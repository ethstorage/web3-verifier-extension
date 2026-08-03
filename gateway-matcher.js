// =============================================================================
// gateway-matcher.js — shared matching layer
// =============================================================================
// webRequest and CDP share the same matching logic.
// Sole dependency: gateway-config.js
// =============================================================================

import { GATEWAY_CONFIG } from './gateway-config.js';

/**
 * Match a URL against gateway config.
 */
export function matchGateway(url) {
  try {
    const hostname = new URL(url).hostname;
    for (const gw of GATEWAY_CONFIG) {
      for (const host of gw.hosts) {
        if (hostname === host || hostname.endsWith('.' + host)) {
          return {
            gatewayId: gw.id,
            gatewayName: gw.name,
          };
        }
      }
    }
  } catch {
    // URL parse failure
  }
  return null;
}

/**
 * Check if a URL belongs to any gateway.
 */
export function isGatewayUrl(url) {
  return matchGateway(url) !== null;
}

/**
 * Generate url filter patterns for webRequest listener.
 * Derived automatically from GATEWAY_CONFIG.
 */
export function getWebRequestUrlPatterns() {
  const patterns = [];
  for (const gw of GATEWAY_CONFIG) {
    for (const host of gw.hosts) {
      patterns.push(`*://${host}/*`);
      patterns.push(`*://*.${host}/*`);
    }
  }
  return patterns;
}