import { Tab, Tabs, EnrichedTabs, ClusterCache, ClusterJob } from '@/types';
import {TaxonomyEngine} from '@/lib/taxonomyEngine';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

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
                        [cacheKey]: { clusters: response?.clusters, labels: response?.labels } as ClusterCache,
                        [jobKey]: { status: 'done' } as ClusterJob,
                    });
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
    addToUngrouped(cache, mapChromeTab(tab));
    await setCache(tab.windowId, cache);
});

chrome.tabs.onUpdated.addListener(async (_, changeInfo, tab) => {
    if (!changeInfo.url) return;
    const cache = await getCache(tab.windowId);
    if (!cache) return;
    // Remove from current position, then re-add to ungrouped with updated data
    cache.clusters = cache.clusters.map(cluster => cluster.filter(t => t.id !== tab.id));
    addToUngrouped(cache, mapChromeTab(tab));
    // Drop clusters that became empty (zip labels with clusters to keep them in sync)
    const pairs = cache.clusters
        .map((cluster, i) => ({ cluster, label: cache.labels[i] }))
        .filter(({ cluster }) => cluster.length > 0);
    cache.clusters = pairs.map(p => p.cluster);
    cache.labels = pairs.map(p => p.label);
    await setCache(tab.windowId, cache);
});

chrome.tabs.onRemoved.addListener(async (tabId, info) => {
    const cache = await getCache(info.windowId);
    if (!cache) return;
    const pairs = cache.clusters
        .map((cluster, i) => ({ cluster: cluster.filter(t => t.id !== tabId), label: cache.labels[i] }))
        .filter(({ cluster }) => cluster.length > 0);
    cache.clusters = pairs.map(p => p.cluster);
    cache.labels = pairs.map(p => p.label);
    await setCache(info.windowId, cache);
});
