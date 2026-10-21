// The two-tap export (SPEC.md, Export). "Prepare backup" builds the file and
// shows what is in it. "Share" then hands it to the share sheet
// synchronously inside its own tap: a share that waits on anything first
// can lose the tap's permission and be refused. Where sharing files isn't
// possible or fails, a download link stands in. A plain download is
// unreliable in an installed web app, which is why sharing comes first.

import type { App } from '../app.ts';
import { backupFileName, buildExport } from '../backup.ts';
import { setLastExport } from '../db/meta.ts';
import { h, replace } from './dom.ts';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export interface BackupPanel {
  el: HTMLElement;
  dispose(): void;
}

/** `onSaved` runs once the file has been shared or its download link used. */
export function backupPanel(app: App, onSaved: () => void = () => {}): BackupPanel {
  const el = h('div', { class: 'backup stack' });
  let url: string | null = null;
  const revoke = () => {
    if (url) URL.revokeObjectURL(url);
    url = null;
  };

  const saved = () => {
    setLastExport(app.db, app.now()).then(() => {
      app.notice('Backup saved.');
      onSaved();
    }, app.fail);
  };

  function downloadLink(file: File): HTMLAnchorElement {
    revoke();
    url = URL.createObjectURL(file);
    return h('a', { class: 'button', href: url, download: file.name, text: 'Download', on: { click: saved } });
  }

  function showFile(file: File, summary: string): void {
    const actions = h('div', { class: 'row' });
    const share = typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
    if (share) {
      actions.append(
        h('button', {
          class: 'primary',
          text: 'Share',
          on: {
            click: () => {
              // Called straight from the tap, with nothing awaited first.
              navigator.share({ files: [file], title: file.name }).then(saved, (e: unknown) => {
                if (e instanceof DOMException && e.name === 'AbortError') return;
                replace(actions, downloadLink(file));
                app.notice('Sharing was refused; use Download instead.');
              });
            },
          },
        }),
      );
    } else {
      actions.append(downloadLink(file));
    }
    replace(el, h('p', { class: 'muted', text: summary }), actions);
  }

  const prepare = h('button', {
    text: 'Prepare backup',
    on: {
      click: () => {
        prepare.disabled = true;
        prepare.textContent = 'Preparing…';
        const now = app.now();
        buildExport(app.db, { now, buildId: app.buildId }).then((backup) => {
          const file = new File([JSON.stringify(backup)], backupFileName(now, app.zone), { type: 'application/json' });
          const { reviewLog, newestTs } = backup.counts;
          const newest = newestTs === null ? 'no reviews yet' : `newest ${formatWhen(newestTs)}`;
          showFile(file, `${file.name}: ${reviewLog.toLocaleString()} log rows, ${formatSize(file.size)}, ${newest}.`);
        }, (e: unknown) => {
          prepare.disabled = false;
          prepare.textContent = 'Prepare backup';
          app.fail(e);
        });
      },
    },
  });
  el.append(prepare);
  return { el, dispose: revoke };
}
