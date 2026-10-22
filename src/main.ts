// The entry script. It loads only what the recovery screen needs, then the
// app itself, so that if the app fails to load or start, the recovery screen
// can still export the data (SPEC.md, Recovery).

import './style.css';
import { recordError } from './errors.ts';
import { startUpdates } from './sw/updates.ts';
import { showRecovery } from './ui/recovery.ts';

addEventListener('error', (e) => recordError(e.error ?? e.message));
addEventListener('unhandledrejection', (e) => recordError(e.reason));

/**
 * Ask the browser not to evict our data. The result is shown in Settings.
 * Asked here, before the app loads, so a failed startup (when the data is
 * most at risk) still asks.
 */
async function persistStorage(): Promise<void> {
  try {
    if (navigator.storage && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch (e) {
    recordError(e);
  }
}

void persistStorage();
const updates = startUpdates();

const root = document.querySelector<HTMLElement>('#app')!;
import('./start.ts')
  .then((m) => m.start(root, updates))
  .catch((e: unknown) => showRecovery(root, e));
