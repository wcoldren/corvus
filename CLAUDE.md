# corvus

A spaced-repetition flashcard app for Latin, plus the course it serves. `SPEC.md` is the source of truth for the app; `README.md` has the layout.

## Lesson sessions

Lessons are taught in chats in the claude.ai project "Learning Latin", which attach this repo. The repo is the only copy of the course files; the project holds no copies of them.

- `docs/syllabus.md`: the course plan. Its Cards column maps syllabus rows to card files, and the next lesson takes the first blank row.
- `docs/card-authoring.md`: how to write a lesson's card file, with the budget, ids and pre-commit checks.
- `cards/schema.json` and `languages/la.json`: what a card file must validate against.

A lesson that produces cards ends with one branch and one pull request containing:

1. `cards/lesson-NN.json`, where `NN` is the next unused lesson number (one more than the highest existing file), not the syllabus row.
2. Any fixes to earlier cards, edited in place in their own files.
3. The syllabus's Cards column filled in for the rows the lesson covered.

Run `npm run verify` before committing and fix every failure. Mention any check-cards warnings in the pull request. Never push to `main`: a push to `main` deploys, so the learner merges.

## Rules

- Card ids are permanent; review history is keyed by them. Never rename, renumber or reuse one. Retire a card with `"retired": true` instead of deleting it.
- Card files and docs are public. No personal names other than authors and figures in the texts.
- No Claude co-author lines or session links in commits or pull requests.
