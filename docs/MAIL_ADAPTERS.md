# 通用招聘邮箱适配

招聘邮箱是侧栏独立入口，位于知识库上方。领域流程只使用五项能力：身份、搜索、读取、下载附件和发送。不预设服务商，也不因安装某个特定名称的 Skill 自动创建连接。不同邮箱 Skill 可以关联 CLI 适配器，声明操作参数与 JSON 字段映射，无需修改招聘流程。

直接在首页输入「请阅读 https://example.org/setup 帮我安装并连接招聘邮箱」即可开始接入对话，无需先上传简历。招聘邮箱面板只用于查看连接状态、检查连接和选择默认邮箱，不提供另一套对话输入。选择自动保存在浏览器，并传给主页 Agent；用户未明确指定其他邮箱时，Agent 优先使用所选连接，无需因存在多个连接而重复询问。

邮箱管理页为支持认证的连接提供「认证邮箱」。点击后后台启动 OAuth 登录，页面原样显示 CLI 输出的授权 URL；授权进程在后台等待，页面定时查询状态，完成后调用身份接口验证邮箱地址。认证失败或超时只显示错误，不会自动重试；用户明确点击「重新认证」才会发起新流程。当前 `agently-mail` 使用 `auth login`，验证使用已配置的 `+me` 身份操作。

伯乐会读取公开 HTTPS 文档、按需安装 npm CLI 和插件、读取帮助与 Skill、生成接口映射。需要浏览器授权时展示 CLI 返回的原始链接；用户完成后回复「已授权，请检查连接」，通过真实邮箱身份检查后选择该连接。安装失败或授权失败不会伪报成功。

CLI 安装在 data/mail-clis 下，不修改项目依赖或全局软件。OAuth 进程跨对话等待，最长五分钟，不会自动重复启动；服务重启会结束尚未完成的授权，之后应先检查已有登录状态。对话消息和操作记录保存在台账中；不向用户索取密码或令牌。身份探测仅允许只读身份命令，并隐藏 token 等字段。对话不提供发信或通用 shell 工具；简历收取通过原有招聘工作流执行。安装文档限公开 HTTPS，拒绝内网地址，限制跳转、大小及超时。

## 用对话收取和筛选

用户可直接说「筛选上周收到的全栈工程师简历，需要 React 和 Node.js」，不需要选择来源开关、填写日期或邮件关键词。Agent 根据浏览器传入的时区及服务器当前时间理解相对日期，发现已接入且启用的邮箱；单个连接可直接采用，多连接有歧义时才追问。

`start_mail_screening` 接收岗位 requirements、providerId、邮箱搜索 query、含起点的 after、不含终点的 before 和 maxMessages（默认 50，最大 200）。Agent 根据插件文档转换实际搜索条件，可使用 query 中的日期语法或覆盖该任务的 searchArgs；不允许替换搜索操作为发信等其他子命令。未提供可执行的截止时间条件时会拒绝启动，不会悄悄丢掉上界。无法确定搜索语法时先读取 Skill/CLI 帮助，仍不支持则说明缺少的能力。

每个任务保存独立搜索配置，原邮箱连接不随本次日期条件更改，任务副本不出现在连接列表中。启动前验证真实邮箱身份，随后将当前工作台对话转为招聘任务，沿用已有画像、简历接入、评估、核查、报告与 HR 邮件审批。返回“已启动”仅代表已经开始执行，不能当作筛选完成；后续进度和需要确认的条件仍显示在同一会话。岗位类型与技能进入评估要求，不只依赖邮件主题检索来判断是否匹配。

页面默认通过对话自动维护连接，保留后台适配器 API 供开发维护，也支持不关联 Skill 的独立 CLI。只有技能文案并不等于已经拥有可执行的邮箱接口；配置后应先检查连接。连接名称取自配置的 name，不绑定邮箱品牌。删除或停用关联 Skill 后，连接从可用列表移除，清除浏览器中的旧选择和收取开关；独立 CLI 不受影响。

## 声明接口

`POST /api/mail/adapters` 保存配置；`GET /api/mail/adapters` 只列出可用适配器和已启用的 Skills。可以按相同 ID 保存新配置。检查连接和创建新任务必须显式指定已配置的 providerId，不会回退到预设邮箱。面板也提供以下通用示例：

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

每个操作先取 `resultPath`，再对结果应用 fields；空路径表示整个 JSON。字段路径支持点分层和数组索引，如 `aliases.0.email`。items 指向搜索列表，messageId 相对于列表中单项；附件字段相对于附件单项。没有 nextCursor 表示单页，配置后以返回的非空游标判断后续页。

参数占位符按操作提供：

- identity：无输入。
- search：query、after、cursor、limit。
- read：messageId。
- download：messageId、attachmentId、outputDir。
- send：to、subject、body。
- 所有操作支持 `{input}`，替换为该操作输入的 JSON 字符串。单值占位符如 `{messageId}` 始终是一个独立参数，不作为 shell 代码执行。缺省值为空字符串，CLI 应按需要处理。

消息及附件 ID 无 QQ 前缀要求。下载必须落在任务提供的 outputDir 内；平台继续校验路径、大小和格式。发送接口须返回非空回执，异常或未知结果不会自动重发。适配器本身负责 CLI 的确认参数映射；平台只会在 HR 批准具体邮件后调用发送能力。

## 任务与版本

任务创建时保存适配器配置快照；每个附件也保留当时的配置。候选人联系审批绑定来源配置、邮箱身份、收件人和正文，不随之后的适配器编辑改变。旧 Agent Mail 来源继续使用原内置适配器。

本版工作流为 1.5.0，保留历史定义，不覆盖旧版本。当前通用驱动适用于能返回 JSON 的本机 CLI；MCP 邮箱工具、仅返回人类可读文本的 CLI 或仅有文档的 Skill，需要增加对应驱动或桥接程序，不能直接视作可用。

集成测试使用与 QQ 命令和字段均不同的真实测试子进程，覆盖导入、筛选、非 QQ ID、配置快照、HR 审批及发信、回执缺失与未知适配器错误。未用未知第三方邮箱账号做联网验证。
