// The recovery screen (SPEC.md, Recovery), shown when startup fails. It is
// loaded with the entry script, not with the app, and reaches the data only
// through dump.ts, so a broken app module can't take the export down with it.
// Nothing here writes to the database.

import { recordError } from '../errors.ts';
import { dumpDatabase, openExisting } from '../dump.ts';
import { h, replace } from './dom.ts';
import { backupFile, filePanel } from './share.ts';

declare const __BUILD_ID__: string;

/** Export a backup without opening the app's own database code. */
async function exportBackup(): Promise<{ file: File; summary: string }> {
  const conn = await openExisting();
  if (!conn) throw new Error('There is no saved progress on this device to export.');
  try {
    return backupFile(await dumpDatabase(conn, { now: Date.now(), buildId: __BUILD_ID__ }));
  } finally {
    conn.close();
  }
}

/**
 * Unregister the service worker and delete Corvus's caches, so the next load
 * fetches the app afresh. IndexedDB (the progress) is never touched.
 */
async function clearAppCache(): Promise<void> {
  const registrations = (await navigator.serviceWorker?.getRegistrations()) ?? [];
  await Promise.all(registrations.map((r) => r.unregister()));
  const names = typeof caches === 'undefined' ? [] : await caches.keys();
  await Promise.all(names.filter((n) => n.startsWith('corvus-')).map((n) => caches.delete(n)));
}

/**
 * Reload at Home. A plain reload keeps the hash, so a screen that fails at
 * startup would fail again on every reload, with no way to reach the others.
 */
function reloadHome(): void {
  history.replaceState(null, '', location.pathname + location.search);
  location.reload();
}

const describe = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export function showRecovery(root: HTMLElement, error: unknown): void {
  recordError(error);
  console.error(error);
  const status = h('p', { class: 'muted', attrs: { 'aria-live': 'polite' } });
  const say = (text: string) => (status.textContent = text);
  const fail = (e: unknown) => {
    recordError(e);
    say(`That didn't work: ${describe(e)}`);
  };

  const backup = filePanel({ label: 'Export data', build: exportBackup, saved: () => say('Backup saved.'), fail, notice: say });

  const clear = h('button', {
    text: 'Clear app cache',
    on: {
      click: () => {
        clear.disabled = true;
        clearAppCache().then(() => say('App cache cleared. Reload to download the app again (this needs a connection).'), (e: unknown) => {
          clear.disabled = false;
          fail(e);
        });
      },
    },
  });

  document.title = 'Corvus · Recovery';
  replace(
    root,
    h('div', { class: 'screen' },
      h('div', { class: 'recovery stack', attrs: { role: 'alert' } },
        h('h1', { text: 'Corvus could not start' }),
        h('p', { class: 'muted', text: describe(error) }),
        h('p', { text: 'Your progress is still on this device. Export it first, before trying anything else. Never delete the app or clear website data to fix this: that deletes your progress.' }),
        backup.el,
        h('div', { class: 'row' }, h('button', { text: 'Reload', on: { click: reloadHome } }), clear),
        status,
        h('p', { class: 'muted', text: `Build ${__BUILD_ID__}` }),
      ),
    ),
  );
}
