import test from 'node:test';
import assert from 'node:assert/strict';
import { rubricIssues, optionalMissingAnomaly, deploymentEvidenceIssues, auditCoverageIssues, experienceOptional } from '../../src/agents/evidence-policy.ts';
import { pdfPageText } from '../../src/ingest/pdf-layout.ts';
import { systemPrompt } from '../../src/agents/prompts.ts';
import { AgentRegistry } from '../../src/core/registry.ts';
import { resolvePaths } from '../../src/config.ts';
import type { AgentDeps } from '../../src/agents/deps.ts';

const requirements = '全栈工程师，应届生也可以，工作经验不限，需要有实际云服务部署经验，技术栈：前端react，后端不做要求';
const dim = (key: string, name: string, anchors: Record<string, string> = {}) => ({ key, name, weight: 100, anchors });

test('不限经验不将缺少工作经历、年限、薪资标为异常；原文缺陷及有年限门槛仍保留', () => {
  assert.equal(optionalMissingAnomaly('缺少工作经历（work_history）字段内容', requirements), true);
  assert.equal(optionalMissingAnomaly('缺少工作年限（years_experience）字段内容', requirements), true);
  assert.equal(optionalMissingAnomaly('缺少期望薪资（expected_salary）字段内容', requirements), true);
  assert.equal(optionalMissingAnomaly('时间线冲突，工作经历起止日期相互矛盾', requirements), false);
  assert.equal(optionalMissingAnomaly('缺少工作年限', '需要三年以上工作经验'), false);
  assert.equal(optionalMissingAnomaly('缺少期望薪资', '期望薪资必须填写'), false);
  assert.equal(experienceOptional('不接受应届生，需要三年工作经验'), false);
});
test('生成评分卡不得添加已明确不限的后端或年限维度', () => {
  assert.equal(rubricIssues(requirements, { version: '1', dimensions: [dim('years_experience', '工作年限'), dim('backend_basics', '后端基础')] }).length, 2);
  assert.deepEqual(rubricIssues('后端工程师，需要五年经验', { version: '1', dimensions: [dim('backend', '后端能力')] }), []);
});
test('应届岗位锚点不引入未要求的高阶职责，用户明确要求时允许', () => {
  const card = { version: '1', dimensions: [dim('cloud', '部署', { '5': 'Kubernetes 多云部署，推动团队技术演进' })] };
  assert.equal(rubricIssues(requirements, card).length, 3);
  assert.deepEqual(rubricIssues('应届生可，需要 Kubernetes、多云能力并推动团队技术演进', card), []);
});
test('明确云项目环境不能被概括为仅了解；不过度证明个人独立负责', () => {
  const text = '项目环境：Ubuntu 阿里云服务器｜容器化部署\n项目成果：目前该项目已投入生产使用';
  assert.equal(deploymentEvidenceIssues(text, ['云服务部署经验仅停留在了解层面']).length, 1);
  assert.deepEqual(deploymentEvidenceIssues(text, ['有云平台项目及部署证据，个人独立负责范围需进一步确认']), []);
  assert.deepEqual(deploymentEvidenceIssues('了解云服务器网站部署', ['云部署仅了解']), []);
});
test('核查必须覆盖全部维度，不能一个整体通过替代逐维度核查', () => {
  const dims = [{ key: 'react', name: 'React 前端开发', rationale: '项目使用 React' }, { key: 'cloud', name: '云部署', rationale: '项目使用阿里云部署' }];
  assert.equal(auditCoverageIssues(dims, [{ claim: 'React 前端开发' }]).length, 1);
  assert.equal(auditCoverageIssues(dims, [{ claim: '整体通过' }]).length, 2);
  assert.deepEqual(auditCoverageIssues(dims, [{ claim: dims[0].rationale }, { claim: 'cloud：云部署证据存在' }]), []);
});
test('PDF 文本按坐标恢复标题行序，相邻英文碎片不强插空格', () => {
  const item = (str: string, x: number, y: number, width: number) => ({ str, transform: [10, 0, 0, 10, x, y], height: 10, width });
  const text = pdfPageText([item('flow', 24, 50, 18), item('项目内容', 0, 30, 40), item('项目经历', 0, 70, 40), item('Work', 0, 50, 24)]);
  assert.equal(text, '项目经历\nWorkflow\n项目内容');
  assert.equal(pdfPageText([item('Ubuntu', 0, 30, 30), item('云服务器', 40, 30, 40)]), 'Ubuntu 云服务器');
});
test('没有坐标及旋转文本保持可靠的内容顺序回退', () => {
  assert.equal(pdfPageText([{ str: 'line', hasEOL: true }, { str: 'next' }]), 'line\nnext ');
  assert.equal(pdfPageText([{ str: 'rotated', transform: [0, 10, -10, 0, 0, 0] }]), 'rotated ');
});
test('平台 skill 实际接入画像、解析、评估、核查，旧 Agent 模板也生效', () => {
  const deps = { registry: AgentRegistry.load(), paths: resolvePaths() } as AgentDeps;
  for (const role of ['profiler', 'parser', 'assessor', 'auditor']) assert.match(systemPrompt(deps, role), /平台技能 evidence-calibration@1.0.0/);
});
