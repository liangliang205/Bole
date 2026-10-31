#!/usr/bin/env node
import path from 'node:path';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { bootstrap } from '../bootstrap.ts';
import { runPipeline, type RunSummary } from '../agents/coordinator.ts';
import { AgentRegistry } from '../core/registry.ts';
import { Ledger } from '../core/ledger.ts';
import { loadPipelineConfig, resolvePaths } from '../config.ts';
import { AutoHitlResponder, ConsoleHitlResponder, type HitlResponder } from '../agents/hitl.ts';
import type { EventRow, JobRow, ResumeRow, UploadedFile } from '../types.ts';
import { maskPII } from '../util/text.ts';
import { formatDuration } from '../util/time.ts';
import { listFilesRecursive } from '../util/fsx.ts';
import { newId } from '../util/ids.ts';
import { detectContentType, isSupportedUpload } from '../ingest/uploads.ts';
import { ProviderStore } from '../settings/provider-store.ts';

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
  process.stdout.write(`${bold('伯乐 BoLe — 可验证的多 Agent 招聘筛选平台')}

用法: bole <命令> [选项]

命令:
  web                 启动对话式控制台（推荐；所有操作在页面完成）
  run                 用本地简历目录跑完整流水线（自动化/验收）
  resume              从批次检查点续跑未完成任务
  status              查看任务台账 / 事件流
  audit               审计某位候选人的完整证据链
  report              查看已生成的 Markdown / JSON 报告
  cost                查看 token 成本与缓存命中
  agents              查看 Agent preset 注册表
  doctor              环境自检（含 OCR 语言数据）
  reset               清空台账、运行产物与上传缓存

选项:
  --jd <text>         招聘需求（run 必填）
  --files <dir>       简历目录（PDF/DOCX/图片/TXT/HTML；run 必填）
  --yes               非交互模式（HITL 自动采纳推荐项）
  --key <sk-...>      临时使用 Key（不持久化；Web 绑定会持久化）
  --host <ip>         web 监听地址（默认 127.0.0.1）
  --port <n>          web 端口（默认 8787）
  --job <id>          resume/status/audit/report/cost 指定任务
  --events <n>        status 事件条数

示例:
  pnpm web
  pnpm bole run --jd "招 Java 后端，3-5 年，base 上海" --files ./resumes --yes
  pnpm bole audit --resume R01
`);
}

function makeHitl(args: Args): { hitl: HitlResponder; close?: () => void } {
  if (bool(args, 'yes') || !process.stdin.isTTY) return { hitl: new AutoHitlResponder() };
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
  const label = String(payload.label ?? '');
  switch (event.type) {
    case 'run.created':
      return `运行创建 provider=${payload.provider}`;
    case 'profiler.started':
      return '需求画像师开始结构化 JD';
    case 'hitl.question':
      return `HITL 反问：${String(payload.question ?? '').slice(0, 60)}…`;
    case 'hitl.answered':
      return `HITL 已确认：${String(payload.answer ?? '').slice(0, 40)}`;
    case 'jd.analyzed':
      return `JD 结构化完成：${payload.title}；${payload.dimensions} 个评分维度`;
    case 'fetch.started':
      return `开始接入 ${payload.files} 份上传简历`;
    case 'resume.fetched':
      return green(`${label} 接入成功（${payload.filename} · ${payload.format} · ${payload.chars} 字符）`);
    case 'resume.ocr':
      return green(`${label} DeepSeek Vision OCR 完成（${payload.model} · ${payload.chars} 字符）`);
    case 'resume.ocr_failed':
      return red(`${label} DeepSeek Vision OCR 失败，回退本地：${String(payload.error ?? '').slice(0, 70)}`);
    case 'resume.duplicate':
      return `${label} 重复投递（与 ${payload.duplicateOf} 一致）`;
    case 'resume.fetch_failed':
      return red(`${label} 接入失败：${String(payload.reason ?? '').slice(0, 70)}`);
    case 'fetch.completed':
      return `接入完成：成功 ${payload.pulled}，重复 ${payload.duplicates}，失败 ${payload.failed}`;
    case 'batch.started':
      return `第 ${payload.batchId} 批进入流水线（${payload.size} 份）`;
    case 'parse.committed':
      return green(`${label} 解析完成，${payload.fields} 个字段`);
    case 'parse.failed':
      return red(`${label} 解析失败`);
    case 'batch.screened':
      return `第 ${payload.batchId} 批初筛完成（${payload.screened} 人）`;
    case 'deep_eval.shortlist':
      return yellow(`第 ${payload.batchId} 批深评短名单：${payload.count} 人（${payload.tier}）`);
    case 'eval.committed':
      return `${label} 评估完成：${Number(payload.totalScore).toFixed(1)} 分（${payload.tier}/${payload.phase}）`;
    case 'deep_eval.completed':
      return green(`${label} pro 深评完成：${Number(payload.totalScore).toFixed(1)} 分`);
    case 'review.verdict':
      return payload.verdict === 'pass'
        ? green(`${label} 核查通过`)
        : yellow(`${label} 核查裁决 ${payload.verdict}（${payload.failed} 条未通过）`);
    case 'selfloop.revise':
      return yellow(`${label} 验真环打回重评 第 ${payload.loop} 轮`);
    case 'worker.reused':
      return dim(`${label} 续用同一评估 Worker`);
    case 'escalate.human':
      return red(`${label} 转人工：${String(payload.reason ?? '').slice(0, 70)}`);
    case 'candidate.processed':
      return `${label} 处理结果：${payload.status}${payload.score ? `（${Number(payload.score).toFixed(1)} 分）` : ''}`;
    case 'report.generated':
      return green(`报告已生成：${(payload.top as string[] | undefined)?.join(', ')}`);
    case 'run.completed':
      return bold('运行完成');
    case 'run.failed':
      return red(`运行失败：${payload.error}`);
    default:
      return `${event.type} ${JSON.stringify(payload).slice(0, 100)}`;
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
      process.stdout.write(`${dim(event.ts.slice(11, 19))} ${dim(event.actor.padEnd(10))} ${summarizeEvent(event)}\n`);
    }
  };
  flush();
  const timer = setInterval(flush, 50);
  return () => {
    clearInterval(timer);
    flush();
  };
}

function printSummary(summary: RunSummary, job: JobRow): void {
  process.stdout.write(`\n${bold('══ 运行汇总 ══')}\n`);
  process.stdout.write(`任务: ${job.id}  状态: ${summary.status}  耗时: ${formatDuration(summary.durationMs)}\n`);
  process.stdout.write(`简历状态: ${Object.entries(summary.counts).map(([k, v]) => `${k}=${v}`).join('  ')}\n`);
  if (summary.top.length > 0) {
    process.stdout.write(`\n${bold('Top 候选人')}\n`);
    summary.top.forEach((candidate, index) => {
      process.stdout.write(`  ${index + 1}. ${candidate.label}  ${candidate.totalScore.toFixed(1)} 分  ${candidate.conclusion}\n`);
    });
  }
  process.stdout.write(`\n${bold('报告')}\n`);
  for (const [name, file] of Object.entries(summary.reports)) {
    process.stdout.write(`  ${name.padEnd(12)} ${relativeToCwd(file)}\n`);
  }
  process.stdout.write(`\n下一步: ${cyan('pnpm web')} 打开对话式控制台 ｜ ${cyan(`bole audit --resume ${summary.top[0]?.label ?? 'R01'}`)}\n\n`);
}

async function cmdRun(args: Args): Promise<void> {
  const requirements = str(args, 'jd') ?? args.positionals.join(' ');
  const filesDir = str(args, 'files');
  if (!requirements || requirements.trim().length < 5) throw new Error('请用 --jd "招聘需求..." 提供 HR 需求');
  if (!filesDir) throw new Error('请用 --files <dir> 指定简历目录');
  const allFiles = await listFilesRecursive(filesDir);
  const files: UploadedFile[] = allFiles
    .filter((file) => isSupportedUpload(file))
    .map((file) => ({
      uploadId: newId('cli'),
      filename: path.basename(file),
      path: file,
      size: statSync(file).size,
      contentType: detectContentType(file),
    }));
  if (files.length === 0) throw new Error(`目录中没有可处理的简历：${filesDir}`);

  const store = new ProviderStore(resolvePaths().dataDir);
  const active = await store.getActive();
  if (!active) throw new Error('尚未配置模型提供商：请先运行 pnpm web 在「设置与模型」中添加。');
  const apiKey = str(args, 'key') ?? active.apiKey;
  if (!apiKey) throw new Error(`模型提供商「${active.name}」未绑定 API Key：请先在 Web 设置中填写，或用 --key 传入。`);
  const boot = await bootstrap({ requirements, deepseekApiKey: apiKey });
  const { hitl, close } = makeHitl(args);
  const unsubscribe = subscribeEvents(boot.deps.ledger, boot.job.id);
  try {
    const summary = await runPipeline(boot.deps, { requirements, hitl, uploadFiles: files });
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
  reader.close();
  if (!job) throw new Error(`任务不存在: ${jobId}`);
  const store = new ProviderStore(paths.dataDir);
  const active = await store.getActive();
  if (!active) throw new Error('尚未配置模型提供商：请先运行 pnpm web 在「设置与模型」中添加。');
  const apiKey = str(args, 'key') ?? active.apiKey;
  if (!apiKey) throw new Error(`模型提供商「${active.name}」未绑定 API Key：请先在 Web 设置中填写，或用 --key 传入。`);
  const boot = await bootstrap({ requirements: job.requirements, jobId, seed: job.seed ?? 'resume', deepseekApiKey: apiKey });
  const { hitl, close } = makeHitl(args);
  const unsubscribe = subscribeEvents(boot.deps.ledger, jobId);
  try {
    const summary = await runPipeline(boot.deps, { requirements: job.requirements, hitl, resumeOnly: true });
    unsubscribe();
    printSummary(summary, boot.job);
  } finally {
    unsubscribe();
    close?.();
    boot.close();
  }
}

function openReader(): Ledger {
  return new Ledger(resolvePaths().dbPath);
}

function resolveJob(ledger: Ledger, args: Args): JobRow {
  const jobId = str(args, 'job');
  const job = jobId ? ledger.getJob(jobId) : ledger.latestJob();
  if (!job) throw new Error('台账中还没有任务：先用 pnpm web 发起筛选');
  return job;
}

function cmdStatus(args: Args): void {
  const ledger = openReader();
  try {
    const job = resolveJob(ledger, args);
    const limit = Number(str(args, 'events') ?? 30);
    process.stdout.write(`${bold('任务')} ${job.id}  ${job.title}  状态=${job.status}\n`);
    process.stdout.write(`需求: ${job.requirements}\n`);
    process.stdout.write(`简历: ${JSON.stringify(ledger.resumeCounts(job.id))}\n`);
    process.stdout.write(`parse: ${JSON.stringify(ledger.statusCounts('parse', job.id))}\n`);
    process.stdout.write(`eval:  ${JSON.stringify(ledger.statusCounts('eval', job.id))}\n`);
    process.stdout.write(`review:${JSON.stringify(ledger.statusCounts('review', job.id))} 裁决=${JSON.stringify(ledger.reviewVerdictCounts(job.id))}\n`);
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
  const found = resumes.find((resume) => resume.id === needle) ?? resumes.find((resume) => resume.label.toLowerCase() === needle.toLowerCase());
  if (!found) throw new Error(`找不到简历 ${needle}；可用: ${resumes.map((resume) => resume.label).join(', ')}`);
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
    if (!needle) throw new Error('请用 --resume <R01|res_id> 指定要审计的简历');
    const resume = findResume(ledger, job.id, needle);
    process.stdout.write(`${bold('证据链审计')} ${resume.label} (${resume.id})\n`);
    process.stdout.write(`格式=${resume.format} 状态=${resume.status} 批次=${resume.batch_id ?? '-'}\n`);
    for (const reason of JSON.parse(resume.reasons_json) as string[]) process.stdout.write(`  - ${reason}\n`);

    const parseTask = ledger
      .listTasks('parse', { jobId: job.id })
      .filter((task) => task.resume_id === resume.id && task.status === 'committed')
      .pop();
    if (parseTask?.fields_json) {
      const fields = JSON.parse(String(parseTask.fields_json)) as Record<string, { value: string; confidence: number }>;
      const spans = JSON.parse(String(parseTask.spans_json ?? '[]')) as { field: string; quote: string; charStart: number; charEnd: number }[];
      process.stdout.write(`\n${bold('① 解析字段与证据 span')}\n`);
      for (const [key, field] of Object.entries(fields)) {
        process.stdout.write(`  ${key}: ${maskFieldValue(key, field.value).slice(0, 80)} (conf=${field.confidence})\n`);
        for (const span of spans.filter((item) => item.field === key)) {
          process.stdout.write(`      ↳ [${span.charStart}-${span.charEnd}] 「${maskPII(span.quote)}」\n`);
        }
      }
    }

    const evalTask = ledger
      .listTasks('eval', { jobId: job.id })
      .filter((task) => task.resume_id === resume.id && task.status === 'committed')
      .pop();
    if (evalTask?.scores_json) {
      const dims = JSON.parse(String(evalTask.scores_json)) as { key: string; name: string; weight: number; score: number; rationale: string; spans: { quote: string; charStart: number; charEnd: number }[] }[];
      process.stdout.write(`\n${bold('② 评估结论')} 总分=${Number(evalTask.total_score).toFixed(1)} 结论=${evalTask.conclusion} 档位=${evalTask.tier ?? '-'} 阶段=${evalTask.phase ?? '-'}\n`);
      for (const dim of dims) {
        process.stdout.write(`  ${dim.name}（权重 ${dim.weight}%，${dim.score} 分）：${maskPII(dim.rationale)}\n`);
        for (const span of dim.spans ?? []) {
          process.stdout.write(`      ↳ [${span.charStart}-${span.charEnd}] 「${maskPII(span.quote)}」\n`);
        }
      }
    }

    process.stdout.write(`\n${bold('③ 核查记录')}\n`);
    const reviews = ledger.listTasks('review', { jobId: job.id }).filter((task) => task.resume_id === resume.id);
    if (reviews.length === 0) process.stdout.write('  无\n');
    for (const review of reviews) {
      process.stdout.write(`  轮次 ${review.loop_count}：${review.verdict}${review.escalation_reason ? ` — ${review.escalation_reason}` : ''}\n`);
      const checks = JSON.parse(String(review.checks_json ?? '[]')) as { claim: string; verdict: string; note: string }[];
      for (const check of checks) {
        process.stdout.write(`    ${check.verdict === 'supported' ? green('✓') : red('✗')} ${check.verdict}  ${maskPII(check.claim).slice(0, 70)} — ${check.note}\n`);
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
      // 跳过
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
      process.stdout.write(yellow('该任务还没有报告：先运行筛选\n'));
      return;
    }
    process.stdout.write(`${bold('报告目录')} ${relativeToCwd(dir)}\n`);
    for (const name of ['report.md', 'report.json', 'cost-report.md', 'convergence.svg']) {
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
    let prompt = 0;
    let completion = 0;
    let cached = 0;
    let cost = 0;
    process.stdout.write(`${bold('成本报表')} ${job.id}\n`);
    process.stdout.write('agent\tmodel\ttier\tcalls\tprompt\tcompletion\tcached\tcostUSD\n');
    for (const row of usage) {
      prompt += Number(row.promptTokens ?? 0);
      completion += Number(row.completionTokens ?? 0);
      cached += Number(row.cachedTokens ?? 0);
      cost += Number(row.costUsd ?? 0);
      process.stdout.write(`${row.agent}\t${row.model}\t${row.tier}\t${row.calls}\t${row.promptTokens}\t${row.completionTokens}\t${row.cachedTokens}\t${Number(row.costUsd ?? 0).toFixed(6)}\n`);
    }
    process.stdout.write(`\n合计: ${prompt} 输入 / ${completion} 输出 / ${cached} 缓存命中（${((cached / Math.max(1, prompt)) * 100).toFixed(1)}%）/ $${cost.toFixed(6)}\n`);
  } finally {
    ledger.close();
  }
}

function cmdAgents(): void {
  const registry = AgentRegistry.load();
  process.stdout.write(`${bold('Agent preset 注册表')} version=${registry.version} fingerprint=${registry.fingerprint}\n\n`);
  process.stdout.write('id\t名称\t档位\tmaxDepth\t输出 schema\t工具\n');
  for (const agent of registry.list()) {
    process.stdout.write(`${agent.id}\t${agent.nameZh}\t${agent.tier}\t${agent.maxDepth}\t\t${agent.outputSchema}\t${agent.tools.join(',')}\n`);
  }
}

async function cmdDoctor(): Promise<void> {
  const paths = resolvePaths();
  const config = loadPipelineConfig();
  process.stdout.write(`${bold('环境自检')}\n`);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  process.stdout.write(`Node ${process.versions.node}：${nodeMajor >= 22 ? green('OK') : red('需要 >=22.6')}\n`);
  const active = await new ProviderStore(paths.dataDir).getActive();
  process.stdout.write(`模型提供商：${active ? green(`${active.name}（${active.api}）${active.apiKey ? '' : ' 未绑定 Key'}`) : red('未配置（运行 pnpm web 添加）')}\n`);
  if (active) process.stdout.write(`模型档位：flash=${active.flashModel} / pro=${active.proModel}；深评 ${config.deepEval.percent}% → ${config.deepEval.tier}\n`);
  process.stdout.write(`简历来源：上传目录 ${relativeToCwd(paths.uploadsDir)}\n`);
  const knowledge = existsSync(paths.knowledgeDir) ? readdirSync(paths.knowledgeDir).filter((name) => name.endsWith('.md')).length : 0;
  process.stdout.write(`RAG 知识库：${knowledge} 个文档\n`);
  const ocrLangs = ['eng', 'chi_sim'].filter((lang) => existsSync(path.join(paths.ocrDir, `${lang}.traineddata.gz`)));
  const ocrMode = (process.env.BOLE_OCR_MODE ?? 'deepseek').toLowerCase();
  process.stdout.write(`OCR：${ocrMode === 'deepseek' || ocrMode === 'auto' ? `DeepSeek Vision（${process.env.BOLE_OCR_MODEL ?? active?.flashModel ?? config.models.flash}）` : ocrMode === 'local' ? '本地 Tesseract' : '外部 OCR'}${ocrMode === 'deepseek' || ocrMode === 'auto' ? `；本地回退${ocrLangs.length ? '就绪' : '未就绪（pnpm ocr:download）'}` : ''}\n`);
  process.stdout.write(`模型档位配置：flash=${config.models.flash} / pro=${config.models.pro}；深评 ${config.deepEval.percent}% → ${config.deepEval.tier}\n`);
  try {
    const ledger = new Ledger(paths.dbPath);
    process.stdout.write(`台账可写：${green('OK')}（${ledger.listJobs().length} 个历史任务）\n`);
    ledger.close();
  } catch (error) {
    process.stdout.write(`台账不可写：${red(error instanceof Error ? error.message : String(error))}\n`);
  }
}

async function cmdReset(args: Args): Promise<void> {
  const paths = resolvePaths();
  if (!bool(args, 'yes')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(yellow('将删除台账、运行产物与上传缓存，输入 "yes" 确认: '))).trim();
    rl.close();
    if (answer !== 'yes') {
      process.stdout.write('已取消。\n');
      return;
    }
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const file = `${paths.dbPath}${suffix}`;
    if (existsSync(file)) rmSync(file, { force: true });
  }
  for (const dir of [paths.runsDir, paths.uploadsDir]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  process.stdout.write(green('已清空台账、运行产出与上传缓存。\n'));
}

async function cmdWeb(args: Args): Promise<void> {
  const host = str(args, 'host') ?? '127.0.0.1';
  const port = Number(str(args, 'port') ?? '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`非法端口: ${port}`);
  const { startWebServer } = await import('../web/server.ts');
  await startWebServer({ host, port });
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (command) {
    case 'web':
      await cmdWeb(args);
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
    case 'agents':
      cmdAgents();
      break;
    case 'doctor':
      await cmdDoctor();
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
