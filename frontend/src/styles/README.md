# 样式组织

源：`src/web/public/styles.css`（897 行 / 563 条规则，旧版仍在用，F6 才删）。

## 现在的三份文件

| 文件 | 内容 | 行数 |
|---|---|---|
| `tokens.css` | 主题变量（`:root` / `html[data-theme]`） | 48 |
| `base.css` | reset、`html/body`、布局骨架与工具类 | 69 |
| `legacy.css` | 其余全部，原样、原顺序 | 777 |

生成方式：`node scripts/split-styles.mjs`（一次性；只搬位置，不改声明）。
校验方式：`node scripts/audit-styles.mjs`，要求 `0 missing / 0 orphan`——逐条比对源与三份文件的规则多重集。

## 为什么不是一上来就 CSS Modules

试过了，机械拆成 12 个 `*.module.css` 之后做了一次跨模块分析，结果是**这张表根本不具备模块自洽性**：

- **39 个类跨模块出现**：`.main`、`.topbar`、`.settings-*`、`.provider-card`、`.model-row`、`.dsh-composer*`、`.attachments` 等；
- **9 条 `@media` 是全站响应式规则**，一条媒体查询同时改写 side/main/drawer/settings 多个区域的类；
- 一旦哈希，这些类会出现"一处哈希、一处字面量"的失配，表现为局部样式突然失效——正好撞在"看不出变化"的验收线上。

所以本期采纳的是**有验证的分阶段做法**：

1. 先做**零风险的组织重构**（本目录三份文件 + 审计脚本），规则内容一字未改；
2. **按组件增量提取** `*.module.css`：每次提取只搬"该组件独占、且不被媒体查询或其它组件引用"的规则，提取后仍要过 `audit-styles.mjs`（规则集合必须与源一致）；
3. 判断标准是机械的：一个类如果只在一个组件文件里出现，才可以被哈希。

## 迁移期约束

- 只允许**等价性修正**（抵消 DOM 结构变化所必需），不允许风格调整；改颜色/间距/字号属于阶段 B。
- 任何样式改动都要重跑 `pnpm audit:styles`。
- 提取模块时，`legacy.css` 里对应规则必须同时删除，避免重复。
