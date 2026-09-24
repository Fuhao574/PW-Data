/**
 * 取色算法（与主站 src/utils/friendColor.ts 同源，保持一致）
 */
export function hexToRgb(hex) {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

export function rgbToHsl(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min, l = (max + min) / 2;
  let h = 0, s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, l];
}

export function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function whiteContrast(rgb) {
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const lum = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  return 1.05 / (lum + 0.05);
}

export function whiteSafeColor(hue, sat) {
  let out = hslToRgb(hue, sat, 0.4);
  for (let l = 1; l >= 0.05; l -= 0.01) {
    out = hslToRgb(hue, sat, l);
    if (whiteContrast(out) >= 4.5) break;
  }
  return out;
}

export function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function rgbToHueSatChroma(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  const chroma = d / 255;
  if (d === 0) return { hue: 0, satHls: 0, chroma };
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  const maxN = max / 255, minN = min / 255;
  const satHls = maxN + minN > 1 ? (maxN - minN) / (2 - maxN - minN) : (maxN - minN) / (maxN + minN);
  return { hue: h, satHls, chroma };
}

function weightedHuePeak(pixels, sigma = 18) {
  const BINS = 360;
  const raw = new Float64Array(BINS);
  let voted = false;
  for (const p of pixels) {
    if (p.a < 128) continue;
    const { hue, satHls, chroma } = rgbToHueSatChroma(p.r, p.g, p.b);
    if (satHls < 0.15) continue;
    raw[Math.round(hue) % BINS] += chroma;
    voted = true;
  }
  if (!voted) return null;

  const radius = Math.ceil(sigma * 2.5);
  const kern = [];
  for (let d = -radius; d <= radius; d += 1) kern.push(Math.exp(-(d * d) / (2 * sigma * sigma)));
  const smooth = new Float64Array(BINS);
  for (let i = 0; i < BINS; i += 1) {
    let acc = 0;
    for (let d = -radius; d <= radius; d += 1) acc += raw[(i + d + BINS) % BINS] * kern[d + radius];
    smooth[i] = acc;
  }

  let peak = 0, peakWeight = -1;
  for (let i = 0; i < BINS; i += 1) {
    if (smooth[i] > peakWeight) { peakWeight = smooth[i]; peak = i; }
  }

  let sx = 0, sy = 0;
  for (let d = -radius; d <= radius; d += 1) {
    const i = (peak + d + BINS) % BINS;
    const rad = (i * Math.PI) / 180;
    sx += Math.cos(rad) * smooth[i];
    sy += Math.sin(rad) * smooth[i];
  }
  return ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360;
}

export function pickAccent(pixels, palette, fallback) {
  const meanHue = weightedHuePeak(pixels);
  if (meanHue === null) return fallback ?? null;

  let satSum = 0, sw = 0;
  for (const p of pixels) {
    if (p.a < 128) continue;
    const { satHls, chroma } = rgbToHueSatChroma(p.r, p.g, p.b);
    if (satHls < 0.15) continue;
    satSum += satHls * chroma;
    sw += chroma;
  }
  const meanSat = sw === 0 ? 0.8 : Math.min(Math.max(satSum / sw, 0.65), 0.95);

  let picked = palette[0], pickedDist = Infinity;
  for (const accent of palette) {
    const dist = hueDistance(meanHue, accent.hue);
    if (dist < pickedDist) { pickedDist = dist; picked = accent; }
  }

  const sorted = [...palette].sort((a, b) => a.hue - b.hue);
  const idx = sorted.findIndex((p) => p.name === picked.name);
  const n = sorted.length;
  const prev = sorted[(idx - 1 + n) % n];
  const next = sorted[(idx + 1) % n];
  const maxLeft = hueDistance(prev.hue, picked.hue) / 2;
  const maxRight = hueDistance(picked.hue, next.hue) / 2;

  let delta = ((meanHue - picked.hue + 540) % 360) - 180;
  delta = Math.max(-maxLeft, Math.min(maxRight, delta));
  const hue = (picked.hue + delta + 360) % 360;
  const sat = Math.min(Math.max(meanSat, 0.72), Math.max(picked.sat, 0.75));
  return { name: picked.name, hue, sat };
}

export function buildThemeRgb(hue, sat) {
  const [r, g, b] = whiteSafeColor(hue, sat);
  return `${r}, ${g}, ${b}`;
}
