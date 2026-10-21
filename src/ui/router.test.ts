import { describe, expect, it } from 'vitest';
import { parseRoute, routeHash, ROUTES } from './router.ts';

describe('parseRoute', () => {
  it('reads each route back from its own hash', () => {
    for (const r of ROUTES) expect(parseRoute(routeHash(r))).toBe(r);
  });

  it('treats an empty hash, a trailing slash and unknown routes as Home or the route meant', () => {
    expect(parseRoute('')).toBe('home');
    expect(parseRoute('#')).toBe('home');
    expect(parseRoute('#/settings/')).toBe('settings');
    expect(parseRoute('#/browse')).toBe('home');
    expect(parseRoute('#/nonsense')).toBe('home');
  });
});
