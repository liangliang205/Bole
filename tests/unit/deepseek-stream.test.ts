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
    /未绑定模型提供商 API Key/,
  );
});

test('DeepSeek Vision：图片以 user content image_url 发送，detail=high', async () => {
  let captured: Record<string, unknown> = {};
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    captured = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: '姓名：李娜' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1200, completion_tokens: 5 },
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
    const result = await provider.chat({
      agent: 'fetcher',
      tier: 'flash',
      system: 'ocr',
      user: '转写',
      images: [{ mimeType: 'image/png', base64: 'aGVsbG8=', detail: 'high' }],
      maxTokens: 8192,
    });
    assert.equal(result.text, '姓名：李娜');
    assert.equal(captured.model, 'deepseek-flash');
    const messages = captured.messages as { role: string; content: unknown }[];
    assert.equal(messages[1].role, 'user');
    const content = messages[1].content as { type: string; image_url?: { url: string; detail: string } }[];
    assert.equal(content[0].type, 'text');
    assert.equal(content[1].type, 'image_url');
    assert.match(content[1].image_url?.url ?? '', /^data:image\/png;base64,aGVsbG8=/);
    assert.equal(content[1].image_url?.detail, 'high');
    assert.equal(captured.response_format, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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

test('OpenAI Responses：请求 /responses，解析 output_text 与 input_tokens_details', async () => {
  let capturedUrl = '';
  let captured: Record<string, unknown> = {};
  const server = createServer(async (req, res) => {
    capturedUrl = req.url ?? '';
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    captured = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      output_text: '{"ok":true}',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
      usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } },
      status: 'completed',
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const provider = new DeepSeekProvider({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      protocol: 'openai-responses',
      deepseekStyle: false,
      maxRetries: 0,
    });
    const result = await provider.chat({ agent: 'parser', tier: 'flash', system: 'sys', user: 'user', schemaName: 'parse_resume' });
    assert.equal(capturedUrl, '/v1/responses');
    assert.equal(captured.model, 'deepseek-flash');
    assert.equal(captured.instructions, 'sys');
    assert.deepEqual(captured.text, { format: { type: 'json_object' } });
    assert.equal(result.text, '{"ok":true}');
    assert.equal(result.usage.promptTokens, 12);
    assert.equal(result.usage.completionTokens, 3);
    assert.equal(result.usage.cachedPromptTokens, 4);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Anthropic Messages：请求 /v1/messages，x-api-key 与 content 解析', async () => {
  let capturedUrl = '';
  let capturedHeaders: Record<string, string | string[] | undefined> = {};
  let captured: Record<string, unknown> = {};
  const server = createServer(async (req, res) => {
    capturedUrl = req.url ?? '';
    capturedHeaders = req.headers;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    captured = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      content: [{ type: 'text', text: '{"ok":true}' }],
      usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 3 },
      stop_reason: 'end_turn',
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const provider = new DeepSeekProvider({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${address.port}`,
      protocol: 'anthropic-messages',
      deepseekStyle: false,
      maxRetries: 0,
    });
    const result = await provider.chat({ agent: 'parser', tier: 'flash', system: 'sys', user: 'user', schemaName: 'parse_resume' });
    assert.equal(capturedUrl, '/v1/messages');
    assert.equal(capturedHeaders['x-api-key'], 'test-key');
    assert.equal(captured.system, 'sys');
    assert.equal(captured.max_tokens, 4096);
    assert.equal(result.text, '{"ok":true}');
    assert.equal(result.usage.promptTokens, 12);
    assert.equal(result.usage.completionTokens, 3);
    assert.equal(result.usage.cachedPromptTokens, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
