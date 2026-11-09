// Time-zone helpers, Open-Meteo requests and aggregation.
import { VAR_BY_KEY, baseUnit, displayUnit, convert } from './vars.js?v=61';

const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const ELEVATION = 'https://api.open-meteo.com/v1/elevation';
const GEOCODE ='https://geocoding-api.open-meteo.com/v1/search';
const REVERSE = 'https://nominatim.openstreetmap.org/reverse';

export const HOUR = 3600;
// Typical length of one bar for each time step (ms); months and years vary, this is for spacing.
export const STEP_MS = { hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30.436875 * 86400e3, year: 365.2425 * 86400e3 };
export const STEPS = ['hour', 'day', 'week', 'month', 'year'];
const FORECAST_PAST_DAYS = 92;

// ---------- Time zones ----------
// All times are unix seconds. "Local" means the selected location's IANA time zone.

const dtfCache = new Map();
function dtf(tz) {
  if (!dtfCache.has(tz)) {
    dtfCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return dtfCache.get(tz);
}

export function localParts(sec, tz) {
  const p = {};
  for (const { type, value } of dtf(tz).formatToParts(new Date(sec * 1000))) p[type] = +value;
  return p; // {year, month, day, hour, minute, second}
}

// Offset of tz from UTC at instant sec, in seconds. Memoised per hour: Intl formatting is slow and
// long hourly series ask for the same offsets on every render.
const offsetCache = new Map();
export function tzOffset(sec, tz) {
  const key = `${tz}|${Math.floor(sec / 3600)}`;
  let off = offsetCache.get(key);
  if (off === undefined) {
    const h = Math.floor(sec / 3600) * 3600;
    const p = localParts(h, tz);
    off = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - h;
    if (offsetCache.size > 500000) offsetCache.clear();
    offsetCache.set(key, off);
  }
  return off;
}

// "YYYY-MM-DDTHH:mm" in tz -> unix seconds.
export function zonedToUnix(str, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(str || '');
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000;
  let ts = guess - tzOffset(guess, tz);
  ts = guess - tzOffset(ts, tz); // second pass handles DST edges
  return ts;
}

const pad = (n) => String(n).padStart(2, '0');

export function unixToZonedInput(sec, tz) {
  const p = localParts(sec, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

export function localDate(sec, tz) {
  const p = localParts(sec, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// Start of the current local hour (handles :30 / :45 offsets).
export function floorLocalHour(sec, tz) {
  const off = tzOffset(sec, tz);
  return Math.floor((sec + off) / HOUR) * HOUR - off;
}

// Shift a unix time so that UTC formatting shows local wall-clock time (used by charts with useUTC).
export function wallMs(sec, tz) { return (sec + tzOffset(sec, tz)) * 1000; }

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Format a wall-clock ms value (from wallMs) — no tz math needed.
export function fmtWall(ms, withTime = true, withYear = true) {
  const d = new Date(ms);
  let s = `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}`;
  if (withYear) s += ` ${d.getUTCFullYear()}`;
  if (withTime) s += ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return s;
}

// Durations for "end + duration": h, d, w, mo, y. Days and longer are calendar-based in the
// location's time zone (same wall-clock hour, DST-safe; 31 Mar − 1 month = 28/29 Feb).
export const DURATION_UNITS = { h: 'h', d: 'd', w: 'w', mo: 'mo', y: 'y' };

export function subtractDuration(sec, qty, unit, tz) {
  if (unit === 'h') return sec - qty * HOUR;
  const p = localParts(sec, tz);
  const months = unit === 'y' ? qty * 12 : unit === 'mo' ? qty : 0;
  const days = unit === 'w' ? qty * 7 : unit === 'd' ? qty : 0;
  const m0 = p.month - 1 - months;
  const y = p.year + Math.floor(m0 / 12);
  const m = ((m0 % 12) + 12) % 12;
  const day = Math.min(p.day, new Date(Date.UTC(y, m + 1, 0)).getUTCDate());
  const t = new Date(Date.UTC(y, m, day - days, p.hour, p.minute));
  return zonedToUnix(t.toISOString().slice(0, 16), tz);
}

// Largest unit that expresses S→E exactly (used when switching from a date range).
export function bestDuration(S, E, tz) {
  const approx = { y: 365.2425 * 86400, mo: 30.436875 * 86400, w: 7 * 86400, d: 86400 };
  for (const unit of ['y', 'mo', 'w', 'd']) {
    const q = Math.round((E - S) / approx[unit]);
    if (q >= 1 && subtractDuration(E, q, unit, tz) === S) return { qty: q, unit };
  }
  return { qty: Math.max(1, Math.round((E - S) / HOUR)), unit: 'h' };
}

export function fmtDuration(hours) {
  if (hours % 24 === 0) return `${hours / 24} day${hours === 24 ? '' : 's'}`;
  if (hours > 72) {
    const d = hours / 24; // a daylight-saving change makes calendar days 23 or 25 h long
    return `${Math.abs(d - Math.round(d)) < 0.1 ? Math.round(d) : d.toFixed(1)} days`;
  }
  return `${hours} h`;
}

// ---------- HTTP ----------

async function getJSON(url, signal) {
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(navigator.onLine === false
      ? 'you seem to be offline. Check your connection and try again.'
      : 'the weather service (Open-Meteo) could not be reached. Try again in a few minutes.');
  }
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error */ }
  if (res.ok && body && !body.error) return body;
  // Outages and rate limits are on Open-Meteo's side: say so rather than show their raw reason.
  if (res.status === 429) {
    throw new Error('too many requests to the weather service (Open-Meteo) for now. Try again later.');
  }
  if (res.status >= 500) {
    throw new Error('the weather service (Open-Meteo) is overloaded or down right now. '
      + 'This is on their side, not the app\'s. Try again in a few minutes.');
  }
  throw new Error(body?.reason || `HTTP ${res.status}`);
}

export async function searchPlaces(name, signal) {
  const url = `${GEOCODE}?name=${encodeURIComponent(name)}&count=10&language=en&format=json`;
  const j = await getJSON(url, signal);
  return (j.results || []).map((r) => ({
    name: r.name,
    region: [r.admin1, r.country].filter(Boolean).join(', '),
    lat: r.latitude, lon: r.longitude, elevation: r.elevation, tz: r.timezone,
  }));
}

// ---------- Coordinates typed in the search box ----------

const COORD_WORDS = {
  LAT: '', LATITUDE: '', LON: '', LNG: '', LONG: '', LONGITUDE: '', DEG: '°',
  NORTH: 'N', NORD: 'N', SOUTH: 'S', SUD: 'S', EAST: 'E', EST: 'E', WEST: 'W', OUEST: 'W', O: 'W',
};
const COORD_TOKENS = /[NSEW]|[-+]?\d+(?:\.\d+)?|[°'",;/|]/g;
const isCoordNum = (t) => /\d/.test(t);
const isCoordSep = (t) => /[,;/|]/.test(t);

function validCoords(lat, lon) {
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

// Links from Google Maps, OpenStreetMap, geo: URIs…
function coordsFromLink(text) {
  if (!/^(https?:|geo:|www\.)/i.test(text)) return null;
  const s = decodeURIComponent(text.replace(/%(?![0-9a-f]{2})/gi, '%25'));
  const n = '(-?\\d+(?:\\.\\d+)?)';
  const patterns = [
    `!3d${n}!4d${n}`, `geo:${n},${n}`, `[?&](?:q|ll|query|center|destination)=(?:loc:)?${n},\\s*${n}`,
    `[?&]m?lat=${n}&m?(?:lon|lng)=${n}`, `#map=[\\d.]+/${n}/${n}`, `@${n},${n}`,
  ];
  for (const p of patterns) {
    const m = s.match(new RegExp(p, 'i'));
    if (m) return validCoords(+m[1], +m[2]);
  }
  return null;
}

// Swiss grid, LV95 (2600000 1200000) or LV03 (600000 200000), with swisstopo's approximate formulas.
function coordsFromSwissGrid(text) {
  const s = text.replace(/(\d)['’\s](?=\d{3}(?!\d))/g, '$1');
  const nums = s.match(/\d{6,7}(?:\.\d+)?/g);
  if (nums?.length !== 2 || s.replace(/\d{6,7}(?:\.\d+)?/g, '').replace(/[ENXY:=,;/\s]/gi, '')) return null;
  const [a, b] = nums.map(Number);
  const grid = (e, n) => (e >= 2.48e6 && e <= 2.84e6 && n >= 1.07e6 && n <= 1.3e6 ? [e, n]
    : e >= 4.8e5 && e <= 8.5e5 && n >= 7e4 && n <= 3e5 ? [e + 2e6, n + 1e6] : null);
  const en = grid(a, b) || grid(b, a);
  if (!en) return null;
  const y = (en[0] - 2.6e6) / 1e6, x = (en[1] - 1.2e6) / 1e6;
  return {
    lat: (16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x * x * x) * 100 / 36,
    lon: (2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y) * 100 / 36,
  };
}

// Decimal degrees, degrees-minutes or degrees-minutes-seconds, with signs or N/S/E/W(O) letters
// before or after the numbers, in either order: { lat, lon }, or null if the text is not coordinates.
export function parseCoords(text) {
  const raw = text.trim();
  const link = coordsFromLink(raw);
  if (link) return link;

  let s = raw.toUpperCase()
    .replace(/[º˚]/g, '°').replace(/[′’‘`´]/g, "'").replace(/[″”“]|''/g, '"').replace(/−/g, '-')
    .replace(/[A-Z]+/g, (w) => COORD_WORDS[w] ?? w).replace(/[:=]/g, ' ');
  if (!s.includes('.')) {
    // Decimal commas: "46,2 6,1" and "46,2,6,1" but not "46,6".
    const four = s.match(/^\s*(\d+),(\d+),(\d+),(\d+)\s*$/);
    const dec = four ? `${four[1]}.${four[2]} ${four[3]}.${four[4]}` : s.replace(/(\d),(\d)/g, '$1.$2');
    if (dec.match(COORD_TOKENS)?.filter(isCoordNum).length >= 2) s = dec;
  }
  const tokens = s.match(COORD_TOKENS);
  if (!tokens || s.replace(COORD_TOKENS, '').trim()) return coordsFromSwissGrid(raw);

  // Find where the second coordinate starts.
  const at = (test) => tokens.flatMap((t, i) => (test(t) ? [i] : []));
  const letters = at((t) => /[NSEW]/.test(t));
  const seps = at(isCoordSep);
  const degs = at((t) => t === '°');
  const nums = at(isCoordNum);
  let cut;
  if (letters.length === 2) cut = letters[0] === 0 ? letters[1] : letters[0] + 1;
  else if (letters.length) return null;
  else if (seps.length === 1) cut = seps[0];
  else if (seps.length) return null;
  else if (degs.length === 2) cut = nums.filter((i) => i < degs[1]).pop();
  else if ([2, 4, 6].includes(nums.length)) cut = nums[nums.length / 2];
  else return null;

  const side = (part) => {
    const [d, m = 0, sec = 0, extra] = part.filter(isCoordNum).map(Number);
    if (d == null || extra != null || m >= 60 || sec >= 60) return null;
    const sign = part.some((t) => t === 'S' || t === 'W' || t.startsWith('-')) ? -1 : 1;
    return { value: sign * (Math.abs(d) + m / 60 + sec / 3600), letter: part.find((t) => /[NSEW]/.test(t)) };
  };
  const a = side(tokens.slice(0, cut));
  const b = side(tokens.slice(cut));
  if (!a || !b) return coordsFromSwissGrid(raw);
  if (a.letter) {
    const aIsLat = /[NS]/.test(a.letter);
    if (aIsLat === /[NS]/.test(b.letter)) return null;
    return (aIsLat ? validCoords(a.value, b.value) : validCoords(b.value, a.value)) || coordsFromSwissGrid(raw);
  }
  // No letters: latitude first, unless the first number can only be a longitude.
  return (Math.abs(a.value) > 90 ? validCoords(b.value, a.value) : validCoords(a.value, b.value)) || coordsFromSwissGrid(raw);
}

// Name + time zone + elevation for an arbitrary point (GPS, map tap or typed coordinates).
export async function resolvePoint(lat, lon, signal) {
  const tzReq = getJSON(`${FORECAST}?latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=1&hourly=temperature_2m`, signal);
  const nameReq = fetch(`${REVERSE}?format=jsonv2&lat=${lat}&lon=${lon}&zoom=12&accept-language=en`, { signal })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [meta, rev] = await Promise.all([tzReq, nameReq]);
  const a = rev?.address || {};
  const name = a.city || a.town || a.village || a.hamlet || a.municipality || a.suburb || a.county || rev?.name;
  return {
    name: name || `${lat.toFixed(3)}, ${lon.toFixed(3)}`,
    region: [a.state, a.country].filter(Boolean).join(', '),
    lat: +lat.toFixed(4), lon: +lon.toFixed(4),
    elevation: meta.elevation, tz: meta.timezone,
  };
}

// Terrain elevation (m) of a point, from Open-Meteo's 90 m digital elevation model.
export async function getElevation(lat, lon, signal) {
  const j = await getJSON(`${ELEVATION}?latitude=${lat}&longitude=${lon}`, signal);
  return j.elevation?.[0] ?? null;
}

// ---------- Weather data ----------

function buildUrl(base, loc, keys, startDate, endDate, model) {
  const q = new URLSearchParams({
    latitude: loc.lat, longitude: loc.lon,
    start_date: startDate, end_date: endDate,
    hourly: keys.join(','),
    timezone: loc.tz, timeformat: 'unixtime',
  });
  if (model && model !== 'best_match') q.set('models', model);
  return `${base}?${q}`;
}

/**
 * Hourly values for the window (startSec, endSec] — an hourly value stamped hh:00 covers the
 * preceding hour, so "last 6 h until 14:00" is the six stamps 09:00…14:00.
 * Returns { times: [sec], values: {key: [base-unit numbers|null]}, filledHours, model }.
 */
export async function fetchHourly({ loc, keys, startSec, endSec, model, signal }) {
  const tz = loc.tz;
  const nowSec = Date.now() / 1000;
  const startDate = localDate(startSec + HOUR, tz);
  const endDate = localDate(endSec, tz);

  const arch = await getJSON(buildUrl(ARCHIVE, loc, keys, startDate, endDate, model), signal);
  const times = [];
  const idx = [];
  arch.hourly.time.forEach((t, i) => { if (t > startSec && t <= endSec) { times.push(t); idx.push(i); } });
  const values = {};
  for (const k of keys) values[k] = idx.map((i) => arch.hourly[k]?.[i] ?? null);

  // Auto mode: fill recent gaps (reanalysis lag) from the forecast API, which keeps ~3 months of past data.
  let filledHours = 0;
  if (model === 'best_match') {
    const oldest = nowSec - (FORECAST_PAST_DAYS - 1) * 86400;
    const gaps = times.map((t, i) => (t >= oldest && keys.some((k) => values[k][i] == null) ? i : -1)).filter((i) => i >= 0);
    if (gaps.length) {
      try {
        const fc = await getJSON(buildUrl(FORECAST, loc, keys,
          localDate(times[gaps[0]], tz), localDate(times[gaps[gaps.length - 1]], tz), null), signal);
        const pos = new Map(fc.hourly.time.map((t, i) => [t, i]));
        const filled = new Set();
        for (const i of gaps) {
          const j = pos.get(times[i]);
          if (j == null) continue;
          for (const k of keys) {
            if (values[k][i] == null && fc.hourly[k]?.[j] != null) { values[k][i] = fc.hourly[k][j]; filled.add(i); }
          }
        }
        filledHours = filled.size;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        // Forecast fill is best effort; gaps simply stay empty.
      }
    }
  }
  return { times, values, filledHours, model, tz };
}

// ---------- Aggregation ----------

function reduce(kind, arr) {
  const xs = arr.filter((x) => x != null);
  if (!xs.length) return { val: null, min: null, max: null, n: 0 };
  if (kind === 'sum') return { val: xs.reduce((a, b) => a + b, 0), n: xs.length };
  if (kind === 'code') return { val: Math.max(...xs), n: xs.length };
  if (kind === 'dir') {
    let sx = 0, sy = 0;
    for (const d of xs) { sx += Math.sin(d * Math.PI / 180); sy += Math.cos(d * Math.PI / 180); }
    return { val: (Math.atan2(sx, sy) * 180 / Math.PI + 360) % 360, n: xs.length };
  }
  return { val: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs), n: xs.length };
}

/**
 * mode: 'hour' | 'day' | 'week' | 'month' | 'year' | 'total'.
 * Returns { x, start, end, last: [wall ms], hours: [hours per bucket], series: {key: {unit, val[], min[], max[], cum[]|null, n[]}} }.
 * last is the end of the latest hour with data in the bucket (before `end` when the bucket is still running).
 * Each bucket covers [start, end) in local wall time and is drawn at its middle x.
 * Running totals (cum) start at the first bucket that begins at or after cumFromMs.
 * Values are converted to display units.
 */
// The bar [start, end) (wall ms) of an aggregation level that contains the wall instant w.
// Weeks start on Monday.
export function bucketBounds(w, mode) {
  const DAY = 86400e3;
  if (mode === 'hour') { const s = Math.floor(w / 3600e3) * 3600e3; return [s, s + 3600e3]; }
  if (mode === 'day') { const s = Math.floor(w / DAY) * DAY; return [s, s + DAY]; }
  if (mode === 'week') {
    const day = Math.floor(w / DAY) * DAY;
    const s = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
    return [s, s + 7 * DAY];
  }
  const d = new Date(w), y = d.getUTCFullYear(), m = d.getUTCMonth();
  return mode === 'month' ? [Date.UTC(y, m, 1), Date.UTC(y, m + 1, 1)] : [Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1)];
}

export function aggregate(raw, keys, mode, units, cumFromMs = -Infinity) {
  const { times, values, tz } = raw;
  const buckets = []; // {start, end, last, idx: []}; last = end of the latest hour with data
  if (mode === 'hour') {
    // An hourly value stamped hh:00 covers the hour before it.
    times.forEach((t, i) => { const e = wallMs(t, tz); buckets.push({ start: e - 3600e3, end: e, last: e, idx: [i] }); });
  } else if (mode !== 'total') {
    const byKey = new Map();
    times.forEach((t, i) => {
      // A stamp at 00:00 belongs to the day (week, month, year) that just ended.
      const [start, end] = bucketBounds(wallMs(t - 1, tz), mode);
      if (!byKey.has(start)) { byKey.set(start, { start, end, idx: [] }); buckets.push(byKey.get(start)); }
      const b = byKey.get(start);
      b.idx.push(i);
      b.last = wallMs(t, tz);
    });
  } else {
    const e = times.length ? wallMs(times[times.length - 1], tz) : 0;
    buckets.push({ start: e, end: e, last: e, idx: times.map((_, i) => i) });
  }

  const series = {};
  for (const k of keys) {
    const v = VAR_BY_KEY[k];
    const from = baseUnit(v);
    const unit = displayUnit(v, units);
    const s = { unit, val: [], min: [], max: [], n: [], cum: v.kind === 'sum' ? [] : null };
    let run = 0;
    for (const b of buckets) {
      const r = reduce(v.kind, b.idx.map((i) => values[k][i]));
      s.val.push(convert(r.val, from, unit));
      s.min.push(convert(r.min ?? null, from, unit));
      s.max.push(convert(r.max ?? null, from, unit));
      s.n.push(r.n);
      // Running total: 0 at cumFromMs (the left edge of the view), nothing before it.
      if (s.cum) {
        if (b.start < cumFromMs) { s.cum.push(null); continue; }
        if (r.val != null) run += r.val;
        s.cum.push(convert(run, from, unit));
      }
    }
    series[k] = s;
  }
  return {
    x: buckets.map((b) => (b.start + b.end) / 2), start: buckets.map((b) => b.start), end: buckets.map((b) => b.end),
    last: buckets.map((b) => b.last), hours: buckets.map((b) => b.idx.length), series,
  };
}
