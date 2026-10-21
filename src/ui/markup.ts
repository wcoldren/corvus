// Card text is markdown-lite (SPEC.md, Input and display): `*italic*` and
// `**bold**`, nothing else. Card data never goes through innerHTML: the text
// is split into spans here, and the DOM is built from them with textContent,
// so `<b>x</b>` in a card shows as those six characters.

export type MarkupNode = string | { tag: 'em' | 'strong'; children: MarkupNode[] };

/**
 * Split text into plain runs and emphasis. A marker with no closing partner
 * stays a literal character, so "2 * 3" and an unmatched `*` read as typed.
 * Bold may hold italics and italics may hold bold, one inside the other.
 */
export function parseMarkup(text: string): MarkupNode[] {
  const out: MarkupNode[] = [];
  let plain = '';
  let i = 0;
  while (i < text.length) {
    const close = text[i] === '*' ? closing(text, i) : null;
    if (close) {
      if (plain) out.push(plain);
      plain = '';
      out.push({ tag: close.tag, children: parseMarkup(text.slice(close.start, close.end)) });
      i = close.end + close.width;
    } else {
      plain += text[i];
      i++;
    }
  }
  if (plain) out.push(plain);
  return out;
}

/** Where the span opened at `i` closes, or null if it doesn't (or would be empty). */
function closing(text: string, i: number): { tag: 'em' | 'strong'; start: number; end: number; width: number } | null {
  if (text.startsWith('**', i)) {
    const end = text.indexOf('**', i + 2);
    if (end > i + 2) return { tag: 'strong', start: i + 2, end, width: 2 };
  }
  // A single `*`: the next `*` that isn't one half of a `**`.
  let j = i + 1;
  while (j < text.length) {
    if (text.startsWith('**', j)) {
      const end = text.indexOf('**', j + 2);
      if (end < 0) break;
      j = end + 2;
    } else if (text[j] === '*') {
      return j > i + 1 ? { tag: 'em', start: i + 1, end: j, width: 1 } : null;
    } else j++;
  }
  return null;
}

/**
 * The DOM for card text. In a field written in the learner's language,
 * italic spans are target-language words (SPEC.md, "Which language each
 * field is in"), so `emLang` marks them for the browser and for styling.
 */
export function renderMarkup(text: string, emLang?: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const build = (nodes: MarkupNode[], parent: Node) => {
    for (const n of nodes) {
      if (typeof n === 'string') parent.appendChild(document.createTextNode(n));
      else {
        const el = document.createElement(n.tag);
        if (n.tag === 'em' && emLang) {
          el.lang = emLang;
          el.className = 'target';
        }
        build(n.children, el);
        parent.appendChild(el);
      }
    }
  };
  build(parseMarkup(text), frag);
  return frag;
}
