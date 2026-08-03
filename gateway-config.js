// =============================================================================
// gateway-config.js — Gateway allowlist
// =============================================================================
// Add new gateways here; webRequest and CDP pick them up automatically.
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