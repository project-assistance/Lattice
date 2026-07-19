# Lattice Chrome Extension — Architecture & Agent Context

This document covers the full architecture, design decisions, UX rationale, known limitations, and development workflow. It is the primary context file for any Claude agent or developer picking up this codebase — read it before making changes.

---

## Product & Audience

**What it is:** A Chrome extension that uses ML embeddings to automatically cluster open tabs into semantically meaningful groups. Users can label, rename, drag-and-drop, and pin clusters to Chrome's native tab groups.

**Target audience:** Tab-hoarder power users — developers, researchers, knowledge workers — who keep Chrome open for days and regularly have 30–150+ tabs. Core pain: cognitive overhead of managing tabs manually and losing context when switching tasks.

**Core value proposition:** Intelligent organization without user effort. The extension watches tab events in the background and continuously maintains a well-organized view. Users should feel like Lattice "just knows" where a new tab belongs.

**Key product principles:**
- The extension must work even when Gemini Nano is unavailable (KeyBERT fallback for labels)
- Lattice's clusters are the source of truth — Chrome tab groups are an optional visual layer, not an independent system to manage
- Automation should be silent; surface proposals only when the improvement is meaningful
- Reconcile against Chrome's live state on every popup open — never trust stored state blindly

---

## Design Decisions

These are the non-obvious architectural choices made and the reasoning behind them. Future agents should understand the *why* before changing these.

**SW dormancy compensated at popup-open time, not at event time**
Chrome MV3 service workers are killed after ~30 seconds of inactivity. Tab events fired while the SW is dormant are permanently lost. We compensate in `handleGetTabs` (runs every popup/sidepanel open) with `reconcileTabs()`, which diffs the cache against Chrome's live tab state. This is cheaper and more reliable than trying to keep the SW alive or replay missed events.

**Session restore is lazy (GET_TABS time), not eager (onStartup time)**
Chrome's session restore (restoring tabs after restart) is not guaranteed to be complete when `onStartup` fires. If we tried to remap tab IDs at startup, Chrome might not have all tabs available yet. Instead, `onStartup` only marks caches stale. The URL-based remapping runs lazily when the user first opens the extension, at which point all tabs are available.

**Chrome tab groups are identified by tab membership, not stored ID**
Chrome assigns new integer IDs to tab groups every session. Storing the ID is useful within a session but meaningless after restart. `reconcileGroupIds()` always matches by checking which Chrome group the cluster's tabs currently belong to. This survives restarts transparently.

**Threshold passed in RUN_EMBEDDINGS payload, not read in offscreen**
Offscreen documents in Chrome MV3 have a limited Chrome API subset — `chrome.storage` is not available. The background reads `clusteringThreshold` from storage via `getThreshold()` and includes it in the `RUN_EMBEDDINGS` message. This is a firm constraint, not a style choice.

**AI labeling is the default — KeyBERT is a silent fallback**
GeminiGate (the previous onboarding gate that asked users to opt into Gemini Nano) has been removed. AI labeling is now the default with no user action required. The extension falls back to KeyBERT labels silently in every case where AI is not `'available'`: model is downloading, disabled in Chrome settings, on an unsupported device, or if `LanguageModel.create()` throws despite a good availability check. Users who actively want keyword labels can toggle the setting in Settings → Group name style. The `geminiChoice` storage key drives this: any value other than explicit `'skip'` is treated as `'ai'` (including `undefined`).

**LanguageModel.create() hangs — always check availability() first**
Calling `LanguageModel.create()` when Chrome is mid-downloading Gemini Nano causes the call to block indefinitely (it does not throw). The `downloadprogress` event also resets to 0% in this state due to a Chrome bug. The fix is to call `LanguageModel.availability()` before `create()` and only proceed when the result is `'available'`. Any other state (`'downloadable'`, `'downloading'`, `'no'`) falls back to KeyBERT immediately. Notably, calling `availability()` itself may trigger Chrome to begin downloading the model as a side effect.

**sendMessageWithTimeout wraps all offscreen calls**
`chrome.runtime.sendMessage` does not support a built-in timeout. If the offscreen document hangs (e.g., `LanguageModel.create()` blocked by a Chrome download), the callback never fires and `handleClusterTabs` would wait forever with `clusterJob.status` stuck at `'running'`. The `sendMessageWithTimeout(msg, 90_000)` helper wraps `sendMessage` in a Promise that rejects after 90 seconds, writing `{ status: 'error' }` to storage and surfacing the error strip in the UI.

**"Pin to Chrome" framing for tab groups**
Calling the button "Group"/"Ungroup" implied Lattice was a tab group manager, confusing users about what the button controlled. The rename to "Pin to Chrome"/"Unpin" communicates that the action is publishing Lattice's existing organization into Chrome's tab bar — not organizing tabs.

**smartPlace falls back to Ungrouped silently**
When the offscreen document is cold (model not loaded), forcing a cold start on every new tab would cause a 2-3 second delay. Instead, `smartPlace` checks `isOffscreenAvailable()` (read-only) and adds to Ungrouped if cold. The model only loads when the user explicitly clicks Organize.

**Background re-cluster produces proposals, never auto-applies**
After 45 minutes, the background re-clusters to detect drift. Even if the result is significantly better, it never auto-applies — it shows a `ProposalBanner` requiring explicit user approval. This is intentional: auto-applying would rearrange tabs the user has open and cause confusion.

---

## What Is NOT Handled (Intentional)

These are deliberate gaps, not bugs. Don't "fix" them without understanding the tradeoff.

**Chrome-to-Lattice sync for tab group changes**
If the user drags a tab between Chrome groups in the tab bar, Lattice's cluster membership does not update. Lattice is the source of truth — Chrome groups reflect Lattice, not the reverse. Listening to `chrome.tabs.onMoved` and `chrome.tabGroups.onUpdated` to sync back would create a two-system conflict with no clear winner.

**URL-changed tabs during SW dormancy are not re-embedded**
`reconcileTabs()` updates metadata (title, favicon) for tabs whose URL changed while the SW was dormant, but does not re-cluster them. Running embeddings for an arbitrary number of tabs on every popup open would be slow and surprising. The user can run Organize to re-cluster, or drag to the correct group.

**Multi-window drag-and-drop**
Tabs can only be drag ged within the same popup's cluster view. Cross-window moves are not supported — `MOVE_TAB` scopes all operations to `windowId`.

**Ungrouped cluster cannot be renamed or pinned to Chrome**
The Ungrouped bucket is a catch-all, not a meaningful semantic cluster. Allowing it to be renamed or pinned would imply it has a coherent identity it doesn't have.

**No real-time sync with Chrome's tab group renames**
If the user renames a Chrome tab group in the tab bar, Lattice's `cache.labels` is not updated. The rename flows one way: Lattice → Chrome (via `RENAME_CLUSTER` calling `chrome.tabGroups.update`). Chrome → Lattice would require listening to `chrome.tabGroups.onUpdated` and deciding which name wins.

---

## Error Handling Patterns

**`sendResponse` is always wrapped in try/catch in the background**
The popup may be closed before the ML pipeline finishes (e.g., user clicks Organize then closes the popup). Calling `sendResponse` on a closed channel throws. Wrapping prevents unhandled rejections that would crash the service worker.

**Clustering errors surface via storage, not message response**
`handleClusterTabs` writes `{ status: 'error', error: message }` to `clusterJob_${windowId}`. The popup reads this via `storage.onChanged` and shows a dismissible error strip. This works even if the popup was closed and reopened — the error state persists in storage until the next successful cluster.

**`sendMessageWithTimeout` prevents silent indefinite hangs**
`handleClusterTabs` and `runBackgroundReCluster` both use `sendMessageWithTimeout(msg, 90_000)` instead of raw `chrome.runtime.sendMessage`. If the offscreen pipeline hangs for any reason (most commonly `LanguageModel.create()` blocked by an in-progress Chrome download), the 90-second deadline triggers, rejects the promise, and writes `{ status: 'error' }` to storage — which surfaces the error strip in the UI. Without this, the job would be stuck at `'running'` until the popup was closed and the 5-minute stuck-job detector fired.

**Stuck-job detection at popup-open time**
If `clusterJob.status === 'running'` and `startedAt` is more than 5 minutes ago, the popup resets the job to `error` and shows the error strip. This handles the case where the service worker crashed mid-run and never wrote the final status.

**`chrome.tabs.group()` failures clear the stale groupId**
Any `chrome.tabs.group({ groupId })` call that throws means the Chrome group no longer exists. The catch block immediately sets `cache.groupIds[idx] = null` so future placements don't keep trying. The proactive path is `chrome.tabGroups.onRemoved` which clears stale groupIds before any placement attempt.

**`isProposalMeaningfullyDifferent` prevents noisy proposals**
Three criteria must be met before surfacing a re-cluster as a proposal: more named clusters, OR Ungrouped shrank by 2+, OR >20% of named tabs shifted clusters. This prevents background noise from waking the user for trivial changes.

---

## Data Flow: How the UI Stays in Sync

The UI never polls. All updates flow through `chrome.storage.onChanged`:

```
User action / tab event
        │
        ▼
background.ts mutates ClusterCache
  → chrome.storage.local.set({ clusterCache_${windowId}: ... })
        │
        ▼
chrome.storage.onChanged fires in popup/sidepanel
  → handleStorageChange reads newValue
  → setTabs(cache.clusters)
  → setLabels(cache.labels)
  → computeGroupInfo(cache.clusters, wid) → setChromeGroups(...)
```

`computeGroupInfo` is always a live query against Chrome's current state — it does not read `cache.groupIds`. This means the UI's visual state (colored dots, Pin/Unpin) is always correct even if `cache.groupIds` is momentarily stale.

`cache.groupIds` is the background's functional state (used by smartPlace, MOVE_TAB, onCreated/onUpdated). It is kept in sync by:
1. Explicit operations (CREATE_TAB_GROUP, UNGROUP_TABS, tabGroups.onRemoved)
2. `reconcileGroupIds()` on every popup open

---

## Reconciliation Pipeline (runs on every GET_TABS)

```
handleGetTabs(windowId)
  │
  ├─ Fresh cache (!stale):
  │   ├── reconcileTabs(cache, windowId)
  │   │     ├── remove ghost tabs (closed while SW dormant)
  │   │     ├── update metadata (title/favicon/active/url)
  │   │     └── add untracked Chrome tabs → Ungrouped
  │   ├── reconcileGroupIds(clusters, windowId)
  │   │     └── match by tab membership → rebuild groupIds array
  │   └── write to storage only if changed → triggers onChanged → UI updates
  │
  ├─ Stale cache (after Chrome restart):
  │   ├── URL-based tab ID remapping (find best overlap across stale caches)
  │   ├── reconcileTabs() (catch tabs opened before extension was first opened)
  │   ├── reconcileGroupIds() (re-associate with surviving Chrome groups)
  │   └── write new cache, remove stale keys
  │
  └─ No cache:
      └── chrome.tabs.query() → return flat Tab[]
```

Both `reconcileTabs` and `reconcileGroupIds` are idempotent — running them when nothing changed produces no storage write.

---

## Feature Status

| Feature | Status | Notes |
|---|---|---|
| ML clustering (agglomerative + embeddings) | ✅ Complete | Xenova/all-MiniLM-L12-v2, 384-dim |
| Gemini Nano cluster labeling | ✅ Complete | AI default; KeyBERT silent fallback when unavailable |
| Smart tab placement (single embed) | ✅ Complete | Falls back to Ungrouped when offscreen cold or disabled |
| Background re-cluster + proposal | ✅ Complete | Configurable interval (Off/30/45/90 min), requires explicit Apply |
| Session restore (URL remapping) | ✅ Complete | Lazy, runs on first GET_TABS after restart |
| SW dormancy reconciliation | ✅ Complete | `reconcileTabs()` on every popup open |
| Chrome tab group integration ("Pin to Chrome") | ✅ Complete | `groupIds` in cache, auto-adds new tabs |
| groupId reconciliation by tab membership | ✅ Complete | Survives Chrome restarts |
| Tab group deleted mid-session | ✅ Complete | `tabGroups.onRemoved` clears stale groupId |
| Drag-and-drop tab movement | ✅ Complete | HTML5 DnD with RAF auto-scroll |
| Inline cluster rename | ✅ Complete | Duplicate check, Chrome group title sync |
| Cluster sensitivity presets (Lower/Default/Higher) | ✅ Complete | Settings page, `clusteringThreshold` in storage |
| Re-cluster interval setting | ✅ Complete | `reClusterInterval` in storage; 0 = off |
| Smart placement toggle | ✅ Complete | `smartPlacement` boolean in storage; default on |
| Grouping proposals toggle | ✅ Complete | `showProposals` boolean in storage; default on |
| AI labeling toggle | ✅ Complete | `geminiChoice` in storage; `'skip'` uses KeyBERT |
| Error surface + stuck-job recovery | ✅ Complete | Error strip in popup/sidepanel, 5-min timeout |
| 90-second offscreen call timeout | ✅ Complete | `sendMessageWithTimeout` in background.ts |
| Welcome / onboarding page | ✅ Complete | Opens on first install via `onInstalled`; shows pin-to-toolbar flow |
| Debug diagnostics panel | ✅ Complete | Settings page, GET_DIAGNOSTICS message |
| Chrome → Lattice tab group sync | ❌ Intentionally not done | Lattice is source of truth |
| Multi-window drag-and-drop | ❌ Not supported | Out of scope |
| Cross-domain re-embed during reconciliation | ❌ Not done | Performance tradeoff; user can Organize |

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
│  │  TabList             │                            │  EMBED_SINGLE_TAB    │  │
│  │  ProposalBanner      │                            │       │              │  │
│  │  error-strip         │                            │       ▼              │  │
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
  clusters: Tab[][]        // parallel arrays — index i of all four fields is the same cluster
  labels: string[]
  centroids?: number[][]   // one 384-dim centroid per cluster, parallel to clusters[]
  groupIds?: (number | null)[]  // Chrome tab group ID per cluster; null = not pinned
  stale?: boolean          // set by onStartup; triggers session-restore remapping in GET_TABS
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
  startedAt?: number  // Date.now() when job started; used for stuck-job detection (> 5 min)
}
```

`ClusterCache.centroids` is optional for backward compatibility with caches written before centroids were introduced. `ClusterProposal` is written to storage only when a background re-cluster produces a meaningfully better grouping than the current state — it is never applied automatically.

---

## Runtime Contexts

### 1. Background (Service Worker)

**File:** [`src/background/background.ts`](src/background/background.ts)

The service worker is the event broker. It has no DOM and no WebGPU. Responsibilities: fetch tabs, load taxonomy, delegate ML work to the offscreen document, manage per-window storage, handle tab lifecycle events, run smart tab placement, and schedule background re-clusters.

#### Storage helpers

Four async getters read user settings from storage at call time so the background always uses the current value:

```ts
getThreshold()          → number           // 'clusteringThreshold', default THRESHOLD (0.65)
getReClusterInterval()  → number           // 'reClusterInterval', default 45 (minutes); 0 = off
getSettingBool(key, default) → boolean     // generic boolean helper for 'smartPlacement', 'showProposals'
getUseAi()              → boolean          // true unless geminiChoice === 'skip'
```

`getUseAi()` treats `undefined` (key not yet set) as `true` — AI is the default, and `'skip'` must be explicitly stored before keyword labels are used.

#### Message API

| Action | Payload | Response |
|---|---|---|
| `GET_TABS` | `{ windowId }` | `{ status: 'success', tabs: Tab[] }` or `{ status: 'cache_success', tabs: Tab[][], labels: string[] }` |
| `CLUSTER_TABS` | `{ windowId }` | `{ status, clusters: Tab[][], labels: string[], vector: number[][] }` |
| `SET_ACTIVE_TAB` | `{ tabId }` | `{ status }` |
| `CLOSE_TAB` | `{ tabId }` | `{ status }` |
| `CREATE_TAB_GROUP` | `{ tabIds, title, colorIndex, clusterIdx, windowId }` | `{ status, groupId }` — persists groupId to `cache.groupIds[clusterIdx]` |
| `UNGROUP_TABS` | `{ tabIds, clusterIdx, windowId }` | `{ status }` — clears `cache.groupIds[clusterIdx]` |
| `MOVE_TAB` | `{ tabId, fromClusterIdx, toClusterIdx, windowId }` | `{ status }` — moves tab in cache; adds to Chrome group if destination is pinned |
| `RENAME_CLUSTER` | `{ clusterIdx, newLabel, windowId }` | `{ status }` — renames label in cache; updates Chrome tab group title if pinned |
| `LOAD_TAXONOMY` | — | `{ status, version, aliases }` |
| `APPLY_PROPOSAL` | `{ windowId }` | `{ status }` — ungroups tracked Chrome groups, replaces `clusterCache` with proposal |
| `DISMISS_PROPOSAL` | `{ windowId }` | `{ status }` — removes `clusterProposal` from storage |
| `GET_DIAGNOSTICS` | — | `{ status, offscreenAvailable, windows: WindowDiag[] }` — used by the settings debug panel |

**`RUN_EMBEDDINGS` internal message** (background → offscreen):

```ts
{ action: 'RUN_EMBEDDINGS', tabs: EnrichedTab[], threshold: number, useAi: boolean }
```

`useAi` is resolved by `getUseAi()` before the message is sent. The offscreen document cannot read `chrome.storage`, so both `threshold` and `useAi` must be passed as payload fields. This is a firm constraint of the MV3 offscreen API.

Both `GET_TABS` and `CLUSTER_TABS` require `windowId` in the payload — the background cannot infer which window the popup belongs to from `sender` alone.

#### Per-window storage

Every cached result is keyed by `windowId` so multiple windows maintain independent cluster state:

```ts
const cacheKey    = `clusterCache_${windowId}`    // ClusterCache
const jobKey      = `clusterJob_${windowId}`      // ClusterJob
const proposalKey = `clusterProposal_${windowId}` // ClusterProposal
```

**`GET_TABS` response logic (runs every time popup or sidepanel opens):**
1. Check `clusterCache_${windowId}` in local storage
2. **Fresh cache** (`!cache.stale`):
   - `reconcileTabs()` — removes ghost tabs, refreshes title/favicon/active metadata, adds untracked Chrome tabs to Ungrouped. Handles service-worker dormancy gaps (SW can be killed by Chrome after ~30s idle, missing tab events).
   - `reconcileGroupIds()` — rebuilds `cache.groupIds` by tab membership (not stored ID). Handles Chrome restarts where group IDs are reassigned.
   - Writes to storage only if either reconciliation changed anything, then returns `cache_success`.
3. **Stale cache** (set by `onStartup` on Chrome restart):
   - URL-based session restore: scans all stale caches, finds best URL overlap with current window, remaps tab IDs, drops unmatched tabs.
   - Runs `reconcileTabs()` after remapping to catch tabs opened in the current session before the extension was first opened.
   - Runs `reconcileGroupIds()` to re-associate with Chrome groups that survived the restart.
   - Cleans up stale cache keys, returns `cache_success`.
4. **No cache** → query Chrome tabs and return `success` with a flat `Tab[]`

#### Job tracking

`handleClusterTabs` writes job status to local storage so the popup can recover state if closed mid-run. It is fully `async/await` and calls `sendMessageWithTimeout(..., 90_000)` to prevent indefinite hangs:

```ts
// Start — include startedAt for stuck-job detection in the popup (> 5 min = timed out)
await chrome.storage.local.set({ [jobKey]: { status: 'running', startedAt: Date.now() } as ClusterJob })

// Resolve threshold and useAi in parallel, then send to offscreen with a 90s deadline
const [threshold, useAi] = await Promise.all([getThreshold(), getUseAi()])
const response = await sendMessageWithTimeout(
  { action: 'RUN_EMBEDDINGS', tabs: enrichedTabs, threshold, useAi },
  90_000
)

// On success
chrome.storage.local.set({
  [cacheKey]: { clusters, labels, centroids } as ClusterCache,
  [jobKey]: { status: 'done' } as ClusterJob,
})

// On error (including timeout rejection)
chrome.storage.local.set({ [jobKey]: { status: 'error', error: message } as ClusterJob })
```

After a successful cluster, the background also:
1. Removes any existing `clusterProposal_${windowId}` — a fresh manual cluster supersedes it
2. Creates a `chrome.alarms` entry `reCluster_${windowId}` with a 45-minute delay

The clustering threshold is user-configurable via Settings (`clusteringThreshold` in storage, default `THRESHOLD = 0.65`). Background reads it with `getThreshold()` before each `RUN_EMBEDDINGS` call and passes it in the message payload — offscreen cannot read storage directly.

`sendResponse` is wrapped in `try/catch` — the popup may have closed before the pipeline finishes.

#### Tab event listeners (smart cache invalidation)

Instead of clearing clusters when tabs change, the background performs surgical updates using domain-aware logic and smart embedding when possible:

```
onCreated
  ├── smartPlacement setting enabled:
  │     ├── tab has real URL → smartPlace()
  │     │     └── if placed cluster has groupId → chrome.tabs.group() adds tab to Chrome group
  │     └── blank / chrome:// tab → addToUngrouped()
  └── smartPlacement disabled → addToUngrouped()

onUpdated (changeInfo.url set)
  ├── smartPlacement setting enabled:
  │     ├── same domain as current cluster → update tab data in place (no cluster move)
  │     └── different domain → remove from cluster → smartPlace()
  │           └── if placed cluster has groupId → chrome.tabs.group() adds tab to Chrome group
  └── smartPlacement disabled → addToUngrouped()

onRemoved
  └── remove tab from its cluster, drop empty clusters
      (groupIds array filtered in parallel with clusters/labels/centroids)
```

All pairs-rebuild operations (onUpdated cross-domain, onRemoved, MOVE_TAB, APPLY_PROPOSAL) thread `groupId` through the pairs map so `ClusterCache.groupIds` stays parallel to `clusters`.

Changes are written to `clusterCache_${windowId}`, triggering `chrome.storage.onChanged` in any open popup/sidepanel to update the UI live.

#### Smart placement (`smartPlace`)

After a Organize run, `ClusterCache.centroids` holds a 384-dim centroid for each cluster. When a new or navigated tab arrives, `smartPlace` embeds the single tab and places it into the nearest cluster if the similarity clears the threshold — otherwise Ungrouped.

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

After every successful Organize, `chrome.alarms` fires `reCluster_${windowId}` after a configurable delay. The handler runs `runBackgroundReCluster()`:

1. Guards: skip if a cluster job is running, no cache exists, or the window was closed
2. Queries fresh tab data via `chrome.tabs.query()` — bypasses any drift in stored Tab objects
3. Enriches tabs with taxonomy signals, runs full `RUN_EMBEDDINGS` (with `sendMessageWithTimeout`) through the offscreen using the current `threshold` and `useAi` values
4. Calls `isProposalMeaningfullyDifferent(currentCache, proposal)`:
   - More named clusters in the proposal, **or**
   - Ungrouped has shrunk by 2+ tabs, **or**
   - >20% of named tabs shifted to a different cluster (catches quality improvements with same count)
5. If `showProposals` is enabled (default true): writes `clusterProposal_${windowId}` → triggers `storage.onChanged` → popup/sidepanel shows `ProposalBanner`
6. If proposals are disabled or the result isn't meaningfully different: silently discards the result

The alarm delay is set by `getReClusterInterval()` — reads `reClusterInterval` from storage (default 45 min). A value of `0` means the alarm is not created after Organize, disabling background re-clustering entirely.

`APPLY_PROPOSAL` replaces `clusterCache` with the proposal and re-arms the 45-minute alarm. `DISMISS_PROPOSAL` just removes the proposal key.

#### Debug logging

A `dbg(tag, ...args)` helper in `background.ts` emits structured console logs only in dev builds (`import.meta.env.DEV` is `false` in production). All logs are prefixed `[Lattice:<tag>]` so they can be filtered in the service worker console (`chrome://extensions/` → Inspect service worker).

| Tag | What it traces |
|---|---|
| `[Lattice:smartPlace]` | Tab domain, which guard triggered (no named clusters / no centroids / offscreen cold / embedding failed), best cluster label + similarity score vs threshold, or fallback reason |
| `[Lattice:onCreated]` | Tab ID, domain, real URL vs blank, action taken |
| `[Lattice:onUpdated]` | Tab ID, old domain → new domain, same/cross-domain decision, cluster updated or smartPlace triggered |
| `[Lattice:cluster]` | Named cluster count after Organize, alarm delay |
| `[Lattice:bgCluster]` | Start with tab count, skip reasons (job running / no cache / window closed / < 2 tabs), current vs proposed named counts, whether proposal was saved |
| `[Lattice:alarm]` | Which windowId the `reCluster_` alarm fired for |
| `[Lattice:proposal]` | Applied or dismissed |
| `[Lattice:startup]` | Count of stale storage keys cleared on Chrome restart |

#### `GET_DIAGNOSTICS`

Returns a snapshot of all per-window storage and offscreen state in a single response. Used by the settings debug panel but can also be sent from DevTools:

```ts
chrome.runtime.sendMessage({ action: 'GET_DIAGNOSTICS' }, console.log)
```

Response shape per window:
```ts
{
  windowId: number
  cache: {
    clusterCount: number       // total clusters including Ungrouped
    namedClusterCount: number  // clusters that aren't 'Ungrouped'
    ungroupedCount: number     // tabs in the Ungrouped bucket
    totalTabCount: number
    hasCentroids: boolean      // false means smartPlace will fall back to Ungrouped
    labels: string[]
  } | null
  job: { status: 'running' | 'done' | 'error'; error?: string } | null
  hasProposal: boolean
  proposalAt: number | null    // Date.now() timestamp
  alarm: { scheduledTime: number } | null
}
```

#### Cache lifecycle

```ts
// First install — open the welcome/onboarding page
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome/index.html') })
    }
})

// Chrome restart — tab IDs reset, mark all caches stale (preserve labels/centroids for session restore)
chrome.runtime.onStartup.addListener(async () => {
    // Marks clusterCache_* as { ...cache, stale: true, groupIds: undefined }
    // groupIds stripped because Chrome tab group IDs are session-local and don't survive restart
    // Removes clusterJob_* and clusterProposal_* (always invalid after restart)
})

// Tab group deleted by user in Chrome tab bar — clear its stale groupId from cache
chrome.tabGroups.onRemoved.addListener(async (group) => {
    // Scans all clusterCache_* keys, sets groupIds[idx] = null where groupIds[idx] === group.id
})

// Window closed — remove per-window keys and cancel the alarm
chrome.windows.onRemoved.addListener(async (windowId) => {
    chrome.storage.local.remove([`clusterCache_${windowId}`, `clusterJob_${windowId}`, `clusterProposal_${windowId}`])
    chrome.alarms.clear(`reCluster_${windowId}`)
})
```

**Session restore** (lazy, runs on first `GET_TABS` after Chrome restart):
1. `onStartup` marks caches stale with `stale: true`, strips `groupIds`
2. On next `GET_TABS`, background scans all stale caches, finds best URL overlap with current window's tabs, remaps tab IDs by URL match
3. `reconcileTabs()` catches any new tabs opened before the user first opened the extension
4. `reconcileGroupIds()` re-associates with any Chrome tab groups that survived the restart
5. Stale keys removed from storage

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

`generateLabels` takes a `useAi` flag (passed from background via `RUN_EMBEDDINGS`) and applies a defensive guard chain before touching the Prompt API:

```ts
async function generateLabels(
    clusters: EnrichedTab[][], clusterIndices: number[][],
    embedder: any, tabs: EnrichedTabs, vectors: number[][],
    useAi: boolean
): Promise<string[]>
```

Guard chain (falls back to KeyBERT for all clusters at the first failure):
1. `!useAi` — user selected keyword labels in Settings
2. `typeof LanguageModel === 'undefined'` — Prompt API not available in this Chrome build
3. `await LanguageModel.availability() !== 'available'` — model is downloading, not installed, or disabled in Chrome settings. Calling `create()` in any non-`'available'` state causes it to block indefinitely.
4. `await LanguageModel.create()` throws — availability check passed but create still failed

When all guards pass, `session.prompt()` is called per cluster with a fallback to KeyBERT for that individual cluster if the prompt throws. `session.destroy()` is called after all labels are generated.

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

Both are nearly identical — the popup additionally has an "Open in side panel" button and calls `window.close()` on tab click. Neither wraps its content in a GeminiGate (deleted); both render a plain `<div className="popup">` / `<div className="panel">` directly.

#### State

```ts
const [tabs, setTabs]               = useState<Tab[][]>([])
const [labels, setLabels]           = useState<string[]>([])
const [chromeGroups, setChromeGroups] = useState<ChromeGroupInfo[]>([])
const [loading, setLoading]         = useState(true)
const [clustering, setClustering]   = useState(false)
const [clusterError, setClusterError] = useState<string | null>(null)  // shown as dismissible error strip
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

  // Stuck-job detection: if job.startedAt > 5 minutes ago, reset to error
  if (job?.status === 'running') {
    if (startedAt && Date.now() - startedAt > 5 * 60 * 1000) {
      // resets job to error, shows error strip
    } else { setClustering(true) }
  } else if (job?.status === 'error') { setClusterError(job.error) }

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

#### Chrome Tab Group Integration ("Pin to Chrome")

Lattice's clusters are the organizing unit. Chrome tab groups are an optional visual representation — "pinning" pushes a cluster into Chrome's tab bar. Framed as "Pin to Chrome" / "Unpin" to clarify it is a publish action, not a management action.

`computeGroupInfo` queries Chrome directly for the UI's visual state (colored dots, Pin/Unpin buttons):
```ts
async function computeGroupInfo(clusters: Tab[][], windowId: number): Promise<ChromeGroupInfo[]>
// Returns { groupId, color } for clusters where all tabs share one groupId, null otherwise
```
Called after mount, after clustering, and after any group/ungroup action. Read-only.

`cache.groupIds` is the background's functional state — drives smartPlace and drag-and-drop adding tabs to Chrome groups. It is rebuilt by `reconcileGroupIds()` on every popup open to stay in sync with Chrome's current state.

**groupId lifetime:**
- `CREATE_TAB_GROUP` → persists returned groupId to `cache.groupIds[clusterIdx]`
- `UNGROUP_TABS` → clears `cache.groupIds[clusterIdx] = null`
- `RENAME_CLUSTER` → calls `chrome.tabGroups.update(groupId, { title: newLabel })`
- `chrome.tabGroups.onRemoved` → proactively clears stale groupIds across all caches
- `onStartup` → strips `groupIds` entirely (Chrome group IDs are session-local integers, not portable across restarts)
- Any `chrome.tabs.group()` call that throws → clears the stale groupId in the catch block

---

### 4. Shared Components

#### `src/components/GeminiGate.tsx` — DELETED

GeminiGate was a wrapper component that checked Gemini Nano availability and asked users to opt in before using the extension. It was removed because:
- Chrome 138+ auto-downloads Gemini Nano independently for its own features (scam detection), making explicit opt-in unnecessary
- AI labeling now defaults to on and falls back silently — no user choice is required at startup
- The gate was the source of the "stuck in Organizing" bug (offscreen couldn't short-circuit to KeyBERT while Chrome was mid-download)

Popup and sidepanel now render a plain `<div>` root instead. Availability is checked lazily in offscreen.ts before `LanguageModel.create()`.

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
  onUngroupCluster?: (tabs: Tab[], groupId: number, clusterIdx: number) => void
  onMoveTab?: (tabId: number, fromIdx: number, toIdx: number) => void
  onRenameCluster?: (clusterIdx: number, newLabel: string) => void
}
```

**Card coloring** — when a `ChromeGroupInfo` entry exists for a cluster, the card background and border are tinted with the Chrome group's color (8-digit hex alpha):
```ts
style={{ backgroundColor: dotColor + '55', borderColor: dotColor + '80' }}
```

**Cluster header** — shows the AI-generated label, an optional colored dot for existing Chrome groups, and a "Pin to Chrome"/"Unpin" button. The Ungrouped bucket never shows a Pin button.

**Inline rename** — clicking any named cluster label (non-Ungrouped) opens an inline input pre-filled with the current name. Enter commits (with duplicate-name validation), Escape cancels, blur quietly reverts on duplicates. Saving also updates the Chrome tab group title via `RENAME_CLUSTER`.

**Drag-and-drop tab movement** — tabs are `draggable` when `onMoveTab` is provided and there are 2+ clusters. Dragging a tab over another cluster highlights it with a teal ring; dropping fires `onMoveTab` → `MOVE_TAB` in the background. If the destination cluster is pinned to Chrome, the tab is automatically added to its Chrome group.

**Auto-scroll during drag** — a `useEffect` activated only while `draggingTabId !== null` listens to `document.dragover` events and drives `requestAnimationFrame`-based scrolling when the cursor is within 100px of the viewport top or bottom. Speed scales proportionally with proximity to the edge (max 12px/frame). Cleans up immediately on drop or cancel.

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

**Dismiss (✕)** — sends `DISMISS_PROPOSAL` to remove the proposal key from storage. Neither action modifies Chrome Tab Groups — the user manages those manually via the "Pin to Chrome"/"Unpin" buttons.

---

### 6. Taxonomy Engine

**Files:** [`src/lib/taxonomyEngine.ts`](src/lib/taxonomyEngine.ts), [`src/lib/taxonomy.types.ts`](src/lib/taxonomy.types.ts)

Loads `public/taxonomy.json` (~100 sites) and provides O(1) URL classification used to enrich tabs before embedding.

---

### 7. Clustering Library

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

### 7. Welcome / Onboarding Page

**Files:** `src/welcome/` (index.html, main.tsx, App.tsx, App.css, index.css)

A standalone page opened automatically on first extension install via `chrome.runtime.onInstalled` (`reason === 'install'`). Shows the extension logo, a tagline, a step-by-step visual guide for pinning the extension to the Chrome toolbar, and a "Got it — let's go" button that calls `window.close()`.

Built as a separate Rollup entry in `vite.config.ts` (`rollupOptions.input.welcome`). Shares the same design system (Fredoka, Quicksand, `#FFFEF5` background) as the settings page.

---

### 8. Settings Page

**Files:** `src/settings/`

Registered as `options_page` in the manifest. Opens via `chrome.runtime.openOptionsPage()` from the popup/sidepanel settings icon.

#### Clustering section

Five controls, each wired directly to `chrome.storage.local` with no debounce (writes on interaction):

**`PresetSetting`** — segmented button group for numeric options. Used for:
- **Cluster sensitivity** (`clusteringThreshold`): Lower (0.35) / Default (0.65) / Higher (0.95). More groups at lower values, fewer at higher. Read by `getThreshold()` before each `RUN_EMBEDDINGS` call.
- **Re-cluster interval** (`reClusterInterval`): Off (0) / 30 min / 45 min (default) / 90 min. `0` disables background re-clustering. Read by `getReClusterInterval()` after each successful cluster.

**`ToggleSetting`** — sliding toggle for boolean flags. Used for:
- **Smart placement** (`smartPlacement`): auto-sort new and navigated tabs into existing groups. Checked by `onCreated`/`onUpdated` via `getSettingBool('smartPlacement', true)`.
- **Grouping proposals** (`showProposals`): show `ProposalBanner` when background re-cluster finds a better grouping. Checked by `runBackgroundReCluster` via `getSettingBool('showProposals', true)`.

**`AiLabelingToggle`** — segmented button group that reads/writes `geminiChoice` (`'ai'` | `'skip'`). Defaults to `'ai'` if the key is not set. "AI labeling" uses Gemini Nano; "Keyword labels" uses KeyBERT for all clusters.

#### Debug / Diagnostics section

`DiagnosticsPanel` calls `GET_DIAGNOSTICS` on mount and renders the response. Useful for diagnosing smart placement failures without opening DevTools.

**What it shows:**
- **Offscreen status** — warm (smart placement active) or cold (falling back to Ungrouped). The most common reason smart placement stops working is the offscreen document being closed by Chrome after inactivity.
- **Per-window cards** — named cluster count, ungrouped tab count, total tab count, centroid presence (`hasCentroids: false` means smartPlace will always Ungrouped), job status with error text, pending proposal timestamp, re-cluster alarm countdown in minutes.
- **Labels** — pill tags for every cluster label so you can see the current grouping at a glance. Ungrouped is visually dimmed.
- **Refresh button** — re-fetches diagnostics from the background.
- **Clear all storage & alarms** — removes all `clusterCache_*`, `clusterJob_*`, `clusterProposal_*` keys and cancels all `reCluster_*` alarms. Equivalent to a clean-slate reset without reinstalling the extension.

**Hot-reload note:** The options page opens as a regular Chrome tab. Unlike the popup/sidepanel, CRXJS HMR does not reach it. After changing settings page code, reload the extension at `chrome://extensions/` then close and reopen the settings tab (or press Cmd+R/F5 in it).

---

## Storage Architecture

All persistent state lives in `chrome.storage.local` (survives browser restarts and system sleep).

| Key pattern | Type | Written by | Read by |
|---|---|---|---|
| `clusterCache_${windowId}` | `ClusterCache` | background (clustering + tab events + reconciliation) | background (GET_TABS), popup/sidepanel (onChanged) |
| `clusterJob_${windowId}` | `ClusterJob` | background | popup/sidepanel (init + onChanged) |
| `clusterProposal_${windowId}` | `ClusterProposal` | background (alarm-triggered re-cluster) | popup/sidepanel (init + onChanged → ProposalBanner) |
| `clusteringThreshold` | `number` | settings page (`PresetSetting`) | background (`getThreshold()`) |
| `reClusterInterval` | `number` (minutes; 0 = off) | settings page (`PresetSetting`) | background (`getReClusterInterval()`) |
| `smartPlacement` | `boolean` | settings page (`ToggleSetting`) | background (`getSettingBool('smartPlacement', true)`) |
| `showProposals` | `boolean` | settings page (`ToggleSetting`) | background (`getSettingBool('showProposals', true)`) |
| `geminiChoice` | `'ai' \| 'skip'` | settings page (`AiLabelingToggle`) | background (`getUseAi()`) — `undefined` treated as `'ai'` |

**Cache invalidation:**
- Tab events trigger surgical cache updates. New tabs use `smartPlace` (embed + centroid comparison) if named clusters exist and the offscreen is warm, otherwise fall back to Ungrouped. Same-domain navigations update tab data in place. Cross-domain navigations re-embed and re-place.
- On every popup/sidepanel open, `reconcileTabs()` removes ghost tabs, refreshes metadata, and adds untracked tabs to Ungrouped — recovering from service-worker dormancy gaps.
- `onStartup` marks `clusterCache_*` entries stale (preserving structure) and removes `clusterJob_*` and `clusterProposal_*` — Chrome restart resets tab IDs. Lazy URL-based remapping runs on the first `GET_TABS` call.
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
| `tabGroups` | `chrome.tabs.group()`, `chrome.tabGroups.update/query/onRemoved` |
| `alarms` | `chrome.alarms.create/clear/onAlarm` — background re-cluster scheduling |

---

## How the Files Connect

```
manifest.config.ts
      │
      ▼
CRXJS Vite Plugin
      ├─► src/popup/index.html
      │         └── App.tsx → ProposalBanner → TabList
      ├─► src/sidepanel/index.html
      │         └── App.tsx → ProposalBanner → TabList
      ├─► src/settings/index.html → App.tsx
      └─► src/background/background.ts
                ├── @/lib/taxonomyEngine.ts
                ├── @/lib/clustering.ts  (THRESHOLD, cosineSimilarity)
                └── @/types.ts

vite.config.ts (rollupOptions.input)
      ├─► src/offscreen/offscreen.html
      │         └── offscreen.ts
      │               ├── @/lib/clustering.ts  (agglomerativeCluster, computeCentroid, …)
      │               ├── @huggingface/transformers (pipeline)
      │               └── LanguageModel (Gemini Nano, browser global)
      └─► src/welcome/index.html          ← opened on first install via onInstalled
                └── App.tsx

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

**`LanguageModel.create()` hangs — never call it without checking `availability()` first.** When the model is in any state other than `'available'` (`'downloading'`, `'downloadable'`, `'no'`), calling `create()` does not throw — it simply blocks indefinitely. `try/catch` alone is not sufficient. Always call `availability()` first, and only call `create()` when the result is exactly `'available'`.

**Chrome auto-downloads Gemini Nano independently of the extension.** Since Chrome 138+, Chrome downloads Gemini Nano in the background for its own features (e.g., scam detection). Calling `LanguageModel.availability()` from the extension can also trigger this download as a side effect. This is why the `'downloading'` state must be handled explicitly — even if the user has never interacted with AI features in the extension.

**Chrome bug: `downloadprogress` resets to 0% when `create()` is called mid-download.** If `LanguageModel.create()` is called while Chrome is already downloading the model, the `downloadprogress` event fires with `e.loaded === 0` repeatedly rather than progressing. Avoid calling `create()` during `'downloading'` state — poll `availability()` instead.

**`e.loaded` in `downloadprogress` is a decimal (0–1).** Multiply by 100 for percentage — there is no `e.total` property.

**Don't pass class instances through `sendMessage`.** The structured clone algorithm strips methods. Pass plain JSON — `TaxonomyEngine` stays in the background and the offscreen only receives plain `EnrichedTab[]`.

**Centroid similarity vs. dot product.** Tab vectors from the embedding pipeline are unit-length (`normalize: true`). Cluster centroids are the mean of unit vectors and may have magnitude < 1. Use the full cosine formula (`dot / |centroid|`) for centroid comparisons rather than the raw dot product, otherwise similarity scores are systematically underestimated and the placement threshold behaves too strictly.

**Smart placement requires warm offscreen.** `smartPlace` checks `isOffscreenAvailable()` (read-only, no model load) and silently falls back to Ungrouped if the offscreen document isn't running. This avoids a 2–3 second cold-start on every tab open when the user hasn't used the extension recently.

**Background re-cluster won't overwrite a running job.** `runBackgroundReCluster` guards against `clusterJob_${windowId}.status === 'running'` to avoid a race with a manual Organize triggered at the same time.

**Options page doesn't hot-reload.** CRXJS HMR keeps the popup and sidepanel live, but the options/settings page opens as a plain Chrome tab. After editing settings page code, reload the extension at `chrome://extensions/` and close+reopen the settings tab (or press Cmd+R in it).

**`dbg()` logs are dev-only.** The structured `[Lattice:*]` logs in `background.ts` only emit when `import.meta.env.DEV` is true. In a production build (`npm run build`) they compile away entirely. To read them during development, open the service worker inspector via `chrome://extensions/` → Inspect service worker.

**`@/` alias** maps to `src/`. Must be configured in both `tsconfig.app.json` (paths) and `vite.config.ts` (resolve.alias).

**Offscreen documents cannot access `chrome.storage`.** Only a limited subset of Chrome APIs is available in offscreen documents — `chrome.storage` is not one of them. Always read storage in `background.ts` and pass values as message payload fields. This is why `threshold` is passed in `RUN_EMBEDDINGS` rather than read inside `offscreen.ts`.

**Chrome tab group IDs are session-local integers, not names.** A group named "React Development" might be ID `5` before a Chrome restart and ID `17` after. Never persist group IDs across restarts. `onStartup` strips `groupIds` from caches; `reconcileGroupIds()` re-associates by tab membership on the next open.

**Service workers are ephemeral — expect missed tab events.** Chrome kills the MV3 service worker after ~30 seconds of inactivity. `chrome.tabs.onCreated/onUpdated/onRemoved` fire directly into the SW; if it's dormant, those events are lost. `reconcileTabs()` in `handleGetTabs` compensates by diffing the cache against Chrome's live tab state on every popup/sidepanel open.

**`groupIds` must stay parallel to `clusters`.** Every operation that rebuilds the `pairs` array (MOVE_TAB, onUpdated cross-domain, onRemoved, APPLY_PROPOSAL) must include `groupId: cache.groupIds?.[i] ?? null` in the map and write back `cache.groupIds = pairs.map(p => p.groupId)` after filtering. Missing this breaks Chrome group membership for smartPlace and drag-and-drop.

**HTML5 drag-and-drop auto-scroll zone is tiny by default.** The native browser scroll zone is only a few pixels at the edge. TabList implements custom RAF-based auto-scroll: `document.addEventListener('dragover')` tracks cursor Y, and a running `requestAnimationFrame` loop scrolls the nearest scrollable ancestor when the cursor is within 100px of the viewport edge.
