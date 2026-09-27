/**
 * One command from the saved captures to the finished video, its checks and
 * docs/VIDEO.md (brief F, F2.6 and F2.8):
 *   1. the identifiers slide from the kit template and docs/IDENTIFIERS.md;
 *   2. the edit list (data/video/edl.json);
 *   3. the render, with its SubRip captions;
 *   4. the checks of F2.7 on the rendered file (data/video/final-checks.json);
 *   5. the outputs on the Desktop, key frames included;
 *   6. docs/VIDEO.md.
 *
 *   node --env-file=.env scripts/video/build.ts [--no-desktop] [--skip-render] [--reuse-transcript]
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { identifiersSlide } from './identifiers-slide.ts';
import { build as buildEdl } from './edl.ts';
import type { Edl } from './edl.ts';
import { render, srt } from './render.ts';
import { black, contactSheet, finalLimits, keyFrame, loud, narrationCheck, probe, silences, transcript } from './checks.ts';
import { videoDoc } from './video-doc.ts';

const DESKTOP = '/Users/ochinimus/Desktop';
const OUT = 'video/out/interpres-demo.mp4';
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** The five moments brief F asks to see full size, taken 1.5 s into their punch-ins. */
export function keyMoments(edl: Edl): Array<{ name: string; at: number }> {
  const punch = (re: RegExp) => { const p = edl.punchIns.find((x) => re.test(x.reason)); if (!p) throw new Error(`no punch-in for ${re}`); return p.start + 1500; };
  const registry = edl.shots.find((s) => s.name === 'registry');
  if (!registry) throw new Error('no registry slide');
  return [
    { name: '1-found', at: punch(/Found in the official MCP registry/) },
    { name: '2-scene-a-tool-call', at: punch(/goji_explain_term/) },
    { name: '3-swap-card', at: punch(/find_tools and the swap/) },
    { name: '4-needs-paste', at: punch(/needs_paste/) },
    { name: '5-registry-slide', at: (registry.start + registry.end) / 2 },
  ];
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  console.log('1. identifiers slide:', await identifiersSlide());
  const edl = buildEdl();
  writeFileSync('data/video/edl.json', JSON.stringify(edl, null, 1));
  const failed = edl.checks.filter((c) => !c.ok);
  console.log(`2. edit list: ${(edl.durationMs / 1000).toFixed(1)} s, ${edl.shots.length} shots, ${edl.cuts.length} cuts; ${failed.length} failed checks`);
  if (failed.length) { for (const c of failed) console.error(`   FAIL ${c.check}: ${c.detail}`); process.exit(1); }
  // --skip-render: the file on disk was rendered from this same edit list (it is rebuilt
  // deterministically; the saved one must match it byte for byte).
  if (process.argv.includes('--skip-render')) {
    const saved = readFileSync('video/out/edl.json', 'utf8');
    if (JSON.stringify(JSON.parse(saved)) !== JSON.stringify(edl)) { console.error('the rendered file came from a different edit list: render again'); process.exit(1); }
    console.log(`3. render skipped: ${OUT} (from the same edit list)`);
  } else {
    const r = await render(edl, OUT);
    writeFileSync('video/out/edl.json', JSON.stringify(edl, null, 1));
    console.log(`3. rendered ${r.frames} frames: ${OUT}`);
  }
  writeFileSync(OUT.replace(/\.mp4$/, '.srt'), srt(edl));
  const results = [...probe(OUT), ...finalLimits(OUT), ...loud(OUT)];
  const b = black(OUT, edl);
  results.push(b.result);
  const sil = silences(OUT, edl);
  // --reuse-transcript: when the file is byte for byte the one last checked, its transcript is
  // fetched again by id rather than made anew, so a changed rule is judged on the same words.
  const last = existsSync('data/video/final-checks.json') ? JSON.parse(readFileSync('data/video/final-checks.json', 'utf8')) as { sha256?: string; transcript?: { id: string } } : null;
  const reuse = process.argv.includes('--reuse-transcript') && last?.sha256 === sha(OUT) ? last.transcript?.id : undefined;
  if (process.argv.includes('--reuse-transcript')) console.log(reuse ? `   transcript ${reuse} reused (same file)` : '   transcript not reused: the file changed');
  const tr = await transcript(OUT, OUT.replace(/\.mp4$/, '-transcript.txt'), reuse);
  results.push(...narrationCheck(edl, tr.words));
  await contactSheet(OUT, OUT.replace(/\.mp4$/, '-contact.png'), edl.durationMs);
  const checks = { file: OUT, sha256: sha(OUT), results, black: b.spans, silences: sil, transcript: { id: tr.id, speechModel: tr.speechModel } };
  writeFileSync('data/video/final-checks.json', `${JSON.stringify(checks, null, 1)}\n`);
  for (const x of results) console.log(`   ${x.ok ? 'ok  ' : 'FAIL'} ${x.check}: ${x.detail}`);
  console.log('4. checks: data/video/final-checks.json');
  if (!process.argv.includes('--no-desktop')) {
    const frames = `${DESKTOP}/interpres-demo-frames`;
    rmSync(frames, { recursive: true, force: true });
    mkdirSync(frames, { recursive: true });
    for (const k of keyMoments(edl)) keyFrame(OUT, k.at, `${frames}/${k.name}.png`);
    for (const [from, to] of [[OUT, 'interpres-demo.mp4'], [OUT.replace(/\.mp4$/, '.srt'), 'interpres-demo.srt'], [OUT.replace(/\.mp4$/, '-transcript.txt'), 'interpres-demo-transcript.txt'], [OUT.replace(/\.mp4$/, '-contact.png'), 'interpres-demo-contact.png']] as const) {
      copyFileSync(from, `${DESKTOP}/${to}`);
    }
    console.log(`5. Desktop: interpres-demo.mp4, .srt, -transcript.txt, -contact.png, interpres-demo-frames/ (${keyMoments(edl).length} frames)`);
  }
  writeFileSync('docs/VIDEO.md', `${await videoDoc()}\n`);
  console.log('6. docs/VIDEO.md');
}
