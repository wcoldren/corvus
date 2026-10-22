# corvus

A spaced-repetition flashcard app for learning Latin, built to run from the iPad Home Screen and to work offline. It schedules reviews with FSRS, the algorithm modern Anki uses, and keeps all review history on the device.

The cards follow a course in Ecclesiastical Latin that aims at reading Church and classical texts in the original: the Vulgate, the prayers of the Office, Seneca, Cicero, Augustine and Aquinas.

This is a personal project. It is shared as is, with no support, no guarantee that it works, and no promise that anything here stays the same.

## What's here

| Path | What it is |
| --- | --- |
| `SPEC.md` | How the app works: card types, scheduling, storage, offline behavior |
| `src/` | The app (TypeScript, Vite) |
| `cards/` | One card file per lesson, and the schema they follow |
| `languages/` | The Latin language pack: parse grids, paradigms, speech rules |
| `docs/syllabus.md` | The 80-lesson course plan |
| `docs/card-authoring.md` | How a lesson's card file is written |
| `scripts/` | `check-cards`, the card file validator |

## Running it

Node 24 or later.

```sh
npm ci
npm run dev       # local dev server
npm run verify    # check-cards, typecheck, tests and build
```

## License

Free for personal, educational and other noncommercial use. Commercial use is not permitted.

- **Code** (everything except the content below): [PolyForm Noncommercial 1.0.0](LICENSE).
- **Lesson content** (`cards/lesson-*.json` and `docs/`): [CC BY-NC-SA 4.0](LICENSE-CONTENT).

Both licenses come without warranty and exclude liability. Quoted scripture, prayers and classical texts are in the public domain.

Copyright 2026 wcoldren.
