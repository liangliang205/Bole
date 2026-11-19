import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseServerUrl } from '../src/launch-url.ts';

test('解析启动行里的 URL', () => {
  assert.equal(parseServerUrl('BoLe Web 已启动: http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
});

test('带 ANSI 颜色码也能解析', () => {
  assert.equal(parseServerUrl('\u001b[32mBoLe Web 已启动: http://127.0.0.1:8899\u001b[0m'), 'http://127.0.0.1:8899');
});

test('普通日志行返回 null', () => {
  assert.equal(parseServerUrl('对话式控制台：上传简历 → 开始筛选'), null);
});
