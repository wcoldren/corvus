import { describe, expect, it } from 'vitest';
import { respell } from './speech.ts';
import type { LanguagePack } from './types.ts';

const packs = import.meta.glob<LanguagePack>(['/languages/*.json', '!/languages/schema.json'], {
  eager: true,
  import: 'default',
});

describe.each(Object.entries(packs))('speech vectors in %s', (_path, pack) => {
  it.each(pack.speech.tests)('$text', ({ text, spoken }) => {
    expect(respell(text, pack.speech.rules).toLowerCase()).toBe(spoken.toLowerCase());
  });
});

it('finds at least one language pack', () => {
  expect(Object.keys(packs).length).toBeGreaterThan(0);
});
