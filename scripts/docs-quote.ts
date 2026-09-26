/**
 * Copies measured figures into README.md and JUDGE_GUIDE.md verbatim, so no
 * number is ever retyped. Each block sits between markers like
 *
 *   <!-- quote:sweep-headline -->  ...  <!-- /quote:sweep-headline -->
 *
 * and is replaced by the table under a heading of a generated page:
 *   sweep-headline      docs/SWEEP.md, "## Headline"
 *   voice-sweep-counts  docs/VOICE-SWEEP.md, "## Counts"
 *   proof-summary       docs/PROOF.md, the table at the top
 *   refine-ab           docs/REFINE.md, the table at the top
 *   gateway-models      docs/GATEWAY.md, the table at the top
 *
 *   node scripts/docs-quote.ts
 */
import { readFile, writeFile } from 'node:fs/promises';

/** The first Markdown table after `heading` (or at the top when heading is null), verbatim. */
export function tableAfter(page: string, heading: string | null): string {
  const lines = page.split('\n');
  let i = heading === null ? 0 : lines.findIndex((l) => l.trim() === heading);
  if (i < 0) throw new Error(`heading not found: ${heading}`);
  while (i < lines.length && !lines[i]!.startsWith('|')) i++;
  const out: string[] = [];
  while (i < lines.length && lines[i]!.startsWith('|')) out.push(lines[i++]!);
  if (out.length === 0) throw new Error(`no table after ${heading ?? 'the top'}`);
  return out.join('\n');
}

/**
 * Put `block` between the named markers. A function replacer, because the
 * tables hold "$4.50" and "$0.60", which a replacement string would read as
 * group references.
 */
export function fill(doc: string, name: string, block: string): string {
  const re = new RegExp(`(<!-- quote:${name} -->)[\\s\\S]*?(<!-- /quote:${name} -->)`);
  return doc.replace(re, (_m, open: string, close: string) => `${open}\n${block}\n${close}`);
}

async function main(): Promise<void> {
  const blocks: Record<string, string> = {
    'sweep-headline': tableAfter(await readFile('docs/SWEEP.md', 'utf8'), '## Headline'),
    'voice-sweep-counts': tableAfter(await readFile('docs/VOICE-SWEEP.md', 'utf8'), '## Counts'),
    'proof-summary': tableAfter(await readFile('docs/PROOF.md', 'utf8'), null),
    'refine-ab': tableAfter(await readFile('docs/REFINE.md', 'utf8'), null),
    'gateway-models': tableAfter(await readFile('docs/GATEWAY.md', 'utf8'), null),
  };
  for (const file of ['README.md', 'JUDGE_GUIDE.md']) {
    let doc = await readFile(file, 'utf8');
    const filled: string[] = [];
    for (const [name, block] of Object.entries(blocks)) {
      if (!doc.includes(`<!-- quote:${name} -->`)) continue;
      doc = fill(doc, name, block);
      // Checked, not assumed: the block must now sit between the markers.
      if (!doc.includes(`<!-- quote:${name} -->\n${block}\n<!-- /quote:${name} -->`)) throw new Error(`${file}: ${name} did not fill`);
      filled.push(`${name} (${block.split('\n').length} lines)`);
    }
    await writeFile(file, doc);
    console.log(`${file}: ${filled.join(', ') || 'no markers'}`);
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) await main();
