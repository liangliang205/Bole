import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { bootstrap } from '../../src/bootstrap.ts';
import { runPipeline } from '../../src/agents/coordinator.ts';
import { AutoHitlResponder } from '../../src/agents/hitl.ts';
import type { UploadedFile } from '../../src/types.ts';
import { FakeProvider } from '../fixtures/fake-provider.ts';
import { setupTempEnv } from '../helpers/env.ts';

const TEXT = `姓名：李娜
手机：13800000002
邮箱：lina@example.com
求职意向：Java 后端
工作年限：6 年
技能标签：Java、Spring Boot、MySQL
工作经历：2020-2024 某公司后端工程师，负责清结算服务。
项目经历：清结算平台重构，日处理 300 万笔。
`;

async function upload(dir: string, name: string, content: string): Promise<UploadedFile> {
  const file = path.join(dir, name);
  await writeFile(file, content, 'utf8');
  return {
    uploadId: `up_err_${name}`,
    filename: name,
    path: file,
    size: Buffer.byteLength(content),
    contentType: 'text/plain; charset=utf-8',
  };
}

test('未配置 DeepSeek Key 时 bootstrap 立即失败（不静默回退 mock）', async () => {
  const env = await setupTempEnv();
  try {
    await assert.rejects(() => bootstrap({ requirements: '招 Java 后端工程师' }), /模型提供商|API Key/);
  } finally {
    await env.restore();
  }
});

test('schema 违规同轮重试：首次坏输出不进入 committed', async () => {
  const env = await setupTempEnv();
  const dir = path.join(env.dir, 'uploads');
  await mkdir(dir, { recursive: true });
  const boot = await bootstrap({
    requirements: '招 Java 后端，3 年以上经验。',
    provider: new FakeProvider({ invalidSchemaOnce: ['*'] }),
  });
  try {
    const summary = await runPipeline(boot.deps, {
      requirements: boot.job.requirements,
      hitl: new AutoHitlResponder(),
      uploadFiles: [await upload(dir, '李娜.txt', TEXT)],
    });
    assert.equal(summary.status, 'final');
    const parseTasks = boot.deps.ledger.listTasks('parse', { jobId: boot.job.id });
    assert.ok(parseTasks.some((task) => task.status === 'committed' && Number(task.attempt) >= 2));
  } finally {
    boot.close();
    await env.restore();
  }
});

test('所有上传都失败时给出可读错误，并保留 failed 明细', async () => {
  const env = await setupTempEnv();
  const dir = path.join(env.dir, 'uploads');
  await mkdir(dir, { recursive: true });
  const boot = await bootstrap({ requirements: '招 Java 后端。', provider: new FakeProvider() });
  try {
    const badFile = await upload(dir, '坏文件.doc', 'garbage');
    await assert.rejects(
      () =>
        runPipeline(boot.deps, {
          requirements: boot.job.requirements,
          hitl: new AutoHitlResponder(),
          uploadFiles: [badFile],
        }),
      /所有简历均未能接入/,
    );
    const failed = boot.deps.ledger.listResumes(boot.job.id).filter((resume) => resume.status === 'failed');
    assert.equal(failed.length, 1);
    assert.match(failed[0].reasons_json, /doc/);
  } finally {
    boot.close();
    await env.restore();
  }
});

test('没有上传文件时拒绝启动，不读取任何本地 mock 邮箱', async () => {
  const env = await setupTempEnv();
  const boot = await bootstrap({ requirements: '招 Java 后端。', provider: new FakeProvider() });
  try {
    await assert.rejects(
      () =>
        runPipeline(boot.deps, {
          requirements: boot.job.requirements,
          hitl: new AutoHitlResponder(),
        }),
      /请至少上传一份简历/,
    );
  } finally {
    boot.close();
    await env.restore();
  }
});
