// =============================================================================
// background.js — Web3 Gateway resource capture via CDP
// =============================================================================
// Architecture:
//   1. Try early attach in onBeforeNavigate; on success, enable CDP + reload
//   2. On early attach failure, retry immediately (up to MAX_ATTACH_RETRY_MS),
//      then fallback to onCommitted
//   3. onCommitted serves as fallback entry — only runs attach when early attach
//      did not succeed
//   4. After attach succeeds, force reload (bypassCache: true) for 100% capture
//      from the start
//
// Completion conditions:
//   activeRequests == 0              ← all target resource requests done
//   + target resource idle >= 3.5s   ← no new requests for tracked types
//   Page.loadEventFired is a soft signal only, not required
//   MAX_TIMEOUT = 30s as safety net
//
// Resource types tracked for idle detection (Fetch/Other cover wasm/workers):
//   Document, Script, Stylesheet, Image, Font, Fetch, Other
// =============================================================================

const STATE = {
  CAPTURING: 'capturing',
  COMPLETED: 'completed',
  ERROR: 'error',
};

const GATEWAY_HOSTS = ['w3link.io', 'w3eth.io'];
const MAX_CAPTURE_MS = 30000;
const IDLE_MS = 3500;              // idle window: 3.5s without new target requests
const MAX_ATTACH_RETRY_MS = 2000;  // max time to retry early attach

// Resource types tracked for idle detection (page-display resources)
const RESOURCE_TYPES_FOR_SILENCE = new Set([
  'Document', 'Script', 'Stylesheet', 'Image', 'Font',
  'Fetch', 'Other',
]);

// ============================================================================
// CaptureRecord
// ============================================================================
class CaptureRecord {
  constructor(tabId, url) {
    this.tabId = tabId;
    this.url = url;
    this.captureId = crypto.randomUUID();
    this.state = STATE.CAPTURING;
    this.capturePhase = 'initial';        // 'initial' | 'reload'
    this.captureQuality = null;           // 'complete' | 'partial' | null
    this.startedAt = Date.now();
    this.durationMs = 0;
    this.resources = [];
    this.error = null;

    // Control flags
    this.reloadPending = false;           // internal reload-triggered navigation
    this.attachReady = false;             // CDP attach succeeded (early vs fallback)

    // CDP event listener reference
    this.onEvent = null;

    // CDP session data
    this.requests = new Map();            // requestId → { url, type, status, mime }
    this.processed = new Set();           // requestIds whose body has been fetched
    this.activeRequests = 0;              // inflight target resource requests
    this.pendingBodies = 0;               // body fetches in progress
    this.docCaptured = false;             // main frame Document body captured
    this.documentRequestId = null;        // main frame Document requestId

    // Completion timers
    this.idleTimer = null;                // idle detection timer
    this.maxTimer = null;                 // safety net timeout
  }
}

// tabId → CaptureRecord
const captures = new Map();

// ---------------------------------------------------------------------------
// Utility: check if URL matches a gateway host
// ---------------------------------------------------------------------------
function isGatewayUrl(url) {
  try {
    const host = new URL(url).hostname;
    return GATEWAY_HOSTS.some((g) => host === g || host.endsWith('.' + g));
  } catch {
    return false;
  }
}

// ============================================================================
// tryAttachWithRetry — retry attach immediately until success or timeout
// ============================================================================
async function tryAttachWithRetry(tabId, maxRetryMs) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxRetryMs) {
    // Check if record still exists (may have been cleaned up by navigation)
    const record = captures.get(tabId);
    if (!record || record.state !== STATE.CAPTURING) {
      return false;
    }
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      return true;
    } catch (err) {
      // Retry immediately, no sleep
    }
  }
  return false;
}

// ============================================================================
// Entry: onBeforeNavigate (early attach + navigation-away detection)
// ============================================================================
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const { tabId, url } = details;

  const record = captures.get(tabId);

  // Non-gateway URL → abort active capture
  if (!isGatewayUrl(url)) {
    if (record && record.state === STATE.CAPTURING) {
      abortCapture(tabId, 'navigated away');
    }
    return;
  }

  // Gateway URL + internal reload → skip (onCommitted handles it)
  if (record && record.reloadPending) {
    return;
  }

  // Active capture with CDP attached → skip (CDP will track new navigation)
  if (record && record.state === STATE.CAPTURING && record.attachReady) {
    console.log('[CAPTURE] onBeforeNavigate: capture active, CDP ready', Date.now(),
      'tabId=', tabId, 'captureId=', record.captureId);
    return;
  }

  // Clean up old record (pending fallback or COMPLETED/ERROR)
  if (record) {
    await disposeRecord(tabId);
  }

  // Create new session, attempt early attach
  console.log('[CAPTURE] onBeforeNavigate → early attach start', Date.now(),
    'tabId=', tabId, 'url=', url.slice(0, 120));
  const newRecord = new CaptureRecord(tabId, url);
  captures.set(tabId, newRecord);
  newRecord.state = STATE.CAPTURING;

  const attached = await tryAttachWithRetry(tabId, MAX_ATTACH_RETRY_MS);
  if (attached) {
    newRecord.attachReady = true;
    console.log('[CAPTURE] early attach ok', Date.now(), 'tabId=', tabId,
      'captureId=', newRecord.captureId);
    await startCapturing(tabId, url, newRecord);
  } else {
    // Early attach timed out, onCommitted will handle fallback
    console.log('[CAPTURE] early attach failed, fallback to onCommitted', Date.now(),
      'tabId=', tabId, 'captureId=', newRecord.captureId);
  }
});

// Tab closed
chrome.tabs.onRemoved.addListener((tabId) => {
  console.log('[CAPTURE] onRemoved', Date.now(), 'tabId=', tabId);
  disposeRecord(tabId);
});

// ============================================================================
// Entry: onCommitted (fallback: only runs when early attach did not succeed)
// ============================================================================
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const { tabId, url } = details;
  if (!isGatewayUrl(url)) return;

  const record = captures.get(tabId);

  // Internal reload → CDP already ready, continue capturing
  if (record && record.reloadPending) {
    console.log('[CAPTURE] reload committed, CDP ready', Date.now(),
      'tabId=', tabId, 'captureId=', record.captureId);
    record.reloadPending = false;
    return;
  }

  // CDP already attached (early attach succeeded) → skip
  if (record && record.attachReady && record.state === STATE.CAPTURING) {
    return;
  }

  // Early attach failed, pending fallback → attach now
  if (record && !record.attachReady && record.state === STATE.CAPTURING) {
    console.log('[CAPTURE] onCommitted fallback: attach now', Date.now(),
      'tabId=', tabId, 'captureId=', record.captureId);
    try {
      await chrome.debugger.detach({ tabId }).catch(() => {});
      await chrome.debugger.attach({ tabId }, '1.3');
      console.log('[CAPTURE] fallback attach ok', Date.now(), 'tabId=', tabId);
      record.attachReady = true;
      await startCapturing(tabId, url, record);
    } catch (err) {
      finishWithError(tabId, record.captureId, 'attach failed: ' + err.message);
    }
    return;
  }

  // COMPLETED/ERROR → clean up old record, start fresh
  if (record) {
    await disposeRecord(tabId);
  }

  // No record (edge case: onBeforeNavigate did not fire) → new capture
  console.log('[CAPTURE] onCommitted → starting capture (no early attach)', Date.now(),
    'tabId=', tabId, 'url=', url.slice(0, 120));
  try {
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await chrome.debugger.attach({ tabId }, '1.3');
    console.log('[CAPTURE] attach ok', Date.now(), 'tabId=', tabId);
    await startCapturing(tabId, url);
  } catch (err) {
    finishWithError(tabId, null, 'attach failed: ' + err.message);
  }
});

// ============================================================================
// startCapturing — enable CDP domains, register event listener, force reload
// ============================================================================
async function startCapturing(tabId, url, existingRecord = null) {
  const record = existingRecord || new CaptureRecord(tabId, url);
  if (!existingRecord) {
    captures.set(tabId, record);
  }
  record.state = STATE.CAPTURING;

  console.log('[CAPTURE] startCapturing begin', Date.now(), 'tabId=', tabId,
    'captureId=', record.captureId, 'capturePhase=', record.capturePhase,
    'url=', url.slice(0, 120));

  // Register CDP event listener
  record.onEvent = (source, method, params) => {
    if (source.tabId !== tabId) return;
    const current = captures.get(tabId);
    if (!current || current.captureId !== record.captureId) return;
    handleCdpEvent(tabId, record.captureId, method, params).catch((err) => {
      console.warn('[CAPTURE] CDP event error:', err);
    });
  };
  chrome.debugger.onEvent.addListener(record.onEvent);

  try {
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
    console.log('[CAPTURE] Network+Page enabled', Date.now(), 'tabId=', tabId,
      'captureId=', record.captureId, '=== LISTENING READY ===');

    // Start safety-net timeout
    record.maxTimer = setTimeout(() => {
      const r = captures.get(tabId);
      if (r && r.captureId === record.captureId && r.state === STATE.CAPTURING) {
        console.log('[CAPTURE] max capture timeout', Date.now(), 'tabId=', tabId,
          'captureId=', record.captureId, 'resourcesLen=', r.resources.length);
        doValidate(tabId, record.captureId);
      }
    }, MAX_CAPTURE_MS);

    notifyPopup(tabId);

    // Force reload to capture 100% from the start
    record.capturePhase = 'reload';
    record.reloadPending = true;
    record.requests.clear();
    record.processed.clear();
    record.activeRequests = 0;
    record.pendingBodies = 0;
    record.docCaptured = false;
    record.documentRequestId = null;
    if (record.idleTimer) {
      clearTimeout(record.idleTimer);
      record.idleTimer = null;
    }

    console.log('[CAPTURE] immediate reload', Date.now(), 'tabId=', tabId,
      'captureId=', record.captureId, '=== RELOAD START ===');
    await chrome.tabs.reload(tabId, { bypassCache: true });
    console.log('[CAPTURE] reload called', Date.now(), 'tabId=', tabId,
      'bypassCache=true');
  } catch (err) {
    finishWithError(tabId, record.captureId, 'enable failed: ' + err.message);
  }
}

// ============================================================================
// CDP event handling
// ============================================================================
async function handleCdpEvent(tabId, captureId, method, params) {
  const record = captures.get(tabId);
  if (!record || record.captureId !== captureId) return;
  if (record.state !== STATE.CAPTURING) return;

  switch (method) {
    case 'Network.requestWillBeSent': {
      const isDoc = params.type === 'Document' && params.frameId === 0;
      record.requests.set(params.requestId, {
        url: params.request.url,
        method: params.request.method,
        type: params.type,
        status: null,
        mime: null,
      });
      if (isDoc && record.documentRequestId === null && isGatewayUrl(params.request.url)) {
        record.documentRequestId = params.requestId;
        console.log('[CAPTURE] Document requestWillBeSent', Date.now(),
          'tabId=', tabId, 'reqId=', params.requestId);
      }

      // Track target resource requests: increment activeRequests, reset idle timer
      const isTarget = RESOURCE_TYPES_FOR_SILENCE.has(params.type);
      const isGateway = isGatewayUrl(params.request.url);
      console.log('[CAPTURE] requestWillBeSent', Date.now(), 'tabId=', tabId,
        'captureId=', captureId,
        'type=', params.type, 'isGateway=', isGateway,
        'isTarget=', isTarget,
        'url=', params.request.url.slice(0, 100),
        'active=', record.activeRequests);

      if (isGateway && isTarget) {
        record.activeRequests++;
        resetIdleTimer(tabId, captureId);
      }
      break;
    }

    case 'Network.responseReceived': {
      const meta = record.requests.get(params.requestId);
      if (meta) {
        meta.status = params.response.status;
        meta.mime = params.response.mimeType;
      }
      break;
    }

    case 'Network.loadingFinished': {
      // Target resource finished → decrement activeRequests
      const finMeta = record.requests.get(params.requestId);
      if (finMeta && RESOURCE_TYPES_FOR_SILENCE.has(finMeta.type) && isGatewayUrl(finMeta.url)) {
        record.activeRequests--;
      }
      await fetchBody(tabId, captureId, params.requestId);
      checkCompletion(tabId, captureId);
      break;
    }

    case 'Network.loadingFailed': {
      // Target resource failed → decrement activeRequests
      const failMeta = record.requests.get(params.requestId);
      if (failMeta && RESOURCE_TYPES_FOR_SILENCE.has(failMeta.type) && isGatewayUrl(failMeta.url)) {
        record.activeRequests--;
      }
      console.log('[CAPTURE] loadingFailed', Date.now(), 'tabId=', tabId,
        'reqId=', params.requestId, 'error=', params.errorText,
        'active=', record.activeRequests);
      checkCompletion(tabId, captureId);
      break;
    }

    case 'Page.loadEventFired': {
      console.log('[CAPTURE] Page.loadEventFired', Date.now(), 'tabId=', tabId,
        'captureId=', captureId, '(soft signal, not required)',
        'active=', record.activeRequests, 'docCaptured=', record.docCaptured,
        'resourcesLen=', record.resources.length);
      // Soft signal only — not a hard requirement for completion
      break;
    }
  }
}

// ============================================================================
// Fetch response body
// ============================================================================
async function fetchBody(tabId, captureId, requestId) {
  const record = captures.get(tabId);
  if (!record || record.captureId !== captureId) return;
  if (record.state !== STATE.CAPTURING) return;
  if (record.processed.has(requestId)) return;

  const meta = record.requests.get(requestId);
  if (!meta) return;
  if (!isGatewayUrl(meta.url)) return;

  record.processed.add(requestId);
  record.pendingBodies++;

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
      url: meta.url,
      type: meta.type,
      status: meta.status,
      mime: meta.mime,
      size,
      body,
      base64Encoded,
      fetchError: false,
    });

    // Check if this is the main frame Document
    if (meta.type === 'Document' && requestId === record.documentRequestId) {
      record.docCaptured = true;
      console.log('[CAPTURE] Document body captured', Date.now(), 'tabId=', tabId,
        'captureId=', captureId, 'size=', size);
    }

    console.log('[CAPTURE] fetchBody ok', Date.now(), 'tabId=', tabId,
      'captureId=', captureId,
      'type=', meta.type, 'size=', size, 'url=', meta.url.slice(0, 80),
      'docCaptured=', record.docCaptured);
  } catch (e) {
    appendResource(tabId, captureId, {
      url: meta.url,
      type: meta.type,
      status: meta.status,
      mime: meta.mime,
      size: 0,
      body: null,
      base64Encoded: false,
      fetchError: true,
    });
    console.log('[CAPTURE] fetchBody fail', Date.now(), 'tabId=', tabId,
      'captureId=', captureId,
      'type=', meta.type, 'err=', e.message);
  }
  record.pendingBodies--;
}

function appendResource(tabId, captureId, resource) {
  const record = captures.get(tabId);
  if (!record || record.captureId !== captureId) return;
  record.resources.push(resource);
  notifyPopup(tabId);
}

// ============================================================================
// Completion check: activeRequests == 0 + idle window
// ============================================================================
function checkCompletion(tabId, captureId) {
  const record = captures.get(tabId);
  if (!record || record.captureId !== captureId) return;
  if (record.state !== STATE.CAPTURING) return;

  // activeRequests == 0 && pendingBodies == 0 → start idle timer
  if (record.activeRequests === 0 && record.pendingBodies === 0) {
    if (!record.idleTimer) {
      console.log('[CAPTURE] checkCompletion: activeRequests=0, pendingBodies=0, waiting for idle', Date.now(),
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
    if (r.state !== STATE.CAPTURING) return;
    r.idleTimer = null;
    // Idle window elapsed — check activeRequests still 0
    if (r.activeRequests === 0 && r.pendingBodies === 0) {
      console.log('[CAPTURE] idle timer: activeRequests=0, pendingBodies=0, capture complete', Date.now(),
        'tabId=', tabId, 'captureId=', captureId,
        'resourcesLen=', r.resources.length);
      r.captureQuality = 'complete';
      completeCapture(tabId, captureId);
    } else {
      // New requests arrived during idle window, keep waiting
      console.log('[CAPTURE] idle timer: activeRequests!=0, waiting more', Date.now(),
        'tabId=', tabId, 'captureId=', captureId,
        'active=', r.activeRequests);
    }
  }, IDLE_MS);
}

// ============================================================================
// Validate capture result
// ============================================================================
function doValidate(tabId, captureId) {
  const record = captures.get(tabId);
  if (!record || record.captureId !== captureId) return;
  if (record.state !== STATE.CAPTURING) return;

  console.log('[CAPTURE] doValidate', Date.now(), 'tabId=', tabId,
    'captureId=', captureId, 'docCaptured=', record.docCaptured,
    'resourcesLen=', record.resources.length);

  record.captureQuality = record.docCaptured ? 'complete' : 'partial';
  if (!record.docCaptured) {
    record.error = 'document not captured';
  }
  completeCapture(tabId, captureId);
}

// ============================================================================
// Finalize capture
// ============================================================================
function completeCapture(tabId, captureId) {
  const record = captures.get(tabId);
  if (!record || record.captureId !== captureId) return;
  if (record.state !== STATE.CAPTURING) return;

  record.state = STATE.COMPLETED;
  record.durationMs = Date.now() - record.startedAt;

  console.log('[CAPTURE] completeCapture → COMPLETED', Date.now(), 'tabId=', tabId,
    'captureId=', captureId,
    'capturePhase=', record.capturePhase,
    'captureQuality=', record.captureQuality,
    'resources=', record.resources.length,
    'durationMs=', record.durationMs);
  console.log('[CAPTURE] ── RESOURCE LIST ──');
  record.resources.forEach((r, i) => {
    console.log('[CAPTURE]   [', i, ']', r.type, r.status,
      r.fetchError ? 'FETCH_ERROR' : 'OK',
      r.size, 'bytes', r.url.slice(0, 120));
  });
  console.log('[CAPTURE] ── END ──');

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

  if (record.onEvent) {
    chrome.debugger.onEvent.removeListener(record.onEvent);
    record.onEvent = null;
  }

  console.log('[CAPTURE] detachDebugger', Date.now(), 'tabId=', tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

function abortCapture(tabId, reason) {
  const record = captures.get(tabId);
  if (!record || record.state !== STATE.CAPTURING) return;
  console.log('[CAPTURE] abortCapture', Date.now(), 'tabId=', tabId,
    'reason=', reason, 'captureId=', record.captureId);
  record.state = STATE.ERROR;
  record.error = reason;
  record.durationMs = Date.now() - record.startedAt;
  detachDebugger(tabId, record.captureId);
  notifyPopup(tabId);
}

async function disposeRecord(tabId) {
  const record = captures.get(tabId);
  if (!record) return;
  console.log('[CAPTURE] disposeRecord', Date.now(), 'tabId=', tabId,
    'captureId=', record.captureId);
  await detachDebugger(tabId, record.captureId);
  captures.delete(tabId);
}

function finishWithError(tabId, captureId, error) {
  const record = captures.get(tabId);
  if (!record || record.captureId !== captureId) return;
  console.log('[CAPTURE] finishWithError', Date.now(), 'tabId=', tabId,
    'err=', error);
  record.state = STATE.ERROR;
  record.error = error;
  record.durationMs = Date.now() - record.startedAt;
  detachDebugger(tabId, captureId);
  notifyPopup(tabId);
}

// Debugger detached externally
chrome.debugger.onDetach.addListener(({ tabId }) => {
  const record = captures.get(tabId);
  if (record && record.state === STATE.CAPTURING) {
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
// Message handling: popup ↔ background
// ============================================================================
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
              capturePhase: record.capturePhase,
              captureQuality: record.captureQuality,
              durationMs: record.durationMs,
              error: record.error,
              captureId: record.captureId,
              counts: { captured: record.resources.length },
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
            durationMs: record.durationMs,
            state: record.state,
            capturePhase: record.capturePhase,
            captureQuality: record.captureQuality,
            captureId: record.captureId,
            resources,
            summary: {
              total: record.resources.length,
              totalSize: record.resources.reduce((s, r) => s + r.size, 0),
              byType: groupByType(record.resources),
            },
          });
        } else {
          sendResponse({ resources: [], summary: { total: 0, totalSize: 0, byType: {} } });
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