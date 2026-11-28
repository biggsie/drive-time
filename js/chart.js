// Minimal SVG line chart: departure time (x) vs drive duration (y).
// "Now" sits at the centre of the default view; observed = solid, forecast = dashed.

import { splitOnGaps } from './data.js';

const NS = 'http://www.w3.org/2000/svg';
const MIN = 60e3, HOUR = 60 * MIN;

// Y modes. "variance" (minutes vs. typical) is planned: add an entry here with its
// own value() and tick formatter once the comparison rule is defined.
export const Y_MODES = {
  duration: {
    value: p => p.d / 60, // minutes
    tick: m => fmtDuration(m * 60, true),
    label: 'Drive time',
  },
};

export function fmtDuration(seconds, compact = false) {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60), m = total % 60;
  if (compact) return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}m`;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
}

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function niceStep(rangeMinutes, target = 5) {
  const steps = [5, 10, 15, 20, 30, 60, 90, 120, 180, 240];
  return steps.find(s => rangeMinutes / s <= target) || 240;
}

function hourStep(windowHours) {
  if (windowHours <= 8) return 1;
  if (windowHours <= 16) return 2;
  if (windowHours <= 30) return 4;
  return 6;
}

// Google's staticDuration varies by departure time (it can sit well above the
// free-flow time), so the "no traffic" reference is the lowest one in the latest
// forecast set, falling back to the most recent observed value.
export function freeFlowSeconds(forecast, observed) {
  const fs = forecast.map(p => p.s).filter(Number.isFinite);
  if (fs.length) return Math.min(...fs);
  return [...observed].reverse().find(p => Number.isFinite(p.s))?.s ?? null;
}

// Pick the best (shortest) departure in view. Future departures (forecast, incl. "now")
// win because they are actionable; if none are in view, fall back to the lowest
// observed point and label it as past.
export function bestInView(observed, forecast, x0, x1, now) {
  const inView = p => p.t >= x0 && p.t <= x1;
  const future = forecast.filter(p => inView(p) && p.t >= now - 5 * MIN);
  const pool = future.length ? future : observed.filter(inView);
  if (!pool.length) return null;
  const best = pool.reduce((a, b) => (b.d < a.d ? b : a));
  return { point: best, isFuture: future.length > 0 };
}

export function renderChart(svg, opts) {
  const { width, height, observed, forecast, center, windowHours, now, timeZone, yMode = 'duration', selected } = opts;
  const lastWeek = opts.lastWeek || [];
  const mode = Y_MODES[yMode];
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const fs = Math.max(16, Math.min(24, width / 55));
  const m = { top: fs * 2.6, right: fs * 1.6, bottom: fs * 3.2, left: fs * 4.2 };
  const iw = width - m.left - m.right, ih = height - m.top - m.bottom;
  const x0 = new Date(center - (windowHours / 2) * HOUR), x1 = new Date(+center + (windowHours / 2) * HOUR);
  const xs = t => m.left + ((t - x0) / (x1 - x0)) * iw;

  // Y domain from what is visible (plus a little context either side).
  const pad = (windowHours / 6) * HOUR;
  const near = p => p.t >= x0 - pad && p.t <= +x1 + pad;
  const visObs = observed.filter(near), visFc = forecast.filter(near), visLw = lastWeek.filter(near);
  const vals = [...visObs, ...visFc, ...visLw].map(mode.value);
  const staticRef = freeFlowSeconds(forecast, observed);
  if (staticRef && yMode === 'duration') vals.push(staticRef / 60);

  const g = el('g', {}, svg);
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
  const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric' });
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' });
  const hourOf = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' });

  // --- X axis: hour ticks aligned to Pacific hours (PT offsets are whole hours). ---
  const step = hourStep(windowHours);
  const firstHour = Math.ceil(x0 / HOUR) * HOUR;
  for (let t = firstHour; t <= x1; t += HOUR) {
    const h = Number(hourOf.format(new Date(t))) % 24;
    const x = xs(t);
    if (h === 0) {
      el('line', { x1: x, x2: x, y1: m.top, y2: m.top + ih, class: 'day-rule' }, g);
      const lab = el('text', { x: x + 6, y: m.top + ih + fs * 2.6, class: 'axis-day', 'font-size': fs * 0.85 }, g);
      lab.textContent = dayFmt.format(new Date(t));
    }
    if (h % step !== 0) continue;
    el('line', { x1: x, x2: x, y1: m.top + ih, y2: m.top + ih + 6, class: 'tick' }, g);
    const lab = el('text', { x, y: m.top + ih + fs * 1.3, class: 'axis-label', 'text-anchor': 'middle', 'font-size': fs }, g);
    lab.textContent = hourFmt.format(new Date(t)).replace(' ', ' ');
  }

  // "Now" crosshair (drawn even with no data so the frame always reads).
  const nowIn = now >= x0 && now <= x1;
  if (nowIn) {
    const x = xs(now);
    el('line', { x1: x, x2: x, y1: m.top - fs * 0.4, y2: m.top + ih, class: 'now-line' }, g);
    const lab = el('text', { x, y: m.top - fs * 0.9, class: 'now-label', 'text-anchor': 'middle', 'font-size': fs }, g);
    lab.textContent = `Now ${time.format(now)}`;
  }

  if (!vals.length) {
    el('line', { x1: m.left, x2: m.left + iw, y1: m.top + ih, y2: m.top + ih, class: 'baseline' }, g);
    const msg = el('text', { x: m.left + iw / 2, y: m.top + ih / 2, class: 'empty', 'text-anchor': 'middle', 'font-size': fs * 1.3 }, g);
    msg.textContent = observed.length || forecast.length || lastWeek.length ? 'No readings in this time range' : 'Collecting data';
    const sub = el('text', { x: m.left + iw / 2, y: m.top + ih / 2 + fs * 1.8, class: 'empty-sub', 'text-anchor': 'middle', 'font-size': fs * 0.9 }, g);
    sub.textContent = observed.length || forecast.length || lastWeek.length ? 'Swipe toward now, or tap Now' : 'Readings are collected hourly and will appear here';
    return { x0, x1, best: null, hit: [] };
  }

  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 20) { const mid = (hi + lo) / 2; lo = mid - 10; hi = mid + 10; }
  const ys0 = niceStep(hi - lo);
  lo = Math.floor((lo - (hi - lo) * 0.08) / ys0) * ys0;
  hi = Math.ceil((hi + (hi - lo) * 0.08) / ys0) * ys0;
  lo = Math.max(0, lo);
  const ys = v => m.top + ih - ((v - lo) / (hi - lo)) * ih;

  for (let v = lo; v <= hi + 1e-9; v += ys0) {
    const y = ys(v);
    el('line', { x1: m.left, x2: m.left + iw, y1: y, y2: y, class: v === lo ? 'baseline' : 'grid' }, g);
    const lab = el('text', { x: m.left - fs * 0.5, y: y + fs * 0.35, class: 'axis-label', 'text-anchor': 'end', 'font-size': fs }, g);
    lab.textContent = mode.tick(v);
  }

  // No-traffic reference: thin dotted line, labelled at the right edge.
  if (staticRef && yMode === 'duration') {
    const y = ys(staticRef / 60);
    el('line', { x1: m.left, x2: m.left + iw, y1: y, y2: y, class: 'static-line' }, g);
    // Left edge: the best-departure label lives on the right (future) side.
    const lab = el('text', { x: m.left + 6, y: y - fs * 0.45, class: 'static-label', 'text-anchor': 'start', 'font-size': fs * 0.8 }, g);
    lab.textContent = `No traffic ${fmtDuration(staticRef)}`;
  }

  const clip = el('clipPath', { id: 'plot-clip' }, el('defs', {}, svg));
  // Slightly wider than the plot so markers on the window edge (e.g. the +3h
  // forecast when "now" is centred) aren't cut in half.
  el('rect', { x: m.left - 16, y: m.top - fs, width: iw + 32, height: ih + fs * 2 }, clip);
  const plot = el('g', { 'clip-path': 'url(#plot-clip)' }, g);
  // Smooth curve through the points (monotone cubic, so it never overshoots a reading).
  const path = pts => {
    const P = pts.map(p => [xs(p.t), ys(mode.value(p))]);
    const n = P.length, f = v => v.toFixed(1);
    if (n < 3) return P.map((q, i) => `${i ? 'L' : 'M'}${f(q[0])},${f(q[1])}`).join('');
    const d = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) d.push((P[i + 1][1] - P[i][1]) / ((P[i + 1][0] - P[i][0]) || 1e-9));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
      if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    let s = `M${f(P[0][0])},${f(P[0][1])}`;
    for (let i = 0; i < n - 1; i++) {
      const dx = (P[i + 1][0] - P[i][0]) / 3;
      s += `C${f(P[i][0] + dx)},${f(P[i][1] + m[i] * dx)} ${f(P[i + 1][0] - dx)},${f(P[i + 1][1] - m[i + 1] * dx)} ${f(P[i + 1][0])},${f(P[i + 1][1])}`;
    }
    return s;
  };

  // Same day last week, moved onto today's timeline: grey line, drawn underneath.
  for (const run of splitOnGaps(lastWeek, 2.5 * HOUR)) {
    if (run.length > 1) el('path', { d: path(run), class: 'lastweek' }, plot);
  }
  if (windowHours <= 12) {
    for (const p of visLw) el('circle', { cx: xs(p.t), cy: ys(mode.value(p)), r: 3.5, class: 'lw-dot' }, plot);
  }

  // Observed: solid, broken at gaps > 2.5h (missed cron runs).
  for (const run of splitOnGaps(observed, 2.5 * HOUR)) {
    if (run.length > 1) el('path', { d: path(run), class: 'observed' }, plot);
  }
  if (windowHours <= 12) {
    for (const p of visObs) el('circle', { cx: xs(p.t), cy: ys(mode.value(p)), r: 4, class: 'obs-dot' }, plot);
  }
  // Forecast: dashed, with hollow markers at each requested departure.
  if (forecast.length > 1) el('path', { d: path(forecast), class: 'forecast' }, plot);
  for (const p of forecast) el('circle', { cx: xs(p.t), cy: ys(mode.value(p)), r: 6, class: 'fc-dot' }, plot);

  // Best departure in view.
  const best = bestInView(observed, forecast, x0, x1, now);
  if (best) {
    const p = best.point, x = xs(p.t), y = ys(mode.value(p));
    el('circle', { cx: x, cy: y, r: 13, class: 'best-ring' }, plot);
    el('circle', { cx: x, cy: y, r: 6, class: 'best-dot' }, plot);
    const above = y - m.top > fs * 2.2;
    // Anchor the label so it never runs off either edge of the plot.
    const anchor = x > m.left + iw * 0.8 ? 'end' : x < m.left + iw * 0.2 ? 'start' : 'middle';
    const lx = anchor === 'end' ? x + 14 : anchor === 'start' ? x - 14 : x;
    const lab = el('text', {
      x: lx, y: above ? y - fs * 1.1 : y + fs * 1.9,
      class: 'best-label', 'text-anchor': anchor, 'font-size': fs,
    }, g);
    lab.textContent = `${best.isFuture ? 'Best' : 'Lowest'} ${time.format(p.t)} · ${fmtDuration(p.d)}`;
  }

  // Selected point readout (tap).
  if (selected && selected.t >= x0 && selected.t <= x1) {
    const x = xs(selected.t), y = ys(mode.value(selected));
    el('line', { x1: x, x2: x, y1: m.top, y2: m.top + ih, class: 'sel-line' }, g);
    el('circle', { cx: x, cy: y, r: 8, class: 'sel-dot' }, g);
    const tx = x > m.left + iw * 0.7 ? x - 12 : x + 12;
    const lab = el('text', { x: tx, y: Math.max(m.top + fs, y - fs * 0.8), class: 'sel-label', 'text-anchor': x > m.left + iw * 0.7 ? 'end' : 'start', 'font-size': fs }, g);
    if (selected.kind === 'lastweek') {
      const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' });
      lab.textContent = `${day.format(selected.orig)} ${time.format(selected.orig)} · ${fmtDuration(selected.d)}`;
    } else {
      const kind = selected.kind === 'forecast' ? 'forecast' : 'observed';
      lab.textContent = `${time.format(selected.t)} · ${fmtDuration(selected.d)} (${kind})`;
    }
  }

  const hit = [...visObs, ...visFc, ...visLw].map(p => ({ p, x: xs(p.t), y: ys(mode.value(p)) }));
  return { x0, x1, best, hit, plotLeft: m.left, plotWidth: iw };
}
