import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchModelList } from '../../src/settings/key-store.ts';

test('模型列表：兼容 /v1/models 的 data[]', async () => {
  const server = createServer((req, res) => {
    assert.equal(req.url, '/v1/models');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'acme-flash' }, { id: 'acme-pro' }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const result = await fetchModelList('sk-test', `http://127.0.0.1:${address.port}/v1`, 'openai-chat');
    assert.deepEqual(result.ids, ['acme-flash', 'acme-pro']);
    assert.equal(result.endpoint, `http://127.0.0.1:${address.port}/v1/models`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('模型列表：阿里云 MaaS 走 /api/v1/models 并解析 output.models', async () => {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ output: { models: [{ model: 'qwen3.8-max' }, { model: 'kimi/kimi-k3.1-pro-highspeed' }] } }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const result = await fetchModelList(
      'sk-test',
      `http://127.0.0.1:${address.port}/compatible-mode/v1`,
      'openai-responses',
    );
    assert.deepEqual(result.ids, ['qwen3.8-max', 'kimi/kimi-k3.1-pro-highspeed']);
    assert.match(result.endpoint, /\/api\/v1\/models/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
