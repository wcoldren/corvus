// The service worker (SPEC.md, Service worker). The build compiles this file
// on its own and puts CACHE and PRECACHE in front of it
// (scripts/service-worker.ts), so it runs as a plain script, not a module.
// It is type-checked against the worker's globals (src/sw/tsconfig.json),
// not the page's.

/** `corvus-<hash of this build's files>`. */
declare const CACHE: string;
/** Every file of this build, relative to the worker, index.html among them. */
declare const PRECACHE: string[];

const sw = self as unknown as ServiceWorkerGlobalScope;

/**
 * The other builds' caches, newest first (cache names list in the order they
 * were made). A page keeps running the build it loaded until it reloads at
 * Home (src/sw/updates.ts), and this worker takes it over at once. Its files
 * that aren't loaded yet are in its own build's cache and nowhere else: the
 * server has moved on to this build's. So that cache is kept, and searched
 * after this one, until the next deploy.
 */
function olderBuilds(names: string[]): string[] {
  return names.filter((name) => name.startsWith('corvus-') && name !== CACHE).reverse();
}

sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        // Past the HTTP cache, so a stale copy never lands in a new cache.
        await cache.addAll(PRECACHE.map((path) => new Request(path, { cache: 'reload' })));
      } catch (e) {
        // An empty cache left behind would pass for the previous build's.
        await caches.delete(CACHE);
        throw e;
      }
      // Take over without waiting for every page to close: a Home Screen app
      // is rarely closed. The page decides when to reload (src/sw/updates.ts).
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Only our own caches, and never IndexedDB. The newest of the others
      // is the build the open page is still running, so it stays until the
      // next deploy (see olderBuilds).
      await Promise.all(olderBuilds(await caches.keys()).slice(1).map((name) => caches.delete(name)));
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(sw.registration.scope)) return;
  // GitHub Pages has no rewrite to index.html, so every page in scope gets
  // the app's one page, online or offline. The route is in the hash, which
  // never reaches here.
  const key = request.mode === 'navigate' ? new URL('index.html', sw.registration.scope).href : request;
  // ignoreVary: a server that answers with `Vary: Origin` would otherwise
  // keep a module script (fetched with an Origin header) from matching the
  // copy precached without one. Each cache holds one build, keyed by URL.
  // caches.match, not caches.open: opening re-creates the cache, empty, if a
  // newer worker has deleted it while this one still answers a request.
  event.respondWith(
    (async () => {
      const hit = await caches.match(key, { cacheName: CACHE, ignoreVary: true });
      if (hit) return hit;
      for (const name of olderBuilds(await caches.keys())) {
        const old = await caches.match(key, { cacheName: name, ignoreVary: true });
        if (old) return old;
      }
      return fetch(request);
    })(),
  );
});
