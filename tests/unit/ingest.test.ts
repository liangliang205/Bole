import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../../src/util/fsx.ts';
import { parseEml } from '../../src/ingest/eml.ts';
import { normalizeDocument, UnsupportedFormatError } from '../../src/ingest/normalize.ts';
import { generateGoldenSet } from '../../scripts/generate-golden.ts';

const inboxDir = path.join(projectRoot(), 'data', 'inbox');

before(async () => {
  if (!existsSync(path.join(inboxDir, 'R01.eml'))) await generateGoldenSet();
});

function load(label: string) {
  const message = parseEml(readFileSync(path.join(inboxDir, `${label}.eml`), 'latin1'));
  const attachment = message.attachments[0];
  assert.ok(attachment);
  return { message, attachment };
}

test('MIME 解析：头部编码、附件与正文', () => {
  const { message, attachment } = load('R01');
  assert.equal(message.messageId, 'R01@bole.mock');
  assert.match(message.subject, /R01/);
  assert.equal(attachment.filename, 'resume-R01.docx');
  assert.ok(attachment.content.length > 500);
});

test('docx 归一化：解压 XML 并保留分段', () => {
  const { attachment } = load('R01');
  const normalized = normalizeDocument(attachment.content, attachment.filename, attachment.contentType);
  assert.equal(normalized.format, 'docx');
  assert.match(normalized.text, /姓名：张伟/);
  assert.match(normalized.text, /工作年限：7 年/);
  assert.match(normalized.text, /工作经历：/);
});

test('html 归一化：去标签与实体', () => {
  const { attachment } = load('R04');
  const normalized = normalizeDocument(attachment.content, attachment.filename, attachment.contentType);
  assert.equal(normalized.format, 'html');
  assert.match(normalized.text, /姓名：刘洋/);
  assert.doesNotMatch(normalized.text, /<p>/);
});

test('txt 归一化保持原文', () => {
  const { attachment } = load('R02');
  const normalized = normalizeDocument(attachment.content, attachment.filename, attachment.contentType);
  assert.equal(normalized.format, 'txt');
  assert.match(normalized.text, /姓名：李娜/);
});

test('旧版 doc 明确报不支持，错误可如实进入失败明细', () => {
  const { attachment } = load('R19');
  assert.throws(
    () => normalizeDocument(attachment.content, attachment.filename, attachment.contentType),
    UnsupportedFormatError,
  );
});

test('重复投递的附件字节与 R05 完全一致', () => {
  const r05 = load('R05').attachment;
  const r18 = load('R18').attachment;
  assert.equal(r05.content.length, r18.content.length);
  assert.deepEqual(r05.content, r18.content);
});
