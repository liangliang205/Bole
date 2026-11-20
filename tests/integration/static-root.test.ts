import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startWebServer } from '../../src/web/server.ts';
import { setupTempEnv } from '../helpers/env.ts';

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const env = await setupTempEnv();
  const server = await startWebServer({ port: 0 });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await env.restore();
  }
}

test('BOLE_WEB_DIR 指向的目录负责提供首页', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-web-'));
  await writeFile(path.join(dir, 'index.html'), '<h1>custom-root</h1>', 'utf8');
  const saved = process.env.BOLE_WEB_DIR;
  process.env.BOLE_WEB_DIR = dir;
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /custom-root/);
    });
  } finally {
    if (saved === undefined) delete process.env.BOLE_WEB_DIR; else process.env.BOLE_WEB_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test('打包产物缺失时给出可执行的提示，而不是 404', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-web-empty-'));
  const saved = process.env.BOLE_WEB_DIR;
  process.env.BOLE_WEB_DIR = dir;
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/`);
      assert.equal(response.status, 500);
      assert.match(await response.text(), /web:build/);
    });
  } finally {
    if (saved === undefined) delete process.env.BOLE_WEB_DIR; else process.env.BOLE_WEB_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test('assets 下的静态资源按扩展名给 Content-Type', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-web-assets-'));
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'index.html'), '<div id="root"></div>', 'utf8');
  await writeFile(path.join(dir, 'assets', 'app.js'), 'console.log(1)', 'utf8');
  await writeFile(path.join(dir, 'assets', 'app.css'), 'body{}', 'utf8');
  const saved = process.env.BOLE_WEB_DIR;
  process.env.BOLE_WEB_DIR = dir;
  try {
    await withServer(async (base) => {
      const js = await fetch(`${base}/assets/app.js`);
      assert.equal(js.status, 200);
      assert.match(js.headers.get('content-type') ?? '', /javascript/);
      const css = await fetch(`${base}/assets/app.css`);
      assert.equal(css.status, 200);
      assert.match(css.headers.get('content-type') ?? '', /css/);
    });
  } finally {
    if (saved === undefined) delete process.env.BOLE_WEB_DIR; else process.env.BOLE_WEB_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test('assets 目录不允许路径穿越', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-web-escape-'));
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'index.html'), 'ok', 'utf8');
  const saved = process.env.BOLE_WEB_DIR;
  process.env.BOLE_WEB_DIR = dir;
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/assets/..%2F..%2Fpackage.json`);
      assert.ok(response.status === 404 || response.status === 400, `期望拒绝，实际 ${response.status}`);
    });
  } finally {
    if (saved === undefined) delete process.env.BOLE_WEB_DIR; else process.env.BOLE_WEB_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test('brand 目录的 logo 可以按图片类型提供，并同样禁止穿越', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-web-brand-'));
  await mkdir(path.join(dir, 'brand'), { recursive: true });
  await writeFile(path.join(dir, 'index.html'), '<div id="root"></div>', 'utf8');
  await writeFile(path.join(dir, 'brand', 'bole-mark.png'), 'PNGDATA', 'utf8');
  const saved = process.env.BOLE_WEB_DIR;
  process.env.BOLE_WEB_DIR = dir;
  try {
    await withServer(async (base) => {
      const logo = await fetch(`${base}/brand/bole-mark.png`);
      assert.equal(logo.status, 200);
      assert.match(logo.headers.get('content-type') ?? '', /image\/png/);
      const escape = await fetch(`${base}/brand/..%2Fpackage.json`);
      assert.ok(escape.status === 404 || escape.status === 400, `期望拒绝，实际 ${escape.status}`);
    });
  } finally {
    if (saved === undefined) delete process.env.BOLE_WEB_DIR; else process.env.BOLE_WEB_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  }
});
