import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyScorecard, conclusionFor, rankEvaluations } from '../../src/tools/scorecard.ts';

const dims = (scores: [number, number, number]) => [
  { key: 'tech_stack', name: '技术栈匹配', weight: 50, score: scores[0], rationale: '', spans: [] },
  { key: 'years_experience', name: '年限经验', weight: 30, score: scores[1], rationale: '', spans: [] },
  { key: 'project_complexity', name: '项目复杂度', weight: 20, score: scores[2], rationale: '', spans: [] },
];

test('总分按权重确定性重算，不使用模型自报总分', () => {
  const result = applyScorecard(dims([5, 3, 1]));
  assert.equal(result.totalScore, 72);
  assert.equal(result.conclusion, 'yes');
  assert.equal(result.weightsNormalized, false);
});

test('权重不足 100 时自动归一化', () => {
  const result = applyScorecard([
    { key: 'a', name: 'A', weight: 60, score: 5, rationale: '', spans: [] },
    { key: 'b', name: 'B', weight: 20, score: 1, rationale: '', spans: [] },
  ]);
  assert.equal(result.weightsNormalized, true);
  assert.ok(result.totalScore > 50 && result.totalScore < 100);
});

test('结论阈值映射', () => {
  assert.equal(conclusionFor(90), 'strong_yes');
  assert.equal(conclusionFor(75), 'yes');
  assert.equal(conclusionFor(65), 'maybe');
  assert.equal(conclusionFor(50), 'no');
  assert.equal(conclusionFor(20), 'strong_no');
});

test('排序平分时按技术栈、年限、项目复杂度依次比较', () => {
  const ranked = rankEvaluations([
    { resumeId: 'a', totalScore: 80, dimensions: [{ key: 'tech_stack', score: 4 }, { key: 'years_experience', score: 5 }] },
    { resumeId: 'b', totalScore: 80, dimensions: [{ key: 'tech_stack', score: 5 }, { key: 'years_experience', score: 3 }] },
    { resumeId: 'c', totalScore: 90, dimensions: [{ key: 'tech_stack', score: 3 }, { key: 'years_experience', score: 3 }] },
  ]);
  assert.deepEqual(ranked.map((item) => item.resumeId), ['c', 'b', 'a']);
});
