/**
 * A rehearsal of scene C in-process, before spending public-site sessions on
 * it: Q3, the sample address pasted, Q4, the paste box cleared, then Q5 (the
 * same address, spoken). It records what the gate decided and which MCP
 * requests were made after Q5, the scene C3 check: needs_paste, and none.
 *
 * The risk it looks for: after C2 the conversation already holds the exact
 * address, from the paste and from afg_get_reputation's result, so the agent
 * may reuse that value for Q5; the gate would then rightly run it.
 *
 * Variants, for the decision the scene needs (none of them is the brief's own):
 *   --variant other-address  Q5 speaks round E's other test address, never pasted;
 *   --variant spoken-first   Q5 (the sample address) before the paste, then Q4.
 *
 *   node --env-file=.env scripts/video/rehearse-c3.ts [--variant other-address|spoken-first]
 */
import { writeFileSync } from 'node:fs';
import { AudioPump, parseWav, silence } from '../lib/audio.ts';
import { LiveSession } from '../lib/session.ts';
import { readFileSync } from 'node:fs';
import { SAMPLE_ADDRESS } from './capture.ts';

const variant = (() => { const i = process.argv.indexOf('--variant'); return i > 0 ? process.argv[i + 1]! : 'brief'; })();
/** Round E's other spoken test address (data/e2e-audio-gate-spoken-d4.json), never pasted here. */
export const OTHER_ADDRESS_TEXT = 'What is the reputation of wallet 0 x 3 f 9 a 1 c 7 e 5 b 2 d 8 f 4 a 6 c 0 e 9 b 3 d 7 f 1 a 5 c 8 e 2 b 4 d 6 f 0 9?';
const clip = (id: string) => {
  if (id === 'Q5b') return { text: OTHER_ADDRESS_TEXT, pcm: Buffer.from(parseWav(readFileSync('video/voices/Q5b.wav')).pcm) };
  const m = JSON.parse(readFileSync('data/video/voices.json', 'utf8')) as { lines: Record<string, { file: string; text: string }> };
  return { text: m.lines[id]!.text, pcm: Buffer.from(parseWav(readFileSync(m.lines[id]!.file)).pcm) };
};

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const s = await LiveSession.open('https://afg.ai/mcp', { asPage: true, maxSessionSeconds: 240 });
  const pump = new AudioPump((b64) => s.sendAudio(b64));
  pump.start();
  const out: Record<string, unknown> = { sessionId: s.sessionId, at: new Date().toISOString(), turns: [] as unknown[] };
  const wait = async (ms: number) => { await pump.enqueue(silence(ms)); };
  const say = async (id: string) => {
    const c = clip(id);
    const turn = s.beginTurn(c.text);
    await pump.enqueue(c.pcm);
    turn.speechEndAt = Date.now();
    const idle = s.waitIdle(60_000);
    void pump.enqueue(silence(1500));
    await idle;
    const done = s.endTurn()!;
    (out.turns as unknown[]).push({ id, heard: done.heard.join(' '), calls: done.calls.map((x) => ({ name: x.name, arguments: x.arguments, method: x.method })), reply: done.agentReply, voiceToVoiceMs: done.voiceToVoiceMs });
    console.log(`${id}: heard "${done.heard.join(' ')}" | calls ${done.calls.map((x) => `${x.name}[${x.method ?? ''}]`).join(', ')} | ${done.agentReply.slice(0, 140)}`);
    return done;
  };
  out.variant = variant;
  try {
    await wait(10000); // the greeting plays (8.8 s on AFG)
    await say('Q3');
    await wait(1500);
    const spoken = async (id: string) => {
      const beforeQ5 = s.mcpRequests.length;
      const gateBefore = s.gateLog.length;
      await say(id);
      out.c3 = { clip: id, mcpRequestsAfterQ5: s.mcpRequests.slice(beforeQ5).map((r) => ({ tool: r.tool, args: r.args })), gateAfterQ5: s.gateLog.slice(gateBefore) };
      console.log(`C3: ${s.mcpRequests.length - beforeQ5} MCP request(s) after ${id}; gate: ${JSON.stringify(s.gateLog.slice(gateBefore))}`);
    };
    if (variant === 'spoken-first') {
      await spoken('Q5');
      await wait(1500);
      s.setPaste(SAMPLE_ADDRESS);
      await wait(3000);
      await say('Q4');
    } else {
      s.setPaste(SAMPLE_ADDRESS);
      await wait(3000);
      await say('Q4');
      await wait(1200);
      s.setPaste('');
      await wait(1200);
      await spoken(variant === 'other-address' ? 'Q5b' : 'Q5');
    }
  } finally {
    pump.stop();
    await s.close();
  }
  const file = `data/video/rehearsal-c3-${variant}-${String(out.sessionId).slice(5, 13)}.json`;
  writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`written: ${file}`);
}
