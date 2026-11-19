import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { formatLogName, pickLogPath } from '../src/log-file.ts';

const day = new Date(2026, 10, 19);

test('日志文件按本地日期命名', () => {
  assert.equal(formatLogName(day), 'server-20261119.log');
});

test('小于 5MB 用当日文件', () => {
  assert.equal(pickLogPath('C:\\logs', 1024, day), path.join('C:\\logs', 'server-20261119.log'));
});

test('超过 5MB 换到 -2 分片', () => {
  assert.equal(pickLogPath('C:\\logs', 5 * 1024 * 1024, day), path.join('C:\\logs', 'server-20261119-2.log'));
});
