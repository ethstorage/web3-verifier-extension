// =============================================================================
// blank.js — interstitial page logic
// =============================================================================
// DNR redirects gateway main_frame to this page.
// Signals background on load, stays blank, waits for background CDP re-navigation.

console.log('[BLANK] page loaded',
  'hash=', window.location.hash ? window.location.hash.slice(0, 120) : '(empty)');

const targetUrl = decodeURIComponent(window.location.hash.slice(1));

if (targetUrl) {
  console.log('[BLANK] sending interstitialReady',
    'targetUrl=', targetUrl.slice(0, 120));
  chrome.runtime.sendMessage({
    action: 'interstitialReady',
    targetUrl,
  }).then(() => {
    console.log('[BLANK] interstitialReady ACK');
  }).catch((err) => {
    console.error('[BLANK] sendMessage failed:', err.message);
  });
} else {
  console.error('[BLANK] no target URL in hash',
    'hash=', window.location.hash,
    'href=', window.location.href.slice(0, 200));
}