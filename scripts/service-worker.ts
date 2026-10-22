// The post-build step (SPEC.md, Build and identity; Service worker). Once
// Vite has written the app, this adds:
// - version.json: the build id and the newest lesson, which the page reads
//   from a new worker's cache to say what an update brings;
// - ids.json: every card id, `~r` ids included, for check-cards rule 10;
// - sw.js: src/sw/worker.ts compiled, after a header naming its cache and the
//   files to precache. The cache name is a hash of those files and the
//   worker, so any change to either makes a new worker and a new cache.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { transformWithOxc, type Plugin } from 'vite';
import { loadCards, newestLesson } from '../src/cards/load.ts';
import type { CardFile } from '../src/cards/types.ts';
import { jsonFiles, root } from './files.ts';

/** Files the worker leaves to the network: itself, and what only CI reads. */
const NOT_PRECACHED = new Set(['sw.js', 'ids.json']);

/** The files to precache, from every file in the build, relative to it. */
export function precacheList(files: readonly string[]): string[] {
  return files
    .filter((f) => !NOT_PRECACHED.has(f) && !f.split('/').some((part) => part.startsWith('.')))
    .sort();
}

/** `corvus-` and a hash of the precached files' paths and bytes, and the worker's code. */
export function cacheName(files: readonly { path: string; bytes: Uint8Array }[], worker: string): string {
  const hash = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(f.path).update('\0').update(f.bytes).update('\0');
  }
  hash.update(worker);
  return `corvus-${hash.digest('hex').slice(0, 12)}`;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'));
}

/** The bundled cards, read the way src/cards/bundle.ts globs them. */
function bundledCards() {
  const files = jsonFiles('cards', [])
    .filter((f) => /^lesson-.*\.json$/u.test(f.name))
    .map((f) => f.data as CardFile);
  return loadCards(files);
}

export function serviceWorker(buildId: string): Plugin {
  return {
    name: 'corvus-service-worker',
    apply: 'build',
    generateBundle() {
      const cards = bundledCards();
      const version = { buildId, newestLesson: newestLesson(cards) };
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(version) + '\n' });
      this.emitFile({ type: 'asset', fileName: 'ids.json', source: JSON.stringify(cards.map((c) => c.id).sort()) + '\n' });
    },
    // After everything is on disk, public/ included.
    writeBundle: {
      order: 'post',
      async handler(output) {
        const outDir = output.dir!;
        const paths = precacheList(walk(outDir));
        const worker = (await transformWithOxc(readFileSync(join(root, 'src/sw/worker.ts'), 'utf8'), 'worker.ts')).code;
        const cache = cacheName(paths.map((path) => ({ path, bytes: readFileSync(join(outDir, path)) })), worker);
        const header = `const CACHE = ${JSON.stringify(cache)};\nconst PRECACHE = ${JSON.stringify(paths, null, 2)};\n\n`;
        writeFileSync(join(outDir, 'sw.js'), header + worker);
      },
    },
  };
}
