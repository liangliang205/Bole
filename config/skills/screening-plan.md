# Skill：筛选扇出与并发计划（Screening Plan）

> 适用：上传/接入完成、解析开始之前。由主 Agent（coordinator）阅读本 skill，输出一份 `screening_plan`。
> 目标：在“上下文有限、成本有限、证据不能降级”的前提下，决定**是否扇出、开多大并发、是否深评**。
> 代码只校验边界并执行；**具体取什么值由你判断**，不要套用固定数字。

## 输入

调用时会给你：

- `usable`：可进入筛选的简历数（不含重复/失败）；
- `duplicates` / `failed`：接入阶段去重与失败数量；
- `formats`：各格式数量（pdf/docx/image/text）；
- `defaults`：当前配置的默认值（batchSize / maxBatchesInFlight / **maxActiveAgents** / pools / deepEval）；
- `bounds`：允许的取值范围（硬边界，超出会被夹紧）。

> `maxActiveAgents` 是**统一子 Agent 总上限**：解析、初筛、深评、核查同一时刻加起来的活跃 Agent 数不超过它。默认 8，跨阶段共享；`pools` 只是各阶段的二级限流，不能突破总上限。

## 判断原则

1. **先判断“值不值得扇出”**
   - 只有 1 份可用简历：没有并行收益，选 `single`。单份简历没有横向比较对象，深评通常没有增量价值，`deepEval.enabled=false`；若解析有异常/不确定项，可保留深评。`single` 下总上限固定为 1。
   - 2 份以上：通常选 `batch`；只有当简历极少且你判断串行更稳时，才选 `single`。
   - 重复/失败很多时，先看 `usable`，不要按上传文件数做决定。

2. **总上限优先于阶段并发**
   - 先定 `maxActiveAgents`（默认 8；不要为了快随便拉高），再定各阶段 `pools`；`pool.parse + pool.assess + pool.review` 可以大于总上限，但实际同时活跃数永远不超过 `maxActiveAgents`。
   - 解析是扇出型工作，可以比评估更宽；核查是串行否决点，默认保持窄并发（1–2）。
   - `deepEval` 只对“需要横向比较/边界候选人”有价值；单简历、证据充分且无不确定项时关闭。

3. **成本**
   - 每多一个 pro 调用都是真金白银：批量初筛用 flash，只有短名单/核查需要 pro。
   - `maxBatchesInFlight` > 2 会显著提高瞬时并发与限流概率，除非 `usable` 很大且你判断收益覆盖风险。
   - 不确定时：**宁可保守**（较小的 batchSize/并发、关闭不必要的深评），把失败率降下来。

4. **失败与重跑**
   - `failed` 占比高时，降低并发、减小批，先让流水线跑通。
   - 续跑场景 `usable` 可能已经变小，按当前可用量重新判断，不要沿用“上次的计划”。

## 输出

严格输出 `screening_plan` JSON：

| 字段 | 说明 |
|---|---|
| `mode` | `single`：单批串行，不开扇出；`batch`：按批并发 |
| `batchSize` | 每批简历数；single 模式会按当前可用量收口 |
| `maxBatchesInFlight` | 同时在途的批数；single 固定为 1 |
| `maxActiveAgents` | 统一子 Agent 总上限（跨阶段共享）；single 固定为 1 |
| `deepEval.enabled` / `percent` | 是否做 pro 深评；percent 只在 batch 模式有意义 |
| `pools.parse` / `assess` / `review` | 各阶段并发上限；review 建议 1–2 |
| `reason` | 一句话说明为什么这样开/不开扇出、为什么选这个并发 |

## 反例（不要这样）

- 不管几份简历都返回 `batchSize=8, pools=4/2/1`——这是硬编码，不是判断。
- 1 份简历也开 `batch` + 深评，白花一次 pro。
- 为了“看起来并发高”把 `maxActiveAgents` 或 `review` 拉满，成本和失败率都会上升。
- 只写阶段并发、不写总上限——总上限才是跨阶段的硬约束。
- 理由只写“默认值”——必须结合 `usable`、失败/重复、格式或成本说清楚。
