# Web3 Gateway Proof - POC

A Chrome Extension that captures static resources served by Web3 gateways
(w3link.io, w3eth.io) via the Chrome DevTools Protocol (CDP). The captured
data will be used for **proof verification** — confirming that the gateway
returned the correct, untampered content for a given URL.

> **Status**: Data capture is fully implemented. Proof verification is planned
> but not yet built.

## How It Works

1. **Early attach** — When navigation to a gateway URL is detected
   (`onBeforeNavigate`), the extension immediately attaches the Chrome debugger
   and retries up to 2 seconds if the target is not yet ready.

2. **CDP capture** — `Network.enable` and `Page.enable` are called, then the
   page is force-reloaded (`bypassCache: true`) to capture every request from
   the start.

3. **Resource tracking** — All gateway requests of types `Document`, `Script`,
   `Stylesheet`, `Image`, `Font`, `Fetch`, and `Other` are tracked. Response
   bodies are fetched via `Network.getResponseBody`.

4. **Completion** — Capture ends when all tracked requests finish and no new
   requests arrive for 3.5 seconds (idle window), with a 30-second hard
   timeout as safety net.

5. **Popup display** — The extension popup shows capture status, resource
   count, total size, and the list of captured files.

## Supported Resource Types

| CDP Type     | Examples                          |
|-------------|-----------------------------------|
| Document    | HTML pages                        |
| Script      | JS bundles, dynamic imports       |
| Stylesheet  | CSS files                         |
| Image       | PNG, SVG, WebP, etc.              |
| Font        | WOFF2, TTF                        |
| Fetch       | `fetch()`-loaded assets, wasm     |
| Other       | Web Workers, some wasm loads      |

## Project Structure

```
├── manifest.json      # Extension manifest (MV3)
├── background.js      # Service worker — CDP capture logic
├── popup.html         # Extension popup UI
├── popup.js           # Popup logic — reads capture state from background
├── popup.css          # Popup styles
└── icons/             # Extension icons (16, 48, 128)
```

## Installation (Development)

1. Clone this repository
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the project directory
5. The extension icon will appear in the toolbar

## Usage

1. Navigate to any `w3link.io` or `w3eth.io` gateway URL
2. The extension automatically starts capturing all static resources
3. Click the extension icon to view:
   - Capture status (inactive / capturing / completed / error)
   - File count and total size
   - Individual file list (expandable)

## Roadmap

- [x] CDP-based resource capture (Document, Script, Stylesheet, Image, Font, Fetch, Other)
- [x] Early debugger attach with retry + onCommitted fallback
- [x] Dynamic resource support (wasm, workers, dynamic imports)
- [ ] Proof verification — compare captured resources against expected hashes
- [ ] Export captured data as JSON
- [ ] Configurable gateway host list