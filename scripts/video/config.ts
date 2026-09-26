/**
 * The demo video's fixed inputs: who speaks with which voice, and every line.
 * Each voice is one value here, so a different pick is one re-render.
 */
import { readFileSync } from 'node:fs';

/** The 11 English Voice Agent voices the docs list; a session's voice is fixed once set. */
export const ENGLISH_VOICES = ['alba', 'eve', 'george', 'jane', 'jean', 'mary', 'michael', 'anna', 'charles', 'paul', 'vera'] as const;

/** The agent's voice is whatever interpres already uses: read from the page's own code. */
export function agentVoice(): string {
  const m = readFileSync('apps/web/src/voice.ts', 'utf8').match(/export const VOICE = '([a-z]+)'/);
  if (!m) throw new Error('apps/web/src/voice.ts: no VOICE constant');
  return m[1]!;
}

const agent = agentVoice();
export const VOICES = {
  agent,
  narrator: agent === 'charles' ? 'paul' : 'charles',
  caller: agent === 'michael' ? 'george' : 'michael',
} as const;

/** The identifier count, from F1's generated page: "Exact: N of M." */
export function identifierCount(): { exact: number; total: number } {
  const m = readFileSync('docs/IDENTIFIERS.md', 'utf8').match(/^Exact: (\d+) of (\d+)\.$/m);
  if (!m) throw new Error('docs/IDENTIFIERS.md: no "Exact: N of M." line; run scripts/spoken-identifiers.ts');
  return { exact: Number(m[1]), total: Number(m[2]) };
}

/** The script as written; N7's {EXACT} and {TOTAL} come from F1's count, as digits like every other number. */
export function narration(): Record<string, string> {
  const { exact: EXACT, total: TOTAL } = identifierCount();
  return {
    N1: "This is interpres. It connects AssemblyAI's Voice Agent API to public MCP servers. Type a website, press the mic, and its tools answer out loud.",
    N2: "AssemblyAI lists its Voice Agent API at $4.50 an hour, and OpenAI Realtime at $18. Realtime can call MCP servers by itself. The Voice Agent API has no MCP tool type, so teams that switch for the price lose their MCP tools. interpres gives them back.",
    N3: "Here's a real website with an MCP server. interpres looks in the official MCP registry, finds the server, and turns each of its tools into a Voice Agent function tool.",
    N4: "That answer came from goji's own server, through a live tool call.",
    N5: 'No website in mind? Search more than 11,000 public MCP servers right on the page. One click connects.',
    N6: 'Many servers list more than ten tools. interpres shows the agent ten at a time, and one of them is find tools. Ask for something out of view, and interpres swaps the right tools in, mid-conversation.',
    N7: `Speech gets identifiers wrong. In our tests, ${EXACT} of ${TOTAL} spoken wallet addresses came through exact. So interpres never runs a tool on an identifier it only heard. Paste it, and the agent uses the exact text.`,
    N8: 'A spoken address is held back. Nothing runs.',
    N9: "To check it isn't just these three, we probed every remote server in the official MCP registry. 12,012 answered without a login, listing more than 200,000 tools, and every tool converted.",
    N10: 'Then we asked thirty of them one question each, out loud and untuned. Fourteen answered from live data. Median voice to voice was 2.6 seconds, and the whole run cost 60 cents.',
    N11: 'Along the way we found two places where the API behaves differently from its docs, and wrote both up with scripts that reproduce them.',
    N12: 'interpres is open source under MIT, and live now at the address on screen. Type a website, press the mic, and ask.',
  };
}

/** The caller's lines. Q5 is round E's spoken-address clip text, the only line not checked word for word. */
export function callerLines(): Record<string, string> {
  const clips = JSON.parse(readFileSync('data/qa-audio/clips.json', 'utf8')).clips as Record<string, string>;
  return {
    Q1: 'What is SEO in plain English?',
    Q2: 'Who recommends Sapiens?',
    Q3: 'I want to run a spec check on a job contract.',
    Q4: 'Check the reputation of the wallet I pasted.',
    Q5: clips['afg-spoken-address']!,
  };
}

/**
 * Proper nouns speech-to-text may spell differently, and nothing else. A
 * transcript word is accepted in place of the script word only as listed.
 */
export const PROPER_NOUN_VARIANTS: Record<string, string[]> = {
  interpres: ['interpress', 'interprez', 'interpreze'],
  assemblyai: ['assembly ai'],
  openai: ['open ai'],
};

export const CAPTURE_URL = 'https://interpres.ochinimus.app/';
