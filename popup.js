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

    if (s.state === 'capturing') {
      await loadResults();
      schedulePoll(800); // fallback polling
    } else if (s.state === 'completed') {
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

  switch (s.state) {
    case 'inactive':
      $('statusIcon').textContent = '\u2299';
      $('statusText').textContent = 'Waiting for w3link.io / w3eth.io gateway...';
      $('statusTime').textContent = '';
      hide($('summary'));
      hide($('results'));
      break;

    case 'capturing':
      $('statusIcon').textContent = '\u25CF';
      $('statusText').textContent = s.capturePhase === 'reload'
        ? 'Reloading and capturing...'
        : 'Capturing gateway traffic...';
      $('statusTime').textContent = captured > 0 ? 'Captured ' + captured + ', waiting for idle' : '';
      break;

    case 'completed':
      $('statusIcon').textContent = '\u2713';
      {
        let qualityText = '';
        if (s.captureQuality === 'complete') qualityText = 'Complete';
        else if (s.captureQuality === 'partial') qualityText = 'Partial';
        else if (s.capturePhase === 'reload') qualityText = 'Captured after reload';
        const phaseText = s.capturePhase === 'reload' ? ' (reload)' : '';
        $('statusText').textContent = 'Capture complete' + (qualityText ? ' \u2022 ' + qualityText : '');
        $('statusTime').textContent = (s.durationMs
          ? (s.durationMs / 1000).toFixed(1) + 's'
          : '') + (phaseText ? ' ' + phaseText : '');
      }
      break;

    case 'error':
      $('statusIcon').textContent = '\u2717';
      $('statusText').textContent = s.error || 'Error occurred';
      $('statusTime').textContent = captured > 0 ? 'Captured ' + captured : '';
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
  const summary = (res && res.summary) || { total: 0, totalSize: 0 };
  console.log('[POPUP] loadResults', 'total=', summary.total, 'byType=', JSON.stringify(summary.byType),
    'captureId=', res?.captureId);

  $('sumTotal').textContent = summary.total;
  $('sumSize').textContent = formatBytes(summary.totalSize);

  if (allResources.length > 0) {
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
  if (allResources.length === 0) {
    btn.textContent = 'Show Files';
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  btn.textContent = expanded
    ? 'Hide Files'
    : `Show Files (${allResources.length})`;
}

function renderList() {
  const list = $('resultsList');
  list.innerHTML = allResources
    .map((r) => {
      const name = escapeHtml(fileName(r.url));
      const fullUrl = escapeHtml(r.url);
      const sizeStr = formatBytes(r.size);
      return `
        <div class="result-item" title="${fullUrl}">
          <span class="result-name">${name}</span>
          <span class="result-size">${sizeStr}</span>
        </div>`;
    })
    .join('');
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