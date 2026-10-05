// Local article archive for time travel. One file per day (by publish date, UTC):
//   data/archive/2026-10-05.ndjson      recent days, appended to as articles arrive
//   data/archive/2026-09-20.ndjson.gz   older days, gzip-compressed (~5x smaller)
// Bounded by ARCHIVE_DAYS (default 365) and ARCHIVE_MAX_MB (default 100): oldest days go first.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { resolveSource } = require('./sources');

const DIR = path.join(__dirname, '..', 'data', 'archive');
const KEEP_PLAIN_DAYS = 5;  // feeds never deliver articles older than 4 days, so older files are final
const MAX_DAYS = +process.env.ARCHIVE_DAYS || 365;
const MAX_BYTES = (+process.env.ARCHIVE_MAX_MB || 100) * 1024 * 1024;

const dayOf = t => new Date(t).toISOString().slice(0, 10);
const known = new Set(); // ids already stored in the plain (recent) files

function files() {
  try {
    return fs.readdirSync(DIR).filter(f => /^\d{4}-\d\d-\d\d\.ndjson(\.gz)?$/.test(f)).sort()
      .map(f => ({ f, day: f.slice(0, 10), gz: f.endsWith('.gz'), bytes: fs.statSync(path.join(DIR, f)).size }));
  } catch { return []; }
}

function readDay(day) {
  const plain = path.join(DIR, day + '.ndjson');
  let text = '';
  try { text = fs.readFileSync(plain, 'utf8'); }
  catch { try { text = zlib.gunzipSync(fs.readFileSync(plain + '.gz')).toString('utf8'); } catch { return []; } }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch {} // tolerate a torn last line after a crash
  }
  return out;
}

function init() {
  fs.mkdirSync(DIR, { recursive: true });
  for (const { day, gz } of files()) if (!gz) for (const r of readDay(day)) known.add(r.id);
  maintain();
}

// Store new live articles. Search results are kept too, so past searches stay researchable.
function add(items, getSource) {
  const byDay = new Map();
  for (const it of items) {
    if (known.has(it.id) || !it.id) continue;
    known.add(it.id);
    const s = getSource(it.sourceId);
    const rec = { id: it.id, title: it.title, description: (it.description || '').slice(0, 500), link: it.link, image: it.image || '',
      sourceId: it.sourceId, topics: it.topics, via: it.via, published: it.published, seen: Date.now() };
    if (s && s.unrated) rec.src = { name: s.name, domain: s.domain }; // so unrated outlets can be re-created later
    const d = dayOf(it.published);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(JSON.stringify(rec));
  }
  for (const [d, lines] of byDay) {
    const gz = path.join(DIR, d + '.ndjson.gz');
    if (fs.existsSync(gz)) continue; // that day is sealed
    fs.appendFileSync(path.join(DIR, d + '.ndjson'), lines.join('\n') + '\n');
  }
  maintain();
}

let lastMaintain = 0;
function maintain() {
  if (Date.now() - lastMaintain < 3600e3) return; // at most hourly
  lastMaintain = Date.now();
  const sealBefore = dayOf(Date.now() - KEEP_PLAIN_DAYS * 864e5);
  for (const { f, day, gz } of files()) {
    if (gz || day >= sealBefore) continue;
    const src = path.join(DIR, f);
    fs.writeFileSync(src + '.gz.tmp', zlib.gzipSync(fs.readFileSync(src), { level: 9 }));
    fs.renameSync(src + '.gz.tmp', src + '.gz');
    fs.unlinkSync(src);
    for (const r of readDay(day)) known.delete(r.id);
  }
  // Enforce limits, oldest first.
  const all = files();
  const minDay = dayOf(Date.now() - MAX_DAYS * 864e5);
  let total = all.reduce((a, x) => a + x.bytes, 0);
  for (const x of all) {
    if (x.day >= minDay && total <= MAX_BYTES) break;
    fs.unlinkSync(path.join(DIR, x.f));
    total -= x.bytes;
  }
}

// Articles published within [from, to].
function read(from, to) {
  const out = [];
  for (let t = Date.parse(dayOf(from)); t <= to; t += 864e5) {
    for (const r of readDay(dayOf(t))) {
      if (r.published < from || r.published > to) continue;
      if (r.src) r.sourceId = resolveSource(r.src.domain, r.src.name).id;
      delete r.src; delete r.seen;
      out.push(r);
    }
  }
  return out;
}

function stats() {
  const all = files();
  return { days: all.length, oldest: all[0] ? all[0].day : null, newest: all.length ? all[all.length - 1].day : null,
    bytes: all.reduce((a, x) => a + x.bytes, 0), maxBytes: MAX_BYTES, maxDays: MAX_DAYS };
}

module.exports = { init, add, read, stats };
