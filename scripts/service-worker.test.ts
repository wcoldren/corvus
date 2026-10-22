import { describe, expect, it } from 'vitest';
import { cacheName, precacheList } from './service-worker.ts';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('precacheList', () => {
  it('keeps the app and leaves out the worker, ids.json and dot directories', () => {
    expect(precacheList(['sw.js', 'index.html', 'ids.json', '.vite/manifest.json', 'assets/a.js', 'version.json']))
      .toEqual(['assets/a.js', 'index.html', 'version.json']);
  });
});

describe('cacheName', () => {
  const files = [
    { path: 'index.html', bytes: bytes('<html>') },
    { path: 'assets/a.js', bytes: bytes('a') },
  ];

  it('does not depend on the order files were listed in', () => {
    expect(cacheName(files, 'w')).toBe(cacheName([...files].reverse(), 'w'));
    expect(cacheName(files, 'w')).toMatch(/^corvus-[0-9a-f]{12}$/u);
  });

  it('changes when a file, a path or the worker changes', () => {
    const base = cacheName(files, 'w');
    expect(cacheName([files[0]!, { path: 'assets/a.js', bytes: bytes('b') }], 'w')).not.toBe(base);
    expect(cacheName([files[0]!, { path: 'assets/b.js', bytes: bytes('a') }], 'w')).not.toBe(base);
    expect(cacheName(files, 'w2')).not.toBe(base);
  });
});
