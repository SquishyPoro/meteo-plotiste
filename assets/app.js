/* Meteo Plotiště – dashboard
 * Dáta: Open-Meteo (deterministické modely, ensemble, mriežka nad Európou).
 * Ak sa živé dáta nedajú načítať (napr. v náhľade), použije sa jasne označený ukážkový režim.
 */
(() => {
'use strict';

const HK = { lat: 50.236, lon: 15.790 };
const TZ = 'Europe/Prague';
const MODELS = [
  { id: 'ecmwf_ifs025',        name: 'ECMWF IFS' },
  { id: 'icon_seamless',       name: 'DWD ICON' },
  { id: 'gfs_seamless',        name: 'NOAA GFS' },
  { id: 'meteofrance_seamless', name: 'Météo-France' },
  { id: 'ukmo_seamless',       name: 'UK Met Office' },
  { id: 'gem_seamless',        name: 'Kanada GEM' },
];
const ENS_MODELS = ['ecmwf_ifs025', 'icon_seamless', 'gfs025'];
// mriežka nad Európou (3° × 3°)
const GRID = { lat0: 34, dlat: 3, nrow: 13, lon0: -24, dlon: 3, ncol: 24 };
const STEP_H = 3, MAX_STEPS = 41; // 0 … 120 h
const DAYS = 7;

const $ = (s) => document.querySelector(s);
// jazyk stránky: slovenčina (predvolená) alebo čeština; tx('slovensky', 'česky')
const LANG = (() => { try { return localStorage.getItem('mp-lang') === 'cs' ? 'cs' : 'sk'; } catch { return 'sk'; } })();
const tx = (sk, cs) => (LANG === 'cs' ? cs : sk);
const LOCALE = tx('sk-SK', 'cs-CZ');
const state = { local: null, grid: null, tracks: [], layer: 'wind', step: 0, demo: { local: false, grid: false }, skill: null, obs: null, precip: null, precipRange: 12, radar: null, rstep: 0, radarError: false };
try { const r = +localStorage.getItem('mp-precip-range'); if ([3, 12, 48].includes(r)) state.precipRange = r; } catch { /* nevadí */ }
const OBS_COLOR = '#f2c46d';
const AI_COLOR = '#8fd3ff';

/* ------------------------------------------------------------------ pomocné */
const fmtTime = new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'numeric' });
const fmtDayShort = new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, weekday: 'short', day: 'numeric' });
const fmtDate = new Intl.DateTimeFormat('sk-SK', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtHour = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const dayLabel = (t) => cap(fmtDay.format(t * 1000).replace(/\s/g, ' '));
const dayShort = (t) => cap(fmtDayShort.format(t * 1000));
const dateKey = (t) => fmtDate.format(t * 1000);
const localHour = (t) => +fmtHour.format(t * 1000);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v) => (v == null || Number.isNaN(v) ? null : v);
const r0 = (v) => (v == null ? '–' : Math.round(v).toString());
const r1 = (v) => (v == null ? '–' : (Math.round(v * 10) / 10).toFixed(1).replace('.', ','));
const pct = (p) => (p == null ? '–' : Math.round(p * 100) + ' %');

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, d = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * d / 2) ** 2 + Math.cos(lat1 * d) * Math.cos(lat2 * d) * Math.sin((lon2 - lon1) * d / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function bearing(lat1, lon1, lat2, lon2) {
  const d = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * d) * Math.cos(lat2 * d);
  const x = Math.cos(lat1 * d) * Math.sin(lat2 * d) - Math.sin(lat1 * d) * Math.cos(lat2 * d) * Math.cos((lon2 - lon1) * d);
  return (Math.atan2(y, x) / d + 360) % 360;
}
const DIR_ADV = tx(['severne', 'severovýchodne', 'východne', 'juhovýchodne', 'južne', 'juhozápadne', 'západne', 'severozápadne'],
  ['severně', 'severovýchodně', 'východně', 'jihovýchodně', 'jižně', 'jihozápadně', 'západně', 'severozápadně']);
const DIR_SHORT = ['S', 'SV', 'V', 'JV', 'J', 'JZ', 'Z', 'SZ'];
const dirIdx = (deg) => Math.round(deg / 45) % 8;

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function mean(arr) {
  let s = 0, n = 0;
  for (const v of arr) if (v != null) { s += v; n++; }
  return n ? s / n : null;
}

const WMO = LANG === 'cs' ? {
  0: 'Jasno', 1: 'Převážně jasno', 2: 'Polojasno', 3: 'Zataženo', 45: 'Mlha', 48: 'Mlha s námrazou',
  51: 'Slabé mrholení', 53: 'Mrholení', 55: 'Husté mrholení', 56: 'Mrznoucí mrholení', 57: 'Mrznoucí mrholení',
  61: 'Slabý déšť', 63: 'Déšť', 65: 'Silný déšť', 66: 'Mrznoucí déšť', 67: 'Mrznoucí déšť',
  71: 'Slabé sněžení', 73: 'Sněžení', 75: 'Silné sněžení', 77: 'Sněhová zrna',
  80: 'Přeháňky', 81: 'Přeháňky', 82: 'Silné přeháňky', 85: 'Sněhové přeháňky', 86: 'Sněhové přeháňky',
  95: 'Bouřka', 96: 'Bouřka s kroupami', 99: 'Bouřka s kroupami',
} : {
  0: 'Jasno', 1: 'Prevažne jasno', 2: 'Polojasno', 3: 'Zamračené', 45: 'Hmla', 48: 'Hmla s námrazou',
  51: 'Slabé mrholenie', 53: 'Mrholenie', 55: 'Husté mrholenie', 56: 'Mrznúce mrholenie', 57: 'Mrznúce mrholenie',
  61: 'Slabý dážď', 63: 'Dážď', 65: 'Silný dážď', 66: 'Mrznúci dážď', 67: 'Mrznúci dážď',
  71: 'Slabé sneženie', 73: 'Sneženie', 75: 'Silné sneženie', 77: 'Snehové zrná',
  80: 'Prehánky', 81: 'Prehánky', 82: 'Silné prehánky', 85: 'Snehové prehánky', 86: 'Snehové prehánky',
  95: 'Búrka', 96: 'Búrka s krúpami', 99: 'Búrka s krúpami',
};

/* ------------------------------------------------------------------ cache + fetch */
function cacheGet(key, maxAgeMin) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (Date.now() - o.at > maxAgeMin * 60000) return null;
    return o.data;
  } catch { return null; }
}
function cacheSet(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), data })); } catch { /* plné alebo blokované */ }
}
async function fetchJSON(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (j && j.error) throw new Error(j.reason || 'API error');
    return j;
  } finally { clearTimeout(timer); }
}
const qs = (o) => Object.entries(o).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');

/* ------------------------------------------------------------------ živé dáta: Plotiště */
async function loadLocalLive() {
  const base = { latitude: HK.lat, longitude: HK.lon, timezone: TZ, timeformat: 'unixtime', forecast_days: DAYS };
  const [cur, det, ens] = await Promise.all([
    fetchJSON('https://api.open-meteo.com/v1/forecast?' + qs({
      ...base,
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,precipitation',
      hourly: 'pressure_msl',
      daily: 'sunrise,sunset',
    })),
    fetchJSON('https://api.open-meteo.com/v1/forecast?' + qs({
      ...base,
      hourly: 'temperature_2m,precipitation,wind_gusts_10m',
      models: MODELS.map((m) => m.id).join(','),
    })),
    fetchJSON('https://ensemble-api.open-meteo.com/v1/ensemble?' + qs({
      ...base,
      hourly: 'temperature_2m,precipitation,wind_gusts_10m,cape',
      models: ENS_MODELS.join(','),
    }), 30000),
  ]);

  const times = det.hourly.time;
  const models = {};
  for (const m of MODELS) {
    const t = det.hourly['temperature_2m_' + m.id];
    if (!t || t.every((v) => v == null)) continue;
    models[m.id] = {
      t, p: det.hourly['precipitation_' + m.id] || [], g: det.hourly['wind_gusts_10m_' + m.id] || [],
    };
  }
  // ensemble: každý kľúč začínajúci názvom premennej je jeden člen (kontrolný aj perturbované)
  const ensIdx = new Map(ens.hourly.time.map((t, i) => [t, i]));
  const members = (v) => Object.keys(ens.hourly)
    .filter((k) => k === v || k.startsWith(v + '_'))
    .map((k) => times.map((t) => { const i = ensIdx.get(t); return i == null ? null : num(ens.hourly[k][i]); }))
    .filter((a) => a.some((x) => x != null));

  const curPIdx = cur.hourly.time.findIndex((t) => t > cur.current.time) - 1;
  const p3 = curPIdx >= 3 ? cur.hourly.pressure_msl[curPIdx] - cur.hourly.pressure_msl[curPIdx - 3] : null;

  return {
    times, models,
    ens: { t: members('temperature_2m'), p: members('precipitation'), g: members('wind_gusts_10m'), cape: members('cape') },
    current: { ...cur.current, pressure_trend: p3 },
    sun: cur.daily.sunrise.map((r, i) => [r, cur.daily.sunset[i]]),
    elevation: det.elevation,
  };
}

/* ------------------------------------------------------------------ živé dáta: mriežka Európy */
async function loadGridLive() {
  const lats = [], lons = [];
  for (let r = 0; r < GRID.nrow; r++) for (let c = 0; c < GRID.ncol; c++) {
    lats.push(GRID.lat0 + r * GRID.dlat); lons.push(GRID.lon0 + c * GRID.dlon);
  }
  const j = await fetchJSON('https://api.open-meteo.com/v1/forecast?' + qs({
    latitude: lats.join(','), longitude: lons.join(','),
    hourly: 'pressure_msl,wind_gusts_10m,precipitation,cape',
    forecast_days: 6, timezone: 'GMT', timeformat: 'unixtime',
  }), 45000);
  const arr = Array.isArray(j) ? j : [j];
  const htimes = arr[0].hourly.time;
  const now = Date.now() / 1000;
  let i0 = htimes.findIndex((t) => t >= now - 1800);
  if (i0 < 0) i0 = 0;
  i0 += (3 - (Math.round(htimes[i0] / 3600) % 3)) % 3; // zarovnať na 00/03/06… UTC
  const times = [], P = [], G = [], R = [], C = [];
  for (let s = 0; s < MAX_STEPS; s++) {
    const i = i0 + s * STEP_H;
    if (i >= htimes.length) break;
    times.push(htimes[i]);
    const p = new Float32Array(arr.length), g = new Float32Array(arr.length), rr = new Float32Array(arr.length), cc = new Float32Array(arr.length);
    arr.forEach((loc, k) => {
      const h = loc.hourly;
      p[k] = h.pressure_msl[i] ?? 1013;
      g[k] = h.wind_gusts_10m[i] ?? 0;
      let sum = 0; for (let q = Math.max(0, i - 2); q <= i; q++) sum += h.precipitation[q] ?? 0;
      rr[k] = sum;
      cc[k] = h.cape ? (h.cape[i] ?? 0) : 0;
    });
    P.push(p); G.push(g); R.push(rr); C.push(cc);
  }
  return { times, P, G, R, C };
}

/* ------------------------------------------------------------------ ukážkové dáta (len keď živé zlyhajú) */
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }

function demoGrid() {
  const rand = rng(7);
  const t0 = Math.floor(Date.now() / 1000 / 10800) * 10800;
  const times = [], P = [], G = [], R = [], C = [];
  const noise = Array.from({ length: GRID.nrow * GRID.ncol }, () => rand() - 0.5);
  // ukážkový scenár: hlboká níž putuje od Atlantiku cez Severné more do Pobaltia
  const lowPath = (h) => {
    const u = h / 120;
    return { lon: -26 + 52 * u, lat: 57 - 5 * Math.sin(u * Math.PI) , p: 992 - 18 * Math.sin(Math.min(1, u * 1.6) * Math.PI / 2) + 10 * Math.max(0, u - 0.6) };
  };
  for (let s = 0; s < MAX_STEPS; s++) {
    const h = s * STEP_H;
    times.push(t0 + h * 3600);
    const L = lowPath(h);
    const p = new Float32Array(GRID.nrow * GRID.ncol), g = new Float32Array(p.length), rr = new Float32Array(p.length), cc = new Float32Array(p.length);
    for (let r = 0; r < GRID.nrow; r++) for (let c = 0; c < GRID.ncol; c++) {
      const k = r * GRID.ncol + c, lat = GRID.lat0 + r * GRID.dlat, lon = GRID.lon0 + c * GRID.dlon;
      const dL = haversine(lat, lon, L.lat, L.lon);
      const dA = haversine(lat, lon, 39, -24 + h * 0.03);
      const dE = haversine(lat, lon, 55, 42);
      const dM = haversine(lat, lon, 39, 15 + h * 0.05);
      p[k] = 1014 - (1014 - L.p) * Math.exp(-(((dL) / 950) ** 2)) + 16 * Math.exp(-(((dA) / 1300) ** 2)) + 12 * Math.exp(-(((dE) / 1200) ** 2))
        - 7 * Math.exp(-(((dM) / 500) ** 2)) + noise[k] * 1.2;
      const front = Math.exp(-(((lon - L.lon - 6) * 0.8) ** 2) / 18) * Math.exp(-(((lat - L.lat + 6)) ** 2) / 40);
      rr[k] = Math.max(0, 5 * Math.exp(-(((dL) / 450) ** 2)) + 4 * front + noise[k] * 0.4 - 0.25);
      cc[k] = Math.max(0, (lat < 42 ? 600 * Math.exp(-(((dM) / 600) ** 2)) : 0) + noise[k] * 60);
    }
    // nárazy z tlakového gradientu
    for (let r = 0; r < GRID.nrow; r++) for (let c = 0; c < GRID.ncol; c++) {
      const k = r * GRID.ncol + c;
      const px = p[r * GRID.ncol + Math.min(GRID.ncol - 1, c + 1)] - p[r * GRID.ncol + Math.max(0, c - 1)];
      const py = p[Math.min(GRID.nrow - 1, r + 1) * GRID.ncol + c] - p[Math.max(0, r - 1) * GRID.ncol + c];
      const grad = Math.hypot(px, py) / 2; // hPa / 3°
      g[k] = clamp(18 + grad * 9 + noise[k] * 6, 5, 140);
    }
    P.push(p); G.push(g); R.push(rr); C.push(cc);
  }
  return { times, P, G, R, C };
}

function demoLocal() {
  const rand = rng(42);
  const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rand(); return s - 3; };
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const t0 = Math.floor(d0.getTime() / 1000);
  const N = DAYS * 24;
  const times = Array.from({ length: N }, (_, i) => t0 + i * 3600);
  const front = 62; // hodina prechodu frontu
  const base = (h, shift = 0, amp = 1) => {
    const x = h - shift;
    const lh = localHour(t0 + h * 3600);
    const diurnal = -Math.cos(((lh - 3) / 24) * 2 * Math.PI) * 4;
    const trend = 9 - 0.03 * x + (x > front ? -3 : 0);
    const temp = trend + diurnal;
    const fr = Math.exp(-(((x - front) / 7) ** 2));
    const rain = amp * (2.4 * fr + 0.6 * Math.exp(-(((x - 120) / 5) ** 2)));
    const gust = 18 + amp * 58 * Math.exp(-(((x - front - 3) / 10) ** 2)) + 6 * Math.sin(h / 5);
    const cape = amp * 120 * fr;
    return { temp, rain, gust, cape };
  };
  const models = {};
  MODELS.forEach((m, mi) => {
    const shift = (mi - 2.5) * 2, amp = 0.8 + mi * 0.08, bias = (mi % 3 - 1) * 0.7;
    const t = [], p = [], g = [];
    for (let h = 0; h < N; h++) {
      const b = base(h, shift, amp);
      t.push(+(b.temp + bias + gauss() * 0.3).toFixed(1));
      p.push(+Math.max(0, b.rain + gauss() * 0.15 - 0.1).toFixed(1));
      g.push(+Math.max(4, b.gust + gauss() * 3).toFixed(0));
    }
    models[m.id] = { t, p, g };
  });
  const ens = { t: [], p: [], g: [], cape: [] };
  for (let e = 0; e < 60; e++) {
    const shift = gauss() * 9, amp = clamp(1 + gauss() * 0.45, 0.2, 2), bias = gauss() * 1.2;
    const t = [], p = [], g = [], cp = [];
    for (let h = 0; h < N; h++) {
      const b = base(h, shift, amp), spread = 1 + h / 48;
      t.push(b.temp + bias + gauss() * 0.5 * spread);
      p.push(Math.max(0, b.rain + gauss() * 0.3 - 0.15));
      g.push(Math.max(4, b.gust + gauss() * 4 * spread));
      cp.push(Math.max(0, b.cape + gauss() * 40));
    }
    ens.t.push(t); ens.p.push(p); ens.g.push(g); ens.cape.push(cp);
  }
  const nowH = Math.floor((Date.now() / 1000 - t0) / 3600);
  const b = base(nowH);
  const sun = Array.from({ length: DAYS }, (_, d) => [t0 + d * 86400 + 6.6 * 3600, t0 + d * 86400 + 16.6 * 3600]);
  return {
    times, models, ens, sun, elevation: null,
    current: {
      time: Date.now() / 1000, temperature_2m: b.temp, apparent_temperature: b.temp - 2.5, relative_humidity_2m: 81,
      weather_code: 3, wind_speed_10m: 14, wind_direction_10m: 245, wind_gusts_10m: b.gust, pressure_msl: 1009.4,
      precipitation: 0, pressure_trend: -1.6,
    },
  };
}

/* ------------------------------------------------------------------ odvodené výpočty: Plotiště */
function deriveLocal(L) {
  const n = L.times.length;
  const ids = Object.keys(L.models);
  const cons = { t: [], p: [], g: [] }, spread = { t: [] };
  const band = { t: [[], []], g: [[], []] }, pRain = [];
  for (let i = 0; i < n; i++) {
    for (const v of ['t', 'p', 'g']) cons[v].push(mean(ids.map((id) => num(L.models[id][v][i]))));
    const ts = ids.map((id) => num(L.models[id].t[i])).filter((x) => x != null);
    spread.t.push(ts.length > 1 ? Math.max(...ts) - Math.min(...ts) : null);
    for (const v of ['t', 'g']) {
      const vals = L.ens[v].map((m) => m[i]).filter((x) => x != null).sort((a, b) => a - b);
      band[v][0].push(vals.length > 4 ? quantile(vals, 0.1) : null);
      band[v][1].push(vals.length > 4 ? quantile(vals, 0.9) : null);
    }
    const ps = L.ens.p.map((m) => m[i]).filter((x) => x != null);
    pRain.push(ps.length > 4 ? ps.filter((x) => x >= 0.1).length / ps.length : null);
  }

  // denné pravdepodobnosti z ensemble
  const dayIdx = new Map();
  L.times.forEach((t, i) => { const k = dateKey(t); if (!dayIdx.has(k)) dayIdx.set(k, []); dayIdx.get(k).push(i); });
  const days = [...dayIdx.entries()].slice(0, DAYS).map(([key, idx]) => {
    const per = (arrs, fn) => arrs.map((m) => {
      const vals = idx.map((i) => m[i]).filter((x) => x != null);
      return vals.length >= idx.length * 0.75 ? fn(vals) : null;
    }).filter((x) => x != null);
    const max = (v) => Math.max(...v), min = (v) => Math.min(...v), sum = (v) => v.reduce((a, b) => a + b, 0);
    const gmax = per(L.ens.g, max), psum = per(L.ens.p, sum), tmin = per(L.ens.t, min), tmax = per(L.ens.t, max);
    // búrka: CAPE ≥ 500 J/kg a zároveň zrážky ≥ 1 mm v tom istom členovi
    const storm = L.ens.cape.length ? L.ens.cape.map((cm, e) => {
      const pm = L.ens.p[e]; if (!pm) return null;
      const c = idx.map((i) => cm[i]).filter((x) => x != null), r = idx.map((i) => pm[i]).filter((x) => x != null);
      if (c.length < idx.length * 0.75) return null;
      return Math.max(...c) >= 500 && r.reduce((a, b) => a + b, 0) >= 1 ? 1 : 0;
    }).filter((x) => x != null) : [];
    const P = (arr, f) => (arr.length ? arr.filter(f).length / arr.length : null);
    return {
      key, t: L.times[idx[0]], members: gmax.length,
      gust60: P(gmax, (x) => x >= 60), gust90: P(gmax, (x) => x >= 90),
      rain10: P(psum, (x) => x >= 10), rain25: P(psum, (x) => x >= 25),
      storm: storm.length ? storm.reduce((a, b) => a + b, 0) / storm.length : null,
      frost: P(tmin, (x) => x < 0), heat: P(tmax, (x) => x >= 30),
      tmin: quantile([...tmin].sort((a, b) => a - b), 0.5), tmax: quantile([...tmax].sort((a, b) => a - b), 0.5),
      rainMed: quantile([...psum].sort((a, b) => a - b), 0.5),
    };
  });
  const ai = state.skill && !state.demo.local ? { t: aiSeries(L, state.skill, 't'), g: aiSeries(L, state.skill, 'g'), p: aiSeries(L, state.skill, 'p') } : null;
  const obs = { t: [], gust: [], precip: [] };
  if (state.obs && !state.demo.local) {
    const idx = new Map(state.obs.time.map((t, i) => [t, i]));
    for (const t of L.times) {
      const i = idx.get(t);
      for (const k of Object.keys(obs)) obs[k].push(i == null ? null : state.obs[k][i]);
    }
  }
  return { cons, spread, band, pRain, days, ai, obs: state.obs && !state.demo.local ? obs : null };
}

/* AI predpoveď: každý model opravený o svoju typickú chybu v Plotišti (podľa predstihu a hodiny dňa),
 * potom vážený priemer s váhami 1/MAE² z data/skill.json (počíta GitHub Actions). */
function aiSeries(L, S, key) {
  const now = Date.now() / 1000;
  return L.times.map((t, i) => {
    const lead = clamp(Math.floor((t - now) / 86400), 0, 6);
    const W = S.weights && S.weights[key] && S.weights[key][lead];
    if (!W) return null;
    let s = 0, sw = 0;
    for (const [m, w] of Object.entries(W)) {
      const v = L.models[m] && num(L.models[m][key][i]);
      if (v == null) continue;
      const e = S.models[m] && S.models[m][key] && S.models[m][key][lead];
      let c = v;
      if (key === 't' && e && e.hour_bias) c -= e.hour_bias[Math.floor(t / 3600) % 24];
      else if (key === 'g' && e) c -= e.bias;
      s += c * w; sw += w;
    }
    if (!sw) return null;
    return key === 't' ? s / sw : Math.max(0, s / sw);
  });
}

/* ------------------------------------------------------------------ odvodené výpočty: tlakové níže */
const REGIONS = [
  [-40, -10, 62, 80, tx('pri Islande', 'u Islandu')], [-40, -10, 28, 62, tx('nad Atlantikom', 'nad Atlantikem')],
  [-10, 2, 49, 60, tx('nad Britskými ostrovmi', 'nad Britskými ostrovy')], [2, 9, 51, 62, tx('nad Severným morom', 'nad Severním mořem')],
  [5, 35, 58, 75, tx('nad Škandináviou', 'nad Skandinávií')], [10, 30, 53, 58, tx('nad Baltským morom', 'nad Baltským mořem')],
  [-10, 3.5, 35, 44, tx('nad Pyrenejským polostrovom', 'nad Pyrenejským poloostrovem')], [-5, 7, 43, 51, tx('nad Francúzskom', 'nad Francií')],
  [5, 16, 45, 47.5, tx('nad Alpami', 'nad Alpami')], [12, 19, 48.5, 51.2, tx('nad Českom', 'nad Českem')], [6, 15, 47.5, 55, tx('nad Nemeckom', 'nad Německem')],
  [14, 24.5, 49, 55, tx('nad Poľskom', 'nad Polskem')], [16, 23, 45.5, 49, tx('nad Panónskou nížinou', 'nad Panonskou nížinou')],
  [13, 28, 39, 46, tx('nad Balkánom', 'nad Balkánem')], [27, 42, 40.5, 47, tx('nad Čiernym morom', 'nad Černým mořem')],
  [-6, 37, 28, 45.5, tx('nad Stredomorím', 'nad Středomořím')], [30, 60, 60, 80, tx('nad severným Ruskom', 'nad severním Ruskem')],
];
const regionName = (lon, lat) => (REGIONS.find(([w, e, s, n]) => lon >= w && lon < e && lat >= s && lat < n) || [, , , , tx('nad východnou Európou', 'nad východní Evropou')])[4];

function findExtrema(p, kind) {
  const out = [];
  const { nrow, ncol } = GRID;
  for (let r = 1; r < nrow - 1; r++) for (let c = 1; c < ncol - 1; c++) {
    const v = p[r * ncol + c];
    if (kind === 'L' ? v > 1008 : v < 1020) continue;
    let ok = true, ring = 0, rn = 0;
    for (let dr = -2; dr <= 2 && ok; dr++) for (let dc = -2; dc <= 2; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= nrow || cc >= ncol) continue;
      const w = p[rr * ncol + cc];
      if (Math.abs(dr) <= 1 && Math.abs(dc) <= 1 && (kind === 'L' ? w < v : w > v)) { ok = false; break; }
      if (Math.abs(dr) === 2 || Math.abs(dc) === 2) { ring += w; rn++; }
    }
    if (!ok) continue;
    const depth = kind === 'L' ? ring / rn - v : v - ring / rn;
    if (depth < 1.5) continue;
    // vážené ťažisko 3×3 na spresnenie polohy
    let sw = 0, sx = 0, sy = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const w = Math.max(0, kind === 'L' ? ring / rn - p[(r + dr) * ncol + c + dc] : p[(r + dr) * ncol + c + dc] - ring / rn) ** 2;
      sw += w; sx += w * (c + dc); sy += w * (r + dr);
    }
    out.push({ lon: GRID.lon0 + (sx / sw) * GRID.dlon, lat: GRID.lat0 + (sy / sw) * GRID.dlat, p: v, depth, kind });
  }
  return out;
}

function buildTracks(G) {
  const tracks = [];
  let active = [];
  G.times.forEach((t, s) => {
    const lows = findExtrema(G.P[s], 'L');
    const used = new Set();
    const next = [];
    for (const tr of active) {
      const last = tr.pts[tr.pts.length - 1];
      let best = null, bd = 650;
      lows.forEach((l, i) => {
        if (used.has(i)) return;
        const d = haversine(last.lat, last.lon, l.lat, l.lon);
        if (d < bd) { bd = d; best = i; }
      });
      if (best != null) { used.add(best); tr.pts.push({ ...lows[best], s, t }); next.push(tr); }
      else if (s - last.s <= 2) next.push(tr); // krátky výpadok detekcie
    }
    lows.forEach((l, i) => {
      if (used.has(i)) return;
      const tr = { pts: [{ ...l, s, t }] }; tracks.push(tr); next.push(tr);
    });
    active = next;
  });
  return tracks
    .filter((tr) => tr.pts.length >= 4)
    .map((tr, i) => {
      let minP = Infinity, minAt = null, near = Infinity, nearAt = null;
      for (const p of tr.pts) {
        if (p.p < minP) { minP = p.p; minAt = p; }
        const d = haversine(HK.lat, HK.lon, p.lat, p.lon);
        if (d < near) { near = d; nearAt = p; }
      }
      // najsilnejšie nárazy v okolí stredu níže (do 2 buniek)
      let gmax = 0;
      for (const p of tr.pts) {
        const c0 = Math.round((p.lon - GRID.lon0) / GRID.dlon), r0_ = Math.round((p.lat - GRID.lat0) / GRID.dlat);
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
          const r = r0_ + dr, c = c0 + dc;
          if (r < 0 || c < 0 || r >= GRID.nrow || c >= GRID.ncol) continue;
          gmax = Math.max(gmax, G.G[p.s][r * GRID.ncol + c]);
        }
      }
      return { id: i + 1, pts: tr.pts, minP, minAt, near, nearAt, gmax };
    })
    .filter((tr) => tr.minP < 1004)
    .sort((a, b) => a.near - b.near)
    .slice(0, 8)
    .map((tr, i) => ({ ...tr, label: 'N' + (i + 1) }));
}

/* dopad níže na Plotiště: ensemble pravdepodobnosť silného vetra / dažďa v deň najbližšieho priblíženia (±1 deň) */
function trackImpact(tr, D) {
  if (!D || tr.near > 1200) return null;
  const k = dateKey(tr.nearAt.t);
  const i = D.days.findIndex((d) => d.key === k);
  if (i < 0) return null;
  const win = D.days.slice(Math.max(0, i - (tr.near < 400 ? 0 : 0)), i + 2);
  const best = (f) => Math.max(...win.map((d) => d[f] ?? 0));
  return { gust60: best('gust60'), gust90: best('gust90'), rain10: best('rain10'), storm: best('storm') };
}
const levelOf = (p) => (p == null ? 'none' : p >= 0.7 ? 'crit' : p >= 0.4 ? 'serious' : p >= 0.2 ? 'warn' : 'low');

/* ------------------------------------------------------------------ MAPA */
const map = {
  canvas: $('#map'), wrap: $('#map-wrap'), proj: null, path: null, w: 0, h: 0, dpr: 1,
  lut: null, field: null, fieldCtx: null, fw: 0, fh: 0, idx: null,
  coast: null, borders: null, rings: null, hover: null,
};

const LAYERS = {
  wind: { name: tx('Nárazy vetra', 'Nárazy větru'), unit: 'km/h', key: 'G', min: 30, max: 130, stops: ['#0a2a44', '#1b6fa8', '#5fc0f0', '#dff4ff'], ticks: [30, 60, 90, 130] },
  rain: { name: tx('Zrážky za 3 h', 'Srážky za 3 h'), unit: 'mm', key: 'R', min: 0.2, max: 12, stops: ['#1a1f5c', '#3b4fd1', '#8f9cff', '#eef0ff'], ticks: [0.2, 3, 6, 12], log: true },
  cape: { name: tx('Búrkový potenciál (CAPE)', 'Bouřkový potenciál (CAPE)'), unit: 'J/kg', key: 'C', min: 150, max: 2000, stops: ['#3a1048', '#8a2bb0', '#d77dff', '#fbe9ff'], ticks: [150, 500, 1000, 2000] },
  none: { name: tx('Len tlak (izobary po 4 hPa)', 'Jen tlak (izobary po 4 hPa)'), unit: 'hPa' },
};

function buildLut(L) {
  const lut = new Uint8ClampedArray(256 * 4);
  const cols = L.stops.map((s) => d3.color(s));
  const sc = d3.scaleLinear().domain(cols.map((_, i) => i / (cols.length - 1))).range(cols.map(String)).interpolate(d3.interpolateRgb);
  for (let i = 0; i < 256; i++) {
    const c = d3.color(sc(i / 255));
    lut[i * 4] = c.r; lut[i * 4 + 1] = c.g; lut[i * 4 + 2] = c.b;
    lut[i * 4 + 3] = Math.round(40 + 175 * Math.min(1, i / 70)); // slabé hodnoty priesvitnejšie
  }
  return lut;
}

function toLines(flatArrs) {
  return { type: 'MultiLineString', coordinates: flatArrs.map((a) => { const o = []; for (let i = 0; i < a.length; i += 2) o.push([a[i], a[i + 1]]); return o; }) };
}

function mapResize() {
  const r = map.wrap.getBoundingClientRect();
  if (r.width < 10 || r.height < 10) return;
  map.dpr = Math.min(2, window.devicePixelRatio || 1);
  map.w = r.width; map.h = r.height;
  map.canvas.width = Math.round(r.width * map.dpr); map.canvas.height = Math.round(r.height * map.dpr);
  const edge = [];
  for (let lon = -14; lon <= 38; lon += 1) { edge.push([lon, 37]); edge.push([lon, 67]); }
  for (let lat = 37; lat <= 67; lat += 1) { edge.push([-14, lat]); edge.push([38, lat]); }
  map.proj = d3.geoConicConformal().parallels([40, 62]).rotate([-12, 0])
    .fitExtent([[6, 6], [map.w - 6, map.h - 6]], { type: 'MultiPoint', coordinates: edge });
  // mriežka indexov pre raster poľa (nižšie rozlíšenie, potom vyhladené)
  const f = 3;
  map.fw = Math.ceil(map.w / f); map.fh = Math.ceil(map.h / f);
  map.field = document.createElement('canvas'); map.field.width = map.fw; map.field.height = map.fh;
  map.fieldCtx = map.field.getContext('2d');
  map.idx = new Float32Array(map.fw * map.fh * 2);
  for (let y = 0; y < map.fh; y++) for (let x = 0; x < map.fw; x++) {
    const ll = map.proj.invert([x * f + f / 2, y * f + f / 2]);
    const k = (y * map.fw + x) * 2;
    if (!ll) { map.idx[k] = -1; continue; }
    map.idx[k] = (ll[0] - GRID.lon0) / GRID.dlon; map.idx[k + 1] = (ll[1] - GRID.lat0) / GRID.dlat;
  }
  const hp = map.proj([HK.lon, HK.lat]);
  const pulse = $('#hk-pulse'); pulse.style.left = hp[0] + 'px'; pulse.style.top = hp[1] + 'px';
  drawMap();
}

function sampleGrid(arr, gx, gy) {
  if (gx < 0 || gy < 0 || gx > GRID.ncol - 1 || gy > GRID.nrow - 1) return null;
  const c = Math.min(GRID.ncol - 2, Math.floor(gx)), r = Math.min(GRID.nrow - 2, Math.floor(gy));
  const fx = gx - c, fy = gy - r, n = GRID.ncol;
  return arr[r * n + c] * (1 - fx) * (1 - fy) + arr[r * n + c + 1] * fx * (1 - fy) + arr[(r + 1) * n + c] * (1 - fx) * fy + arr[(r + 1) * n + c + 1] * fx * fy;
}

function drawField(ctx, s) {
  const L = LAYERS[state.layer];
  if (!L.key || !state.grid) return;
  const arr = state.grid[L.key][s];
  if (!map.lut || map.lut.layer !== state.layer) { map.lut = buildLut(L); map.lut.layer = state.layer; }
  const img = map.fieldCtx.createImageData(map.fw, map.fh);
  const d = img.data, lut = map.lut;
  const lo = L.log ? Math.log(L.min) : L.min, hi = L.log ? Math.log(L.max) : L.max;
  for (let i = 0, n = map.fw * map.fh; i < n; i++) {
    const gx = map.idx[i * 2]; if (gx < 0) continue;
    const v = sampleGrid(arr, gx, map.idx[i * 2 + 1]);
    if (v == null || v < L.min) continue;
    const u = clamp(((L.log ? Math.log(v) : v) - lo) / (hi - lo), 0, 1);
    const li = Math.round(u * 255) * 4;
    // jemné stmievanie na okraji mriežky
    const ex = Math.min(gx, GRID.ncol - 1 - gx, map.idx[i * 2 + 1], GRID.nrow - 1 - map.idx[i * 2 + 1]);
    const fade = clamp(ex / 0.8, 0, 1);
    d[i * 4] = lut[li]; d[i * 4 + 1] = lut[li + 1]; d[i * 4 + 2] = lut[li + 2]; d[i * 4 + 3] = lut[li + 3] * fade;
  }
  map.fieldCtx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(map.field, 0, 0, map.w, map.h);
}

function isobars(s) {
  const up = 4, { nrow, ncol } = GRID;
  const W = (ncol - 1) * up + 1, H = (nrow - 1) * up + 1;
  const vals = new Float64Array(W * H);
  const p = state.grid.P[s];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) vals[y * W + x] = sampleGrid(p, x / up, y / up);
  const th = d3.range(948, 1052, 4);
  const onEdge = ([x, y]) => x <= 0.5 || y <= 0.5 || x >= W - 0.5 || y >= H - 0.5;
  return d3.contours().size([W, H]).thresholds(th)(vals).map((c) => {
    const rings = [];
    for (const ring of c.coordinates.flat()) {
      // rozdeliť kontúru tam, kde ide po okraji dátovej mriežky (umelá hrana)
      let seg = [];
      for (const pt of ring) {
        if (onEdge(pt)) { if (seg.length > 2) rings.push(seg); seg = []; continue; }
        const gx = (pt[0] - 0.5) / up, gy = (pt[1] - 0.5) / up; // d3.contours: hodnota bodu i leží na x = i + 0.5
        seg.push(map.proj([GRID.lon0 + gx * GRID.dlon, GRID.lat0 + gy * GRID.dlat]));
      }
      if (seg.length > 2) rings.push(seg);
    }
    return { value: c.value, rings };
  });
}

function smoothPath(ctx, pts) {
  // vynechať úseky na okraji mriežky (umelé hrany kontúr)
  if (pts.length < 3) return;
  ctx.moveTo((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
  }
}

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function positionPulse(proj) {
  const hp = proj([HK.lon, HK.lat]), pulse = $('#hk-pulse');
  pulse.style.left = hp[0] + 'px'; pulse.style.top = hp[1] + 'px';
}

function drawMap() {
  if (!map.proj) return;
  if (state.layer === 'radar') { drawRadarMap(); positionPulse(map.rproj); return; }
  positionPulse(map.proj);
  const ctx = map.canvas.getContext('2d');
  ctx.setTransform(map.dpr, 0, 0, map.dpr, 0, 0);
  ctx.clearRect(0, 0, map.w, map.h);
  ctx.fillStyle = css('--sea'); ctx.fillRect(0, 0, map.w, map.h);
  const path = d3.geoPath(map.proj, ctx);
  const s = state.step;

  // zemepisná sieť
  ctx.beginPath(); path(d3.geoGraticule().step([10, 10]).extent([[-40, 25], [60, 80]])());
  ctx.strokeStyle = '#ffffff0d'; ctx.lineWidth = 1; ctx.stroke();

  if (state.grid) drawField(ctx, s);

  // pobrežie a hranice
  if (!map.coast) { map.coast = toLines(window.EU_GEO.coast); map.borders = toLines(window.EU_GEO.borders); }
  ctx.beginPath(); path(map.borders); ctx.strokeStyle = css('--border-line'); ctx.lineWidth = 0.7; ctx.stroke();
  ctx.beginPath(); path(map.coast); ctx.strokeStyle = css('--land-line'); ctx.lineWidth = 1; ctx.stroke();

  // izobary
  if (state.grid) {
    const iso = isobars(s);
    ctx.lineWidth = 1;
    for (const c of iso) {
      ctx.beginPath();
      for (const ring of c.rings) smoothPath(ctx, ring);
      ctx.strokeStyle = c.value % 20 === 0 ? '#ffffff70' : '#ffffff38';
      ctx.lineWidth = c.value % 20 === 0 ? 1.3 : 0.9;
      ctx.stroke();
    }
  }

  // kruhy vzdialenosti od Plotišťa
  ctx.setLineDash([3, 4]); ctx.strokeStyle = '#8fd3ff55'; ctx.lineWidth = 1;
  ctx.font = '10px ' + css('--mono'); ctx.fillStyle = '#8fd3ffaa';
  for (const km of [300, 600, 1000]) {
    ctx.beginPath(); path(d3.geoCircle().center([HK.lon, HK.lat]).radius(km / 111.2).precision(2)()); ctx.stroke();
    const lp = map.proj([HK.lon, HK.lat + km / 111.2]);
    ctx.fillText(km + ' km', lp[0] + 4, lp[1] - 3);
  }
  ctx.setLineDash([]);

  // dráhy níží
  const tr = state.tracks;
  for (const t of tr) {
    const pts = t.pts.map((p) => ({ ...p, xy: map.proj([p.lon, p.lat]) }));
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(...p.xy) : ctx.moveTo(...p.xy)));
    ctx.strokeStyle = state.hover === t.label ? '#ffb547' : '#ffb54766'; ctx.lineWidth = state.hover === t.label ? 2 : 1.2;
    ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
    for (const p of pts) if (p.s % 8 === 0) { // bodka každých 24 h
      ctx.beginPath(); ctx.arc(p.xy[0], p.xy[1], 2.2, 0, Math.PI * 2); ctx.fillStyle = '#ffb547aa'; ctx.fill();
    }
  }

  // N / V značky v aktuálnom kroku
  if (state.grid) {
    const ext = [...findExtrema(state.grid.P[s], 'L'), ...findExtrema(state.grid.P[s], 'H')];
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const e of ext) {
      const [x, y] = map.proj([e.lon, e.lat]);
      if (x < 0 || y < 0 || x > map.w || y > map.h) continue;
      const lab = tr.find((t) => t.pts.some((p) => p.s === s && haversine(p.lat, p.lon, e.lat, e.lon) < 50));
      ctx.fillStyle = e.kind === 'L' ? '#ffb547' : '#9fe0b8';
      ctx.font = '600 17px ' + css('--display');
      ctx.fillText(e.kind === 'L' ? 'N' : 'V', x, y);
      ctx.font = '10px ' + css('--mono'); ctx.fillStyle = '#dbe5f2';
      ctx.fillText(Math.round(e.p) + (lab ? ' · ' + lab.label : ''), x, y + 14);
    }
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  }

  // Plotiště
  const hp = map.proj([HK.lon, HK.lat]);
  ctx.beginPath(); ctx.arc(hp[0], hp[1], 3, 0, Math.PI * 2); ctx.fillStyle = css('--accent'); ctx.fill();
  ctx.font = '600 11px ' + css('--mono'); ctx.fillStyle = css('--accent');
  ctx.fillText('PLOTIŠTĚ', hp[0] + 8, hp[1] + 4);
}

function renderLegend() {
  const el = $('#map-legend');
  if (state.layer === 'radar') {
    el.innerHTML = `<div class="lt">${tx('Radar · intenzita [mm/h]', 'Radar · intenzita [mm/h]')}</div><div class="keys rk">${RAIN_CLASSES.map((c) => `<span style="--c:${c.color}">${c.name} ≥ ${String(c.min).replace('.', ',')}</span>`).join('')}
      <span style="--c:${R_STORM}">${tx('búrka, krúpy', 'bouřka, kroupy')} ≥ 50 dBZ</span></div><div class="keys"><span>${tx('šípka = pohyb zrážok za 60 min', 'šipka = pohyb srážek za 60 min')}</span></div>`;
    return;
  }
  const L = LAYERS[state.layer];
  const keys = tx(`<div class="keys"><span><b>N</b> tlaková níž · <b>V</b> tlaková výš (hPa)</span>
    <span>— — dráha níže, bodka = 24 h</span><span>čiary = izobary po 4 hPa</span></div>`,
  `<div class="keys"><span><b>N</b> tlaková níže · <b>V</b> tlaková výše (hPa)</span>
    <span>— — dráha níže, tečka = 24 h</span><span>čáry = izobary po 4 hPa</span></div>`);
  if (!L.key) { el.innerHTML = `<div class="lt">${L.name}</div>${keys}`; return; }
  const grad = L.stops.join(',');
  el.innerHTML = `<div class="lt">${L.name} [${L.unit}]</div>
    <div class="bar" style="background:linear-gradient(90deg,${grad})"></div>
    <div class="ticks">${L.ticks.map((t) => `<span>${String(t).replace('.', ',')}</span>`).join('')}</div>${keys}`;
}

function renderTimeline() {
  if (state.layer === 'radar') {
    const seq = radarSeq(), inp = $('#time');
    if (!seq.length) { $('#tl-label').textContent = 'Radar…'; return; }
    state.rstep = clamp(state.rstep, 0, seq.length - 1);
    inp.max = seq.length - 1; inp.value = state.rstep;
    const fr = seq[state.rstep], last = state.radar.frames[state.radar.frames.length - 1];
    const m = Math.round((fr.time - last.time) / 60);
    $('#tl-label').innerHTML = `${fmtTime.format(fr.time * 1000)} <span>${m > 0 ? '+' + m + tx(' min · odhad', ' min · odhad') : m < 0 ? m + ' min' : tx('posledná snímka', 'poslední snímek')}</span>`;
    return;
  }
  const G = state.grid; if (!G) return;
  const inp = $('#time'); inp.max = G.times.length - 1; inp.value = state.step;
  const t = G.times[state.step];
  const h = Math.round((t - Date.now() / 1000) / 3600);
  $('#tl-label').innerHTML = `${dayLabel(t)} ${fmtTime.format(t * 1000)} <span>${h >= 0 ? '+' : ''}${h} h</span>`;
}

function mapReadout(ev) {
  if (state.layer === 'radar') { radarReadout(ev); return; }
  if (!map.proj || !state.grid) return;
  const r = map.canvas.getBoundingClientRect();
  const ll = map.proj.invert([ev.clientX - r.left, ev.clientY - r.top]);
  if (!ll) return;
  const gx = (ll[0] - GRID.lon0) / GRID.dlon, gy = (ll[1] - GRID.lat0) / GRID.dlat;
  const s = state.step, G = state.grid;
  const p = sampleGrid(G.P[s], gx, gy);
  const el = $('#map-readout');
  if (p == null) { el.innerHTML = tx('Mimo dátovej mriežky', 'Mimo datové mřížky'); return; }
  const d = haversine(HK.lat, HK.lon, ll[1], ll[0]);
  el.innerHTML = `${ll[1].toFixed(1)}° S ${ll[0].toFixed(1)}° V · <b>${r0(d)} km</b> ${tx('od Plotišťa', 'od Plotiště')}<br>
    tlak <b>${r0(p)} hPa</b> · nárazy <b>${r0(sampleGrid(G.G[s], gx, gy))} km/h</b><br>
    ${tx('zrážky', 'srážky')} <b>${r1(sampleGrid(G.R[s], gx, gy))} mm/3h</b> · CAPE <b>${r0(sampleGrid(G.C[s], gx, gy))} J/kg</b>`;
}

function renderSystems() {
  if (state.layer === 'radar') { renderRadarPanel(); return; }
  $('.systems h3').textContent = tx('Sledované tlakové níže a ich dosah na Plotiště', 'Sledované tlakové níže a jejich dosah na Plotiště');
  const el = $('#sys-list');
  const D = state.derived;
  if (!state.tracks.length) { el.innerHTML = `<span class="empty">${tx('Žiadna výrazná tlaková níž (pod 1004 hPa) v najbližších 5 dňoch.', 'Žádná výrazná tlaková níže (pod 1004 hPa) v nejbližších 5 dnech.')}</span>`; return; }
  el.innerHTML = state.tracks.map((t) => {
    const imp = trackImpact(t, D);
    const lvl = imp ? levelOf(Math.max(imp.gust60, imp.rain10, imp.storm ?? 0)) : 'none';
    const dir = DIR_ADV[dirIdx(bearing(HK.lat, HK.lon, t.nearAt.lat, t.nearAt.lon))];
    const now = t.pts.find((p) => p.s === state.step) || t.pts[0];
    const impTxt = imp
      ? `${tx('vietor', 'vítr')} ≥60: <b>${pct(imp.gust60)}</b> · ${tx('dážď', 'déšť')} ≥10 mm: <b>${pct(imp.rain10)}</b>`
      : tx('mimo dosahu Plotišťa', 'mimo dosah Plotiště');
    return `<button class="sys" type="button" data-label="${t.label}" data-level="${lvl}" data-step="${t.nearAt.s}">
      <div class="t"><span><em>${t.label}</em> · min. ${r0(t.minP)} hPa</span><span>${r0(t.gmax)} km/h</span></div>
      <div class="d">${tx('teraz', 'nyní')} ${regionName(now.lon, now.lat)}; ${tx('najbližšie', 'nejblíže')} ${r0(t.near)} km ${dir} — ${dayShort(t.nearAt.t)} ${fmtTime.format(t.nearAt.t * 1000)}</div>
      <div class="p">${impTxt}</div></button>`;
  }).join('');
}

/* ------------------------------------------------------------------ PLOTIŠTĚ: panel */
function renderNow() {
  const L = state.local, c = L.current;
  const desc = WMO[c.weather_code] || '—';
  $('#now').innerHTML = `<div class="temp">${r1(c.temperature_2m)}<sup>°C</sup></div>
    <div><div class="desc">${desc}</div><div class="feel">${tx('pocitovo', 'pocitově')} ${r1(c.apparent_temperature)} °C · model ${fmtTime.format(c.time * 1000)}</div>${obsLine()}</div>`;
  const dir = c.wind_direction_10m;
  const trend = c.pressure_trend;
  const trendTxt = trend == null ? '' : (trend > 0.5 ? '↗' : trend < -0.5 ? '↘' : '→') + ' ' + (trend > 0 ? '+' : '') + r1(trend);
  $('#now-kv').innerHTML = `
    <div><dt>${tx('Vietor', 'Vítr')}</dt><dd><span class="arrow" style="transform:rotate(${dir + 180}deg)">↑</span> ${r0(c.wind_speed_10m)}<small>km/h ${DIR_SHORT[dirIdx(dir)]}</small></dd></div>
    <div><dt>Nárazy</dt><dd>${r0(c.wind_gusts_10m)}<small>km/h</small></dd></div>
    <div><dt>${tx('Vlhkosť', 'Vlhkost')}</dt><dd>${r0(c.relative_humidity_2m)}<small>%</small></dd></div>
    <div><dt>Tlak</dt><dd>${r0(c.pressure_msl)}<small>hPa</small></dd></div>
    <div><dt>${tx('Tendencia 3 h', 'Tendence 3 h')}</dt><dd>${trendTxt || '–'}<small>hPa</small></dd></div>
    <div><dt>${tx('Zrážky', 'Srážky')}</dt><dd>${r1(c.precipitation)}<small>mm</small></dd></div>`;
  if (L.elevation != null) $('#coords').textContent = `50.236° S · 15.790° V · ${Math.round(L.elevation)} m n. m.`;
}

function obsLine() {
  const O = state.obs;
  if (!O || state.demo.local) return '';
  for (let i = O.time.length - 1; i >= 0; i--) {
    if (O.t[i] == null) continue;
    const age = (Date.now() / 1000 - O.time[i]) / 3600;
    if (age > 6) return '';
    return `<div class="obs-line">${tx('namerané', 'naměřeno')} ${r1(O.t[i])} °C · nárazy ${r0(O.gust[i])} km/h · ČHMÚ ${fmtTime.format(O.time[i] * 1000)}</div>`;
  }
  return '';
}

const MODEL_NAME = Object.fromEntries(MODELS.map((m) => [m.id, m.name]));

function renderSkill() {
  const el = $('#skill');
  const S = state.skill;
  if (!S || state.demo.local) {
    el.innerHTML = `<h3>${tx('Presnosť modelov v Plotišti', 'Přesnost modelů v Plotišti')}</h3><p class="skill-lead">${tx('Vyhodnotenie sa zobrazí, keď GitHub Actions spracuje merania ČHMÚ (každú hodinu).', 'Vyhodnocení se zobrazí, až GitHub Actions zpracuje měření ČHMÚ (každou hodinu).')}</p>`;
    return;
  }
  const g = (m, k, L, f = 'mae_corr') => { const e = S.models[m] && S.models[m][k] && S.models[m][k][L]; return e ? (e[f] ?? e.mae) : null; };
  const ids = Object.keys(S.models).filter((m) => g(m, 't', 1) != null);
  const w = S.weights.t && S.weights.t[1] || {};
  ids.sort((a, b) => (w[b] || 0) - (w[a] || 0));
  const best = (k, L) => ids.reduce((b, m) => (g(m, k, L) != null && (b == null || g(m, k, L) < g(b, k, L)) ? m : b), null);
  const bt1 = best('t', 1), bt3 = best('t', 3), bg1 = best('g', 1);
  const maxW = Math.max(...ids.map((m) => w[m] || 0), 0.01);
  const rows = ids.map((m) => `<tr><td>${MODEL_NAME[m] || m}</td>
    <td class="${m === bt1 ? 'best' : ''}">${r1(g(m, 't', 1))}</td>
    <td class="${m === bt3 ? 'best' : ''}">${r1(g(m, 't', 3))}</td>
    <td class="${m === bg1 ? 'best' : ''}">${r0(g(m, 'g', 1))}</td>
    <td><span class="w"><i style="width:${Math.round(22 * (w[m] || 0) / maxW)}px"></i>${Math.round((w[m] || 0) * 100)} %</span></td></tr>`).join('');
  const T = S.test || {};
  const cmp = (k, L, unit, dec) => {
    const x = T[k] && T[k][L]; if (!x) return null;
    const gain = (x.mean - x.ai) / x.mean;
    const lvl = gain > 0.02 ? 'ok' : gain < -0.02 ? 'serious' : 'warn';
    const pctTxt = Math.abs(gain) < 0.01 ? tx('bez rozdielu', 'bez rozdílu') : `${gain > 0 ? 'o ' + Math.round(gain * 100) + tx(' % lepšie', ' % lépe') : 'o ' + Math.round(-gain * 100) + tx(' % horšie', ' % hůře')}`;
    return `<b>${r1(x.ai)}</b> vs <b>${r1(x.mean)}</b> ${unit} <span class="chip" data-level="${lvl}">${pctTxt.toUpperCase()}</span>`;
  };
  const ct = cmp('t', 1, '°C', true), cg = cmp('g', 1, 'km/h', false);
  el.innerHTML = `<h3>${tx('Presnosť modelov v Plotišti', 'Přesnost modelů v Plotišti')} · ${S.window.days} ${tx('dní', 'dní')}</h3>
    ${ct || cg ? `<p class="skill-lead">${tx('Priemerná chyba na zajtra za posledný týždeň, AI vs. obyčajný priemer modelov:', 'Průměrná chyba na zítřek za poslední týden, AI vs. obyčejný průměr modelů:')}
      ${ct ? `teplota ${ct}` : ''}${ct && cg ? ' · ' : ''}${cg ? `nárazy ${cg}` : ''}</p>` : ''}
    <div class="skill-wrap"><table class="skill">
      <thead><tr><th>Model</th><th title="${tx('Priemerná chyba teploty na zajtra', 'Průměrná chyba teploty na zítřek')}">°C D+1</th><th title="${tx('Priemerná chyba teploty o 3 dni', 'Průměrná chyba teploty za 3 dny')}">°C D+3</th><th title="${tx('Priemerná chyba nárazov na zajtra', 'Průměrná chyba nárazů na zítřek')}">km/h D+1</th><th>${tx('Váha AI', 'Váha AI')}</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="skill-note">${tx('Chyby po korekcii (°C, km/h); zelená = najlepší model. Merania', 'Chyby po korekci (°C, km/h); zelená = nejlepší model. Měření')}: ${S.station}.
      ${tx('Novšie dni majú väčšiu váhu. Pretrénované', 'Novější dny mají větší váhu. Přetrénováno')} ${dayLabel(S.updated)} ${fmtTime.format(S.updated * 1000)}.</div>`;
}

const HAZARDS = [
  ['gust60', tx('Silný vietor', 'Silný vítr'), 'nárazy ≥ 60 km/h'],
  ['gust90', tx('Víchrica', 'Vichřice'), 'nárazy ≥ 90 km/h'],
  ['rain10', tx('Výdatný dážď', 'Vydatný déšť'), tx('≥ 10 mm / deň', '≥ 10 mm / den')],
  ['rain25', tx('Prívalový dážď', 'Přívalový déšť'), tx('≥ 25 mm / deň', '≥ 25 mm / den')],
  ['storm', tx('Búrky', 'Bouřky'), tx('CAPE ≥ 500 + zrážky', 'CAPE ≥ 500 + srážky')],
  ['frost', tx('Mráz', 'Mráz'), 'min. teplota < 0 °C'],
  ['heat', tx('Horúčava', 'Horko'), 'max. teplota ≥ 30 °C'],
];

function renderRisk() {
  const D = state.derived;
  const head = `<tr><th></th>${D.days.map((d) => `<th>${dayShort(d.t)}</th>`).join('')}</tr>`;
  const rows = HAZARDS.map(([k, name, desc]) => `<tr><th class="h" scope="row">${name}<small>${desc}</small></th>${
    D.days.map((d) => { const p = d[k]; return `<td data-level="${levelOf(p)}" title="${name} – ${dayLabel(d.t)}: ${pct(p)} (${d.members} ${tx('členov', 'členů')})">${p == null ? '–' : Math.round(p * 100)}</td>`; }).join('')
  }</tr>`).join('');
  $('#risk').innerHTML = `<thead>${head}</thead><tbody>${rows}</tbody>`;
}

function renderSummary() {
  const D = state.derived, L = state.local;
  const [d0, d1] = D.days;
  const lines = [];
  const desc = (d) => `${r0(d.tmin)} až ${r0(d.tmax)} °C${d.rainMed >= 0.5 ? tx(`, zrážky okolo ${r1(d.rainMed)} mm`, `, srážky kolem ${r1(d.rainMed)} mm`) : tx(', bez výraznejších zrážok', ', bez výraznějších srážek')}`;
  if (d0) lines.push(`<b>Dnes</b> ${desc(d0)}.`);
  if (d1) lines.push(`<b>${tx('Zajtra', 'Zítra')}</b> ${desc(d1)}.`);
  // najvýraznejšie riziko v 7 dňoch
  let top = null;
  for (const d of D.days) for (const [k, name] of HAZARDS) {
    const p = d[k]; if (p != null && p >= 0.2 && (!top || p > top.p)) top = { p, name, t: d.t };
  }
  const near = state.tracks.find((t) => t.near < 800);
  const risk = top
    ? `${tx('Najvýraznejšie riziko', 'Nejvýraznější riziko')}: <span class="chip" data-level="${levelOf(top.p)}">${top.name.toUpperCase()} ${pct(top.p)}</span> ${dayLabel(top.t)}`
    : tx('V najbližších 7 dňoch sa nečakajú nebezpečné javy (všetky pod 20 %).', 'V nejbližších 7 dnech se neočekávají nebezpečné jevy (všechny pod 20 %).');
  const trk = near
    ? tx(` Tlaková níž ${near.label} (${r0(near.minP)} hPa) sa priblíži na ${r0(near.near)} km — ${dayLabel(near.nearAt.t)}`, ` Tlaková níže ${near.label} (${r0(near.minP)} hPa) se přiblíží na ${r0(near.near)} km — ${dayLabel(near.nearAt.t)}`)
    : '';
  // istota: priemerný rozptyl modelov v teplote na 72 h
  const sp = D.spread.t.slice(0, 72).filter((x) => x != null);
  const avg = sp.length ? sp.reduce((a, b) => a + b, 0) / sp.length : null;
  const conf = avg == null ? null : avg < 2 ? ['ok', tx('vysoká', 'vysoká')] : avg < 3.5 ? ['warn', tx('stredná', 'střední')] : ['serious', tx('nízka', 'nízká')];
  $('#summary').innerHTML = `<p>${lines.join(' ')}</p><p>${risk}${trk}</p>
    ${conf ? `<div class="conf">${tx('Zhoda modelov na 3 dni', 'Shoda modelů na 3 dny')}: <span class="chip" data-level="${conf[0]}">${conf[1].toUpperCase()}</span> · ${LANG === 'cs' ? 'průměrný rozdíl' : 'priemerný rozdiel'} ${r1(avg)} °C · ${Object.keys(L.models).length} ${LANG === 'cs' ? 'modelů' : 'modelov'}</div>` : ''}`;
}

/* ------------------------------------------------------------------ grafy (SVG) */
const charts = [];
let crossIdx = null;

function chart(el, cfg) {
  const o = { el, cfg };
  charts.push(o);
  el.innerHTML = `<div class="chart-head"><h3>${cfg.title}</h3><div class="chart-key"></div></div><svg></svg><div class="tip" hidden></div>`;
  o.svg = d3.select(el).select('svg');
  o.tip = el.querySelector('.tip');
  const move = (ev) => {
    const [mx] = d3.pointer(ev, o.svg.node());
    const i = Math.round(o.x.invert(mx));
    crossIdx = clamp(i, 0, state.local.times.length - 1);
    charts.forEach((c) => c.cross(crossIdx, c === o ? mx : null));
  };
  o.svg.on('pointermove', move).on('pointerleave', () => { crossIdx = null; charts.forEach((c) => c.cross(null)); });
  return o;
}

function drawChart(o) {
  const { cfg } = o;
  const L = state.local;
  const W = o.el.clientWidth || 300, H = cfg.height || 150;
  const m = { l: 34, r: 8, t: 8, b: 22 };
  const n = L.times.length;
  const x = d3.scaleLinear().domain([0, n - 1]).range([m.l, W - m.r]);
  const y = d3.scaleLinear().domain(cfg.domain()).nice().range([H - m.b, m.t]);
  o.x = x; o.y = y;
  o.el.querySelector('.chart-key').innerHTML = typeof cfg.key === 'function' ? cfg.key() : cfg.key;
  const svg = o.svg.attr('viewBox', `0 0 ${W} ${H}`).attr('height', H);
  svg.selectAll('*').remove();

  // noc
  const g0 = svg.append('g');
  for (const [rise, set] of L.sun) {
    const nextRise = rise + 86400;
    const i0 = L.times.findIndex((t) => t >= set), i1 = L.times.findIndex((t) => t >= nextRise);
    if (i0 < 0) continue;
    g0.append('rect').attr('x', x(i0)).attr('y', m.t).attr('width', x(i1 < 0 ? n - 1 : i1) - x(i0)).attr('height', H - m.b - m.t).attr('fill', '#ffffff06');
  }
  const firstRise = L.sun[0] && L.times.findIndex((t) => t >= L.sun[0][0]);
  if (firstRise > 0) g0.append('rect').attr('x', x(0)).attr('y', m.t).attr('width', x(firstRise) - x(0)).attr('height', H - m.b - m.t).attr('fill', '#ffffff06');

  // mriežka + os y
  const ticks = y.ticks(4);
  const gy = svg.append('g');
  ticks.forEach((t) => {
    gy.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(t)).attr('y2', y(t)).attr('stroke', t === 0 && cfg.zeroLine ? '#ffffff30' : '#ffffff0f');
    gy.append('text').attr('x', m.l - 6).attr('y', y(t) + 3).attr('text-anchor', 'end').text(String(t).replace('.', ','));
  });
  // dni
  const gd = svg.append('g').attr('class', 'day');
  L.times.forEach((t, i) => {
    if (localHour(t) !== 0) return;
    gd.append('line').attr('x1', x(i)).attr('x2', x(i)).attr('y1', m.t).attr('y2', H - m.b).attr('stroke', '#ffffff1c');
  });
  L.times.forEach((t, i) => {
    if (localHour(t) !== 12) return;
    gd.append('text').attr('x', x(i)).attr('y', H - 6).attr('text-anchor', 'middle').text(dayShort(t));
  });

  cfg.draw(svg, x, y, W, H, m);

  // zvýraznenie "teraz"
  const nowI = L.times.findIndex((t) => t > Date.now() / 1000) - 1;
  if (nowI >= 0) {
    svg.append('line').attr('x1', x(nowI)).attr('x2', x(nowI)).attr('y1', m.t).attr('y2', H - m.b).attr('stroke', '#8fd3ff').attr('stroke-dasharray', '2 3').attr('opacity', 0.7);
    svg.append('text').attr('x', x(nowI) + 4).attr('y', m.t + 9).text(tx('teraz', 'nyní')).style('fill', '#8fd3ff');
  }
  o.crossLine = svg.append('line').attr('y1', m.t).attr('y2', H - m.b).attr('stroke', '#dbe5f2').attr('stroke-width', 1).attr('opacity', 0);
  o.crossDot = svg.append('circle').attr('r', 4).attr('fill', '#8fd3ff').attr('stroke', '#0a111e').attr('stroke-width', 2).attr('opacity', 0);
  // väčší zásah pre myš
  svg.append('rect').attr('x', m.l).attr('y', 0).attr('width', W - m.l - m.r).attr('height', H).attr('fill', 'transparent');

  o.cross = (i, mx) => {
    if (i == null) { o.crossLine.attr('opacity', 0); o.crossDot.attr('opacity', 0); o.tip.hidden = true; return; }
    const v = cfg.value(i);
    o.crossLine.attr('x1', x(i)).attr('x2', x(i)).attr('opacity', 0.35);
    if (v != null) o.crossDot.attr('cx', x(i)).attr('cy', y(v)).attr('opacity', 1);
    if (mx == null) { o.tip.hidden = true; return; }
    o.tip.innerHTML = `<b>${dayLabel(L.times[i])} ${fmtTime.format(L.times[i] * 1000)}</b><hr>${cfg.tip(i)}`;
    o.tip.hidden = false;
    const tw = o.tip.offsetWidth;
    o.tip.style.left = (mx + 14 + tw > W ? mx - tw - 14 : mx + 14) + 'px';
    o.tip.style.top = '28px';
  };
}

function setupCharts() {
  charts.length = 0;
  const L = () => state.local, D = () => state.derived;
  const row = (a, b) => `<div class="r"><span>${a}</span><span>${b}</span></div>`;
  const modelRows = (v, f) => MODELS.filter((mm) => L().models[mm.id]).map((mm) => row(mm.name, f(L().models[mm.id][v][crossIdx ?? 0]))).join('');
  const line = (vals, x, y) => d3.line().defined((d) => d != null).x((_, i) => x(i)).y((d) => y(d)).curve(d3.curveMonotoneX)(vals);
  const area = (lo, hi, x, y) => d3.area().defined((_, i) => lo[i] != null && hi[i] != null).x((_, i) => x(i)).y0((_, i) => y(lo[i])).y1((_, i) => y(hi[i])).curve(d3.curveMonotoneX)(lo);

  const K = { ai: tx('AI predpoveď', 'AI předpověď'), mean: tx('priemer modelov', 'průměr modelů'), obs: tx('namerané', 'naměřeno'),
    Ai: tx('AI predpoveď', 'AI předpověď'), Mean: tx('Priemer modelov', 'Průměr modelů'), Obs: tx('Namerané', 'Naměřeno') };
  chart($('#ch-temp'), {
    title: 'Teplota [°C]', height: 170, zeroLine: true,
    key: () => (D().ai ? `<span><i style="--c:#8fd3ff"></i>${K.ai}</span><span><i class="thin" style="--c:#dbe5f2"></i>${K.mean}</span>` : `<span><i style="--c:#8fd3ff"></i>${K.mean}</span>`)
      + (D().obs ? `<span><i style="--c:${OBS_COLOR}"></i>${K.obs}</span>` : '')
      + `<span><i class="thin" style="--c:#6b7a92"></i>${tx('jednotlivé modely', 'jednotlivé modely')}</span><span><i class="band" style="--c:#8fd3ff"></i>ensemble 10–90 %</span>`,
    domain: () => {
      const all = [...Object.values(L().models).flatMap((mm) => mm.t), ...D().band.t[0], ...D().band.t[1], ...(D().obs ? D().obs.t : [])].filter((v) => v != null);
      return [Math.min(...all) - 1, Math.max(...all) + 1];
    },
    draw: (svg, x, y) => {
      svg.append('path').attr('d', area(D().band.t[0], D().band.t[1], x, y)).attr('fill', '#8fd3ff').attr('opacity', 0.14);
      for (const mm of Object.values(L().models)) svg.append('path').attr('d', line(mm.t, x, y)).attr('fill', 'none').attr('stroke', '#6b7a92').attr('stroke-width', 1).attr('opacity', 0.55);
      if (D().ai) {
        svg.append('path').attr('d', line(D().cons.t, x, y)).attr('fill', 'none').attr('stroke', '#dbe5f2').attr('stroke-width', 1).attr('stroke-dasharray', '3 3').attr('opacity', 0.7);
        svg.append('path').attr('d', line(D().ai.t, x, y)).attr('fill', 'none').attr('stroke', AI_COLOR).attr('stroke-width', 2);
      } else {
        svg.append('path').attr('d', line(D().cons.t, x, y)).attr('fill', 'none').attr('stroke', AI_COLOR).attr('stroke-width', 2);
      }
      if (D().obs) svg.append('path').attr('d', line(D().obs.t, x, y)).attr('fill', 'none').attr('stroke', OBS_COLOR).attr('stroke-width', 2);
    },
    value: (i) => (D().ai ? D().ai.t[i] : D().cons.t[i]),
    tip: (i) => (D().obs && D().obs.t[i] != null ? row(K.Obs, r1(D().obs.t[i]) + ' °C') : '')
      + (D().ai ? row(K.Ai, r1(D().ai.t[i]) + ' °C') : '') + row(K.Mean, r1(D().cons.t[i]) + ' °C')
      + row('Ensemble 10–90 %', `${r1(D().band.t[0][i])} – ${r1(D().band.t[1][i])}`) + '<hr>' + modelRows('t', (v) => r1(v) + ' °C'),
  });

  chart($('#ch-rain'), {
    title: tx('Zrážky [mm/h]', 'Srážky [mm/h]'), height: 130,
    key: `<span><i class="band" style="--c:#8f9cff"></i>${K.mean}</span><span>${tx('pásik = pravdepodobnosť zrážok (ensemble)', 'proužek = pravděpodobnost srážek (ensemble)')}</span>`,
    domain: () => [0, Math.max(1, ...D().cons.p.filter((v) => v != null)) * 1.1],
    draw: (svg, x, y, W, H, m) => {
      const bw = Math.max(1, (x(1) - x(0)) - 1);
      D().cons.p.forEach((v, i) => {
        if (!v || v < 0.05) return;
        svg.append('rect').attr('x', x(i) - bw / 2).attr('width', bw).attr('y', y(v)).attr('height', Math.max(1, y(0) - y(v))).attr('rx', Math.min(2, bw / 2)).attr('fill', '#8f9cff');
      });
      // pásik pravdepodobnosti nad grafom osi x
      const probY = H - m.b + 1;
      D().pRain.forEach((p, i) => {
        if (p == null) return;
        svg.append('rect').attr('x', x(i) - (x(1) - x(0)) / 2).attr('width', x(1) - x(0) + 0.5).attr('y', probY).attr('height', 4)
          .attr('fill', '#8f9cff').attr('opacity', 0.08 + 0.92 * p);
      });
    },
    value: (i) => D().cons.p[i],
    tip: (i) => (D().obs && D().obs.precip[i] != null ? row(K.Obs, r1(D().obs.precip[i]) + ' mm') : '')
      + row(K.Mean, r1(D().cons.p[i]) + ' mm') + row(tx('Pravdep. zrážok', 'Pravděp. srážek'), pct(D().pRain[i])) + '<hr>' + modelRows('p', (v) => r1(v) + ' mm'),
  });

  chart($('#ch-wind'), {
    title: tx('Nárazy vetra [km/h]', 'Nárazy větru [km/h]'), height: 150,
    key: () => (D().ai ? `<span><i style="--c:#5fc0f0"></i>${K.ai}</span>` : `<span><i style="--c:#5fc0f0"></i>${K.mean}</span>`)
      + (D().obs ? `<span><i style="--c:${OBS_COLOR}"></i>${K.obs}</span>` : '')
      + `<span><i class="band" style="--c:#5fc0f0"></i>ensemble 10–90 %</span><span><i class="thin" style="--c:#ff8a3d"></i>${tx('prahy', 'prahy')} 60 / 90</span>`,
    domain: () => [0, Math.max(70, ...D().band.g[1].filter((v) => v != null), ...D().cons.g.filter((v) => v != null), ...(D().obs ? D().obs.gust.filter((v) => v != null) : [])) + 5],
    draw: (svg, x, y, W, H, m) => {
      svg.append('path').attr('d', area(D().band.g[0], D().band.g[1], x, y)).attr('fill', '#5fc0f0').attr('opacity', 0.14);
      for (const [v, lab] of [[60, tx('silný vietor', 'silný vítr')], [90, tx('víchrica', 'vichřice')]]) {
        if (v > y.domain()[1]) continue;
        svg.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(v)).attr('y2', y(v)).attr('stroke', '#ff8a3d').attr('stroke-dasharray', '4 4').attr('opacity', 0.6);
        svg.append('text').attr('x', W - m.r - 2).attr('y', y(v) - 3).attr('text-anchor', 'end').text(lab);
      }
      svg.append('path').attr('d', line(D().ai ? D().ai.g : D().cons.g, x, y)).attr('fill', 'none').attr('stroke', '#5fc0f0').attr('stroke-width', 2);
      if (D().obs) svg.append('path').attr('d', line(D().obs.gust, x, y)).attr('fill', 'none').attr('stroke', OBS_COLOR).attr('stroke-width', 1.5);
    },
    value: (i) => (D().ai ? D().ai.g : D().cons.g)[i],
    tip: (i) => (D().obs && D().obs.gust[i] != null ? row(K.Obs, r0(D().obs.gust[i]) + ' km/h') : '')
      + (D().ai ? row(K.Ai, r0(D().ai.g[i]) + ' km/h') : '') + row(K.Mean, r0(D().cons.g[i]) + ' km/h')
      + row('Ensemble 10–90 %', `${r0(D().band.g[0][i])} – ${r0(D().band.g[1][i])}`) + '<hr>' + modelRows('g', (v) => r0(v) + ' km/h'),
  });
}

function drawCharts() { if (state.local) charts.forEach(drawChart); }

/* ------------------------------------------------------------------ ZRÁŽKY DETAILNE (15 min + po hodinách) */
const HIRES = [
  { id: 'icon_d2', name: 'ICON-D2', res: '2 km' },
  { id: 'knmi_harmonie_arome_europe', name: 'HARMONIE KNMI', res: '2 km' },
  { id: 'dmi_harmonie_arome_europe', name: 'HARMONIE DMI', res: '2 km' },
  { id: 'icon_eu', name: 'ICON-EU', res: '7 km' },
];
const WET = 0.05; // mm za 15 min (= 0,2 mm/h)
// intenzita podľa mm/h
const RAIN_CLASSES = [
  { min: 0.1, name: tx('slabý', 'slabý'), color: '#2f4f8f' },
  { min: 1, name: tx('mierny', 'mírný'), color: '#4f7be0' },
  { min: 4, name: tx('silný', 'silný'), color: '#93acff' },
  { min: 10, name: tx('prívalový', 'přívalový'), color: '#e6ebff' },
];
const rainClass = (mmh) => { let c = null; for (const k of RAIN_CLASSES) if (mmh >= k.min) c = k; return c; };

async function loadPrecipLive() {
  const base = { latitude: HK.lat, longitude: HK.lon, timezone: TZ, timeformat: 'unixtime' };
  const [m15, hr] = await Promise.all([
    fetchJSON('https://api.open-meteo.com/v1/forecast?' + qs({ ...base, models: 'icon_d2', minutely_15: 'precipitation,snowfall', forecast_minutely_15: 192, past_minutely_15: 8 })),
    fetchJSON('https://api.open-meteo.com/v1/forecast?' + qs({ ...base, models: HIRES.map((m) => m.id).join(','), hourly: 'precipitation,snowfall', forecast_hours: 48, past_hours: 2 })),
  ]);
  const models = {};
  for (const m of HIRES) {
    const a = hr.hourly['precipitation_' + m.id];
    if (a && a.some((v) => v != null)) models[m.id] = a;
  }
  return {
    m15: { time: m15.minutely_15.time, p: m15.minutely_15.precipitation, snow: m15.minutely_15.snowfall },
    hourly: { time: hr.hourly.time, models },
  };
}

function demoPrecip() {
  const now = Math.floor(Date.now() / 900000) * 900;
  const time = [], p = [], snow = [];
  for (let i = -8; i < 192; i++) {
    const t = now + i * 900, h = i / 4;
    time.push(t);
    const v = Math.max(0, 0.9 * Math.exp(-(((h - 3) / 0.9) ** 2)) + 0.25 * Math.exp(-(((h - 5.5) / 1.4) ** 2)) + 0.4 * Math.exp(-(((h - 30) / 2) ** 2)) - 0.03);
    p.push(+v.toFixed(2)); snow.push(0);
  }
  const ht = [], models = {};
  const h0 = Math.floor(Date.now() / 3600000) * 3600;
  for (let i = -2; i < 48; i++) ht.push(h0 + i * 3600);
  HIRES.forEach((m, k) => {
    models[m.id] = ht.map((t) => {
      let s = 0; for (let q = 0; q < 4; q++) { const j = time.indexOf(t - q * 900); if (j >= 0) s += p[j]; }
      return +Math.max(0, s * (0.7 + 0.15 * k) + (k - 1.5) * 0.1).toFixed(1);
    });
  });
  return { m15: { time, p, snow }, hourly: { time: ht, models } };
}

function precipHeadline(P) {
  const { time, p, snow } = P.m15;
  const now = Date.now() / 1000;
  const i0 = time.findIndex((t) => t > now);
  if (i0 < 0) return tx('Krátkodobá predpoveď zrážok nie je k dispozícii.', 'Krátkodobá předpověď srážek není k dispozici.');
  const end12 = Math.min(time.length, i0 + 48);
  const sum = (a, b) => p.slice(a, b).reduce((s, v) => s + (v || 0), 0);
  const isSnow = (a, b) => snow.slice(a, b).some((v) => v > 0.05);
  const kind = (a, b) => (isSnow(a, b) ? tx('sneženie', 'sněžení') : tx('dážď', 'déšť'));
  const at = (i) => fmtTime.format((time[i] - 900) * 1000); // začiatok 15-min intervalu
  // práve prší? (model alebo posledné meranie ČHMÚ)
  const O = state.obs && !state.demo.local ? state.obs : null;
  const lastObs = O ? O.precip.length - 1 : -1;
  const obsWet = O && lastObs >= 0 && now - O.time[lastObs] < 2 * 3600 && (O.precip[lastObs] || 0) >= 0.1;
  const wetNow = (p[i0] || 0) >= WET || ((p[i0 - 1] || 0) >= WET);
  const obsTxt = obsWet ? tx(` ČHMÚ za poslednú hodinu nameralo ${r1(O.precip[lastObs])} mm.`, ` ČHMÚ za poslední hodinu naměřil ${r1(O.precip[lastObs])} mm.`) : '';
  if (wetNow || obsWet) {
    let e = i0;
    while (e < end12) {
      if (p.slice(e, e + 4).every((v) => (v || 0) < WET)) break;
      e++;
    }
    const k = cap(kind(i0, e));
    if (e >= end12) return tx(`<b>${k} pokračuje</b> aj ďalších 12 hodín, spolu asi ${r1(sum(i0, end12))} mm.`, `<b>${k} pokračuje</b> i dalších 12 hodin, celkem asi ${r1(sum(i0, end12))} mm.`) + obsTxt;
    if (e === i0) return tx('<b>Zrážky práve slabnú</b> a podľa ICON-D2 by mali do 15 minút ustať.', '<b>Srážky právě slábnou</b> a podle ICON-D2 by měly do 15 minut ustat.') + obsTxt;
    return tx(`<b>${k} skončí okolo ${at(e)}</b>. Do konca ešte asi ${r1(sum(i0, e))} mm.`, `<b>${k} skončí kolem ${at(e)}</b>. Do konce ještě asi ${r1(sum(i0, e))} mm.`) + obsTxt;
  }
  const s = p.findIndex((v, i) => i >= i0 && i < end12 && (v || 0) >= WET);
  if (s >= 0) {
    let e = s; while (e < time.length && !p.slice(e, e + 4).every((v) => (v || 0) < WET)) e++;
    const peak = Math.max(...p.slice(s, e)) * 4;
    const cls = rainClass(peak);
    // zhoda modelov s vysokým rozlíšením v hodine začiatku
    const hIdx = P.hourly.time.findIndex((t) => t >= time[s]);
    const ids = Object.keys(P.hourly.models);
    const agree = hIdx >= 0 ? ids.filter((id) => [0, 1].some((d) => (P.hourly.models[id][hIdx + d] || 0) >= 0.1)).length : 0;
    const mins = Math.round((time[s] - 900 - now) / 60);
    const when = mins < 60 ? tx(`o ${Math.max(5, Math.round(mins / 5) * 5)} min (${at(s)})`, `za ${Math.max(5, Math.round(mins / 5) * 5)} min (${at(s)})`) : tx(`okolo ${at(s)}`, `kolem ${at(s)}`);
    return tx(`<b>${cap(kind(s, e))} začne ${when}</b>${cls ? `, ${cls.name}` : ''}, spolu asi ${r1(sum(s, e))} mm.
      Zhoda modelov s vysokým rozlíšením: ${agree} zo ${ids.length}.`, `<b>${cap(kind(s, e))} začne ${when}</b>${cls ? `, ${cls.name}` : ''}, celkem asi ${r1(sum(s, e))} mm.
      Shoda modelů s vysokým rozlišením: ${agree} z ${ids.length}.`);
  }
  // nič v 12 h – ďalšie zrážky v 48 h podľa ICON-D2 / priemeru
  const n = p.findIndex((v, i) => i >= end12 && (v || 0) >= WET);
  return tx(`<b>Najbližších 12 hodín bez zrážok.</b>${n >= 0 ? ` Ďalšie zrážky asi ${dayShort(time[n])} okolo ${at(n)}.` : ' Ani do 48 hodín sa podľa ICON-D2 zrážky nečakajú.'}`,
    `<b>Nejbližších 12 hodin bez srážek.</b>${n >= 0 ? ` Další srážky asi ${dayShort(time[n])} kolem ${at(n)}.` : ' Ani do 48 hodin se podle ICON-D2 srážky neočekávají.'}`);
}

let precipChart = null;
function renderPrecip() {
  const el = $('#precip');
  const P = state.precip;
  if (!P) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="chart-head"><h3>${tx('Zrážky detailne', 'Srážky podrobně')}</h3>
      <div class="seg" role="group" aria-label="${tx('Rozsah', 'Rozsah')}" id="precip-range">
        <button type="button" data-h="3" aria-pressed="${state.precipRange === 3}">3 h</button>
        <button type="button" data-h="12" aria-pressed="${state.precipRange === 12}">12 h</button>
        <button type="button" data-h="48" aria-pressed="${state.precipRange === 48}">48 h</button></div></div>
    ${state.radar ? `<p class="precip-radar" data-level="${state.radar.summary.level}"><span class="lbl">Radar ${state.radar.summary.time}</span> ${state.radar.summary.html}</p>` : ''}
    <p class="precip-head"><span class="lbl">${tx('Model ICON-D2', 'Model ICON-D2')}</span> ${precipHeadline(P)}</p>
    <div class="chart" id="ch-m15"><svg></svg><div class="tip" hidden></div></div>
    <div class="precip-key">${RAIN_CLASSES.map((c) => `<span style="--c:${c.color}">${c.name}${c.min === 10 ? ' ≥ 10' : ''}</span>`).join('')}<span class="u">mm/h · po 15 min · ICON-D2 2 km</span></div>
    <h3 class="sub-h">${tx('Po hodinách · modely s vysokým rozlíšením [mm]', 'Po hodinách · modely s vysokým rozlišením [mm]')}</h3>
    <div class="pm-wrap">${precipMatrix(P)}</div>
    <div class="skill-note">${tx('Hodnota pri hodine = úhrn za nasledujúcu hodinu (napr. 14 = 14:00–15:00). Načasovanie prehánok má neistotu asi ±1 h; keď sa modely zhodujú, predpoveď je spoľahlivejšia.',
      'Hodnota u hodiny = úhrn za následující hodinu (např. 14 = 14:00–15:00). Načasování přeháněk má nejistotu asi ±1 h; když se modely shodují, předpověď je spolehlivější.')}</div>`;
  el.querySelectorAll('#precip-range button').forEach((b) => b.addEventListener('click', () => {
    state.precipRange = +b.dataset.h;
    try { localStorage.setItem('mp-precip-range', b.dataset.h); } catch { /* nevadí */ }
    renderPrecip();
  }));
  drawPrecipChart();
}

function precipMatrix(P) {
  const now = Date.now() / 1000;
  const H = P.hourly;
  // hodnota v čase T = úhrn za hodinu pred T → stĺpec označíme začiatkom hodiny
  const cols = H.time.map((t, i) => ({ t, i })).filter((c) => c.t > now - 3600 + 1).slice(0, 24);
  const cell = (v) => {
    if (v == null) return '<td class="na">·</td>';
    const c = rainClass(v);
    return c ? `<td style="--c:${c.color}" data-c="${RAIN_CLASSES.indexOf(c)}">${r1(v)}</td>` : '<td class="dry">·</td>';
  };
  const head = `<tr><th></th>${cols.map((c) => `<th>${localHour(c.t - 3600)}</th>`).join('')}</tr>`;
  const ids = HIRES.filter((m) => H.models[m.id]);
  const rows = ids.map((m) => `<tr><th class="m">${m.name}<small>${m.res}</small></th>${cols.map((c) => cell(H.models[m.id][c.i])).join('')}</tr>`);
  // pravdepodobnosť z ensemble (hodinové časy z hlavnej predpovede)
  if (state.derived && state.local) {
    const li = new Map(state.local.times.map((t, i) => [t, i]));
    rows.push(`<tr class="prob"><th class="m">${tx('Pravdepodobnosť', 'Pravděpodobnost')}<small>ensemble ≥ 0,1 mm</small></th>${cols.map((c) => {
      const i = li.get(c.t); const pr = i == null ? null : state.derived.pRain[i];
      return pr == null ? '<td class="na">·</td>' : `<td style="--a:${(0.1 + 0.9 * pr).toFixed(2)}">${Math.round(pr * 100)}</td>`;
    }).join('')}</tr>`);
  }
  // dni nad stĺpcami
  const days = [];
  cols.forEach((c) => { const d = dayShort(c.t - 3600); if (!days.length || days[days.length - 1].d !== d) days.push({ d, n: 1 }); else days[days.length - 1].n++; });
  const dayRow = `<tr class="days"><th></th>${days.map((d) => `<th colspan="${d.n}">${d.n >= 3 ? d.d : ''}</th>`).join('')}</tr>`;
  return `<table class="pm"><thead>${dayRow}${head}</thead><tbody>${rows.join('')}</tbody></table>`;
}

function drawPrecipChart() {
  const P = state.precip; if (!P) return;
  const el = $('#ch-m15'); if (!el) return;
  const svg = d3.select(el).select('svg'), tip = el.querySelector('.tip');
  const now = Date.now() / 1000;
  const hours = state.precipRange;
  const { time, p, snow } = P.m15;
  const idx = time.map((t, i) => i).filter((i) => time[i] > now - 3600 && time[i] <= now + hours * 3600 + 1);
  if (!idx.length) { svg.selectAll('*').remove(); return; }
  const W = el.clientWidth || 300, H = 130, m = { l: 30, r: 6, t: 8, b: 20 };
  const t0 = time[idx[0]] - 900, t1 = time[idx[idx.length - 1]];
  const x = d3.scaleLinear().domain([t0, t1]).range([m.l, W - m.r]);
  const maxR = Math.max(2, ...idx.map((i) => (p[i] || 0) * 4));
  const y = d3.scaleLinear().domain([0, maxR]).nice().range([H - m.b, m.t]);
  svg.attr('viewBox', `0 0 ${W} ${H}`).attr('height', H).selectAll('*').remove();
  y.ticks(3).forEach((v) => {
    svg.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(v)).attr('y2', y(v)).attr('stroke', '#ffffff10');
    svg.append('text').attr('x', m.l - 5).attr('y', y(v) + 3).attr('text-anchor', 'end').text(String(v).replace('.', ','));
  });
  // osi času
  const stepH = hours <= 3 ? 0.5 : hours <= 12 ? 2 : 6;
  for (let t = Math.ceil(t0 / (stepH * 3600)) * stepH * 3600; t <= t1; t += stepH * 3600) {
    svg.append('line').attr('x1', x(t)).attr('x2', x(t)).attr('y1', m.t).attr('y2', H - m.b).attr('stroke', '#ffffff0d');
    svg.append('text').attr('x', x(t)).attr('y', H - 5).attr('text-anchor', 'middle').text(fmtTime.format(t * 1000));
  }
  const bw = Math.max(1, x(t0 + 900) - x(t0) - (hours <= 12 ? 2 : 0.5));
  for (const i of idx) {
    const r = (p[i] || 0) * 4, c = rainClass(r);
    if (!c) continue;
    svg.append('rect').attr('x', x(time[i] - 900) + (hours <= 12 ? 1 : 0.25)).attr('width', bw).attr('y', y(r)).attr('height', Math.max(1.5, y(0) - y(r)))
      .attr('rx', Math.min(2, bw / 2)).attr('fill', c.color).attr('stroke', snow[i] > 0.02 ? '#ffffff' : 'none').attr('stroke-width', 0.8);
  }
  svg.append('line').attr('x1', x(now)).attr('x2', x(now)).attr('y1', m.t).attr('y2', H - m.b).attr('stroke', '#8fd3ff').attr('stroke-dasharray', '2 3');
  svg.append('text').attr('x', x(now) + 4).attr('y', m.t + 9).text(tx('teraz', 'nyní')).style('fill', '#8fd3ff');
  const cross = svg.append('rect').attr('y', m.t).attr('height', H - m.b - m.t).attr('width', bw).attr('fill', '#ffffff14').attr('opacity', 0);
  svg.append('rect').attr('x', m.l).attr('y', 0).attr('width', W - m.l - m.r).attr('height', H).attr('fill', 'transparent')
    .on('pointermove', (ev) => {
      const [mx] = d3.pointer(ev);
      const t = x.invert(mx);
      const i = idx.reduce((b, k) => (Math.abs(time[k] - 450 - t) < Math.abs(time[b] - 450 - t) ? k : b), idx[0]);
      const r = (p[i] || 0) * 4, c = rainClass(r);
      cross.attr('x', x(time[i] - 900)).attr('opacity', 1);
      tip.innerHTML = `<b>${fmtTime.format((time[i] - 900) * 1000)}–${fmtTime.format(time[i] * 1000)}</b><hr>
        <div class="r"><span>${tx('Úhrn', 'Úhrn')}</span><span>${r1(p[i])} mm</span></div><div class="r"><span>Intenzita</span><span>${r1(r)} mm/h</span></div>
        <div class="r"><span>Typ</span><span>${c ? (snow[i] > 0.02 ? tx('sneženie, ', 'sněžení, ') : '') + c.name : tx('bez zrážok', 'bez srážek')}</span></div>`;
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = (mx + 12 + tw > W ? mx - tw - 12 : mx + 12) + 'px'; tip.style.top = '6px';
    })
    .on('pointerleave', () => { cross.attr('opacity', 0); tip.hidden = true; });
}

/* ------------------------------------------------------------------ RADAR (RainViewer) + vlastný nowcast
 * Dlaždice z7 (3×3 okolo Plotišťa, ~600 km), farby „Universal Blue“ sa prevedú späť na dBZ.
 * Odhad pohybu: porovnanie posledných snímok po blokoch (block matching), potom posun poslednej snímky
 * po vektoroch pohybu až 90 min dopredu (semi-Lagrangeovská extrapolácia).
 */
const RZ = 7, RX0 = 68, RY0 = 42, RT = 3, RW = 256 * RT;
const R_FRAMES = 7, R_FC = 9;              // 60 min histórie, 90 min odhadu (krok 10 min)
const KM_PX = 156.543 * Math.cos(HK.lat * Math.PI / 180) / 2 ** RZ; // km na pixel
const R_WET = 15;                           // dBZ ≈ 0,3 mm/h
// RainViewer „Universal Blue“, dBZ −10 … 95
const UB = '63615914,66635a19,69665c1e,6c685d24,6f6b5f29,726e612e,75706234,78736439,7c75653e,7f786744,827b6949,857d6a4e,88806c54,8b826d59,8e856f5e,92887164,9e93756e,aa9e7978,b6a97e82,c2b4828c,cec08796,d2c48ba0,d6c88faa,dacc93b4,ded097be,88ddeeff,6cd1ebff,51c5e8ff,36bae5ff,1baee2ff,00a3e0ff,009ad5ff,0091caff,0088bfff,007fb4ff,0077aaff,0070a3ff,00699cff,006295ff,005b8eff,005588ff,005180ff,004e78ff,004a70ff,004768ff,ffee00ff,ffe000ff,ffd200ff,ffc500ff,ffb700ff,ffaa00ff,ff9f00ff,ff9500ff,ff8b00ff,ff8100ff,ff4400ff,f23600ff,e62800ff,d91b00ff,cd0d00ff,c10000ff,a80000ff,8f0000ff,760000ff,5d0000ff,ffaaffff,ff9fffff,ff95ffff,ff8bffff,ff81ffff,ff77ffff,ff6cffff,ff62ffff,ff58ffff,ff4effff,ffffffff,ffffffff,ffffffff,ffffffff,ffffffff,ffffffff,ffffffff,ffffffff,ffffffff,ffffffff,00ff00ff,00ff00ff,00ff00ff,00ff00ff,00ff00ff,00ff00ff,00ff00ff,00ff00ff,00ff00ff,00ff00ff,00ff00ff,00ff00ff,00ff00ff,00ff00ff,00ff00ff,00ff00ff,00ff00ff,00ff00ff,00ff00ff,00ff00ff,00ff00ff'.split(',');
const UB_RGB = new Map(), UB_ALPHA = [];
UB.forEach((h, i) => {
  const n = parseInt(h, 16) >>> 0, a = n & 255, rgb = n >>> 8, dbz = i - 10;
  if (a === 255) { if (!UB_RGB.has(rgb)) UB_RGB.set(rgb, dbz); } else UB_ALPHA.push([a, dbz]);
});
const NO_ECHO = -128;
const rateOf = (dbz) => (dbz <= NO_ECHO ? 0 : (10 ** (dbz / 10) / 200) ** 0.625); // Marshall–Palmer
function decodeColor(r, g, b, a) {
  if (a === 0) return NO_ECHO;
  if (a < 250) { // slabé echá sú kódované priesvitnosťou
    let best = UB_ALPHA[0];
    for (const x of UB_ALPHA) if (Math.abs(x[0] - a) < Math.abs(best[0] - a)) best = x;
    return best[1];
  }
  const key = (r << 16) | (g << 8) | b;
  const hit = UB_RGB.get(key);
  if (hit != null) return hit;
  let bd = Infinity, bz = NO_ECHO;
  for (const [k, z] of UB_RGB) {
    const d = (((k >> 16) & 255) - r) ** 2 + (((k >> 8) & 255) - g) ** 2 + ((k & 255) - b) ** 2;
    if (d < bd) { bd = d; bz = z; }
  }
  UB_RGB.set(key, bz);
  return bz;
}

// pixel (0…768) ↔ zemepisné súradnice (Web Mercator)
const rPx = (lon, lat) => {
  const n = 2 ** RZ * 256, s = Math.sin(lat * Math.PI / 180);
  return [(lon + 180) / 360 * n - RX0 * 256, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n - RY0 * 256];
};
const rLonLat = (x, y) => {
  const n = 2 ** RZ * 256;
  return [(x + RX0 * 256) / n * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + RY0 * 256) / n))) * 180 / Math.PI];
};
const HK_PX = rPx(HK.lon, HK.lat);

const radarTileCache = new Map();
function loadImg(url) {
  return new Promise((res, rej) => {
    const im = new Image(); im.crossOrigin = 'anonymous';
    im.onload = () => res(im); im.onerror = () => rej(new Error('tile ' + url));
    im.src = url;
  });
}
async function loadRadarFrame(host, f) {
  if (radarTileCache.has(f.path)) return radarTileCache.get(f.path);
  const cv = document.createElement('canvas'); cv.width = cv.height = RW;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  await Promise.all([0, 1, 2].flatMap((dx) => [0, 1, 2].map(async (dy) => {
    const im = await loadImg(`${host}${f.path}/256/${RZ}/${RX0 + dx}/${RY0 + dy}/2/0_0.png`);
    ctx.drawImage(im, dx * 256, dy * 256);
  })));
  const d = ctx.getImageData(0, 0, RW, RW).data;
  const z = new Int8Array(RW * RW);
  for (let i = 0; i < z.length; i++) z[i] = decodeColor(d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]);
  const fr = { time: f.time, z };
  radarTileCache.set(f.path, fr);
  return fr;
}

async function loadRadar() {
  const meta = await fetchJSON('https://api.rainviewer.com/public/weather-maps.json', 15000);
  const past = meta.radar.past.slice(-R_FRAMES);
  const frames = await Promise.all(past.map((f) => loadRadarFrame(meta.host, f)));
  for (const k of radarTileCache.keys()) if (!past.some((f) => f.path === k)) radarTileCache.delete(k);
  const motion = estimateMotion(frames);
  const fc = motion ? extrapolate(frames[frames.length - 1], motion) : [];
  const r = { frames, fc, motion };
  r.summary = radarSummary(r);
  return r;
}

/* ---- odhad pohybu: bloky 32×32 na 4× zmenšenej mriežke, hľadanie posunu ±8 px (= ±25 km / 10 min) */
function downsample(z) {
  const N = RW / 4, out = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let s = 0;
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { const v = z[(y * 4 + j) * RW + x * 4 + i]; if (v >= 10) s += v; }
    out[y * N + x] = s / 16;
  }
  return out;
}
const median = (a) => { if (!a.length) return null; const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };

function estimateMotion(frames) {
  const N = RW / 4, B = 32, NB = N / B, S = 8;
  const ds = frames.map((f) => downsample(f.z));
  const per = Array.from({ length: NB * NB }, () => ({ x: [], y: [] }));
  for (let k = Math.max(1, frames.length - 3); k < frames.length; k++) {
    if (Math.abs(frames[k].time - frames[k - 1].time - 600) > 120) continue;
    const a = ds[k - 1], b = ds[k];
    for (let by = 0; by < NB; by++) for (let bx = 0; bx < NB; bx++) {
      let echo = 0;
      for (let y = by * B; y < by * B + B; y++) for (let x = bx * B; x < bx * B + B; x++) if (b[y * N + x] > 5) echo++;
      if (echo < B * B * 0.08) continue;
      let best = Infinity, bv = null;
      for (let dy = -S; dy <= S; dy++) for (let dx = -S; dx <= S; dx++) {
        let cost = 0, n = 0;
        for (let y = by * B; y < by * B + B; y += 2) {
          const py = y - dy; if (py < 0 || py >= N) continue;
          for (let x = bx * B; x < bx * B + B; x += 2) {
            const px = x - dx; if (px < 0 || px >= N) continue;
            cost += Math.abs(b[y * N + x] - a[py * N + px]); n++;
          }
        }
        if (n < 64) continue;
        cost = cost / n + 0.02 * (dx * dx + dy * dy); // mierne preferovať menší posun
        if (cost < best) { best = cost; bv = [dx, dy]; }
      }
      if (bv) { per[by * NB + bx].x.push(bv[0]); per[by * NB + bx].y.push(bv[1]); }
    }
  }
  const all = per.filter((p) => p.x.length);
  if (!all.length) return null;
  const gx = median(all.map((p) => median(p.x))), gy = median(all.map((p) => median(p.y)));
  let vx = per.map((p) => (p.x.length ? median(p.x) : gx)), vy = per.map((p) => (p.y.length ? median(p.y) : gy));
  // vyhladenie 3×3 a prevod na plné rozlíšenie (px / 10 min)
  const sm = (v) => v.map((_, i) => {
    const bx = i % NB, by = Math.floor(i / NB); let s = 0, n = 0;
    for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
      const x = bx + k, y = by + j; if (x < 0 || y < 0 || x >= NB || y >= NB) continue;
      s += v[y * NB + x]; n++;
    }
    return (s / n) * 4;
  });
  vx = sm(vx); vy = sm(vy);
  return { NB, vx, vy, gx: gx * 4, gy: gy * 4, blocks: all.length };
}

function motionAt(M, x, y) {
  const cs = RW / M.NB, fx = clamp(x / cs - 0.5, 0, M.NB - 1), fy = clamp(y / cs - 0.5, 0, M.NB - 1);
  const x0 = Math.min(M.NB - 2, Math.floor(fx)), y0 = Math.min(M.NB - 2, Math.floor(fy)), ax = fx - x0, ay = fy - y0;
  const g = (a) => a[y0 * M.NB + x0] * (1 - ax) * (1 - ay) + a[y0 * M.NB + x0 + 1] * ax * (1 - ay) + a[(y0 + 1) * M.NB + x0] * (1 - ax) * ay + a[(y0 + 1) * M.NB + x0 + 1] * ax * ay;
  return [g(M.vx), g(M.vy)];
}

function extrapolate(last, M) {
  const step = 2; // výpočet na polovičnom rozlíšení
  const W = RW / step, Dx = new Float32Array(W * W), Dy = new Float32Array(W * W);
  const out = [];
  for (let k = 1; k <= R_FC; k++) {
    const z = new Int8Array(RW * RW).fill(NO_ECHO);
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
      const q = j * W + i, x = i * step, y = j * step;
      const [vx, vy] = motionAt(M, x - Dx[q], y - Dy[q]);
      Dx[q] += vx; Dy[q] += vy;
      const sx = Math.round(x - Dx[q]), sy = Math.round(y - Dy[q]);
      if (sx < 0 || sy < 0 || sx >= RW || sy >= RW) continue;
      const v = last.z[sy * RW + sx];
      for (let b = 0; b < step; b++) for (let a = 0; a < step; a++) z[(y + b) * RW + x + a] = v;
    }
    out.push({ time: last.time + k * 600, z, fc: true });
  }
  return out;
}

function zAtHK(fr, r = 2) {
  let m = NO_ECHO;
  const [cx, cy] = HK_PX.map(Math.round);
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) m = Math.max(m, fr.z[y * RW + x]);
  return m;
}

function radarSummary(R) {
  const last = R.frames[R.frames.length - 1];
  const t = fmtTime.format(last.time * 1000);
  const age = Math.round((Date.now() / 1000 - last.time) / 60);
  const zNow = zAtHK(last);
  const M = R.motion;
  const speed = M ? Math.hypot(M.gx, M.gy) * KM_PX * 6 : 0;
  const DIR_TO = tx(['sever', 'severovýchod', 'východ', 'juhovýchod', 'juh', 'juhozápad', 'západ', 'severozápad'],
    ['sever', 'severovýchod', 'východ', 'jihovýchod', 'jih', 'jihozápad', 'západ', 'severozápad']);
  const toward = M ? DIR_TO[dirIdx((Math.atan2(M.gx, -M.gy) * 180 / Math.PI + 360) % 360)] : '';
  const moveTxt = M && speed >= 5 ? `pohyb na ${toward} ${r0(speed)} km/h` : tx('takmer bez pohybu', 'téměř bez pohybu');
  const cls = (z) => { const c = rainClass(rateOf(z)); return c ? c.name : tx('veľmi slabý', 'velmi slabý'); };
  let html, level = 'ok';
  if (zNow >= R_WET) {
    level = 'warn';
    const end = R.fc.findIndex((f) => zAtHK(f) < R_WET);
    html = tx(`V Plotišti práve prší (${cls(zNow)}, ${r1(rateOf(zNow))} mm/h). `, `V Plotišti právě prší (${cls(zNow)}, ${r1(rateOf(zNow))} mm/h). `)
      + (end >= 0 ? tx(`Podľa pohybu zrážok (${moveTxt}) skončí asi o <b>${(end + 1) * 10} min</b>.`, `Podle pohybu srážek (${moveTxt}) skončí asi za <b>${(end + 1) * 10} min</b>.`)
        : tx(`Podľa pohybu zrážok (${moveTxt}) bude pršať aj ďalších 90 min.`, `Podle pohybu srážek (${moveTxt}) bude pršet i dalších 90 min.`));
  } else {
    // najbližšie echo
    let bd = Infinity, bp = null;
    for (let y = 0; y < RW; y += 2) for (let x = 0; x < RW; x += 2) {
      if (last.z[y * RW + x] < R_WET) continue;
      const d = Math.hypot(x - HK_PX[0], y - HK_PX[1]);
      if (d < bd) { bd = d; bp = [x, y]; }
    }
    const arr = R.fc.findIndex((f) => zAtHK(f) >= R_WET);
    if (!bp || bd * KM_PX > 250) html = tx('Do 250 km od Plotišťa radar nevidí žiadne zrážky.', 'Do 250 km od Plotiště radar nevidí žádné srážky.');
    else {
      const ll = rLonLat(...bp);
      const dir = DIR_ADV[dirIdx(bearing(HK.lat, HK.lon, ll[1], ll[0]))];
      const near = tx(`Najbližšie zrážky sú ${r0(bd * KM_PX)} km ${dir}, ${moveTxt}.`, `Nejbližší srážky jsou ${r0(bd * KM_PX)} km ${dir}, ${moveTxt}.`);
      if (arr >= 0) { level = 'warn'; html = near + tx(` Odhad príchodu do Plotišťa: o <b>${(arr + 1) * 10} min</b> (${cls(zAtHK(R.fc[arr]))}).`, ` Odhad příchodu do Plotiště: za <b>${(arr + 1) * 10} min</b> (${cls(zAtHK(R.fc[arr]))}).`); }
      else html = near + tx(' V najbližších 90 min by mali Plotiště minúť.', ' V nejbližších 90 min by měly Plotiště minout.');
    }
  }
  return { html, level, time: t, age, text: `Radar ${t}` };
}

/* ---- zobrazenie na mape */
const R_CITIES = [['Praha', 14.42, 50.09], ['Pardubice', 15.78, 50.04], ['Liberec', 15.06, 50.77], ['Jičín', 15.35, 50.44], ['Trutnov', 15.91, 50.56],
  ['Náchod', 16.16, 50.42], ['Kolín', 15.20, 50.03], ['Chrudim', 15.80, 49.95], ['Ústí n. Orl.', 16.39, 49.97], ['Havlíčkův Brod', 15.58, 49.61],
  ['Jihlava', 15.59, 49.40], ['Brno', 16.61, 49.20], ['Wrocław', 17.03, 51.11], ['Ústí n. L.', 14.03, 50.66], ['Olomouc', 17.25, 49.59],
  ['Dresden', 13.74, 51.05], ['Mladá Boleslav', 14.90, 50.41], ['Svitavy', 16.47, 49.75], ['Kłodzko', 16.66, 50.44]];
const R_STORM = '#ff6bd6';
let rLut = null;
function radarLut() {
  if (rLut) return rLut;
  rLut = new Uint8ClampedArray(256 * 4); // index = dBZ + 128
  for (let z = -128; z < 128; z++) {
    const i = (z + 128) * 4, rate = rateOf(z), c = z >= 50 ? { color: R_STORM } : rainClass(rate);
    if (z <= NO_ECHO || z < 8) continue;
    const col = d3.color(c ? c.color : RAIN_CLASSES[0].color);
    rLut[i] = col.r; rLut[i + 1] = col.g; rLut[i + 2] = col.b; rLut[i + 3] = c ? 225 : 90;
  }
  return rLut;
}
const rCanvasCache = new WeakMap();
function radarCanvas(fr) {
  if (rCanvasCache.has(fr)) return rCanvasCache.get(fr);
  const cv = document.createElement('canvas'); cv.width = cv.height = RW;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(RW, RW), d = img.data, lut = radarLut();
  for (let i = 0; i < fr.z.length; i++) {
    const li = (fr.z[i] + 128) * 4;
    d[i * 4] = lut[li]; d[i * 4 + 1] = lut[li + 1]; d[i * 4 + 2] = lut[li + 2]; d[i * 4 + 3] = lut[li + 3];
  }
  ctx.putImageData(img, 0, 0);
  rCanvasCache.set(fr, cv);
  return cv;
}
const radarSeq = () => (state.radar ? [...state.radar.frames, ...state.radar.fc] : []);

function radarProj() {
  // mierka: polomer ~140 km v kratšom rozmere okna
  const k = Math.PI * 2 / (2 ** RZ * 256); // radiány na radarový pixel
  const s = Math.min(map.w, map.h) / 2 / ((140 / KM_PX) * k);
  return d3.geoMercator().center([HK.lon, HK.lat]).translate([map.w / 2, map.h / 2]).scale(s);
}

function drawRadarMap() {
  const ctx = map.canvas.getContext('2d');
  ctx.setTransform(map.dpr, 0, 0, map.dpr, 0, 0);
  ctx.clearRect(0, 0, map.w, map.h);
  ctx.fillStyle = css('--sea'); ctx.fillRect(0, 0, map.w, map.h);
  const proj = map.rproj = radarProj();
  const path = d3.geoPath(proj, ctx);
  ctx.font = '11px ' + css('--mono');
  const seq = radarSeq();
  const fr = seq[state.rstep];
  // oblasť radaru
  const [x0, y0] = proj(rLonLat(0, 0)), [x1, y1] = proj(rLonLat(RW, RW));
  ctx.fillStyle = '#ffffff06'; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  if (fr) {
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = fr.fc ? 0.8 : 1;
    ctx.drawImage(radarCanvas(fr), x0, y0, x1 - x0, y1 - y0);
    ctx.globalAlpha = 1;
  }
  if (!map.coast) { map.coast = toLines(window.EU_GEO.coast); map.borders = toLines(window.EU_GEO.borders); }
  ctx.beginPath(); path(map.borders); ctx.strokeStyle = '#6f88aa'; ctx.lineWidth = 1.1; ctx.stroke();
  // kruhy 25 / 50 / 100 km
  ctx.setLineDash([3, 4]); ctx.strokeStyle = '#8fd3ff55'; ctx.fillStyle = '#8fd3ffaa';
  for (const km of [25, 50, 100]) {
    ctx.beginPath(); path(d3.geoCircle().center([HK.lon, HK.lat]).radius(km / 111.2).precision(1)()); ctx.stroke();
    const lp = proj([HK.lon, HK.lat + km / 111.2]); ctx.fillText(km + ' km', lp[0] + 4, lp[1] - 3);
  }
  ctx.setLineDash([]);
  // vektor pohybu
  if (state.radar && state.radar.motion) {
    const M = state.radar.motion, [hx, hy] = proj([HK.lon, HK.lat]);
    const sc = (x1 - x0) / RW; // obrazovkové px na radarový px
    const ex = hx + M.gx * 6 * sc, ey = hy + M.gy * 6 * sc; // posun za 60 min
    if (Math.hypot(ex - hx, ey - hy) > 6) {
      ctx.strokeStyle = '#ffb547'; ctx.fillStyle = '#ffb547'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(ex, ey); ctx.stroke();
      const a = Math.atan2(ey - hy, ex - hx);
      ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - 8 * Math.cos(a - 0.4), ey - 8 * Math.sin(a - 0.4)); ctx.lineTo(ex - 8 * Math.cos(a + 0.4), ey - 8 * Math.sin(a + 0.4)); ctx.fill();
      ctx.font = '10px ' + css('--mono'); ctx.textAlign = 'center'; ctx.fillText(tx('pohyb za 60 min', 'pohyb za 60 min'), ex, ey + (ey >= hy ? 16 : -10)); ctx.textAlign = 'start';
    }
  }
  // mestá
  ctx.font = '10.5px ' + css('--body');
  for (const [n, lon, lat] of R_CITIES) {
    const [x, y] = proj([lon, lat]); if (x < 0 || y < 0 || x > map.w || y > map.h) continue;
    ctx.fillStyle = '#dbe5f2'; ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#b8c6da'; ctx.fillText(n, x + 5, y + 3.5);
  }
  const [hx, hy] = proj([HK.lon, HK.lat]);
  ctx.beginPath(); ctx.arc(hx, hy, 3, 0, Math.PI * 2); ctx.fillStyle = css('--accent'); ctx.fill();
  ctx.font = '600 11px ' + css('--mono'); ctx.fillStyle = css('--accent'); ctx.fillText('PLOTIŠTĚ', hx + 8, hy - 8);
  if (!state.radar) {
    ctx.fillStyle = '#dbe5f2'; ctx.font = '13px ' + css('--body'); ctx.textAlign = 'center';
    ctx.fillText(state.radarError ? tx('Radar sa nepodarilo načítať.', 'Radar se nepodařilo načíst.') : tx('Načítavam radar…', 'Načítám radar…'), map.w / 2, map.h / 2 + 40);
    ctx.textAlign = 'start';
  }
  if (fr && fr.fc) {
    ctx.font = '600 11px ' + css('--mono'); ctx.fillStyle = '#ffb547';
    ctx.fillText(tx('ODHAD · extrapolácia pohybu', 'ODHAD · extrapolace pohybu'), 12, 22);
  }
}

function radarReadout(ev) {
  const fr = radarSeq()[state.rstep]; if (!fr || !map.rproj) return;
  const r = map.canvas.getBoundingClientRect();
  const ll = map.rproj.invert([ev.clientX - r.left, ev.clientY - r.top]);
  const [px, py] = rPx(ll[0], ll[1]).map(Math.round);
  const el = $('#map-readout');
  if (px < 0 || py < 0 || px >= RW || py >= RW) { el.innerHTML = tx('Mimo radaru', 'Mimo radar'); return; }
  const z = fr.z[py * RW + px], d = haversine(HK.lat, HK.lon, ll[1], ll[0]);
  el.innerHTML = `${ll[1].toFixed(2)}° S ${ll[0].toFixed(2)}° V · <b>${r0(d)} km</b> ${tx('od Plotišťa', 'od Plotiště')}<br>
    ${z >= 8 ? `${tx('odrazivosť', 'odrazivost')} <b>${z} dBZ</b> · intenzita <b>${r1(rateOf(z))} mm/h</b>` : tx('bez zrážok', 'bez srážek')}`;
}

function renderRadarPanel() {
  const el = $('#sys-list');
  $('.systems h3').textContent = tx('Radar · odhad na najbližších 90 minút', 'Radar · odhad na nejbližších 90 minut');
  const R = state.radar;
  if (!R) { el.innerHTML = `<span class="empty">${state.radarError ? tx('Radar nie je dostupný (RainViewer neodpovedá).', 'Radar není dostupný (RainViewer neodpovídá).') : tx('Načítavam radar…', 'Načítám radar…')}</span>`; return; }
  const S = R.summary;
  el.innerHTML = `<div class="radar-sum" data-level="${S.level}"><div class="t">${S.text}${S.age > 25 ? ` · <em>${tx('staré', 'stáří')} ${S.age} min</em>` : ''}</div><p>${S.html}</p>
    <div class="radar-note">${tx('Odhad posúva zrážky v smere ich pohybu za posledných 30 min; nevie, či zosilnejú alebo zoslabnú.', 'Odhad posouvá srážky ve směru jejich pohybu za posledních 30 min; neví, zda zesílí nebo zeslábnou.')} Zdroj: RainViewer.</div></div>`;
}

let radarTimer = null;
async function refreshRadar() {
  try {
    const prevLen = state.radar ? state.radar.frames.length : 0;
    state.radar = await loadRadar();
    state.radarError = false;
    if (state.layer === 'radar' && (!prevLen || state.rstep >= prevLen - 1)) state.rstep = state.radar.frames.length - 1;
  } catch (e) {
    console.warn('Radar zlyhal:', e);
    state.radarError = true;
  }
  if (state.layer === 'radar') { renderTimeline(); renderSystems(); drawMap(); }
  if (state.precip) renderPrecip();
}

/* ------------------------------------------------------------------ stav, ovládanie */
function setStatus() {
  const st = $('#status');
  const demo = state.demo.local || state.demo.grid;
  st.dataset.state = demo ? 'demo' : 'live';
  st.querySelector('span').textContent = demo ? tx('Ukážkové dáta', 'Ukázková data') : tx('Živé dáta', 'Živá data');
  $('#demo-note').hidden = !demo;
  $('#updated').textContent = tx('aktualizované ', 'aktualizováno ') + fmtTime.format(Date.now());
}

async function load(force = false) {
  const st = $('#status'); st.dataset.state = 'loading'; st.querySelector('span').textContent = tx('Načítavam', 'Načítám');
  const getLocal = async () => {
    const c = !force && cacheGet('mp-local-v1', 30);
    if (c) return c;
    const d = await loadLocalLive(); cacheSet('mp-local-v1', d); return d;
  };
  const getGrid = async () => {
    const c = !force && cacheGet('mp-grid-v1', 60);
    if (c) return { ...c, P: c.P.map((a) => Float32Array.from(Object.values(a))), G: c.G.map((a) => Float32Array.from(Object.values(a))), R: c.R.map((a) => Float32Array.from(Object.values(a))), C: c.C.map((a) => Float32Array.from(Object.values(a))) };
    const d = await loadGridLive();
    cacheSet('mp-grid-v1', { ...d, P: d.P.map((a) => Array.from(a, (v) => Math.round(v * 10) / 10)), G: d.G.map((a) => Array.from(a, Math.round)), R: d.R.map((a) => Array.from(a, (v) => Math.round(v * 10) / 10)), C: d.C.map((a) => Array.from(a, Math.round)) });
    return d;
  };
  const getPrecip = async () => {
    const c = !force && cacheGet('mp-precip-v1', 10);
    if (c) return c;
    const d = await loadPrecipLive(); cacheSet('mp-precip-v1', d); return d;
  };
  const own = (f) => fetchJSON(`data/${f}?v=${Math.floor(Date.now() / 600000)}`, 15000);
  const [lr, gr, sk, ob, pr] = await Promise.allSettled([getLocal(), getGrid(), own('skill.json'), own('obs-recent.json'), getPrecip()]);
  if (pr.status !== 'fulfilled') console.warn('Zrážky detailne – živé dáta zlyhali:', pr.reason);
  state.skill = sk.status === 'fulfilled' ? sk.value : null;
  state.obs = ob.status === 'fulfilled' ? ob.value : null;
  state.demo.local = lr.status !== 'fulfilled';
  state.demo.grid = gr.status !== 'fulfilled';
  if (lr.status !== 'fulfilled') console.warn('Plotiště – živé dáta zlyhali:', lr.reason);
  if (gr.status !== 'fulfilled') console.warn('Európa – živé dáta zlyhali:', gr.reason);
  state.local = lr.status === 'fulfilled' ? lr.value : demoLocal();
  state.precip = pr.status === 'fulfilled' ? pr.value : (state.demo.local ? demoPrecip() : null);
  state.grid = gr.status === 'fulfilled' ? gr.value : demoGrid();
  state.derived = deriveLocal(state.local);
  state.tracks = buildTracks(state.grid);
  state.step = Math.min(state.step, state.grid.times.length - 1);

  renderNow(); renderPrecip(); renderSummary(); renderRisk(); renderSkill();
  if (!charts.length) setupCharts();
  drawCharts();
  renderLegend(); renderTimeline(); renderSystems();
  mapResize();
  setStatus();
}

function setStep(s) {
  if (state.layer === 'radar') state.rstep = s; else state.step = s;
  renderTimeline(); drawMap();
}

let playTimer = null;
function togglePlay(on) {
  const b = $('#play');
  on = on ?? !playTimer;
  clearInterval(playTimer); playTimer = null;
  b.setAttribute('aria-pressed', on); b.textContent = on ? '❚❚ Pauza' : tx('▶ Prehrať', '▶ Přehrát');
  if (on) playTimer = setInterval(() => {
    if (state.layer === 'radar') { const n = radarSeq().length; if (n) setStep((state.rstep + 1) % n); }
    else setStep((state.step + 1) % state.grid.times.length);
  }, state.layer === 'radar' ? 450 : 650);
}

function toggleMax(which) {
  const w = $('#windows');
  if (w.dataset.max === which || !which) delete w.dataset.max; else w.dataset.max = which;
  document.querySelectorAll('.max-btn').forEach((b) => b.setAttribute('aria-pressed', w.dataset.max === b.dataset.max));
  requestAnimationFrame(() => { mapResize(); drawCharts(); drawPrecipChart(); });
}

function applyLang() {
  document.documentElement.lang = LANG;
  if (LANG === 'cs') {
    document.querySelectorAll('[data-cs]').forEach((el) => { el.innerHTML = el.dataset.cs; });
    document.querySelectorAll('[data-cs-aria]').forEach((el) => el.setAttribute('aria-label', el.dataset.csAria));
    document.querySelectorAll('[data-cs-title]').forEach((el) => el.setAttribute('title', el.dataset.csTitle));
  }
  document.querySelectorAll('#lang-seg button').forEach((b) => {
    b.setAttribute('aria-pressed', b.dataset.lang === LANG);
    b.addEventListener('click', () => {
      if (b.dataset.lang === LANG) return;
      try { localStorage.setItem('mp-lang', b.dataset.lang); } catch { /* nevadí */ }
      location.reload();
    });
  });
}

function init() {
  applyLang();
  const tick = () => { $('#clock').textContent = new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date()); };
  tick(); setInterval(tick, 1000);
  renderLegend();

  document.querySelectorAll('#layer-seg button').forEach((b) => b.addEventListener('click', () => {
    const wasRadar = state.layer === 'radar';
    state.layer = b.dataset.layer;
    document.querySelectorAll('#layer-seg button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    if (state.layer === 'radar' && state.radar) state.rstep = state.radar.frames.length - 1;
    if (wasRadar !== (state.layer === 'radar')) togglePlay(false);
    renderLegend(); renderTimeline(); renderSystems(); drawMap();
  }));
  document.querySelectorAll('.max-btn').forEach((b) => b.addEventListener('click', () => toggleMax(b.dataset.max)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#windows').dataset.max) toggleMax(null); });
  $('#time').addEventListener('input', (e) => { togglePlay(false); setStep(+e.target.value); });
  $('#play').addEventListener('click', () => togglePlay());
  $('#refresh').addEventListener('click', () => load(true));
  map.canvas.addEventListener('pointermove', mapReadout);
  map.canvas.addEventListener('pointerdown', mapReadout);
  $('#sys-list').addEventListener('click', (e) => {
    const b = e.target.closest('.sys'); if (!b) return;
    state.hover = b.dataset.label; togglePlay(false); setStep(+b.dataset.step);
  });

  let rt = null;
  new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { mapResize(); drawCharts(); drawPrecipChart(); }, 120); }).observe(document.body);

  load();
  setInterval(() => load(), 30 * 60000); // automatická obnova každých 30 min
  refreshRadar();
  setInterval(refreshRadar, 5 * 60000);  // nová radarová snímka každých 10 min
}

init();
})();
