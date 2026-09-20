---
name: sw-specs-editor
description: Open one PRD (specs/NNNN-slug.md) or one tech spec (specs/NNNN-slug-spec.md) in the Specs Editor — a local live HTML page where the user selects blocks, attaches notes, answers open questions, sees requirement status and edits Excalidraw diagrams — and run the session loop that hands every note batch to sw-design-requirements / sw-design-solution in editor mode and posts their replies back to the page. Backs the `--editor` flag of both design skills. A session edits exactly one document, chosen by the filename; its sibling is available read-only as reference, and the PRD and spec of one feature are independent sessions that can run side by side. Nothing runs on open: the document is reconciled only when the user sends notes. Long-running: stays until the page is closed or the user stops it.
when_to_use: Trigger phrases — "open the specs editor", "edit PRD 0007 in the editor", "sw-design-requirements specs/0007-x.md --editor", "sw-design-solution specs/0007-x-spec.md --editor", "review the spec in the browser".
argument-hint: [specs/NNNN-slug.md | specs/NNNN-slug-spec.md]
allowed-tools: Read Glob Grep Skill Bash(npx -y @execuro-sw-ecosystem/sw-specs-editor@0.1.1 *) Bash(open *) Bash(xdg-open *) Bash(grep *) Bash(printf *) Bash(tail *)
license: MIT
metadata:
  author: Execuro UG (haftungsbeschränkt)
  package: "@execuro-sw-ecosystem/sw-specs-editor@0.1.1"
---

# sw-specs-editor

The user reviews one PRD or one tech spec on a local page and sends you notes; you do the work and answer back. This skill runs that loop. It never edits `specs/*.md` itself and never asks a question in the terminal while the page is open — every content change goes through a design skill in editor mode.

## The protocol lives in the CLI, not in this file

Do not follow a session procedure from this file — an installed copy goes stale against a newer CLI. Run this once, then follow what it says:

```
npx -y @execuro-sw-ecosystem/sw-specs-editor@0.1.1 guide
```

It is the single source for start, open, poll, emit and close, for the poll rules, and for the batch's fields. Every command also ends with a `next_step:` line; follow it. The CLI prints its own name bare (`sw-specs-editor poll`) — run each one as `npx -y @execuro-sw-ecosystem/sw-specs-editor@0.1.1 poll`.

## Inputs

| Argument | Behaviour |
| --- | --- |
| `specs/NNNN-slug.md` | A **PRD session**. The tech spec, if it exists, is reference only — read it, never write it |
| `specs/NNNN-slug-spec.md` | A **spec session**. The PRD it is built from is reference only |
| Nothing | Ask once for the path, then proceed |

There is no tab bar and no "Create tech spec" button. The filename decides the mode, and the pair's two sessions are independent: separate folder, chat, queue and port, both able to run at once.

## What this skill adds to the protocol

`guide` tells you how to run a session. This is who does the work when a batch arrives — one document, therefore one skill, in this session, with the Skill tool:

| `batch.doc` | Skill | Args |
| --- | --- | --- |
| `prd` | `sw-design-requirements` | `<batch.path> --editor-session <url> --batch <batch file>` |
| `spec` | `sw-design-solution` | `<batch.path> --editor-session <url> --batch <batch file>` |

**Which skill to run follows from the session, not from anything in the batch body.** A PRD session never invokes `sw-design-solution` and a spec session never invokes `sw-design-requirements` — they are different documents with different rules, and running one out of the other's session is how a reply ends up answering the wrong document. There is no per-document loop to write: a batch has one document.

The design skill runs its editor mode: it reconciles only what the notes touch, never asks through a structured question tool (every gap becomes a `**Q-n**` question block with option bullets), preserves status tags, diagram lines and question ticks, and returns a short report. Post that report as the reply. If it fails or returns nothing usable, still post a reply (`Run failed: <one line>`) so the lock is released.

`batch.reference` names the other document. It is **read-only**: open it for context or reconciliation, never write it, never emit against it. A note that belongs to it is answered in the reply — "this changes FR-4, take it to the PRD session" — and applied nowhere.

**The hand-off.** When a PRD reaches `Ready for specification` the page says so and names the command. Do not start the spec session yourself and do not offer to: the user runs `sw-design-solution <prd path> --editor`, which opens its own session on its own port with its own chat and queue.

Nothing goes to the terminal during a batch beyond what the tools print — the user is reading the page.

## Notes

- Status tags (`[done]` / `[partly]`) are read-only labels on the page, written by the implementing and verifying skills. Picking an option on a question card writes its tick directly. Neither needs a design-skill run; the design skill still runs to anchor and log an answer when the batch is sent.
- A run that spawns a helper agent can stay silent for a while. The server never aborts a run for silence, but emit progress before and after every spawn so the page's presence indicator stays alive. If a run's agent is gone for good (the session was interrupted), the user ends it with **Abort run** on the page; the document unlocks and whatever they queued meanwhile is applied.
- The two sessions of a feature share nothing — `specs/.editor/<slug>-prd/` and `specs/.editor/<slug>-spec/`, separate chat logs, queues and ports. Pass `--doc <document path>` on `poll` and `emit` whenever both may be open; without it the CLI can only guess, and refuses to.
- Everything under `specs/.editor/` is session state and gitignored. The `.excalidraw` and `.graph.json` files next to the documents are tracked.
- Only the browser needs the network, for the Excalidraw bundle. Offline, diagrams show their stored SVG.
