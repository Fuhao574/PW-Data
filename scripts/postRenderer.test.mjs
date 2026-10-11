import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseFragment } from 'parse5';
import { renderPost } from './postRenderer.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const allowedTags = new Set(['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote',
  'ul', 'ol', 'li', 'strong', 'em', 'del', 'a', 'img', 'pre', 'code', 'span',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input']);
const allowedAttributes = {
  a: new Set(['href', 'title', 'target', 'rel']),
  img: new Set(['src', 'alt', 'title']),
  pre: new Set(['data-lang']),
  code: new Set(['class']),
  span: new Set(['class']),
  ol: new Set(['start']),
  th: new Set(['align']),
  td: new Set(['align']),
  input: new Set(['type', 'disabled', 'checked']),
};

function elements(node) {
  return (node.childNodes ?? []).flatMap(child => [
    ...(child.tagName ? [child] : []), ...elements(child),
  ]);
}
const attr = (node, name) => node.attrs.find(a => a.name === name)?.value;
const text = node => node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(text).join('');

/** 检查浏览器会解析出的标签与属性，不把代码示例中已转义的危险文字误判为注入。 */
function assertSafe(html) {
  const fragment = parseFragment(html);
  for (const node of elements(fragment)) {
    assert.ok(allowedTags.has(node.tagName), `不允许的标签：${node.tagName}`);
    for (const attribute of node.attrs) {
      assert.ok(allowedAttributes[node.tagName]?.has(attribute.name), `不允许的属性：${node.tagName}.${attribute.name}`);
      assert.ok(!attribute.namespace, '不允许命名空间属性');
      if (attribute.name === 'href' || attribute.name === 'src') {
        assert.ok(/^(?:https?:|#|\/)/i.test(attribute.value) ||
          (attribute.name === 'href' && /^mailto:/i.test(attribute.value)), '危险 URL 协议');
        assert.ok(!/[\u0000-\u0020\u007f]/.test(attribute.value), 'URL 含控制字符或空白');
      }
    }
    if (node.tagName === 'a') {
      assert.equal(attr(node, 'target'), '_blank');
      assert.equal(attr(node, 'rel'), 'noopener noreferrer');
    }
    if (node.tagName === 'pre') assert.match(attr(node, 'data-lang'), /^[a-z0-9][a-z0-9_+-]{0,31}$/);
    if (node.tagName === 'code' && attr(node, 'class')) assert.match(attr(node, 'class'), /^hljs language-[a-z0-9][a-z0-9_+-]{0,31}$/);
    if (node.tagName === 'input') {
      assert.equal(attr(node, 'type'), 'checkbox');
      assert.notEqual(attr(node, 'disabled'), undefined);
    }
  }
  return fragment;
}

test('安全检查能识别真正的标签/属性，而不是仅检查危险字符串', () => {
  assert.throws(() => assertSafe('<script>alert(1)</script>'));
  assert.throws(() => assertSafe('<img src="/safe.png" onerror="alert(1)">'));
  assert.throws(() => assertSafe('<a href="javascript:alert(1)">x</a>'));
  assert.doesNotThrow(() => assertSafe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'));
});

for (const payload of ['<script>alert(1)</script>', '<img src=x onerror="alert(1)">',
  '<svg onload="alert(1)"></svg>', '<iframe src="https://example.com"></iframe>',
  '<object data="https://example.com"></object>', '<embed src="https://example.com">']) {
  test(`原生 HTML 只能作为文字：${payload.split('>')[0]}>`, () => {
    const fragment = assertSafe(renderPost(payload));
    assert.ok(elements(fragment).every(node => node.tagName === 'p'));
    assert.equal(text(fragment).trim(), payload);
  });
}

test('链接文字里的原生 HTML 不得绕过 renderer.html', () => {
  const payload = '<img src=x onerror="alert(1)">';
  const fragment = assertSafe(renderPost(`[${payload}](https://example.com)`));
  const link = elements(fragment).find(n => n.tagName === 'a');
  assert.equal(text(link), payload);
  assert.equal(elements(link).length, 0);
});

test('链接文字保留加粗、斜体、删除线、行内代码和 Markdown 图片', () => {
  const fragment = assertSafe(renderPost('[**bold** *italic* ~~deleted~~ `code` ![pic](/pic.png)](https://example.com)'));
  const link = elements(fragment).find(n => n.tagName === 'a');
  assert.deepEqual(elements(link).map(n => n.tagName), ['strong', 'em', 'del', 'code', 'img']);
});

test('嵌套在加粗、表格、引用、图片 alt 和引用式链接中的 HTML 同样安全', () => {
  for (const raw of ['[**<svg onload=alert(1)>**](https://example.com)',
    '| head |\n| --- |\n| [<img src=x onerror=alert(1)>](https://example.com) |',
    '> [<iframe src=x>](https://example.com)',
    '![<img src=x onerror=alert(1)>](/safe.png)',
    '[<img src=x onerror=alert(1)>][ref]\n\n[ref]: https://example.com']) {
    assertSafe(renderPost(raw));
  }
});

test('链接 title 与图片 alt/title 的引号不能新增属性', () => {
  const fragment = assertSafe(renderPost(`[title](/safe '" onmouseover="alert(1)')

![" onerror="alert(1)](/safe.png '" onload="alert(1)')`));
  assert.equal(elements(fragment).filter(n => n.tagName === 'a' || n.tagName === 'img').length, 2);
  assert.equal(attr(elements(fragment).find(n => n.tagName === 'a'), 'title'), '" onmouseover="alert(1)');
  assert.equal(attr(elements(fragment).find(n => n.tagName === 'img'), 'alt'), '" onerror="alert(1)');
});

for (const url of ['javascript:alert%281%29', 'JaVaScRiPt:alert%281%29', 'java&#x73;cript:alert%281%29',
  'java&#9;script:alert%281%29', 'java&#10;script:alert%281%29', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox%281%29']) {
  test(`危险链接/图片不生成 URL 属性：${url}`, () => {
    for (const raw of [`[**blocked**](${url})`, `![blocked](${url})`]) {
      const fragment = assertSafe(renderPost(raw));
      assert.ok(!elements(fragment).some(n => n.tagName === 'a' || n.tagName === 'img'));
    }
  });
}

test('mailto 只用于链接，不用于图片', () => {
  const fragment = assertSafe(renderPost('[mail](mailto:hello@example.com) ![mail](mailto:hello@example.com)'));
  assert.equal(elements(fragment).filter(n => n.tagName === 'a').length, 1);
  assert.equal(elements(fragment).filter(n => n.tagName === 'img').length, 0);
});

test('HTTP(S)、站内绝对路径、锚点、协议相对地址和正常图片保持兼容', () => {
  for (const url of ['https://example.com/a?x=1&y=2', 'http://example.com', '/posts/hello', '#section', '//cdn.example.com/a.png']) {
    const fragment = assertSafe(renderPost(`[safe](${url}) ![safe](${url})`));
    assert.equal(attr(elements(fragment).find(n => n.tagName === 'a'), 'href'), url);
    assert.equal(attr(elements(fragment).find(n => n.tagName === 'img'), 'src'), url);
  }
});

for (const language of ['x" onmouseover="alert(1)', 'x&#34; onload=alert(1)', 'x><img/src=x/onerror=alert(1)>',
  "x' onclick='alert(1)", 'constructor', '__proto__', 'x'.repeat(100)]) {
  test(`代码语言名不能注入 HTML 属性：${language.slice(0, 40)}`, () => {
    const fragment = assertSafe(renderPost('```' + language + '\n<script>alert(1)</script>\n```'));
    const pre = elements(fragment).find(n => n.tagName === 'pre');
    assert.equal(text(pre), '<script>alert(1)</script>');
  });
}

test('原有代码高亮与语言别名保持兼容', () => {
  for (const [input, expected] of [['ts', 'typescript'], ['js', 'javascript'], ['sh', 'bash'], ['shell', 'bash'],
    ['html', 'xml'], ['php', 'php'], ['json', 'json'], ['css', 'css'], ['yaml', 'yaml'], ['sql', 'sql']]) {
    const fragment = assertSafe(renderPost('```' + input + '\nconst x = "<img src=x onerror=alert(1)>";\n```'));
    assert.equal(attr(elements(fragment).find(n => n.tagName === 'pre'), 'data-lang'), expected);
  }
  const fragment = assertSafe(renderPost('```ts\nconst x = 1;\n```'));
  assert.ok(elements(fragment).some(n => n.tagName === 'span' && attr(n, 'class').startsWith('hljs-')));
});

test('无语言/非法语言回退 text，合法未知语言保留标签和源码', () => {
  for (const [language, label] of [['', 'text'], ['x" onload="alert(1)', 'text'], ['tsx', 'tsx'], ['rust', 'rust']]) {
    const fragment = assertSafe(renderPost('```' + language + '\n<div>& hello</div>\n```'));
    assert.equal(attr(elements(fragment).find(n => n.tagName === 'pre'), 'data-lang'), label);
    assert.equal(text(elements(fragment).find(n => n.tagName === 'pre')), '<div>& hello</div>');
  }
});

test('frontmatter 不进入正文；GFM 表格/任务列表/换行保持正常', () => {
  const fragment = assertSafe(renderPost('---\r\ntitle: secret\r\n---\r\n# Heading\n\nfirst\nsecond\n\n- [x] done\n\n| a | b |\n| :--- | ---: |\n| 1 | 2 |'));
  assert.ok(!text(fragment).includes('secret'));
  for (const tag of ['h1', 'br', 'input', 'table']) assert.ok(elements(fragment).some(n => n.tagName === tag));
});

const postFiles = (await fs.readdir(path.join(root, 'data/posts'))).filter(name => name.endsWith('.md')).sort();
for (const file of postFiles) {
  test(`实际文章安全回归：${file}`, async () => {
    const raw = await fs.readFile(path.join(root, 'data/posts', file), 'utf8');
    const html = renderPost(raw);
    assert.ok(html.length > 0);
    assertSafe(html);
    assert.equal(renderPost(raw), html, '渲染应保持确定性');
  });
}

test('构建集成：使用同一渲染器生成真实文章，草稿不输出 HTML（离线隔离目录）', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'friends-post-renderer-'));
  try {
    await fs.mkdir(path.join(dir, 'data/friends'), { recursive: true });
    await fs.cp(path.join(root, 'data/posts'), path.join(dir, 'data/posts'), { recursive: true });
    await fs.mkdir(path.join(dir, 'dist/data'), { recursive: true });
    await fs.writeFile(path.join(dir, 'dist/data/friends.json'), '{"friends":[]}');
    // 本地旧产物阻止线上兜底请求；空友链目录阻止头像请求，测试只覆盖文章构建。
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/build.mjs')], {
      cwd: dir, env: { ...process.env, DATA_URL: 'https://example.invalid' }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    const metas = JSON.parse(await fs.readFile(path.join(dir, 'dist/data/posts.json'), 'utf8'));
    assert.equal(metas.length, postFiles.length);
    const files = await fs.readdir(path.join(dir, 'dist/posts'));
    assert.deepEqual(files.sort(), metas.filter(m => !m.draft).map(m => `${m.slug}.html`).sort());
    for (const meta of metas.filter(m => !m.draft)) {
      const html = await fs.readFile(path.join(dir, 'dist/posts', `${meta.slug}.html`), 'utf8');
      assertSafe(html);
      const raw = await fs.readFile(path.join(root, 'data/posts', `${meta.slug}.md`), 'utf8');
      assert.equal(html, renderPost(raw));
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
