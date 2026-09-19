# Changelog

All notable changes to `@execuro-sw-ecosystem/sw-specs-editor`.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

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

[Unreleased]: https://github.com/execuro/sw-specs-editor/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/execuro/sw-specs-editor/compare/v0.1.0...v0.1.1
