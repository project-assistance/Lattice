import { Tab, Tabs, EnrichedTabs, ClusterCache, ClusterJob, ClusterProposal } from '@/types';
import { TaxonomyEngine } from '@/lib/taxonomyEngine';
import { THRESHOLD } from '@/lib/clustering';

async function getThreshold(): Promise<number> {
    const result = await chrome.storage.local.get('clusteringThreshold');
    return (result['clusteringThreshold'] as number | undefined) ?? THRESHOLD;
}

async function getReClusterInterval(): Promise<number> {
    const result = await chrome.storage.local.get('reClusterInterval');
    return (result['reClusterInterval'] as number | undefined) ?? RECLUSTER_ALARM_DELAY_MINUTES;
}

async function getSettingBool(key: string, defaultValue: boolean): Promise<boolean> {
    const result = await chrome.storage.local.get(key);
    return (result[key] as boolean | undefined) ?? defaultValue;
}

async function getUseAi(): Promise<boolean> {
    const result = await chrome.storage.local.get('geminiChoice');
    // Default to AI — only skip if user explicitly chose 'skip' in Settings
    return (result['geminiChoice'] as string | undefined) !== 'skip';
}

// Wraps chrome.runtime.sendMessage in a promise that rejects after timeoutMs.
// Without this, a hanging offscreen response (e.g. LanguageModel.create() blocked
// by a Chrome mid-download) leaves the job stuck at 'running' indefinitely.
function sendMessageWithTimeout(msg: object, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`Organizing is taking too long. Please try again.`)),
            timeoutMs
        );
        chrome.runtime.sendMessage(msg, (response) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(response);
            }
        });
    });
}

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const RECLUSTER_ALARM_DELAY_MINUTES = 45;

// Structured debug logging — only emits in dev builds.
// Filter by tag in the service worker console: [Lattice:smartPlace], [Lattice:onUpdated], etc.
function dbg(tag: string, ...args: any[]) {
    if (!import.meta.env.DEV) return;
    console.log(`[Lattice:${tag}]`, ...args);
}

// Guards against concurrent createDocument calls — if two callers race,
// the second awaits the same promise instead of trying to create a second document.
let creating: Promise<void> | null = null;

// Tracks whether the offscreen module script has finished loading and registered
// its message listener. createDocument() resolves after the HTML loads, but
// <script type="module"> is deferred, so the listener isn't guaranteed to exist yet.
let offscreenReady = false;
let readyResolvers: (() => void)[] = [];

let taxonomyPromise: Promise<TaxonomyEngine> | null = null;

async function getTaxonomy() {
  if (!taxonomyPromise) {
    taxonomyPromise = (async () => {
      const data = await fetch(chrome.runtime.getURL('taxonomy.json'));
      return new TaxonomyEngine(await data.json());
    })();
  }
  return taxonomyPromise;
}

// Parks the caller until OFFSCREEN_READY is received. Supports multiple concurrent
// waiters via the resolver array — all resolve at once when the signal arrives.
function waitForOffscreenReady() {
    if (offscreenReady) return Promise.resolve();
    return new Promise<void>(resolve => readyResolvers.push(resolve));
}

// Returns true if the document was just created (listener not yet registered),
// false if it already existed (listener already registered, no wait needed).
async function ensureOffscreenDocument(): Promise<boolean> {
    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
    const existing = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
        documentUrls: [offscreenUrl],
    });
    if (existing.length > 0) return false;

    if (creating) {
        await creating;
    } else {
        creating = chrome.offscreen.createDocument({
            url: OFFSCREEN_PATH,
            reasons: [chrome.offscreen.Reason.WORKERS],
            justification: 'Run transformers.js ML embeddings',
        });
        await creating;
        creating = null;
    }
    return true;
}

// Read-only check — does not create the document.
async function isOffscreenAvailable(): Promise<boolean> {
    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
    const existing = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
        documentUrls: [offscreenUrl],
    });
    return existing.length > 0;
}

// Cosine similarity between a unit-length tab vector and a non-unit centroid.
// The tab vector is always unit-length (pipeline normalize: true). The centroid
// is the mean of unit vectors so its magnitude is ≤ 1 — we divide by it to get
// true cosine similarity rather than a scaled dot product.
function centroidSim(tabVec: number[], centroid: number[]): number {
    let dot = 0;
    let centMagSq = 0;
    for (let i = 0; i < tabVec.length; i++) {
        dot += tabVec[i] * centroid[i];
        centMagSq += centroid[i] * centroid[i];
    }
    const centMag = Math.sqrt(centMagSq);
    return centMag === 0 ? 0 : dot / centMag;
}

async function embedSingleTab(tab: Tab): Promise<number[] | null> {
    const taxonomy = await getTaxonomy();
    const enriched = {
        ...tab,
        signal: taxonomy.lookup(tab.url)?.signal ?? null,
        category: taxonomy.lookup(tab.url)?.category ?? null,
    };
    return new Promise(resolve => {
        chrome.runtime.sendMessage(
            { action: 'EMBED_SINGLE_TAB', tab: enriched },
            (response) => {
                resolve(response?.status === 'success' ? response.vector : null);
            }
        );
    });
}

// Embeds a single tab and places it in the nearest cluster if it clears the
// similarity threshold; otherwise falls back to Ungrouped. Silently falls back
// when no named clusters exist (e.g. after a crash restore) or the offscreen
// document isn't warm (no model cold-start on every tab open).
async function smartPlace(cache: ClusterCache, tab: Tab): Promise<void> {
    const domain = getDomain(tab.url);
    const hasNamedClusters = cache.labels.some(l => l !== 'Ungrouped');

    if (!hasNamedClusters) {
        dbg('smartPlace', `${domain} → Ungrouped (no named clusters)`);
        addToUngrouped(cache, tab);
        return;
    }
    if (!cache.centroids?.length) {
        dbg('smartPlace', `${domain} → Ungrouped (no centroids in cache)`);
        addToUngrouped(cache, tab);
        return;
    }

    const offscreen = await isOffscreenAvailable();
    if (!offscreen) {
        dbg('smartPlace', `${domain} → Ungrouped (offscreen cold)`);
        addToUngrouped(cache, tab);
        return;
    }

    const vector = await embedSingleTab(tab);
    if (!vector) {
        dbg('smartPlace', `${domain} → Ungrouped (embedding failed)`);
        addToUngrouped(cache, tab);
        return;
    }

    const simThreshold = 1 - THRESHOLD;
    let bestIdx = -1;
    let bestSim = -Infinity;
    for (let i = 0; i < cache.centroids.length; i++) {
        if (cache.labels[i] === 'Ungrouped') continue;
        if (!cache.centroids[i]?.length) continue;
        const sim = centroidSim(vector, cache.centroids[i]);
        if (sim > bestSim) { bestSim = sim; bestIdx = i; }
    }

    if (bestIdx !== -1 && bestSim >= simThreshold) {
        const clusterLabel = cache.labels[bestIdx];
        dbg('smartPlace', `${domain} → "${clusterLabel}" (sim: ${bestSim.toFixed(3)}, threshold: ${simThreshold.toFixed(3)})`);
        cache.clusters[bestIdx].push(tab);
        // Running-average centroid update: keeps the centroid representative
        // as new tabs arrive without requiring access to all stored vectors.
        const count = cache.clusters[bestIdx].length;
        cache.centroids[bestIdx] = cache.centroids[bestIdx].map(
            (v, i) => (v * (count - 1) + vector[i]) / count
        );
    } else {
        const reason = bestIdx === -1
            ? 'no named centroids'
            : `best sim ${bestSim.toFixed(3)} < threshold ${simThreshold.toFixed(3)}`;
        dbg('smartPlace', `${domain} → Ungrouped (${reason})`);
        addToUngrouped(cache, tab);
    }
}

const getTabTitles = async (windowId: number): Promise<Tabs> => {
    const tabs = await chrome.tabs.query({ windowId });
    return tabs.map(tab => {
        return { title: tab.title, url: tab.url , id: tab.id!, windowId: tab.windowId, index: tab.index, active: tab.active, pinned: tab.pinned, discarded: tab.discarded, favIconUrl: tab.favIconUrl };
    }) as Tabs;
}

// Reconciles the cached tab list against Chrome's live state to recover from service-worker
// dormancy gaps. Handles three cases:
//   - Ghost tabs: in cache but no longer in Chrome → removed
//   - Metadata drift: title/favicon/active changed while SW was dormant → updated in place
//   - Unknown tabs: open in Chrome but not tracked → added to Ungrouped
// URL-changed tabs (cross-domain navigation while dormant) are left in their current cluster
// with updated metadata; the user can re-run Organize or drag to re-place them.
async function reconcileTabs(cache: ClusterCache, windowId: number): Promise<{ cache: ClusterCache; changed: boolean }> {
    const chromeTabs = await chrome.tabs.query({ windowId });
    const chromeTabMap = new Map(chromeTabs.map(t => [t.id!, t]));
    const chromeTabIds = new Set(chromeTabMap.keys());
    const cachedTabIds = new Set(cache.clusters.flat().map(t => t.id));
    let changed = false;

    // 1. Remove ghost tabs
    const ghostIds = new Set([...cachedTabIds].filter(id => !chromeTabIds.has(id)));
    if (ghostIds.size > 0) {
        changed = true;
        const pairs = cache.clusters
            .map((c, i) => ({
                cluster: c.filter(t => !ghostIds.has(t.id)),
                label: cache.labels[i],
                centroid: cache.centroids?.[i],
                groupId: cache.groupIds?.[i] ?? null,
            }))
            .filter(p => p.cluster.length > 0);
        cache.clusters = pairs.map(p => p.cluster);
        cache.labels = pairs.map(p => p.label);
        if (cache.centroids) cache.centroids = pairs.map(p => p.centroid ?? []);
        if (cache.groupIds) cache.groupIds = pairs.map(p => p.groupId);
    }

    // 2. Update metadata for tracked tabs (title, favicon, active state)
    cache.clusters = cache.clusters.map(cluster =>
        cluster.map(t => {
            const live = chromeTabMap.get(t.id);
            if (!live) return t;
            const mapped = mapChromeTab(live);
            if (mapped.title !== t.title || mapped.favIconUrl !== t.favIconUrl || mapped.active !== t.active || mapped.url !== t.url) {
                changed = true;
                return mapped;
            }
            return t;
        })
    );

    // 3. Add untracked Chrome tabs to Ungrouped
    for (const id of chromeTabIds) {
        if (cachedTabIds.has(id)) continue;
        const live = chromeTabMap.get(id)!;
        const mapped = mapChromeTab(live);
        if (!mapped.url || mapped.url.startsWith('chrome://') || mapped.url.startsWith('about:')) continue;
        addToUngrouped(cache, mapped);
        changed = true;
    }

    return { cache, changed };
}

// Rebuilds groupIds by checking which Chrome group each cluster's tabs currently belong to.
// Matches by tab membership (not stored ID), so it works correctly after Chrome restarts
// where group IDs are reassigned. A cluster gets a groupId only if every one of its tabs
// that exists in Chrome is in the same group.
async function reconcileGroupIds(clusters: Tab[][], windowId: number): Promise<(number | null)[]> {
    const [chromeTabs, chromeGroups] = await Promise.all([
        chrome.tabs.query({ windowId }),
        chrome.tabGroups.query({ windowId }),
    ]);
    const tabToGroupId = new Map(chromeTabs.map(t => [t.id!, t.groupId]));
    const validGroupIds = new Set(chromeGroups.map(g => g.id));

    return clusters.map(cluster => {
        const ids = [...new Set(
            cluster
                .map(t => tabToGroupId.get(t.id) ?? -1)
                .filter(id => id !== -1 && validGroupIds.has(id))
        )];
        return ids.length === 1 ? ids[0] : null;
    });
}

function groupIdsEqual(a: (number | null)[] | undefined, b: (number | null)[]): boolean {
    if (!a || a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
}

async function handleGetTabs(sendResponse: (response: any) => void, windowId: number) {
    const cacheKey = `clusterCache_${windowId}`;
    const result = await chrome.storage.local.get(cacheKey);
    const clusterCache = result[cacheKey] as ClusterCache | undefined;

    // Fresh (non-stale) cache: reconcile tabs and groupIds against Chrome's live state
    // to recover from service-worker dormancy gaps.
    if (clusterCache?.clusters && clusterCache?.labels && !clusterCache.stale) {
        const { cache: reconciledCache, changed: tabsChanged } = await reconcileTabs(clusterCache, windowId);
        const reconciledIds = await reconcileGroupIds(reconciledCache.clusters, windowId);
        if (tabsChanged || !groupIdsEqual(reconciledCache.groupIds, reconciledIds)) {
            reconciledCache.groupIds = reconciledIds;
            await chrome.storage.local.set({ [cacheKey]: reconciledCache });
        }
        sendResponse({ status: 'cache_success', tabs: reconciledCache.clusters, labels: reconciledCache.labels });
        return;
    }

    // No fresh cache: look for stale caches from a previous Chrome session and
    // try to remap their stored tab URLs to the current session's tab IDs.
    // This runs lazily (after the user opens the extension), so Chrome's session
    // restore is already complete and tabs are available.
    try {
        const all = await chrome.storage.local.get(null);
        const staleCaches = Object.entries(all)
            .filter(([k, v]) => k.startsWith('clusterCache_') && (v as ClusterCache).stale)
            .map(([k, v]) => ({ key: k, cache: v as ClusterCache }));

        if (staleCaches.length > 0) {
            const currentTabs = await chrome.tabs.query({ windowId });
            const urlToTab = new Map(currentTabs.map(t => [t.url!, mapChromeTab(t)]));

            let bestKey = '';
            let bestCache: ClusterCache | null = null;
            let bestOverlap = 0;

            for (const { key, cache } of staleCaches) {
                const storedUrls = cache.clusters.flat().map(t => t.url).filter(Boolean);
                const overlap = storedUrls.filter(u => urlToTab.has(u)).length;
                if (overlap > bestOverlap) { bestOverlap = overlap; bestCache = cache; bestKey = key; }
            }

            if (bestCache && bestOverlap > 0) {
                const remappedClusters = bestCache.clusters.map(cluster =>
                    cluster.map(t => urlToTab.get(t.url) ?? null).filter(Boolean) as Tab[]
                );
                const pairs = remappedClusters
                    .map((c, i) => ({ cluster: c, label: bestCache!.labels[i], centroid: bestCache!.centroids?.[i] }))
                    .filter(p => p.cluster.length > 0);

                // Build initial remapped cache, then reconcile tabs to catch any tabs
                // opened in the current session that the URL mapping didn't cover.
                let restoredCache: ClusterCache = {
                    clusters: pairs.map(p => p.cluster),
                    labels: pairs.map(p => p.label),
                    centroids: bestCache.centroids ? pairs.map(p => p.centroid).filter((c): c is number[] => !!c) : undefined,
                };
                const { cache: reconciledCache } = await reconcileTabs(restoredCache, windowId);
                reconciledCache.groupIds = await reconcileGroupIds(reconciledCache.clusters, windowId);

                await chrome.storage.local.set({ [cacheKey]: reconciledCache });
                await chrome.storage.local.remove(staleCaches.map(s => s.key).filter(k => k !== cacheKey));
                dbg('startup', `session restore for windowId:${windowId} — remapped ${bestOverlap} tabs from ${bestKey}`);

                sendResponse({ status: 'cache_success', tabs: reconciledCache.clusters, labels: reconciledCache.labels });
                return;
            }

            // No usable stale cache — clean up orphaned stale keys.
            await chrome.storage.local.remove(staleCaches.map(s => s.key));
        }
    } catch (err) {
        console.error('[Lattice:getTabs] session restore failed:', err);
    }

    try {
        const tabs = await getTabTitles(windowId);
        sendResponse({ status: 'success', tabs });
    } catch (error) {
        console.error('[Lattice:getTabs] failed:', error);
        sendResponse({ status: 'error', message: 'Failed to fetch tabs' });
    }
}

async function handleClusterTabs(sendResponse: (response: any) => void, windowId: number) {
    const jobKey = `clusterJob_${windowId}`;
    const cacheKey = `clusterCache_${windowId}`;
    await chrome.storage.local.set({ [jobKey]: { status: 'running', startedAt: Date.now() } as ClusterJob });
    try {
        const [tabs, taxonomy] = await Promise.all([getTabTitles(windowId), getTaxonomy()]);
        const justCreated = await ensureOffscreenDocument();
        if (justCreated) await waitForOffscreenReady();

        const enrichedTabs: EnrichedTabs = tabs.map(tab => ({
            ...tab,
            signal: taxonomy.lookup(tab.url)?.signal || null,
            category: taxonomy.lookup(tab.url)?.category || null,
        }));

        const [threshold, useAi] = await Promise.all([getThreshold(), getUseAi()]);

        let response: any;
        try {
            response = await sendMessageWithTimeout(
                { action: 'RUN_EMBEDDINGS', tabs: enrichedTabs, threshold, useAi },
                90_000
            );
        } catch (err: any) {
            const msg = err.message ?? 'Organizing timed out. Please try again.';
            dbg('cluster', `RUN_EMBEDDINGS timed out or disconnected: ${msg}`);
            chrome.storage.local.set({ [jobKey]: { status: 'error', error: msg } as ClusterJob });
            try { sendResponse({ status: 'error', message: msg }); } catch {}
            return;
        }

        if (response?.status === 'error') {
            console.error('[Lattice:cluster] RUN_EMBEDDINGS error:', response.message);
            chrome.storage.local.set({ [jobKey]: { status: 'error', error: response.message } as ClusterJob });
            try { sendResponse({ status: 'error', message: response.message }); } catch {}
        } else {
            const namedCount = (response?.labels as string[] ?? []).filter((l: string) => l !== 'Ungrouped').length;
            const interval = await getReClusterInterval();
            dbg('cluster', `done — ${namedCount} named clusters, alarm set for ${interval}min`);
            chrome.storage.local.set({
                [cacheKey]: {
                    clusters: response?.clusters,
                    labels: response?.labels,
                    centroids: response?.centroids,
                } as ClusterCache,
                [jobKey]: { status: 'done' } as ClusterJob,
            });
            chrome.storage.local.remove(`clusterProposal_${windowId}`);
            if (interval > 0) {
                chrome.alarms.create(`reCluster_${windowId}`, { delayInMinutes: interval });
            }
            try { sendResponse({ status: 'success', vector: response?.vector, clusters: response?.clusters, labels: response?.labels }); } catch {}
        }
    } catch (error: any) {
        console.error('[Lattice:cluster] handleClusterTabs failed:', error);
        chrome.storage.local.set({ [jobKey]: { status: 'error', error: error.message } as ClusterJob });
        try { sendResponse({ status: 'error', message: 'Failed to run embeddings' }); } catch {}
    }
}

// Returns true if the background re-cluster found a meaningfully better grouping.
// Criteria: more named clusters, Ungrouped shrank by 2+ tabs, or >20% of named
// tabs shifted to a different cluster (catches quality improvements with same count).
function isProposalMeaningfullyDifferent(current: ClusterCache, proposal: ClusterProposal): boolean {
    const currentNamed = current.labels.filter(l => l !== 'Ungrouped').length;
    const proposedNamed = proposal.labels.filter(l => l !== 'Ungrouped').length;
    if (proposedNamed > currentNamed) return true;

    const currentUngroupedCount = current.clusters[current.labels.indexOf('Ungrouped')]?.length ?? 0;
    const proposedUngroupedCount = proposal.clusters[proposal.labels.indexOf('Ungrouped')]?.length ?? 0;
    if (currentUngroupedCount - proposedUngroupedCount >= 2) return true;

    // Detect significant reshuffling: >20% of named tabs moved to a different cluster.
    if (currentNamed > 0 && proposedNamed > 0) {
        const currentTabCluster = new Map<number, number>();
        current.clusters.forEach((cluster, i) => {
            if (current.labels[i] !== 'Ungrouped') cluster.forEach(t => currentTabCluster.set(t.id, i));
        });
        let shifted = 0, total = 0;
        proposal.clusters.forEach((cluster, i) => {
            if (proposal.labels[i] !== 'Ungrouped') {
                cluster.forEach(t => {
                    if (currentTabCluster.has(t.id)) {
                        total++;
                        if (currentTabCluster.get(t.id) !== i) shifted++;
                    }
                });
            }
        });
        if (total > 0 && shifted / total > 0.2) return true;
    }

    return false;
}

// Runs a full re-cluster in the background using fresh tab data.
// Stores the result as a proposal if it's meaningfully better than the current cache.
async function runBackgroundReCluster(windowId: number) {
    // Don't run if a manual cluster job is in progress.
    const jobResult = await chrome.storage.local.get(`clusterJob_${windowId}`);
    if ((jobResult[`clusterJob_${windowId}`] as ClusterJob | undefined)?.status === 'running') {
        dbg('bgCluster', `windowId:${windowId} — skipped (job running)`);
        return;
    }

    const currentCache = await getCache(windowId);
    if (!currentCache) {
        dbg('bgCluster', `windowId:${windowId} — skipped (no cache)`);
        return;
    }

    // Bail if the window has been closed.
    try { await chrome.windows.get(windowId); } catch {
        dbg('bgCluster', `windowId:${windowId} — skipped (window closed)`);
        return;
    }

    try {
        const [tabs, taxonomy] = await Promise.all([getTabTitles(windowId), getTaxonomy()]);
        if (tabs.length < 2) {
            dbg('bgCluster', `windowId:${windowId} — skipped (< 2 tabs)`);
            return;
        }

        dbg('bgCluster', `windowId:${windowId} — starting (${tabs.length} tabs)`);

        const justCreated = await ensureOffscreenDocument();
        if (justCreated) await waitForOffscreenReady();

        const enrichedTabs: EnrichedTabs = tabs.map(tab => ({
            ...tab,
            signal: taxonomy.lookup(tab.url)?.signal || null,
            category: taxonomy.lookup(tab.url)?.category || null,
        }));

        const [threshold, useAi] = await Promise.all([getThreshold(), getUseAi()]);

        let response: any;
        try {
            response = await sendMessageWithTimeout(
                { action: 'RUN_EMBEDDINGS', tabs: enrichedTabs, threshold, useAi },
                90_000
            );
        } catch (err: any) {
            console.error('[Lattice:bgCluster] RUN_EMBEDDINGS timed out:', err.message);
            return;
        }

        if (response?.status !== 'success') {
            console.error('[Lattice:bgCluster] RUN_EMBEDDINGS failed:', response?.message);
            return;
        }

        const proposal: ClusterProposal = {
            clusters: response.clusters,
            labels: response.labels,
            centroids: response.centroids ?? [],
            proposedAt: Date.now(),
        };

        const different = isProposalMeaningfullyDifferent(currentCache, proposal);
        const currentNamed = currentCache.labels.filter(l => l !== 'Ungrouped').length;
        const proposedNamed = proposal.labels.filter(l => l !== 'Ungrouped').length;
        dbg('bgCluster', `windowId:${windowId} — ${currentNamed} named → ${proposedNamed} named, meaningful: ${different}`);

        if (!different) return;

        if (!await getSettingBool('showProposals', true)) {
            dbg('bgCluster', `windowId:${windowId} — proposals disabled, skipping`);
            return;
        }

        chrome.storage.local.set({ [`clusterProposal_${windowId}`]: proposal });
        dbg('bgCluster', `windowId:${windowId} — proposal saved`);
    } catch (error) {
        console.error('[Lattice:bgCluster] failed:', error);
    }
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm.name.startsWith('reCluster_')) return;
    const windowId = parseInt(alarm.name.replace('reCluster_', ''), 10);
    dbg('alarm', `reCluster fired for windowId:${windowId}`);
    runBackgroundReCluster(windowId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'GET_TABS') {
        handleGetTabs(sendResponse, message.windowId);
        return true;
    }

    if (message.action === 'CLUSTER_TABS') {
        handleClusterTabs(sendResponse, message.windowId);
        return true;
    }

    if (message.action === 'OFFSCREEN_READY') {
        offscreenReady = true;
        readyResolvers.forEach(r => r());
        readyResolvers = [];
    }

    if (message.action === 'LOAD_TAXONOMY') {
        getTaxonomy().then(taxonomy => {
            sendResponse({ status: 'success', version: taxonomy.version, aliases: taxonomy.aliases });
        }).catch(error => {
            console.error('[Lattice:taxonomy] load failed:', error);
            sendResponse({ status: 'error', message: 'Failed to load taxonomy' });
        });
        return true;
    }

    if (message.action === 'CREATE_TAB_GROUP') {
        (async () => {
            const { tabIds, title, colorIndex, clusterIdx, windowId } = message;
            const colors = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
            const color = colors[colorIndex % colors.length] as chrome.tabGroups.Color;
            try {
                const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
                await chrome.tabGroups.update(groupId, { title, color });
                // Persist the groupId so smartPlace and MOVE_TAB can add future tabs to this group
                if (clusterIdx != null) {
                    const cache = await getCache(windowId);
                    if (cache) {
                        if (!cache.groupIds) cache.groupIds = Array(cache.clusters.length).fill(null);
                        cache.groupIds[clusterIdx] = groupId;
                        await setCache(windowId, cache);
                    }
                }
                sendResponse({ status: 'success', groupId });
            } catch (err: any) {
                sendResponse({ status: 'error', message: err.message });
            }
        })();
        return true;
    }

    if (message.action === 'UNGROUP_TABS') {
        (async () => {
            const { tabIds, clusterIdx, windowId } = message;
            try {
                await chrome.tabs.ungroup(tabIds);
                if (clusterIdx != null && windowId != null) {
                    const cache = await getCache(windowId);
                    if (cache?.groupIds) {
                        cache.groupIds[clusterIdx] = null;
                        await setCache(windowId, cache);
                    }
                }
                sendResponse({ status: 'success' });
            } catch (err: any) {
                sendResponse({ status: 'error', message: err.message });
            }
        })();
        return true;
    }

    if (message.action === 'CLOSE_TAB') {
        chrome.tabs.remove(message.tabId, () => {
            if (chrome.runtime.lastError) {
                sendResponse({ status: 'error', message: chrome.runtime.lastError.message });
            } else {
                sendResponse({ status: 'success' });
            }
        });
        return true;
    }

    if (message.action === 'SET_ACTIVE_TAB') {
        const { tabId } = message;
        chrome.tabs.update(tabId, { active: true }, (tab) => {
            if (chrome.runtime.lastError) {
                console.error('[Lattice:setActiveTab] error:', chrome.runtime.lastError);
                sendResponse({ status: 'error', message: chrome.runtime.lastError.message });
            } else {
                sendResponse({ status: 'success', tab });
            }
        });
        return true;
    }

    if (message.action === 'APPLY_PROPOSAL') {
        (async () => {
            const { windowId } = message;
            const result = await chrome.storage.local.get(`clusterProposal_${windowId}`);
            const proposal = result[`clusterProposal_${windowId}`] as ClusterProposal | undefined;
            if (!proposal) { sendResponse({ status: 'error' }); return; }

            // Ungroup any Chrome tab groups for tabs Lattice currently tracks, so the
            // browser tab bar doesn't show stale groups after the new layout is applied.
            const currentCache = await getCache(windowId);
            if (currentCache) {
                const trackedIds = new Set(currentCache.clusters.flat().map(t => t.id));
                const chromeTabs = await chrome.tabs.query({ windowId });
                const groupedIds = chromeTabs
                    .filter(t => t.groupId !== -1 && trackedIds.has(t.id!))
                    .map(t => t.id!);
                if (groupedIds.length) {
                    try { chrome.tabs.ungroup(groupedIds as [number, ...number[]]); } catch {}
                }
            }

            await chrome.storage.local.set({
                [`clusterCache_${windowId}`]: {
                    clusters: proposal.clusters,
                    labels: proposal.labels,
                    centroids: proposal.centroids,
                } as ClusterCache,
            });
            await chrome.storage.local.remove(`clusterProposal_${windowId}`);
            const interval = await getReClusterInterval();
            if (interval > 0) {
                chrome.alarms.create(`reCluster_${windowId}`, { delayInMinutes: interval });
            }
            dbg('proposal', `windowId:${windowId} — applied`);
            sendResponse({ status: 'success' });
        })();
        return true;
    }

    if (message.action === 'MOVE_TAB') {
        (async () => {
            const { tabId, fromClusterIdx, toClusterIdx, windowId } = message;
            const cache = await getCache(windowId);
            if (!cache) { sendResponse({ status: 'error' }); return; }

            // Capture target groupId before pairs rebuild so indices stay valid
            const targetGroupId = cache.groupIds?.[toClusterIdx] ?? null;

            let movedTab: Tab | undefined;
            cache.clusters[fromClusterIdx] = cache.clusters[fromClusterIdx].filter(t => {
                if (t.id === tabId) { movedTab = t; return false; }
                return true;
            });

            if (movedTab && toClusterIdx < cache.clusters.length) {
                cache.clusters[toClusterIdx].push(movedTab);
            }

            // Drop empty named clusters; keep Ungrouped even if empty.
            const pairs = cache.clusters
                .map((c, i) => ({ cluster: c, label: cache.labels[i], centroid: cache.centroids?.[i], groupId: cache.groupIds?.[i] ?? null }))
                .filter(p => p.cluster.length > 0 || p.label === 'Ungrouped');
            cache.clusters = pairs.map(p => p.cluster);
            cache.labels = pairs.map(p => p.label);
            if (cache.centroids) cache.centroids = pairs.map(p => p.centroid ?? []);
            if (cache.groupIds) cache.groupIds = pairs.map(p => p.groupId);

            // Add tab to the destination Chrome group before saving so computeGroupInfo sees it
            if (movedTab && targetGroupId !== null && targetGroupId !== -1) {
                try {
                    await chrome.tabs.group({ tabIds: [movedTab.id], groupId: targetGroupId });
                } catch {
                    // Group was deleted mid-session — clear the dead reference in the rebuilt cache
                    const newToIdx = cache.clusters.findIndex(c => c.some(t => t.id === movedTab!.id));
                    if (newToIdx !== -1 && cache.groupIds) cache.groupIds[newToIdx] = null;
                }
            }

            await setCache(windowId, cache);
            sendResponse({ status: 'success' });
        })();
        return true;
    }

    if (message.action === 'RENAME_CLUSTER') {
        (async () => {
            const { clusterIdx, newLabel, windowId } = message;
            const cache = await getCache(windowId);
            if (!cache) { sendResponse({ status: 'error' }); return; }

            // Server-side duplicate guard (UI already checks, but be safe)
            const isDuplicate = cache.labels.some((l, i) => i !== clusterIdx && l !== 'Ungrouped' && l === newLabel);
            if (isDuplicate) { sendResponse({ status: 'error', message: 'Duplicate name' }); return; }

            cache.labels[clusterIdx] = newLabel;

            // Keep the Chrome tab group title in sync if this cluster has one
            const groupId = cache.groupIds?.[clusterIdx];
            if (groupId != null && groupId !== -1) {
                try { await chrome.tabGroups.update(groupId, { title: newLabel }); } catch {}
            }

            await setCache(windowId, cache);
            sendResponse({ status: 'success' });
        })();
        return true;
    }

    if (message.action === 'DISMISS_PROPOSAL') {
        chrome.storage.local.remove(`clusterProposal_${message.windowId}`);
        dbg('proposal', `windowId:${message.windowId} — dismissed`);
        sendResponse({ status: 'success' });
    }

    if (message.action === 'GET_DIAGNOSTICS') {
        (async () => {
            const [all, alarms, offscreenAvailable] = await Promise.all([
                chrome.storage.local.get(null),
                chrome.alarms.getAll(),
                isOffscreenAvailable(),
            ]);

            const cacheKeys = Object.keys(all).filter(k => k.startsWith('clusterCache_'));
            const windows = cacheKeys.map(key => {
                const windowId = parseInt(key.replace('clusterCache_', ''), 10);
                const cache = all[key] as ClusterCache | undefined;
                const job = all[`clusterJob_${windowId}`] as ClusterJob | undefined;
                const proposal = all[`clusterProposal_${windowId}`] as ClusterProposal | undefined;
                const alarm = alarms.find(a => a.name === `reCluster_${windowId}`);

                return {
                    windowId,
                    cache: cache ? {
                        clusterCount: cache.clusters.length,
                        namedClusterCount: cache.labels.filter(l => l !== 'Ungrouped').length,
                        ungroupedCount: cache.clusters[cache.labels.indexOf('Ungrouped')]?.length ?? 0,
                        totalTabCount: cache.clusters.flat().length,
                        hasCentroids: !!(cache.centroids?.length),
                        labels: cache.labels,
                    } : null,
                    job: job ?? null,
                    hasProposal: !!proposal,
                    proposalAt: proposal?.proposedAt ?? null,
                    alarm: alarm ? { scheduledTime: alarm.scheduledTime } : null,
                };
            });

            sendResponse({ status: 'success', offscreenAvailable, windows });
        })();
        return true;
    }
});

function mapChromeTab(tab: chrome.tabs.Tab): Tab {
    return {
        title: tab.title ?? '',
        url: tab.url ?? '',
        id: tab.id!,
        windowId: tab.windowId,
        index: tab.index,
        active: tab.active,
        pinned: tab.pinned,
        discarded: tab.discarded,
        favIconUrl: tab.favIconUrl,
    };
}

function addToUngrouped(cache: ClusterCache, tab: Tab): void {
    const idx = cache.labels.lastIndexOf('Ungrouped');
    if (idx !== -1) {
        cache.clusters[idx].push(tab);
    } else {
        cache.clusters.push([tab]);
        cache.labels.push('Ungrouped');
        if (cache.centroids) cache.centroids.push([]);
        if (cache.groupIds) cache.groupIds.push(null);
    }
}

async function getCache(windowId: number): Promise<ClusterCache | undefined> {
    const result = await chrome.storage.local.get(`clusterCache_${windowId}`);
    return result[`clusterCache_${windowId}`] as ClusterCache | undefined;
}

async function setCache(windowId: number, cache: ClusterCache): Promise<void> {
    await chrome.storage.local.set({ [`clusterCache_${windowId}`]: cache });
}

chrome.tabs.onCreated.addListener(async (tab) => {
    const cache = await getCache(tab.windowId);
    if (!cache) return;
    const mapped = mapChromeTab(tab);
    const isRealUrl = mapped.url && !mapped.url.startsWith('chrome://') && !mapped.url.startsWith('about:');
    if (isRealUrl) {
        if (await getSettingBool('smartPlacement', true)) {
            dbg('onCreated', `tab ${tab.id}: ${getDomain(mapped.url)} — real URL → smartPlace`);
            await smartPlace(cache, mapped);
        } else {
            dbg('onCreated', `tab ${tab.id}: ${getDomain(mapped.url)} — smart placement off → Ungrouped`);
            addToUngrouped(cache, mapped);
        }
    } else {
        dbg('onCreated', `tab ${tab.id}: (blank) → Ungrouped placeholder`);
        addToUngrouped(cache, mapped);
    }
    // If placed cluster has a Chrome group, add the tab before saving so computeGroupInfo sees it
    const placedIdx = cache.clusters.findIndex(c => c.some(t => t.id === mapped.id));
    const groupId = placedIdx !== -1 ? (cache.groupIds?.[placedIdx] ?? null) : null;
    if (groupId !== null && groupId !== -1) {
        try {
            await chrome.tabs.group({ tabIds: [mapped.id], groupId });
        } catch {
            // Group was deleted mid-session before onRemoved fired — clear the dead reference
            if (placedIdx !== -1 && cache.groupIds) cache.groupIds[placedIdx] = null;
        }
    }
    await setCache(tab.windowId, cache);
});

function getDomain(url: string): string {
    try { return new URL(url).hostname; } catch { return url || '(blank)'; }
}

chrome.tabs.onUpdated.addListener(async (_, changeInfo, tab) => {
    if (!changeInfo.url) return;
    const cache = await getCache(tab.windowId);
    if (!cache) return;

    let oldUrl = '';
    let clusterIdx = -1;
    for (let i = 0; i < cache.clusters.length; i++) {
        const found = cache.clusters[i].find(t => t.id === tab.id);
        if (found) { oldUrl = found.url; clusterIdx = i; break; }
    }

    const newTab = mapChromeTab(tab);
    const oldDomain = getDomain(oldUrl);
    const newDomain = getDomain(newTab.url);
    let needsGroupCheck = false;

    if (clusterIdx !== -1 && oldDomain === newDomain) {
        dbg('onUpdated', `tab ${tab.id}: ${oldDomain} → ${newDomain} (same domain) → update in place in "${cache.labels[clusterIdx]}"`);
        cache.clusters[clusterIdx] = cache.clusters[clusterIdx].map(t => t.id === tab.id ? newTab : t);
    } else {
        const reason = clusterIdx === -1 ? 'not in cache' : `${oldDomain} → ${newDomain} (cross-domain)`;
        dbg('onUpdated', `tab ${tab.id}: ${reason} → smartPlace`);
        cache.clusters = cache.clusters.map(cluster => cluster.filter(t => t.id !== tab.id));
        const pairs = cache.clusters
            .map((cluster, i) => ({ cluster, label: cache.labels[i], centroid: cache.centroids?.[i], groupId: cache.groupIds?.[i] ?? null }))
            .filter(({ cluster }) => cluster.length > 0);
        cache.clusters = pairs.map(p => p.cluster);
        cache.labels = pairs.map(p => p.label);
        if (cache.centroids) cache.centroids = pairs.map(p => p.centroid).filter((c): c is number[] => c !== undefined);
        if (cache.groupIds) cache.groupIds = pairs.map(p => p.groupId);
        if (await getSettingBool('smartPlacement', true)) {
            await smartPlace(cache, newTab);
        } else {
            addToUngrouped(cache, newTab);
        }
        needsGroupCheck = true;
    }

    if (needsGroupCheck) {
        const placedIdx = cache.clusters.findIndex(c => c.some(t => t.id === newTab.id));
        const groupId = placedIdx !== -1 ? (cache.groupIds?.[placedIdx] ?? null) : null;
        if (groupId !== null && groupId !== -1) {
            try {
                await chrome.tabs.group({ tabIds: [newTab.id], groupId });
            } catch {
                if (placedIdx !== -1 && cache.groupIds) cache.groupIds[placedIdx] = null;
            }
        }
    }

    await setCache(tab.windowId, cache);
});

chrome.tabs.onRemoved.addListener(async (tabId, info) => {
    const cache = await getCache(info.windowId);
    if (!cache) return;
    const pairs = cache.clusters
        .map((cluster, i) => ({
            cluster: cluster.filter(t => t.id !== tabId),
            label: cache.labels[i],
            centroid: cache.centroids?.[i],
            groupId: cache.groupIds?.[i] ?? null,
        }))
        .filter(({ cluster }) => cluster.length > 0);
    cache.clusters = pairs.map(p => p.cluster);
    cache.labels = pairs.map(p => p.label);
    if (cache.centroids) cache.centroids = pairs.map(p => p.centroid).filter((c): c is number[] => c !== undefined);
    if (cache.groupIds) cache.groupIds = pairs.map(p => p.groupId);
    await setCache(info.windowId, cache);
});

// Chrome restart: tab IDs are reassigned. Mark caches stale so GET_TABS can attempt
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome/index.html') });
    }
});

// URL-based remapping when the user next opens the extension (after session restore).
// Jobs and proposals are always invalid after restart and are deleted immediately.
chrome.runtime.onStartup.addListener(async () => {
    const all = await chrome.storage.local.get(null);
    const cacheKeys = Object.keys(all).filter(k => k.startsWith('clusterCache_'));
    const deadKeys = Object.keys(all).filter(k =>
        k.startsWith('clusterJob_') || k.startsWith('clusterProposal_')
    );

    if (cacheKeys.length) {
        const updates: Record<string, ClusterCache> = {};
        for (const key of cacheKeys) {
            const { groupIds: _drop, ...rest } = all[key] as ClusterCache;
            updates[key] = { ...rest, stale: true };
        }
        await chrome.storage.local.set(updates);
    }
    if (deadKeys.length) await chrome.storage.local.remove(deadKeys);
    dbg('startup', `marked ${cacheKeys.length} caches stale, removed ${deadKeys.length} dead keys`);
});

// Tab group deleted by the user mid-session: clear the stale groupId from any cache
// that references it so future smartPlace/MOVE_TAB calls don't try to join a dead group.
chrome.tabGroups.onRemoved.addListener(async (group) => {
    const all = await chrome.storage.local.get(null);
    const cacheKeys = Object.keys(all).filter(k => k.startsWith('clusterCache_'));
    for (const key of cacheKeys) {
        const cache = all[key] as ClusterCache;
        if (!cache.groupIds) continue;
        const idx = cache.groupIds.indexOf(group.id);
        if (idx === -1) continue;
        cache.groupIds[idx] = null;
        await chrome.storage.local.set({ [key]: cache });
        dbg('tabGroups', `removed group ${group.id} from ${key}[${idx}]`);
    }
});

// Window closed: remove its cache, proposal, and alarm so storage doesn't grow unboundedly.
chrome.windows.onRemoved.addListener(async (windowId) => {
    await chrome.storage.local.remove([
        `clusterCache_${windowId}`,
        `clusterJob_${windowId}`,
        `clusterProposal_${windowId}`,
    ]);
    chrome.alarms.clear(`reCluster_${windowId}`);
    dbg('windowRemoved', `windowId:${windowId} — storage and alarm cleared`);
});
