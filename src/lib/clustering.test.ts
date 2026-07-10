import { describe, it, expect } from 'vitest';
import {
    cosineSimilarity,
    cosineDistance,
    pairwiseDistances,
    clusterAverageDistance,
    agglomerativeCluster,
    formatTabInput,
    mapClustersToItems,
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
