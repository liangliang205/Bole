import test from 'node:test';
import assert from 'node:assert/strict';
import { startWebServer, drainWebServer } from '../../src/web/server.ts';
import { setupTempEnv } from '../helpers/env.ts';

test('容器健康检查不依赖模型密钥，排空后关闭监听', async () => {
  const env = await setupTempEnv();
  const server = await startWebServer({ port: 0 });
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    for (const endpoint of ['/healthz', '/readyz']) assert.equal((await fetch(base + endpoint)).status, 200);
    await drainWebServer(server, 100);
    assert.equal(server.listening, false);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await env.restore();
  }
});
