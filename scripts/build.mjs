/**
 * 友链合并构建脚本（CF Pages 运行）
 *
 *   1. 读 data/friends/*.json
 *   2. 每次都重新下载头像 → sharp 采样 → pickAccent 取色（拉取失败/超时才沿用旧 accent 和旧 snippet）
 *   3. 色相散排，写 order
 *   4. 头像存 dist/snippet/<order>.<ext>（无 order 的站长存 self）
 *   5. 合并成 dist/data/friends.json，带 total 和 updated
 *   6. dist/_headers 带 CORS，主站跨域直读
 *
 * 取色失败只跳过该卡片的颜色，不阻断构建；散排保证同样的输入每次结果一样。
 * 头像拉取失败时沿用上次的 snippet 快照，所以清 dist 之前得先把旧产物读出来。
 *
 * 兜底数据的来源（DATA_URL，必填）：
 *   - 本地连跑时读 dist/（上一次本地构建的产物）
 *   - CF Pages 每次都是全新克隆，dist/ 不存在；但构建期间自定义域仍指向
 *     「上一次部署」，data/friends.json 与 snippet/* 都还活着——从这里读回来。
 *   - DATA_URL 缺失直接报错退出：兜底链没有数据源就是裸奔，不能静默构建。
 */
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import php from 'highlight.js/lib/languages/php';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import jsonLang from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import xml from 'highlight.js/lib/languages/xml';
import cssLang from 'highlight.js/lib/languages/css';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import {
  rgbToHsl, hueDistance, pickAccent, buildThemeRgb, hexToRgb,
} from './friendColor.mjs';

const SRC_DIR = path.resolve('data/friends');
const OUT_DIR = path.resolve('dist');
const DATA_DIR = path.join(OUT_DIR, 'data');
const SNIPPET_DIR = path.join(OUT_DIR, 'snippet');
const OUT_FILE = path.join(DATA_DIR, 'friends.json');
const POSTS_SRC_DIR = path.resolve('data/posts');
const POSTS_OUT_DIR = path.join(OUT_DIR, 'posts');
const POSTS_META_FILE = path.join(DATA_DIR, 'posts.json');

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
const PREV_TIMEOUT = 30_000;
const EXT_MAP = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', avif: 'avif' };

hljs.registerLanguage('php', php); hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript); hljs.registerLanguage('json', jsonLang);
hljs.registerLanguage('bash', bash); hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', cssLang); hljs.registerLanguage('yaml', yaml); hljs.registerLanguage('sql', sql);

const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escapeAttr = (text) => escapeHtml(text).replace(/'/g, '&#39;');
const safeUrl = (value) => /^(?:https?:|mailto:|#|\/)/i.test(String(value).trim()) && !/^\s*javascript:/i.test(String(value)) ? String(value).trim() : '#';
const stripComment = (value) => value.replace(/\s+#.*$/, '').trim();
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result = {}; let currentKey = '';
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) { currentKey = kv[1]; const value = stripComment(kv[2]).replace(/^['"]|['"]$/g, ''); if (value !== '') result[currentKey] = value === 'true' ? true : value === 'false' ? false : value; }
    else if (currentKey) { const item = line.match(/^\s+-\s*(.+)$/); if (item) { const value = stripComment(item[1]).replace(/^['"]|['"]$/g, ''); if (Array.isArray(result[currentKey])) result[currentKey].push(value); else result[currentKey] = [value]; } }
  }
  return result;
}
function readableLength(raw) { return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, ' ').replace(/[#>*_~\\|\-]/g, ' ').replace(/\s/g, '').length; }
function renderPost(raw) {
  const renderer = new marked.Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  renderer.link = ({ href, title, text }) => `<a href="${escapeAttr(safeUrl(href))}" target="_blank" rel="noopener noreferrer"${title ? ` title="${escapeAttr(title)}"` : ''}>${text}</a>`;
  renderer.image = ({ href, title, text }) => `<img src="${escapeAttr(safeUrl(href))}" alt="${escapeAttr(text)}"${title ? ` title="${escapeAttr(title)}"` : ''}>`;
  renderer.code = ({ text, lang }) => {
    const aliases = { ts: 'typescript', js: 'javascript', sh: 'bash', shell: 'bash', html: 'xml' };
    const language = (lang || '').trim().toLowerCase(); const target = aliases[language] || language; const known = hljs.getLanguage(target);
    const highlighted = known ? hljs.highlight(text, { language: target, ignoreIllegals: true }).value : escapeHtml(text); const label = known ? target : language || 'text';
    return `<pre data-lang="${label}"><code class="hljs language-${label}">${highlighted}</code></pre>`;
  };
  marked.setOptions({ gfm: true, breaks: true });
  return marked.parse(raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''), { renderer, async: false });
}

async function buildPosts() {
  if (!(await fs.stat(POSTS_SRC_DIR).catch(() => null))) return;
  await fs.mkdir(POSTS_OUT_DIR, { recursive: true });
  const metas = [];
  for (const file of (await fs.readdir(POSTS_SRC_DIR)).filter(name => name.endsWith('.md')).sort()) {
    const raw = await fs.readFile(path.join(POSTS_SRC_DIR, file), 'utf8');
    const fm = parseFrontmatter(raw); const slug = file.replace(/\.md$/, '');
    const meta = { slug, title: typeof fm.title === 'string' && fm.title ? fm.title : slug, description: typeof fm.description === 'string' ? fm.description : '', date: typeof fm.published === 'string' ? fm.published : '', image: typeof fm.image === 'string' ? fm.image : '', thumb: typeof fm.image === 'string' ? fm.image.replace(/(-cover)\.(webp|jpe?g|png)$/i, '$1-320.webp') : '', tags: Array.isArray(fm.tags) ? fm.tags : [], category: typeof fm.category === 'string' ? fm.category : '', draft: fm.draft === true, length: readableLength(raw) };
    metas.push(meta);
    if (!meta.draft) await fs.writeFile(path.join(POSTS_OUT_DIR, `${slug}.html`), renderPost(raw), 'utf8');
  }
  metas.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  await fs.writeFile(POSTS_META_FILE, JSON.stringify(metas, null, 2) + '\n', 'utf8');
  console.log(`文章构建完成：${metas.filter(post => !post.draft).length} 篇公开文章 → dist/posts/`);
}

/* 本地开发时读 .env（脚本跑在构建链路里，环境变量可能还没注入）。
 * 只补进程里还没有的键，CF Pages 注入的环境变量优先。 */
function loadDotEnv(file) {
  let text;
  try {
    text = readFileSync(file, 'utf-8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
loadDotEnv(path.resolve('.env'));

/* 兜底数据源：本地 dist 不可用时，从「上一次部署」读回旧 accent / snippet。
 * 去掉结尾斜杠，后面统一拼相对路径。 */
const DATA_URL = process.env.DATA_URL?.trim().replace(/\/+$/, '');

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

/**
 * 把上一次的构建产物读进内存：旧 accent 和旧 snippet 快照，都按友链名索引。
 * 源 json 里不再存这三个字段，本次拉取/取色失败时全靠它兜底——所以必须在清 dist 之前调用。
 * 按名字而不是头像 URL 索引：朋友换头像地址时仍能对上同一份旧数据。
 *
 * 两个来源，本地优先：
 *   1. 本地 dist/——本地连跑构建时有效
 *   2. DATA_URL 指向的上次部署——CF Pages 全新克隆没有 dist/，但构建期间
 *      自定义域仍服务着旧部署，data/friends.json 和 snippet/* 都能拉回来
 */
async function loadPrevBuild() {
  const map = new Map();
  let old = null;
  try {
    old = JSON.parse(await fs.readFile(OUT_FILE, 'utf-8'));
  } catch {
    /* 本地没有旧产物，走线上兜底 */
  }
  if (!old) {
    if (!DATA_URL) {
      console.warn('  ⚠ 本地无旧产物且未配置 DATA_URL，本次构建没有兜底数据可用');
      return map;
    }
    try {
      const res = await fetch(`${DATA_URL}/data/friends.json`, { signal: AbortSignal.timeout(PREV_TIMEOUT) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      old = await res.json();
      console.log(`  兜底：从上次部署 ${DATA_URL} 读到旧数据`);
    } catch (err) {
      console.warn(`  ⚠ 上次部署的兜底数据读取失败（${err.message}），本次构建无旧值可用`);
      return map;
    }
  }
  for (const f of old.friends || []) {
    if (!f.name) continue;
    const entry = {};
    if (typeof f.accent === 'string' && f.accent) entry.accent = f.accent;
    if (f.snippet) {
      const rel = String(f.snippet).replace(/^\/+/, '');
      const ext = rel.split('.').pop();
      let buf = null;
      try {
        buf = await fs.readFile(path.join(OUT_DIR, rel));
      } catch {
        /* 本地旧文件不在了，去上次部署拉 */
      }
      if (!buf && DATA_URL) {
        try {
          const res = await fetch(`${DATA_URL}/${rel}`, { signal: AbortSignal.timeout(AVATAR_TIMEOUT) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          buf = Buffer.from(await res.arrayBuffer());
        } catch {
          /* snippet 拉不回就算了，accent 还能单独用 */
        }
      }
      if (buf) entry.snippet = { buf, ext };
    }
    map.set(f.name, entry);
  }
  return map;
}

/** 取色/拉取失败时，沿用上次构建算出来的 accent；没有就留空，日志说明 */
function applyPrevAccent(json, prev, file, reason) {
  if (prev?.accent) {
    console.log(`  ${file}: ${reason}，沿用上次 accent ${prev.accent}`);
    return prev.accent;
  }
  console.log(`  ${file}: ${reason}，无旧 accent 可用`);
  return undefined;
}

/** 站长自己那张：回链用，不参与散排，snippet 固定存 self */
function isSelf(f) {
  return typeof f.url === 'string' && f.url.includes('fuhao574.cyou');
}

async function main() {
  // DATA_URL 是兜底链的数据源：头像拉取失败时沿用上次 accent / snippet 全靠它。
  // 缺了就是裸奔（一次失败就永久丢色），构建开始前直接拦下。
  if (!DATA_URL) {
    console.error('❌ 缺少 DATA_URL，无法读取上次构建的兜底数据');
    console.error('   CF Pages 项目设置 → Environment variables 加 DATA_URL=https://data.fuhao574.cyou');
    console.error('   本地构建在 friends-repo 根目录建 .env 写 DATA_URL=...');
    process.exit(1);
  }
  // 先留住上次的 accent 和 snippet 快照，再清 dist；本次构建有失败时靠它兜底
  const prevBuild = await loadPrevBuild();
  // 每次构建都是全新产物，旧的 dist 整个清掉，避免残留过期文件
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(SNIPPET_DIR, { recursive: true });
  await buildPosts();
  const files = (await fs.readdir(SRC_DIR)).filter((f) => f.endsWith('.json')).sort();

  const friends = [];
  for (const file of files) {
    const json = JSON.parse(await fs.readFile(path.join(SRC_DIR, file), 'utf-8'));
    const prev = prevBuild.get(json.name);
    if (!json.avatar) {
      console.log(`  ${file}: 无头像，跳过取色`);
      friends.push(json);
      continue;
    }
    try {
      // 每次构建都重新拉取头像并重算 accent；失败/超时才沿用上次构建的旧值
      const buf = await fetchAvatar(json.avatar);
      const pixels = await extractPixels(buf);
      const accent = pickAccent(pixels, PALETTE, INDIGO);
      if (accent) {
        const rgb = buildThemeRgb(accent.hue, accent.sat);
        console.log(`  ${file}: ${accent.name} ${rgb}`);
        json.accent = rgb;
      } else {
        json.accent = applyPrevAccent(json, prev, file, '无彩色像素');
      }
      // 头像存 snippet，等散排算完 order 再落盘
      const fmt = (await sharp(buf).metadata()).format;
      json._snippet = { buf, ext: EXT_MAP[fmt] || 'png' };
    } catch (err) {
      json.accent = applyPrevAccent(json, prev, file, `拉取失败（${err.message}）`);
      if (prev?.snippet) {
        json._snippet = prev.snippet;
        console.log(`  ${file}: └ 沿用上次 snippet 快照`);
      } else {
        console.log(`  ${file}: └ 无旧 snippet 快照可用`);
      }
    }
    friends.push(json);
  }

  // 色相散排：站长自己那张不参与
  const entries = [];
  for (const f of friends) {
    if (isSelf(f)) continue;
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
  // 取色彻底失败（新算的旧的全没有）的友链没进散排，也得给个编号，
  // 否则 snippet 落盘时会用 'self' 文件名，把站长头像覆盖掉
  let spare = order.length;
  for (const f of friends) {
    if (isSelf(f) || typeof f.order === 'number') continue;
    f.order = spare;
    spare += 1;
    console.log(`  ${f.name}: 无 accent，排到末尾 order=${f.order}`);
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
