import assert from 'node:assert/strict';

/**
 * 断言首页响应是"可用的前端入口"。
 *
 * 前端产物（frontend/dist）是构建生成的，不进 git；因此集成测试既可能在有产物的环境跑，
 * 也可能在干净检出里跑。两种情况都合法：有产物时应返回 SPA 挂载点，没有时应返回
 * 明确的可执行提示（而不是 404 或空页面）。产物是否真的构建成功由 CI 的构建步骤与
 * docker 作业负责，本断言只守住"服务端对首页的响应是有意义的"。
 */
export function assertFrontendEntry(html: string): void {
  const hasShell = html.includes('id="root"');
  const hasBuildHint = html.includes('缺少前端产物') && html.includes('web:build');
  assert.ok(
    hasShell || hasBuildHint,
    `首页既不是 SPA 入口也没有构建提示，实际内容：${html.slice(0, 120)}`,
  );
}
