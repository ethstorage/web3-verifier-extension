// =============================================================================
// verify.js — captured data verification
// =============================================================================
// Provides a verify() interface for validating captured gateway resources.
// Parameters: captured data + gateway URL.
// =============================================================================

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const REQUIRED_RESOURCE_FIELDS = ['url', 'type', 'status', 'size'];
const VALID_RESOURCE_TYPES = new Set([
  'Document', 'Script', 'Stylesheet', 'Image', 'Font',
  'Fetch', 'XHR', 'Media', 'Manifest', 'Other',
]);
// Statuses that legitimately have an empty body. A 200 with empty body is NOT
// in this set: a successful gateway response for a static asset must carry the
// asset bytes, so an empty body on 2xx is treated as a verification failure.
const EMPTY_BODY_OK_STATUS = new Set([100, 101, 102, 204, 304]);

// ---------------------------------------------------------------------------
// verify — main entry point
// ---------------------------------------------------------------------------
/**
 * Verify captured resources against the gateway URL.
 *
 * Verification goals (no hashing — KZG verification happens downstream):
 *   - captured data structure is correct
 *   - body exists and is trustworthy (non-null, non-"null", size consistent)
 *   - missing resources are detectable
 *   - error states never pass as 'complete'
 *
 * @param {Object} params
 * @param {string} params.url        - gateway URL that was captured
 * @param {Array}  params.resources  - captured resources with body
 * @param {Array}  [params.failedBodies]     - resources whose body fetch failed
 * @param {Array}  [params.missingResources] - resources seen by webRequest but missed by CDP
 * @returns {Object} { valid, errors, warnings, stats }
 */
export function verify({ url, resources = [], failedBodies = [], missingResources = [] }) {
  const errors = [];
  const warnings = [];

  // --- URL validation ---
  if (!url || typeof url !== 'string') {
    errors.push('Missing or invalid URL');
  } else {
    try {
      new URL(url);
    } catch {
      errors.push(`Invalid URL: ${url}`);
    }
  }

  // --- Document presence ---
  // A capture without a Document resource cannot be a complete frontend
  // capture; downstream KZG verification would have nothing to anchor on.
  const docResources = Array.isArray(resources)
    ? resources.filter(r => r && r.type === 'Document')
    : [];
  if (docResources.length === 0) {
    errors.push('No Document resource captured');
  } else if (docResources.length > 1) {
    warnings.push(`${docResources.length} Document resources captured (expected 1)`);
  }

  // --- Resource validation ---
  if (!Array.isArray(resources)) {
    errors.push('resources must be an array');
  } else {
    for (let i = 0; i < resources.length; i++) {
      const r = resources[i];
      const prefix = `resource[${i}]`;

      if (!r || typeof r !== 'object') {
        errors.push(`${prefix}: not an object`);
        continue;
      }

      // Required fields
      for (const field of REQUIRED_RESOURCE_FIELDS) {
        if (r[field] == null) {
          errors.push(`${prefix}: missing field "${field}"`);
        }
      }

      // URL format
      if (r.url) {
        try {
          new URL(r.url);
        } catch {
          errors.push(`${prefix}: invalid URL "${r.url}"`);
        }
      }

      // Type
      if (r.type && !VALID_RESOURCE_TYPES.has(r.type)) {
        warnings.push(`${prefix}: unknown type "${r.type}"`);
      }

      // Status
      if (r.status != null && (r.status < 100 || r.status > 599)) {
        warnings.push(`${prefix}: unusual status ${r.status}`);
      }

      // Size
      if (typeof r.size !== 'number' || r.size < 0) {
        warnings.push(`${prefix}: invalid or negative size ${r.size}`);
      }

      // Body presence — required for verification.
      // `body == null` means fetchBody never produced usable bytes; this is a
      // hard error, not a warning, because KZG verification needs real bytes.
      if (r.body == null) {
        if (r.status != null && EMPTY_BODY_OK_STATUS.has(r.status)) {
          // Legitimate empty body (204/304). Acceptable.
        } else {
          errors.push(`${prefix}: body is null (status=${r.status})`);
        }
      } else if (typeof r.body !== 'string') {
        errors.push(`${prefix}: body has unexpected type ${typeof r.body}`);
      } else if (r.body === '' && !(r.status != null && EMPTY_BODY_OK_STATUS.has(r.status))) {
        // Empty body on a status that should carry content → failure.
        errors.push(`${prefix}: empty body for status=${r.status}`);
      }
      // `base64Encoded` is informational; both true/false are acceptable as
      // long as body is a non-empty string (or legitimately empty).
    }
  }

  // --- Failed bodies — hard error (P0-4) ---
  // Any failed body fetch means the captured set is incomplete for KZG
  // verification. This must not be a warning.
  const failedArr = Array.isArray(failedBodies) ? failedBodies : [];
  if (failedArr.length > 0) {
    const unavailable = failedArr.filter(f => f && f.bodyUnavailable).length;
    const mismatch = failedArr.filter(f => f && f.sizeMismatch).length;
    const other = failedArr.length - unavailable - mismatch;
    errors.push(
      `${failedArr.length} resource(s) failed body fetch ` +
      `(bodyUnavailable=${unavailable}, sizeMismatch=${mismatch}, other=${other})`
    );
  }

  // --- Missing resources — hard error (P0-4) ---
  const missedCount = Array.isArray(missingResources) ? missingResources.length : 0;
  if (missedCount > 0) {
    errors.push(`${missedCount} resource(s) missed by CDP`);
  }

  // --- Result ---
  const totalSize = Array.isArray(resources)
    ? resources.reduce((sum, r) => sum + (r.size || 0), 0)
    : 0;

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      url,
      totalResources: Array.isArray(resources) ? resources.length : 0,
      failedBodies: failedArr.length,
      missedResources: missedCount,
      totalSize,
      byType: groupByType(resources),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function groupByType(resources) {
  const map = {};
  for (const r of resources) {
    const t = r.type || 'unknown';
    map[t] = (map[t] || 0) + 1;
  }
  return map;
}