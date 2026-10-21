import './style.css';
import { Shell } from './app.ts';
import { recordError } from './errors.ts';
import { homeScreen } from './ui/home.ts';
import { reviewScreen } from './ui/review.ts';
import { settingsScreen } from './ui/settings.ts';

addEventListener('error', (e) => recordError(e.error ?? e.message));
addEventListener('unhandledrejection', (e) => recordError(e.reason));

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

const root = document.querySelector<HTMLElement>('#app')!;
try {
  trackViewport();
  new Shell(root, { home: homeScreen, review: reviewScreen, settings: settingsScreen }).start();
  void persistStorage();
} catch (e) {
  // The recovery screen replaces this (SPEC.md, Recovery).
  recordError(e);
  root.textContent = `Corvus could not start: ${e instanceof Error ? e.message : String(e)}`;
}
