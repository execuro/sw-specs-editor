---
name: sw-specs-editor
description: Open a PRD (specs/NNNN-slug.md) or tech spec (specs/NNNN-slug-spec.md) in the Specs Editor — a local live HTML page where the user selects blocks, attaches notes, answers open questions, sees requirement status and edits Excalidraw diagrams — and run the session loop that hands every note batch to sw-design-requirements / sw-design-solution in editor mode and posts their replies back to the page. Backs the `--editor` flag of both design skills; one runtime serves both documents as tabs. Nothing runs on open: the document is reconciled only when the user sends notes. Long-running: stays until the page is closed or the user stops it.
when_to_use: Trigger phrases — "open the specs editor", "edit PRD 0007 in the editor", "sw-design-requirements specs/0007-x.md --editor", "sw-design-solution specs/0007-x-spec.md --editor", "review the spec in the browser".
argument-hint: [specs/NNNN-slug.md | specs/NNNN-slug-spec.md]
allowed-tools: Read Glob Grep Skill Bash(npx -y @execuro-sw-ecosystem/sw-specs-editor@0.1.0 *) Bash(open *) Bash(xdg-open *) Bash(grep *) Bash(printf *) Bash(tail *)
license: MIT
metadata:
  author: Execuro UG (haftungsbeschränkt)
  package: "@execuro-sw-ecosystem/sw-specs-editor@0.1.0"
---

# sw-specs-editor

The user reviews a PRD or tech spec on a local page and sends you notes; you do the work and answer back. This skill runs that loop. It never edits `specs/*.md` itself and never asks a question in the terminal while the page is open — every content change goes through a design skill in editor mode.

## The protocol lives in the CLI, not in this file

Do not follow a session procedure from this file — an installed copy goes stale against a newer CLI. Run this once, then follow what it says:

```
npx -y @execuro-sw-ecosystem/sw-specs-editor@0.1.0 guide
```

It is the single source for start, open, poll, emit and close, for the poll rules, and for the batch's fields. Every command also ends with a `next_step:` line; follow it. The CLI prints its own name bare (`sw-specs-editor poll`) — run each one as `npx -y @execuro-sw-ecosystem/sw-specs-editor@0.1.0 poll`.

## Inputs

| Argument | Behaviour |
| --- | --- |
| `specs/NNNN-slug.md` | Opens the PRD tab first; the spec tab is derived (`specs/NNNN-slug-spec.md`, disabled with "Create tech spec" if missing) |
| `specs/NNNN-slug-spec.md` | Opens the spec tab first; the PRD tab is derived |
| Nothing | Ask once for the path, then proceed |

## What this skill adds to the protocol

`guide` tells you how to run a session. This is who does the work when a batch arrives — for **each** document in `touched`, in this session, with the Skill tool, PRD first when both are touched:

| Case | Skill | Args |
| --- | --- | --- |
| `prd` in `touched` | `sw-design-requirements` | `<prd path> --editor-session <url> --batch <batch file>` |
| `spec` in `touched` | `sw-design-solution` | `<spec path> --editor-session <url> --batch <batch file>` |
| `createSpec` is `true` | `sw-design-solution` | `<prd path> --editor-session <url> --batch <batch file>` (new-spec mode) |

The design skill runs its editor mode: it reconciles only what the notes touch, never asks through a structured question tool (every gap becomes a `**Q-n**` question block with option bullets), preserves status tags, diagram lines and question ticks, never edits the other document, and returns a short report. Post that report as the reply for that document. If it fails or returns nothing usable, still post a reply (`Run failed: <one line>`) so the lock is released.

For a `createSpec` batch the reply goes to `--doc prd`; the watcher picks the new spec file up and the page enables the tab.

Nothing goes to the terminal during a batch beyond what the tools print — the user is reading the page.

## Notes

- Status tags (`[done]` / `[partly]`) are read-only labels on the page, written by the implementing and verifying skills. Picking an option on a question card writes its tick directly. Neither needs a design-skill run; the design skill still runs to anchor and log an answer when the batch is sent.
- A run that spawns a helper agent can stay silent for a while. The server never aborts a run for silence, but emit progress before and after every spawn so the page's presence indicator stays alive.
- Everything under `specs/.editor/` is session state and gitignored. The `.excalidraw` and `.graph.json` files next to the documents are tracked.
- Only the browser needs the network, for the Excalidraw bundle. Offline, diagrams show their stored SVG.
