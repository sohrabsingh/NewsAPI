// Veritas — cross-verified news. Zero-dependency Node server (Node 18+).
const http = require('http');
const fs = require('fs');
const path = require('path');

// Load secrets from .env (git-ignored; see .env.example). Real environment variables win.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const { fetchAll, fetchSearch, fetchArticleText, fetchWaybackText, finish } = require('./lib/feeds');
const { clusterItems, analyzeTexts, sourceStats } = require('./lib/analyze');
const { getSource, allSources } = require('./lib/sources');
const { profile } = require('./lib/wiki');
const { tokens } = require('./lib/text');
const health = require('./lib/health');
const archive = require('./lib/archive');
const history = require('./lib/history');

const PORT = +process.env.PORT || 3000;
const FRESH_MS = 10 * 60e3;
const WINDOW = { headlines: 4 * 864e5, search: 7 * 864e5 }; // how far back an edition looks

const editions = new Map(); // "query|asOf" -> { at, promise }
const stories = new Map();  // story id -> story (from any edition)
let baseItems = [];
let latestStats = {};

archive.init();

const matchesQuery = q => {
  const qt = tokens(q);
  return i => { const t = new Set(tokens(i.title + ' ' + i.description)); return qt.every(x => t.has(x)); };
};

// Live edition: fetch everything now, and archive it for future time travel.
async function fetchLive(q) {
  if (!q) {
    const fetched = await fetchAll();
    baseItems = fetched.items;
    health.record(fetched.checks);
    archive.add(fetched.items, getSource);
    return fetched;
  }
  const fetched = await fetchSearch(q);
  archive.add(fetched.items, getSource);
  // Mix in already-fetched outlet items that mention the query.
  const ids = new Set(fetched.items.map(i => i.id));
  fetched.items.push(...baseItems.filter(matchesQuery(q)).filter(i => !ids.has(i.id)));
  return fetched;
}

// Past edition: only articles published in the window before `asOf` — as the news looked then.
async function fetchPast(q, asOf) {
  const from = asOf - (q ? WINDOW.search : WINDOW.headlines), to = asOf;
  let archived = archive.read(from, to);
  const days = [];
  for (let t = Date.parse(history.dayOf(from)); t <= to; t += 864e5) days.push(history.dayOf(t));
  // Fetched fresh from the internet for that date, all in parallel:
  //  - every outlet's own feed as the Wayback Machine saved it then (the real front pages)
  //  - Wikipedia's record of each day's events, with the outlets it cites
  //  - date-limited Google News searches (by topic, or for your search terms)
  const [pages, wayback, dated] = await Promise.all([
    history.currentEvents(days),
    history.archivedFeeds(from, to),
    q ? fetchSearch(q, { from, to }) : history.datedTopics(from, to),
  ]);
  let events = pages.flatMap(p => p.items || []).filter(i => i.published >= from && i.published <= to);
  let frontPages = wayback.items;
  const errors = [...pages.filter(p => p.error).map(p => ({ feed: `Wikipedia Current events ${p.day}`, error: p.error })), ...wayback.errors];
  let extra = dated.items;
  if (q) {
    const match = matchesQuery(q);
    archived = archived.filter(match); events = events.filter(match); frontPages = frontPages.filter(match);
    errors.push(...dated.errors);
  } else {
    if (dated.failed) errors.push({ feed: 'Google News (dated topics)', error: `${dated.failed} of ${dated.attempted} searches failed` });
    const c = await history.corroborate(events); // look for more outlets covering Wikipedia's events
    extra = extra.concat(c.items);
    if (c.failed) errors.push({ feed: 'Google News (dated events)', error: `${c.failed} of ${c.attempted} searches failed` });
  }
  const items = finish([...frontPages, ...events, ...archived, ...extra], from, to);
  return { items, errors, attempted: days.length + wayback.attempted + dated.attempted + 1,
    coverage: { partial: wayback.partial, archived: archived.length, frontPages: frontPages.length, frontPageOutlets: wayback.outlets, wikipedia: events.length, dated: extra.length, from, to } };
}

async function buildEdition(q, asOf) {
  const fetched = asOf ? await fetchPast(q, asOf) : await fetchLive(q);
  const t0 = Date.now();
  const { clusters } = clusterItems(fetched.items);
  for (const s of clusters) { s.asOf = asOf || null; stories.set(s.id, s); }
  while (stories.size > 20000) stories.delete(stories.keys().next().value); // bounded memory
  const stats = sourceStats(clusters);
  if (!q && !asOf) latestStats = stats;
  const reachable = fetched.attempted - fetched.errors.length;
  const label = [q && `"${q}"`, asOf && `as of ${new Date(asOf).toISOString()}`].filter(Boolean).join(' ');
  console.log(`[edition${label ? ' ' + label : ''}] ${fetched.items.length} articles -> ${clusters.length} stories in ${Date.now() - t0}ms; ${reachable}/${fetched.attempted} sources ok`);
  return { generatedAt: Date.now(), asOf: asOf || null, query: q || null, stories: clusters, stats,
    coverage: fetched.coverage || null, feeds: { attempted: fetched.attempted, ok: reachable, errors: fetched.errors } };
}

// asOf: a past moment (ms). Missing, invalid, or within the last minute means "live".
function parseAsOf(v) {
  const t = Number(v) || Date.parse(v || '');
  if (!Number.isFinite(t) || t > Date.now() - 60e3) return null;
  return Math.max(t, Date.parse('2000-01-01'));
}

function edition(q, asOf, force) {
  q = (q || '').trim().toLowerCase();
  const key = `${q}|${asOf || ''}`;
  const hit = editions.get(key);
  const ttl = asOf && asOf < Date.now() - WINDOW.search ? 6 * 3600e3 : FRESH_MS; // the distant past rarely changes
  if (hit && !force && Date.now() - hit.at < (hit.ttl || ttl)) return hit.promise;
  const promise = buildEdition(q, asOf).catch(e => { editions.delete(key); throw e; });
  editions.delete(key);
  const entry = { at: Date.now(), promise };
  editions.set(key, entry);
  // Partly loaded past dates (archive.org still sending) are rebuilt after a minute.
  promise.then(ed => { if (ed.coverage && ed.coverage.partial) entry.ttl = 60e3; }, () => {});
  while (editions.size > 40) editions.delete(editions.keys().next().value);
  return promise;
}

function sourcePayload(ids, stats = latestStats) {
  const out = {};
  for (const id of ids) {
    const s = getSource(id);
    if (!s) continue;
    const { feeds, ...rest } = s;
    out[id] = { ...rest, live: stats[id] || null };
  }
  return out;
}

const deepCache = new Map();
async function deepVerify(story) {
  if (deepCache.has(story.id + '|' + story.asOf)) return deepCache.get(story.id + '|' + story.asOf);
  if (story.asOf) return deepVerifyPast(story);
  // One article per outlet; Google News links are redirect wrappers we can't read server-side.
  const picks = [];
  const seen = new Set();
  for (const it of story.items) {
    if (seen.has(it.sourceId) || /news\.google\.com/.test(it.link)) continue;
    seen.add(it.sourceId); picks.push(it);
    if (picks.length >= 10) break;
  }
  const results = await Promise.all(picks.map(async it => {
    try {
      const text = await fetchArticleText(it.link);
      return { sourceId: it.sourceId, title: it.title, text: text || it.description, fetched: text.length > 200 ? 'full' : 'summary only (page blocked or paywalled)' };
    } catch (e) {
      return { sourceId: it.sourceId, title: it.title, text: it.description, fetched: `summary only (${e.message})` };
    }
  }));
  // Outlets we couldn't open still contribute their headline/summary.
  for (const it of story.items) if (!seen.has(it.sourceId)) { seen.add(it.sourceId); results.push({ sourceId: it.sourceId, title: it.title, text: it.title + '. ' + it.description, fetched: 'headline only (aggregator link)' }); }
  const analysis = analyzeTexts(results);
  const out = { storyId: story.id, analysis, fetch: results.map(r => ({ sourceId: r.sourceId, status: r.fetched, chars: (r.text || '').length })) };
  deepCache.set(story.id + '|' + story.asOf, out);
  return out;
}

// Time travel: read each article as the Wayback Machine saved it near the chosen date,
// so later edits and corrections don't leak into the past.
async function deepVerifyPast(story) {
  const day = t => new Date(t).toISOString().slice(0, 10);
  const picks = [], seen = new Set();
  for (const it of story.items) {
    if (seen.has(it.sourceId) || /news\.google\.com/.test(it.link)) continue;
    seen.add(it.sourceId); picks.push(it);
    if (picks.length >= 8) break; // the Wayback Machine is slow; keep it reasonable
  }
  const results = await Promise.all(picks.map(async it => {
    const base = { sourceId: it.sourceId, title: it.title };
    try {
      const { text, snapshot } = await fetchWaybackText(it.link, story.asOf);
      if (text.length > 200) {
        const late = snapshot && snapshot > story.asOf + 2 * 864e5;
        return { ...base, text, fetched: `archived copy from ${snapshot ? day(snapshot) : '?'}${late ? ' (saved after your date, may include later edits)' : ''}` };
      }
    } catch {}
    try {
      const text = await fetchArticleText(it.link);
      if (text.length > 200) return { ...base, text, fetched: 'no archived copy; used the current page (may have been edited since)' };
    } catch {}
    return { ...base, text: it.title + '. ' + it.description, fetched: 'summary only (no archived or live copy readable)' };
  }));
  for (const it of story.items) if (!seen.has(it.sourceId)) { seen.add(it.sourceId); results.push({ sourceId: it.sourceId, title: it.title, text: it.title + '. ' + it.description, fetched: 'headline only (aggregator link)' }); }
  const out = { storyId: story.id, asOf: story.asOf, analysis: analyzeTexts(results), fetch: results.map(r => ({ sourceId: r.sourceId, status: r.fetched, chars: (r.text || '').length })) };
  deepCache.set(story.id + '|' + story.asOf, out);
  return out;
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const PUBLIC = path.join(__dirname, 'public');

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/api/news') {
      const ed = await edition(url.searchParams.get('q'), parseAsOf(url.searchParams.get('asOf')), url.searchParams.get('refresh') === '1');
      const ids = new Set(ed.stories.flatMap(s => s.sources));
      const { stats, ...rest } = ed;
      return send(res, 200, { ...rest, outlets: sourcePayload(ids, stats) });
    }
    if (p === '/api/archive') return send(res, 200, archive.stats());
    let m;
    if ((m = p.match(/^\/api\/story\/([\w-]+)\/deep$/))) {
      const story = stories.get(m[1]);
      if (!story) return send(res, 404, { error: 'Story expired — refresh the feed.' });
      return send(res, 200, await deepVerify(story));
    }
    if (p === '/api/entity') {
      const name = (url.searchParams.get('name') || '').slice(0, 120);
      if (!name) return send(res, 400, { error: 'name required' });
      return send(res, 200, await profile(name, url.searchParams.get('context') || ''));
    }
    if ((m = p.match(/^\/api\/outlet\/(.+)$/))) {
      const id = decodeURIComponent(m[1]);
      const s = getSource(id);
      if (!s) return send(res, 404, { error: 'unknown outlet' });
      const prof = s.wiki ? await profile(s.wiki).catch(() => null) : null;
      return send(res, 200, { outlet: sourcePayload([id])[id], profile: prof });
    }
    if (p === '/api/health') return send(res, 200, health.report());
    if (p === '/api/outlets') return send(res, 200, sourcePayload(allSources().map(s => s.id)));

    // static files
    const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
    if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      // no-cache: the browser re-checks on every load, so updates show up without a hard refresh.
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

// Run file: lets start.bat find the running app and stop.bat shut down exactly this process.
const RUN_FILE = path.join(__dirname, 'data', 'server.json');
function clearRunFile() {
  try { if (JSON.parse(fs.readFileSync(RUN_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(RUN_FILE); } catch {}
}
process.on('exit', clearRunFile);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(0));

server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use — is Veritas already running? Run stop.bat first, or set PORT in .env.` : e.message);
  process.exit(1);
});

server.listen(PORT, () => {
  fs.mkdirSync(path.dirname(RUN_FILE), { recursive: true });
  fs.writeFileSync(RUN_FILE, JSON.stringify({ pid: process.pid, port: PORT, started: new Date().toISOString() }));
  console.log(`Veritas running at http://localhost:${PORT}`);
  console.log(process.env.NEWSAPI_KEY ? 'NewsAPI: enabled' : 'NewsAPI: disabled (set NEWSAPI_KEY to add it as a source)');
  edition('').catch(e => console.error('initial fetch failed:', e.message)); // warm the cache
});
