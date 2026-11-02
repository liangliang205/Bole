/** 报告 → Word：使用开源库 docx（MIT）生成结构化报告文件。 */
import {
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { ReportData } from '../report/builder.ts';

const borders = {
  top: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
  bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
  left: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
  right: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
  insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
};

const dash = (value: unknown): string => (value === null || value === undefined || value === '' ? '—' : String(value));

function bullets(items: string[]): Paragraph[] {
  if (items.length === 0) return [new Paragraph({ text: '· 无', spacing: { after: 60 } })];
  return items.map((item) => new Paragraph({ text: `· ${item}`, spacing: { after: 60 } }));
}

function table(header: string[], rows: string[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders,
    rows: [
      new TableRow({
        tableHeader: true,
        children: header.map(
          (title) =>
            new TableCell({
              shading: { fill: 'F2F2F2' },
              children: [new Paragraph({ children: [new TextRun({ text: title, bold: true, size: 17 })] })],
            }),
        ),
      }),
      ...rows.map(
        (row) =>
          new TableRow({
            children: row.map(
              (cell) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: cell, size: 17 })] })] }),
            ),
          }),
      ),
    ],
  });
}

export async function buildReportDocx(report: ReportData): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: `伯乐 · 招聘筛选报告 — ${report.job.title}`, heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [
        new TextRun({ text: `生成时间：${report.run.generatedTs}`, size: 19, color: '555555' }),
        new TextRun({ text: `　Run：${report.run.runId}（${report.run.status === 'final' ? '定稿' : '草稿'}）`, size: 19, color: '555555' }),
        new TextRun({ text: `　耗时：${(report.run.durationMs / 1000).toFixed(1)} 秒`, size: 19, color: '555555' }),
      ],
      spacing: { after: 120 },
    }),
    new Paragraph({ text: '岗位需求（JD 摘要）', heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 100 } }),
    new Paragraph({ text: `岗位：${report.job.title}`, spacing: { after: 60 } }),
    ...bullets(report.job.jd.hardRequirements),
    new Paragraph({ text: `地点：${dash(report.job.jd.location)}；薪酬：${dash(report.job.jd.compensation)}`, spacing: { after: 100 } }),
    new Paragraph({ text: '评分卡', heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 100 } }),
    table(
      ['维度', '名称', '权重'],
      report.job.scorecard.dimensions.map((dim) => [dim.key, dim.name, dash(dim.weight)]),
    ),
    new Paragraph({ text: `推荐候选人（Top ${report.top.length}）`, heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 100 } }),
    table(
      ['#', '候选人', '总分', '结论', '核查', '档位'],
      report.top.map((candidate, index) => [
        String(index + 1),
        candidate.label,
        dash(candidate.totalScore),
        dash(candidate.conclusion),
        candidate.review ? `${candidate.review.verdict}（${candidate.review.supported}/${candidate.review.checks} 条证据支持）` : '—',
        `${candidate.evalTier}/${candidate.evalPhase}`,
      ]),
    ),
  ];

  report.top.forEach((candidate, index) => {
    children.push(
      new Paragraph({ text: `#${index + 1} ${candidate.label}`, heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 80 } }),
      new Paragraph({
        children: [
          new TextRun({
            text: `总分：${dash(candidate.totalScore)}；结论：${dash(candidate.conclusion)}；来源格式：${dash(candidate.sourceFormat)}。`,
            size: 19,
          }),
        ],
        spacing: { after: 60 },
      }),
    );
    for (const flag of candidate.redFlags) children.push(new Paragraph({ text: `⚠ 风险：${flag}`, spacing: { after: 40 } }));
    if (candidate.dimensions.length) {
      children.push(
        table(
          ['维度', '权重', '得分', '理由'],
          candidate.dimensions.map((dim) => [dim.name, dash(dim.weight), dash(dim.score), dim.rationale]),
        ),
      );
    }
    if (candidate.evidenceChain.length) {
      children.push(
        table(
          ['维度', '字段', '原文引用', '区间', '核验'],
          candidate.evidenceChain.slice(0, 40).map((span) => [
            span.dimension,
            span.field,
            span.quote,
            `${span.charStart}-${span.charEnd}`,
            span.verified ? `✓ ${span.verdict}` : span.verdict,
          ]),
        ),
      );
    }
    if (candidate.interview) {
      children.push(new Paragraph({ text: `面试建议：${candidate.interview.recommendation}`, spacing: { before: 60, after: 40 } }));
      for (const question of candidate.interview.questions) {
        children.push(new Paragraph({ text: `问：${question.question}（考察：${question.target}）`, spacing: { after: 40 } }));
      }
    }
  });

  if (report.escalations.length || report.others.length) {
    children.push(new Paragraph({ text: '其他候选人', heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 100 } }));
    if (report.escalations.length) {
      children.push(
        table(
          ['候选人', '原因', '重评轮数', '分数'],
          report.escalations.map((row) => [row.label, row.reason, String(row.loopCount), dash(row.score)]),
        ),
      );
    }
    if (report.others.length) {
      children.push(
        table(
          ['候选人', '总分', '结论', '说明'],
          report.others.map((row) => [row.label, dash(row.totalScore), dash(row.conclusion), row.reason]),
        ),
      );
    }
  }

  children.push(new Paragraph({ text: '合规', heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 100 } }));
  children.push(new Paragraph({ text: report.compliance.piiRedaction, spacing: { after: 60 } }));
  if (report.compliance.rubberStampWarning) {
    children.push(new Paragraph({ text: `⚠ ${report.compliance.rubberStampWarning}`, spacing: { after: 60 } }));
  }
  if (report.compliance.fairnessRemovals.length) {
    children.push(
      table(
        ['原文', '类别', '处理'],
        report.compliance.fairnessRemovals.map((row) => [row.text, row.category, row.action]),
      ),
    );
  }

  children.push(new Paragraph({ text: '成本', heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 100 } }));
  children.push(
    new Paragraph({
      text: `总调用 ${report.cost.totalCalls} 次；输入 ${report.cost.promptTokens} tok；输出 ${report.cost.completionTokens} tok；总成本 $${report.cost.costUsd.toFixed(4)}。`,
      spacing: { after: 60 },
    }),
  );
  if (report.cost.byAgent.length) {
    children.push(
      table(
        ['Agent', '模型', '档位', '调用', '输入tok', '输出tok', '成本USD'],
        report.cost.byAgent.map((row) => [
          row.agent,
          row.model,
          row.tier,
          String(row.calls),
          String(row.promptTokens),
          String(row.completionTokens),
          row.costUsd.toFixed(4),
        ]),
      ),
    );
  }

  children.push(new Paragraph({ text: '已知限制', heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 100 } }));
  children.push(...bullets(report.limitations));

  const buffer = await Packer.toBuffer(
    new Document({ creator: 'BoLe', title: `伯乐 · 招聘筛选报告 — ${report.job.title}`, sections: [{ children }] }),
  );
  return Buffer.from(buffer);
}
