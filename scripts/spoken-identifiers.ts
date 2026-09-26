/**
 * Every recorded attempt to speak a wallet address, from every source in
 * data/, against what speech-to-text heard and what, if anything, reached an
 * MCP server. Writes docs/IDENTIFIERS.md; the README and JUDGE_GUIDE quote its
 * count through scripts/docs-quote.ts, never typed in.
 *
 *   node scripts/spoken-identifiers.ts
 *
 * Sources counted:
 *   data/e2e-audio-*.json          scripted sessions, spoken with macOS `say`
 *   data/qa-public-round-e.json    the round E browser QA, spoken into the page
 *                                  (what was said: data/qa-audio/clips.json)
 *   data/video/capture-*.json      the demo video's capture logs, when present
 *   data/video/rehearsals-c.json   the in-process rehearsals of the video's scene C
 * Every other file in data/ (and data/video/) that holds an address is listed
 * with the reason it is left out, so nothing is dropped silently.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { collapseSpelled, findIdentifiers } from '../packages/core/src/index.ts';

type Turn = { said?: string; heard?: string[]; calls?: Array<{ name: string; arguments?: Record<string, unknown>; method?: string }> };

export type Attempt = {
  source: string;
  sessionId: string;
  spoken: string;
  heard: string | null;
  exact: boolean;
  /** The identifier that reached an MCP server, or null when nothing ran. */
  ran: string | null;
};

function* strings(v: unknown): Generator<string> {
  if (typeof v === 'string') yield v;
  else if (Array.isArray(v)) for (const x of v) yield* strings(x);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) yield* strings(x);
}

/** Wallet-address-shaped identifiers in a text, spelled-out characters joined up first. */
const addresses = (text: string) => findIdentifiers(collapseSpelled(text)).map((h) => h.normalized).filter((n) => /^0x[0-9a-f]{8,}$/i.test(n) || /^0x0+/i.test(n));
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

/** The e2e-audio runs: one address spoken per session. */
function fromE2eAudio(dir: string, file: string): Attempt[] {
  const d = json(`${dir}/${file}`);
  const sessions: Array<{ sessionId: string; turns: Turn[]; mcpRequests?: Array<{ args: Record<string, unknown> }> }> = [];
  if (Array.isArray(d.results)) for (const r of d.results) sessions.push({ sessionId: r.sessionId, turns: r.turns ?? [] });
  else if (Array.isArray(d.turns)) sessions.push({ sessionId: d.sessionId, turns: d.turns, mcpRequests: d.mcpRequests });
  const out: Attempt[] = [];
  for (const s of sessions) {
    const spoken = [...new Set(s.turns.flatMap((t) => (t.said ? addresses(t.said) : [])))];
    if (spoken.length === 0) continue;
    const heard = [...new Set(s.turns.flatMap((t) => (t.heard ?? []).flatMap(addresses)))];
    // What reached a server: the recorded requests when the run kept them,
    // otherwise every call the gate did not hold.
    const sent = s.mcpRequests
      ? s.mcpRequests.flatMap((m) => [...strings(m.args)].flatMap(addresses))
      : s.turns.flatMap((t) => (t.calls ?? []).filter((c) => !String(c.method ?? '').startsWith('gate')).flatMap((c) => [...strings(c.arguments)].flatMap(addresses)));
    for (const said of spoken) {
      out.push({
        source: file, sessionId: s.sessionId, spoken: said, heard: heard[0] ?? null, exact: heard.includes(said),
        // One address is spoken per session, so whatever address was sent is its outcome.
        ran: spoken.length === 1 ? (sent[0] ?? null) : null,
      });
    }
  }
  return out;
}

/**
 * The round E browser QA: row 5's spoken address, desktop and 375 px. What was
 * said is the clip's text; what was heard and whether a call followed are in
 * the QA record; the sessions are named there by row.
 */
function fromQaRoundE(dir: string): Attempt[] {
  const qa = json(`${dir}/qa-public-round-e.json`);
  const clip = json(`${dir}/qa-audio/clips.json`).clips['afg-spoken-address'] as string;
  const said = addresses(clip)[0]!;
  const row5 = (qa.rows as Array<Record<string, any>>).find((r) => r.row === 5)!;
  const sessionFor = (label: RegExp) => Object.entries(qa.sessions as Record<string, { row: string }>).find(([, v]) => label.test(String(v.row)))?.[0];
  const views: Array<[string, RegExp]> = [['desktop', /^5 and 6 idle, desktop$/], ['mobile375', /^5, 375 px$/]];
  return views.map(([view, label]) => {
    const sa = row5[view].spokenAddress;
    const sessionId = sessionFor(label);
    if (!sa || !sessionId) throw new Error(`qa-public-round-e.json: no spoken address or session for ${view}`);
    const heard = addresses(String(sa.heard))[0] ?? null;
    return { source: `qa-public-round-e.json (${view})`, sessionId, spoken: said, heard, exact: heard === said, ran: sa.mcpCallsAfter === 0 ? null : 'a call ran' };
  });
}

/** The demo video's capture logs: each records its spoken-address take, if it has one. */
function fromVideo(dir: string): Attempt[] {
  const vdir = `${dir}/video`;
  if (!existsSync(vdir)) return [];
  const out: Attempt[] = [];
  for (const f of readdirSync(vdir).filter((x) => /^capture-.*\.json$/.test(x)).sort()) {
    const d = json(`${vdir}/${f}`);
    for (const a of (d.spokenAddresses ?? []) as Array<{ sessionId: string; said: string; heard: string; mcpCalls: Array<{ arguments?: unknown }> }>) {
      const said = addresses(a.said)[0];
      if (!said) continue;
      const heard = addresses(a.heard ?? '')[0] ?? null;
      const sent = a.mcpCalls.flatMap((c) => [...strings(c.arguments)].flatMap(addresses));
      out.push({ source: `video/${f}`, sessionId: a.sessionId, spoken: said, heard, exact: heard === said, ran: sent[0] ?? null });
    }
  }
  return out;
}

/** The in-process rehearsals of scene C: one spoken address per run. */
function fromRehearsals(dir: string): Attempt[] {
  const f = `${dir}/video/rehearsals-c.json`;
  if (!existsSync(f)) return [];
  const d = json(f) as { otherAddressText: string; runs: Array<{ variant: string; sessionId: string; turns: Array<{ id: string; heard: string }>; c3?: { clip?: string; mcpRequestsAfterQ5?: Array<{ args?: unknown }> } }> };
  const q5 = (json(`${dir}/video/voices.json`) as { lines: Record<string, { text: string }> }).lines.Q5!.text;
  return d.runs.map((r) => {
    const clip = r.c3?.clip ?? 'Q5';
    const said = addresses(clip === 'Q5b' ? d.otherAddressText : q5)[0]!;
    const heard = addresses(r.turns.find((t) => t.id === clip)?.heard ?? '')[0] ?? null;
    const sent = (r.c3?.mcpRequestsAfterQ5 ?? []).flatMap((c) => [...strings(c.args)].flatMap(addresses));
    return { source: `video/rehearsals-c.json (${r.variant})`, sessionId: r.sessionId, spoken: said, heard, exact: heard === said, ran: sent[0] ?? null };
  });
}

/** Why a file that holds an address is not counted as a spoken attempt. */
function leftOutReason(file: string): string | null {
  if (/^e2e-audio-gate-paste/.test(file)) return 'the address was pasted, not spoken';
  if (/^e2e-checkpoint-a\.json$|^e2e-\d{4}-/.test(file)) return 'text injected with conversation.message (scripts/e2e.ts), not speech';
  if (/^sweep-/.test(file)) return 'an address inside a registry server description; nothing was spoken';
  if (/^qa-audio\//.test(file)) return 'the clip texts themselves, counted through the QA record';
  if (file === 'video/caller-gate.json') return 'the F2a hearing gate: its only address was pasted for Q4, not spoken';
  if (file === 'video/voices.json') return 'the caller clip texts themselves; the sessions that spoke them are counted';
  if (/^video\/transcripts\//.test(file)) return 'a capture stem transcript; that take is counted from its capture log';
  return null;
}

export function recount(dir = 'data') {
  const attempts: Attempt[] = [];
  const counted = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => /^e2e-audio-.*\.json$/.test(x)).sort()) {
    const a = fromE2eAudio(dir, f);
    if (a.length > 0) counted.add(f);
    attempts.push(...a);
  }
  const qa = fromQaRoundE(dir);
  counted.add('qa-public-round-e.json');
  attempts.push(...qa);
  const video = fromVideo(dir);
  for (const v of video) counted.add(v.source);
  attempts.push(...video);
  const rehearsals = fromRehearsals(dir);
  counted.add('video/rehearsals-c.json');
  attempts.push(...rehearsals);

  // Every other file in data/ that holds a wallet address anywhere.
  const leftOut: Array<{ file: string; reason: string }> = [];
  const sub = (d: string) => (existsSync(`${dir}/${d}`) ? readdirSync(`${dir}/${d}`).filter((f) => f.endsWith('.json')).map((f) => `${d}/${f}`) : []);
  const files = [...readdirSync(dir).filter((f) => /\.(json|jsonl)$/.test(f)), ...sub('qa-audio'), ...sub('video'), ...sub('video/transcripts')].sort();
  for (const f of files) {
    if (counted.has(f)) continue;
    let text = readFileSync(`${dir}/${f}`, 'utf8');
    if (text.length > 30_000_000) continue;
    const docs = f.endsWith('.jsonl') ? text.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [JSON.parse(text)];
    text = '';
    const has = docs.some((d) => [...strings(d)].some((s) => s.length < 4000 && addresses(s).some((a) => a.length >= 20)));
    if (!has) continue;
    leftOut.push({ file: f, reason: leftOutReason(f) ?? 'UNCLASSIFIED: look at this file' });
  }
  const exact = attempts.filter((a) => a.exact).length;
  return { attempts, exact, total: attempts.length, leftOut };
}

const short = (v: string) => (v.length > 24 ? `\`${v.slice(0, 10)}…${v.slice(-6)}\` (${v.length})` : `\`${v}\``);

export function report(r = recount()): string {
  const rows = r.attempts.map((a) =>
    `| ${a.source} | \`${a.sessionId}\` | ${short(a.spoken)} | ${a.heard ? short(a.heard) : '(nothing)'} | ${a.exact ? 'yes' : 'no'} | ${a.ran === null ? 'nothing ran' : a.ran === a.spoken ? `ran with the spoken value` : a.ran === 'a call ran' ? 'a call ran' : `ran with ${short(a.ran)}`} |`);
  const misheardRan = r.attempts.filter((a) => !a.exact && a.ran !== null).length;
  return [
    '# Spoken wallet addresses',
    '',
    `Every recorded attempt to speak a wallet address, from every source in \`data/\`, recounted by \`scripts/spoken-identifiers.ts\`. "Ran" is whether the address reached an MCP server: a misheard value ran in ${misheardRan} of them, all from before the gate held spoken identifiers (decision D4).`,
    '',
    `Exact: ${r.exact} of ${r.total}.`,
    '',
    `Misheard and reached a server: ${misheardRan}.`,
    '',
    '| source | session | spoken | heard | exact | ran |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## Files in data/ that hold an address but are not counted',
    '',
    '| file | why |',
    '| --- | --- |',
    ...r.leftOut.map((l) => `| \`${l.file}\` | ${l.reason} |`),
    '',
  ].join('\n');
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const r = recount();
  const md = report(r);
  writeFileSync('docs/IDENTIFIERS.md', md);
  console.log(md);
  if (r.leftOut.some((l) => l.reason.startsWith('UNCLASSIFIED'))) {
    console.error('an address-holding file is unclassified: decide whether it counts');
    process.exit(1);
  }
}
