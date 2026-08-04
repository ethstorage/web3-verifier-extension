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
// Guard against net-error navigations where onCommitted never fires (P0-3).
const NAVIGATING_TARGET_TIMEOUT_MS = 15000;

const RESOURCE_TYPES_FOR_SILENCE = new Set([
  'Document', 'Script', 'Stylesheet', 'Image', 'Font',
  'Fetch', 'Other',
]);

// Content-Encoding values for which encodedDataLength (compressed bytes) is
// inherently different from the decompressed body returned by getResponseBody.
const COMPRESSED_ENCODINGS = new Set(['gzip', 'br', 'deflate']);

// Extract lowercase Content-Encoding from CDP response headers. Returns null
// when absent or non-compressed.
function extractContentEncoding(headers) {
  if (!headers) return null;
  const v = headers['Content-Encoding'] || headers['content-encoding'];
  if (!v) return null;
  const enc = String(v).toLowerCase().trim();
  return COMPRESSED_ENCODINGS.has(enc) ? enc : null;
}

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
    this.resourceCoverage = null; // Resource Coverage: 'complete' | 'partial'
    this.bodyQuality = null;      // Body Availability:  'complete' | 'partial'
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
    // Original URLs of HTTP redirect chains — prevents misclassifying them as
    // "missed" in reconcile when CDP overwrites the requestId entry (P0-7).
    this.redirectOrigins = new Set();

    this.cdpReadyAt = null;

    // Reconcile data
    this.resources = [];
    // Resource discovery (CDP requestWillBeSent) — drives Resource Coverage.
    // Decoupled from body fetch: a failed body fetch must NOT mark a resource
    // as undiscovered. bodyQuality is tracked via failedBodies instead.
    this.cdpDiscoveredResources = new Set();
    this.failedBodies = [];
    this.missingResources = [];

    // Completion timers
    this.idleTimer = null;
    this.maxTimer = null;
    this.interstitialTimer = null;
    this.navigatingTimer = null;
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
    const wReqNormKey = normalizeResourceKey(details.url, details.type);
    log.push({
      url: details.url,
      type: details.type,
      timeStamp: details.timeStamp,
      _normKey: wReqNormKey,
    });
  },
  { urls: getWebRequestUrlPatterns() }
);

// ============================================================================
// CDP setup — shared across all capture paths
// ============================================================================
async function setupCdp(tabId, record) {
  await chrome.debugger.detach({ tabId }).catch(() => {});
  await chrome.debugger.attach({ tabId }, '1.3');

  // Auto-attach child targets (worker / service_worker / OOPIF)
  // Must be called before Network.enable so that child target Network
  // events are captured from the moment they are created.
  await chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });

  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
  record.cdpReadyAt = Date.now();

  // Bypass ServiceWorker so response bodies come from the gateway origin,
  // not from a previously registered SW cache (P0-2).
  await chrome.debugger.sendCommand(
    { tabId },
    'Network.setBypassServiceWorker',
    { bypass: true }
  );

  await chrome.debugger.sendCommand({ tabId }, 'Page.enable');

  record.onEvent = (source, method, params) => {
    if (source.tabId !== tabId) return;
    const current = captures.get(tabId);
    if (!current || current.captureId !== record.captureId) return;
    handleCdpEvent(tabId, record.captureId, method, params, source).catch((err) => {
      console.warn('[CAPTURE] CDP event error:', err);
    });
  };
  chrome.debugger.onEvent.addListener(record.onEvent);
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
    await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url: targetUrl });

    // Start NAVIGATING_TARGET watchdog. If onCommitted does not arrive within
    // the timeout (DNS/TLS/net error, chrome-error:// fallback), abort so the
    // capture does not hang in NAVIGATING_TARGET forever (P0-3).
    record.navigatingTimer = setTimeout(() => {
      const r = captures.get(tabId);
      if (r && r.captureId === record.captureId && r.state === ST.NAVIGATING_TARGET) {
        console.error('[CAPTURE] navigating target timeout', 'tabId=', tabId);
        finishWithError(tabId, record.captureId, 'navigating target timeout');
      }
    }, NAVIGATING_TARGET_TIMEOUT_MS);
  } catch (err) {
    console.error('[CAPTURE] interstitial setup failed', 'tabId=', tabId,
      'err=', err.message);
    await removeSessionAllowRule(tabId, record.captureId);
    finishWithError(tabId, record.captureId, 'interstitial setup failed: ' + err.message);
  }
}

function startCaptureTimers(tabId, record) {
  // Navigation succeeded → cancel the NAVIGATING_TARGET watchdog (P0-3).
  if (record.navigatingTimer) {
    clearTimeout(record.navigatingTimer);
    record.navigatingTimer = null;
  }
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
});

// ============================================================================
// onErrorOccurred — navigation failure handling (P0-3)
// ============================================================================
// ERR_ABORTED is a normal byproduct of the capture flow's redirect-heavy
// design (DNR redirect, Page.navigate, HTTP 3xx, SW interception). It must
// NOT terminate the capture in pre-capture phases. Genuine network failures
// (DNS/TLS/timeout/connection refused) remain fatal.
chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return;
  const record = captures.get(details.tabId);
  if (!record) return;

  const isAborted = details.error === 'net::ERR_ABORTED';

  // Pre-capture phases: DNR redirect cancels the original navigation, and
  // ERR_ABORTED is expected. Ignore all errors here — the interstitial /
  // navigating watchdog timers handle true dead-ends.
  if (record.state === ST.USER_NAV_DETECTED
      || record.state === ST.INTERSTITIAL_COMMITTED
      || record.state === ST.CDP_ATTACHING
      || record.state === ST.READY) {
    if (isAborted) {
      console.warn('[CAPTURE] navigation aborted (pre-capture, ignored)',
        'tabId=', details.tabId, 'state=', record.state,
        'url=', (details.url || '').slice(0, 120));
      return;
    }
    // Non-ABORTED errors in pre-capture phases are still fatal.
    console.error('[CAPTURE] navigation error (pre-capture)',
      'tabId=', details.tabId, 'state=', record.state,
      'error=', details.error,
      'url=', (details.url || '').slice(0, 120));
    finishWithError(details.tabId, record.captureId,
      `navigation error: ${details.error}`);
    return;
  }

  // NAVIGATING_TARGET: Page.navigate(targetUrl) has been issued. ERR_ABORTED
  // here typically comes from HTTP redirects, in-page jumps, or SW navigation
  // handling — the subsequent onCommitted (or navigatingTimer watchdog) will
  // determine the real outcome. Defer to those mechanisms.
  if (record.state === ST.NAVIGATING_TARGET) {
    if (isAborted) {
      console.warn('[CAPTURE] navigation aborted (navigating target, ignored)',
        'tabId=', details.tabId,
        'url=', (details.url || '').slice(0, 120),
        '→ awaiting onCommitted or navigatingTimer watchdog');
      return;
    }
    console.error('[CAPTURE] navigation error (navigating target)',
      'tabId=', details.tabId, 'error=', details.error,
      'url=', (details.url || '').slice(0, 120));
    finishWithError(details.tabId, record.captureId,
      `navigation error: ${details.error}`);
  }

  // CAPTURING and terminal states: not navigation-related, ignore.
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
      try {
        await chrome.debugger.sendCommand(
          { tabId, sessionId },
          'Network.enable'
        );
      } catch (e) {
        console.warn('[CDP] Network.enable failed for child target',
          'type=', targetInfo.type,
          'err=', e.message);
      }
      break;
    }

    case 'Network.requestWillBeSent': {
      const isDoc = params.type === 'Document' && params.frameId === 0;
      const isGateway = isGatewayUrl(params.request.url);
      const sid = source?.sessionId || null;
      const resourceKey = sid ? `${sid}:${params.requestId}` : params.requestId;

      // HTTP redirect (P0-7): CDP reuses requestId for the redirected request.
      // Save original URL to redirectOrigins, clear processed so the final
      // request's loadingFinished can trigger fetchBody for the final body.
      const isRedirect = !!params.redirectResponse;
      const prevEntry = isRedirect ? record.cdpRequests.get(resourceKey) : null;
      if (prevEntry) {
        record.redirectOrigins.add(prevEntry.url);
        record.processed.delete(resourceKey);
      }

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
          encodedDataLength: null,
          bodyFetchResult: null,
        });
        // Record CDP discovery — independent of later body fetch outcome.
        record.cdpDiscoveredResources.add(cdpReqNormKey);
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
        req.encodedDataLength = params.response.encodedDataLength;
        req.contentEncoding = extractContentEncoding(params.response.headers);
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
          encodedDataLength: params.response.encodedDataLength,
          contentEncoding: extractContentEncoding(params.response.headers),
          bodyFetchResult: null,
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
      await fetchBody(tabId, captureId, resourceKey);
      checkCompletion(tabId, captureId);
      break;
    }

    case 'Network.loadingFailed': {
      const sid = source?.sessionId || null;
      const resourceKey = sid ? `${sid}:${params.requestId}` : params.requestId;
      const failReq = record.cdpRequests.get(resourceKey);
      // Guard: only decrement when requestWillBeSent was recorded (P0-5).
      if (failReq
          && RESOURCE_TYPES_FOR_SILENCE.has(failReq.type)
          && isGatewayUrl(failReq.url)
          && failReq.requestWillBeSentTime !== null) {
        record.activeRequests--;
      }
      console.warn('[CDP] loadingFailed', 'tabId=', tabId,
        'reqId=', resourceKey, 'error=', params.errorText);
      checkCompletion(tabId, captureId);
      break;
    }
  }
}

// ============================================================================
// Fetch response body — with retry, body validation and failure classification
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

  try {
    const retryDelays = [100, 300];
    const debuggee = req.sessionId
      ? { tabId, sessionId: req.sessionId }
      : { tabId };

    let lastErr = null;
    let resp = null;

    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        resp = await chrome.debugger.sendCommand(
          debuggee,
          'Network.getResponseBody',
          { requestId: req.cdpRequestId }
        );
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < retryDelays.length) {
          console.warn('[CDP] getResponseBody retry',
            'type=', req.type, 'attempt=', attempt + 1,
            'delay=', retryDelays[attempt], 'ms',
            'url=', req.url.slice(0, 80));
          await new Promise(r => setTimeout(r, retryDelays[attempt]));
        }
      }
    }

    if (lastErr !== null) {
      classifyAndAppendFailure(tabId, captureId, req, resourceKey, lastErr);
      return;
    }

    const { body, base64Encoded } = resp;
    const validated = validateBody(body, base64Encoded, req);

    if (!validated.ok) {
      // Treat as failure: no usable body. Do NOT appendResource; resourceCoverage
      // must not be 'complete' when body is null/empty-but-expected/non-string.
      classifyAndAppendFailure(tabId, captureId, req, resourceKey, {
        message: validated.reason,
      }, { bodyUnavailable: validated.bodyUnavailable });
      return;
    }

    const size = validated.size;
    appendResource(tabId, captureId, {
      url: req.url,
      type: req.type,
      status: req.status,
      size,
      body,
      base64Encoded,
    });

    req.bodyFetchResult = 'success';

    if (req.type === 'Document') {
      record.docCaptured = true;
      console.log('[CDP] getResponseBody OK (Document)',
        'size=', size, 'url=', req.url.slice(0, 80));
    }
  } finally {
    record.pendingBodies--;
  }
}

// ----------------------------------------------------------------------------
// validateBody — returns { ok, size, reason, bodyUnavailable }
// ----------------------------------------------------------------------------
function validateBody(body, base64Encoded, req) {
  if (body == null || typeof body !== 'string') {
    return {
      ok: false,
      reason: `body ${body == null ? 'is null' : `has type ${typeof body}`}`,
      bodyUnavailable: true,
    };
  }

  let size;
  try {
    size = base64Encoded
      ? atob(body).length
      : new TextEncoder().encode(body).length;
  } catch (e) {
    return {
      ok: false,
      reason: `body decode failed: ${e.message}`,
      bodyUnavailable: true,
    };
  }

  if (size === 0) {
    // Empty body is OK only for 1xx/204/304; otherwise it indicates the body
    // could not be read.
    const status = req.status;
    const emptyOkStatus = status != null && (
      status < 200 || status === 204 || status === 304
    );
    const reportedLen = req.encodedDataLength;
    if (emptyOkStatus && (reportedLen == null || reportedLen === 0)) {
      return { ok: true, size: 0 };
    }
    return {
      ok: false,
      reason: `empty body for status=${status} encodedDataLength=${reportedLen}`,
      bodyUnavailable: true,
    };
  }

  return { ok: true, size };
}

// ----------------------------------------------------------------------------
// classifyAndAppendFailure — shared failure path for fetchBody
// ----------------------------------------------------------------------------
function classifyAndAppendFailure(tabId, captureId, req, resourceKey, err, extra = {}) {
  const isBodyUnavailable = extra.bodyUnavailable != null
    ? extra.bodyUnavailable
    : /no resource with given identifier/i.test(err.message);

  const failEntry = {
    url: req.url,
    type: req.type,
    bodyUnavailable: isBodyUnavailable,
    sizeMismatch: !!extra.sizeMismatch,
  };

  appendFailedBody(tabId, captureId, failEntry);

  req.bodyFetchResult = 'fail';

  console.error('[CDP] getResponseBody FAIL',
    'type=', req.type, 'err=', err.message,
    'bodyUnavailable=', isBodyUnavailable,
    'sizeMismatch=', !!extra.sizeMismatch,
    'fromCache=', req.fromCache,
    'url=', req.url.slice(0, 80));
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

  const cdpMissed = [];

  for (const wReq of wReqDeduped) {
    const normKey = wReq._normKey;

    // Redirect origin (P0-7): the original URL in an HTTP redirect chain was
    // seen by webRequest and by CDP (its 3xx body was fetched), but its
    // cdpRequests entry was overwritten by the final URL. Treat it as captured
    // so it is not falsely reported as missing.
    if (record.redirectOrigins.has(wReq.url)) {
      continue;
    }

    let cdpMatch = record.cdpDiscoveredResources.has(normKey);

    // Fuzzy match: webRequest and CDP use different type names
    if (!cdpMatch) {
      const baseUrl = normKey.split('|')[0];
      for (const discKey of record.cdpDiscoveredResources) {
        if (discKey.startsWith(baseUrl + '|')) {
          cdpMatch = true;
          break;
        }
      }
    }

    // Final fallback: record.resources is the source of truth. A resource
    // whose body was successfully appended is by definition captured, even
    // if CDP requestWillBeSent was missed (e.g. browser-internal favicon
    // fetch). Intermediate tracking (cdpDiscoveredResources) must not
    // override the final captured-set evidence.
    if (!cdpMatch) {
      const baseUrl = normKey.split('|')[0];
      for (const r of record.resources) {
        if (r.url.startsWith(baseUrl)) {
          cdpMatch = true;
          break;
        }
      }
    }

    if (!cdpMatch) {
      cdpMissed.push(wReq);
    }
  }

  const missingB = [];
  const netEnabled = record.cdpReadyAt || 0;

  for (const wReq of cdpMissed) {
    const normKey = wReq._normKey;
    const baseUrl = normKey.split('|')[0];

    // Final fallback: check record.resources before declaring missing.
    // cdpRequests may have been overwritten or never created for resources
    // that still ended up captured (redirect, responseReceived fallback).
    let captured = false;
    for (const r of record.resources) {
      if (r.url.startsWith(baseUrl)) {
        captured = true;
        break;
      }
    }
    if (captured) continue;

    let cdpReq = null;
    for (const [, r] of record.cdpRequests) {
      const rNormKey = r._normKey || normalizeResourceKey(r.url, r.type);
      if (rNormKey === normKey || rNormKey.startsWith(baseUrl + '|')) {
        cdpReq = r;
        break;
      }
    }
    if (!cdpReq && wReq.timeStamp >= netEnabled) {
      missingB.push(wReq);
    }
  }

  record.missingResources = missingB;

  // resourceCoverage — based on the final captured set (record.resources),
  // not on intermediate tracking flags. docDiscovered is true when a
  // Document resource is present in the captured set.
  // Missing resources are a coverage gap, NOT a pipeline error — record.error
  // is reserved exclusively for capture pipeline failures.
  const docDiscovered = record.resources.some(r => r.type === 'Document');
  const hasMissing = missingB.length > 0;

  if (docDiscovered && !hasMissing) {
    record.resourceCoverage = 'complete';
  } else {
    record.resourceCoverage = 'partial';
    console.warn('[CAPTURE] reconcile: resourceCoverage=partial',
      'docDiscovered=', docDiscovered,
      'missingB=', missingB.length);
  }

  // bodyQuality — based on the final captured set. docBodyOk is true when
  // a Document resource with a non-null body is present. Intermediate
  // bodyFetchResult / documentRequestId are debug-only and must not drive
  // the final quality verdict.
  const docBodyOk = record.resources.some(r =>
    r.type === 'Document' && r.body != null
  );
  const hasFailedBodies = record.failedBodies.length > 0;

  if (docBodyOk && !hasFailedBodies) {
    record.bodyQuality = 'complete';
  } else {
    record.bodyQuality = 'partial';
    console.warn('[CAPTURE] reconcile: bodyQuality=partial',
      'docBodyOk=', docBodyOk,
      'failedBodies=', record.failedBodies.length);
  }

  // ---------------------------------------------------------------------------
  // Reconcile summary
  // ---------------------------------------------------------------------------
  console.log('[CAPTURE] reconcile', captureId,
    'gatewayId=', record.gatewayId,
    'resourceCoverage=', record.resourceCoverage,
    'bodyQuality=', record.bodyQuality,
    'duration=', Date.now() - record.startedAt, 'ms',
    'webRequest=', wReqLog.length, '(deduped:', wReqDeduped.length, ')',
    'fail=', record.failedBodies.length,
    'missingB=', missingB.length);

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
    'resourceCoverage=', record.resourceCoverage,
    'bodyQuality=', record.bodyQuality,
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
  if (record.navigatingTimer) { clearTimeout(record.navigatingTimer); record.navigatingTimer = null; }

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
              resourceCoverage: record.resourceCoverage,
              bodyQuality: record.bodyQuality,
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
            resourceCoverage: record.resourceCoverage,
            bodyQuality: record.bodyQuality,
            captureId: record.captureId,
            resources,
            failedBodies: record.failedBodies.map(r => ({
              url: r.url,
              type: r.type,
              bodyUnavailable: r.bodyUnavailable,
              sizeMismatch: r.sizeMismatch,
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