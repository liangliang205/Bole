# 插件安装与技能管理

设置 → 插件使用统一的「添加插件」入口和已安装列表。用户不需要先区分 MCP 与 Skill：粘贴安装命令，点击「交给 Agent 安装」，系统使用当前配置的 LLM 分析名称、用途和适用角色，再执行对应的安装流程。结果会说明安装和连接是否成功。

## 命令安装

支持的常见形式：

```text
npx skills add https://agent.qq.com --skill agently-mail -g -y
npx skills add owner/repository --skill skill-name
npx -y @modelcontextprotocol/server-filesystem D:/resumes
pnpm dlx @modelcontextprotocol/server-filesystem D:/resumes
npm install -g @modelcontextprotocol/server-filesystem
https://example.com/mcp
```

MCP npm 包使用项目配套的 npm/npx 运行，不依赖机器上恰好存在 npm 命令。`npm install -g` 输入转换为 BoLe 管理的 npm 包启动配置，不修改系统全局包。HTTPS 地址按 MCP 端点处理；Skill 仓库或网站地址应放在 `skills add` 命令中。暂不支持任意 shell 脚本、管道、串联命令、uvx/Python 安装命令等；不支持的方式可使用手动配置。

输入命令只负责提供安装源和参数，LLM 不得改写可执行安装目标。凭据应通过手动配置的加密字段填写，不放进安装命令。命令安装使用当前模型提供商，因此需要先配置有效 API Key。

Skill 安装由项目依赖的 Skills CLI 下载到 `data/skill-packages/<安装ID>`，统一使用项目级范围，不写入 Codex、Claude 等工具的全局配置。配套文件保留，SKILL.md 内容注册到 BoLe。指定的 Skill 缺失、内容不合法或下载失败时不提交注册记录；多 Skill 注册使用数据库事务。

Windows Node 24 环境下，已观察到第三方安装器在写完文件后以 `UV_HANDLE_CLOSING` 断言退出。仅在日志明确显示安装完成且匹配该异常时，系统校验本次下载的 SKILL.md 和所有指定 Skill 后恢复导入，并在安装结果提示此情况；其他非零退出不视为成功。

MCP 安装会保存配置并尝试连接。配置已保存但服务连接失败时，会显示具体连接状态，不宣称工具可用。可在同一列表中继续编辑、测试或停用。

## 手动导入与管理

添加窗口也保留「手动配置工具」和「导入技能文件」。Skills 可上传 Markdown、读取服务器本机 SKILL.md / 含 SKILL.md 的目录，或粘贴编辑内容。YAML frontmatter 支持 name 和 description；无 frontmatter 时可手填名称、ID 和说明。

每个 Skill 可启停、编辑、删除，并分配给主 Agent、画像、解析、评估、核查或专职检查角色。接入器是确定性代码，不加载 Skill。外部 Skill 存在 SQLite 的 `skill_plugins` 表，每次编辑增加修订号，过期编辑会被拒绝。

新任务创建时冻结启用的 Skill 内容、适用角色、修订号和内容哈希，保存到 Agent manifest。只有被分配的角色加载该技能。编辑、停用或删除不会改变已有任务；要使用新版本，请新建任务。平台内置技能继续由原配置管理。

Skill 是操作指引，不是新增的函数或权限。导入技能不会自动执行配套脚本、安装二次依赖或增加 MCP / Python 权限。邮箱接入和发送仍通过 BoLe 原生招聘邮箱流程，HR 仍需审阅候选人与具体邮件后批准发送。

## API 与验证

- `POST /api/plugins/install`：`{"command":"npx skills add …"}`，由当前 LLM 分析并安装。
- `POST /api/skills/preview`：`{"content":"…"}` 或 `{"path":"本机路径"}`，仅预览。
- `GET /api/skills`、`POST /api/skills`：列出 / 注册。
- `PATCH /api/skills/:id`：编辑或启停，必须包含当前 `revision`。
- `DELETE /api/skills/:id`：删除注册；旧任务快照及安装产物保留。
- MCP 原 API 保持兼容。

集成测试覆盖命令识别、LLM 元数据规划、固定安装来源、下载失败、实际注册、角色注入、任务快照、编辑冲突以及 HTTP 生命周期。真实网络冒烟已使用官方 Agent Mail Skill，在隔离目录验证下载、校验和注册，未向用户插件库安装示例，也未发送邮件。
