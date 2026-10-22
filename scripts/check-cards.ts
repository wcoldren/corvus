// npm run check-cards [-- --base <git ref>] [-- --registry <ids.json file>]
// Validates the card files and language packs (SPEC.md, "Card validation").
// Exits 1 on any failure; warnings are printed but don't fail.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkCorpus, type CorpusInput, type NamedFile } from './cardcheck.ts';
import { jsonFiles, readJson, root } from './files.ts';

function baseFiles(ref: string): NamedFile[] {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return git('ls-tree', '--name-only', ref, 'cards/')
    .split('\n')
    .filter((p) => /^cards\/lesson-.*\.json$/u.test(p))
    .map((p) => ({ name: p.slice('cards/'.length), data: JSON.parse(git('show', `${ref}:${p}`)) }));
}

/**
 * Rule 10's list of deployed ids: a saved copy with --registry, otherwise the
 * live site's, at package.json's `homepage`. Only read once the epoch exists.
 */
async function liveIds(file: string | undefined): Promise<CorpusInput['liveIds']> {
  try {
    if (file) return { data: readJson(file) };
    const site = (readJson(join(root, 'package.json')) as { homepage?: string }).homepage;
    if (!site) return { error: 'package.json has no homepage naming the live site' };
    const url = new URL('ids.json', site);
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { error: `${url} answered ${res.status}` };
    return { data: await res.json() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const args = process.argv.slice(2);
/** The value after --name, or undefined; exits on a flag with no value. */
function option(name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith('--')) {
    console.error('usage: check-cards [--base <git ref>] [--registry <ids.json file>]');
    process.exit(2);
  }
  return value;
}
const baseRef = option('--base');
const registry = option('--registry');
const epoch = existsSync(join(root, 'cards/epoch.json'));

const result = checkCorpus({
  cardSchema: readJson(join(root, 'cards/schema.json')) as object,
  packSchema: readJson(join(root, 'languages/schema.json')) as object,
  cardFiles: jsonFiles('cards', ['schema.json', 'epoch.json']),
  packFiles: jsonFiles('languages', ['schema.json']),
  epoch,
  liveIds: epoch ? await liveIds(registry) : undefined,
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
