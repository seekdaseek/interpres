/**
 * The warm-connection A/B, read from two e2e-audio runs of the spoken suite:
 * one with MCP_WARM=off, one with it on (the default).
 *
 *   node scripts/warm-ab.ts data/e2e-audio-warm-off.json data/e2e-audio-warm-on.json
 */
import { readFile } from 'node:fs/promises';

type Call = { name: string; mcpMs?: number; method?: string };
type Turn = { calls: Call[]; voiceToVoiceMs?: number };
type Run = { url: string; sessionId: string; turns: Turn[] };

const BUILT_INS = new Set(['use_pasted_text', 'find_tools']);

const median = (xs: number[]) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export async function summarise(file: string) {
  const d = JSON.parse(await readFile(file, 'utf8')) as { results: Run[] };
  const first: number[] = [];
  const later: number[] = [];
  const v2v: number[] = [];
  for (const r of d.results) {
    let n = 0;
    for (const t of r.turns) {
      if (typeof t.voiceToVoiceMs === 'number') v2v.push(t.voiceToVoiceMs);
      for (const c of t.calls) {
        // Only calls that reached an MCP server; the gate and the built-ins make none.
        if (BUILT_INS.has(c.name) || typeof c.mcpMs !== 'number' || String(c.method ?? '').startsWith('gate')) continue;
        (n++ === 0 ? first : later).push(c.mcpMs);
      }
    }
  }
  const all = [...first, ...later];
  return { calls: all.length, mcpMedian: median(all), firstMedian: median(first), laterMedian: median(later), firstN: first.length, laterN: later.length, turns: v2v.length, v2vMedian: median(v2v), sessions: d.results.map((r) => r.sessionId) };
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [offFile, onFile] = process.argv.slice(2);
  if (!offFile || !onFile) { console.error('usage: node scripts/warm-ab.ts <off.json> <on.json>'); process.exit(2); }
  const off = await summarise(offFile);
  const on = await summarise(onFile);
  const row = (label: string, a: number, b: number) => console.log(`${label.padEnd(36)} ${String(Math.round(a)).padStart(6)}  ${String(Math.round(b)).padStart(6)}  ${String(Math.round(a - b)).padStart(6)}`);
  console.log(`${''.padEnd(36)} ${'off'.padStart(6)}  ${'on'.padStart(6)}  ${'gain'.padStart(6)}  (ms, medians)`);
  row(`MCP call, all (n=${off.calls}/${on.calls})`, off.mcpMedian, on.mcpMedian);
  row(`MCP call, first in session (n=${off.firstN}/${on.firstN})`, off.firstMedian, on.firstMedian);
  row(`MCP call, later in session (n=${off.laterN}/${on.laterN})`, off.laterMedian, on.laterMedian);
  row(`voice-to-voice (turns ${off.turns}/${on.turns})`, off.v2vMedian, on.v2vMedian);
  console.log(`off sessions: ${off.sessions.join(' ')}`);
  console.log(`on sessions:  ${on.sessions.join(' ')}`);
}
