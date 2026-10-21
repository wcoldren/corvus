import type { App, Screen } from '../app.ts';
import { h } from './dom.ts';

export async function reviewScreen(_app: App): Promise<Screen> {
  return { el: h('section', { class: 'review' }, h('h1', { text: 'Review' })) };
}
