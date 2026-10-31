import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AlreadyCommittedError,
  IllegalTransitionError,
  assertTransition,
  combineStopReasons,
  errorToStopReason,
} from '../../src/core/state.ts';

test('任务状态机允许正常提交路径', () => {
  assertTransition('task', 'pending', 'running');
  assertTransition('task', 'running', 'staged');
  assertTransition('task', 'staged', 'committed');
});

test('任务状态机拒绝跳过 staged 直接提交', () => {
  assert.throws(() => assertTransition('task', 'running', 'committed'), IllegalTransitionError);
});

test('committed 是终态', () => {
  assert.throws(() => assertTransition('task', 'committed', 'running'), IllegalTransitionError);
});

test('简历生命周期支持验真环回退重评', () => {
  assertTransition('resume', 'evaluated', 'verifying');
  assertTransition('resume', 'verifying', 'evaluated');
  assertTransition('resume', 'evaluated', 'evaluating');
  assertTransition('resume', 'verifying', 'verified');
  assertTransition('resume', 'verifying', 'quarantine');
});

test('失败优先于取消，取消优先于完成', () => {
  assert.equal(combineStopReasons(null, 'completed'), 'completed');
  assert.equal(combineStopReasons('error', 'aborted'), 'error');
  assert.equal(combineStopReasons('aborted', 'error'), 'error');
  assert.equal(combineStopReasons('completed', 'aborted'), 'aborted');
  assert.equal(combineStopReasons('aborted', 'completed'), 'aborted');
  assert.equal(combineStopReasons('max-tokens', 'aborted'), 'max-tokens');
  assert.equal(combineStopReasons('refusal', 'error'), 'refusal');
});

test('异常映射到结算语义', () => {
  assert.equal(errorToStopReason(new Error('MCP request timeout')), 'aborted');
  assert.equal(errorToStopReason(Object.assign(new Error('x'), { name: 'AbortError' })), 'aborted');
  assert.equal(errorToStopReason(new Error('model refusal')), 'refusal');
  assert.equal(errorToStopReason(new Error('boom')), 'error');
});

test('已提交任务禁止再写入（单调守卫）', () => {
  const error = new AlreadyCommittedError('parse_1');
  assert.match(error.message, /committed/);
});
