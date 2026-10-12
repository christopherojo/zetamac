# Zetamac Local

Offline Zetamac-style arithmetic practice that records how long every question takes, with a focus on which multiplication pairs and numbers slow you down. Plain HTML, CSS and JavaScript. No server, accounts, CDN or network access.

## Open it

Double-click `index.html` (or drag it into a browser window). Everything runs from the file. No internet connection is needed.

- **Practice**: pick Standard or Targeted ×, a difficulty (Easy / Medium / Hard / Custom ranges), a duration (Bullet 60 s, Blitz 120 s, Rapid 180 s) and operations. Press **Enter** or **Start**.
- During a round, type answers. A correct answer advances immediately, with no Enter needed. **Esc** abandons the round.
- **Statistics** has history, score trends, per-operation timing, multiplication pair/number analysis, a heatmap, and data controls.

Your last-used settings are remembered.

## Where your data lives

Rounds are saved in the browser's `localStorage`, one entry per round (`zetamac.session.<id>`), plus `zetamac.settings`. Each round is written once, when it ends. Nothing is written while you type.

That data belongs to **this browser on this computer**, and to the way you opened the page:

- **Chrome / Edge / Brave:** all pages opened from `file://` share one storage area. This was verified in Chrome: data survives quitting and reopening the browser.
- **Firefox:** storage is tied to the file's location. If you move or rename the folder, the app will start empty. Import a backup to bring the data back.
- **Safari:** `file://` storage should work, but this has **not been verified**. If rounds don't persist, serve the folder locally instead, as described below.
- Private/incognito windows discard storage when they close. Clearing "site data" or "cookies and site data" in your browser also erases the history.

If saving ever fails (for example, storage is full or disabled), the results screen says **Not saved** and a red banner offers an immediate backup export. The app never reports a failed save as saved.

### Fallback: local server (only if file:// storage doesn't work in your browser)

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Run it from this folder, then open <http://127.0.0.1:8765/>. Always use that exact address. `localhost:8765` or a different port counts as a different site with separate, empty storage. Storage under the server address is also separate from `file://` storage, so move history between them with export/import.

## Backups

Statistics → **Your data**:

- **Export backup (JSON)** downloads `zetamac-backup-YYYY-MM-DD.json`. It is a versioned file (`format: "zetamac-local-backup"`, `version: 1`) with all rounds, every question record, and your settings.
- **Import backup** validates every round: the arithmetic must match, the score must equal the number of completed questions, and ranges must be valid. Rounds already present (same id, or the same round under a different id) are skipped, so importing twice is safe. Invalid rounds are reported and skipped.
- **Clear history…** deletes all rounds after a confirmation. Your settings are kept.

Export now and then. Browser storage can be wiped by the browser or by clearing site data.

## How things are measured

- **Problems.** Addition draws `a` and `b` uniformly from the inclusive ranges. Subtraction shows `(a+b) − a` (answer `b`), multiplication shows `a × b`, and division shows `(a×b) ÷ a` (answer `b`). The operation is chosen uniformly among the enabled ones.
- **Time per question.** This runs from the moment the question is shown until the correct answer is fully typed. It includes thinking, typing and any corrections. Keystrokes, wrong attempts and accuracy are not tracked.
- **Clock.** The clock is a monotonic deadline (`performance.now()`), started once the first question and input are ready. Answers at or after the deadline are rejected, so background-tab timer throttling can't lengthen a round.
- **Unfinished question.** The question on screen when time runs out is saved as *unfinished*, along with the time spent on it. It is shown separately and never counted in timing averages.
- **Abandoned rounds.** These are saved and marked *abandoned*. They are excluded from personal bests, trends and statistics unless you tick "Include abandoned rounds". Closing the tab mid-round also counts as abandoning.
- **Comparisons.** Personal bests and score trends only compare rounds with identical mode, duration, operations and ranges. Targeted rounds are always kept separate from standard rounds.

### Multiplication analysis

- **Pairs.** 7 × 8 and 8 × 7 are grouped as one pair; raw records keep the order as shown. The main ranking uses median time and only includes pairs with **at least 5** completed answers. Smaller samples are listed separately.
- **Numbers.** Each question counts once per distinct number in it, so 7 × 7 counts once for 7. Clicking a number breaks its timing down by role (first or second factor) and by the size of the other factor.
- **Heatmap.** Rows are the smaller factor and columns the larger. Colour shows median time, using quantile bins. Hatched cells have fewer than 5 samples, and dashed empty cells have no data.
- **Division.** You can optionally include division as divisor × quotient.

### Targeted × mode

There are three focuses: **My slowest pairs**, **Numbers** (e.g. `7, 8` × a partner range), and **Pairs** (e.g. `7x8, 6x9`). A configurable share of questions (0–50 %, default 25 %) is random multiplication from the current ranges, so practice doesn't collapse onto a few facts.

"Slowest pairs" works like this:

- It takes up to 15 of your slowest sufficiently sampled pairs inside the current ranges.
- It picks each one with probability proportional to its median time squared.
- It avoids immediate repeats and randomises factor order.
- With fewer than 3 qualifying pairs, it falls back to random multiplication and tells you so.

## Tests

```bash
node --test tests/core.test.js
```

Unit tests (Node ≥ 18) cover the following:

- Inclusive ranges and inverse problems
- Answer checking, timing, the deadline, and single-save behaviour
- Unfinished questions
- Statistics, pair grouping and number counting
- Targeted weighting and fallback
- Storage round-trip, backup validation and duplicate detection

```bash
node tests/e2e.mjs
```

This end-to-end test (about 75 s, needs Google Chrome) runs headless Chrome against `file://…/index.html` with networking disabled. It covers:

- Real keystrokes: partial and wrong answers, Backspace, auto-advance
- A full 60 s round and the deadline
- Saved records
- Abandoning a round
- Quitting and relaunching Chrome to confirm persistence
- Export, clear, import, and re-import duplicate skipping
- Targeted mode
- The save-failure warning
- Checking that no network requests were made

## Files

- `index.html`: markup for the four screens
- `styles.css`: styles, with light and dark themes from system fonts
- `js/core.js`: generation, the round engine, statistics, storage format and backup (no DOM; also loaded by the tests)
- `js/app.js`: UI wiring and rendering
- `tests/`: unit and end-to-end tests
