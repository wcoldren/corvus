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

sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Past the HTTP cache, so a stale copy never lands in a new cache.
      await cache.addAll(PRECACHE.map((path) => new Request(path, { cache: 'reload' })));
      // Take over without waiting for every page to close: a Home Screen app
      // is rarely closed. The page decides when to reload (src/sw/updates.ts).
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Only our own caches, and never IndexedDB.
      const stale = (await caches.keys()).filter((name) => name.startsWith('corvus-') && name !== CACHE);
      await Promise.all(stale.map((name) => caches.delete(name)));
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
  event.respondWith(
    caches.open(CACHE).then(async (cache) => (await cache.match(key, { ignoreVary: true })) ?? fetch(request)),
  );
});
