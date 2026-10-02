// Text helpers: HTML cleanup, tokenising, sentence splitting and named-entity spotting.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', eacute: 'é', egrave: 'è', uuml: 'ü', ouml: 'ö', auml: 'ä' };

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function stripHtml(s) {
  return decode(decode(s))
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set(('a about above after again against all also am an and any are as at be because been before being below between both but by ' +
  'can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its ' +
  'itself just me more most my myself no nor not now of off on once only or other our ours out over own same she should so some such than that the their ' +
  'theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with ' +
  'would you your yours says said say new news after amid over year years day days week weeks one two first last get gets got make makes made may might ' +
  'us also could would told tells live latest update updates video watch photos read report reports via per around since still back like just well ' +
  'take takes many much people time according including former next another while however').split(' '));

function stem(w) {
  if (w.length > 5 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('es') && /(sh|ch|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
  return w;
}

function tokens(text) {
  return (String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .match(/[a-z0-9][a-z0-9'’-]*/g) || [])
    .map(w => w.replace(/['’]s$/, '').replace(/['’-]/g, ''))
    .filter(w => w.length > 1 && !STOP.has(w))
    .map(stem);
}

function sentences(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…"”])\s+(?=[A-Z“"‘'])/)
    .map(s => s.trim())
    .filter(s => s.length > 25);
}

// Words that start sentences or headlines and are capitalised without being names.
const CAP_NOISE = new Set(('The A An In On At For From By With After Before As But And Or If When While Why How What Who Where This That These Those It Its ' +
  'He She They We I You His Her Their Our My Your Watch Live Video Photos Opinion Analysis Explainer Breaking Exclusive Update Report Reports Read More ' +
  'Here There Today Yesterday Tomorrow Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August ' +
  'September October November December Mr Mrs Ms Dr Sir Former Top Over Amid Under Can Will Could Would Should Is Are Was Were Has Have Had Not No ' +
  'All Some Many Most More Why Inside Meet Opinion Editorial Review Podcast Newsletter Also Despite During Following According Police Officials Government ' +
  'President Minister Prime Chief Senator Governor Judge Court Supreme State Says Said Hundreds Thousands Dozens Millions Nearly Around About Several ' +
  'Riot Violent Fires School Failed Burning Footage Protests Education Continue Leaders What Who Did Rents Opposition Demonstrators Blast Woman Man Send Full Article Scoop').split(' '));
const CONNECT = new Set(['of', 'de', 'da', 'del', 'van', 'von', 'bin', 'al', 'la', 'le', 'du', 'der']);
// Titles we keep only when followed by a name (e.g. "President Macron" -> "Macron").
const TITLES = /^(President|Prime|Minister|Chief|Senator|Sen|Rep|Governor|Gov|Judge|Justice|Mr|Mrs|Ms|Dr|Sir|King|Queen|Prince|Princess|Pope|General|Gen|Secretary|Attorney|Chancellor|Mayor|Ambassador|Speaker|Leader|Chairman|CEO)\.?$/;

const isTitleCase = t => { const w = t.split(/\s+/).filter(x => /^[a-z]/i.test(x) && x.length > 3); return w.length >= 4 && !w.some(x => /^[a-z]/.test(x)); };

function entities(text) {
  // Title Case Headlines Capitalise Every Word, so only use their sentences that aren't.
  text = String(text).split(/(?<=[.!?])\s+/).filter(s => !isTitleCase(s)).join(' ');
  const out = [];
  let atStart = true, runStart = true;
  const words = String(text).replace(/[“”"()\[\]:;,!?|]/g, ' . ').split(/\s+/);
  let run = [];
  const flush = () => {
    while (run.length && (CONNECT.has(run[run.length - 1]))) run.pop();
    while (run.length && (CAP_NOISE.has(run[0]) || TITLES.test(run[0]) || CONNECT.has(run[0]))) run.shift();
    if (run.length === 1 && runStart) run = [];
    if (run.length) {
      const name = run.join(' ').replace(/['’]s$/, '').replace(/\.$/, '');
      if (name.length > 2 && !/^\d/.test(name)) out.push(name);
    }
    run = [];
  };
  for (const raw of words) {
    const w = raw.replace(/^['‘’]+|['‘’]+$/g, '');
    const endsSentence = /[.]$/.test(w) && !/^[A-Z]\.$|^(Mr|Mrs|Ms|Dr|St|Jr|Sr|U\.S|U\.K)\.$/.test(w);
    const clean = w.replace(/\.$/, '');
    if (run.length && TITLES.test(clean)) flush(); // "New York Governor Kathy Hochul" -> two names
    if (/^[A-Z][\p{L}'’.-]*$/u.test(clean) && clean.length > 1) { if (!run.length) runStart = atStart; run.push(clean); }
    else if (run.length && CONNECT.has(clean)) run.push(clean);
    else flush();
    atStart = raw === '.' || endsSentence;
    if (endsSentence) flush();
  }
  flush();
  return out;
}

const HEDGE = /\b(alleged(ly)?|reportedly|purported(ly)?|unconfirmed|unverified|rumou?r(s|ed)?|speculat\w*|conspiracy|theor(y|ies|ised|ized)|claims? (that|to)|suspected|believed to|could|may have|might|appears? to|sources (say|said|told)|not been (independently )?verified|without evidence|it is unclear|unclear whether)\b/i;
const DISPUTE = /\b(false(ly)?|fake|misleading|debunk\w*|hoax|denie[sd]|deny|dispute[sd]?|refute[sd]?|no evidence|fact[- ]check\w*|baseless|doctored|morphed|out of context|misinformation|disinformation)\b/i;
const CLAIMY = /\b(said|says|told|announced|confirmed|stated|claimed|according to|reported|killed|died|arrested|charged|sentenced|won|lost|approved|rejected|signed|launched|resigned|elected|ordered|banned|raised|cut|rose|fell|increased|decreased|percent|%|million|billion|\d)/i;

module.exports = { decode, stripHtml, tokens, sentences, entities, HEDGE, DISPUTE, CLAIMY };
