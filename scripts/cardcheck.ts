// The rules behind `npm run check-cards` (SPEC.md, "Card validation"), as a
// pure function over file contents so the tests can feed it broken copies.
// scripts/check-cards.ts reads the files from disk and prints the result.
import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import { loadCards } from '../src/cards/load.ts';
import type { Card, CardFile, CardJson } from '../src/cards/types.ts';
import { buildFormIndex, checkTyped } from '../src/check/answer.ts';
import { expandAlternatives, normalize } from '../src/check/normalize.ts';
import { respell } from '../src/pack/speech.ts';
import type { Grid, LanguagePack } from '../src/pack/types.ts';

export interface NamedFile {
  name: string;
  data: unknown;
}

export interface CorpusInput {
  cardSchema: object;
  packSchema: object;
  /** Every .json in cards/ other than schema.json and epoch.json. */
  cardFiles: NamedFile[];
  /** Every .json in languages/ other than schema.json. */
  packFiles: NamedFile[];
  /** cards/epoch.json exists. */
  epoch: boolean;
  /** With --base <ref>: the lesson files at that ref. */
  base?: NamedFile[];
}

export interface LessonReport {
  name: string;
  instances: number;
  seconds: number;
  byKind: Record<string, number>;
  lemmas: number;
  lemmasSoFar: number;
}

export interface CorpusResult {
  fails: string[];
  warns: string[];
  lessons: LessonReport[];
}

// Placeholder first-pass answer times by mode, until logged means replace
// them (SPEC.md, Workload budget).
const SECONDS = { reveal: 8, grid: 12, typed: 15 } as const;
const MAX_INSTANCES = 22;
const MAX_SECONDS = 240;

const LESSON_FILE = /^lesson-(\d{2,})\.json$/;

export function checkCorpus(input: CorpusInput): CorpusResult {
  const fails: string[] = [];
  const warns: string[] = [];
  // strictSchema rejects unknown (misspelled) keywords in the schemas. Ajv's
  // other strict lints (strictTypes, strictRequired) stay off: they reject the
  // card schema's `if`/`then` conditions, which are valid JSON Schema but name
  // properties and types defined at the top level rather than beside them.
  const ajv = new Ajv2020({ allErrors: true, strictSchema: true, strictTypes: false, strictRequired: false });
  const validCard = ajv.compile(input.cardSchema);
  const validPack = ajv.compile(input.packSchema);

  // Language packs: schema, then the cross-references inside each pack.
  const packs = new Map<string, LanguagePack>();
  for (const f of input.packFiles) {
    if (!validPack(f.data)) {
      fails.push(...schemaErrors(f.name, validPack.errors));
      continue;
    }
    const pack = f.data as LanguagePack;
    if (f.name !== `${pack.code}.json`) fails.push(`${f.name}: file name does not match code "${pack.code}"`);
    fails.push(...checkPack(f.name, pack));
    packs.set(pack.code, pack);
  }

  // Rule 1: card files, by name and schema.
  const files: CardFile[] = [];
  const fileName = new Map<CardFile, string>();
  for (const f of input.cardFiles) {
    const m = LESSON_FILE.exec(f.name);
    if (!m) {
      fails.push(`${f.name}: not a card file name; card files are cards/lesson-NN.json`);
      continue;
    }
    if (!validCard(f.data)) {
      fails.push(...schemaErrors(f.name, validCard.errors));
      continue;
    }
    const file = f.data as CardFile;
    if (Number(m[1]) !== file.lesson) fails.push(`${f.name}: file name does not match lesson ${file.lesson}`);
    if (!packs.has(file.language)) fails.push(`${f.name}: no valid language pack languages/${file.language}.json`);
    files.push(file);
    fileName.set(file, f.name);
  }
  files.sort((a, b) => a.lesson - b.lesson);
  for (let i = 1; i < files.length; i++) {
    const [prev, cur] = [files[i - 1]!, files[i]!];
    if (prev.lesson === cur.lesson) fails.push(`${fileName.get(cur)}: lesson ${cur.lesson} is also in ${fileName.get(prev)}`);
    if (cur.unit < prev.unit) fails.push(`${fileName.get(cur)}: unit ${cur.unit} is lower than lesson ${prev.lesson}'s unit ${prev.unit}`);
  }

  const cards = loadCards(files);
  const where = (c: Card) => `${fileName.get(files.find((f) => f.lesson === c.lesson)!)}: ${c.id}`;

  // Rule 2: id prefixes, and ids unique across files, `~r` ids and retired cards included.
  const seen = new Map<string, Card>();
  for (const c of cards) {
    const prefix = `${c.language}-${String(c.lesson).padStart(2, '0')}-`;
    if (!c.reverse && !c.id.startsWith(prefix)) fails.push(`${where(c)}: id does not start with ${prefix}`);
    const other = seen.get(c.id);
    if (other) fails.push(`${where(c)}: duplicate id (also in lesson ${other.lesson})`);
    else seen.set(c.id, c);
  }

  // Rule 3: no two live cards share type, normalized prompt and answer.
  const content = new Map<string, Card>();
  for (const c of cards.filter((x) => !x.retired)) {
    const answer = Array.isArray(c.answer) ? [...c.answer].sort().join(' ') : normalize(c.answer);
    const key = `${c.type}\u0000${normalize(c.prompt)}\u0000${answer}`;
    const other = content.get(key);
    if (other) fails.push(`${where(c)}: same type, prompt and answer as ${other.id}`);
    else content.set(key, c);
  }

  const forms = buildFormIndex(cards);
  for (const c of cards) {
    const pack = packs.get(c.language);
    const src = c.source;

    // Rule 4: grid mode belongs to parse cards, and parse cards always use it.
    if (!c.reverse && src.mode !== undefined && (src.mode === 'grid') !== (c.type === 'parse')) {
      fails.push(`${where(c)}: mode "${src.mode}" is not valid for a ${c.type} card`);
    }

    // Rule 5: what is typed is compared as plain NFC text.
    const plain = c.mode === 'typed' && typeof c.answer === 'string' ? [c.answer, ...c.accept] : [];
    if (c.reverse && c.lemma) plain.push(c.lemma);
    for (const s of plain) {
      if (s !== s.normalize('NFC')) fails.push(`${where(c)}: "${s}" is not NFC`);
      if (/[*<>]/u.test(s)) fails.push(`${where(c)}: "${s}" holds markup; typed answers are plain text`);
    }

    // Rule 6: grid and paradigm references, and cells within their grid.
    if (pack && !c.reverse) fails.push(...checkCells(where(c), src, pack));

    // Rule 7: the cards that are about a word name it.
    if (!c.reverse && (c.type === 'vocab' || c.type === 'ending' || c.type === 'parse') && !c.lemma) {
      fails.push(`${where(c)}: a ${c.type} card needs a lemma`);
    }

    // Rule 8: a typed card's own answers grade correct through the real checker.
    if (pack && !c.retired && c.mode === 'typed' && typeof c.answer === 'string') {
      for (const a of [c.answer, ...c.accept]) {
        for (const alt of expandAlternatives(a)) {
          const v = checkTyped(c, alt, { ignoreWords: pack.learner.ignoreWords, forms });
          if (v.kind !== 'correct') fails.push(`${where(c)}: its own answer "${alt}" grades as ${v.kind}`);
        }
      }
    }

    if (c.retired || !pack) continue;
    // Warnings.
    for (const s of targetText(c)) {
      for (const v of variantsIn(s, pack)) warns.push(`${where(c)}: "${s}" has the variant "${v.variant}" (cards use "${v.standard}")`);
    }
    if (c.tags.includes('cloze') && c.prompt.split('___').length !== 2) {
      warns.push(`${where(c)}: a cloze card needs exactly one ___ in its prompt`);
    }
  }

  // Rule 9: every pack's speech vectors.
  for (const pack of packs.values()) {
    for (const t of pack.speech.tests) {
      const got = respell(t.text, pack.speech.rules).toLowerCase();
      if (got !== t.spoken.toLowerCase()) fails.push(`${pack.code}.json: speech "${t.text}" gives "${got}", expected "${t.spoken}"`);
    }
  }

  // Rule 10, once the epoch exists: no deployed id may disappear. It needs
  // the live site's ids.json, which the deploy step adds; until it is written,
  // an epoch file fails rather than skipping the check.
  if (input.epoch) {
    fails.push('cards/epoch.json exists but the registry check (rule 10) is not implemented yet');
  }

  warns.push(...acceptCollisions(cards, packs));
  if (input.base) warns.push(...changedAnswers(input.base, files, fileName));
  const lessons = report(files, fileName, cards, warns);
  return { fails, warns, lessons };
}

function schemaErrors(name: string, errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${name}: ${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
}

export function gridCells(grid: Grid): Set<string> {
  return new Set(grid.rows.flatMap((r) => grid.cols.map((c) => `${r.id}.${c.id}`)));
}

function checkPack(name: string, pack: LanguagePack): string[] {
  const fails: string[] = [];
  for (const [id, g] of Object.entries(pack.grids)) {
    if (!/^[a-z0-9]+$/u.test(id)) fails.push(`${name}: grid id "${id}" is not lowercase letters and digits`);
    for (const axis of ['rows', 'cols'] as const) {
      const ids = g[axis].map((x) => x.id);
      if (new Set(ids).size !== ids.length) fails.push(`${name}: grid ${id} has duplicate ${axis} ids`);
    }
  }
  if (!(pack.defaultGrid in pack.grids)) fails.push(`${name}: defaultGrid "${pack.defaultGrid}" is not a grid`);
  for (const [id, p] of Object.entries(pack.paradigms)) {
    if (!(p.grid in pack.grids)) fails.push(`${name}: paradigm ${id} uses unknown grid "${p.grid}"`);
  }
  return fails;
}

function checkCells(at: string, c: CardJson, pack: LanguagePack): string[] {
  const fails: string[] = [];
  if (c.type === 'parse') {
    const id = c.grid ?? pack.defaultGrid;
    const grid = pack.grids[id];
    if (!grid) return [`${at}: unknown grid "${id}"`];
    const cells = gridCells(grid);
    const extra = (c.answer as string[]).filter((x) => !cells.has(x));
    if (extra.length) fails.push(`${at}: cells not in grid ${id}: ${extra.join(', ')}`);
  }
  if (c.paradigm !== undefined) {
    const p = pack.paradigms[c.paradigm];
    const grid = p && pack.grids[p.grid];
    if (!p) fails.push(`${at}: unknown paradigm "${c.paradigm}"`);
    else if (grid && c.cell !== undefined && !gridCells(grid).has(c.cell)) {
      fails.push(`${at}: cell "${c.cell}" is not in grid ${p.grid}`);
    }
  }
  return fails;
}

// Italic spans in learner-language text are target-language words.
const ITALIC = /(?<!\*)\*(?!\*)([^*]+)\*(?!\*)/gu;
const italics = (s: string | undefined) => (s ? [...s.matchAll(ITALIC)].map((m) => m[1]!) : []);

/**
 * Target-language text on a card, by SPEC.md's field table, plus italic spans
 * in its learner-language prompt and answers. Notes are left out: printed
 * spellings are taught there on purpose.
 */
function targetText(c: Card): string[] {
  const s = c.source;
  const out: string[] = [];
  // A reverse card's lemma is its forward card's, already scanned there.
  if (c.lemma && !c.reverse) out.push(c.lemma);
  if (c.reverse) {
    out.push(...c.accept);
  } else if (s.type === 'vocab' || s.type === 'parse' || s.type === 'phrase') {
    out.push(s.prompt);
  } else if (s.type === 'ending') {
    out.push(s.answer as string, ...(s.accept ?? []));
    if (s.tags?.includes('cloze')) out.push(s.prompt);
  }
  if (!c.reverse && s.type !== 'parse') {
    const learnerPrompt = s.type === 'concept' || (s.type === 'ending' && !s.tags?.includes('cloze'));
    if (learnerPrompt) out.push(...italics(s.prompt));
    if (s.type !== 'ending') out.push(...italics(s.answer as string), ...(s.accept ?? []).flatMap(italics));
  }
  return out;
}

function variantsIn(text: string, pack: LanguagePack) {
  const nfd = text.normalize('NFD').toLowerCase();
  const letters = pack.spellingVariants.letters.filter((v) => nfd.includes(v.variant.normalize('NFD').toLowerCase()));
  const words = pack.spellingVariants.words.filter((v) => {
    const escaped = v.variant.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{M}])${escaped}(?![\\p{L}\\p{M}])`, 'iu').test(text);
  });
  return [...letters, ...words];
}

/** An accept entry equal to another live card's answer, in the same language. */
function acceptCollisions(cards: Card[], packs: Map<string, LanguagePack>): string[] {
  const warns: string[] = [];
  const norm = (c: Card, s: string) =>
    normalize(s, c.answerLang === 'learner' ? (packs.get(c.language)?.learner.ignoreWords ?? []) : []);
  const answers = new Map<string, Card>();
  const live = cards.filter((c) => !c.retired && typeof c.answer === 'string');
  for (const c of live) answers.set(`${c.language}:${c.answerLang}:${norm(c, c.answer as string)}`, c);
  for (const c of live) {
    for (const a of c.accept) {
      const other = answers.get(`${c.language}:${c.answerLang}:${norm(c, a)}`);
      if (other && other.id !== c.id) warns.push(`${c.id}: accepts "${a}", which is the answer of ${other.id}`);
    }
  }
  return warns;
}

/** With --base: answers that changed since that ref, for a look against the epoch rule. */
function changedAnswers(base: NamedFile[], files: CardFile[], fileName: Map<CardFile, string>): string[] {
  const before = new Map<string, unknown>();
  for (const f of base) for (const c of (f.data as CardFile).cards ?? []) before.set(c.id, c.answer);
  const warns: string[] = [];
  for (const file of files) {
    for (const c of file.cards) {
      if (before.has(c.id) && JSON.stringify(before.get(c.id)) !== JSON.stringify(c.answer)) {
        warns.push(`${fileName.get(file)}: ${c.id}: answer changed since the base ref; check it still tests the same fact`);
      }
    }
  }
  return warns;
}

function report(files: CardFile[], fileName: Map<CardFile, string>, cards: Card[], warns: string[]): LessonReport[] {
  const lemmasSeen = new Set<string>();
  return files.map((file) => {
    const name = fileName.get(file)!;
    const live = cards.filter((c) => c.lesson === file.lesson && !c.retired);
    const byKind: Record<string, number> = {};
    for (const c of live) {
      const kind = c.reverse ? '~r' : c.type;
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
    const seconds = live.reduce((s, c) => s + SECONDS[c.mode], 0);
    const lemmas = new Set(live.filter((c) => c.lemma && !c.reverse).map((c) => normalize(c.lemma!)));
    for (const l of lemmas) lemmasSeen.add(l);
    if (live.length > MAX_INSTANCES) warns.push(`${name}: ${live.length} instances, over the budget of ${MAX_INSTANCES}`);
    if (seconds > MAX_SECONDS) warns.push(`${name}: about ${seconds} s first pass, over the budget of ${MAX_SECONDS} s`);
    return { name, instances: live.length, seconds, byKind, lemmas: lemmas.size, lemmasSoFar: lemmasSeen.size };
  });
}
