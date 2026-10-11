/** 构建专用 HTTPS 下载：DNS 校验后绑定连接 IP，逐跳校验，不使用环境代理。 */
import https from 'node:https';
import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import sharp from 'sharp';

export function publicIp(ip) {
  if (!ipaddr.isValid(ip)) return false;
  const parsed = ipaddr.parse(ip);
  if (parsed.range() !== 'unicast') return false;
  if (parsed.kind() === 'ipv6') {
    return parsed.match(ipaddr.parse('2000::'), 3) && !parsed.match(ipaddr.parse('2001::'), 23)
      && !parsed.match(ipaddr.parse('2001:db8::'), 32) && !parsed.match(ipaddr.parse('2002::'), 16)
      && !parsed.match(ipaddr.parse('3fff::'), 20);
  }
  return true;
}
export async function publicTarget(value, resolver = dns.lookup) {
  if (typeof value !== 'string' || /[\s\\]/.test(value)) throw new Error('invalid download URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('only HTTPS 443 downloads');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.')) throw new Error('non-public host');
  const answers = ipaddr.isValid(host) ? [{ address: host, family: ipaddr.parse(host).kind() === 'ipv4' ? 4 : 6 }] : await resolver(host, { all: true });
  if (!answers.length || answers.some(a => !publicIp(a.address))) throw new Error('non-public DNS answer');
  return { url, answers };
}
export async function download(value, { maxBytes = 2097152, timeout = 30000, types, resolver, request = https.get } = {}) {
  const deadline = Date.now() + timeout;
  for (let hop = 0; hop <= 3; hop++) {
    // Promise deadline bounds DNS wait without letting a late answer start a connection.
    let timer;
    const target = await Promise.race([
      publicTarget(value, resolver),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS/download timeout')), Math.max(1, deadline - Date.now())); }),
    ]).finally(() => clearTimeout(timer));
    const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error('download timeout');
    const result = await new Promise((resolve, reject) => {
      let req, timer;
      const fail = error => { clearTimeout(timer); req?.destroy(); reject(error); };
      const lookup = (host, options, callback) => {
        const answer = target.answers.find(a => !options.family || a.family === options.family) ?? target.answers[0];
        callback(null, ...(options.all ? [target.answers] : [answer.address, answer.family]));
      };
      req = request(target.url, { lookup, agent: false, rejectUnauthorized: true, maxHeaderSize: 65536,
        headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'Fuhao574-Build/1.0' } }, res => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          clearTimeout(timer); res.destroy(); req.destroy(); resolve({ location: res.headers.location }); return;
        }
        if (status < 200 || status >= 300) { res.destroy(); fail(new Error(`HTTP ${status}`)); return; }
        const type = (res.headers['content-type'] ?? '').split(';')[0].toLowerCase();
        if (types && !types.includes(type)) { res.destroy(); fail(new Error(`unexpected Content-Type ${type}`)); return; }
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.destroy(); fail(new Error('unexpected content encoding')); return; }
        if (Number(res.headers['content-length']) > maxBytes) { res.destroy(); fail(new Error('response too large')); return; }
        let size = 0; const chunks = [];
        res.on('data', chunk => { size += chunk.length; if (size > maxBytes) fail(new Error('response too large')); else chunks.push(chunk); });
        res.on('error', fail); res.on('aborted', () => fail(new Error('response interrupted')));
        res.on('end', () => { clearTimeout(timer); resolve({ body: Buffer.concat(chunks) }); });
      });
      req.on('error', fail);
      timer = setTimeout(() => fail(new Error('download timeout')), remaining);
    });
    if (result.body) return result.body;
    if (hop === 3) throw new Error('too many redirects');
    value = new URL(result.location, target.url).href;
  }
}
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'application/octet-stream'];
export async function inspectImage(buf) {
  if (buf.length > 8388608) throw new Error('image exceeds 8 MiB');
  const meta = await sharp(buf, { limitInputPixels: 16777216 }).metadata();
  if (!['png', 'jpeg', 'webp', 'gif', 'avif'].includes(meta.format) || !meta.width || !meta.height
      || meta.width * meta.height * (meta.pages ?? 1) > 16777216 || (meta.pages ?? 1) > 300) throw new Error('unsupported/oversized image');
  return meta;
}
