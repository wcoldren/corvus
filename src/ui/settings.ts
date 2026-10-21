import type { App, Screen } from '../app.ts';
import { h } from './dom.ts';

export async function settingsScreen(_app: App): Promise<Screen> {
  return { el: h('section', { class: 'settings' }, h('h1', { text: 'Settings' })) };
}
