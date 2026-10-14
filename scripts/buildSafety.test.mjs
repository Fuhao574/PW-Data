import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import https from 'node:https';
import sharp from 'sharp';
import { validateFriends, validatePosts, slugPath, snippetPath } from './buildContracts.mjs';
import { publicTarget, download, inspectImage } from './publicDownload.mjs';
import { withTransaction } from './fileTransaction.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const friend = { name: 'friend', url: 'https://example.com/', avatar: '', description: '' };
const post = { slug: 'how-to-choose-SHP', title: 'title', description: '', date: '2026-10-11T10:00:00', category: '', image: '', thumb: '', tags: [], draft: false, length: 1, htmlSha256: 'a'.repeat(64) };
test('现有全部友邻通过新源契约', async () => {
  const files = await fs.readdir(path.join(root, 'data/friends'));
  const friends = await Promise.all(files.filter(f => f.endsWith('.json')).map(async f => JSON.parse(await fs.readFile(path.join(root, 'data/friends', f)))));
  assert.ok(friends.length > 0);
  assert.equal(validateFriends(friends, { source: true }).length, friends.length);
});
test('安全 slug/快照路径与元数据类型拒绝，大小写旧 URL 不改', () => {
  assert.ok(slugPath('/posts', post.slug).endsWith('/how-to-choose-SHP.html'));
  for (const slug of ['../x', 'a/b', 'a\\b', '%2e%2e', '.', '', 'x'.repeat(121)]) assert.throws(() => slugPath('/posts', slug));
  for (const value of ['../outside', 'snippet/../../x', 'snippet/1.svg', 'https://example.com/a.png']) assert.throws(() => snippetPath(value));
  assert.doesNotThrow(() => validatePosts([post]));
  for (const bad of [{ ...post, tags: 'tag' }, { ...post, htmlSha256: '' }, { ...post, date: 'bad' }, { ...post, date: '2026-02-30T10:00:00' }, { ...post, draft: 'false' }]) assert.throws(() => validatePosts([bad]));
  assert.throws(() => validatePosts([post, { ...post, slug: post.slug.toLowerCase() }]));
  for (const bad of [{ ...friend, name: [] }, { ...friend, url: 'javascript:x' }, { ...friend, avatar: {} }, { ...friend, avatar: null }, { ...friend, description: 'x'.repeat(201) }]) assert.throws(() => validateFriends([bad]));
  assert.throws(() => validateFriends([friend, friend]));
});
test('下载连接前拒绝内网/混合 DNS/危险跳转', async () => {
  const resolver = async () => [{ address: '8.8.8.8', family: 4 }];
  for (const url of ['https://127.0.0.1/', 'https://[::ffff:127.0.0.1]/', 'https://localhost/', 'https://example.com:8080/', 'file:///a']) await assert.rejects(publicTarget(url, resolver));
  await assert.rejects(publicTarget('https://example.com', async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]));
  let calls = 0;
  const request = (url, options, callback) => {
    calls++; const req = new EventEmitter(); req.destroy = () => {};
    queueMicrotask(() => { const res = new PassThrough(); res.statusCode = 302; res.headers = { location: 'https://127.0.0.1/secret' }; callback(res); });
    return req;
  };
  await assert.rejects(download('https://example.com', { resolver, request }));
  assert.equal(calls, 1);
});
test('下载绑定 DNS、TLS 校验和资源/超时边界', async () => {
  const resolver = async () => [{ address: '8.8.8.8', family: 4 }];
  const fake = (headers, chunks, interrupted = false) => (url, options, callback) => {
    assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
    options.lookup('example.com', { all: true }, (e, answers) => assert.equal(answers[0].address, '8.8.8.8'));
    const req = new EventEmitter(); req.destroy = () => {};
    queueMicrotask(() => { const res = new PassThrough(); res.statusCode = 200; res.headers = headers; callback(res);
      for (const c of chunks) res.write(c);
      if (interrupted) res.emit('aborted'); else res.end();
    }); return req;
  };
  assert.equal((await download('https://example.com', { resolver, request: fake({ 'content-type': 'text/html' }, ['ok']), types: ['text/html'] })).toString(), 'ok');
  await assert.rejects(download('https://example.com', { resolver, request: fake({}, ['12345']), maxBytes: 4 }));
  await assert.rejects(download('https://example.com', { resolver, request: fake({ 'content-type': 'text/html' }, ['<html>']), types: ['image/png'] }));
  await assert.rejects(download('https://example.com', { resolver, request: fake({}, ['x'], true) }));
  await assert.rejects(download('https://example.com', { resolver: async () => new Promise(() => {}), timeout: 10 }));
});
test('图片限制仍保留透明 PNG/动画识别，错误文件拒绝', async () => {
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#00000000' } }).png().toBuffer();
  assert.equal((await inspectImage(png)).hasAlpha, true);
  await assert.rejects(inspectImage(Buffer.from('<html>error</html>')));
  await assert.rejects(inspectImage(Buffer.alloc(8388609)));
});
test('真实本机 TLS 下载：域名校验、内容类型、截断和重定向边界', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'download-tls-'));
  let server;
  try {
    const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'),
      '-out', path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=fixture.example', '-addext', 'subjectAltName=DNS:fixture.example'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const ca = await fs.readFile(path.join(dir, 'cert.pem'));
    server = https.createServer({ key: await fs.readFile(path.join(dir, 'key.pem')), cert: ca }, (req, res) => {
      if (req.url === '/private') { res.writeHead(302, { Location: 'https://127.0.0.1/' }); res.end(); }
      else if (req.url === '/redirect') { res.writeHead(302, { Location: '/ok' }); res.end(); }
      else if (req.url === '/truncated') { res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': 500 }); res.write('incomplete'); setTimeout(() => res.destroy(), 10); }
      else if (req.url === '/huge') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('x'.repeat(100)); }
      else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('complete'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const request = (url, options, callback) => {
      options.lookup(url.hostname, { all: true }, (e, ips) => assert.equal(ips[0].address, '8.8.8.8'));
      // 仅测试 transport 在校验后改连本机，生产 URL/校验开关没有放宽。
      return https.get({ ...options, hostname: '127.0.0.1', port: server.address().port, path: url.pathname,
        servername: url.hostname, ca }, callback);
    };
    const opts = { request, resolver: async () => [{ address: '8.8.8.8', family: 4 }], types: ['text/html'] };
    assert.equal((await download('https://fixture.example/redirect', opts)).toString(), 'complete');
    await assert.rejects(download('https://wrong.example/ok', opts));
    await assert.rejects(download('https://fixture.example/private', opts), /non-public/);
    await assert.rejects(download('https://fixture.example/truncated', opts));
    await assert.rejects(download('https://fixture.example/huge', { ...opts, maxBytes: 50 }));
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('暂存失败与切换异常都保留原始产物', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'build-safe-'));
  try {
    await fs.writeFile(path.join(dir, 'data.json'), 'old');
    await assert.rejects(withTransaction(dir, ['data.json'], async stage => { await fs.writeFile(path.join(stage, 'data.json'), 'new'); throw new Error('download failed'); }));
    assert.equal(await fs.readFile(path.join(dir, 'data.json'), 'utf8'), 'old');
    await assert.rejects(withTransaction(dir, ['data.json'], async stage => fs.writeFile(path.join(stage, 'data.json'), 'new'), { checkpoint: async () => { throw new Error('rename failed'); } }));
    assert.equal(await fs.readFile(path.join(dir, 'data.json'), 'utf8'), 'old');
    await withTransaction(dir, ['data.json'], async stage => fs.writeFile(path.join(stage, 'data.json'), 'new'));
    assert.equal(await fs.readFile(path.join(dir, 'data.json'), 'utf8'), 'new');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('新事务目录无 journal 的中断状态不影响旧产物', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'build-stage-'));
  try {
    await fs.writeFile(path.join(dir, 'a'), 'old');
    await fs.mkdir(path.join(dir, '.data-transaction/stage'), { recursive: true });
    await fs.writeFile(path.join(dir, '.data-transaction/stage/a'), 'incomplete');
    await assert.rejects(withTransaction(dir, ['a'], async () => { throw new Error('failure'); }));
    assert.equal(await fs.readFile(path.join(dir, 'a'), 'utf8'), 'old');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('切换进程退出后，下次启动回滚且恢复旧产物', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'build-recover-'));
  try {
    await fs.writeFile(path.join(dir, 'a'), 'old-a'); await fs.writeFile(path.join(dir, 'b'), 'old-b');
    const code = `import { withTransaction } from ${JSON.stringify(new URL('./fileTransaction.mjs', import.meta.url).href)}; import fs from 'node:fs/promises'; import path from 'node:path'; await withTransaction(${JSON.stringify(dir)},['a','b'],async s=>{await fs.writeFile(path.join(s,'a'),'new-a');await fs.writeFile(path.join(s,'b'),'new-b');},{checkpoint:async(phase,name)=>{if(phase==='install'&&name==='a')process.exit(9)}});`;
    assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', code]).status, 9);
    await assert.rejects(withTransaction(dir, ['a', 'b'], async () => { throw new Error('next download failed'); }));
    assert.equal(await fs.readFile(path.join(dir, 'a'), 'utf8'), 'old-a');
    assert.equal(await fs.readFile(path.join(dir, 'b'), 'utf8'), 'old-b');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('坏友链输入不能清空现有 dist', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'build-invalid-'));
  try {
    await fs.mkdir(path.join(dir, 'data/friends'), { recursive: true });
    await fs.cp(path.join(root, 'data/posts'), path.join(dir, 'data/posts'), { recursive: true });
    await fs.writeFile(path.join(dir, 'data/friends/bad.json'), '{"name":[],"url":"https://example.com"}');
    await fs.mkdir(path.join(dir, 'dist')); await fs.writeFile(path.join(dir, 'dist/keep.txt'), 'old');
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { cwd: dir, env: { ...process.env, DATA_URL: 'https://example.invalid' }, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(result.status, 0); assert.equal(await fs.readFile(path.join(dir, 'dist/keep.txt'), 'utf8'), 'old');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
