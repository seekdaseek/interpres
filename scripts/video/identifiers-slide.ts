/**
 * F2c: the identifiers slide. The kit's template gets {EXACT}, {TOTAL}, {RAN}
 * and {EXACTCLIPS} from docs/IDENTIFIERS.md (scripts/spoken-identifiers.ts), and is
 * screenshotted at 1920x1080 in headless Chromium. The kit itself is not
 * touched: the filled page points back at the kit's fonts with a <base> tag.
 *
 *   node scripts/video/identifiers-slide.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { exactClipsText, identifierCount } from './config.ts';
import { IDENTIFIERS_PNG, KIT } from './edl.ts';

export async function identifiersSlide(): Promise<{ exact: number; total: number; ran: number; exactClips: string; png: string }> {
  const { exact, total, ran, exactClips: clips } = identifierCount();
  const exactClips = exactClipsText(clips);
  const template = readFileSync(`${KIT}/template/identifiers.html`, 'utf8');
  for (const k of ['{EXACT}', '{TOTAL}', '{RAN}', '{EXACTCLIPS}']) if (!template.includes(k)) throw new Error(`the template has no ${k}`);
  const filled = template
    .replaceAll('{EXACTCLIPS}', exactClips).replaceAll('{EXACT}', String(exact)).replaceAll('{TOTAL}', String(total)).replaceAll('{RAN}', String(ran))
    .replace('<head>', `<head>\n<base href="file://${KIT}/template/">`);
  if (/\{[A-Z]+\}/.test(filled)) throw new Error('a placeholder is left');
  mkdirSync('video/out', { recursive: true });
  const html = resolve('video/out/identifiers.html');
  writeFileSync(html, filled);
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(`file://${html}`);
  await page.evaluate(() => document.fonts.ready);
  const fonts = await page.evaluate(() => ['88px "Instrument Serif"', '32px "IBM Plex Sans"', '24px "JetBrains Mono"'].map((f) => [f, document.fonts.check(f)]));
  const loaded = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family} ${f.weight} ${f.style}`));
  if (fonts.some(([, ok]) => !ok) || loaded.length < 3) throw new Error(`fonts did not load: ${JSON.stringify({ fonts, loaded })}`);
  await page.screenshot({ path: IDENTIFIERS_PNG, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
  await browser.close();
  return { exact, total, ran, exactClips, png: IDENTIFIERS_PNG };
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) console.log(await identifiersSlide());
