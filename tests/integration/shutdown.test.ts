import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Server } from 'node:http';
import { setupTempEnv } from '../helpers/env.ts';
import { startWebServer } from '../../src/web/server.ts';

const originalToken = process.env.BOLE_SHUTDOWN_TOKEN;

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待超时');
}

function addressOf(server: Server): { port: number } {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { port: address.port };
}

test('未设置 token 时 /api/shutdown 不存在', async () => {
  const env = await setupTempEnv();
  delete process.env.BOLE_SHUTDOWN_TOKEN;
  let server: Server | null = null;
  try {
    server = await startWebServer({ port: 0 });
    const { port } = addressOf(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST' });
    assert.equal(response.status, 404);
  } finally {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    process.env.BOLE_SHUTDOWN_TOKEN = originalToken;
    await env.restore();
  }
});

test('token 不匹配时拒绝', async () => {
  const env = await setupTempEnv();
  process.env.BOLE_SHUTDOWN_TOKEN = 't1';
  let server: Server | null = null;
  try {
    server = await startWebServer({ port: 0 });
    const { port } = addressOf(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: 'POST',
      headers: { 'x-bole-token': 'wrong' },
    });
    assert.equal(response.status, 403);
  } finally {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    process.env.BOLE_SHUTDOWN_TOKEN = originalToken;
    await env.restore();
  }
});

test('token 匹配时先回应再排空并回调', async () => {
  const env = await setupTempEnv();
  process.env.BOLE_SHUTDOWN_TOKEN = 't1';
  let called = false;
  let listeningAtHook: boolean | null = null;
  let server: Server | null = null;
  try {
    server = await startWebServer({
      port: 0,
      onShutdown: () => {
        listeningAtHook = server!.listening;
        called = true;
      },
    });
    const { port } = addressOf(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: 'POST',
      headers: { 'x-bole-token': 't1' },
    });
    assert.equal(response.status, 202);
    await waitFor(() => called);
    assert.equal(listeningAtHook, false, '退出钩子必须在 drain 完成之后才被调用');
    assert.equal(server.listening, false);
  } finally {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    process.env.BOLE_SHUTDOWN_TOKEN = originalToken;
    await env.restore();
  }
});
