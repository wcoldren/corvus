// Hash routes (SPEC.md, Build and identity). One page, and GitHub Pages has
// no rewrite to index.html, so the route lives after the `#`. The session
// never lives in the URL: reloading #/review starts a fresh session from
// what IndexedDB holds.

export const ROUTES = ['home', 'review', 'settings'] as const;
export type Route = (typeof ROUTES)[number];

const HASHES: Record<Route, string> = {
  home: '#/',
  review: '#/review',
  settings: '#/settings',
};

const BY_PATH = new Map(ROUTES.map((r) => [HASHES[r].slice(1), r]));

/** The route for a location hash. Anything unknown (including #/browse until M2) is Home. */
export function parseRoute(hash: string): Route {
  const path = '/' + hash.replace(/^#\/?/, '').replace(/\/+$/, '');
  return BY_PATH.get(path) ?? 'home';
}

export function routeHash(route: Route): string {
  return HASHES[route];
}
