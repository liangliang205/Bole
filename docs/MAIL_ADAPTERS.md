# 通用招聘邮箱适配

招聘邮箱是侧栏独立入口，位于知识库上方。领域流程只使用五项能力：身份、搜索、读取、下载附件和发送。腾讯 Agent Mail 是内置适配器；其他邮箱 Skill 可以关联一个 CLI 适配器，声明操作参数与 JSON 字段映射，无需修改招聘流程。

在招聘邮箱面板展开「接入其他邮箱 Skill」，选定已安装的 Skill，填入适配配置并保存。也支持不关联 Skill 的独立 CLI。只有技能文案并不等于已经拥有可执行的邮箱接口；配置后应先检查连接。

## 声明接口

`POST /api/mail/adapters` 保存配置；`GET /api/mail/adapters` 列出适配器和已启用的 Skills。可以按相同 ID 保存新配置。面板也提供以下通用示例：

```json
{
  "id": "company-mail",
  "name": "公司招聘邮箱",
  "command": "D:/tools/company-mail.exe",
  "baseArgs": [],
  "operations": {
    "identity": {"args": ["whoami", "--json"], "resultPath": "data"},
    "search": {"args": ["search", "--json-input", "{input}"], "resultPath": "data"},
    "read": {"args": ["read", "--id", "{messageId}", "--json"], "resultPath": "data"},
    "download": {"args": ["download", "--message", "{messageId}", "--attachment", "{attachmentId}", "--directory", "{outputDir}", "--json"], "resultPath": "data"},
    "send": {"args": ["send", "--json-input", "{input}"], "resultPath": "data"}
  },
  "fields": {
    "email": "email",
    "items": "messages",
    "messageId": "id",
    "nextCursor": "nextCursor",
    "sender": "from.email",
    "attachments": "attachments",
    "attachmentId": "id",
    "filename": "name",
    "size": "size",
    "savedPath": "path"
  }
}
```

可选 `skillId` 指向已安装的 Skill；新任务要求关联 Skill 已启用。`command` 是可执行程序路径，Windows 上 Node CLI 应使用 node.exe 并把脚本路径放进 baseArgs，不使用 cmd / PowerShell 字符串拼接。接口必须以 stdout 返回 JSON，失败时非零退出或返回 `ok:false`。授权由各 CLI 自己管理。

每个操作先取 `resultPath`，再对结果应用 fields；空路径表示整个 JSON。字段路径支持点分层和数组索引，如 `aliases.0.email`。items 指向搜索列表，messageId 相对于列表中单项；附件字段相对于附件单项。没有 nextCursor 表示单页，配置后以返回的非空游标判断后续页。可选的 `subject` 用于垃圾邮件判别；CLI 不提供该字段时只按发件人规则判断。

参数占位符按操作提供：

- identity：无输入。
- search：query、after、cursor、limit。
- read：messageId。
- download：messageId、attachmentId、outputDir。
- send：to、subject、body。
- 所有操作支持 `{input}`，替换为该操作输入的 JSON 字符串。单值占位符如 `{messageId}` 始终是一个独立参数，不作为 shell 代码执行。缺省值为空字符串，CLI 应按需要处理。

消息及附件 ID 无 QQ 前缀要求。下载必须落在任务提供的 outputDir 内；平台继续校验路径、大小和格式。发送接口须返回非空回执，异常或未知结果不会自动重发。适配器本身负责 CLI 的确认参数映射；平台只会在 HR 批准具体邮件后调用发送能力。

## 通过邮箱 MCP 接入（IMAP 只读）

内置的只读 IMAP 服务位于 `src/mail-mcp/`，配置里用 `kind: "mcp"` 接入：

```json
{
  "kind": "mcp",
  "id": "hr-qq",
  "name": "HR 主邮箱",
  "accountRef": "qq-hr",
  "folder": "INBOX",
  "callTimeoutMs": 120000
}
```

`accountRef` 指向本机 `data/mail/accounts.json` 里的账号。凭据由 CLI 交互式录入并用 `SecretBox` 加密，不会作为工具参数传给模型，也不会进入适配器快照或数据库明文。agent 侧只有 `identity`、`search`、`read`、`download` 四个只读工具，没有发送和删除能力。

```powershell
pnpm bole mail-account add qq-hr --vendor qq --user hr@qq.com
pnpm bole mail-account list
pnpm bole mail-account test qq-hr
pnpm bole mail-account remove qq-hr
```

`--vendor` 支持 `qq`、`163`、`126`、`icloud`；自建或企业邮箱改用 `--host imap.example.com [--port 993]`。`add` 会提示输入 IMAP 授权码且不回显，`test` 会真正登录一次并返回邮箱地址，用来先排除授权与网络问题。

MCP 侧搜索只返回带可导入附件（PDF/Word、图片、TXT/MD/HTML）且单附件不超过 25MB 的邮件；`query` 按主题或发件人在本地过滤（中文搜索条件在 QQ/163 服务端不可靠，因此不依赖 IMAP SEARCH 的关键词）。附件格式、大小和落盘路径在 Bole 侧再次校验。

下载附件前的筛选分四步，任何一步判定为非简历都会记录 `mail.message.skipped` 并跳过该附件：

1. 发件人与主题规则：发件人为空、发件人就是当前招聘邮箱自身、发件人本地部分是 `noreply`、`mailer-daemon`、`postmaster`、`bounces` 等自动地址，或主题包含退订、`newsletter`、`unsubscribe`，整封邮件跳过。
2. 关键词粗筛：主题或附件名命中简历、应聘、求职、履历、面试、`resume`、`cv`、`application` 时记为高置信命中（`mail.triage.keyword` 事件）。未命中不会丢弃，继续后面两步，避免主题为空或写法特殊的真实简历漏掉。
3. 文件头校验：下载后读取文件头，放行 PDF（`%PDF-`）、DOCX（ZIP 且含 `word/` 或 `[Content_Types].xml`）、DOC（OLE 头），以及 JPEG/PNG/GIF/WebP/BMP/TIFF 图片；TXT/MD/HTML 没有魔数，按扩展名加 UTF-8/GBK 可打印字符比例判断。扩展名和实际类型必须同族，否则丢弃。
4. 模型二次识别：PDF/DOCX/TXT/MD/HTML 提取正文前 1500 字，用 flash 档模型判定是否为个人简历；图片直接用 flash 视觉模型判定（`detail=low`），不做 OCR 转写。明确判定为非简历才拦截；旧版 doc、无文本层的扫描版 PDF、视觉模型不支持的 BMP/TIFF 返回 unknown 放行，交给后续解析；模型异常时同样放行并记录 `mail.classifier.unknown`，避免因模型故障漏简历。

## 任务与版本

任务创建时保存适配器配置快照；每个附件也保留当时的配置。候选人联系审批绑定来源配置、邮箱身份、收件人和正文，不随之后的适配器编辑改变。旧 Agent Mail 来源继续使用原内置适配器。

本版工作流为 1.5.0，保留历史定义，不覆盖旧版本。当前驱动覆盖能返回 JSON 的本机 CLI 和 `kind: "mcp"` 的只读邮箱 MCP 服务；仅返回人类可读文本的 CLI 或仅有文档的 Skill，仍需要增加对应驱动或桥接程序，不能直接视作可用。

集成测试使用与 QQ 命令和字段均不同的真实测试子进程，覆盖导入、筛选、非 QQ ID、配置快照、HR 审批及发信、回执缺失与未知适配器错误。未用未知第三方邮箱账号做联网验证。
