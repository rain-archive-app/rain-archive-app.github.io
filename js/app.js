import {
  VARS, VAR_BY_KEY, QUICK_VARS, FAMILIES, MODELS, IFS_FROM, pre2017Source, defaultUnits, decimals, wmoLabel, compass,
} from './vars.js?v=56';
import {
  HOUR, STEP_MS, STEPS, bucketBounds, searchPlaces, resolvePoint, getElevation, fetchHourly, aggregate,
  zonedToUnix, unixToZonedInput, floorLocalHour, wallMs, tzOffset, fmtWall, fmtDuration,
  DURATION_UNITS, subtractDuration, bestDuration,
} from './data.js?v=56';
import { renderCharts, renderEmpty, disposeCharts, resizeCharts, setZoom, chartRange, boundStep } from './charts.js?v=56';
import { createRangeBar } from './rangebar.js?v=56';

const $ = (id) => document.getElementById(id);

// Date + time pickers of the Period panel: a date field (required, so browsers show no "Clear"
// button) and a list of whole hours (the data are hourly). The wrapper element behaves like one
// input: .value is "YYYY-MM-DDTHH:mm", .disabled, and a single 'change' event.
document.querySelectorAll('.dt').forEach((el) => {
  const [date, time] = el.children;
  for (let h = 0; h < 24; h++) {
    const v = `${String(h).padStart(2, '0')}:00`;
    time.add(new Option(v, v));
  }
  let last = '';
  Object.defineProperty(el, 'value', {
    get: () => (date.value ? `${date.value}T${time.value}` : last),
    set: (v) => {
      last = v || '';
      const [d, t = '00:00'] = last.split('T');
      date.value = d || '';
      const h = Number(t.split(':')[0]) || 0; // snap to the whole hour
      time.value = `${String(h).padStart(2, '0')}:00`;
    },
  });
  Object.defineProperty(el, 'disabled', { set: (b) => { date.disabled = b; time.disabled = b; }, get: () => date.disabled });
  for (const c of [date, time]) {
    c.addEventListener('change', (e) => {
      e.stopPropagation();
      if (!date.value) { el.value = last; return; } // an emptied date falls back to the previous one
      last = el.value;
      el.dispatchEvent(new Event('change'));
    });
  }
});
const STORE_KEY = 'rain-archive-state';
// MapTiler API key (free plan), restricted in MapTiler's dashboard to the app's site and 127.0.0.1.
const MAPTILER_KEY = 'AgLcaCLlnBP2fhhC9B01';
const MIN_DATE = Date.UTC(1940, 0, 1) / 1000;
const MAX_SPAN_DAYS = 366 * 20;

// ---------- State ----------

const LAUSANNE = { name: 'Lausanne', region: 'Vaud, Switzerland', lat: 46.516, lon: 6.6328, elevation: 495, tz: 'Europe/Zurich' };

const state = {
  loc: LAUSANNE,         // first launch

  favorites: [],
  otherMode: 'end',
  endNow: true,          // "Up to now": the end follows the current hour
  end: '', qty: 1, qtyUnit: 'd',
  rangeStart: '', rangeEnd: '',
  vars: ['rain'],
  agg: 'hour',
  chartMode: 'stacked',
  units: defaultUnits(),
  model: 'best_match',
};
let raw = null;          // hourly data behind the chart (see "Data model" below)
let rawWindow = null;    // {S, E} of the saved period
let zoomWin = null;      // visible chart window {startMs, endMs} in wall ms, kept across re-renders

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (s) {
      Object.assign(state, s, { units: { ...defaultUnits(), ...(s.units || {}) } });
      // Older versions had a "Last N hours" preset list: turn it into "Up to now" + duration.
      if ('preset' in s) {
        if (s.preset !== 'other') {
          const h = Number(s.preset);
          Object.assign(state, { otherMode: 'end', endNow: true, qty: h % 24 ? h : h / 24, qtyUnit: h % 24 ? 'h' : 'd' });
        } else if (!('endNow' in s)) state.endNow = false;
        delete state.preset;
      }
    }
  } catch { /* storage unavailable */ }
  delete state.quarter; delete state.detail; // former 15-minute detail settings
  state.vars = state.vars.filter((k) => VAR_BY_KEY[k]);
  if (!state.loc) state.loc = LAUSANNE;
  // Every opening starts on the last 3 days up to now, hour by hour; place, favorites, variables,
  // units and model are kept from last time.
  Object.assign(state, { otherMode: 'end', endNow: true, qty: 3, qtyUnit: 'd', agg: 'hour' });
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

const tz = () => state.loc?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
const nowHour = () => floorLocalHour(Date.now() / 1000, tz());

// ---------- Tabs (settings panels shown as an overlay under the header) ----------

const tabs = [...document.querySelectorAll('.tab')];
function openPanel(id) {
  document.documentElement.style.setProperty('--header-h', `${Math.round($('topbar').getBoundingClientRect().bottom)}px`);
  for (const t of tabs) {
    const on = t.dataset.panel === id;
    t.setAttribute('aria-expanded', on);
    $(t.dataset.panel).hidden = !on;
  }
  $('panel-backdrop').hidden = !id;
}
tabs.forEach((t) => {
  t.onclick = () => openPanel(t.getAttribute('aria-expanded') === 'true' ? null : t.dataset.panel);
});
$('panel-backdrop').onclick = () => openPanel(null);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('panel-backdrop').hidden && !$('map-dialog').open) openPanel(null); });

function updateTabs() {
  $('tab-location').textContent = state.loc ? state.loc.name : 'Choose…';
  const w = computeWindow();
  let p;
  const dur = `${state.qty} ${DURATION_UNITS[state.qtyUnit] || state.qtyUnit}`;
  if (state.otherMode === 'end' && state.endNow) p = `Last ${dur}`;
  else if (w.error) p = 'Incomplete';
  else {
    const z = tz();
    const sameYear = new Date(wallMs(w.S, z)).getUTCFullYear() === new Date(wallMs(w.E, z)).getUTCFullYear();
    p = state.otherMode === 'end'
      ? `${dur} → ${fmtWall(wallMs(w.E, z), false).slice(4)}`
      : `${fmtWall(wallMs(w.S, z), false, !sameYear).slice(4)} → ${fmtWall(wallMs(w.E, z), false).slice(4)}`;
  }
  $('tab-period').textContent = p;
  const first = state.vars[0] ? VAR_BY_KEY[state.vars[0]].label : 'None';
  const aggTxt = { hour: 'per hour', day: 'per day', week: 'per week', month: 'per month', year: 'per year' }[state.agg];
  $('tab-data').textContent = `${first}${state.vars.length > 1 ? ` +${state.vars.length - 1}` : ''} · ${aggTxt}`;
}

// ---------- Location ----------

let keepViewOnce = false; // next fetch keeps the displayed time window (see doFetch)

function setLocation(loc) {
  state.loc = loc;
  keepViewOnce = true;
  save();
  renderLocation();
  renderPeriodSummary();
  openPanel(null);
  scheduleFetch(0);
}

function renderLocation() {
  const box = $('loc-info');
  const loc = state.loc;
  $('btn-fav').disabled = !loc;
  if (!loc) { box.textContent = 'No location selected.'; renderFavorites(); return; }
  const fav = isFavorite(loc);
  $('btn-fav').textContent = fav ? '★ Saved' : '☆ Save';
  box.innerHTML = '';
  const strong = document.createElement('strong');
  strong.textContent = loc.name;
  box.append(strong);
  if (loc.region) box.append(`, ${loc.region}`);
  const sub = document.createElement('div');
  sub.className = 'small';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn mini';
  copy.textContent = 'Copy';
  copy.title = 'Copy coordinates';
  copy.onclick = () => copyCoords(loc.lat, loc.lon);
  sub.append(`${loc.lat.toFixed(3)}°, ${loc.lon.toFixed(3)}°`, copy,
    (loc.elevation != null ? ` · ${Math.round(loc.elevation)} m` : '') + ` · ${loc.tz}`);
  box.append(sub);
  renderFavorites();
}

// Short message at the bottom of the screen (visible above panels and dialogs).
let toastTimer;
function toast(msg) {
  const t = $('toast');
  (document.querySelector('dialog[open]') || document.body).append(t); // above an open dialog too
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

// Copy "lat, lon" (4 decimals) to the clipboard.
async function copyCoords(lat, lon) {
  const txt = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  let ok = false;
  try { await navigator.clipboard.writeText(txt); ok = true; } catch { /* try the older way */ }
  if (!ok) {
    // Fallback for browsers that refuse the Clipboard API: copy from a hidden text field.
    const ta = document.createElement('textarea');
    ta.value = txt;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;left:0;top:0';
    (document.querySelector('dialog[open]') || document.body).append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  toast(ok ? `Coordinates copied: ${txt}` : 'Could not copy the coordinates');
}

const sameLoc = (a, b) => a && b && Math.abs(a.lat - b.lat) < 1e-3 && Math.abs(a.lon - b.lon) < 1e-3;
const isFavorite = (loc) => state.favorites.some((f) => sameLoc(f, loc));
const favAt = (loc) => state.favorites.find((f) => sameLoc(f, loc));
function setFavorites(list) {
  state.favorites = list;
  save();
  renderLocation();
  refreshMapFavorites();
}

// ---------- Favorites ----------
// Tap: show that place. ✕: remove it. Long press: menu (rename, move on map, edit or copy
// coordinates, delete). Press and drag onto another favorite: reorder.

const LONG_PRESS_MS = 500;

function renderFavorites() {
  const box = $('favorites');
  box.innerHTML = '';
  state.favorites.forEach((f, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip fav' + (sameLoc(f, state.loc) ? ' active' : '');
    chip.dataset.i = i;
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'fav-main';
    main.textContent = `★ ${f.name}`;
    main.title = 'Tap: show · Long press: options · Drag: reorder';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'fav-del';
    del.textContent = '✕';
    del.title = `Remove ${f.name} from favorites`;
    del.setAttribute('aria-label', del.title);
    del.onclick = () => setFavorites(state.favorites.filter((x) => x !== f));
    chip.append(main, del);
    attachChipGestures(chip, main, f);
    box.append(chip);
  });
}

function attachChipGestures(chip, main, fav) {
  let g = null;
  main.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    try { main.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, long: false, over: null };
    g.timer = setTimeout(() => {
      if (!g || g.moved) return;
      g.long = true;
      navigator.vibrate?.(25);
      openFavMenu(chip, fav);
    }, LONG_PRESS_MS);
  });
  main.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id || g.long) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.moved && Math.hypot(dx, dy) < 8) return;
    if (!g.moved) { g.moved = true; clearTimeout(g.timer); chip.classList.add('dragging'); }
    chip.style.transform = `translate(${dx}px, ${dy}px)`;
    chip.style.pointerEvents = 'none';
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('#favorites .chip');
    chip.style.pointerEvents = '';
    g.over = over && over !== chip ? Number(over.dataset.i) : null;
    document.querySelectorAll('#favorites .chip').forEach((c) => c.classList.toggle('drop', Number(c.dataset.i) === g.over));
  });
  const end = (e) => {
    if (!g || e.pointerId !== g.id) return;
    clearTimeout(g.timer);
    const { moved, long, over } = g;
    g = null;
    chip.classList.remove('dragging');
    chip.style.transform = '';
    if (long) return;
    if (moved) {
      if (over != null) {
        const list = [...state.favorites];
        list.splice(list.indexOf(fav), 1);
        list.splice(over, 0, fav);
        setFavorites(list);
      } else renderFavorites();
      return;
    }
    if (e.type === 'pointerup') setLocation(fav);
  };
  main.addEventListener('pointerup', end);
  main.addEventListener('pointercancel', end);
  main.addEventListener('contextmenu', (e) => e.preventDefault());
  main.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLocation(fav); } });
}

function closeFavMenu() { $('fav-menu')?.remove(); }
function openFavMenu(chip, fav) {
  closeFavMenu();
  const m = document.createElement('div');
  m.id = 'fav-menu';
  m.className = 'menu';
  m.setAttribute('role', 'menu');
  const items = [
    ['Rename', () => editFav(fav, 'rename')],
    ['Move on map', () => openMap({ moveFav: fav })],
    ['Edit coordinates', () => editFav(fav, 'coords')],
    ['Copy coordinates', () => copyCoords(fav.lat, fav.lon)],
    ['Delete', () => setFavorites(state.favorites.filter((x) => x !== fav))],
  ];
  for (const [label, run] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    if (label === 'Delete') b.className = 'danger';
    b.onclick = () => { closeFavMenu(); run(); };
    m.append(b);
  }
  document.body.append(m);
  const r = chip.getBoundingClientRect();
  m.style.left = `${Math.min(Math.max(8, r.left), innerWidth - m.offsetWidth - 8)}px`;
  m.style.top = `${Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8)}px`;
  setTimeout(() => document.addEventListener('pointerdown', function away(e) {
    if (!e.target.closest('#fav-menu')) { closeFavMenu(); document.removeEventListener('pointerdown', away); }
  }), 0);
}

// Rename or edit coordinates in a small dialog.
function editFav(fav, what) {
  const dlgF = $('fav-dialog');
  $('fav-title').textContent = what === 'rename' ? 'Rename favorite' : `Coordinates of ${fav.name}`;
  $('fav-name-row').hidden = what !== 'rename';
  $('fav-coords-row').hidden = what !== 'coords';
  $('fav-name').value = fav.name;
  $('fav-lat').value = fav.lat;
  $('fav-lon').value = fav.lon;
  $('fav-error').textContent = '';
  dlgF.showModal();
  $('fav-save').onclick = async () => {
    if (what === 'rename') {
      const name = $('fav-name').value.trim();
      if (!name) { $('fav-error').textContent = 'Enter a name.'; return; }
      updateFav(fav, { name });
      dlgF.close();
      return;
    }
    const lat = Number($('fav-lat').value), lon = Number($('fav-lon').value);
    if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180) || $('fav-lat').value === '' || $('fav-lon').value === '') {
      $('fav-error').textContent = 'Latitude −90…90, longitude −180…180.';
      return;
    }
    $('fav-error').textContent = 'Updating…';
    try { await moveFav(fav, lat, lon); dlgF.close(); }
    catch (e) { $('fav-error').textContent = `Failed: ${e.message}`; }
  };
}
$('fav-cancel').onclick = () => $('fav-dialog').close();

function updateFav(fav, changes) {
  const wasCurrent = sameLoc(fav, state.loc);
  const next = { ...fav, ...changes };
  state.favorites = state.favorites.map((f) => (f === fav ? next : f));
  if (wasCurrent) { state.loc = { ...next }; save(); renderLocation(); updateTabs(); scheduleFetch(0); }
  setFavorites(state.favorites);
  return next;
}

// New position for a favorite: keep its name, refresh elevation and time zone.
async function moveFav(fav, lat, lon) {
  const p = await resolvePoint(lat, lon);
  return updateFav(fav, { lat: p.lat, lon: p.lon, elevation: p.elevation, tz: p.tz });
}

$('btn-fav').onclick = () => {
  if (!state.loc) return;
  if (isFavorite(state.loc)) setFavorites(state.favorites.filter((f) => !sameLoc(f, state.loc)));
  else setFavorites([...state.favorites, { ...state.loc }]);
};

// Search
let searchTimer, searchAbort;
const results = $('search-results');
$('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { results.hidden = true; return; }
  searchTimer = setTimeout(() => runSearch(q), 300);
});
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); results.querySelector('button')?.click(); }
  if (e.key === 'Escape') results.hidden = true;
  if (e.key === 'ArrowDown') { e.preventDefault(); results.querySelector('button')?.focus(); }
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) results.hidden = true; });

async function runSearch(q) {
  searchAbort?.abort();
  searchAbort = new AbortController();
  try {
    const list = await searchPlaces(q, searchAbort.signal);
    results.innerHTML = '';
    if (!list.length) results.innerHTML = '<li class="muted small" style="padding:8px">No place found.</li>';
    for (const p of list) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = '<span></span><span class="sub"></span>';
      b.firstChild.textContent = p.name;
      b.lastChild.textContent = [p.region, p.elevation != null ? `${Math.round(p.elevation)} m` : ''].filter(Boolean).join(' · ');
      b.onclick = () => { results.hidden = true; $('search').value = ''; setLocation(p); };
      b.className = 'res-main';
      b.onkeydown = (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); li.nextElementSibling?.querySelector('button')?.focus(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); (li.previousElementSibling?.querySelector('button') || $('search')).focus(); }
      };
      // Add to favorites / copy coordinates, without choosing the place yet.
      const star = document.createElement('button');
      star.type = 'button';
      star.className = 'res-act star-btn';
      const syncStar = () => {
        const on = isFavorite(p);
        star.textContent = on ? '★' : '☆';
        star.classList.toggle('on', on);
        star.title = on ? 'Remove from favorites' : 'Add to favorites';
        star.setAttribute('aria-label', star.title);
      };
      syncStar();
      star.onclick = () => {
        setFavorites(isFavorite(p) ? state.favorites.filter((f) => !sameLoc(f, p)) : [...state.favorites, { ...p }]);
        syncStar();
      };
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'res-act';
      copy.title = 'Copy coordinates';
      copy.setAttribute('aria-label', copy.title);
      copy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>';
      copy.onclick = () => copyCoords(p.lat, p.lon);
      li.append(b, star, copy);
      results.append(li);
    }
    results.hidden = false;
  } catch (e) {
    if (e.name !== 'AbortError') { results.innerHTML = `<li class="small" style="padding:8px">Search failed: ${e.message}</li>`; results.hidden = false; }
  }
}

// GPS
$('btn-gps').onclick = () => {
  if (!navigator.geolocation) return setStatus('Geolocation is not available on this device.', 'error');
  setStatus('Getting your position…', 'loading');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try { setLocation(await resolvePoint(pos.coords.latitude, pos.coords.longitude)); }
      catch (e) { setStatus(`Could not resolve your position: ${e.message}`, 'error'); }
    },
    (err) => setStatus(`Position unavailable: ${err.message}`, 'error'),
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 },
  );
};

// ---------- Map ----------
// Favorites are yellow pins; tapping one selects it. The star next to "Use this point" shows
// whether the selected point is a favorite and toggles it. In "move favorite" mode the button
// saves the new position instead.

let map, marker, favLayer, picked = null, mapMode = null;
const dlg = $('map-dialog');

function refreshMapFavorites() {
  if (!favLayer) return;
  favLayer.clearLayers();
  for (const f of state.favorites) {
    L.circleMarker([f.lat, f.lon], { radius: 8, color: '#8a6d00', weight: 2, fillColor: '#ffd21f', fillOpacity: 0.95 })
      .bindTooltip(f.name, { direction: 'top', offset: [0, -8] })
      .on('click', (e) => { L.DomEvent.stopPropagation(e); pickPoint(f.lat, f.lon); })
      .addTo(favLayer);
  }
  updateStar();
}

function updateStar() {
  const star = $('map-star');
  const fav = picked && favAt(picked);
  star.disabled = !picked || !!mapMode;
  star.textContent = fav ? '★' : '☆';
  star.classList.toggle('on', !!fav);
  star.title = fav ? `Remove ${fav.name} from favorites` : 'Add this point to favorites';
  $('map-copy').disabled = !picked;
}
$('map-copy').onclick = () => { if (picked) copyCoords(picked.lat, picked.lon); };

let elevAbort;
async function pickPoint(lat, lon) {
  picked = { lat, lon };
  if (marker) marker.setLatLng([lat, lon]); else marker = L.marker([lat, lon]).addTo(map);
  const fav = favAt(picked);
  const txt = `${fav ? `${fav.name} · ` : ''}${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
  $('map-picked').textContent = `${txt} · … m`;
  $('map-use').disabled = false;
  updateStar();
  elevAbort?.abort();
  elevAbort = new AbortController();
  const at = picked;
  try {
    const elev = await getElevation(lat, lon, elevAbort.signal);
    if (picked === at) $('map-picked').textContent = `${txt}${elev != null ? ` · ${Math.round(elev)} m` : ''}`;
  } catch (err) {
    if (err.name !== 'AbortError' && picked === at) $('map-picked').textContent = txt;
  }
}

function openMap(opts = {}) {
  if (typeof L === 'undefined') return setStatus('Map library could not be loaded (offline?).', 'error');
  mapMode = opts.moveFav ? { moveFav: opts.moveFav } : null;
  $('map-title').textContent = mapMode ? `Tap the new position of ${mapMode.moveFav.name}` : 'Tap the map to pick a point';
  $('map-use').textContent = mapMode ? 'Save position' : 'Use this point';
  dlg.showModal();
  if (!map) {
    map = L.map('map', { worldCopyJump: true });
    // MapTiler Topo (free plan; the key only works from the app's own site). 512 px tiles: a quarter
    // of the requests counted against the monthly quota. If MapTiler stops answering (quota used up,
    // key refused), the map falls back to OpenTopoMap.
    const topo = L.tileLayer(`https://api.maptiler.com/maps/topo-v4/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`, {
      tileSize: 512, zoomOffset: -1, minZoom: 1, maxZoom: 19, crossOrigin: true,
      attribution: '<a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener">© MapTiler</a> '
        + '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>',
    }).addTo(map);
    let tileErrors = 0;
    topo.on('tileerror', () => {
      if (++tileErrors < 4 || !map.hasLayer(topo)) return;
      map.removeLayer(topo);
      L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        maxZoom: 17, subdomains: 'abc',
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM · style © <a href="https://opentopomap.org/">OpenTopoMap</a> (CC BY-SA)',
      }).addTo(map);
    });
    favLayer = L.layerGroup().addTo(map);
    map.on('click', (e) => { const p = e.latlng.wrap(); pickPoint(p.lat, p.lng); });
  }
  refreshMapFavorites();
  const center = mapMode ? mapMode.moveFav : state.loc;
  const c = center ? [center.lat, center.lon] : [46.52, 6.63];
  map.setView(c, center ? 10 : 6);
  picked = null;
  if (marker) { marker.remove(); marker = null; }
  $('map-picked').textContent = 'No point selected.';
  $('map-use').disabled = true;
  updateStar();
  setTimeout(() => map.invalidateSize(), 50);
}
$('btn-map').onclick = () => openMap();
$('map-close').onclick = () => dlg.close();
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

$('map-star').onclick = async () => {
  if (!picked) return;
  const fav = favAt(picked);
  if (fav) { setFavorites(state.favorites.filter((f) => f !== fav)); pickPoint(picked.lat, picked.lon); return; }
  $('map-star').disabled = true;
  try {
    const p = await resolvePoint(picked.lat, picked.lon);
    setFavorites([...state.favorites, p]);
    pickPoint(p.lat, p.lon);
  } catch (e) {
    $('map-picked').textContent = `Lookup failed: ${e.message}`;
    updateStar();
  }
};

$('map-use').onclick = async () => {
  if (!picked) return;
  $('map-use').disabled = true;
  try {
    if (mapMode) {
      $('map-picked').textContent = 'Saving…';
      await moveFav(mapMode.moveFav, picked.lat, picked.lon);
      dlg.close();
      return;
    }
    const fav = favAt(picked);
    if (fav) { dlg.close(); setLocation(fav); return; }
    $('map-picked').textContent = 'Looking up the place…';
    const loc = await resolvePoint(picked.lat, picked.lon);
    dlg.close();
    setLocation(loc);
  } catch (e) {
    $('map-picked').textContent = `Failed: ${e.message}`;
  } finally { $('map-use').disabled = false; }
};

// ---------- Period ----------

function computeWindow() {
  const z = tz();
  const now = nowHour();
  let S, E, note = '';
  if (state.otherMode === 'end') {
    E = state.endNow ? now : zonedToUnix(state.end, z);
    const q = Math.floor(Number(state.qty));
    if (E == null) return { error: 'Choose an end date and time.' };
    if (!(q >= 1)) return { error: 'Duration must be at least 1.' };
    S = subtractDuration(E, q, state.qtyUnit, z);
  } else {
    S = zonedToUnix(state.rangeStart, z);
    E = zonedToUnix(state.rangeEnd, z);
    if (S == null || E == null) return { error: 'Choose both start and end.' };
  }
  if (E > now) { E = now; note = 'End moved to the current hour.'; }
  if (S >= E) return { error: 'Start must be before end.' };
  if (S < MIN_DATE) return { error: 'Data is only available from 1 January 1940.' };
  if (E - S > MAX_SPAN_DAYS * 86400) return { error: 'Please choose a period of 20 years or less.' };
  return { S, E, note };
}

function renderPeriodSummary() {
  updateTabs();
  const w = computeWindow();
  const el = $('period-summary');
  if (w.error) { el.textContent = w.error; return; }
  const z = tz();
  el.textContent = `${fmtWall(wallMs(w.S, z))} → ${fmtWall(wallMs(w.E, z))} · ${fmtDuration(Math.round((w.E - w.S) / HOUR))} · ${z}` +
    (w.note ? ` · ${w.note}` : '');
}

function syncPeriodUI() {
  document.querySelector(`input[name="other-mode"][value="${state.otherMode}"]`).checked = true;
  $('mode-end').hidden = state.otherMode !== 'end';
  $('mode-range').hidden = state.otherMode !== 'range';
  $('end-now').checked = state.endNow;
  $('end').disabled = state.endNow;
  if (state.endNow) state.end = unixToZonedInput(nowHour(), tz());
  $('end').value = state.end;
  $('qty').value = state.qty;
  $('qty-unit').value = state.qtyUnit;
  $('range-start').value = state.rangeStart;
  $('range-end').value = state.rangeEnd;
  renderPeriodSummary();
}

function prefillOther() {
  const now = nowHour();
  if (!state.end) state.end = unixToZonedInput(now, tz());
  if (!state.rangeEnd) state.rangeEnd = unixToZonedInput(now, tz());
  if (!state.rangeStart) state.rangeStart = unixToZonedInput(now - 7 * 86400, tz());
}

function onPeriodChange() { save(); syncPeriodUI(); scheduleFetch(); }

$('end-now').onchange = (e) => { state.endNow = e.target.checked; onPeriodChange(); };
// Switching between "end + duration" and "date range" keeps the same period.
function convertOtherMode(to) {
  const z = tz();
  if (to === 'range') {
    const w = computeWindow();
    if (!w.error) {
      state.rangeEnd = unixToZonedInput(w.E, z);
      state.rangeStart = unixToZonedInput(w.S, z);
    } else if (state.end) state.rangeEnd = state.end;
  } else {
    const S = zonedToUnix(state.rangeStart, z), E = zonedToUnix(state.rangeEnd, z);
    if (E != null) { state.end = state.rangeEnd; state.endNow = E >= nowHour(); }
    if (S != null && E != null && E > S) {
      const d = bestDuration(S, E, z);
      state.qty = d.qty;
      state.qtyUnit = d.unit;
    }
  }
}
document.querySelectorAll('input[name="other-mode"]').forEach((r) => {
  r.onchange = () => { convertOtherMode(r.value); state.otherMode = r.value; onPeriodChange(); };
});
$('end').onchange = (e) => { state.end = e.target.value; onPeriodChange(); };
$('qty').oninput = (e) => { state.qty = e.target.value; save(); renderPeriodSummary(); scheduleFetch(900); };
$('qty-unit').onchange = (e) => { state.qtyUnit = e.target.value; onPeriodChange(); };
$('range-start').onchange = (e) => { state.rangeStart = e.target.value; onPeriodChange(); };
$('range-end').onchange = (e) => { state.rangeEnd = e.target.value; onPeriodChange(); };

// ---------- Variables ----------

function checkbox(v) {
  const label = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.value = v.key;
  cb.checked = state.vars.includes(v.key);
  cb.onchange = () => {
    if (cb.checked) { if (!state.vars.includes(v.key)) state.vars.push(v.key); }
    else state.vars = state.vars.filter((k) => k !== v.key);
    save();
    renderVars(); // selected variables move to the top list, unselected ones go back to "Other"
    renderUnits();
    // Already-fetched variables only need a re-render; new ones need a fetch.
    if (raw && state.vars.every((k) => k in raw.values)) renderResults();
    else { keepViewOnce = true; scheduleFetch(); }
  };
  label.append(cb, document.createTextNode(v.label));
  label.dataset.search = `${v.label} ${v.key} ${v.cat}`.toLowerCase();
  return label;
}

// Top list: the quick variables plus every selected one; "Other variables": the rest.
function renderVars() {
  const top = [...QUICK_VARS, ...state.vars.filter((k) => !QUICK_VARS.includes(k))];
  const quick = $('quick-vars');
  quick.innerHTML = '';
  top.forEach((k) => quick.append(checkbox(VAR_BY_KEY[k])));
  const list = $('var-list');
  list.innerHTML = '';
  let cat = null;
  for (const v of VARS) {
    if (top.includes(v.key)) continue;
    if (v.cat !== cat) {
      cat = v.cat;
      const h = document.createElement('h3');
      h.textContent = cat;
      list.append(h);
    }
    list.append(checkbox(v));
  }
  renderVarCount();
  applyVarFilter();
}

function renderVarCount() { updateTabs(); }

$('var-filter').addEventListener('input', applyVarFilter);
function applyVarFilter() {
  const q = $('var-filter').value.trim().toLowerCase();
  const list = $('var-list');
  list.querySelectorAll('label').forEach((l) => { l.hidden = q && !l.dataset.search.includes(q); });
  list.querySelectorAll('h3').forEach((h) => {
    let el = h.nextElementSibling, any = false;
    while (el && el.tagName === 'LABEL') { if (!el.hidden) any = true; el = el.nextElementSibling; }
    h.hidden = !any;
  });
}

// ---------- Aggregation (one bar per hour → day → week → month → year) ----------
// Changing it only regroups the data; the displayed time window does not move.

const STEP_LABEL = { hour: '/h', day: '/d', week: '/wk', month: '/mo', year: '/y' };
const STEP_NAME = { hour: 'per hour', day: 'per day', week: 'per week', month: 'per month', year: 'per year' };

function syncStepUI() {
  document.querySelector(`input[name="agg"][value="${state.agg}"]`).checked = true;
  const i = STEPS.indexOf(state.agg);
  $('step-label').textContent = STEP_LABEL[state.agg];
  $('step-label').title = `Data aggregated ${STEP_NAME[state.agg]}`;
  $('btn-finer').disabled = i === 0;
  $('btn-coarser').disabled = i === STEPS.length - 1;
  $('btn-finer').title = i > 0 ? `Aggregate ${STEP_NAME[STEPS[i - 1]]}` : 'Already the finest aggregation';
  $('btn-coarser').title = i < STEPS.length - 1 ? `Aggregate ${STEP_NAME[STEPS[i + 1]]}` : 'Already the coarsest aggregation';
}
function setAgg(value) {
  state.agg = value;
  save();
  syncStepUI();
  updateTabs();
  if (!raw) return;
  renderResults();
  fillAxis(); // complete the bars at both ends (a month or a year needs all of its hours)
}
document.querySelectorAll('input[name="agg"]').forEach((r) => { r.onchange = () => setAgg(r.value); });
$('btn-finer').onclick = () => { const i = STEPS.indexOf(state.agg); if (i > 0) setAgg(STEPS[i - 1]); };
$('btn-coarser').onclick = () => { const i = STEPS.indexOf(state.agg); if (i < STEPS.length - 1) setAgg(STEPS[i + 1]); };

// ---------- Units & model ----------

function renderUnits() {
  const box = $('units');
  box.innerHTML = '';
  const fams = [...new Set(state.vars.map((k) => VAR_BY_KEY[k].family).filter(Boolean))];
  if (!fams.length) { box.innerHTML = '<p class="muted small">No adjustable units for the selected data.</p>'; return; }
  for (const f of fams) {
    const fam = FAMILIES[f];
    const label = document.createElement('label');
    label.className = 'field';
    label.innerHTML = '<span></span><select></select>';
    label.firstChild.textContent = fam.label;
    const sel = label.lastChild;
    fam.units.forEach((u) => sel.add(new Option(u, u, false, u === state.units[f])));
    sel.onchange = () => { state.units[f] = sel.value; save(); renderResults(); };
    box.append(label);
  }
}

function renderModels() {
  const sel = $('model');
  MODELS.forEach((m) => sel.add(new Option(m.label, m.id, false, m.id === state.model)));
  const note = () => { $('model-note').textContent = MODELS.find((m) => m.id === state.model)?.note || ''; };
  note();
  sel.onchange = () => { state.model = sel.value; save(); note(); keepViewOnce = true; scheduleFetch(0); };
}

// ---------- Data model ----------
// period: hourly data of the saved period (its time range is the saved Period).
// raw:    hourly data behind the chart, contiguous over [raw.loadedS, raw.loadedE] (unix s).
//         It starts as the period and grows (or is replaced) as the view moves.
// axis:   the chart's time axis [axis.S, axis.E]: the visible window plus one window-width on each
//         side (never before 1940 or after the current hour). The time bar shows this range, so the
//         visible part always fills about a third of it. Data for the margins is fetched in the
//         background; when the view comes near an edge, the axis re-centres on it and the charts
//         are updated in place, without being rebuilt.

let period = null;
let axis = null;

function setStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = `status ${kind}`;
}

let fetchTimer, fetchAbort;
function scheduleFetch(delay = 400) {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(doFetch, delay);
}

const unwall = (ms) => { const s = ms / 1000; return s - tzOffset(s, raw.tz); }; // wall ms → unix s
function axisAround(S, E) {
  const span = E - S;
  return { S: Math.max(MIN_DATE, floorLocalHour(S - span, tz())), E: Math.min(nowHour(), E + span) };
}
// Data needed to draw [S, E] with whole bars: widened to the bars that contain both ends.
function wholeBars({ S, E }) {
  const z = raw?.tz || tz();
  const a = bucketBounds(wallMs(S, z), state.agg)[0], b = bucketBounds(wallMs(E - 1, z), state.agg)[1];
  return { S: a / 1000 - tzOffset(a / 1000, z), E: b / 1000 - tzOffset(b / 1000, z) };
}

async function doFetch() {
  if (!state.loc) { setStatus('Search a place, use your position or pick one on the map to start.'); return; }
  const w = computeWindow();
  if (w.error) { setStatus(w.error, 'error'); clearResults(); return; }
  if (!state.vars.length) {
    // Nothing to download: keep an empty chart over the period, with a message.
    fetchAbort?.abort();
    const empty = { times: [], values: {}, tz: tz(), model: state.model, filledHours: 0 };
    period = empty;
    raw = { ...empty, loadedS: w.S, loadedE: w.E };
    rawWindow = w;
    axis = axisAround(w.S, w.E);
    zoomWin = { startMs: wallMs(w.S, raw.tz), endMs: wallMs(w.E, raw.tz) };
    setActiveView('period');
    setStatus('');
    renderResults();
    return;
  }
  fetchAbort?.abort();
  fetchAbort = new AbortController();
  const ctrl = fetchAbort;
  // A new place, variable or model keeps the displayed window (same wall-clock times);
  // only a new period re-centres the view on it.
  const keep = keepViewOnce && zoomWin ? { win: { ...zoomWin }, view: activeView } : null;
  keepViewOnce = false;
  setStatus('Loading data…', 'loading');
  const done = watchSlow('Loading the data', () => ctrl.abort());
  try {
    const p = await fetchHourly({ loc: state.loc, keys: [...state.vars], startSec: w.S, endSec: w.E, model: state.model, signal: ctrl.signal });
    done();
    period = p;
    raw = { ...p, loadedS: w.S, loadedE: w.E };
    rawWindow = w;
    setStatus('');
    if (keep) {
      axis = axisAround(unwall(keep.win.startMs), unwall(keep.win.endMs));
      zoomWin = keep.win;
      await queue(() => ensureData(wholeBars(axis))); // the window may lie outside the period
      if (raw.tz !== p.tz || period !== p) return; // replaced meanwhile
      renderResults();
      setActiveView(keep.view);
      refreshScales();
      return;
    }
    axis = axisAround(w.S, w.E);
    zoomWin = null;
    renderResults();
    zoomWin = viewWindow('period');
    renderResults();
    setActiveView('period');
    fillAxis(); // the margins, in the background
    refreshScales();
  } catch (e) {
    done();
    if (e.name === 'AbortError') return;
    setStatus(`Could not load data: ${e.message}`, 'error');
    clearResults();
  }
}

// Downloads run one after the other so that the pieces of `raw` stay contiguous.
let chain = Promise.resolve();
const queue = (fn) => (chain = chain.then(fn, fn));

// Make `raw` cover [S, E]: extend it on either side, or replace it when the range is far away.
// Returns true when `raw` changed.
async function ensureData({ S, E }) {
  if (!raw) return false;
  const target = raw;
  S = Math.max(MIN_DATE, floorLocalHour(S, target.tz));
  E = Math.min(nowHour(), E);
  if (!Object.keys(target.values).length) return false; // no variable: nothing to load
  if (S >= target.loadedS && E <= target.loadedE) return false;
  const ctrl = new AbortController();
  fetchAbort?.signal.addEventListener('abort', () => ctrl.abort());
  const get = (a, b) => fetchHourly({ loc: state.loc, keys: Object.keys(target.values), startSec: a, endSec: b, model: target.model, signal: ctrl.signal });
  try {
    if (E < target.loadedS || S > target.loadedE) {
      const next = await get(S, E);
      if (raw !== target) return false;
      raw = { ...next, loadedS: S, loadedE: E };
      return true;
    }
    let { times, values } = target;
    let { loadedS, loadedE } = target;
    let filled = target.filledHours;
    if (S < loadedS) {
      const prev = await get(S, loadedS);
      times = prev.times.concat(times);
      values = Object.fromEntries(Object.keys(values).map((k) => [k, prev.values[k].concat(values[k])]));
      filled += prev.filledHours;
      loadedS = S;
    }
    if (E > loadedE) {
      const next = await get(loadedE, E);
      times = times.concat(next.times);
      values = Object.fromEntries(Object.keys(values).map((k) => [k, values[k].concat(next.values[k])]));
      filled += next.filledHours;
      loadedE = E;
    }
    if (raw !== target) return false;
    raw = { ...target, times, values, loadedS, loadedE, filledHours: filled };
    return true;
  } catch (e) {
    if (e.name !== 'AbortError') setStatus(`Could not load more data: ${e.message}`, 'error');
    return false;
  }
}

// ---------- Stable y scales ----------
// To compare views by eye, each variable's y axis is fixed by a reference: the 99th percentile of
// its values (bars at the current aggregation level) over the saved period plus one year before and
// one year after (never beyond now). For averaged variables the 1st percentile sets the bottom.
// For sums (rain, snow…) only non-zero bars count, otherwise the many dry hours would pull the
// percentile to 0. The axis only stretches beyond that when a higher (or lower) value is actually
// on screen, once the view has stopped moving.

const REF_HI = 0.99;
const YEAR = 365.2425 * 86400;
let ref = { key: '', data: null, stats: null, statsKey: '' };

async function refreshScales() {
  if (!state.loc || !rawWindow || !state.vars.length) return;
  const S = Math.max(MIN_DATE, rawWindow.S - YEAR), E = Math.min(nowHour(), rawWindow.E + YEAR);
  const keys = [...state.vars].sort();
  const key = [state.loc.lat, state.loc.lon, state.model, keys.join(','), Math.round(S / 86400), Math.round(E / 86400)].join('|');
  if (ref.key === key) return;
  ref = { key, data: null, stats: null, statsKey: '' };
  try {
    const data = await fetchHourly({ loc: state.loc, keys, startSec: floorLocalHour(S, tz()), endSec: E, model: state.model, signal: fetchAbort?.signal });
    if (ref.key !== key) return; // superseded
    ref.data = data;
    renderResults();
  } catch { /* no reference: axes stay automatic */ }
}

function percentile(sorted, q) { return sorted.length ? sorted[Math.floor(q * (sorted.length - 1))] : null; }

// {key: {lo, hi}} from the reference data, for the current aggregation level and units.
function refStats(keys) {
  if (!ref.data) return null;
  const sk = `${state.agg}|${JSON.stringify(state.units)}`;
  if (ref.statsKey === sk && ref.stats) return ref.stats;
  const usable = keys.filter((k) => k in ref.data.values);
  const agg = aggregate(ref.data, usable, state.agg, state.units);
  const stats = {};
  for (const k of usable) {
    const v = VAR_BY_KEY[k], s = agg.series[k];
    if (v.kind === 'dir' || v.kind === 'code') continue;
    const banded = v.kind === 'mean' && state.agg !== 'hour';
    const highs = (banded ? s.max : s.val).filter((x) => x != null && (v.kind !== 'sum' || x > 0)).sort((a, b) => a - b);
    const lows = (banded ? s.min : s.val).filter((x) => x != null).sort((a, b) => a - b);
    stats[k] = { hi: percentile(highs, REF_HI), lo: v.kind === 'sum' ? 0 : percentile(lows, 1 - REF_HI) };
  }
  ref.stats = stats;
  ref.statsKey = sk;
  return stats;
}

// Round a [lo, hi] range outwards to tidy values (steps of 1, 2, 2.5 or 5 × 10ⁿ).
function niceRange(lo, hi) {
  const span = Math.max(hi - lo, Math.abs(hi) * 1e-3, 1e-6);
  const raw5 = span / 5, mag = 10 ** Math.floor(Math.log10(raw5));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw5);
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step };
}

// y range per variable for the current view: the reference, widened only by values on screen.
function yScales(keys, agg) {
  const st = refStats(keys);
  if (!st) return null;
  const s0 = zoomWin ? zoomWin.startMs : -Infinity, e0 = zoomWin ? zoomWin.endMs : Infinity;
  const out = {};
  for (const k of keys) {
    if (!st[k] || st[k].hi == null) continue;
    const v = VAR_BY_KEY[k], s = agg.series[k];
    const banded = v.kind === 'mean' && state.agg !== 'hour';
    let hi = st[k].hi, lo = st[k].lo;
    agg.start.forEach((b, i) => {
      if (agg.end[i] <= s0 || b >= e0) return;
      const top = banded ? s.max[i] : s.val[i], bottom = banded ? s.min[i] : s.val[i];
      if (top != null && top > hi) hi = top;
      if (v.kind !== 'sum' && bottom != null && bottom < lo) lo = bottom;
    });
    out[k] = v.kind === 'sum' ? { min: 0, max: niceRange(0, hi).max } : niceRange(lo, hi);
  }
  return out;
}

// Keep the loaded data from growing without bound while browsing: drop what is far outside the axis.
function trimRaw() {
  const len = axis.E - axis.S;
  if (raw.loadedE - raw.loadedS <= 4 * len) return;
  const wb = wholeBars(axis); // never cut into a bar that is on screen
  const S = Math.max(raw.loadedS, Math.min(wb.S, axis.S - len)), E = Math.min(raw.loadedE, Math.max(wb.E, axis.E + len));
  const idx = [];
  raw.times.forEach((t, i) => { if (t > S && t <= E) idx.push(i); });
  raw = { ...raw, times: idx.map((i) => raw.times[i]),
    values: Object.fromEntries(Object.entries(raw.values).map(([k, v]) => [k, idx.map((i) => v[i])])), loadedS: S, loadedE: E };
}

async function fillAxis() {
  const target = raw;
  if (await queue(() => ensureData(wholeBars(axis))) && raw && raw !== target) renderResults();
}

// After a zoom or pan settles: re-centre the axis on the view when the view nears an edge that can
// still move, or when the view is no longer about a third of the axis.
let relayoutTimer;
function scheduleRelayout(delay = 350) { clearTimeout(relayoutTimer); relayoutTimer = setTimeout(relayout, delay); }
async function relayout() {
  if (!raw || !zoomWin || !axis) return;
  if (rangeBar.isDragging()) { scheduleRelayout(); return; }
  snapView();
  const vS = unwall(zoomWin.startMs), vE = unwall(zoomWin.endMs);
  const span = vE - vS;
  const nearLeft = vS - axis.S < span * 0.5 && axis.S > MIN_DATE;
  const nearRight = axis.E - vE < span * 0.5 && axis.E < nowHour();
  const ratio = (axis.E - axis.S) / span;
  if (!nearLeft && !nearRight && ratio > 2 && ratio < 4.5) {
    // Same axis: running totals restart at the new left edge and the y scales check what is now
    // on screen (in place, cheap).
    renderResults();
    return;
  }
  const want = axisAround(vS, vE);
  await queue(() => ensureData(wholeBars(want)));
  if (!raw) return;
  axis = want;
  trimRaw();
  renderResults();
}

// Once a zoom or pan settles, the bounds snap to the precision the time bar writes them in (whole
// days or hours), or to the ends of the axis.
let snapped = null; // the window just set by snapView, whose own zoom event must not count as a user change
function snapView() {
  const { min, max, minSpan } = chartRange;
  const st = boundStep(zoomWin.endMs - zoomWin.startMs);
  const round = (t) => Math.round(t / st) * st;
  let s = Math.max(min, round(zoomWin.startMs)), e = Math.min(max, round(zoomWin.endMs));
  const least = Math.ceil(minSpan / st) * st;
  if (e - s < least) { e = Math.min(max, s + least); s = Math.max(min, e - least); }
  if (s === zoomWin.startMs && e === zoomWin.endMs) return;
  zoomWin = { startMs: s, endMs: e };
  snapped = { ...zoomWin };
  rangeBar.update({ start: s, end: e });
  setZoom(s, e);
}

function onChartZoom(z) {
  zoomWin = { startMs: z.startMs, endMs: z.endMs };
  rangeBar.update({ start: z.startMs, end: z.endMs });
  const own = snapped && Math.abs(z.startMs - snapped.startMs) < 1e3 && Math.abs(z.endMs - snapped.endMs) < 1e3;
  if (own) return; // relayout is already running
  snapped = null;
  setActiveView(null);
  scheduleRelayout();
}

// ---------- "Taking long" dialog (downloads still running after 5 s) ----------

let choiceToken = 0;
function showChoice({ title, text, buttons }) {
  const token = ++choiceToken;
  $('slow-title').textContent = title;
  $('slow-text').textContent = text;
  const box = $('slow-btns');
  box.innerHTML = '';
  for (const b of buttons) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `btn${b.primary ? ' primary' : ''}`;
    el.textContent = b.label;
    el.onclick = () => { $('slow-dialog').close(); b.run?.(); };
    box.append(el);
  }
  if (!$('slow-dialog').open) $('slow-dialog').showModal();
  return token;
}
function closeChoice(token) { if (token === choiceToken && $('slow-dialog').open) $('slow-dialog').close(); }

// Start a 5 s watchdog for a download; returns the function to call when it is over.
function watchSlow(what, cancel) {
  let token = 0;
  const t = setTimeout(() => {
    token = showChoice({
      title: 'This is taking long',
      text: `${what} is still running after 5 seconds. Long periods with several variables take longer to download.`,
      buttons: [
        { label: 'Keep waiting', primary: true },
        { label: 'Cancel', run: () => { cancel(); setStatus('Cancelled.'); } },
      ],
    });
  }, 5000);
  return () => { clearTimeout(t); if (token) closeChoice(token); };
}

// ---------- View buttons ----------
// Period: the saved period. Up to now: the current visible length, ending now (the saved period is
// not changed). 1 d…1 y: that length, ending where the chart currently ends.

let activeView = null;
let lastX = [], lastStart = [], lastEnd = []; // bars of the last render: middle, start, end (wall ms)
function setActiveView(v) {
  activeView = v;
  document.querySelectorAll('#view-btns button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
}

// Number of bars a view shows for the current time step (the last one may be partial).
function viewBuckets(view) {
  const h = Number(view);
  return { hour: h, day: Math.round(h / 24), week: Math.round(h / 168), month: Math.round(h / 730.5), year: Math.round(h / 8766) }[state.agg] || 1;
}

// Bars that cover the instants just after `from` and just before `to` (wall ms).
const firstBarAfter = (from) => { const i = lastEnd.findIndex((e) => e > from); return i < 0 ? lastEnd.length - 1 : i; };
function lastBarBefore(to) {
  for (let i = lastStart.length - 1; i >= 0; i--) if (lastStart[i] < to) return i;
  return 0;
}

// Visible window (wall ms) for a view, snapped to whole bars.
function viewWindow(view, spanSec, anchorMs) {
  let i0, i1;
  if (view === 'period') {
    i0 = firstBarAfter(wallMs(rawWindow.S, raw.tz));
    i1 = lastBarBefore(wallMs(rawWindow.E, raw.tz));
  } else if (view === 'now') {
    i1 = lastStart.length - 1;
    i0 = Math.max(0, i1 - Math.max(1, Math.round((spanSec * 1000) / STEP_MS[state.agg])) + 1);
  } else {
    i1 = lastBarBefore(anchorMs);
    i0 = Math.max(0, i1 - viewBuckets(view) + 1);
  }
  return { startMs: lastStart[i0], endMs: lastEnd[i1] };
}

async function applyView(view) {
  setActiveView(view);
  const stepSec = STEP_MS[state.agg] / 1000;
  const anchorMs = zoomWin ? zoomWin.endMs : wallMs(rawWindow.E, raw.tz);
  let S, E, spanSec = 0;
  if (view === 'period') { S = rawWindow.S; E = rawWindow.E; }
  else if (view === 'now') {
    spanSec = zoomWin ? (zoomWin.endMs - zoomWin.startMs) / 1000 : rawWindow.E - rawWindow.S;
    E = nowHour(); S = E - spanSec;
  } else {
    E = unwall(anchorMs) + stepSec;
    S = E - (viewBuckets(view) + 1) * stepSec;
  }
  const want = axisAround(S, E);
  await queue(() => ensureData(wholeBars(want)));
  if (activeView !== view || !raw) return; // the user moved on meanwhile
  axis = want;
  trimRaw();
  renderResults(); // refreshes lastX for the current time step
  zoomWin = viewWindow(view, spanSec, anchorMs);
  renderResults();
  setActiveView(view);
}

document.querySelectorAll('#view-btns button[data-view]').forEach((b) => {
  b.onclick = () => { if (raw) applyView(b.dataset.view); };
});

// ---------- In / out marks ----------
// Drag the start mark (or the end mark) from the toolbar and drop it on a chart or on the time bar:
// the saved period then starts (or ends) there. The drop point snaps to an hour, or to a bar boundary when
// the data are aggregated per day, week, month or year. A dashed line shows where it will land.

const WD3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function markLabel(ms) {
  const d = new Date(ms);
  const date = `${WD3[d.getUTCDay()]} ${d.getUTCDate()} ${MO3[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return state.agg === 'hour' ? `${date} ${String(d.getUTCHours()).padStart(2, '0')}:00` : date;
}

function snapMark(ms) {
  if (state.agg === 'hour') return Math.round(ms / 3600e3) * 3600e3;
  const [a, b] = bucketBounds(ms, state.agg);
  return ms - a < b - ms ? a : b;
}

// Time (wall ms) under a screen point, or null when the point is neither on a plot nor on the time bar.
function timeAtPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  const chartEl = el?.closest('.chart');
  if (chartEl) {
    const chart = echarts.getInstanceByDom(chartEl);
    const r = chartEl.getBoundingClientRect();
    const grid = chart?.getModel().getComponent('grid')?.coordinateSystem?.getRect();
    if (!grid || x - r.left < grid.x - 2 || x - r.left > grid.x + grid.width + 2) return null;
    return { t: chart.convertFromPixel({ xAxisIndex: 0 }, x - r.left), chart, chartEl };
  }
  const track = el?.closest('.rb-track');
  if (track) {
    const r = track.getBoundingClientRect();
    return { t: chartRange.min + ((x - r.left) / r.width) * (chartRange.max - chartRange.min) };
  }
  return null;
}

function showGuide(which, hit) {
  const guide = $('mark-guide');
  if (!hit?.chart) { guide.hidden = true; return; }
  const wrap = guide.parentElement.getBoundingClientRect();
  const r = hit.chartEl.getBoundingClientRect();
  const px = hit.chart.convertToPixel({ xAxisIndex: 0 }, hit.snapped);
  guide.style.left = `${r.left - wrap.left + px}px`;
  guide.classList.toggle('end', which === 'end');
  guide.firstChild.textContent = markLabel(hit.snapped);
  guide.hidden = false;
}

// A dropped mark becomes the start (or end) of the saved period: the Period panel switches to
// "Date range" with that bound, the other bound is kept, and the data are reloaded.
function applyMark(which, t) {
  const z = raw.tz;
  const sec = unwall(t);
  let S = rawWindow.S, E = rawWindow.E;
  const len = E - S;
  if (which === 'start') {
    S = sec;
    if (E - S < HOUR) E = S + len; // dropped after the end: keep the length
  } else {
    E = sec;
    if (E - S < HOUR) S = E - len;
  }
  Object.assign(state, {
    otherMode: 'range',
    rangeStart: unixToZonedInput(Math.max(MIN_DATE, S), z),
    rangeEnd: unixToZonedInput(Math.min(nowHour(), E), z),
  });
  save();
  syncPeriodUI();
  scheduleFetch(0);
}

let markHintTimer;
document.querySelectorAll('#view-btns button[data-mark]').forEach((btn) => {
  const which = btn.dataset.mark;
  const ghost = $('mark-ghost');
  let drag = null;
  btn.addEventListener('pointerdown', (e) => {
    if (btn.disabled || e.button > 0 || !raw) return;
    e.preventDefault();
    try { btn.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, hit: null };
  });
  btn.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
    drag.moved = true;
    const hit = timeAtPoint(e.clientX, e.clientY);
    if (hit) hit.snapped = snapMark(hit.t);
    drag.hit = hit;
    ghost.hidden = false;
    ghost.style.left = `${e.clientX}px`;
    ghost.style.top = `${e.clientY}px`;
    ghost.textContent = hit ? `Period ${which}: ${markLabel(hit.snapped)}` : `Drop on the chart to set the period ${which}`;
    ghost.classList.toggle('off', !hit);
    showGuide(which, hit);
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { moved, hit } = drag;
    drag = null;
    ghost.hidden = true;
    $('mark-guide').hidden = true;
    if (moved && hit && e.type === 'pointerup') applyMark(which, hit.snapped);
    if (!moved) {
      setStatus(`Drag this mark onto the chart to set the ${which} of the period.`);
      clearTimeout(markHintTimer);
      markHintTimer = setTimeout(() => setStatus(''), 3000);
    }
  };
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
});

// Which model(s) produced the data, spelled out for "Auto".
function modelUsedText(keys, S, E) {
  if (period.model !== 'best_match') return `Model: ${MODELS.find((m) => m.id === period.model)?.label}.`;
  const parts = [];
  if (S < IFS_FROM) {
    const groups = { era5: [], land: [], mix: [] };
    keys.forEach((k) => groups[pre2017Source(k)].push(VAR_BY_KEY[k].label));
    const names = { era5: 'ERA5', land: 'ERA5-Land', mix: 'ERA5 + ERA5-Land' };
    const g = Object.entries(groups).filter(([, l]) => l.length);
    const txt = g.length === 1 ? names[g[0][0]] : g.map(([s, l]) => `${names[s]} (${l.join(', ')})`).join(', ');
    parts.push(E <= IFS_FROM ? txt : `${txt} until 31 Dec 2016`);
  }
  if (E > IFS_FROM) parts.push(S < IFS_FROM ? 'then ECMWF IFS 9 km' : 'ECMWF IFS 9 km');
  let t = `Currently used: ${parts.join(', ')}.`;
  if (period.filledHours) t += ` Last ${period.filledHours} h from Open-Meteo forecast.`;
  return t;
}

function clearResults() {
  raw = null;
  period = null;
  axis = null;
  disposeCharts();
  $('charts').innerHTML = '';
  $('rangebar').hidden = true;
  $('model-used').textContent = '';
  $('btn-chart-mode').hidden = true;
  $('btn-fullscreen').hidden = true;
  $('view-btns').hidden = true;
}

function fmt(v, unit) { return v == null ? '–' : v.toFixed(decimals(unit)); }

// First and last bar whose middle lies inside the view. When the view is narrower than one bar (no
// middle on screen), the bar under the middle of the view. null when there are no bars at all.
function visibleBars(agg) {
  const s0 = zoomWin ? zoomWin.startMs : -Infinity, e0 = zoomWin ? zoomWin.endMs : Infinity;
  let i0 = -1, i1 = -1;
  agg.x.forEach((x, i) => { if (x >= s0 && x <= e0) { if (i0 < 0) i0 = i; i1 = i; } });
  if (i0 < 0 && zoomWin) {
    const mid = (s0 + e0) / 2;
    i0 = i1 = agg.start.findIndex((b, i) => b <= mid && agg.end[i] > mid);
  }
  return i0 < 0 ? null : { i0, i1 };
}

// Running totals: nothing before the first bar on screen, then the sum from there on.
function restartRunningTotals(agg, vis) {
  for (const s of Object.values(agg.series)) {
    if (!s.cum) continue;
    let run = 0;
    s.cum = s.val.map((v, i) => {
      if (!vis || i < vis.i0) return null;
      if (v != null) run += v;
      return run;
    });
  }
}

function renderResults() {
  if (!raw || !period) return false;
  const keys = state.vars.filter((k) => k in raw.values);
  if (typeof echarts === 'undefined') { setStatus('Chart library could not be loaded (offline?).', 'error'); return false; }
  $('view-btns').hidden = false;
  document.querySelectorAll('#view-btns button').forEach((b) => { b.disabled = !keys.length; });
  if (!keys.length) {
    // No variable selected: the time axes and the time bar stay, the chart is empty with a message.
    lastX = []; lastStart = []; lastEnd = []; lastShadow = [];
    $('btn-chart-mode').hidden = true;
    $('btn-fullscreen').hidden = false;
    const range = { min: wallMs(axis.S, raw.tz), max: wallMs(axis.E, raw.tz) };
    renderEmpty($('charts'), state.agg, 'No data selected\nChoose a variable in the Data tab', { range, zoom: zoomWin, onZoom: onChartZoom });
    $('rangebar').hidden = false;
    rangeBar.update({ ...chartRange, start: zoomWin ? zoomWin.startMs : chartRange.min, end: zoomWin ? zoomWin.endMs : chartRange.max,
      shadow: [], unit: state.agg });
    $('model-used').textContent = '';
    return true;
  }
  if (!raw.times.length) { setStatus('No data returned for this period.', 'error'); return false; }

  $('btn-fullscreen').hidden = false;
  const modeBtn = $('btn-chart-mode');
  const combined = state.chartMode === 'combined';
  modeBtn.hidden = keys.length < 2;
  modeBtn.setAttribute('aria-pressed', combined);
  modeBtn.title = combined ? 'Separate charts' : 'Combine charts';
  modeBtn.setAttribute('aria-label', modeBtn.title);

  const agg = aggregate(raw, keys, state.agg, state.units);
  lastX = agg.x; lastStart = agg.start; lastEnd = agg.end;
  // The bars "on screen" are those whose middle is inside the view: the running total starts at the
  // first of them and its value is written at the last.
  const vis = visibleBars(agg);
  restartRunningTotals(agg, vis);
  // The axis keeps its time range whatever the aggregation: wide bars at its ends are simply cut.
  // (Only the data behind them is loaded whole, so their values are complete.)
  const range = axis ? { min: wallMs(axis.S, raw.tz), max: wallMs(axis.E, raw.tz) } : undefined;
  renderCharts($('charts'), agg, keys, state.agg, keys.length < 2 ? 'stacked' : state.chartMode,
    { range, zoom: zoomWin, onZoom: onChartZoom, yScale: yScales(keys, agg), endIdx: vis ? vis.i1 : -1,
      // Where the value is written: the last bar's middle, kept on screen when that bar is wider than the view.
      endX: vis && zoomWin ? Math.min(Math.max(agg.x[vis.i1], zoomWin.startMs), zoomWin.endMs) : undefined });
  // Time bar: the axis range, the visible window, and the first variable's profile.
  $('rangebar').hidden = false;
  lastShadow = agg.x.map((x, i) => [x, agg.series[keys[0]].val[i]]);
  rangeBar.update({ ...chartRange, start: zoomWin ? zoomWin.startMs : chartRange.min, end: zoomWin ? zoomWin.endMs : chartRange.max,
    shadow: lastShadow, unit: state.agg });

  $('model-used').textContent = modelUsedText(keys, rawWindow.S, rawWindow.E);
  return true;
}

$('btn-refresh').onclick = () => { syncPeriodUI(); scheduleFetch(0); };
$('btn-chart-mode').onclick = () => {
  state.chartMode = state.chartMode === 'stacked' ? 'combined' : 'stacked';
  save();
  renderResults();
};

// Full screen: the browser's own when it allows it, otherwise the results block is simply laid over
// the whole page (.fs). Either way the charts are resized to the new space.
function onFullscreenChange() {
  const on = !!document.fullscreenElement || $('results').classList.contains('fs');
  $('btn-fullscreen').title = on ? 'Exit full screen' : 'Full screen';
  $('btn-fullscreen').setAttribute('aria-pressed', on);
  setTimeout(() => { resizeCharts(); rangeBar.update({ redraw: true }); }, 120);
}
function setFallbackFullscreen(on) {
  $('results').classList.toggle('fs', on);
  onFullscreenChange();
}
$('btn-fullscreen').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else if ($('results').classList.contains('fs')) setFallbackFullscreen(false);
  else if (document.fullscreenEnabled) $('results').requestFullscreen().catch(() => setFallbackFullscreen(true));
  else setFallbackFullscreen(true);
};
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('results').classList.contains('fs')) setFallbackFullscreen(false); });

const rangeBar = createRangeBar($('rangebar'), { onChange: setZoom, onEnd: () => scheduleRelayout(0), minSpan: 3 * 3600e3,
  stepFor: (span) => boundStep(span) });
let lastShadow = null;

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { resizeCharts(); rangeBar.update({ redraw: true }); }, 150);
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderResults());

// ---------- Boot ----------

load();
prefillOther();
syncStepUI();
renderLocation();
syncPeriodUI();
renderVars();
renderUnits();
renderModels();
updateTabs();
scheduleFetch(0);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {}));
}

// Show unexpected errors in the status line so they can be reported.
window.addEventListener('error', (e) => setStatus(`Error: ${e.message}`, 'error'));
window.addEventListener('unhandledrejection', (e) => setStatus(`Error: ${e.reason?.message || e.reason}`, 'error'));
