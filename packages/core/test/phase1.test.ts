import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GOLDEN_PATH, PHASE1_FIXTURES, phase1 } from '../../../scripts/phase1-golden.ts';

// Written from the code as it stood before round F's paid-tool change. Paid
// tools change what a call result says and which starters are offered, never
// what the agent is shown first.
const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Array<ReturnType<typeof phase1>>;

test('phase 1 is unchanged for the six presets and goji', () => {
  assert.deepEqual(golden.map((g) => g.fixture), PHASE1_FIXTURES);
  for (const g of golden) assert.deepEqual(phase1(g.fixture), g, g.fixture);
});

test('the snapshot would notice a changed phase (control)', () => {
  const g = golden.find((x) => x.hasFindTools)!;
  const moved = { ...phase1(g.fixture), tools: [...phase1(g.fixture).tools].reverse() };
  assert.notDeepEqual(moved, g);
});
