// Background profiles for people, organisations and outlets from Wikipedia + Wikidata,
// including any "Controversies / Criticism / Legal" sections (the skeptic's view).
const UA = 'VeritasNews/1.0 (local news verification app; https://github.com)';
const cache = new Map();
const TTL = 24 * 3600e3;

// Retries with backoff when Wikipedia/Wikidata rate-limit us (HTTP 429/503).
async function json(url, tries = 3) {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (res.status === 404) return null;
    if (res.ok) return res.json();
    if (i >= tries - 1 || ![429, 503].includes(res.status)) throw new Error(res.status === 429 ? 'Wikipedia rate limit, try again in a minute' : `HTTP ${res.status}`);
    await new Promise(r => setTimeout(r, Math.min(8000, (+res.headers.get('retry-after') || 0) * 1000 || 1000 * 2 ** i)));
  }
}

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  const v = fn().catch(e => { cache.delete(key); throw e; });
  cache.set(key, { t: Date.now(), v });
  return v;
}

const summary = title => json(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}?redirect=true`);

async function search(q) {
  const d = await json(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=3&format=json&origin=*`);
  return ((d && d.query && d.query.search) || []).map(r => r.title);
}

// Find the article that really is about `name` (avoid disambiguation pages and unrelated hits).
async function resolve(name, context) {
  const words = name.toLowerCase().split(/\s+/);
  const plausible = s => s && s.type !== 'disambiguation' && words.every(w => (s.title + ' ' + (s.extract || '')).toLowerCase().includes(w));
  let s = await summary(name).catch(() => null);
  if (plausible(s)) return s;
  for (const t of await search(context ? `${name} ${context}` : name)) {
    s = await summary(t).catch(() => null);
    if (plausible(s)) return s;
  }
  return null;
}

const PROPS = {
  P31: 'instanceOf', P569: 'born', P570: 'died', P19: 'birthplace', P27: 'citizenship', P106: 'occupation', P39: 'positions',
  P102: 'party', P69: 'education', P108: 'employer', P571: 'founded', P159: 'headquarters', P127: 'ownedBy', P749: 'parent',
  P112: 'founders', P169: 'ceo', P488: 'chair', P1037: 'director', P17: 'country', P1830: 'owns', P26: 'spouse', P1399: 'convictedOf',
  P1344: 'participantIn', P166: 'awards',
};

async function wikidata(qid) {
  const d = await json(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`);
  const ent = d && d.entities && Object.values(d.entities)[0];
  if (!ent) return {};
  const facts = {}, ids = new Set();
  for (const [p, key] of Object.entries(PROPS)) {
    const claims = (ent.claims[p] || []).filter(c => c.rank !== 'deprecated').slice(0, 8);
    const vals = [];
    for (const c of claims) {
      const v = c.mainsnak.datavalue && c.mainsnak.datavalue.value;
      if (!v) continue;
      if (v.time) vals.push(v.time.replace(/^\+/, '').replace(/T.*$/, '').replace(/-00/g, ''));
      else if (v.id) { vals.push({ id: v.id }); ids.add(v.id); }
      else if (typeof v === 'string') vals.push(v);
    }
    if (vals.length) facts[key] = vals;
  }
  if (ids.size) {
    const labels = {};
    const list = [...ids];
    for (let i = 0; i < list.length; i += 50) {
      const r = await json(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${list.slice(i, i + 50).join('|')}&props=labels&languages=en&format=json`);
      for (const [id, e] of Object.entries((r && r.entities) || {})) labels[id] = (e.labels && e.labels.en && e.labels.en.value) || id;
    }
    for (const k of Object.keys(facts)) facts[k] = [...new Set(facts[k].map(v => (v.id ? labels[v.id] || v.id : v)))];
  }
  return facts;
}

const SCRUTINY = /controvers|critic|legal|lawsuit|litigation|allegation|scandal|investigation|bias|censorship|conviction|indictment|misconduct|ban|sanction|propaganda|disinformation|ethic|accusation|reception|editorial (stance|independence)|ownership|funding/i;

async function scrutiny(title) {
  const d = await json(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=wiki&redirects=1&titles=${encodeURIComponent(title)}&format=json&origin=*`);
  const page = d && d.query && Object.values(d.query.pages)[0];
  const text = (page && page.extract) || '';
  const parts = text.split(/\n(={2,4})\s*(.+?)\s*\1\n/);
  const out = [];
  for (let i = 1; i < parts.length; i += 3) {
    const heading = parts[i + 1], body = (parts[i + 2] || '').trim();
    if (SCRUTINY.test(heading) && body.length > 80) out.push({ heading, text: body.length > 1100 ? body.slice(0, 1100).replace(/\s\S*$/, '') + '…' : body });
  }
  return out.slice(0, 5);
}

function profile(name, context) {
  return cached(`p:${name}|${context || ''}`, async () => {
    const s = await resolve(name, context);
    if (!s) return { name, found: false };
    const [facts, critique] = await Promise.all([
      s.wikibase_item ? wikidata(s.wikibase_item).catch(() => ({})) : {},
      scrutiny(s.title).catch(() => []),
    ]);
    const inst = (facts.instanceOf || []).join(' ').toLowerCase();
    const kind = inst.includes('human') ? 'person'
      : /country|city|state|province|region|territory|village|town|district/.test(inst) ? 'place'
      : /organi[sz]ation|company|party|agency|business|enterprise|broadcaster|newspaper|channel|network|group|government|ministry|union|court|institution|university|team|club/.test(inst) ? 'organization'
      : 'other';
    return {
      name, found: true, kind, title: s.title, description: s.description || '', extract: s.extract || '',
      thumbnail: s.thumbnail && s.thumbnail.source, url: s.content_urls && s.content_urls.desktop.page,
      wikidata: s.wikibase_item, facts, scrutiny: critique,
    };
  });
}

module.exports = { profile };
