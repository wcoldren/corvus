// The key bar (SPEC.md, Input and display): the pack's inputKeys as buttons
// above a target-language answer. A key inserts at the caret. It acts on
// pointerdown and cancels the default, so the input never loses focus and
// the on-screen keyboard stays up.

import { h } from './dom.ts';

export function keyBar(keys: readonly string[], input: HTMLInputElement, lang: string): HTMLElement {
  const insert = (key: string) => {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.setRangeText(key, start, end, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  return h('div', { class: 'keybar', attrs: { role: 'group', 'aria-label': 'Letters with marks' } },
    ...keys.map((key) =>
      h('button', {
        type: 'button',
        class: 'key target',
        text: key,
        attrs: { lang, tabindex: '-1' },
        on: {
          pointerdown: (e) => {
            e.preventDefault();
            insert(key);
          },
          // Keyboard and switch users activate with click, not pointerdown.
          click: (e) => {
            if (e.detail === 0) insert(key);
          },
        },
      }),
    ),
  );
}
