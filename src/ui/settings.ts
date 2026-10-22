// Settings (SPEC.md, Screens: Settings): backup, import, Reset, rebuilding
// the schedule, and what this build and this device are. The adjustable
// settings arrive in M1b and M2.

import type { App, Screen } from '../app.ts';
import {
  BackupError,
  importBackup,
  rebuildSchedule,
  reset,
  summarizeImport,
  validateBackup,
  type Backup,
} from '../backup.ts';
import { getLastExport } from '../db/meta.ts';
import type { CheckResult } from '../sw/updates.ts';
import { readErrors } from '../errors.ts';
import { backupPanel, type BackupPanel } from './backup.ts';
import { h, replace } from './dom.ts';
import { formatWhen } from './share.ts';
import { routeHash } from './router.ts';

const UPDATE_RESULT: Record<CheckResult, string> = {
  found: 'Downloading a new version. It loads when you return to Home.',
  current: 'This is the newest version.',
  failed: 'Could not check for updates. Is this device offline?',
  off: 'Updates are off in development builds.',
};

/** A button that stays disabled until `word` is typed (SPEC.md, Import and reset). */
function typedConfirm(word: string, label: string, action: (button: HTMLButtonElement) => void): HTMLElement {
  const button = h('button', { class: 'danger', text: label, disabled: true, on: { click: () => action(button) } });
  const input = h('input', {
    type: 'text',
    attrs: { autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', autocomplete: 'off', 'aria-label': `Type ${word} to confirm` },
    on: { input: () => (button.disabled = input.value.trim().toLowerCase() !== word) },
  });
  return h('div', { class: 'stack' }, h('p', {}, 'Type ', h('strong', { text: word }), ' to confirm.'), input, button);
}

export async function settingsScreen(app: App): Promise<Screen> {
  const panels: BackupPanel[] = [];
  /** A backup panel whose object URL is released when the screen goes. */
  const panel = (onSaved?: () => void) => {
    const p = backupPanel(app, onSaved);
    panels.push(p);
    return p.el;
  };

  const [logRows, stateIds, lastExport, persisted] = await Promise.all([
    app.db.read((c) => c.count('reviewLog')),
    app.db.read((c) => c.getAllKeys('cardState')),
    getLastExport(app.db),
    navigator.storage?.persisted?.().catch(() => null) ?? Promise.resolve(null),
  ]);
  const known = new Set(app.cards.map((c) => c.id));
  const orphaned = stateIds.filter((id) => !known.has(id)).length;

  /**
   * Import and Reset begin with a backup of this device (SPEC.md, Import
   * and reset). `then` runs once one is saved, or at once if there is
   * nothing on the device to lose.
   */
  function backupFirst(box: HTMLElement, then: () => void): void {
    if (logRows === 0) return then();
    replace(box, h('p', { text: 'First, save a backup of what is on this device.' }), panel(then));
  }

  // Import.
  const importBox = h('div', { class: 'stack' });
  const fileInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    attrs: { 'aria-label': 'Backup file' },
    on: { change: () => void chooseFile() },
  });

  async function chooseFile(): Promise<void> {
    const file = fileInput.files?.[0];
    if (!file) return;
    let backup: Backup;
    try {
      backup = validateBackup(JSON.parse(await file.text()));
    } catch (e) {
      const why = e instanceof BackupError ? e.message : 'This file is not valid JSON.';
      return replace(importBox, h('p', { class: 'error', text: why }));
    }
    const s = await summarizeImport(app.db, backup);
    const newest = s.newestTs === null ? 'no reviews' : `newest ${formatWhen(s.newestTs)}`;
    const summary = h('p', {
      text: `File: ${s.fileRows.toLocaleString()} log rows, ${newest}. ${s.notOnDevice.toLocaleString()} are not on this device. Nothing here will be removed.`,
    });
    const step = h('div', { class: 'stack' });
    replace(importBox, summary, step);
    backupFirst(step, () => replace(step, confirmImport(backup)));
  }

  function confirmImport(backup: Backup): HTMLElement {
    const result = h('div', { class: 'stack' });
    const run = (mode: 'merge' | 'replace', button: HTMLButtonElement) => {
      button.disabled = true;
      importBackup(app.db, backup, mode).then(
        (r) => {
          replace(result,
            h('p', { text: `Imported. ${r.added.toLocaleString()} new log rows.` }),
            r.differs.length > 0 &&
              h('p', {
                class: 'advisory',
                text: `${r.differs.length} cards rebuilt differently from the file's copy: ${r.differs.slice(0, 10).join(', ')}${r.differs.length > 10 ? ', …' : ''}.`,
              }),
            h('a', { class: 'button primary', href: routeHash('home'), text: 'Home' }),
          );
        },
        (e: unknown) => {
          button.disabled = false;
          app.fail(e);
        },
      );
    };
    const merge = h('button', { class: 'primary', text: 'Merge into this device', on: { click: () => run('merge', merge) } });
    const replaceAll = h('details', {},
      h('summary', { text: 'Advanced: replace everything on this device with the file' }),
      typedConfirm('replace', 'Replace all', (b) => run('replace', b)),
    );
    return h('div', { class: 'stack' }, merge, replaceAll, result);
  }

  // Reset.
  const resetBox = h('div', { class: 'stack' });
  const startReset = h('button', {
    class: 'danger',
    text: 'Reset…',
    on: {
      click: () =>
        backupFirst(resetBox, () =>
          replace(resetBox,
            h('p', { text: 'Reset deletes every review on this device. The cards stay.' }),
            typedConfirm('reset', 'Delete all reviews', (b) => {
              b.disabled = true;
              reset(app.db).then(() => {
                app.notice('Reset done. The next review starts a fresh history.');
                app.go('home');
              }, app.fail);
            }),
          ),
        ),
    },
  });
  resetBox.append(startReset);

  // Rebuild.
  const rebuild = h('button', {
    text: 'Rebuild schedule',
    on: {
      click: () => {
        rebuild.disabled = true;
        rebuildSchedule(app.db).then(
          (r) => {
            rebuild.disabled = false;
            app.notice(
              r.changed === 0
                ? `Rebuilt ${r.cards} cards from the log; nothing had drifted.`
                : `Rebuilt ${r.cards} cards from the log; ${r.changed} had drifted and were corrected.`,
            );
          },
          (e: unknown) => {
            rebuild.disabled = false;
            app.fail(e);
          },
        );
      },
    },
  });

  // Check for updates (SPEC.md, Updates). The app checks by itself at start
  // and on resume; this is for when a deploy has just gone out.
  const updateStatus = h('p', { class: 'muted', attrs: { 'aria-live': 'polite' } });
  const checkUpdates = h('button', {
    text: 'Check for updates',
    on: {
      click: () => {
        checkUpdates.disabled = true;
        updateStatus.textContent = 'Checking…';
        void app.updates.check().then((result) => {
          checkUpdates.disabled = false;
          updateStatus.textContent = UPDATE_RESULT[result];
        });
      },
    },
  });

  const errors = readErrors();
  const persistText =
    persisted === null ? 'unknown (this browser does not say)'
    : persisted ? 'persistent: the browser will not evict it'
    : 'not persistent: the browser may evict it under storage pressure';

  const el = h('section', { class: 'settings' },
    h('nav', { class: 'top' },
      h('a', { class: 'button', href: routeHash('home'), text: 'Home' }),
      h('h1', { text: 'Settings' }),
      h('span'),
    ),

    h('h2', { text: 'Backup' }),
    h('p', { class: 'muted', text: lastExport === null ? 'No backup yet.' : `Last backup: ${formatWhen(lastExport)}.` }),
    panel(),

    h('h2', { text: 'Import' }),
    h('p', { class: 'muted', text: 'Merge a backup file into this device. Rows already here are kept.' }),
    fileInput,
    importBox,

    h('h2', { text: 'Schedule' }),
    h('p', { class: 'muted', text: 'Recompute every card from the review log. Safe at any time.' }),
    rebuild,

    h('h2', { text: 'Typing marks' }),
    app.pack.inputHelp ? h('p', { attrs: { lang: app.pack.learner.lang }, text: app.pack.inputHelp }) : null,

    h('h2', { text: 'This app' }),
    h('dl', { class: 'facts' },
      h('dt', { text: 'Build' }), h('dd', { class: 'mono', text: app.buildId }),
      h('dt', { text: 'Newest lesson in this build' }), h('dd', { text: String(app.newestLesson) }),
      h('dt', { text: 'Storage' }), h('dd', { text: persistText }),
      h('dt', { text: 'Log rows' }), h('dd', { text: logRows.toLocaleString() }),
      orphaned > 0 && h('dt', { text: 'Orphaned cards' }),
      orphaned > 0 && h('dd', { text: `${orphaned}: history for cards this build no longer has. It is kept.` }),
    ),
    checkUpdates,
    updateStatus,
    errors.length > 0 &&
      h('details', { class: 'errors' },
        h('summary', { text: `Recent errors (${errors.length})` }),
        h('ol', {}, ...errors.map((e) => h('li', {}, h('span', { class: 'muted', text: formatWhen(e.ts) + ' ' }), e.message))),
      ),

    h('h2', { text: 'Reset' }),
    h('p', { class: 'muted', text: 'Delete all review history on this device, after saving a backup.' }),
    resetBox,
  );

  return { el, dispose: () => panels.forEach((p) => p.dispose()) };
}
