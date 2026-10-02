# Veritas: cross-verified news

Veritas pulls news from 40+ outlets: public broadcasters, newspapers, independent media, state media and fact-checkers, plus Google News, GDELT and NewsAPI if you add a key. It groups articles about the same event into one story and checks how many **independent owners** report it. Each story shows its claims, theories, the people involved and the background of every outlet carrying it.

**Windows, one click:** double-click **`start.bat`**. It starts Veritas in the background with no window and opens it in your browser. Double-click **`stop.bat`** to shut it down completely; it stops only Veritas, never your other Node programs.

**Any OS, from a terminal:**
```bash
npm start            # or: node server.js   (Node 18+, no dependencies)
# open http://localhost:3000
```

Optional: copy `.env.example` to `.env` and fill in your keys. `.env` is git-ignored, and both `server.js` and `ss.py` read it automatically. Adding `NEWSAPI_KEY` brings in NewsAPI as another source. `PORT=8080` changes the port.

## What you get

| Feature | How it works |
|---|---|
| **Cross-verification score** | Articles are grouped by TF-IDF and named-entity similarity. Outlets with the same owner count as **one voice** (Fox + WSJ = Murdoch; ABC + ESPN = Disney). The score rises with the number of independent owners and their reliability. It also gets a bonus when the outlets span different countries and political leanings. A story carried by only one owner is capped at 35. A story carried only by state media is capped at 15. |
| **Status** | Verified (3+ owners with a high score) · Corroborated (2+ owners) · Single source · Contested (a fact-checker is involved, or 2+ owners use dispute language) |
| **Claims** | Sentences that state a fact are matched across outlets. Each one is marked corroborated, single-source, unconfirmed (hedged wording) or disputed. If outlets give **different numbers** for the same claim, the claim is flagged. |
| **Theories & angles** | Lists allegations, "reportedly"-style speculation and dispute language. It also shows which leanings are covering the story (and which are missing), and the words each outlet uses that no other outlet does. |
| **People & entities** | Profiles from Wikipedia and Wikidata: birth, positions held, party, education, employer, ownership. Also pulls each article's **Controversies / Criticism / Legal** sections, labelled as the "skeptic's view". |
| **Outlet scrutiny** | Owner, ultimate group, funding, country, leaning, curated reliability and a **live corroboration rate** (how often other owners report the same stories). Also pulls the outlet's own controversy sections from Wikipedia. |
| **Divergence view (ON/OFF toggle)** | Shows where each outlet's account matches the shared story ("on") and where it departs from it ("off"):<br>• a timeline of when each outlet picked up the story<br>• a claim-by-outlet grid: states it / covers the same facts / disputes it / silent<br>• each outlet's text, highlighted green when another independent owner echoes it and amber when only that outlet says it |
| **Deep verify** | Downloads each outlet's full article and runs the cross-check again on the complete text. Paywalled or blocked pages fall back to the summary. |
| **Preferences** | Topics, regions, followed keywords and people, blocked keywords, minimum verification level, sort order, a boost for independent media, a filter that hides stories carried only by state media, and muted outlets. Preferences are saved in your browser. |

## Files

- `lib/sources.js`: the outlet database (feeds, owners, funding, leaning, reliability, notes). **The reliability numbers are editorial starting estimates**, so adjust them to your own judgement. In the app they are blended 70/30 with the live corroboration rate.
- `lib/feeds.js`: reads RSS/Atom feeds and the Google News, GDELT and NewsAPI sources, and extracts article text.
- `lib/analyze.js`: story grouping, scoring, claim matching, divergence and angles.
- `lib/wiki.js`: Wikipedia and Wikidata profiles and controversy sections (cached for 24 hours).
- `server.js`: API (`/api/news?q=`, `/api/story/:id/deep`, `/api/entity?name=`, `/api/outlet/:id`, `/api/outlets`) and static files.
- `public/`: the interface. Link to a single story with `/#story=<id>&diverge=1&tab=claims`.

## Limits (read before trusting it)

- Matching is statistical, not semantic. Two outlets "agreeing" means they report the same facts and wording, not that the facts are true. Coordinated or copied wire copy can inflate agreement.
- People profiles are matched **by name**, so a common name can resolve to the wrong person. Every card links to its source so you can check.
- Many feeds carry only headlines and summaries. Use Deep verify for full-text claims.
- GDELT rate-limits heavily (HTTP 429). When that happens, search uses Google News instead.
