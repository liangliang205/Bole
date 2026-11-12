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
