/**
 * Snapshot of the opening phase ("phase 1") for the six presets and goji, from
 * their captured fixtures: the tools in view, find_tools, the reason, the key
 * terms, and a hash of the exact session.update. Written once before round F's
 * paid-tool change; packages/core/test/phase1.test.ts recomputes it and must
 * match, so a change meant for results and starters cannot move a phase.
 *
 *   node scripts/phase1-golden.ts
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { FIND_TOOLS_NAME, convertCatalog, initialPhase, phaseSessionUpdate } from '../packages/core/src/index.ts';
import { loadFixture } from '../packages/core/test/fixtures.ts';

export const PHASE1_FIXTURES = [
  'assemblyai-docs-mcp', 'afg-marketplace', 'advisorsai-service-navigator',
  'most-recommended-books', 'recipes-daily', 'weather-datakoot', 'goji',
];
export const GOLDEN_PATH = 'packages/core/test/phase1-golden.json';

export function phase1(name: string) {
  const f = loadFixture(name);
  const conversion = convertCatalog(f.tools, { reserved: [FIND_TOOLS_NAME] });
  const phase = initialPhase({ catalog: conversion.converted, server: f.initialize.serverInfo, instructions: f.initialize.instructions });
  const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
  return {
    fixture: name,
    url: f.captured.url,
    tools: phase.tools.map((t) => t.name),
    hasFindTools: phase.hasFindTools,
    reason: phase.reason,
    keyterms: phase.keyterms,
    sessionUpdateSha256: sha(phaseSessionUpdate(phase)),
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const golden = PHASE1_FIXTURES.map(phase1);
  writeFileSync(GOLDEN_PATH, `${JSON.stringify(golden, null, 1)}\n`);
  for (const g of golden) console.log(`${g.fixture}: ${g.tools.length} tools, find_tools ${g.hasFindTools}, ${g.sessionUpdateSha256.slice(0, 12)}`);
}
