import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { bootstrap } from '../../src/bootstrap.ts';
import { runPipeline } from '../../src/agents/coordinator.ts';
import { AutoHitlResponder } from '../../src/agents/hitl.ts';
import type { UploadedFile } from '../../src/types.ts';
import { FakeProvider } from '../fixtures/fake-provider.ts';
import { setupTempEnv } from '../helpers/env.ts';

const RESUME_A = `姓名：张伟
手机：13800000001
邮箱：zhangwei@example.com
求职意向：Java 后端工程师
教育背景：2015-2019 华东理工大学 计算机科学与技术 本科
工作年限：7 年
技能标签：Java、Spring Boot、MySQL、Redis、Kafka
工作经历：
2019.07-2024.06 某某科技有限公司 后端工程师
负责支付系统订单模块，使用 Java、Spring Boot、MySQL。
项目经历：
1. 支付网关重构：主导微服务拆分，P99 从 800ms 降到 180ms。
2. 订单系统分库分表：QPS 从 2k 提升到 12k。
期望薪资：40-50K
`;

const RESUME_B = `姓名：李娜
手机：13800000002
邮箱：lina@example.com
求职意向：Java 后端工程师
教育背景：2016-2020 上海大学 软件工程 本科
工作年限：6 年
技能标签：Java、Spring Cloud、MySQL、Redis、Docker
工作经历：
2020.07-2024.06 某某支付公司 后端工程师
负责清结算服务，使用 Java、Spring Boot、MySQL、Redis。
项目经历：
1. 清结算平台重构：拆分 5 个微服务，日处理 300 万笔。
2. 引入 Redis 缓存：接口 P95 从 600ms 降到 120ms。
期望薪资：35-45K
`;

const RESUME_C = `姓名：王强
手机：13800000003
邮箱：wangqiang@example.com
求职意向：Java 后端工程师
教育背景：2014-2018 南京大学 计算机科学与技术 本科
工作年限：8 年
技能标签：Java、Spring Boot、MySQL、Kafka、Kubernetes
工作经历：
2018.07-2024.06 某某互联网公司 高级后端工程师
负责交易链路与稳定性建设。
项目经历：
1. 交易链路治理：将核心接口可用性从 99.9% 提升到 99.99%。
2. 消息队列治理：Kafka 堆积从小时级降到分钟级。
期望薪资：45-55K
`;

async function makeUpload(dir: string, name: string, content: string, contentType = 'text/plain; charset=utf-8'): Promise<UploadedFile> {
  const filePath = path.join(dir, name);
  await writeFile(filePath, content, 'utf8');
  return {
    uploadId: `up_test_${name.replace(/\W/g, '')}`,
    filename: name,
    path: filePath,
    size: Buffer.byteLength(content),
    contentType,
  };
}

test('真实上传 → 并发流水线 → 证据报告（Markdown+JSON，无 HTML）', async () => {
  const env = await setupTempEnv();
  const uploadDir = path.join(env.dir, 'uploads');
  await mkdir(uploadDir, { recursive: true });
  const files = [
    await makeUpload(uploadDir, '张伟.txt', RESUME_A),
    await makeUpload(uploadDir, '李娜.txt', RESUME_B),
    await makeUpload(uploadDir, '张伟-重复.txt', RESUME_A),
    await makeUpload(uploadDir, '王强.txt', RESUME_C),
  ];
  const tokens: string[] = [];
  const boot = await bootstrap({
    requirements: '急招 Java 后端工程师，3-5 年经验，熟悉 Spring Boot、MySQL、Redis，有微服务与高并发经验，base 上海。',
    provider: new FakeProvider({ faults: { fabricate: ['R01'] } }),
    stream: (chunk) => tokens.push(chunk.delta),
  });
  try {
    const summary = await runPipeline(boot.deps, {
      requirements: boot.job.requirements,
      hitl: new AutoHitlResponder(),
      uploadFiles: files,
    });
    assert.equal(summary.status, 'final');
    assert.ok(summary.top.length >= 1, '至少一位候选人应通过证据核查');
    assert.ok(summary.counts.reported >= 1);
    assert.ok(tokens.length > 0, '应产生 token 级流式输出');
    assert.ok(tokens.join('').length > 20);

    const reports = summary.reports as unknown as Record<string, string>;
    for (const key of ['markdown', 'json', 'cost', 'convergence']) {
      assert.ok(reports[key], `应生成 ${key} 报告`);
      assert.ok(existsSync(reports[key]), `报告文件存在：${key}`);
    }
    assert.equal(Object.prototype.hasOwnProperty.call(summary.reports, 'html'), false);
    assert.equal(existsSync(path.join(summary.runDir, 'report.html')), false);

    const resumes = boot.deps.ledger.listResumes(boot.job.id);
    assert.equal(resumes.length, 4);
    assert.equal(resumes.filter((resume) => resume.status === 'duplicate').length, 1);
    assert.equal(resumes.filter((resume) => resume.status === 'failed').length, 0);
    assert.ok(resumes.filter((resume) => resume.status === 'reported').length >= 1);

    const events = boot.deps.ledger.listEvents({ jobId: boot.job.id, limit: 2000 });
    assert.ok(events.some((event) => event.type === 'fetch.completed'));
    assert.ok(events.some((event) => event.type === 'deep_eval.shortlist'));
    assert.ok(events.some((event) => event.type === 'selfloop.revise'), '伪造结论应被验真环打回');
    assert.ok(events.some((event) => event.type === 'report.generated'));

    const parseTasks = boot.deps.ledger.listTasks('parse', { jobId: boot.job.id });
    assert.ok(parseTasks.filter((task) => task.status === 'committed').length >= 3);
  } finally {
    boot.close();
    await env.restore();
  }
});

test('图片简历默认走 DeepSeek Vision OCR（测试替身），成本记入 fetcher', async () => {
  const env = await setupTempEnv();
  const uploadDir = path.join(env.dir, 'uploads');
  await mkdir(uploadDir, { recursive: true });
  const image = await makeUpload(uploadDir, '李娜.png', 'fake-png-bytes', 'image/png');
  const boot = await bootstrap({
    requirements: '招 Java 后端，3 年以上经验。',
    provider: new FakeProvider(),
  });
  try {
    const summary = await runPipeline(boot.deps, {
      requirements: boot.job.requirements,
      hitl: new AutoHitlResponder(),
      uploadFiles: [image],
    });
    assert.equal(summary.status, 'final');
    const resumes = boot.deps.ledger.listResumes(boot.job.id);
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0].format, 'image');
    assert.notEqual(resumes[0].status, 'failed');
    const events = boot.deps.ledger.listEvents({ jobId: boot.job.id, limit: 500 });
    assert.ok(events.some((event) => event.type === 'resume.ocr' && event.payload_json.includes('deepseek-vision')));
    const calls = boot.deps.ledger.usageSummary(boot.job.id);
    assert.ok(calls.some((call) => call.agent === 'fetcher' && call.calls >= 1));
  } finally {
    boot.close();
    await env.restore();
  }
});

test('接入失败不阻塞批次：.doc 旧格式进入 failed 明细', async () => {  const env = await setupTempEnv();
  const uploadDir = path.join(env.dir, 'uploads');
  await mkdir(uploadDir, { recursive: true });
  const files = [
    await makeUpload(uploadDir, '张伟.txt', RESUME_A),
    await makeUpload(uploadDir, '旧版简历.doc', 'not a real doc'),
    await makeUpload(uploadDir, '李娜.txt', RESUME_B),
  ];
  const boot = await bootstrap({
    requirements: '招 Java 后端，3 年以上经验。',
    provider: new FakeProvider(),
  });
  try {
    const summary = await runPipeline(boot.deps, {
      requirements: boot.job.requirements,
      hitl: new AutoHitlResponder(),
      uploadFiles: files,
    });
    assert.equal(summary.status, 'final');
    const failed = boot.deps.ledger.listResumes(boot.job.id).filter((resume) => resume.status === 'failed');
    assert.equal(failed.length, 1);
    assert.match(failed[0].reasons_json, /doc/);
    assert.ok(summary.counts.reported >= 1);
  } finally {
    boot.close();
    await env.restore();
  }
});

test('从检查点续跑：不重新上传，复用已评估结果', async () => {
  const env = await setupTempEnv();
  const uploadDir = path.join(env.dir, 'uploads');
  await mkdir(uploadDir, { recursive: true });
  const files = [await makeUpload(uploadDir, '张伟.txt', RESUME_A), await makeUpload(uploadDir, '李娜.txt', RESUME_B)];
  const boot = await bootstrap({ requirements: '招 Java 后端，3 年以上经验。', provider: new FakeProvider() });
  let jobId = '';
  try {
    const first = await runPipeline(boot.deps, {
      requirements: boot.job.requirements,
      hitl: new AutoHitlResponder(),
      uploadFiles: files,
    });
    jobId = boot.job.id;
    assert.equal(first.status, 'final');
  } finally {
    boot.close();
  }
  try {
    const resumed = await bootstrap({ requirements: '招 Java 后端，3 年以上经验。', jobId, provider: new FakeProvider() });
    try {
      const summary = await runPipeline(resumed.deps, {
        requirements: resumed.job.requirements,
        hitl: new AutoHitlResponder(),
        resumeOnly: true,
      });
      assert.equal(summary.status, 'final');
      assert.ok(existsSync(summary.reports.markdown));
    } finally {
      resumed.close();
    }
  } finally {
    await env.restore();
  }
});
