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

const { fetchAll, fetchSearch, fetchArticleText } = require('./lib/feeds');
const { clusterItems, analyzeTexts, sourceStats } = require('./lib/analyze');
const { getSource, allSources } = require('./lib/sources');
const { profile } = require('./lib/wiki');
const { tokens } = require('./lib/text');
const health = require('./lib/health');

const PORT = +process.env.PORT || 3000;
const FRESH_MS = 10 * 60e3;

const editions = new Map(); // key ('' or query) -> { at, promise }
const stories = new Map();  // story id -> story (from any edition)
let baseItems = [];
let latestStats = {};

async function buildEdition(q) {
  let fetched;
  if (!q) {
    fetched = await fetchAll();
    baseItems = fetched.items;
    health.record(fetched.checks);
  } else {
    fetched = await fetchSearch(q);
    // Mix in already-fetched outlet items that mention the query.
    const qt = tokens(q);
    const local = baseItems.filter(i => { const t = new Set(tokens(i.title + ' ' + i.description)); return qt.every(x => t.has(x)); });
    const ids = new Set(fetched.items.map(i => i.id));
    fetched.items.push(...local.filter(i => !ids.has(i.id)));
  }
  const t0 = Date.now();
  const { clusters } = clusterItems(fetched.items);
  for (const s of clusters) stories.set(s.id, s);
  if (!q) latestStats = sourceStats(clusters);
  const reachable = fetched.attempted - fetched.errors.length;
  console.log(`[edition${q ? ' "' + q + '"' : ''}] ${fetched.items.length} articles -> ${clusters.length} stories in ${Date.now() - t0}ms; ${reachable}/${fetched.attempted} feeds ok`);
  return { generatedAt: Date.now(), query: q || null, stories: clusters, feeds: { attempted: fetched.attempted, ok: reachable, errors: fetched.errors } };
}

function edition(q, force) {
  const key = (q || '').trim().toLowerCase();
  const hit = editions.get(key);
  if (hit && !force && Date.now() - hit.at < FRESH_MS) return hit.promise;
  const promise = buildEdition(key).catch(e => { editions.delete(key); throw e; });
  editions.set(key, { at: Date.now(), promise });
  return promise;
}

function sourcePayload(ids) {
  const out = {};
  for (const id of ids) {
    const s = getSource(id);
    if (!s) continue;
    const { feeds, ...rest } = s;
    out[id] = { ...rest, live: latestStats[id] || null };
  }
  return out;
}

const deepCache = new Map();
async function deepVerify(story) {
  if (deepCache.has(story.id)) return deepCache.get(story.id);
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
  deepCache.set(story.id, out);
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
      const ed = await edition(url.searchParams.get('q'), url.searchParams.get('refresh') === '1');
      const ids = new Set(ed.stories.flatMap(s => s.sources));
      return send(res, 200, { ...ed, outlets: sourcePayload(ids) });
    }
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
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Veritas running at http://localhost:${PORT}`);
  console.log(process.env.NEWSAPI_KEY ? 'NewsAPI: enabled' : 'NewsAPI: disabled (set NEWSAPI_KEY to add it as a source)');
  edition('').catch(e => console.error('initial fetch failed:', e.message)); // warm the cache
});
