// check-cards against the real lessons, and against broken copies of them:
// each case below mutates one thing and expects check-cards to fail (or not).
// The first 30 cases are the ones the stdlib stand-in checker used to carry.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkCorpus, type CorpusInput } from './cardcheck.ts';

const dir = (rel: string) => fileURLToPath(new URL(`../${rel}/`, import.meta.url));
const read = (rel: string, name: string): unknown => JSON.parse(readFileSync(dir(rel) + name, 'utf8'));
const named = (rel: string, skip: string[]) =>
  readdirSync(dir(rel))
    .filter((n) => n.endsWith('.json') && !skip.includes(n))
    .sort()
    .map((name) => ({ name, data: read(rel, name) }));

const real: CorpusInput = {
  cardSchema: read('cards', 'schema.json') as object,
  packSchema: read('languages', 'schema.json') as object,
  cardFiles: named('cards', ['schema.json', 'epoch.json']),
  packFiles: named('languages', ['schema.json']),
  epoch: false,
};

// Loose JSON access for mutations.
type Json = any;

function run(mutate: (input: CorpusInput & { files: Record<string, Json> }) => void) {
  const input = structuredClone(real) as CorpusInput & { files: Record<string, Json> };
  input.files = Object.fromEntries([...input.cardFiles, ...input.packFiles].map((f) => [f.name, f.data]));
  mutate(input);
  return checkCorpus(input);
}

const L1 = 'lesson-01.json';
const L2 = 'lesson-02.json';
const LA = 'la.json';
const card = (input: { files: Record<string, Json> }, file: string, id: string): Json => {
  const c = input.files[file].cards.find((x: Json) => x.id === id);
  if (!c) throw new Error(`no ${id} in ${file}`);
  return c;
};
const V = (i: { files: Record<string, Json> }) => card(i, L2, 'la-02-v-gloria');
const E = (i: { files: Record<string, Json> }) => card(i, L2, 'la-02-e-anima-gen-pl');
const X = (i: { files: Record<string, Json> }) => card(i, L2, 'la-02-x-aquae');

it('passes the real lessons', () => {
  const r = checkCorpus(real);
  expect(r.fails).toEqual([]);
  expect(r.lessons.length).toBe(real.cardFiles.length);
});

type Case = [label: string, fails: boolean, mutate: Parameters<typeof run>[0], expect?: string];

const cases: Case[] = [
  // --- carried over from the stand-in
  ['reverse without lemma', true, (i) => delete V(i).lemma],
  ['reverse false', true, (i) => (V(i).reverse = false)],
  ['reverse object, unknown key', true, (i) => (V(i).reverse = { hint: 'x', bogus: 1 })],
  ['reverse object ok', false, (i) => (V(i).reverse = { accept: ['glōriam'], hint: 'not laus' })],
  ['reverse on ending', true, (i) => (E(i).reverse = true)],
  ['grid on vocab', true, (i) => (V(i).grid = 'case5')],
  ['voc.pl on default grid', true, (i) => X(i).answer.push('voc.pl'), 'not in grid case5'],
  ['voc.pl on case6', false, (i) => (X(i).answer.push('voc.pl'), (X(i).grid = 'case6'))],
  ['unknown grid', true, (i) => (X(i).grid = 'adj'), 'unknown grid'],
  ['bad cell pattern', true, (i) => X(i).answer.push('Gen.SG')],
  ['paradigm without cell', true, (i) => delete E(i).cell],
  ['cell without paradigm', true, (i) => delete E(i).paradigm],
  ['paradigm on vocab', true, (i) => Object.assign(V(i), { paradigm: 'decl1', cell: 'gen.sg' })],
  ['paradigm + cell ok', false, (i) => Object.assign(E(i), { paradigm: 'decl1', cell: 'gen.sg' })],
  ['unknown paradigm', true, (i) => Object.assign(E(i), { paradigm: 'decl9', cell: 'gen.sg' }), 'unknown paradigm'],
  ['cell not in grid', true, (i) => Object.assign(E(i), { paradigm: 'decl1', cell: 'voc.sg' }), 'not in grid'],
  ['strictMarks on parse', true, (i) => (X(i).strictMarks = true)],
  ['strictMarks false', true, (i) => (E(i).strictMarks = false)],
  ['strictMarks ok', false, (i) => (E(i).strictMarks = true)],
  ['variant spelling warns, does not fail', false, (i) => (V(i).lemma = 'coelum')],
  ['bad defaultGrid', true, (i) => (i.files[LA].defaultGrid = 'nope'), 'defaultGrid'],
  ['wrong speech vector', true, (i) => i.files[LA].speech.tests.push({ text: 'caelum', spoken: 'kaelum' }), 'speech'],
  ['paradigm with unknown grid', true, (i) => (i.files[LA].paradigms.decl1.grid = 'nope'), 'unknown grid "nope"'],
  ['unknown top-level key in pack', true, (i) => (i.files[LA].extra = 1)],
  ['duplicate row id', true, (i) => i.files[LA].grids.case5.rows.push({ id: 'nom', label: 'x' }), 'duplicate rows'],
  ['grid without cols', true, (i) => delete i.files[LA].grids.case5.cols],
  ['dotted row id', true, (i) => i.files[LA].grids.case5.rows.push({ id: 'x.y', label: 'x' }), 'rows/5/id must match pattern'],
  ['dotted col id ok', false, (i) => i.files[LA].grids.case5.cols.push({ id: 'pl.m', label: 'x' })],
  ['learner without lang', true, (i) => delete i.files[LA].learner.lang],
  ['old top-level ignoreWords', true, (i) => (i.files[LA].ignoreWords = ['the'])],

  // --- rule 1: files
  ['a card file under another name', true, (i) => (i.cardFiles[0]!.name = 'lesson1.json'), 'not a card file name'],
  ['file name and lesson disagree', true, (i) => (i.files[L1].lesson = 9), 'does not match lesson 9'],
  ['two files with one lesson number', true, (i) => i.cardFiles.push({ name: 'lesson-04.json', data: { ...i.files[L1], lesson: 1 } }), 'does not match'],
  ['unit goes down as lessons rise', true, (i) => (i.files[L2].unit = 0), undefined],
  ['unit lower than an earlier lesson', true, (i) => (i.files[L1].unit = 2), 'is lower than'],
  ['no pack for the language', true, (i) => (i.files[L1].language = 'xx'), 'no valid language pack'],
  ['pack file named after another code', true, (i) => (i.packFiles[0]!.name = 'lat.json'), 'does not match code'],
  // --- rule 2: ids
  ['id without its file prefix', true, (i) => (V(i).id = 'la-01-v-gloria'), 'does not start with la-02-'],
  ['duplicate id across files', true, (i) => (V(i).id = 'la-02-v-aqua'), 'duplicate id'],
  ['a ~r id is taken', true, (i) => i.files[L2].cards.push({ ...E(i), id: 'la-02-v-gloria~r' }), undefined],
  ['retired cards still own their ids', true, (i) => i.files[L2].cards.push({ ...V(i), retired: true }), 'duplicate id'],
  // --- rule 3: duplicates
  ['same type, prompt and answer', true, (i) => i.files[L2].cards.push({ ...V(i), id: 'la-02-v-gloria2', reverse: undefined }), 'same type, prompt and answer'],
  ['the same, but one retired', false, (i) => i.files[L2].cards.push({ ...V(i), id: 'la-02-v-gloria2', reverse: undefined, retired: true })],
  // --- rule 4: modes
  ['grid mode on a vocab card', true, (i) => (V(i).mode = 'grid'), 'not valid'],
  ['typed mode on a parse card', true, (i) => (X(i).mode = 'typed'), 'not valid'],
  ['typed mode on a vocab card', false, (i) => (V(i).mode = 'typed')],
  // --- rule 5: plain text
  ['markup in a typed answer', true, (i) => (E(i).answer = '*animārum*'), 'markup'],
  ['markup in an accept entry', true, (i) => (E(i).accept = ['<b>x</b>']), 'markup'],
  ['a decomposed macron in a typed answer', true, (i) => (E(i).answer = 'animārum'), 'not NFC'],
  ['markup in a reveal answer is fine', false, (i) => (V(i).answer = '*glory*')],
  // --- rule 7: lemmas
  ['ending card without a lemma', true, (i) => delete E(i).lemma, 'needs a lemma'],
  ['parse card without a lemma', true, (i) => delete X(i).lemma, 'needs a lemma'],
  // --- rule 8: self-check
  ['an answer that grades wrong against itself', true, (i) => (E(i).answer = '?!'), 'grades as wrong'],
  ['an accept entry with nothing to type', true, (i) => (E(i).accept = ['/']), 'leaves no answer'],
  // --- rule 10
  ['an epoch file before the registry check exists', true, (i) => (i.epoch = true), 'rule 10'],
];

describe.each(cases)('%s', (_label, fails, mutate, text) => {
  it(fails ? 'fails' : 'passes', () => {
    const r = run(mutate);
    if (fails) {
      expect(r.fails.length).toBeGreaterThan(0);
      if (text) expect(r.fails.join('\n')).toContain(text);
    } else {
      expect(r.fails).toEqual([]);
    }
  });
});

describe('warnings', () => {
  const warns = (m: Parameters<typeof run>[0]) => run(m).warns.join('\n');

  it('a target-language spelling variant', () => {
    expect(warns((i) => (V(i).lemma = 'coelum'))).toContain('variant "coelum"');
    expect(warns((i) => (E(i).answer = 'animærum'))).toContain('variant "æ"');
  });

  it('but not a variant taught in notes', () => {
    expect(warns((i) => (V(i).notes = 'Printed texts write *coelum*.'))).not.toContain('coelum');
  });

  it('a cloze card without exactly one ___', () => {
    expect(warns((i) => (E(i).tags = ['cloze']))).toContain('exactly one ___');
    expect(warns((i) => Object.assign(E(i), { tags: ['cloze'], prompt: 'In ___ (anima)' }))).not.toContain('___');
  });

  it('an accept entry that is another card\'s answer', () => {
    expect(warns(() => {})).toContain('la-02-v-anima: accepts "life", which is the answer of la-02-v-vita');
  });

  it('a lesson over budget', () => {
    const w = warns((i) => {
      for (let k = 0; k < 10; k++) {
        i.files[L2].cards.push({ ...card(i, L2, 'la-02-e-aqua-abl-sg'), id: `la-02-e-extra${k}`, prompt: `extra ${k}` });
      }
    });
    expect(w).toContain('over the budget of 22');
    expect(w).toContain('over the budget of 240 s');
  });

  it('with --base, an answer that changed', () => {
    const base = structuredClone(real.cardFiles);
    expect(warns((i) => (i.base = base))).not.toContain('changed since');
    expect(warns((i) => ((i.base = base), (E(i).answer = 'animārum2')))).toContain('la-02-e-anima-gen-pl: answer changed');
  });
});
