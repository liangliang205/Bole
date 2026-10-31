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
