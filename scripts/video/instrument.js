// Runs in the captured page before the page's own scripts (Playwright
// addInitScript). Harness only: it logs and records. It changes nothing the
// page shows, except the one-frame white sync flash at the start and end of a
// capture, which the edit cuts.
//
// - The fake microphone: getUserMedia returns a fresh MediaStreamDestination
//   from a 48 kHz harness AudioContext on every call; named caller clips play
//   into it on the harness's say-so.
// - Two recorders, both AudioWorklets: "caller" is what the fake mic sends,
//   "agent" is everything the page connects to an AudioContext destination,
//   tapped in the page's own context. Chunks go to the harness with their
//   context frame, and each context's getOutputTimestamp is sampled every
//   250 ms so every sample lands on the same epoch clock as the video frames.
// - The event log: WebSocket and fetch, with the token stripped from every URL
//   and no request header or token body ever read; DOM snapshots of the
//   parts the edit needs (hint, calls, gate card, phase chips, lines, status),
//   with rects for punch-ins; mouse, keys, scroll and the page's URL.
(() => {
  if (window.__cap) return;
  const now = () => performance.timeOrigin + performance.now();
  const send = (e) => { try { window.__capLog(e); } catch { /* binding not ready */ } };
  const log = (type, data) => send({ t: now(), type, ...(data || {}) });
  const cap = (window.__cap = { now, log });

  // ------------------------------------------------------------ recorders
  const REC = `class CapRec extends AudioWorkletProcessor {
    constructor() { super(); this.size = 4800; this.buf = new Float32Array(this.size); this.n = 0; this.start = -1; }
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      const len = ch ? ch.length : 128;
      if (this.start < 0) this.start = currentFrame;
      for (let i = 0; i < len; i++) {
        this.buf[this.n++] = ch ? ch[i] : 0;
        if (this.n === this.size) {
          this.port.postMessage({ frame: this.start, data: this.buf }, [this.buf.buffer]);
          this.buf = new Float32Array(this.size); this.n = 0; this.start = currentFrame + i + 1;
        }
      }
      return true;
    }
  }
  registerProcessor('cap-rec', CapRec);`;
  const recUrl = URL.createObjectURL(new Blob([REC], { type: 'application/javascript' }));
  const toB64 = (f32) => {
    const u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  let ctxCount = 0;
  const watchClock = (ctx, id, stem) => {
    const tick = () => {
      if (ctx.state === 'closed') { log('audio.closed', { ctx: id, stem }); return; }
      const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
      if (ts && ts.performanceTime > 0) {
        try { window.__capClock({ ctx: id, stem, contextTime: ts.contextTime, performanceTime: ts.performanceTime, timeOrigin: performance.timeOrigin, rate: ctx.sampleRate, baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency }); } catch { /* */ }
      }
      setTimeout(tick, 250);
    };
    tick();
  };
  const recorder = async (ctx, id, stem) => {
    await ctx.audioWorklet.addModule(recUrl);
    const node = new AudioWorkletNode(ctx, 'cap-rec', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    node.port.onmessage = (ev) => { try { window.__capAudio(stem, id, ev.data.frame, ctx.sampleRate, toB64(ev.data.data)); } catch { /* */ } };
    watchClock(ctx, id, stem);
    log('audio.recorder', { ctx: id, stem, rate: ctx.sampleRate });
    return node;
  };

  const OrigAC = window.AudioContext;
  const origConnect = AudioNode.prototype.connect;

  // The harness's own context: the fake mic and the caller recorder. It runs at
  // the clips' own 24 kHz: at 48 kHz Chromium resamples an AudioBuffer by linear
  // interpolation and the page's mic got the clip at 30.9 dB SNR; at 24 kHz it
  // gets it bit for bit (measured, see BUILDLOG).
  let H = null;
  const harness = async () => {
    if (H) return H;
    const ctx = new OrigAC({ sampleRate: 24000 });
    const id = 0;
    const bus = ctx.createGain();
    H = { ctx, id, bus, clips: new Map(), rec: null };
    H.rec = await recorder(ctx, id, 'caller');
    origConnect.call(bus, H.rec);
    if (ctx.state !== 'running') await ctx.resume();
    return H;
  };
  // "running" comes before the output device does: wait until the output clock advances.
  cap.ready = async () => {
    const h = await harness();
    const t0 = performance.now();
    for (;;) {
      const ts = h.ctx.getOutputTimestamp();
      if (ts.performanceTime > 0 && ts.contextTime > 0.2) break;
      if (performance.now() - t0 > 10000) throw new Error('the harness audio clock did not start within 10 s');
      await new Promise((r) => setTimeout(r, 50));
    }
    return { state: h.ctx.state, rate: h.ctx.sampleRate, waitedMs: Math.round(performance.now() - t0) };
  };

  // Every page context gets an id; the one that reaches a destination is tapped.
  window.AudioContext = class extends OrigAC {
    constructor(...a) { super(...a); this.__capId = ++ctxCount; log('audio.context', { ctx: this.__capId, rate: this.sampleRate }); }
  };
  const tapped = new WeakMap();
  const micTapped = new WeakSet();
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = origConnect.call(this, dest, ...rest);
    try {
      if (dest instanceof AudioDestinationNode && (!H || this.context !== H.ctx)) {
        const ctx = this.context;
        const node = this;
        if (!tapped.has(ctx)) tapped.set(ctx, recorder(ctx, ctx.__capId ?? -1, 'agent'));
        tapped.get(ctx).then((rec) => { origConnect.call(node, rec); log('agent.tap', { ctx: ctx.__capId ?? -1 }); });
      }
      // What the page's own mic path receives, recorded as evidence only.
      if (this instanceof MediaStreamAudioSourceNode && (!H || this.context !== H.ctx) && !micTapped.has(this)) {
        micTapped.add(this);
        const ctx = this.context;
        const node = this;
        recorder(ctx, ctx.__capId ?? -1, 'pagemic').then((rec) => { origConnect.call(node, rec); log('pagemic.tap', { ctx: ctx.__capId ?? -1, rate: ctx.sampleRate }); });
      }
    } catch (e) { log('tap.error', { message: String(e) }); }
    return r;
  };
  // Media elements are not used in a live session; if one plays, the take is flagged.
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) { log('media.play', { src: String(this.currentSrc || this.src || '').slice(0, 120) }); return origPlay.apply(this, a); };

  // The fake microphone: a fresh stream per call.
  if (navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const h = await harness();
      const dest = h.ctx.createMediaStreamDestination();
      dest.channelCount = 1;
      origConnect.call(h.bus, dest);
      log('mic.getUserMedia', { audio: !!(constraints && constraints.audio) });
      return dest.stream;
    };
  }
  cap.loadClip = async (id, b64, rate) => {
    const h = await harness();
    const bin = atob(b64);
    const n = bin.length >> 1;
    const buf = h.ctx.createBuffer(1, n, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v >= 0x8000) v -= 0x10000; ch[i] = v / 32768; }
    h.clips.set(id, buf);
    return { id, seconds: buf.duration };
  };
  cap.playClip = async (id) => {
    const h = await harness();
    const buf = h.clips.get(id);
    if (!buf) throw new Error(`no clip ${id}`);
    const src = h.ctx.createBufferSource();
    src.buffer = buf;
    origConnect.call(src, h.bus);
    const when = h.ctx.currentTime + 0.05;
    src.start(when);
    log('clip.start', { id, ctx: 0, contextTime: when, seconds: buf.duration });
    await new Promise((res) => { src.onended = res; });
    log('clip.end', { id });
    return { id, contextTime: when, seconds: buf.duration };
  };

  // ------------------------------------------------------------ sync mark
  let flash = null;
  cap.sync = async (label) => {
    const h = await harness();
    if (!flash) {
      flash = document.createElement('div');
      flash.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:2147483647;display:none;pointer-events:none';
      document.documentElement.appendChild(flash);
    }
    const ts = h.ctx.getOutputTimestamp();
    const when = h.ctx.currentTime + 0.25;
    // When that context time is heard, on the page's clock.
    const heardAt = ts.performanceTime + (when - ts.contextTime) * 1000;
    const osc = h.ctx.createOscillator();
    osc.frequency.value = 1000;
    const g = h.ctx.createGain();
    g.gain.value = 0.5;
    origConnect.call(osc, g);
    origConnect.call(g, h.bus);
    osc.start(when);
    osc.stop(when + 0.02);
    log('sync.beep', { label, ctx: 0, contextTime: when, heardAt: performance.timeOrigin + heardAt });
    await new Promise((res) => setTimeout(res, Math.max(0, heardAt - performance.now() - 12)));
    await new Promise((res) => requestAnimationFrame(() => { flash.style.display = 'block'; log('sync.flash.on', { label }); res(); }));
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    flash.style.display = 'none';
    log('sync.flash.off', { label });
    return { when };
  };

  // ------------------------------------------------------------ network
  const stripToken = (u) => String(u).replace(/([?&])token=[^&#]*/gi, '$1token=STRIPPED');
  const OrigWS = window.WebSocket;
  window.WebSocket = class extends OrigWS {
    constructor(url, protocols) {
      super(url, protocols);
      log('ws.open', { url: stripToken(url) });
      let audioCount = 0;
      let audioBytes = 0;
      this.addEventListener('message', (ev) => {
        let m;
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        switch (m.type) {
          case 'reply.audio': {
            const b = String(m.data || '');
            audioBytes += Math.floor((b.length * 3) / 4);
            if (audioCount++ === 0) log('ws.in', { msg: 'reply.audio.first', reply_id: m.reply_id });
            break;
          }
          case 'transcript.user.delta': case 'transcript.agent.delta': break;
          case 'session.ready': log('ws.in', { msg: m.type, session_id: m.session_id }); break;
          case 'transcript.user': log('ws.in', { msg: m.type, text: m.text }); break;
          case 'transcript.agent': log('ws.in', { msg: m.type, text: m.text, reply_id: m.reply_id, interrupted: m.interrupted === true }); break;
          case 'reply.started': audioCount = 0; audioBytes = 0; log('ws.in', { msg: m.type, reply_id: m.reply_id }); break;
          case 'reply.done': log('ws.in', { msg: m.type, reply_id: m.reply_id, status: m.status, audioBytes }); break;
          case 'tool.call': log('ws.in', { msg: m.type, call_id: m.call_id, name: m.name, arguments: m.arguments }); break;
          case 'session.error': log('ws.in', { msg: m.type, code: m.code, message: m.message }); break;
          default: log('ws.in', { msg: m.type });
        }
      });
      this.addEventListener('close', (ev) => log('ws.close', { code: ev.code }));
      const origSend = this.send.bind(this);
      this.send = (data) => {
        let m = null;
        try { m = JSON.parse(String(data)); } catch { /* not JSON */ }
        if (m && m.type !== 'input.audio') {
          if (m.type === 'session.update') {
            const s = m.session || {};
            log('ws.out', { msg: m.type, tools: Array.isArray(s.tools) ? s.tools.map((x) => x.name) : undefined, keyterms: s.input && s.input.keyterms, greeting: s.greeting, voice: s.output && s.output.voice });
          } else if (m.type === 'tool.result') {
            log('ws.out', { msg: m.type, call_id: m.call_id, chars: String(m.result || '').length });
          } else log('ws.out', { msg: m.type });
        }
        return origSend(data);
      };
    }
  };
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname;
    let body;
    try {
      const b = init && typeof init.body === 'string' ? JSON.parse(init.body) : null;
      if (b && path === '/api/mcp/call') body = { tool: b.tool, arguments: b.arguments, session: b.session };
      else if (b && path === '/api/mcp/find-tools') body = { query: b.query };
      else if (b && path === '/api/mcp/connect') body = { url: b.url };
    } catch { /* not JSON */ }
    const t0 = now();
    const id = Math.random().toString(36).slice(2, 8);
    log('fetch.start', { id, path, query: path === '/api/registry/search' ? url.search : undefined, body });
    try {
      const res = await origFetch(input, init);
      log('fetch.done', { id, path, status: res.status, ms: Math.round(now() - t0) });
      // The server's own timings for a tool call, for the latency breakdown; never the result text.
      if (path === '/api/mcp/call') {
        res.clone().json().then((j) => log('mcp.timing', { id, mcpMs: j.mcpMs, totalMs: j.totalMs, refineMs: j.refineMs, refine: j.refine, method: j.method, shaped: j.shaped, isError: j.isError })).catch(() => undefined);
      }
      return res;
    } catch (e) {
      log('fetch.fail', { id, path, message: String(e), ms: Math.round(now() - t0) });
      throw e;
    }
  };

  // ------------------------------------------------------------ page state
  const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const shown = (el) => !!el && !el.hidden && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
  const q = (s) => document.querySelector(s);
  const snap = {
    hint: () => { const el = q('#url-hint'); return { shown: shown(el), text: el ? el.textContent : '', rect: rectOf(el), font: el ? getComputedStyle(el).fontSize : null }; },
    calls: () => [...document.querySelectorAll('#calls .call')].map((li) => ({
      name: li.querySelector('.call-name') ? li.querySelector('.call-name').textContent : '',
      meta: li.querySelector('.call-meta') ? li.querySelector('.call-meta').textContent : '',
      args: li.querySelector('.call-args') ? li.querySelector('.call-args').textContent : '',
      spoken: li.querySelector('.call-spoken') ? li.querySelector('.call-spoken').textContent : '',
      cls: li.className, rect: rectOf(li), argsRect: rectOf(li.querySelector('.call-args')),
    })),
    gate: () => { const el = q('#gate-card'); return { shown: shown(el), kind: el ? el.dataset.kind : null, kindText: q('#gate-kind') ? q('#gate-kind').textContent : '', tool: q('#gate-tool') ? q('#gate-tool').textContent : '', value: q('#gate-value') ? q('#gate-value').textContent : '', say: q('#gate-say') ? q('#gate-say').textContent : '', rect: rectOf(el) }; },
    chips: () => ({ chips: [...document.querySelectorAll('#phase-tools .chip')].map((c) => ({ name: c.textContent, isNew: c.classList.contains('new') })), rect: rectOf(q('#phase-tools')) }),
    lines: () => [...document.querySelectorAll('#lines .line')].map((l) => ({ who: l.className.replace('line', '').trim(), text: l.querySelector('.text') ? l.querySelector('.text').textContent : '' })),
    ui: () => ({ status: q('#status') ? q('#status').textContent : '', server: q('#server-name') ? q('#server-name').textContent : '', connect: q('#connect-btn') ? q('#connect-btn').textContent : '', sample: q('#sample-btn') ? q('#sample-btn').textContent : '', paste: q('#paste') ? q('#paste').value : '', scrollY, results: [...document.querySelectorAll('#results .result')].slice(0, 3).map((r) => ({ text: r.textContent.trim().replace(/\s+/g, ' ').slice(0, 80), rect: rectOf(r) })) }),
  };
  cap.snapshot = () => ({ hint: snap.hint(), calls: snap.calls(), gate: snap.gate(), chips: snap.chips(), lines: snap.lines(), ui: snap.ui(), rects: Object.fromEntries(['#url', '#connect-btn', '#search', '#mic', '#paste', '#sample-btn', '#talk', '#panes', '#calls', '#lines', '#server', '#presets'].map((s) => [s, rectOf(q(s))])) });
  const last = {};
  const emit = (name) => {
    const v = snap[name]();
    const k = JSON.stringify(v);
    if (last[name] === k) return;
    last[name] = k;
    log(`dom.${name}`, { v });
  };
  let pending = null;
  const schedule = () => { if (pending) return; pending = setTimeout(() => { pending = null; for (const n of Object.keys(snap)) emit(n); }, 30); };
  const start = () => {
    new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'data-kind', 'data-state'] });
    schedule();
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
  let scrollTimer = null;
  addEventListener('scroll', () => { if (scrollTimer) clearTimeout(scrollTimer); scrollTimer = setTimeout(() => { log('scroll', { y: scrollY }); schedule(); }, 60); }, { passive: true });
  addEventListener('mousemove', (e) => log('mouse', { x: e.clientX, y: e.clientY }), { passive: true, capture: true });
  addEventListener('mousedown', (e) => log('mousedown', { x: e.clientX, y: e.clientY }), { capture: true });
  addEventListener('mouseup', (e) => log('mouseup', { x: e.clientX, y: e.clientY }), { capture: true });
  addEventListener('keydown', (e) => log('key', { key: e.key.length === 1 || ['Enter', 'Backspace', 'Tab'].includes(e.key) ? e.key : e.key === 'Meta' || e.key === 'Control' ? e.key : 'other', meta: e.metaKey, ctrl: e.ctrlKey }), { capture: true });
  addEventListener('paste', (e) => { const text = e.clipboardData ? e.clipboardData.getData('text') : ''; log('paste', { chars: text.length, text: /^0x[0-9a-fA-F]{40}$/.test(text) ? text : undefined }); }, { capture: true });
  const hist = (fn) => function (...a) { const r = fn.apply(this, a); log('url', { href: location.href }); return r; };
  history.replaceState = hist(history.replaceState);
  history.pushState = hist(history.pushState);
  addEventListener('DOMContentLoaded', () => log('url', { href: location.href }));
  addEventListener('error', (e) => log('page.error', { message: String(e.message || e) }));
  addEventListener('unhandledrejection', (e) => log('page.rejection', { message: String(e.reason && e.reason.message || e.reason) }));
})();
