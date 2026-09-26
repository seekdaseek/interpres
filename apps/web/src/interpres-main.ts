import './interpres.css';
import { $, h, clear, clip } from './dom.ts';
import { VoiceSession } from './voice.ts';
import type { ConnectPayload, PhasePayload, Status, ToolOutcome, VoiceUi } from './voice.ts';
import type { ToolCall } from '@interpres/core';

type Preset = { label: string; url: string; blurb: string; asks: string[]; exercisesPhases?: boolean };
type CatalogEntry = { voiceName: string; mcpName: string; description: string; isWriteTool: boolean };
type ConnectResponse = ConnectPayload & {
  cached: boolean;
  transport: string;
  server: { name?: string; title?: string; version?: string } | null;
  stats: { toolsIn: number; toolsConverted: number; failed: number; convertedWithHints: number };
  catalog: CatalogEntry[];
  asks: string[];
};

let conn: ConnectResponse | null = null;
let session: VoiceSession | null = null;
let visibleBefore = new Set<string>();
let callCount = 0;
const callItems = new Map<string, HTMLElement>();
const agentLines = new Map<string, HTMLElement>();
let userLive: HTMLElement | null = null;
let timerHandle: ReturnType<typeof setInterval> | undefined;

// -------------------------------------------------------------------- status

const STATUS: Record<Status, [string, string]> = {
  connecting: ['Connecting', 'Getting a session token and opening the line.'],
  listening: ['Listening', 'Go ahead - ask it something.'],
  hearing: ['Hearing you', 'Keep talking; it waits for you to finish.'],
  thinking: ['Thinking', 'Deciding whether it needs a tool.'],
  speaking: ['Speaking', 'Talk over it to interrupt.'],
  tool: ['Calling a tool', ''],
  ended: ['Session ended', 'Press to start a new one.'],
  error: ['Something went wrong', ''],
};

function setStatus(s: Status, detail?: string): void {
  const [title, sub] = STATUS[s];
  $('status').textContent = s === 'tool' && detail ? `Calling ${detail}` : title;
  $('substatus').textContent = detail && s !== 'tool' ? detail : sub;
  $('talk').dataset.state = s;
}

// ------------------------------------------------------------ conversation

function scrollDown(el: HTMLElement): void {
  el.scrollTop = el.scrollHeight;
}

function addLine(who: 'you' | 'agent' | 'note', text: string): HTMLElement {
  $('lines-empty').hidden = true;
  const li = h('li', { class: `line ${who}` }, h('span', { class: 'who' }, who === 'you' ? 'You' : who === 'agent' ? 'Agent' : ''), h('span', { class: 'text' }, text));
  $('lines').append(li);
  scrollDown($('lines'));
  return li;
}

function joinWord(existing: string, word: string): string {
  if (existing === '') return word.trimStart();
  return /^[.,!?;:'")\]]/.test(word) ? existing + word : `${existing} ${word.trim()}`;
}

// ------------------------------------------------------------- phase panes

function renderPhase(phase: PhasePayload, why: string): void {
  const now = new Set(phase.tools.map((t) => t.name));
  const list = $('phase-tools');
  clear(list);
  for (const t of phase.tools) {
    const isNew = visibleBefore.size > 0 && !visibleBefore.has(t.name);
    list.append(h('li', { class: `chip${t.name === 'find_tools' ? ' meta' : ''}${isNew ? ' new' : ''}`, title: t.description }, t.name));
  }
  $('phase-count').textContent = `${phase.tools.length} of 10`;
  $('phase-reason').textContent = why;
  visibleBefore = now;

  const kt = $('keyterms');
  clear(kt);
  for (const k of phase.keyterms.slice(0, 48)) kt.append(h('li', { class: 'chip' }, k));
  if (phase.keyterms.length > 48) kt.append(h('li', { class: 'chip more' }, `+${phase.keyterms.length - 48}`));
  $('kt-count').textContent = String(phase.keyterms.length);
}

// ------------------------------------------------------------ tool timeline

function argsText(args: Record<string, unknown>): string {
  const s = JSON.stringify(args);
  return s === '{}' ? '(no arguments)' : clip(s, 500);
}

function toolStart(call: ToolCall): void {
  $('calls-empty').hidden = true;
  callCount++;
  $('call-count').textContent = String(callCount);
  const isPhase = call.name === 'find_tools';
  const li = h('li', { class: `call pending${isPhase ? ' phase-call' : ''}` },
    h('div', { class: 'call-head' },
      h('span', { class: 'call-name' }, call.name),
      h('span', { class: 'call-meta' }, 'calling…'),
    ),
    h('code', { class: 'call-args' }, argsText(call.arguments)),
  );
  callItems.set(call.callId, li);
  $('calls').prepend(li);
}

function toolDone(call: ToolCall, out: ToolOutcome, ms: number): void {
  const li = callItems.get(call.callId);
  if (!li) return;
  li.classList.remove('pending');
  const meta = li.querySelector('.call-meta')!;
  if (call.name === 'find_tools' && out.phase) {
    meta.textContent = `${ms} ms · phase swap`;
    const revealed = out.phase.tools.map((t) => t.name).filter((n) => n !== 'find_tools');
    li.append(h('p', { class: 'call-spoken' }, `Swapped in ${revealed.length} tools: ${revealed.join(', ')}`));
    if (out.carried && out.carried.length > 0) {
      li.append(h('p', { class: 'call-carried' }, `Carried from what you said: ${out.carried.join(', ')}`));
    }
    return;
  }
  if (out.isError) li.classList.add('failed');
  const bits = [`${out.totalMs ?? ms} ms`, out.method ?? ''];
  if (out.refine === 'used') bits.push('refined');
  meta.textContent = bits.filter(Boolean).join(' · ');
  li.append(h('p', { class: 'call-spoken' }, out.spoken));
  if (out.normalisersApplied && out.normalisersApplied.length > 0) {
    li.append(h('p', { class: 'call-carried' }, `Normalised: ${out.normalisersApplied.join(', ')}`));
  }
  if (out.raw && out.raw !== out.spoken) {
    li.append(h('details', { class: 'call-raw' },
      h('summary', {}, `Raw result · ${out.raw.length.toLocaleString()} characters`),
      h('pre', {}, clip(out.raw, 8000)),
    ));
  }
}

function toolFailed(call: ToolCall, message: string): void {
  const li = callItems.get(call.callId);
  if (!li) return;
  li.classList.remove('pending');
  li.classList.add('failed');
  li.querySelector('.call-meta')!.textContent = 'failed';
  li.append(h('p', { class: 'call-spoken' }, message));
}

// ------------------------------------------------------------------ voice

const ui: VoiceUi = {
  status: setStatus,
  ready(sessionId, maxSeconds) {
    $('diag').textContent = `session ${sessionId}`;
    const ends = Date.now() + maxSeconds * 1000;
    const timer = $('timer');
    timer.hidden = false;
    const tick = () => {
      const left = Math.max(0, Math.round((ends - Date.now()) / 1000));
      timer.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      timer.classList.toggle('low', left <= 30);
    };
    tick();
    timerHandle = setInterval(tick, 1000);
    if (session) {
      const r = session.sampleRates;
      $('diag').textContent = `session ${sessionId} · audio ${r.capture} Hz in / ${r.playback} Hz out (asked for 24000)`;
    }
  },
  userPartial(text) {
    if (!userLive) userLive = addLine('you', '');
    userLive.classList.add('live');
    userLive.querySelector('.text')!.textContent = text;
    scrollDown($('lines'));
  },
  userFinal(text) {
    if (!userLive) userLive = addLine('you', '');
    userLive.classList.remove('live');
    userLive.querySelector('.text')!.textContent = text;
    userLive = null;
  },
  agentDelta(replyId, word) {
    let li = agentLines.get(replyId);
    if (!li) { li = addLine('agent', ''); li.classList.add('live'); agentLines.set(replyId, li); }
    const t = li.querySelector('.text')!;
    t.textContent = joinWord(t.textContent ?? '', word);
    scrollDown($('lines'));
  },
  agentFinal(replyId, text, interrupted) {
    let li = agentLines.get(replyId);
    if (!li) { li = addLine('agent', ''); agentLines.set(replyId, li); }
    li.classList.remove('live');
    if (text.trim() === '' && !interrupted) { li.remove(); return; }
    li.querySelector('.text')!.textContent = text;
    if (interrupted) li.classList.add('cut');
  },
  toolStart,
  toolDone,
  toolFailed,
  phase: renderPhase,
  interrupted() { /* the line is marked when transcript.agent arrives */ },
  ended(reason) {
    if (timerHandle) clearInterval(timerHandle);
    $('timer').hidden = true;
    $('mic').setAttribute('aria-label', 'Start talking');
    $('talk').classList.remove('live');
    session = null;
    addLine('note', `Session ended: ${reason}.`);
  },
  level(rms) {
    $('talk').style.setProperty('--level', rms.toFixed(3));
  },
};

async function toggleTalk(): Promise<void> {
  if (!conn) return;
  if (session) { await session.stop('ended by you'); return; }
  session = new VoiceSession(conn, ui);
  $('talk').classList.add('live');
  $('mic').setAttribute('aria-label', 'End the conversation');
  // The opening phase again: each conversation starts from phase 0.
  visibleBefore = new Set();
  renderPhase(conn.phase, conn.phase.reason);
  try {
    await session.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const blocked = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    await session?.stop('could not start').catch(() => {});
    setStatus('error', blocked ? 'The microphone is blocked. Allow it from the address bar, then press again.' : message);
  }
}

// ----------------------------------------------------------------- connect

function showError(message: string | null): void {
  const el = $('connect-error');
  el.hidden = message === null;
  el.textContent = message ?? '';
}

async function connect(url: string): Promise<void> {
  if (session) await session.stop('switched server');
  showError(null);
  const btn = $('connect-btn') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    const res = await fetch('/api/mcp/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const body = await res.json();
    if (!res.ok) { showError(`${body.error ?? 'Could not connect.'}${body.code ? ` (${body.code})` : ''}`); return; }
    conn = body as ConnectResponse;
    renderServer(conn);
    const q = new URL(location.href);
    q.searchParams.set('url', url);
    history.replaceState(null, '', q);
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Could not connect.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
}

function renderServer(c: ConnectResponse): void {
  const name = c.server?.title ?? c.server?.name ?? new URL(c.url).host;
  $('server-name').textContent = name;
  $('server-meta').textContent = [
    c.server?.version ? `v${c.server.version}` : '',
    `${c.stats.toolsConverted} ${c.stats.toolsConverted === 1 ? 'tool' : 'tools'}`,
    c.transport,
    c.phase.hasFindTools ? 'over the 10-tool limit, so find_tools is on' : 'every tool fits in one phase',
  ].filter(Boolean).join(' · ');
  const writes = c.catalog.filter((t) => t.isWriteTool).map((t) => t.mcpName);
  const warn = $('server-warn');
  warn.hidden = writes.length === 0;
  warn.textContent = writes.length > 0 ? `${writes.length} of these tools change state on the server.` : '';

  const asks = $('asks');
  clear(asks);
  if (c.asks.length > 0) {
    asks.append(h('span', { class: 'asks-label' }, 'Try saying'));
    for (const a of c.asks) asks.append(h('span', { class: 'ask' }, `“${a}”`));
  }

  clear($('lines'));
  $('lines-empty').hidden = false;
  clear($('calls'));
  callItems.clear();
  agentLines.clear();
  userLive = null;
  callCount = 0;
  $('call-count').textContent = '0';
  $('calls-empty').hidden = false;
  visibleBefore = new Set();
  renderPhase(c.phase, c.phase.reason);

  $('server').hidden = false;
  $('talk').hidden = false;
  $('panes').hidden = false;
  setStatus('ended');
  $('status').textContent = 'Press to talk';
  $('substatus').textContent = 'Your browser will ask for the microphone.';
  $('talk').dataset.state = 'idle';
}

async function loadPresets(): Promise<Preset[]> {
  try {
    const res = await fetch('/api/presets');
    return ((await res.json()) as { presets: Preset[] }).presets;
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const presets = await loadPresets();
  const box = $('presets');
  for (const p of presets) {
    box.append(h('button', {
      type: 'button',
      class: 'preset',
      title: p.url,
      onclick: () => { ($('url') as HTMLInputElement).value = p.url; void connect(p.url); },
    }, h('span', { class: 'preset-label' }, p.label), h('span', { class: 'preset-blurb' }, p.blurb)));
  }

  $('connect-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = ($('url') as HTMLInputElement).value.trim();
    if (url) void connect(url);
  });
  $('mic').addEventListener('click', () => void toggleTalk());

  const fromQuery = new URL(location.href).searchParams.get('url');
  if (fromQuery) {
    ($('url') as HTMLInputElement).value = fromQuery;
    void connect(fromQuery);
  }
}

void main();
