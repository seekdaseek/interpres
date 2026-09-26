/**
 * docs/PROOF.md from AssemblyAI's Session History: every session_id recorded in
 * data/*.json, read back from the API rather than from our own logs. Sessions,
 * tool calls, success rate, median tool latency, time to first audio, and the
 * cost computed from the published $4.50/hr.
 *
 *   node --env-file=.env scripts/proof.ts
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { getSession, getTimeline } from './session-history.ts';
import type { TimelineTurn } from './session-history.ts';

const USD_PER_HOUR = 4.5;

const median = (xs: number[]) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

type Row = { id: string; file: string; status?: string; seconds: number; toolCalls: number; toolErrors: number; toolMs: number[]; ttfa: number[]; error?: string };

async function main(): Promise<void> {
  // Every session a data file names, and the first file that names it.
  const where = new Map<string, string>();
  for (const f of (await readdir('data')).filter((x) => x.endsWith('.json')).sort()) {
    for (const id of (await readFile(`data/${f}`, 'utf8')).match(/sess_[0-9a-f]{32}/g) ?? []) if (!where.has(id)) where.set(id, f);
  }
  const ids = [...where.keys()];
  console.log(`${ids.length} session ids in data/`);

  const rows: Row[] = [];
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++]!;
      const row: Row = { id, file: where.get(id)!, seconds: 0, toolCalls: 0, toolErrors: 0, toolMs: [], ttfa: [] };
      try {
        const s = await getSession(id);
        row.status = s.status;
        row.seconds = Number(s.duration_seconds ?? 0);
        const tl = await getTimeline(s);
        for (const t of (tl?.turns ?? []) as TimelineTurn[]) {
          if (typeof t.time_to_first_audio_ms === 'number') row.ttfa.push(t.time_to_first_audio_ms);
          for (const c of t.tool_calls ?? []) {
            row.toolCalls++;
            if (c.is_error === true) row.toolErrors++;
            if (typeof c.duration_ms === 'number') row.toolMs.push(c.duration_ms);
          }
        }
      } catch (err) {
        row.error = err instanceof Error ? err.message.slice(0, 120) : String(err);
      }
      rows.push(row);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  rows.sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id));

  const read = rows.filter((r) => !r.error);
  const calls = read.reduce((n, r) => n + r.toolCalls, 0);
  const errors = read.reduce((n, r) => n + r.toolErrors, 0);
  const toolMs = read.flatMap((r) => r.toolMs);
  const ttfa = read.flatMap((r) => r.ttfa);
  const seconds = read.reduce((n, r) => n + r.seconds, 0);
  const pulledAt = new Date().toISOString();
  const byFile = new Map<string, Row[]>();
  for (const r of rows) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);

  const md: string[] = [];
  md.push('# Proof from Session History', '');
  md.push(`Every \`session_id\` recorded in \`data/*.json\`, read back from AssemblyAI's Session History (\`GET /v1/sessions/{id}\` and its timeline artifact) at ${pulledAt} by \`scripts/proof.ts\`. None of these numbers come from interpres's own logs.`, '');
  md.push('| | |', '| --- | ---: |');
  md.push(`| sessions | ${read.length}${rows.length > read.length ? ` (${rows.length - read.length} could not be read back)` : ''} |`);
  md.push(`| tool calls | ${calls} |`);
  md.push(`| tool calls answered with no error flag (Session History \`is_error\`) | ${calls - errors} of ${calls} (${calls > 0 ? ((100 * (calls - errors)) / calls).toFixed(1) : '-'}%) |`);
  md.push(`| median tool latency | ${Number.isNaN(median(toolMs)) ? '-' : `${Math.round(median(toolMs))} ms`} (n=${toolMs.length}) |`);
  md.push(`| median time to first audio | ${Number.isNaN(median(ttfa)) ? '-' : `${Math.round(median(ttfa))} ms`} (n=${ttfa.length} turns that report it) |`);
  md.push(`| session time | ${Math.round(seconds)} s |`);
  md.push(`| cost, computed from the published $${USD_PER_HOUR.toFixed(2)}/hr (not read from a bill) | $${((seconds / 3600) * USD_PER_HOUR).toFixed(2)} |`, '');
  md.push('`is_error` marks a tool.result the agent received as an error. interpres hands a tool\'s own error back as a result the agent can speak, so a tool that answered "nothing found" or "needs a key" counts as answered here: the spoken sweep counts those separately (docs/VOICE-SWEEP.md).', '');
  md.push('Session History reports time to first audio for greetings and tool-free turns only; a turn that calls a tool carries no reply start and no time to first audio (see the README, "Measured against the docs").', '');
  md.push('## By data file', '');
  md.push('| data file | sessions | tool calls | errors | seconds |', '| --- | ---: | ---: | ---: | ---: |');
  for (const [f, rs] of byFile) {
    const ok = rs.filter((r) => !r.error);
    md.push(`| \`${f}\` | ${ok.length} | ${ok.reduce((n, r) => n + r.toolCalls, 0)} | ${ok.reduce((n, r) => n + r.toolErrors, 0)} | ${Math.round(ok.reduce((n, r) => n + r.seconds, 0))} |`);
  }
  md.push('', '## Every session', '');
  md.push('| session_id | data file | status | seconds | tool calls | errors | median tool ms |', '| --- | --- | --- | ---: | ---: | ---: | ---: |');
  for (const r of rows) {
    md.push(`| \`${r.id}\` | ${r.file} | ${r.error ? `not read: ${r.error}` : r.status ?? '-'} | ${r.seconds ? r.seconds.toFixed(1) : '-'} | ${r.toolCalls} | ${r.toolErrors} | ${Number.isNaN(median(r.toolMs)) ? '-' : Math.round(median(r.toolMs))} |`);
  }
  md.push('');
  await writeFile('docs/PROOF.md', `${md.join('\n')}\n`);
  console.log(`docs/PROOF.md: ${read.length} sessions, ${calls} tool calls (${errors} errors), median tool ${Math.round(median(toolMs))} ms, median ttfa ${Math.round(median(ttfa))} ms, ${Math.round(seconds)} s, $${((seconds / 3600) * USD_PER_HOUR).toFixed(2)}`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) await main();
