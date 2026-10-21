// A small helper for building DOM without innerHTML. Text always goes in
// through textContent or text nodes, so nothing a card says can become markup.

export type Child = Node | string | null | undefined | false;

export interface Props {
  class?: string;
  text?: string;
  /** Attributes, set with setAttribute (lang, aria-*, inputmode, ...). */
  attrs?: Record<string, string>;
  on?: { [K in keyof HTMLElementEventMap]?: (e: HTMLElementEventMap[K]) => void };
  /** Anything else is assigned as a property (type, disabled, value, href, ...). */
  [prop: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, text, attrs, on, ...rest } = props;
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, v);
  for (const [k, fn] of Object.entries(on ?? {})) el.addEventListener(k, fn as EventListener);
  Object.assign(el, rest);
  append(el, ...children);
  return el;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

/** Replace everything inside `el`. */
export function replace(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, ...children);
}
