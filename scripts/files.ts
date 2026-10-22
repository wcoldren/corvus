// Reading the repo's JSON files from disk, for the scripts that run in Node:
// check-cards and the post-build step.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NamedFile } from './cardcheck.ts';

export const root = join(import.meta.dirname, '..');

export const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

/** Every .json file in a directory of the repo but `skip`, by name. */
export const jsonFiles = (dir: string, skip: string[]): NamedFile[] =>
  readdirSync(join(root, dir))
    .filter((n) => n.endsWith('.json') && !skip.includes(n))
    .sort()
    .map((name) => ({ name, data: readJson(join(root, dir, name)) }));
