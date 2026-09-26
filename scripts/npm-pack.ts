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
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

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
  bugs: { url: 'https://github.com/seekdaseek/interpres/issues' },
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

// The README's example must run as written, installed the way a user would:
// the packed tarball into an empty project, then `node example.mjs`.
const scratch = await mkdtemp(join(tmpdir(), 'interpres-example-'));
const tgz = execFileSync('npm', ['pack', '--pack-destination', scratch, '--silent'], { cwd: OUT }).toString().trim().split('\n').pop()!;
await writeFile(join(scratch, 'package.json'), '{ "name": "readme-example", "private": true, "type": "module" }\n');
execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent', join(scratch, tgz)], { cwd: scratch, stdio: 'inherit' });
const example = (await readFile(`${OUT}/README.md`, 'utf8')).match(/```js\n([\s\S]*?)```/)?.[1];
if (!example) throw new Error('README.md has no ```js example');
await writeFile(join(scratch, 'example.mjs'), example);
console.log(`README example, run from a clean install of ${tgz}: ${execFileSync('node', ['example.mjs'], { cwd: scratch }).toString().trim()}`);

execFileSync('npm', ['pack', '--dry-run'], { cwd: OUT, stdio: 'inherit' });
