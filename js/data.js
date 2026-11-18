// Data layer: loading, caching and shaping the JSON the collector commits.
// Everything here reads real files from data/; nothing is ever synthesised.
// A missing file means "no data yet" and yields an empty array.

const HOUR = 3600e3;

async function fetchJSON(path) {
  // Cache-bust: GitHub Pages serves with max-age=600 and Safari caches aggressively.
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export async function loadConfig() {
  return fetchJSON('config.json');
}

export async function loadLatest() {
  return fetchJSON('data/latest.json');
}

// Pacific-time calendar months ("YYYY-MM") touched by [start, end].
export function monthsBetween(start, end, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' });
  const out = new Set();
  for (let t = start.getTime(); t <= end.getTime() + 1; t += 6 * HOUR) out.add(fmt.format(new Date(t)).slice(0, 7));
  out.add(fmt.format(end).slice(0, 7));
  return [...out].sort();
}

const monthCache = new Map(); // month -> {records, fetchedAt}

// Load observed records for the given months. Past months are cached for the life
// of the page; the current month is re-fetched when older than maxAgeMs.
export async function loadHistory(months, { currentMonth, maxAgeMs }) {
  const index = await fetchJSON('data/history/index.json').catch(() => null);
  const available = index ? new Set(index.months) : null;
  const all = [];
  for (const m of months) {
    if (available && !available.has(m)) continue;
    const cached = monthCache.get(m);
    const fresh = cached && (m !== currentMonth || Date.now() - cached.fetchedAt < maxAgeMs);
    if (!fresh) {
      const records = (await fetchJSON(`data/history/${m}.json`)) || [];
      monthCache.set(m, { records, fetchedAt: Date.now() });
    }
    all.push(...monthCache.get(m).records);
  }
  return all;
}

// --- Shaping -------------------------------------------------------------------

// Observed points for one direction, oldest first: {t: Date, d: seconds, s: seconds|null}
export function observedSeries(records, direction) {
  return records
    .filter(r => r.direction === direction && Number.isFinite(r.duration_seconds))
    .map(r => ({ t: new Date(r.timestamp_utc), d: r.duration_seconds, s: r.static_duration_seconds ?? null, kind: 'observed' }))
    .sort((a, b) => a.t - b.t);
}

// Forecast points from latest.json for one direction: departures now..+3h.
export function forecastSeries(latest, direction) {
  const route = latest?.routes?.[direction];
  if (!route) return [];
  return (route.forecast || [])
    .filter(p => Number.isFinite(p.duration_seconds))
    .map(p => ({
      t: new Date(p.departure_time_utc), d: p.duration_seconds, s: p.static_duration_seconds ?? null,
      offset: p.offset_hours, issuedAt: new Date(p.requested_at_utc), kind: 'forecast',
    }))
    .sort((a, b) => a.t - b.t);
}

// Split a time series wherever consecutive points are further apart than maxGapMs,
// so a skipped cron run shows as a gap instead of a misleading straight line.
export function splitOnGaps(points, maxGapMs) {
  const runs = [];
  let run = [];
  for (const p of points) {
    if (run.length && p.t - run[run.length - 1].t > maxGapMs) { runs.push(run); run = []; }
    run.push(p);
  }
  if (run.length) runs.push(run);
  return runs;
}

// --- Historical comparison (to be defined) ------------------------------------
//
// "Comparable times" is still an open question (same weekday? same month/season?
// holidays?). Each rule is a predicate (candidateRecord, targetLocal) -> boolean,
// where targetLocal = {date: 'YYYY-MM-DD', hour, weekday: 'Mon'}. Records already
// carry local_date / local_hour / weekday in Pacific time, so rules stay one-liners.
// Register new rules here; nothing in the UI uses them yet.
export const COMPARISON_RULES = {
  // Example only, not wired up: same weekday and departure hour, any date before today.
  sameWeekdayHour: (r, target) => r.weekday === target.weekday && r.local_hour === target.hour && r.local_date < target.date,
};

// Median observed duration among comparable records, or null if there are none.
// This is what a future "variance from normal" Y mode would subtract.
export function typicalDuration(records, direction, targetLocal, ruleName) {
  const rule = COMPARISON_RULES[ruleName];
  if (!rule) return null;
  const ds = records.filter(r => r.direction === direction && rule(r, targetLocal)).map(r => r.duration_seconds).sort((a, b) => a - b);
  if (!ds.length) return null;
  const mid = ds.length >> 1;
  return ds.length % 2 ? ds[mid] : (ds[mid - 1] + ds[mid]) / 2;
}
