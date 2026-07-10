import type {
  TaxonomyData,
  TaxonomySite,
  CompiledSitePath,
  CompiledPattern,
  LookupResult,
} from './taxonomy.types';

export type {
  TaxonomyCategory,
  SitePath,
  TaxonomySite,
  TaxonomyPattern,
  TaxonomyData,
  CompiledSitePath,
  CompiledPattern,
  LookupResult,
} from './taxonomy.types';

export class TaxonomyEngine {
  readonly version: string;
  readonly aliases: Record<string, string>;
  private domainMap: Map<string, TaxonomySite>;
  private patterns: CompiledPattern[];
  private sitePaths: Map<string, CompiledSitePath[]>;

  constructor(data: TaxonomyData) {
    this.version = data.version;
    this.aliases = data.aliases;

    // O(1) domain lookup
    this.domainMap = new Map();
    for (const site of data.sites) {
      for (const domain of site.domains) {
        this.domainMap.set(domain, site);
      }
    }

    // Pre-compiled regexes for patterns
    this.patterns = data.patterns.map(p => ({
      ...p,
      regex: new RegExp(p.domainPattern),
    }));

    // Pre-compiled regexes for path extractors
    this.sitePaths = new Map();
    for (const site of data.sites) {
      if (!site.paths) continue;
      this.sitePaths.set(site.id, site.paths.map(p => ({
        ...p,
        regex: new RegExp(p.match),
      })));
    }
  }

  lookup(url: string): LookupResult | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }

    if (!parsed.protocol.startsWith('http')) return null;

    let hostname = parsed.hostname.replace(/^www\./, '');

    // Resolve short-link aliases (e.g. youtu.be → youtube.com)
    const aliasTarget = this.aliases[hostname];
    if (aliasTarget) hostname = aliasTarget;

    // 1. Exact domain match
    const site = this.domainMap.get(hostname);
    if (site) {
      const paths = this.sitePaths.get(site.id);
      if (paths) {
        for (const path of paths) {
          const match = path.regex.exec(parsed.pathname);
          if (match) {
            const extracted: Record<string, string> = {};
            for (const [key, spec] of Object.entries(path.extract ?? {})) {
              extracted[key] = typeof spec === 'number'
                ? (match[spec] ?? '')
                : (parsed.searchParams.get(spec.query) ?? '');
            }
            return {
              site,
              category: site.category,
              signal: path.signal,
              ...(Object.keys(extracted).length > 0 ? { extracted } : {}),
            };
          }
        }
      }
      return { site, category: site.category };
    }

    // 2. Subdomain / wildcard pattern match
    for (const pattern of this.patterns) {
      if (pattern.regex.test(hostname)) {
        return { category: pattern.category, signal: pattern.signal };
      }
    }

    return null;
  }
}
