/**
 * Renders docs/SWEEP.md and docs/sweep-servers.csv from a sweep and, when given,
 * its stability recheck (`--recheck-classes ok`) and a re-measure of its
 * failures (`--recheck-classes auth_required,unreachable,protocol_error`).
 *
 *   node scripts/sweep-report.ts <sweep> [--recheck <file>] [--reclassify <file>]
 *
 * Every number is counted from those files. Nothing is typed in by hand.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { readSweep, totals } from './sweep.ts';
import type { ServerResult } from './sweep.ts';
import { PRESETS } from '../apps/server/src/presets.ts';

type Meta = {
  startedAt: string; finishedAt: string; seconds: number; userAgent: string;
  concurrency: number; perHost: number; timeoutMs: number;
  recheckOf: string | null; minGapMinutes: number | null;
  registry: { entries: number; uniqueServers: number; withRemotes: number };
  distinctHosts: number; method: string;
};

const FAILURES = ['auth_required', 'unreachable', 'protocol_error'] as const;

const fmt = (n: number) => n.toLocaleString('en-US');
const pct = (n: number, d: number) => (d > 0 ? `${((100 * n) / d).toFixed(1)}%` : '-');
const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const csvCell = (s: unknown) => {
  const v = String(s ?? '');
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};
const norm = (u: string) => u.replace(/\/+$/, '').toLowerCase();

export function hostOf(r: ServerResult): string {
  try {
    return new URL(r.url ?? r.remotes[0]!.url).host;
  } catch {
    return '?';
  }
}

export function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function countBy<T>(list: T[], key: (t: T) => string): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const t of list) m.set(key(t), (m.get(key(t)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** `align` is one letter per column: l or r. */
function table(head: string[], rows: Array<Array<string | number>>, align = 'l' + 'r'.repeat(head.length - 1)): string {
  const rule = head.map((_, i) => (align[i] === 'r' ? '---:' : '---'));
  return [`| ${head.join(' | ')} |`, `| ${rule.join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

/** Per reason: how many servers, on how many hosts, and the host with the most. */
export function reasonHosts(servers: ServerResult[], top = 6): Array<Array<string | number>> {
  return countBy(servers, (r) => r.reason).slice(0, top).map(([reason, n]) => {
    const hosts = countBy(servers.filter((r) => r.reason === reason), hostOf);
    const [h, k] = hosts[0]!;
    return [reason, fmt(n), fmt(hosts.length), `${h} (${fmt(k)})`];
  });
}

/** Servers of a first pass matched to a later probe of the same registry name. */
export function follow(first: ServerResult[], later: ServerResult[] | null) {
  const byName = new Map((later ?? []).map((r) => [r.name, r]));
  const outcome: Record<string, number> = {};
  const gaps: number[] = [];
  for (const r of first) {
    const again = byName.get(r.name);
    const k = again ? again.class : 'not rechecked';
    outcome[k] = (outcome[k] ?? 0) + 1;
    if (again) gaps.push((Date.parse(again.probedAt) - Date.parse(r.probedAt)) / 60_000);
  }
  return { outcome, gaps, byName };
}

function parseArgs(argv: string[]): { sweep?: string; recheck?: string; reclassify?: string } {
  const a: { sweep?: string; recheck?: string; reclassify?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === '--recheck') a.recheck = argv[++i];
    else if (k === '--reclassify') a.reclassify = argv[++i];
    else if (!k.startsWith('--')) a.sweep = k;
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sweep) {
    console.error('usage: node scripts/sweep-report.ts <sweep> [--recheck <file>] [--reclassify <file>]');
    process.exit(2);
  }
  const A = await readSweep(args.sweep);
  const B = args.recheck ? await readSweep(args.recheck) : null;
  const C = args.reclassify ? await readSweep(args.reclassify) : null;
  const am = A.sweep as unknown as Meta;
  const bm = B ? (B.sweep as unknown as Meta) : null;
  const cm = C ? (C.sweep as unknown as Meta) : null;
  const all = A.servers;
  const T = totals(all);
  const ok = all.filter((r) => r.class === 'ok');
  const failed = all.filter((r) => r.class !== 'ok');
  const okWithTools = ok.filter((r) => (r.toolCount ?? 0) > 0);
  const st = follow(ok, B?.servers ?? null);
  const re = follow(failed, C?.servers ?? null);
  /**
   * A failed server's class as re-measured, when there is a re-measure. One that
   * answered only then is `ok_later`, so every `ok` column agrees with the headline.
   */
  const finalClass = (r: ServerResult): string => {
    if (r.class === 'ok' || !C) return r.class;
    const k = re.byName.get(r.name)?.class ?? r.class;
    return k === 'ok' ? 'ok_later' : k;
  };
  const c = T.ok.conversion;
  const okHosts = countBy(ok, hostOf);
  // Hosts that answered the recheck with 50+ 429s were rate-limiting this sweep,
  // not failing, so stability is also given without them.
  const dropped = (B?.servers ?? []).filter((r) => r.class !== 'ok');
  const limited = countBy(dropped.filter((r) => r.reason === 'http_429'), hostOf).filter(([, n]) => n >= 50).map(([h]) => h);
  const unlimited = ok.filter((r) => !limited.includes(hostOf(r)));
  const heldUnlimited = unlimited.filter((r) => st.byName.get(r.name)?.class === 'ok').length;

  const md: string[] = [];
  md.push('# Sweep of the official MCP registry', '');
  md.push(`Measured by \`scripts/sweep.ts\` from ${am.startedAt} to ${am.finishedAt} (${fmt(am.seconds)} s).`);
  if (bm) md.push(`Every server that answered was probed again by \`--recheck\`, each at least ${bm.minGapMinutes} minutes after its first probe (${bm.startedAt} to ${bm.finishedAt}).`);
  if (cm) md.push(`Every server that failed was probed again with the corrected error classifier (${cm.startedAt} to ${cm.finishedAt}); see [Outcome by class](#outcome-by-class).`);
  md.push('');
  md.push(`Method: ${am.method}. User-Agent \`${am.userAgent}\`; concurrency ${am.concurrency}, at most ${am.perHost} at once per host, ${am.timeoutMs / 1000} s timeout.`);
  md.push('No credential was sent to any server, so `ok` means the server completed `initialize` and listed its tools **without auth**. Calling a tool can still need a key: listing proves the catalog, not every call.', '');

  md.push('## Headline', '');
  const headline: Array<[string, string]> = [
    ['Registry entries (every version)', fmt(am.registry.entries)],
    ['Unique servers (latest version each)', fmt(am.registry.uniqueServers)],
    ['With a streamable-http or sse remote: probed', fmt(am.registry.withRemotes)],
    ['Distinct hosts probed', fmt(am.distinctHosts)],
    ['`ok`: listed its tools without auth', `${fmt(ok.length)} (${pct(ok.length, all.length)})`],
    ['... on distinct hosts', fmt(okHosts.length)],
    ['`ok` with at least one tool', fmt(okWithTools.length)],
    ['`ok` with more than 10 tools (find_tools engages)', `${fmt(T.ok.serversOverTenTools)} (${pct(T.ok.serversOverTenTools, ok.length)})`],
    ['Tools per `ok` server: median / 90th percentile / max', (() => {
      const n = ok.map((r) => r.toolCount ?? 0).sort((x, y) => x - y);
      return `${fmt(median(n))} / ${fmt(n[Math.floor(0.9 * (n.length - 1))] ?? 0)} / ${fmt(n[n.length - 1] ?? 0)}`;
    })()],
    ['`ok` by transport', countBy(ok, (r) => r.transport ?? '?').map(([k, n]) => `${k} ${fmt(n)}`).join(', ')],
    ['Tools listed by `ok` servers', fmt(c.toolsIn)],
    ['Tools converted to Voice Agent function tools', `${fmt(c.toolsConverted)} (${pct(c.toolsConverted, c.toolsIn)})`],
    ['Converted tools carrying spoken-format hints', `${fmt(c.convertedWithHints)} (${pct(c.convertedWithHints, c.toolsConverted)})`],
  ];
  if (B) headline.push(['`ok` again at the recheck', `${fmt(st.outcome.ok ?? 0)} of ${fmt(ok.length)} (${pct(st.outcome.ok ?? 0, ok.length)})${limited.length ? `; ${pct(heldUnlimited, unlimited.length)} without the host that rate-limited the sweep` : ''}`]);
  md.push(table(['', 'count'], headline), '');

  md.push('## Outcome by class', '');
  if (C) {
    md.push('The first pass classified failures with a bug: the MCP SDK puts the HTTP status on the error object and only the response body in the message, and the classifier then read bare numbers out of that body - `font-weight: 500` in a challenge page counted as a 5xx. The status is now kept and decides first; after it only explicit words do. Every failed server was probed again with the fix, and the failure split below is that re-measure. The `ok` count is unaffected: it never went through the classifier.', '');
    md.push(table(['class', 'first pass', 're-measured'], [
      ['`ok`', fmt(ok.length), fmt(ok.length)],
      ...FAILURES.map((k) => [`\`${k}\``, fmt(T.byClass[k] ?? 0), fmt(re.outcome[k] ?? 0)] as Array<string | number>),
      ['`ok` when re-measured (failed the first time)', '-', fmt(re.outcome.ok ?? 0)],
      ['total', fmt(all.length), fmt(ok.length + Object.values(re.outcome).reduce((n, k) => n + k, 0))],
    ]), '');
    const cFailed = (C.servers ?? []).filter((r) => r.class !== 'ok');
    const reasons = totals(cFailed).byReason;
    md.push('Reasons within each class at the re-measure, as recorded by the probe:', '');
    for (const cls of FAILURES) {
      const rows = Object.entries(reasons[cls] ?? {}).sort((x, y) => y[1] - x[1]);
      md.push(`**${cls}**: ${rows.map(([r, n]) => `${r} ${fmt(n)}`).join(', ') || 'none'}`, '');
    }
    md.push('The largest reasons, and whether one host is behind them. A 429 is a host rate-limiting this sweep, not a broken server.', '');
    md.push(table(['reason', 'servers', 'hosts', 'top host'], reasonHosts(cFailed), 'lrrl'), '');
  } else {
    md.push(table(['class', 'servers', 'share'], Object.entries(T.byClass).sort((x, y) => y[1] - x[1]).map(([k, n]) => [`\`${k}\``, fmt(n), pct(n, all.length)])), '');
    for (const [cls, reasons] of Object.entries(T.byReason).sort()) {
      if (cls === 'ok') continue;
      const rows = Object.entries(reasons).sort((x, y) => y[1] - x[1]);
      md.push(`**${cls}**: ${rows.map(([r, n]) => `${r} ${fmt(n)}`).join(', ')}`, '');
    }
  }

  md.push('## Conversion', '');
  md.push('Counted over the tools of every `ok` server.', '');
  md.push(table(['converter counter', 'tools'], [
    ['listed', fmt(c.toolsIn)],
    ['converted', fmt(c.toolsConverted)],
    ['converted with hints', fmt(c.convertedWithHints)],
    ['names sanitised', fmt(c.namesSanitised)],
    ['descriptions synthesised', fmt(c.descriptionsSynthesised)],
    ['descriptions truncated', fmt(c.descriptionsTruncated)],
    ['patterns kept', fmt(c.patternsKept)],
    ['patterns dropped', fmt(c.patternsDropped)],
    ['$refs resolved', fmt(c.refsResolved)],
    ['allOf flattened', fmt(c.allOfFlattened)],
    ['unions collapsed', fmt(c.unionsCollapsed)],
    ['nullable unwrapped', fmt(c.nullableUnwrapped)],
    ['failed', fmt(c.failed)],
  ]), '');
  const fails = Object.entries(T.ok.conversionFailuresByReason).sort((x, y) => y[1] - x[1]);
  md.push(fails.length ? `Failures by reason: ${fails.map(([r, n]) => `${r} ${fmt(n)}`).join(', ')}.` : 'No tool failed to convert.', '');

  md.push('## Tool annotations', '');
  md.push(table(['', 'count'], [
    ['Tools with `readOnlyHint: true`', fmt(T.ok.toolsWithReadOnlyHint)],
    ['Tools with `destructiveHint: true`', fmt(T.ok.toolsWithDestructiveHint)],
    ['`ok` servers with at least one of the two', `${fmt(T.ok.serversWithAnyAnnotation)} of ${fmt(ok.length)}`],
  ]), '');

  md.push('## Declared auth against measured', '');
  md.push(`A registry entry "declares auth" when one of its remotes lists a required or secret header.${C ? ' Failures use the re-measured class.' : ''}`, '');
  const cols = C ? ['ok', ...FAILURES, 'ok_later'] : ['ok', ...FAILURES];
  const declared = all.filter((r) => r.declaresAuth);
  const undeclared = all.filter((r) => !r.declaresAuth);
  md.push(table(['declares auth', 'servers', ...cols.map((k) => (k === 'ok_later' ? '`ok` only when re-measured' : `\`${k}\``))], [
    ['yes', fmt(declared.length), ...cols.map((k) => fmt(declared.filter((r) => finalClass(r) === k).length))],
    ['no', fmt(undeclared.length), ...cols.map((k) => fmt(undeclared.filter((r) => finalClass(r) === k).length))],
  ]), '');
  md.push(`${fmt(undeclared.filter((r) => finalClass(r) === 'auth_required').length)} servers answered with an auth wall that their registry entry does not declare, and ${fmt(declared.filter((r) => r.class === 'ok').length)} that declare one listed their tools without it.`, '');

  md.push('## Host concentration', '');
  md.push('A few hosts publish many registry entries. These counts keep the headline honest.', '');
  md.push(table(['host', 'probed', '`ok`'], countBy(all, hostOf).slice(0, 10).map(([h, n]) => [h, fmt(n), fmt(okHosts.find(([x]) => x === h)?.[1] ?? 0)]), 'lrr'), '');
  const top3 = okHosts.slice(0, 3).reduce((n, [, k]) => n + k, 0);
  md.push(`The three hosts with the most \`ok\` servers hold ${fmt(top3)} of the ${fmt(ok.length)} (${pct(top3, ok.length)}). \`ok\` servers sit on ${fmt(okHosts.length)} distinct hosts.`, '');

  if (B) {
    md.push('## Stability', '');
    md.push(`Each \`ok\` server was probed again ${fmt(Math.round(Math.min(...st.gaps)))}-${fmt(Math.round(Math.max(...st.gaps)))} minutes after its first probe (median ${fmt(Math.round(median(st.gaps)))}).`, '');
    md.push(table(['at the recheck', 'servers', 'share'], Object.entries(st.outcome).sort((x, y) => y[1] - x[1]).map(([k, n]) => [`\`${k}\``, fmt(n), pct(n, ok.length)])), '');
    if (limited.length) md.push(`Without ${limited.map((h) => `\`${h}\``).join(', ')}, which answered the recheck with 429 - rate-limiting this sweep, not failing - ${fmt(heldUnlimited)} of ${fmt(unlimited.length)} held (${pct(heldUnlimited, unlimited.length)}).`, '');
    if (dropped.length > 0) {
      md.push('Why the ones that dropped did, and whether one host is behind it:', '');
      md.push(table(['reason', 'servers', 'hosts', 'top host'], reasonHosts(dropped), 'lrrl'), '');
    }
  }

  md.push('## Presets', '');
  md.push('The demo presets, looked up in these sweeps by URL. Presets added from the sweep had to be `ok` in both passes, declare no auth, and answer their suggested questions spoken through `scripts/e2e-audio.ts`.', '');
  md.push(table(['preset', 'url', 'first pass', 'recheck', 'tools'], PRESETS.map((p) => {
    const hit = all.find((r) => [r.url, ...r.remotes.map((x) => x.url)].some((u) => u && norm(u) === norm(p.url)));
    const again = hit ? st.byName.get(hit.name) : undefined;
    return [p.label, p.url, hit ? hit.class : 'not in the registry', again ? again.class : hit && B ? 'not rechecked' : '-', hit?.toolCount ?? '-'];
  }), 'llllr'), '');

  md.push('## Per-server table', '');
  md.push(`[\`docs/sweep-servers.csv\`](sweep-servers.csv) holds one row per probed server, all ${fmt(all.length)} of them: class and reason from the first pass, the recheck class for \`ok\` servers, the re-measured class for failures, tool counts, conversion and annotation counts. At ${fmt(okWithTools.length)} \`ok\` servers alone, a Markdown table here would be too large to read.`, '');

  md.push('## Reproduce', '');
  md.push('```');
  md.push('node scripts/sweep.ts                                  # first pass');
  md.push('node scripts/sweep.ts --recheck <first pass>           # each ok server again, >= 60 min later');
  md.push('node scripts/sweep.ts --recheck <first pass> --recheck-classes auth_required,unreachable,protocol_error --min-gap-minutes 0');
  md.push('node scripts/sweep-report.ts <first pass> --recheck <recheck> --reclassify <re-measure>');
  md.push('```', '');
  const inputs = [args.sweep, args.recheck, args.reclassify].filter((x): x is string => x !== undefined);
  md.push(`This page was rendered from ${inputs.map((f) => `\`${f.replace(/^.*\//, '')}\``).join(', ')}. The gzipped summaries in \`data/\` are enough to render it again. The raw catalogs (every \`tools/list\`, tens of MB) stay out of git.`, '');

  const csv = [['name', 'class', 'reason', 'host', 'transport', 'tools', 'converted', 'with_hints', 'read_only_hint', 'destructive_hint', 'declares_auth', 'probed_at', 'recheck_class', 'recheck_probed_at', 'remeasured_class', 'remeasured_reason']];
  for (const r of all) {
    const again = r.class === 'ok' ? st.byName.get(r.name) : undefined;
    const rem = r.class !== 'ok' ? re.byName.get(r.name) : undefined;
    csv.push([r.name, r.class, r.reason, hostOf(r), r.transport ?? '', String(r.toolCount ?? ''), String(r.conversion?.toolsConverted ?? ''),
      String(r.conversion?.convertedWithHints ?? ''), String(r.readOnlyHint ?? ''), String(r.destructiveHint ?? ''), String(r.declaresAuth), r.probedAt,
      again?.class ?? (B && r.class === 'ok' ? 'not rechecked' : ''), again?.probedAt ?? '',
      rem?.class ?? (C && r.class !== 'ok' ? 'not rechecked' : ''), rem?.reason ?? '']);
  }

  await mkdir('docs', { recursive: true });
  await writeFile('docs/SWEEP.md', `${md.join('\n')}\n`);
  await writeFile('docs/sweep-servers.csv', `${csv.map((r) => r.map(csvCell).join(',')).join('\n')}\n`);
  console.log(`docs/SWEEP.md (${md.join('\n').length} chars); docs/sweep-servers.csv: ${all.length} servers`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) await main();
