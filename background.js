// =============================================================================
// background.js — 状态机驱动的 gateway 资源捕获
// =============================================================================
// 架构：
//   1. DNR 永久规则重定向 gateway main_frame → chrome-extension://<id>/blank.html#<url>
//   2. blank.html 加载后通知 background (interstitialReady)
//   3. background attach CDP + 注册 listener + 添加 session allow rule
//   4. Page.navigate(targetUrl) → session allow rule 绕过 DNR
//   5. 网关 URL committed 后移除 session allow rule，开始捕获
//   6. webRequest 作为独立审计日志
//
// 状态机：
//   USER_NAV_DETECTED → INTERSTITIAL_COMMITTED → CDP_ATTACHING → READY
//                                                                    ↓
//                                                             NAVIGATING_TARGET
//                                                                    ↓
//                                                                CAPTURING
//                                                                    ↓
//                                                               COMPLETED
//                                                               ERROR
// =============================================================================

import { matchGateway, isGatewayUrl, getWebRequestUrlPatterns } from './gateway-matcher.js';
import { initPermanentRules, addSessionAllowRule, removeSessionAllowRule } from './dnr-manager.js';

// ============================================================================
// DNR initialization — permanent rules, idempotent on every SW start
// ============================================================================
initPermanentRules();

// ============================================================================
// State constants
// ============================================================================
const ST = {
  USER_NAV_DETECTED: 'user_nav_detected',
  INTERSTITIAL_COMMITTED: 'interstitial_committed',
  CDP_ATTACHING: 'cdp_attaching',
  READY: 'ready',
  NAVIGATING_TARGET: 'navigating_target',
  CAPTURING: 'capturing',
  COMPLETED: 'completed',
  ERROR: 'error',
};

// Non-terminal states: capture session is active
const ACTIVE_STATES = new Set([
  ST.USER_NAV_DETECTED, ST.INTERSTITIAL_COMMITTED,
  ST.CDP_ATTACHING, ST.READY,
  ST.NAVIGATING_TARGET, ST.CAPTURING,
]);

const MAX_CAPTURE_MS = 30000;
const IDLE_MS = 3500;
const INTERSTITIAL_TIMEOUT_MS = 5000;

const RESOURCE_TYPES_FOR_SILENCE = new Set([
  'Document', 'Script', 'Stylesheet', 'Image', 'Font',
  'Fetch', 'Other',
]);

// ============================================================================
// Storage
// ============================================================================
const captures = new Map();       // tabId → CaptureRecord
const webRequestLog = new Map();  // captureId → GatewayRequest[]

// ============================================================================
// State transition helper
// ============================================================================
function transitionTo(record, newState, event) {
  const oldState = record.state;
  record.state = newState;
  console.log('[STATE]', record.captureId,
    oldState, '→', newState,
    'event=', event,
    'url=', (record.url || '').slice(0, 80) || '(none)',
    'tabId=', record.tabId);
}

// ============================================================================
// CaptureRecord
// ============================================================================
class CaptureRecord {
  constructor(tabId, url) {
    this.tabId = tabId;
    this.url = url;
    this.targetUrl = url;          // original gateway URL to navigate to
    this.captureId = crypto.randomUUID();
    this.state = ST.USER_NAV_DETECTED;
    this.startedAt = Date.now();
    this.durationMs = 0;
    this.captureQuality = null;
    this.error = null;

    // Gateway info
    const gw = matchGateway(url);
    this.gatewayId = gw ? gw.gatewayId : null;
    this.gatewayName = gw ? gw.gatewayName : null;

    // CDP event listener reference
    this.onEvent = null;

    // CDP session data
    this.cdpRequests = new Map();  // requestId → { url, method, type, status, mime, fromCache, lifecycle fields }
    this.processed = new Set();
    this.activeRequests = 0;
    this.pendingBodies = 0;
    this.docCaptured = false;
    this.documentRequestId = null;

    this.cdpReadyAt = null;

    // Setup phase timestamps
    this.setupTiming = {
      attachStartAt: null,
      attachEndAt: null,
      networkEnableStartAt: null,
      networkEnableEndAt: null,
      pageEnableStartAt: null,
      pageEnableEndAt: null,
      pageNavigateStartAt: null,
      pageNavigateEndAt: null,
      firstCdpRequestAt: null,
    };

    // Reconcile data
    this.resources = [];
    this.cdpResources = new Map();
    this.failedBodies = [];
    this.missingResources = [];

    // Completion timers
    this.idleTimer = null;
    this.maxTimer = null;
    this.interstitialTimer = null;
  }
}

// ============================================================================
// onBeforeNavigate — detect user gateway navigation
// ============================================================================
// DNR 重定向到 blank.html 后，此事件收到原始 gateway URL。创建 capture session。
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const { tabId, url } = details;

  console.log('[NAV] onBeforeNavigate', Date.now(), 'tabId=', tabId, 'url=', url.slice(0, 120));

  // Ignore extension pages (blank.html interstitial)
  if (url.startsWith('chrome-extension://')) return;

  const existing = captures.get(tabId);

  // Internal navigation: Page.navigate to targetUrl
  if (existing) {
    if (existing.state === ST.NAVIGATING_TARGET && url === existing.targetUrl) {
      console.log('[NAV] onBeforeNavigate: internal Page.navigate, ignoring');
      return;
    }
    // User navigated away during active capture
    if (ACTIVE_STATES.has(existing.state) && !isGatewayUrl(url)) {
      abortCapture(tabId, 'navigated away');
      return;
    }
  }

  // Non-gateway → ignore
  if (!isGatewayUrl(url)) return;

  // New gateway navigation
  if (existing) await disposeRecord(tabId);
  console.log('[CAPTURE] user navigation detected', Date.now(), 'tabId=', tabId,
    'url=', url.slice(0, 120));
  const newRecord = new CaptureRecord(tabId, url);
  captures.set(tabId, newRecord);
  transitionTo(newRecord, ST.USER_NAV_DETECTED, 'onBeforeNavigate');
});

// ============================================================================
// webRequest listener — audit log
// ============================================================================
// Non-blocking: records all gateway requests during active capture sessions.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const gw = matchGateway(details.url);
    if (!gw) return;

    const record = captures.get(details.tabId);
    if (!record || !ACTIVE_STATES.has(record.state)) return;

    let log = webRequestLog.get(record.captureId);
    if (!log) {
      log = [];
      webRequestLog.set(record.captureId, log);
    }
    const cdpReady = record.cdpReadyAt != null;
    const phase = cdpReady ? 'C' : 'A';
    log.push({
      requestId: details.requestId,
      url: details.url,
      method: details.method,
      type: details.type,
      timeStamp: details.timeStamp,
      frameId: details.frameId,
      gatewayId: gw.gatewayId,
      cdpReady,
      phase,
    });
    console.log('[WEBREQ] seen', Date.now(),
      'captureId=', record.captureId,
      'phase=', phase,
      'requestId=', details.requestId,
      'type=', details.type,
      'cdpReady=', cdpReady,
      'url=', details.url.slice(0, 120));
  },
  { urls: getWebRequestUrlPatterns() }
);

// ============================================================================
// CDP setup — shared across all capture paths
// ============================================================================
async function setupCdp(tabId, record) {
  record.setupTiming.attachStartAt = Date.now();
  console.log('[TIMING] debugger.attach START', record.setupTiming.attachStartAt, 'tabId=', tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
  await chrome.debugger.attach({ tabId }, '1.3');
  record.setupTiming.attachEndAt = Date.now();
  console.log('[TIMING] debugger.attach END', record.setupTiming.attachEndAt,
    'elapsed=', record.setupTiming.attachEndAt - record.setupTiming.attachStartAt, 'ms');

  record.setupTiming.networkEnableStartAt = Date.now();
  console.log('[TIMING] Network.enable START', record.setupTiming.networkEnableStartAt, 'tabId=', tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
  record.setupTiming.networkEnableEndAt = Date.now();
  record.cdpReadyAt = record.setupTiming.networkEnableEndAt;
  console.log('[TIMING] Network.enable END', record.setupTiming.networkEnableEndAt,
    'elapsed=', record.setupTiming.networkEnableEndAt - record.setupTiming.networkEnableStartAt, 'ms');

  record.setupTiming.pageEnableStartAt = Date.now();
  console.log('[TIMING] Page.enable START', record.setupTiming.pageEnableStartAt, 'tabId=', tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
  record.setupTiming.pageEnableEndAt = Date.now();
  console.log('[TIMING] Page.enable END', record.setupTiming.pageEnableEndAt,
    'elapsed=', record.setupTiming.pageEnableEndAt - record.setupTiming.pageEnableStartAt, 'ms');

  record.onEvent = (source, method, params) => {
    if (source.tabId !== tabId) return;
    const current = captures.get(tabId);
    if (!current || current.captureId !== record.captureId) return;
    handleCdpEvent(tabId, record.captureId, method, params).catch((err) => {
      console.warn('[CAPTURE] CDP event error:', err);
    });
  };
  chrome.debugger.onEvent.addListener(record.onEvent);
  console.log('[CAPTURE] CDP listener registered', Date.now(), 'tabId=', tabId,
    'captureId=', record.captureId);
}

// ============================================================================
// handleInterstitialReady — blank.html 通知 background
// ============================================================================
async function handleInterstitialReady(tabId, targetUrl) {
  const record = captures.get(tabId);
  if (!record) {
    console.warn('[CAPTURE] interstitialReady: no record for tabId=', tabId);
    return;
  }
  // Accept USER_NAV_DETECTED (onCommitted may not fire for chrome-extension:// URLs)
  // or INTERSTITIAL_COMMITTED (onCommitted did fire)
  if (record.state !== ST.USER_NAV_DETECTED && record.state !== ST.INTERSTITIAL_COMMITTED) {
    console.warn('[CAPTURE] interstitialReady: unexpected state=', record.state, 'tabId=', tabId);
    return;
  }

  console.log('[CAPTURE] interstitialReady received', Date.now(), 'tabId=', tabId,
    'captureId=', record.captureId, 'prevState=', record.state,
    'targetUrl=', targetUrl.slice(0, 120));

  // Clear interstitial timeout (may not exist if onCommitted didn't fire)
  if (record.interstitialTimer) {
    clearTimeout(record.interstitialTimer);
    record.interstitialTimer = null;
  }

  transitionTo(record, ST.CDP_ATTACHING, 'interstitialReady');

  try {
    await setupCdp(tabId, record);
    transitionTo(record, ST.READY, 'cdp setup complete');

    // Add session allow rule to bypass DNR on next navigation
    await addSessionAllowRule(tabId, record.captureId);

    transitionTo(record, ST.NAVIGATING_TARGET, 'Page.navigate');
    record.setupTiming.pageNavigateStartAt = Date.now();
    console.log('[TIMING] Page.navigate START', record.setupTiming.pageNavigateStartAt,
      'tabId=', tabId, 'url=', targetUrl.slice(0, 120));
    await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url: targetUrl });
    record.setupTiming.pageNavigateEndAt = Date.now();
    console.log('[TIMING] Page.navigate END', record.setupTiming.pageNavigateEndAt,
      'elapsed=', record.setupTiming.pageNavigateEndAt - record.setupTiming.pageNavigateStartAt, 'ms');
  } catch (err) {
    console.error('[CAPTURE] interstitial setup failed', Date.now(), 'tabId=', tabId,
      'err=', err.message);
    await removeSessionAllowRule(tabId, record.captureId);
    finishWithError(tabId, record.captureId, 'interstitial setup failed: ' + err.message);
  }
}

function startCaptureTimers(tabId, record) {
  transitionTo(record, ST.CAPTURING, 'startCapture');
  record.maxTimer = setTimeout(() => {
    const r = captures.get(tabId);
    if (r && r.captureId === record.captureId && r.state === ST.CAPTURING) {
      console.log('[CAPTURE] max timeout', Date.now(), 'tabId=', tabId,
        'captureId=', record.captureId);
      doReconcile(tabId, record.captureId);
    }
  }, MAX_CAPTURE_MS);
  notifyPopup(tabId);
  console.log('[CAPTURE] capturing started', Date.now(), 'tabId=', tabId,
    'captureId=', record.captureId);
}

// ============================================================================
// onCommitted — state-driven navigation handling
// ============================================================================
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const { tabId, url } = details;

  const record = captures.get(tabId);

  console.log('[NAV] onCommitted', Date.now(), 'tabId=', tabId,
    'url=', url.slice(0, 120),
    'recordState=', record ? record.state : 'none');

  // ── State: USER_NAV_DETECTED → blank.html committed ──
  if (record && record.state === ST.USER_NAV_DETECTED && url.startsWith('chrome-extension://')) {
    transitionTo(record, ST.INTERSTITIAL_COMMITTED, 'onCommitted(blank.html)');
    // Safety timeout: if interstitialReady not received, abort
    record.interstitialTimer = setTimeout(() => {
      const r = captures.get(tabId);
      if (r && r.captureId === record.captureId && r.state === ST.INTERSTITIAL_COMMITTED) {
        console.error('[CAPTURE] interstitial timeout', Date.now(), 'tabId=', tabId);
        finishWithError(tabId, record.captureId, 'interstitial timeout');
      }
    }, INTERSTITIAL_TIMEOUT_MS);
    return;
  }

  // ── State: NAVIGATING_TARGET → gateway URL committed ──
  if (record && record.state === ST.NAVIGATING_TARGET && isGatewayUrl(url)) {
    record.url = url;
    // Remove session allow rule now that navigation succeeded
    await removeSessionAllowRule(tabId, record.captureId);
    startCaptureTimers(tabId, record);
    return;
  }

  // ── Non-gateway → ignore ──
  if (!isGatewayUrl(url)) return;
});

// ============================================================================
// Tab closed
// ============================================================================
chrome.tabs.onRemoved.addListener((tabId) => {
  console.log('[CAPTURE] onRemoved', Date.now(), 'tabId=', tabId);
  disposeRecord(tabId);
});

// ============================================================================
// CDP event handling
// ============================================================================
async function handleCdpEvent(tabId, captureId, method, params) {
  const record = captures.get(tabId);
  if (!record || record.captureId !== captureId) return;
  if (record.state !== ST.READY && record.state !== ST.NAVIGATING_TARGET && record.state !== ST.CAPTURING) return;

  switch (method) {
    case 'Network.requestWillBeSent': {
      const isDoc = params.type === 'Document' && params.frameId === 0;
      const isGateway = isGatewayUrl(params.request.url);

      if (isGateway) {
        record.cdpRequests.set(params.requestId, {
          url: params.request.url,
          method: params.request.method,
          type: params.type,
          status: null,
          mime: null,
          fromCache: false,
          requestWillBeSentTime: Date.now(),
          responseReceivedTime: null,
          loadingFinishedTime: null,
          loadingFailedTime: null,
          fromDiskCache: null,
          fromPrefetchCache: null,
          fromServiceWorker: null,
          encodedDataLength: null,
          bodyFetchResult: null,
          bodyFetchError: null,
        });
        console.log('[CDP_REQ] requestWillBeSent', Date.now(),
          'requestId=', params.requestId,
          'type=', params.type,
          'url=', params.request.url.slice(0, 120));

        if (record.setupTiming.firstCdpRequestAt === null) {
          record.setupTiming.firstCdpRequestAt = Date.now();
          console.log('[TIMING] first CDP requestWillBeSent', record.setupTiming.firstCdpRequestAt,
            'requestId=', params.requestId,
            'type=', params.type,
            'url=', params.request.url.slice(0, 80));
        }
      }
      if (isDoc && record.documentRequestId === null && isGatewayUrl(params.request.url)) {
        record.documentRequestId = params.requestId;
        console.log('[CDP] Document requestWillBeSent', Date.now(),
          'tabId=', tabId, 'reqId=', params.requestId,
          'url=', params.request.url.slice(0, 100));
      }

      const isTarget = RESOURCE_TYPES_FOR_SILENCE.has(params.type);

      console.log('[CDP] requestWillBeSent', Date.now(), 'tabId=', tabId,
        'type=', params.type, 'isGateway=', isGateway,
        'url=', params.request.url.slice(0, 100),
        'active=', record.activeRequests);

      if (isGateway && isTarget) {
        record.activeRequests++;
        resetIdleTimer(tabId, captureId);
      }
      break;
    }

    case 'Network.responseReceived': {
      let req = record.cdpRequests.get(params.requestId);
      if (req) {
        req.status = params.response.status;
        req.mime = params.response.mimeType;
        req.fromCache = !!(params.response.fromDiskCache || params.response.fromServiceWorker);
        req.responseReceivedTime = Date.now();
        req.fromDiskCache = !!params.response.fromDiskCache;
        req.fromPrefetchCache = !!params.response.fromPrefetchCache;
        req.fromServiceWorker = !!params.response.fromServiceWorker;
        req.encodedDataLength = params.response.encodedDataLength;
      } else if (isGatewayUrl(params.response.url)) {
        req = {
          url: params.response.url,
          method: 'GET',
          type: params.type,
          status: params.response.status,
          mime: params.response.mimeType,
          fromCache: !!(params.response.fromDiskCache || params.response.fromServiceWorker),
          requestWillBeSentTime: null,
          responseReceivedTime: Date.now(),
          loadingFinishedTime: null,
          loadingFailedTime: null,
          fromDiskCache: !!params.response.fromDiskCache,
          fromPrefetchCache: !!params.response.fromPrefetchCache,
          fromServiceWorker: !!params.response.fromServiceWorker,
          encodedDataLength: params.response.encodedDataLength,
          bodyFetchResult: null,
          bodyFetchError: null,
        };
        record.cdpRequests.set(params.requestId, req);
        console.log('[CDP] responseReceived (requestWillBeSent SKIPPED, memory cache)', Date.now(),
          'requestId=', params.requestId,
          'type=', params.type,
          'url=', params.response.url.slice(0, 80));
      }
      if (isGatewayUrl(params.response.url)) {
        console.log('[CDP] responseReceived', Date.now(),
          'type=', params.type, 'status=', params.response.status,
          'mime=', params.response.mimeType,
          'fromCache=', req?.fromCache,
          'url=', params.response.url.slice(0, 80));
      }
      break;
    }

    case 'Network.requestServedFromCache': {
      console.log('[CDP] requestServedFromCache', Date.now(),
        'reqId=', params.requestId, 'url=', (record.cdpRequests.get(params.requestId)?.url || '').slice(0, 80));
      const req = record.cdpRequests.get(params.requestId);
      if (req) req.fromCache = true;
      break;
    }

    case 'Network.loadingFinished': {
      const finReq = record.cdpRequests.get(params.requestId);
      if (finReq && RESOURCE_TYPES_FOR_SILENCE.has(finReq.type) && isGatewayUrl(finReq.url)) {
        if (finReq.requestWillBeSentTime !== null) {
          record.activeRequests--;
        }
      }
      if (finReq) finReq.loadingFinishedTime = Date.now();
      const rwsSkipped = finReq && finReq.requestWillBeSentTime === null;
      console.log('[CDP] loadingFinished', Date.now(),
        'type=', finReq?.type, 'url=', finReq?.url?.slice(0, 80),
        rwsSkipped ? '(requestWillBeSent skipped, memory cache)' : '');
      await fetchBody(tabId, captureId, params.requestId);
      checkCompletion(tabId, captureId);
      break;
    }

    case 'Network.loadingFailed': {
      const failReq = record.cdpRequests.get(params.requestId);
      if (failReq && RESOURCE_TYPES_FOR_SILENCE.has(failReq.type) && isGatewayUrl(failReq.url)) {
        record.activeRequests--;
      }
      if (failReq) failReq.loadingFailedTime = Date.now();
      console.log('[CDP] loadingFailed', Date.now(), 'tabId=', tabId,
        'reqId=', params.requestId, 'error=', params.errorText,
        'active=', record.activeRequests);
      checkCompletion(tabId, captureId);
      break;
    }

    case 'Page.loadEventFired': {
      console.log('[CDP] Page.loadEventFired', Date.now(), 'tabId=', tabId,
        'captureId=', captureId, '(soft signal)',
        'active=', record.activeRequests, 'docCaptured=', record.docCaptured,
        'resourcesLen=', record.resources.length);
      break;
    }
  }
}

// ============================================================================
// Fetch response body — with retry and failure classification
// ============================================================================
async function fetchBody(tabId, captureId, requestId) {
  const record = captures.get(tabId);
  if (!record || record.captureId !== captureId) return;
  if (record.state !== ST.CAPTURING) return;
  if (record.processed.has(requestId)) return;

  const req = record.cdpRequests.get(requestId);
  if (!req) return;
  if (!isGatewayUrl(req.url)) return;

  record.processed.add(requestId);
  record.pendingBodies++;

  const retryDelays = [100, 300];

  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      const { body, base64Encoded } = await chrome.debugger.sendCommand(
        { tabId },
        'Network.getResponseBody',
        { requestId }
      );
      const size = base64Encoded
        ? atob(body).length
        : new TextEncoder().encode(body).length;

      appendResource(tabId, captureId, {
        url: req.url,
        type: req.type,
        status: req.status,
        mime: req.mime,
        size,
        body,
        base64Encoded,
        fromCache: req.fromCache,
        gatewayId: record.gatewayId,
      });

      const normKey = normalizeResourceKey(req.url, req.type);
      record.cdpResources.set(normKey, {
        url: req.url,
        type: req.type,
        status: req.status,
        mime: req.mime,
        bodySuccess: true,
        fromCache: req.fromCache,
        cdpRequestId: requestId,
      });

      req.bodyFetchResult = 'success';

      if (req.type === 'Document' && requestId === record.documentRequestId) {
        record.docCaptured = true;
        console.log('[CDP] getResponseBody OK (Document)', Date.now(),
          'size=', size, 'url=', req.url.slice(0, 80));
      } else {
        console.log('[CDP] getResponseBody OK', Date.now(),
          'type=', req.type, 'size=', size,
          'attempt=', attempt + 1,
          'url=', req.url.slice(0, 80));
      }

      record.pendingBodies--;
      return;
    } catch (e) {
      if (attempt < retryDelays.length) {
        console.log('[CDP] getResponseBody retry', Date.now(),
          'type=', req.type, 'attempt=', attempt + 1,
          'delay=', retryDelays[attempt], 'ms',
          'url=', req.url.slice(0, 80));
        await new Promise(r => setTimeout(r, retryDelays[attempt]));
      } else {
        const isBodyUnavailable = /no resource with given identifier/i.test(e.message);
        const failEntry = {
          url: req.url,
          type: req.type,
          status: req.status,
          mime: req.mime,
          fromCache: req.fromCache,
          error: e.message,
          bodyUnavailable: isBodyUnavailable,
        };

        appendFailedBody(tabId, captureId, failEntry);

        const normKeyFail = normalizeResourceKey(req.url, req.type);
        record.cdpResources.set(normKeyFail, {
          url: req.url,
          type: req.type,
          status: req.status,
          mime: req.mime,
          bodySuccess: false,
          bodyUnavailable: isBodyUnavailable,
          fromCache: req.fromCache,
          cdpRequestId: requestId,
        });

        req.bodyFetchResult = 'fail';
        req.bodyFetchError = e.message;

        console.log('[CDP] getResponseBody FAIL (after retries)', Date.now(),
          'type=', req.type, 'err=', e.message,
          'bodyUnavailable=', isBodyUnavailable,
          'fromCache=', req.fromCache,
          'url=', req.url.slice(0, 80));
      }
    }
  }
  record.pendingBodies--;
}

function appendResource(tabId, captureId, resource) {
  const record = captures.get(tabId);
  if (!record || record.captureId !== captureId) return;
  record.resources.push(resource);
  notifyPopup(tabId);
}

function appendFailedBody(tabId, captureId, failEntry) {
  const record = captures.get(tabId);
  if (!record || record.captureId !== captureId) return;
  record.failedBodies.push(failEntry);
  notifyPopup(tabId);
}

// ============================================================================
// Completion check
// ============================================================================
function checkCompletion(tabId, captureId) {
  const record = captures.get(tabId);
  if (!record || record.captureId !== captureId) return;
  if (record.state !== ST.CAPTURING) return;

  if (record.activeRequests === 0 && record.pendingBodies === 0) {
    if (!record.idleTimer) {
      console.log('[CAPTURE] checkCompletion: all done, waiting for idle', Date.now(),
        'tabId=', tabId, 'captureId=', captureId);
      resetIdleTimer(tabId, captureId);
    }
  }
}

function resetIdleTimer(tabId, captureId) {
  const record = captures.get(tabId);
  if (!record || record.captureId !== captureId) return;
  if (record.idleTimer) clearTimeout(record.idleTimer);
  record.idleTimer = setTimeout(() => {
    const r = captures.get(tabId);
    if (!r || r.captureId !== captureId) return;
    if (r.state !== ST.CAPTURING) return;
    r.idleTimer = null;
    if (r.activeRequests === 0 && r.pendingBodies === 0) {
      console.log('[CAPTURE] idle complete → reconcile', Date.now(),
        'tabId=', tabId, 'captureId=', captureId,
        'resourcesLen=', r.resources.length);
      doReconcile(tabId, captureId);
    } else {
      console.log('[CAPTURE] idle timer: new requests, waiting more', Date.now(),
        'tabId=', tabId, 'captureId=', captureId,
        'active=', r.activeRequests, 'pendingBodies=', r.pendingBodies);
    }
  }, IDLE_MS);
}

// ============================================================================
// Reconcile — webRequest vs CDP 对账
// ============================================================================
function doReconcile(tabId, captureId) {
  const record = captures.get(tabId);
  if (!record || record.captureId !== captureId) return;
  if (record.state !== ST.CAPTURING) return;

  const wReqLog = webRequestLog.get(captureId) || [];

  const wReqDeduped = [];
  const wReqSeen = new Set();
  for (const wReq of wReqLog) {
    const key = normalizeResourceKey(wReq.url, wReq.type);
    if (!wReqSeen.has(key)) {
      wReqSeen.add(key);
      wReqDeduped.push({ ...wReq, _normKey: key });
    }
  }

  const captured = [];
  const bodyMissing = [];
  const cdpMissed = [];

  let cdpReqSentCount = 0;
  let cdpRespRecvCount = 0;
  let cdpLoadFinishCount = 0;
  for (const req of record.cdpRequests.values()) {
    if (req.requestWillBeSentTime) cdpReqSentCount++;
    if (req.responseReceivedTime) cdpRespRecvCount++;
    if (req.loadingFinishedTime) cdpLoadFinishCount++;
  }

  for (const wReq of wReqDeduped) {
    const normKey = wReq._normKey;
    const cdpMatch = record.cdpResources.get(normKey);

    if (!cdpMatch) {
      cdpMissed.push(wReq);
    } else if (cdpMatch.bodySuccess) {
      captured.push(wReq);
    } else {
      bodyMissing.push({
        ...wReq,
        bodyUnavailable: cdpMatch.bodyUnavailable,
        fromCache: cdpMatch.fromCache,
      });
    }
  }

  const missingA = [];
  const missingB = [];
  const missingC = [];

  for (const wReq of cdpMissed) {
    const normKey = wReq._normKey;
    let cdpReq = null;
    for (const [reqId, r] of record.cdpRequests) {
      if (normalizeResourceKey(r.url, r.type) === normKey) {
        cdpReq = r;
        break;
      }
    }
    const cdpRes = record.cdpResources.get(normKey);
    const reqTime = wReq.timeStamp;
    const netEnabled = record.cdpReadyAt || 0;

    if (cdpReq) {
      if (cdpRes && cdpRes.bodySuccess) {
        missingC.push({ ...wReq, _category: 'C', _cdpReq: cdpReq, _cdpRes: cdpRes, _bug: true });
      } else {
        missingC.push({ ...wReq, _category: 'C', _cdpReq: cdpReq, _cdpRes: cdpRes });
      }
    } else if (reqTime < netEnabled) {
      missingA.push({ ...wReq, _category: 'A' });
    } else {
      missingB.push({ ...wReq, _category: 'B' });
    }
  }

  record.missingResources = missingB;

  const realMissing = missingB.length;
  record.captureQuality = realMissing > 0 ? 'partial' : 'complete';
  if (!record.docCaptured) {
    record.captureQuality = 'partial';
    if (!record.error) record.error = 'document not captured';
  }

  // =========================================================================
  // CAPTURE SUMMARY
  // =========================================================================
  console.log('[CAPTURE] ╔══════════════════════════════════════════════');
  console.log('[CAPTURE] ║  CAPTURE SUMMARY');
  console.log('[CAPTURE] ╠══════════════════════════════════════════════');
  console.log('[CAPTURE] ║  captureId :', captureId);
  console.log('[CAPTURE] ║  gatewayId :', record.gatewayId);
  console.log('[CAPTURE] ║  duration  :', Date.now() - record.startedAt, 'ms');
  console.log('[CAPTURE] ║  quality   :', record.captureQuality);
  console.log('[CAPTURE] ╠══════════════════════════════════════════════');
  console.log('[CAPTURE] ║  Gateway requests (webRequest) :', wReqLog.length,
    '(deduped:', wReqDeduped.length, ')');
  console.log('[CAPTURE] ║  CDP requestWillBeSent :', cdpReqSentCount);
  console.log('[CAPTURE] ║  CDP responseReceived  :', cdpRespRecvCount);
  console.log('[CAPTURE] ║  CDP loadingFinished   :', cdpLoadFinishCount);
  console.log('[CAPTURE] ║  CDP body success      :', captured.length);
  console.log('[CAPTURE] ║  CDP body failed       :', record.failedBodies.length);
  console.log('[CAPTURE] ║  CDP resources (Map)   :', record.cdpResources.size);

  // Phase A/C merge stats
  const phaseA = wReqLog.filter(r => r.phase === 'A');
  const phaseC = wReqLog.filter(r => r.phase === 'C');
  let cdpRwsSkipped = 0;
  let cdpMemCacheBodies = 0;
  let cdpMemCacheBodiesFailed = 0;
  for (const req of record.cdpRequests.values()) {
    if (req.requestWillBeSentTime === null) {
      cdpRwsSkipped++;
      if (req.bodyFetchResult === 'success') cdpMemCacheBodies++;
      if (req.bodyFetchResult === 'fail') cdpMemCacheBodiesFailed++;
    }
  }
  console.log('[CAPTURE] ╠══════════════════════════════════════════════');
  console.log('[CAPTURE] ║  PHASE A/C MERGE');
  console.log('[CAPTURE] ╠══════════════════════════════════════════════');
  console.log('[CAPTURE] ║  Phase A webRequest (before CDP)  :', phaseA.length);
  console.log('[CAPTURE] ║  Phase C webRequest (after CDP)   :', phaseC.length);
  console.log('[CAPTURE] ║  Merged (deduped)                  :', wReqDeduped.length);
  console.log('[CAPTURE] ║  CDP normal (requestWillBeSent)    :', cdpReqSentCount);
  console.log('[CAPTURE] ║  CDP memory cache (rws skipped)    :', cdpRwsSkipped);
  console.log('[CAPTURE] ║    → body captured                 :', cdpMemCacheBodies);
  console.log('[CAPTURE] ║    → body failed                   :', cdpMemCacheBodiesFailed);
  console.log('[CAPTURE] ║  CDP total requests                :', record.cdpRequests.size);
  console.log('[CAPTURE] ║  Body captured (resources[])        :', record.resources.length);
  const allResWithBody = new Set(record.resources.map(r => normalizeResourceKey(r.url, r.type)));
  const missingBody = wReqDeduped.filter(w => !allResWithBody.has(w._normKey));
  console.log('[CAPTURE] ║  Merged resources without body     :', missingBody.length);
  console.log('[CAPTURE] ╠══════════════════════════════════════════════');

  // Setup timeline
  const st = record.setupTiming;
  console.log('[CAPTURE] ║  SETUP TIMELINE');
  console.log('[CAPTURE] ╠══════════════════════════════════════════════');
  if (st.attachStartAt) {
    console.log('[CAPTURE] ║  [1] debugger.attach    :', st.attachStartAt,
      '→', st.attachEndAt, '(elapsed:', (st.attachEndAt - st.attachStartAt), 'ms)');
  }
  if (st.networkEnableStartAt) {
    console.log('[CAPTURE] ║  [2] Network.enable     :', st.networkEnableStartAt,
      '→', st.networkEnableEndAt, '(elapsed:', (st.networkEnableEndAt - st.networkEnableStartAt), 'ms)');
  }
  if (st.pageEnableStartAt) {
    console.log('[CAPTURE] ║  [3] Page.enable        :', st.pageEnableStartAt,
      '→', st.pageEnableEndAt, '(elapsed:', (st.pageEnableEndAt - st.pageEnableStartAt), 'ms)');
  }
  if (st.pageNavigateStartAt) {
    console.log('[CAPTURE] ║  [4] Page.navigate      :', st.pageNavigateStartAt,
      '→', st.pageNavigateEndAt, '(elapsed:', (st.pageNavigateEndAt - st.pageNavigateStartAt), 'ms)');
  }
  if (st.firstCdpRequestAt) {
    console.log('[CAPTURE] ║  [5] first CDP request  :', st.firstCdpRequestAt);
  }
  if (st.pageNavigateEndAt && st.firstCdpRequestAt) {
    const delta = st.firstCdpRequestAt - st.pageNavigateEndAt;
    console.log('[CAPTURE] ║  ORDERING: Page.navigate.end → first CDP req =', delta, 'ms',
      delta >= 0 ? '(OK)' : '(UNEXPECTED)');
  }

  // Category A items
  if (missingA.length > 0) {
    console.log('[CAPTURE] ║  CATEGORY A (', missingA.length, '): reqTime < cdpReadyAt');
    console.log('[CAPTURE] ║    cdpReadyAt:', record.cdpReadyAt);
    for (const a of missingA.slice(0, 5)) {
      console.log('[CAPTURE] ║    [A] reqTime=', a.timeStamp,
        'gap=', (record.cdpReadyAt || 0) - a.timeStamp, 'ms',
        'type=', a.type, 'url=', a.url.slice(0, 80));
    }
  }
  console.log('[CAPTURE] ╠══════════════════════════════════════════════');

  // Missing breakdown
  if (cdpMissed.length > 0) {
    console.log('[CAPTURE] ║  MISSING BREAKDOWN (', cdpMissed.length, 'items)');
    console.log('[CAPTURE] ║    A: attach too late :', missingA.length);
    console.log('[CAPTURE] ║    B: CDP omission     :', missingB.length);
    console.log('[CAPTURE] ║    C: body fetch issue  :', missingC.length);
    console.log('[CAPTURE] ║    captureQuality (B)   :', record.captureQuality);
    console.log('[CAPTURE] ╠══════════════════════════════════════════════');
    console.log('[CAPTURE] ║  MISSING_ANALYSIS');
    for (const item of cdpMissed) {
      const normKey = item._normKey;
      let cdpReq = null;
      let cdpReqId = null;
      for (const [reqId, r] of record.cdpRequests) {
        if (normalizeResourceKey(r.url, r.type) === normKey) {
          cdpReq = r;
          cdpReqId = reqId;
          break;
        }
      }
      const cdpRes = record.cdpResources.get(normKey);
      const reqTime = item.timeStamp;
      const netEnabled = record.cdpReadyAt || 0;
      const tooEarly = reqTime < netEnabled;

      console.log('[CAPTURE] ║  ─────────────────────────────────');
      console.log('[CAPTURE] ║  [MISSING] category=', item._category || '?');
      console.log('[CAPTURE] ║    url               :', item.url.slice(0, 120));
      console.log('[CAPTURE] ║    type              :', item.type);
      console.log('[CAPTURE] ║    webRequestTime    :', reqTime);
      console.log('[CAPTURE] ║    networkEnabledTime:', netEnabled);
      console.log('[CAPTURE] ║    reqTime < netEnabled :', tooEarly);
      console.log('[CAPTURE] ║    cdpRequestSeen    :', cdpReq ? true : false);
      console.log('[CAPTURE] ║    cdpRequestId      :', cdpReqId || 'N/A');
      if (cdpReq && cdpReq.responseReceivedTime) {
        console.log('[CAPTURE] ║    fromDiskCache     :', cdpReq.fromDiskCache);
        console.log('[CAPTURE] ║    fromPrefetchCache  :', cdpReq.fromPrefetchCache);
        console.log('[CAPTURE] ║    fromServiceWorker  :', cdpReq.fromServiceWorker);
      }
      console.log('[CAPTURE] ║    bodyFetchAttempted:', cdpRes ? true : false);
      console.log('[CAPTURE] ║    bodyFetchResult   :', cdpRes ? (cdpRes.bodySuccess ? 'success' : 'fail') : 'N/A');
    }
  }

  console.log('[CAPTURE] ╚══════════════════════════════════════════════');

  webRequestLog.delete(captureId);
  completeCapture(tabId, captureId);
}

// ============================================================================
// Finalize capture
// ============================================================================
function completeCapture(tabId, captureId) {
  const record = captures.get(tabId);
  if (!record || record.captureId !== captureId) return;

  transitionTo(record, ST.COMPLETED, 'completeCapture');
  record.durationMs = Date.now() - record.startedAt;

  console.log('[CAPTURE] completeCapture', Date.now(), 'tabId=', tabId,
    'captureId=', captureId,
    'gatewayId=', record.gatewayId,
    'captureQuality=', record.captureQuality,
    'resources=', record.resources.length,
    'failedBodies=', record.failedBodies.length,
    'missing=', record.missingResources.length,
    'durationMs=', record.durationMs);

  detachDebugger(tabId, captureId);
  notifyPopup(tabId);
}

// ============================================================================
// Debugger lifecycle
// ============================================================================
async function detachDebugger(tabId, captureId) {
  const record = captures.get(tabId);
  if (!record || record.captureId !== captureId) return;

  if (record.idleTimer) { clearTimeout(record.idleTimer); record.idleTimer = null; }
  if (record.maxTimer) { clearTimeout(record.maxTimer); record.maxTimer = null; }
  if (record.interstitialTimer) { clearTimeout(record.interstitialTimer); record.interstitialTimer = null; }

  if (record.onEvent) {
    chrome.debugger.onEvent.removeListener(record.onEvent);
    record.onEvent = null;
  }

  console.log('[CAPTURE] detachDebugger', Date.now(), 'tabId=', tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

async function abortCapture(tabId, reason) {
  const record = captures.get(tabId);
  if (!record || !ACTIVE_STATES.has(record.state)) return;
  console.log('[CAPTURE] abortCapture', Date.now(), 'tabId=', tabId,
    'reason=', reason, 'captureId=', record.captureId);
  transitionTo(record, ST.ERROR, 'abortCapture: ' + reason);
  record.error = reason;
  record.durationMs = Date.now() - record.startedAt;
  webRequestLog.delete(record.captureId);
  await removeSessionAllowRule(tabId, record.captureId);
  await detachDebugger(tabId, record.captureId);
  notifyPopup(tabId);
}

async function disposeRecord(tabId) {
  const record = captures.get(tabId);
  if (!record) return;
  console.log('[CAPTURE] disposeRecord', Date.now(), 'tabId=', tabId,
    'captureId=', record.captureId);
  webRequestLog.delete(record.captureId);
  await removeSessionAllowRule(tabId, record.captureId);
  await detachDebugger(tabId, record.captureId);
  captures.delete(tabId);
}

async function finishWithError(tabId, captureId, error) {
  const record = captures.get(tabId);
  if (!record || record.captureId !== captureId) return;
  console.log('[CAPTURE] finishWithError', Date.now(), 'tabId=', tabId,
    'err=', error);
  transitionTo(record, ST.ERROR, 'finishWithError: ' + error);
  record.error = error;
  record.durationMs = Date.now() - record.startedAt;
  webRequestLog.delete(record.captureId);
  await removeSessionAllowRule(tabId, captureId);
  await detachDebugger(tabId, captureId);
  notifyPopup(tabId);
}

// Debugger detached externally
chrome.debugger.onDetach.addListener(({ tabId }) => {
  const record = captures.get(tabId);
  if (record && record.state === ST.CAPTURING) {
    finishWithError(tabId, record.captureId, 'debugger detached');
  }
});

// ============================================================================
// Push state changes to popup
// ============================================================================
function notifyPopup(tabId) {
  chrome.runtime.sendMessage({ action: 'stateChanged', tabId }).catch(() => {});
}

// ============================================================================
// Message handling: interstitialReady + popup ↔ background
// ============================================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // interstitialReady — blank.html 通知（无需 sendResponse）
  if (msg.action === 'interstitialReady') {
    handleInterstitialReady(sender.tab.id, msg.targetUrl);
    return false;
  }

  // popup 消息
  (async () => {
    const tabId = msg.tabId ?? (await getActiveTabId());
    const record = tabId != null ? captures.get(tabId) : null;

    switch (msg.action) {
      case 'getState': {
        if (record) {
          sendResponse({
            state: {
              state: record.state,
              url: record.url,
              gatewayId: record.gatewayId,
              gatewayName: record.gatewayName,
              captureQuality: record.captureQuality,
              durationMs: record.durationMs,
              error: record.error,
              captureId: record.captureId,
              counts: {
                captured: record.resources.length,
                failedBodies: record.failedBodies.length,
                missed: record.missingResources.length,
              },
            },
          });
        } else {
          sendResponse({ state: { state: 'inactive' } });
        }
        break;
      }
      case 'getResults': {
        const withBody = msg.withBody === true;
        if (record) {
          const resources = withBody
            ? record.resources
            : record.resources.map(({ body, base64Encoded, ...rest }) => rest);
          sendResponse({
            url: record.url,
            gatewayId: record.gatewayId,
            gatewayName: record.gatewayName,
            durationMs: record.durationMs,
            state: record.state,
            captureQuality: record.captureQuality,
            captureId: record.captureId,
            resources,
            failedBodies: record.failedBodies.map(r => ({
              url: r.url,
              type: r.type,
              status: r.status,
              error: r.error,
              bodyUnavailable: r.bodyUnavailable,
              fromCache: r.fromCache,
            })),
            missingResources: record.missingResources.map(r => ({
              url: r.url,
              type: r.type,
              timeStamp: r.timeStamp,
            })),
            summary: {
              total: record.resources.length,
              totalSize: record.resources.reduce((s, r) => s + r.size, 0),
              failedBodies: record.failedBodies.length,
              missed: record.missingResources.length,
              byType: groupByType(record.resources),
            },
          });
        } else {
          sendResponse({
            resources: [],
            failedBodies: [],
            missingResources: [],
            summary: { total: 0, totalSize: 0, failedBodies: 0, missed: 0, byType: {} },
          });
        }
        break;
      }
      default:
        sendResponse({ error: 'unknown action' });
    }
  })();
  return true;
});

// ============================================================================
// Utilities
// ============================================================================
async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

function groupByType(resources) {
  const map = {};
  for (const r of resources) map[r.type] = (map[r.type] || 0) + 1;
  return map;
}

function normalizeResourceKey(url, type) {
  let u;
  try {
    u = new URL(url);
  } catch {
    const clean = String(url).replace(/#.*$/, '').replace(/\/$/, '');
    return `${clean}|${String(type).toLowerCase()}`;
  }
  u.hash = '';
  let pathname = u.pathname.replace(/\/$/, '');
  if (!pathname) pathname = '/';
  const normalized = `${u.protocol}//${u.host}${pathname}`;
  return `${normalized}|${String(type).toLowerCase()}`;
}