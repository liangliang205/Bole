import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DeepSeekProvider } from '../../src/llm/deepseek.ts';

test('DeepSeek streaming 解析 SSE：token 回调、usage、finish_reason', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunks = [
      'data: {"choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"true}"},"finish_reason":"stop"}]}\r\n\r\n',
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"prompt_cache_hit_tokens":4}}\n\n',
      'data: [DONE]\n\n',
    ];
    for (const chunk of chunks) res.write(chunk);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const tokens: string[] = [];
  try {
    const provider = new DeepSeekProvider({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${address.port}`,
      maxRetries: 0,
    });
    const result = await provider.chat({
      agent: 'parser',
      tier: 'flash',
      system: 'sys',
      user: 'user',
      schemaName: 'parse_resume',
      onToken: (delta) => tokens.push(delta),
    });
    assert.equal(result.text, '{"ok":true}');
    assert.deepEqual(tokens, ['{"ok":', 'true}']);
    assert.equal(result.usage.promptTokens, 12);
    assert.equal(result.usage.completionTokens, 3);
    assert.equal(result.usage.cachedPromptTokens, 4);
    assert.equal(result.stopReason, 'completed');
    assert.equal(result.cacheHit, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('DeepSeek 无 Key 时明确报错', async () => {
  const provider = new DeepSeekProvider({ apiKey: '' });
  await assert.rejects(
    () => provider.chat({ agent: 'x', tier: 'flash', system: 's', user: 'u' }),
    /未绑定 DeepSeek API Key/,
  );
});

test('DeepSeek 档位映射：flash→deepseek-flash，pro→deepseek-v4-pro + thinking high', async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const provider = new DeepSeekProvider({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${address.port}`,
      maxRetries: 0,
    });
    await provider.chat({ agent: 'assessor', tier: 'pro', system: 's', user: 'u', schemaName: 'evaluate_resume' });
    await provider.chat({ agent: 'assessor', tier: 'flash', system: 's', user: 'u', schemaName: 'evaluate_resume' });
    assert.equal(bodies[0].model, 'deepseek-v4-pro');
    assert.deepEqual(bodies[0].thinking, { type: 'enabled' });
    assert.equal(bodies[0].reasoning_effort, 'high');
    assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
    assert.equal(bodies[1].model, 'deepseek-flash');
    assert.deepEqual(bodies[1].thinking, { type: 'disabled' });
    assert.equal(bodies[1].reasoning_effort, undefined);
    assert.equal(bodies[1].temperature, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
