import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * 删除 A 类死样式：只处理"整条规则的所有选择器都只涉及 A 类"的顶层规则。
 * @media 内的规则暂不处理（两侧文件保持一致即可通过等价审计）。
 */
const A_CLASSES = [
  // 旧 Agent 编辑器
  'agent-card-actions', 'agent-card-description', 'agent-card-details', 'agent-card-footer', 'agent-card-heading',
  'agent-history', 'agent-role-card', 'agent-team-disclosures', 'agent-team-footer', 'agent-team-form',
  // 旧模型目录
  'model-directory', 'model-empty', 'model-list', 'model-row', 'directory-actions', 'directory-head',
  'provider-builtin-head', 'provider-actions',
  // 旧知识库文档列表
  'knowledge-doc-actions', 'knowledge-doc-item', 'knowledge-doc-list', 'knowledge-docs-head',
  'knowledge-table-empty', 'knowledge-time', 'knowledge-type', 'doc-name', 'doc-meta',
  // 旧邮箱
  'mailbox-actions', 'mailbox-flow', 'mail-enabled',
  // 旧插件编辑器
  'plugin-editor', 'plugin-install-dialog',
  // 旧工具 / 工作流
  'tool-card', 'tool-output', 'tools-grid', 'section-row',
  // 旧 composer 选择器
  'composer-picker', 'composer-picker-menu', 'picker-group', 'picker-label',
  // 其它
  'help-roles', 'memory-json', 'memory-weight', 'policy-binding', 'pill', 'report-actions', 'bar',
];

const hasClass = (selector, name) => new RegExp(`\\.${name}(?![\\w-])`).test(selector);
const onlyDead = (selector) => {
  const classes = [...selector.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]);
  const deadHits = classes.filter((name) => A_CLASSES.includes(name));
  if (deadHits.length === 0) return false;
  // 规则里只要出现"非 A 类"的类，就保留整条（可能被别的组件用到）
  const otherClasses = classes.filter((name) => !A_CLASSES.includes(name));
  // .btn/.tag 这类全局工具类不算"使用方"，允许连带删除
  const allowlist = new Set(['btn', 'ghost', 'primary', 'block', 'danger-text', 'tag', 'muted', 'input', 'hidden', 'active', 'ok', 'danger', 'warn']);
  return otherClasses.every((name) => allowlist.has(name));
};

/** 删除顶层规则（不进入 @media 等块内部）。 */
function prune(text) {
  let out = '';
  let index = 0;
  let removed = 0;
  let kept = 0;
  while (index < text.length) {
    const braceOpen = text.indexOf('{', index);
    if (braceOpen < 0) { out += text.slice(index); break; }
    // 选择器文本（可能前面带注释与空白）
    const selectorRaw = text.slice(index, braceOpen);
    // 跳过 @ 规则与注释块：整体保留到配对的 }
    const trimmed = selectorRaw.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    let depth = 0;
    let cursor = braceOpen;
    for (; cursor < text.length; cursor += 1) {
      if (text[cursor] === '{') depth += 1;
      else if (text[cursor] === '}') { depth -= 1; if (depth === 0) { cursor += 1; break; } }
    }
    const block = text.slice(index, cursor);
    if (trimmed.startsWith('@') || trimmed === '' || /^\s*:root/.test(trimmed)) {
      out += block;
      kept += 1;
    } else {
      const selectors = trimmed.split(',').map((part) => part.trim()).filter(Boolean);
      if (selectors.length > 0 && selectors.every(onlyDead)) {
        removed += 1;
        // 同时吞掉紧随其后的空行，避免留下空洞
        while (text[cursor] === '\n' || text[cursor] === '\r') cursor += 1;
      } else {
        out += block;
        kept += 1;
      }
    }
    index = cursor;
  }
  return { text: out, removed, kept };
}

const targets = [
  ...readdirSync('frontend/src/styles').filter((f) => f.endsWith('.css')).map((f) => path.join('frontend/src/styles', f)),
  'src/web/public/styles.css',
];

let totalRemoved = 0;
for (const file of targets) {
  const source = readFileSync(file, 'utf8');
  const result = prune(source);
  if (result.removed > 0) {
    writeFileSync(file, result.text);
    totalRemoved += result.removed;
  }
  process.stdout.write(`${file.padEnd(34)} 删除 ${result.removed} 条，保留 ${result.kept} 条\n`);
}
process.stdout.write(`\n共删除 ${totalRemoved} 条顶层规则\n`);
