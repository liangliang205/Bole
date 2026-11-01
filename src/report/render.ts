import path from 'node:path';
import { writeJson, writeText } from '../util/fsx.ts';
import { maskPII } from '../util/text.ts';
import type { ReportData } from './builder.ts';

export interface ReportPaths {
  markdown: string;
  json: string;
  cost: string;
  convergence: string;
}

function fmtScore(value: number): string {
  return value.toFixed(1);
}

function statusLabel(status: 'final' | 'draft'): string {
  return status === 'final' ? '终稿（HR 已确认）' : '草稿（待 HR 确认）';
}

function table(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}`;
}

function topMarkdown(data: ReportData): string {
  const lines: string[] = [];
  data.top.forEach((candidate, index) => {
    lines.push(`### ${index + 1}. ${candidate.label} — ${fmtScore(candidate.totalScore)} 分（${candidate.conclusion}）`);
    lines.push('');
    lines.push(
      table(
        ['维度', '权重', '得分', '评估理由'],
        candidate.dimensions.map((dim) => [
          dim.name || dim.key,
          `${dim.weight}%`,
          dim.score.toFixed(1),
          dim.rationale.replace(/\|/g, '\\|'),
        ]),
      ),
    );
    lines.push('');
    lines.push('**证据链（结论 → 原文引用 → 位置 → 核查）**');
    lines.push('');
    lines.push(
      `评估档位：\`${candidate.evalTier}\` / ${candidate.evalPhase === 'deep' ? '深评' : candidate.evalPhase === 'revise' ? '返工' : '初筛'}${candidate.evalTier === 'pro' ? '（短名单深评）' : '（全量初筛）'}`,
    );
    lines.push('');
    lines.push(
      table(
        ['维度', '原文引用', '字符区间', '核查'],
        candidate.evidenceChain.map((evidence) => [
          evidence.dimension,
          `「${evidence.quote.replace(/\|/g, '\\|')}」`,
          `${evidence.charStart}-${evidence.charEnd}`,
          evidence.verified ? '✓ 已核对' : '✗ 未通过/未核对',
        ]),
      ),
    );
    lines.push('');
    if (candidate.interview) {
      lines.push('**面试建议**');
      lines.push('');
      for (const question of candidate.interview.questions) {
        lines.push(`- ${question.question}`);
        lines.push(`  - 验证目标：${question.target}${question.evidenceHint ? `；关联证据：「${maskPII(question.evidenceHint)}」` : ''}`);
      }
      if (candidate.interview.risks.length > 0) {
        lines.push(`- 风险提示：${candidate.interview.risks.join('；')}`);
      }
      lines.push(`- 用人建议：${candidate.interview.recommendation}`);
    }
    if (candidate.uncertainties.length > 0) {
      lines.push(`- 不确定项：${candidate.uncertainties.join('；')}`);
    }
    if (candidate.anomalies.length > 0) {
      lines.push(`- 简历异常：${candidate.anomalies.join('；')}`);
    }
    if (candidate.review) {
      lines.push(
        `- 核查记录：${candidate.review.verdict}（验真环第 ${candidate.review.loopCount} 轮，${candidate.review.supported}/${candidate.review.checks} 条结论有证据支持，合规风险 ${candidate.review.compliance.risk}）`,
      );
    }
    lines.push('');
  });
  return lines.join('\n');
}

export function renderMarkdown(data: ReportData): string {
  const resumeTotal =
    data.top.length + data.escalations.length + data.others.length + data.compliance.duplicates.length + data.compliance.failed.length;
  const lines: string[] = [];
  lines.push(`# BoLe 招聘筛选报告 — ${data.job.title}`);
  lines.push('');
  lines.push(`> 报告状态：**${statusLabel(data.run.status)}**｜运行：\`${data.run.runId}\`｜模型：${data.run.provider}｜生成：${data.run.generatedTs}`);
  lines.push('> 平台只提供筛选建议，不生成 offer/拒信；最终用人决定由 HR 负责。');
  lines.push('');
  lines.push('## 1. 摘要');
  lines.push('');
  lines.push(
    table(
      ['指标', '数值'],
      [
        ['本次处理简历', `${resumeTotal} 份（其中推荐 ${data.top.length} 人）`],
        ['核查通过', `${data.compliance.reviewStats.pass} 次裁决`],
        ['验真环打回', `${data.compliance.reviewStats.re_eval} 次`],
        ['转人工', `${data.escalations.length} 人`],
        ['解析/评估失败', `${data.compliance.failed.length} 份`],
        ['重复投递去重', `${data.compliance.duplicates.length} 份`],
        ['核查否决率', `${(data.compliance.reviewStats.vetoRate * 100).toFixed(1)}%`],
      ],
    ),
  );
  lines.push('');
  if (data.top.length > 0) {
    lines.push(
      table(
        ['排名', '候选人', '总分', '结论', '推荐理由', '审核'],
        data.top.map((candidate, index) => [
          String(index + 1),
          candidate.label,
          fmtScore(candidate.totalScore),
          candidate.conclusion,
          candidate.reason.replace(/\|/g, '\\|'),
          candidate.review ? `${candidate.review.verdict}（${candidate.review.loopCount} 轮）` : '—',
        ]),
      ),
    );
    lines.push('');
  } else {
    lines.push('_本次没有候选人通过证据核查，未生成推荐。_');
    lines.push('');
  }

  lines.push('## 2. 推荐候选人（含证据链与面试建议）');
  lines.push('');
  lines.push('> 证据的字符区间以归一化简历文本为基准（`runs/<runId>/resumes/norm/`）；原始附件保留在 `runs/<runId>/resumes/raw/`，可直接复核引用。');
  lines.push('');
  lines.push(topMarkdown(data) || '_无_');
  lines.push('');

  lines.push('## 3. 转人工队列');
  lines.push('');
  if (data.escalations.length === 0) {
    lines.push('_本次没有转人工项。_');
  } else {
    lines.push(
      table(
        ['候选人', '原因', '已重评轮次', '当前分数'],
        data.escalations.map((item) => [
          item.label,
          item.reason.replace(/\|/g, '\\|'),
          String(item.loopCount),
          item.score === null ? '—' : fmtScore(item.score),
        ]),
      ),
    );
  }
  lines.push('');

  lines.push('## 4. 合规报告');
  lines.push('');
  lines.push('### 4.1 公平性（反歧视）');
  lines.push('');
  if (data.compliance.fairnessRemovals.length > 0) {
    lines.push('以下需求条件因涉及受保护属性，已被剥离出评分范围：');
    lines.push('');
    lines.push(
      table(
        ['原始条件', '类别', '处理'],
        data.compliance.fairnessRemovals.map((item) => [
          item.text.replace(/\|/g, '\\|'),
          item.category,
          item.action,
        ]),
      ),
    );
  } else {
    lines.push('未在需求中发现受保护属性条件。');
  }
  lines.push('');
  for (const finding of data.compliance.fairnessFindings) lines.push(`- ${finding}`);
  if (data.compliance.rubberStampWarning) {
    lines.push(`- ⚠️ ${data.compliance.rubberStampWarning}`);
  }
  lines.push('');
  lines.push('### 4.2 数据与隐私');
  lines.push('');
  lines.push(`- ${data.compliance.piiRedaction}`);
  lines.push('');
  lines.push('### 4.3 重复投递');
  lines.push('');
  if (data.compliance.duplicates.length === 0) {
    lines.push('_未发现重复投递。_');
  } else {
    lines.push(
      table(
        ['简历', '与谁重复', '判定依据'],
        data.compliance.duplicates.map((item) => [
          item.label,
          item.duplicateOf,
          item.reason.replace(/\|/g, '\\|'),
        ]),
      ),
    );
  }
  lines.push('');
  lines.push('### 4.4 处理失败明细（不静默丢弃）');
  lines.push('');
  if (data.compliance.failed.length === 0) {
    lines.push('_本次没有失败项。_');
  } else {
    lines.push(
      table(
        ['简历', '失败原因'],
        data.compliance.failed.map((item) => [item.label, item.reason.replace(/\|/g, '\\|')]),
      ),
    );
  }
  lines.push('');

  lines.push('## 5. 其他候选人');
  lines.push('');
  if (data.others.length === 0) {
    lines.push('_无_');
  } else {
    lines.push(
      table(
        ['候选人', '总分', '结论', '说明'],
        data.others.map((item) => [item.label, fmtScore(item.totalScore), item.conclusion, item.reason]),
      ),
    );
  }
  lines.push('');

  lines.push('## 6. HITL 决策记录（可审计）');
  lines.push('');
  if (data.hitl.length === 0) {
    lines.push('_本次没有 HITL 决策记录。_');
  } else {
    lines.push(
      table(
        ['节点', '问题', '回答', '操作者', '时间'],
        data.hitl.map((decision) => [
          decision.node,
          decision.question.replace(/\|/g, '\\|'),
          decision.answer.replace(/\|/g, '\\|'),
          decision.actor,
          decision.ts,
        ]),
      ),
    );
  }
  lines.push('');

  lines.push('## 7. 成本与调度');
  lines.push('');
  lines.push(
    table(
      ['阶段', '调用次数', '输入 tokens', '输出 tokens', '成本（USD）'],
      data.cost.byStage.map((stage) => [
        stage.stage,
        String(stage.calls),
        String(stage.promptTokens),
        String(stage.completionTokens),
        stage.costUsd.toFixed(6),
      ]),
    ),
  );
  lines.push('');
  lines.push(
    `合计：${data.cost.totalCalls} 次调用，输入 ${data.cost.promptTokens} tokens（缓存命中 ${data.cost.cachedTokens}），输出 ${data.cost.completionTokens} tokens，成本 $${data.cost.costUsd}；无前缀缓存基线 $${data.cost.baselineCostUsd}，节省 $${data.cost.cacheSavingsUsd}。`,
  );
  lines.push('');
  lines.push(
    table(
      ['容量池', '容量', '峰值并发', '获取', '拒绝', '释放'],
      data.pools.map((pool) => [
        pool.name,
        String(pool.capacity),
        String(pool.peak),
        String(pool.acquired),
        String(pool.refused),
        String(pool.released),
      ]),
    ),
  );
  lines.push('');
  lines.push(
    `验真环收敛：${data.convergence
      .map((point) => `第 ${point.round} 轮 ${point.passed}/${point.reviews} 通过（${(point.rate * 100).toFixed(0)}%）`)
      .join('；') || '未触发打回'}。`,
  );
  lines.push('');

  lines.push('## 8. 已知限制（兑现"无夸大"）');
  lines.push('');
  for (const item of data.limitations) lines.push(`- ${item}`);
  lines.push('');
  lines.push(`事件总数：${data.eventsCount}（可通过 \`bole status --job ${data.job.id}\` 查看完整事件流）。`);
  lines.push('');
  return lines.join('\n');
}

export function renderCostReport(data: ReportData): string {
  const lines: string[] = [];
  lines.push(`# BoLe 成本与缓存报表（${data.job.title}）`);
  lines.push('');
  lines.push(`> 运行 ${data.run.runId}｜provider=${data.run.provider}｜生成 ${data.run.generatedTs}`);
  lines.push('');
  lines.push('## 1. 按 Agent 汇总');
  lines.push('');
  lines.push(
    table(
      ['Agent', '模型', '档位', '调用', '输入 tokens', '输出 tokens', '缓存 tokens', '成本 USD'],
      data.cost.byAgent.map((row) => [
        row.agent,
        row.model,
        row.tier,
        String(row.calls),
        String(row.promptTokens),
        String(row.completionTokens),
        String(row.cachedTokens),
        Number(row.costUsd ?? 0).toFixed(6),
      ]),
    ),
  );
  lines.push('');
  lines.push('## 2. 按阶段（schema）汇总');
  lines.push('');
  lines.push(
    table(
      ['阶段', '调用', '输入 tokens', '输出 tokens', '成本 USD'],
      data.cost.byStage.map((row) => [
        row.stage,
        String(row.calls),
        String(row.promptTokens),
        String(row.completionTokens),
        row.costUsd.toFixed(6),
      ]),
    ),
  );
  lines.push('');
  lines.push('## 3. 缓存前缀对齐对比（实测）');
  lines.push('');
  lines.push(
    table(
      ['指标', '无前缀对齐（基线）', '有前缀对齐（本次）'],
      [
        ['输入 tokens', String(data.cost.promptTokens), String(data.cost.promptTokens)],
        ['缓存命中 tokens', '0', String(data.cost.cachedTokens)],
        ['缓存命中率', '0%', `${(data.cost.cacheHitRate * 100).toFixed(1)}%`],
        ['成本 USD', data.cost.baselineCostUsd.toFixed(6), data.cost.costUsd.toFixed(6)],
        ['节省', '—', `${data.cost.cacheSavingsUsd.toFixed(6)} USD`],
      ],
    ),
  );
  lines.push('');
  lines.push('说明：基线 = 同一批调用在"系统提示词/评分卡/工具池完全重复发送、无缓存"下的成本；本次 = 共享常量前缀 + 请求末尾差异内容的实测成本。Mock 模式下缓存 token 由前缀长度确定性估算，DeepSeek 模式取 API 返回的 `prompt_cache_hit_tokens`。');
  lines.push('');
  lines.push('## 4. 调度资源');
  lines.push('');
  lines.push(
    table(
      ['容量池', '容量', '峰值', '获取', '拒绝（不排队）', '超时'],
      data.pools.map((pool) => [
        pool.name,
        String(pool.capacity),
        String(pool.peak),
        String(pool.acquired),
        String(pool.refused),
        String(pool.timeouts),
      ]),
    ),
  );
  lines.push('');
  return lines.join('\n');
}

export function renderConvergenceSvg(data: ReportData): string {
  const points = data.convergence;
  const width = 560;
  const height = 260;
  const padLeft = 44;
  const padBottom = 36;
  const plotW = width - padLeft - 24;
  const plotH = height - padBottom - 24;
  const rounds = Math.max(1, points.length);
  const x = (index: number): number => padLeft + (points.length <= 1 ? plotW / 2 : (index / (rounds - 1)) * plotW);
  const y = (rate: number): number => 24 + (1 - rate) * plotH;

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((rate) => {
      const gy = y(rate);
      return `<line x1="${padLeft}" y1="${gy}" x2="${padLeft + plotW}" y2="${gy}" stroke="#e4e8ef" stroke-width="1"/>
        <text x="${padLeft - 8}" y="${gy + 4}" text-anchor="end" font-size="10" fill="#6b778c">${Math.round(rate * 100)}%</text>`;
    })
    .join('');

  const centers = points
    .map((point, index) => `${x(index)},${y(point.rate)}`)
    .join(' ');

  const dots = points
    .map(
      (point, index) => `<circle cx="${x(index)}" cy="${y(point.rate)}" r="4" fill="#2457d6"/>
      <text x="${x(index)}" y="${y(point.rate) - 10}" text-anchor="middle" font-size="11" fill="#1a2233">${(point.rate * 100).toFixed(0)}%</text>
      <text x="${x(index)}" y="${height - 12}" text-anchor="middle" font-size="11" fill="#6b778c">第 ${point.round} 轮 (${point.passed}/${point.reviews})</text>`,
    )
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="验真环收敛曲线">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${padLeft}" y="14" font-size="12" fill="#1a2233">验真环逐轮通过率（通过数/核查数）</text>
  ${gridLines}
  <line x1="${padLeft}" y1="${24 + plotH}" x2="${padLeft + plotW}" y2="${24 + plotH}" stroke="#94a3b8" stroke-width="1"/>
  ${points.length > 1 ? `<polyline points="${centers}" fill="none" stroke="#2457d6" stroke-width="2"/>` : ''}
  ${dots}
</svg>`;
}

export async function writeReports(data: ReportData, runDir: string): Promise<ReportPaths> {
  const paths: ReportPaths = {
    markdown: path.join(runDir, 'report.md'),
    json: path.join(runDir, 'report.json'),
    cost: path.join(runDir, 'cost-report.md'),
    convergence: path.join(runDir, 'convergence.svg'),
  };
  await writeText(paths.markdown, renderMarkdown(data));
  await writeJson(paths.json, data);
  await writeText(paths.cost, renderCostReport(data));
  await writeText(paths.convergence, renderConvergenceSvg(data));
  return paths;
}
