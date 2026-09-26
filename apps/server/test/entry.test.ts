import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const src = (name: string) => fileURLToPath(new URL(`../src/${name}`, import.meta.url));

/**
 * Import an entry file the way PM2's fork container does - from another file,
 * so process.argv[1] is not the entry - and report whether it bound a port.
 * Reads the "listening" line rather than connecting, so it needs no socket
 * client and still passes with outbound network denied.
 */
function importAsProcessManager(file: string, ms = 8000): Promise<{ listening: boolean; code: number | null }> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(file).href)})`], {
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      ASSEMBLYAI_API_KEY: 'test-not-a-real-key',
      AGENTS_API: 'http://127.0.0.1:9',
      LOG_PATH: join(tmpdir(), `interpres-entry-${process.pid}.jsonl`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve) => {
    let out = '';
    const done = (listening: boolean, code: number | null) => {
      clearTimeout(timer);
      child.kill();
      resolve({ listening, code });
    };
    const timer = setTimeout(() => done(false, null), ms);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (/interpres listening on http:\/\/127\.0\.0\.1:\d+/.test(out)) done(true, null);
    });
    child.on('exit', (code) => done(false, code));
  });
}

test('serve.ts binds when a process manager imports it', async () => {
  const r = await importAsProcessManager(src('serve.ts'));
  assert.equal(r.listening, true, `serve.ts must listen; exited with ${r.code}`);
});

test('index.ts imported the same way stays silent (why serve.ts exists)', async () => {
  const r = await importAsProcessManager(src('index.ts'));
  assert.equal(r.listening, false);
  assert.equal(r.code, 0, 'a clean exit is exactly what PM2 would restart forever');
});
