// The review screen (SPEC.md, Screens: Review, and Input and display). The
// session logic lives in src/review/run.ts; this file draws it and wires the
// taps and keys.
//
// Focus matters on the iPad: the keyboard shows only when an input is
// focused synchronously inside a tap. So a rating moves to the next card and
// focuses its input before the save finishes (run.rate saves in the
// background), and a save that fails stops the screen afterwards.

import type { App, Screen } from '../app.ts';
import type { Card } from '../cards/types.ts';
import type { CorpusForm, Verdict } from '../check/answer.ts';
import { CardChangedError } from '../db/history.ts';
import { recordError } from '../errors.ts';
import type { LanguagePack } from '../pack/types.ts';
import { formatInterval, RATINGS } from '../review/intervals.ts';
import { ReviewRun } from '../review/run.ts';
import type { Turn } from '../review/turn.ts';
import type { Rating } from '../scheduler.ts';
import { h, replace, type Child } from './dom.ts';
import { keyBar } from './keybar.ts';
import { renderMarkup } from './markup.ts';
import { routeHash } from './router.ts';

const RATING_LABEL: Record<Rating, string> = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };

/**
 * Whether a card's prompt is in the target language (SPEC.md, "Which
 * language each field is in"): vocab, parse and phrase prompts are, and so
 * is a cloze sentence; a reverse card's prompt is the forward card's answer.
 */
function promptIsTarget(card: Card): boolean {
  if (card.reverse) return false;
  if (card.type === 'ending') return card.tags.includes('cloze');
  return card.type === 'vocab' || card.type === 'parse' || card.type === 'phrase';
}

/** "Ablative singular" for a corpus form's cell, from the pack's grid labels. */
function formLabel(pack: LanguagePack, f: CorpusForm): string {
  if (!f.cells.length) return 'the dictionary form';
  const gridId = f.grid ?? (f.paradigm ? pack.paradigms[f.paradigm]?.grid : undefined);
  const grid = gridId ? pack.grids[gridId] : undefined;
  return f.cells
    .map((cell) => {
      const [row, col] = cell.split('.');
      const r = grid?.rows.find((x) => x.id === row)?.label;
      const c = grid?.cols.find((x) => x.id === col)?.label;
      return r && c ? `${r} ${c.toLocaleLowerCase(pack.learner.lang)}` : cell;
    })
    .join(' or ');
}

export async function reviewScreen(app: App): Promise<Screen> {
  const { pack } = app;
  const open = () => ReviewRun.open({ db: app.db, cards: app.cards, buildId: app.buildId, zone: app.zone, now: app.now });
  let run = await open();
  // Don't announce the goal if it was already reached before this session.
  let goalShown = run.usedMs >= run.goalMs;
  let disposed = false;

  const progress = h('p', { class: 'progress muted', attrs: { 'aria-live': 'polite' } });
  const undoButton = h('button', { text: 'Undo', on: { click: () => void undo() } });
  const body = h('div', { class: 'review-body' });
  const el = h('section', { class: 'review' },
    h('nav', { class: 'top' },
      h('a', { class: 'button', href: routeHash('home'), text: 'Home' }),
      progress,
      undoButton,
    ),
    body,
  );

  function updateHeader(): void {
    const used = Math.floor(run.usedMs / 60_000);
    progress.textContent = `${run.remaining} left · ${used} of ${run.settings.goalMin} min`;
    undoButton.disabled = !run.canUndo;
  }

  /** Show whatever comes next: the goal notice, the next card, or the end. */
  function advance(): void {
    if (disposed) return;
    updateHeader();
    if (!goalShown && run.answeredCount > 0 && run.usedMs >= run.goalMs) {
      goalShown = true;
      return showGoal();
    }
    const turn = run.next();
    updateHeader();
    if (!turn) return showEnd();
    guard(turn, () => showAsk(turn));
  }

  /** A card that throws while shown or checked is skipped, and nothing is logged (SPEC.md, Recovery). */
  function guard(turn: Turn, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      recordError(e);
      app.notice(`Skipped a card that could not be shown (${turn.card.id}).`);
      run.skip();
      advance();
    }
  }

  function showGoal(): void {
    replace(body,
      h('div', { class: 'card stack goal' },
        h('p', { class: 'big', text: 'Goal reached: stop here or keep going.' }),
        h('div', { class: 'row' },
          h('a', { class: 'button', href: routeHash('home'), text: 'Stop here' }),
          h('button', { class: 'primary', text: 'Keep going', on: { click: () => advance() } }),
        ),
      ),
    );
  }

  function showEnd(): void {
    const n = run.answeredCount;
    replace(body,
      h('div', { class: 'card stack end' },
        h('p', { class: 'big', text: n ? 'That is everything for now.' : 'Nothing is due right now.' }),
        n > 0 && h('p', { text: `${n} answered this session · ${Math.round(run.usedMs / 60_000)} min today` }),
        h('a', { class: 'button primary', href: routeHash('home'), text: 'Home' }),
      ),
    );
  }

  function promptBlock(card: Card): HTMLElement {
    const target = promptIsTarget(card);
    const prompt = h('p', {
      class: target ? 'prompt target' : 'prompt',
      attrs: { lang: target ? pack.code : pack.learner.lang },
    });
    prompt.append(renderMarkup(card.prompt, target ? undefined : pack.code));
    const ask =
      card.reverse ? `In ${pack.name}?`
      : card.type === 'vocab' ? 'Meaning?'
      : card.type === 'phrase' ? 'Translate.'
      : null;
    return h('div', { class: 'prompt-block' }, ask && h('p', { class: 'muted ask', text: ask }), prompt);
  }

  function hintBlock(turn: Turn): HTMLElement | null {
    const hint = turn.card.hint;
    if (!hint) return null;
    const box = h('div', { class: 'hint' });
    const button = h('button', {
      type: 'button',
      text: 'Hint',
      on: {
        click: () => {
          turn.showHint();
          const p = h('p', { class: 'hint-text', attrs: { lang: pack.learner.lang } });
          p.append(renderMarkup(hint, pack.code));
          replace(box, p);
          box.parentElement?.querySelector('input')?.focus();
        },
      },
    });
    box.append(button);
    return box;
  }

  function showAsk(turn: Turn): void {
    const { card } = turn;
    const parts: Child[] = [promptBlock(card)];
    if (card.mode === 'typed') {
      const target = card.answerLang === 'target';
      const input = h('input', {
        type: 'text',
        attrs: {
          lang: target ? pack.code : pack.learner.lang,
          autocapitalize: 'none',
          autocorrect: 'off',
          spellcheck: 'false',
          autocomplete: 'off',
          enterkeyhint: 'go',
          'aria-label': 'Your answer',
        },
      });
      if (target) input.classList.add('target');
      const form = h('form', {
        class: 'answer stack',
        on: {
          submit: (e) => {
            e.preventDefault();
            guard(turn, () => {
              turn.submit(input.value, { ignoreWords: pack.learner.ignoreWords, forms: app.forms }, app.now());
              showFeedback(turn);
            });
          },
        },
      },
        target && pack.inputKeys.length ? keyBar(pack.inputKeys, input, pack.code) : null,
        input,
        h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit', text: 'Check' }), hintBlock(turn)),
      );
      parts.push(form);
      replace(body, ...parts);
      input.focus();
    } else {
      parts.push(
        h('div', { class: 'row' },
          h('button', { class: 'primary reveal', text: 'Show answer', on: { click: () => reveal(turn) } }),
          hintBlock(turn),
        ),
      );
      replace(body, ...parts);
    }
  }

  function reveal(turn: Turn): void {
    if (turn.answered) return;
    guard(turn, () => {
      turn.reveal(app.now());
      showFeedback(turn);
    });
  }

  function verdictLine(v: Verdict): HTMLElement {
    switch (v.kind) {
      case 'correct':
        return h('p', { class: 'verdict good', text: '✓ Correct' });
      case 'slip':
        return h('p', { class: 'verdict good', text: '✓ Right word, check the marks' });
      case 'wrongForm':
        return h('p', { class: 'verdict bad', text: '✗ That is another form' });
      case 'wrong':
        return h('p', { class: 'verdict bad', text: v.strict ? '✗ The marks make a different word here' : '✗ Not this time' });
    }
  }

  /** The expected answer, with the letters whose marks were missed underlined. */
  function expected(card: Card, v: Verdict | null): HTMLElement {
    const lang = card.answerLang === 'target' ? pack.code : pack.learner.lang;
    const p = h('p', { class: card.answerLang === 'target' ? 'expected target' : 'expected', attrs: { lang } });
    if (v?.kind === 'slip' && v.diff.length) {
      const marked = new Set(v.diff);
      Array.from(v.matched).forEach((ch, i) => p.append(marked.has(i) ? h('mark', { text: ch }) : ch));
    } else if (typeof card.answer === 'string') {
      p.append(renderMarkup(card.answer, card.answerLang === 'learner' ? pack.code : undefined));
    }
    return p;
  }

  function showFeedback(turn: Turn): void {
    const { card, verdict } = turn;
    const parts: Child[] = [promptBlock(card)];
    const fb = h('div', { class: 'feedback stack', attrs: { 'aria-live': 'polite' } });
    if (verdict) {
      fb.append(verdictLine(verdict));
      if (verdict.kind !== 'correct' && turn.response?.trim()) {
        fb.append(h('p', { class: 'muted' }, 'You typed: ', h('span', { class: 'typed', text: turn.response })));
      }
      if (verdict.kind === 'wrongForm') {
        const labels = [...new Set(verdict.forms.map((f) => `${f.form}: ${formLabel(pack, f)}`))];
        fb.append(h('p', { class: 'muted', text: labels.join('; ') }));
      }
    }
    fb.append(expected(card, verdict));
    // A reverse card shows the whole dictionary entry, so the genitive and
    // gender are seen every time (SPEC.md, Card types).
    if (card.reverse) fb.append(h('p', { class: 'target', attrs: { lang: pack.code }, text: card.source.prompt }));
    if (card.mode === 'reveal' && card.accept.length) {
      fb.append(h('p', { class: 'muted', attrs: { lang: pack.learner.lang }, text: `also: ${card.accept.join(', ')}` }));
    }
    if (card.notes) {
      const notes = h('p', { class: 'notes', attrs: { lang: pack.learner.lang } });
      notes.append(renderMarkup(card.notes, pack.code));
      fb.append(notes);
    }
    parts.push(fb);

    const previews = run.previews();
    let suggestedButton: HTMLButtonElement | null = null;
    const buttons = RATINGS.map((r) => {
      const b = h('button', {
        class: r === turn.suggested ? 'rate primary suggested' : 'rate',
        on: { click: () => rate(r) },
      },
        h('span', { text: RATING_LABEL[r] }),
        previews && h('small', { text: formatInterval(previews[r]) }),
      );
      if (r === turn.suggested) suggestedButton = b;
      return b;
    });
    parts.push(h('div', { class: 'ratings', attrs: { role: 'group', 'aria-label': 'Rate' } }, ...buttons));
    replace(body, ...parts);
    // Return accepts the suggestion: the suggested button holds focus.
    (suggestedButton as HTMLButtonElement | null)?.focus();
  }

  function rate(r: Rating): void {
    if (!run.current?.answered) return;
    run.rate(r).catch(onWriteError);
    advance();
  }

  async function undo(): Promise<void> {
    undoButton.disabled = true;
    try {
      const card = await run.undo();
      if (!card) app.notice('Nothing to undo in this session.');
      advance();
    } catch (e) {
      await onWriteError(e);
    }
  }

  async function onWriteError(e: unknown): Promise<void> {
    if (!(e instanceof CardChangedError)) return app.fail(e);
    app.notice('A card changed elsewhere, so the session was rebuilt.');
    try {
      await run.reload();
      advance();
    } catch (err) {
      app.fail(err);
    }
  }

  function onKey(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target instanceof HTMLInputElement) return;
    const turn = run.current;
    if (!turn) return;
    if (!turn.answered && turn.card.mode === 'reveal' && e.key === ' ') {
      e.preventDefault();
      reveal(turn);
    } else if (turn.answered && ['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault();
      rate(Number(e.key) as Rating);
    }
  }

  async function onVisibility(): Promise<void> {
    const now = app.now();
    if (document.visibilityState === 'hidden') return run.current?.watch.pause(now);
    run.current?.watch.resume(now);
    if (!run.isStale()) return;
    // A session begun on an earlier study day ends, and today's is planned
    // afresh from the database (SPEC.md, Days and the clock).
    try {
      await run.saved().catch(() => {});
      run = await open();
      goalShown = run.usedMs >= run.goalMs;
      app.notice('A new study day has begun.');
      advance();
    } catch (e) {
      app.fail(e);
    }
  }
  const visibility = () => void onVisibility();

  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', visibility);
  advance();

  return {
    el,
    dispose: () => {
      disposed = true;
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', visibility);
    },
  };
}
