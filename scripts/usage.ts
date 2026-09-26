/**
 * Voice Agent minutes used, from Session History, and what they cost at the
 * published $4.50/hr against the $150 hackathon credit.
 *
 *   node --env-file=.env scripts/usage.ts [--json]
 */
import { config } from '../apps/server/src/config.ts';

export const PRICE_PER_HOUR = 4.5;
export const CREDIT = 150;

type Row = { id: string; status?: string; duration_seconds?: number; created_at?: string; public_close_reason?: string };

export async function allSessions(): Promise<Row[]> {
  const out: Row[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const u = new URL(`${config.agentsApi}/sessions`);
    u.searchParams.set('limit', '200');
    if (cursor) u.searchParams.set('cursor', cursor);
    const r = await fetch(u, { headers: { authorization: `Bearer ${config.assemblyAiKey}` } });
    if (!r.ok) throw new Error(`GET /sessions -> ${r.status}`);
    const j = (await r.json()) as { sessions?: Row[]; has_more?: boolean; response_metadata?: { next_cursor?: string } };
    out.push(...(j.sessions ?? []));
    if (!j.has_more || !j.response_metadata?.next_cursor) break;
    cursor = j.response_metadata.next_cursor;
  }
  return out;
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const rows = await allSessions();
  const seconds = rows.reduce((s, r) => s + (r.duration_seconds ?? 0), 0);
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status ?? '?'] = (byStatus[r.status ?? '?'] ?? 0) + 1;
  const cost = (seconds / 3600) * PRICE_PER_HOUR;
  const first = rows.map((r) => r.created_at ?? '').filter(Boolean).sort()[0];
  const summary = {
    sessions: rows.length,
    byStatus,
    seconds: Math.round(seconds),
    minutes: Number((seconds / 60).toFixed(1)),
    costUsd: Number(cost.toFixed(2)),
    creditUsd: CREDIT,
    creditUsedPct: Number(((cost / CREDIT) * 100).toFixed(2)),
    firstSession: first,
    note: 'cost computed from the published $4.50/hr price, not read from a bill',
  };
  console.log(process.argv.includes('--json') ? JSON.stringify(summary, null, 1) : summary);
}
