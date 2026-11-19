import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choosePort } from '../src/port.ts';

const isFreeOf = (busy: number[]) => async (port: number): Promise<boolean> => !busy.includes(port);

test('首选端口可用时复用', async () => {
  const choice = await choosePort({ preferred: 9001, isFree: isFreeOf([]) });
  assert.deepEqual(choice, { port: 9001, reused: true });
});

test('首选不可用时退回默认端口', async () => {
  const choice = await choosePort({ preferred: 9001, isFree: isFreeOf([9001]) });
  assert.deepEqual(choice, { port: 8787, reused: false });
});

test('默认端口与第一个候选都被占时向后扫描', async () => {
  const choice = await choosePort({ isFree: isFreeOf([8787, 8788]) });
  assert.deepEqual(choice, { port: 8789, reused: false });
});

test('所有候选端口都被占用时抛错', async () => {
  const busy: number[] = [];
  busy.push(9001);
  for (let port = 8787; port <= 8900; port += 1) busy.push(port);
  await assert.rejects(() => choosePort({ preferred: 9001, isFree: isFreeOf(busy) }), /所有候选端口都被占用/);
});
