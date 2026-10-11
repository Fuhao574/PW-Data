/** 博客构建期渲染：原生 HTML 只作为文字，链接与图片使用协议白名单。 */
import { Marked, Renderer } from 'marked';
import hljs from 'highlight.js/lib/core';
import php from 'highlight.js/lib/languages/php';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';

for (const [name, language] of Object.entries({ php, typescript, javascript, json, bash, xml, css, yaml, sql })) {
  hljs.registerLanguage(name, language);
}

const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escapeAttr = (text) => escapeHtml(text).replace(/'/g, '&#39;');
const aliases = new Map([['ts', 'typescript'], ['js', 'javascript'], ['sh', 'bash'], ['shell', 'bash'], ['html', 'xml']]);

function safeUrl(value, image = false) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) return null;
  // 保留原有 HTTP(S)、站内绝对路径和锚点；mailto 只适用于链接。
  return /^(?:https?:|#|\/)/i.test(value) || (!image && /^mailto:/i.test(value)) ? value : null;
}

const renderer = new Renderer();
renderer.html = ({ text }) => escapeHtml(text);
renderer.link = function ({ href, title, tokens }) {
  // 必须通过同一 parser 渲染内部 token：既保留 Markdown 格式，也让嵌套 HTML 经过 html() 转义。
  const label = this.parser.parseInline(tokens);
  const url = safeUrl(href);
  if (url === null) return label;
  return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${escapeAttr(title)}"` : ''}>${label}</a>`;
};
renderer.image = ({ href, title, text }) => {
  const url = safeUrl(href, true);
  if (url === null) return escapeHtml(text);
  return `<img src="${escapeAttr(url)}" alt="${escapeAttr(text)}"${title ? ` title="${escapeAttr(title)}"` : ''}>`;
};
renderer.code = ({ text, lang }) => {
  const language = (lang || '').trim().toLowerCase();
  // 未知但合法的语言仍显示标签（如 tsx）；非法属性字符或超长标签统一退回 text。
  const target = /^[a-z0-9][a-z0-9_+-]{0,31}$/.test(language) ? (aliases.get(language) || language) : 'text';
  const highlighted = hljs.getLanguage(target)
    ? hljs.highlight(text, { language: target, ignoreIllegals: true }).value
    : escapeHtml(text);
  const label = escapeAttr(target);
  return `<pre data-lang="${label}"><code class="hljs language-${label}">${highlighted}</code></pre>`;
};

// 独立实例，避免构建脚本或测试改变 marked 的全局选项。
const markdown = new Marked({ gfm: true, breaks: true, renderer, async: false });

export function renderPost(raw) {
  return markdown.parse(raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''));
}
