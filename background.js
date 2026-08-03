// =============================================================================
// background.js — state-machine-driven gateway resource capture
// =============================================================================
// Architecture:
//   1. DNR permanent rules redirect gateway main_frame → chrome-extension://<id>/blank.html#<url>
//   2. blank.html signals background via interstitialReady message
//   3. background attaches CDP, registers listener, adds session allow rule
//   4. Page.navigate(targetUrl) → session allow rule bypasses DNR
//   5. Gateway URL committed → remove session allow rule → start capture
//   6. webRequest serves as independent audit log
//
// State machine:
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

    // Child target session management (worker / service_worker / OOPIF)
    // targetId → { type, url, sessionId }
    this.childTargets = new Map();
  }
}

// ============================================================================
// onBeforeNavigate — detect user gateway navigation
// ============================================================================
// After DNR redirects to blank.html, this event receives the original gateway URL.
// Creates a new capture session.
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const { tabId, url } = details;

  // Ignore extension pages (blank.html interstitial)
  if (url.startsWith('chrome-extension://')) return;

  const existing = captures.get(tabId);

  // Internal navigation: Page.navigate to targetUrl
  if (existing) {
    if (existing.state === ST.NAVIGATING_TARGET && url === existing.targetUrl) {
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
  console.log('[CAPTURE] user navigation detected', 'tabId=', tabId,
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
    const wReqNormKey = normalizeResourceKey(details.url, details.type);
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
      _normKey: wReqNormKey,
    });
  },
  { urls: getWebRequestUrlPatterns() }
);

// ============================================================================
// CDP setup — shared across all capture paths
// ============================================================================
async function setupCdp(tabId, record) {
  record.setupTiming.attachStartAt = Date.now();
  await chrome.debugger.detach({ tabId }).catch(() => {});
  await chrome.debugger.attach({ tabId }, '1.3');
  record.setupTiming.attachEndAt = Date.now();

  // Auto-attach child targets (worker / service_worker / OOPIF)
  // Must be called before Network.enable so that child target Network
  // events are captured from the moment they are created.
  await chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });

  record.setupTiming.networkEnableStartAt = Date.now();
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
  record.setupTiming.networkEnableEndAt = Date.now();
  record.cdpReadyAt = record.setupTiming.networkEnableEndAt;

  record.setupTiming.pageEnableStartAt = Date.now();
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
  record.setupTiming.pageEnableEndAt = Date.now();

  console.log('[CAPTURE] CDP setup done', 'tabId=', tabId,
    'attach=', (record.setupTiming.attachEndAt - record.setupTiming.attachStartAt), 'ms',
    'network=', (record.setupTiming.networkEnableEndAt - record.setupTiming.networkEnableStartAt), 'ms',
    'page=', (record.setupTiming.pageEnableEndAt - record.setupTiming.pageEnableStartAt), 'ms');

  record.onEvent = (source, method, params) => {
    if (source.tabId !== tabId) return;
    const current = captures.get(tabId);
    if (!current || current.captureId !== record.captureId) return;
    handleCdpEvent(tabId, record.captureId, method, params, source).catch((err) => {
      console.warn('[CAPTURE] CDP event error:', err);
    });
  };
  chrome.debugger.onEvent.addListener(record.onEvent);
  console.log('[CAPTURE] CDP listener registered', 'tabId=', tabId,
    'captureId=', record.captureId);
}

// ============================================================================
// handleInterstitialReady — blank.html signals background
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

  console.log('[CAPTURE] interstitialReady received', 'tabId=', tabId,
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
    await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url: targetUrl });
    record.setupTiming.pageNavigateEndAt = Date.now();
    console.log('[CAPTURE] Page.navigate done', 'tabId=', tabId,
      'elapsed=', (record.setupTiming.pageNavigateEndAt - record.setupTiming.pageNavigateStartAt), 'ms');
  } catch (err) {
    console.error('[CAPTURE] interstitial setup failed', 'tabId=', tabId,
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
      console.warn('[CAPTURE] max timeout', 'tabId=', tabId,
        'captureId=', record.captureId);
      doReconcile(tabId, record.captureId);
    }
  }, MAX_CAPTURE_MS);
  notifyPopup(tabId);
  resetIdleTimer(tabId, record.captureId);
  console.log('[CAPTURE] capturing started', 'tabId=', tabId,
    'captureId=', record.captureId);
}

// ============================================================================
// onCommitted — state-driven navigation handling
// ============================================================================
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const { tabId, url } = details;

  const record = captures.get(tabId);

  // ── State: USER_NAV_DETECTED → blank.html committed ──
  if (record && record.state === ST.USER_NAV_DETECTED && url.startsWith('chrome-extension://')) {
    transitionTo(record, ST.INTERSTITIAL_COMMITTED, 'onCommitted(blank.html)');
    // Safety timeout: if interstitialReady not received, abort
    record.interstitialTimer = setTimeout(() => {
      const r = captures.get(tabId);
      if (r && r.captureId === record.captureId && r.state === ST.INTERSTITIAL_COMMITTED) {
        console.error('[CAPTURE] interstitial timeout', 'tabId=', tabId);
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
  console.log('[CAPTURE] onRemoved', 'tabId=', tabId);
  disposeRecord(tabId);
});

// ============================================================================
// CDP event handling
// ============================================================================
async function handleCdpEvent(tabId, captureId, method, params, source) {
  const record = captures.get(tabId);
  if (!record || record.captureId !== captureId) return;
  if (record.state !== ST.READY && record.state !== ST.NAVIGATING_TARGET && record.state !== ST.CAPTURING) return;

  switch (method) {
    case 'Target.attachedToTarget': {
      const { targetInfo, sessionId } = params;
      if (targetInfo.type === 'page') break;
      console.log('[CDP] Target.attachedToTarget', Date.now(),
        'targetId=', targetInfo.targetId,
        'type=', targetInfo.type,
        'sessionId=', sessionId,
        'url=', (targetInfo.url || '').slice(0, 80));
      record.childTargets.set(targetInfo.targetId, {
        type: targetInfo.type,
        url: targetInfo.url,
        sessionId,
      });
      // Enable Network for child target
      await chrome.debugger.sendCommand(
        { tabId, sessionId },
        'Network.enable'
      );
      break;
    }

    case 'Target.detachedFromTarget': {
      const { targetId } = params;
      console.log('[CDP] Target.detachedFromTarget', Date.now(), 'targetId=', targetId);
      record.childTargets.delete(targetId);
      break;
    }

    case 'Network.requestWillBeSent': {
      const isDoc = params.type === 'Document' && params.frameId === 0;
      const isGateway = isGatewayUrl(params.request.url);
      const sid = source?.sessionId || null;
      const resourceKey = sid ? `${sid}:${params.requestId}` : params.requestId;

      if (isGateway) {
        const cdpReqNormKey = normalizeResourceKey(params.request.url, params.type);
        record.cdpRequests.set(resourceKey, {
          url: params.request.url,
          method: params.request.method,
          type: params.type,
          status: null,
          mime: null,
          fromCache: false,
          sessionId: sid,
          cdpRequestId: params.requestId,
          _normKey: cdpReqNormKey,
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

        if (record.setupTiming.firstCdpRequestAt === null) {
          record.setupTiming.firstCdpRequestAt = Date.now();
        }
      }
      if (isDoc && isGatewayUrl(params.request.url)) {
        if (record.documentRequestId === null) {
          record.documentRequestId = resourceKey;
          console.log('[CDP] Document requestWillBeSent', 'tabId=', tabId,
            'reqId=', resourceKey,
            'url=', params.request.url.slice(0, 100));
        }
        record.docCaptured = true;
      }

      const isTarget = RESOURCE_TYPES_FOR_SILENCE.has(params.type);

      if (isGateway && isTarget) {
        record.activeRequests++;
        resetIdleTimer(tabId, captureId);
      }
      break;
    }

    case 'Network.responseReceived': {
      const sid = source?.sessionId || null;
      const resourceKey = sid ? `${sid}:${params.requestId}` : params.requestId;
      let req = record.cdpRequests.get(resourceKey);
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
        const memCacheNormKey = normalizeResourceKey(params.response.url, params.type);
        req = {
          url: params.response.url,
          method: 'GET',
          type: params.type,
          status: params.response.status,
          mime: params.response.mimeType,
          fromCache: !!(params.response.fromDiskCache || params.response.fromServiceWorker),
          sessionId: sid,
          cdpRequestId: params.requestId,
          _normKey: memCacheNormKey,
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
        record.cdpRequests.set(resourceKey, req);
      }
      break;
    }

    case 'Network.requestServedFromCache': {
      const sid = source?.sessionId || null;
      const resourceKey = sid ? `${sid}:${params.requestId}` : params.requestId;
      const req = record.cdpRequests.get(resourceKey);
      if (req) req.fromCache = true;
      break;
    }

    case 'Network.loadingFinished': {
      const sid = source?.sessionId || null;
      const resourceKey = sid ? `${sid}:${params.requestId}` : params.requestId;
      const finReq = record.cdpRequests.get(resourceKey);
      if (finReq && RESOURCE_TYPES_FOR_SILENCE.has(finReq.type) && isGatewayUrl(finReq.url)) {
        if (finReq.requestWillBeSentTime !== null) {
          record.activeRequests--;
        }
      }
      if (finReq) finReq.loadingFinishedTime = Date.now();
      await fetchBody(tabId, captureId, resourceKey);
      checkCompletion(tabId, captureId);
      break;
    }

    case 'Network.loadingFailed': {
      const sid = source?.sessionId || null;
      const resourceKey = sid ? `${sid}:${params.requestId}` : params.requestId;
      const failReq = record.cdpRequests.get(resourceKey);
      if (failReq && RESOURCE_TYPES_FOR_SILENCE.has(failReq.type) && isGatewayUrl(failReq.url)) {
        record.activeRequests--;
      }
      if (failReq) failReq.loadingFailedTime = Date.now();
      console.warn('[CDP] loadingFailed', 'tabId=', tabId,
        'reqId=', resourceKey, 'error=', params.errorText);
      checkCompletion(tabId, captureId);
      break;
    }
  }
}

// ============================================================================
// Fetch response body — with retry and failure classification
// ============================================================================
async function fetchBody(tabId, captureId, resourceKey) {
  const record = captures.get(tabId);
  if (!record || record.captureId !== captureId) return;
  if (record.state !== ST.NAVIGATING_TARGET && record.state !== ST.CAPTURING) return;
  if (record.processed.has(resourceKey)) return;

  const req = record.cdpRequests.get(resourceKey);
  if (!req) return;
  if (!isGatewayUrl(req.url)) return;

  record.processed.add(resourceKey);
  record.pendingBodies++;

  const retryDelays = [100, 300];
  const debuggee = req.sessionId
    ? { tabId, sessionId: req.sessionId }
    : { tabId };

  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      const { body, base64Encoded } = await chrome.debugger.sendCommand(
        debuggee,
        'Network.getResponseBody',
        { requestId: req.cdpRequestId }
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
        cdpRequestId: resourceKey,
      });

      req.bodyFetchResult = 'success';

      if (req.type === 'Document') {
        record.docCaptured = true;
        console.log('[CDP] getResponseBody OK (Document)',
          'size=', size, 'url=', req.url.slice(0, 80));
      }

      record.pendingBodies--;
      return;
    } catch (e) {
      if (attempt < retryDelays.length) {
        console.warn('[CDP] getResponseBody retry',
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
          cdpRequestId: resourceKey,
        });

        req.bodyFetchResult = 'fail';
        req.bodyFetchError = e.message;

        console.error('[CDP] getResponseBody FAIL',
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
      console.log('[CAPTURE] idle complete → reconcile', 'tabId=', tabId,
        'captureId=', captureId, 'resources=', r.resources.length);
      doReconcile(tabId, captureId);
    }
  }, IDLE_MS);
}

// ============================================================================
// Reconcile — webRequest vs CDP
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
    let cdpMatch = record.cdpResources.get(normKey);

    // Fuzzy match: webRequest and CDP use different type names
    // (e.g. webRequest 'xmlhttprequest' vs CDP 'Fetch')
    if (!cdpMatch) {
      const baseUrl = normKey.split('|')[0];
      for (const [resKey, resVal] of record.cdpResources) {
        if (resKey.startsWith(baseUrl + '|')) {
          cdpMatch = resVal;
          break;
        }
      }
    }

    if (!cdpMatch) {
      cdpMissed.push(wReq);
    } else if (cdpMatch.bodySuccess) {
      captured.push(wReq);
    }
  }

  const missingA = [];
  const missingB = [];
  const missingC = [];

  for (const wReq of cdpMissed) {
    const normKey = wReq._normKey;
    const baseUrl = normKey.split('|')[0];
    let cdpReq = null;
    for (const [, r] of record.cdpRequests) {
      const rNormKey = r._normKey || normalizeResourceKey(r.url, r.type);
      if (rNormKey === normKey || rNormKey.startsWith(baseUrl + '|')) {
        cdpReq = r;
        break;
      }
    }
    const reqTime = wReq.timeStamp;
    const netEnabled = record.cdpReadyAt || 0;

    if (cdpReq) {
      missingC.push(wReq);
    } else if (reqTime < netEnabled) {
      missingA.push(wReq);
    } else {
      missingB.push(wReq);
    }
  }

  record.missingResources = missingB;

  record.captureQuality = missingB.length > 0 ? 'partial' : 'complete';
  if (!record.docCaptured) {
    record.captureQuality = 'partial';
    if (!record.error) record.error = 'document not captured';
    console.warn('[CAPTURE] reconcile: docCaptured=false, setting quality=partial');
  }

  // ---------------------------------------------------------------------------
  // Reconcile summary
  // ---------------------------------------------------------------------------
  const st = record.setupTiming;
  console.log('[CAPTURE] reconcile', captureId,
    'gatewayId=', record.gatewayId,
    'quality=', record.captureQuality,
    'duration=', Date.now() - record.startedAt, 'ms',
    'webRequest=', wReqLog.length, '(deduped:', wReqDeduped.length, ')',
    'CDP rws=', cdpReqSentCount, 'resp=', cdpRespRecvCount, 'finish=', cdpLoadFinishCount,
    'body ok=', captured.length, 'fail=', record.failedBodies.length,
    'missing A=', missingA.length, 'B=', missingB.length, 'C=', missingC.length,
    'setup attach=', (st.attachEndAt - st.attachStartAt), 'ms',
    'network=', (st.networkEnableEndAt - st.networkEnableStartAt), 'ms',
    'navigate=', (st.pageNavigateEndAt - st.pageNavigateStartAt), 'ms');

  if (missingB.length > 0) {
    console.warn('[CAPTURE] reconcile: CDP missed', missingB.length, 'resources');
    for (const m of missingB.slice(0, 5)) {
      console.warn('[CAPTURE]   missed:', m.type, m.url.slice(0, 120));
    }
    if (missingB.length > 5) console.warn('[CAPTURE]   ... and', missingB.length - 5, 'more');
  }

  webRequestLog.delete(captureId);
  completeCapture(tabId, captureId);
}

// ============================================================================
// Finalize capture
// ============================================================================
async function completeCapture(tabId, captureId) {
  const record = captures.get(tabId);
  if (!record || record.captureId !== captureId) return;

  transitionTo(record, ST.COMPLETED, 'completeCapture');
  record.durationMs = Date.now() - record.startedAt;

  console.log('[CAPTURE] completeCapture', 'tabId=', tabId,
    'captureId=', captureId,
    'gatewayId=', record.gatewayId,
    'captureQuality=', record.captureQuality,
    'resources=', record.resources.length,
    'failedBodies=', record.failedBodies.length,
    'missing=', record.missingResources.length,
    'durationMs=', record.durationMs);

  await detachDebugger(tabId, captureId);
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

  console.log('[CAPTURE] detachDebugger', 'tabId=', tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

async function abortCapture(tabId, reason) {
  const record = captures.get(tabId);
  if (!record || !ACTIVE_STATES.has(record.state)) return;
  console.warn('[CAPTURE] abortCapture', 'tabId=', tabId,
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
  console.log('[CAPTURE] disposeRecord', 'tabId=', tabId,
    'captureId=', record.captureId);
  webRequestLog.delete(record.captureId);
  await removeSessionAllowRule(tabId, record.captureId);
  await detachDebugger(tabId, record.captureId);
  captures.delete(tabId);
}

async function finishWithError(tabId, captureId, error) {
  const record = captures.get(tabId);
  if (!record || record.captureId !== captureId) return;
  console.error('[CAPTURE] finishWithError', 'tabId=', tabId,
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
  if (record && ACTIVE_STATES.has(record.state)) {
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
  // interstitialReady — blank.html notification (no sendResponse needed)
  if (msg.action === 'interstitialReady') {
    handleInterstitialReady(sender.tab.id, msg.targetUrl);
    return false;
  }

  // Popup messages
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