/**
 * Stage packages/core for npm as `interpres`, and run `npm pack --dry-run`.
 * Nothing is published: that is Sergiu's step (npm login with web 2FA).
 *
 *   node scripts/npm-pack.ts
 *
 * The package ships compiled JavaScript: Node strips TypeScript types only
 * outside node_modules, so the .ts sources the monorepo runs directly would not
 * load for anyone who installed them.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const OUT = 'build/npm/interpres';
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
execFileSync('npx', ['tsc', '-p', 'packages/core/tsconfig.npm.json'], { stdio: 'inherit' });

const root = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
await writeFile(`${OUT}/package.json`, `${JSON.stringify({
  name: 'interpres',
  version: root.version,
  description: "Make any MCP server talkable through AssemblyAI's Voice Agent API: MCP tools to Voice Agent function tools, phased at 10, shaped for speech, gated against mishearing.",
  license: 'MIT',
  type: 'module',
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
  files: ['dist', 'README.md', 'LICENSE', 'THIRD_PARTY_LICENSES.md'],
  sideEffects: false,
  engines: { node: '>=20' },
  repository: { type: 'git', url: 'git+https://github.com/seekdaseek/interpres.git', directory: 'packages/core' },
  homepage: 'https://github.com/seekdaseek/interpres#readme',
  keywords: ['mcp', 'model-context-protocol', 'assemblyai', 'voice-agent', 'voice', 'tools'],
}, null, 2)}\n`);
await copyFile('packages/core/README.md', `${OUT}/README.md`);
await copyFile('LICENSE', `${OUT}/LICENSE`);
await copyFile('packages/core/THIRD_PARTY_LICENSES.md', `${OUT}/THIRD_PARTY_LICENSES.md`);

// The compiled package must load and work with no TypeScript anywhere.
const lib = await import(pathToFileURL(resolve(OUT, 'dist/index.js')).href);
const fixture = JSON.parse(await readFile('packages/core/test/fixtures/afg-marketplace.json', 'utf8'));
const { converted } = lib.convertCatalog(fixture.toolsList.tools);
const planner = { catalog: converted, server: fixture.initialize.serverInfo };
const update = lib.phaseSessionUpdate(lib.initialPhase(planner));
const swapped = lib.handleFindTools(planner, 'check a job contract');
console.log(`smoke: ${converted.length} tools converted; first phase shows ${update.session.tools.length}; find_tools reveals ${swapped.available.length}`);

execFileSync('npm', ['pack', '--dry-run'], { cwd: OUT, stdio: 'inherit' });
