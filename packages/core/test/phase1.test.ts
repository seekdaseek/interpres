import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GOLDEN_PATH, PHASE1_FIXTURES, phase1 } from '../../../scripts/phase1-golden.ts';
import { loadFixture } from './fixtures.ts';
import { FIND_TOOLS_NAME, TRANSCRIPTION_MODE, convertCatalog, initialPhase, phaseSessionUpdate } from '../src/index.ts';

// Written from the code as it stood before round F's paid-tool change. Paid
// tools change what a call result says and which starters are offered, never
// what the agent is shown first.
const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Array<ReturnType<typeof phase1>>;

test('phase 1 is unchanged for the six presets and goji', () => {
  assert.deepEqual(golden.map((g) => g.fixture), PHASE1_FIXTURES);
  for (const g of golden) assert.deepEqual(phase1(g.fixture), g, g.fixture);
});

test('phase 1 sends the transcription mode for the six presets and goji (round H)', () => {
  for (const name of PHASE1_FIXTURES) {
    const f = loadFixture(name);
    const { converted } = convertCatalog(f.tools, { reserved: [FIND_TOOLS_NAME] });
    const upd = phaseSessionUpdate(initialPhase({ catalog: converted, server: f.initialize.serverInfo, instructions: f.initialize.instructions }));
    assert.equal((upd.session.input as Record<string, unknown>).transcription_mode, TRANSCRIPTION_MODE, name);
  }
});

test('the snapshot would notice a changed phase (control)', () => {
  const g = golden.find((x) => x.hasFindTools)!;
  const moved = { ...phase1(g.fixture), tools: [...phase1(g.fixture).tools].reverse() };
  assert.notDeepEqual(moved, g);
});
