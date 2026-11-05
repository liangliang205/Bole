import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Server } from 'node:http';
import { startWebServer } from '../../src/web/server.ts';
import { setupTempEnv } from '../helpers/env.ts';
import type { JobFamily, PolicyProposal, PolicyVersion } from '../../src/memory/types.ts';

test('隔离 HTTP 服务：提案先隔离、人工发布、重复批准幂等、退役和前端入口可访问', async () => {
  const env = await setupTempEnv();
  const oldMcp = process.env.BOLE_MCP_CONFIG;
  process.env.BOLE_MCP_CONFIG = path.join(env.dir, 'no-mcp.json');
  let server: Server | undefined;
  try {
    server = await startWebServer({ port: 0 });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const api = async (url: string, body?: unknown) => {
      const response = await fetch(base + url, body === undefined ? {} : { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json() as { family: JobFamily; proposal: PolicyProposal; version: PolicyVersion; versions: PolicyVersion[] };
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    const family = (await api('/api/memory/families', { name: 'HTTP 验证岗位' })).family;
    const proposal = (await api('/api/memory/proposals', {
      familyId: family.id, rule: '按项目证据评分', why: '业务确认', howToApply: '新任务',
      profile: { jd: { title: 'Java', hardRequirements: ['Java'] }, scorecard: { dimensions: [
        { key: 'tech', name: '技术', weight: 40 }, { key: 'project', name: '项目', weight: 40 }, { key: 'communication', name: '沟通', weight: 20 },
      ] } },
    })).proposal;
    assert.equal((await api('/api/memory')).versions.length, 0);
    const body = { decision: 'approve', contentHash: proposal.content_hash };
    const published = await api(`/api/memory/proposals/${proposal.id}/decision`, body);
    const repeated = await api(`/api/memory/proposals/${proposal.id}/decision`, body);
    assert.equal(published.version.id, repeated.version.id);
    await api(`/api/memory/versions/${published.version.id}/retire`, {});
    assert.equal((await api('/api/memory')).versions[0].status, 'retired');
    const page = await fetch(base + '/');
    assert.match(await page.text(), /data-settings-tab="memory"/);
    const script = await fetch(base + '/memory-ui.js');
    assert.equal(script.status, 200);
    assert.match(await script.text(), /memory-proposals/);
  } finally {
    if (server) await new Promise<void>((resolve, reject) => { server!.close((error) => error ? reject(error) : resolve()); server!.closeAllConnections(); });
    if (oldMcp === undefined) delete process.env.BOLE_MCP_CONFIG; else process.env.BOLE_MCP_CONFIG = oldMcp;
    await env.restore();
  }
});
