# Tidy2 Chrome Extension — Codebase Guide

This document explains every file in `src/`, how they connect, and what to change to build new functionality. Written for someone who understands React but is new to Chrome Extension Manifest V3.

---

## The Big Picture

A Chrome extension is several isolated JavaScript environments that communicate by passing messages. They cannot share variables or imports — only JSON-serializable data via `chrome.runtime.sendMessage()`.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  BROWSER                                                                          │
│                                                                                   │
│  ┌──────────────────────┐  GET_TABS / CLUSTER_TABS    ┌──────────────────────┐  │
│  │  Popup  (popup/)     │───────────────────────────►│  Service Worker      │  │
│  │  Side Panel          │◄───────────────────────────│  (background.ts)     │  │
│  │  (sidepanel/)        │  clusters[][], labels[]     │                      │  │
│  │                      │                            │  RUN_EMBEDDINGS      │  │
│  │  GeminiGate          │                            │  EMBED_SINGLE_TAB    │  │
│  │  TabList             │                            │       │              │  │
│  │  ProposalBanner      │                            │       ▼              │  │
│  └──────────────────────┘                            │  ┌─────────────┐    │  │
│            │                                         │  │  Offscreen  │    │  │
│            │  chrome.storage.onChanged               │  │  Document   │    │  │
│            │  (cache + job + proposal updates)       │  │  ONNX +     │    │  │
│            ▼                                         │  │  Gemini     │    │  │
│  ┌──────────────────────────────────────────┐        │  └─────────────┘    │  │
│  │  chrome.storage.local                    │        │                      │  │
│  │  clusterCache_${windowId}   ClusterCache │        │  chrome.alarms       │  │
│  │  clusterJob_${windowId}     ClusterJob   │        │  reCluster_${wid}    │  │
│  │  clusterProposal_${windowId} ClusterProp │        └──────────────────────┘  │
│  └──────────────────────────────────────────┘                                   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## Config Files

### [`manifest.config.ts`](manifest.config.ts)

```ts
permissions: [
  'tabs',            // chrome.tabs.query(), tab.url, tab.title, tab.groupId
  'storage',         // chrome.storage.local
  'alarms',          // scheduled background re-cluster (reCluster_${windowId})
  'sidePanel',       // chrome.sidePanel.open()
  'offscreen',       // chrome.offscreen.createDocument() for ML inference
  'aiAssistant',     // Gemini Nano / Prompt API (window.LanguageModel)
  'contentSettings',
  'tabGroups',       // chrome.tabs.group(), chrome.tabGroups.update/query
]
options_page: 'src/settings/index.html'
```

`tabGroups` is required for creating, updating, and querying Chrome Tab Groups. `aiAssistant` enables the Prompt API (`LanguageModel`) for Gemini Nano cluster labeling. `alarms` powers the 45-minute background re-cluster cycle.

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
  clusters: Tab[][]     // parallel arrays — index i of clusters matches index i of labels
  labels: string[]
  centroids?: number[][]  // one 384-dim centroid per cluster, parallel to clusters[]
}

export type ClusterProposal = {
  clusters: Tab[][]
  labels: string[]
  centroids: number[][]
  proposedAt: number  // Date.now() timestamp when the proposal was computed
}

export type ClusterJob = {
  status: 'running' | 'done' | 'error'
  error?: string
}
```

`ClusterCache.centroids` is optional for backward compatibility with caches written before centroids were introduced. `ClusterProposal` is written to storage only when a background re-cluster produces a meaningfully better grouping than the current state — it is never applied automatically.

---

## Runtime Contexts

### 1. Background (Service Worker)

**File:** [`src/background/background.ts`](src/background/background.ts)

The service worker is the event broker. It has no DOM and no WebGPU. Responsibilities: fetch tabs, load taxonomy, delegate ML work to the offscreen document, manage per-window storage, handle tab lifecycle events, run smart tab placement, and schedule background re-clusters.

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
| `APPLY_PROPOSAL` | `{ windowId }` | `{ status }` — replaces `clusterCache` with the stored proposal |
| `DISMISS_PROPOSAL` | `{ windowId }` | `{ status }` — removes `clusterProposal` from storage |

Both `GET_TABS` and `CLUSTER_TABS` require `windowId` in the payload — the background cannot infer which window the popup belongs to from `sender` alone.

#### Per-window storage

Every cached result is keyed by `windowId` so multiple windows maintain independent cluster state:

```ts
const cacheKey    = `clusterCache_${windowId}`    // ClusterCache
const jobKey      = `clusterJob_${windowId}`      // ClusterJob
const proposalKey = `clusterProposal_${windowId}` // ClusterProposal
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
  [cacheKey]: { clusters, labels, centroids } as ClusterCache,
  [jobKey]: { status: 'done' } as ClusterJob,
})

// On error
chrome.storage.local.set({ [jobKey]: { status: 'error', error: message } as ClusterJob })
```

After a successful cluster, the background also:
1. Removes any existing `clusterProposal_${windowId}` — a fresh manual cluster supersedes it
2. Creates a `chrome.alarms` entry `reCluster_${windowId}` with a 45-minute delay

`sendResponse` is wrapped in `try/catch` — the popup may have closed before the pipeline finishes.

#### Tab event listeners (smart cache invalidation)

Instead of clearing clusters when tabs change, the background performs surgical updates using domain-aware logic and smart embedding when possible:

```
onCreated
  ├── tab has real URL (link opened in new tab) → smartPlace()
  └── blank / chrome:// tab                    → addToUngrouped()

onUpdated (changeInfo.url set)
  ├── same domain as current cluster           → update tab data in place (no cluster move)
  └── different domain                         → remove from cluster → smartPlace()

onRemoved
  └── remove tab from its cluster, drop empty clusters
```

Changes are written to `clusterCache_${windowId}`, triggering `chrome.storage.onChanged` in any open popup/sidepanel to update the UI live.

#### Smart placement (`smartPlace`)

After a Tidy Up run, `ClusterCache.centroids` holds a 384-dim centroid for each cluster. When a new or navigated tab arrives, `smartPlace` embeds the single tab and places it into the nearest cluster if the similarity clears the threshold — otherwise Ungrouped.

```ts
async function smartPlace(cache: ClusterCache, tab: Tab): Promise<void>
```

Guard chain (falls back to `addToUngrouped` at the first failure):
1. **Has named clusters** — at least one cluster that isn't `'Ungrouped'`. Prevents smart placement during crash-restore or bulk tab sessions when no real groups exist.
2. **Centroids present** — `cache.centroids?.length` must be truthy.
3. **Offscreen is warm** — `isOffscreenAvailable()` checks for an existing offscreen document without creating one. No cold-starting the GPU pipeline on every tab open.
4. **Embedding succeeds** — `embedSingleTab()` sends `EMBED_SINGLE_TAB` to the offscreen and returns the 384-dim vector, or `null` on failure.
5. **Similarity threshold** — best cluster centroid similarity must be `≥ 1 - THRESHOLD` (equivalent to cosine distance `< THRESHOLD`, matching the clustering algorithm's criterion).

After placement, the cluster's centroid is updated with a running average so it stays representative as new tabs arrive:
```ts
const count = cache.clusters[bestIdx].length;
cache.centroids[bestIdx] = cache.centroids[bestIdx].map(
    (v, i) => (v * (count - 1) + vector[i]) / count
);
```

**Centroid similarity note:** Tab vectors are unit-length (pipeline `normalize: true`). Centroids are the mean of unit vectors and may have magnitude < 1. `centroidSim()` uses the full cosine similarity formula (`dot / |centroid|`) rather than the raw dot product to avoid systematically underestimating similarity.

#### Background re-cluster

45 minutes after every successful Tidy Up, `chrome.alarms` fires `reCluster_${windowId}`. The handler runs `runBackgroundReCluster()`:

1. Guards: skip if a cluster job is running, no cache exists, or the window was closed
2. Queries fresh tab data via `chrome.tabs.query()` — bypasses any drift in stored Tab objects
3. Enriches tabs with taxonomy signals, runs full `RUN_EMBEDDINGS` through the offscreen
4. Calls `isProposalMeaningfullyDifferent(currentCache, proposal)`:
   - More named clusters in the proposal, **or**
   - Ungrouped has shrunk by 3+ tabs
5. If different: writes `clusterProposal_${windowId}` → triggers `storage.onChanged` → popup/sidepanel shows `ProposalBanner`
6. If not different: silently discards the result

`APPLY_PROPOSAL` replaces `clusterCache` with the proposal and re-arms the 45-minute alarm. `DISMISS_PROPOSAL` just removes the proposal key.

#### Cache lifecycle

```ts
// Chrome restart — all tab IDs reset, every cache is stale
chrome.runtime.onStartup.addListener(async () => {
    // removes all clusterCache_*, clusterJob_*, clusterProposal_* keys
})

// Window closed — remove per-window keys and cancel the alarm
chrome.windows.onRemoved.addListener(async (windowId) => {
    chrome.storage.local.remove([`clusterCache_${windowId}`, `clusterJob_${windowId}`, `clusterProposal_${windowId}`])
    chrome.alarms.clear(`reCluster_${windowId}`)
})
```

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

`isOffscreenAvailable()` is a separate read-only check (does not create) used by `smartPlace` to avoid cold-starting the pipeline on every tab event.

---

### 2. Offscreen Document

**Files:** [`src/offscreen/offscreen.html`](src/offscreen/offscreen.html), [`src/offscreen/offscreen.ts`](src/offscreen/offscreen.ts)

Hidden browser page with full renderer access (WebGPU, dynamic `import()`). Runs the entire ML pipeline.

#### Embedding model

```ts
const MODEL_ID = 'Xenova/all-MiniLM-L12-v2'  // 12-layer, 33MB, 384-dim
```

L12 distinguishes intent (browsing code vs. buying something) rather than just keyword overlap. L6 is faster but produces weaker cluster separation. The `pipeline()` call is memoized by transformers.js — the model loads once per offscreen document lifetime and subsequent calls are inference-only (~50ms).

#### Message handlers

**`RUN_EMBEDDINGS`** — full pipeline for all tabs in a window:
1. Embed all tabs → `vectors: number[][]`
2. Agglomerative cluster → `clusterIndices: number[][]`
3. Split: multi-tab clusters get Gemini/KeyBERT labels; singletons → Ungrouped
4. Compute one centroid per final cluster via `computeCentroid`
5. Respond with `{ clusters, labels, centroids, vector }`

**`EMBED_SINGLE_TAB`** — lightweight single-tab embedding for smart placement:
```ts
// Receives an EnrichedTab, returns its 384-dim vector
{ action: 'EMBED_SINGLE_TAB', tab: EnrichedTab }
→ { status: 'success', vector: number[] }
```
Reuses the already-loaded pipeline singleton — no model reload. Used by `smartPlace` in the background to place a single new or navigated tab without re-running the full pipeline.

#### Centroid computation

After clustering, one centroid is computed per final cluster (including Ungrouped) and returned alongside clusters and labels:

```ts
const multiCentroids = multiIndices.map(group =>
    computeCentroid(group.map(idx => vectors[idx]))
)
const finalCentroids = singleTabs.length > 0
    ? [...multiCentroids, computeCentroid(singletonIndices.map(idx => vectors[idx]))]
    : multiCentroids
```

#### Cluster labeling — Gemini Nano first, KeyBERT fallback

`generateLabels` tries Gemini Nano as primary and falls back to KeyBERT per cluster if it fails:

```ts
async function generateLabels(
    clusters: EnrichedTab[][], clusterIndices: number[][],
    embedder: any, tabs: EnrichedTabs, vectors: number[][]
): Promise<string[]>
```

Gemini Nano prompt: _"These browser tabs are open together: … Write a concise 2–4 word title describing what they have in common."_

KeyBERT fallback: embed candidate keywords extracted from tab titles, find the top-k closest to the cluster centroid.

#### Single-tab separation

After clustering, single-tab clusters are pulled out and collected into a single **Ungrouped** bucket appended at the end:

```ts
const multiClusters = clusteredTabs.filter(c => c.length > 1)
const singleTabs    = clusteredTabs.filter(c => c.length === 1).flat()
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
const [proposal, setProposal]       = useState<ClusterProposal | null>(null)
const windowIdRef                   = useRef<number | null>(null)
```

#### Initialization (`useEffect`)

```ts
const init = async () => {
  const win = await chrome.windows.getCurrent()
  windowIdRef.current = win.id!

  const [jobResult, proposalResult, response] = await Promise.all([
    chrome.storage.local.get(`clusterJob_${wid}`),
    chrome.storage.local.get(`clusterProposal_${wid}`),
    chrome.runtime.sendMessage({ action: 'GET_TABS', windowId: wid }),
  ])

  // Restore in-progress clustering indicator if popup was closed mid-run
  if (jobResult[`clusterJob_${wid}`]?.status === 'running') setClustering(true)

  // Restore any pending background proposal
  if (proposalResult[`clusterProposal_${wid}`]) setProposal(proposalResult[`clusterProposal_${wid}`])

  // Restore cached clusters or show fresh flat tab list
  if (response.status === 'cache_success') { setTabs(response.tabs); setLabels(response.labels) }
  else if (response.status === 'success')  { setTabs([response.tabs]) }

  setChromeGroups(await computeGroupInfo(clusters, wid))
}
```

#### Reactive storage listener

`chrome.storage.onChanged` drives all live updates — clustering completion, tab events, and proposal arrival:

```ts
const handleStorageChange = async (changes, area) => {
  const cacheChange = changes[`clusterCache_${wid}`]
  if (cacheChange?.newValue) {
    const cache = cacheChange.newValue as ClusterCache
    setTabs(cache.clusters)
    setLabels(cache.labels ?? [])
    setChromeGroups(await computeGroupInfo(cache.clusters, wid))
  }
  const jobChange = changes[`clusterJob_${wid}`]
  if (jobChange?.newValue?.status === 'done' || 'error') setClustering(false)

  // Background re-cluster produced a new proposal
  const proposalChange = changes[`clusterProposal_${wid}`]
  if (proposalChange !== undefined) {
    setProposal(proposalChange.newValue as ClusterProposal | null ?? null)
  }
}
```

#### Chrome Tab Groups

`computeGroupInfo` queries Chrome directly to check if each cluster already has a native tab group:

```ts
async function computeGroupInfo(clusters: Tab[][], windowId: number): Promise<ChromeGroupInfo[]>
// Returns { groupId, color } for clusters where all tabs share one groupId, null otherwise
```

Called after mount, after clustering, and after any group/ungroup action. Read-only — never creates or modifies Chrome groups.

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

#### [`src/components/TabList.tsx`](src/components/TabList.tsx)

Shared between popup and side panel. Renders `Tab[][]` as either a plain list (single group) or color-tinted cards with headers (multiple groups).

```ts
interface TabListProps {
  tabs: Tab[][]
  labels?: string[]
  chromeGroups?: ChromeGroupInfo[]   // parallel — null means no Chrome group for that cluster
  loading: boolean
  onTabClick: (tab: Tab) => void
  onTabClose: (tab: Tab) => void
  onGroupCluster?: (tabs: Tab[], label: string, index: number) => void
  onUngroupCluster?: (tabs: Tab[], groupId: number) => void
}
```

**Card coloring** — when a `ChromeGroupInfo` entry exists for a cluster, the card background and border are tinted with the Chrome group's color (8-digit hex alpha):
```ts
style={{ backgroundColor: dotColor + '55', borderColor: dotColor + '80' }}
```

**Cluster header** — shows the AI-generated label, an optional colored dot for existing Chrome groups, and a "Group"/"Ungroup" button. The Ungrouped bucket never shows a Group button.

#### [`src/components/ProposalBanner.tsx`](src/components/ProposalBanner.tsx)

Non-blocking banner that appears between the toolbar and tab list when a background re-cluster has found a meaningfully better grouping. Shown in both popup and sidepanel.

```ts
interface Props {
  windowId: number
  proposal: ClusterProposal   // used to display group count and tab count
  onDismiss: () => void        // called optimistically to clear local state
}
```

**Apply** — sends `APPLY_PROPOSAL` to the background, which replaces `clusterCache` with the proposal and re-arms the alarm. The `clusterCache` storage change triggers the normal `onChanged` listener and updates the tab list.

**Dismiss (✕)** — sends `DISMISS_PROPOSAL` to remove the proposal key from storage. Neither action modifies Chrome Tab Groups — the user manages those manually via the "Group"/"Ungroup" buttons.

---

### 5. Taxonomy Engine

**Files:** [`src/lib/taxonomyEngine.ts`](src/lib/taxonomyEngine.ts), [`src/lib/taxonomy.types.ts`](src/lib/taxonomy.types.ts)

Loads `public/taxonomy.json` (~100 sites) and provides O(1) URL classification used to enrich tabs before embedding.

---

### 6. Clustering Library

**File:** [`src/lib/clustering.ts`](src/lib/clustering.ts)

Pure functions — no Chrome APIs or browser dependencies. Used by the offscreen document and tests.

| Export | Description |
|---|---|
| `THRESHOLD` | Distance threshold (0.65) for clustering and smart placement |
| `agglomerativeCluster(embeddings, threshold?)` | Bottom-up clustering → `number[][]` of tab index groups |
| `formatTabInput(url, title, signal?, category?)` | Formats enriched tab into embedding string |
| `mapClustersToItems(items, clusters)` | Maps index clusters → `T[][]` |
| `extractCandidates(tabs)` | KeyBERT: extract candidate keywords from tab titles |
| `computeCentroid(vectors)` | Mean of a set of embedding vectors |
| `topKeywords(candidates, cvectors, centroid, k)` | KeyBERT: top-k words by cosine similarity to centroid |
| `cosineSimilarity(a, b)` | Dot product (correct when both vectors are unit-length) |
| `cosineDistance(a, b)` | `1 - cosineSimilarity` |

`THRESHOLD` is exported so smart placement in `background.ts` can use the same criterion as the clustering algorithm (`1 - THRESHOLD` converts distance to similarity for centroid comparisons).

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
| `clusterProposal_${windowId}` | `ClusterProposal` | background (alarm-triggered re-cluster) | popup/sidepanel (init + onChanged → ProposalBanner) |

**Cache invalidation:**
- Tab events trigger surgical cache updates. New tabs use `smartPlace` (embed + centroid comparison) if named clusters exist and the offscreen is warm, otherwise fall back to Ungrouped. Same-domain navigations update tab data in place. Cross-domain navigations re-embed and re-place.
- `onStartup` removes all three key types — Chrome restart resets tab IDs so every cached cluster is stale.
- `windows.onRemoved` removes all three keys for that window and cancels its `reCluster_` alarm.

**Proposal lifecycle:**
```
handleClusterTabs (success)
  → chrome.alarms.create('reCluster_${windowId}', { delayInMinutes: 45 })
  → clears any existing clusterProposal_${windowId}

alarm fires
  → runBackgroundReCluster()
  → if meaningfully different → writes clusterProposal_${windowId}
  → popup/sidepanel onChanged → ProposalBanner appears

user clicks Apply
  → APPLY_PROPOSAL: clusterCache ← proposal, removes proposal key, re-arms alarm
  → clusterCache change → onChanged → tab list updates

user clicks Dismiss
  → DISMISS_PROPOSAL: removes proposal key
```

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
| `alarms` | `chrome.alarms.create/clear/onAlarm` — background re-cluster scheduling |
| `contentSettings` | Per-site content settings |

---

## How the Files Connect

```
manifest.config.ts
      │
      ▼
CRXJS Vite Plugin
      ├─► src/popup/index.html
      │         └── App.tsx → GeminiGate → ProposalBanner → TabList
      ├─► src/sidepanel/index.html
      │         └── App.tsx → GeminiGate → ProposalBanner → TabList
      ├─► src/settings/index.html → App.tsx
      ├─► src/content/main.tsx
      └─► src/background/background.ts
                ├── @/lib/taxonomyEngine.ts
                ├── @/lib/clustering.ts  (THRESHOLD, cosineSimilarity)
                └── @/types.ts

vite.config.ts (rollupOptions.input)
      └─► src/offscreen/offscreen.html
                └── offscreen.ts
                      ├── @/lib/clustering.ts  (agglomerativeCluster, computeCentroid, …)
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

**Extension CSP blocks CDN imports.** Copy onnxruntime-web WASM files to `public/ort/` and set `env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('/ort/')`. The `manifest.config.ts` includes `'wasm-unsafe-eval'` in `content_security_policy.extension_pages` for WebAssembly instantiation.

**`return true` in message listeners.** Always return `true` from `onMessage.addListener` when `sendResponse` is called asynchronously — forgetting this closes the channel and the response silently becomes `undefined`.

**`sendResponse` throws if the sender context closes.** Wrap all `sendResponse` calls in `try/catch` in `handleClusterTabs` — the popup may close before the ML pipeline finishes.

**`chrome.storage.session` clears on macOS sleep.** Use `chrome.storage.local` for anything that should survive system sleep. `storage.session` only survives until Chrome closes.

**`chrome.storage.get(key)` wraps the result.** `get('clusterCache_1')` returns `{ clusterCache_1: ... }` not the value directly — always unwrap: `result['clusterCache_1']`.

**`LanguageModel.availability()` not `capabilities()`.** The Prompt API uses `availability()` returning `'available' | 'downloadable' | 'downloading' | 'unavailable'`. The older `capabilities()` / `window.ai.languageModel` API is deprecated.

**`e.loaded` in `downloadprogress` is a decimal (0–1).** Multiply by 100 for percentage — there is no `e.total` property.

**Don't pass class instances through `sendMessage`.** The structured clone algorithm strips methods. Pass plain JSON — `TaxonomyEngine` stays in the background and the offscreen only receives plain `EnrichedTab[]`.

**Centroid similarity vs. dot product.** Tab vectors from the embedding pipeline are unit-length (`normalize: true`). Cluster centroids are the mean of unit vectors and may have magnitude < 1. Use the full cosine formula (`dot / |centroid|`) for centroid comparisons rather than the raw dot product, otherwise similarity scores are systematically underestimated and the placement threshold behaves too strictly.

**Smart placement requires warm offscreen.** `smartPlace` checks `isOffscreenAvailable()` (read-only, no model load) and silently falls back to Ungrouped if the offscreen document isn't running. This avoids a 2–3 second cold-start on every tab open when the user hasn't used the extension recently.

**Background re-cluster won't overwrite a running job.** `runBackgroundReCluster` guards against `clusterJob_${windowId}.status === 'running'` to avoid a race with a manual Tidy Up triggered at the same time.

**`@/` alias** maps to `src/`. Must be configured in both `tsconfig.app.json` (paths) and `vite.config.ts` (resolve.alias).
