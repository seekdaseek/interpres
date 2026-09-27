/**
 * The spoken sweep. From the registry sweep, the first 30 servers in registry
 * order that listed their tools without auth, declare no auth, and have at least
 * one read-only tool - no picking. Each is connected afresh, asked its first
 * starter question (task 5: the LLM Gateway, or templates) out loud in a
 * macOS `say` voice, through a real Voice Agent session that can see ONLY its
 * read-only tools. No state-changing tool is ever exposed, and no auth is sent.
 *
 *   node --env-file=.env scripts/voice-sweep.ts <sweep .json.gz with raw catalogs> [--limit 30]
 *
 * Sequential; each session capped at 90 s by its token; stops before spend
 * passes $5 at $4.50/hr. Writes data/voice-sweep-<date>.json and docs/VOICE-SWEEP.md.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { readSweep } from './sweep.ts';
import { isReadOnlyTool, sharedPrefixTokens } from '../packages/core/src/index.ts';
import { getCatalog } from '../apps/server/src/catalog.ts';
import { writeStarters } from '../apps/server/src/starters.ts';
import { CircuitBreaker } from '../apps/server/src/shaper.ts';
import { LiveSession } from './lib/session.ts';
import { AudioPump, silence, synthesize } from './lib/audio.ts';

const SESSION_CAP_S = 90;
const BUDGET_USD = 5;
const USD_PER_S = 4.5 / 3600;
const BUILT_INS = new Set(['use_pasted_text', 'find_tools']);

type Row = {
  order: number;
  name: string;
  url: string;
  toolsTotal: number;
  readOnlyTools: number;
  connect: 'ok' | 'failed';
  connectError?: string;
  starter?: { source: string; question: string; reason?: string; ms: number; attempts: number };
  sessionId?: string;
  heard?: string;
  toolCalled?: string | null;
  toolArgs?: unknown;
  mcp?: 'ok' | 'error' | 'held' | 'none';
  answer?: string;
  voiceToVoiceMs?: number;
  seconds?: number;
  failures?: string[];
};

const median = (xs: number[]) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

async function main(): Promise<void> {
  const file = process.argv[2];
  const li = process.argv.indexOf('--limit');
  const limit = li > 0 ? Number(process.argv[li + 1]) : 30;
  if (!file) { console.error('usage: node --env-file=.env scripts/voice-sweep.ts <sweep .json.gz> [--limit 30]'); process.exit(2); }
  const A = await readSweep(file);

  const picked: Array<{ name: string; url: string; total: number; ro: number }> = [];
  for (const r of A.servers) {
    if (r.class !== 'ok' || r.declaresAuth || !r.url) continue;
    const tools = r.toolsList ?? [];
    const shared = sharedPrefixTokens(tools.map((t) => t.name));
    const ro = tools.filter((t) => isReadOnlyTool(t, shared)).length;
    if (ro === 0) continue;
    picked.push({ name: r.name, url: r.url, total: tools.length, ro });
    if (picked.length === limit) break;
  }
  console.log(`spoken sweep: ${picked.length} servers from ${file}`);

  const breaker = new CircuitBreaker();
  const rows: Row[] = [];
  let spentS = 0;
  const startedAt = new Date().toISOString();
  // Pass 1: connect, and take each server's starters, before any session runs.
  // The Gateway's free plan answers 429 to more than a couple of calls a minute
  // (the first run got templates for 5 of its first 6 servers). A batch can wait
  // the breaker out, which a person connecting cannot; templates remain the
  // fallback after three tries.
  const prepared: Array<{ row: Row; question: string }> = [];
  for (const [i, p] of picked.entries()) {
    const row: Row = { order: i + 1, name: p.name, url: p.url, toolsTotal: p.total, readOnlyTools: p.ro, connect: 'ok' };
    rows.push(row);
    let catalog;
    try {
      catalog = (await getCatalog(p.url, { force: true })).catalog;
    } catch (err) {
      row.connect = 'failed';
      row.connectError = err instanceof Error ? err.message.slice(0, 200) : String(err);
      console.log(`${String(i + 1).padStart(2)} ${p.name}: connect failed (${row.connectError})`);
      continue;
    }
    let starters = await writeStarters(catalog, { breaker });
    let attempts = 1;
    while (attempts < 3 && starters.source === 'template' && (starters.reason === 'rate_limited' || starters.reason === 'breaker_open')) {
      const wait = breaker.secondsLeft() + 1;
      console.log(`   ${p.name}: Gateway rate-limited, waiting ${wait} s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      starters = await writeStarters(catalog, { breaker });
      attempts++;
    }
    const question = starters.questions[0] ?? 'What can you do?';
    row.starter = { source: starters.source, question, reason: starters.reason, ms: starters.ms, attempts };
    console.log(`${String(i + 1).padStart(2)} ${p.name}: [${starters.source}${starters.reason ? ` ${starters.reason}` : ''}] "${question}"`);
    prepared.push({ row, question });
  }

  // Pass 2: the voice sessions, one at a time, inside the budget.
  for (const { row, question } of prepared) {
    if (spentS * USD_PER_S >= BUDGET_USD) { console.log(`budget of $${BUDGET_USD} reached before ${row.name}: stopping`); break; }
    const p = { name: row.name, url: row.url };
    const i = row.order - 1;
    const clip = await synthesize(question, { voice: 'Samantha' });
    const opened = Date.now();
    let session: LiveSession | undefined;
    try {
      session = await LiveSession.open(p.url, { readOnlyOnly: true, maxSessionSeconds: SESSION_CAP_S });
      row.sessionId = session.sessionId;
      const pump = new AudioPump((b64) => session!.sendAudio(b64));
      pump.start();
      await pump.enqueue(silence(400));
      const turn = session.beginTurn(question);
      await pump.enqueue(clip.pcm);
      turn.speechEndAt = Date.now();
      const idle = session.waitIdle(60_000);
      void pump.enqueue(silence(1500));
      if ((await idle) === 'timeout') session.failures.push('turn timed out');
      const done = session.endTurn()!;
      pump.stop();
      const call = done.calls.find((c) => !BUILT_INS.has(c.name));
      row.heard = done.heard.join(' ');
      row.toolCalled = call?.name ?? null;
      row.toolArgs = call?.arguments;
      row.mcp = !call ? 'none' : String(call.method ?? '').startsWith('gate') ? 'held' : call.isError ? 'error' : 'ok';
      row.answer = done.agentReply;
      row.voiceToVoiceMs = done.voiceToVoiceMs;
      row.failures = [...session.failures];
    } catch (err) {
      row.failures = [err instanceof Error ? err.message.slice(0, 200) : String(err)];
    } finally {
      await session?.close().catch(() => {});
      row.seconds = Math.round((Date.now() - opened) / 100) / 10;
      spentS += row.seconds;
    }
    console.log(`${String(i + 1).padStart(2)} ${p.name}: [${row.starter!.source}] "${question}" -> ${row.toolCalled ?? '(no tool)'} ${row.mcp} | ${row.voiceToVoiceMs ?? '-'} ms | ${row.sessionId} | ${(row.answer ?? '').slice(0, 70)}`);
  }

  const day = startedAt.slice(0, 10);
  const out: Saved = { startedAt, finishedAt: new Date().toISOString(), source: file, limit, sessionCapSeconds: SESSION_CAP_S, budgetUsd: BUDGET_USD, spentSeconds: Math.round(spentS), rows };
  await mkdir('data', { recursive: true });
  await writeFile(`data/voice-sweep-${day}.json`, `${JSON.stringify(out, null, 1)}\n`);
  await renderPage(out, `data/voice-sweep-${day}.json`);
}

type Saved = { startedAt: string; finishedAt: string; source: string; limit: number; sessionCapSeconds: number; budgetUsd: number; spentSeconds: number; rows: Row[] };

/** docs/VOICE-SWEEP.md from a saved run. */
async function renderPage(out: Saved, dataFile: string): Promise<void> {
  const { startedAt, rows, limit } = out;
  const file = out.source;
  const spentS = out.spentSeconds;
  const day = startedAt.slice(0, 10);
  const connected = rows.filter((r) => r.connect === 'ok');
  const ran = rows.filter((r) => r.sessionId);
  const called = ran.filter((r) => r.toolCalled);
  const answered = ran.filter((r) => (r.answer ?? '').trim() !== '');
  const v2v = answered.map((r) => r.voiceToVoiceMs).filter((x): x is number => typeof x === 'number');
  const count = (f: (r: Row) => boolean) => rows.filter(f).length;
  const md: string[] = [];
  md.push('# Spoken sweep', '');
  md.push(`Run ${startedAt} to ${out.finishedAt} by \`scripts/voice-sweep.ts\`, from \`${file.replace(/^.*\//, '')}\`.`, '');
  md.push(`The first ${limit} servers of the registry sweep, in registry order, that listed their tools without auth, declare no auth, and have at least one read-only tool (\`readOnlyHint: true\`, or unannotated and not a write by the gate's classifier). Nothing was picked by hand.`, '');
  md.push(`Each server was connected afresh and asked the first of its starter questions (task 5: written by the LLM Gateway, or templates when it could not answer), spoken in a macOS \`say\` voice (Samantha) through a real Voice Agent session that could see only that server's read-only tools. No state-changing tool was exposed and no credential was sent. Sessions ran one at a time, each capped at ${SESSION_CAP_S} s, under a $${BUDGET_USD} budget.`, '');
  md.push('Every starter was written before any session ran. When the Gateway rate-limited (this account\'s free plan answers 429 to more than a couple of calls a minute), the batch waited out its 60 s breaker and asked again, up to three tries; templates built from the tools\' own descriptions were the fallback. A first run that did not wait got templates for 5 of its first 6 servers, and was stopped.', '');
  md.push('## Counts', '');
  md.push('| | count |', '| --- | ---: |');
  md.push(`| servers attempted | ${rows.length} |`);
  md.push(`| connected | ${connected.length} |`);
  md.push(`| starter from the LLM Gateway / from templates | ${count((r) => r.starter?.source === 'gateway')} / ${count((r) => r.starter?.source === 'template')} |`);
  md.push(`| voice sessions run | ${ran.length} |`);
  md.push(`| session failed to open (the API's own session.error) | ${rows.filter((r) => r.connect === 'ok' && !r.sessionId).length} |`);
  md.push(`| a tool was called | ${called.length} |`);
  md.push(`| MCP call succeeded / tool answered with an error / held by the gate | ${count((r) => r.mcp === 'ok')} / ${count((r) => r.mcp === 'error')} / ${count((r) => r.mcp === 'held')} |`);
  md.push(`| the agent answered out loud | ${answered.length} |`);
  md.push(`| median voice-to-voice, answered turns | ${Number.isNaN(median(v2v)) ? '-' : `${Math.round(median(v2v))} ms`} |`);
  // The fair figure for a turn the video shows: only the turns in which a tool ran.
  const toolV2v = called.map((r) => r.voiceToVoiceMs).filter((x): x is number => typeof x === 'number');
  md.push(`| median voice-to-voice, turns that called a tool | ${Number.isNaN(median(toolV2v)) ? '-' : `${Math.round(median(toolV2v))} ms (${toolV2v.length} turns)`} |`);
  md.push(`| session time, and its cost at $4.50/hr | ${Math.round(spentS)} s, $${(spentS * USD_PER_S).toFixed(2)} |`, '');
  md.push('## Every server', '');
  md.push('| # | server | read-only tools | starter | tool called | MCP | answer | voice-to-voice | session_id |');
  md.push('| ---: | --- | ---: | --- | --- | --- | --- | ---: | --- |');
  for (const r of rows) {
    md.push(`| ${r.order} | ${cell(r.name)} | ${r.readOnlyTools} of ${r.toolsTotal} | ${r.starter ? `${cell(r.starter.question)} (${r.starter.source}${r.starter.attempts > 1 ? `, ${r.starter.attempts} tries` : ''})` : `connect failed: ${cell(r.connectError)}`} | ${cell(r.toolCalled ?? '-')} | ${cell(r.mcp ?? '-')} | ${r.connect === 'ok' && !r.sessionId ? `session failed to open: ${cell((r.failures ?? []).join('; '))}` : cell((r.answer ?? '').slice(0, 140) || '-')} | ${r.voiceToVoiceMs ?? '-'} | ${r.sessionId ? `\`${r.sessionId}\`` : '-'} |`);
  }
  md.push('', `Every \`session_id\` above can be looked up in AssemblyAI Session History; \`data/voice-sweep-${day}.json\` holds each run in full.`, '');
  await mkdir('docs', { recursive: true });
  await writeFile('docs/VOICE-SWEEP.md', `${md.join('\n')}\n`);
  console.log(`\nwritten: docs/VOICE-SWEEP.md from ${dataFile}; ${ran.length} sessions, ${Math.round(spentS)} s, $${(spentS * USD_PER_S).toFixed(2)}`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const ri = process.argv.indexOf('--render');
  if (ri > 0) {
    // Render the page again from a saved run, without running anything.
    const f = process.argv[ri + 1]!;
    const { readFile } = await import('node:fs/promises');
    await renderPage(JSON.parse(await readFile(f, 'utf8')) as Saved, f);
  } else {
    await main();
  }
}
