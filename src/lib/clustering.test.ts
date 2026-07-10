import { describe, it, expect } from 'vitest';
import type { EnrichedTab } from '@/types';
import {
    cosineSimilarity,
    cosineDistance,
    pairwiseDistances,
    clusterAverageDistance,
    agglomerativeCluster,
    formatTabInput,
    mapClustersToItems,
    extractCandidates,
    computeCentroid,
    topKeywords,
} from './clustering';

describe('cosineSimilarity', () => {
    it('identical vectors → 1', () => {
        expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    });

    it('orthogonal vectors → 0', () => {
        expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
    });

    it('opposite vectors → -1', () => {
        expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1);
    });
});

describe('cosineDistance', () => {
    it('identical vectors → 0', () => {
        expect(cosineDistance([1, 0, 0], [1, 0, 0])).toBeCloseTo(0);
    });

    it('orthogonal vectors → 1', () => {
        expect(cosineDistance([1, 0, 0], [0, 1, 0])).toBeCloseTo(1);
    });

    it('opposite vectors → 2', () => {
        expect(cosineDistance([1, 0, 0], [-1, 0, 0])).toBeCloseTo(2);
    });
});

describe('pairwiseDistances', () => {
    it('produces a symmetric n×n matrix', () => {
        const embeddings = [[1, 0], [0, 1], [1, 1]];
        const d = pairwiseDistances(embeddings);

        expect(d.length).toBe(3);
        expect(d[0].length).toBe(3);

        // symmetric
        expect(d[0][1]).toBeCloseTo(d[1][0]);
        expect(d[0][2]).toBeCloseTo(d[2][0]);
        expect(d[1][2]).toBeCloseTo(d[2][1]);
    });

    it('diagonal is zero (each vector vs itself)', () => {
        const embeddings = [[1, 0], [0, 1]];
        const d = pairwiseDistances(embeddings);
        expect(d[0][0]).toBe(0);
        expect(d[1][1]).toBe(0);
    });
});

describe('clusterAverageDistance', () => {
    it('returns mean of all cross-cluster pairwise distances', () => {
        // d[0][2] = 1, d[1][2] = 1 → average = 1
        const distances = [
            new Float32Array([0, 1, 1]),
            new Float32Array([1, 0, 1]),
            new Float32Array([1, 1, 0]),
        ];
        expect(clusterAverageDistance([0, 1], [2], distances)).toBeCloseTo(1);
    });
});

describe('agglomerativeCluster', () => {
    it('handles a single embedding — returns one cluster containing that index', () => {
        const result = agglomerativeCluster([[1, 0, 0]]);
        expect(result).toEqual([[0]]);
    });

    it('merges close embeddings into one cluster', () => {
        // Two nearly identical vectors, one far away
        const embeddings = [
            [1, 0, 0],
            [0.99, 0.1, 0],   // very close to [0]
            [0, 0, 1],         // far from both
        ];
        const clusters = agglomerativeCluster(embeddings, 0.4);

        // indices 0 and 1 should be in the same cluster, 2 alone
        const flat = clusters.map(c => c.sort());
        expect(flat).toContainEqual([0, 1]);
        expect(flat).toContainEqual([2]);
    });

    it('keeps all tabs separate when threshold is 0', () => {
        const embeddings = [[1, 0], [0, 1], [0.5, 0.5]];
        const clusters = agglomerativeCluster(embeddings, 0);
        expect(clusters.length).toBe(3);
    });

    it('merges everything when threshold is 2 (max cosine distance)', () => {
        const embeddings = [[1, 0], [0, 1], [-1, 0]];
        const clusters = agglomerativeCluster(embeddings, 2);
        expect(clusters.length).toBe(1);
        expect(clusters[0].sort()).toEqual([0, 1, 2]);
    });
});

describe('formatTabInput', () => {
    it('combines domain, path, and title', () => {
        const result = formatTabInput('https://github.com/react/react', 'React');
        expect(result).toContain('github.com');
        expect(result).toContain('React');
    });

    it('strips www from domain', () => {
        const result = formatTabInput('https://www.example.com/page', 'Page');
        expect(result).not.toContain('www.');
        expect(result).toContain('example.com');
    });

    it('strips opaque path IDs', () => {
        const result = formatTabInput('https://youtube.com/watch?v=dQw4w9WgXcQ', 'Video');
        expect(result).not.toContain('dQw4w9WgXcQ');
    });

    it('keeps short meaningful path segments', () => {
        const result = formatTabInput('https://github.com/react/react', 'React');
        expect(result).toContain('/react/react');
    });

    it('falls back to title for chrome:// URLs', () => {
        expect(formatTabInput('chrome://newtab', 'New Tab')).toBe('New Tab');
    });

    it('falls back to title for about:blank', () => {
        expect(formatTabInput('about:blank', 'Blank')).toBe('Blank');
    });

    it('appends signal when provided', () => {
        const result = formatTabInput('https://github.com/foo/bar', 'foo/bar', 'viewing-repo');
        expect(result).toContain('viewing-repo');
    });

    it('appends category when provided', () => {
        const result = formatTabInput('https://github.com/foo/bar', 'foo/bar', null, 'code');
        expect(result).toContain('code');
    });

    it('appends both signal and category when provided', () => {
        const result = formatTabInput('https://github.com/foo/bar', 'foo/bar', 'viewing-repo', 'code');
        expect(result).toContain('viewing-repo');
        expect(result).toContain('code');
    });

    it('does not include the word "null" when signal is null', () => {
        const result = formatTabInput('https://example.com', 'Example', null, null);
        expect(result).not.toContain('null');
    });

    it('does not include the word "null" when signal is undefined', () => {
        const result = formatTabInput('https://example.com', 'Example');
        expect(result).not.toContain('null');
        expect(result).not.toContain('undefined');
    });

    it('produces the same output with null signal as with no signal', () => {
        const withNull = formatTabInput('https://example.com/page', 'Page', null, null);
        const withoutArgs = formatTabInput('https://example.com/page', 'Page');
        expect(withNull).toBe(withoutArgs);
    });
});

describe('mapClustersToItems', () => {
    it('maps index clusters back to the original items', () => {
        const items = ['a', 'b', 'c'];
        const clusters = [[0, 2], [1]];
        expect(mapClustersToItems(items, clusters)).toEqual([['a', 'c'], ['b']]);
    });

    it('handles a single cluster containing all items', () => {
        const items = ['x', 'y', 'z'];
        const clusters = [[0, 1, 2]];
        expect(mapClustersToItems(items, clusters)).toEqual([['x', 'y', 'z']]);
    });

    it('handles every item in its own cluster', () => {
        const items = ['x', 'y', 'z'];
        const clusters = [[0], [1], [2]];
        expect(mapClustersToItems(items, clusters)).toEqual([['x'], ['y'], ['z']]);
    });

    it('works with object items (tabs)', () => {
        const tabs = [
            { title: 'GitHub', url: 'https://github.com' },
            { title: 'Amazon', url: 'https://amazon.com' },
            { title: 'GitLab', url: 'https://gitlab.com' },
        ];
        const clusters = [[0, 2], [1]];
        const result = mapClustersToItems(tabs, clusters);
        expect(result[0]).toContainEqual({ title: 'GitHub', url: 'https://github.com' });
        expect(result[0]).toContainEqual({ title: 'GitLab', url: 'https://gitlab.com' });
        expect(result[1]).toContainEqual({ title: 'Amazon', url: 'https://amazon.com' });
    });

    it('preserves item order within each cluster', () => {
        const items = ['a', 'b', 'c', 'd'];
        const clusters = [[3, 0, 2], [1]];
        const result = mapClustersToItems(items, clusters);
        expect(result[0]).toEqual(['d', 'a', 'c']);
    });
});

function makeTab(title: string, signal: string | null = null, category: string | null = null): EnrichedTab {
    return { title, url: 'https://example.com', id: 0, windowId: 0, index: 0, active: false, pinned: false, discarded: false, signal, category };
}

describe('extractCandidates', () => {
    it('extracts meaningful words from tab titles', () => {
        const result = extractCandidates([makeTab('TypeScript Generics')]);
        expect(result).toContain('typescript');
        expect(result).toContain('generics');
    });

    it('filters stop words', () => {
        const result = extractCandidates([makeTab('How to use React hooks')]);
        expect(result).not.toContain('how');
        expect(result).not.toContain('to');
        expect(result).not.toContain('use');
        expect(result).toContain('react');
        expect(result).toContain('hooks');
    });

    it('filters tokens shorter than 3 characters', () => {
        const result = extractCandidates([makeTab('JS vs TS performance')]);
        expect(result).not.toContain('js');
        expect(result).not.toContain('ts');
        expect(result).toContain('performance');
    });

    it('filters pure numeric tokens', () => {
        const result = extractCandidates([makeTab('Array index 123 example')]);
        expect(result).not.toContain('123');
        expect(result).toContain('array');
        expect(result).toContain('index');
        expect(result).toContain('example');
    });

    it('deduplicates candidates across multiple tabs', () => {
        const tabs = [makeTab('React tutorial'), makeTab('React hooks guide')];
        const result = extractCandidates(tabs);
        expect(result.filter(w => w === 'react').length).toBe(1);
    });

    it('splits hyphenated signal and adds non-stop words', () => {
        const result = extractCandidates([makeTab('GitHub', 'viewing-repo')]);
        expect(result).toContain('viewing');
        expect(result).toContain('repo');
    });

    it('includes category as a candidate', () => {
        const result = extractCandidates([makeTab('Laptop deals', null, 'shopping')]);
        expect(result).toContain('shopping');
    });

    it('does not emit the string "null" when signal and category are null', () => {
        const result = extractCandidates([makeTab('Clean title', null, null)]);
        expect(result).not.toContain('null');
    });
});

describe('computeCentroid', () => {
    it('computes the element-wise mean of multiple vectors', () => {
        const centroid = computeCentroid([[1, 0], [0, 1], [1, 1]]);
        expect(centroid[0]).toBeCloseTo(2 / 3);
        expect(centroid[1]).toBeCloseTo(2 / 3);
    });

    it('returns a copy of the single vector when given one input', () => {
        const centroid = computeCentroid([[0.5, 0.3, 0.9]]);
        expect(centroid).toEqual([0.5, 0.3, 0.9]);
    });
});

describe('topKeywords', () => {
    it('returns an empty array when candidates list is empty', () => {
        expect(topKeywords([], [], [1, 0], 2)).toEqual([]);
    });

    it('returns the single best candidate when k=1', () => {
        const centroid = [1, 0];
        const candidates = ['alpha', 'beta', 'gamma'];
        const vectors = [
            [1, 0],     // alpha — closest to centroid
            [0, 1],     // beta  — orthogonal
            [0.5, 0.5], // gamma — middle
        ];
        expect(topKeywords(candidates, vectors, centroid, 1)).toEqual(['alpha']);
    });

    it('returns at most k results', () => {
        const centroid = [1, 0];
        const candidates = ['a', 'b', 'c', 'd'];
        const vectors = [[1, 0], [0.9, 0.1], [0.5, 0.5], [0, 1]];
        expect(topKeywords(candidates, vectors, centroid, 2)).toHaveLength(2);
    });

    it('ranks candidates by descending similarity to the centroid', () => {
        const centroid = [1, 0];
        const candidates = ['low', 'mid', 'high'];
        const vectors = [
            [0, 1],     // low  — orthogonal to centroid
            [0.7, 0.7], // mid
            [1, 0],     // high — identical to centroid
        ];
        const result = topKeywords(candidates, vectors, centroid, 3);
        expect(result[0]).toBe('high');
        expect(result[2]).toBe('low');
    });
});
