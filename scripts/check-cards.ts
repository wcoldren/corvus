// npm run check-cards [-- --base <git ref>]
// Validates the card files and language packs (SPEC.md, "Card validation").
// Exits 1 on any failure; warnings are printed but don't fail.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkCorpus, type NamedFile } from './cardcheck.ts';

const root = join(import.meta.dirname, '..');
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const jsonFiles = (dir: string, skip: string[]): NamedFile[] =>
  readdirSync(join(root, dir))
    .filter((n) => n.endsWith('.json') && !skip.includes(n))
    .sort()
    .map((name) => ({ name, data: readJson(join(root, dir, name)) }));

function baseFiles(ref: string): NamedFile[] {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return git('ls-tree', '--name-only', ref, 'cards/')
    .split('\n')
    .filter((p) => /^cards\/lesson-.*\.json$/u.test(p))
    .map((p) => ({ name: p.slice('cards/'.length), data: JSON.parse(git('show', `${ref}:${p}`)) }));
}

const args = process.argv.slice(2);
const baseAt = args.indexOf('--base');
const baseRef = baseAt >= 0 ? args[baseAt + 1] : undefined;
if (baseAt >= 0 && !baseRef) {
  console.error('usage: check-cards [--base <git ref>]');
  process.exit(2);
}

const result = checkCorpus({
  cardSchema: readJson(join(root, 'cards/schema.json')) as object,
  packSchema: readJson(join(root, 'languages/schema.json')) as object,
  cardFiles: jsonFiles('cards', ['schema.json', 'epoch.json']),
  packFiles: jsonFiles('languages', ['schema.json']),
  epoch: existsSync(join(root, 'cards/epoch.json')),
  base: baseRef ? baseFiles(baseRef) : undefined,
});

for (const l of result.lessons) {
  const kinds = Object.entries(l.byKind).map(([k, n]) => `${k} ${n}`).join(', ');
  console.log(
    `${l.name}  ${String(l.instances).padStart(3)} instances  ~${String(l.seconds).padStart(3)} s  ` +
      `${String(l.lemmas).padStart(2)} lemmas (${l.lemmasSoFar} so far)  ${kinds}`,
  );
}
for (const w of result.warns) console.log(`WARN ${w}`);
for (const f of result.fails) console.log(`FAIL ${f}`);
console.log(result.fails.length ? `${result.fails.length} failure(s)` : 'check-cards: OK');
process.exit(result.fails.length ? 1 : 0);
