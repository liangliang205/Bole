import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeService, chunkKnowledgeText, formatKnowledgeReferences } from '../../src/knowledge/service.ts';

test('知识库默认空、禁用时不召回，启用后按关键词检索', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-kb-'));
  const service = new KnowledgeService(path.join(dir, 'knowledge.db'));
  try {
    assert.equal(service.listBases().length, 0);
    assert.deepEqual(await service.recall('Java 后端'), []);
    const base = service.createBase({ name: '招聘知识', description: '岗位与面试资料' });
    assert.equal(base.enabled, false);
    const document = await service.addDocument(base.id, {
      filename: 'java.md',
      buffer: Buffer.from('# Java 后端\n\n## 技术栈\n\nSpring Boot、MySQL、Redis、Kafka。\n\n## 面试\n\n重点验证高并发与微服务经验。'),
      contentType: 'text/markdown',
    });
    assert.equal(document.format, 'md');
    assert.deepEqual(await service.recall('Spring Boot 微服务', 3), []);
    service.updateBase(base.id, { enabled: true });
    const hits = await service.recall('Spring Boot 微服务', 3);
    assert.ok(hits.length > 0);
    assert.ok(hits.some((hit) => /Spring Boot/.test(hit.text)));
    assert.ok(hits.some((hit) => /微服务/.test(hit.text)));
    assert.equal(hits[0].baseName, '招聘知识');
    const references = formatKnowledgeReferences(hits, 2000);
    assert.match(references, /招聘知识/);
    assert.match(references, /Spring Boot/);
    assert.equal(service.stats().enabledBases, 1);
    const baseStats = service.baseStats(base.id);
    assert.equal(baseStats.sources, 1);
    assert.equal(baseStats.parsedDocuments, 1);
    assert.ok(baseStats.chunks > 0);
    assert.ok(baseStats.chars > 0);
    assert.ok(baseStats.tokens >= baseStats.chars / 3);
  } finally {
    service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('知识库分块识别 Markdown 标题并保留重叠', () => {
  const text = '# 标题\n\n## 第一节\n\n' + 'A'.repeat(300) + '\n\n## 第二节\n\n第二段内容';
  const chunks = chunkKnowledgeText(text, { chunkSize: 160, chunkOverlap: 30, smartChunk: true });
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.some((chunk) => chunk.heading === '第一节'));
  assert.ok(chunks.some((chunk) => chunk.heading === '第二节'));
});

test('知识库关闭自动召回后 search 仍可用，recall 返回空', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-kb-'));
  const service = new KnowledgeService(path.join(dir, 'knowledge.db'));
  try {
    const base = service.createBase({ name: '规则库' });
    await service.addDocument(base.id, {
      filename: 'rules.txt',
      buffer: Buffer.from('候选人必须提供真实项目证据，禁止使用受保护属性。'),
      contentType: 'text/plain',
    });
    service.updateBase(base.id, { enabled: true });
    service.updateSettings({ autoRecall: false });
    assert.deepEqual(await service.recall('项目证据'), []);
    const hits = await service.search('项目证据', { topK: 3 });
    assert.ok(hits.length > 0);
  } finally {
    service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
