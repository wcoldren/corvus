# Corvus: app spec

## Goal

A daily review app that makes Latin vocabulary, endings, and grammar stick using spaced repetition. Misses come back soon, while correct answers get pushed out to days, weeks, and months. It should open from the iPad home screen, work offline, and take about 10 minutes a day.

## Users and devices

- One user. No accounts and no server.
- Primary device: iPad (Safari, added to the Home Screen). It must also work in desktop browsers for development.
- Touch-first, with a large tap target and a comfortable typing field. It should use the iPad keyboard well, with no autocorrect or autocapitalize on answer fields.

## Core concepts

- **Card**: one prompt and its answer, loaded from `cards/*.json` (see `cards/schema.json`).
- **Review state**: the FSRS state per card id (stability, difficulty, due date, lapses, and so on), plus a log of every review. It is stored in IndexedDB.
- **New card**: a card with no review state yet. New cards are introduced in lesson order, then in file order.
- **Lesson unlock**: a card file only enters the new-card queue once its lesson is unlocked. Lessons unlock manually from Settings ("I've finished Lesson N") so that cards never get ahead of the lessons.

## Scheduling

- Use `ts-fsrs` with default parameters and a desired retention of 0.9. Retention should be adjustable in Settings.
- A session works like this: due reviews come first (most overdue first), then up to N new cards, where N defaults to 10 and is adjustable. Never show more than about 150 reviews in one session; any remainder carries to the next day.
- The ratings are Again, Hard, Good, and Easy. For typed and grid answers, the app suggests a rating: wrong is Again, right is Good, and right with only macron slips is Hard. The user can override the suggestion before continuing.
- A card answered Again returns later in the same session (FSRS learning steps).

## Card types and how they're answered

| type | Prompt shows | Answer mode | Notes |
| --- | --- | --- | --- |
| `vocab` | A Latin word with its dictionary form, or the English meaning when `reverse` is set | Typed, or reveal | Latin→English is self-graded by default; English→Latin is typed |
| `concept` | A question about grammar ("What does the genitive do?") | Reveal and self-grade | Free-text answers are too varied to auto-check |
| `ending` | A paradigm cell ("1st decl., gen. pl. of *aqua*") | Typed | Checked against `answer` and `accept` |
| `parse` | A form ("*aquae*") | Grid | A grid of 5 cases × 2 numbers; tap every possible combination. All must be right |
| `phrase` | A short phrase or sentence | Reveal and self-grade | Used for translations like *Agnus Deī* |

A `vocab` card with `"reverse": true` produces two cards in the app: the original and a reversed English→Latin card. The reversed card's id is the original id plus `~r`.

### Answer checking (typed)

1. Normalize both answers: trim, lowercase, collapse spaces, and use Unicode NFC.
2. An exact match with `answer` or any `accept` entry means **correct**.
3. A match only after stripping macrons and diacritics means **correct, macron slip**. Show the right form with the macrons highlighted, and suggest Hard.
4. Otherwise the answer is **wrong**. Show a letter-level diff so it's clear which ending was off.

For English answers, ignore a leading "the", "a", "an", or "to" when comparing.

## Screens

1. **Home**: due count, new count, streak, "Start review", and a lesson-progress line ("Unlocked through Lesson 3").
2. **Review**: the prompt, the answer input (typed, grid, or reveal), a speak button, then the feedback and rating buttons. Show progress through the session.
3. **Browse**: all cards grouped by lesson, with a search box. Tapping a card shows its review history.
4. **Settings**: new cards per day, desired retention, unlocked lesson, speech voice and rate, export/import, and reset.

## Speech

- A speak button uses the Web Speech API. The default voice prefers `it-IT`, because Italian is very close to Ecclesiastical Latin pronunciation. Speak the card's `speak` field if present, otherwise the Latin side.
- On iOS, speech must start from a user tap. Never autoplay.

## Data and backup

- Store review state and logs in IndexedDB. Call `navigator.storage.persist()` on first run.
- **Export** downloads a dated JSON file of all review state and logs. **Import** restores from that file after a confirmation step.
- Every 7 days, if no export has happened, show a gentle reminder on Home.
- Card content is never stored in IndexedDB as the source of truth. It always comes from the deployed `cards/` files, so editing card text never loses history.

## Offline and install

- A web app manifest with name "Corvus", a raven icon (simple and original), and `display: standalone`.
- A service worker precaches the app shell and all card files, and updates them on the next launch after a deploy.
- The iPad flow is: open the Pages URL in Safari, choose Share, then Add to Home Screen.

## Game-ready hooks (build the hooks now, the game later)

- Emit simple app events (`review:answered`, `session:completed`, `lesson:unlocked`, `streak:changed`) through one small event bus so that a game layer can subscribe later.
- Keep `unit`, `lesson`, and `tags` on every card available to the UI.
- Game rule for later: the game may decorate the experience but must never change scheduling.

## Card validation

`npm run check-cards` validates every card file against `cards/schema.json`. It also fails on duplicate ids across all files, on `lesson` mismatches between a file and its cards, and on `parse` cards whose answers use unknown case or number values.

## Milestones

1. **M1: Review loop.** Scaffold, load cards, FSRS scheduling, typed and reveal answers, IndexedDB, and a Home screen. Deploy to GitHub Pages and install on the iPad. *Done when* the learner can do a real review session on the iPad offline and their progress survives closing the app.
2. **M2: Full card types.** Parse grid, reverse vocab cards, macron-tolerant checking with a diff, speak button, Browse, Settings, and export/import.
3. **M3: Polish.** Streaks, a review heatmap, and stats per lesson and per card type.
4. **M4: Game layer.** Brewing sessions, the abbey rooms that unlock by unit, and Corvus's commentary. This will be specced separately later.

## Out of scope for now

Accounts, cloud sync, multiple users, audio recordings, and in-app card editing (cards are edited as JSON in the repo).
