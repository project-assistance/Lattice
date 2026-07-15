import { Tab, Tabs, EnrichedTabs, ClusterCache, ClusterJob, ClusterProposal } from '@/types';
import { TaxonomyEngine } from '@/lib/taxonomyEngine';
import { THRESHOLD } from '@/lib/clustering';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const RECLUSTER_ALARM_DELAY_MINUTES = 45;

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
    console.log('Loading taxonomy...');
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
    const hasNamedClusters = cache.labels.some(l => l !== 'Ungrouped');
    if (!hasNamedClusters || !cache.centroids?.length || !await isOffscreenAvailable()) {
        addToUngrouped(cache, tab);
        return;
    }

    const vector = await embedSingleTab(tab);
    if (!vector) {
        addToUngrouped(cache, tab);
        return;
    }

    // 1 - THRESHOLD converts the distance threshold to a similarity threshold.
    // Matches the same criterion the clustering algorithm uses to merge tabs.
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
        cache.clusters[bestIdx].push(tab);
        // Running-average centroid update: keeps the centroid representative
        // as new tabs arrive without requiring access to all stored vectors.
        const count = cache.clusters[bestIdx].length;
        cache.centroids[bestIdx] = cache.centroids[bestIdx].map(
            (v, i) => (v * (count - 1) + vector[i]) / count
        );
    } else {
        addToUngrouped(cache, tab);
    }
}

const getTabTitles = async (windowId: number): Promise<Tabs> => {
    const tabs = await chrome.tabs.query({ windowId });
    console.log('Queried tabs:', tabs);
    return tabs.map(tab => {
        return { title: tab.title, url: tab.url , id: tab.id!, windowId: tab.windowId, index: tab.index, active: tab.active, pinned: tab.pinned, discarded: tab.discarded, favIconUrl: tab.favIconUrl };
    }) as Tabs;
}

async function handleGetTabs(sendResponse: (response: any) => void, windowId: number) {
    {
        const cacheKey = `clusterCache_${windowId}`;
        const result = await chrome.storage.local.get(cacheKey);
        const clusterCache = result[cacheKey] as ClusterCache | undefined;
        if (clusterCache?.clusters && clusterCache?.labels) {
            console.log('Returning cached clusters from session storage:', clusterCache);
            sendResponse({ status: 'cache_success', tabs: clusterCache.clusters, labels: clusterCache.labels });
            return;
        }
    }
    try {
        const tabs = await getTabTitles(windowId);
        sendResponse({ status: 'success', tabs });
    } catch (error) {
        console.error('Error in handleGetTabs:', error);
        sendResponse({ status: 'error', message: 'Failed to fetch tabs' });
    }
}

async function handleClusterTabs(sendResponse: (response: any) => void, windowId: number) {
    const jobKey = `clusterJob_${windowId}`;
    const cacheKey = `clusterCache_${windowId}`;
    await chrome.storage.local.set({ [jobKey]: { status: 'running' } as ClusterJob });
    try {
        const [tabs, taxonomy] = await Promise.all([getTabTitles(windowId), getTaxonomy()]);
        const justCreated = await ensureOffscreenDocument();
        if (justCreated) await waitForOffscreenReady();

        const enrichedTabs: EnrichedTabs = tabs.map(tab => ({
            ...tab,
            signal: taxonomy.lookup(tab.url)?.signal || null,
            category: taxonomy.lookup(tab.url)?.category || null,
        }));

        chrome.runtime.sendMessage(
            { action: 'RUN_EMBEDDINGS', tabs: enrichedTabs },
            (response) => {
                if (response?.status === 'error') {
                    chrome.storage.local.set({ [jobKey]: { status: 'error', error: response.message } as ClusterJob });
                    try { sendResponse({ status: 'error', message: response.message }); } catch {}
                } else {
                    chrome.storage.local.set({
                        [cacheKey]: {
                            clusters: response?.clusters,
                            labels: response?.labels,
                            centroids: response?.centroids,
                        } as ClusterCache,
                        [jobKey]: { status: 'done' } as ClusterJob,
                    });
                    // Clear any pending proposal — a fresh manual cluster supersedes it.
                    chrome.storage.local.remove(`clusterProposal_${windowId}`);
                    // Schedule a background re-cluster to detect drift after 45 minutes.
                    chrome.alarms.create(`reCluster_${windowId}`, { delayInMinutes: RECLUSTER_ALARM_DELAY_MINUTES });
                    try { sendResponse({ status: 'success', vector: response?.vector, clusters: response?.clusters, labels: response?.labels }); } catch {}
                }
            }
        );
    } catch (error: any) {
        console.error('Error in handleClusterTabs:', error);
        chrome.storage.local.set({ [jobKey]: { status: 'error', error: error.message } as ClusterJob });
        try { sendResponse({ status: 'error', message: 'Failed to run embeddings' }); } catch {}
    }
}

// Returns true if the background re-cluster found a meaningfully better grouping.
// Criteria: more named clusters, or Ungrouped shrank by 3+ tabs.
function isProposalMeaningfullyDifferent(current: ClusterCache, proposal: ClusterProposal): boolean {
    const currentNamed = current.labels.filter(l => l !== 'Ungrouped').length;
    const proposedNamed = proposal.labels.filter(l => l !== 'Ungrouped').length;
    if (proposedNamed > currentNamed) return true;

    const currentUngroupedCount = current.clusters[current.labels.indexOf('Ungrouped')]?.length ?? 0;
    const proposedUngroupedCount = proposal.clusters[proposal.labels.indexOf('Ungrouped')]?.length ?? 0;
    if (currentUngroupedCount - proposedUngroupedCount >= 3) return true;

    return false;
}

// Runs a full re-cluster in the background using fresh tab data.
// Stores the result as a proposal if it's meaningfully better than the current cache.
async function runBackgroundReCluster(windowId: number) {
    // Don't run if a manual cluster job is in progress.
    const jobResult = await chrome.storage.local.get(`clusterJob_${windowId}`);
    if ((jobResult[`clusterJob_${windowId}`] as ClusterJob | undefined)?.status === 'running') return;

    const currentCache = await getCache(windowId);
    if (!currentCache) return;

    // Bail if the window has been closed.
    try { await chrome.windows.get(windowId); } catch { return; }

    try {
        const [tabs, taxonomy] = await Promise.all([getTabTitles(windowId), getTaxonomy()]);
        if (tabs.length < 2) return;

        const justCreated = await ensureOffscreenDocument();
        if (justCreated) await waitForOffscreenReady();

        const enrichedTabs: EnrichedTabs = tabs.map(tab => ({
            ...tab,
            signal: taxonomy.lookup(tab.url)?.signal || null,
            category: taxonomy.lookup(tab.url)?.category || null,
        }));

        chrome.runtime.sendMessage(
            { action: 'RUN_EMBEDDINGS', tabs: enrichedTabs },
            (response) => {
                if (response?.status !== 'success') return;

                const proposal: ClusterProposal = {
                    clusters: response.clusters,
                    labels: response.labels,
                    centroids: response.centroids ?? [],
                    proposedAt: Date.now(),
                };

                if (!isProposalMeaningfullyDifferent(currentCache, proposal)) return;

                chrome.storage.local.set({ [`clusterProposal_${windowId}`]: proposal });
            }
        );
    } catch (error) {
        console.error('Background re-cluster failed:', error);
    }
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm.name.startsWith('reCluster_')) return;
    const windowId = parseInt(alarm.name.replace('reCluster_', ''), 10);
    runBackgroundReCluster(windowId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

    if ( message.action === 'LOAD_TAXONOMY') {
        getTaxonomy().then(taxonomy => {
            sendResponse({ status: 'success', version: taxonomy.version, aliases: taxonomy.aliases });
        }).catch(error => {
            console.error('Error loading taxonomy:', error);
            sendResponse({ status: 'error', message: 'Failed to load taxonomy' });
        });
        return true; // keep channel open for async sendResponse
    }

    if (message.action === 'CREATE_TAB_GROUP') {
        const { tabIds, title, colorIndex, windowId } = message;
        const colors = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
        const color = colors[colorIndex % colors.length] as chrome.tabGroups.Color;
        chrome.tabs.group({ tabIds, createProperties: { windowId } }, (groupId) => {
            if (chrome.runtime.lastError) {
                sendResponse({ status: 'error', message: chrome.runtime.lastError.message });
                return;
            }
            chrome.tabGroups.update(groupId, { title, color }, () => {
                sendResponse({ status: 'success', groupId });
            });
        });
        return true;
    }

    if (message.action === 'UNGROUP_TABS') {
        chrome.tabs.ungroup(message.tabIds, () => {
            if (chrome.runtime.lastError) {
                sendResponse({ status: 'error', message: chrome.runtime.lastError.message });
            } else {
                sendResponse({ status: 'success' });
            }
        });
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

    if(message.action === 'SET_ACTIVE_TAB') {
        const { tabId } = message;
        chrome.tabs.update(tabId, { active: true }, (tab) => {
            if (chrome.runtime.lastError) {
                console.error('Error activating tab:', chrome.runtime.lastError);
                sendResponse({ status: 'error', message: chrome.runtime.lastError.message });
            } else {
                sendResponse({ status: 'success', tab });
            }
        });
        return true; // keep channel open for async sendResponse
    }

    if (message.action === 'APPLY_PROPOSAL') {
        (async () => {
            const { windowId } = message;
            const result = await chrome.storage.local.get(`clusterProposal_${windowId}`);
            const proposal = result[`clusterProposal_${windowId}`] as ClusterProposal | undefined;
            if (!proposal) { sendResponse({ status: 'error' }); return; }
            await chrome.storage.local.set({
                [`clusterCache_${windowId}`]: {
                    clusters: proposal.clusters,
                    labels: proposal.labels,
                    centroids: proposal.centroids,
                } as ClusterCache,
            });
            await chrome.storage.local.remove(`clusterProposal_${windowId}`);
            // Re-arm the alarm so we keep checking after the applied grouping.
            chrome.alarms.create(`reCluster_${windowId}`, { delayInMinutes: RECLUSTER_ALARM_DELAY_MINUTES });
            sendResponse({ status: 'success' });
        })();
        return true;
    }

    if (message.action === 'DISMISS_PROPOSAL') {
        chrome.storage.local.remove(`clusterProposal_${message.windowId}`);
        sendResponse({ status: 'success' });
    }

    console.log('Received message:', message);
    console.log('From sender:', sender);
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
    // Tabs opened from a link already have a URL — smart-place immediately.
    // Blank new tabs have no URL yet; onUpdated handles them when they navigate.
    const isRealUrl = mapped.url && !mapped.url.startsWith('chrome://') && !mapped.url.startsWith('about:');
    if (isRealUrl) {
        await smartPlace(cache, mapped);
    } else {
        addToUngrouped(cache, mapped);
    }
    await setCache(tab.windowId, cache);
});

function getDomain(url: string): string {
    try { return new URL(url).hostname; } catch { return ''; }
}

chrome.tabs.onUpdated.addListener(async (_, changeInfo, tab) => {
    if (!changeInfo.url) return;
    const cache = await getCache(tab.windowId);
    if (!cache) return;

    // Find the tab's current position and old URL in the cache.
    let oldUrl = '';
    let clusterIdx = -1;
    for (let i = 0; i < cache.clusters.length; i++) {
        const found = cache.clusters[i].find(t => t.id === tab.id);
        if (found) { oldUrl = found.url; clusterIdx = i; break; }
    }

    const newTab = mapChromeTab(tab);

    if (clusterIdx !== -1 && getDomain(oldUrl) === getDomain(newTab.url)) {
        // Same domain (e.g. github.com/foo → github.com/bar): update in place, no cluster change.
        cache.clusters[clusterIdx] = cache.clusters[clusterIdx].map(t => t.id === tab.id ? newTab : t);
    } else {
        // New domain or tab not yet tracked: remove from current position, then smart-place.
        cache.clusters = cache.clusters.map(cluster => cluster.filter(t => t.id !== tab.id));
        const pairs = cache.clusters
            .map((cluster, i) => ({ cluster, label: cache.labels[i], centroid: cache.centroids?.[i] }))
            .filter(({ cluster }) => cluster.length > 0);
        cache.clusters = pairs.map(p => p.cluster);
        cache.labels = pairs.map(p => p.label);
        if (cache.centroids) cache.centroids = pairs.map(p => p.centroid).filter((c): c is number[] => c !== undefined);
        await smartPlace(cache, newTab);
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
        }))
        .filter(({ cluster }) => cluster.length > 0);
    cache.clusters = pairs.map(p => p.cluster);
    cache.labels = pairs.map(p => p.label);
    if (cache.centroids) cache.centroids = pairs.map(p => p.centroid).filter((c): c is number[] => c !== undefined);
    await setCache(info.windowId, cache);
});

// Chrome restart: all tab IDs are reassigned, so every cached cluster is stale.
chrome.runtime.onStartup.addListener(async () => {
    const all = await chrome.storage.local.get(null);
    const staleKeys = Object.keys(all).filter(k =>
        k.startsWith('clusterCache_') || k.startsWith('clusterJob_') || k.startsWith('clusterProposal_')
    );
    if (staleKeys.length) await chrome.storage.local.remove(staleKeys);
});

// Window closed: remove its cache, proposal, and alarm so storage doesn't grow unboundedly.
chrome.windows.onRemoved.addListener(async (windowId) => {
    await chrome.storage.local.remove([
        `clusterCache_${windowId}`,
        `clusterJob_${windowId}`,
        `clusterProposal_${windowId}`,
    ]);
    chrome.alarms.clear(`reCluster_${windowId}`);
});
