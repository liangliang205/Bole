import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens,
  locateQuote,
  maskPII,
  resolveRawSpans,
  tokenOverlap,
  verifySpan,
} from '../../src/util/text.ts';

const TEXT = '姓名：张伟\n手机：13800000001\n邮箱：zhangwei@example.com\n技能标签：Java、Spring Boot、MySQL\n工作年限：7 年\n项目：主导支付网关重构，P99 从 800ms 降到 180ms。';

test('精确引用可定位字符区间', () => {
  const located = locateQuote(TEXT, '工作年限：7 年');
  assert.ok(located);
  assert.equal(TEXT.slice(located.start, located.end), '工作年限：7 年');
});

test('空白差异可宽松定位', () => {
  const located = locateQuote(TEXT, '技能标签: Java、Spring Boot、MySQL');
  assert.ok(located);
  assert.match(TEXT.slice(located.start, located.end), /技能标签/);
});

test('LLM 用省略号拼接片段时取可定位片段', () => {
  const located = locateQuote(TEXT, '姓名：张伟…工作年限：7 年');
  assert.ok(located);
  assert.equal(TEXT.slice(located.start, located.end), '姓名：张伟');
});

test('不存在的引用无法定位', () => {
  assert.equal(locateQuote(TEXT, '主导过千万级日活系统架构设计'), null);
});

test('resolveRawSpans 对无法定位的引用报错', () => {
  const resolved = resolveRawSpans(
    TEXT,
    [
      { field: 'skills', quote: '技能标签：Java、Spring Boot、MySQL' },
      { field: 'projects', quote: '主导千万级日活系统' },
    ],
    'unknown',
  );
  assert.equal(resolved.spans.length, 1);
  assert.equal(resolved.errors.length, 1);
  assert.match(resolved.errors[0], /无法在原文定位/);
});

test('verifySpan 能识别偏移错误并给出修正', () => {
  const span = { field: 'years', quote: '工作年限：7 年', charStart: 0, charEnd: 2 };
  const result = verifySpan(TEXT, span);
  assert.equal(result.ok, true);
  assert.match(result.reason, /偏移可修正/);
});

test('verifySpan 对不存在的原文判失败', () => {
  const result = verifySpan(TEXT, { field: 'x', quote: '不存在的句子', charStart: 1, charEnd: 5 });
  assert.equal(result.ok, false);
});

test('PII 脱敏覆盖手机号/邮箱/姓名', () => {
  const masked = maskPII(TEXT);
  assert.doesNotMatch(masked, /13800000001/);
  assert.doesNotMatch(masked, /zhangwei@example\.com/);
  assert.match(masked, /张\*\*/);
});

test('token 估算与关键词重合度可用', () => {
  assert.ok(estimateTokens(TEXT) > 20);
  assert.ok(tokenOverlap('Java、Spring Boot、MySQL', '技能标签：Java、Spring Boot、MySQL') > 0.5);
  assert.equal(tokenOverlap('完全无关', 'Java'), 0);
});
