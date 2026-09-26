/**
 * Word timings for the captions, from AssemblyAI (the account's default model;
 * each result names it):
 * - narration: every narration clip as used, into data/video/narration-words.json;
 * - a capture: its caller and agent stems, into data/video/transcripts/.
 * Stems are sent as 16 kHz 16-bit FLAC, made by ffmpeg from the float stems,
 * which changes nothing about where a word falls.
 *
 *   node --env-file=.env scripts/video/transcribe.ts narration
 *   node --env-file=.env scripts/video/transcribe.ts capture video/captures/<dir>
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { narration } from './config.ts';
import { transcribeFile } from './stt.ts';
import type { Transcript } from './stt.ts';
import { MANIFEST } from './voices.ts';

export const NARRATION_WORDS = 'data/video/narration-words.json';
export const TRANSCRIPTS = 'data/video/transcripts';

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

export type Words = { file: string; sha256: string; id: string; speechModel: string | null; text: string; words: Array<{ text: string; start: number; end: number }> };

async function words(path: string, send = path): Promise<Words> {
  const t: Transcript = await transcribeFile(send);
  return { file: path, sha256: sha(path), id: t.id, speechModel: t.speechModel, text: t.text, words: t.words.map((w) => ({ text: w.text, start: w.start, end: w.end })) };
}

export async function narrationWords(): Promise<Record<string, Words & { script: string }>> {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { lines: Record<string, { file: string; text: string }> };
  const have: Record<string, Words & { script: string }> = existsSync(NARRATION_WORDS) ? JSON.parse(readFileSync(NARRATION_WORDS, 'utf8')) : {};
  const script = narration();
  for (const id of Object.keys(script)) {
    const e = manifest.lines[id]!;
    if (e.text !== script[id]) throw new Error(`${id}: the clip is for an older line; remake it`);
    if (have[id] && have[id]!.sha256 === sha(e.file)) continue;
    have[id] = { ...(await words(e.file)), script: e.text };
    console.log(`  ${id}: ${have[id]!.words.length} words, ${have[id]!.speechModel}`);
  }
  writeFileSync(NARRATION_WORDS, `${JSON.stringify(have, null, 1)}\n`);
  return have;
}

export async function captureWords(dir: string): Promise<{ caller: Words; agent: Words }> {
  mkdirSync(TRANSCRIPTS, { recursive: true });
  const name = basename(dir);
  const out: Record<string, Words> = {};
  for (const stem of ['caller', 'agent']) {
    const target = `${TRANSCRIPTS}/${name}-${stem}.json`;
    const wav = `${dir}/stems/${stem}.wav`;
    if (existsSync(target) && JSON.parse(readFileSync(target, 'utf8')).sha256 === sha(wav)) { out[stem] = JSON.parse(readFileSync(target, 'utf8')); continue; }
    const flac = `${dir}/stems/${stem}-16k.flac`;
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', flac]);
    out[stem] = await words(wav, flac);
    writeFileSync(target, `${JSON.stringify(out[stem], null, 1)}\n`);
    console.log(`  ${name} ${stem}: ${out[stem]!.words.length} words, ${out[stem]!.speechModel}`);
  }
  return { caller: out.caller!, agent: out.agent! };
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const what = process.argv[2];
  if (what === 'narration') await narrationWords();
  else if (what === 'capture' && process.argv[3]) await captureWords(process.argv[3]);
  else { console.error('narration | capture <dir>'); process.exit(2); }
}
