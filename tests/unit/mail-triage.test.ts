import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAutomatedSender, isLikelySpam } from '../../src/mail/triage.ts';

test('邮箱 triage：自动地址、自发邮件与广告主题被跳过', () => {
  const mailbox = 'hr@example.com';
  assert.equal(isLikelySpam({ from: 'noreply@example.com', subject: '系统通知', mailbox }).spam, true);
  assert.equal(isLikelySpam({ from: 'Mailer-Daemon@example.com', subject: '退信', mailbox }).spam, true);
  assert.equal(isLikelySpam({ from: 'bounces+123@example.com', subject: '', mailbox }).spam, true);
  assert.equal(isLikelySpam({ from: mailbox, subject: '测试简历', mailbox }).spam, true);
  assert.equal(isLikelySpam({ from: 'candidate@example.com', subject: '订阅退订方式', mailbox }).spam, true);
  assert.equal(isLikelySpam({ from: 'candidate@example.com', subject: '应聘 Java 后端工程师', mailbox }).spam, false);
  assert.equal(isLikelySpam({ from: '', subject: '', mailbox }).spam, true);
  assert.equal(isAutomatedSender('do-not-reply+123@example.com'), true);
  assert.equal(isAutomatedSender('candidate@example.com'), false);
});
