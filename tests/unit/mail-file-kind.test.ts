import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFileKind, detectImageMime, kindMatchesExtension } from '../../src/mail/file-kind.ts';
import { makeDocx, makePdf } from '../fixtures/documents.ts';

test('邮件附件文件头：识别 PDF/DOCX/DOC/图片/文本并校验扩展名同族', () => {
  assert.equal(detectFileKind(makePdf('hello'), 'resume.pdf'), 'pdf');
  assert.equal(detectFileKind(makeDocx('hello'), 'resume.docx'), 'docx');
  assert.equal(detectFileKind(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]), 'resume.doc'), 'doc');

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
  assert.equal(detectFileKind(png, '个人简历.png'), 'image');
  assert.equal(detectFileKind(jpeg, 'photo.jpg'), 'image');
  assert.equal(detectImageMime(png), 'image/png');
  assert.equal(detectImageMime(jpeg), 'image/jpeg');

  assert.equal(detectFileKind(Buffer.from('姓名：张伟\n工作年限：5年\n技能：Java、MySQL'), 'resume.txt'), 'text');
  assert.equal(detectFileKind(Buffer.from('姓名：张伟\n工作年限：5年\n技能：Java、MySQL'), 'resume.md'), 'text');
  assert.equal(detectFileKind(Buffer.from('<html><body>姓名：张伟 工作年限：5年 技能：Java</body></html>'), 'resume.html'), 'text');
  assert.equal(detectFileKind(Buffer.from('short'), 'resume.txt'), null);
  assert.equal(detectFileKind(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13]), 'resume.txt'), null);
  assert.equal(detectFileKind(Buffer.from('PK\x03\x04 not really docx'), 'resume.docx'), null);

  assert.equal(kindMatchesExtension('pdf', 'resume.pdf'), true);
  assert.equal(kindMatchesExtension('pdf', 'resume.docx'), false);
  assert.equal(kindMatchesExtension('image', 'photo.JPEG'), true);
  assert.equal(kindMatchesExtension('image', 'resume.pdf'), false);
  assert.equal(kindMatchesExtension('text', 'resume.htm'), true);
  assert.equal(kindMatchesExtension('doc', 'resume.DOC'), true);
});
