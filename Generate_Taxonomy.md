You are generating a website taxonomy file for a Chrome extension that 
helps users organize browser tabs. Your output will be parsed as JSON and 
used by a clustering engine.

## Your task

Produce a JSON file containing taxonomy entries for the top 100 websites by 
global traffic. Use your knowledge of the actual top-trafficked sites as of 
your knowledge cutoff. Prioritize sites that knowledge workers, students, 
researchers, designers, developers, and curious generalists actually use 
daily. If a site is in the global top 100 but rarely used by this audience 
(e.g., regional portals, certain ad networks), replace it with the next 
most-used site for the target audience.

## Output format

Output ONLY valid JSON. No prose, no markdown code fences, no explanations 
before or after. The output must parse with JSON.parse() directly.

The structure is:

{
  "version": "<today's date in YYYY-MM-DD>",
  "categories": [<list of category strings used>],
  "sites": [<array of site entries>],
  "patterns": [<array of regex-based fallbacks for site families>],
  "aliases": {<map of alternate domains to canonical domains>}
}

## Category vocabulary

Use ONLY these categories. Do not invent new ones. If a site does not fit 
cleanly, pick the closest match.

- "code" — code hosting, development, version control
- "communication" — email, chat, messaging, video calls
- "community" — forums, social discussion, Q&A
- "document" — collaborative documents, notes, knowledge bases
- "media" — music, podcasts, streaming audio
- "reading" — articles, blogs, news, newsletters
- "reference" — search, encyclopedias, dictionaries, wikis
- "research" — academic papers, scientific resources, data
- "shopping" — e-commerce, marketplaces, product research
- "social" — social networks focused on personal connections
- "tools" — SaaS productivity, design, project management
- "travel" — booking, maps, navigation
- "video" — video streaming, video sharing
- "work" — work-specific platforms (HR, CRM, ATS, etc.)
- "ai" — AI assistants, AI tools, AI services
- "finance" — banking, investing, financial services
- "education" — online courses, learning platforms
- "documentation" — technical docs, API references, developer resources
- "entertainment" — games, humor, casual entertainment
- "adult" — flag for filter awareness; do not include detailed entries

## Site entry schema

Each entry in "sites" must have this exact shape:

{
  "id": "<short stable identifier, kebab-case, e.g., 'github'>",
  "domains": [<array of domain strings, all lowercase, no protocol, no path>],
  "category": "<one of the categories above>",
  "tool": "<optional: short name for the specific product, e.g., 'github', 'gmail'>",
  "multipurpose": <boolean: true if site is genuinely used for multiple distinct purposes>,
  "possibleCategories": [<optional: only if multipurpose is true; list of plausible categories>],
  "paths": [<optional: only include for sites where URL paths carry strong semantic signal>]
}

Path entries follow this schema:

{
  "match": "<JavaScript regex string matching url.pathname>",
  "extract": {<optional: map of field names to either a capture group number OR {"query": "param_name"}>},
  "signal": "<short string describing what kind of activity this URL represents>"
}

## Critical guidance on multipurpose sites

Sites like YouTube, Reddit, Twitter/X, Wikipedia, Amazon, and similar can 
be used for many different purposes. For these:

- Set "multipurpose": true
- List 2-4 plausible categories in "possibleCategories", with the primary 
  category in "category"
- The category should reflect what the site IS, not what users might use it FOR

Example: YouTube IS a video platform. People use it for entertainment, 
education, research, music, and tutorials. So:
  "category": "video",
  "multipurpose": true,
  "possibleCategories": ["video", "entertainment", "education", "tutorial"]

Do NOT mark a site multipurpose just because it has multiple sections. 
Reserve this flag for sites with genuinely ambiguous user intent.

## Critical guidance on paths

Only include "paths" entries when they carry HIGH-VALUE semantic signal. 
Examples of high-value cases:

- Search engines: extract the query string ("?q=", "?search_query=", etc.)
- GitHub/GitLab: extract owner and repo from path
- Reddit: extract subreddit name
- YouTube: distinguish /watch from /results from /@channel
- Google Docs/Sheets/Slides: distinguish document types
- Amazon: distinguish search results from product pages

Do NOT add path entries for sites where they would be low-value. Most 
sites do not need any "paths" entries at all.

For "extract":
- A number (e.g., 1) means "use the Nth regex capture group"
- {"query": "name"} means "use url.searchParams.get('name')"

## Critical guidance on domains

For each site, include ALL meaningful variant domains in the "domains" 
array, including:
- The canonical domain (e.g., "github.com")
- Common subdomain variants where they represent the SAME product 
  (e.g., for Reddit: "reddit.com", "old.reddit.com", "new.reddit.com")
- Country-specific variants ONLY for the most globally significant sites 
  (e.g., for Amazon: "amazon.com", "amazon.co.uk", "amazon.de", 
  "amazon.fr", "amazon.ca", "amazon.co.jp")

Do NOT include subdomains that represent DIFFERENT products. Those get 
their own entries. Examples that DO get separate entries:
- mail.google.com (Gmail) — separate entry from google.com
- docs.google.com (Google Docs) — separate entry
- drive.google.com (Google Drive) — separate entry
- meet.google.com (Google Meet) — separate entry
- studio.youtube.com (YouTube Studio) — separate entry from youtube.com
- music.youtube.com (YouTube Music) — separate entry

For URL shorteners and aliases, put them in the top-level "aliases" 
object instead. Example: {"youtu.be": "youtube.com", "fb.com": "facebook.com"}

## Patterns section

Include 10-20 regex-based patterns for site FAMILIES rather than 
individual sites. These catch the long tail. Examples:

{
  "id": "docs-subdomain",
  "domainPattern": "^docs?\\.",
  "category": "documentation",
  "signal": "documentation-site"
}

{
  "id": "substack",
  "domainPattern": "\\.substack\\.com$",
  "category": "reading",
  "signal": "newsletter"
}

Cover patterns for: documentation subdomains, Substack, Medium custom 
domains, Atlassian, Zendesk, Slack workspaces, Shopify stores, Notion 
shared sites, WordPress hosted blogs, GitHub Pages, GitLab self-hosted, 
common SaaS suffixes (.app, certain TLDs), and similar families.

## Coverage targets for the 100 sites

Aim for coverage roughly distributed like this (these are approximate, 
not strict quotas):

- Search and reference: ~6 sites (Google, Bing, DuckDuckGo, Wikipedia, 
  Wolfram Alpha, etc.)
- Social and community: ~10 sites
- Video and streaming: ~6 sites
- Code and development: ~8 sites
- Documentation: ~5 sites (MDN, Stack Overflow, etc.)
- Productivity and SaaS: ~12 sites (Notion, Linear, Figma, Slack, etc.)
- Communication: ~5 sites
- AI tools: ~6 sites (ChatGPT, Claude, Gemini, Perplexity, etc.)
- Shopping: ~6 sites
- News and reading: ~8 sites
- Education: ~5 sites
- Travel: ~3 sites
- Finance: ~4 sites
- Media and music: ~4 sites
- Entertainment and games: ~4 sites
- Other major utilities: ~8 sites

Adjust as needed for accuracy. The point is breadth across the audience's 
actual browsing, not strict numerical quotas.

## Quality guidance

1. Use real domains. Do not invent or guess. If you're not certain a 
   specific subdomain exists for a real product, omit it rather than 
   hallucinate.

2. Domain matching is case-insensitive in the engine, but write all 
   domains in lowercase.

3. Regexes are JavaScript-compatible. Escape backslashes appropriately 
   for JSON (use \\\\ for a single backslash in regex).

4. Keep "id" values stable, short, and descriptive. They should never 
   change in future updates.

5. For "tool", use the common product name in kebab-case 
   (e.g., "google-docs", "github", "youtube-music").

6. Do not include adult sites, gambling sites, or sites whose primary 
   purpose is content the target user would not want categorized in their 
   organization tool. If such a site is in the global top 100, skip it.

7. Aim for the response to be approximately 8,000-15,000 tokens of JSON. 
   If you find yourself going significantly over, you are including too 
   much detail per site. If significantly under, you are missing coverage.

## Final check before output

Before producing your response, mentally verify:
- All categories used appear in the "categories" array
- All domains are lowercase, no protocol, no path
- All regex strings are valid JavaScript regex
- All path "extract" values are either numbers or {"query": "..."} objects
- No duplicate domain across different entries
- The output is valid JSON parseable by JSON.parse()

Now produce the taxonomy JSON. Output ONLY the JSON, nothing else.