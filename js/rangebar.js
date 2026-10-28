// Time bar under the charts. The highlighted window is the visible part of the chart.
// - One finger / mouse: dragging the window only moves it in time.
// - Long press (≈0.45 s without moving) on an edge unlocks that edge for resizing.
// - Two fingers: each finger immediately takes the nearest edge, so both bounds can be set at once.
// - Tapping the track outside the window centres the window there.
// Vertical ticks mark round dates; the dates of both bounds are written under the window.

const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE = 6; // px of finger jitter allowed during the long press
const EDGE_ZONE = 18;     // px around each edge where a long press grabs that edge

const H = 3600e3, D = 24 * H;
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Tick spacing candidates: [kind, amount]. Months/years are calendar-aligned.
const TICK_STEPS = [['h', 1], ['h', 3], ['h', 6], ['h', 12], ['d', 1], ['d', 2], ['d', 7], ['m', 1], ['m', 3], ['m', 6],
  ['y', 1], ['y', 2], ['y', 5], ['y', 10], ['y', 20]];
const approx = ([k, n]) => n * (k === 'h' ? H : k === 'd' ? D : k === 'm' ? 30.44 * D : 365.24 * D);

function ticks(min, max, widthPx) {
  const want = (max - min) / Math.max(2, widthPx / 45); // about one tick every 45 px
  const st = TICK_STEPS.find((s) => approx(s) >= want) || TICK_STEPS[TICK_STEPS.length - 1];
  const [k, n] = st;
  const out = [];
  const d = new Date(min);
  if (k === 'h' || k === 'd') {
    const unit = k === 'h' ? H * n : D * n;
    for (let t = Math.ceil(min / unit) * unit; t <= max; t += unit) out.push(t);
  } else {
    let y = d.getUTCFullYear(), m = k === 'm' ? Math.ceil(d.getUTCMonth() / n) * n : 0;
    if (k === 'y') y = Math.ceil(y / n) * n;
    for (let t = Date.UTC(y, m, 1); t <= max; ) {
      if (t >= min) out.push(t);
      if (k === 'm') { m += n; t = Date.UTC(y, m, 1); } else { y += n; t = Date.UTC(y, 0, 1); }
    }
  }
  return out;
}

// Date of a window bound, in the precision of the time step (unit: hour, day, month, year), with the
// time of day when withTime: "8h", "8h30", "8h15".
function fmtBound(ms, unit, withTime) {
  const d = new Date(ms);
  if (unit === 'year') return String(d.getUTCFullYear());
  if (unit === 'month') return `${MO[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const s = `${d.getUTCDate()} ${MO[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (!withTime) return s;
  const m = d.getUTCMinutes();
  return `${s} ${d.getUTCHours()}h${m ? String(m).padStart(2, '0') : ''}`;
}

// stepFor(spanMs): precision of the bound labels for a window of that length (ms; ≥ 1 day = date only).
export function createRangeBar(el, { onChange, onEnd, minSpan, stepFor = () => H }) {
  el.innerHTML = '<div class="rb-track"><svg class="rb-svg" preserveAspectRatio="none" aria-hidden="true"><g class="rb-ticks"></g><path class="rb-shadow"/></svg>'
    + '<div class="rb-thumb"><span class="rb-h rb-l"></span><span class="rb-h rb-r"></span></div></div>'
    + '<div class="rb-labels"><span class="rb-lab rb-lab-l"></span><span class="rb-lab rb-lab-r"></span></div>';
  const track = el.querySelector('.rb-track');
  const thumb = el.querySelector('.rb-thumb');
  const svg = el.querySelector('.rb-svg');
  const labL = el.querySelector('.rb-lab-l'), labR = el.querySelector('.rb-lab-r');
  let min = 0, max = 1, start = 0, end = 1, span = minSpan, unit = 'hour', shadow = null;
  let g = null;              // current gesture
  const pointers = new Map(); // pointerId → clientX

  const W = () => track.clientWidth;
  const toX = (t) => ((t - min) / (max - min)) * W();
  const perPx = () => (max - min) / W();

  function drawLabels() {
    const w = W(), l = toX(start), r = toX(end);
    // Date and time of each bound, rounded to the current step. Per month or year the bounds are month
    // or year starts, written as such; with a step of a day or more, only dates are written, and the
    // end then names the last month, year or day included.
    const step = stepFor(end - start);
    const coarse = unit === 'month' || unit === 'year' || step >= D;
    const round = (ms) => Math.round(ms / step) * step;
    labL.textContent = fmtBound(coarse ? start : round(start), unit, !coarse);
    labR.textContent = fmtBound(coarse ? end - 1 : round(end), unit, !coarse);
    const lw = labL.offsetWidth, rw = labR.offsetWidth;
    // Each label is centred under its bound; if they would overlap, both move apart by the same
    // amount, and they always stay within the bar.
    let lx = l - lw / 2, rx = r - rw / 2;
    const overlap = lx + lw + 8 - rx;
    if (overlap > 0) { lx -= overlap / 2; rx += overlap / 2; }
    lx = Math.min(Math.max(0, lx), w - lw);
    rx = Math.min(Math.max(0, rx), w - rw);
    if (lx + lw + 8 > rx) { if (lx === 0) rx = lx + lw + 8; else lx = rx - lw - 8; } // pinned at an edge
    labL.style.left = `${lx}px`;
    labR.style.left = `${rx}px`;
  }

  function draw() {
    const l = toX(start), r = toX(end);
    thumb.style.left = `${l}px`;
    thumb.style.width = `${Math.max(6, r - l)}px`;
    drawLabels();
  }

  function drawTrack() {
    const w = W(), h = track.clientHeight;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    el.querySelector('.rb-ticks').innerHTML = ticks(min, max, w)
      .map((t) => { const x = toX(t).toFixed(1); return `<line x1="${x}" x2="${x}" y1="0" y2="${h}"/>`; }).join('');
    const path = el.querySelector('.rb-shadow');
    if (!shadow) { path.setAttribute('d', ''); return; }
    // One column per 2 px holding the largest value: cheap even for years of hourly data.
    const cols = new Float64Array(Math.max(1, Math.ceil(w / 2)));
    let top = 1e-9;
    for (const [t, v] of shadow) {
      if (v == null || t < min || t > max) continue;
      const i = Math.min(cols.length - 1, Math.max(0, Math.floor(((t - min) / (max - min)) * cols.length)));
      const a = Math.abs(v);
      if (a > cols[i]) cols[i] = a;
      if (a > top) top = a;
    }
    let d = `M0,${h}`;
    cols.forEach((v, i) => { d += `L${i * 2},${(h - (v / top) * (h - 4)).toFixed(1)}`; });
    path.setAttribute('d', `${d}L${w},${h}Z`);
  }

  function emit(s, e) {
    start = s; end = e;
    draw();
    onChange(start, end);
  }

  function clampMove(s, e) {
    const w = e - s;
    if (s < min) { s = min; e = min + w; }
    if (e > max) { e = max; s = max - w; }
    return [s, e];
  }

  const setLeft = (t) => Math.min(Math.max(min, t), end - span);
  const setRight = (t) => Math.max(Math.min(max, t), start + span);

  track.addEventListener('pointerdown', (ev) => {
    if (ev.button > 0) return;
    try { track.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    pointers.set(ev.pointerId, ev.clientX);
    el.classList.add('dragging');

    if (pointers.size === 2) {
      // Second finger: both edges follow their nearest finger right away.
      clearTimeout(g?.timer);
      const [a, b] = [...pointers.entries()].sort((p, q) => p[1] - q[1]);
      g = { mode: 'two', left: a[0], right: b[0], xl0: a[1], xr0: b[1], s0: start, e0: end };
      el.classList.add('resizing-l', 'resizing-r');
      return;
    }
    if (pointers.size > 2) return;

    const x = ev.clientX - track.getBoundingClientRect().left;
    const l = toX(start), r = toX(end);
    if (x < l - EDGE_ZONE / 2 || x > r + EDGE_ZONE / 2) {
      const c = min + x * perPx();
      emit(...clampMove(c - (end - start) / 2, c + (end - start) / 2));
      g = { mode: 'tap' };
      return;
    }
    const dl = Math.abs(x - l), dr = Math.abs(x - r);
    const edge = Math.min(dl, dr) <= EDGE_ZONE ? (dl <= dr ? 'l' : 'r') : null;
    g = { mode: 'move', id: ev.pointerId, x0: ev.clientX, s0: start, e0: end, moved: false, timer: 0 };
    if (edge) {
      g.timer = setTimeout(() => {
        if (!g || g.moved || g.mode !== 'move') return;
        g.mode = edge;
        el.classList.add(`resizing-${edge}`);
        navigator.vibrate?.(25);
      }, LONG_PRESS_MS);
    }
  });

  track.addEventListener('pointermove', (ev) => {
    if (!pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, ev.clientX);
    if (!g) return;
    if (g.mode === 'two') {
      const xl = pointers.get(g.left), xr = pointers.get(g.right);
      const s = Math.max(min, g.s0 + (xl - g.xl0) * perPx());
      const e = Math.min(max, g.e0 + (xr - g.xr0) * perPx());
      if (e - s >= span) emit(s, e);
      return;
    }
    if (ev.pointerId !== g.id) return;
    const dx = ev.clientX - g.x0;
    if (!g.moved && Math.abs(dx) <= MOVE_TOLERANCE) return;
    if (!g.moved) { g.moved = true; clearTimeout(g.timer); }
    const dt = dx * perPx();
    if (g.mode === 'move') emit(...clampMove(g.s0 + dt, g.e0 + dt));
    else if (g.mode === 'l') emit(setLeft(g.s0 + dt), end);
    else if (g.mode === 'r') emit(start, setRight(g.e0 + dt));
  });

  const stop = (ev) => {
    pointers.delete(ev.pointerId);
    if (pointers.size > 0 && g?.mode === 'two') { g = null; return; } // wait for the last finger
    if (pointers.size > 0) return;
    clearTimeout(g?.timer);
    el.classList.remove('resizing-l', 'resizing-r', 'dragging');
    const had = !!g;
    g = null;
    if (had) onEnd?.();
  };
  track.addEventListener('pointerup', stop);
  track.addEventListener('pointercancel', stop);

  return {
    isDragging: () => pointers.size > 0,
    // o: {min, max, minSpan, start, end, shadow: [[t, v], …], unit, redraw}; all optional.
    update(o) {
      let rescaled = false;
      if (o.min != null && (o.min !== min || o.max !== max)) { min = o.min; max = o.max; rescaled = true; }
      if (o.minSpan != null) span = o.minSpan;
      if (o.unit) unit = o.unit;
      if (o.start != null && !pointers.size) { start = Math.max(min, o.start); end = Math.min(max, o.end); }
      if (o.shadow) { shadow = o.shadow; rescaled = true; }
      if (rescaled || o.redraw) drawTrack();
      draw();
    },
  };
}
