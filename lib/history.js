// Historical coverage for any past date (before the local archive existed):
//  - Wikipedia "Current events" day pages: curated events, each citing one or more outlets
//  - Google News searches limited to the days around each event, to find other outlets' coverage
const { resolveSource, SOURCES } = require('./sources');
const { fetchGoogle, parseFeed, toItem } = require('./feeds');
const { entities } = require('./text');

const UA = 'VeritasNews/1.0 (local news verification app)';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const CATEGORY_TOPIC = [
  [/armed conflict|attack/i, 'conflict'], [/politic|election|international relations/i, 'politics'],
  [/business|econom/i, 'business'], [/health|environment/i, 'health'], [/science|technology/i, 'science'],
  [/sport/i, 'sports'], [/disaster|accident/i, 'climate'],
];

const cache = new Map(); // day -> { at, promise }
const dayOf = t => new Date(t).toISOString().slice(0, 10);

function clean(s) {
  return s.replace(/<!--[\s\S]*?-->/g, '').replace(/<ref[\s\S]*?(<\/ref>|\/>)/g, '').replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1').replace(/'{2,}/g, '').replace(/\s+/g, ' ').trim();
}

const pageTitle = day => { const [y, m, d] = day.split('-').map(Number); return `Portal:Current events/${y} ${MONTHS[m - 1]} ${d}`; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Wikipedia API call that backs off and retries when Wikipedia says "too many requests".
async function wikiApi(params, tries = 4) {
  const url = 'https://en.wikipedia.org/w/api.php?' + new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  for (let i = 0; ; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    const body = await res.text();
    if (res.ok) { try { return JSON.parse(body); } catch {} }
    if (i >= tries - 1) throw new Error(res.status === 429 || /too many requests/i.test(body) ? 'Wikipedia rate limit, try again in a minute' : `Wikipedia HTTP ${res.status}`);
    await sleep(Math.min(8000, (+res.headers.get('retry-after') || 0) * 1000 || 1000 * 2 ** i));
  }
}

// Fetch several day pages in ONE request (keeps us well under Wikipedia's rate limits).
async function fetchDays(days) {
  const json = await wikiApi({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: days.map(pageTitle).join('|') });
  const byTitle = new Map(((json.query && json.query.pages) || []).map(p => [p.title, p.missing ? '' : p.revisions[0].slots.main.content]));
  return new Map(days.map(d => [d, parseDay(d, byTitle.get(pageTitle(d)) || '')])); // missing page (e.g. today) => no events
}

function parseDay(day, wikitext) {
  const published = Date.parse(day + 'T12:00:00Z'); // day pages give no times; use midday UTC
  const items = [];
  let topic = 'world';
  const parents = [];
  const LINK = /\[(https?:\/\/[^\s\]]+)\s+\(([^)\]]+)\)\]/g;
  for (const raw of wikitext.split('\n')) {
    const cat = raw.match(/^'''([^']+)'''\s*$/);
    if (cat) { topic = (CATEGORY_TOPIC.find(([re]) => re.test(cat[1])) || [, 'world'])[1]; parents.length = 0; continue; }
    const m = raw.match(/^(\*+)\s*(.*)$/);
    if (!m) continue;
    const depth = m[1].length, content = m[2];
    const links = [...content.matchAll(LINK)];
    if (!links.length) { parents[depth] = clean(content); parents.length = depth + 1; continue; }
    const text = clean(content.replace(LINK, ''));
    if (text.length < 20) continue;
    const context = parents.slice(1, depth).filter(Boolean).join(' › ');
    // Headline = first sentence, or a word-boundary cut with an ellipsis.
    const stop = text.indexOf('. ');
    const headline = text.length <= 220 ? text : stop > 40 && stop < 220 ? text.slice(0, stop + 1) : text.slice(0, 220).replace(/\s+\S*$/, '') + '…';
    for (const [, url, name] of links) {
      const src = resolveSource(url, clean(name));
      if (!src) continue;
      items.push({ title: headline, description: (context ? context + ' — ' : '') + text, link: url, image: '',
        sourceId: src.id, topics: [topic], via: 'Wikipedia Current Events', published });
    }
  }
  return items;
}

// Events for each requested day: one { day, items } or { day, error } per day.
// Cached: past days are fetched once, recent days at most hourly.
async function currentEvents(days) {
  const fresh = d => { const hit = cache.get(d); return hit && (d < dayOf(Date.now() - 2 * 864e5) || Date.now() - hit.at < 3600e3); };
  const missing = days.filter(d => !fresh(d));
  if (missing.length) {
    const batch = fetchDays(missing);
    for (const d of missing) cache.set(d, { at: Date.now(), promise: batch.then(m => m.get(d)) });
    batch.catch(() => missing.forEach(d => cache.delete(d))); // failed days are retried next time
  }
  return Promise.all(days.map(d => cache.get(d).promise.then(items => ({ day: d, items }), e => ({ day: d, error: e.message }))));
}

// For the most notable events, search Google News within a few days of the event for more outlets.
async function corroborate(events, max = 10) {
  const seen = new Set();
  const picks = [];
  for (const ev of events.slice().sort((a, b) => b.published - a.published)) {
    const ents = [...new Set(entities(ev.title))].filter(e => e.length > 3).slice(0, 3);
    const key = ents.join('|');
    if (ents.length < 2 || seen.has(key)) continue;
    seen.add(key); picks.push({ ev, q: ents.map(e => `"${e}"`).join(' ') });
    if (picks.length >= max) break;
  }
  const results = await Promise.allSettled(picks.map(({ ev, q }) => {
    const after = dayOf(ev.published - 864e5), before = dayOf(ev.published + 2 * 864e5);
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} after:${after} before:${before}`)}&hl=en-US&gl=US&ceid=US:en`;
    return fetchGoogle(url, ev.topics, 'Google News (dated)');
  }));
  return { items: results.flatMap(r => (r.status === 'fulfilled' ? r.value.slice(0, 12) : [])), attempted: picks.length,
    failed: results.filter(r => r.status === 'rejected').length };
}

// ---------- Outlet front pages on that day, from the Wayback Machine ----------
// Every outlet feed Veritas follows, as archive.org saved it closest to (preferably before) `to`.
// archive.org throttles bursts hard, so: few requests at a time, polite retries, and a cache.
const wbCache = new Map(); // feedUrl|ts -> { at, promise }
const waybackTs = t => new Date(t).toISOString().replace(/[-:T]/g, '').slice(0, 14);
const parseTs = s => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12));

async function waybackGet(url, at) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`https://web.archive.org/web/${waybackTs(at)}id_/${url}`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000), redirect: 'follow' });
      if (res.ok) {
        const m = res.url.match(/\/web\/(\d{14})/);
        return { xml: await res.text(), snapshot: m ? parseTs(m[1]) : null };
      }
      if (res.status === 404) return null; // never archived
      if (![429, 502, 503, 504].includes(res.status) || i >= 2) throw new Error(`Wayback HTTP ${res.status}`);
    } catch (e) {
      if (i >= 2 || e.message.startsWith('Wayback HTTP')) throw e;
    }
    await sleep(3000 * (i + 1)); // archive.org asks clients to back off
  }
}

async function archivedFeed(source, feed, from, to) {
  const key = feed.url + '|' + waybackTs(to).slice(0, 10); // hourly granularity
  const hit = wbCache.get(key);
  if (hit) return hit.promise;
  const promise = (async () => {
    const take = got => (got ? parseFeed(got.xml).slice(0, 60).map(r => toItem(r, source, feed.topics, 'Wayback (outlet feed)'))
      .filter(i => i.published >= from && i.published <= to) : []);
    let got = await waybackGet(feed.url, to);
    let items = take(got);
    // Nearest copy was saved after the date and has nothing from the window? Look a bit earlier.
    if (!items.length && got && got.snapshot > to) { got = await waybackGet(feed.url, to - 2 * 864e5); items = take(got); }
    return { items, snapshot: got && got.snapshot };
  })();
  wbCache.set(key, { at: Date.now(), promise });
  promise.catch(() => wbCache.delete(key));
  while (wbCache.size > 3000) wbCache.delete(wbCache.keys().next().value);
  return promise;
}

// Waits at most `budgetMs`. Feeds still loading keep going in the background and land in the
// cache, so revisiting the date a minute later shows the rest.
async function archivedFeeds(from, to, { concurrency = 4, budgetMs = 40000 } = {}) {
  const jobs = SOURCES.flatMap(s => s.feeds.map(f => ({ s, f })));
  const items = [], errors = [], outlets = new Set();
  let next = 0, failStreak = 0, done = 0, timedOut = false;
  async function worker() {
    while (next < jobs.length) {
      const { s, f } = jobs[next++];
      if (failStreak >= 8) { errors.push({ feed: `${s.name} (Wayback)`, error: 'skipped: archive.org is throttling, try again shortly' }); done++; continue; }
      try {
        const r = await archivedFeed(s, f, from, to);
        failStreak = 0;
        if (!timedOut && r.items.length) { items.push(...r.items); outlets.add(s.id); }
      } catch (e) { failStreak++; if (!timedOut) errors.push({ feed: `${s.name} (Wayback)`, error: e.message }); }
      done++;
    }
  }
  const all = Promise.all(Array.from({ length: concurrency }, worker));
  await Promise.race([all, sleep(budgetMs)]);
  if (done < jobs.length) {
    timedOut = true;
    errors.push({ feed: 'Wayback outlet feeds', error: `${jobs.length - done} of ${jobs.length} still loading from archive.org (it is slow); refresh in a minute to include them` });
  }
  return { items: items.slice(), errors, attempted: jobs.length, outlets: outlets.size, partial: timedOut };
}

// Broad date-limited Google News searches: other outlets' coverage from those days.
const TOPIC_QUERIES = [['world news', 'world'], ['India', 'world'], ['politics', 'politics'], ['business economy', 'business'],
  ['technology', 'tech'], ['science', 'science'], ['health', 'health'], ['sports', 'sports'], ['climate', 'climate']];
async function datedTopics(from, to) {
  const after = dayOf(from), before = dayOf(to + 864e5);
  const results = await Promise.allSettled(TOPIC_QUERIES.map(([q, topic]) => fetchGoogle(
    `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} after:${after} before:${before}`)}&hl=en-US&gl=US&ceid=US:en`,
    [topic], 'Google News (dated)')));
  return { items: results.flatMap(r => (r.status === 'fulfilled' ? r.value.slice(0, 40) : [])), attempted: TOPIC_QUERIES.length,
    failed: results.filter(r => r.status === 'rejected').length };
}

module.exports = { currentEvents, corroborate, archivedFeeds, datedTopics, dayOf };
