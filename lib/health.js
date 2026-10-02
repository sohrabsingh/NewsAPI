// Feed health tracker: notices when a feed goes down, goes empty, shrinks, or looks removed.
// Storage is bounded: per feed a fixed-length history string, plus a capped event log,
// written atomically to one small JSON file (tens of KB at most, however long it runs).
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'feed-health.json');
const HISTORY = 144;          // checks kept per feed (144 x 10 min = 24h of refreshes)
const MAX_EVENTS = 300;       // oldest events are dropped beyond this
const DOWN_AFTER = 3;         // consecutive failures before a feed counts as "down" (ignores blips)
const EMPTY_AFTER = 2;        // consecutive empty-but-OK responses before "empty"
const REMOVED_AFTER = 7 * 864e5;  // down/empty this long => probably removed or moved
const FORGET_AFTER = 30 * 864e5;  // drop feeds no longer configured after this long

let db = { version: 1, feeds: {}, events: [] };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}

function event(now, key, f, type, detail) {
  db.events.push({ t: now, key, label: f.label, sourceId: f.sourceId || null, type, detail: detail || '' });
  if (db.events.length > MAX_EVENTS) db.events.splice(0, db.events.length - MAX_EVENTS);
}

function record(checks) {
  const now = Date.now();
  for (const c of checks) {
    const f = db.feeds[c.key] || (db.feeds[c.key] = {
      label: c.label, sourceId: c.sourceId || null, history: '', status: 'up', since: now,
      failStreak: 0, zeroStreak: 0, avgCount: null, lastCount: 0, lastOk: null, lastError: null, flagged: {},
    });
    f.label = c.label; f.lastSeen = now;
    // History symbols: 1 = ok with articles, 0 = failed, e = ok but empty
    f.history = (f.history + (c.ok ? (c.count ? '1' : 'e') : '0')).slice(-HISTORY);
    const prev = f.status;
    let next = prev;

    if (c.ok) {
      f.failStreak = 0;
      f.lastCount = c.count;
      if (c.count > 0) {
        f.lastOk = now; f.zeroStreak = 0;
        // Sudden shrink vs. its usual volume (feed restructured or truncated?)
        if (f.avgCount >= 5 && c.count < f.avgCount * 0.3) {
          if (!f.flagged.shrunk) { event(now, c.key, f, 'shrunk', `${c.count} articles vs usual ~${Math.round(f.avgCount)}`); f.flagged.shrunk = true; }
        } else f.flagged.shrunk = false;
        f.avgCount = f.avgCount == null ? c.count : f.avgCount * 0.9 + c.count * 0.1;
        next = 'up';
      } else if (++f.zeroStreak >= EMPTY_AFTER) next = 'empty';
    } else {
      f.lastError = c.error;
      if (++f.failStreak >= DOWN_AFTER) next = 'down';
    }

    if (next !== prev) {
      if (next === 'up') event(now, c.key, f, 'recovered', `back after ${Math.round((now - f.since) / 60000)} min ${prev}`);
      if (next === 'down') event(now, c.key, f, 'down', c.error);
      if (next === 'empty') event(now, c.key, f, 'empty', 'feed responds but contains no articles');
      f.status = next; f.since = now; f.flagged.removed = false;
    }
    if ((f.status === 'down' || f.status === 'empty') && now - f.since > REMOVED_AFTER && !f.flagged.removed) {
      event(now, c.key, f, 'likely-removed', `no articles for ${Math.round((now - f.since) / 864e5)} days — feed URL may have moved; update lib/sources.js`);
      f.flagged.removed = true;
    }
  }
  // Forget feeds that are no longer configured
  for (const [k, f] of Object.entries(db.feeds)) if (now - (f.lastSeen || 0) > FORGET_AFTER) delete db.feeds[k];
  save();
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE); // atomic replace: never leaves a half-written file
  } catch (e) { console.error('feed-health save failed:', e.message); }
}

function report() {
  const feeds = Object.entries(db.feeds).map(([key, f]) => {
    const h = f.history, ok = (h.match(/1/g) || []).length;
    return { key, label: f.label, sourceId: f.sourceId, status: f.flagged && f.flagged.removed ? 'likely-removed' : f.status,
      since: f.since, history: h, uptime: h.length ? ok / h.length : null, lastOk: f.lastOk, lastError: f.lastError,
      lastCount: f.lastCount, avgCount: f.avgCount && Math.round(f.avgCount) };
  }).sort((a, b) => (a.status === 'up') - (b.status === 'up') || (a.uptime ?? 1) - (b.uptime ?? 1));
  let bytes = 0; try { bytes = fs.statSync(FILE).size; } catch {}
  return { feeds, events: db.events.slice().reverse(), storage: { file: 'data/feed-health.json', bytes, maxEvents: MAX_EVENTS, historyPerFeed: HISTORY } };
}

module.exports = { record, report };
