// =============================================================================
// popup.js — Web3 Gateway capture result display (read-only)
// =============================================================================
// The popup only does:
//   1. Get the currently active tabId
//   2. Read the capture result for that tab (getState / getResults)
//   3. Display it
//
// The popup must NOT:
//   - Clear results (no clearResults message)
//   - Create/destroy sessions
//   - Affect the capture lifecycle
//
// On tab switch, the popup re-reads the newly active tab's data.
// stateChanged push includes tabId; the popup only responds to its own tabId.
// =============================================================================

const $ = (id) => document.getElementById(id);

let allResources = [];
let missedResources = [];
let failedBodies = [];
let expanded = false;
let pollingTimer = null;
let activeTabId = null;       // tab currently focused by popup
let activeCaptureId = null;   // prevents stale response contamination after tab switch

// ---- Initialization ----
document.addEventListener('DOMContentLoaded', () => {
  $('btnToggle').addEventListener('click', toggleExpand);

  // Tab switch → re-read newly active tab data
  chrome.tabs.onActivated.addListener((activeInfo) => {
    if (activeInfo.tabId !== activeTabId) {
      console.log('[POPUP] tab activated', activeInfo.tabId);
      refreshActiveTab();
    }
  });

  // Receive background push (includes tabId)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === 'stateChanged') {
      // Only respond to the tab currently focused by the popup
      if (msg.tabId === activeTabId) {
        refreshState();
      }
    }
  });

  refreshActiveTab();
});

// ---- Get active tab, read its capture data ----
async function refreshActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab ? tab.id : null;
    activeCaptureId = null;  // reset, wait for getState response
  } catch {
    activeTabId = null;
  }
  await refreshState();
}

// ---- State refresh ----
async function refreshState() {
  if (activeTabId == null) {
    showInactive();
    return;
  }
  try {
    const res = await chrome.runtime.sendMessage({ action: 'getState', tabId: activeTabId });
    if (!res || !res.state) {
      showInactive();
      return;
    }
    const s = res.state;
    activeCaptureId = s.captureId || null;  // record current captureId to prevent stale responses
    console.log('[POPUP] refreshState', 'state=', s.state, 'captureId=', s.captureId,
      'captured=', s.counts?.captured, 'activeCaptureId=', activeCaptureId);
    updateStatus(s);

    if (s.state === 'user_nav_detected' || s.state === 'interstitial_committed' ||
        s.state === 'cdp_attaching' || s.state === 'ready' ||
        s.state === 'navigating_target' ||
        s.state === 'capturing') {
      await loadResults();
      schedulePoll(800); // fallback polling
    } else if (s.state === 'completed' || s.state === 'error') {
      stopPoll();
      await loadResults();
    } else {
      stopPoll();
    }
  } catch (err) {
    console.warn('refreshState error:', err.message);
    showInactive();
  }
}

function schedulePoll(ms) {
  stopPoll();
  pollingTimer = setTimeout(refreshState, ms);
}
function stopPoll() {
  if (pollingTimer) { clearTimeout(pollingTimer); pollingTimer = null; }
}

function showInactive() {
  updateStatus({ state: 'inactive' });
}

// ---- Status bar ----
function updateStatus(s) {
  const statusBar = $('statusBar');
  statusBar.className = 'status-' + s.state;
  const captured = s.counts && s.counts.captured != null ? s.counts.captured : 0;
  const missed = s.counts && s.counts.missed != null ? s.counts.missed : 0;
  const bodyFetchErrors = s.counts && s.counts.failedBodies != null ? s.counts.failedBodies : 0;

  switch (s.state) {
    case 'inactive':
      $('statusIcon').textContent = '\u2299';
      $('statusText').textContent = 'Waiting for gateway page...';
      $('statusTime').textContent = '';
      hide($('summary'));
      hide($('results'));
      break;

    case 'user_nav_detected':
    case 'interstitial_committed':
    case 'cdp_attaching':
    case 'ready':
    case 'navigating_target':
      $('statusIcon').textContent = '\u25CF';
      $('statusText').textContent = 'Setting up capture...';
      $('statusTime').textContent = '';
      break;

    case 'capturing':
      $('statusIcon').textContent = '\u25CF';
      $('statusText').textContent = 'Capturing gateway traffic...';
      $('statusTime').textContent = captured > 0 ? 'Captured ' + captured + ', waiting for idle' : '';
      break;

    case 'completed':
      $('statusIcon').textContent = '\u2713';
      {
        let qualityText = '';
        if (s.captureQuality === 'complete') qualityText = 'Complete';
        else if (s.captureQuality === 'partial') qualityText = 'Partial';
        const gatewayText = s.gatewayName ? ' \u2022 ' + s.gatewayName : '';
        $('statusText').textContent = 'Capture ' + (qualityText || 'done');
        let timeInfo = '';
        if (s.durationMs) timeInfo = (s.durationMs / 1000).toFixed(1) + 's';
        if (missed > 0) timeInfo += ' \u2022 ' + missed + ' missed';
        if (bodyFetchErrors > 0) timeInfo += ' \u2022 ' + bodyFetchErrors + ' fetch err';
        $('statusTime').textContent = (timeInfo || '') + gatewayText;
      }
      break;

    case 'error':
      $('statusIcon').textContent = '\u2717';
      $('statusText').textContent = s.error || 'Error occurred';
      $('statusTime').textContent = (captured > 0 ? 'Captured ' + captured : '')
        + (bodyFetchErrors > 0 ? ' \u2022 ' + bodyFetchErrors + ' fetch err' : '');
      break;
  }
}

// ---- Load and display results (shared by capturing/completed) ----
async function loadResults() {
  if (activeTabId == null) return;
  const res = await chrome.runtime.sendMessage({ action: 'getResults', tabId: activeTabId });
  // Prevent stale response contamination: verify captureId
  if (res && res.captureId && activeCaptureId && res.captureId !== activeCaptureId) {
    console.log('[POPUP] stale results ignored', 'resCaptureId=', res.captureId, 'activeCaptureId=', activeCaptureId);
    return;
  }
  allResources = (res && res.resources) || [];
  missedResources = (res && res.missedResources) || [];
  failedBodies = (res && res.failedBodies) || [];
  const summary = (res && res.summary) || { total: 0, totalSize: 0, missed: 0, failedBodies: 0 };
  console.log('[POPUP] loadResults', 'total=', summary.total, 'missed=', summary.missed,
    'failedBodies=', summary.failedBodies,
    'byType=', JSON.stringify(summary.byType), 'captureId=', res?.captureId);

  $('sumTotal').textContent = summary.total;
  $('sumSize').textContent = formatBytes(summary.totalSize);
  if (summary.missed > 0) {
    $('sumMissed').textContent = summary.missed;
    show($('sumMissedItem'));
  } else {
    hide($('sumMissedItem'));
  }

  const hasAny = allResources.length > 0 || missedResources.length > 0 || failedBodies.length > 0;
  if (hasAny) {
    show($('summary'));
    updateToggleButton();
    if (expanded) {
      renderList();
      show($('results'));
    }
  } else {
    hide($('summary'));
    hide($('results'));
  }
}

// ---- Expand/collapse file list ----
function toggleExpand() {
  expanded = !expanded;
  updateToggleButton();
  if (expanded) {
    renderList();
    show($('results'));
  } else {
    hide($('results'));
  }
}

function updateToggleButton() {
  const btn = $('btnToggle');
  const total = allResources.length + missedResources.length + failedBodies.length;
  if (total === 0) {
    btn.textContent = 'Show Files';
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  btn.textContent = expanded
    ? 'Hide Files'
    : `Show Files (${total})`;
}

function renderList() {
  const list = $('resultsList');
  const items = [];

  // Captured resources
  allResources.forEach((r) => {
    const name = escapeHtml(fileName(r.url));
    const fullUrl = escapeHtml(r.url);
    const sizeStr = formatBytes(r.size);
    items.push(`
      <div class="result-item" title="${fullUrl}">
        <span class="result-name">${name}</span>
        <span class="result-size">${sizeStr}</span>
      </div>`);
  });

  // Missed resources
  missedResources.forEach((r) => {
    const name = escapeHtml(fileName(r.url));
    const fullUrl = escapeHtml(r.url);
    items.push(`
      <div class="result-item result-missed" title="${fullUrl}">
        <span class="result-tag">MISSED</span>
        <span class="result-name">${name}</span>
        <span class="result-size">${r.type}</span>
      </div>`);
  });

  // Body fetch errors
  failedBodies.forEach((r) => {
    const name = escapeHtml(fileName(r.url));
    const fullUrl = escapeHtml(r.url);
    items.push(`
      <div class="result-item result-fetch-error" title="${fullUrl}">
        <span class="result-tag">FETCH ERR</span>
        <span class="result-name">${name}</span>
        <span class="result-size">${r.type}</span>
      </div>`);
  });

  list.innerHTML = items.join('');
}

// ---- Utilities ----
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function fileName(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    if (seg) return decodeURIComponent(seg);
    return u.hostname + '/';
  } catch {
    return url;
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}