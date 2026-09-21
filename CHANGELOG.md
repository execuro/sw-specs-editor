# Changelog

All notable changes to `@execuro-sw-ecosystem/sw-specs-editor`.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-09-21

### Added

- **The batch says which questions still carry no recommendation.** Every batch now
  carries `questions: {open, unadvised}`. `unadvised` lists the question ids with no
  `(recommended)` option backed by an agent note, minus the ones the user raised
  themselves (`  - [user] …`). Until now the only questions an agent saw were the ones
  the user happened to click, so a question born without advice stayed that way until
  the user asked for it by hand. `status` prints the same as a `questions:` line, the
  model carries it as `meta.unadvised`, and the page marks those cards **advice pending**.

### Changed

- **An ADR or readiness question lists its options one per row.** `[adr]` and `[gate]`
  questions laid their options out side by side, so two short ones sat in half-width
  boxes and a third wrapped onto a ragged second row - a different shape from every
  other question on the page, for no reason beyond the options usually being short.
  They now use the same single-column list as the rest; only the slightly heavier
  option text still marks them out.

- **A spec AC's parts read top-to-bottom instead of in two columns.** `Depends on`,
  `Decision`, `Implementation plan (TDD order)` and `Tests` put the label in a narrow
  left column and the content in a right one, which suits `Depends on: none` and
  nothing else: a numbered TDD plan or a list of test files was squeezed into the
  remaining width. The label is now a sub-header on its own line with its content
  full-width below it. Presentation only - the model, block ids, status tags and note
  anchoring are unchanged.

### Fixed

- **A session you have not opened yet waits ten minutes, not one.** The heartbeat
  clock started when the server booted, so the 60 s `--grace` window was already
  running before anyone had the URL: reach the browser a minute late and the
  session was gone. That number answers "the tab that was here has gone away",
  which is not the same question as "nobody has arrived yet". Until the first
  heartbeat ever arrives the grace is at least 600 s; from that beat on `--grace`
  applies exactly as before, and an explicit `--grace` longer than 600 s is never
  shortened by it.

- **A run can no longer drop a question's advice unnoticed.** The pre-run snapshot now
  records each question's `(recommended)` mark and its agent-note lines, and the repair
  pass puts back whatever the run lost, reporting it in the chat like any other repair.
  The notes are also part of the question's hash, so losing them reads as a change
  instead of the no-op it used to be for the diff and the page's highlighting.
- **Ticking the ✎ own answer no longer re-attributes agent notes.** The `- [x] ✎ …`
  line was inserted straight after the last option, i.e. between that option and its
  indented notes; on the next parse those notes lost their option and the page showed
  them on the recommended one instead. It now goes below the notes.
- **The legacy question-table conversion keeps each note's stance.** `[pm] Recommends A:
  …` used to come out as `[pm] …`, losing the verb the page italicises.

## [0.1.2] - 2026-09-20

### Changed

- **BREAKING — a session now edits one document, not a pair.** `start --doc <path>`
  infers the mode from the filename (`…-spec.md` opens a tech-spec session,
  anything else a PRD session) and the session knows exactly one editable
  document. State moves from `specs/.editor/<slug>/` to
  `specs/.editor/<slug>-prd/` or `<slug>-spec/`, so a PRD and its tech spec are
  independent sessions — own chat log, queue, batch id space and port — and both
  can run at once. The tab bar is gone; the header names the one document.

  This is what the change is for. One chat log, one queue and one batch id space
  used to cover both documents, and a batch carried `touched`, so a session
  opened by `sw-design-requirements` could be handed a spec batch and dispatch
  `sw-design-solution` out of it — a different document with different rules —
  while both runs wrote into the same history.

  The sibling is not lost: it is handed to the agent read-only as
  `reference.path` in the batch, for context and reconciliation. The page is told
  only that it exists and where, never its content.

  Breaking in the same change: the batch JSON is flat (`doc`, `path`, `pathRel`,
  `notes`, `chat`, `reference`), with `touched`, `docs.<doc>`, `chatDoc`,
  `createSpec`, `paths` and `pathsRel` gone; `emit --doc` takes a document path
  rather than `prd`/`spec` (the literal is still accepted and ignored, so a skill
  pinned to an older CLI degrades instead of failing); `batch --kind spec` is
  refused with the command that replaces it; `POST /api/status`, `/api/answer`
  and `/api/diagram` answer **400** for a `doc` naming the other document instead
  of silently coercing it to `prd`; and a diagram's SVG fallback now lives in its
  own document's session folder.

  An existing `specs/.editor/<slug>/` folder is not migrated. Its chat log
  interleaves both documents and its `system` lines name neither, so a filtered
  history would read as fact without being one — worse than none, because the
  agent reads it as context. `start` closes any server still behind it, renames
  it to `specs/.editor/<slug>.pre-split/` and says so in the new session's chat.
  It is gitignored scratch; nothing is lost.

### Removed

- **`createSpec`** — the batch field, the page's *Create tech spec* button and the
  dispatch case behind them. A PRD that reaches `Ready for specification` now
  shows a banner naming `sw-design-solution <prd path> --editor`, which the user
  runs themselves; `sw-design-solution --editor` given a PRD path resolves to the
  spec path and creates it from its template when it does not exist yet.

### Added

- **Clear cache** in the Agent panel head, and `POST /api/cache/clear` behind it. A
  session inherits the previous one's chat log - which the agent reads as its run
  context - and any batch left pending in `queue.json`, which the next poll is handed.
  A stray instruction therefore keeps re-running on every start. Clearing aborts an
  open run, empties the queue and `batches/`, truncates the chat and resets the batch
  counter. The documents, the unsent notes and the deferred page writes stay as they are.

- **Abort run** on the page, and `POST /api/run/abort` behind it. A batch is
  delivered under a lease: the documents stay locked until the agent replies, and
  the server deliberately never times a run out, because killing a long one would
  be worse. When the agent is gone for good - the session was interrupted, the
  worker died - nothing was ever going to send that reply and every page write
  piled up behind it. Aborting finishes the run, unlocks the documents and applies
  what was queued; edits the agent already wrote are kept.

### Changed

- The Queued list's **Clear** button only appears when something is queued.

- The Abort control no longer appears after two minutes of silence. Presence (the
  header dot) and run silence are now separate: a run is called quiet only after
  15 minutes of no progress, and a progress line clears it again. A
  normal run takes five to ten minutes and says nothing between steps, so the old
  threshold flagged healthy runs. The chat line and the banner say the agent may
  still be working and that aborting is for a session that was closed or
  interrupted.

- A batch of nothing but question answers or chat is handled without spawning the
  product-manager, architect or QA agents. Answering a question was costing a full
  analysis wave while the user watched the page.

- Progress lines are kept few and short - one line per phase, no per-tool
  narration. They are the page's only sign of life while a helper agent runs, so
  they still bracket every spawn; they are just no longer a running commentary.

- The disconnect banner no longer contradicts the header. While a run is open the
  page says "agent working" and offers **Abort run** instead of telling the user
  to re-run a skill that is already running.

- The chat no longer repeats the session banner of every past run. Older
  `session started/resumed/closed` lines collapse into a single muted
  **previous session** divider at each boundary; only the current session's
  line is shown. The conversation itself still loads in full, and `chat.jsonl`
  keeps every line for the agent's context.

- The page's separate **Notes** panel is gone. Unsent items now collect in a
  collapsible **Queued (n)** accordion at the top of the chat panel, under the
  `Agent` header, so the agent chat fills the whole side column. Each row carries the document badge, the
  block reference and an ✕ that drops it before sending (dropping a question
  answer un-ticks it in the markdown again); **Clear** empties the queue. The
  single **Send (n)** button in the chat row ships the queue with whatever is in
  the box, and a sent batch stays in the transcript as a collapsed **Sent (n)**
  entry above the reply. The `+ free note` button is gone — the chat box is the
  free note.

### Fixed

- Sending a batch now clears the stored unsent notes, so a page reload (or a
  second tab) no longer resurrects items that were already sent.

- A question's agent-note popover no longer runs off the left edge of the
  document pane. The icon in front of a question's title sits at the pane's left
  edge, while the popover was anchored to grow leftwards from it, and the pane
  clips horizontally — so the note was cut off rather than merely scrolled away.
  It now opens rightwards there, and any popover wider than the pane, or pushed
  past either edge, is shifted and narrowed back inside it.

### Added

- `sw-specs-editor uninstall-skill [--target <dir>] [--root <path>]` — removes
  the one `SKILL.md` `install-skill` wrote, and the `sw-specs-editor/` directory
  once it is empty. A copy the host has edited is kept and reported, never
  deleted; an absent file is `changed: false`, not an error. The two commands
  resolve their target identically, so they are exact opposites.

## [0.1.1] - 2026-09-19

### Fixed

- A filesystem watch error (for example `EMFILE` under file-descriptor
  pressure) no longer crashes the server process: the dead watcher is dropped,
  the page is told that edits made outside it are not picked up, and the watch
  is retried three times with a short backoff before it gives up.

### Added

- First packaged release. Previously an internal tool inside a Shopware
  agentic harness; now a standalone repository and npm package.
- `skills/sw-specs-editor/SKILL.md` — the stub skill, shipped in the package and
  installed into a host by `sw-specs-editor install-skill`.
- `lib/paths.mjs` — project-root resolution by walk-up from the document, so the
  CLI no longer depends on the caller's working directory.
- MIT `LICENSE`, `THIRD-PARTY-NOTICES.md`, consumer `README.md`.
- Tag-driven release: pushing `v<version>` publishes to npm from GitHub Actions
  with `--provenance`, authenticated by OIDC trusted publishing. No npm token
  is stored in this repository.
- `scripts/check-version.mjs` — refuses a release whose shipped skill pins a
  different CLI version than `package.json` declares.

[Unreleased]: https://github.com/execuro/sw-specs-editor/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/execuro/sw-specs-editor/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/execuro/sw-specs-editor/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/execuro/sw-specs-editor/compare/v0.1.0...v0.1.1
