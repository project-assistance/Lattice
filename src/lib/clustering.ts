import { EnrichedTab } from '@/types'

// Dot product of two vectors. Because the embedder normalizes output to unit length
// (normalize: true in the pipeline call), the dot product equals cosine similarity —
// no need to divide by magnitudes since they're already 1.

export const THRESHOLD = 0.65; // distance threshold for clustering; exposed here for testing

export function cosineSimilarity(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += a[i] * b[i];
    }
    return sum;
}

// Converts similarity (1 = identical, -1 = opposite) into a distance (0 = identical).
// Used so clustering can work with "how far apart" rather than "how similar".
export function cosineDistance(a: number[], b: number[]): number {
    return 1 - cosineSimilarity(a, b);
}

// Builds an n×n matrix of pairwise distances between all embeddings.
// Only the upper triangle is computed; the lower triangle is filled by symmetry
// (distance from A→B equals B→A), halving the work.
// Stored as Float32Array rows for memory efficiency over a nested number[][] array.
export function pairwiseDistances(embeddings: number[][]): Float32Array[] {
    const n = embeddings.length;
    const distances = Array.from({ length: n }, () => new Float32Array(n));

    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const d = cosineDistance(embeddings[i], embeddings[j]);
            distances[i][j] = d;
            distances[j][i] = d;
        }
    }

    return distances;
}

// Average linkage: the distance between two clusters is the mean of all pairwise
// distances between their members. This is more stable than single linkage (which
// uses the minimum and tends to form long chains) or complete linkage (which uses
// the maximum and can be too conservative for semantically related tabs).
export function clusterAverageDistance(clusterA: number[], clusterB: number[], distances: Float32Array[]): number {
    let sum = 0;
    let count = 0;
    for (const i of clusterA) {
        for (const j of clusterB) {
            sum += distances[i][j];
            count++;
        }
    }
    return sum / count;
}

// Agglomerative (bottom-up) hierarchical clustering with average linkage.
// Starts with every tab in its own cluster, then repeatedly merges the two
// closest clusters until no remaining pair is within distanceThreshold.
//
// distanceThreshold controls how aggressively tabs are grouped:
//   0.0 = only merge identical tabs
//   0.4 = merge tabs with reasonably similar topics (default)
//   1.0 = merge everything into one cluster
//
// Returns an array of clusters, where each cluster is an array of tab indices
// into the original tabs array. e.g. [[0,2], [1,3,4], [5]] means tabs 0 and 2
// are in one group, tabs 1/3/4 in another, tab 5 alone.
export function agglomerativeCluster(embeddings: number[][], distanceThreshold = THRESHOLD): number[][] {
    const n = embeddings.length;
    const distances = pairwiseDistances(embeddings);

    let clusters = Array.from({ length: n }, (_, i) => [i]);

    while (clusters.length > 1) {
        let minDist = Infinity;
        let mergeA = -1, mergeB = -1;

        for (let i = 0; i < clusters.length; i++) {
            for (let j = i + 1; j < clusters.length; j++) {
                const d = clusterAverageDistance(clusters[i], clusters[j], distances);
                if (d < minDist) {
                    minDist = d;
                    mergeA = i;
                    mergeB = j;
                }
            }
        }

        if (minDist > distanceThreshold) break;

        const merged = [...clusters[mergeA], ...clusters[mergeB]];
        clusters = clusters.filter((_, idx) => idx !== mergeA && idx !== mergeB);
        clusters.push(merged);
    }

    return clusters;
}

// Formats a tab's URL + title into a single string for embedding.
// Combining domain and path with the title gives the model more signal than
// the title alone — two tabs called "Settings" on different sites won't cluster.
export function formatTabInput(url: string, title: string, signal?: string | null, category?: string | null): string {
    try {
        const parsed = new URL(url);
        // chrome:// and about: parse without throwing but produce meaningless
        // hostnames (e.g. "newtab", ""). Only process http/https URLs.
        if (!parsed.protocol.startsWith('http')) return title;
        const domain = parsed.hostname.replace('www.', '');
        const path = parsed.pathname
            .replace(/\/$/, '')
            .split('/')
            .filter(seg => !/^[a-z0-9_-]{8,}$/i.test(seg)) // strip opaque IDs
            .join('/');
        return `${domain} ${path} ${title} ${signal || ''} ${category || ''}`.trim();
    } catch {
        return title;
    }
}

// Maps cluster index arrays back to the original items they refer to.
// e.g. items = [tabA, tabB, tabC], clusters = [[0,2],[1]]
//   → [[tabA, tabC], [tabB]]
export function mapClustersToItems<T>(items: T[], clusters: number[][]): T[][] {
    return clusters.map(cluster => cluster.map(i => items[i]));
}

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'in', 'at', 'on', 'for', 'of', 'to', 'and', 'or',
    'with', 'how', 'what', 'why', 'when', 'where', 'who', 'which', 'that',
    'this', 'these', 'those', 'it', 'its', 'be', 'been', 'have', 'has', 'had',
    'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
    'not', 'no', 'use', 'using', 'used', 'get', 'new', 'vs', 'via', 'from',
    'by', 'as', 'are', 'was', 'were', 'but', 'if', 'then', 'than', 'so',
    'up', 'out', 'about', 'into', 'after', 'before', 'more', 'can', 'your',
    'you', 'my', 'we', 'our', 'their', 'all', 'just', 'also', 'page', 'site',
])

// Extracts candidate keywords from enriched tab titles, signals, and categories.
// Used as input candidates for KeyBERT-style cluster label generation.
export function extractCandidates(tabs: EnrichedTab[]): string[] {
    const seen = new Set<string>()
    const candidates: string[] = []

    const add = (w: string) => { if (!seen.has(w)) { seen.add(w); candidates.push(w) } }

    for (const tab of tabs) {
        tab.title
            .toLowerCase()
            .split(/[\s\-–—|·•:,.()[\]{}'"!?/\\@#]+/)
            .filter(w => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w))
            .forEach(add)

        // signal like "viewing-repo" → ["viewing", "repo"]
        tab.signal?.split('-').filter(w => w.length >= 3 && !STOP_WORDS.has(w)).forEach(add)

        if (tab.category) add(tab.category)
    }

    return candidates
}

// Mean of a set of vectors — the geometric center of a cluster.
export function computeCentroid(vectors: number[][]): number[] {
    const dim = vectors[0].length
    const sum = new Array(dim).fill(0)
    for (const vec of vectors) {
        for (let i = 0; i < dim; i++) sum[i] += vec[i]
    }
    return sum.map(v => v / vectors.length)
}

// Picks the k candidates whose embeddings are closest to the centroid.
// These are the words that best represent the cluster's semantic center.
export function topKeywords(
    candidates: string[],
    candidateVectors: number[][],
    centroid: number[],
    k = 2
): string[] {
    if (candidates.length === 0) return []
    return candidates
        .map((word, i) => ({ word, score: cosineSimilarity(candidateVectors[i], centroid) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map(s => s.word)
}
