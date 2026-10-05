// Fetches RSS/Atom feeds, Google News, optional NewsAPI and GDELT, and normalises items.
const { SOURCES, AGGREGATORS, resolveSource, hostOf } = require('./sources');
const { decode, stripHtml } = require('./text');

const UA = 'Mozilla/5.0 (compatible; VeritasNews/1.0; local news verification app)';

async function get(url, { timeout = 12000, accept = '*/*' } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept }, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]).trim() : '';
}
function attr(xml, name, a) {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*\\b${a}=["']([^"']+)["']`, 'i'));
  return m ? decode(m[1]) : '';
}

function parseFeed(xml) {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  return blocks.map(b => {
    let link = tag(b, 'link');
    if (!link || link.startsWith('<')) {
      const links = b.match(/<link\b[^>]*>/gi) || [];
      const pick = links.find(l => /rel=["']alternate/i.test(l)) || links.find(l => !/rel=/i.test(l)) || links[0] || '';
      link = attr(pick, 'link', 'href');
    }
    const rawDesc = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content');
    const img = attr(b, 'media:content', 'url') || attr(b, 'media:thumbnail', 'url') ||
      (/<enclosure[^>]+type=["']image/i.test(b) ? attr(b, 'enclosure', 'url') : '') ||
      ((decode(rawDesc).match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1] || '');
    return {
      title: stripHtml(tag(b, 'title')),
      link: stripHtml(link),
      description: stripHtml(rawDesc).slice(0, 1200),
      date: tag(b, 'pubDate') || tag(b, 'dc:date') || tag(b, 'published') || tag(b, 'updated'),
      image: img,
      sourceName: stripHtml(tag(b, 'source')),
      sourceUrl: attr(b, 'source', 'url'),
    };
  }).filter(i => i.title && i.link);
}

function toItem(raw, source, topics, via) {
  const t = Date.parse(raw.date);
  return {
    id: '', // set later
    title: raw.title, description: raw.description === raw.title ? '' : raw.description,
    link: raw.link, image: raw.image || '', sourceId: source.id, topics, via: via || null,
    published: Number.isFinite(t) ? Math.min(t, Date.now()) : Date.now(),
  };
}

async function fetchOutletFeed(source, feed) {
  const xml = await (await get(feed.url, { accept: 'application/rss+xml, application/xml, text/xml' })).text();
  return parseFeed(xml).slice(0, 40).map(r => toItem(r, source, feed.topics));
}

// Google News: titles end with " - Publisher" and carry a <source url> naming the publisher.
async function fetchGoogle(url, topics, via) {
  const xml = await (await get(url)).text();
  return parseFeed(xml).slice(0, 60).map(r => {
    const src = resolveSource(r.sourceUrl || r.sourceName, r.sourceName);
    if (!src) return null;
    if (r.sourceName && r.title.endsWith(' - ' + r.sourceName)) r.title = r.title.slice(0, -(r.sourceName.length + 3));
    // Google's description is just a link list repeating the headline; drop it.
    r.description = '';
    return toItem(r, src, topics, via);
  }).filter(Boolean);
}

async function fetchNewsApi(params) {
  const key = process.env.NEWSAPI_KEY;
  if (!key) return [];
  const endpoint = params.q ? 'everything' : 'top-headlines';
  const qs = new URLSearchParams({ ...params, pageSize: '50', language: 'en', apiKey: key });
  if (endpoint === 'everything') qs.set('sortBy', 'publishedAt');
  const data = await (await get(`https://newsapi.org/v2/${endpoint}?${qs}`)).json();
  return (data.articles || []).map(a => {
    const src = resolveSource(a.url, a.source && a.source.name);
    if (!src) return null;
    return toItem({ title: a.title || '', link: a.url, description: a.description || '', date: a.publishedAt, image: a.urlToImage },
      src, [params.category || 'world'], 'NewsAPI');
  }).filter(i => i && i.title && !/\[Removed\]/.test(i.title));
}

const gdeltTime = t => new Date(t).toISOString().replace(/[-:T]/g, '').slice(0, 14);
async function fetchGdelt(q, range) {
  const qs = new URLSearchParams({ query: `${q} sourcelang:english`, mode: 'artlist', format: 'json', maxrecords: '75', sort: 'datedesc' });
  if (range) { qs.set('startdatetime', gdeltTime(range.from)); qs.set('enddatetime', gdeltTime(range.to)); } else qs.set('timespan', '3d');
  const data = await (await get(`https://api.gdeltproject.org/api/v2/doc/doc?${qs}`)).json();
  return (data.articles || []).map(a => {
    const src = resolveSource(a.url, a.domain);
    if (!src) return null;
    const d = a.seendate ? a.seendate.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z') : '';
    return toItem({ title: a.title, link: a.url, description: '', date: d, image: a.socialimage }, src, ['world'], 'GDELT');
  }).filter(Boolean);
}

// Dedupe, assign ids, and keep articles published within [from, to] (default: the last 4 days).
function finish(items, from = Date.now() - 4 * 864e5, to = Infinity) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = it.link.replace(/[?#].*$/, '') + '|' + it.title.toLowerCase();
    const k2 = it.sourceId + '|' + it.title.toLowerCase();
    if (seen.has(key) || seen.has(k2)) continue;
    seen.add(key); seen.add(k2);
    it.id = hash(it.link + it.title);
    out.push(it);
  }
  return out.filter(i => i.published >= from && i.published <= to);
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

async function settle(tasks) {
  const results = await Promise.allSettled(tasks.map(t => t.run()));
  const items = [], errors = [];
  const checks = [];
  results.forEach((r, i) => {
    const t = tasks[i];
    if (r.status === 'fulfilled') { items.push(...r.value); checks.push({ key: t.key || t.label, label: t.label, sourceId: t.sourceId, ok: true, count: r.value.length }); }
    else {
      const error = String(r.reason && r.reason.message || r.reason);
      errors.push({ feed: t.label, error });
      checks.push({ key: t.key || t.label, label: t.label, sourceId: t.sourceId, ok: false, count: 0, error });
    }
  });
  return { items, errors, attempted: tasks.length, checks };
}

// Base edition: every outlet feed + aggregators (+ NewsAPI headlines when a key is set).
async function fetchAll() {
  const tasks = [];
  for (const s of SOURCES) for (const f of s.feeds) tasks.push({ key: f.url, sourceId: s.id, label: `${s.name} (${hostOf(f.url)})`, run: () => fetchOutletFeed(s, f) });
  for (const a of AGGREGATORS) tasks.push({ key: a.url, label: a.via, run: () => fetchGoogle(a.url, a.topics, a.via) });
  if (process.env.NEWSAPI_KEY) {
    tasks.push({ label: 'NewsAPI (us)', run: () => fetchNewsApi({ country: 'us' }) });
    tasks.push({ label: 'NewsAPI (in)', run: () => fetchNewsApi({ country: 'in' }) });
  }
  const r = await settle(tasks);
  return { ...r, items: finish(r.items) };
}

// Topic search: Google News search across all publishers + GDELT + NewsAPI.
// With a range (time travel), every source is limited to articles published in that window.
async function fetchSearch(q, range) {
  const day = t => new Date(t).toISOString().slice(0, 10);
  const when = range ? ` after:${day(range.from)} before:${day(range.to + 864e5)}` : ' when:3d';
  const enc = encodeURIComponent(q + when);
  const via = range ? 'Google News (dated)' : 'Google News';
  const tasks = [
    { label: 'Google News search (US)', run: () => fetchGoogle(`https://news.google.com/rss/search?q=${enc}&hl=en-US&gl=US&ceid=US:en`, ['search'], via) },
    { label: 'Google News search (IN)', run: () => fetchGoogle(`https://news.google.com/rss/search?q=${enc}&hl=en-IN&gl=IN&ceid=IN:en`, ['search'], via) },
    { label: 'Google News search (UK)', run: () => fetchGoogle(`https://news.google.com/rss/search?q=${enc}&hl=en-GB&gl=GB&ceid=GB:en`, ['search'], via) },
  ];
  // GDELT's article search only covers roughly the last three months.
  if (!range || range.from > Date.now() - 85 * 864e5) tasks.push({ label: 'GDELT', run: () => fetchGdelt(q, range) });
  // NewsAPI's free plan only reaches back about a month.
  if (process.env.NEWSAPI_KEY && (!range || range.from > Date.now() - 29 * 864e5)) {
    tasks.push({ label: 'NewsAPI search', run: () => fetchNewsApi(range ? { q, from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() } : { q }) });
  }
  const r = await settle(tasks);
  return { ...r, items: range ? finish(r.items, range.from, range.to) : finish(r.items) };
}

// Pull readable paragraphs out of an article page for deep verification.
async function fetchArticleText(url) {
  return extractText(await (await get(url, { timeout: 10000, accept: 'text/html' })).text());
}

// The article as the Wayback Machine saved it closest to a past moment ("id_" = original page, no toolbar).
async function fetchWaybackText(url, at) {
  const ts = new Date(at).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const res = await get(`https://web.archive.org/web/${ts}id_/${url}`, { timeout: 25000, accept: 'text/html' });
  const m = res.url.match(/\/web\/(\d{14})/);
  const snapshot = m ? Date.UTC(+m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8), +m[1].slice(8, 10), +m[1].slice(10, 12)) : null;
  return { text: extractText(await res.text()), snapshot };
}

function extractText(html) {
  const body = (html.match(/<article\b[\s\S]*?<\/article>/i) || [html])[0]
    .replace(/<(script|style|noscript|svg|figure|nav|footer|header|aside|form)\b[\s\S]*?<\/\1>/gi, ' ');
  const paras = (body.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || [])
    .map(p => stripHtml(p))
    .filter(p => p.length > 60 && !/cookie|subscribe|newsletter|sign up|all rights reserved|javascript/i.test(p));
  return paras.slice(0, 45).join('\n').slice(0, 9000);
}

module.exports = { fetchAll, fetchSearch, fetchArticleText, fetchWaybackText, fetchGoogle, finish, hash, parseFeed, toItem };
