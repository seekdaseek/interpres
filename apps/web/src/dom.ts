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
 * Scroll an element into view: smoothly where the browser animates it, with a
 * jump where it does not. The desktop app's embedded Chromium left a smooth
 * scroll where it started (a card still 1,087 px down 1.5 s later, measured
 * Sep 26), so a click on a search result looked like it did nothing.
 */
export function reveal(el: HTMLElement, block: ScrollLogicalPosition = 'start'): void {
  el.scrollIntoView({ behavior: 'smooth', block });
  setTimeout(() => {
    const top = el.getBoundingClientRect().top;
    if (top < -1 || top > window.innerHeight - 40) el.scrollIntoView({ block });
  }, 700);
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${(text.length - max).toLocaleString()} more characters)`;
}
