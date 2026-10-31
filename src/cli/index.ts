#!/usr/bin/env node
import path from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { readFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { bootstrap } from '../bootstrap.ts';
import { runPipeline, type RunSummary } from '../agents/coordinator.ts';
import { AgentRegistry } from '../core/registry.ts';
import { Ledger } from '../core/ledger.ts';
import { mapConcurrent } from '../core/pipeline.ts';
import { loadPipelineConfig, resolvePaths } from '../config.ts';
import { AutoHitlResponder, ConsoleHitlResponder, type HitlQuestion, type HitlResponder } from '../agents/hitl.ts';
import type { EventRow, JobRow, ResumeRow } from '../types.ts';
import { DEMO_FAULTS, DEMO_REQUIREMENTS, DEMO_SEED } from './demo-data.ts';
import { maskPII } from '../util/text.ts';
import { formatDuration, sleep } from '../util/time.ts';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, text: string): string => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = (text: string): string => paint('1', text);
const dim = (text: string): string => paint('2', text);
const green = (text: string): string => paint('32', text);
const yellow = (text: string): string => paint('33', text);
const red = (text: string): string => paint('31', text);
const cyan = (text: string): string => paint('36', text);

interface Args {
  flags: Map<string, string | boolean>;
  positionals: string[];
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
      } else if (body.startsWith('no-')) {
        flags.set(body.slice(3), false);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(body, next);
          i += 1;
        } else {
          flags.set(body, true);
        }
      }
    } else {
      positionals.push(token);
    }
  }
  return { flags, positionals };
}

function str(args: Args, key: string): string | undefined {
  const value = args.flags.get(key);
  return typeof value === 'string' ? value : undefined;
}

function bool(args: Args, key: string): boolean {
  const value = args.flags.get(key);
  return value === true || value === 'true' || value === '1';
}

function relativeToCwd(file: string): string {
  const rel = path.relative(process.cwd(), file);
  return rel === '' ? file : rel;
}

function printHelp(): void {
  const help = `${bold('伯乐 BoLe — 可验证的多 Agent 招聘筛选平台')}

用法: bole <命令> [选项]

命令:
  demo                运行 8 分钟演示场景（20 份简历 + 故障注入 + HITL）
  run                 自定义 JD 跑完整流水线
  resume              从批次检查点续跑未完成任务
  status              查看任务台账 / 事件流
  audit               审计某位候选人的完整证据链（≤2 步回溯）
  report              查看已生成的报告文件
  web                 启动交互式前端（浏览器 UI + HITL 回答 + 实时事件）
  cost                查看 token 成本与缓存命中
  bench               调度并发扫描实验（模拟模型时延）
  agents              查看 Agent preset 注册表
  doctor              环境自检
  seed                重新生成黄金简历集（20 份 .eml）
  reset               清空台账与运行产物

常用选项:
  --yes               非交互模式（HITL 自动采纳推荐项，并记录 actor=HR(auto-demo)）
  --seed <str>        固定随机种子
  --llm mock|deepseek 模型提供方（默认 mock，离线可复现）
  --inbox <dir>       邮箱目录（默认 data/inbox）
  --mcp in-process|stdio  MCP 传输方式
  --no-faults         关闭演示用故障注入（幻觉结论/偏见理由）
  --latency <ms>      mock 模型单次调用模拟时延
  --fresh             demo 前清空台账与 runs
  --job <id>          指定任务
  --events <n>        status 显示的事件条数
  --host <ip>         web 模式监听地址（默认 127.0.0.1）
  --port <n>          web 模式监听端口（默认 8787）

示例:
  pnpm bole demo --yes
  pnpm bole demo                 # 交互式 HITL
  pnpm bole run --jd "招 Java 后端，3 年经验，base 上海"
  pnpm bole audit --resume R03
  pnpm bole status --events 40
  pnpm bole web --port 8787
`;
  process.stdout.write(help);
}

class PrintingAutoHitl implements HitlResponder {
  private inner: AutoHitlResponder;
  constructor() {
    this.inner = new AutoHitlResponder();
  }
  async ask(question: HitlQuestion): Promise<{ answer: string; actor: string }> {
    process.stdout.write(`\n${yellow('【HITL】')} ${question.question}\n`);
    const result = await this.inner.ask(question);
    process.stdout.write(`  ${dim('→ 自动应答:')} ${result.answer} ${dim(`(${result.actor})`)}\n`);
    return result;
  }
}

function makeHitl(args: Args): { hitl: HitlResponder; close?: () => void } {
  if (bool(args, 'yes') || !process.stdin.isTTY) {
    if (!bool(args, 'yes') && !process.stdin.isTTY) {
      process.stdout.write(yellow('检测到非交互终端，自动使用推荐选项（等同 --yes）。\n'));
    }
    return { hitl: new PrintingAutoHitl() };
  }
  const responder = new ConsoleHitlResponder();
  return { hitl: responder, close: () => responder.close() };
}

function summarizeEvent(event: EventRow): string {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(event.payload_json) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const label = (payload.label as string) ?? '';
  switch (event.type) {
    case 'run.created':
      return `运行创建 provider=${payload.provider} seed=${payload.seed}`;
    case 'profiler.started':
      return '需求画像师开始结构化 JD';
    case 'hitl.question':
      return `HITL 反问：${String(payload.question ?? '').slice(0, 60)}…`;
    case 'hitl.answered':
      return `HITL 已确认：${String(payload.answer ?? '').slice(0, 40)} (${payload.actor})`;
    case 'jd.analyzed':
      return `JD 结构化完成：${payload.title}；${payload.dimensions} 个评分维度；剥离受保护条件 ${payload.removedProtected} 项`;
    case 'mcp.connected':
      return `MCP 已连接（${payload.transport}）`;
    case 'resume.fetched':
      return `${label} 接入成功（${payload.format}, ${payload.chars} 字符）`;
    case 'resume.duplicate':
      return `${label} 判定为重复投递（与 ${payload.duplicateOf} 一致）`;
    case 'resume.fetch_failed':
      return `${label} 接入失败：${String(payload.reason ?? '').slice(0, 70)}`;
    case 'fetch.completed':
      return `简历接入完成：成功 ${payload.pulled}，重复 ${payload.duplicates}，失败 ${payload.failed}`;
    case 'batch.started':
      return `第 ${payload.batchId} 批进入流水线（${payload.size} 份）`;
    case 'parse.started':
      return `${label} 解析开始（${payload.workerId}）`;
    case 'parse.committed':
      return green(`${label} 解析完成，${payload.fields} 个字段`);
    case 'parse.failed':
      return red(`${label} 解析失败：${String((payload.errors as string[] | undefined)?.[0] ?? '').slice(0, 60)}`);
    case 'eval.started':
      return `${label} ${payload.phase === 'deep' ? 'pro 深评' : payload.phase === 'revise' ? '返工评估' : 'flash 初筛'}开始（第 ${payload.loopIndex} 轮, ${payload.workerId}）`;
    case 'eval.committed':
      return `${label} 评估完成：${Number(payload.totalScore).toFixed(1)} 分（${payload.conclusion}，${payload.tier}/${payload.phase}）`;
    case 'eval.failed':
      return red(`${label} 评估失败`);
    case 'batch.screened':
      return `第 ${payload.batchId} 批初筛完成（${payload.screened} 人，失败 ${payload.failed}）`;
    case 'deep_eval.shortlist':
      return yellow(`第 ${payload.batchId} 批深评短名单：${payload.count} 人（Top ${payload.percent}% + 异常，${payload.tier}）`);
    case 'deep_eval.completed':
      return green(`${label} pro 深评完成：${Number(payload.totalScore).toFixed(1)} 分`);
    case 'deep_eval.failed':
      return yellow(`${label} 深评失败，回退 flash 结果`);
    case 'screen.failed':
      return red(`第 ${payload.batchId} 批初筛失败：${String(payload.error ?? '').slice(0, 70)}`);
    case 'review.started':
      return `${label} 证据核查开始（第 ${payload.loopCount} 轮）`;
    case 'review.verdict':
      return payload.verdict === 'pass'
        ? green(`${label} 核查通过（${payload.supported} 条支持）`)
        : yellow(`${label} 核查裁决 ${payload.verdict}（${payload.failed} 条未通过）`);
    case 'selfloop.revise':
      return yellow(`${label} 验真环打回重评 第 ${payload.loop} 轮（沿用 ${payload.workerId}）`);
    case 'worker.reused':
      return dim(`${label} 续用同一评估 Worker：${payload.workerId}`);
    case 'escalate.human':
      return red(`${label} 转人工：${String(payload.reason ?? '').slice(0, 70)}`);
    case 'candidate.processed':
      return `${label} 批次处理结果：${payload.status}${payload.score ? `（${Number(payload.score).toFixed(1)} 分）` : ''}${payload.tier ? ` [${payload.tier}/${payload.phase}]` : ''}`;
    case 'batch.parsed':
      return `第 ${payload.batchId} 批解析完成（${payload.parsed} 成功 / ${payload.failed} 失败）`;
    case 'batch.completed':
      return `第 ${payload.batchId} 批完成（评估 ${payload.evaluated}）`;
    case 'hitl.final_confirmation':
      return `HITL 终稿确认：${payload.answer}`;
    case 'report.generated':
      return green(`报告已生成（${payload.status}）：Top ${(payload.top as string[] | undefined)?.join(', ')}`);
    case 'run.completed':
      return bold('运行完成');
    case 'recovery.resume_reset':
      return `检查点恢复：${label} ${payload.from} → ${payload.to}`;
    case 'recovery.task_aborted':
      return `检查点恢复：中止未提交任务 ${payload.kind}/${String(payload.taskId).slice(0, 18)}`;
    default:
      return `${event.type} ${JSON.stringify(payload).slice(0, 120)}`;
  }
}

function subscribeEvents(ledger: Ledger, jobId: string, max = 400): () => void {
  let seq = 0;
  let count = 0;
  const flush = (): void => {
    const events = ledger.listEvents({ jobId, sinceSeq: seq, limit: 100 });
    for (const event of events) {
      seq = event.seq;
      count += 1;
      if (count > max) continue;
      const time = event.ts.slice(11, 19);
      process.stdout.write(`${dim(time)} ${dim(event.actor.padEnd(10))} ${summarizeEvent(event)}\n`);
    }
  };
  flush();
  const timer = setInterval(flush, 40);
  return () => {
    clearInterval(timer);
    flush();
  };
}

function printSummary(summary: RunSummary, job: JobRow): void {
  process.stdout.write(`\n${bold('══ 运行汇总 ══')}\n`);
  process.stdout.write(`任务: ${job.id}  状态: ${summary.status === 'final' ? green('终稿') : yellow('草稿')}  耗时: ${formatDuration(summary.durationMs)}\n`);
  const counts = Object.entries(summary.counts)
    .map(([status, count]) => `${status}=${count}`)
    .join('  ');
  process.stdout.write(`简历状态: ${counts}\n`);
  process.stdout.write(`Self-Loop: 重评 ${summary.selfLoop.revisions} 次，转人工 ${summary.selfLoop.escalations} 人\n`);
  if (summary.top.length > 0) {
    process.stdout.write(`\n${bold('Top 候选人')}\n`);
    summary.top.forEach((candidate, index) => {
      process.stdout.write(`  ${index + 1}. ${candidate.label}  ${candidate.totalScore.toFixed(1)} 分  ${candidate.conclusion}\n`);
    });
  }
  process.stdout.write(`\n${bold('容量池')}\n`);
  for (const pool of summary.pools) {
    process.stdout.write(
      `  ${pool.name}: 容量 ${pool.capacity}，峰值 ${pool.peak}，获取 ${pool.acquired}，拒绝 ${pool.refused}（不排队），超时 ${pool.timeouts}\n`,
    );
  }
  process.stdout.write(
    `\n${bold('成本')}: ${summary.usage.calls} 次模型调用，输入 ${summary.usage.promptTokens} tokens（缓存命中 ${summary.usage.cachedTokens}），输出 ${summary.usage.completionTokens}，合计 $${summary.usage.costUsd}\n`,
  );
  process.stdout.write(`\n${bold('报告')}\n`);
  for (const [name, file] of Object.entries(summary.reports)) {
    process.stdout.write(`  ${name.padEnd(12)} ${relativeToCwd(file)}\n`);
  }
  process.stdout.write(
    `\n下一步: ${cyan(`bole audit --resume ${summary.top[0]?.label ?? 'R01'}`)} 查看证据链 ｜ ${cyan('bole status')} 查看台账 ｜ 打开 report.md\n\n`,
  );
}

async function cmdDemo(args: Args): Promise<void> {
  if (bool(args, 'fresh')) resetArtifacts(false);
  const paths = resolvePaths();
  const inboxDir = str(args, 'inbox') ?? paths.inboxDir;
  if (!existsSync(inboxDir)) {
    throw new Error(`找不到邮箱目录 ${inboxDir}；先运行 pnpm seed 生成黄金简历集`);
  }
  const requirements = str(args, 'jd') ?? DEMO_REQUIREMENTS;
  const llm = (str(args, 'llm') ?? 'mock') as 'mock' | 'deepseek';
  const faults = bool(args, 'no-faults') ? {} : DEMO_FAULTS;
  const latency = str(args, 'latency') ? Number(str(args, 'latency')) : 8;
  const boot = await bootstrap({
    requirements,
    seed: str(args, 'seed') ?? DEMO_SEED,
    llm,
    faults,
    mockLatencyMs: latency,
  });
  process.stdout.write(`${bold('\n伯乐 BoLe · 演示运行')}\n`);
  process.stdout.write(dim(`job=${boot.job.id} run=${boot.deps.runId} provider=${llm} inbox=${inboxDir}\n`));
  process.stdout.write(dim('故障注入: R17 幻觉结论 / R20 偏见理由（用于演示核查与 Self-Loop）\n\n'));
  const { hitl, close } = makeHitl(args);
  const unsubscribe = subscribeEvents(boot.deps.ledger, boot.job.id);
  try {
    const summary = await runPipeline(boot.deps, {
      requirements,
      hitl,
      inboxDir,
      mcpMode: (str(args, 'mcp') ?? 'in-process') as 'in-process' | 'stdio',
    });
    unsubscribe();
    printSummary(summary, boot.job);
  } finally {
    unsubscribe();
    close?.();
    boot.close();
  }
}

async function cmdRun(args: Args): Promise<void> {
  const requirements = str(args, 'jd') ?? args.positionals.join(' ');
  if (!requirements || requirements.trim().length < 5) {
    throw new Error('请用 --jd "招聘需求..." 提供 HR 需求');
  }
  const paths = resolvePaths();
  const inboxDir = str(args, 'inbox') ?? paths.inboxDir;
  const llm = (str(args, 'llm') ?? 'mock') as 'mock' | 'deepseek';
  const boot = await bootstrap({ requirements, seed: str(args, 'seed') ?? 'run-default', llm });
  process.stdout.write(`${bold('BoLe 运行')} job=${boot.job.id}\n`);
  const { hitl, close } = makeHitl(args);
  const unsubscribe = subscribeEvents(boot.deps.ledger, boot.job.id);
  try {
    const summary = await runPipeline(boot.deps, {
      requirements,
      hitl,
      inboxDir,
      mcpMode: (str(args, 'mcp') ?? 'in-process') as 'in-process' | 'stdio',
    });
    unsubscribe();
    printSummary(summary, boot.job);
  } finally {
    unsubscribe();
    close?.();
    boot.close();
  }
}

async function cmdResume(args: Args): Promise<void> {
  const jobId = str(args, 'job');
  if (!jobId) throw new Error('请用 --job <id> 指定要续跑的任务（bole status 可查看）');
  const paths = resolvePaths();
  const reader = new Ledger(paths.dbPath);
  const job = reader.getJob(jobId);
  if (!job) {
    reader.close();
    throw new Error(`任务不存在: ${jobId}`);
  }
  reader.close();
  const boot = await bootstrap({
    requirements: job.requirements,
    jobId,
    seed: job.seed ?? 'resume',
    llm: (str(args, 'llm') ?? 'mock') as 'mock' | 'deepseek',
  });
  process.stdout.write(`${bold('BoLe 检查点续跑')} job=${jobId}\n`);
  const { hitl, close } = makeHitl(args);
  const unsubscribe = subscribeEvents(boot.deps.ledger, jobId);
  try {
    const summary = await runPipeline(boot.deps, {
      requirements: job.requirements,
      hitl,
      inboxDir: str(args, 'inbox') ?? paths.inboxDir,
      resumeOnly: true,
    });
    unsubscribe();
    printSummary(summary, boot.job);
  } finally {
    unsubscribe();
    close?.();
    boot.close();
  }
}

function openReader(): Ledger {
  const paths = resolvePaths();
  return new Ledger(paths.dbPath);
}

function resolveJob(ledger: Ledger, args: Args): JobRow {
  const jobId = str(args, 'job');
  const job = jobId ? ledger.getJob(jobId) : ledger.latestJob();
  if (!job) throw new Error('台账中还没有任务：先运行 bole demo 或 bole run');
  return job;
}

function cmdStatus(args: Args): void {
  const ledger = openReader();
  try {
    const job = resolveJob(ledger, args);
    const limit = Number(str(args, 'events') ?? 30);
    if (bool(args, 'json')) {
      process.stdout.write(
        `${JSON.stringify(
          {
            job,
            resumes: ledger.resumeCounts(job.id),
            parse: ledger.statusCounts('parse', job.id),
            eval: ledger.statusCounts('eval', job.id),
            review: ledger.statusCounts('review', job.id),
            verdicts: ledger.reviewVerdictCounts(job.id),
            selfLoop: ledger.selfLoopStats(job.id),
            usage: ledger.usageSummary(job.id),
            events: ledger.listEvents({ jobId: job.id, limit }),
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    process.stdout.write(`${bold('任务')} ${job.id}  ${job.title}  状态=${job.status}\n`);
    process.stdout.write(`需求: ${job.requirements}\n`);
    process.stdout.write(`简历: ${JSON.stringify(ledger.resumeCounts(job.id))}\n`);
    process.stdout.write(`parse: ${JSON.stringify(ledger.statusCounts('parse', job.id))}\n`);
    process.stdout.write(`eval:  ${JSON.stringify(ledger.statusCounts('eval', job.id))}\n`);
    process.stdout.write(`review:${JSON.stringify(ledger.statusCounts('review', job.id))} 裁决=${JSON.stringify(ledger.reviewVerdictCounts(job.id))}\n`);
    process.stdout.write(`self-loop: ${JSON.stringify(ledger.selfLoopStats(job.id))}\n`);
    const usage = ledger.usageSummary(job.id);
    const cost = usage.reduce((sum, row) => sum + Number(row.costUsd ?? 0), 0);
    process.stdout.write(`成本: $${cost.toFixed(6)}（${usage.length} 个 agent/模型组合）\n`);
    process.stdout.write(`\n${bold(`最近 ${limit} 条事件`)}\n`);
    for (const event of ledger.listEvents({ jobId: job.id, limit })) {
      process.stdout.write(`${dim(String(event.seq).padStart(5))} ${dim(event.ts.slice(11, 19))} ${event.actor.padEnd(12)} ${event.type}\n`);
    }
  } finally {
    ledger.close();
  }
}

function findResume(ledger: Ledger, jobId: string, needle: string): ResumeRow {
  const resumes = ledger.listResumes(jobId);
  const found = resumes.find((r) => r.id === needle) ?? resumes.find((r) => r.label.toLowerCase() === needle.toLowerCase());
  if (!found) throw new Error(`找不到简历 ${needle}；可用: ${resumes.map((r) => r.label).join(', ')}`);
  return found;
}

function maskFieldValue(field: string, value: string): string {
  if (field === 'name') {
    const chars = Array.from(value);
    return chars.length > 1 ? `${chars[0]}**` : '**';
  }
  return maskPII(value);
}

function cmdAudit(args: Args): void {
  const ledger = openReader();
  try {
    const job = resolveJob(ledger, args);
    const needle = str(args, 'resume') ?? args.positionals[0];
    if (!needle) throw new Error('请用 --resume <R03|res_id> 指定要审计的简历');
    const resume = findResume(ledger, job.id, needle);
    process.stdout.write(`${bold('证据链审计')} ${resume.label} (${resume.id})\n`);
    process.stdout.write(`格式=${resume.format} 状态=${resume.status} 批次=${resume.batch_id ?? '-'}\n`);
    const reasons = JSON.parse(resume.reasons_json) as string[];
    for (const reason of reasons) process.stdout.write(`  - ${reason}\n`);

    const parseTasks = ledger.listTasks('parse', { jobId: job.id }).filter((task) => task.resume_id === resume.id);
    const parseTask = parseTasks.find((task) => task.status === 'committed');
    if (parseTask?.fields_json) {
      const fields = JSON.parse(String(parseTask.fields_json)) as Record<string, { value: string; confidence: number }>;
      const spans = JSON.parse(String(parseTask.spans_json ?? '[]')) as { field: string; quote: string; charStart: number; charEnd: number }[];
      process.stdout.write(`\n${bold('① 解析字段与证据 span')}\n`);
      for (const [key, field] of Object.entries(fields)) {
        const fieldSpans = spans.filter((span) => span.field === key);
        process.stdout.write(`  ${key}: ${maskFieldValue(key, field.value).slice(0, 80)} (conf=${field.confidence})\n`);
        for (const span of fieldSpans) {
          process.stdout.write(`      ↳ [${span.charStart}-${span.charEnd}] 「${maskPII(span.quote)}」\n`);
        }
      }
    }

    const evals = ledger.listTasks('eval', { jobId: job.id }).filter((task) => task.resume_id === resume.id && task.status === 'committed');
    if (evals.length > 0) {
      const latest = evals[evals.length - 1];
      const dims = JSON.parse(String(latest.scores_json ?? '[]')) as {
        key: string;
        name: string;
        weight: number;
        score: number;
        rationale: string;
        spans: { quote: string; charStart: number; charEnd: number }[];
      }[];
      process.stdout.write(`\n${bold('② 评估结论')} 总分=${Number(latest.total_score).toFixed(1)} 结论=${latest.conclusion} 版本=${latest.id} 档位=${latest.tier ?? '-'} 阶段=${latest.phase ?? '-'}\n`);
      for (const dim of dims) {
        process.stdout.write(`  ${dim.name}（权重 ${dim.weight}%，${dim.score} 分）：${maskPII(dim.rationale)}\n`);
        for (const span of dim.spans) {
          process.stdout.write(`      ↳ [${span.charStart}-${span.charEnd}] 「${maskPII(span.quote)}」\n`);
        }
      }
    }

    const reviews = ledger.listTasks('review', { jobId: job.id }).filter((task) => task.resume_id === resume.id);
    process.stdout.write(`\n${bold('③ 核查记录')}\n`);
    if (reviews.length === 0) process.stdout.write('  无\n');
    for (const review of reviews) {
      process.stdout.write(
        `  轮次 ${review.loop_count}：${review.verdict}（${review.status}）${review.escalation_reason ? ` — ${review.escalation_reason}` : ''}\n`,
      );
      const checks = JSON.parse(String(review.checks_json ?? '[]')) as { claim: string; verdict: string; note: string; quote?: string }[];
      for (const check of checks) {
        const icon = check.verdict === 'supported' ? green('✓') : red('✗');
        process.stdout.write(`    ${icon} ${check.verdict}  ${maskPII(check.claim).slice(0, 70)} — ${check.note}\n`);
      }
    }

    process.stdout.write(`\n${bold('④ 台账事件（该候选人）')}\n`);
    for (const event of ledger.listEvents({ jobId: job.id, limit: 2000 })) {
      const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
      if (payload.resumeId === resume.id || payload.label === resume.label) {
        process.stdout.write(`  ${dim(event.ts.slice(11, 19))} ${event.actor.padEnd(10)} ${event.type}\n`);
      }
    }
  } finally {
    ledger.close();
  }
}

function findLatestReport(jobId: string): string | null {
  const paths = resolvePaths();
  if (!existsSync(paths.runsDir)) return null;
  const dirs = readdirSync(paths.runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(paths.runsDir, entry.name))
    .sort()
    .reverse();
  for (const dir of dirs) {
    const file = path.join(dir, 'report.json');
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as { job?: { id?: string } };
      if (data.job?.id === jobId) return dir;
    } catch {
      // 跳过损坏报告
    }
  }
  return null;
}

function cmdReport(args: Args): void {
  const ledger = openReader();
  try {
    const job = resolveJob(ledger, args);
    const dir = findLatestReport(job.id);
    if (!dir) {
      process.stdout.write(yellow('该任务还没有报告：先运行 bole demo 或 bole run\n'));
      return;
    }
    process.stdout.write(`${bold('报告目录')} ${relativeToCwd(dir)}\n`);
    for (const name of ['report.md', 'report.html', 'report.json', 'cost-report.md', 'convergence.svg']) {
      const file = path.join(dir, name);
      if (existsSync(file)) process.stdout.write(`  ${name.padEnd(18)} ${relativeToCwd(file)}\n`);
    }
  } finally {
    ledger.close();
  }
}

function cmdCost(args: Args): void {
  const ledger = openReader();
  try {
    const job = resolveJob(ledger, args);
    const usage = ledger.usageSummary(job.id);
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;
    let cost = 0;
    process.stdout.write(`${bold('成本报表')} ${job.id}\n`);
    process.stdout.write('agent\tmodel\ttier\tcalls\tprompt\tcompletion\tcached\tcostUSD\n');
    for (const row of usage) {
      promptTokens += Number(row.promptTokens ?? 0);
      completionTokens += Number(row.completionTokens ?? 0);
      cachedTokens += Number(row.cachedTokens ?? 0);
      cost += Number(row.costUsd ?? 0);
      process.stdout.write(
        `${row.agent}\t${row.model}\t${row.tier}\t${row.calls}\t${row.promptTokens}\t${row.completionTokens}\t${row.cachedTokens}\t${Number(row.costUsd ?? 0).toFixed(6)}\n`,
      );
    }
    process.stdout.write(
      `\n合计: ${promptTokens} 输入 / ${completionTokens} 输出 / ${cachedTokens} 缓存命中（${((cachedTokens / Math.max(1, promptTokens)) * 100).toFixed(1)}%）/ $${cost.toFixed(6)}\n`,
    );
    const dir = findLatestReport(job.id);
    if (dir) process.stdout.write(`详细缓存对比见: ${relativeToCwd(path.join(dir, 'cost-report.md'))}\n`);
  } finally {
    ledger.close();
  }
}

async function cmdBench(args: Args): Promise<void> {
  const config = loadPipelineConfig();
  const items = Number(str(args, 'items') ?? config.bench.itemsPerRun);
  const latency = Number(str(args, 'latency') ?? config.bench.simulatedLatencyMs);
  const levels = (str(args, 'concurrency')?.split(',').map(Number) ?? config.bench.concurrency).filter((n) => n > 0);
  process.stdout.write(`${bold('调度并发扫描（微基准）')}\n`);
  process.stdout.write(dim(`items=${items} 模拟单次模型时延=${latency}ms（不含真实推理与网络；用于验证并发池/批流动的调度开销）\n\n`));
  process.stdout.write('并发度\t吞吐(项/秒)\t总耗时(ms)\tP50(ms)\tP95(ms)\t成功\n');
  const results: { level: number; throughput: number }[] = [];
  for (const level of levels) {
    const durations: number[] = [];
    const started = performance.now();
    await mapConcurrent(Array.from({ length: items }, (_, index) => index), level, async () => {
      const taskStart = performance.now();
      await sleep(latency);
      durations.push(performance.now() - taskStart);
      return true;
    });
    const total = performance.now() - started;
    durations.sort((a, b) => a - b);
    const p50 = durations[Math.floor(durations.length * 0.5)] ?? 0;
    const p95 = durations[Math.floor(durations.length * 0.95)] ?? 0;
    const throughput = (items / total) * 1000;
    results.push({ level, throughput });
    process.stdout.write(
      `${level}\t${throughput.toFixed(1)}\t\t${total.toFixed(0)}\t\t${p50.toFixed(0)}\t${p95.toFixed(0)}\t${durations.length}/${items}\n`,
    );
  }
  const baseline = results.find((r) => r.level === 1)?.throughput ?? 1;
  const best = results.reduce((max, r) => Math.max(max, r.throughput), baseline);
  process.stdout.write(`\n并发 ${results.find((r) => r.throughput === best)?.level ?? 1} 相比串行吞吐提升 ${(best / baseline).toFixed(2)}×\n`);
  process.stdout.write(dim('注：调度层微基准，真实端到端吞吐受模型网关限流与简历长度影响，见文档"已知限制"。\n'));
}

function resetArtifacts(force = true): void {
  const paths = resolvePaths();
  if (existsSync(paths.dbPath)) rmSync(paths.dbPath, { force: true });
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const file = `${paths.dbPath}${suffix}`;
    if (existsSync(file)) rmSync(file, { force: true });
  }
  if (existsSync(paths.runsDir)) rmSync(paths.runsDir, { recursive: true, force: true });
  if (force) process.stdout.write(green('已清空台账与运行产物。\n'));
}

async function cmdReset(args: Args): Promise<void> {
  if (bool(args, 'yes')) {
    resetArtifacts(true);
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(yellow('将删除台账与全部运行产物，输入 "yes" 确认: '))).trim();
  rl.close();
  if (answer !== 'yes') {
    process.stdout.write('已取消。\n');
    return;
  }
  resetArtifacts(true);
}

async function cmdSeed(): Promise<void> {
  const { generateGoldenSet } = await import('../../scripts/generate-golden.ts');
  const result = await generateGoldenSet();
  process.stdout.write(green(`黄金简历集已生成：${result.messages} 封邮件，${result.files} 个附件，目录 ${relativeToCwd(result.inboxDir)}\n`));
}

function cmdAgents(): void {
  const registry = AgentRegistry.load();
  process.stdout.write(`${bold('Agent preset 注册表')} version=${registry.version} fingerprint=${registry.fingerprint}\n\n`);
  process.stdout.write('id\t名称\t档位\tmaxDepth\t输出 schema\t工具\n');
  for (const agent of registry.list()) {
    process.stdout.write(
      `${agent.id}\t${agent.nameZh}\t${agent.tier}\t${agent.maxDepth}\t\t${agent.outputSchema}\t${agent.tools.join(',')}\n`,
    );
  }
}

function cmdDoctor(): void {
  const paths = resolvePaths();
  const config = loadPipelineConfig();
  process.stdout.write(`${bold('环境自检')}\n`);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  process.stdout.write(`Node ${process.versions.node}：${nodeMajor >= 22 ? green('OK（>=22）') : red('需要 >=22.6')}\n`);
  for (const file of ['config/agents.json', 'config/pipeline.json']) {
    const full = path.join(paths.root, file);
    process.stdout.write(`${file}：${existsSync(full) ? green('存在') : red('缺失')}\n`);
  }
  const inbox = existsSync(paths.inboxDir) ? readdirSync(paths.inboxDir).filter((f) => f.endsWith('.eml')).length : 0;
  process.stdout.write(`邮箱目录：${relativeToCwd(paths.inboxDir)}（${inbox} 封邮件）${inbox > 0 ? green('') : yellow('— 先运行 pnpm seed')}\n`);
  const knowledge = existsSync(paths.knowledgeDir) ? readdirSync(paths.knowledgeDir).filter((f) => f.endsWith('.md')).length : 0;
  process.stdout.write(`知识库：${knowledge} 个文档\n`);
  const registry = AgentRegistry.load();
  process.stdout.write(`Agent preset：${registry.list().length} 个，版本 ${registry.version}，指纹 ${registry.fingerprint}\n`);
  process.stdout.write(`模型档位：flash=${config.models.flash} / pro=${config.models.pro}\n`);
  process.stdout.write(`DeepSeek API Key：${process.env.DEEPSEEK_API_KEY ? green('已配置') : dim('未配置（默认 mock 模式可完整运行）')}\n`);
  try {
    const ledger = new Ledger(paths.dbPath);
    const jobs = ledger.listJobs().length;
    ledger.close();
    process.stdout.write(`台账可写：${green('OK')}（${relativeToCwd(paths.dbPath)}，${jobs} 个历史任务）\n`);
  } catch (error) {
    process.stdout.write(`台账不可写：${red(error instanceof Error ? error.message : String(error))}\n`);
  }
}

async function cmdWeb(args: Args): Promise<void> {
  const host = str(args, 'host') ?? '127.0.0.1';
  const portRaw = str(args, 'port') ?? '8787';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`非法端口: ${portRaw}`);
  }
  const { startWebServer } = await import('../web/server.ts');
  await startWebServer({ host, port });
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (command) {
    case 'demo':
      await cmdDemo(args);
      break;
    case 'run':
      await cmdRun(args);
      break;
    case 'resume':
      await cmdResume(args);
      break;
    case 'status':
      cmdStatus(args);
      break;
    case 'audit':
      cmdAudit(args);
      break;
    case 'report':
      cmdReport(args);
      break;
    case 'cost':
      cmdCost(args);
      break;
    case 'web':
      await cmdWeb(args);
      break;
    case 'bench':
      await cmdBench(args);
      break;
    case 'agents':
      cmdAgents();
      break;
    case 'doctor':
      cmdDoctor();
      break;
    case 'seed':
      await cmdSeed();
      break;
    case 'reset':
      await cmdReset(args);
      break;
    case 'help':
    case undefined:
      printHelp();
      break;
    default:
      printHelp();
      process.exitCode = 1;
      break;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\n${red('错误：')}${error instanceof Error ? error.message : String(error)}\n`);
  if (process.env.BOLE_DEBUG && error instanceof Error) process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
