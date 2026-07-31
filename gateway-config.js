// =============================================================================
// gateway-config.js — Gateway allowlist 配置
// =============================================================================
// 新增 gateway 只需在此数组中添加条目，webRequest 和 CDP 自动生效。
// =============================================================================

export const GATEWAY_CONFIG = [
  {
    id: 'w3link',
    name: 'w3link Gateway',
    hosts: ['w3link.io'],
  },
  {
    id: 'w3eth',
    name: 'w3eth Gateway',
    hosts: ['w3eth.io'],
  },
];