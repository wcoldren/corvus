// Text normalization for answer checking (SPEC.md, "Answer checking").

// Apostrophes that count as the same character. iPadOS can turn a typed '
// into ’ ("smart punctuation") even with autocorrect off.
const APOSTROPHES = /[’‘ʼ]/gu;
// Punctuation is stripped, except a hyphen or apostrophe between two letters
// ("well-known", "o'clock"). Marks (\p{M}) are not punctuation, so a
// combining macron survives.
const PUNCT = /(?<=\p{L}\p{M}*)['\-‐‑](?=\p{L})|(\p{P})/gu;

/**
 * NFC, trim, lowercase, unify apostrophes, strip punctuation, collapse spaces.
 * With ignoreWords (a typed meaning in the learner's language), whole words in
 * that list are dropped, unless that would leave nothing.
 */
export function normalize(text: string, ignoreWords: readonly string[] = []): string {
  let s = text.normalize('NFC').toLowerCase().replace(APOSTROPHES, "'");
  s = s.replace(PUNCT, (m, punct: string | undefined) => (punct === undefined ? m : ''));
  s = s.replace(/\s+/gu, ' ').trim();
  if (ignoreWords.length > 0) {
    const kept = s.split(' ').filter((w) => !ignoreWords.includes(w));
    if (kept.length > 0) s = kept.join(' ');
  }
  return s;
}

/** Remove every mark: "animārum" → "animarum". */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
}

const MAX_EXPANSIONS = 256;

/**
 * Expand slash alternatives: within a word, `/` lists choices for that slot,
 * so "he/she/it loves" stands for "he loves", "she loves" and "it loves".
 * Spaces around a slash are ignored ("he / she loves" is "he/she loves").
 * Runs before normalize(), which would strip the slashes. An answer with no
 * choices left (a lone "/") expands to nothing; check-cards rule 8 fails it.
 */
export function expandAlternatives(answer: string): string[] {
  let out = [''];
  for (const word of answer.trim().replace(/\s*\/\s*/gu, '/').split(/\s+/u)) {
    const choices = word.includes('/') ? word.split('/').filter((w) => w !== '') : [word];
    out = out.flatMap((head) => choices.map((c) => (head ? head + ' ' + c : c)));
    if (out.length > MAX_EXPANSIONS) throw new Error(`too many alternatives in "${answer}"`);
  }
  return out;
}
