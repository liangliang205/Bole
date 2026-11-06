# 动态 Agent 扩展指南

适用：本地单用户 BoLe，受控执行模板第一版。

## 新增专职检查角色

1. 打开“设置 → Agent 团队 → 创建与编辑”，选择“专职检查”职责并开始填写；需要重新创建时点击“按此职责新建”。
2. 填写角色名称与工作指令，标识和版本自动生成；职责选项使用中文说明，契约自动匹配。
3. 选择快速/深入档位，按需勾选知识库访问角色。主 Agent 和工具助手还可勾选文件工具及会话历史读取权限。更细的参数保留在折叠的高级设置中。
4. 点击“发布并启用”，依次完成保存、校验、注册和激活。仅想暂存时点击“保存草稿”。
5. 在角色卡片点击“配置到团队”，通常保留基础分工，只增加专职检查；点击“保存并用于新会话”。修改相同团队时自动创建新版本，内容未变则复用已有版本。
6. 新会话会自动选中刚保存的团队，上传真实材料即可筛选。已有会话保持原绑定。界面帮助中的“配置 Agent”提供完整操作步骤和术语解释。

完整定义示例（管理界面基本表单优先覆盖 ID、版本、名称、提示词）：

```json
{
  "id": "payment-checker",
  "version": "1.0.0",
  "name": "支付项目检查",
  "description": "核查简历中的支付项目经历，不作淘汰决定",
  "roleTags": ["payment"],
  "templateId": "structured-llm.v1",
  "inputContract": "recruitment.specialist-input@1",
  "outputContract": "recruitment.findings@1",
  "capabilities": ["resume.specialist-check@1"],
  "prompt": "检查支付项目经历。发现必须引用原文；没有依据时返回空 findings，不编造资格或经历。",
  "tier": "flash",
  "tools": [],
  "mcp": [],
  "skills": [],
  "knowledge": { "accessRoles": ["assessor"], "maxContextChars": 3000 },
  "memory": { "read": ["job-profile", "candidate-evidence"], "write": ["task-result"], "scope": "candidate" },
  "limits": { "maxConcurrency": 2, "timeoutMs": 180000, "maxToolSteps": 1 }
}
```

角色输出必须符合目录中的 `recruitment.findings@1`：`findings[]` 中每项有 code、severity（info/warning）、note、evidence（field/quote）。代码将 quote 定位为当前材料的字符范围；不可定位的引用会触发修正重试，不能作为已验证发现落库。

## 替换现有角色

从版本列表“复制为新版本”，保留相应模板和契约，调整提示词、技能及档位。也可以改为新 ID，如 `payment-assessor`；团队的评估槽位必须使用 `builtin.assessor.v1`，代码计分、引用校验与重评机制不会被替换掉。

团队支持两种槽位定义：

```json
{
  "assessor": { "agentId": "payment-assessor", "version": "1.0.0" },
  "parser": { "activeAgentId": "parser" },
  "specialist": { "agentId": "payment-checker", "version": "1.0.0" }
}
```

上面是 slots 的局部示例，完整团队还须包含 coordinator/profiler/fetcher/parser/assessor/auditor 六个槽位。每个槽位明确指定一个角色；能力发现用于查询和人工选择，不再新建候选池。历史候选团队仅兼容读取，不改写历史版本。

激活版本只是更新默认选择指针，不改写已绑定任务。精确绑定不跟随活动指针；`activeAgentId` 在任务创建时解析，此后也冻结。

## 验证、升级与故障处理

- 新增和修改的角色通过实际团队流程验证：保存团队，在新会话中选择，使用少量适当材料检查输出和原文证据。
- 独立试运行页面与提交接口已移除，已有历史记录保留。实际对话中的工具操作沿用所选模式的权限与审批。
- `retire` 停止新任务发现和选择该版本；已绑定任务继续使用原版本。
- 模型提供商身份、网关地址/协议和实际模型 ID 会随任务绑定；切换网关后，旧任务可能要求切回原提供商。密钥不进入快照，可在同一网关下更新。
- 配置文件不再自动覆盖版本库。使用“配置导入预览”，审阅差异后创建新版本。
- 模板代码、模型服务、MCP 实现并不随定义冻结。更改模板语义时请升级模板标识并保留兼容实现；不保证模型输出逐字复现。

## 接口与代码入口

- 模板/能力目录：`GET /api/agent-catalog`。
- 注册与发现：`POST /api/agent-drafts`，随后 validate/register；`GET /api/agents?capabilitiesAll=resume.assess@1`。
- 团队：`GET/POST /api/agent-teams`。
- 任务清单：`GET /api/run/:jobId/agent-manifest`。
- CLI：`pnpm bole agents`，筛选时 `--agent-team payment-team@1.0.0`。

实现位于 `src/agent-platform/`。新增执行语义需修改代码目录及业务适配器；不支持运行时上传任意模块、远程 Schema 或未经校验的工具名。管理写接口不进入模型工具池，部署仍需遵守本地单用户访问边界。
