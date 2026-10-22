// The backup panel in Settings: the two-tap export (share.ts), recording the
// date of the last export once the file has been saved.

import type { App } from '../app.ts';
import { buildExport } from '../backup.ts';
import { setLastExport } from '../db/meta.ts';
import { backupFile, filePanel, type FilePanel } from './share.ts';

export type BackupPanel = FilePanel;

/** `onSaved` runs once the file has been shared or its download link used. */
export function backupPanel(app: App, onSaved: () => void = () => {}): BackupPanel {
  return filePanel({
    label: 'Prepare backup',
    build: async () => backupFile(await buildExport(app.db, { now: app.now(), buildId: app.buildId }), app.zone),
    saved: () => {
      setLastExport(app.db, app.now()).then(() => {
        app.notice('Backup saved.');
        onSaved();
      }, app.fail);
    },
    fail: app.fail,
    notice: app.notice,
  });
}
