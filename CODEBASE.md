# Tidy2 Chrome Extension — Codebase Guide

This document explains every file in `src/`, how they connect, and what to change to build new functionality. Written for someone who understands React but is new to Chrome Extension Manifest V3.

---

## The Big Picture

A Chrome extension is several isolated JavaScript environments that communicate by passing messages. They cannot share variables or imports — only JSON-serializable data via `chrome.runtime.sendMessage()`.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  BROWSER                                                                     │
│                                                                              │
│  ┌──────────────────────┐  GET_TABS / CLUSTER_TABS   ┌──────────────────┐  │
│  │  Popup  (popup/)     │──────────────────────────►│  Service Worker  │  │
│  │  Side Panel          │◄──────────────────────────│  (background.ts) │  │
│  │  (sidepanel/)        │  clusters[][], labels[]   │                  │  │
│  │                      │                           │  RUN_EMBEDDINGS  │  │
│  │  GeminiGate          │                           │      │           │  │
│  │  TabList             │                           │      ▼           │  │
│  └──────────────────────┘                           │  ┌────────────┐  │  │
│            │                                        │  │  Offscreen │  │  │
│            │  chrome.storage.onChanged              │  │  Document  │  │  │
│            │  (cache + job updates)                 │  │  ONNX +    │  │  │
│            ▼                                        │  │  Gemini    │  │  │
│  ┌──────────────────────────────────────────┐       │  └────────────┘  │  │
│  │  chrome.storage.local                    │       └──────────────────┘  │
│  │  clusterCache_${windowId}  ClusterCache  │                              │
│  │  clusterJob_${windowId}    ClusterJob    │                              │
│  └──────────────────────────────────────────┘                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Config Files

### [`manifest.config.ts`](manifest.config.ts)

```ts
permissions: [
  'tabs',            // chrome.tabs.query(), tab.url, tab.title, tab.groupId
  'storage',         // chrome.storage.local
  'alarms',          // scheduled background tasks
  'sidePanel',       // chrome.sidePanel.open()
  'offscreen',       // chrome.offscreen.createDocument() for ML inference
  'aiAssistant',     // Gemini Nano / Prompt API (window.LanguageModel)
  'contentSettings',
  'tabGroups',       // chrome.tabs.group(), chrome.tabGroups.update/query
]
options_page: 'src/settings/index.html'
```

`tabGroups` is required for creating, updating, and querying Chrome Tab Groups. `aiAssistant` enables the Prompt API (`LanguageModel`) for Gemini Nano cluster labeling.

---

## Types ([`src/types.ts`](src/types.ts))

```ts
export type Tab = {
  title: string; url: string
  id: number; windowId: number; index: number
  active: boolean; pinned: boolean; discarded: boolean
  favIconUrl?: string
}
export type Tabs = Tab[]

export type EnrichedTab = Tab & {
  signal: string | null    // e.g. "viewing-repo", "watching-video"
  category: string | null  // e.g. "code", "shopping"
}
export type EnrichedTabs = EnrichedTab[]

export type ClusterCache = {
  clusters: Tab[][]   // parallel arrays — index i of clusters matches index i of labels
  labels: string[]
}

export type ClusterJob = {
  status: 'running' | 'done' | 'error'
  error?: string
}
```

`ClusterCache` and `ClusterJob` are stored in `chrome.storage.local` keyed by `windowId`. They are the source of truth for restoring state when the popup re-opens.

---

## Runtime Contexts

### 1. Background (Service Worker)

**File:** [`src/background/background.ts`](src/background/background.ts)

The service worker is the event broker. It has no DOM and no WebGPU. Responsibilities: fetch tabs, load taxonomy, delegate ML work to the offscreen document, manage per-window storage, and handle tab lifecycle events.

#### Message API

| Action | Payload | Response |
|---|---|---|
| `GET_TABS` | `{ windowId }` | `{ status: 'success', tabs: Tab[] }` or `{ status: 'cache_success', tabs: Tab[][], labels: string[] }` |
| `CLUSTER_TABS` | `{ windowId }` | `{ status, clusters: Tab[][], labels: string[], vector: number[][] }` |
| `SET_ACTIVE_TAB` | `{ tabId }` | `{ status }` |
| `CLOSE_TAB` | `{ tabId }` | `{ status }` |
| `CREATE_TAB_GROUP` | `{ tabIds, title, colorIndex, windowId }` | `{ status, groupId }` |
| `UNGROUP_TABS` | `{ tabIds }` | `{ status }` |
| `LOAD_TAXONOMY` | — | `{ status, version, aliases }` |

Both `GET_TABS` and `CLUSTER_TABS` require `windowId` in the payload — the background cannot infer which window the popup belongs to from `sender` alone.

#### Per-window storage

Every cached result is keyed by `windowId` so multiple windows maintain independent cluster state:

```ts
const cacheKey = `clusterCache_${windowId}`  // ClusterCache
const jobKey   = `clusterJob_${windowId}`    // ClusterJob
```

**`GET_TABS` response logic:**
1. Check `clusterCache_${windowId}` in local storage
2. If found → return `cache_success` with the cached `clusters` and `labels`
3. If not found → query Chrome tabs and return `success` with a flat `Tab[]`

#### Job tracking

`handleClusterTabs` writes job status to local storage so the popup can recover state if closed mid-run:

```ts
// Start
await chrome.storage.local.set({ [jobKey]: { status: 'running' } as ClusterJob })

// On success (inside RUN_EMBEDDINGS callback)
chrome.storage.local.set({
  [cacheKey]: { clusters, labels } as ClusterCache,
  [jobKey]: { status: 'done' } as ClusterJob,
})

// On error
chrome.storage.local.set({ [jobKey]: { status: 'error', error: message } as ClusterJob })
```

`sendResponse` is wrapped in `try/catch` — the popup may have closed before the pipeline finishes.

#### Tab event listeners (smart cache invalidation)

Instead of clearing clusters when tabs change, the background performs surgical updates:

```ts
// New tab → add to Ungrouped bucket
chrome.tabs.onCreated.addListener(async (tab) => { ... addToUngrouped(cache, tab) })

// Tab navigated → move to Ungrouped with updated URL/title
chrome.tabs.onUpdated.addListener(async (_, changeInfo, tab) => {
  if (!changeInfo.url) return  // only act on navigations, not title/status changes
  // remove from current cluster, add to Ungrouped
})

// Tab closed → remove from its cluster, drop empty clusters
chrome.tabs.onRemoved.addListener(async (tabId, info) => { ... })
```

Changes are written to `clusterCache_${windowId}` which triggers `chrome.storage.onChanged` in any open popup/sidepanel, updating the UI live.

#### Concurrency-safe offscreen document creation

```ts
async function ensureOffscreenDocument(): Promise<boolean> {
    const existing = await chrome.runtime.getContexts({ ... })
    if (existing.length > 0) return false
    if (creating) { await creating } else { creating = chrome.offscreen.createDocument(...) }
    return true
}
const justCreated = await ensureOffscreenDocument()
if (justCreated) await waitForOffscreenReady()
```

`OFFSCREEN_READY` is sent from the offscreen module after `onMessage.addListener` — necessary because `<script type="module">` is deferred and `createDocument()` resolves before module scripts execute.

---

### 2. Offscreen Document

**Files:** [`src/offscreen/offscreen.html`](src/offscreen/offscreen.html), [`src/offscreen/offscreen.ts`](src/offscreen/offscreen.ts)

Hidden browser page with full renderer access (WebGPU, dynamic `import()`). Runs the entire ML pipeline.

#### Embedding model

```ts
const MODEL_ID = 'Xenova/all-MiniLM-L12-v2'  // 12-layer, 33MB, 384-dim
```

L12 distinguishes intent (browsing code vs. buying something) rather than just keyword overlap. L6 is faster but produces weaker cluster separation.

#### Cluster labeling — Gemini Nano first, KeyBERT fallback

`generateLabels` tries Gemini Nano as primary and falls back to KeyBERT per cluster if it fails:

```ts
async function generateLabels(
    clusters: EnrichedTab[][], clusterIndices: number[][],
    embedder: any, tabs: EnrichedTabs, vectors: number[][]
): Promise<string[]> {
    let session: any = null
    try {
        session = await LanguageModel.create()   // Gemini Nano session
    } catch {
        // Gemini unavailable — use KeyBERT for all clusters
        return Promise.all(clusterIndices.map(g => keyBERTLabel(g, embedder, tabs, vectors)))
    }

    const labels: string[] = []
    for (let i = 0; i < clusters.length; i++) {
        try {
            const tabList = clusters[i]
                .map(t => `- "${t.title}" (${getDomain(t.url)})`).join('\n')
            const response = await session.prompt(
                `These browser tabs are open together:\n${tabList}\n\n` +
                `Write a concise 2-4 word title describing what they have in common. ` +
                `Reply with only the title, no punctuation or explanation.`
            )
            labels.push(response.trim())
        } catch {
            labels.push(await keyBERTLabel(clusterIndices[i], embedder, tabs, vectors))
        }
    }
    session.destroy()
    return labels
}
```

#### Single-tab separation

After clustering, single-tab clusters are pulled out and collected into a single **Ungrouped** bucket appended at the end:

```ts
const multiClusters = clusteredTabs.filter(c => c.length > 1)
const singleTabs    = clusteredTabs.filter(c => c.length === 1).flat()
// Only named multi-tab clusters get passed to generateLabels
const finalClusters = singleTabs.length > 0 ? [...multiClusters, singleTabs] : multiClusters
const finalLabels   = singleTabs.length > 0 ? [...multiLabels, 'Ungrouped'] : multiLabels
```

---

### 3. Popup & Side Panel

**Files:** `src/popup/App.tsx`, `src/sidepanel/App.tsx`

Both are nearly identical — the popup additionally has an "Open in side panel" button and calls `window.close()` on tab click.

#### State

```ts
const [tabs, setTabs]               = useState<Tab[][]>([])
const [labels, setLabels]           = useState<string[]>([])
const [chromeGroups, setChromeGroups] = useState<ChromeGroupInfo[]>([])
const [loading, setLoading]         = useState(true)
const [clustering, setClustering]   = useState(false)
const windowIdRef                   = useRef<number | null>(null)
```

#### Initialization (`useEffect`)

```ts
const init = async () => {
  const win = await chrome.windows.getCurrent()
  windowIdRef.current = win.id!

  const [jobResult, response] = await Promise.all([
    chrome.storage.local.get(`clusterJob_${wid}`),
    chrome.runtime.sendMessage({ action: 'GET_TABS', windowId: wid }),
  ])

  // Restore in-progress clustering indicator if popup was closed mid-run
  if (jobResult[`clusterJob_${wid}`]?.status === 'running') setClustering(true)

  // Restore cached clusters or show fresh flat tab list
  if (response.status === 'cache_success') { setTabs(response.tabs); setLabels(response.labels) }
  else if (response.status === 'success')  { setTabs([response.tabs]) }

  setChromeGroups(await computeGroupInfo(clusters, wid))
}
```

#### Reactive storage listener

`chrome.storage.onChanged` drives all live updates — both clustering completion and tab events (create/navigate/close):

```ts
const handleStorageChange = async (changes, area) => {
  const cacheChange = changes[`clusterCache_${wid}`]
  if (cacheChange?.newValue) {
    // Tab event or clustering completed — update UI immediately
    const cache = cacheChange.newValue as ClusterCache
    setTabs(cache.clusters)
    setLabels(cache.labels ?? [])
    setChromeGroups(await computeGroupInfo(cache.clusters, wid))
  }
  const jobChange = changes[`clusterJob_${wid}`]
  if (jobChange?.newValue?.status === 'done' || 'error') setClustering(false)
}
chrome.storage.onChanged.addListener(handleStorageChange)
```

#### Chrome Tab Groups

`computeGroupInfo` queries Chrome directly to check if each cluster already has a native tab group:

```ts
async function computeGroupInfo(clusters: Tab[][], windowId: number): Promise<ChromeGroupInfo[]> {
  const [chromeTabs, chromeGroups] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({ windowId }),
  ])
  // Returns { groupId, color } for clusters where all tabs share one groupId, null otherwise
}
```

Called after mount, after clustering, and after any group/ungroup action.

---

### 4. Shared Components

#### [`src/components/GeminiGate.tsx`](src/components/GeminiGate.tsx)

Gates both popup and side panel behind Gemini Nano availability. Wraps the app content as `children` and renders a blocking screen until the model is ready.

```
Status states:
  'checking'       → calls LanguageModel.availability() on mount
  'available'      → renders children (normal app)
  'needs-download' → shows download prompt + link to Chrome AI docs
  'downloading'    → shows progress bar (e.loaded * 100 = percentage)
  'incompatible'   → LanguageModel global absent or availability() === 'unavailable'
```

The `className` prop (e.g. `"popup"` or `"panel"`) is applied to the gate wrapper so layout constraints are preserved in all states.

If `availability()` returns `'downloading'` (download already in progress), the gate auto-calls `LanguageModel.create()` with a monitor to attach progress tracking.

#### [`src/components/TabList.tsx`](src/components/TabList.tsx)

Shared between popup and side panel. Renders `Tab[][]` as either a plain list (single group) or color-tinted cards with headers (multiple groups).

```ts
interface TabListProps {
  tabs: Tab[][]
  labels?: string[]
  chromeGroups?: ChromeGroupInfo[]   // parallel array — null means no Chrome group for that cluster
  loading: boolean
  onTabClick: (tab: Tab) => void
  onTabClose: (tab: Tab) => void
  onGroupCluster?: (tabs: Tab[], label: string, index: number) => void
  onUngroupCluster?: (tabs: Tab[], groupId: number) => void
}

export type ChromeGroupInfo = { groupId: number; color: string } | null
```

**Card coloring** — when a `ChromeGroupInfo` entry exists for a cluster, the card background and border are tinted with the Chrome group's color (8-digit hex alpha):
```ts
style={{ backgroundColor: dotColor + '12', borderColor: dotColor + '40' }}
```

**Cluster header** — shows the AI-generated label, an optional colored dot for existing Chrome groups, and a "Group"/"Ungroup" button. The Ungrouped bucket never shows a Group button.

**Close button** — appears on tab item hover, calls `onTabClose` with `e.stopPropagation()` to prevent also triggering `onTabClick`.

---

### 5. Taxonomy Engine

**Files:** [`src/lib/taxonomyEngine.ts`](src/lib/taxonomyEngine.ts), [`src/lib/taxonomy.types.ts`](src/lib/taxonomy.types.ts)

Unchanged from original design. Loads `public/taxonomy.json` (~100 sites) and provides O(1) URL classification used to enrich tabs before embedding.

---

### 6. Clustering Library

**File:** [`src/lib/clustering.ts`](src/lib/clustering.ts)

Pure functions — no Chrome APIs or browser dependencies. Used by the offscreen document and tests.

| Export | Description |
|---|---|
| `agglomerativeCluster(embeddings, threshold?)` | Bottom-up clustering → `number[][]` of tab index groups |
| `formatTabInput(url, title, signal?, category?)` | Formats enriched tab into embedding string |
| `mapClustersToItems(items, clusters)` | Maps index clusters → `T[][]` |
| `extractCandidates(tabs)` | KeyBERT: extract candidate keywords from tab titles |
| `computeCentroid(vectors)` | Mean of a set of embedding vectors |
| `topKeywords(candidates, cvectors, centroid, k)` | KeyBERT: top-k words by cosine similarity to cluster centroid |

---

### 7. Settings Page

**Files:** `src/settings/`

Registered as `options_page` in the manifest. Opens via `chrome.runtime.openOptionsPage()` from the popup/sidepanel settings icon. Currently a placeholder for cluster threshold configuration.

---

## Storage Architecture

All persistent state lives in `chrome.storage.local` (survives browser restarts and system sleep).

| Key pattern | Type | Written by | Read by |
|---|---|---|---|
| `clusterCache_${windowId}` | `ClusterCache` | background (clustering + tab events) | background (GET_TABS), popup/sidepanel (onChanged) |
| `clusterJob_${windowId}` | `ClusterJob` | background | popup/sidepanel (init + onChanged) |

**Cache invalidation:** Tab events trigger surgical cache updates rather than full clears. New/navigated tabs move to Ungrouped; removed tabs are deleted from their cluster; empty clusters are dropped. This preserves the user's groups while keeping the UI accurate.

---

## Permissions Reference

| Permission | What it unlocks |
|---|---|
| `tabs` | `chrome.tabs.query/update/remove/group/ungroup`, `tab.url/title/groupId` |
| `storage` | `chrome.storage.local` (persistent), `chrome.storage.onChanged` |
| `sidePanel` | `chrome.sidePanel.open()` |
| `offscreen` | `chrome.offscreen.createDocument()` for hidden ONNX/WebGPU pages |
| `aiAssistant` | `LanguageModel` global (Gemini Nano / Chrome Prompt API) |
| `tabGroups` | `chrome.tabs.group()`, `chrome.tabGroups.update/query` |
| `alarms` | `chrome.alarms.*` |
| `contentSettings` | Per-site content settings |

---

## How the Files Connect

```
manifest.config.ts
      │
      ▼
CRXJS Vite Plugin
      ├─► src/popup/index.html
      │         └── App.tsx → GeminiGate → TabList
      ├─► src/sidepanel/index.html
      │         └── App.tsx → GeminiGate → TabList
      ├─► src/settings/index.html → App.tsx
      ├─► src/content/main.tsx
      └─► src/background/background.ts
                ├── @/lib/taxonomyEngine.ts
                └── @/types.ts

vite.config.ts (rollupOptions.input)
      └─► src/offscreen/offscreen.html
                └── offscreen.ts
                      ├── @/lib/clustering.ts  (ONNX embeddings + agglomerative cluster)
                      ├── @huggingface/transformers (pipeline)
                      └── LanguageModel (Gemini Nano, browser global)

public/
  taxonomy.json   ← fetched at runtime by background.ts
  ort/            ← onnxruntime-web WASM (bypasses CDN CSP restriction)
```

---

## Development Workflow

```bash
npm run dev        # Vite dev server + CRXJS HMR
npm test           # Run all tests once
npm run test:watch # Rerun on file change
npm run build      # TypeScript check + production build → dist/
```

1. `npm run dev` → load `dist/` as unpacked extension in `chrome://extensions/`
2. Popup and sidepanel hot-reload automatically
3. `background.ts` changes require clicking refresh on `chrome://extensions/`
4. Offscreen console: `chrome://extensions/` → your extension → "Inspect" on the offscreen document

---

## Common Gotchas

**No dynamic `import()` in service workers.** `@huggingface/transformers` uses dynamic imports — `pipeline()` must run in the offscreen document, never in `background.ts`.

**`createDocument()` resolves before module scripts run.** Always send `OFFSCREEN_READY` after `onMessage.addListener` in the offscreen module, and always `await waitForOffscreenReady()` in the background before sending `RUN_EMBEDDINGS`.

**Extension CSP blocks CDN imports.** Copy onnxruntime-web WASM files to `public/ort/` and set `env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('/ort/')`.

**`return true` in message listeners.** Always return `true` from `onMessage.addListener` when `sendResponse` is called asynchronously — forgetting this closes the channel and the response silently becomes `undefined`.

**`sendResponse` throws if the sender context closes.** Wrap all `sendResponse` calls in `try/catch` in `handleClusterTabs` — the popup may close before the ML pipeline finishes.

**`chrome.storage.session` clears on macOS sleep.** Use `chrome.storage.local` for anything that should survive system sleep. `storage.session` only survives until Chrome closes.

**`chrome.storage.get(key)` wraps the result.** `get('clusterCache_1')` returns `{ clusterCache_1: ... }` not the value directly — always unwrap: `result['clusterCache_1']`.

**`LanguageModel.availability()` not `capabilities()`.** The Prompt API uses `availability()` returning `'available' | 'downloadable' | 'downloading' | 'unavailable'`. The older `capabilities()` / `window.ai.languageModel` API is deprecated.

**`e.loaded` in `downloadprogress` is a decimal (0–1).** Multiply by 100 for percentage — there is no `e.total` property.

**Don't pass class instances through `sendMessage`.** The structured clone algorithm strips methods. Pass plain JSON — `TaxonomyEngine` stays in the background and the offscreen only receives plain `EnrichedTab[]`.

**`@/` alias** maps to `src/`. Must be configured in both `tsconfig.app.json` (paths) and `vite.config.ts` (resolve.alias).
