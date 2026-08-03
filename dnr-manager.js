// =============================================================================
// dnr-manager.js — DNR permanent rules + session allow management
// =============================================================================
// Design:
//   1. initPermanentRules() — permanent redirect rules, send gateway main_frame
//      to chrome-extension://<id>/blank.html#<url>
//      Old rules are removed before re-adding to handle persistence across restarts.
//   2. addSessionAllowRule(tabId) — high-priority session allow rule,
//      added before Page.navigate to prevent second navigation from being intercepted.
//   3. removeSessionAllowRule(tabId) — cleanup session allow rule.
//
// Forbidden: enableDnrRuleset / disableDnrRuleset toggle pattern.
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
 * Initialize permanent DNR rules. Called on every service worker start.
 * Dynamic rules persist across restarts, so old rules must be removed first.
 */
export async function initPermanentRules() {
  try {
    // Clean up leftover session allow rule from previous abnormal exit
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [SESSION_ALLOW_RULE_ID],
    });

    // Remove old rules with same IDs, then add current definitions
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: PERMANENT_RULE_IDS,
      addRules: PERMANENT_RULES,
    });
    console.log('[DNR] permanent rules initialized:', PERMANENT_RULES.length, 'rules');
  } catch (e) {
    console.error('[DNR] initPermanentRules failed:', e);
  }
}

/**
 * Add session allow rule for the current tab to bypass DNR redirect.
 * Called before Page.navigate(targetUrl).
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
 * Remove session allow rule.
 * Called after gateway URL committed or on abort/error.
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