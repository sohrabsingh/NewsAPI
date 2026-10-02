// Story clustering, cross-verification scoring, claim matching and divergence analysis.
const { tokens, sentences, entities, HEDGE, DISPUTE, CLAIMY } = require('./text');
const { getSource } = require('./sources');
const { hash } = require('./feeds');

const UNRATED_RELIABILITY = 45;
const rel = s => (s && s.reliability != null ? s.reliability : UNRATED_RELIABILITY);

// ---------- topics & regions ----------
const kw = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, new Set(tokens(v))]));
const TOPIC_KW = kw({
  politics: 'election elections parliament congress senate minister party vote voters bjp democrat democrats republican republicans government policy president campaign lok sabha opposition cabinet legislation bill law white house',
  business: 'market markets stock stocks economy economic inflation bank banks trade tariff tariffs company companies shares revenue gdp investor investors earnings rupee dollar oil price prices startup ipo merger',
  tech: 'ai artificial intelligence tech technology software apple google microsoft meta openai anthropic chip chips semiconductor cyber hack hackers app smartphone robot robots internet data privacy',
  science: 'scientist scientists study research space nasa isro planet species physics astronomers telescope discovery fossil',
  health: 'health disease virus vaccine vaccines hospital cancer covid medical drug drugs outbreak patients doctors',
  climate: 'climate emissions flood floods heatwave wildfire wildfires cyclone hurricane earthquake monsoon environment carbon pollution drought storm',
  sports: 'cricket football soccer match cup league tournament olympic olympics tennis ipl fifa nba nfl goal coach championship innings wicket',
  conflict: 'war strike strikes missile missiles troops military attack attacks ceasefire hamas hezbollah army drone drones bombing shelling invasion hostage hostages',
});
const REGION_KW = kw({
  India: 'india indian delhi mumbai modi bjp kerala karnataka bengal bihar gujarat punjab kashmir tamil nadu uttar pradesh maharashtra rupee bengaluru hyderabad chennai kolkata',
  US: 'us usa america american washington trump biden congress senate california texas florida york pentagon white house',
  UK: 'uk britain british london starmer england scotland wales labour tories conservative',
  Europe: 'eu europe european france french germany german ukraine ukrainian russia russian macron brussels italy spain poland nato',
  'Middle East': 'israel israeli gaza palestinian iran iranian saudi syria syrian lebanon iraq yemen qatar uae houthi',
  'Asia-Pacific': 'china chinese japan japanese korea korean pakistan bangladesh taiwan australia indonesia philippines sri lanka nepal myanmar afghanistan',
  Africa: 'africa african nigeria kenya sudan ethiopia egypt congo somalia ghana',
  Americas: 'canada mexico brazil argentina venezuela colombia chile peru cuba',
});
const COUNTRY_REGION = { India: 'India', US: 'US', UK: 'UK', Germany: 'Europe', France: 'Europe', EU: 'Europe', Qatar: 'Middle East', Russia: 'Europe', 'Hong Kong': 'Asia-Pacific' };

function classify(tokSet, items) {
  const score = (dict) => Object.entries(dict).map(([k, set]) => [k, [...tokSet].filter(t => set.has(t)).length]).filter(([, n]) => n > 0);
  const topics = new Set(score(TOPIC_KW).filter(([, n]) => n >= 2).map(([k]) => k));
  for (const it of items) for (const t of it.topics) if (!['search', 'world', 'india'].includes(t)) topics.add(t);
  if (!topics.size) topics.add('world');
  let regions = score(REGION_KW).sort((a, b) => b[1] - a[1]).filter(([, n], i, arr) => n >= Math.max(1, arr[0][1] / 3)).map(([k]) => k);
  if (!regions.length) {
    const c = items.map(i => COUNTRY_REGION[(getSource(i.sourceId) || {}).country]).filter(Boolean);
    if (c.length) regions = [c[0]];
  }
  return { topics: [...topics], regions };
}

// ---------- vectors ----------
function cosine(a, b) {
  let dot = 0;
  const [s, l] = a.size < b.size ? [a, b] : [b, a];
  for (const [k, v] of s) { const w = l.get(k); if (w) dot += v * w; }
  return dot;
}
function normalize(m) {
  let n = 0; for (const v of m.values()) n += v * v;
  n = Math.sqrt(n) || 1;
  for (const [k, v] of m) m.set(k, v / n);
  return m;
}

function buildIdf(docTokenSets) {
  const df = new Map();
  for (const set of docTokenSets) for (const t of set) df.set(t, (df.get(t) || 0) + 1);
  const N = docTokenSets.length || 1;
  return t => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;
}

// ---------- clustering ----------
function clusterItems(items) {
  const prepared = items.map(it => {
    const titleToks = tokens(it.title);
    const descToks = tokens(it.description).slice(0, 60);
    const ents = entities(it.title + '. ' + it.description).map(e => 'e:' + e.toLowerCase());
    return { it, titleToks, descToks, ents, all: new Set([...titleToks, ...descToks, ...ents]) };
  });
  const idf = buildIdf(prepared.map(p => p.all));
  for (const p of prepared) {
    const v = new Map();
    const add = (t, w) => v.set(t, (v.get(t) || 0) + w * idf(t));
    p.titleToks.forEach(t => add(t, 2));
    p.descToks.forEach(t => add(t, 0.6));
    p.ents.forEach(t => add(t, 1.6));
    p.vec = normalize(v);
  }

  const clusters = []; // { members, centroid(Map, unnormalised sum), norm }
  const index = new Map(); // token -> Set(cluster idx)
  const N = prepared.length;
  prepared.sort((a, b) => a.it.published - b.it.published);
  for (const p of prepared) {
    const cand = new Set();
    for (const t of p.vec.keys()) {
      if (idf(t) < Math.log(N / 40)) continue; // skip very common tokens
      const s = index.get(t); if (s) s.forEach(c => cand.add(c));
    }
    let best = -1, bestSim = 0;
    for (const c of cand) {
      const cl = clusters[c];
      const sim = cosine(p.vec, cl.centroid) / cl.norm;
      if (sim > bestSim) { bestSim = sim; best = c; }
    }
    // Titles alone are short, so require a shared distinctive entity for weaker matches.
    const sharesEntity = best >= 0 && p.ents.some(e => clusters[best].centroid.has(e));
    if (best >= 0 && (bestSim >= 0.42 || (bestSim >= 0.27 && sharesEntity))) {
      const cl = clusters[best];
      cl.members.push(p);
      for (const [k, v] of p.vec) cl.centroid.set(k, (cl.centroid.get(k) || 0) + v);
      let n = 0; for (const v of cl.centroid.values()) n += v * v; cl.norm = Math.sqrt(n);
      for (const k of p.vec.keys()) { if (!index.has(k)) index.set(k, new Set()); index.get(k).add(best); }
    } else {
      const idx = clusters.length;
      clusters.push({ members: [p], centroid: new Map(p.vec), norm: 1 });
      for (const k of p.vec.keys()) { if (!index.has(k)) index.set(k, new Set()); index.get(k).add(idx); }
    }
  }
  // Second pass: centroids drift, so merge clusters that ended up describing the same story.
  const big = clusters.map((c, i) => i).filter(i => clusters[i].members.length >= 2);
  const parent = clusters.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let a = 0; a < big.length; a++) for (let b = a + 1; b < big.length; b++) {
    const A = clusters[big[a]], B = clusters[big[b]];
    if (cosine(A.centroid, B.centroid) / (A.norm * B.norm) >= 0.5) parent[find(big[b])] = find(big[a]);
  }
  const merged = new Map();
  clusters.forEach((c, i) => { const r = find(i); if (!merged.has(r)) merged.set(r, []); merged.get(r).push(...c.members.map(m => m.it)); });
  return { clusters: [...merged.values()].map(items => buildStory(items, idf)), idf };
}

// ---------- verification ----------
function verify(items) {
  const groups = new Map();
  const leanings = new Set(), countries = new Set();
  let independent = false, allState = true;
  const factCheckers = [], disputes = [];
  for (const it of items) {
    const s = getSource(it.sourceId) || {};
    groups.set(s.group || it.sourceId, Math.max(groups.get(s.group || it.sourceId) || 0, rel(s)));
    if (s.leaning && s.leaning !== 'unknown') leanings.add(s.leaning);
    if (s.country && s.country !== '?') countries.add(s.country);
    if (s.independent) independent = true;
    if (s.leaning !== 'state-aligned') allState = false;
    if (s.factChecker) factCheckers.push(it.sourceId);
    if (DISPUTE.test(it.title)) disputes.push({ sourceId: it.sourceId, title: it.title });
  }
  const n = groups.size;
  const weighted = [...groups.values()].reduce((a, r) => a + r / 100, 0);
  let score = 1 - Math.exp(-weighted / 2.8);
  score += Math.min(0.1, 0.03 * Math.max(0, leanings.size - 1) + 0.02 * Math.max(0, countries.size - 1));
  if (independent && n >= 2) score += 0.04;
  score = Math.round(100 * Math.min(1, score));
  if (n === 1) score = Math.min(score, 35);
  if (allState) score = Math.min(score, 15);
  const disputeGroups = new Set(disputes.map(d => (getSource(d.sourceId) || {}).group || d.sourceId));
  const contested = factCheckers.length > 0 || disputeGroups.size >= 2;
  const status = contested ? 'contested' : n >= 3 && score >= 70 ? 'verified' : n >= 2 ? 'corroborated' : 'single-source';
  return { score, status, independentVoices: n, leanings: [...leanings], countries: [...countries],
    factCheckedBy: [...new Set(factCheckers)], disputes, hasIndependentMedia: independent };
}

// ---------- claims, theories, divergence ----------
const overlap = (a, bSet) => { if (!a.size) return 0; let n = 0; for (const t of a) if (bSet.has(t)) n++; return n / a.size; };
const jaccard = (a, b) => { let n = 0; for (const t of a) if (b.has(t)) n++; return n / (a.size + b.size - n || 1); };
const numbers = s => (s.match(/\b\d[\d,.]*\s*(%|percent|million|billion|crore|lakh)?/gi) || []).map(x => x.replace(/,/g, '').trim().toLowerCase());

// docs: [{ sourceId, text, title? }] — one per outlet.
function analyzeTexts(docs, idf) {
  docs = docs.filter(d => d.text && d.text.trim());
  const groupOf = id => (getSource(id) || {}).group || id;
  const prepared = docs.map(d => {
    const sents = sentences(d.text);
    if (d.title && !sents.some(s => s.startsWith(d.title.slice(0, 30)))) sents.unshift(d.title);
    return { ...d, group: groupOf(d.sourceId), sents: sents.slice(0, 60).map(text => ({ text, toks: new Set(tokens(text)) })), all: new Set(tokens(d.text + ' ' + (d.title || ''))) };
  });
  idf = idf || buildIdf(prepared.map(p => p.all));

  // Divergence: is each sentence echoed ("on") by any outlet from a different owner group?
  const perSource = prepared.map(p => {
    const sents = p.sents.map(s => {
      const matchedBy = s.toks.size < 3 ? [] : prepared.filter(o => o.group !== p.group && overlap(s.toks, o.all) >= 0.6).map(o => o.sourceId);
      return { text: s.text, on: matchedBy.length > 0, matchedBy, hedged: HEDGE.test(s.text), disputing: DISPUTE.test(s.text) };
    });
    const on = sents.filter(s => s.on).length;
    return { sourceId: p.sourceId, sentences: sents, onRatio: sents.length ? on / sents.length : 0 };
  });

  // Claims: factual-looking sentences, merged across outlets.
  const claims = [];
  for (const p of prepared) for (const s of p.sents) {
    if (s.toks.size < 4 || !(CLAIMY.test(s.text) || HEDGE.test(s.text))) continue;
    let c = claims.find(c => jaccard(c.toks, s.toks) >= 0.45);
    if (!c) { c = { toks: s.toks, variants: [] }; claims.push(c); }
    c.variants.push({ sourceId: p.sourceId, text: s.text });
  }
  const out = claims.map(c => {
    const asserted = [...new Set(c.variants.map(v => v.sourceId))];
    const supportedBy = prepared.filter(p => asserted.includes(p.sourceId) || overlap(c.toks, p.all) >= 0.6).map(p => p.sourceId);
    const disputedBy = prepared.filter(p => p.sents.some(s => DISPUTE.test(s.text) && overlap(c.toks, s.toks) >= 0.35)).map(p => p.sourceId)
      .filter(id => !c.variants.some(v => v.sourceId === id && DISPUTE.test(v.text)) || (getSource(id) || {}).factChecker);
    const hedged = c.variants.some(v => HEDGE.test(v.text));
    const groups = new Set(supportedBy.map(groupOf));
    const nums = c.variants.map(v => ({ sourceId: v.sourceId, numbers: numbers(v.text) })).filter(v => v.numbers.length);
    const numberSets = new Set(nums.map(v => v.numbers.join('|')));
    const best = [...c.variants].sort((a, b) => rel(getSource(b.sourceId)) - rel(getSource(a.sourceId)))[0];
    const status = disputedBy.length ? 'disputed' : groups.size >= 2 ? 'corroborated' : hedged ? 'unconfirmed' : 'single-source';
    return { text: best.text, status, hedged, assertedBy: asserted, supportedBy, disputedBy, independentSupport: groups.size,
      discrepancy: numberSets.size > 1 ? nums : null, variants: c.variants.slice(0, 6) };
  }).sort((a, b) => b.independentSupport - a.independentSupport || (b.discrepancy ? 1 : 0) - (a.discrepancy ? 1 : 0)).slice(0, 18);

  // Angles: what each outlet emphasises that nobody else mentions.
  const angles = prepared.map(p => {
    const others = new Set(prepared.filter(o => o !== p).flatMap(o => [...o.all]));
    const unique = [...p.all].filter(t => !others.has(t) && t.length > 3 && !/^\d+$/.test(t)).sort((a, b) => idf(b) - idf(a)).slice(0, 6);
    return { sourceId: p.sourceId, headline: p.title || '', uniqueTerms: prepared.length > 1 ? unique : [] };
  });

  const theories = [];
  for (const ps of perSource) for (const s of ps.sentences) {
    if (s.hedged || s.disputing) theories.push({ sourceId: ps.sourceId, text: s.text, kind: s.disputing ? 'dispute / fact-check' : 'speculative or unconfirmed', echoedBy: s.matchedBy });
  }
  return { claims: out, perSource, angles, theories: theories.slice(0, 25) };
}

// ---------- story assembly ----------
function topEntities(items) {
  const counts = new Map();
  for (const it of items) {
    const seen = new Set();
    for (const e of entities(it.title + '. ' + it.description)) {
      const k = e.toLowerCase();
      if (!counts.has(k)) counts.set(k, { name: e, count: 0, sources: new Set() });
      const c = counts.get(k); c.count++; c.sources.add(it.sourceId);
      seen.add(k);
    }
  }
  // Fold surnames ("Macron") into full names ("Emmanuel Macron").
  const list = [...counts.values()];
  for (const short of list) {
    if (short.name.includes(' ')) continue;
    const full = list.find(l => l !== short && l.name.includes(' ') && l.name.split(' ').pop() === short.name);
    if (full) { full.count += short.count; short.sources.forEach(s => full.sources.add(s)); short.count = 0; }
  }
  return list.filter(e => e.count > 0)
    .sort((a, b) => b.sources.size - a.sources.size || b.count - a.count)
    .slice(0, 10)
    .map(e => ({ name: e.name, mentions: e.count, sources: [...e.sources] }));
}

function buildStory(items, idf) {
  items.sort((a, b) => rel(getSource(b.sourceId)) - rel(getSource(a.sourceId)) || a.published - b.published);
  const lead = items[0];
  const withDesc = items.filter(i => i.description).sort((a, b) => rel(getSource(b.sourceId)) - rel(getSource(a.sourceId)));
  const tokSet = new Set(items.flatMap(i => tokens(i.title + ' ' + i.description)));
  const { topics, regions } = classify(tokSet, items);
  const bySource = new Map();
  for (const it of items) {
    const d = bySource.get(it.sourceId) || { sourceId: it.sourceId, title: it.title, text: '' };
    d.text += ' ' + it.title + '. ' + it.description;
    bySource.set(it.sourceId, d);
  }
  const times = items.map(i => i.published);
  return {
    id: hash(items.map(i => i.id).sort().join()),
    title: lead.title,
    summary: (withDesc[0] || {}).description || '',
    image: (items.find(i => i.image) || {}).image || '',
    topics, regions,
    sources: [...new Set(items.map(i => i.sourceId))],
    items: items.map(({ id, title, description, link, sourceId, published, via }) => ({ id, title, description, link, sourceId, published, via })),
    verification: verify(items),
    entities: topEntities(items),
    analysis: analyzeTexts([...bySource.values()], idf),
    firstSeen: Math.min(...times), lastSeen: Math.max(...times),
    keywords: [...tokSet].slice(0, 200),
  };
}

// Live per-outlet stats: how often an outlet's stories are echoed by other owner groups.
function sourceStats(stories) {
  const stats = {};
  for (const st of stories) for (const it of st.items) {
    const s = stats[it.sourceId] || (stats[it.sourceId] = { articles: 0, corroborated: 0, contested: 0, solo: 0 });
    s.articles++;
    if (st.verification.independentVoices >= 2) s.corroborated++; else s.solo++;
    if (st.verification.status === 'contested') s.contested++;
  }
  for (const s of Object.values(stats)) s.corroborationRate = s.articles ? s.corroborated / s.articles : 0;
  return stats;
}

module.exports = { clusterItems, analyzeTexts, sourceStats, verify };
