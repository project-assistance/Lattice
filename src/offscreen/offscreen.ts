import { pipeline, env } from '@huggingface/transformers';
import { EnrichedTab, EnrichedTabs } from '@/types';
import {
    agglomerativeCluster,
    formatTabInput,
    mapClustersToItems,
    extractCandidates,
    computeCentroid,
    topKeywords,
} from '@/lib/clustering';

declare const LanguageModel: any;

function getDomain(url: string) {
    try { return new URL(url).hostname.replace('www.', '') } catch { return url }
}

// onnxruntime-web fetches its WASM runtime from jsdelivr CDN by default,
// which Chrome extension CSP blocks. Point it to the local copies in /ort/ instead.
if (env.backends.onnx.wasm) {
    env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('/ort/');
}
// const MODEL_ID = 'onnx-community/all-MiniLM-L6-v2-ONNX';
const MODEL_ID = "Xenova/all-MiniLM-L12-v2";

const model = {
    id: MODEL_ID,
    dtype: "fp32" as const,
    task: "feature-extraction" as const,
    device: "webgpu" as const,
}

async function keyBERTLabel(
    group: number[],
    embedder: any,
    tabs: EnrichedTabs,
    vectors: number[][]
): Promise<string> {
    const candidates = extractCandidates(group.map(idx => tabs[idx]))
    if (candidates.length === 0) return ''
    const output = await embedder(candidates, { pooling: 'mean', normalize: true })
    const cvectors: number[][] = output.tolist()
    const centroid = computeCentroid(group.map(idx => vectors[idx]))
    const keywords = topKeywords(candidates, cvectors, centroid, 2)
    return keywords.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' · ')
}

async function generateLabels(
    clusters: EnrichedTab[][],
    clusterIndices: number[][],
    embedder: any,
    tabs: EnrichedTabs,
    vectors: number[][]
): Promise<string[]> {
    let session: any = null
    try {
        session = await LanguageModel.create()
    } catch {
        // Gemini unavailable — use KeyBERT for all clusters
        return Promise.all(clusterIndices.map(g => keyBERTLabel(g, embedder, tabs, vectors)))
    }

    const labels: string[] = []
    for (let i = 0; i < clusters.length; i++) {
        try {
            const tabList = clusters[i]
                .map(t => `- "${t.title}" (${getDomain(t.url)})`)
                .join('\n')
            const response = await session.prompt(
                `These browser tabs are open together:\n${tabList}\n\nWrite a concise 2-4 word title describing what they have in common. Reply with only the title, no punctuation or explanation.`
            )
            labels.push(response.trim())
        } catch {
            // Single prompt failed — fall back to KeyBERT for this cluster
            labels.push(await keyBERTLabel(clusterIndices[i], embedder, tabs, vectors))
        }
    }

    session.destroy()
    return labels
}

async function runTabCompare(tabs: EnrichedTabs, sendResponse: (response: any) => void) {
    try {
        const embedder = await pipeline(model.task, model.id, { device: model.device, dtype: model.dtype });
        const inputs = tabs.map(t => formatTabInput(t.url, t.title, t.signal, t.category));
        console.log('Embedding inputs:', inputs);
        const output = await embedder(inputs, { pooling: 'mean', normalize: true });
        const vectors: number[][] = output.tolist();
        const clusterIndices = agglomerativeCluster(vectors);
        const clusteredTabs = mapClustersToItems(tabs, clusterIndices);

        // Split: multi-tab clusters get named, singletons are collected into one ungrouped bucket
        const multiIndices = clusterIndices.filter((_, i) => clusteredTabs[i].length > 1);
        const multiClusters = clusteredTabs.filter(c => c.length > 1);
        const singleTabs = clusteredTabs.filter(c => c.length === 1).flat();

        const multiLabels = await generateLabels(multiClusters, multiIndices, embedder, tabs, vectors);

        const finalClusters = singleTabs.length > 0 ? [...multiClusters, singleTabs] : multiClusters;
        const finalLabels = singleTabs.length > 0 ? [...multiLabels, 'Ungrouped'] : multiLabels;

        console.log('Clustered tabs:', finalClusters);
        console.log('Cluster labels:', finalLabels);
        sendResponse({ status: 'success', vector: vectors, clusters: finalClusters, labels: finalLabels });
    } catch (error: any) {
        console.error('Error in runTabCompare:', error);
        sendResponse({ status: 'error', message: error.message });
    }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'RUN_EMBEDDINGS') {
        console.log('Received tabs for comparison:', message.tabs);
        runTabCompare(message.tabs, sendResponse);
        return true; // keep channel open for async sendResponse
    }
});

// Signal to the background that this module has finished executing and the
// message listener above is registered. The background waits for this before
// sending RUN_EMBEDDINGS — necessary because <script type="module"> is deferred
// and createDocument() resolves before module scripts finish executing.
chrome.runtime.sendMessage({ action: 'OFFSCREEN_READY' });
