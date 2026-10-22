// Handing a file to the person (SPEC.md, Export), used by Settings and by the
// recovery screen. "Prepare" builds the file and shows what is in it.
// "Share" then hands it to the share sheet synchronously inside its own tap:
// a share that waits on anything first can lose the tap's permission and be
// refused. Where sharing files isn't possible or fails, a download link
// stands in. A plain download is unreliable in an installed web app, which
// is why sharing comes first.

import type { Zone } from '../day.ts';
import { backupFileName, type Backup } from '../dump.ts';
import { h, replace } from './dom.ts';

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** A backup as a file, with a line saying what is in it. */
export function backupFile(backup: Backup, zone?: Zone): { file: File; summary: string } {
  const file = new File([JSON.stringify(backup)], backupFileName(backup.exportedAt, zone), { type: 'application/json' });
  const { reviewLog, newestTs } = backup.counts;
  const newest = newestTs === null ? 'no reviews yet' : `newest ${formatWhen(newestTs)}`;
  const rows = `${reviewLog.toLocaleString()} log ${reviewLog === 1 ? 'row' : 'rows'}`;
  return { file, summary: `${file.name}: ${rows}, ${formatSize(file.size)}, ${newest}.` };
}

export interface FilePanelOptions {
  label: string;
  /** Build the file, and a line saying what is in it. */
  build(): Promise<{ file: File; summary: string }>;
  /** The file was shared, or its download link used. */
  saved(): void;
  fail(error: unknown): void;
  notice(text: string): void;
}

export interface FilePanel {
  el: HTMLElement;
  dispose(): void;
}

export function filePanel(opts: FilePanelOptions): FilePanel {
  const el = h('div', { class: 'backup stack' });
  let url: string | null = null;
  const revoke = () => {
    if (url) URL.revokeObjectURL(url);
    url = null;
  };

  function downloadLink(file: File): HTMLAnchorElement {
    revoke();
    url = URL.createObjectURL(file);
    return h('a', { class: 'button', href: url, download: file.name, text: 'Download', on: { click: opts.saved } });
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
              navigator.share({ files: [file], title: file.name }).then(opts.saved, (e: unknown) => {
                if (e instanceof DOMException && e.name === 'AbortError') return;
                replace(actions, downloadLink(file));
                opts.notice('Sharing was refused; use Download instead.');
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
    text: opts.label,
    on: {
      click: () => {
        prepare.disabled = true;
        prepare.textContent = 'Preparing…';
        opts.build().then(({ file, summary }) => showFile(file, summary), (e: unknown) => {
          prepare.disabled = false;
          prepare.textContent = opts.label;
          opts.fail(e);
        });
      },
    },
  });
  el.append(prepare);
  return { el, dispose: revoke };
}
