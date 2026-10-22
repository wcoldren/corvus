// Starting the app. main.ts loads this with a dynamic import, so an error
// anywhere in the app's modules, including one thrown while they load,
// lands in main.ts's catch and the recovery screen instead of a blank page.

import { Shell } from './app.ts';
import { recordError } from './errors.ts';
import { homeScreen } from './ui/home.ts';
import { reviewScreen } from './ui/review.ts';
import { settingsScreen } from './ui/settings.ts';

// The review screen is laid out within the visible viewport, so nothing sits
// behind the on-screen keyboard (SPEC.md, Input and display).
function trackViewport(): void {
  const vv = window.visualViewport;
  const set = () => document.documentElement.style.setProperty('--vvh', `${vv ? vv.height : innerHeight}px`);
  vv?.addEventListener('resize', set);
  addEventListener('resize', set);
  set();
}

/** Ask the browser not to evict our data. The result is shown in Settings. */
async function persistStorage(): Promise<void> {
  try {
    if (navigator.storage && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch (e) {
    recordError(e);
  }
}

/** Resolves once the first screen is showing; rejects if startup failed. */
export async function start(root: HTMLElement): Promise<void> {
  // `npm run build:startup-fail` makes the test build for acceptance
  // criterion 6. Vite drops this line from every other build.
  if (import.meta.env.MODE === 'startup-fail') throw new Error('This test build fails at startup on purpose.');
  trackViewport();
  await new Shell(root, { home: homeScreen, review: reviewScreen, settings: settingsScreen }).start();
  void persistStorage();
}
