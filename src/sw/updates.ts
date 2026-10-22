// Registering the service worker and noticing new versions (SPEC.md,
// Updates). A Home Screen app on iPadOS often resumes instead of launching,
// so the app asks for a new version at start and whenever it comes back,
// at most once every 10 minutes. The worker takes over as soon as it has
// installed; the shell decides when the page reloads into it.
//
// main.ts starts this before the app loads, so a fixed build still reaches a
// device whose app fails at startup.

import { recordError } from '../errors.ts';

export interface NewVersion {
  /** The new build's newest lesson, or null if it couldn't be read. */
  newestLesson: number | null;
}

export type CheckResult = 'found' | 'current' | 'failed' | 'off';

export interface Updates {
  /** Ask for a new version now, whenever the last check was. */
  check(): Promise<CheckResult>;
  /** Called once a new version controls this page (at once if one already does). */
  onReady(ready: (version: NewVersion) => void): void;
}

const SPACING_MS = 10 * 60_000;

/** Development builds never register a worker, so they never cache. */
const off: Updates = {
  check: () => Promise.resolve('off'),
  onReady: () => {},
};

/** What the new worker's cache says about its build. */
async function readVersion(base: string): Promise<NewVersion> {
  try {
    const res = await fetch(`${base}version.json`, { cache: 'no-store' });
    const v = (await res.json()) as { newestLesson?: unknown };
    return { newestLesson: typeof v.newestLesson === 'number' ? v.newestLesson : null };
  } catch {
    return { newestLesson: null };
  }
}

export function startUpdates(): Updates {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return off;
  const container = navigator.serviceWorker;
  const base = import.meta.env.BASE_URL;
  // 'none': the browser checks sw.js itself, never an HTTP-cached copy.
  const registration = container.register(`${base}sw.js`, { scope: base, updateViaCache: 'none' });
  registration.catch(recordError);

  let ready: NewVersion | null = null;
  let listener: ((version: NewVersion) => void) | null = null;
  // The first worker also takes control of the page that installed it, but
  // that is an install, not a new version.
  let controlled = container.controller !== null;
  container.addEventListener('controllerchange', () => {
    if (!controlled) {
      controlled = true;
      return;
    }
    void readVersion(base).then((v) => {
      ready = v;
      listener?.(v);
    });
  });

  let lastCheck = 0;
  async function check(): Promise<CheckResult> {
    lastCheck = Date.now();
    try {
      const reg = await registration;
      await reg.update();
      return ready || reg.installing || reg.waiting ? 'found' : 'current';
    } catch {
      // Offline, most likely. Forget this try, so the next resume tries
      // again instead of waiting out the spacing.
      lastCheck = 0;
      return 'failed';
    }
  }

  const spaced = () => {
    if (Date.now() - lastCheck >= SPACING_MS) void check();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') spaced();
  });
  addEventListener('pageshow', (e) => {
    if (e.persisted) spaced();
  });
  void check();

  return {
    check,
    onReady: (fn) => {
      listener = fn;
      if (ready) fn(ready);
    },
  };
}
