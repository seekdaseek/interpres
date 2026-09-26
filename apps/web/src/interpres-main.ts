import './interpres.css';
import { $, h, clear, clip } from './dom.ts';
import { TokenRefusedError, VoiceSession } from './voice.ts';
import { ReplayPlayer, replay } from './replay.ts';
import type { ConnectPayload, PhasePayload, Status, ToolOutcome, VoiceUi } from './voice.ts';
import type { GateDecision, ToolCall, UrlNote } from '@interpres/core';
import { groupInFours, mergeKeyterms, normaliseServerUrl, pasteKeyterms } from '@interpres/core';
import { api, postJson } from './http.ts';

type Preset = { label: string; url: string; blurb: string; asks: string[]; exercisesPhases?: boolean };
type CatalogEntry = { voiceName: string; mcpName: string; description: string; isWriteTool: boolean; writeReason?: string };
/** A server discovery found for a website. */
type Candidate = { url: string; tools: number; source: 'registry' | 'probe'; name?: string; title?: string; note: string };
type DiscoveryInfo = { kind: 'one' | 'several' | 'none'; domain: string; tried: string[]; ms: number; cached: boolean; from: string; found?: Candidate };
/** Several servers answered for one website: the page shows a pick list. */
type ChooseResponse = { url: string; input: string; choose: Candidate[]; discovery: DiscoveryInfo };
type RegistryServer = { name: string; title?: string; url: string; host: string; tools: number; transport: string; description?: string };
type ConnectResponse = ConnectPayload & {
  /** What was typed, and what the server made of it. */
  input: string;
  notes: UrlNote[];
  discovery: DiscoveryInfo | null;
  cached: boolean;
  transport: string;
  server: { name?: string; title?: string; version?: string } | null;
  stats: { toolsIn: number; toolsConverted: number; failed: number; convertedWithHints: number };
  catalog: CatalogEntry[];
  asks: string[];
  sampleValue: { label: string; value: string } | null;
};

let conn: ConnectResponse | null = null;
let session: VoiceSession | null = null;
let visibleBefore = new Set<string>();
let callCount = 0;
const callItems = new Map<string, HTMLElement>();
const agentLines = new Map<string, HTMLElement>();
let userLive: HTMLElement | null = null;
let timerHandle: ReturnType<typeof setInterval> | undefined;
let player: ReplayPlayer | null = null;

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

function resetPanels(): void {
  clear($('lines'));
  $('lines-empty').hidden = false;
  clear($('calls'));
  callItems.clear();
  agentLines.clear();
  userLive = null;
  callCount = 0;
  $('call-count').textContent = '0';
  $('calls-empty').hidden = false;
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

  renderKeyterms(phase.keyterms, currentYours);
}

let currentYours: string[] = [];

function renderKeyterms(all: string[], yours: string[]): void {
  currentYours = yours;
  const kt = $('keyterms');
  clear(kt);
  const mine = new Set(yours.map((y) => y.toLowerCase()));
  for (const k of all.slice(0, 48)) {
    const isYours = mine.has(k.toLowerCase());
    kt.append(h('li', { class: `chip${isYours ? ' yours' : ''}`, title: isYours ? 'From your paste box' : undefined }, k, isYours ? h('span', { class: 'yours-tag' }, 'yours') : null));
  }
  if (all.length > 48) kt.append(h('li', { class: 'chip more' }, `+${all.length - 48}`));
  $('kt-count').textContent = String(all.length);
}

// ---------------------------------------------------------------- the gate

let gateHideTimer: ReturnType<typeof setTimeout> | undefined;

function showGate(call: ToolCall, d: Exclude<GateDecision, { action: 'execute' }>): void {
  if (gateHideTimer) clearTimeout(gateHideTimer);
  const card = $('gate-card');
  card.hidden = false;
  card.dataset.kind = d.action === 'confirm' ? 'write' : d.action;
  $('gate-kind').textContent =
    d.action === 'invalid' ? 'Wrong format - paste it instead'
      : d.action === 'paste' ? 'Heard from speech, may be wrong - paste it to run'
        : 'Changes something - confirm first';
  $('gate-tool').textContent = d.action === 'confirm' && d.card.server ? `${call.name} on ${d.card.server}` : call.name;
  const value = $('gate-value');
  value.hidden = !d.card.value;
  value.textContent = d.card.value ? groupInFours(d.card.value) : '';
  const what = $('gate-what');
  what.hidden = !d.card.what;
  what.textContent = d.card.what ?? '';
  $('gate-say').textContent = d.card.say;
  // A spoken identifier can only get through the paste box, so take the person there.
  if (d.action !== 'confirm') {
    const box = $('paste') as HTMLInputElement;
    box.focus();
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  // A held call is released only within 120 s; the card should not outlive that.
  gateHideTimer = setTimeout(() => { card.hidden = true; }, 120_000);
}

function releaseGate(call: ToolCall): void {
  const card = $('gate-card');
  card.dataset.kind = 'released';
  $('gate-kind').textContent = 'Confirmed - running it';
  $('gate-tool').textContent = call.name;
  if (gateHideTimer) clearTimeout(gateHideTimer);
  gateHideTimer = setTimeout(() => { card.hidden = true; }, 2500);
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
  if (li.classList.contains('held')) return;   // the gate already wrote this card
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
  gateHeld(call, decision) {
    showGate(call, decision);
    const li = callItems.get(call.callId);
    if (li) {
      li.classList.remove('pending');
      li.classList.add('held');
      li.querySelector('.call-meta')!.textContent =
        decision.action === 'invalid' ? 'held: wrong format' : decision.action === 'paste' ? 'held: heard, needs a paste' : 'held: changes state';
      li.append(h('p', { class: 'call-spoken' }, decision.card.say));
    }
  },
  gateReleased(call) {
    releaseGate(call);
  },
  keyterms(all, yours) {
    renderKeyterms(all, yours);
  },
  idle(secondsLeft) {
    const el = $('idle');
    el.hidden = secondsLeft === null;
    if (secondsLeft === null) return;
    el.textContent = `No one is speaking: this session ends in ${secondsLeft} s. Say anything to keep going.`;
    el.classList.toggle('soon', secondsLeft <= 10);
  },
};

async function toggleTalk(): Promise<void> {
  if (!conn) return;
  if (session) { await session.stop('ended by you'); return; }
  session = new VoiceSession(conn, ui, () => ($('paste') as HTMLInputElement).value);
  $('talk').classList.add('live');
  $('mic').setAttribute('aria-label', 'End the conversation');
  // The opening phase again: each conversation starts from phase 0.
  visibleBefore = new Set();
  renderPhase(conn.phase, conn.phase.reason);
  try {
    await session.start();
  } catch (err) {
    if (err instanceof TokenRefusedError) {
      // The demo degrades, it never goes dark: the recording plays instead.
      await session?.stop('could not start').catch(() => {});
      void startReplay(`Live sessions are paused: ${err.message} Here is a recorded one instead.`);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const blocked = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    await session?.stop('could not start').catch(() => {});
    setStatus('error', blocked ? 'The microphone is blocked. Allow it from the address bar, then press again.' : message);
  }
}

// ------------------------------------------------------------------ replay

/**
 * Plays the recorded session in the live panes: from the homepage button, and
 * in place of an error when /api/token refuses.
 */
async function startReplay(why: string | null): Promise<void> {
  if (session) await session.stop('switched to the recording');
  player?.stop();
  $('server-name').textContent = replay.server.label;
  $('server-meta').textContent = [`recorded ${replay.recordedAt.slice(0, 10)}`, `${replay.tools.length} tools`, `${Math.round(replay.durationSeconds)} s`].join(' · ');
  $('server-warn').hidden = true;
  clear($('asks'));
  $('starters').hidden = true;
  $('gate-card').hidden = true;
  $('talk').hidden = true;
  $('paste-row').hidden = true;
  const list = $('phase-tools');
  clear(list);
  for (const name of replay.tools) list.append(h('li', { class: 'chip' }, name));
  $('phase-count').textContent = `${replay.tools.length} of 10`;
  $('phase-reason').textContent = 'the tools this session was given';
  visibleBefore = new Set();
  renderKeyterms([], []);
  $('replay-note').textContent = why ?? 'A real session, recorded. The caller is synthetic speech; the agent, its voice and every tool call are live AssemblyAI and MCP traffic.';
  $('replay-id').textContent = replay.sessionId;
  $('replay-voice').textContent = `Caller voice: ${replay.voice}.`;
  resetPanels();
  $('server').hidden = false;
  $('panes').hidden = false;
  $('replay').hidden = false;
  const audio = $('replay-audio') as HTMLAudioElement;
  player = new ReplayPlayer(audio, {
    reset: resetPanels,
    line: (who) => addLine(who, ''),
    toolStart: (id, name, args) => toolStart({ callId: id, name, arguments: args }),
    toolDone: (id, name, spoken, method, ms, ok) => toolDone({ callId: id, name, arguments: {} }, { spoken, method, totalMs: ms, isError: !ok } as ToolOutcome, ms),
  });
  audio.currentTime = 0;
  $('replay').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!(await player.play())) $('replay-note').textContent += ' Press play to start it.';
}

// ---------------------------------------------------------------- starters

const WHY_TEMPLATES: Record<string, string> = {
  rate_limited: 'was rate-limited',
  breaker_open: 'is resting after a rate limit',
  timeout: 'did not answer in time',
  unusable_output: 'gave no usable questions',
  no_read_only_tools: 'was not asked: this server has no read-only tools',
};

/** Three questions for this server, from the LLM Gateway or, failing that, from templates. */
async function loadStarters(url: string): Promise<void> {
  const el = $('starters');
  clear(el);
  el.hidden = false;
  el.append(h('span', { class: 'asks-label' }, 'Try asking'), h('span', { class: 'starter-note' }, 'writing questions…'));
  try {
    const r = await postJson<{ source?: string; questions?: string[]; ms?: number; model?: string; reason?: string }>('/api/mcp/starters', { url });
    if (conn?.url !== url) return;   // switched server meanwhile
    if (!r.ok || !Array.isArray(r.data.questions)) { el.hidden = true; return; }
    const s = r.data as { source?: string; questions: string[]; ms?: number; model?: string; reason?: string };
    clear(el);
    el.append(h('span', { class: 'asks-label' }, 'Try asking'));
    for (const q of s.questions) el.append(h('span', { class: 'ask' }, `“${q}”`));
    el.append(h('span', { class: 'starter-note' }, s.source === 'gateway'
      ? `written by AssemblyAI's LLM Gateway (${s.model}, ${s.ms} ms)`
      : `from the tools' own descriptions: the LLM Gateway ${WHY_TEMPLATES[s.reason ?? ''] ?? 'was unavailable'}`));
  } catch {
    el.hidden = true;
  }
}

// ----------------------------------------------------------------- connect

/** One plain sentence, and what the server actually said folded under it. */
function showError(message: string | null, detail?: string): void {
  const el = $('connect-error');
  clear(el);
  el.hidden = message === null;
  if (message === null) return;
  el.append(h('span', {}, message));
  if (detail) el.append(h('details', { class: 'error-detail' }, h('summary', {}, 'What the server said'), h('code', {}, detail)));
}

const NOTE_TEXT: Record<UrlNote, string> = {
  added_https: 'added https://',
  switched_to_https: 'switched http:// to https://, the only kind interpres connects to',
  cleaned: 'removed the quotes and punctuation around it',
};

function showHint(text: string | null): void {
  const el = $('url-hint');
  el.hidden = text === null;
  el.textContent = text ?? '';
}

/** As the box is typed in: the address it will connect to, when that differs. Errors wait for Connect. */
function previewUrl(): void {
  const typed = ($('url') as HTMLInputElement).value;
  const r = normaliseServerUrl(typed);
  if (!r.ok || r.url === typed.trim()) { showHint(null); return; }
  showHint(`Will connect to ${r.url}${r.notes.length ? ` (${r.notes.map((n) => NOTE_TEXT[n]).join('; ')})` : ''}`);
}

const toolsText = (n: number) => `${n} ${n === 1 ? 'tool' : 'tools'}`;

/** Several servers answered for one website: one button each, and a click connects. */
function showChoices(d: ChooseResponse | null): void {
  const el = $('choices');
  clear(el);
  el.hidden = d === null;
  if (d === null) return;
  el.append(h('p', { class: 'choices-label' }, `${d.choose.length} MCP servers answered for ${d.discovery.domain}. Pick one:`));
  for (const cand of d.choose) {
    el.append(h('button', {
      type: 'button',
      class: 'pick',
      onclick: () => { ($('url') as HTMLInputElement).value = cand.url; void connect(cand.url, { scroll: true }); },
    },
    h('span', { class: 'pick-title' }, cand.title ?? cand.name ?? new URL(cand.url).host),
    h('span', { class: 'pick-meta' }, `${cand.url} · ${toolsText(cand.tools)} · ${cand.note}`)));
  }
}

async function connect(input: string, opts: { scroll?: boolean } = {}): Promise<void> {
  if (session) await session.stop('switched server');
  showError(null);
  showChoices(null);
  // The same normaliser the server runs, so a refusal needs no round trip.
  // The server runs it again and its answer is the one that counts.
  const preview = normaliseServerUrl(input);
  if (!preview.ok) { showHint(null); showError(preview.message); return; }
  const btn = $('connect-btn') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = preview.url.endsWith('/') && new URL(preview.url).pathname === '/' ? 'Looking…' : 'Connecting…';
  try {
    const r = await postJson<ConnectResponse | ChooseResponse>('/api/mcp/connect', { url: input });
    if (!r.ok) { showHint(null); showError(r.message, r.detail); return; }
    if ('choose' in r.data && Array.isArray(r.data.choose)) { showHint(null); showChoices(r.data); return; }
    conn = r.data as ConnectResponse;
    ($('url') as HTMLInputElement).value = conn.url;
    const notes = conn.notes ?? [];
    const found = conn.discovery?.kind === 'one' ? conn.discovery.found : undefined;
    if (found && conn.discovery) {
      const ms = conn.discovery.ms;
      showHint(`${found.note}: ${conn.url} · ${toolsText(found.tools)} · ${ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}${conn.discovery.cached ? ', remembered from an earlier look' : ''}`);
    } else {
      showHint(notes.length ? `Connected to ${conn.url}: ${notes.map((n) => NOTE_TEXT[n] ?? n).join('; ')}.` : null);
    }
    renderServer(conn);
    if (opts.scroll) $('server').scrollIntoView({ behavior: 'smooth', block: 'start' });
    void loadStarters(conn.url);
    const q = new URL(location.href);
    q.searchParams.set('url', conn.url);
    history.replaceState(null, '', q);
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
    asks.append(h('span', { class: 'asks-label' }, 'Tested on this server'));
    for (const a of c.asks) asks.append(h('span', { class: 'ask' }, `“${a}”`));
  }

  resetPanels();
  visibleBefore = new Set();
  renderPhase(c.phase, c.phase.reason);
  player?.stop();
  $('replay').hidden = true;

  const sample = $('sample-btn') as HTMLButtonElement;
  sample.hidden = !c.sampleValue;
  if (c.sampleValue) {
    const sv = c.sampleValue;
    sample.textContent = sv.label;
    sample.onclick = async () => {
      // Clipboard first, so the judge pastes it themselves; fill the box if the
      // browser will not allow the copy.
      try {
        await navigator.clipboard.writeText(sv.value);
        sample.textContent = 'Copied - now paste it in the box';
      } catch {
        ($('paste') as HTMLInputElement).value = sv.value;
        onPasteChange();
        sample.textContent = 'Filled in for you';
      }
      setTimeout(() => { sample.textContent = sv.label; }, 2500);
    };
  }
  $('gate-card').hidden = true;
  $('starters').hidden = true;
  const yoursNow = pasteKeyterms(($('paste') as HTMLInputElement).value);
  renderKeyterms(mergeKeyterms(c.phase.keyterms, yoursNow), yoursNow);

  $('server').hidden = false;
  $('talk').hidden = false;
  $('paste-row').hidden = false;
  $('panes').hidden = false;
  setStatus('ended');
  $('status').textContent = 'Press to talk';
  $('substatus').textContent = 'Your browser will ask for the microphone.';
  $('talk').dataset.state = 'idle';
}

let pasteTimer: ReturnType<typeof setTimeout> | undefined;

function onPasteChange(): void {
  const text = ($('paste') as HTMLInputElement).value;
  if (session) session.notePaste(text);
  else if (conn) renderKeyterms(mergeKeyterms(conn.phase.keyterms, pasteKeyterms(text)), pasteKeyterms(text));
}

async function loadPresets(): Promise<{ presets: Preset[]; registryCount: number | null }> {
  const r = await api<{ presets: Preset[]; registry?: { count?: number } }>('/api/presets');
  if (!r.ok) return { presets: [], registryCount: null };
  return {
    presets: Array.isArray(r.data.presets) ? r.data.presets : [],
    registryCount: typeof r.data.registry?.count === 'number' ? r.data.registry.count : null,
  };
}

// ------------------------------------------------------------------ search

let searchSeq = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

function searchNote(text: string | null): void {
  const el = $('search-note');
  el.hidden = text === null;
  el.textContent = text ?? '';
}

function onSearchInput(): void {
  const q = ($('search') as HTMLInputElement).value.trim();
  if (searchTimer) clearTimeout(searchTimer);
  if (q.length < 2) {
    searchSeq++;   // an answer still on its way is now stale
    clear($('results'));
    searchNote(q.length === 1 ? 'Type at least 2 characters.' : null);
    return;
  }
  searchTimer = setTimeout(() => void runSearch(q), 250);
}

async function runSearch(q: string): Promise<void> {
  const seq = ++searchSeq;
  const r = await api<{ results: RegistryServer[]; total: number }>(`/api/registry/search?q=${encodeURIComponent(q)}`);
  if (seq !== searchSeq) return;   // a newer search is on its way
  const list = $('results');
  clear(list);
  if (!r.ok) { searchNote(r.message); return; }
  const { results, total } = r.data;
  searchNote(results.length === 0
    ? `Nothing among ${total.toLocaleString('en-US')} servers matches “${q}”.`
    : `${results.length} of ${total.toLocaleString('en-US')}, at most two per host. Click one to connect.`);
  for (const s of results) {
    list.append(h('li', {}, h('button', {
      type: 'button',
      class: 'result',
      title: s.url,
      onclick: () => { ($('url') as HTMLInputElement).value = s.url; void connect(s.url, { scroll: true }); },
    },
    h('span', { class: 'result-title' }, s.title ?? s.name),
    h('span', { class: 'result-meta' }, `${s.host} · ${toolsText(s.tools)}`),
    s.description ? h('span', { class: 'result-desc' }, s.description) : null)));
  }
}

async function main(): Promise<void> {
  const { presets, registryCount } = await loadPresets();
  // N is the server's index count, shown only once it has arrived. The plain
  // line rounds it down to the hundred, so "over" stays true.
  if (registryCount !== null) {
    $('registry-count').textContent = registryCount.toLocaleString('en-US');
    $('registry').hidden = false;
    $('plain-n').textContent = (Math.floor(registryCount / 100) * 100).toLocaleString('en-US');
    $('plain').hidden = false;
  }
  $('search').addEventListener('input', onSearchInput);
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
    void connect(($('url') as HTMLInputElement).value);
  });
  $('url').addEventListener('input', previewUrl);
  $('mic').addEventListener('click', () => void toggleTalk());
  $('replay-btn').addEventListener('click', () => void startReplay(null));
  $('paste').addEventListener('input', () => {
    if (pasteTimer) clearTimeout(pasteTimer);
    pasteTimer = setTimeout(onPasteChange, 300);
  });

  const fromQuery = new URL(location.href).searchParams.get('url');
  if (fromQuery) {
    ($('url') as HTMLInputElement).value = fromQuery;
    void connect(fromQuery);
  }
}

void main();
