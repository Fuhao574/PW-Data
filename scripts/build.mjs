/**
 * 友链合并构建脚本（CF Pages 运行）
 *
 *   1. 读 data/friends/*.json
 *   2. 每次都重新下载头像 → sharp 采样 → pickAccent 取色（拉取失败/超时才沿用旧 accent）
 *   3. 色相散排，写 order
 *   4. 头像存 dist/snippet/<order>.<ext>（无 order 的站长存 self）
 *   5. 合并成 dist/data/friends.json，带 total 和 updated
 *   6. dist/_headers 带 CORS，主站跨域直读
 *
 * 取色失败只跳过该卡片的颜色，不阻断构建；散排保证同样的输入每次结果一样。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {
  rgbToHsl, hueDistance, pickAccent, buildThemeRgb, hexToRgb,
} from './friendColor.mjs';

const SRC_DIR = path.resolve('data/friends');
const OUT_DIR = path.resolve('dist');
const DATA_DIR = path.join(OUT_DIR, 'data');
const SNIPPET_DIR = path.join(OUT_DIR, 'snippet');
const OUT_FILE = path.join(DATA_DIR, 'friends.json');

const ACCENTS = {
  indigo: '#6366f1', teal: '#14b8a6', violet: '#8b5cf6',
  amber: '#f59e0b', rose: '#f43f5e', sky: '#0ea5e9',
};
const PALETTE = Object.entries(ACCENTS).map(([name, hex]) => {
  const [hue, sat] = rgbToHsl(...hexToRgb(hex));
  return { name, hue, sat };
});
const INDIGO = PALETTE.find((p) => p.name === 'indigo');
const SAMPLE = 16;
const AVATAR_TIMEOUT = 15_000;
const EXT_MAP = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', avif: 'avif' };

async function fetchAvatar(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(AVATAR_TIMEOUT) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function extractPixels(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = [];
  for (let gy = 0; gy < SAMPLE; gy++) {
    const y0 = Math.floor((gy * info.height) / SAMPLE);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * info.height) / SAMPLE));
    for (let gx = 0; gx < SAMPLE; gx++) {
      const x0 = Math.floor((gx * info.width) / SAMPLE);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * info.width) / SAMPLE));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * info.width + x) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3]; n++;
        }
      }
      if (n > 0) pixels.push({ r: r / n, g: g / n, b: b / n, a: a / n });
    }
  }
  return pixels;
}

function spreadOrder(hues) {
  const n = hues.length;
  if (n <= 2) return hues.map((_, i) => i);

  const GRIDS = [1, 2, 3];
  const pairSets = GRIDS.map((cols) => {
    const pairs = [];
    for (let p = 0; p < n; p += 1) {
      if (p % cols !== 0) pairs.push([p, p - 1]);
      if (p - cols >= 0) pairs.push([p, p - cols]);
    }
    return pairs;
  });

  const score = (order) => {
    let min = Infinity, sum = 0;
    for (const pairs of pairSets) {
      for (const [a, b] of pairs) {
        const d = hueDistance(hues[order[a]], hues[order[b]]);
        if (d < min) min = d;
        sum += d;
      }
    }
    return min + sum / 1000;
  };

  const byHue = hues.map((_, i) => i).sort((a, b) => hues[a] - hues[b]);
  const interleave = () => {
    const mid = Math.ceil(n / 2);
    const lo = byHue.slice(0, mid);
    const hi = byHue.slice(mid);
    const out = [];
    for (let i = 0; i < hi.length; i += 1) out.push(lo[i], hi[i]);
    if (lo.length > hi.length) out.push(lo[lo.length - 1]);
    return out;
  };

  let seed = 42;
  const shuffled = () => {
    const o = interleave();
    for (let i = n - 1; i > 0; i -= 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const j = Math.floor((seed / 0x7fffffff) * (i + 1));
      [o[i], o[j]] = [o[j], o[i]];
    }
    return o;
  };

  let best = interleave();
  let bestScore = score(best);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    let order = attempt === 0 ? best.slice() : shuffled();
    let s = score(order);
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < n; i += 1) {
        for (let j = i + 1; j < n; j += 1) {
          const next = order.slice();
          [next[i], next[j]] = [next[j], next[i]];
          const ns = score(next);
          if (ns > s + 1e-9) { order = next; s = ns; improved = true; }
        }
      }
    }
    if (s > bestScore) { best = order; bestScore = s; }
  }
  return best;
}

async function main() {
  // 每次构建都是全新产物，旧的 dist 整个清掉，避免残留过期文件
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(SNIPPET_DIR, { recursive: true });
  const files = (await fs.readdir(SRC_DIR)).filter((f) => f.endsWith('.json')).sort();

  const friends = [];
  for (const file of files) {
    const json = JSON.parse(await fs.readFile(path.join(SRC_DIR, file), 'utf-8'));
    if (!json.avatar) { console.log(`  ${file}: 无头像，跳过取色`); friends.push(json); continue; }
    try {
      // 每次构建都重新拉取头像并重算 accent；失败/超时才沿用旧值
      const buf = await fetchAvatar(json.avatar);
      const pixels = await extractPixels(buf);
      const accent = pickAccent(pixels, PALETTE, INDIGO);
      if (accent) {
        const rgb = buildThemeRgb(accent.hue, accent.sat);
        console.log(`  ${file}: ${accent.name} ${rgb}`);
        json.accent = rgb;
      } else {
        console.log(`  ${file}: 无彩色像素，沿用旧 accent`);
      }
      // 头像存 snippet，等散排算完 order 再落盘
      const fmt = (await sharp(buf).metadata()).format;
      json._snippet = { buf, ext: EXT_MAP[fmt] || 'png' };
    } catch (err) {
      console.log(`  ${file}: 取色失败（${err.message}），沿用旧 accent`);
    }
    friends.push(json);
  }

  // 色相散排：站长自己那张不参与
  const entries = [];
  for (const f of friends) {
    if (typeof f.url === 'string' && f.url.includes('fuhao574.cyou')) continue;
    if (!f.accent) continue;
    const rgb = f.accent.split(',').map((p) => parseInt(p.trim(), 10));
    if (rgb.length !== 3 || !rgb.every((v) => Number.isInteger(v))) continue;
    const [hue] = rgbToHsl(...rgb);
    entries.push({ friend: f, hue });
  }
  const order = spreadOrder(entries.map((e) => e.hue));
  for (let pos = 0; pos < order.length; pos += 1) {
    entries[order[pos]].friend.order = pos;
  }

  // snippet 落盘：有 order 用 order，没有（站长）用 self；相对路径写进 json
  for (const f of friends) {
    if (!f._snippet) continue;
    const name = typeof f.order === 'number' ? f.order : 'self';
    await fs.writeFile(path.join(SNIPPET_DIR, `${name}.${f._snippet.ext}`), f._snippet.buf);
    f.snippet = `snippet/${name}.${f._snippet.ext}`;
    delete f._snippet;
  }

  const payload = {
    total: friends.length,
    updated: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + '+08:00',
    friends,
  };
  await fs.writeFile(OUT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf-8');

  // CF Pages 的 _headers：主站跨域读取必须带 CORS，否则浏览器直接拦截
  await fs.writeFile(
    path.join(OUT_DIR, '_headers'),
    '/*\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=60\n',
    'utf-8',
  );
  console.log(`合并完成：${friends.length} 个友链 → dist/data/friends.json`);
}

main().catch((err) => { console.error(err); process.exit(1); });
