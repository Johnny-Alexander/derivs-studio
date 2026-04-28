// charts.js — small SVG chart primitives with hover.
// Reusable across product UIs.

const SVG_NS = 'http://www.w3.org/2000/svg';

export function el(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

export function linear(domain, range) {
  const [d0, d1] = domain, [r0, r1] = range;
  const k = (r1 - r0) / ((d1 - d0) || 1);
  return v => r0 + (v - d0) * k;
}

export function niceTicks(min, max, count = 5) {
  if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
  if (min === max) { min -= 1; max += 1; }
  const range = max - min;
  const step0 = range / count;
  if (!isFinite(step0) || step0 <= 0) return [min, max];
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  let step;
  if (norm < 1.5) step = 1 * mag;
  else if (norm < 3) step = 2 * mag;
  else if (norm < 7) step = 5 * mag;
  else step = 10 * mag;
  if (!isFinite(step) || step <= 0) return [min, max];
  const ticks = [];
  const start = Math.ceil(min / step) * step;
  // Hard cap on iterations: guards against subnormal ranges where `v += step`
  // can't advance `v` in IEEE-754, which would otherwise spin until V8 throws
  // RangeError on the growing array. count*4+4 is more than any sane axis.
  const maxTicks = count * 4 + 4;
  let v = start;
  for (let i = 0; i < maxTicks && v <= max + 1e-9; i++, v += step) {
    ticks.push(+v.toFixed(10));
  }
  return ticks;
}

export function fmtAxisMoney(v) {
  const abs = Math.abs(v);
  if (abs >= 1000) return (v / 1000).toFixed(1) + 'k';
  if (abs >= 10)   return v.toFixed(0);
  if (abs >= 1)    return v.toFixed(1);
  if (abs >= 0.01) return v.toFixed(2);
  return v.toExponential(1);
}
export function fmtPct(v, digits = 1) { return (v * 100).toFixed(digits) + '%'; }

export function buildPath(xs, ys, sx, sy) {
  let d = '';
  for (let i = 0; i < xs.length; i++) {
    d += (i === 0 ? 'M' : 'L') + sx(xs[i]).toFixed(2) + ',' + sy(ys[i]).toFixed(2) + ' ';
  }
  return d;
}
export function buildArea(xs, ys, sx, sy, zeroY) {
  let d = 'M' + sx(xs[0]).toFixed(2) + ',' + zeroY.toFixed(2) + ' ';
  for (let i = 0; i < xs.length; i++) {
    d += 'L' + sx(xs[i]).toFixed(2) + ',' + sy(ys[i]).toFixed(2) + ' ';
  }
  d += 'L' + sx(xs[xs.length - 1]).toFixed(2) + ',' + zeroY.toFixed(2) + ' Z';
  return d;
}

// Draw a line chart with multiple series + optional hover tooltip.
//  svgEl: <svg> element to render into (cleared first)
//  tipEl: tooltip DIV (positioned absolute within the same parent)
//  cfg: {
//    xs: array of x values,
//    series: [{ label, ys, color, type: 'line' | 'dashed' | 'area' | 'area-signed' }],
//    xLabel?, yLabel?,
//    verticals?: [{ x, color, label }],
//    markers?: [{ x, y, color, label }],
//    xFormat?, yFormat?,
//    tooltip?: (idx, xs, series) => string (HTML)
//  }
export function drawLineChart(svgEl, tipEl, cfg) {
  svgEl.innerHTML = '';
  const xs = cfg.xs;
  if (!xs || xs.length < 2) return;
  const W = svgEl.clientWidth || 800;
  const H = svgEl.clientHeight || 320;
  const m = { l: 54, r: 16, t: 16, b: 28 };

  const xmin = xs[0], xmax = xs[xs.length - 1];
  let ymin = Infinity, ymax = -Infinity;
  for (const s of cfg.series) {
    for (const y of s.ys) {
      if (!isFinite(y)) continue;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
  }
  if (!isFinite(ymin) || !isFinite(ymax)) { ymin = -1; ymax = 1; }
  // Treat subnormal ranges as "flat": delta ~1e-246 for deep-OTM digitals would
  // otherwise produce a tick step too small to advance in float64.
  if (ymax - ymin < 1e-12) { const mid = (ymin + ymax) / 2; ymin = mid - 1; ymax = mid + 1; }
  const pad = (ymax - ymin) * 0.1 || 1;
  ymin -= pad; ymax += pad;
  if (cfg.zeroAnchor !== false && ymin > 0 && cfg.includeZero !== false) ymin = Math.min(ymin, -pad * 0.2);
  if (cfg.zeroAnchor !== false && ymax < 0 && cfg.includeZero !== false) ymax = Math.max(ymax, pad * 0.2);

  const sx = linear([xmin, xmax], [m.l, W - m.r]);
  const sy = linear([ymin, ymax], [H - m.b, m.t]);

  // defs + clips for signed areas
  const defs = el('defs', {});
  defs.innerHTML = `
    <linearGradient id="chGradPos" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#34d399" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#34d399" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="chGradNeg" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0%" stop-color="#fb7185" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#fb7185" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="chPosClip"><rect x="0" y="${m.t}" width="${W}" height="${Math.max(0, sy(0) - m.t)}"/></clipPath>
    <clipPath id="chNegClip"><rect x="0" y="${sy(0)}" width="${W}" height="${Math.max(0, H - m.b - sy(0))}"/></clipPath>
  `;
  svgEl.appendChild(defs);

  // gridlines
  const yTicks = niceTicks(ymin, ymax, 5);
  const xTicks = niceTicks(xmin, xmax, 6);
  const yFmt = cfg.yFormat || fmtAxisMoney;
  const xFmt = cfg.xFormat || (v => (v >= 100 ? v.toFixed(0) : v.toFixed(1)));

  yTicks.forEach(t => {
    const y = sy(t);
    svgEl.appendChild(el('line', {
      x1: m.l, x2: W - m.r, y1: y, y2: y,
      stroke: Math.abs(t) < 1e-9 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.05)',
      'stroke-dasharray': Math.abs(t) < 1e-9 ? '0' : '3 4'
    }));
    const lbl = el('text', { x: m.l - 8, y: y + 3.5, 'text-anchor': 'end',
      fill: '#8d94ad', 'font-size': 10, 'font-family': 'SF Mono, monospace' });
    lbl.textContent = yFmt(t);
    svgEl.appendChild(lbl);
  });
  xTicks.forEach(t => {
    const x = sx(t);
    const lbl = el('text', { x, y: H - m.b + 16, 'text-anchor': 'middle',
      fill: '#8d94ad', 'font-size': 10, 'font-family': 'SF Mono, monospace' });
    lbl.textContent = xFmt(t);
    svgEl.appendChild(lbl);
  });

  if (cfg.verticals) {
    for (const v of cfg.verticals) {
      const x = sx(v.x);
      if (x < m.l || x > W - m.r) continue;
      svgEl.appendChild(el('line', {
        x1: x, x2: x, y1: m.t, y2: H - m.b,
        stroke: v.color || 'rgba(125,211,252,0.4)', 'stroke-dasharray': '4 4'
      }));
      if (v.label) {
        const t = el('text', { x: x + 5, y: m.t + 12, fill: v.color || '#7dd3fc',
          'font-size': 10, 'font-family': 'SF Mono, monospace' });
        t.textContent = v.label;
        svgEl.appendChild(t);
      }
    }
  }

  // render each series
  const seriesPaths = [];
  cfg.series.forEach((s, idx) => {
    if (s.type === 'area-signed') {
      const d = buildArea(xs, s.ys, sx, sy, sy(0));
      svgEl.appendChild(el('path', { d, fill: 'url(#chGradPos)', 'clip-path': 'url(#chPosClip)' }));
      svgEl.appendChild(el('path', { d, fill: 'url(#chGradNeg)', 'clip-path': 'url(#chNegClip)' }));
    } else if (s.type === 'area') {
      const d = buildArea(xs, s.ys, sx, sy, sy(ymin));
      const p = el('path', { d, fill: s.fill || s.color, opacity: s.fillOpacity ?? 0.2 });
      svgEl.appendChild(p);
    }
    if (s.type !== 'area') {
      const d = buildPath(xs, s.ys, sx, sy);
      const attrs = { d, fill: 'none', stroke: s.color, 'stroke-width': s.width || 2.2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round' };
      if (s.type === 'dashed') attrs['stroke-dasharray'] = '5 4';
      const p = el('path', attrs);
      svgEl.appendChild(p);
      seriesPaths.push(p);
    }
  });

  if (cfg.markers) {
    for (const mk of cfg.markers) {
      const cx = sx(mk.x), cy = sy(mk.y);
      svgEl.appendChild(el('circle', { cx, cy, r: 4, fill: mk.color, stroke: '#07080f', 'stroke-width': 1.5 }));
      if (mk.label) {
        const t = el('text', { x: cx, y: cy - 8, 'text-anchor': 'middle', fill: mk.color,
          'font-size': 10, 'font-family': 'SF Mono, monospace' });
        t.textContent = mk.label;
        svgEl.appendChild(t);
      }
    }
  }

  // hover
  if (tipEl) {
    const hover = el('line', { y1: m.t, y2: H - m.b, stroke: 'rgba(255,255,255,0.25)', visibility: 'hidden' });
    const dots = cfg.series.filter(s => s.type !== 'area').map(s =>
      el('circle', { r: 4, fill: s.color, stroke: '#07080f', 'stroke-width': 1.5, visibility: 'hidden' }));
    svgEl.appendChild(hover);
    dots.forEach(d => svgEl.appendChild(d));
    const overlay = el('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' });
    svgEl.appendChild(overlay);
    overlay.addEventListener('mousemove', (ev) => {
      const rect = svgEl.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const t = (mx - m.l) / (W - m.l - m.r);
      const idx = Math.max(0, Math.min(xs.length - 1, Math.round(t * (xs.length - 1))));
      const x = sx(xs[idx]);
      hover.setAttribute('x1', x); hover.setAttribute('x2', x);
      hover.setAttribute('visibility', 'visible');
      const drawableSeries = cfg.series.filter(s => s.type !== 'area');
      drawableSeries.forEach((s, i) => {
        dots[i].setAttribute('cx', x);
        dots[i].setAttribute('cy', sy(s.ys[idx]));
        dots[i].setAttribute('visibility', 'visible');
      });
      const html = cfg.tooltip ? cfg.tooltip(idx, xs, cfg.series) :
        `<div class="row"><span>x</span><span>${xFmt(xs[idx])}</span></div>` +
        drawableSeries.map(s => `<div class="row"><span style="color:${s.color}">${s.label}</span><span>${yFmt(s.ys[idx])}</span></div>`).join('');
      tipEl.innerHTML = html;
      tipEl.style.display = 'block';
      tipEl.style.left = x + 'px';
      tipEl.style.top = Math.min(...drawableSeries.map(s => sy(s.ys[idx]))) + 'px';
    });
    overlay.addEventListener('mouseleave', () => {
      hover.setAttribute('visibility', 'hidden');
      dots.forEach(d => d.setAttribute('visibility', 'hidden'));
      tipEl.style.display = 'none';
    });
  }

  return { W, H, m, sx, sy, xmin, xmax, ymin, ymax };
}

// Draw vertical bars — used for autocall probabilities per observation date.
export function drawBarChart(svgEl, tipEl, cfg) {
  svgEl.innerHTML = '';
  const labels = cfg.labels;
  const values = cfg.values;
  const colors = cfg.colors || labels.map(() => cfg.color || '#7dd3fc');
  if (!labels || !labels.length) return;
  const W = svgEl.clientWidth || 800;
  const H = svgEl.clientHeight || 260;
  const m = { l: 46, r: 16, t: 14, b: 28 };

  const ymax = Math.max(0.05, ...values) * 1.2;
  const sy = linear([0, ymax], [H - m.b, m.t]);

  const yTicks = niceTicks(0, ymax, 4);
  const yFmt = cfg.yFormat || (v => (v * 100).toFixed(0) + '%');
  yTicks.forEach(t => {
    const y = sy(t);
    svgEl.appendChild(el('line', { x1: m.l, x2: W - m.r, y1: y, y2: y,
      stroke: t === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.05)',
      'stroke-dasharray': t === 0 ? '0' : '3 4' }));
    const lbl = el('text', { x: m.l - 8, y: y + 3.5, 'text-anchor': 'end',
      fill: '#8d94ad', 'font-size': 10, 'font-family': 'SF Mono, monospace' });
    lbl.textContent = yFmt(t);
    svgEl.appendChild(lbl);
  });

  const n = labels.length;
  const cellW = (W - m.l - m.r) / n;
  const barW = Math.max(2, Math.min(32, cellW * 0.6));

  labels.forEach((label, i) => {
    const cx = m.l + cellW * (i + 0.5);
    const v = values[i];
    const y = sy(v);
    const h = sy(0) - y;
    svgEl.appendChild(el('rect', {
      x: cx - barW / 2, y, width: barW, height: Math.max(0, h),
      fill: colors[i], rx: 3, opacity: 0.9
    }));
    // x labels: show every k-th to avoid crowding
    const skip = Math.ceil(n / 10);
    if (i % skip === 0 || i === n - 1) {
      const lbl = el('text', { x: cx, y: H - m.b + 16, 'text-anchor': 'middle',
        fill: '#8d94ad', 'font-size': 10, 'font-family': 'SF Mono, monospace' });
      lbl.textContent = label;
      svgEl.appendChild(lbl);
    }
  });

  // hover bands
  if (tipEl) {
    const overlay = el('g', {});
    labels.forEach((label, i) => {
      const cx = m.l + cellW * (i + 0.5);
      const hit = el('rect', { x: cx - cellW / 2, y: m.t, width: cellW, height: H - m.t - m.b,
        fill: 'transparent' });
      hit.addEventListener('mouseenter', () => {
        tipEl.style.display = 'block';
        tipEl.style.left = cx + 'px';
        tipEl.style.top = sy(values[i]) + 'px';
        tipEl.innerHTML = cfg.tooltip ? cfg.tooltip(i, labels, values)
          : `<div class="row"><span>${label}</span><span>${yFmt(values[i])}</span></div>`;
      });
      hit.addEventListener('mouseleave', () => tipEl.style.display = 'none');
      overlay.appendChild(hit);
    });
    svgEl.appendChild(overlay);
  }
}

// Draw multiple spot paths on one canvas (used for autocallable path sample).
// cfg: { times, paths: [{ spots, color }], verticals: [{t,label,color}], horizontals: [{y,label,color}] }
export function drawPathsChart(svgEl, cfg) {
  svgEl.innerHTML = '';
  const paths = cfg.paths || [];
  if (!paths.length) return;
  const W = svgEl.clientWidth || 800;
  const H = svgEl.clientHeight || 320;
  const m = { l: 54, r: 16, t: 14, b: 28 };
  const times = cfg.times;

  const xmin = times[0], xmax = times[times.length - 1];
  let ymin = Infinity, ymax = -Infinity;
  for (const p of paths) for (const y of p.spots) { if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
  if (cfg.horizontals) for (const h of cfg.horizontals) { if (h.y < ymin) ymin = h.y; if (h.y > ymax) ymax = h.y; }
  const pad = (ymax - ymin) * 0.08 || 1;
  ymin -= pad; ymax += pad;

  const sx = linear([xmin, xmax], [m.l, W - m.r]);
  const sy = linear([ymin, ymax], [H - m.b, m.t]);

  // gridlines
  const yTicks = niceTicks(ymin, ymax, 5);
  yTicks.forEach(t => {
    const y = sy(t);
    svgEl.appendChild(el('line', { x1: m.l, x2: W - m.r, y1: y, y2: y,
      stroke: 'rgba(255,255,255,0.05)', 'stroke-dasharray': '3 4' }));
    const lbl = el('text', { x: m.l - 8, y: y + 3.5, 'text-anchor': 'end',
      fill: '#8d94ad', 'font-size': 10, 'font-family': 'SF Mono, monospace' });
    lbl.textContent = fmtAxisMoney(t);
    svgEl.appendChild(lbl);
  });

  // horizontals (barriers)
  if (cfg.horizontals) for (const h of cfg.horizontals) {
    const y = sy(h.y);
    svgEl.appendChild(el('line', {
      x1: m.l, x2: W - m.r, y1: y, y2: y,
      stroke: h.color, 'stroke-dasharray': '6 4', 'stroke-width': 1.5, opacity: 0.9
    }));
    if (h.label) {
      const t = el('text', { x: W - m.r - 6, y: y - 4, 'text-anchor': 'end',
        fill: h.color, 'font-size': 10, 'font-family': 'SF Mono, monospace' });
      t.textContent = h.label;
      svgEl.appendChild(t);
    }
  }

  // verticals (observation dates)
  if (cfg.verticals) for (const v of cfg.verticals) {
    const x = sx(v.t);
    svgEl.appendChild(el('line', {
      x1: x, x2: x, y1: m.t, y2: H - m.b,
      stroke: v.color || 'rgba(255,255,255,0.08)', 'stroke-dasharray': v.dashed === false ? '0' : '2 3'
    }));
  }

  // paths
  for (const p of paths) {
    const d = buildPath(times, p.spots, sx, sy);
    svgEl.appendChild(el('path', {
      d, fill: 'none', stroke: p.color, 'stroke-width': p.width || 1.2,
      opacity: p.opacity ?? 0.65, 'stroke-linejoin': 'round'
    }));
  }
}

// Histogram helper.
// cfg: { values, bins, color, xFormat?, yFormat? }
export function drawHistogram(svgEl, tipEl, cfg) {
  svgEl.innerHTML = '';
  const values = cfg.values;
  if (!values || !values.length) return;
  const nBins = cfg.bins || 40;
  let lo = Math.min(...values), hi = Math.max(...values);
  if (lo === hi) { lo -= 0.5; hi += 0.5; }
  // pad
  const pad = (hi - lo) * 0.02;
  lo -= pad; hi += pad;
  const width = (hi - lo) / nBins;
  const counts = new Array(nBins).fill(0);
  for (const v of values) {
    let i = Math.floor((v - lo) / width);
    if (i < 0) i = 0;
    if (i >= nBins) i = nBins - 1;
    counts[i]++;
  }
  const freq = counts.map(c => c / values.length);

  const W = svgEl.clientWidth || 800;
  const H = svgEl.clientHeight || 260;
  const m = { l: 46, r: 16, t: 14, b: 28 };

  const ymax = Math.max(...freq) * 1.15 || 1;
  const sx = linear([lo, hi], [m.l, W - m.r]);
  const sy = linear([0, ymax], [H - m.b, m.t]);

  const yTicks = niceTicks(0, ymax, 4);
  yTicks.forEach(t => {
    const y = sy(t);
    svgEl.appendChild(el('line', { x1: m.l, x2: W - m.r, y1: y, y2: y,
      stroke: 'rgba(255,255,255,0.05)', 'stroke-dasharray': '3 4' }));
    const lbl = el('text', { x: m.l - 8, y: y + 3.5, 'text-anchor': 'end',
      fill: '#8d94ad', 'font-size': 10, 'font-family': 'SF Mono, monospace' });
    lbl.textContent = (t * 100).toFixed(0) + '%';
    svgEl.appendChild(lbl);
  });

  const xTicks = niceTicks(lo, hi, 6);
  const xFmt = cfg.xFormat || (v => v.toFixed(2));
  xTicks.forEach(t => {
    const x = sx(t);
    const lbl = el('text', { x, y: H - m.b + 16, 'text-anchor': 'middle',
      fill: '#8d94ad', 'font-size': 10, 'font-family': 'SF Mono, monospace' });
    lbl.textContent = xFmt(t);
    svgEl.appendChild(lbl);
  });

  // vertical guide for reference (e.g. at 1.0)
  if (cfg.verticals) for (const v of cfg.verticals) {
    if (v.x < lo || v.x > hi) continue;
    const x = sx(v.x);
    svgEl.appendChild(el('line', { x1: x, x2: x, y1: m.t, y2: H - m.b,
      stroke: v.color, 'stroke-dasharray': '4 4' }));
    if (v.label) {
      const t = el('text', { x: x + 5, y: m.t + 12, fill: v.color,
        'font-size': 10, 'font-family': 'SF Mono, monospace' });
      t.textContent = v.label;
      svgEl.appendChild(t);
    }
  }

  for (let i = 0; i < nBins; i++) {
    const x0 = sx(lo + i * width);
    const x1 = sx(lo + (i + 1) * width);
    const y = sy(freq[i]);
    const h = sy(0) - y;
    svgEl.appendChild(el('rect', {
      x: x0 + 0.5, y, width: Math.max(0.5, x1 - x0 - 1), height: Math.max(0, h),
      fill: cfg.color || '#7dd3fc', rx: 1.5, opacity: 0.85
    }));
  }
}

// Heatmap. Used by calibration to show |modelIV - marketIV| on the (T, k)
// grid, and re-usable for any 2D scalar grid you want to render with a
// diverging or sequential colormap.
//
// cfg:
//   xs: column-axis values (e.g. log-moneyness)
//   ys: row-axis values    (e.g. maturities)
//   values: Float64Array, length xs.length * ys.length, row-major.
//           values[r * xs.length + c]
//   colormap: 'diverging' (default — blue/white/red around 0) | 'sequential'
//             (dark→bright). Pass cfg.symmetric=true for diverging to force
//             |max| on both sides.
//   xFormat?, yFormat?, valueFormat?
//   xLabel?, yLabel?
//   tooltip?: (r, c, value, x, y) => HTML
export function drawHeatmap(svgEl, tipEl, cfg) {
  svgEl.innerHTML = '';
  const xs = cfg.xs, ys = cfg.ys, values = cfg.values;
  if (!xs || !ys || !values || xs.length === 0 || ys.length === 0) return;
  const nC = xs.length, nR = ys.length;
  const W = svgEl.clientWidth || 800;
  const H = svgEl.clientHeight || 260;
  const m = { l: 56, r: 16, t: 14, b: 28 };

  // value extent
  let vmin = Infinity, vmax = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isFinite(v)) continue;
    if (v < vmin) vmin = v;
    if (v > vmax) vmax = v;
  }
  if (!isFinite(vmin) || !isFinite(vmax)) { vmin = 0; vmax = 1; }
  if (vmin === vmax) { vmin -= 1e-6; vmax += 1e-6; }

  const symmetric = !!cfg.symmetric;
  const cmap = cfg.colormap || 'diverging';
  let domain;
  if (cmap === 'diverging' && symmetric) {
    const a = Math.max(Math.abs(vmin), Math.abs(vmax));
    domain = [-a, 0, a];
  } else if (cmap === 'diverging') {
    domain = [vmin, (vmin + vmax) / 2, vmax];
  } else {
    domain = [vmin, vmax];
  }

  function color(v) {
    if (!isFinite(v)) return '#444';
    if (cmap === 'diverging') {
      // blue (-) → light → red (+)
      const [lo, mid, hi] = domain;
      if (v <= mid) {
        const t = (v - lo) / Math.max(1e-12, mid - lo);
        return mix('#3b82f6', '#f1f5f9', clamp01(t));
      } else {
        const t = (v - mid) / Math.max(1e-12, hi - mid);
        return mix('#f1f5f9', '#ef4444', clamp01(t));
      }
    } else {
      const [lo, hi] = domain;
      const t = clamp01((v - lo) / Math.max(1e-12, hi - lo));
      return mix('#0b132a', '#fde68a', t);
    }
  }

  const cellW = (W - m.l - m.r) / nC;
  const cellH = (H - m.t - m.b) / nR;
  const xFmt = cfg.xFormat || (v => v.toFixed(2));
  const yFmt = cfg.yFormat || (v => v.toFixed(2));
  const valFmt = cfg.valueFormat || (v => v.toFixed(4));

  // y-axis labels (rows)
  for (let r = 0; r < nR; r++) {
    const cy = m.t + cellH * (r + 0.5);
    const lbl = el('text', { x: m.l - 8, y: cy + 3.5, 'text-anchor': 'end',
      fill: '#8d94ad', 'font-size': 10, 'font-family': 'SF Mono, monospace' });
    lbl.textContent = yFmt(ys[r]);
    svgEl.appendChild(lbl);
  }
  // x-axis labels (cols), every Nth to avoid crowding
  const xSkip = Math.max(1, Math.ceil(nC / 8));
  for (let c = 0; c < nC; c++) {
    if (c % xSkip !== 0 && c !== nC - 1) continue;
    const cx = m.l + cellW * (c + 0.5);
    const lbl = el('text', { x: cx, y: H - m.b + 16, 'text-anchor': 'middle',
      fill: '#8d94ad', 'font-size': 10, 'font-family': 'SF Mono, monospace' });
    lbl.textContent = xFmt(xs[c]);
    svgEl.appendChild(lbl);
  }

  // cells
  for (let r = 0; r < nR; r++) {
    for (let c = 0; c < nC; c++) {
      const v = values[r * nC + c];
      const x = m.l + c * cellW;
      const y = m.t + r * cellH;
      const rect = el('rect', {
        x: x + 0.5, y: y + 0.5,
        width: Math.max(0, cellW - 1), height: Math.max(0, cellH - 1),
        fill: color(v), 'data-r': r, 'data-c': c
      });
      if (tipEl) {
        rect.addEventListener('mouseenter', () => {
          tipEl.style.display = 'block';
          tipEl.style.left = (x + cellW / 2) + 'px';
          tipEl.style.top = (y + cellH / 2) + 'px';
          tipEl.innerHTML = cfg.tooltip
            ? cfg.tooltip(r, c, v, xs[c], ys[r])
            : `<div class="row"><span>${cfg.yLabel || 'y'}</span><span>${yFmt(ys[r])}</span></div>` +
              `<div class="row"><span>${cfg.xLabel || 'x'}</span><span>${xFmt(xs[c])}</span></div>` +
              `<div class="row"><span>value</span><span>${valFmt(v)}</span></div>`;
        });
        rect.addEventListener('mouseleave', () => { tipEl.style.display = 'none'; });
      }
      svgEl.appendChild(rect);
    }
  }

  // colorbar (compact, on the right inside the right margin)
  // (skipped: would require widening m.r; UI shows scale via min/max labels)
}

function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
// Linear interpolate between two #rrggbb hex strings.
function mix(a, b, t) {
  const ar = parseInt(a.slice(1, 3), 16), ag = parseInt(a.slice(3, 5), 16), ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16), bg = parseInt(b.slice(3, 5), 16), bb = parseInt(b.slice(5, 7), 16);
  const rr = Math.round(ar + (br - ar) * t);
  const gg = Math.round(ag + (bg - ag) * t);
  const bbv = Math.round(ab + (bb - ab) * t);
  return `rgb(${rr},${gg},${bbv})`;
}
