import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * 保守清理死样式：按选择器逐个裁剪，只做"删除"，不改动其余格式。
 * 判定：选择器里只要出现一个"源码中从不出现的类"，该选择器永远匹配不到元素，可删。
 * 逗号列表只删死的那段，其余保留；规则删空才整条删除。
 * 顶层规则与 @media 内规则同样处理，并同步作用于基准表，保证等价审计通过。
 */
const A_CLASSES = new Set([
  'agent-card-actions', 'agent-card-description', 'agent-card-details', 'agent-card-footer', 'agent-card-heading',
  'agent-history', 'agent-role-card', 'agent-team-disclosures', 'agent-team-footer', 'agent-team-form',
  'model-directory', 'model-empty', 'model-list', 'model-row', 'directory-actions', 'directory-head',
  'provider-builtin-head', 'provider-actions',
  'knowledge-doc-actions', 'knowledge-doc-item', 'knowledge-doc-list', 'knowledge-docs-head',
  'knowledge-table-empty', 'knowledge-time', 'knowledge-type', 'doc-name', 'doc-meta',
  'mailbox-actions', 'mailbox-flow', 'mail-enabled',
  'plugin-editor', 'plugin-install-dialog',
  'tool-card', 'tool-output', 'tools-grid', 'section-row',
  'composer-picker', 'composer-picker-menu', 'picker-group', 'picker-label',
  'help-roles', 'memory-json', 'memory-weight', 'policy-binding', 'pill', 'report-actions', 'bar',
]);

const isDeadSelector = (selector) => [...selector.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].some((m) => A_CLASSES.has(m[1]));

/**
 * 扫描文本并按原始偏移记录编辑动作，最后从后往前落盘，保证未触碰的部分逐字节不变。
 * actions: {start, end, replacement}
 */
function collect(text) {
  const actions = [];
  let index = 0;
  let removedRules = 0;
  let removedParts = 0;

  while (index < text.length) {
    const braceAt = text.indexOf('{', index);
    if (braceAt < 0) break;

    const rawPrelude = text.slice(index, braceAt);
    const commentMatch = /^(\s*(?:\/\*[\s\S]*?\*\/\s*)*)/.exec(rawPrelude);
    const leadingLength = commentMatch ? commentMatch[1].length : 0;

    let depth = 0;
    let cursor = braceAt;
    for (; cursor < text.length; cursor += 1) {
      if (text[cursor] === '{') depth += 1;
      else if (text[cursor] === '}') { depth -= 1; if (depth === 0) { cursor += 1; break; } }
    }

    const preludeRaw = rawPrelude.slice(leadingLength);
    const prelude = preludeRaw.trim();
    const body = text.slice(braceAt + 1, cursor - 1);

    if (prelude.startsWith('@')) {
      const inner = collect(body);
      // 把块内的相对偏移映射回全文
      for (const action of inner.actions) {
        actions.push({ start: braceAt + 1 + action.start, end: braceAt + 1 + action.end, replacement: action.replacement });
      }
      removedRules += inner.removedRules;
      removedParts += inner.removedParts;
    } else if (prelude !== '' && !prelude.startsWith(':root')) {
      const parts = prelude.split(',').map((part) => part.trim()).filter(Boolean);
      const kept = parts.filter((part) => !isDeadSelector(part));
      const dropped = parts.length - kept.length;
      if (dropped > 0) {
        removedParts += dropped;
        if (kept.length === 0) {
          removedRules += 1;
          // 保留前导注释与缩进，删掉「选择器 + 块 + 其后换行」
          const start = index + leadingLength;
          let end = cursor;
          while (end < text.length && (text[end] === '\r' || text[end] === '\n')) end += 1;
          actions.push({ start, end, replacement: '' });
        } else {
          // 只重写选择器列表，保留缩进前缀与块的其余部分
          const indent = preludeRaw.slice(0, preludeRaw.length - preludeRaw.trimStart().length);
          actions.push({ start: index + leadingLength, end: braceAt, replacement: `${indent}${kept.join(', ')} ` });
        }
      }
    }
    index = cursor;
  }
  return { actions, removedRules, removedParts };
}

function apply(text, actions) {
  let out = text;
  for (const action of [...actions].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, action.start) + action.replacement + out.slice(action.end);
  }
  return out;
}

const targets = [
  ...readdirSync('frontend/src/styles').filter((f) => f.endsWith('.css')).map((f) => path.join('frontend/src/styles', f)),
  'src/web/public/styles.css',
];

let rules = 0;
let parts = 0;
for (const file of targets) {
  const source = readFileSync(file, 'utf8');
  const { actions, removedRules, removedParts } = collect(source);
  if (actions.length > 0) writeFileSync(file, apply(source, actions));
  rules += removedRules;
  parts += removedParts;
  process.stdout.write(`${file.padEnd(34)} 规则 ${String(removedRules).padStart(2)} / 选择器段 ${removedParts}\n`);
}
process.stdout.write(`\n合计：整条规则 ${rules}，选择器段 ${parts}\n`);
