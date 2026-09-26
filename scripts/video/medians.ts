/**
 * The two medians each exchange in the video is shown next to (docs/VIDEO.md):
 * - the spoken sweep's voice-to-voice over the turns that called a tool, from
 *   data/voice-sweep-2026-09-26.json;
 * - the warm spoken suite's voice-to-voice, scripts/warm-ab.ts over
 *   data/e2e-audio-warm-on.json (README: 3,020 ms).
 * Never the sweep's 2.6 s, which covers all 29 answers, tool or not.
 *
 *   node scripts/video/medians.ts
 */
import { readFileSync } from 'node:fs';
import { summarise } from '../warm-ab.ts';

export const SWEEP_FILE = 'data/voice-sweep-2026-09-26.json';
export const WARM_FILE = 'data/e2e-audio-warm-on.json';

export const median = (xs: number[]): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

type SweepRow = { sessionId?: string; toolCalled?: string | null; voiceToVoiceMs?: number | null };

export function sweepMedians(): { toolTurns: number; toolMedianMs: number; answered: number; allMedianMs: number } {
  const rows = (JSON.parse(readFileSync(SWEEP_FILE, 'utf8')) as { rows: SweepRow[] }).rows;
  const answered = rows.filter((r) => typeof r.voiceToVoiceMs === 'number');
  const withTool = answered.filter((r) => typeof r.toolCalled === 'string' && r.toolCalled !== '');
  return {
    toolTurns: withTool.length,
    toolMedianMs: median(withTool.map((r) => r.voiceToVoiceMs!)),
    answered: answered.length,
    allMedianMs: median(answered.map((r) => r.voiceToVoiceMs!)),
  };
}

export async function warmMedian(): Promise<{ turns: number; medianMs: number }> {
  const on = await summarise(WARM_FILE);
  return { turns: on.turns, medianMs: on.v2vMedian };
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const s = sweepMedians();
  const w = await warmMedian();
  console.log(`spoken sweep, turns that called a tool: ${s.toolTurns}, median voice-to-voice ${Math.round(s.toolMedianMs)} ms`);
  console.log(`spoken sweep, all answered turns (the 2.6 s; never compared): ${s.answered}, median ${Math.round(s.allMedianMs)} ms`);
  console.log(`warm spoken suite: ${w.turns} turns, median voice-to-voice ${Math.round(w.medianMs)} ms`);
}
