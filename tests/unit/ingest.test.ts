import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { detectFormat, normalizeDocument, UnsupportedFormatError } from '../../src/ingest/normalize.ts';
import { loadUpload, saveUpload, UploadError } from '../../src/ingest/uploads.ts';
import { makeDocx, makePdf } from '../fixtures/documents.ts';

const RESUME = `姓名：张伟
手机：13800000001
邮箱：zhangwei@example.com
求职意向：Java 后端工程师
教育背景：2015-2019 华东理工大学 计算机科学与技术 本科
工作年限：7 年
技能标签：Java、Spring Boot、MySQL、Redis
工作经历：
2019.07-2024.06 某某科技有限公司 后端工程师
负责支付系统订单模块，使用 Java、Spring Boot、MySQL。
项目经历：
1. 支付网关重构：主导微服务拆分，P99 从 800ms 降到 180ms。
期望薪资：40-50K
`;

test('上传：保存、读取元数据并保留原文件', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-upload-'));
  try {
    const saved = await saveUpload(
      { filename: '王强-简历.txt', contentBase64: Buffer.from(RESUME, 'utf8').toString('base64') },
      dir,
    );
    assert.equal(saved.filename, '王强-简历.txt');
    assert.equal(saved.contentType, 'text/plain; charset=utf-8');
    const loaded = await loadUpload(saved.uploadId, dir);
    assert.ok(loaded);
    assert.equal(await readFile(loaded!.path, 'utf8'), RESUME);
    assert.equal(await loadUpload('../../etc/passwd', dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('上传：拒绝不支持的扩展名', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-upload-'));
  try {
    await assert.rejects(
      () => saveUpload({ filename: 'malware.exe', contentBase64: Buffer.from('x').toString('base64') }, dir),
      UploadError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('归一化：txt 保持原文与字段', async () => {
  const normalized = await normalizeDocument(Buffer.from(RESUME, 'utf8'), 'r.txt', 'text/plain');
  assert.equal(normalized.format, 'txt');
  assert.match(normalized.text, /姓名：张伟/);
  assert.match(normalized.text, /工作年限：7 年/);
});

test('归一化：docx 解压正文', async () => {
  const normalized = await normalizeDocument(makeDocx(RESUME), 'r.docx');
  assert.equal(normalized.format, 'docx');
  assert.match(normalized.text, /姓名：张伟/);
  assert.match(normalized.text, /项目经历/);
});

test('归一化：html 去标签', async () => {
  const html = `<html><body>${RESUME.split('\n').map((line) => `<p>${line}</p>`).join('')}</body></html>`;
  const normalized = await normalizeDocument(Buffer.from(html, 'utf8'), 'r.html');
  assert.equal(normalized.format, 'html');
  assert.match(normalized.text, /姓名：张伟/);
  assert.doesNotMatch(normalized.text, /<p>/);
});

test('归一化：PDF 文本层可通过 PDF.js 提取', async () => {
  const normalized = await normalizeDocument(makePdf('Java Spring Boot MySQL'), 'r.pdf');
  assert.equal(normalized.format, 'pdf');
  assert.match(normalized.text, /Java Spring Boot MySQL/);
});

test('归一化：旧版 doc 明确拒绝', async () => {
  await assert.rejects(() => normalizeDocument(Buffer.from('garbage'), 'r.doc'), UnsupportedFormatError);
});

test('格式识别：图片走 image 分支，pdf/docx 正确识别', () => {
  assert.equal(detectFormat('resume.png'), 'image');
  assert.equal(detectFormat('resume.jpg', 'image/jpeg'), 'image');
  assert.equal(detectFormat('resume.pdf', 'application/pdf'), 'pdf');
  assert.equal(detectFormat('resume.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'docx');
});
