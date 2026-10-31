import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupKeyFromText, extractIdentity } from '../../src/ingest/dedup.ts';
import { RagIndex } from '../../src/tools/rag.ts';
import { scanProtected } from '../../src/tools/fairness.ts';

test('去重指纹忽略手机号格式差异', () => {
  const a = '姓名：张伟\n手机：138-0000-0001\n邮箱：zhangwei@example.com';
  const b = '姓名：张伟\n手机：13800000001\n邮箱：ZHANGWEI@example.com';
  assert.equal(dedupKeyFromText(a), dedupKeyFromText(b));
  assert.equal(extractIdentity(a).phone, '13800000001');
});

test('不同候选人生成不同去重指纹', () => {
  const a = '姓名：张伟\n手机：13800000001\n邮箱：zhangwei@example.com';
  const b = '姓名：李娜\n手机：13800000002\n邮箱：lina@example.com';
  assert.notEqual(dedupKeyFromText(a), dedupKeyFromText(b));
});

test('缺少身份信息时退化为正文指纹', () => {
  assert.equal(dedupKeyFromText('只有一段正文'), dedupKeyFromText('只有一段正文'));
  assert.notEqual(dedupKeyFromText('正文 A'), dedupKeyFromText('正文 B'));
});

test('RAG 检索命中相关章节且结果确定', () => {
  const index = new RagIndex([
    {
      id: 'a',
      title: 'scorecard',
      heading: '技术栈匹配',
      text: '技术栈匹配 5 分需要精通 Java 与 Spring Boot，并有架构级实践与量化证据。',
    },
    {
      id: 'b',
      title: 'scorecard',
      heading: '年限经验',
      text: '年限经验以工作经历起止时间为准，目标区间 3-5 年。',
    },
    {
      id: 'c',
      title: 'jd',
      heading: 'Java 后端工程师',
      text: '硬性要求：Java、Spring Boot、MySQL、Redis、微服务与高并发经验。',
    },
  ]);
  const first = index.search('Java Spring Boot 架构实践', 2);
  const second = index.search('Java Spring Boot 架构实践', 2);
  assert.ok(first.length > 0);
  assert.deepEqual(first.map((hit) => hit.id), second.map((hit) => hit.id));
  assert.equal(first[0].id, 'a');
  assert.equal(index.search('完全不相关的查询词', 2).length, 0);
});

test('公平性规则识别受保护属性文本', () => {
  const hits = scanProtected('限男性，30 岁以下，已婚未育');
  const categories = hits.map((hit) => hit.category);
  assert.ok(categories.includes('gender'));
  assert.ok(categories.includes('age'));
  assert.ok(categories.includes('marital'));
  assert.ok(categories.includes('childbearing'));
});
