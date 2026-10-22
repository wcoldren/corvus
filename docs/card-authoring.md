# Writing card files

This is the guide for the lesson chat that writes each lesson's cards. The chat attaches this repo and works on its files directly: `cards/schema.json` and `languages/la.json` define what is valid, and `SPEC.md` is the source of truth for how the app uses these fields. This file covers what to write.

## What a lesson produces

At the end of a lesson, open one pull request on its own branch with:

1. **One card file**, `cards/lesson-NN.json`, where `NN` is this lesson's number with two digits: one more than the highest existing card file. It must validate against `cards/schema.json`.
2. **Fixes to earlier cards**, if any, made in place in their own files (see Changing earlier cards).
3. **The syllabus's Cards column** filled in with `lesson-NN` for each row the lesson covered.

Nothing else goes in the card file: no comments, and no cards for other lessons. Don't push to `main`, which deploys; the learner merges the pull request.

```json
{
  "language": "la",
  "lesson": 4,
  "unit": 1,
  "title": "sum, esse: the present tense",
  "cards": [ ... ]
}
```

- `lesson` is the card file's number, which is also the unlock key. It is not the syllabus row number: the two have drifted, and `docs/syllabus.md` maps one to the other.
- `unit` is the syllabus unit. It never goes down from one lesson to the next.
- `title` is the lesson's topic in plain words.

## The budget

The app's daily goal is 20 minutes, with 30 as a ceiling. One lesson's cards must fit that:

| Kind | Per lesson |
| --- | --- |
| New lemmas (forward vocab) | about 13 to 14 |
| Reverse cards | at most 3 |
| Ending, parse, headword and cloze | at most 4 |
| Concept and phrase | at most 1 to 2 |
| Total instances, counting reverse cards | about 20 to 22 |

A vocab card with `reverse` counts as two instances. check-cards also estimates the first-pass cost (reveal 8 s, grid 12 s, typed 15 s) and warns above 240 s.

When a lesson has more to say than fits, cut in this order: reverse cards, then paradigm cells, then concept cards. Never cut lemmas to make room; vocabulary cards are the cheapest kind and the course needs about 1,100 of them by the end.

Before writing the file, ask for the app's Home counts (cards due today, new cards waiting). If more than one lesson's worth of new cards is already waiting, write a smaller file and suggest a review day before the next lesson.

## Order and ids

- **File order is introduction order.** The app introduces new cards in lesson order and then file order. Put a lemma's vocab card before any ending, parse or headword card that uses it.
- **Ids** look like `la-NN-<kind>-<slug>`: `c` concept, `p` phrase, `v` vocab, `e` ending, `x` parse, `h` headword, `z` cloze. The slug is lowercase ASCII with hyphens, made from the content: `la-04-v-sumus`, `la-04-e-sum-1pl`, `la-04-h-estis`.
- Ids are permanent: the review history is keyed by them. Never reuse an id, even one from a deleted or retired card, and never give a new card an id that differs from an old one only by its lesson number.
- A reverse card's id is generated (`<id>~r`). Don't write it.

## Lemmas

Every vocab, ending and parse card has a `lemma`: the dictionary headword the card is about, lowercase, with its macrons. A card on *amat* has the lemma `amō`; a card on *Deī* has the lemma `deus`. Cards that share a lemma are siblings, which the app keeps apart in a session, and the lemma list is how the app counts vocabulary.

Use the same spelling for a lemma every time it appears. Concept and phrase cards have no lemma.

## The card types

### vocab

Target language to meaning, self-graded.

```json
{ "id": "la-02-v-terra", "type": "vocab", "lemma": "terra",
  "prompt": "terra, terrae, f.", "answer": "earth", "accept": ["land", "ground"],
  "reverse": true, "tags": ["decl-1"] }
```

- The prompt is the full dictionary entry: nominative, genitive and gender for nouns. For verbs, give the principal parts as far as the course has taught them.
- `answer` is the main meaning, `accept` the other common ones. A `/` lists alternatives for one slot ("he/she/it loves").
- Prefer dictionary entries over inflected forms. An inflected form (*amat*, *est*) gets a vocab card only when a lesson needs it before its paradigm is taught. It still gets a `lemma`, and never `reverse`.
- Pronunciation goes in `notes` when the spelling misleads (*agnus* is AH-nyoos).

### Reverse cards

`reverse` on a vocab card adds a second card that shows the meaning and expects the lemma, typed. Use it on at most three words a lesson, and only on words worth producing: words of the prayers and texts to be recited, and high-frequency nouns and verbs. Never use it on function words, inflected forms or chemistry words.

If another card already has the same meaning in its `answer` or `accept`, the reverse card would have two right answers. Give it a hint that rules one out:

```json
"reverse": { "hint": "not anima" }
```

`reverse.accept` lists other target-language answers that count as correct.

### concept

A grammar question, self-graded. Ask about one idea, and keep the answer to one or two sentences. Use at most one or two a lesson; the lesson itself teaches the idea, and the card only keeps it.

### phrase

A short phrase or sentence to translate, self-graded. Prefer sentences from the lesson's story or from the next milestone text. Explain the case of each important word in `notes`.

### ending

A form to produce, typed: one cell of a paradigm.

```json
{ "id": "la-02-e-anima-gen-pl", "type": "ending", "lemma": "anima",
  "paradigm": "decl1", "cell": "gen.pl",
  "prompt": "1st decl. · genitive plural of *anima*", "answer": "animārum",
  "tags": ["decl-1"] }
```

- `paradigm` and `cell` name the paradigm in `languages/la.json` and the cell in its grid. Both or neither.
- Write one card per **distinct form** of an ending, not one per cell. The ablative plural and dative plural are the same form, so card one and say so in `notes`.
- Spread a paradigm's cells over the lemmas already known, rather than running one word through every cell: genitive plural on *anima*, accusative plural on *terra*.
- Never card a cell whose answer is in the prompt. The nominative singular is the dictionary form, so it has no card.
- **Verbs**: there are no verb grids yet. Card the personal-ending sets and the tense and mood signs (*-ba-*, *-bi-*), and write full-form cards only for irregular verbs (*sum*, *possum*, *eō*, *volō*, *ferō*). Leave `paradigm` and `cell` off verb cards until the pack has a verb paradigm.

### parse

A bare form; the learner taps every cell of the grid that it fills.

```json
{ "id": "la-02-x-aquae", "type": "parse", "lemma": "aqua",
  "prompt": "aquae", "answer": ["gen.sg", "dat.sg", "nom.pl"], "tags": ["decl-1"] }
```

- The prompt is the form alone. The app labels the grid, so no instruction is needed.
- `answer` lists **every** cell the form can fill in that grid. A missing cell makes a right tap wrong.
- Use words other than the paradigm's model word, and prefer forms that fill more than one cell: those are the ones that trip up reading.
- `grid` defaults to `case5`. From the lesson that teaches the vocative, new noun parse cards use `"grid": "case6"`. Parse cards for adjectives or verbs wait until the pack has a grid for them; ask for it to be added first.

### headword

An `ending` card tagged `headword`: a form in the prompt, the dictionary headword as the typed answer. It trains looking a word up.

```json
{ "id": "la-03-h-hominem", "type": "ending", "lemma": "homō",
  "prompt": "*hominem*: dictionary headword?", "answer": "homō",
  "notes": "*homō, hominis, m.* The stem comes from the genitive.", "tags": ["headword"] }
```

From the 3rd declension on, write one for each new noun whose stem differs from its nominative (*rēx, rēgis*). From principal parts on, write one for each verb with an unpredictable stem (*tulit* → *ferō*, *dedit* → *dō*).

### cloze

An `ending` card tagged `cloze`: a sentence with exactly one `___`, and the lemma of the missing word in parentheses. The answer is the missing form.

```json
{ "id": "la-04-z-genesis-terram", "type": "ending", "lemma": "terra",
  "prompt": "In prīncipiō creāvit Deus caelum et ___. (terra)", "answer": "terram",
  "notes": "Accusative: the direct object of *creāvit*, like *caelum*. Genesis 1:1.", "tags": ["cloze"] }
```

Take the sentence from the story or a milestone text, and blank an ending that has already been taught. Say why that case in `notes`. Prefer Vulgate and Seneca sentences to prayers learned by heart, where the answer comes from memory rather than grammar.

## Writing the text

- **Macrons** on every long vowel, in every field. The app tolerates missing macrons in typed answers, but only when the card's text has them right.
- **Spelling**: *ae* and *oe*, not *æ* and *œ*; *i*, not *j*; no stress accents. Use *caelum*, not *coelum*. check-cards warns on any spelling variant listed in `languages/la.json`.
- **Liturgical spellings stay as printed** in the prayers the course reads: *quotīdiānum* and *tentātiōnem* in the *Pater Noster*, not the classical *cottīdiānum* and *temptātiōnem*. Cards quoting or teaching those words use the liturgical form, and `notes` gives the classical one.
- **strictMarks**: set `"strictMarks": true` on a typed card whose answer, written without its macrons, would be a different real form that no card has yet (*vēnit* and *venit*, *manūs* and *manus*). The app already catches clashes with forms the cards do have.
- **Markup**: `*italic*` and `**bold**` only, in prompts, notes and self-graded answers. A typed answer and its `accept` entries are plain text. In English text, italics mean Latin: the app reads an italic span as Latin, so put English words in quotes rather than italics ("root of 'animate'").
- **Tags** name topics: `decl-1`, `cases`, `neuter`, `chemistry`. `headword` and `cloze` are tags the app reads. A tag that repeats the card's type adds nothing; leave it off new cards.
- **No personal names** of real people other than authors and figures in the texts. Card files are public.
- `hint` sits behind a button and caps the rating at Hard. Use it rarely.
- `speak` replaces the spoken text where speech is allowed. Leave it off until the voice has been tested on the iPad.

## Choosing new words

1. Words from the next milestone text (`docs/syllabus.md` lists them), so it can be read when the course reaches it.
2. Words from the lesson's story passage.
3. Then by frequency rank in the DCC Latin Core Vocabulary (Dickinson College Commentaries, C. Francese et al., CC BY-SA 3.0, <https://dcc.dickinson.edu/latin-core-list1>), which belongs in the project's files for this purpose.

Chemistry words go in `notes`, or at most one or two cards a lesson. Mark Late or Medieval Latin words as such in `notes` (*cuprum*).

## Changing earlier cards

A card already in the app is changed in place only when it still tests the same fact:

- **Same fact, edit in place**: a typo, a macron, an added `accept`, a better note, a missing valid parse cell.
- **Different fact, new card**: retire the old one with `"retired": true` and write the replacement in the current lesson's file, under a new id. Cards never move between files.

Make fixes directly in the earlier file, and list them in the pull request description, one line per card: its id, the field, and why. When a fix changes a card's answer, run `npm run check-cards -- --base origin/main` and confirm the change still tests the same fact.

## Before committing

Run `npm run verify` and fix every failure. Mention any check-cards warnings in the pull request. check-cards catches most of the list below, but not all of it, so check each, and fix the file rather than noting the problem:

1. The file parses as JSON, `lesson` matches the file name, and every id starts with `la-NN-` for this lesson.
2. No id has been used before, in this file or an earlier one.
3. Every vocab, ending and parse card has a `lemma`, and each lemma's vocab card comes before the cards that use it.
4. The instance count, counting reverse cards, is within the budget.
5. No card's answer appears in its own prompt.
6. Every parse answer lists every cell the form fills, and only cells of its grid.
7. Every reverse card's meaning is unique, or it has a `hint`.
8. Macrons are complete, and no typed answer has markup.
9. Every cloze prompt has exactly one `___`.
