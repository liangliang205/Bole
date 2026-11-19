# 样式组织

源：`src/web/public/styles.css`（897 行 / 563 条规则基线）。

## 模块化样式表结构

| 文件 | 职责与内容 | 行数 |
|---|---|---|
| `tokens.css` | 主题变量（`:root` / `html[data-theme="light"]`） | 48 |
| `base.css` | 暗夜变量、reset、`html/body`、`.app` 布局骨架与工具类 | 69 |
| `layout.css` | 侧栏、会话列表与右键菜单、顶栏、空状态页（`.sidebar` / `.topbar` / `.empty-view` / `.session-menu`） | 121 |
| `chat.css` | 对话消息流、Markdown、导出文件卡片、流式预览、HITL/审批、DSH 输入框与选择器 | 204 |
| `panels.css` | 右侧分栏 PDF/DOCX 文件预览、任务抽屉（候选人/合规/成本/证据/工作流） | 127 |
| `settings.css` | 弹窗骨架、设置中心导航、模型提供商、MCP/Skill 插件、Agent 团队与岗位记忆 | 158 |
| `modals.css` | 本地知识库弹窗、招聘邮箱弹窗、帮助中心弹窗与全局响应式断点 | 146 |

校验方式：`pnpm --dir frontend run audit:styles`（`node scripts/audit-styles.mjs`），要求 `0 missing / 0 orphan`——逐条比对基线与全部模块化文件的规则多重集。

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
