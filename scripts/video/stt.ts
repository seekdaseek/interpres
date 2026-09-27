/**
 * AssemblyAI pre-recorded transcription, for checking the video's audio: every
 * narration and caller clip, the capture stems, and the final file. No speech
 * model is named in the request, so the account's current default runs; the
 * response says which one that was.
 */
import { readFileSync } from 'node:fs';
import { config } from '../../apps/server/src/config.ts';

const API = 'https://api.assemblyai.com/v2';

export type Word = { text: string; start: number; end: number; confidence?: number; speaker?: string | null };
export type Transcript = { id: string; text: string; words: Word[]; speechModel: string | null; utterances?: Array<{ speaker: string; text: string; start: number; end: number }> };

async function api<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { authorization: config.assemblyAiKey, ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

/** A finished transcript fetched again by its id: the same words, re-checked under a changed rule. */
export async function getTranscript(id: string): Promise<Transcript> {
  const t = await api<{ id: string; status: string; text?: string; words?: Word[]; speech_model?: string | null; speech_models?: string[] | null; utterances?: Transcript['utterances'] }>(`/transcript/${id}`, { method: 'GET' });
  if (t.status !== 'completed') throw new Error(`transcript ${id} is ${t.status}`);
  return { id: t.id, text: t.text ?? '', words: t.words ?? [], speechModel: t.speech_model ?? (t.speech_models?.join(',') ?? null), utterances: t.utterances };
}

export async function transcribeFile(path: string, opts: { speakerLabels?: boolean } = {}): Promise<Transcript> {
  if (config.assemblyAiKey === '') throw new Error('ASSEMBLYAI_API_KEY is not set');
  const { upload_url } = await api<{ upload_url: string }>('/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: readFileSync(path),
  });
  const job = await api<{ id: string }>('/transcript', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audio_url: upload_url, ...(opts.speakerLabels ? { speaker_labels: true } : {}) }),
  });
  for (let i = 0; i < 240; i++) {
    const t = await api<{ id: string; status: string; error?: string; text?: string; words?: Word[]; speech_model?: string | null; speech_models?: string[] | null; utterances?: Transcript['utterances'] }>(`/transcript/${job.id}`, { method: 'GET' });
    if (t.status === 'completed') {
      return { id: t.id, text: t.text ?? '', words: t.words ?? [], speechModel: t.speech_model ?? (t.speech_models?.join(',') ?? null), utterances: t.utterances };
    }
    if (t.status === 'error') throw new Error(`transcript ${job.id}: ${t.error}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`transcript ${job.id} did not finish`);
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 12012 -> "twelve thousand twelve": the one number format both sides are reduced to. */
export function numberWords(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ''}`;
  if (n < 1_000_000) return `${numberWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberWords(n % 1000)}` : ''}`;
  return `${numberWords(Math.floor(n / 1_000_000))} million${n % 1_000_000 ? ` ${numberWords(n % 1_000_000)}` : ''}`;
}

/**
 * Case, punctuation and number format, removed: "$4.50" and "four dollars
 * fifty" and "4.50" all become words, "2.6" becomes "two point six", "60 cents"
 * stays "sixty cents". Nothing else is forgiven.
 */
export function normaliseSpeech(text: string): string[] {
  let t = ` ${text.toLowerCase()} `;
  t = t.replace(/[‘’]/g, "'");
  // $0.60 -> 60 cents: an amount under a dollar is said in cents.
  t = t.replace(/\$0\.(\d{2})\b/g, (_m, b: string) => ` ${Number(b)} cents `);
  // $4.50 -> 4 dollars 50 ; $18 -> 18 dollars
  t = t.replace(/\$(\d[\d,]*)\.(\d{2})\b/g, (_m, a: string, b: string) => ` ${a.replace(/,/g, '')} dollars ${Number(b)} `);
  t = t.replace(/\$(\d[\d,]*)\b/g, (_m, a: string) => ` ${a.replace(/,/g, '')} dollars `);
  // 2.6 -> 2 point 6
  t = t.replace(/(\d)\.(\d+)/g, (_m, a: string, b: string) => `${a} point ${b.split('').join(' ')}`);
  t = t.replace(/(\d),(\d{3})/g, '$1$2').replace(/(\d),(\d{3})/g, '$1$2');
  t = t.replace(/\d+/g, (d) => ` ${numberWords(Number(d))} `);
  // "four dollars fifty" said for $4.50: the cents are spoken without "cents".
  t = t.replace(/\band\b/g, ' and ');
  t = t.replace(/[^a-z0-9' ]+/g, ' ').replace(/'s\b/g, 's').replace(/'/g, '');
  return t.split(/\s+/).filter(Boolean);
}

export type Match = { ok: boolean; expected: string[]; heard: string[]; variantsUsed: string[]; firstDifference?: { at: number; expected: string; heard: string } };

/**
 * The words of `expected` against the transcript, after normalising both.
 * Proper nouns may differ only as `variants` lists (script word -> accepted
 * transcript spellings, which may be two words).
 */
export function matchWords(expectedText: string, heardText: string, variants: Record<string, string[]>): Match {
  const expected = normaliseSpeech(expectedText);
  let heard = normaliseSpeech(heardText);
  const variantsUsed: string[] = [];
  // Rewrite accepted variants in the transcript back to the script's word.
  for (const [word, alts] of Object.entries(variants)) {
    for (const alt of alts) {
      const altWords = normaliseSpeech(alt);
      for (let i = 0; i + altWords.length <= heard.length; i++) {
        if (altWords.every((w, j) => heard[i + j] === w) && expected.includes(word) && altWords.join(' ') !== word) {
          heard = [...heard.slice(0, i), word, ...heard.slice(i + altWords.length)];
          variantsUsed.push(`${alt} -> ${word}`);
        }
      }
    }
  }
  const n = Math.max(expected.length, heard.length);
  for (let i = 0; i < n; i++) {
    if (expected[i] !== heard[i]) return { ok: false, expected, heard, variantsUsed, firstDifference: { at: i, expected: expected.slice(i, i + 4).join(' '), heard: heard.slice(i, i + 4).join(' ') } };
  }
  return { ok: true, expected, heard, variantsUsed };
}
