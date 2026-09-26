/**
 * Read one session back from AssemblyAI's Session History: metadata, then the
 * timeline artifact (a pre-signed URL, fetched with NO Authorization header).
 *
 *   node --env-file=.env scripts/session-history.ts <session_id> [--json]
 */
import { config } from '../apps/server/src/config.ts';

export type TimelineTurn = {
  turn_id?: string;
  item_id?: string;
  status?: string;
  trigger?: string;
  user_transcript?: string | null;
  user_confidence?: number;
  agent_text?: string;
  agent_reply_started_at_ms?: number;
  agent_reply_ended_at_ms?: number;
  time_to_first_audio_ms?: number;
  tool_calls?: Array<{ call_id: string; name: string; arguments: unknown; result?: string; dispatched_at_ms?: number; result_received_at_ms?: number; duration_ms?: number; is_error?: boolean }>;
  [k: string]: unknown;
};

export type SessionRecord = {
  id: string;
  status?: string;
  duration_seconds?: number;
  created_at?: string;
  ended_at?: string;
  public_close_reason?: string;
  artifacts?: Array<{ type: string; url: string; content_type?: string }>;
  [k: string]: unknown;
};

export async function getSession(id: string): Promise<SessionRecord> {
  const r = await fetch(`${config.agentsApi}/sessions/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${config.assemblyAiKey}` },
  });
  if (!r.ok) throw new Error(`GET /sessions/${id} -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as SessionRecord;
}

export async function getTimeline(session: SessionRecord): Promise<{ started_at_unix_ms?: number; turns?: TimelineTurn[]; [k: string]: unknown } | null> {
  const art = session.artifacts?.find((a) => a.type === 'timeline');
  if (!art) return null;
  // Pre-signed: the signature authorises the request, so no key goes with it.
  const r = await fetch(art.url);
  if (!r.ok) throw new Error(`timeline artifact -> ${r.status}`);
  return (await r.json()) as { turns?: TimelineTurn[] };
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const id = process.argv[2];
  if (!id) { console.error('usage: scripts/session-history.ts <session_id> [--json]'); process.exit(2); }
  const s = await getSession(id);
  const tl = await getTimeline(s);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ session: { ...s, artifacts: s.artifacts?.map((a) => ({ type: a.type })) }, timeline: tl }, null, 1));
  } else {
    console.log(`session ${s.id}: status=${s.status} duration=${s.duration_seconds}s close=${s.public_close_reason} created=${s.created_at}`);
    console.log(`artifacts: ${(s.artifacts ?? []).map((a) => a.type).join(', ') || '(none)'}`);
    console.log(`timeline keys: ${tl ? Object.keys(tl).join(', ') : '(no timeline)'}`);
    const t0 = tl?.started_at_unix_ms ?? 0;
    for (const [i, t] of (tl?.turns ?? []).entries()) {
      const at = (ms?: number) => (ms && t0 ? `+${((ms - t0) / 1000).toFixed(1)}s` : '-');
      console.log(`\nturn ${i}: trigger=${t.trigger} status=${t.status} ttfa=${t.time_to_first_audio_ms ?? '-'}ms reply ${at(t.agent_reply_started_at_ms)}..${at(t.agent_reply_ended_at_ms)}`);
      console.log(`  user : ${JSON.stringify(t.user_transcript ?? null)}${t.user_confidence !== undefined ? ` (conf ${t.user_confidence})` : ''}`);
      console.log(`  agent: ${JSON.stringify((t.agent_text ?? '').slice(0, 160))}`);
      for (const c of t.tool_calls ?? []) console.log(`  tool : ${c.name}(${JSON.stringify(c.arguments)}) ${c.duration_ms ?? '?'}ms error=${c.is_error ?? '?'}`);
      const extra = Object.keys(t).filter((k) => !['turn_id', 'item_id', 'status', 'trigger', 'user_transcript', 'user_confidence', 'agent_text', 'agent_reply_started_at_ms', 'agent_reply_ended_at_ms', 'time_to_first_audio_ms', 'tool_calls'].includes(k));
      if (extra.length) console.log(`  other fields: ${extra.join(', ')}`);
    }
  }
}
