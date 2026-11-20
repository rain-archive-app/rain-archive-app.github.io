// ECharts rendering: one synced chart per variable ("stacked") or a single multi-axis chart ("combined").
// When only the data or the time range changes, existing charts are updated in place (no flicker).
import { VAR_BY_KEY, decimals, wmoLabel, compass } from './vars.js?v=153';
import { fmtWall, STEP_MS } from './data.js?v=153';

const PALETTE = ['#2f7fd8', '#e8743b', '#19a979', '#945ecf', '#d4526e', '#13a4b4', '#ce8f1f', '#6b7a8f'];
const GROUP = 'rain-archive';
const DAY = 86400e3;
let instances = [];
let current = null; // {sig, titleEls: {key: el}, gran}

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

const colorFor = (keys, k) => PALETTE[keys.indexOf(k) % PALETTE.length];

// #rrggbb moved towards white (255) or black (0) by the fraction f.
function mixColor(color, target, f) {
  const n = parseInt(color.slice(1), 16);
  const ch = (shift) => Math.round(((n >> shift) & 255) * (1 - f) + target * f);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
const lighter = (color) => mixColor(color, 255, 0.45); // forecast bars, dots and bands
// Running totals and mean lines. Less dark on a dark background, where they would disappear.
const darker = (color, theme) => mixColor(color, 0, theme.dark ? 0.2 : 0.35);

const IS_TOUCH = matchMedia('(pointer: coarse)').matches;
const PINCH_TOLERANCE = 0.15; // finger spacing may change ±15 % during a two-finger pan

// Full x range of the charts (wall ms) and smallest visible span; shared with the gesture code and the app.
export const chartRange = { min: 0, max: 1, minSpan: 3 * 3600e3 };

// Icon of the combine / separate button: two data lines in the colours of the first two variables. It shows what a click will give:
// the lines together in one chart, or each in its own band.
export function chartModeIcon(keys, toCombined) {
  const col = (i) => (keys[i] ? colorFor(keys, keys[i]) : 'currentColor');
  const line = (d, i) => `<path d="${d}" stroke="${col(i)}" stroke-width="2"/>`;
  if (toCombined) {
    return line('M3 16l5-7 5 5 8-8', 0) + line('M3 10l5 7 5-4 8 5', 1);
  }
  return line('M3 9l5-4 5 2.5 8-4', 0) + line('M3 19.5l5-4 5 2.5 8-4', 1);
}

// ---------- Axis labels ----------
// Bottom ticks are evenly spaced in a calendar unit chosen from the visible span and the chart width
// (every hour, 6 h, 12 h, day, week, month, 3 or 6 months, year, 2/5/10 years), and every tick is
// labelled. Weekdays are written diagonally on top only when days are readable. Both axes have dark
// tick marks joining each label to its axis.

const WD = ['Sun.', 'Mon.', 'Tue.', 'Wed.', 'Thu.', 'Fri.', 'Sat.'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
const Y = 365.2425 * DAY;
// [approximate interval ms, kind, minimum px between two labels, count]
// The px values are about one label's width plus a small gap ("15:00" ≈ 30 px, "21 Sep" ≈ 36 px).
const TICK_UNITS = [
  [3600e3, 'h', 36, 1], [2 * 3600e3, 'h', 36, 2], [3 * 3600e3, 'h', 36, 3], [6 * 3600e3, 'h', 36, 6], [12 * 3600e3, 'h', 36, 12],
  [DAY, 'd', 44, 1], [2 * DAY, 'd', 44, 2], [7 * DAY, 'w', 44, 1],
  [Y / 12, 'm', 30, 1], [Y / 4, 'm', 30, 3], [Y / 2, 'm', 30, 6],
  [Y, 'y', 34, 1], [2 * Y, 'y', 34, 2], [5 * Y, 'y', 34, 5], [10 * Y, 'y', 34, 10],
];

// Tick positions (wall ms) between min and max, aligned on the calendar: hours on multiples of n,
// every n-th day, Mondays, months/years on multiples of n.
function calendarTicks(min, max, [, kind, , n]) {
  const out = [];
  if (kind === 'h' || kind === 'd') {
    const unit = (kind === 'h' ? 3600e3 : DAY) * n;
    for (let t = Math.ceil(min / unit) * unit; t <= max; t += unit) out.push(t);
  } else if (kind === 'w') {
    let t = Math.ceil(min / DAY) * DAY;
    t += ((8 - new Date(t).getUTCDay()) % 7) * DAY; // next Monday
    for (; t <= max; t += 7 * DAY) out.push(t);
  } else {
    const d = new Date(min);
    let y = d.getUTCFullYear(), m = kind === 'm' ? d.getUTCMonth() : 0;
    if (kind === 'm') m = Math.floor(m / n) * n; else y = Math.floor(y / n) * n;
    for (let i = 0; i < 2000; i++) {
      const t = Date.UTC(y, m, 1);
      if (t > max) break;
      if (t >= min) out.push(t);
      if (kind === 'm') m += n; else y += n;
    }
  }
  return out;
}
let tickUnit = TICK_UNITS[3];
let topShown = true;
let plotWidth = 260;

function unitFor(spanMs) {
  const pxPerMs = plotWidth / spanMs;
  return TICK_UNITS.find(([ms, , px]) => ms * pxPerMs >= px) || TICK_UNITS[TICK_UNITS.length - 1];
}
// Precision of the window bounds (time bar labels and snapping), from how dense the axis labels are:
// labels sparser than every 2 days → whole days; otherwise whole hours (the data are hourly).
export function boundStep(spanMs) {
  return ['w', 'm', 'y'].includes(unitFor(spanMs)[1]) ? 24 * 3600e3 : 3600e3;
}
// Weekdays on top whenever the bottom labels name days ("19 Oct"), whatever the aggregation level.
const topFor = (spanMs) => ['h', 'd', 'w'].includes(unitFor(spanMs)[1]);
const GRID_TOP = { on: 34, off: 22 }; // room for the diagonal weekdays, or else for the units above the axes

function bottomLabel(ms) {
  const d = new Date(ms);
  const isDay = d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
  const isMonth = isDay && d.getUTCDate() === 1;
  const isYear = isMonth && d.getUTCMonth() === 0;
  const kind = tickUnit[1];
  if (kind === 'y') return String(d.getUTCFullYear());
  if (kind === 'm') return isYear ? String(d.getUTCFullYear()) : MO[d.getUTCMonth()];
  if (kind === 'h' && !isDay) return `${pad(d.getUTCHours())}:00`;
  return `${d.getUTCDate()} ${MO[d.getUTCMonth()]}`;
}
const topLabel = (ms) => WD[new Date(ms).getUTCDay()];

// Visible part of the axis (wall ms); imposed ticks are limited to it, otherwise ECharts draws the
// labels of ticks lying just outside the view at the plot edges.
const view = { s: 0, e: 1 };

// The next larger calendar unit above the tick spacing: days above hours, months above days and
// weeks, years above months. Its boundaries get dark grid lines and dark, bold labels.
const MAJOR_OF = { h: [DAY, 'd', 0, 1], d: [Y / 12, 'm', 0, 1], w: [Y / 12, 'm', 0, 1], m: [Y, 'y', 0, 1] };
let majors = new Set();
const bottomLabelStyled = (ms) => (majors.has(ms) ? `{major|${bottomLabel(ms)}}` : bottomLabel(ms));

// Grid lines follow the smallest unit that appears in the labels: every hour when hours are
// written, every day when days are written (even if only every other day carries a label), every
// month, every year. If that would put lines closer than 4 px, they follow the labels instead.
const LOWEST_OF = { h: [3600e3, 'h', 0, 1], d: [DAY, 'd', 0, 1], w: [DAY, 'd', 0, 1], m: [Y / 12, 'm', 0, 1], y: [Y, 'y', 0, 1] };

// Hidden helper axis: only draws vertical grid lines at the given times.
const gridAxis = (range, values, color) => ({
  type: 'time', ...range, position: 'bottom',
  axisLabel: { show: false, customValues: values },
  axisTick: { show: false, customValues: values },
  axisLine: { show: false, onZero: false },
  splitLine: { show: true, lineStyle: { color, width: 1 } },
});

const WEEKDAY_W = 22; // px, how far right of its tick a slanted weekday label reaches
function xAxes(theme, gran) {
  const range = { min: chartRange.min, max: chartRange.max };
  const ticks = calendarTicks(view.s, view.e, tickUnit); // imposed, so they stay perfectly regular
  const major = MAJOR_OF[tickUnit[1]] ? calendarTicks(view.s, view.e, MAJOR_OF[tickUnit[1]]) : [];
  majors = new Set(major);
  let minor = calendarTicks(view.s, view.e, LOWEST_OF[tickUnit[1]]);
  if (minor.length && plotWidth / minor.length < 4) minor = ticks;
  // Weekdays on top exactly above the bottom labels that name a day (midnight ticks), so a day
  // hidden below for lack of room is hidden above too, and every connector has its label.
  // A weekday too close to the right end of the plot would run, slanting up to the right, under the
  // unit written above the right axis: it is left out (with its connector).
  const px = (t) => ((t - view.s) / (view.e - view.s)) * plotWidth;
  const weekdays = ticks.filter((t) => t % DAY === 0 && px(t) <= plotWidth - WEEKDAY_W);
  return [
    {
      // Labels below the plot (no tick marks below the axis).
      type: 'time', ...range, position: 'bottom',
      axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: false, formatter: bottomLabelStyled, margin: 6, customValues: ticks,
        rich: { major: { color: theme.major, fontWeight: 700, fontSize: 11 } } },
      axisTick: { show: false, customValues: ticks },
      axisLine: { onZero: false, lineStyle: { color: theme.line } }, // stays at the bottom even below 0 °C
      splitLine: { show: false },
    },
    {
      // Weekdays, written diagonally above the chart, each joined to the top of the plot by a dark
      // connector. onZero: false keeps the axis (and its connectors) at the top instead of at y = 0.
      type: 'time', ...range, position: 'top', show: topShown,
      // rotate −45: text rising from bottom left to top right, starting at its connector.
      axisLabel: { color: theme.muted, fontSize: 10, rotate: -45, hideOverlap: false, formatter: topLabel, margin: 11, customValues: weekdays },
      axisTick: { show: true, length: 10, lineStyle: { color: theme.text }, customValues: weekdays },
      axisLine: { show: false, onZero: false },
      splitLine: { show: false },
    },
    gridAxis(range, minor, theme.grid),  // light lines: smallest unit shown in the labels
    gridAxis(range, major, theme.major), // dark lines: the larger unit (drawn last, on top)
  ];
}

// Called after each zoom/pan: recompute the ticks of the new visible part (and their spacing).
// Each setOption makes ECharts go through all the series again (up to 0.4 s per chart for a year of
// hourly data), so nothing is redone while the view moves: the ticks follow once it has stood still
// for a moment, and not at all when the app has meanwhile redrawn the charts with the same ticks.
let labelTimer = 0, labelSig = '';
const axesSig = (xAxis) => [tickUnit.join(), topShown, ...xAxis.map((a) => a.axisLabel.customValues?.join(',') ?? '')].join('|');
function refreshLabels(chart, startMs, endMs, gran, theme) {
  view.s = startMs; view.e = endMs;
  clearTimeout(labelTimer);
  labelTimer = setTimeout(() => applyLabels(gran, theme), 450);
}
function applyLabels(gran, theme) {
  tickUnit = unitFor(view.e - view.s);
  topShown = topFor(view.e - view.s);
  const xAxis = xAxes(theme, gran);
  const sig = axesSig(xAxis);
  if (sig === labelSig) return;
  labelSig = sig;
  const grid = { top: topShown ? GRID_TOP.on : GRID_TOP.off };
  // The units above the y axes follow the top of the plot (separate charts only have them).
  const unitTop = { top: grid.top - UNIT_GAP - 11 };
  for (const c of instances) {
    // The ids of the unit texts of this chart (unit-l / unit-r, or unit-0, unit-1… when combined).
    const ids = (c.getModel().getComponent('graphic')?.option?.elements || []).map((e) => e.id).filter((id) => /^unit-/.test(id));
    c.setOption({ xAxis, grid, ...(ids.length ? { graphic: ids.map((id) => ({ id, ...unitTop })) } : {}) });
  }
}

// ---------- Touch gestures ----------

/**
 * Two-finger gestures on a chart: moving both fingers pans the time window; spreading or
 * pinching them (beyond the tolerance) zooms around their midpoint. One finger is left to
 * ECharts, which shows the tooltip under the finger as a tap would.
 */
// Visible part of the time axis, in % ({start, end}), read from the model: getOption() would copy all the data.
function zoomPct(chart) {
  const [start, end] = chart.getModel().getComponent('dataZoom', 0).getPercentRange();
  return { start, end };
}
function attachTouch(chart, el) {
  let g = null;
  const mid = (t) => (t[0].clientX + t[1].clientX) / 2;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) { g = null; return; }
    const { min, max } = chartRange;
    const dz = zoomPct(chart);
    const rect = chart.getModel().getComponent('grid').coordinateSystem.getRect();
    const box = el.getBoundingClientRect();
    g = {
      s: min + (dz.start / 100) * (max - min), e: min + (dz.end / 100) * (max - min),
      m0: mid(e.touches), d0: dist(e.touches), left: box.left + rect.x, width: rect.width, mode: null,
    };
    hideTips(true);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!g || e.touches.length !== 2) return;
    e.preventDefault();
    hideTips(true);
    const { min, max, minSpan } = chartRange;
    const ratio = dist(e.touches) / g.d0;
    const dx = mid(e.touches) - g.m0;
    if (!g.mode) {
      if (Math.abs(ratio - 1) > PINCH_TOLERANCE) g.mode = 'zoom';
      else if (Math.abs(dx) > 8) g.mode = 'pan';
      else return;
    }
    const span = g.e - g.s;
    const perPx = span / g.width;
    let s, en;
    if (g.mode === 'pan') {
      s = g.s - dx * perPx;
      en = g.e - dx * perPx;
    } else {
      const anchor = g.s + (g.m0 - g.left) * perPx; // time under the fingers at the start
      const newSpan = Math.min(max - min, Math.max(minSpan, span / ratio));
      const frac = (g.m0 - g.left) / g.width;
      s = anchor - frac * newSpan - dx * (newSpan / g.width);
      en = s + newSpan;
    }
    if (s < min) { en += min - s; s = min; }
    if (en > max) { s -= en - max; en = max; }
    chart.dispatchAction({ type: 'dataZoom', startValue: Math.max(min, s), endValue: en });
  }, { passive: false });
  const end = (e) => {
    if (e.touches.length < 2) g = null;
    // The tooltip stays off until every finger is up: the finger left last would bring it back.
    if (!e.touches.length) hideTips(false);
    else hideTips(true);
  };
  el.addEventListener('touchend', end, { passive: true });
  el.addEventListener('touchcancel', end, { passive: true });
}

// A tap on the box with the values closes it (it is the chart's second child, after the canvas).
let tapCloseOn = false;
function closeTipOnTap(container) {
  if (tapCloseOn || !IS_TOUCH) return;
  tapCloseOn = true;
  // On the touch end itself: phones send the click (if at all: iOS skips it on plain boxes) only
  // afterwards, with mouse events that could open the box again where the finger was.
  const close = (e) => {
    if (!e.target.closest?.('.chart > div + div')) return;
    if (e.cancelable) e.preventDefault(); // no click or mouse events after this tap
    e.stopPropagation();
    const hide = () => { for (const c of instances) c.dispatchAction({ type: 'hideTip' }); };
    hide();
    setTimeout(hide, 80); // and again, in case something reopened it meanwhile
  };
  container.addEventListener('touchend', close, { passive: false });
  container.addEventListener('click', close);
}

// No tooltip (the box with the values) during a two-finger zoom or pan, on any of the charts.
let tipsOff = false;
function hideTips(off) {
  if (off) for (const c of instances) c.dispatchAction({ type: 'hideTip' });
  if (off === tipsOff) return;
  tipsOff = off;
  document.body.classList.toggle('two-fingers', off);
}

// ---------- Titles, tooltip ----------

// Title: just "● Rain" (the total is written on the running-total line). With several variables, an
// eye (show / hide its chart) and a bin (remove it) follow the name.
const EYE = '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
const EYE_OFF = `${EYE}<path d="M4 4l16 16"/>`;
const BIN = '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"/>';
const INFO = '<circle cx="12" cy="12" r="9.5"/><path d="M12 11.2v5.6"/><circle cx="12" cy="7.6" r="1.25" fill="currentColor" stroke="none"/>';
function titleEl(key, color, t = {}) {
  const el = document.createElement('div');
  el.className = 'chart-title' + (t.hidden ? ' is-hidden' : '');
  el.dataset.key = key;
  el.innerHTML = '<span class="dot"></span><span class="name"></span>';
  el.querySelector('.dot').style.background = color;
  el.querySelector('.name').textContent = VAR_BY_KEY[key].label;
  const label = VAR_BY_KEY[key].label;
  const icon = (cls, svg, title, disabled) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `var-tool ${cls}`;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.disabled = !!disabled;
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${svg}</svg>`;
    return b;
  };
  if (t.tools) {
    el.append(
      icon('var-hide', t.hidden ? EYE_OFF : EYE, t.hidden ? `Show ${label}` : `Hide ${label}`, t.lastShown),
      icon('var-del', BIN, `Remove ${label}`));
  }
  el.append(icon('var-info', INFO, `Where the ${label.toLowerCase()} data come from`)); // always, even alone
  return el;
}

export function disposeCharts() {
  instances.forEach((c) => c.dispose());
  instances = [];
  labelSpecs = [];
  current = null;
}

// Real plot width (px), measured on the first chart; the label density depends on it.
function measurePlot() {
  const w = instances[0]?.getModel().getComponent('grid')?.coordinateSystem?.getRect().width;
  if (w > 0) plotWidth = w;
}

export function resizeCharts() {
  instances.forEach((c) => c.resize());
  measurePlot();
  if (current) refreshLabels(null, view.s, view.e, current.gran, current.theme);
  placeTotalLabels();
}

// The "Total …" label sits above the end of the running-total line, but must stay between the top
// and bottom lines of the plot. When there is no room above, it goes below the point, on a 50 %
// transparent background so it stays readable over the bars (and the other way round at the bottom).
const TOTAL_FS = 13; // px, bold "Total …" label
const LABEL_H = 18;  // px, one line of it
function halfTransparent(color) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return 'rgba(255,255,255,0.5)';
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},0.5)`;
}
// Several totals on one chart (combined charts) never overlap: a label that would cover another one
// already placed moves down below it (or up above it when there is no room left below).
function labelWidth(text) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  labelFont ??= `700 ${TOTAL_FS}px ${getComputedStyle(document.body).fontFamily}`;
  measureCtx.font = labelFont;
  return measureCtx.measureText(text).width + 6;
}
let labelFont = null;
const bodyFont = () => getComputedStyle(document.body).fontFamily;
// The "Total" / "Mean" labels of each chart, noted when the charts are drawn ({ i: series index,
// coord, yAxisIndex, w: width, pos, off }), so that nothing has to read the charts' whole options
// back (chart.getOption() copies all the data: far too slow to do while dragging).
let labelSpecs = [];
function noteLabels(charts) {
  labelSpecs = charts.map((c) => ({ count: c.opt.series.length, items: c.opt.series.map((s, i) => {
    const coord = s.markPoint?.data?.[0]?.coord;
    if (!coord) return null;
    return { i, coord, yAxisIndex: s.yAxisIndex ?? 0, w: labelWidth(s.markPoint.label.formatter()), pos: 'top', off: 0, offX: 0 };
  }).filter(Boolean) }));
}
function placeTotalLabels() {
  const bg = halfTransparent(css('--card'));
  instances.forEach((chart, n) => {
    const spec = labelSpecs[n];
    if (!spec?.items.length) return;
    const rect = chart.getModel().getComponent('grid')?.coordinateSystem?.getRect();
    if (!rect) return;
    const items = [];
    spec.items.forEach((sp) => {
      // Measured on the label's own y axis (the right-hand Σ axis for totals), not the first one.
      const [px, py] = chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: sp.yAxisIndex }, sp.coord) ?? [];
      if (py == null || Number.isNaN(py)) return;
      const roomAbove = py - 4 - LABEL_H >= rect.y;
      const roomBelow = py + 4 + LABEL_H <= rect.y + rect.height;
      const below = !roomAbove && roomBelow;
      const top = below ? py + 4 : py - 4 - LABEL_H;
      // Right-aligned on its point, but never cut by the left edge of the chart: then moved right.
      const dx = Math.max(0, Math.ceil(2 - (px - sp.w)));
      items.push({ i: sp.i, sp, below, top, top0: top, dx, left: px - sp.w + dx, right: px + dx });
    });
    // Highest first; each one goes clear of those already placed that it overlaps.
    items.sort((a, b) => a.top - b.top);
    const placed = [];
    for (const it of items) {
      const hits = () => placed.find((p) => it.left < p.right && it.right > p.left && it.top < p.top + LABEL_H && it.top + LABEL_H > p.top);
      for (let h = hits(), n = 0; h && n < 10; h = hits(), n++) it.top = h.top + LABEL_H + 1;
      if (it.top + LABEL_H > rect.y + rect.height) { // no room below: above them all instead
        it.top = Math.min(...placed.filter((p) => it.left < p.right && it.right > p.left).map((p) => p.top), it.top0) - LABEL_H - 1;
      }
      placed.push(it);
    }
    let changed = false;
    const series = Array.from({ length: spec.count }, (_, i) => {
      const it = items.find((x) => x.i === i);
      if (!it) return {};
      const offset = [it.dx, Math.round(it.top - it.top0)];
      const want = it.below ? 'bottom' : 'top';
      if (it.sp.pos === want && it.sp.off === offset[1] && it.sp.offX === offset[0]) return {};
      it.sp.pos = want; it.sp.off = offset[1]; it.sp.offX = offset[0];
      changed = true;
      return { markPoint: { label: it.below || offset[1]
        ? { position: want, offset, backgroundColor: bg, padding: [1, 3], borderRadius: 3 }
        : { position: want, offset, backgroundColor: 'transparent', padding: 0 } } };
    });
    if (changed) chart.setOption({ series });
  });
}

// Where the "Total …" labels are on screen (client pixels), so the marks' handles can keep clear of them.
let measureCtx = null;
export function totalLabelBoxes() {
  const boxes = [];
  instances.forEach((chart, n) => {
    const items = labelSpecs[n]?.items;
    if (!items?.length) return;
    const dom = chart.getDom().getBoundingClientRect();
    for (const sp of items) {
      const [px, py] = chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: sp.yAxisIndex }, sp.coord) ?? [];
      if (py == null || Number.isNaN(py)) continue;
      const top = (sp.pos === 'bottom' ? py + 4 : py - 4 - LABEL_H) + sp.off;
      boxes.push({ left: dom.left + px - sp.w + sp.offX, right: dom.left + px + sp.offX, top: dom.top + top, bottom: dom.top + top + LABEL_H });
    }
  });
  return boxes;
}

export function setZoom(startMs, endMs) {
  instances[0]?.dispatchAction({ type: 'dataZoom', startValue: startMs, endValue: endMs }); // connected charts follow
}

function fmtVal(v, unit) {
  if (v == null || Number.isNaN(v)) return '–';
  return `${v.toFixed(decimals(unit))} ${unit}`;
}

// Tooltip header for the bar covering [start, end) (wall ms), as precise as the aggregation level.
// A bar still running (current day, week, month…) says up to when it has data.
function fmtHeader(start, end, last, gran) {
  const d = new Date(start);
  const dm = (ms) => { const x = new Date(ms); return `${x.getUTCDate()} ${MO[x.getUTCMonth()]}`; };
  const hh = (ms) => `${pad(new Date(ms).getUTCHours())}:00`;
  const soFar = last < end ? ` <span style="opacity:.7">(so far: until ${dm(last)} ${hh(last)})</span>` : '';
  if (gran === 'year') return `${d.getUTCFullYear()}${soFar}`;
  if (gran === 'month') return `${MO[d.getUTCMonth()]} ${d.getUTCFullYear()}${soFar}`;
  if (gran === 'week') return `${dm(start)} – ${dm(end - DAY)} ${new Date(end - DAY).getUTCFullYear()}${soFar}`;
  if (gran === 'day') return `${fmtWall(start, false)}${soFar}`;
  return `${fmtWall(start, false)} ${hh(start)}–${hh(end)}`;
}

function tooltipLine(color, label, text) {
  return `<div style="display:flex;gap:6px;align-items:center"><span style="width:9px;height:9px;border-radius:50%;background:${color}"></span>${label}: <b>${text}</b></div>`;
}

function describe(key, s, i, gran) {
  const v = VAR_BY_KEY[key];
  if (v.kind === 'code') return wmoLabel(s.val[i]);
  if (v.kind === 'dir') return s.val[i] == null ? '–' : `${Math.round(s.val[i])}° ${compass(s.val[i])}`;
  let t = fmtVal(s.val[i], s.unit);
  if (s.lo?.[i] != null) t += ` <span style="opacity:.75">(likely ${fmtVal(s.lo[i], s.unit)} – ${fmtVal(s.hi[i], s.unit)})</span>`;
  else if (v.kind === 'mean' && gran !== 'hour' && s.min[i] != null) t += ` <span style="opacity:.75">(${fmtVal(s.min[i], s.unit)} – ${fmtVal(s.max[i], s.unit)})</span>`;
  if (s.cum?.[i] != null) {
    t += ` <span style="opacity:.75">· total ${fmtVal(s.cum[i], s.unit)}`;
    if (s.cumLo?.[i] != null) t += ` (${fmtVal(s.cumLo[i], s.unit)} – ${fmtVal(s.cumHi[i], s.unit)})`;
    t += '</span>';
  }
  return t;
}

// ---------- Series and axes ----------

// Series for one variable. axes = {main, cum} y-axis indices.
// endIdx: last bar on screen; the running total shows its value there, in bold.
// totalIdx: the bar whose running total is the value written (its end may be off screen).
function seriesFor(key, s, x, gran, color, axes, theme, endIdx = -1, endX, fc = [], totalIdx = endIdx, stat = null) {
  const v = VAR_BY_KEY[key];
  const light = lighter(color), dark = darker(color, theme);
  const pts = (arr) => x.map((t, i) => [t, arr[i]]);
  // The same values split between past and forecast. Forecast lines start at the last past point.
  const pastPts = (arr) => x.map((t, i) => [t, fc[i] ? null : arr[i]]);
  const fcPts = (arr) => x.map((t, i) => [t, fc[i] ? arr[i] : null]);
  const fcLinePts = (arr) => x.map((t, i) => [t, fc[i] || fc[i + 1] ? arr[i] : null]);
  const out = [];
  // Long series: bars drawn in "large" batch mode, lines thinned to their visible shape (LTTB).
  const many = x.length > 2000;
  const fast = { sampling: 'lttb', progressive: 4000 };
  // Shaded band between lo[] and hi[], as an invisible base and a stacked height. stackStrategy "all"
  // because the default only stacks values of the same sign, which breaks bands crossing zero.
  const band = (name, lo, hi, col, yAxisIndex, opacity, step = false) => {
    const stack = `${name}-${key}`;
    const common = { type: 'line', yAxisIndex, stack, stackStrategy: 'all', showSymbol: false, lineStyle: { opacity: 0 }, silent: true, step };
    out.push({ ...common, name: `${v.label} ${name} base`, data: pts(lo) });
    out.push({ ...common, name: `${v.label} ${name}`, areaStyle: { color: col, opacity },
      data: x.map((t, i) => [t, lo[i] == null || hi[i] == null ? null : hi[i] - lo[i]]) });
  };
  if (v.kind === 'sum') {
    // Stacked on each other (one of the two is always empty) so that they share one bar slot.
    const bars = { type: 'bar', yAxisIndex: axes.main, stack: `bars-${key}`, barMaxWidth: 40, barCategoryGap: '15%', large: many, largeThreshold: 2000 };
    out.push({ ...bars, name: v.label, data: pastPts(s.val), itemStyle: { color } });
    out.push({ ...bars, name: `${v.label} forecast`, data: fcPts(s.val), itemStyle: { color: light } });
    band('likely', s.lo, s.hi, light, axes.main, 0.3, 'middle');
    band('total range', s.cumLo, s.cumHi, dark, axes.cum, 0.12);
    const endVal = endIdx >= 0 ? s.cum[endIdx] : null;
    const totalVal = s.cum[totalIdx], totalLo = s.cumLo[totalIdx];
    // From 1 cm on, millimetres are written as centimetres.
    const inCm = s.unit === 'mm' && totalVal >= 10;
    const unit = inCm ? 'cm' : s.unit, f = inCm ? 0.1 : 1;
    const d = inCm ? (totalVal < 100 ? 2 : totalVal < 1000 ? 1 : 0) : decimals(s.unit);
    const num = (val) => (val * f).toFixed(d);
    const endText = endVal == null ? '' : `Total ${num(totalVal)} ${unit}`
      + (totalLo != null ? ` (${num(totalLo)}–${num(s.cumHi[totalIdx])})` : '')
      + (fc[totalIdx] ? ' incl. forecast' : '');
    // The line goes on to the point, at the end of its last bar (where the end mark sits), not its middle.
    const pastLine = pastPts(s.cum), fcLine = fcLinePts(s.cum);
    if (endVal != null && endX != null && endX > x[endIdx]) (fc[endIdx] ? fcLine : pastLine).splice(endIdx + 1, 0, [endX, endVal]);
    const total = { type: 'line', yAxisIndex: axes.cum, showSymbol: false, ...fast, z: 3, itemStyle: { color: dark } };
    out.push({ ...total, name: `${v.label} – running total forecast`, data: fcLine,
      lineStyle: { color: dark, width: 2, type: 'dotted' } });
    out.push({ ...total, name: `${v.label} – running total`, data: pastLine,
      lineStyle: { color: dark, width: 1.5, type: 'dashed' },
      markPoint: endVal == null ? { data: [] } : {
        symbol: 'circle', symbolSize: 6, silent: true, animation: false, itemStyle: { color: dark },
        // "Total" and the number, in bold, right above the end of the line (no unit, no background).
        // Right-aligned on the point, so it never runs into the axis numbers on the right.
        // (placeTotalLabels moves it below the point, on a background, when there is no room above)
        // In the colour of its own running-total line, so that several totals can be told apart.
        label: { show: true, position: 'top', distance: 4, align: 'right', color: dark, fontWeight: 700, fontSize: TOTAL_FS, fontFamily: bodyFont(), // the font measured by labelWidth
          backgroundColor: 'transparent', padding: 0, offset: [0, 0], // reset on each redraw: placeTotalLabels may have moved it
          formatter: () => endText },
        data: [{ coord: [endX ?? x[endIdx], endVal] }],
      } });
  } else if (v.kind === 'dir' || v.kind === 'code') {
    const dots = { type: 'scatter', yAxisIndex: axes.main, symbolSize: many ? 3 : 6, large: many, largeThreshold: 2000 };
    out.push({ ...dots, name: v.label, data: pastPts(s.val), itemStyle: { color } });
    out.push({ ...dots, name: `${v.label} forecast`, data: fcPts(s.val), itemStyle: { color: light } });
  } else {
    if (gran !== 'hour') {
      // Lowest and highest of each bar; where the forecast has a likely range, that band replaces it.
      const noBand = (arr, future) => arr.map((a, i) => (s.lo[i] == null && !!fc[i] === future ? a : null));
      band('range', noBand(s.min, false), noBand(s.max, false), color, axes.main, 0.18);
      band('forecast range', noBand(s.min, true), noBand(s.max, true), light, axes.main, 0.3);
    }
    band('likely', s.lo, s.hi, light, axes.main, 0.4);
    const line = { type: 'line', yAxisIndex: axes.main, showSymbol: x.length < 60, symbolSize: 4, ...fast, connectNulls: false, itemStyle: { color: dark } };
    out.push({ ...line, name: v.label, data: pastPts(s.val), lineStyle: { color: dark, width: 2 } });
    out.push({ ...line, name: `${v.label} forecast`, data: fcLinePts(s.val), lineStyle: { color: dark, width: 2, type: 'dotted' } });
    // Mean over the range of the marks: a dashed level line between them, its value written at its
    // end like the totals ("Mean 7.4 °C (2.1–12.0)": mean, then lowest and highest bar).
    if (stat && endIdx >= 0) {
      let sum = 0, w = 0, lo = Infinity, hi = -Infinity, withFc = false;
      for (let i = stat.i0; i <= stat.i1; i++) {
        const val = s.val[i];
        if (val == null) continue;
        const h = stat.hours?.[i] || 1;
        sum += val * h; w += h;
        lo = Math.min(lo, val); hi = Math.max(hi, val);
        if (fc[i]) withFc = true;
      }
      if (w) {
        const mean = sum / w, d = decimals(s.unit);
        const text = `Mean ${mean.toFixed(d)} ${s.unit} (${lo.toFixed(d)}–${hi.toFixed(d)})${withFc ? ' incl. forecast' : ''}`;
        const xe = endX ?? x[endIdx];
        out.push({ type: 'line', name: `${v.label} – mean`, yAxisIndex: axes.main, showSymbol: false, silent: true, z: 3,
          data: [[stat.xs, mean], [xe, mean]], lineStyle: { color: dark, width: 1.5, type: 'dashed' },
          markPoint: { symbol: 'circle', symbolSize: 6, silent: true, animation: false, itemStyle: { color: dark },
            label: { show: true, position: 'top', distance: 4, align: 'right', color: dark, fontWeight: 700, fontSize: TOTAL_FS, fontFamily: bodyFont(), // the font measured by labelWidth
              backgroundColor: 'transparent', padding: 0, offset: [0, 0], formatter: () => text },
            data: [{ coord: [xe, mean] }] } });
      }
    }
  }
  return out;
}

// The present on the time axis: a vertical line, and everything after it lightly shaded.
function nowSeries(nowMs, theme) {
  const on = nowMs != null && nowMs < chartRange.max;
  return { name: 'Now', type: 'line', yAxisIndex: 0, data: [], silent: true,
    markLine: { silent: true, symbol: 'none', animation: false, precision: 0,
      lineStyle: { color: theme.text, type: 'solid', width: 2.5, opacity: 0.8 },
      label: { formatter: 'Now', position: 'end', color: theme.text, fontSize: 10, fontWeight: 700 },
      data: on ? [{ xAxis: nowMs }] : [] },
    markArea: { silent: true, animation: false, itemStyle: { color: theme.muted, opacity: 0.08 },
      data: on ? [[{ xAxis: nowMs }, { xAxis: chartRange.max }]] : [] } };
}

// Unit names run vertically along their axis, so the space above the plot stays free for weekdays.
function yAxis(name, unitKind, theme, position, offset, showGrid, gap) {
  const ax = {
    // The unit, written level above the top of the axis, on the side of its numbers: ending at the axis
    // on the left, starting from it on the right.
    // Lined up with the numbers below it: same 5 px from the axis line.
    type: 'value', name, position, offset, nameLocation: 'end', nameGap: 9,
    nameTextStyle: { color: theme.muted, fontSize: 11, fontFamily: bodyFont(), align: position === 'left' ? 'right' : 'left', verticalAlign: 'bottom',
      padding: position === 'left' ? [0, 5, 0, 0] : [0, 0, 0, 5] },
    axisLabel: { color: theme.muted, fontSize: 11 }, splitLine: { show: showGrid, lineStyle: { color: theme.grid } }, scale: unitKind !== 'sum',
  };
  if (unitKind === 'sum') ax.min = 0;
  if (unitKind === 'dir') Object.assign(ax, { min: 0, max: 360, interval: 90, axisLabel: { color: theme.muted, fontSize: 11, formatter: (d) => compass(d) } });
  return ax;
}

// Room for an axis's numbers, estimated from the values it may show (wider than needed rather than
// narrower: the y axis may rescale to the visible part only), then its unit name, then the edge.
function axisRoom(arrs, sc, kind, fs, name = '') {
  let lo = Infinity, hi = -Infinity;
  for (const a of arrs) for (const v of a ?? []) if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (sc) { lo = Math.min(lo, sc.min); hi = Math.max(hi, sc.max); }
  let chars = 3;
  if (kind === 'dir') chars = 2;
  else if (hi >= lo) {
    chars = String(Math.round(Math.max(Math.abs(lo), Math.abs(hi)) * 1.2)).length + (lo < 0 ? 1 : 0);
    if (hi - lo < 3) chars = Math.max(chars + 2, 3); // ticks like 0.5
  }
  // The widest number, measured in the font ECharts draws it with (digits all have the same width),
  // then 5 px to the axis line: the side holds just that, plus 2 px to the edge of the chart.
  // Always room for at least 3 digits, so that the plot does not move sideways when the numbers
  // change from 1 or 2 digits to 3 as the view moves (more only for values that need them, like 1013 hPa).
  chars = Math.max(chars, 3);
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = `${fs}px ${bodyFont()}`;
  const gap = Math.ceil(measureCtx.measureText('8'.repeat(chars)).width) + 5;
  return { gap, side: gap + 2 };
}

// Separate charts: the units above the y axes, set against the edges of the chart (left one from
// the left edge, right one up to the right edge), 9 px above the top of the plot.
const UNIT_GAP = 9;
function unitTexts(left, right, theme, top) {
  const t = (id, text, side) => ({ type: 'text', id, [side]: 2, top: top - UNIT_GAP - 11, silent: true,
    style: { text, fill: theme.muted, font: `11px ${bodyFont()}` } });
  return [t('unit-l', left, 'left'), t('unit-r', right || '', 'right')];
}

// Fixed y range (from the app's reference percentiles), or back to automatic when there is none.
// null is passed explicitly so that an in-place update also clears a previous fixed range.
function applyScale(ax, kind, sc) {
  if (kind === 'dir') return ax;
  ax.min = sc ? sc.min : (kind === 'sum' ? 0 : null);
  ax.max = sc ? sc.max : null;
  if (sc) ax.scale = false;
  return ax;
}

function baseOption(gran, theme, tooltipFmt, gridRight, gridLeft, zoom) {
  const step = STEP_MS[gran];
  const { min, max } = chartRange;
  const win = zoom ? { startValue: Math.max(min, zoom.startMs), endValue: Math.min(max, zoom.endMs) } : {};
  // Bars just outside the window are dropped: ECharts does not reliably clip them at the plot edge
  // with several x axes, and they would spill over the axis labels.
  const filterMode = 'filter';
  return {
    useUTC: true, // x values are wall-clock times of the location, encoded as UTC
    animation: false,
    textStyle: { color: theme.text },
    grid: { left: gridLeft, right: gridRight, top: topShown ? GRID_TOP.on : GRID_TOP.off, bottom: 28 },
    tooltip: {
      // On touch screens the box takes taps, so that tapping it closes it (see closeTipOnTap).
      trigger: 'axis', confine: true, triggerOn: 'mousemove|click', enterable: IS_TOUCH,
      backgroundColor: theme.card, borderColor: theme.line, textStyle: { color: theme.text, fontSize: 12 },
      axisPointer: { type: 'line', lineStyle: { color: theme.muted }, label: { show: false } },
      formatter: tooltipFmt,
    },
    xAxis: xAxes(theme, gran),
    dataZoom: [
      // Touch screens: built-in drag/pinch off; one finger shows values, two fingers pan/zoom (attachTouch).
      { type: 'inside', id: 'dz-in', xAxisIndex: [0, 1, 2, 3], filterMode, disabled: IS_TOUCH, zoomOnMouseWheel: true, moveOnMouseMove: true,
        minValueSpan: 3 * 3600e3, ...win }, // the same for every aggregation level, so changing it never moves the view
    ],
  };
}

// ---------- Image export ----------

/**
 * The charts on screen as one image: a heading, then each chart under its coloured titles (hidden
 * variables left out), the marks of the totals, and the data credit at the bottom.
 * format: 'png' | 'jpg' | 'svg'. o: { heading, credit, marks: [startMs, endMs] | null, filename }.
 */
export async function exportCharts(container, format, o) {
  const theme = themeColors(), bg = theme.card, accent = css('--accent');
  const font = getComputedStyle(document.body).fontFamily;
  const blocks = [];
  let titles = [];
  for (const el of container.children) {
    if (el.classList.contains('chart-title')) {
      if (!el.classList.contains('is-hidden')) titles.push({ name: el.querySelector('.name').textContent, color: el.querySelector('.dot').style.background });
    } else if (el.classList.contains('chart')) {
      const chart = echarts.getInstanceByDom(el);
      // The chart's own size (its pixels), which may lag behind the page's after a layout change.
      if (chart) blocks.push({ titles, chart, w: chart.getWidth(), h: chart.getHeight() });
      titles = [];
    }
  }
  if (!blocks.length) return;
  const W = Math.max(...blocks.map((b) => b.w));
  const PAD = 10, ROW = 20, FOOT = 22;
  // Everything is laid out once, measured, so that no text runs out of the image: the heading
  // shrinks (down to 10 px) or goes on two lines, the titles wrap onto several rows, and so does
  // the credit if it must.
  measureCtx ??= document.createElement('canvas').getContext('2d');
  const textW = (s, f) => { measureCtx.font = f; return measureCtx.measureText(s).width; };
  const fit = (s, weight, size, min) => {
    let px = size;
    while (px > min && textW(s, `${weight} ${px}px ${font}`) > W - 2 * PAD) px -= 0.5;
    return px;
  };
  const texts = []; // { s, x, y, px, weight, color, anchor }
  let y = 0;
  const headFull = fit(o.heading, 700, 14, 13);
  if (textW(o.heading, `700 ${headFull}px ${font}`) <= W - 2 * PAD) {
    y += 20; texts.push({ s: o.heading, x: PAD, y, px: headFull, weight: 700, color: theme.text });
  } else {
    const cut = o.heading.indexOf(' · ');
    const lines = cut > 0 ? [o.heading.slice(0, cut), o.heading.slice(cut + 3)] : [o.heading];
    for (const s of lines) { y += 18; texts.push({ s, x: PAD, y, px: fit(s, 700, 14, 10), weight: 700, color: theme.text }); }
  }
  y += 8;
  const dots = []; // { x, y, color }
  for (const b of blocks) {
    if (b.titles.length) {
      let x = PAD, rowY = y + 15;
      for (const t of b.titles) {
        const px = fit(t.name, 600, 13, 10), w = 14 + textW(t.name, `600 ${px}px ${font}`);
        if (x > PAD && x + w > W - PAD) { x = PAD; rowY += ROW; }
        dots.push({ x: x + 4.5, y: rowY - 4, color: t.color });
        texts.push({ s: t.name, x: x + 14, y: rowY, px, weight: 600, color: theme.text });
        x += w + 16;
      }
      y = rowY + 7;
    } else y += 4;
    b.y = y;
    y += b.h;
  }
  const credit = textW(o.credit, `11px ${font}`) <= W - 2 * PAD ? [o.credit] : o.credit.split(' · ');
  for (const s of credit) { y += 15; texts.push({ s, x: W - PAD, y, px: 11, weight: 400, color: theme.muted, anchor: 'end' }); }
  const H = y + 8;
  // Marks: x on each chart, and the top and bottom of its plot.
  for (const b of blocks) {
    const rect = b.chart.getModel().getComponent('grid')?.coordinateSystem?.getRect();
    b.marks = !o.marks || !rect ? [] : o.marks.map((t) => b.chart.convertToPixel({ xAxisIndex: 0 }, t))
      .filter((x) => x >= rect.x - 1 && x <= rect.x + rect.width + 1).map((x) => ({ x, y0: rect.y, y1: rect.y + rect.height }));
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let blob;
  if (format === 'svg') {
    const parts = [`<rect width="${W}" height="${H}" fill="${bg}"/>`];
    for (const d of dots) parts.push(`<circle cx="${d.x}" cy="${d.y}" r="4.5" fill="${d.color}"/>`);
    for (const t of texts) {
      parts.push(`<text x="${t.x}" y="${t.y}"${t.anchor ? ` text-anchor="${t.anchor}"` : ''} font-family="${esc(font)}" font-size="${t.px}" font-weight="${t.weight}" fill="${t.color}">${esc(t.s)}</text>`);
    }
    for (const b of blocks) {
      // The same chart drawn again by ECharts as SVG, off screen, at the same size.
      const div = document.createElement('div');
      div.style.cssText = `position:fixed;left:-10000px;top:0;width:${b.w}px;height:${b.h}px`;
      document.body.append(div);
      const inst = echarts.init(div, null, { renderer: 'svg', width: b.w, height: b.h });
      inst.setOption({ ...b.chart.getOption(), animation: false });
      const svg = inst.renderToSVGString().replace(/^<\?xml[^>]*>/, '');
      inst.dispose(); div.remove();
      parts.push(`<g transform="translate(0,${b.y})">${svg}</g>`);
      for (const m of b.marks) parts.push(`<line x1="${m.x}" x2="${m.x}" y1="${b.y + m.y0}" y2="${b.y + m.y1}" stroke="${accent}" stroke-width="2"/>`);
    }
    blob = new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`], { type: 'image/svg+xml' });
  } else {
    const R = 2; // twice the screen resolution
    const cv = document.createElement('canvas');
    cv.width = W * R; cv.height = H * R;
    const ctx = cv.getContext('2d');
    ctx.scale(R, R);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    for (const b of blocks) {
      const img = new Image();
      img.src = b.chart.getDataURL({ type: 'png', pixelRatio: R, backgroundColor: bg });
      await img.decode();
      ctx.drawImage(img, 0, b.y, b.w, b.h);
      ctx.strokeStyle = accent; ctx.lineWidth = 2;
      for (const m of b.marks) { ctx.beginPath(); ctx.moveTo(m.x, b.y + m.y0); ctx.lineTo(m.x, b.y + m.y1); ctx.stroke(); }
    }
    for (const d of dots) { ctx.fillStyle = d.color; ctx.beginPath(); ctx.arc(d.x, d.y, 4.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.textBaseline = 'alphabetic';
    for (const t of texts) {
      ctx.font = `${t.weight} ${t.px}px ${font}`; ctx.fillStyle = t.color; ctx.textAlign = t.anchor === 'end' ? 'right' : 'left';
      ctx.fillText(t.s, t.x, t.y);
    }
    blob = await new Promise((res) => cv.toBlob(res, format === 'jpg' ? 'image/jpeg' : 'image/png', 0.92));
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${o.filename}.${format}`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function themeColors() {
  return { text: css('--text'), muted: css('--muted'), line: css('--line'), grid: css('--chart-grid'), major: css('--chart-major'), card: css('--card'),
    dark: parseInt(css('--card').slice(1, 3), 16) < 128 };
}

/**
 * An empty chart over opts.range (same time axes, zoom and gestures as a real one) with a message in
 * the middle — used when no variable is selected.
 */
export function renderEmpty(container, gran, message, opts = {}) {
  const theme = themeColors();
  Object.assign(chartRange, opts.range, { minSpan: 3 * 3600e3 });
  const zoom = opts.zoom;
  const span = zoom ? zoom.endMs - zoom.startMs : chartRange.max - chartRange.min;
  if (!instances.length) plotWidth = Math.max(120, container.clientWidth - 112);
  tickUnit = unitFor(span);
  labelSig = ''; // the axes are set anew below
  topShown = topFor(span);
  view.s = zoom ? Math.max(chartRange.min, zoom.startMs) : chartRange.min;
  view.e = zoom ? Math.min(chartRange.max, zoom.endMs) : chartRange.max;
  const opt = baseOption(gran, theme, () => '', 56, 56, zoom);
  opt.tooltip.show = false;
  opt.yAxis = [{ type: 'value', min: 0, max: 1, axisLabel: { show: false }, splitLine: { lineStyle: { color: theme.grid } } }];
  opt.series = [];
  opt.graphic = [{ type: 'text', left: 'center', top: 'middle', silent: true,
    style: { text: message, fill: theme.muted, fontSize: 14, textAlign: 'center', lineHeight: 20 } }];

  const sig = `empty|${gran}|${theme.text}`;
  if (current && current.sig === sig && instances.length === 1) {
    instances[0].setOption(opt);
    measurePlot();
    return;
  }
  disposeCharts();
  container.innerHTML = '';
  container.style.setProperty('--n', 1);
  const el = document.createElement('div');
  el.className = 'chart first last';
  container.append(el);
  const chart = echarts.init(el, null, { renderer: 'canvas' });
  chart.setOption(opt);
  chart.on('datazoom', () => {
    const { min, max } = chartRange;
    const dz = zoomPct(chart);
    const startMs = min + (dz.start / 100) * (max - min), endMs = min + (dz.end / 100) * (max - min);
    refreshLabels(chart, startMs, endMs, gran, theme);
    opts.onZoom?.({ startMs, endMs });
  });
  if (IS_TOUCH) attachTouch(chart, el);
  instances.push(chart);
  current = { sig, titleEls: {}, gran, theme };
  measurePlot();
}

/**
 * agg: result of aggregate(); keys: variables; gran: 'hour'|'day'|'month'|'year'; mode: 'stacked'|'combined'.
 * opts.range: {min, max} x range (wall ms), defaults to the data extent;
 * opts.zoom: {startMs, endMs} visible window (wall ms);
 * opts.nowMs: the present (wall ms), marked on the axis when the future is on it;
 * opts.onZoom({startMs, endMs}) is called after the user zooms or pans.
 */
export function renderCharts(container, agg, keys, gran, mode, opts = {}) {
  if (!agg.x.length) { disposeCharts(); container.innerHTML = ''; return; }
  const theme = themeColors();
  const { x, hours, series } = agg;
  // keys: the variables drawn; opts.allKeys: all the selected ones, hidden ones included (their title
  // stays, to show them again). Colours follow the full list, so hiding one changes no colour.
  const allKeys = opts.allKeys || keys;
  const color = (k) => colorFor(allKeys, k);
  const step = STEP_MS[gran];
  const range = opts.range || { min: agg.start[0], max: agg.end[agg.end.length - 1] };
  Object.assign(chartRange, range, { minSpan: 3 * 3600e3 });
  const zoom = opts.zoom;
  const span = zoom ? zoom.endMs - zoom.startMs : range.max - range.min;
  // Last bar on screen (chosen by the app, same bars as the title text): the running total's value
  // is written there.
  const endIdx = opts.endIdx ?? -1, totalIdx = opts.totalIdx ?? endIdx;
  // Bars of the range of the marks (for the means of the variables that are not added up).
  const stat = opts.statRange ? { ...opts.statRange, xs: agg.start[opts.statRange.i0], hours } : null;
  if (!instances.length) plotWidth = Math.max(120, container.clientWidth - (mode === 'combined' ? 140 : 112)); // first guess
  tickUnit = unitFor(span);
  labelSig = ''; // the axes are set anew below
  topShown = topFor(span);
  view.s = zoom ? Math.max(range.min, zoom.startMs) : range.min;
  view.e = zoom ? Math.min(range.max, zoom.endMs) : range.max;

  const makeTooltip = (ks) => (params) => {
    const i = params[0]?.dataIndex;
    if (i == null) return '';
    const tag = agg.fc?.[i] ? ' <b>· forecast</b>' : '';
    return `<div style="margin-bottom:4px">${fmtHeader(agg.start[i], agg.end[i], agg.last[i], gran)}${tag}</div>` +
      ks.map((k) => tooltipLine(agg.fc?.[i] ? lighter(color(k)) : color(k), VAR_BY_KEY[k].label, describe(k, series[k], i, gran))).join('');
  };

  // Options for every chart, in display order.
  const narrow = container.clientWidth < 600;
  const charts = [];
  if (mode === 'combined') {
    // One y axis per unit (+ one per unit for running totals), alternating left/right, all labelled
    // and coloured like their variable.
    const fs = narrow ? 10 : 11;
    const axes = [];
    const axisIdx = (id, name, kind, col, arrs) => {
      let i = axes.findIndex((a) => a.id === id);
      if (i < 0) {
        const side = axes.length % 2 === 0 ? 'left' : 'right';
        const ax = yAxis(name, kind, theme, side, 0, axes.length === 0, 0);
        ax.axisLine = { show: true, lineStyle: { color: col } };
        ax.axisLabel = { ...ax.axisLabel, color: col, fontSize: fs, fontFamily: bodyFont(), margin: 4 };
        ax.nameTextStyle = { ...ax.nameTextStyle, color: col, fontSize: fs, padding: side === 'left' ? [0, 4, 0, 0] : [0, 0, 0, 4] };
        axes.push({ id, ...ax, arrs: [], axKind: kind });
        i = axes.length - 1;
      }
      axes[i].arrs.push(...arrs); // every variable on this axis counts for its width
      return i;
    };
    const all = [];
    for (const k of keys) {
      const v = VAR_BY_KEY[k];
      const s = series[k];
      const unitName = v.kind === 'code' ? 'WMO' : s.unit;
      const main = axisIdx(`${v.kind === 'dir' ? 'dir' : unitName}`, unitName, v.kind, color(k), [s.val, s.lo, s.hi, s.min, s.max]);
      const cum = s.cum ? axisIdx(`${unitName}-cum`, `Σ ${unitName}`, 'sum', theme.muted, [s.cum, s.cumLo, s.cumHi]) : 0;
      all.push(...seriesFor(k, s, x, gran, color(k), { main, cum }, theme, endIdx, opts.endX, agg.fc, totalIdx, stat));
      // Variables sharing a unit share an axis: its fixed range must hold all of them.
      const sc = opts.yScale?.[k];
      if (sc && v.kind !== 'dir') {
        const ax = axes[main];
        ax.fixed = ax.fixed ? { min: Math.min(ax.fixed.min, sc.min), max: Math.max(ax.fixed.max, sc.max) } : { ...sc };
        ax.kind = v.kind;
      }
    }
    // Each axis only as wide as its own numbers (or its unit, written above them, if wider), the
    // axes of a side set one after the other from the plot outwards, 2 px from the edge.
    measureCtx ??= document.createElement('canvas').getContext('2d');
    measureCtx.font = `${fs}px ${bodyFont()}`;
    const used = { left: 0, right: 0 };
    for (const a of axes) {
      const nums = axisRoom(a.arrs, a.fixed, a.axKind, fs).gap;
      a.w = Math.max(nums, Math.ceil(measureCtx.measureText(a.name).width) + 4) + 4;
      a.offset = used[a.position];
      used[a.position] += a.w;
    }
    const gridLeft = used.left + 2, gridRight = Math.max(used.right, 8) + 2;
    const opt = baseOption(gran, theme, makeTooltip(keys), gridRight, gridLeft, zoom);
    // Units above the axes, each against the outer edge of its own column (left edge on the left,
    // right edge on the right), 9 px above the top of the plot.
    const unitTop = opt.grid.top - UNIT_GAP - 11;
    opt.graphic = axes.map((a, i) => ({ type: 'text', id: `unit-${i}`, silent: true, top: unitTop,
      [a.position]: (a.position === 'left' ? gridLeft : gridRight) - a.offset - a.w + 2,
      style: { text: a.name, fill: a.nameTextStyle.color, font: `${fs}px ${bodyFont()}` } }));
    opt.yAxis = axes.map(({ id, fixed, kind, arrs, axKind, w, ...a }) => ({ ...(kind ? applyScale(a, kind, fixed) : a), name: '' }));
    opt.series = [...all, nowSeries(opts.nowMs, theme)]; // no legend: the coloured titles above the chart play that role
    charts.push({ opt, cls: 'chart combined first' });
  } else {
    keys.forEach((k, n) => {
      const v = VAR_BY_KEY[k];
      const s = series[k];
      const unitName = v.kind === 'code' ? 'WMO' : s.unit;
      // Each side only as wide as its numbers need, so the plot gets the rest.
      const fs = narrow ? 10 : 11;
      const left = axisRoom([s.val, s.lo, s.hi, s.min, s.max], opts.yScale?.[k], v.kind, fs, unitName);
      // No running total until its range is set: its axis is then hidden too.
      const hasCum = s.cum?.some((c) => c != null);
      const right = hasCum ? axisRoom([s.cum, s.cumLo, s.cumHi], null, 'sum', fs, `Σ ${s.unit}`) : { side: 10 };
      const yAxes = [yAxis(unitName, v.kind, theme, 'left', 0, true, left.gap)];
      applyScale(yAxes[0], v.kind, opts.yScale?.[k]);
      if (s.cum) yAxes.push({ ...yAxis(`Σ ${s.unit}`, 'sum', theme, 'right', 0, false, right.gap ?? 0), show: hasCum });
      for (const ax of yAxes) {
        ax.axisLabel = { ...ax.axisLabel, fontSize: fs, fontFamily: bodyFont(), margin: 5 };
        ax.name = ''; // written by unitTexts instead, against the edges
      }
      const opt = baseOption(gran, theme, makeTooltip([k]), right.side, left.side, zoom);
      opt.yAxis = yAxes;
      opt.graphic = unitTexts(unitName, hasCum ? `Σ ${s.unit}` : '', theme, opt.grid.top);
      opt.series = [...seriesFor(k, s, x, gran, color(k), { main: 0, cum: 1 }, theme, endIdx, opts.endX, agg.fc, totalIdx, stat), nowSeries(opts.nowMs, theme)];
      charts.push({ opt, cls: 'chart' + (n === 0 ? ' first' : '') + (n === keys.length - 1 ? ' last' : '') });
    });
  }

  // These options carry the ticks of the current view: no need to set them again afterwards.
  if (charts.length) labelSig = axesSig(charts[0].opt.xAxis);
  // Same layout as now: update in place, so the screen does not flash.
  const sig = [mode, gran, keys.join(','), allKeys.join(','), narrow, theme.text].join('|');
  // After drawing: measure the real plot width and re-space the labels if the estimate was off.
  const fitLabels = () => {
    measurePlot();
    if (unitFor(view.e - view.s) !== tickUnit) refreshLabels(null, view.s, view.e, gran, theme);
  };
  if (current && current.sig === sig && instances.length === charts.length) {
    charts.forEach((c, i) => instances[i].setOption(c.opt));
    noteLabels(charts);
    fitLabels();
    placeTotalLabels();
    return;
  }

  disposeCharts();
  container.innerHTML = '';
  container.style.setProperty('--n', keys.length); // used by full-screen sizing
  const titleEls = {};
  closeTipOnTap(container);
  const listen = (chart) => {
    chart.on('datazoom', () => {
      const { min, max } = chartRange;
      const dz = zoomPct(chart);
      const startMs = min + (dz.start / 100) * (max - min);
      const endMs = min + (dz.end / 100) * (max - min);
      refreshLabels(chart, startMs, endMs, gran, theme);
      opts.onZoom?.({ startMs, endMs });
    });
  };
  const tools = allKeys.length > 1;
  const addTitle = (k) => {
    titleEls[k] = titleEl(k, color(k), { tools, hidden: !keys.includes(k), lastShown: keys.length === 1 && keys[0] === k });
    container.append(titleEls[k]);
  };
  // Combined: every title above the one chart. Separate: each title above its chart, a hidden
  // variable keeping only its title, in the order of the list.
  if (mode === 'combined') allKeys.forEach(addTitle);
  let next = 0;
  charts.forEach((c, n) => {
    if (mode !== 'combined') {
      const k = keys[n];
      while (next < allKeys.length && allKeys[next] !== k) addTitle(allKeys[next++]);
      addTitle(allKeys[next++]);
    }
    const el = document.createElement('div');
    el.className = c.cls;
    container.append(el);
    const chart = echarts.init(el, null, { renderer: 'canvas' });
    chart.setOption(c.opt);
    if (n === 0) listen(chart); // connected charts zoom together; one listener is enough
    if (IS_TOUCH) attachTouch(chart, el);
    if (mode !== 'combined') chart.group = GROUP;
    instances.push(chart);
  });
  if (mode !== 'combined') while (next < allKeys.length) addTitle(allKeys[next++]); // hidden ones at the end
  if (mode !== 'combined') echarts.connect(GROUP);
  current = { sig, titleEls, gran, theme };
  noteLabels(charts);
  fitLabels();
  placeTotalLabels();
}
