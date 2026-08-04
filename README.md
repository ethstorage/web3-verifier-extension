# Web3 Gateway Proof - POC

A Chrome MV3 extension that captures static resources served by Web3 gateways
(`w3link.io`, `w3eth.io`) via the Chrome DevTools Protocol (CDP). Captured
data is intended as input for **proof verification** — confirming that a
gateway returned the correct, untampered content for a given URL.

> **Status**
> - Resource capture: implemented and exercised end-to-end.
> - Proof verification / KZG commitment verification: **not implemented**.
>   `verify.js` is a structural validator only (shape / body presence /
>   missing-resource checks), and is not wired into the capture pipeline.

## Why DNR + interstitial?

Chrome MV3 exposes `chrome.debugger` (CDP) as an out-of-process attach API.
The hard problem is **timing**: by the time `webNavigation.onBeforeNavigate`
fires for a real gateway URL, the document request has often already been
issued and may have completed. Attaching CDP after that point means missing
the very first request — which for a Web3 gateway is usually the HTML
document anchoring every subsequent asset.

The extension solves this by never letting the browser load the gateway URL
directly on the first hop. A permanent DNR rule redirects the `main_frame`
request to an extension interstitial page; CDP is attached on that blank
page; the background then issues `Page.navigate(targetUrl)` itself, so CDP
is fully listening before the gateway receives any request.

## How It Works

```
User navigates to gateway URL
        │
        │  DNR permanent rule redirects main_frame
        ▼
Interstitial page (blank.html) commits
        │  blank.js signals background via interstitialReady
        ▼
Background attaches Chrome debugger (CDP)
  - Target.setAutoAttach (workers / OOPIFs)
  - Network.enable + Network.setBypassServiceWorker
  - Page.enable
        │
        │  Add session allow rule (priority 100, tab-scoped)
        │  to bypass the permanent redirect for this tab only
        ▼
Page.navigate(original gateway URL)
        │  Gateway URL commits → remove session allow rule
        ▼
Capture requests / responses / bodies via CDP Network events
        │  Idle for 3.5s with no in-flight requests  OR  30s hard cap
        ▼
Reconcile CDP results vs webRequest audit log
  - detect resources CDP missed
  - compute resourceCoverage / bodyQuality
        ▼
Persist terminal summary → notify popup
```

Key design points:

- **Permanent DNR rules** (priority 1) redirect any `main_frame` request to a
  gateway host → `chrome-extension://<id>/blank.html#<original-url>`. They
  are re-installed idempotently on every service-worker start.
- **Session allow rule** (priority 100, `tabIds: [tabId]`) is added before
  `Page.navigate` so the programmatic navigation reaches the gateway, and
  removed the moment the gateway URL commits — so subsequent user-typed
  gateway navigations are intercepted again.
- **`blank.js` only signals** `interstitialReady` with the target URL. It
  never navigates on its own; all further navigation is driven by the
  background via CDP.
- **`webRequest` runs in parallel** as a non-blocking audit log, used by the
  reconcile phase to detect resources CDP missed.
- **`Network.setBypassServiceWorker { bypass: true }`** ensures response
  bodies come from the gateway origin, not a previously registered SW cache.

## Resource Tracking

Captured resource types (CDP `Network.requestWillBeSent` `type`):

| Type        | Examples                          |
|-------------|-----------------------------------|
| Document    | HTML pages                        |
| Script      | JS bundles, dynamic imports       |
| Stylesheet  | CSS files                         |
| Image       | PNG, SVG, WebP, etc.              |
| Font        | WOFF2, TTF                        |
| Fetch       | `fetch()`-loaded assets, wasm     |
| Other       | Web Workers, some wasm loads      |

- Response bodies are fetched via `Network.getResponseBody`, with short
  retry backoff. Requests from workers / service workers / OOPIFs use the
  child target's `sessionId`.
- `record.resources` is the single source of truth for the final capture
  set. Reconcile uses it as the fallback when matching against the
  `webRequest` audit log.
- Missing resources (seen by `webRequest` but not by CDP) are reported as a
  **coverage gap** (`resourceCoverage: partial`), not as a pipeline error.

## Project Structure

```
├── manifest.json          # MV3 manifest — permissions, SW, web_accessible_resources
├── background.js          # Service worker: state machine, CDP capture, reconcile
├── dnr-manager.js         # Permanent redirect rules + session allow rule lifecycle
├── gateway-config.js      # Gateway allowlist (w3link, w3eth)
├── gateway-matcher.js     # Shared URL/host matching for webRequest + CDP
├── blank.html             # Interstitial page shell (loads blank.js)
├── blank.js               # Interstitial logic: parse hash, signal interstitialReady
├── popup.html             # Popup UI shell
├── popup.js               # Popup logic — read-only state + results display
├── popup.css              # Popup styles
├── verify.js              # Structural validator (NOT proof verification; not wired into pipeline)
└── icons/                 # Extension icons (16, 48, 128)
```

## Installation (Development)

1. Clone this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the project directory.
5. The extension icon appears in the toolbar.

## Usage

1. Navigate to any `w3link.io` or `w3eth.io` gateway URL (or a subdomain).
   The browser is briefly redirected to the interstitial, then to the
   gateway — capture is automatic.
2. Click the extension icon to view:
   - Capture status (inactive / setting up / capturing / completed / error)
   - Resource Coverage and Body Availability verdicts
   - File count, total size, and (when present) missed-file count
   - An expandable file list grouping captured / missed / fetch-error entries

## Roadmap

Only items **not** implemented are listed.

- [ ] Proof verification — hashing captured bytes and comparing against
      expected gateway commitments.
- [ ] KZG commitment verification — verify the gateway's commitment against
      the captured content.
- [ ] Export format — serialize the captured set (with bodies) into a
      stable artifact suitable for downstream verification.
- [ ] Future improvements — broader gateway host list, multi-tab capture
      coordination, performance instrumentation.
