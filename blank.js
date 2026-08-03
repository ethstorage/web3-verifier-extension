// =============================================================================
// blank.js — interstitial page 逻辑
// =============================================================================
// DNR 将 gateway main_frame 重定向到此页面。
// 页面加载后通知 background，保持空白，等待 background 通过 CDP 重新导航。

console.log('[BLANK] page loaded', Date.now(),
  'hash=', window.location.hash ? window.location.hash.slice(0, 120) : '(empty)');

const targetUrl = decodeURIComponent(window.location.hash.slice(1));

if (targetUrl) {
  console.log('[BLANK] sending interstitialReady', Date.now(),
    'targetUrl=', targetUrl.slice(0, 120));
  chrome.runtime.sendMessage({
    action: 'interstitialReady',
    targetUrl,
  }).then(() => {
    console.log('[BLANK] interstitialReady ACK', Date.now());
  }).catch((err) => {
    console.error('[BLANK] sendMessage failed:', err.message);
  });
} else {
  console.error('[BLANK] no target URL in hash',
    'hash=', window.location.hash,
    'href=', window.location.href.slice(0, 200));
}