// =============================================================================
// gateway-matcher.js — 共享匹配层
// =============================================================================
// webRequest 和 CDP 两边共用同一套匹配逻辑。
// 唯一依赖：gateway-config.js
// =============================================================================

import { GATEWAY_CONFIG } from './gateway-config.js';

/**
 * 根据 URL 匹配 gateway 配置。
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
    // URL parse 失败
  }
  return null;
}

/**
 * 判断 URL 是否属于任意 gateway。
 */
export function isGatewayUrl(url) {
  return matchGateway(url) !== null;
}

/**
 * 生成 webRequest listener 的 urls filter 参数。
 * 从 GATEWAY_CONFIG 自动推导，无需手动维护。
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