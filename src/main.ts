// The entry script. It loads only what the recovery screen needs, then the
// app itself, so that if the app fails to load or start, the recovery screen
// can still export the data (SPEC.md, Recovery).

import './style.css';
import { recordError } from './errors.ts';
import { showRecovery } from './ui/recovery.ts';

addEventListener('error', (e) => recordError(e.error ?? e.message));
addEventListener('unhandledrejection', (e) => recordError(e.reason));

const root = document.querySelector<HTMLElement>('#app')!;
import('./start.ts')
  .then((m) => m.start(root))
  .catch((e: unknown) => showRecovery(root, e));
