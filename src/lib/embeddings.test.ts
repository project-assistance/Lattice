import { describe, it, expect, beforeAll } from 'vitest';
import { pipeline } from '@huggingface/transformers';
import { agglomerativeCluster, cosineSimilarity, formatTabInput } from './clustering';

// Uses onnxruntime-node (already a transitive dep) — no browser needed.
// Model is downloaded from HuggingFace Hub on first run and cached locally.
// First run is slow (~30s); subsequent runs use the local cache.
// const MODEL_ID = 'onnx-community/all-MiniLM-L6-v2-ONNX';
const MODEL_ID = "Xenova/all-MiniLM-L12-v2";


type Embedder = Awaited<ReturnType<typeof pipeline>>;
let embedder: Embedder;

beforeAll(async () => {
    embedder = await pipeline('feature-extraction', MODEL_ID, { device: 'cpu', dtype: 'fp32' });
}, 60_000);

async function embed(inputs: string[]): Promise<number[][]> {
    const output = await (embedder as any)(inputs, { pooling: 'mean', normalize: true });
    return output.tolist();
}

// Tab data includes taxonomy signal and category — matches what the background
// sends to the offscreen document in production.
const DEV_TABS = [
    { url: 'https://github.com/facebook/react', title: 'facebook/react - GitHub', signal: 'viewing-repo', category: 'code' },
    { url: 'https://stackoverflow.com/questions/123', title: 'How to use async/await - Stack Overflow', signal: 'viewing-question', category: 'documentation' },
    { url: 'https://developer.mozilla.org/en-US/docs/Web/API', title: 'Web APIs - MDN', signal: null, category: 'documentation' },
];

const SHOPPING_TABS = [
    { url: 'https://www.amazon.com/dp/product', title: 'Buy Laptop - Amazon', signal: 'product-page', category: 'shopping' },
    { url: 'https://www.ebay.com/itm/123', title: 'Laptop for Sale - eBay', signal: 'product-page', category: 'shopping' },
];

const NEWS_TABS = [
    { url: 'https://news.ycombinator.com', title: 'Hacker News', signal: null, category: 'community' },
    { url: 'https://www.bbc.com/news/technology', title: 'Technology News - BBC', signal: null, category: 'reading' },
];

type TabFixture = { url: string; title: string; signal?: string | null; category?: string | null };
const toInput = (t: TabFixture) => formatTabInput(t.url, t.title, t.signal, t.category);

describe('embedding quality', () => {
    it('dev tabs are more similar to each other than to shopping tabs', async () => {
        const vectors = await embed([...DEV_TABS, ...SHOPPING_TABS].map(toInput));

        const devSim = (
            cosineSimilarity(vectors[0], vectors[1]) +
            cosineSimilarity(vectors[0], vectors[2]) +
            cosineSimilarity(vectors[1], vectors[2])
        ) / 3;
        const crossSim = (
            cosineSimilarity(vectors[0], vectors[3]) +
            cosineSimilarity(vectors[0], vectors[4]) +
            cosineSimilarity(vectors[1], vectors[3])
        ) / 3;

        console.log(`dev avg: ${devSim.toFixed(3)}, dev→shopping avg: ${crossSim.toFixed(3)}`);
        expect(devSim).toBeGreaterThan(crossSim);
    }, 30_000);

    it('shopping tabs are more similar to each other than to dev tabs', async () => {
        const vectors = await embed([...SHOPPING_TABS, ...DEV_TABS].map(toInput));
        const shoppingSim = cosineSimilarity(vectors[0], vectors[1]);
        const crossSim = cosineSimilarity(vectors[0], vectors[2]);
        console.log(`amazon↔ebay: ${shoppingSim.toFixed(3)}, shopping→dev: ${crossSim.toFixed(3)}`);
        expect(shoppingSim).toBeGreaterThan(crossSim);
    }, 30_000);

    it('news tabs are more similar to each other than to dev tabs', async () => {
        const vectors = await embed([...NEWS_TABS, ...DEV_TABS].map(toInput));
        const newsSim = cosineSimilarity(vectors[0], vectors[1]);
        const crossSim = (cosineSimilarity(vectors[0], vectors[2]) + cosineSimilarity(vectors[1], vectors[2])) / 2;
        console.log(`news↔news: ${newsSim.toFixed(3)}, news→dev: ${crossSim.toFixed(3)}`);
        expect(newsSim).toBeGreaterThan(crossSim);
    }, 30_000);

    it('tabs with the same signal are more similar than cross-signal tabs', async () => {
        const githubRepo = toInput({ url: 'https://github.com/foo/bar', title: 'foo/bar · GitHub', signal: 'viewing-repo', category: 'code' });
        const gitlabRepo = toInput({ url: 'https://gitlab.com/baz/qux', title: 'baz/qux · GitLab', signal: 'viewing-repo', category: 'code' });
        const amazonProduct = toInput({ url: 'https://amazon.com/dp/B001', title: 'Buy Headphones', signal: 'product-page', category: 'shopping' });

        const [vGithub, vGitlab, vAmazon] = await embed([githubRepo, gitlabRepo, amazonProduct]);
        const repoSim = cosineSimilarity(vGithub, vGitlab);
        const crossSim = cosineSimilarity(vGithub, vAmazon);

        console.log(`repo↔repo: ${repoSim.toFixed(3)}, repo↔shopping: ${crossSim.toFixed(3)}`);
        expect(repoSim).toBeGreaterThan(crossSim);
    }, 30_000);

    it('output has 384 dimensions', async () => {
        const vectors = await embed([toInput(DEV_TABS[0])]);
        expect(vectors[0].length).toBe(384);
    }, 30_000);
});

describe('clustering', () => {
    it('dev and shopping tabs form separate clusters', async () => {
        const tabs = [...DEV_TABS, ...SHOPPING_TABS];
        const vectors = await embed(tabs.map(toInput));
        const clusters = agglomerativeCluster(vectors, 0.8);

        console.log('clusters:', JSON.stringify(clusters));

        // indices 0-2 = dev, 3-4 = shopping
        const devCluster = clusters.find(c => [0, 1, 2].every(i => c.includes(i)));
        const shoppingCluster = clusters.find(c => [3, 4].every(i => c.includes(i)));

        expect(devCluster).toBeDefined();
        expect(shoppingCluster).toBeDefined();
        expect(devCluster).not.toEqual(shoppingCluster);
    }, 30_000);

    it('dev, shopping, and news tabs each form their own cluster', async () => {
        const tabs = [...DEV_TABS, ...SHOPPING_TABS, ...NEWS_TABS];
        const vectors = await embed(tabs.map(toInput));
        const clusters = agglomerativeCluster(vectors, 0.8);

        console.log('clusters:', JSON.stringify(clusters));

        // indices 0-2 = dev, 3-4 = shopping, 5-6 = news
        const devCluster = clusters.find(c => [0, 1, 2].every(i => c.includes(i)));
        const shoppingCluster = clusters.find(c => [3, 4].every(i => c.includes(i)));
        const newsCluster = clusters.find(c => [5, 6].every(i => c.includes(i)));

        expect(devCluster).toBeDefined();
        expect(shoppingCluster).toBeDefined();
        expect(newsCluster).toBeDefined();
        expect(devCluster).not.toEqual(shoppingCluster);
        expect(devCluster).not.toEqual(newsCluster);
        expect(shoppingCluster).not.toEqual(newsCluster);
    }, 30_000);
});
