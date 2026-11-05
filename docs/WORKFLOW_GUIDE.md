# 最小代码化工作流

BoLe 提供嵌入式 TypeScript 工作流 SDK，入口为 `src/workflow/index.ts`。流程由项目内可信模块注册，不支持从 HTTP 上传代码或执行任意脚本。

招聘参考实现位于 `src/workflows/recruitment/workflow.ts`。Web 和 CLI 仍调用 `runPipeline`，内部由工作流引擎执行；解析、评估、核查的业务台账和 Agent 版本绑定继续生效。

## 先跑一个例子

```bash
pnpm workflow:example
```

这是无 API Key、内存数据库的确定性 SDK 示例：两条材料并行核查，伪造引用经过循环修正，分别进入嵌套审批子流程，再模拟人工批准并恢复。会输出修正结果、父子运行 ID 和状态。它用于说明控制结构，生产招聘流程仍调用实际 LLM Agent；示例中的 `example-human` 批准逻辑不能复制为生产自动批准。

## 定义流程

```ts
import { z } from 'zod';
import { Ledger } from '../src/core/ledger.ts';
import {
  defineWorkflow, task, sequence, WorkflowRegistry, WorkflowEngine,
} from '../src/workflow/index.ts';

const schema = z.object({ text: z.string() });
const normalize = task({
  id: 'normalize', input: schema, output: schema,
  recovery: 'retry',
  handler: (input, ctx) => {
    // ctx.idempotencyKey 在同一个节点的恢复/重试期间保持不变。
    return { text: input.text.trim() };
  },
});
const workflow = defineWorkflow({
  id: 'document-process', version: '1.0.0',
  input: schema, output: schema,
  implementation: 'source-revision-1',
  body: sequence('main', normalize),
});
const ledger = new Ledger(':memory:');
try {
  const job = ledger.createJob({ title: '示例', requirements: '处理材料' });
  const registry = new WorkflowRegistry().register(workflow);
  const engine = new WorkflowEngine(ledger, registry);
  const result = await engine.start(job.id, 'document-process@1.0.0', { text: ' example ' });
  console.log(result);
} finally { ledger.close(); }
```

节点输入输出必须能够往返 JSON，不能包含函数、类实例、循环引用、`undefined`、非有限数等值；Schema 需支持 `z.toJSONSchema`，避免把转换函数藏在 Schema 中，转换应写为显式任务。顺序相邻节点通过 TypeScript 泛型检查数据兼容性；任务、流程及子流程边界还会执行运行时 Schema 校验。

第一版同一个招聘任务最多绑定一个根工作流。需要独立运行时创建新的任务。`start` 不会覆盖同一任务的版本或输入；恢复请调用 `engine.resume(rootRunId)`。

## 控制结构

| 接口 | 约定 |
| --- | --- |
| `sequence(id, a, b, ...)` | 顺序传递输出；最多五个直接步骤，更多步骤可嵌套组合 |
| `parallel(id, options)` | `items` 产生动态列表，`key` 返回唯一稳定标识，`body` 定义每项处理，`concurrency` 为数字或输入计算函数 |
| `branches(id, options)` | 固定命名分支的并行便捷接口；使用同一并行执行器 |
| `condition(id, { test, then, otherwise })` | `test` 返回布尔值；选择结果保存，恢复时不重新选择 |
| `loop(id, { body, until, maxIterations })` | 至少执行一轮，轮后判断，状态作为下一轮输入；最多 1000 轮，返回 `{ status, iterations, value }` |
| `subworkflow(id, 'id@version', inputSchema, outputSchema)` | 调用已注册的明确版本，保存父子运行关系，校验调用边界 |
| `approval(id, { title, input, payload? })` | 无论默认/严格模式，显式审批节点都要求人工批准；返回原输入 |
| `retain(id, node)` | 输出 `{ input, result }`，便于聚合并行结果时保留上游输入 |

节点 ID 在同一控制节点下必须唯一；并行项的 key 不能重复。不同分支、循环轮次和子流程调用具有独立实例路径，因此不会错误复用另一候选人或另一轮次的结果。

并行的失败策略必须显式选择：

- `collect`：返回有序的 `{ key, ok, value/error }[]`，由下游判断部分失败是否可以继续。
- `fail-fast`：首个失败后停止派发剩余项，等待在途项收束，向上传播失败，不回滚已经发生的外部操作。

审批等待向父节点传播，但其他独立分支仍可执行；父节点不会在审批未完成时成功。拒绝审批属于失败，是否使整个并行节点失败由声明的失败策略决定。

循环耗尽返回 `status: 'exhausted'`，不能解释为验证通过。业务必须显式选择转人工或抛出失败。招聘参考实现将未通过者转人工。

## 接入 Agent

工作流决定控制结构，Agent 团队定义模型角色及权限。处理器通过现有 `AgentDeps` 调用 `ParserWorker`、`AssessorWorker`、`AuditorWorker` 等适配器；所有模型调用继续走任务已绑定的 Agent 版本和模型网关。

招聘规划 Agent 产生批次大小、批次并发、角色容量和深评策略；这些经过边界校验的决策实际决定 `parallel` 的并发与候选人深评分支。工作流本身不增加新的优先级队列或负载感知调度器。

如果需要根据 LLM 选择路径，应先用任务节点产生经 Schema 校验的结构化决策，再由 `condition` 消费；不要让 LLM 生成可执行 TypeScript。

## 招聘参考实现

```text
画像 → 文件接入 → Agent 规划 → 严格模式计划审批
 → 并行批次
    → 并行解析
    → 并行初评（含已配置的专职检查）
    → 选择深评短名单
    → 并行候选人
       → 条件深评
       → candidate-verification@1.0.0 子流程
          → 有界循环：按反馈修正 → 核查 → 判断是否结束
          → 通过 / 转人工
 → 汇总报告
 → report-publication@1.0.0 子流程
    → 严格模式人工审批
    → 确认并写出报告
```

默认模式保留原有终稿确认；严格模式沿用 `screening-plan` 和 `publish-report` 审批类型及现有前端操作。专职检查、批内短名单规则、共享容量池、证据校验、报告格式保持业务兼容。成功节点复用检查点；恢复未完成的解析、评估和核查时，还会核对已提交业务记录，减少“业务已提交但节点结果尚未记录”造成的重复调用。

升级前没有工作流记录的任务，在首次续跑时记录 `workflow.legacy_import`，复用已提交解析，重新进入尚未完成的阶段；不能确认成功的半成品不会直接视为成功。已有业务台账不清空。

## 持久化与版本

SQLite 自动增加 `workflow_definitions`、`workflow_runs`、`workflow_nodes`。流程定义保存控制结构、Schema、函数源码和实现指纹；同版本内容不可覆盖。运行输入、版本和父子绑定也受数据库不可变触发器保护。

`implementation` 应反映处理器、条件及其依赖模块的源代码版本或文件哈希。SDK 无法自动发现函数闭包、动态导入及全部外部依赖；FDE 必须将会影响执行的逻辑纳入该指纹，将业务配置放进冻结输入。招聘参考实现会显式计算相关源码文件哈希，并冻结启动配置。

发布变更时增加版本，同时保留旧定义及旧处理器供在途任务恢复。引擎比较根流程及递归子流程的整个定义包；发现源码与已绑定版本不一致会拒绝执行，不能通过修改版本指针静默替换。只在数据库里保存快照不能替代保留旧版可执行模块。

## 暂停、重启与副作用

`new WorkflowEngine(ledger, registry, { shouldPause, approvalResponder })` 可对接暂停信号与人工回答。Web 的发送按钮继续负责暂停/续跑；暂停停止派发新节点，在途节点收束并保存结果。服务重启后，从原根运行恢复。

每个根运行有数据库租约，避免两个执行者同时恢复；进程崩溃后默认 30 秒租约过期才允许接管。进程正常退出等待审批/暂停时立即释放租约。

任务必须声明恢复策略：

- `recovery: 'retry'`：只用于可安全重试的计算、幂等操作或具备业务结果复用的处理器。引擎提供稳定的 `ctx.idempotencyKey`，外部系统支持时应传递该键。
- `recovery: 'confirm'`：可能产生无法确认的外部副作用。执行异常或恢复发现中断的 `running` 节点时，转为 `waiting_confirmation`，不会自动重放。

人工应先核对外部系统，再在任务面板确认可以重试，或录入已完成的 JSON 输出。录入结果会在恢复时再次按节点输出 Schema 校验。第一版不提供分布式执行、自动补偿或外部副作用 exactly-once 保证。

## 查看与确认

右上角「任务面板 → 工作流」展示版本、运行状态、父子 ID、分支/迭代路径、输入输出、执行次数及错误。没有工作流记录的历史会话显示兼容提示。

- `GET /api/run/:jobId/workflow`：读取当前任务的运行和节点。
- `POST /api/run/:jobId/workflow/confirm`：提交 `{ runId, path, action: 'retry' }` 或 `{ runId, path, action: 'complete', output }`，记录人工审计，不自动启动执行。
- `POST /api/run/:jobId/resume`：沿用现有续跑接口。

接口沿用本地单用户访问边界，不对 Agent 开放管理权限，也不提供独立身份认证。

## 验证

```bash
pnpm workflow:example
pnpm check
```

专门测试在 `tests/unit/workflow.test.ts`；招聘和审批集成测试验证实际业务使用新节点执行，包括伪造结论触发修正、父子审批等待、暂停/重启恢复和升级前任务迁移。
