import { loadConfig, loadLatest, loadHistory, monthsBetween, observedSeries, forecastSeries } from './data.js';
import { renderChart, fmtDuration, bestInView, freeFlowSeconds } from './chart.js';

const HOUR = 3600e3;
const $ = sel => document.querySelector(sel);

const state = {
  config: null,
  latest: null,
  history: [],
  direction: null,
  windowHours: 6,
  center: null,      // null = follow "now"
  selected: null,
  fetchError: null,
  lastInteraction: 0,
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// --- Data refresh ---------------------------------------------------------------

async function refreshLatest() {
  try {
    state.latest = await loadLatest();
    state.fetchError = null;
  } catch (e) {
    state.fetchError = e.message; // keep showing the last good data
  }
  render();
}

async function refreshHistory() {
  const tz = state.config.display.timezone;
  const now = new Date();
  const start = new Date(now - state.config.display.max_window_hours * HOUR);
  const months = monthsBetween(start, now, tz);
  try {
    state.history = await loadHistory(months, {
      currentMonth: months[months.length - 1],
      maxAgeMs: state.config.refresh.history_minutes * 60e3 - 5e3,
    });
  } catch (e) {
    state.fetchError = e.message;
  }
  render();
}

// --- Rendering ------------------------------------------------------------------

let lastChart = null;

function render() {
  const { config, latest, direction } = state;
  if (!config) return;
  const tz = config.display.timezone;
  const now = new Date();
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });

  // Direction toggle labels + state.
  for (const btn of document.querySelectorAll('[data-dir]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.dir === direction));
  }

  const observed = observedSeries(state.history, direction);
  const forecast = forecastSeries(latest, direction);

  // Hero: leave-now duration, and the best departure in the forecast horizon.
  const nowPoint = forecast.find(p => p.offset === 0);
  const freeFlow = freeFlowSeconds(forecast, observed);
  const fresh = latest?.generated_at_utc ? now - new Date(latest.generated_at_utc) : Infinity;
  if (nowPoint) {
    $('#now-value').textContent = fmtDuration(nowPoint.d);
    $('#now-value').classList.remove('empty-value');
    $('#now-caption').textContent = `Leaving at ${time.format(nowPoint.t)}` +
      (freeFlow ? ` · ${signed(nowPoint.d - freeFlow)} vs no traffic` : '');
  } else {
    $('#now-value').textContent = '–';
    $('#now-value').classList.add('empty-value');
    $('#now-caption').textContent = 'Waiting for the first reading';
  }

  const horizonBest = bestInView([], forecast, new Date(0), new Date(8.64e15), now);
  if (horizonBest && nowPoint) {
    const b = horizonBest.point;
    const saving = nowPoint.d - b.d;
    $('#best-value').textContent = b.offset === 0 ? 'Now' : time.format(b.t);
    $('#best-value').classList.remove('empty-value');
    $('#best-caption').textContent = b.offset === 0
      ? `Shortest in the next ${maxOffset(forecast)}h of forecasts`
      : `${fmtDuration(b.d)} · saves ${fmtDuration(saving)}`;
  } else {
    $('#best-value').textContent = '–';
    $('#best-value').classList.add('empty-value');
    $('#best-caption').textContent = '';
  }

  // Status: last updated, stale warning, errors.
  const status = $('#status');
  const banner = $('#banner');
  const staleMs = config.refresh.stale_after_hours * HOUR;
  if (latest?.generated_at_utc) {
    const gen = new Date(latest.generated_at_utc);
    status.textContent = `Updated ${time.format(gen)} · ${ago(now - gen)}`;
  } else {
    status.textContent = 'No data yet';
  }
  let warn = null;
  if (latest?.generated_at_utc && fresh > staleMs) {
    warn = `Data is ${ago(fresh, false)} old. Hourly collection may have stopped; check GitHub Actions.`;
  } else if (state.fetchError) {
    warn = `Can't reach the data (${state.fetchError}). Showing the last good reading.`;
  } else if (latest?.errors?.length) {
    warn = `${latest.errors.length} request${latest.errors.length > 1 ? 's' : ''} failed on the last run; some points are missing.`;
  }
  banner.hidden = !warn;
  if (warn) $('#banner-text').textContent = warn;

  // Chart.
  const svg = $('#chart');
  const box = svg.getBoundingClientRect();
  if (box.width < 50 || box.height < 50) return;
  const center = state.center ?? now;
  lastChart = renderChart(svg, {
    width: box.width, height: box.height, observed, forecast, center, now,
    windowHours: state.windowHours, timeZone: tz, yMode: config.display.y_mode, selected: state.selected,
  });

  for (const b of document.querySelectorAll('[data-window]')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.window) === state.windowHours));
  }
  $('#now-btn').hidden = state.center === null;
}

function maxOffset(forecast) { return Math.max(0, ...forecast.map(p => p.offset)); }
function signed(sec) { return `${sec >= 0 ? '+' : '−'}${fmtDuration(Math.abs(sec))}`; }
function ago(ms, suffix = true) {
  const min = Math.round(ms / 60e3);
  const s = min < 1 ? 'just now' : min < 60 ? `${min} min` : `${Math.floor(min / 60)}h ${min % 60}m`;
  return suffix && min >= 1 ? `${s} ago` : s;
}

// --- Interaction: swipe to pan, pinch / buttons to zoom, tap to inspect ----------

function clampCenter(c) {
  const now = Date.now();
  const maxH = state.config.display.max_window_hours;
  const half = (state.windowHours / 2) * HOUR;
  const min = now - maxH * HOUR + half;          // left edge no further back than max window
  return Math.min(now, Math.max(Math.min(min, now), c));
}

function setWindow(hours) {
  const maxH = state.config.display.max_window_hours;
  state.windowHours = Math.max(3, Math.min(maxH, hours));
  if (state.center !== null) state.center = clampCenter(state.center);
  touch();
  render();
}

function touch() { state.lastInteraction = Date.now(); }

function initGestures() {
  const svg = $('#chart');
  const pointers = new Map();
  let start = null;

  svg.addEventListener('pointerdown', e => {
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, e.clientX);
    const xs = [...pointers.values()];
    start = {
      x: e.clientX, y: e.clientY, center: +(state.center ?? Date.now()), window: state.windowHours,
      spread: xs.length === 2 ? Math.abs(xs[0] - xs[1]) : null, moved: false,
    };
    touch();
  });

  svg.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId) || !start || !lastChart) return;
    pointers.set(e.pointerId, e.clientX);
    const xs = [...pointers.values()];
    if (xs.length === 2 && start.spread) {
      const spread = Math.abs(xs[0] - xs[1]);
      if (spread > 10) setWindow(Math.round(start.window * (start.spread / spread)));
      start.moved = true;
      return;
    }
    const dx = e.clientX - start.x;
    if (Math.abs(dx) > 8) start.moved = true;
    if (!start.moved) return;
    const msPerPx = (state.windowHours * HOUR) / lastChart.plotWidth;
    state.center = clampCenter(start.center - dx * msPerPx);
    if (Math.abs(state.center - Date.now()) < 60e3) state.center = null;
    touch();
    render();
  });

  const end = e => {
    pointers.delete(e.pointerId);
    if (start && !start.moved && e.type === 'pointerup' && lastChart) {
      const r = svg.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      let best = null, bd = Infinity;
      for (const h of lastChart.hit) {
        const d = Math.hypot(h.x - px, (h.y - py) * 0.5);
        if (d < bd) { bd = d; best = h.p; }
      }
      state.selected = bd < 60 ? best : null;
      render();
    }
    if (!pointers.size) start = null;
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);

  for (const b of document.querySelectorAll('[data-window]')) {
    b.addEventListener('click', () => setWindow(Number(b.dataset.window)));
  }
  $('#now-btn').addEventListener('click', () => { state.center = null; state.selected = null; render(); });
  for (const btn of document.querySelectorAll('[data-dir]')) {
    btn.addEventListener('click', () => {
      state.direction = btn.dataset.dir;
      state.selected = null;
      store.set('direction', state.direction);
      touch();
      render();
    });
  }
}

// Wall display: drift back to the default "now-centred" view after inactivity.
function snapBack() {
  const idle = Date.now() - state.lastInteraction;
  if (idle > state.config.display.snap_back_to_now_seconds * 1e3) {
    if (state.center !== null || state.selected || state.windowHours !== state.config.display.default_window_hours) {
      state.center = null;
      state.selected = null;
      state.windowHours = state.config.display.default_window_hours;
    }
  }
}

async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') await navigator.wakeLock.request('screen');
  } catch { /* not supported or not allowed; set iPad Auto-Lock to Never */ }
}

// --- Boot -----------------------------------------------------------------------

async function main() {
  state.config = await loadConfig();
  const { display, refresh, routes } = state.config;
  const saved = store.get('direction');
  state.direction = routes[saved] ? saved : display.default_direction;
  state.windowHours = display.default_window_hours;

  for (const btn of document.querySelectorAll('[data-dir]')) {
    const r = routes[btn.dataset.dir];
    btn.querySelector('.dir-label').textContent = r ? r.label : btn.dataset.dir;
  }

  initGestures();
  await Promise.all([refreshLatest(), refreshHistory()]);

  setInterval(refreshLatest, refresh.latest_minutes * 60e3);
  setInterval(refreshHistory, refresh.history_minutes * 60e3);
  setInterval(() => { snapBack(); render(); }, refresh.redraw_seconds * 1e3);
  // Periodic full reload picks up code changes and keeps long-running Safari tidy.
  setTimeout(() => location.reload(), refresh.full_reload_hours * HOUR);

  window.addEventListener('resize', render);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { keepAwake(); refreshLatest(); refreshHistory(); }
  });
  keepAwake();
}

main().catch(e => {
  $('#banner').hidden = false;
  $('#banner-text').textContent = `Failed to start: ${e.message}`;
});
