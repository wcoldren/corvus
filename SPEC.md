# Corvus: app spec

## Goal

A daily review app that makes Latin vocabulary, endings and grammar stick using spaced repetition. Misses come back soon, while correct answers get pushed out to days, weeks and months. It opens from the iPad Home Screen, works offline, and takes about 20 minutes a day, rarely more than 30.

The code knows nothing about Latin. Everything language-specific lives in data: the card files and the language pack (`languages/la.json`). Latin appears in this spec only as examples.

## Users and devices

- One learner. No accounts and no server.
- Primary device: an iPad, with the app added to the Home Screen from Safari. It must also work in desktop browsers for development.
- Touch-first, and it should use the iPad keyboard well (see Input and display).

## Core concepts

- **Card file**: `cards/lesson-NN.json`, one per lesson, validated by `cards/schema.json`. Only files matching `cards/lesson-*.json` are card files; the build and check-cards use the same glob. `lesson` is the number of the lesson chat that wrote the file and is the unlock key. `unit` is the syllabus unit, used by quizzes and later by the game.
- **Language pack**: `languages/<code>.json`, validated by `languages/schema.json`. It holds the parse grids, paradigms, the on-screen key bar and its help text, speech respelling with test vectors, the learner's own language (its code and the words ignored in typed meanings), and printed spelling variants. One deployment teaches one target language, but stored state is keyed by language code so a second one would not collide.
- **Card**: one prompt and its answer. Its `id` is permanent: review history is keyed by it (see Card history epoch).
- **Lemma**: the dictionary headword a card is about (`amō` for a card on *amat*). Cards that share a lemma are siblings. The lemma is also the answer of the reverse card.
- **Reverse card**: a vocab card with `reverse` set also yields a card with id `<id>~r` that runs the other way (see Card types).
- **Review state**: the scheduler's state for one card id. It is a cache, rebuilt from the review log on demand (see Data contract).
- **New card**: an unlocked card with no review state. New cards are introduced in lesson order, then file order. File order is the deliberate introduction order, set by the lesson chat.
- **Unlock**: a card file enters the new-card queue only once its lesson is unlocked, so cards never get ahead of the lessons. Home shows "I've finished Lesson N: unlock its cards" whenever a deployed file is above the unlocked lesson. Unlocking is one tap and cannot be undone from the UI.
- **Study day**: the day a review counts toward. It rolls over at 04:00 local time by default (Settings). "Today", daily limits, Home counts, the streak and the forecast all use it.

## Card types and how they're answered

| type | Prompt shows | Default mode | Answer |
| --- | --- | --- | --- |
| `vocab` | The dictionary entry (*aqua, aquae, f.*) | reveal | The meaning, self-graded |
| `vocab` `~r` | The forward card's answer, plus `reverse.hint` | typed | The lemma, or a `reverse.accept` entry |
| `concept` | A question about grammar | reveal | Self-graded; free text is too varied to check |
| `ending` | A paradigm cell ("1st decl., gen. pl. of *aqua*") | typed | `answer` or an `accept` entry |
| `parse` | A bare form (*aquae*) | grid | Every cell of the card's grid that the form fills |
| `phrase` | A short phrase or sentence | reveal | A translation, self-graded |

- `mode` may switch a vocab, concept, ending or phrase card between typed and reveal. Grid mode belongs to parse cards only, and parse cards always use it.
- **Reverse cards** are made only for words worth producing (see `docs/card-authoring.md`). The prompt is the forward card's answer, so "life" with the hint "not *anima*". The expected answer is the lemma alone, not the whole dictionary entry; feedback then shows the full forward prompt, so the genitive and gender are seen every time. `reverse.retired` hides the reverse card only. Retiring the forward card retires both.
- **Parse grids** come from the language pack. A card names one with `grid`, or gets the pack's `defaultGrid`. The UI labels the grid from its row and column labels, which is why parse prompts are the bare form. The learner taps every cell that applies; the answer is right only when the set of tapped cells equals `answer` exactly.
- **Headword cards** are `ending` cards tagged `headword`: a form in the prompt (*hominis*), the lemma as the typed answer (*homō*). They train the skill of reading with a dictionary.
- **Cloze cards** are `ending` cards tagged `cloze`, with exactly one `___` in the prompt and the lemma in parentheses ("In prīncipiō creāvit Deus caelum et ___. (terra)" → *terram*).
- **Which language each field is in.** The app needs this for the input's `lang`, the key bar, text size and check-cards' variant warning:

  | type | Target language | Learner's language |
  | --- | --- | --- |
  | `vocab` | `prompt`, `lemma`, `reverse.accept` | `answer`, `accept`, `reverse.hint` |
  | `concept` | | `prompt`, `answer` |
  | `ending` | `answer`, `accept`, `lemma`; the `prompt` of a cloze card | `prompt` |
  | `parse` | `prompt`, `lemma` | |
  | `phrase` | `prompt` | `answer` |

  `notes` and `hint` are in the learner's language. In any field in the learner's language, `*italic*` spans count as target-language text (the form in "genitive plural of *anima*"), so card files keep italics for target-language words.
- `hint` is behind a Hint button. Using it is logged and caps the suggested rating at Hard.
- `notes` are shown after answering. On a reveal card, `accept` entries are shown under the answer as "also: …".
- A retired card leaves every queue and count. Its history stays and still exports.

## Workload budget

The budget is set by the daily time, not by how much material there is. The operating point is **a 20-minute daily goal, with 30 minutes as a soft ceiling** that a normal day stays under. At one lesson every 1.5 days, that yields **about 1,100 lemmas by the end of the syllabus**, or nearer 900 if review and reading lessons add none. Lesson counts in this section are the syllabus's 80 rows. The first chats each covered several rows, so chat numbers run behind row numbers.

The numbers behind that, simulated day by day with FSRS-6 default weights at retention 0.9, the scheduler config below, the new-card allowance below, and the per-lesson budget in the table:

- Over the first 120 days: about 18 min/day on average, 22 on the busiest twentieth of days, and about 26 at most. Over a year the average falls to about 11, since cards learned early come up rarely.
- With a missed day about one day in ten, the day after a miss is the worst day: about 28 to 29 min at most, with the daily cap below holding it under 30.
- The cards keep pace with the course. The 80th lesson unlocks on day 119 and its last card is introduced around day 127 (around day 137 with missed days).
- If answering is 25 percent slower than assumed, the allowance holds the average near 20 by introducing new cards more slowly: the last card enters around day 153, and the worst days after a miss reach the mid-30s. At 25 percent faster, the average is about 14 and nothing waits.
- The cards as first written (about 40 instances a lesson, 10 new a day) cost about 18 min/day, left 1,965 cards waiting at day 120 (about 50 lessons behind), and introduced the last card around day 316. Taking each lesson's cards whole instead cost about 46 min/day, with 73-minute peaks.
- These used placeholder answer times (reveal 8 s, grid 12 s, typed 15 s, plus 10 s for a miss and 6 s for a new card's first showing), and they assume the model's predicted recall is the true recall. Rerun them after 30 days of logged review times.

**Per-lesson budget**, by type, protecting cheap forward vocabulary:

| Kind | Per lesson |
| --- | --- |
| New lemmas (forward vocab) | about 13 to 14 |
| Reverse cards | at most 3 |
| Ending, parse, headword and cloze | at most 4 |
| Concept and phrase | at most 1 to 2 |
| Total instances, counting `~r` | about 20 to 22 |

An instance is one schedulable card, so a vocab card with `reverse` counts twice. check-cards also estimates each file's first-pass cost in seconds (reveal 8 s, grid 12 s, typed 15 s, until logged means replace them) and warns above 240 s. When a lesson has more to say, cut reverse cards and paradigm cells, never lemmas.

Lessons 1 to 3 were written before this budget and hold 17, 16 and 14 instances. Lessons 2 and 3 were cut to the per-kind limits. They have fewer lemmas than the budget allows, because the trim cut forms and concepts, not words.

The main workload levers are the card budget, the learning steps and the new-card allowance. Desired retention is a minor one: 0.85 saves roughly 10 to 15 percent of reviews and costs more forgetting.

## Card history epoch

The epoch is the first real review recorded in the installed Home Screen app: the first one after the Reset that ends the M1a acceptance run.

- **Before it**, card files may be restructured freely: cards deleted, renamed, merged or moved. Testing happens only in a Safari tab, the Simulator or a desktop browser.
- **After it**, only two kinds of change are allowed. A same-fact fix is made in place: a typo, a macron, an added `accept`, a note, or a missing valid parse cell. If the fact a card tests changes, the old id gets `"retired": true` and a new id carries the new fact. Ids are never renamed, reused or deleted, and cards never move between files.
- The epoch is recorded in `cards/epoch.json`, `{date, commit}`, where `commit` is the deployed build the first review used. check-cards rule 10 applies only once that file exists.
- Test reviews in the installed app don't start the epoch as long as they are cleared: export them, then Reset. The M1a acceptance run ends this way (criterion 12).

Epoch: not yet reached.

## Scheduling

### The scheduler

- `ts-fsrs` pinned to exactly `5.4.2` (FSRS-6, 21 weights), with `package-lock.json` committed. Upgrading to a new major (v6 moves to FSRS-7 with a new API) is a planned migration, checked by replaying an exported history, never a routine bump.
- Only `src/scheduler.ts` imports ts-fsrs. It converts to and from Corvus's own card state, applies the day-boundary shift below, and takes an injected clock.
- The config is written out in full, never left to library defaults:

  | Setting | Value |
  | --- | --- |
  | `w` | ts-fsrs default weights until custom ones are set (M3) |
  | `request_retention` | 0.90; Settings allows 0.80 to 0.95 |
  | `maximum_interval` | 36500 |
  | `enable_fuzz` | `true` (5.4.2 defaults to false) |
  | `enable_short_term` | `true` |
  | `learning_steps` | `['10m']` |
  | `relearning_steps` | `['10m']` |

  A unit test fails if any value differs from this table. The active config is stored as a params row holding every value in the table, and every review records its `paramsId`.
- With one 10-minute step, Good on first sight graduates the card, and Again brings it back in about 10 minutes, within the same session through learn-ahead. Each new card costs about one presentation instead of two.
- Changing desired retention affects each card's next interval only, from its next review. Existing due dates are not changed.

### Days and the clock

- `studyDay` is the local date of (now − rollover hour).
- ts-fsrs 5.4.2 counts elapsed days by UTC calendar day. The wrapper corrects this: before each call it shifts `now`, `due` and `last_review` by `shiftMin` (the local UTC offset minus the rollover hour, in minutes), and shifts the results back. Stored state and exports are always in real time. `shiftMin` is logged with each review, and replay and undo use the logged value, so changing the rollover hour or crossing a time zone affects only future reviews.
- The review time used is `max(now, last_review + 1 s)`. Home warns when the clock reads more than 5 minutes earlier than the newest log row.
- When the app resumes (`visibilitychange` to visible, or `pageshow`), it recomputes the study day and Home counts and checks for an update. A session begun on an earlier study day ends, and its queue is rebuilt from IndexedDB.

### Building today's session

A pure function, `buildQueue(cards, states, log, settings, now)`, so it can be unit-tested on an injected clock.

1. **Reviews due**: every review-state card due before the next rollover. Learning and relearning cards use their exact due times instead.
2. **Order**: ascending retrievability at session start, computed through the wrapper. Ties, which are common, are broken by a shuffle seeded from the study day, so a lesson's cards never come back as a recited sequence.
3. **Daily cap**: at most 120 reviews from earlier days per study day, counted from the log. The rest carry over. The cap is what keeps the day after a missed day under the 30-minute ceiling. New cards and same-day steps don't count toward it.
4. **New cards**: today's allowance (below) is interleaved, one new card after every 4 reviews, so a heavy review day still introduces some.
5. **Spacing**: cards with the same lemma are never shown back to back, and a card that just failed comes back no sooner than 3 cards later.
6. **Learn-ahead**: when nothing else is due, learning cards due within the next 20 minutes (Settings) are shown early, in due order. The session ends when none remain. Learning cards still pending carry over and come first next session.

### New-card allowance

```
newToday = min(maxNew, floor((goalSec − dueToday × secPerReview) / secPerNew)) − newAlreadyToday
```

- `goalSec` is the daily goal (Settings, default 20 minutes).
- `secPerReview` is the mean logged `totalMs` over the last 500 reviews, each capped at 60 s; 12 s until there is data. It is the mean, not the median: the median lands on the cheapest card type, and in a simulation run at a 15-minute goal it overshot by 3 to 5 minutes a day.
- `secPerNew` is 1.4 × `secPerReview` + 6 s.
- `maxNew` is a ceiling (Settings, default 25), not the usual limit.
- A negative result is 0, so new cards pause by themselves when reviews fill the day.

After a session ends with new cards still waiting, "Learn 5 more" introduces five more. It can be repeated, and the cards are logged like any others, so tomorrow's allowance accounts for them.

### Siblings and reverse cards

- A `~r` card enters the new queue no earlier than the study day after its forward card's first review. It counts toward the new-card allowance.
- If two siblings are due the same day, both are shown, apart (spacing rule above). Nothing is buried.

### Undo

Undo reverses the most recent answer and can be repeated back to the start of the session. It restores the card state from the log row's `before` snapshot (exact, with no reliance on ts-fsrs `rollback`), appends an undo row naming the undone row, and puts the card back at the front of the queue. Log rows are never edited, so merging exports stays safe. Undone rows are left out of replay, stats and the optimizer.

## Answer checking (typed)

1. **Normalize** both sides: Unicode NFC, trim, lowercase, collapse spaces, and strip punctuation (every Unicode `P` character except a hyphen or apostrophe inside a word). When the expected answer is in the learner's own language (a typed meaning), whole words from the pack's `learner.ignoreWords` are dropped from both sides.
2. **Alternatives**: in `answer` and `accept`, a word joined by `/` lists alternatives for that slot. "he/she/it loves" accepts "he loves", "she loves" and "it loves".
3. **Exact match** with any expected answer: **correct**, suggest Good.
4. **Match only after folding marks** (NFD, remove every `\p{M}` character, NFC):
   - a. If what was typed is itself a form of another card in the loaded corpus, and not accepted for this card, it is a **wrong form**. Suggest Again and name it: "*aqua*: nom. sg.". The corpus forms are every card's lemma, the answers and `accept` entries of target-language typed cards, and the forms of parse cards, each labelled with its cell where one is known.
   - b. If the card has `strictMarks`, it is **wrong**, and the feedback shows what was typed. This covers collisions the corpus doesn't hold yet (*vēnit*/*venit*).
   - c. Otherwise it is a **slip**: highlight the missing marks and suggest Good. A setting ("Count mark slips as Hard") suggests Hard instead; it is off by default, because Hard is a pass that also raises the card's difficulty for good.
5. Otherwise it is **wrong**: suggest Again. M1 shows the right answer; M2 adds a letter-level diff so it's clear which ending was off.

The suggestion is never Easy, and using the hint caps it at Hard. The learner can always choose another rating. The suggested button is the largest target, and Return accepts it.

## Screens

1. **Home**
   - "Due today: N · about M min", from the logged means.
   - "New today: K", and "Waiting: X cards from Lessons A to B (about D days at this pace)".
   - The unlock button, and "Start review".
   - Advisories, one line each: a review day is suggested when the waiting cards exceed one lesson's budget or tomorrow's forecast exceeds the goal; an export reminder after 7 days without one; the Safari-tab banner; the clock warning.
2. **Review**
   - The prompt, the answer input (typed, grid or reveal), Hint, and the speak button.
   - After answering: feedback with the expected form and highlights, the notes, and the rating buttons, each showing its next interval.
   - Undo, and progress: minutes used against the goal, and cards left.
   - When the goal is reached: "Goal reached: stop here or keep going".
3. **Browse** (M2): every card by lesson, with search.
   - Tapping a card shows its review history.
   - Filters: leeches, flagged, suspended.
   - A card whose text changed since its last review is marked "edited".
4. **Settings**: export, import, Reset, rebuild schedule, build id and newest lesson in this build, storage persistence status, and "Check for updates". From M1b: daily goal and max new. From M2: desired retention, the slip setting, rollover hour, the learn-ahead window, voice and rate, leech threshold, and text size.
5. **Recovery**: see Offline, install and updates.

Leeches (M2): a card whose lapses reach a threshold (default 6) is marked a leech, gets a banner after it is answered, and keeps being scheduled. Any card can be flagged with a note, or suspended and unsuspended. Flags and suspension are `manual` log rows, so they survive a rebuild and an import; card state caches them, and card files never hold them.

## Input and display

- Typed answers use `<input>` inside a `<form>`, with `lang` set to the language of the expected answer (the pack's `code` or `learner.lang`) and `autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off" enterkeyhint="go"`. The input font is at least 18 px.
- A key bar above the input, on cards whose answer is in the target language, holds the pack's `inputKeys`. Its buttons insert at the caret with `setRangeText` and use `pointerdown` plus `preventDefault`, so the field keeps focus and the keyboard stays up. Settings shows the pack's `inputHelp` on typing marks.
- **Keys**: Enter checks the answer, and Enter again accepts the suggested rating. When the input isn't taking text, 1 to 4 rate and Space reveals. The next card's input is focused synchronously inside the rating handler.
- The review screen is laid out top-down within the height reported by `visualViewport`, so nothing sits behind the on-screen keyboard. It works in narrow Split View and Slide Over widths, and pads for the safe areas.
- Target-language text is at least 28 px, body text at least 18 px, sized in rem, with a text-size setting. Light and dark themes follow the system. Highlights use underline or weight as well as colour, text contrast is at least 4.5:1, and every tap target is at least 44 px, with a visible selected state on grid cells.
- Card text is markdown-lite: `*italic*` and `**bold**` only, in prompts, notes and reveal answers. One renderer builds `em` and `strong` nodes with `textContent`. Card data never goes through `innerHTML`, and a CSP meta tag (`default-src 'self'`) is set in the production build. Typed answers are plain text.
- `answerMs` pauses while the page is hidden.

## Speech

- A speak button uses the Web Speech API. It never autoplays; on iOS speech must start from a tap.
- The voice defaults to the pack's `speech.lang`, falling back to any voice for that language, and can be changed in Settings. Text goes through the pack's `speech.rules` before speaking, and never changes what is displayed.
- What is spoken, so the button never gives the answer away:

  | Card | Before answering | After answering |
  | --- | --- | --- |
  | vocab | the prompt | the prompt |
  | `~r` | nothing | the forward card's prompt |
  | ending | nothing | the answer; a cloze speaks its prompt with the blank filled |
  | parse | the prompt | the prompt |
  | phrase | the prompt | the prompt |
  | concept | nothing, unless `speak` is set | the same |

  A card's `speak` field replaces the text where speech is allowed.
- Test the default voice on the iPad early in M2: whether it is installed, how it reads the respelled text, and its stress. Do this before writing any stress fixes into `speak`.

## Data contract

Stored history is the one thing that can't be rebuilt, so its shape is fixed before the first review.

### Storage

IndexedDB database `corvus`, opened through `idb`, with these stores:

- `reviewLog`: the record of truth. Rows are appended and never changed. Indexes: `byCard`, `byDay`, `byTs`.
- `cardState`: review state per card id, with dates as epoch ms. It is a cache, rebuilt by replaying the log ("Rebuild schedule" in Settings). The app never deletes state for an id it no longer finds in the card files; Settings shows "N orphaned cards".
- `params`: one row per scheduler config: `{id, lib: "ts-fsrs@5.4.2", model: "FSRS-6", w, retention, fuzz, shortTerm, learningSteps, relearningSteps, maxInterval}`.
- `daily`: one row per study day (reviews, new cards, total ms), updated in the same transaction as each review. Home and the limiter read these and a bounded cursor over recent rows, never the whole log.
- `meta`: settings, `unlockedThrough` keyed by language (`{ "la": 3 }`), the last export date and the database version.

Card content is never stored in IndexedDB. It always comes from the bundled card files, so fixing a card's text never touches its history.

Other storage names: localStorage keys start with `corvus:`, caches with `corvus-`. The service worker never touches anything else.

### The review log row (v1)

Each answer writes its log row, the new card state and the daily aggregate in **one** readwrite transaction.

| Field | Meaning |
| --- | --- |
| `id` | `crypto.randomUUID()`, so rows from different devices or backups merge |
| `v` | row format version, 1 |
| `cardId` | the card, including `~r` ids |
| `kind` | `review`, `undo` (with `undoes`: the undone row's id), or `manual` (with `action`: `suspend`, `unsuspend`, `flag`, `unflag` or `forget`, which returns one card to new; `note` on a flag). On non-review rows the review fields are null. |
| `ts` | review time used, epoch ms; `wallTs`, the raw clock reading, when it differs |
| `studyDay`, `shiftMin`, `tzOffsetMin` | the day the review counts toward, and the exact shift applied |
| `rating` | the final rating, 1 to 4 |
| `suggested` | the app's suggestion, or null for self-graded cards |
| `mode` | `typed`, `reveal` or `grid` |
| `response` | the typed text, the tapped cells, or null |
| `outcome` | `correct`, `slip`, `wrongForm`, `wrong` or `revealed` |
| `hintShown` | boolean |
| `answerMs`, `totalMs` | prompt to submit, and prompt to rating |
| `before` | the card state before this review, or null for a new card |
| `paramsId` | the scheduler config used |
| `cardHash` | a short hash of the card's prompt, answer and accept as reviewed |
| `sessionId`, `buildId` | which session and which build |

A unit test rebuilds every card's state by replaying its rows in (`ts`, `id`) order, using each row's `paramsId` and `shiftMin`, and compares the result with the stored state. It runs in two time zones and across a DST change.

### Versioning

The database version only goes up, through one migration per step, each with a test. idb's `blocking()` handler closes the connection and asks for a reload. If a write fails, or the connection closes (iPadOS can drop it after the app is backgrounded), the app reopens once and retries the same write, holding the rating in memory. If the retry fails, a red "Not saved. Reload." banner blocks the next card.

### Export

- Format v1: `{format: "corvus-backup", formatVersion: 1, exportedAt, buildId, dbVersion, settings, unlockedThrough, params, reviewLog, cardStates, counts}`. `cardStates` is there for checking; the log is the content.
- Two taps. "Prepare backup" builds the file in the background and shows its size, row count and newest review. "Share" then calls `navigator.share({files})` synchronously inside the tap, because a share that waits on anything first can lose the tap's permission and be refused. If file sharing is refused, it falls back to a download link. A plain `<a download>` is unreliable in an installed web app, which is why sharing comes first.
- The file is named `corvus-backup-YYYY-MM-DD.json`.

### Import and reset

- Import begins by forcing an export of the current data.
- It validates the format and version, then shows a summary: "File: 1,240 reviews, newest 2026-11-02. 37 are not on this device. Nothing here will be removed."
- On confirm, it merges: the union of log rows and params by id, and the higher `unlockedThrough` per language. It then rebuilds card state by replaying the merged log, and reports any card whose rebuilt state differs from the file's as a warning. Importing the same file twice changes nothing.
- "Replace all" is an advanced option behind a second, typed confirmation.
- Reset uses the same forced export and a typed confirmation, then deletes every store in the `corvus` database and every `corvus:` localStorage key. Caches are left alone.

## Offline, install and updates

### Build and identity

- Card files and language packs are bundled at build time with `import.meta.glob('/cards/lesson-*.json', { eager: true })`, and packs with `import.meta.glob(['/languages/*.json', '!/languages/schema.json'], { eager: true })`. A static site can't list a directory at runtime, and bundling puts the cards inside the precache. The build also writes `ids.json`, every card id including `~r` ids, for check-cards rule 10.
- Vite `base` is `/corvus/`, and every URL is built from `import.meta.env.BASE_URL`.
- Manifest: `id`, `start_url` and `scope` all `/corvus/`, `display: standalone`, name and short_name "Corvus", and a simple, original raven icon (a 180 px apple-touch icon, 192 and 512 px icons, and a maskable one). The viewport meta includes `viewport-fit=cover`.
- The base path, the manifest identity and the icon are frozen before the first install. Whether to use a custom domain is decided before the epoch. After that the origin is as permanent as the card ids, and moving it takes an export and an import.
- One page. Screens are hash routes (`#/`, `#/review`, `#/browse`, `#/settings`). The session never lives in the URL; it is rebuilt from IndexedDB on load.

### Service worker

- Hand-written, about a page of code, with no Workbox. It is registered only in production builds, so development never caches.
- The cache is named `corvus-<build hash>`, and a short post-build script lists the files to precache from Vite's build manifest. Install fetches with `cache: 'reload'` and calls `skipWaiting()`. Activate deletes only stale `corvus-*` caches and claims clients.
- Every navigation in scope gets the precached `index.html`, online or offline, since GitHub Pages has no rewrite to it.
- **Updates**: "on the next launch" is not reliable for a Home Screen app on iPadOS, which often resumes instead of launching. So the app calls `registration.update()` at start and whenever it becomes visible, at most once every 10 minutes. When a new worker takes control, the app reloads straight away if it is on Home with no session open. Otherwise it shows "New version ready (cards through Lesson N): it loads when this session ends" and reloads after the session.

### iPad facts the design depends on

- A Home Screen app's storage is separate from Safari's (WebKit bug 181849). Opened in a Safari tab, Corvus shows a persistent banner: "This is a Safari tab. Progress here is separate from the Home Screen app." That makes the tab a safe test bed.
- Deleting the Home Screen icon deletes the app's data. **Never delete the app or clear website data to fix a problem: export first, from the recovery screen if need be.** Whether iCloud device backups include this data is unverified, so they are not relied on.
- `navigator.storage.persist()` is called on first run, and its result is shown in Settings.

### Recovery

Startup runs inside a try/catch, with `error` and `unhandledrejection` handlers. If startup fails, a fallback screen from a small module that depends only on `idb` shows the error and offers "Export data" (the same share path), "Reload", and "Clear app cache". Clear app cache unregisters the service worker and deletes `corvus-*` caches, never IndexedDB. A card that throws while rendering or checking is skipped with a notice, and no rating is logged. The last 20 errors are kept in `corvus:errors` and shown in Settings.

## Daily workflow

1. The lesson chat in claude.ai writes `lesson-NN.json`, following `docs/card-authoring.md`, plus any fixes to earlier cards as `{id, field, value}` lists.
2. On the Mac, Claude Code saves the file into `cards/`, applies the fixes, runs `npm run verify`, and commits.
3. A push to `main` deploys, so it waits for an explicit go-ahead. GitHub Actions runs the verify job and then the deploy job.
4. The next time the app opens or resumes, it picks up the new build (see Updates).
5. After finishing the lesson, the learner taps "unlock" on Home.

## Lesson report (M2)

"Copy report for next lesson" puts a plain-text block of at most 40 lines on the clipboard, to paste into the next lesson chat together with the recap. It holds:

- A status line: unlocked through, new cards waiting (in days), the 7-day average minutes, tomorrow's forecast, and a card budget for the next lesson computed from the limiter's spare time.
- Up to 10 leech or flagged cards, each with its full current card JSON and recent wrong responses, so the chat can send back corrected cards under the same id.
- Known lemmas (vocab stability of at least 7 days) and shaky ones, so the next story passage can be written mostly from known words.
- In M3, the top three ending confusions.

The text is built when the screen opens, and `navigator.clipboard.writeText` is called synchronously in the tap, with a selectable text area as the fallback. Until this exists, the lesson chat asks for the Home counts, typed in by hand.

## Game hooks (build the hooks now, the game later)

- One small event bus with typed payloads:
  - `review:answered {cardId, logId, outcome, suggested, rating}`
  - `review:undone {cardId, logId}`
  - `session:completed {studyDay, reviews, newCards, ms}`
  - `lesson:unlocked {language, lesson}`
  - `streak:changed`, in M3
- Events are emitted only after the IndexedDB transaction commits. Errors in subscribers are caught and logged.
- `unit`, `lesson` and `tags` stay available to the UI.
- The game may decorate the experience. It may never add, skip or reorder cards, or change a rating. It gets the bus and read-only queries, nothing that writes. When `src/game` exists, a test checks that it imports nothing that does.

## Card validation (`npm run check-cards`)

Failures:

1. **Files**: only `cards/lesson-NN.json`, the same glob as the app. The file name matches `lesson`, lesson numbers are unique, and `unit` never decreases as lessons rise. Every file validates against `cards/schema.json`, and its `language` has a pack that validates against `languages/schema.json`.
2. **Ids**: every id starts with `<language>-<NN>-` for its own file, and ids are unique across all files, generated `~r` ids included.
3. **Duplicates**: no two non-retired cards share type, normalized prompt and answer.
4. **Modes**: each card's effective mode is valid for its type (see Card types).
5. **Plain text**: a typed answer, its `accept` entries, and, for a reverse card, the lemma and `reverse.accept` are NFC text with no markup.
6. **Grids**: grid and paradigm ids exist in the pack; every parse answer is a cell of the card's grid, and every `cell` is a cell of its paradigm's grid.
7. **Lemmas**: every vocab, ending and parse card has a `lemma`.
8. **Self-check**: every typed card's own answer and `accept` entries grade correct through the app's real checker module.
9. **Speech**: the pack's speech test vectors pass (also run by `npm test`).
10. **Registry**, once `cards/epoch.json` exists: every id in the live site's `ids.json` is present in the new build. Retiring is fine; disappearing fails, and so does a missing `ids.json`. Before the epoch the rule is skipped, so cards can still be restructured. Recovery from a failure is restoring the card from git history.

Warnings:

- A lesson over budget, in instances or estimated seconds.
- Target-language card text containing one of the pack's spelling variants.
- A `cloze` card without exactly one `___`.
- An `accept` entry equal to another card's answer.
- With `--base <ref>`, a card whose answer changed since that ref, so the change gets a deliberate look against the epoch rule.

It also prints each file's instance count and estimated seconds, and the cumulative lemma count.

## Testing and release

- `npm run verify` runs check-cards, `tsc --noEmit`, the unit tests and `vite build`. The Pages workflow runs it as a job that the deploy job `needs`, in one concurrency group. Rolling back means reverting the commit and letting the workflow redeploy.
- Unit tests cover at least:
  - answer checking, with cases drawn from the lesson data;
  - the pinned scheduler config;
  - single-step graduation;
  - the day boundary (a 21:00 review checked at 08:00, a session across 04:00, a review across UTC midnight, a DST change);
  - the clock clamp, and `buildQueue`;
  - replay against stored state;
  - import idempotence;
  - each database migration;
  - the markup renderer (`<b>x</b>`, `a < b`, an unmatched `*`);
  - the speech vectors;
  - the Home model built from aggregates with 50,000 synthetic log rows.
- Dev-only dependencies (approved): `vitest`, `fake-indexeddb` and `ajv`. Runtime dependencies stay `ts-fsrs` and `idb`.
- Device testing uses the deployed site over HTTPS. The LAN dev server can't exercise offline mode, storage or sharing. The installed app can be inspected from the Mac with Safari's Develop menu. Destructive tests run only in an iPad Safari tab, the Simulator or a desktop browser, never in the Home Screen app. The one exception is acceptance criterion 5, the reinstall, which runs before the epoch and is followed by criterion 12.
- The device checklist is acceptance criteria 1 to 8 and 10, plus the Safari-tab banner and the storage persistence status in Settings. It runs in full once before the epoch, and again after any change to the service worker, storage or export.
- A verify skill, kept untracked, is the first M1 task. It wraps `npm run verify`, the scan for personal names, and the device checklist.

## Milestones

- **M0: Docs and data.** This spec, the card and language schemas, `docs/card-authoring.md`, the syllabus mapping, and lessons 1 to 3 brought to the schema.
- **M1a: A history-safe review loop.** Everything that shapes or protects stored history.
  - Card loading. Parse and `~r` cards get no review state yet, are held out of the new queue, and enter it in normal order when M2 ships.
  - Typed and reveal answers, with folding, the wrong-form rule and punctuation handling.
  - The scheduler wrapper and day boundary.
  - Building the session: `buildQueue` steps 1, 3, 4 and 6 (due reviews in due order, the daily cap, new cards, learn-ahead), with the new-card allowance fixed at `maxNew` until the limiter arrives.
  - Unlock on Home.
  - The log contract with single-transaction writes, and undo.
  - Export, import and Reset.
  - The Safari-tab banner, `storage.persist()`, the export reminder and the clock warning.
  - The service worker and update flow, hash routing, the recovery screen, the deploy gate, and the device checklist.
- **M1b: Session quality.**
  - The time-budget limiter, "Learn 5 more", the review-day advisory, and the backlog and forecast lines on Home.
  - Review ordering and sibling spacing.
  - The key bar and keyboard flow, and the display rules.
- **M2: Full card types and tools.**
  - The parse grid, reverse cards, the letter diff, and speech.
  - Browse, the rest of Settings, and leeches, flags and suspend.
  - The lesson report.
- **M3: Stats.**
  - A review heatmap, and stats per lesson and per card type.
  - The streak, counted as days studied in the last 30.
  - Ending confusions and a paradigm heat-table.
  - An optional FSRS optimizer run on the Mac after about 1,000 reviews over 30 days (a dev-only dependency, needing approval), with custom weights pasted into Settings.
- **Reading** (after M3): a readiness meter for each milestone text ("Pater Noster: 62% of words known"), if the report's lemma lists turn out not to be enough.
- **M4: Game layer.** Brewing sessions, the abbey rooms that unlock by unit, and Corvus's commentary. Specced separately later.

## Acceptance criteria

M1a is done when all of these hold. Criteria 1 to 8 and 10 are checked on the iPad, and the last one comes last:

1. A real review session runs in the Home Screen app while offline, and its progress survives closing the app and a force-quit.
2. One deploy that adds a lesson file and edits one card's prompt: the app shows the new build id within one open-and-resume, existing review states are unchanged, the new cards appear only after unlock, and the edited card keeps its history. Retiring a card in a later deploy removes it from queues and keeps its history.
3. Reloading from `#/settings` works both offline and online.
4. An export from the Home Screen app reaches Files, imports on a desktop browser with matching counts, and every row in it carries every log field.
5. Before the epoch: delete and reinstall the app, import the backup, and everything is restored.
6. A test build that throws during startup still exports a valid backup from the recovery screen.
7. Undo restores the exact previous state.
8. Precomposed vowels with macrons and combining macrons both render correctly.
9. `npm run verify` passes in CI, and its tests cover every item in the Testing list.
10. No parse or `~r` card appears in a session, and none has review state.
11. The deploy job `needs` verify: one run with a deliberately failing test, made before the epoch, deployed nothing.
12. Last: export, then Reset, and Home shows no reviews. The next review is the epoch.

## Rejected, with reasons

Listed so later sessions don't propose them again:

- **Fading macrons on mature cards**: under a fixed id it changes what the card tests. Unmarked reading is practised with plain-text cards under new ids.
- **A practice mode** that reviews without scheduling: it splits attention from the daily queue for one learner with a fixed daily budget.
- **An in-browser optimizer**: too heavy for a static site. A Mac-side script on an export does the same job (M3).
- **A core vocabulary deck before the course ends**: it would compete with the lessons for the same daily minutes. The DCC Latin Core list guides which words the lessons choose instead.
- **A runtime morphology engine**: the cards hold the forms, and the grids and paradigms are data.
- **A separate cloze type**: `ending` cards tagged `cloze` do the job without a schema change.
- **Lemmatizing running text word by word**: not until the readiness meter needs it.
- **A load balancer for due dates**: fuzz is on and there is one daily learner. Revisit if the 7-day forecast shows spikes over 1.5 times the median.

## Out of scope for now

Accounts, cloud sync, multiple users, audio recordings, and in-app card editing (cards are edited as JSON in the repo).
