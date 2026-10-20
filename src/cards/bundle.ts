// The card files and language packs bundled into the build. A static site
// can't list a directory at runtime, and bundling puts the cards inside the
// service worker's precache. check-cards reads the same globs from disk.
import { loadCards } from './load.ts';
import type { CardFile } from './types.ts';
import type { LanguagePack } from '../pack/types.ts';

const cardFiles = import.meta.glob<CardFile>('/cards/lesson-*.json', {
  eager: true,
  import: 'default',
});

const packFiles = import.meta.glob<LanguagePack>(['/languages/*.json', '!/languages/schema.json'], {
  eager: true,
  import: 'default',
});

export const files: CardFile[] = Object.values(cardFiles);
export const cards = loadCards(files);
export const packs: Record<string, LanguagePack> = Object.fromEntries(
  Object.values(packFiles).map((p) => [p.code, p]),
);
