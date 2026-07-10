# Tidy2 Chrome Extension — Codebase Guide

This document explains every file in `src/`, how they connect, and what to change to build your own functionality. Written for someone who understands React but is new to Chrome Extension Manifest V3.

---

## The Big Picture: How a Chrome Extension Works

A Chrome extension is not a single webpage. It is several isolated JavaScript environments that run simultaneously and communicate by passing messages. Each environment has different capabilities and different lifetimes.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  BROWSER                                                                  │
│                                                                           │
│  ┌─────────────────────┐  GET_TABS      ┌─────────────────────────────┐ │
│  │  Popup              │───────────────►│  Service Worker             │ │
│  │  (popup/)           │◄───────────────│  (background.ts)            │ │
│  │                     │  tabs[]        │                             │ │
│  │                     │  CLUSTER_TABS  │  RUN_EMBEDDINGS             │ │
│  │                     │───────────────►│      │           ▲          │ │
│  │                     │◄───────────────│      ▼           │          │ │
│  │                     │  clusters[][]  │  ┌──────────────────────┐   │ │
│  └─────────────────────┘               │  │  Offscreen Document  │   │ │
│                                        │  │  (offscreen/)        │   │ │
│  ┌─────────────────────┐               │  │  ML pipeline + clust │   │ │
│  │  Side Panel         │               │  └──────────────────────┘   │ │
│  │  (sidepanel/)       │               └─────────────────────────────┘ │
│  └─────────────────────┘                                                 │
│  ┌───────────────────────────────┐                                       │
│  │  Web Page                     │                                       │
│  │   └── Content Script          │                                       │
│  │       (content/)              │                                       │
│  └───────────────────────────────┘                                       │
└──────────────────────────────────────────────────────────────────────────┘
```

**Key MV3 rule:** These environments **cannot share variables or imports**. They can only talk via `chrome.runtime.sendMessage()`. Think of them as separate processes.

---

## The Build Toolchain

### Vite + CRXJS (`@crxjs/vite-plugin`)

CRXJS reads `manifest.config.ts` as the source of truth for entry points, automatically tells Vite to build every HTML file and script listed, injects HMR into content scripts, copies `public/` into `dist/`, and generates `dist/manifest.json`.

### `vite-plugin-zip-pack`

After build, zips `dist/` into `release/crx-tidy2-1.0.0.zip` for Chrome Web Store upload.

---

## Config Files

### [`manifest.config.ts`](manifest.config.ts)

```ts
export default defineManifest({
  manifest_version: 3,
  permissions: [
    'tabs',            // chrome.tabs.query(), tab.url, tab.title
    'storage',         // chrome.storage.local / sync
    'alarms',          // scheduled background tasks
    'sidePanel',       // chrome.sidePanel API
    'contentSettings', // per-site content settings
    'offscreen',       // create hidden offscreen documents for ML inference
  ],
  background: {
    service_worker: 'src/background/background.ts',
    type: 'module',
  },
})
```

The `offscreen` permission is required to use `chrome.offscreen.createDocument()`.

### [`vite.config.ts`](vite.config.ts)

```ts
export default defineConfig({
  resolve: {
    alias: { '@': `${path.resolve(__dirname, 'src')}` },
  },
  build: {
    rollupOptions: {
      input: {
        offscreen: path.resolve(__dirname, 'src/offscreen/offscreen.html'),
      },
    },
  },
  plugins: [ react(), crx({ manifest }), zip(...) ],
})
```

The `build.rollupOptions.input` entry registers `offscreen.html` as an additional build entry point. Without it, Vite would not bundle the offscreen document.

### `public/`

Everything in `public/` is copied to `dist/` as-is, making it accessible via `chrome.runtime.getURL(...)` at runtime.

```
public/
  taxonomy.json        ← site taxonomy data, loaded at runtime by the background
  ort/                 ← onnxruntime-web WASM files (copied from node_modules)
    ort-wasm-simd-threaded.asyncify.mjs / .wasm
    ort-wasm-simd-threaded.mjs / .wasm
    ort-wasm-simd-threaded.jsep.mjs / .wasm
```

The `ort/` files exist because Chrome extension CSP blocks dynamic imports from external CDNs (`cdn.jsdelivr.net`). `@huggingface/transformers` fetches its WASM runtime from jsdelivr at runtime — pointing `env.backends.onnx.wasm.wasmPaths` to these local files bypasses that.

---

## Types ([`src/types.ts`](src/types.ts))

```ts
// Raw tab from Chrome
export type Tab = { title: string; url: string }
export type Tabs = Tab[]

// Tab after taxonomy lookup — signal and category added by background before embedding
export type EnrichedTab = Tab & {
  signal: string | null    // e.g. "watching-video", "viewing-repo"
  category: string | null  // e.g. "code", "shopping"
}
export type EnrichedTabs = EnrichedTab[]
```

`Tab` is what Chrome returns. `EnrichedTab` is what gets sent to the offscreen document — the background adds `signal` and `category` from the taxonomy engine so the ML model gets richer semantic context.

---

## Runtime Contexts

### 1. Background (Service Worker)

**File:** [`src/background/background.ts`](src/background/background.ts)

The service worker is Chrome's event broker for the extension. It has no DOM, no WebGPU, and cannot use dynamic `import()` (HTML spec restriction on `ServiceWorkerGlobalScope`). It owns three responsibilities: fetching tabs, loading the taxonomy, and delegating ML work to the offscreen document.

#### Message API

| Action | Payload | Response |
|---|---|---|
| `GET_TABS` | — | `{ status, tabs: Tab[] }` |
| `CLUSTER_TABS` | — | `{ status, clusters: EnrichedTab[][], vector: number[][] }` |
| `LOAD_TAXONOMY` | — | `{ status, version, aliases }` |

`GET_TABS` and `CLUSTER_TABS` are intentionally decoupled so the popup can show tabs immediately and trigger clustering separately based on user preference.

#### Key patterns

**Lazy taxonomy loading** — loaded once on first use, cached for the lifetime of the service worker:

```ts
let taxonomyPromise: Promise<TaxonomyEngine> | null = null;

async function getTaxonomy() {
    if (!taxonomyPromise) {
        taxonomyPromise = fetch(chrome.runtime.getURL('taxonomy.json'))
            .then(r => r.json())
            .then(data => new TaxonomyEngine(data));
    }
    return taxonomyPromise;
}
```

**Tab enrichment** — background looks up each tab in the taxonomy before sending to the offscreen doc. `tabs` and `taxonomy` are fetched in parallel:

```ts
const [tabs, taxonomy] = await Promise.all([getTabTitles(), getTaxonomy()]);

const enrichedTabs: EnrichedTabs = tabs.map(tab => ({
    ...tab,
    signal: taxonomy.lookup(tab.url)?.signal ?? null,
    category: taxonomy.lookup(tab.url)?.category ?? null,
}));
```

**Concurrency-safe offscreen document creation** (Google-recommended pattern):

```ts
let creating: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<boolean> {
    const existing = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    if (existing.length > 0) return false;

    if (creating) {
        await creating;
    } else {
        creating = chrome.offscreen.createDocument({ url: OFFSCREEN_PATH, ... });
        await creating;
        creating = null;
    }
    return true;
}
```

**OFFSCREEN_READY signal** — `createDocument()` resolves when the HTML loads, but `<script type="module">` is deferred so the listener may not be registered yet. The background waits for a signal before sending work:

```ts
const justCreated = await ensureOffscreenDocument();
if (justCreated) await waitForOffscreenReady(); // parks until OFFSCREEN_READY arrives
chrome.runtime.sendMessage({ action: 'RUN_EMBEDDINGS', tabs: enrichedTabs });
```

**Message flow for clustering:**

```
Popup              Background                    Offscreen
  │                    │                              │
  │─ CLUSTER_TABS ────►│                              │
  │                    │─ getTabTitles() + getTaxonomy() (parallel)
  │                    │─ enrich tabs with signal/category
  │                    │─ RUN_EMBEDDINGS (enrichedTabs) ─►│
  │                    │                              │─ pipeline() + cluster()
  │                    │◄─ { clusters, vector } ───────│
  │◄─ { clusters } ────│                              │
```

---

### 2. Offscreen Document

**Files:** [`src/offscreen/offscreen.html`](src/offscreen/offscreen.html), [`src/offscreen/offscreen.ts`](src/offscreen/offscreen.ts)

A hidden browser page owned by the extension. Unlike the service worker, it runs in a full renderer process with WebGPU and dynamic `import()`. This is where the ML pipeline runs.

#### Embedding model

```ts
const MODEL_ID = 'Xenova/all-MiniLM-L12-v2'; // 12-layer, 33MB, 384-dim output
```

`all-MiniLM-L12-v2` (12 transformer layers) produces better cluster separation than the L6 variant (6 layers) for tab content. Each additional layer gives the model another pass to build more abstract representations — L12 distinguishes *intent* (browsing code vs. buying something) rather than just keyword overlap. The tradeoff is ~50% larger download (33MB vs 22MB) and slightly slower first inference, but both are one-time costs.

To swap models, change `MODEL_ID` here and update `MODEL_ID` in `embeddings.test.ts` to benchmark quality before committing.

#### Pipeline

Receives `EnrichedTabs` from the background. Passes `signal` and `category` through to `formatTabInput` so the embedding includes semantic context beyond just the URL and title.

```ts
const inputs = tabs.map(t => formatTabInput(t.url, t.title, t.signal, t.category));
console.log('Embedding inputs:', inputs); // visible in offscreen devtools
const output = await embedder(inputs, { pooling: 'mean', normalize: true });
```

**Why `OFFSCREEN_READY` is sent last** — the background waits for this signal before sending `RUN_EMBEDDINGS`. It must come after `onMessage.addListener`, otherwise the background could receive it and immediately send work before the listener is registered.

**Inspecting the offscreen console:** `chrome://extensions/` → your extension → "Inspect" next to the offscreen document.

---

### 3. Taxonomy Engine

**Files:** [`src/lib/taxonomyEngine.ts`](src/lib/taxonomyEngine.ts), [`src/lib/taxonomy.types.ts`](src/lib/taxonomy.types.ts)

Loads [`public/taxonomy.json`](public/taxonomy.json) — a hand-curated database of ~100 sites — and provides O(1) URL classification.

#### `taxonomy.json` structure

```jsonc
{
  "version": "2026-06-23",
  "categories": ["code", "shopping", "video", ...],  // 19 categories
  "sites": [
    {
      "id": "github",
      "domains": ["github.com"],
      "category": "code",
      "tool": "github",
      "multipurpose": true,
      "possibleCategories": ["code", "documentation", "community"],
      "paths": [
        { "match": "^/([^/]+)/([^/]+)/?$", "extract": {"owner": 1, "repo": 2}, "signal": "viewing-repo" }
      ]
    }
  ],
  "patterns": [
    { "id": "docs-subdomain", "domainPattern": "^\\.docs?\\.", "category": "documentation", "signal": "documentation-site" }
  ],
  "aliases": { "youtu.be": "youtube.com", "amzn.to": "amazon.com" }
}
```

#### `TaxonomyEngine.lookup(url)` — resolution order

```
1. Parse URL, strip www., resolve aliases (youtu.be → youtube.com)
2. domainMap.get(hostname)       → exact site match
      └── try each site's path rules for signal + extraction
3. patterns[].regex.test(hostname) → wildcard pattern match (docs.*, *.myshopify.com)
4. return null                   → unknown site
```

**Constructor pre-compiles everything** so `lookup()` pays no regex compilation cost at call time:
- `domainMap: Map<string, TaxonomySite>` — flat domain → site index (one entry per domain alias)
- `patterns: CompiledPattern[]` — `TaxonomyPattern & { regex: RegExp }`
- `sitePaths: Map<string, CompiledSitePath[]>` — per-site path rules with compiled regexes

#### Key types ([`src/lib/taxonomy.types.ts`](src/lib/taxonomy.types.ts))

| Type | Description |
|---|---|
| `TaxonomyCategory` | Union of all 19 category strings |
| `TaxonomySite` | One site entry from `sites[]` |
| `SitePath` | A path rule: `match`, `signal?`, `extract?` |
| `TaxonomyPattern` | A wildcard pattern: `domainPattern`, `category`, `signal` |
| `TaxonomyData` | Shape of the full `taxonomy.json` file |
| `LookupResult` | `{ site?, category, signal?, extracted? }` |

**Tests:** [`src/lib/taxonomyEngine.test.ts`](src/lib/taxonomyEngine.test.ts) — 32 tests covering exact matches, path extraction, alias resolution, and pattern matching. All load from `public/taxonomy.json`.

---

### 4. Clustering Library

**File:** [`src/lib/clustering.ts`](src/lib/clustering.ts)

Pure functions with no Chrome API or browser dependencies. Safe to import in Node.js (tests) and the offscreen document alike.

| Export | Description |
|---|---|
| `THRESHOLD` | Default cosine distance threshold (`0.8`) |
| `cosineSimilarity(a, b)` | Dot product of two normalized unit vectors |
| `cosineDistance(a, b)` | `1 - cosineSimilarity` |
| `pairwiseDistances(embeddings)` | n×n distance matrix (Float32Array rows) |
| `clusterAverageDistance(A, B, distances)` | Average linkage between two clusters |
| `agglomerativeCluster(embeddings, threshold?)` | Bottom-up clustering → `number[][]` |
| `formatTabInput(url, title, signal?, category?)` | Formats tab into embedding string |
| `mapClustersToItems(items, clusters)` | Maps index clusters back to items: `T[][]` |

**`formatTabInput` output** — combines all available context into a single string the model embeds:
```
"github.com /microsoft/typescript TypeScript viewing-repo code"
 ──────────  ─────────────────────  ──────────  ────────────  ────
  domain           path              title        signal      category
```
`signal` and `category` are optional — tabs that don't match the taxonomy still embed using domain + path + title.

**Clustering algorithm:** Agglomerative hierarchical with average linkage. Starts with every tab in its own cluster, repeatedly merges the two closest clusters until no pair is within `THRESHOLD` (cosine distance).

**Tests:** [`src/lib/clustering.test.ts`](src/lib/clustering.test.ts) — 29 pure unit tests covering all functions including `mapClustersToItems` and enriched `formatTabInput` (with signal/category). [`src/lib/embeddings.test.ts`](src/lib/embeddings.test.ts) — 7 embedding quality and clustering tests using `onnxruntime-node` with `device: 'cpu'`.

Tab fixtures in `embeddings.test.ts` include `signal` and `category` to match the production enriched format:

```ts
const DEV_TABS = [
    { url: '...github.com/...', title: '...', signal: 'viewing-repo', category: 'code' },
    { url: '...stackoverflow...', title: '...', signal: 'viewing-question', category: 'documentation' },
    { url: '...mozilla.org/...', title: '...', signal: null, category: 'documentation' },
];
const toInput = (t) => formatTabInput(t.url, t.title, t.signal, t.category);
```

Tests use `onnx-community/all-MiniLM-L6-v2-ONNX` (not L12) — the tests were calibrated against L6's distance distribution. If you switch the production model, benchmark with a dedicated test run rather than updating `MODEL_ID` in this file permanently.

---

### 5. Popup

**Files:** `src/popup/`

The popup drives both decoupled actions:

```tsx
// Step 1 — fast, show tabs immediately
chrome.runtime.sendMessage({ action: 'GET_TABS' })
// → { status, tabs: Tab[] }

// Step 2 — user-triggered, runs ML pipeline
chrome.runtime.sendMessage({ action: 'CLUSTER_TABS' })
// → { status, clusters: EnrichedTab[][], vector: number[][] }
```

`CLUSTER_TABS` carries no payload — the background fetches fresh tabs itself so the clustering always reflects the current state of the window, not a snapshot from when `GET_TABS` was called.

---

### 6. Side Panel

**Files:** `src/sidepanel/`

Same structure as the popup. Persistent panel on the right side of the browser window. Currently contains placeholder UI.

---

### 7. Content Script

**Files:** `src/content/`

Injected into every HTTPS page. Mounts a floating React overlay. CSS is not isolated from the page — use Shadow DOM if conflicts arise.

---

## How the Files Connect

```
manifest.config.ts
      │
      ▼
CRXJS Vite Plugin
      ├─► src/popup/index.html → App.tsx
      ├─► src/sidepanel/index.html → App.tsx
      ├─► src/content/main.tsx
      └─► src/background/background.ts
                ├── @/lib/taxonomyEngine.ts → @/lib/taxonomy.types.ts
                └── @/types.ts

vite.config.ts (rollupOptions.input)
      └─► src/offscreen/offscreen.html → offscreen.ts
                ├── @/lib/clustering.ts
                └── @/types.ts

public/taxonomy.json   ← fetched at runtime by background.ts
public/ort/            ← fetched at runtime by offscreen.ts (WASM)
```

---

## Permissions Reference

| Permission | What it unlocks |
|---|---|
| `tabs` | `chrome.tabs.query()`, `tab.url`, `tab.title` |
| `storage` | `chrome.storage.local` / `chrome.storage.sync` |
| `alarms` | `chrome.alarms.*` for scheduled background tasks |
| `sidePanel` | `chrome.sidePanel.*` API |
| `contentSettings` | Per-site content settings |
| `offscreen` | `chrome.offscreen.createDocument()` for hidden browser pages |

---

## Development Workflow

```bash
npm run dev        # Vite dev server + CRXJS HMR
npm test           # Run all tests once
npm run test:watch # Rerun tests on file change
npm run build      # TypeScript check + production build → dist/
```

1. Run `npm run dev`
2. Go to `chrome://extensions/`, enable Developer Mode
3. Click "Load unpacked" → select `dist/`
4. Popup and sidepanel hot-reload automatically
5. Content script hot-reloads via CRXJS
6. `background.ts` changes require clicking refresh on `chrome://extensions/`
7. Offscreen document console: `chrome://extensions/` → your extension → "Inspect" on the offscreen document

---

## Common Gotchas

**No dynamic `import()` in service workers.** `@huggingface/transformers` uses dynamic imports internally — running `pipeline()` in `background.ts` will always fail. Use the offscreen document.

**`createDocument()` resolves before module scripts run.** `<script type="module">` is deferred. The `OFFSCREEN_READY` signal pattern handles this — always send it after `onMessage.addListener`.

**Extension CSP blocks CDN imports.** `onnxruntime-web` fetches its WASM runtime from jsdelivr. Copy the WASM files to `public/ort/` and set `env.backends.onnx.wasm.wasmPaths`.

**`return true` in message listeners.** Always return `true` from `onMessage.addListener` if `sendResponse` is called asynchronously. Forgetting this closes the channel and the response silently becomes `undefined`.

**Service worker state resets.** Chrome kills the background service worker after ~30s of inactivity. `offscreenReady`, `taxonomyPromise`, and `creating` all reset on restart. The offscreen document typically outlives a single service worker invocation — the `existing.length > 0` check handles re-attaching without re-waiting for `OFFSCREEN_READY`.

**Don't pass class instances through `sendMessage`.** The structured clone algorithm strips methods and serializes `Map`/`Set`/`RegExp` as empty objects. Pass plain JSON-serializable data. The background enriches tabs with `signal`/`category` (plain strings) before sending — the offscreen doc never needs to know about `TaxonomyEngine`.

**`@/` alias** maps to `src/`. Must be configured in both `tsconfig.app.json` (paths) and `vite.config.ts` (alias).
