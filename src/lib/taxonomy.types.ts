export type TaxonomyCategory =
  | 'ai'
  | 'code'
  | 'communication'
  | 'community'
  | 'document'
  | 'documentation'
  | 'education'
  | 'entertainment'
  | 'finance'
  | 'media'
  | 'reading'
  | 'reference'
  | 'research'
  | 'shopping'
  | 'social'
  | 'tools'
  | 'travel'
  | 'video'
  | 'work';

type ExtractSpec = number | { query: string };

export interface SitePath {
  match: string;
  signal?: string;
  extract?: Record<string, ExtractSpec>;
}

export interface TaxonomySite {
  id: string;
  domains: string[];
  category: TaxonomyCategory;
  tool: string;
  multipurpose: boolean;
  possibleCategories?: TaxonomyCategory[];
  paths?: SitePath[];
}

export interface TaxonomyPattern {
  id: string;
  domainPattern: string;
  category: TaxonomyCategory;
  signal: string;
}

export interface TaxonomyData {
  version: string;
  categories: TaxonomyCategory[];
  sites: TaxonomySite[];
  patterns: TaxonomyPattern[];
  aliases: Record<string, string>;
}

export interface CompiledSitePath extends SitePath {
  regex: RegExp;
}

export interface CompiledPattern extends TaxonomyPattern {
  regex: RegExp;
}

export interface LookupResult {
  site?: TaxonomySite;        // absent for pattern-only matches (no known site record)
  category: TaxonomyCategory;
  signal?: string;
  extracted?: Record<string, string>;
}
