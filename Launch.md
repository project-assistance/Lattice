Congratulations — getting to launch is genuinely hard, and most people who start don't. A few things worth doing before you press submit, organized by how much they'll actually protect you from bad outcomes.

## The things that will kill you if you skip them

These are non-negotiable. If any of these is missing or broken at launch, you're going to have a bad time.

**1. Test on machines that aren't yours.**

Your extension works on your machine. That's necessary but not sufficient. Test on:
- A machine with 8 GB RAM (Nano won't run — does your fallback work?)
- A machine that's never had Nano downloaded (does the download prompt appear correctly?)
- A machine with 200+ tabs open (does clustering complete? Does the extension crash?)
- A completely fresh Chrome profile (does first-run onboarding work?)
- Windows *and* Mac (assuming you've been developing on one, test the other)
- The latest Chrome stable *and* one or two versions back
- A machine with a slow CPU (does clustering feel painfully slow? Do you need to show progress?)

Real user machines are more varied than you expect. Bugs that only appear on machines unlike yours are the most common launch-day disasters.

**2. Run the taxonomy through real user data.**

Pull the URLs from your own current tabs, run them through the taxonomy engine, look at the results. Then do the same with 2-3 other people's tab lists (friends, colleagues, anyone who'll share). You'll almost certainly find missing sites, wrong categorizations, or path patterns that don't match reality. Fix these before shipping. Post-launch taxonomy fixes are fine, but you don't want your first 100 users to see nonsense clusters on the most common sites.

**3. Verify the manifest permissions are minimal and defensible.**

Look at every permission in your manifest.json and ask: do I actually need this? Every permission is friction at install and a target for reviewer scrutiny. Chrome's `tabs` permission is fine. Storage is fine. `activeTab` is fine. If you have `<all_urls>` or `webNavigation` or any of the scarier ones, be sure you truly need them and have a defensible answer for why.

Common permissions to double-check:
- `tabs` — nearly always needed
- `storage` — nearly always needed
- `offscreen` — needed for the embedding model
- `system.memory` — only if you're monitoring memory
- Anything else — question hard

**4. Handle the "nothing to show" states.**

What happens when:
- User installs and has zero tabs open besides Chrome Web Store? (probably won't happen, but...)
- User has only one or two tabs?
- Every tab is on chrome:// pages?
- All tabs are in one huge topic?
- All tabs are unrelated singletons?

Each of these needs a graceful UI, not a blank panel or an error. Empty states, near-empty states, and single-cluster states are commonly forgotten and universally noticed.

**5. Handle the error states.**

What happens when:
- Nano fails to load or crashes mid-generation
- The embedding model download fails (Transformers.js network hiccup)
- `chrome.storage.local` is full or throws
- A malformed URL breaks your parser
- A tab has no title
- The offscreen document dies unexpectedly
- The service worker gets killed in the middle of clustering

Each of these should degrade gracefully. The user should never see a broken UI or a spinning loader that never resolves. If clustering fails, show the tabs unclustered with an explanation. If naming fails, use heuristic names. Every part of the pipeline needs a fallback.

**6. Verify uninstall works cleanly.**

When users uninstall, `chrome.storage.local` should get wiped by Chrome automatically. But if you've written to disk anywhere else (unlikely for an extension), clean it up. Also: any users who reinstall should get the fresh-install experience, not stale state from their previous install.

## The things that will hurt but not kill

Important but recoverable. Ideally handle before launch, but if you have to launch without them, you can patch quickly.

**1. A meaningful onboarding flow.**

First-time users need to understand what they're seeing within 30 seconds. Not a five-slide tour — a single, elegant moment that explains "these are your tabs, organized into threads based on what you're doing." Then let them explore.

Bad onboarding: modal walls of text, forced tutorials, forms to fill out.
Good onboarding: one clear message, a single call to action, immediate value visible.

**2. Clear privacy disclosure at install.**

This matters enormously for your positioning. On first open, or in a prominent location:

> "Everything happens on your device. Your tabs, URLs, and content never leave your computer. The AI that names your groups runs locally in Chrome."

If you've opted into any cloud calls (I don't think you have, but if you did), disclose them clearly. This is the trust foundation your product is built on. Don't bury it in a privacy policy nobody reads.

**3. A clear settings page.**

Users will want to:
- Turn Nano naming on/off
- Adjust cluster granularity if you expose it
- See what memory the extension is using
- Reset all data
- Understand what the extension is doing

A minimal, honest settings page is a real trust builder. Skip the "advanced settings" trap; a curated few options are better than dozens.

**4. Feedback mechanism.**

Where do users go when something goes wrong? A "send feedback" button in the extension that opens an email link or a form is enough for v1. You need to hear from users when things break, and they need somewhere to send that.

**5. Store listing that actually sells.**

The Chrome Web Store listing is your acquisition surface. It needs:
- A one-line pitch that resonates with your target user
- Screenshots showing the product in action (at least 3, ideally with realistic-looking tab clusters)
- A short video if you can make one (5-15 seconds of "chaos becomes order")
- A clear "what this does" description
- Honest permissions justification
- A privacy policy link (Chrome requires this)

Sloppy store listings kill install rates. Spend a day on this specifically.

**6. Handle the Nano download messaging.**

We covered this in detail — don't block the product on it, make it opt-in, frame it as Chrome's feature not yours. But specifically for launch: verify that a user who installs your extension without Nano already downloaded sees a reasonable experience. Test this end to end with a fresh profile.

## The things that separate a good launch from a great one

If you have time, these are worth doing. If not, they can wait a few weeks post-launch.

**1. Instrument what you need to see, respecting privacy.**

You need to know:
- How many users install
- How many complete first use
- How many still use the extension after a week
- What common failure modes look like
- How the memory usage trends in real user hardware

This can all be done with local logs users can share via a "diagnostic report" button, without any real telemetry. For a privacy-first product, avoid analytics services. Roll your own minimal error reporting if you must, and be transparent about what you collect.

An alternative: don't collect anything programmatically, and rely on feedback + reviews for signal. This is a legitimate choice that matches your positioning.

**2. Prepare for the first review.**

Chrome Web Store reviews will happen quickly once you have users. Some will be angry. Some will be unfair. Respond thoughtfully and quickly. A responsive developer with visible activity on reviews signals quality to future browsers of the listing.

Have a plan for how you'll monitor and respond. Set expectations for yourself about response time. Don't let the first bad review send you into a spiral — it happens to everyone.

**3. Have a launch narrative.**

Where do the first 100 users come from? Not "we'll see." Have an intentional answer:

- Post on Hacker News? Do it Thursday morning US time. Prepare the post carefully. Show, don't tell.
- Product Hunt launch? Requires prep — teaser, hunter, timing.
- Reddit? Which subreddits will actually welcome this? r/chrome_extensions, r/productivity, r/artificial? Read their rules, don't spam.
- Your own network? Send an email to friends who fit the target user.
- A blog post explaining why you built it? Genuinely useful for people who arrive via search.

Even if you're informal about launch, having a plan multiplies your odds.

**4. Set up a landing page.**

Even a simple one. Something to link from HN comments, Reddit posts, Twitter. Include: what it does, screenshots, the privacy angle, install button, way to contact you. Doesn't need to be fancy. Does need to exist.

The Chrome Web Store listing isn't a great landing page — it's a store page. A dedicated landing page lets you tell the story your way.

**5. Prepare for the questions.**

You'll get asked, publicly and privately:
- "How is this different from Arc / OneTab / Workona / Toby?"
- "Does this send data anywhere?"
- "Why does it need 2 GB for AI?"
- "Will it work in Firefox / Safari / Edge?"
- "Is this open source?"
- "How do you make money?"
- "What's your privacy policy?"

Have clear, honest answers ready. If you don't know the answer to one (like "how will I make money"), that's fine — say so honestly. Users often appreciate "I don't know yet" more than corporate hedging.

**6. Rehearse the "I don't like it" scenario.**

Some users will hate it. Some will leave one-star reviews with genuine criticism, some with unfair criticism, some with nonsense. This is genuinely hard emotionally, especially for solo builders shipping their first thing.

Prepare yourself. Know that: (a) the first weeks are noisier than steady state, (b) angry users are overrepresented in reviews vs. happy users, (c) most feedback contains a grain of truth even if delivered rudely, and (d) your job is to filter for signal, not to respond to noise.

Have someone you trust to talk to about the feedback. Solo launches without a sounding board are harder than they need to be.

## The things you shouldn't worry about for launch

Just as important as knowing what to do is knowing what to skip.

**Don't try to solve every edge case.** Ship the 80% and let real users tell you what the important 20% is. You'll spend forever trying to imagine edge cases; you'll find them faster by launching.

**Don't over-polish.** There's a real diminishing return to polishing before launch. At some point you're just delaying the feedback that would tell you what's actually worth polishing.

**Don't scale prep.** You do not need infrastructure for a million users on day one. You need infrastructure for the users you actually have, which is zero, becoming twenty, becoming a hundred if things go well. Chrome Web Store handles most of the scaling for you.

**Don't add "one more feature."** Whatever you're tempted to add right before launch is almost never the feature that would have mattered. Ship, learn, iterate.

**Don't monetize yet.** Free until you have real signal about what users value. Adding pricing at launch shrinks your funnel and doesn't teach you anything.

**Don't obsess over the landing page.** Good enough is fine. Ship it, watch what people do, iterate.

## Two specific technical checks worth doing

Since you've been building this for a while, two things you might have grown blind to:

**1. Fresh install experience test.**

Set up a completely fresh Chrome profile. Install your extension from a local copy (using Developer mode → Load unpacked). Use it for 10 minutes as a first-time user would. Note everything that's confusing, broken, or missing.

You'll find things. Every developer does. Fix the obvious ones before launch.

**2. Uninstall test.**

Install the extension. Use it for a bit. Uninstall it. Reinstall it. Does state get properly reset? Does onboarding show again? Does anything feel weird? Confusion here at reinstall is a common source of "this extension is broken" reviews.

## The soft stuff that matters more than you'd expect

**1. Take care of yourself.**

Launches are stressful. Sleep matters. So does not checking reviews at 2am. Set boundaries. The extension will still be there tomorrow.

**2. Have a person to celebrate with.**

Someone who understands what you built and can share the moment. Solo shipping is lonely without this.

**3. Write down why you built it.**

Not for public consumption necessarily. For yourself. When the first bad review lands, or when installs stall, or when someone in a comment thread says something dismissive, you'll want to remember why you started. Write it before launch, when you're clear-headed.

**4. Give it time to breathe.**

Extensions rarely explode overnight. If you launch and get 50 users in the first week, that's fine. If you get 5, that's also fine. If you get 500, that's great. None of these numbers tells you whether the product is good yet. Real signal takes weeks — do users come back? Do they tell others? Do they leave the extension installed?

Don't panic in the first days. Don't declare victory or defeat prematurely. Let it breathe.

## A pre-launch checklist you can actually use

If it helps to have a list to run through:

Technical:
- [ ] Tested on Mac, Windows, and various hardware profiles
- [ ] Tested on fresh Chrome profile with no Nano download
- [ ] Tested with 5, 50, 200 tabs
- [ ] All error states handled gracefully
- [ ] All empty states handled gracefully
- [ ] Uninstall/reinstall works cleanly
- [ ] Manifest permissions are minimal and justified
- [ ] Extension package is under a reasonable size
- [ ] No console errors in normal operation
- [ ] Service worker doesn't die during critical operations
- [ ] Taxonomy tested against real tab data

Product:
- [ ] Onboarding is minimal and clear
- [ ] Settings page exists and works
- [ ] Feedback mechanism exists
- [ ] Privacy disclosure is prominent
- [ ] Nano download is opt-in and non-blocking
- [ ] Empty states have clear messaging
- [ ] Common failure modes have clear messaging

Launch:
- [ ] Chrome Web Store listing is written and reviewed
- [ ] Screenshots show product realistically
- [ ] Privacy policy exists and is linked
- [ ] Landing page exists (even minimal)
- [ ] Launch venues identified
- [ ] Prepared answers for common questions
- [ ] Sounding board identified for feedback processing
- [ ] Personal support plan for stressful moments

## The most important thing

Ship it. Not perfect, not complete, not answering every possible question — but shipped.

Every day it doesn't ship is a day you don't learn what real users think. Every polish you add is a delay in getting real feedback. Every anxiety about a corner case is anxiety about a hypothetical user; the real ones are just as important and more informative.

You've done the hard part — you've built a product that solves a real problem for a real user type, based on thoughtful architecture and clear positioning. The remaining work is smaller than the work behind you. Trust that.

There's a specific kind of clarity that only comes after launch. You can't get to it by preparing more. You can only get to it by shipping and paying attention. So: prepare the important things, skip the rest, and go.

Good luck with the launch. This has been a genuinely thoughtful process — the extension is going to be better than most because you've thought hard about the right things at the right times. That shows in the product.