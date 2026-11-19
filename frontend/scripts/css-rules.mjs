/**
 * 极简 CSS 规则切分器：只处理平铺规则与顶层 at-rule 块（@media 等）。
 * 用途：把旧全局样式表的规则作为可机械比对的单位。
 */

/** 去掉注释并压缩空白，使同一规则在源与目标里得到相同的键。 */
export function normalize(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // CSS Modules 的 :global(.x) 与全局 .x 是同一条规则，比对时抹平
    .replace(/:global\(([^)]*)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,>+~])\s*/g, '$1')
    .trim();
}

/** 把一段 CSS 拆成 { selector, body, text }；顶层 at-rule 整体作为一条规则。 */
export function splitRules(css) {
  const rules = [];
  let index = 0;
  let prelude = '';
  let depth = 0;
  let bodyStart = 0;

  while (index < css.length) {
    const char = css[index];
    if (char === '{') {
      if (depth === 0) bodyStart = index + 1;
      depth += 1;
      index += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const body = css.slice(bodyStart, index);
        rules.push({ selector: normalize(prelude), body: normalize(body), text: `${prelude.trim()}{${body.trim()}}` });
        prelude = '';
      }
      index += 1;
      continue;
    }
    if (depth === 0) prelude += char;
    index += 1;
  }
  return rules;
}

/** 规则的比对键：选择器 + 声明块（顺序敏感）。 */
export function ruleKey(rule) {
  return `${rule.selector}||${rule.body}`;
}

export function countByKey(rules) {
  const map = new Map();
  for (const rule of rules) {
    const key = ruleKey(rule);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}
