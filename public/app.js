// Veritas front-end: preference-ranked feed, story inspector, divergence view, people & outlet profiles.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${Math.max(m, 1)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const api = async u => { const r = await fetch(u); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j; };

const TOPICS = ['world', 'politics', 'business', 'tech', 'science', 'health', 'climate', 'sports', 'conflict', 'factcheck'];
const REGIONS = ['India', 'US', 'UK', 'Europe', 'Middle East', 'Asia-Pacific', 'Africa', 'Americas'];
const STATUS_COLOR = { verified: 'var(--verified)', corroborated: 'var(--corroborated)', 'single-source': 'var(--single)', contested: 'var(--contested)' };
const CLAIM_COLOR = { corroborated: 'var(--verified)', 'single-source': 'var(--single)', unconfirmed: 'var(--single)', disputed: 'var(--contested)' };
const CLAIM_LABEL = { corroborated: 'Corroborated by independent outlets', 'single-source': 'Single outlet only', unconfirmed: 'Unconfirmed / speculative wording', disputed: 'Disputed or fact-checked' };

const state = { data: null, outlets: {}, story: null, tab: 'coverage', diverge: false, deep: {}, profiles: {} };

// ---------- preferences ----------
const DEFAULT_PREFS = { topics: [], regions: [], follow: '', block: '', min: 'any', sort: 'relevance', indie: true, hideState: false, muted: [] };
let prefs = { ...DEFAULT_PREFS };
try { prefs = { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem('veritas.prefs') || '{}') }; } catch {}
const savePrefs = () => { try { localStorage.setItem('veritas.prefs', JSON.stringify(prefs)); } catch {} renderFeed(); };
const list = s => s.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);

function initPrefs() {
  const chipGroup = (el, values, key) => {
    el.innerHTML = values.map(v => `<button class="chip" data-v="${esc(v)}" aria-pressed="${prefs[key].includes(v)}">${esc(v)}</button>`).join('');
    el.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      const v = b.dataset.v;
      prefs[key] = prefs[key].includes(v) ? prefs[key].filter(x => x !== v) : [...prefs[key], v];
      b.setAttribute('aria-pressed', prefs[key].includes(v)); savePrefs();
    };
  };
  chipGroup($('#pref-topics'), TOPICS, 'topics');
  chipGroup($('#pref-regions'), REGIONS, 'regions');
  const bind = (sel, key, prop = 'value', ev = 'change') => { const el = $(sel); el[prop] = prefs[key]; el.addEventListener(ev, () => { prefs[key] = el[prop]; savePrefs(); }); };
  bind('#pref-follow', 'follow', 'value', 'input'); bind('#pref-block', 'block', 'value', 'input');
  bind('#pref-min', 'min'); bind('#pref-sort', 'sort');
  bind('#pref-indie', 'indie', 'checked'); bind('#pref-state', 'hideState', 'checked');
  $('#btn-prefs').onclick = () => { const p = $('#prefs'); p.hidden = !p.hidden; $('#btn-prefs').setAttribute('aria-expanded', !p.hidden); };
  if (prefs.topics.length || prefs.regions.length || prefs.follow) $('#prefs').hidden = false;
}

// ---------- outlet credibility ----------
function outlet(id) { return state.outlets[id] || { id, name: id, reliability: null, leaning: 'unknown', unrated: true, notes: [] }; }
function credibility(o) {
  const base = o.reliability ?? 45;
  if (o.live && o.live.articles >= 5) return Math.round(base * 0.7 + o.live.corroborationRate * 100 * 0.3);
  return base;
}
const relColor = v => (v >= 75 ? 'var(--verified)' : v >= 60 ? 'var(--corroborated)' : v >= 45 ? 'var(--single)' : 'var(--contested)');
const srcChip = id => { const o = outlet(id); const c = credibility(o); return `<span class="src" title="${esc(o.name)} — credibility ${o.unrated ? 'unrated' : c}/100, ${esc(o.leaning)}"><i class="rel" style="background:${o.unrated ? 'var(--muted)' : relColor(c)}"></i>${esc(o.name)}</span>`; };

// ---------- feed ----------
async function load(q = '', refresh = false) {
  $('#status').textContent = q ? `Searching every outlet for “${q}” and cross-checking…` : 'Fetching and cross-checking coverage from 40+ outlets…';
  try {
    const d = await api(`/api/news?${new URLSearchParams({ q, ...(refresh ? { refresh: '1' } : {}) })}`);
    state.data = d; Object.assign(state.outlets, d.outlets);
    renderFeed();
    // Deep link: #story=<id>[&diverge=1][&tab=claims]
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('story') && $('#drawer').hidden) {
      if (h.get('diverge') === '1') state.diverge = true;
      if (openStory(h.get('story')) && h.get('tab')) { state.tab = h.get('tab'); renderTab(); }
    }
  } catch (e) {
    $('#status').textContent = 'Could not load news: ' + e.message;
  }
}

function visibleItems(st) { return st.items.filter(i => !prefs.muted.includes(i.sourceId)); }

function rank() {
  const follow = list(prefs.follow), block = list(prefs.block);
  const rankOrder = { any: 0, corroborated: 1, verified: 2 };
  const statusRank = s => ({ 'single-source': 0, contested: 1, corroborated: 1, verified: 2 }[s]);
  const now = Date.now();
  return state.data.stories.map(st => {
    const items = visibleItems(st);
    if (!items.length) return null;
    const hay = (st.title + ' ' + st.summary + ' ' + items.map(i => i.title).join(' ') + ' ' + st.entities.map(e => e.name).join(' ')).toLowerCase();
    if (block.some(b => hay.includes(b))) return null;
    if (statusRank(st.verification.status) < rankOrder[prefs.min]) return null;
    if (prefs.hideState && st.sources.every(s => outlet(s).leaning === 'state-aligned')) return null;
    const followHits = follow.filter(f => hay.includes(f)).length;
    const topicHit = !prefs.topics.length || st.topics.some(t => prefs.topics.includes(t));
    const regionHit = !prefs.regions.length || st.regions.some(r => prefs.regions.includes(r));
    if (!followHits && (!topicHit || !regionHit)) return null;
    const recency = Math.exp(-(now - st.lastSeen) / (18 * 3600e3));
    let pref = (prefs.topics.length && topicHit ? 0.35 : 0) + (prefs.regions.length && regionHit ? 0.3 : 0) + Math.min(1, followHits * 0.6);
    if (prefs.indie && st.verification.hasIndependentMedia) pref += 0.12;
    const voices = st.verification.independentVoices;
    const relevance = 0.4 * st.verification.score / 100 + 0.25 * recency + 0.3 * Math.min(1, pref) + 0.05 * Math.log2(voices);
    return { st, items, relevance };
  }).filter(Boolean).sort((a, b) =>
    prefs.sort === 'latest' ? b.st.lastSeen - a.st.lastSeen
      : prefs.sort === 'verified' ? b.st.verification.score - a.st.verification.score || b.st.verification.independentVoices - a.st.verification.independentVoices
      : b.relevance - a.relevance);
}

function renderFeed() {
  const d = state.data; if (!d) return;
  const rows = rank();
  const multi = d.stories.filter(s => s.verification.independentVoices > 1).length;
  const errs = d.feeds.errors.length ? ` <details><summary class="hint">${d.feeds.errors.length} feed(s) failed</summary>${d.feeds.errors.map(e => `<div class="hint">${esc(e.feed)}: ${esc(e.error)}</div>`).join('')}</details>` : '';
  $('#status').innerHTML = `${d.query ? `Results for “${esc(d.query)}” · <a href="#" id="clear-q">back to headlines</a> · ` : ''}` +
    `${rows.length} shown of ${d.stories.length} stories · ${multi} cross-reported · ${d.feeds.ok}/${d.feeds.attempted} feeds reached · updated ${ago(d.generatedAt)}${errs} · <a href="#" id="open-health">feed health</a>`;
  $('#open-health').onclick = e => { e.preventDefault(); openHealth(); };
  const clr = $('#clear-q'); if (clr) clr.onclick = e => { e.preventDefault(); $('#q').value = ''; load(); };
  $('#feed').innerHTML = rows.length ? rows.slice(0, 150).map(({ st, items }) => {
    const v = st.verification, srcs = [...new Set(items.map(i => i.sourceId))];
    return `<div class="card ${st.image ? '' : 'no-img'}" style="--c:${STATUS_COLOR[v.status]}" data-id="${st.id}" tabindex="0">
      <div>
        <div class="meta"><span class="badge ${v.status}-bg">${esc(v.status.replace('-', ' '))}</span>
          <span class="score">${v.score}/100</span>
          <span>${v.independentVoices} independent owner${v.independentVoices > 1 ? 's' : ''}</span>
          ${v.factCheckedBy.length ? `<span>🔎 fact-checked</span>` : ''}
          ${st.analysis.claims.some(c => c.discrepancy) ? `<span title="Outlets report different numbers">⚠ figures differ</span>` : ''}
          <span>· ${ago(st.lastSeen)}</span></div>
        <h2>${esc(st.title)}</h2>
        ${st.summary ? `<p>${esc(st.summary)}</p>` : ''}
        <div class="meta">${srcs.slice(0, 6).map(srcChip).join('')}${srcs.length > 6 ? `<span>+${srcs.length - 6} more</span>` : ''}
          <span>${st.topics.concat(st.regions).map(esc).join(' · ')}</span></div>
      </div>
      ${st.image ? `<img src="${esc(st.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
    </div>`;
  }).join('') : `<div class="empty">No stories match your preferences. Loosen the filters in ⚙ Preferences.</div>`;
}

$('#feed').addEventListener('click', e => { const c = e.target.closest('.card'); if (c) openStory(c.dataset.id); });
$('#feed').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('card')) openStory(e.target.dataset.id); });

// ---------- story drawer ----------
function analysis(st) { return (state.deep[st.id] && state.deep[st.id].analysis) || st.analysis; }

function openStory(id) {
  const st = state.data.stories.find(s => s.id === id);
  if (!st) { history.replaceState(null, '', location.pathname); return false; }
  state.story = st; state.tab = 'coverage';
  const v = st.verification;
  const leanList = v.leanings.length ? v.leanings.join(', ') : 'unknown';
  $('#d-head').innerHTML = `
    <div class="meta"><span class="badge ${v.status}-bg">${esc(v.status.replace('-', ' '))}</span> ${st.topics.concat(st.regions).map(esc).join(' · ')}</div>
    <h1 class="d-title" id="d-title">${esc(st.title)}</h1>
    <div class="row"><b>Verification ${v.score}/100</b></div>
    <div class="meter"><i style="width:${v.score}%;background:${STATUS_COLOR[v.status]}"></i></div>
    <p class="why">Reported by <b>${v.independentVoices}</b> independent owner group${v.independentVoices > 1 ? 's' : ''} (${st.sources.length} outlets)
      across ${v.countries.length || 1} countr${v.countries.length > 1 ? 'ies' : 'y'} (${esc(v.countries.join(', ') || '?')}) and editorial leanings: ${esc(leanList)}.
      ${v.hasIndependentMedia ? 'Includes independent media. ' : ''}
      ${v.factCheckedBy.length ? `<b style="color:var(--contested)">Fact-checkers involved: ${v.factCheckedBy.map(id => esc(outlet(id).name)).join(', ')}.</b> ` : ''}
      ${v.disputes.length ? `Dispute language in: ${v.disputes.map(d => esc(outlet(d.sourceId).name)).join(', ')}.` : ''}
      First reported ${ago(st.firstSeen)}, latest ${ago(st.lastSeen)}.</p>`;
  $('#deep-status').textContent = state.deep[st.id] ? 'Deep verification loaded.' : '';
  setDiverge(state.diverge);
  $('#drawer').hidden = false; document.body.style.overflow = 'hidden';
  history.replaceState(null, '', '#story=' + st.id);
  renderTab();
  return true;
}

function closeAll() { history.replaceState(null, '', location.pathname); $('#drawer').hidden = true; $('#modal').hidden = true; document.body.style.overflow = ''; }
document.addEventListener('click', e => { if (e.target.closest('[data-close]')) { const dlg = e.target.closest('.drawer'); dlg.hidden = true; if (dlg.id === 'drawer') history.replaceState(null, '', location.pathname); if ($('#drawer').hidden && $('#modal').hidden) document.body.style.overflow = ''; } });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('#modal').hidden) $('#modal').hidden = true; else closeAll(); } });

document.querySelector('.tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]'); if (!b) return;
  state.tab = b.dataset.tab; renderTab();
});

function renderTab() {
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === state.tab));
  const st = state.story, body = $('#d-body');
  ({ coverage: tabCoverage, claims: tabClaims, theories: tabTheories, people: tabPeople, outlets: tabOutlets })[state.tab](st, body);
}

function tabCoverage(st, body) {
  const bySrc = new Map();
  for (const it of visibleItems(st)) { if (!bySrc.has(it.sourceId)) bySrc.set(it.sourceId, []); bySrc.get(it.sourceId).push(it); }
  const groups = [...bySrc.entries()].sort((a, b) => credibility(outlet(b[0])) - credibility(outlet(a[0])));
  const deep = state.deep[st.id];
  body.innerHTML = groups.map(([id, items]) => {
    const o = outlet(id), c = credibility(o), fetchInfo = deep && deep.fetch.find(f => f.sourceId === id);
    return `<div class="box">
      <div class="row"><h4>${esc(o.name)}</h4>
        <span class="small">${o.unrated ? 'unrated outlet' : `credibility <b style="color:${relColor(c)}">${c}</b>/100`} · ${esc(o.leaning)} · ${esc(o.country || '?')} · owner: <a href="#" data-outlet="${esc(id)}">${esc(o.owner || 'unknown')}</a></span></div>
      ${items.map(it => `<div style="margin-top:6px"><a href="${esc(it.link)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>
        <span class="small">· ${ago(it.published)}${it.via ? ' · via ' + esc(it.via) : ''}</span>
        ${it.description ? `<div class="small">${esc(it.description.slice(0, 300))}${it.description.length > 300 ? '…' : ''}</div>` : ''}</div>`).join('')}
      ${fetchInfo ? `<div class="small">Deep verify: ${esc(fetchInfo.status)}</div>` : ''}
    </div>`;
  }).join('');
}

function claimCard(c) {
  const names = ids => ids.map(id => esc(outlet(id).name)).join(', ');
  return `<div class="box claim" style="--c:${CLAIM_COLOR[c.status]}">
    <div class="tag">${CLAIM_LABEL[c.status]} · ${c.independentSupport} independent owner${c.independentSupport === 1 ? '' : 's'}</div>
    <div style="margin:4px 0">“${esc(c.text)}”</div>
    <div class="small">Stated by: ${names(c.assertedBy)}</div>
    ${c.supportedBy.length > c.assertedBy.length ? `<div class="small">Also covered by: ${names(c.supportedBy.filter(x => !c.assertedBy.includes(x)))}</div>` : ''}
    ${c.disputedBy.length ? `<div class="small" style="color:var(--contested)">Disputed / fact-checked by: ${names(c.disputedBy)}</div>` : ''}
    ${c.discrepancy ? `<div class="warn">⚠ Figures differ between outlets: ${c.discrepancy.map(d => `<b>${esc(outlet(d.sourceId).name)}</b>: ${esc(d.numbers.join(', '))}`).join(' · ')}</div>` : ''}
    ${c.variants.length > 1 ? `<details><summary class="small">How each outlet phrased it (${c.variants.length})</summary>${c.variants.map(v => `<div class="small">— <b>${esc(outlet(v.sourceId).name)}</b>: ${esc(v.text)}</div>`).join('')}</details>` : ''}
  </div>`;
}

function tabClaims(st, body) {
  const a = analysis(st);
  const note = state.deep[st.id] ? '' : `<p class="hint">Claims below come from headlines and summaries. Use <b>🔬 Deep verify</b> to read the full articles and extract more.</p>`;
  body.innerHTML = note + (a.claims.length ? a.claims.map(claimCard).join('') : `<div class="empty">No checkable factual claims found in the available text.</div>`);
}

function tabTheories(st, body) {
  const a = analysis(st);
  const leanings = {};
  for (const id of st.sources) { const l = outlet(id).leaning || 'unknown'; (leanings[l] = leanings[l] || []).push(outlet(id).name); }
  const order = ['left', 'center-left', 'center', 'center-right', 'right', 'state-aligned', 'unknown'];
  body.innerHTML = `
    <div class="box"><h4>Who is telling this story (editorial spectrum)</h4>
      ${order.filter(l => leanings[l]).map(l => `<div class="small"><b>${esc(l)}</b>: ${leanings[l].map(esc).join(', ')}</div>`).join('')}
      ${order.slice(0, 5).filter(l => !leanings[l]).length ? `<div class="small" style="margin-top:6px">Not covered (in our feeds) by: ${order.slice(0, 5).filter(l => !leanings[l]).join(', ')} outlets — a possible blind spot.</div>` : ''}
    </div>
    <h4>Theories, allegations &amp; unconfirmed angles</h4>
    ${a.theories.length ? a.theories.map(t => `<div class="box claim" style="--c:${t.kind.startsWith('dispute') ? 'var(--contested)' : 'var(--single)'}">
        <div class="tag">${esc(t.kind)}</div><div>“${esc(t.text)}”</div>
        <div class="small">— ${esc(outlet(t.sourceId).name)}${t.echoedBy.length ? ` · echoed by ${t.echoedBy.map(id => esc(outlet(id).name)).join(', ')}` : ' · not echoed by any other owner group'}</div></div>`).join('')
      : `<p class="hint">No speculative or disputed language detected${state.deep[st.id] ? '' : ' in headlines/summaries — try 🔬 Deep verify'}.</p>`}
    <h4>Framing: what each outlet emphasises that others don't</h4>
    ${a.angles.map(g => `<div class="box"><div class="row"><b>${esc(outlet(g.sourceId).name)}</b><span class="small">${esc(g.headline)}</span></div>
      ${g.uniqueTerms.length ? `<div class="chips" style="margin-top:4px">${g.uniqueTerms.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : '<div class="small">No unique emphasis.</div>'}</div>`).join('')}`;
}

function factsList(f, kind) {
  const rows = kind === 'person'
    ? [['Born', f.born], ['Died', f.died], ['Birthplace', f.birthplace], ['Citizenship', f.citizenship], ['Occupation', f.occupation], ['Positions held', f.positions], ['Party', f.party], ['Education', f.education], ['Employer', f.employer], ['Spouse', f.spouse], ['Convicted of', f.convictedOf], ['Awards', f.awards]]
    : [['Type', f.instanceOf], ['Founded', f.founded], ['Country', f.country], ['Headquarters', f.headquarters], ['Founders', f.founders], ['Owned by', f.ownedBy], ['Parent org', f.parent], ['CEO', f.ceo], ['Chair', f.chair], ['Owns', f.owns]];
  const r = rows.filter(([, v]) => v && v.length);
  return r.length ? `<dl class="kv">${r.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v.slice(0, 6).join(', '))}</dd>`).join('')}</dl>` : '';
}

function profileCard(p, fallbackName) {
  if (!p) return `<div class="box"><b>${esc(fallbackName)}</b><div class="small">Loading…</div></div>`;
  if (p.error) return `<div class="box"><b>${esc(fallbackName)}</b><div class="small">Lookup failed: ${esc(p.error)}</div></div>`;
  if (!p.found) return `<div class="box"><b>${esc(p.name)}</b><div class="small">No reliable public profile found.</div></div>`;
  return `<div class="box person">
    ${p.thumbnail ? `<img src="${esc(p.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="ph">${p.kind === 'person' ? '👤' : p.kind === 'place' ? '📍' : '🏢'}</div>`}
    <div><div class="row"><h4>${esc(p.title)}</h4><span class="small">${esc(p.kind)}</span></div>
      <div class="small">${esc(p.description)}</div>
      <div style="font-size:13.5px;margin-top:4px">${esc(p.extract.slice(0, 420))}${p.extract.length > 420 ? '…' : ''}</div>
      ${factsList(p.facts || {}, p.kind)}
      ${(p.scrutiny || []).map(s => `<details class="scrutiny"><summary>Skeptic's view — ${esc(s.heading)}</summary><p>${esc(s.text)}</p></details>`).join('')}
      <div class="small" style="margin-top:6px">${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">Wikipedia</a>` : ''}${p.wikidata ? ` · <a href="https://www.wikidata.org/wiki/${esc(p.wikidata)}" target="_blank" rel="noopener">Wikidata</a>` : ''} · matched automatically by name from “${esc(p.name)}”, double-check it's the same ${p.kind === 'person' ? 'person' : 'entity'}.</div>
    </div></div>`;
}

async function loadProfile(name, context) {
  const key = name.toLowerCase();
  if (state.profiles[key]) return state.profiles[key];
  try { state.profiles[key] = await api(`/api/entity?${new URLSearchParams({ name, context })}`); }
  catch (e) { state.profiles[key] = { name, error: e.message }; }
  return state.profiles[key];
}

function tabPeople(st, body) {
  const ents = st.entities.slice(0, 8);
  if (!ents.length) { body.innerHTML = `<div class="empty">No named people or organisations detected.</div>`; return; }
  const draw = () => {
    if (state.tab !== 'people' || state.story !== st) return;
    const profs = ents.map(e => [e, state.profiles[e.name.toLowerCase()]]);
    const groups = { person: [], organization: [], other: [] };
    const shown = new Set();
    for (const [e, p] of profs) {
      if (p && p.found) { if (shown.has(p.title)) continue; shown.add(p.title); }
      (groups[p && p.found ? (p.kind === 'person' ? 'person' : p.kind === 'organization' ? 'organization' : 'other') : 'other']).push([e, p]);
    }
    const section = (title, arr) => arr.length ? `<h4>${title}</h4><div class="grid2">${arr.map(([e, p]) => profileCard(p, e.name)).join('')}</div>` : '';
    body.innerHTML = `<p class="hint">Background from Wikipedia &amp; Wikidata, including any controversies, criticism or legal sections. Mentioned by: ${ents.map(e => `${esc(e.name)} (${e.sources.length} outlet${e.sources.length > 1 ? 's' : ''})`).join(', ')}.</p>` +
      section('People', groups.person) + section('Organisations', groups.organization) + section('Places &amp; other', groups.other);
  };
  draw();
  ents.forEach(e => loadProfile(e.name, '').then(draw));
}

function outletCard(id, prof) {
  const o = outlet(id), c = credibility(o), live = o.live;
  return `<div class="box">
    <div class="row"><h4>${esc(o.name)}</h4><span class="small">${esc(o.type || '')}</span>
      <span class="badge" style="background:${o.unrated ? 'var(--muted)' : relColor(c)}">${o.unrated ? 'unrated' : c + '/100'}</span></div>
    <dl class="kv">
      <dt>Owner</dt><dd>${esc(o.owner || 'Unknown')}</dd>
      <dt>Ultimate group</dt><dd>${esc(o.group || '?')}</dd>
      <dt>Funding</dt><dd>${esc(o.funding || 'Unknown')}</dd>
      <dt>Country</dt><dd>${esc(o.country || '?')}</dd>
      <dt>Editorial leaning</dt><dd>${esc(o.leaning)}</dd>
      <dt>Baseline reliability</dt><dd>${o.reliability ?? 'not rated'}${o.reliability != null ? '/100 (curated estimate)' : ''}</dd>
      <dt>Live corroboration</dt><dd>${live ? `${Math.round(live.corroborationRate * 100)}% of its ${live.articles} current stories are echoed by other owners · ${live.solo} exclusive/solo · ${live.contested} contested` : 'no data yet'}</dd>
      ${o.independent ? '<dt>Independent</dt><dd>Yes — not owned by a conglomerate or state</dd>' : ''}
    </dl>
    ${(o.notes || []).map(n => `<div class="warn">${esc(n)}</div>`).join('')}
    ${prof === undefined ? `<button class="ghost" data-load-outlet="${esc(id)}" style="margin-top:8px">Load public record &amp; controversies</button>`
      : prof && prof.found ? `<div style="font-size:13.5px;margin-top:8px">${esc(prof.extract.slice(0, 500))}${prof.extract.length > 500 ? '…' : ''}</div>${factsList(prof.facts || {}, 'organization')}
        ${(prof.scrutiny || []).length ? prof.scrutiny.map(s => `<details class="scrutiny"><summary>Skeptic's view — ${esc(s.heading)}</summary><p>${esc(s.text)}</p></details>`).join('') : '<div class="small">No controversy/criticism section on Wikipedia.</div>'}
        ${prof.url ? `<div class="small"><a href="${esc(prof.url)}" target="_blank" rel="noopener">Wikipedia</a></div>` : ''}`
      : prof === null ? '<div class="small">Loading…</div>' : '<div class="small">No public profile found.</div>'}
  </div>`;
}

const outletProfiles = {};
async function loadOutlet(id, redraw) {
  if (outletProfiles[id] !== undefined) return;
  outletProfiles[id] = null; redraw();
  try { const r = await api(`/api/outlet/${encodeURIComponent(id)}`); outletProfiles[id] = r.profile || { found: false }; state.outlets[id] = { ...outlet(id), ...r.outlet }; }
  catch (e) { outletProfiles[id] = { found: false }; }
  redraw();
}

function tabOutlets(st, body) {
  const ids = [...st.sources].sort((a, b) => credibility(outlet(b)) - credibility(outlet(a)));
  const draw = () => { if (state.tab === 'outlets' && state.story === st) body.innerHTML = `<p class="hint">Who owns and funds each outlet carrying this story, how reliable it is, and what critics say about it. Outlets sharing an owner count as one voice in the verification score.</p>` + ids.map(id => outletCard(id, outletProfiles[id])).join(''); };
  draw();
  body.onclick = e => {
    const b = e.target.closest('[data-load-outlet]'); if (b) loadOutlet(b.dataset.loadOutlet, draw);
  };
  ids.slice(0, 4).forEach(id => loadOutlet(id, draw));
}

$('#d-body').addEventListener('click', e => {
  const a = e.target.closest('[data-outlet]'); if (!a) return;
  e.preventDefault(); openOutletModal(a.dataset.outlet);
});

// ---------- divergence view ----------
function setDiverge(on) {
  state.diverge = on;
  const b = $('#btn-diverge');
  b.setAttribute('aria-pressed', on);
  b.querySelector('b').textContent = on ? 'ON' : 'OFF';
  $('#d-diverge').hidden = !on;
  if (on && state.story) renderDiverge(state.story);
}
$('#btn-diverge').onclick = () => setDiverge(!state.diverge);

function renderDiverge(st) {
  const a = analysis(st);
  const items = visibleItems(st).slice().sort((x, y) => x.published - y.published);
  const t0 = st.firstSeen, t1 = Math.max(st.lastSeen, t0 + 60000);
  const firstBy = new Map(); for (const it of items) if (!firstBy.has(it.sourceId)) firstBy.set(it.sourceId, it.published);
  const ticks = [...firstBy.entries()].map(([id, t]) => {
    const pct = 2 + 96 * (t - t0) / (t1 - t0), c = credibility(outlet(id));
    return `<span class="tick" style="left:${pct}%;background:${relColor(c)}" title="${esc(outlet(id).name)} — ${new Date(t).toLocaleString()}"></span><span class="tl" style="left:${pct}%">${esc(outlet(id).name)}</span>`;
  }).join('');
  const cols = [...new Set(a.perSource.map(p => p.sourceId))];
  const claims = a.claims.slice(0, 10);
  const cell = (c, id) => c.disputedBy.includes(id) ? '<td class="cell-dis" title="disputes">✕</td>'
    : c.assertedBy.includes(id) ? '<td class="cell-on" title="states this">●</td>'
    : c.supportedBy.includes(id) ? '<td class="cell-echo" title="covers the same facts">◐</td>'
    : '<td class="cell-off" title="silent — goes off here">·</td>';
  const matrix = claims.length ? `<div class="matrix"><table>
      <tr><th></th>${cols.map(id => `<th class="c">${esc(outlet(id).name)}</th>`).join('')}</tr>
      ${claims.map(c => `<tr><td class="t">${esc(c.text.slice(0, 140))}${c.text.length > 140 ? '…' : ''}${c.discrepancy ? ' <b style="color:var(--single)">⚠ numbers differ</b>' : ''}</td>${cols.map(id => cell(c, id)).join('')}</tr>`).join('')}
    </table></div><div class="small">● states it · ◐ covers the same facts · ✕ disputes it · · silent (off)</div>` : '<p class="hint">No claims to compare.</p>';
  const texts = a.perSource.slice().sort((x, y) => x.onRatio - y.onRatio).map(p => `
    <div class="box"><div class="row"><b>${esc(outlet(p.sourceId).name)}</b>
      <span class="bar" title="${Math.round(p.onRatio * 100)}% on the shared account"><i style="width:${Math.round(p.onRatio * 100)}%"></i></span>
      <span class="small">${Math.round(p.onRatio * 100)}% on · ${100 - Math.round(p.onRatio * 100)}% off (unique to this outlet)</span></div>
      <div class="textblock">${p.sentences.map(s => `<span class="sent ${s.on ? 'on' : 'off'}" title="${s.on ? 'Echoed by: ' + esc(s.matchedBy.map(id => outlet(id).name).join(', ')) : 'No other owner group reports this'}">${esc(s.text)}</span> `).join('')}</div></div>`).join('');
  $('#d-diverge').innerHTML = `
    <h4>When each outlet picked it up</h4>
    <div class="timeline">${ticks}<span class="ends" style="left:0">${new Date(t0).toLocaleString()}</span><span class="ends" style="right:0">${new Date(t1).toLocaleString()}</span></div>
    <h4>Claim-by-outlet map — where coverage goes on and off</h4>${matrix}
    <h4>Each outlet's text, highlighted <span class="sent on">on</span> = echoed by an independent owner, <span class="sent off">off</span> = only this outlet says it</h4>
    ${state.deep[st.id] ? '' : '<p class="hint">Showing headlines/summaries. Run 🔬 Deep verify to compare full articles.</p>'}${texts}`;
}

// ---------- deep verify ----------
$('#btn-deep').onclick = async () => {
  const st = state.story; if (!st) return;
  const status = $('#deep-status');
  status.textContent = 'Reading full articles from each outlet and re-running the cross-check…';
  $('#btn-deep').disabled = true;
  try {
    state.deep[st.id] = await api(`/api/story/${st.id}/deep`);
    const full = state.deep[st.id].fetch.filter(f => f.status === 'full').length;
    if (state.story === st) {
      status.textContent = `Deep verification done: ${full}/${state.deep[st.id].fetch.length} outlets' full text read (others blocked/paywalled — summaries used).`;
      renderTab(); if (state.diverge) renderDiverge(st);
    }
  } catch (e) { status.textContent = 'Deep verify failed: ' + e.message; }
  $('#btn-deep').disabled = false;
};

// ---------- outlets directory ----------
async function openOutletsDirectory() {
  $('#m-body').innerHTML = '<p>Loading outlets…</p>'; $('#modal').hidden = false; document.body.style.overflow = 'hidden';
  const all = await api('/api/outlets'); Object.assign(state.outlets, all);
  const ids = Object.keys(all).filter(id => !all[id].unrated || (all[id].live && all[id].live.articles))
    .sort((a, b) => (all[a].unrated - all[b].unrated) || credibility(all[b]) - credibility(all[a]));
  const draw = () => {
    $('#m-body').innerHTML = `<h2 style="margin-top:0">Outlets &amp; credibility</h2>
      <p class="hint">Credibility = 70% curated baseline (editable in <code>lib/sources.js</code>) + 30% live corroboration rate. Mute an outlet to remove it from your feed. Click a name for its public record and controversies.</p>
      <div style="overflow-x:auto"><table class="table"><tr><th>Outlet</th><th>Cred.</th><th>Leaning</th><th>Owner / funding</th><th>Live corroboration</th><th>Mute</th></tr>
      ${ids.map(id => { const o = all[id], c = credibility(o); return `<tr>
        <td><a href="#" data-outlet="${esc(id)}">${esc(o.name)}</a><div class="small">${esc(o.type)} · ${esc(o.country)}${o.factChecker ? ' · fact-checker' : ''}${o.independent ? ' · independent' : ''}</div></td>
        <td><b style="color:${o.unrated ? 'var(--muted)' : relColor(c)}">${o.unrated ? '—' : c}</b></td>
        <td>${esc(o.leaning)}</td>
        <td>${esc(o.owner)}<div class="small">${esc(o.funding)}</div></td>
        <td>${o.live ? `${Math.round(o.live.corroborationRate * 100)}% <span class="small">of ${o.live.articles}</span>` : '<span class="small">—</span>'}</td>
        <td><input type="checkbox" data-mute="${esc(id)}" ${prefs.muted.includes(id) ? 'checked' : ''} style="width:auto"></td></tr>`; }).join('')}
      </table></div>`;
  };
  draw();
}
$('#m-body').addEventListener('change', e => {
  const id = e.target.dataset.mute; if (!id) return;
  prefs.muted = e.target.checked ? [...prefs.muted, id] : prefs.muted.filter(x => x !== id); savePrefs();
});
$('#m-body').addEventListener('click', e => {
  const a = e.target.closest('[data-outlet]'); if (a) { e.preventDefault(); openOutletModal(a.dataset.outlet); }
  const b = e.target.closest('[data-load-outlet]'); if (b) loadOutlet(b.dataset.loadOutlet, () => openOutletModal(b.dataset.loadOutlet, true));
  if (e.target.closest('#back-dir')) { e.preventDefault(); openOutletsDirectory(); }
});

function openOutletModal(id, noLoad) {
  $('#modal').hidden = false; document.body.style.overflow = 'hidden';
  const draw = () => { $('#m-body').innerHTML = `<a href="#" id="back-dir">← all outlets</a>` + outletCard(id, outletProfiles[id]); };
  draw();
  if (!noLoad) loadOutlet(id, draw);
}

// ---------- feed health ----------
const STATUS_TXT = { up: ['OK', 'var(--verified)'], down: ['Down', 'var(--contested)'], empty: ['Empty', 'var(--single)'], 'likely-removed': ['Likely removed', 'var(--contested)'] };
const EVENT_TXT = { down: '🔴 went down', empty: '🟠 returned no articles', shrunk: '🟠 article count dropped', recovered: '🟢 recovered', 'likely-removed': '⛔ likely removed / moved' };
async function openHealth() {
  $('#m-body').innerHTML = '<p>Loading feed health…</p>'; $('#modal').hidden = false; document.body.style.overflow = 'hidden';
  const h = await api('/api/health');
  const spark = hist => `<span class="spark">${hist.slice(-72).split('').map(c => `<i class="${c === '1' ? 'ok' : c === 'e' ? 'em' : 'bad'}"></i>`).join('')}</span>`;
  $('#m-body').innerHTML = `<h2 style="margin-top:0">Feed health</h2>
    <p class="hint">Every refresh checks each feed. A feed is marked down after 3 failures in a row, empty when it answers with no articles, and likely removed after 7 days with nothing.
      Storage is capped: the last ${h.storage.historyPerFeed} checks per feed and the last ${h.storage.maxEvents} events, kept in <code>${esc(h.storage.file)}</code> (currently ${(h.storage.bytes / 1024).toFixed(1)} KB).</p>
    <div style="overflow-x:auto"><table class="table"><tr><th>Feed</th><th>Status</th><th>Recent checks (newest right)</th><th>Uptime</th><th>Articles</th><th>Last error</th></tr>
    ${h.feeds.map(f => { const [txt, col] = STATUS_TXT[f.status] || [f.status, 'var(--muted)']; return `<tr>
      <td>${esc(f.label)}</td>
      <td><b style="color:${col}">${txt}</b><div class="small">since ${ago(f.since)}</div></td>
      <td>${spark(f.history)}</td>
      <td>${f.uptime == null ? '—' : Math.round(f.uptime * 100) + '%'}</td>
      <td>${f.lastCount}${f.avgCount ? ` <span class="small">(usual ~${f.avgCount})</span>` : ''}</td>
      <td class="small">${f.status === 'up' ? '' : esc(f.lastError || '')}</td></tr>`; }).join('')}
    </table></div>
    <h3>Change log</h3>
    ${h.events.length ? h.events.map(ev => `<div class="small" style="padding:3px 0;border-bottom:1px solid var(--line)"><b>${new Date(ev.t).toLocaleString()}</b> · ${esc(ev.label)} ${EVENT_TXT[ev.type] || esc(ev.type)}${ev.detail ? ' — ' + esc(ev.detail) : ''}</div>`).join('')
      : '<p class="hint">No changes recorded yet — events appear when a feed goes down, empties, shrinks or recovers.</p>'}`;
}

// ---------- boot ----------
$('#btn-outlets').onclick = openOutletsDirectory;
$('#btn-refresh').onclick = () => load($('#q').value.trim(), true);
$('#search').onsubmit = e => { e.preventDefault(); load($('#q').value.trim()); };
initPrefs();
load();
setInterval(() => { if ($('#drawer').hidden && $('#modal').hidden) load($('#q').value.trim()); }, 10 * 60e3);
