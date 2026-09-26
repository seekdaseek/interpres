/**
 * docs/REFINE.md: what LLM Gateway refinement costs a spoken turn, recounted
 * from the committed runs. The A/B is the one like-for-like pair: the same six
 * questions to the same presets, refinement on in one run and off in the
 * other. Two day-wide counts sit under it, over every spoken run in data/.
 * The README quotes the table through scripts/docs-quote.ts.
 *
 *   node scripts/refine-report.ts
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

export const PAIR = { off: 'data/e2e-audio-refine-off.json', on: 'data/e2e-audio-refine-on.json' };

type Call = { refine?: string; refineMs?: number; transitionAudioMs?: number };
type Turn = { said?: string; calls?: Call[]; voiceToVoiceMs?: number };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length === 0 ? NaN : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

function toolTurns(file: string): Turn[] {
  return (JSON.parse(readFileSync(file, 'utf8')).results ?? [])
    .flatMap((r: { turns?: Turn[] }) => r.turns ?? [])
    .filter((t: Turn) => (t.calls ?? []).length > 0);
}

const refinedMs = (turns: Turn[]) =>
  turns.flatMap((t) => t.calls ?? []).filter((c) => c.refine === 'used' && typeof c.refineMs === 'number').map((c) => c.refineMs!);
const withAudioFirst = (turns: Turn[]) => turns.filter((t) => (t.calls ?? []).some((c) => (c.transitionAudioMs ?? 0) > 0)).length;
const ms = (n: number) => `${Math.round(n).toLocaleString('en-US')} ms`;
const range = (xs: number[]) => (xs.length ? `${ms(Math.min(...xs))} to ${ms(Math.max(...xs))}` : '-');

export function report(): string {
  const off = toolTurns(PAIR.off);
  const on = toolTurns(PAIR.on);
  if (JSON.stringify(off.map((t) => t.said)) !== JSON.stringify(on.map((t) => t.said))) throw new Error('the A/B runs do not ask the same questions');
  const v2v = (turns: Turn[]) => median(turns.map((t) => t.voiceToVoiceMs).filter((x): x is number => typeof x === 'number'));

  const spoken = readdirSync('data').filter((f) => f.startsWith('e2e-audio') && f.endsWith('.json')).sort();
  const allTurns = spoken.flatMap((f) => toolTurns(`data/${f}`));
  const allRefined = refinedMs(allTurns);

  return [
    '# What Gateway refinement costs a spoken turn',
    '',
    `The A/B is \`${PAIR.off}\` against \`${PAIR.on}\`: the same six questions to the same presets. The last two rows count every spoken run in \`data/e2e-audio*.json\` (${spoken.length} files). Recounted by \`scripts/refine-report.ts\`.`,
    '',
    '| | refinement off | refinement on |',
    '| --- | ---: | ---: |',
    `| tool-calling turns | ${off.length} | ${on.length} |`,
    `| calls the Gateway refined | ${refinedMs(off).length} | ${refinedMs(on).length} |`,
    `| Gateway time per refined call | ${range(refinedMs(off))} | ${range(refinedMs(on))} |`,
    `| median voice-to-voice | ${ms(v2v(off))} | ${ms(v2v(on))} |`,
    `| every spoken run: tool-calling turns with any audio before the tool result | ${withAudioFirst(allTurns)} of ${allTurns.length} | |`,
    `| every spoken run: Gateway time per refined call | | ${range(allRefined)} (${allRefined.length} calls) |`,
    '',
  ].join('\n');
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const md = report();
  writeFileSync('docs/REFINE.md', md);
  console.log(md);
}
