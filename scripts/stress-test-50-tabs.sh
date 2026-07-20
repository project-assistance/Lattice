#!/usr/bin/env bash
#
# stress-test-50-tabs.sh
#
# Opens a fresh Chrome window and populates it with 50 real tabs spanning
# ~9 semantically distinct topics plus a batch of one-off "noise" tabs.
# Built to stress-test Lattice's clustering pipeline (agglomerative
# clustering over MiniLM embeddings + taxonomy signals) with something
# closer to a real tab-hoarder's window than a synthetic dataset.
#
# Usage:
#   ./scripts/stress-test-50-tabs.sh
#
# What to expect / how to use this for a demo:
#   1. Run the script. A new Chrome window opens and tabs load one every
#      ~0.35s (deliberately staggered so it reads well on screen recording).
#   2. Open Lattice (popup or side panel) and click "Organize".
#   3. Expect roughly 8-9 named clusters (see groups below) plus an
#      "Ungrouped" bucket holding the noise tabs (~10) that don't share
#      strong semantic overlap with anything else, plus any near-miss
#      one-timers the model doesn't confidently attach to a real cluster.
#   4. Good narration beats for a demo:
#        - The "React / frontend debugging" group spans 6 different
#          domains (GitHub, Stack Overflow, MDN, npm, YouTube, Medium) —
#          shows clustering is semantic, not just "same domain."
#        - The AI/LLM research group mixes chat tools (ChatGPT, Claude)
#          with a paper (arXiv) and a model hub (Hugging Face).
#        - Zillow and Craigslist are NOT in Lattice's taxonomy (~119
#          known sites) — watch whether the embedding model still finds
#          the apartment-hunting semantic connection to Airbnb/Booking,
#          or whether it lands in Ungrouped. Either outcome is a good
#          talking point about taxonomy-assisted vs. pure-embedding signal.
#        - Try "Pin to Chrome" on 2-3 clusters, drag a tab between
#          clusters, then reopen the popup to show reconciliation holding
#          up.
#
# Requires macOS + Google Chrome. Uses AppleScript (osascript) to drive
# Chrome directly rather than shelling out 50 times to `open`, so tabs
# land in one dedicated window instead of scattering across whatever
# Chrome windows are already open.

set -euo pipefail

DELAY="${STRESS_TEST_DELAY:-0.35}"

# --- Group 1: React / frontend debugging (6 tabs) --------------------------
# Same task ("debugging a React hooks issue"), 6 different domains.
GROUP_REACT=(
  "https://github.com/facebook/react/issues/12345"
  "https://stackoverflow.com/questions/tagged/react-hooks"
  "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API"
  "https://www.npmjs.com/package/@tanstack/react-query"
  "https://www.youtube.com/watch?v=TNhaISOUy6Q"
  "https://medium.com/tag/react"
)

# --- Group 2: AI / LLM research (5 tabs) ------------------------------------
GROUP_AI=(
  "https://openai.com/chatgpt/"
  "https://www.anthropic.com/claude"
  "https://arxiv.org/abs/1706.03762"
  "https://huggingface.co/models?pipeline_tag=text-generation"
  "https://www.perplexity.ai/search?q=retrieval-augmented-generation"
)

# --- Group 3: Job hunting / career (4 tabs) ---------------------------------
GROUP_JOBS=(
  "https://www.glassdoor.com/Job/index.htm"
  "https://www.indeed.com/jobs?q=frontend+engineer"
  "https://boards.greenhouse.io/anthropic"
  "https://www.workday.com/en-us/homepage.html"
)

# --- Group 4: Apartment hunting / travel (3 tabs, deliberately small) ------
# Zillow/Craigslist below (noise section) are the same *task* but outside
# Lattice's taxonomy — a good test of pure-embedding semantic clustering.
GROUP_TRAVEL=(
  "https://www.airbnb.com/s/San-Francisco--CA"
  "https://www.booking.com/searchresults.html?city=san-francisco"
  "https://maps.google.com/maps?q=san+francisco+apartments"
)

# --- Group 5: Home-office shopping (5 tabs) ---------------------------------
GROUP_SHOPPING=(
  "https://www.amazon.com/s?k=standing+desk"
  "https://www.amazon.com/s?k=4k+monitor"
  "https://www.ebay.com/sch/i.html?_nkw=mechanical+keyboard"
  "https://www.etsy.com/search?q=desk+mat"
  "https://www.bestbuy.com/site/searchpage.jsp?st=webcam"
)

# --- Group 6: News / current events (5 tabs) --------------------------------
GROUP_NEWS=(
  "https://www.nytimes.com/section/technology"
  "https://www.theguardian.com/world"
  "https://www.bbc.com/news"
  "https://arstechnica.com/gadgets/"
  "https://www.theverge.com/tech"
)

# --- Group 7: Work / project management tools (5 tabs) ----------------------
GROUP_WORK=(
  "https://www.notion.so"
  "https://linear.app"
  "https://www.atlassian.com/software/jira"
  "https://slack.com"
  "https://trello.com"
)

# --- Group 8: Entertainment / streaming (4 tabs) ----------------------------
GROUP_ENTERTAINMENT=(
  "https://www.netflix.com"
  "https://www.twitch.tv/directory"
  "https://www.spotify.com"
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
)

# --- Group 9: Finance (3 tabs) -----------------------------------------------
GROUP_FINANCE=(
  "https://www.coinbase.com/price"
  "https://www.paypal.com"
  "https://stripe.com/docs"
)

# --- Noise: one-off tabs with no strong shared topic (10 tabs) -------------
# Includes two domains (Zillow, Craigslist) NOT in taxonomy.json's ~119
# known sites, to test the embedding model's fallback behavior.
GROUP_NOISE=(
  "https://en.wikipedia.org/wiki/Special_relativity"
  "https://www.duolingo.com"
  "https://www.chess.com"
  "https://www.goodreads.com/book/show/11"
  "https://www.imdb.com/title/tt0111161/"
  "https://translate.google.com/?sl=en&tl=es"
  "https://www.dropbox.com"
  "https://substack.com"
  "https://www.zillow.com/homes/San-Francisco-CA_rb/"
  "https://sfbay.craigslist.org/search/fua"
)

ALL_TABS=(
  "${GROUP_REACT[@]}"
  "${GROUP_AI[@]}"
  "${GROUP_JOBS[@]}"
  "${GROUP_TRAVEL[@]}"
  "${GROUP_SHOPPING[@]}"
  "${GROUP_NEWS[@]}"
  "${GROUP_WORK[@]}"
  "${GROUP_ENTERTAINMENT[@]}"
  "${GROUP_FINANCE[@]}"
  "${GROUP_NOISE[@]}"
)

echo "Lattice stress test: opening ${#ALL_TABS[@]} tabs across 9 topic groups + noise."

# Open (or focus) Chrome and create one dedicated new window to hold the test.
osascript -e 'tell application "Google Chrome" to activate' \
          -e 'tell application "Google Chrome" to make new window'

count=0
for url in "${ALL_TABS[@]}"; do
  count=$((count + 1))
  printf "  [%2d/%d] %s\n" "$count" "${#ALL_TABS[@]}" "$url"

  if [ "$count" -eq 1 ]; then
    # First tab: reuse the blank tab the new window opened with.
    osascript -e "tell application \"Google Chrome\" to set URL of active tab of front window to \"$url\""
  else
    osascript -e "tell application \"Google Chrome\" to tell front window to make new tab with properties {URL:\"$url\"}"
  fi

  sleep "$DELAY"
done

echo "Done. ${#ALL_TABS[@]} tabs opened in a new Chrome window — open Lattice and click Organize."
