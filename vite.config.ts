import { execSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';
import { serviceWorker } from './scripts/service-worker.ts';

/**
 * The build id shown in Settings and logged with every review: the commit
 * it was built from, marked when the working tree had uncommitted changes.
 */
function buildId(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim() !== '';
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

/**
 * The production page may load nothing but its own files (SPEC.md, Input and
 * display). Development is left alone, since Vite's dev client injects
 * inline styles and scripts.
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'corvus-csp',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: "default-src 'self'" },
        injectTo: 'head-prepend',
      },
    ],
  };
}

// The site is served from https://<user>.github.io/corvus/, so every URL is
// built from this base (import.meta.env.BASE_URL in the app).
const id = buildId();

export default defineConfig({
  base: '/corvus/',
  define: { __BUILD_ID__: JSON.stringify(id) },
  plugins: [contentSecurityPolicy(), serviceWorker(id)],
});
