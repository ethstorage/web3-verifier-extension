// =============================================================================
// dnr-manager.js — DNR 动态规则管理
// =============================================================================
// 从 GATEWAY_CONFIG 自动生成 DNR 规则，单一数据源。
// =============================================================================

import { GATEWAY_CONFIG } from './gateway-config.js';

const DNR_RULE_ID_BASE = 1000;

function buildDnrRules() {
  const rules = [];
  let id = DNR_RULE_ID_BASE;
  for (const gw of GATEWAY_CONFIG) {
    for (const host of gw.hosts) {
      rules.push({
        id: id++,
        priority: 1,
        action: { type: 'redirect', redirect: { url: 'about:blank' } },
        condition: { urlFilter: `||${host}`, resourceTypes: ['main_frame'] },
      });
      rules.push({
        id: id++,
        priority: 1,
        action: { type: 'redirect', redirect: { url: 'about:blank' } },
        condition: { urlFilter: `||*.${host}`, resourceTypes: ['main_frame'] },
      });
    }
  }
  return rules;
}

const DNR_RULES = buildDnrRules();
const DNR_RULE_IDS = DNR_RULES.map(r => r.id);

export async function enableDnrRuleset() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: DNR_RULES,
    });
    console.log('[DNR] enabled', DNR_RULES.length, 'rules');
  } catch (e) {
    console.error('[DNR] enable failed', e);
  }
}

export async function disableDnrRuleset() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: DNR_RULE_IDS,
    });
    console.log('[DNR] disabled', DNR_RULE_IDS.length, 'rules');
  } catch (e) {
    console.error('[DNR] disable failed', e);
  }
}

