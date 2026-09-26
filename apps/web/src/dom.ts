/**
 * A tiny DOM builder. Every string that reaches the page - tool names,
 * descriptions and results from a stranger's MCP server, and whatever the
 * speech-to-text heard - goes in as a text node. Nothing here ever assigns
 * innerHTML, so nothing an MCP server returns can run in the page.
 */
type Attrs = Record<string, string | number | boolean | undefined | ((e: Event) => void)>;
type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/**
 * Scroll an element into view, at once. Smooth scrolling was dropped after two
 * measured failures in a throttled tab (the desktop app's embedded Chromium,
 * Sep 26): it left a card 1,087 px down 1.5 s later, and when a jump followed,
 * the stalled animation fired later still and overshot by 249 px. An instant
 * scroll lands in the same place in every browser.
 */
export function reveal(el: HTMLElement, block: ScrollLogicalPosition = 'start'): void {
  el.scrollIntoView({ block });
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${(text.length - max).toLocaleString()} more characters)`;
}
