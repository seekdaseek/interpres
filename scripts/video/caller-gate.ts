/**
 * Round F2a: a caller clip is judged where it is heard.
 *
 * Each clip is streamed at real-time pace, like a microphone, into a live Voice
 * Agent session opened in this process with the API key (as scripts/e2e-audio.ts
 * does, not through the public site). The session is set up as the page sets up
 * that scene's server at that point in the scene: the page's own
 * `session.update` (system prompt, tools, keyterms, transcription prompt,
 * greeting, formats), the greeting played out before the caller speaks, and in
 * scene C the phase that find_tools swapped in plus the pasted sample address's
 * keyterms, pushed the way the page's paste box pushes them.
 *
 * The setup is also compared with what the public site would send, from its
 * /api/mcp/connect and /api/mcp/find-tools answers (no voice session there).
 *
 * A clip passes when two sessions in a row hear it exactly: scripts/video/stt.ts
 * `matchWords`, which forgives case, punctuation and number format and nothing
 * else. A scene gets at most `--max` sessions (default 4) and stops as soon as
 * every clip in it has passed or a pass is out of reach.
 *
 *   node --env-file=.env scripts/video/caller-gate.ts --scene A|B|C [--max 4] [--no-public]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mergeKeyterms, pasteKeyterms, phaseSessionUpdate } from '@interpres/core';
import { AudioPump, assertApiFormat, parseWav, silence } from '../lib/audio.ts';
import { LiveSession } from '../lib/session.ts';
import { PROPER_NOUN_VARIANTS, VOICES, agentVoice, callerLines, callerSay } from './config.ts';
import { matchWords } from './stt.ts';
import { MANIFEST } from './voices.ts';

export const GATE_FILE = 'data/video/caller-gate.json';
const PUBLIC = 'https://interpres.ochinimus.app';
const SAMPLE_ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const TURN_TIMEOUT_MS = 45_000;

type Scene = { url: string; clips: string[]; note: string };
export const SCENES: Record<string, Scene> = {
  A: { url: 'https://mcp.goji.agency/mcp', clips: ['Q1'], note: 'goji, opening phase, paste box empty' },
  B: { url: 'https://mostrecommendedbooks.com/api/mcp', clips: ['Q2'], note: 'Most Recommended Books, opening phase, paste box empty' },
  C: { url: 'https://afg.ai/mcp', clips: ['Q3', 'Q4'], note: 'AFG: Q3 in the opening phase with the paste box empty; Q4 in the phase find_tools swapped in, after the sample address is pasted' },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** JSON with sorted keys, so two setups compare by content alone. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

async function publicJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${PUBLIC}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text) as T;
}

type PublicPhase = { keyterms: string[]; sessionUpdate: { session: Record<string, unknown> } };

/** The page's opening session.update, built from the public connect answer exactly as voice.ts start() builds it. */
async function publicOpening(url: string): Promise<Record<string, unknown>> {
  const c = await publicJson<{ url: string; greeting: string; phase: PublicPhase }>('/api/mcp/connect', { url });
  const s = c.phase.sessionUpdate.session;
  return {
    ...s,
    greeting: c.greeting,
    input: { ...(s.input as Record<string, unknown>), keyterms: mergeKeyterms(c.phase.keyterms, []), format: { encoding: 'audio/pcm' } },
    output: { voice: agentVoice(), format: { encoding: 'audio/pcm' } },
  };
}

type Clip = { id: string; caption: string; say: string; voice: string; file: string; sha256: string; ms: number; pcm: Buffer };

function loadClip(id: string): Clip {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { lines: Record<string, { voice: string; text: string; say?: string; file: string }> };
  const e = manifest.lines[id];
  if (!e || !existsSync(e.file)) throw new Error(`${id}: no clip in ${MANIFEST}; make it with scripts/video/voices.ts --only ${id}`);
  const caption = callerLines()[id]!;
  if (e.text !== caption) throw new Error(`${id}: the clip says "${e.text}", the script now says "${caption}"; remake it`);
  if ((e.say ?? e.text) !== callerSay(id, caption)) throw new Error(`${id}: the clip was made from different spoken text; remake it`);
  const bytes = readFileSync(e.file);
  const w = parseWav(bytes);
  assertApiFormat(w);
  return { id, caption, say: e.say ?? e.text, voice: e.voice, file: e.file, sha256: sha256(bytes), ms: Math.round(w.pcm.length / 48), pcm: Buffer.from(w.pcm) };
}

type Heard = {
  clip: string; heard: string; exact: boolean; firstDifference?: unknown; variantsUsed: string[];
  counted: boolean; whyNotCounted?: string;
  voiceToVoiceMs?: number; agentReply: string;
  calls: Array<{ name: string; arguments: Record<string, unknown>; method?: string; isError?: boolean; phaseAfter?: string[] }>;
};

type SessionRun = {
  sessionId: string; at: string; greeting: { text: string; audioMs: number };
  setup: { sha256: string; tools: string[]; keyterms: number; publicMatch: boolean | null };
  afterFindTools?: { query: string; tools: string[]; publicMatch: boolean | null; pasteKeyterms: string[]; keytermsAfterPaste: number };
  heard: Heard[];
  mcpRequests: Array<{ tool: string; argsSha256: Record<string, string> }>;
  failures: string[];
};

/** Wait until the greeting has played out, as the page plays it: from its first audio, for its length. */
async function waitGreeting(s: LiveSession): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < 25_000) {
    const r = s.replies[0];
    if (r?.doneAt !== undefined && r.firstAudioAt !== undefined && Date.now() >= r.firstAudioAt + r.audioBytes / 48 + 700) return Math.round(r.audioBytes / 48);
    await sleep(100);
  }
  throw new Error('the greeting did not finish within 25 s');
}

async function say(s: LiveSession, pump: AudioPump, clip: Clip): Promise<Heard> {
  const turn = s.beginTurn(clip.caption);
  await pump.enqueue(Buffer.from(clip.pcm));
  turn.speechEndAt = Date.now();
  const idle = s.waitIdle(TURN_TIMEOUT_MS);
  void pump.enqueue(silence(1500));
  const outcome = await idle;
  const done = s.endTurn()!;
  if (outcome === 'timeout') s.failures.push(`${clip.id}: the turn did not go idle within ${TURN_TIMEOUT_MS / 1000} s`);
  const heard = done.heard.join(' ').trim();
  const m = matchWords(clip.caption, heard, PROPER_NOUN_VARIANTS);
  console.log(`  ${clip.id} heard "${heard}" -> ${m.ok ? 'EXACT' : `DIFFERS at word ${m.firstDifference?.at}: "${m.firstDifference?.expected}" vs "${m.firstDifference?.heard}"`}; v2v ${done.voiceToVoiceMs ?? '?'} ms; calls ${done.calls.map((c) => c.name).join(', ') || 'none'}`);
  return {
    clip: clip.id, heard, exact: m.ok, firstDifference: m.firstDifference, variantsUsed: m.variantsUsed, counted: true,
    voiceToVoiceMs: done.voiceToVoiceMs, agentReply: done.agentReply,
    calls: done.calls.map((c) => ({ name: c.name, arguments: c.arguments, method: c.method, isError: c.isError, phaseAfter: c.phaseAfter })),
  };
}

async function runSession(scene: string, clips: Clip[], opening: Record<string, unknown> | null): Promise<SessionRun> {
  const sc = SCENES[scene]!;
  const s = await LiveSession.open(sc.url, { asPage: true, maxSessionSeconds: 180 });
  const pump = new AudioPump((b64) => s.sendAudio(b64));
  // The page's microphone streams from session.ready on, silence included.
  pump.start();
  const agentLines: string[] = [];
  s.onEvent((m) => { if (m.type === 'transcript.agent') agentLines.push(String(m.text ?? '')); });
  const run: SessionRun = {
    sessionId: s.sessionId, at: new Date().toISOString(), greeting: { text: '', audioMs: 0 },
    setup: {
      sha256: sha256(canonical(s.sentSetup)),
      tools: (s.sentSetup.tools as Array<{ name: string }>).map((t) => t.name),
      keyterms: ((s.sentSetup.input as { keyterms: string[] }).keyterms ?? []).length,
      publicMatch: opening === null ? null : canonical(opening) === canonical(s.sentSetup),
    },
    heard: [], mcpRequests: [], failures: [],
  };
  console.log(`session ${s.sessionId}: ${run.setup.tools.length} tools, ${run.setup.keyterms} keyterms, setup ${run.setup.sha256.slice(0, 12)}${run.setup.publicMatch === null ? '' : run.setup.publicMatch ? ', same as the public site' : ', DIFFERS from the public site'}`);
  try {
    run.greeting.audioMs = await waitGreeting(s);
    run.greeting.text = agentLines[0] ?? '';
    console.log(`  greeting ${run.greeting.audioMs} ms: "${run.greeting.text}"`);
    for (const clip of clips) {
      if (clip.id === 'Q4') {
        // Scene C: the swap must have happened, as it does in the scene, for Q4's setup to be the scene's.
        const ft = run.heard.find((h) => h.clip === 'Q3')?.calls.find((c) => c.name === 'find_tools');
        const swapped = ft !== undefined && s.phase.tools.some((t) => t.name === 'afg_speccheck');
        const pasteTerms = pasteKeyterms(SAMPLE_ADDRESS);
        let publicMatch: boolean | null = null;
        if (ft && opening !== null) {
          const q3 = run.heard.find((h) => h.clip === 'Q3')!;
          const r = await publicJson<{ phase: PublicPhase }>('/api/mcp/find-tools', { url: sc.url, query: String(ft.arguments.query ?? ''), lastUserTurn: q3.heard });
          const pageSide = { ...r.phase.sessionUpdate.session, input: { ...(r.phase.sessionUpdate.session.input as Record<string, unknown>), keyterms: mergeKeyterms(r.phase.keyterms, []) } };
          publicMatch = canonical(pageSide) === canonical(phaseSessionUpdate(s.phase).session);
        }
        // The page's paste box: copy, paste, and notePaste pushes the merged keyterms.
        const merged = s.setPaste(SAMPLE_ADDRESS);
        run.afterFindTools = { query: String(ft?.arguments.query ?? ''), tools: s.phase.tools.map((t) => t.name), publicMatch, pasteKeyterms: pasteTerms, keytermsAfterPaste: merged.length };
        console.log(`  paste: ${pasteTerms.length} keyterms from the sample address, ${merged.length} in effect; phase ${swapped ? 'is the swapped one' : 'was NOT swapped'}${publicMatch === null ? '' : publicMatch ? ', same as the public site' : ', DIFFERS from the public site'}`);
        await pump.enqueue(silence(3000));
        const h = await say(s, pump, clip);
        if (!swapped) { h.counted = false; h.whyNotCounted = 'find_tools did not swap afg_speccheck in during Q3, so this is not the scene\'s setup'; }
        run.heard.push(h);
      } else {
        run.heard.push(await say(s, pump, clip));
      }
      await pump.enqueue(silence(800));
    }
  } finally {
    pump.stop();
    await s.close();
  }
  run.mcpRequests = s.mcpRequests.map((r) => ({ tool: r.tool, argsSha256: r.sha256 }));
  run.failures = [...s.failures];
  return run;
}

/** pass: two exact in a row; fail: that can no longer happen within `max`; open: keep going. */
export function verdict(results: boolean[], max: number): 'pass' | 'fail' | 'open' {
  for (let i = 1; i < results.length; i++) if (results[i] && results[i - 1]) return 'pass';
  const left = max - results.length;
  if (left >= 2 || (left === 1 && results.at(-1) === true)) return 'open';
  return 'fail';
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const scene = arg('--scene') ?? '';
  const max = Number(arg('--max') ?? 4);
  if (!SCENES[scene]) { console.error(`--scene ${Object.keys(SCENES).join('|')}`); process.exit(2); }
  const sc = SCENES[scene]!;
  const clips = sc.clips.map(loadClip);
  for (const c of clips) {
    if (c.voice !== VOICES.caller) throw new Error(`${c.id} was made in ${c.voice}, the config's caller is ${VOICES.caller}`);
  }
  console.log(`scene ${scene}: ${sc.note}`);
  for (const c of clips) console.log(`  ${c.id} (${c.voice}, ${c.ms} ms, sha256 ${c.sha256.slice(0, 12)}): "${c.caption}"${c.say !== c.caption ? ` voice given "${c.say}"` : ''}`);
  const opening = process.argv.includes('--no-public') ? null : await publicOpening(sc.url);

  const record = existsSync(GATE_FILE) ? JSON.parse(readFileSync(GATE_FILE, 'utf8')) : { rule: '', runs: [] };
  record.rule = 'A clip passes when two live sessions in a row hear it exactly (matchWords: case, punctuation and number format forgiven). Sessions are opened in-process with the API key and set up with the page\'s own session.update for that scene; at most four sessions per run.';
  const run = {
    scene, url: sc.url, at: new Date().toISOString(), max,
    clips: Object.fromEntries(clips.map((c) => [c.id, { voice: c.voice, file: c.file, sha256: c.sha256, ms: c.ms, caption: c.caption, say: c.say }])),
    sessions: [] as SessionRun[],
    verdicts: {} as Record<string, string>,
  };
  record.runs.push(run);
  mkdirSync('data/video', { recursive: true });
  const save = () => writeFileSync(GATE_FILE, `${JSON.stringify(record, null, 1)}\n`);

  const results: Record<string, boolean[]> = Object.fromEntries(clips.map((c) => [c.id, []]));
  const open = () => clips.some((c) => verdict(results[c.id]!, max) === 'open');
  while (open() && run.sessions.length < max) {
    const r = await runSession(scene, clips, opening);
    run.sessions.push(r);
    for (const h of r.heard) if (h.counted && verdict(results[h.clip]!, max) === 'open') results[h.clip]!.push(h.exact);
    for (const c of clips) run.verdicts[c.id] = verdict(results[c.id]!, max);
    save();
  }
  for (const c of clips) {
    const v = verdict(results[c.id]!, max);
    run.verdicts[c.id] = v === 'open' ? 'fail' : v;
    const ids = run.sessions.map((s) => `${s.sessionId} ${s.heard.find((h) => h.clip === c.id)?.exact ? 'exact' : 'differs'}`);
    console.log(`\n${c.id} (${c.voice}): ${run.verdicts[c.id]!.toUpperCase()} | ${ids.join(' | ')}`);
  }
  save();
  console.log(`\nwritten: ${GATE_FILE}`);
}
