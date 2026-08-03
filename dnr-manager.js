// =============================================================================
// dnr-manager.js — DNR 永久规则 + session allow 管理
// =============================================================================
// 设计：
//   1. initPermanentRules() — 永久 redirect 规则，重定向 gateway main_frame
//      到 chrome-extension://<id>/blank.html#<url>
//      规则在 service worker 每次启动时重新添加（同 ID 替换），持久化存储。
//   2. addSessionAllowRule(tabId) — 高优先级 session allow 规则，
//      在 Page.navigate 前添加，避免第二次导航被 DNR 再次拦截。
//   3. removeSessionAllowRule(tabId) — 清理 session allow 规则。
//
// 禁止: enableDnrRuleset / disableDnrRuleset 的开关模式。
// =============================================================================

import { GATEWAY_CONFIG } from './gateway-config.js';

const DNR_RULE_ID_BASE = 1000;
const SESSION_ALLOW_RULE_ID = 1;

const EXT_ID = chrome.runtime.id;

function buildPermanentRules() {
  const rules = [];
  let id = DNR_RULE_ID_BASE;
  for (const gw of GATEWAY_CONFIG) {
    for (const host of gw.hosts) {
      // exact host: https://w3eth.io/...
      rules.push({
        id: id++,
        priority: 1,
        action: {
          type: 'redirect',
          redirect: {
            regexSubstitution: `chrome-extension://${EXT_ID}/blank.html#\\0`,
          },
        },
        condition: {
          regexFilter: `^https?://${host.replace(/\./g, '\\.')}(/.*)?$`,
          resourceTypes: ['main_frame'],
        },
      });
      // subdomain: https://*.w3eth.io/...
      rules.push({
        id: id++,
        priority: 1,
        action: {
          type: 'redirect',
          redirect: {
            regexSubstitution: `chrome-extension://${EXT_ID}/blank.html#\\0`,
          },
        },
        condition: {
          regexFilter: `^https?://[^/]+\\.${host.replace(/\./g, '\\.')}(/.*)?$`,
          resourceTypes: ['main_frame'],
        },
      });
    }
  }
  return rules;
}

const PERMANENT_RULES = buildPermanentRules();
const PERMANENT_RULE_IDS = PERMANENT_RULES.map(r => r.id);

/**
 * 初始化永久 DNR 规则。每次 service worker 启动时调用。
 * 动态规则持久化在浏览器进程，同 ID 替换保证幂等。
 */
export async function initPermanentRules() {
  try {
    // 清理可能残留的 session allow rule（上次异常退出）
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [SESSION_ALLOW_RULE_ID],
    });

    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: PERMANENT_RULES,
    });
    console.log('[DNR] permanent rules initialized:', PERMANENT_RULES.length, 'rules');
  } catch (e) {
    console.error('[DNR] initPermanentRules failed:', e);
  }
}

/**
 * 为当前 tab 添加 session allow rule，绕过 DNR redirect。
 * 在 Page.navigate(targetUrl) 前调用。
 */
export async function addSessionAllowRule(tabId, captureId) {
  // Build condition: match all gateway hosts, only this tab, only main_frame
  const hostPatterns = [];
  for (const gw of GATEWAY_CONFIG) {
    for (const host of gw.hosts) {
      hostPatterns.push(host.replace(/\./g, '\\.'));
    }
  }
  const regexFilter = `^https?://([^/]+\\.)?(${hostPatterns.join('|')})(/.*)?$`;

  const rule = {
    id: SESSION_ALLOW_RULE_ID,
    priority: 100,
    action: { type: 'allow' },
    condition: {
      regexFilter,
      resourceTypes: ['main_frame'],
      tabIds: [tabId],
    },
  };

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [rule],
    });
    console.log('[DNR] session allow rule added', 'captureId=', captureId, 'tabId=', tabId);
  } catch (e) {
    console.error('[DNR] addSessionAllowRule failed:', e);
  }
}

/**
 * 移除 session allow rule。
 * 在 gateway URL committed 后或 abort/error 时调用。
 */
export async function removeSessionAllowRule(tabId, captureId) {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [SESSION_ALLOW_RULE_ID],
    });
    console.log('[DNR] session allow rule removed', 'captureId=', captureId, 'tabId=', tabId);
  } catch (e) {
    console.error('[DNR] removeSessionAllowRule failed:', e);
  }
}