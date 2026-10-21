// Home (SPEC.md, Screens: Home). Every number comes from home.ts's model;
// this file only lays them out and wires the two buttons.

import type { App, Screen } from '../app.ts';
import { unlockLesson } from '../db/meta.ts';
import { homeModel, loadHomeData, type HomeModel } from '../home.ts';
import { h, replace } from './dom.ts';
import { routeHash } from './router.ts';

const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export async function homeScreen(app: App): Promise<Screen> {
  const el = h('section', { class: 'home stack' });

  async function render(): Promise<void> {
    const now = app.now();
    const model = homeModel(app.cards, await loadHomeData(app.db, now, app.zone), app.pack.code, now, app.zone);
    replace(el, ...view(app, model, render));
  }

  await render();
  return {
    el,
    // A new study day may have begun, or another tab may have reviewed.
    resume: () => void render().catch(app.fail),
  };
}

function view(app: App, m: HomeModel, rerender: () => Promise<void>): HTMLElement[] {
  const nothing = m.dueToday === 0 && m.newToday === 0;
  const out: HTMLElement[] = [
    h('nav', { class: 'top' },
      h('h1', { text: 'Corvus' }),
      h('a', { class: 'button', href: routeHash('settings'), text: 'Settings' }),
    ),
    h('div', { class: 'card stack' },
      h('p', { class: 'big', text: `Due today: ${m.dueToday.toLocaleString()} · about ${m.dueMin} min` }),
      h('p', { text: `New today: ${m.newToday.toLocaleString()}` }),
      m.waiting &&
        h('p', {
          class: 'muted',
          text:
            `Waiting: ${plural(m.waiting.cards, 'card')} from ` +
            (m.waiting.fromLesson === m.waiting.toLesson
              ? `Lesson ${m.waiting.fromLesson}`
              : `Lessons ${m.waiting.fromLesson} to ${m.waiting.toLesson}`) +
            (m.waiting.days !== null ? ` (about ${plural(m.waiting.days, 'day')} at this pace)` : ''),
        }),
      m.overCap > 0 &&
        h('p', { class: 'muted', text: `${plural(m.overCap, 'review')} held back by the daily cap come tomorrow.` }),
    ),
    h('div', { class: 'row' },
      h('a', {
        class: 'button primary start',
        href: routeHash('review'),
        text: nothing ? 'Nothing due' : 'Start review',
        attrs: nothing ? { 'aria-disabled': 'true' } : {},
        on: { click: (e) => nothing && e.preventDefault() },
      }),
    ),
  ];

  if (m.unlock !== null) {
    const lesson = m.unlock;
    const button = h('button', {
      text: `I've finished Lesson ${lesson}: unlock its cards`,
      on: {
        click: () => {
          button.disabled = true;
          unlockLesson(app.db, app.pack.code, lesson).then(rerender, (e: unknown) => {
            button.disabled = false;
            app.fail(e);
          });
        },
      },
    });
    out.push(h('div', { class: 'row' }, button));
  }

  const advisories = [
    m.clockBehind &&
      "This device's clock reads earlier than the newest review. Check the date and time before reviewing.",
    m.exportReminder && 'No backup for 7 days or more. Export one from Settings.',
  ].filter((a): a is string => typeof a === 'string');
  if (advisories.length) out.push(h('div', {}, ...advisories.map((text) => h('p', { class: 'advisory', text }))));
  return out;
}
