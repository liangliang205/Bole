import path from 'node:path';
import { writeJson, writeText } from '../util/fsx.ts';
import { escapeHtml, maskPII } from '../util/text.ts';
import type { ReportData } from './builder.ts';

export interface ReportPaths {
  markdown: string;
  json: string;
  html: string;
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
        ['排名', '候选人', '总分', '结论', '审核'],
        data.top.map((candidate, index) => [
          String(index + 1),
          candidate.label,
          fmtScore(candidate.totalScore),
          candidate.conclusion,
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

export function renderHtml(data: ReportData): string {
  const reportData = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BoLe 控制台 — ${escapeHtml(data.job.title)}</title>
<style>
:root{
  color-scheme:dark;
  --bg:#0b1220;
  --panel:#111b2e;
  --panel-soft:#16243d;
  --line:#273a5f;
  --text:#d8e4ff;
  --muted:#91a5ca;
  --accent:#4d8bff;
  --ok:#30c48d;
  --warn:#ffb020;
  --danger:#ff647c;
}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 500px at 30% -200px,#1f3a72 0%,var(--bg) 45%);color:var(--text);font-family:Inter,"Segoe UI","Noto Sans SC",sans-serif}
.layout{display:grid;grid-template-columns:280px 1fr;min-height:100vh}
.sidebar{border-right:1px solid var(--line);background:linear-gradient(180deg,#0f1930 0%,#0b1220 100%);padding:20px 16px 16px;position:sticky;top:0;height:100vh;overflow:auto}
.logo{font-size:20px;font-weight:700;margin:0 0 6px}
.sub{margin:0 0 14px;color:var(--muted);font-size:12px;line-height:1.6}
.chip{display:inline-flex;padding:3px 9px;border-radius:999px;background:#21355b;color:#a9c4ff;font-size:12px;border:1px solid #33507f}
.side-title{margin:20px 0 8px;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.nav button{display:block;width:100%;text-align:left;border:1px solid transparent;background:transparent;color:var(--text);padding:10px 12px;border-radius:10px;margin-bottom:8px;cursor:pointer}
.nav button:hover{background:#152643}
.nav button.active{background:#1b2f51;border-color:#345687}
.side-list{list-style:none;padding:0;margin:0;display:grid;gap:8px}
.side-list li{padding:8px 10px;border-radius:8px;background:#0f1a31;border:1px solid #213559;color:var(--muted);font-size:12px}
.main{padding:22px;max-width:1280px}
.hero{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;background:rgba(17,27,46,.75);border:1px solid var(--line);border-radius:16px;padding:18px 20px}
.hero h1{margin:0 0 8px;font-size:24px}
.hero p{margin:4px 0;color:var(--muted);font-size:13px}
.status{padding:4px 10px;border-radius:999px;background:#1d345a;border:1px solid #385b90;color:#b8d1ff;font-size:12px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:16px 0}
.kpi{background:rgba(17,27,46,.9);border:1px solid var(--line);border-radius:14px;padding:14px}
.kpi b{display:block;font-size:26px;line-height:1.1;color:#fff}
.kpi span{font-size:12px;color:var(--muted)}
.view{display:none}
.view.active{display:block}
.card{background:rgba(17,27,46,.92);border:1px solid var(--line);border-radius:14px;padding:16px;margin:14px 0}
.card h2{margin:0 0 10px;font-size:17px}
.card h3{margin:14px 0 8px;font-size:14px}
table{border-collapse:collapse;width:100%}
th,td{border-bottom:1px solid var(--line);padding:8px 10px;font-size:12px;text-align:left;vertical-align:top}
th{color:#a8bde6;font-weight:600;background:#10203a}
.muted{color:var(--muted);font-size:12px}
.good{color:var(--ok)}
.warn{color:var(--warn)}
.danger{color:var(--danger)}
.grid-2{display:grid;grid-template-columns:minmax(280px,360px) 1fr;gap:12px}
.candidate-list button{width:100%;text-align:left;background:#10203a;border:1px solid #253c63;color:var(--text);padding:10px;border-radius:10px;margin-bottom:8px;cursor:pointer}
.candidate-list button.active{background:#1c355b;border-color:#4b76bb}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;border:1px solid #395d94;background:#18325a;color:#b8d1ff}
ul.clean{list-style:none;padding:0;margin:0;display:grid;gap:8px}
ul.clean li{padding:9px 10px;border-radius:10px;background:#0e1a30;border:1px solid #243a5f;font-size:12px;line-height:1.6}
code{background:#0f1a31;padding:2px 6px;border-radius:6px;border:1px solid #243a5f;color:#bad3ff}
@media (max-width: 1050px){
  .layout{grid-template-columns:1fr}
  .sidebar{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)}
  .grid-2{grid-template-columns:1fr}
}
</style>
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    <p class="logo">BoLe Frontend</p>
    <p class="sub">DeepSeek Harness 风格控制台 · 多 Agent 招聘筛选可视化</p>
    <span class="chip">${statusLabel(data.run.status)}</span>
    <p class="side-title">导航</p>
    <nav class="nav" id="tab-nav">
      <button class="active" data-view="overview">运行总览</button>
      <button data-view="candidates">候选人视图</button>
      <button data-view="compliance">合规与风险</button>
      <button data-view="cost">成本与调度</button>
      <button data-view="hitl">HITL 与限制</button>
    </nav>
    <p class="side-title">运行信息</p>
    <ul class="side-list">
      <li><b>Run ID</b><br><code>${escapeHtml(data.run.runId)}</code></li>
      <li><b>Job</b><br>${escapeHtml(data.job.title)}</li>
      <li><b>Provider</b><br>${escapeHtml(data.run.provider)}</li>
      <li><b>Seed</b><br>${escapeHtml(data.run.seed)}</li>
      <li><b>事件数</b><br>${data.eventsCount}</li>
    </ul>
  </aside>
  <main class="main">
    <section class="hero">
      <div>
        <h1>BoLe 招聘筛选控制台</h1>
        <p>${escapeHtml(data.job.title)}｜${escapeHtml(data.job.id)}｜生成时间 ${escapeHtml(data.run.generatedTs)}</p>
        <p>平台只提供建议，不做最终用人决策。每个结论均附简历证据引用与字符区间。</p>
      </div>
      <span class="status">${statusLabel(data.run.status)}</span>
    </section>

    <section class="kpis">
      <div class="kpi"><b>${data.top.length}</b><span>推荐候选人</span></div>
      <div class="kpi"><b>${data.escalations.length}</b><span>转人工</span></div>
      <div class="kpi"><b>${(data.compliance.reviewStats.vetoRate * 100).toFixed(1)}%</b><span>核查否决率</span></div>
      <div class="kpi"><b>$${data.cost.costUsd.toFixed(3)}</b><span>本次模型成本</span></div>
      <div class="kpi"><b>${data.cost.totalCalls}</b><span>模型调用次数</span></div>
    </section>

    <section id="view-overview" class="view active"></section>
    <section id="view-candidates" class="view"></section>
    <section id="view-compliance" class="view"></section>
    <section id="view-cost" class="view"></section>
    <section id="view-hitl" class="view"></section>
  </main>
</div>

<script id="report-data" type="application/json">${reportData}</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById('report-data').textContent || '{}');
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
  const score = (value) => Number(value ?? 0).toFixed(1);
  const table = (headers, rows) =>
    \`<table><thead><tr>\${headers.map((h) => \`<th>\${esc(h)}</th>\`).join('')}</tr></thead><tbody>\${
      rows.length
        ? rows.map((row) => \`<tr>\${row.map((col) => \`<td>\${col}</td>\`).join('')}</tr>\`).join('')
        : \`<tr><td colspan="\${headers.length}" class="muted">无数据</td></tr>\`
    }</tbody></table>\`;

  const summaryTable = table(
    ['指标', '值'],
    [
      [esc('处理简历'), esc(String(data.top.length + data.others.length + data.escalations.length + data.compliance.duplicates.length + data.compliance.failed.length))],
      [esc('核查通过'), esc(String(data.compliance.reviewStats.pass))],
      [esc('核查打回'), esc(String(data.compliance.reviewStats.re_eval))],
      [esc('转人工'), esc(String(data.compliance.reviewStats.escalate))],
      [esc('缓存命中'), esc(\`\${(Number(data.cost.cacheHitRate) * 100).toFixed(1)}%\`)],
    ],
  );
  const rankTable = table(
    ['排名', '候选人', '总分', '结论', '核查'],
    data.top.map((item, idx) => [
      esc(String(idx + 1)),
      esc(item.label),
      esc(score(item.totalScore)),
      \`<span class="badge">\${esc(item.conclusion)}</span>\`,
      esc(item.review ? \`\${item.review.verdict}（\${item.review.loopCount}轮）\` : '—'),
    ]),
  );
  document.getElementById('view-overview').innerHTML = \`
    <div class="card"><h2>岗位需求概览</h2><p class="muted">\${esc(data.job.requirements)}</p></div>
    <div class="card"><h2>运行摘要</h2>\${summaryTable}</div>
    <div class="card"><h2>Top 推荐</h2>\${rankTable}</div>
  \`;

  const candidateContainer = document.getElementById('view-candidates');
  if (!data.top.length) {
    candidateContainer.innerHTML = '<div class="card"><h2>候选人视图</h2><p class="muted">没有通过核查的候选人。</p></div>';
  } else {
    let selected = 0;
    const renderCandidate = () => {
      const candidate = data.top[selected];
      const dimTable = table(
        ['维度', '权重', '得分', '评估理由'],
        candidate.dimensions.map((dim) => [
          esc(dim.name || dim.key),
          esc(\`\${dim.weight}%\`),
          esc(score(dim.score)),
          esc(dim.rationale),
        ]),
      );
      const evidenceTable = table(
        ['维度', '引用', '区间', '核查'],
        candidate.evidenceChain.map((item) => [
          esc(item.dimension),
          esc(item.quote),
          esc(\`\${item.charStart}-\${item.charEnd}\`),
          item.verified ? '<span class="good">✓ supported</span>' : '<span class="danger">✗ unsupported</span>',
        ]),
      );
      const interview = candidate.interview
        ? \`<ul class="clean">\${candidate.interview.questions
            .map((q) => \`<li>\${esc(q.question)}<div class="muted">验证目标：\${esc(q.target)}</div></li>\`)
            .join('')}</ul>\`
        : '<p class="muted">暂无面试建议</p>';
      const notes = [ ...(candidate.uncertainties || []), ...(candidate.anomalies || []), ...(candidate.redFlags || []) ];

      candidateContainer.innerHTML = \`
        <div class="grid-2">
          <div class="card candidate-list">
            <h2>候选人列表</h2>
            \${data.top
              .map((item, idx) => \`<button data-index="\${idx}" class="\${idx === selected ? 'active' : ''}">
                <div><b>#\${idx + 1} \${esc(item.label)}</b> <span class="badge">\${esc(score(item.totalScore))}</span></div>
                <div class="muted">\${esc(item.conclusion)} · \${item.review ? esc(item.review.verdict) : 'pending'}</div>
              </button>\`)
              .join('')}
          </div>
          <div>
            <div class="card"><h2>\${esc(candidate.label)} <span class="badge">\${esc(score(candidate.totalScore))}</span></h2>
              <p class="muted">结论：\${esc(candidate.conclusion)}｜核查：\${esc(candidate.review ? \`\${candidate.review.verdict}（\${candidate.review.loopCount} 轮）\` : '—')}</p>
              \${dimTable}
            </div>
            <div class="card"><h2>证据链</h2>\${evidenceTable}</div>
            <div class="card"><h2>面试建议</h2>\${interview}</div>
            <div class="card"><h2>风险与不确定项</h2>\${
              notes.length
                ? \`<ul class="clean">\${notes.map((note) => \`<li>\${esc(note)}</li>\`).join('')}</ul>\`
                : '<p class="muted">无</p>'
            }</div>
          </div>
        </div>
      \`;
      candidateContainer.querySelectorAll('button[data-index]').forEach((button) => {
        button.addEventListener('click', () => {
          selected = Number(button.dataset.index || 0);
          renderCandidate();
        });
      });
    };
    renderCandidate();
  }

  document.getElementById('view-compliance').innerHTML = \`
    <div class="card"><h2>公平性剥离与发现</h2>
      \${table(
        ['剥离条件', '类别', '处理'],
        (data.compliance.fairnessRemovals || []).map((item) => [esc(item.text), esc(item.category), esc(item.action)]),
      )}
      <h3>合规提示</h3>
      <ul class="clean">\${(data.compliance.fairnessFindings || []).map((item) => \`<li>\${esc(item)}</li>\`).join('') || '<li>无</li>'}</ul>
      \${data.compliance.rubberStampWarning ? \`<p class="warn">⚠️ \${esc(data.compliance.rubberStampWarning)}</p>\` : ''}
      <p class="muted">\${esc(data.compliance.piiRedaction)}</p>
    </div>
    <div class="card"><h2>转人工 / 重复 / 失败明细</h2>
      <h3>转人工</h3>
      \${table(
        ['候选人', '原因', '重评轮次', '当前分数'],
        (data.escalations || []).map((item) => [esc(item.label), esc(item.reason), esc(item.loopCount), esc(item.score == null ? '—' : score(item.score))]),
      )}
      <h3>重复投递</h3>
      \${table(
        ['候选人', '重复对象', '判定依据'],
        (data.compliance.duplicates || []).map((item) => [esc(item.label), esc(item.duplicateOf), esc(item.reason)]),
      )}
      <h3>失败明细</h3>
      \${table(
        ['候选人', '失败原因'],
        (data.compliance.failed || []).map((item) => [esc(item.label), esc(item.reason)]),
      )}
    </div>
  \`;

  document.getElementById('view-cost').innerHTML = \`
    <div class="card"><h2>按 Agent 计费</h2>
      \${table(
        ['Agent', '模型', '档位', '调用', '输入', '输出', '缓存', '成本(USD)'],
        (data.cost.byAgent || []).map((item) => [
          esc(item.agent), esc(item.model), esc(item.tier), esc(item.calls), esc(item.promptTokens), esc(item.completionTokens), esc(item.cachedTokens), esc(Number(item.costUsd).toFixed(6)),
        ]),
      )}
    </div>
    <div class="card"><h2>按阶段统计</h2>
      \${table(
        ['阶段', '调用', '输入', '输出', '成本(USD)'],
        (data.cost.byStage || []).map((item) => [esc(item.stage), esc(item.calls), esc(item.promptTokens), esc(item.completionTokens), esc(Number(item.costUsd).toFixed(6))]),
      )}
      <p class="muted">总成本 $ \${esc(Number(data.cost.costUsd).toFixed(6))}，无缓存基线 $ \${esc(Number(data.cost.baselineCostUsd).toFixed(6))}，节省 $ \${esc(Number(data.cost.cacheSavingsUsd).toFixed(6))}。</p>
    </div>
    <div class="card"><h2>调度池利用率</h2>
      \${table(
        ['容量池', '容量', '峰值', '获取', '拒绝', '超时'],
        (data.pools || []).map((item) => [esc(item.name), esc(item.capacity), esc(item.peak), esc(item.acquired), esc(item.refused), esc(item.timeouts)]),
      )}
    </div>
  \`;

  document.getElementById('view-hitl').innerHTML = \`
    <div class="card"><h2>HITL 决策记录</h2>
      \${table(
        ['节点', '问题', '回答', '操作者', '时间'],
        (data.hitl || []).map((item) => [esc(item.node), esc(item.question), esc(item.answer), esc(item.actor), esc(item.ts)]),
      )}
    </div>
    <div class="card"><h2>已知限制（无夸大）</h2>
      <ul class="clean">\${(data.limitations || []).map((item) => \`<li>\${esc(item)}</li>\`).join('')}</ul>
    </div>
  \`;

  const tabs = document.querySelectorAll('#tab-nav button');
  const views = document.querySelectorAll('.view');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((item) => item.classList.remove('active'));
      tab.classList.add('active');
      views.forEach((view) => view.classList.remove('active'));
      const id = 'view-' + tab.dataset.view;
      const target = document.getElementById(id);
      if (target) target.classList.add('active');
    });
  });
})();
</script>
</body>
</html>`;
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
    html: path.join(runDir, 'report.html'),
    cost: path.join(runDir, 'cost-report.md'),
    convergence: path.join(runDir, 'convergence.svg'),
  };
  await writeText(paths.markdown, renderMarkdown(data));
  await writeJson(paths.json, data);
  await writeText(paths.html, renderHtml(data));
  await writeText(paths.cost, renderCostReport(data));
  await writeText(paths.convergence, renderConvergenceSvg(data));
  return paths;
}
