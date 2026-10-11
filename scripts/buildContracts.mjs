/** 构建输入契约。此文件在两个独立仓库各自维护，测试确认相同规则。 */
import path from 'node:path';
import ipaddr from 'ipaddr.js';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function text(value, label, max, required = false) {
  if (typeof value !== 'string' || [...value].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || (required && !value.trim())) throw new Error(`${label}: invalid string/length`);
  return value;
}
export function webUrl(value, label, { optional = false, relative = false } = {}) {
  text(value, label, 2048);
  if (optional && !value) return value;
  if (relative && /^\/(?!\/)[^\\\s]*$/.test(value)) return value;
  if (/[\s\\]/.test(value)) throw new Error(`${label}: invalid URL`);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || (url.port && url.port !== '443')) throw new Error(`${label}: only public HTTPS port 443 URLs`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.')
      || (ipaddr.isValid(host) && ipaddr.parse(host).range() !== 'unicast')) throw new Error(`${label}: non-public URL`);
  return value;
}
export function slugPath(dir, slug) {
  if (typeof slug !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,119}$/.test(slug)) throw new Error('invalid post slug');
  const result = path.resolve(dir, `${slug}.html`);
  if (path.dirname(result) !== path.resolve(dir)) throw new Error('post path escaped directory');
  return result;
}
export function snippetPath(value) {
  if (typeof value !== 'string' || !/^\/?snippet\/(?:self|[0-9]+)\.(?:png|jpe?g|webp|gif|avif)$/.test(value)) throw new Error('invalid snippet path');
  return value.replace(/^\//, '');
}
export function validateFriends(payload, { source = false } = {}) {
  const list = Array.isArray(payload) ? payload : payload?.friends;
  if (!Array.isArray(list) || list.length > 500) throw new Error('friends must be an array (max 500)');
  const names = new Set(), urls = new Set(), snippets = new Set();
  for (const f of list) {
    if (!object(f)) throw new Error('invalid friend object');
    text(f.name, 'friend.name', 60, true); webUrl(f.url, 'friend.url');
    const identity = new URL(f.url).href.replace(/\/+$/, '');
    if (names.has(f.name) || urls.has(identity)) throw new Error('duplicate friend name/URL');
    names.add(f.name); urls.add(identity);
    for (const key of ['avatar', 'rss', 'backlink']) webUrl(f[key] === undefined ? '' : f[key], `friend.${key}`, { optional: true });
    text(f.description === undefined ? '' : f.description, 'friend.description', 200);
    if (!source) {
      if (f.snippetRemote !== undefined) webUrl(f.snippetRemote, 'friend.snippetRemote', { optional: true });
      if (f.accent !== undefined && (typeof f.accent !== 'string' || !/^\d{1,3},\s*\d{1,3},\s*\d{1,3}$/.test(f.accent) || f.accent.split(',').some(x => Number(x) > 255))) throw new Error('invalid accent');
      if (f.order !== undefined && (!Number.isSafeInteger(f.order) || f.order < 0 || f.order > 500)) throw new Error('invalid order');
      if (f.snippet !== undefined) { const s = snippetPath(f.snippet).replace(/\.[^.]+$/, ''); if (snippets.has(s)) throw new Error('duplicate snippet'); snippets.add(s); }
    } else if (['accent', 'order', 'snippet', 'snippetRemote', '_snippet'].some(k => k in f)) throw new Error('generated fields must not be in source friend JSON');
  }
  return list;
}
export function validatePosts(posts, { requireHash = true } = {}) {
  if (!Array.isArray(posts) || posts.length > 2000) throw new Error('posts must be an array (max 2000)');
  const seen = new Set();
  for (const p of posts) {
    if (!object(p)) throw new Error('invalid post object');
    slugPath('.', p.slug);
    const key = p.slug.toLowerCase(); if (seen.has(key)) throw new Error('duplicate/case-conflicting slug'); seen.add(key);
    text(p.title, 'post.title', 200, true); text(p.description, 'post.description', 2000);
    text(p.category, 'post.category', 60); text(p.date, 'post.date', 64);
    if (typeof p.draft !== 'boolean') throw new Error('draft must be boolean');
    if (!p.draft && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?$/.test(p.date) || !Number.isFinite(Date.parse(p.date))
        || new Date(`${p.date.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== p.date.slice(0, 10))) throw new Error('invalid published date');
    for (const field of ['image', 'thumb']) webUrl(p[field], `post.${field}`, { optional: true, relative: true });
    if (!Array.isArray(p.tags) || p.tags.length > 30) throw new Error('invalid tags');
    p.tags.forEach(t => text(t, 'post.tag', 60, true));
    if (!Number.isSafeInteger(p.length) || p.length < 0) throw new Error('invalid readable length');
    if (!p.draft && requireHash && (typeof p.htmlSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.htmlSha256))) throw new Error('missing/invalid htmlSha256: deploy data repo first');
  }
  return posts;
}
