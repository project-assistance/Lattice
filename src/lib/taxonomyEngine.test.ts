import { describe, it, expect, beforeAll } from 'vitest';
import { TaxonomyEngine } from './taxonomyEngine';
import type { TaxonomyData } from './taxonomy.types';
import taxonomyData from '../../public/taxonomy.json';

const data = taxonomyData as TaxonomyData;

describe('TaxonomyEngine', () => {
  let engine: TaxonomyEngine;

  beforeAll(() => {
    engine = new TaxonomyEngine(data);
  });

  describe('initialization', () => {
    it('reads version from taxonomy.json', () => {
      expect(engine.version).toBe('2026-06-23');
    });

    it('loads aliases from taxonomy.json', () => {
      expect(engine.aliases['youtu.be']).toBe('youtube.com');
      expect(engine.aliases['amzn.to']).toBe('amazon.com');
      expect(engine.aliases['t.co']).toBe('twitter.com');
    });
  });

  describe('lookup — exact domain matches', () => {
    it('returns the correct site and category for github.com', () => {
      const result = engine.lookup('https://github.com');
      expect(result?.site?.id).toBe('github');
      expect(result?.category).toBe('code');
    });

    it('strips www. before matching', () => {
      const result = engine.lookup('https://www.github.com');
      expect(result?.site?.id).toBe('github');
    });

    it('matches country-code TLDs (amazon.co.uk)', () => {
      const result = engine.lookup('https://amazon.co.uk');
      expect(result?.site?.id).toBe('amazon');
      expect(result?.category).toBe('shopping');
    });

    it('returns null for non-http protocols', () => {
      expect(engine.lookup('chrome://newtab')).toBeNull();
      expect(engine.lookup('about:blank')).toBeNull();
    });

    it('returns null for invalid URLs', () => {
      expect(engine.lookup('not-a-url')).toBeNull();
    });

    it('returns null for unknown domains', () => {
      expect(engine.lookup('https://totally-unknown-site-xyz.com')).toBeNull();
    });
  });

  describe('lookup — path signal extraction', () => {
    it('detects a YouTube watch page and extracts videoId from query param', () => {
      const result = engine.lookup('https://youtube.com/watch?v=dQw4w9WgXcQ');
      expect(result?.signal).toBe('watching-video');
      expect(result?.extracted?.videoId).toBe('dQw4w9WgXcQ');
    });

    it('detects a YouTube search and extracts the query', () => {
      const result = engine.lookup('https://youtube.com/results?search_query=typescript');
      expect(result?.signal).toBe('video-search');
      expect(result?.extracted?.query).toBe('typescript');
    });

    it('detects YouTube Shorts', () => {
      const result = engine.lookup('https://youtube.com/shorts/abc123');
      expect(result?.signal).toBe('watching-shorts');
    });

    it('detects a Reddit subreddit and extracts its name', () => {
      const result = engine.lookup('https://reddit.com/r/programming');
      expect(result?.signal).toBe('viewing-subreddit');
      expect(result?.extracted?.subreddit).toBe('programming');
    });

    it('detects a Google search and extracts the query', () => {
      const result = engine.lookup('https://google.com/search?q=typescript+types');
      expect(result?.signal).toBe('web-search-query');
      expect(result?.extracted?.query).toBe('typescript types');
    });

    it('detects an Amazon product search and extracts the keyword', () => {
      const result = engine.lookup('https://amazon.com/s?k=mechanical+keyboard');
      expect(result?.signal).toBe('product-search');
      expect(result?.extracted?.query).toBe('mechanical keyboard');
    });

    it('detects an Amazon product detail page', () => {
      const result = engine.lookup('https://amazon.com/dp/B0ABCDE123');
      expect(result?.signal).toBe('product-page');
    });

    it('detects a GitHub repo page and extracts owner and repo', () => {
      const result = engine.lookup('https://github.com/microsoft/typescript');
      expect(result?.signal).toBe('viewing-repo');
      expect(result?.extracted?.owner).toBe('microsoft');
      expect(result?.extracted?.repo).toBe('typescript');
    });

    it('detects a GitHub issues/PRs page', () => {
      const result = engine.lookup('https://github.com/microsoft/typescript/issues');
      expect(result?.signal).toBe('issues-or-prs');
      expect(result?.extracted?.section).toBe('issues');
    });

    it('detects a Wikipedia article and extracts its name', () => {
      const result = engine.lookup('https://en.wikipedia.org/wiki/TypeScript');
      expect(result?.signal).toBe('encyclopedia-article');
      expect(result?.extracted?.article).toBe('TypeScript');
    });

    it('detects a LinkedIn job search page', () => {
      const result = engine.lookup('https://linkedin.com/jobs/search?keywords=engineer');
      expect(result?.signal).toBe('job-search');
    });

    it('detects a Google Docs document page', () => {
      const result = engine.lookup('https://docs.google.com/document/d/1abc/edit');
      expect(result?.signal).toBe('editing-doc');
    });

    it('detects a Google Sheets page', () => {
      const result = engine.lookup('https://docs.google.com/spreadsheets/d/1abc/edit');
      expect(result?.signal).toBe('editing-spreadsheet');
    });

    it('detects a Stack Overflow question page', () => {
      const result = engine.lookup('https://stackoverflow.com/questions/123/how-does-async-await-work');
      expect(result?.site?.id).toBe('stackoverflow');
      expect(result?.signal).toBe('viewing-question');
    });

    it('detects a GitHub code search', () => {
      const result = engine.lookup('https://github.com/search?q=vitest&type=code');
      expect(result?.site?.id).toBe('github');
      expect(result?.signal).toBe('code-search');
    });

    it('returns the site with no signal when no path rule matches', () => {
      const result = engine.lookup('https://github.com/explore');
      expect(result?.site?.id).toBe('github');
      expect(result?.signal).toBeUndefined();
    });
  });

  describe('lookup — alias resolution', () => {
    it('resolves youtu.be to the YouTube site', () => {
      const result = engine.lookup('https://youtu.be/dQw4w9WgXcQ');
      expect(result?.site?.id).toBe('youtube');
    });

    it('resolves amzn.to to the Amazon site', () => {
      const result = engine.lookup('https://amzn.to/3xYzAbc');
      expect(result?.site?.id).toBe('amazon');
    });

    it('resolves t.co to the Twitter site', () => {
      const result = engine.lookup('https://t.co/somepath');
      expect(result?.site?.id).toBe('twitter');
    });
  });

  describe('lookup — pattern matches', () => {
    it('matches a docs. subdomain as documentation', () => {
      const result = engine.lookup('https://docs.example.com/guide');
      expect(result?.category).toBe('documentation');
      expect(result?.signal).toBe('documentation-site');
    });

    it('matches an api. subdomain as documentation', () => {
      const result = engine.lookup('https://api.example.com/v1');
      expect(result?.category).toBe('documentation');
      expect(result?.signal).toBe('api-reference');
    });

    it('matches a .myshopify.com domain as shopping', () => {
      const result = engine.lookup('https://mystore.myshopify.com');
      expect(result?.category).toBe('shopping');
      expect(result?.signal).toBe('online-store');
    });

    it('matches a .vercel.app domain as tools', () => {
      const result = engine.lookup('https://my-app.vercel.app');
      expect(result?.category).toBe('tools');
      expect(result?.signal).toBe('deployed-app');
    });

    it('matches a .substack.com domain as reading', () => {
      const result = engine.lookup('https://stratechery.substack.com');
      expect(result?.category).toBe('reading');
      expect(result?.signal).toBe('newsletter');
    });

    it('matches a .github.io domain as documentation', () => {
      const result = engine.lookup('https://microsoft.github.io/vscode-docs');
      expect(result?.category).toBe('documentation');
      expect(result?.signal).toBe('project-site');
    });

    it('matches a .slack.com workspace as communication', () => {
      const result = engine.lookup('https://myteam.slack.com/messages');
      expect(result?.category).toBe('communication');
      expect(result?.signal).toBe('slack-workspace');
    });
  });
});
