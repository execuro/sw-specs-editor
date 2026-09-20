# @execuro-sw-ecosystem/sw-specs-editor

Review a PRD or a tech spec on a local page instead of in a wall of chat.

Your coding agent starts a small zero-dependency server on `127.0.0.1`; you open
the page, select any block, attach notes, answer open questions, see requirement
status and edit Excalidraw diagrams. When you send a batch of notes, the agent
picks it up, does the work, and posts its reply back onto the page. Nothing runs
until you send something.

Built for [Shopware](https://www.shopware.com/) PRDs and specs written by the
[Shopware Ecosystem Agentic Harness](https://github.com/execuro/sw-ecosystem-agentic-harness),
whose `sw-design-requirements` and `sw-design-solution` skills take `--editor`.

## Install

Nothing to install for the CLI - it runs through `npx`. What a host installs is
the **skill**, which teaches an agent to drive it:

```sh
npx -y @execuro-sw-ecosystem/sw-specs-editor@0.1.1 install-skill
```

That writes one file, `sw-specs-editor/SKILL.md`, into your agent's skills
directory. It is idempotent, and it refuses to overwrite a copy you have edited
unless you pass `--force`. `--print` writes nothing and hands you the content to
place yourself. Reload your agent session afterwards.

`uninstall-skill` takes it back off again: it removes that one file, and the
`sw-specs-editor/` directory once it is empty. A copy you have edited is kept,
not deleted, and the command tells you where it is. Both commands take the same
`--target <dir>`, so they always act on the same file.

```sh
npx -y @execuro-sw-ecosystem/sw-specs-editor@0.1.1 uninstall-skill
```

If you use the Shopware Ecosystem Agentic Harness, its `sw-setup` skill offers
this for you - the Specs Editor is an optional add-on there, and declining it is
a supported setup.

Requires Node >= 20. Zero runtime dependencies, no build step, no install hooks.

## Use it

Ask your agent for the page:

```
sw-design-requirements specs/0007-cart-upsell.md --editor
```

or drive the CLI directly. `guide` is the session protocol and the single source
of truth for it - an agent should read that, not this file:

```
npx -y @execuro-sw-ecosystem/sw-specs-editor@0.1.1 guide
```

## Commands

```
sw-specs-editor guide                            # the session protocol - read it first
sw-specs-editor start   --doc specs/0007-x.md    # prints SPECS_EDITOR_URL=…, detaches; reattaches if already running
sw-specs-editor status  --doc specs/0007-x.md    # live session summary; --json for the full payload
sw-specs-editor poll    --doc specs/0007-x.md    # waits up to 90 s -> batch | idle | closed
sw-specs-editor stop    --doc specs/0007-x.md
sw-specs-editor migrate --doc specs/0007-x.md    # converts a legacy question table to blocks, no server started
sw-specs-editor install-skill   [--target <dir>] [--print] [--force]
sw-specs-editor uninstall-skill [--target <dir>]  # removes only that file, keeps a copy you edited
sw-specs-editor start --doc … --foreground --grace 60 --agent-timeout 120 --idle 14400
```

Every command finds its session from the document, so none of them takes a URL.
Output is `key: value` lines, then `next_step:`, then any large payload last.
Exit codes: 0 success, 1 server unreachable, 2 usage error.

## Using the page

| Area | What you do |
| --- | --- |
| Tabs | PRD and tech spec side by side. A missing spec shows **Create tech spec**, which runs `sw-design-solution` in new-spec mode |
| Overview | Status, confidence, open questions, weakest dimension (PRD) or AC coverage and open ADRs (spec) |
| Open questions | Pick an option (one is marked recommended, agent notes sit behind the info icon) or choose the ✎ radio and type your own answer. The pick is ticked `[x]` in the markdown at once and also becomes a queued item; the next run anchors it and removes the question |
| Annotate | Switch in the header (shortcut `A`). Click any block, or highlight text inside it, to attach a comment |
| Agent | Chat with the agent's progress and replies, full height on the right. Free text typed here counts as a note on the active tab |
| Queued | Everything not yet sent — block comments, question answers, diagram requests — collects in the collapsible **Queued (n)** accordion at the top of the chat panel, under the **Agent** header. ✕ drops one item, **Clear** drops them all, **Send (n)** ships them together with whatever is in the box. A sent batch stays in the chat as a collapsed **Sent (n)** entry above the reply |
| Diagrams | Excalidraw canvas per linked diagram. Edits save to the `.excalidraw` file; **Ask agent to regenerate** rebuilds it from the graph file |
| Status labels | `open` / `partly` / `done` on FRs and ACs are read-only here; the implementing and verifying skills set them |
| Abort run | Appears beside the run banner when the agent has gone quiet mid-run. Ends the run, unlocks the documents and applies everything queued behind it. Edits already written stay |

### What happens when you send

1. The page posts the batch; the touched document is locked and the tab shows **agent working**.
2. The session runs `sw-design-requirements` (PRD notes) or `sw-design-solution` (spec notes) in editor mode. The skill reads the batch, checks only the concepts the notes touch, anchors answers into the right sections, logs them, removes answered question rows and rescores. It never asks in the terminal: a new gap becomes a question row with options. A batch of nothing but question answers and chat skips the helper agents entirely.
3. The reply lands in the chat with links to the changed blocks, which are highlighted until the next send.

A run is never cut off for being quiet - a long one must not be killed by a
timer. If its agent is gone for good, **Abort run** on the page ends it, unlocks
the documents and applies whatever you changed while it was locked.

A note that belongs to the other document (a business change on the spec, a technical note on the PRD)
is answered in chat and not applied. Re-add it on the other tab.

Asking for a full review ("check the whole PRD") is the one note that runs the complete design-skill flow.

## Where things are written

The project root is the nearest ancestor of your document holding `.git`;
`--root` overrides it. Session state goes to `<project root>/specs/.editor/<slug>/`
and is gitignored - never your home directory, and never wherever the command
happened to be run from. So a command issued from a subdirectory reaches the
same session as one issued from the root.

Paths the agent has to open are absolute in the batch JSON, so they resolve from
any working directory. Their `*Rel` twins are the project-relative form, for
logs and for quoting back to you.

## What needs the network

The CLI and the server never reach the network. Two things do:

- `npx` fetches this package the first time, so a cold cache needs a registry.
  There is no offline story in 0.1.0 - on an air-gapped machine, install the
  package yourself beforehand.
- The browser fetches the Excalidraw bundle from a pinned CDN URL when you open
  a diagram. Offline, the page shows the diagram's stored SVG instead.

No telemetry, no self-update, no third-party hosting, and no binding beyond
`127.0.0.1`.

## Layout

| Path | Role |
| --- | --- |
| `bin/cli.mjs` | the one executable; every other file exports `main(argv)` and never reads `process.argv`, so the commands work through an npx `.bin` symlink |
| `lib/server.mjs` | http server on `127.0.0.1` (random port, `SPECS_EDITOR_PORT` to pin): page, JSON API, SSE, file watcher, batch queue, per-document lock, heartbeat timeout, status-tag and diagram writes, session persistence |
| `lib/paths.mjs` | project-root resolution and the absolute/relative path split |
| `lib/parse.mjs` | markdown → document model with stable block ids (`FR-3`, `Q-1`, `AC-2.plan`, `s5.p2`, `t8.r1`, `diagram:domain`), both templates, `**Q-n**` question blocks, legacy question table |
| `lib/diff.mjs` | old vs new model → changed / added / removed ids |
| `lib/status.mjs` | status-tag and answer-tick rewrite on one line; snapshot + verify/repair after an agent run; legacy question table → blocks |
| `lib/emit.mjs` | `emit progress\|chat\|done "<text>" [--batch id] [--doc prd\|spec]` — the design skill's only channel to the page |
| `lib/diagram.mjs` | `<graph.json> <out.excalidraw> [--svg auto\|none\|<path>]` — deterministic layered layout, SVG fallback |
| `lib/guide.mjs` | the session protocol, printed by `guide`. The only place it is written down |
| `page/` | `index.html`, `app.js`, `app.css`, `diagram.js`, `vendor/marked.min.js` — vanilla JS, no build |
| `skills/sw-specs-editor/` | the stub skill `install-skill` hands to a host |

## Session folder `specs/.editor/<slug>/` (gitignored)

`session.json`, `session.lock` (pid + url while running), `chat.jsonl`, `notes.json` (unsent notes), `batches/b-N.json`, `snapshot.json` (hashes, tags, diagram lines before a run), `queue.json` (the durable batch queue: order + the batch in flight), `queued.json` (toggles/diagram saves waiting for unlock), `<name>.svg` (diagram exports), `server.log`.

## API (all JSON, localhost only)

| Method & path | Purpose |
| --- | --- |
| `GET /`, `GET /page/*`, `GET /file?path=specs/…` | page, assets, files under `specs/` |
| `GET /api/session` | session info (locks, agent liveness), both models, unsent notes, chat history |
| `GET /api/events` | SSE: `hello`, `doc` (model + changed ids), `chat`, `progress`, `run`, `agent`, `queued`, `notes`, `diagram`, `closing` |
| `POST /api/heartbeat` | tab liveness (5 s); 60 s without any → server exits |
| `POST /api/notes` | autosave unsent notes |
| `POST /api/batch` | `{docs:{prd:{notes},spec:{notes}}, chat, chatDoc, createSpec?}` → queued for the agent. Batches are the only trigger for agent work; nothing runs on open |
| `POST /api/status` | `{doc, id, status}` → rewrites the tag on that line; `202` + queued while the document is locked |
| `POST /api/answer` | `{doc, id, option}` / `{doc, id, text}` / `{doc, id}` → ticks/unticks the question's answer; `202` + queued while the document is locked |
| `POST /api/diagram` | `{doc, id, scene, svg}` → writes `.excalidraw` + SVG; `202` while locked |
| `POST /api/run/abort` | `{reason}` → end a run whose agent will never reply: unlock every document it holds, apply queued writes, release the queue |
| `POST /api/close` | end the session |
| `GET /api/next?wait=<s>` | **agent** long-poll → `{event:"batch"}` / `idle` / `closed`; reserves the batch, locks and snapshots the touched documents. The reservation is only final once the agent acknowledges it through one of the `/api/agent/*` endpoints: a poll that dies before the response is written rolls it back, and an unacknowledged run is re-delivered to the next poll, so a killed `poll` never loses a batch. Agent presence = a poll or progress line within `--agent-timeout` (120 s); silence is reported once in chat and never acted on: a run ends only on `emit done` or Stop |
| `POST /api/agent/progress` / `chat` / `reply` | **agent** progress line, interim message, final reply per document (verify + repair, diff, unlock, apply queued) |
| `GET /api/lock` | locks, agent liveness, active run, queue |
| `GET /health` | package name and version, pid, slug, url, start time. `start` probes it: a matching version reattaches, a different one is stopped and restarted |

## Markdown conventions the runtime relies on

- Status tag directly after the bold id: `- **FR-3** [partly] …`, `- **AC-1** [done] (FR-1)`, part-level `- **Decision:** [done] …`. Absent = open.
- Questions are a `**Q-n**` block, not a table: `**Q-6** [adr]? question sentence`, an optional `Blocks: FR-12, §8` line, then top-level task-list options `- [ ] A: text (recommended)` (at most one `(recommended)`), with agent notes as indented bullets under the option they judge, `  - [pm] text` — hidden in the page and shown behind an info icon on that option (a note under the question line, before any option, is shown on the recommended option, and sits on the question head only when the row has no recommended option; several agents may note the same option). Question may start with `[adr]` / `[gate]` right after the id.
- An answer is `[x]` on exactly one option, or an own-answer line `- [x] ✎ text` as the question's last bullet; the page writes the tick via `POST /api/answer` when the user picks an option or saves an own answer, and clears it when the answer note is deleted. `null`/no tick means unanswered.
- A legacy five/six-column question table (`| # | Question | Blocks | Options | Agent notes |`, optionally `Impact`) still parses (`legacy: true`, no ticking); `bin/cli.mjs migrate --doc …` or the automatic repair after an agent run (`verifyAndRepair`) converts it to blocks. No skill writes a table.
- Diagram link line `Diagram: specs/NNNN-slug.domain.excalidraw` (PRD §4) / `Diagram: specs/NNNN-slug-spec.architecture.excalidraw` (spec §2). The agent writes only the sibling `*.graph.json`; `bin/cli.mjs diagram` produces the scene.
