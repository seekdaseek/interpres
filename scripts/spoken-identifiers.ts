/**
 * Every identifier ever spoken in a recorded e2e-audio run, against what
 * speech-to-text heard and what, if anything, reached an MCP server.
 *
 *   node scripts/spoken-identifiers.ts
 *
 * The README quotes this output; it is recounted from data/, never typed in.
 */
import { readdir, readFile } from 'node:fs/promises';
import { collapseSpelled, findIdentifiers } from '../packages/core/src/index.ts';

type Turn = { said?: string; heard?: string[]; calls?: Array<{ name: string; arguments?: Record<string, unknown>; method?: string }> };
type Session = { file: string; sessionId: string; turns: Turn[]; mcpRequests?: Array<{ tool: string; args: Record<string, unknown> }> };

function* strings(v: unknown): Generator<string> {
  if (typeof v === 'string') yield v;
  else if (Array.isArray(v)) for (const x of v) yield* strings(x);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) yield* strings(x);
}

const ids = (text: string) => findIdentifiers(collapseSpelled(text)).map((h) => h.normalized);
const short = (v: string) => (v.length > 24 ? `${v.slice(0, 12)}...${v.slice(-8)} (${v.length})` : v);

export async function spokenIdentifierRuns(dir = 'data') {
  const sessions: Session[] = [];
  for (const f of (await readdir(dir)).filter((x) => /^e2e-audio-.*\.json$/.test(x)).sort()) {
    const d = JSON.parse(await readFile(`${dir}/${f}`, 'utf8'));
    if (Array.isArray(d.results)) for (const r of d.results) sessions.push({ file: f, sessionId: r.sessionId, turns: r.turns ?? [] });
    else if (Array.isArray(d.turns)) sessions.push({ file: f, sessionId: d.sessionId, turns: d.turns, mcpRequests: d.mcpRequests });
  }
  const rows = [];
  for (const s of sessions) {
    const spoken = [...new Set(s.turns.flatMap((t) => (t.said ? ids(t.said) : [])))];
    if (spoken.length === 0) continue;
    const heard = [...new Set(s.turns.flatMap((t) => (t.heard ?? []).flatMap(ids)))];
    // What reached a server: the recorded requests when the run kept them,
    // otherwise every call the gate did not hold.
    const sent = s.mcpRequests
      ? s.mcpRequests.flatMap((m) => [...strings(m.args)].flatMap(ids))
      : s.turns.flatMap((t) => (t.calls ?? []).filter((c) => !String(c.method ?? '').startsWith('gate')).flatMap((c) => [...strings(c.arguments)].flatMap(ids)));
    for (const said of spoken) {
      rows.push({
        file: s.file, sessionId: s.sessionId, said,
        heard: heard[0] ?? null,
        exact: heard.includes(said),
        // One identifier is spoken per session, so whatever identifier was sent is its
        // outcome. Matching by prefix would miss a mishearing in the first characters.
        reachedServer: spoken.length === 1 ? (sent[0] ?? null) : null,
      });
    }
  }
  return rows;
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const rows = await spokenIdentifierRuns();
  for (const r of rows) {
    console.log(`${r.file.replace(/^e2e-audio-|\.json$/g, '').padEnd(20)} ${r.sessionId}  said ${short(r.said)}  heard ${r.heard ? short(r.heard) : '(none)'}  exact=${r.exact}  reached a server: ${r.reachedServer ? short(r.reachedServer) : 'no'}`);
  }
  const exact = rows.filter((r) => r.exact).length;
  const ranMisheard = rows.filter((r) => r.reachedServer !== null && r.reachedServer !== r.said);
  console.log(`\nspoken identifiers that came through exact: ${exact} of ${rows.length}`);
  console.log(`misheard values that reached a server: ${ranMisheard.length} (${ranMisheard.map((r) => `${r.file} ${r.sessionId}`).join('; ') || 'none'})`);
}
