import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { McpInitializeResult, McpTool } from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(HERE, 'fixtures');

export type Fixture = {
  name: string;
  captured: { url: string; at: string; statefulSession?: boolean };
  initialize: McpInitializeResult;
  tools: McpTool[];
};

export function loadFixture(name: string): Fixture {
  const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8'));
  return { name, captured: raw._captured, initialize: raw.initialize, tools: raw.toolsList.tools };
}

/** Every fixture on disk, so a newly captured server is tested automatically. */
export function allFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => loadFixture(f.replace(/\.json$/, '')))
    .sort((a, b) => a.name.localeCompare(b.name));
}
