// `guide` - the session protocol, printed by the CLI.
//
// This is deliberately the ONLY place the protocol is written down. A copy
// inside a skill file goes stale the moment the CLI changes and the agent has
// no way to tell which one is current, so the skills stay stubs that say "run
// `guide` and follow it".

import * as out from './out.mjs';

const GUIDE = `
Specs Editor - session protocol

The user reviews a PRD or tech spec on a local page and sends you notes. You do
the work and answer back. The page is the user's side; this CLI is yours.

A session edits exactly ONE document. Its sibling - the spec of a PRD, the PRD of
a spec - is available to you read-only, as reference.

0. PREPARE
   Session state is written to specs/.editor/<slug>-prd/ or <slug>-spec/ and must
   not be committed:
     grep -q "specs/.editor" .gitignore || printf '\\n/specs/.editor/\\n' >> .gitignore

1. START
   sw-specs-editor start --doc specs/NNNN-slug.md
   Prints SPECS_EDITOR_URL=<url>. The path you pass is the document the session
   edits, and its filename picks the mode: a path ending in -spec.md opens a
   tech-spec session, anything else a PRD session. Starting the SAME document a
   second time reattaches to its running server instead of binding a second port.

   A PRD and its tech spec are two independent sessions - separate folder, chat,
   queue and port - and both may run at once. Finishing the PRD does not open the
   spec: when the PRD reaches "Ready for specification", tell the user in one line
   that the next step is "sw-design-solution specs/NNNN-slug-spec.md --editor"
   and stop. Never start it yourself.

   Then open it for the user:
     open <url>        (macOS)
     xdg-open <url>    (Linux)
   If neither exists, print the URL and carry on - the user can open it by hand.
   Tell them the URL in one line and nothing else: no summary of the document,
   no analysis. The order is fixed: server, then browser, then the poll loop.

2. NOTHING RUNS ON OPEN
   Opening the page reconciles nothing. You act only when a batch arrives. If
   you find yourself reading or reconciling a document before a batch has
   arrived, stop.

3. POLL
   sw-specs-editor poll
   Waits up to 90 s, then returns one of:
     event: batch    a batch file to act on; read batch_file, then do the work
     event: idle     nothing yet - run poll again
     event: closed   the session is over - stop polling
   Follow the next_step line in the output.

   sw-specs-editor poll --reply "<text>"
       closes the active batch (same effect as "emit done") and falls straight
       into the wait for the next one - one call instead of "emit done" then a
       separate "poll".

   Poll rules:
   - Keep poll in the foreground of the active turn. Never background it with
     nohup, &, or a detached shell: the harness does not wake you when a
     background command finishes, so the batch would sit unanswered.
   - poll is safe to re-run after being killed. A batch is redelivered until
     you acknowledge it by calling emit (progress, chat or done) - a killed
     poll never loses a batch; re-running poll just returns the same one.
   - Do not raise your command timeout for it. The 90 s bound exists so the
     default timeout is always enough.

4. WORK
   A batch locks this session's document. While it is locked the user's direct
   edits (status ticks, question answers, diagrams) are queued and applied when
   you release it.

   The batch JSON carries: id, doc ("prd" or "spec"), path and pathRel (the
   document), notes, chat, root (the project root), file (this batch file),
   context (chat.jsonl), questions, and reference when the sibling exists.

   questions is what the document still owes you: {open, unadvised}. unadvised
   lists the question ids that carry no agent recommendation - no option marked
   (recommended) with an agent note behind it - and that the user did not raise
   themselves. They are yours to clear whether or not this batch mentions them;
   the user should never have to ask for a recommendation.

   Each note has kind (comment | answer | free | diagram) and text; block-bound notes also
   carry file, block, blockKind, path (breadcrumb of ancestor sections),
   line-endLine, md (block source), quote, hash, and optionally selection (the
   exact text the user highlighted); answer notes may carry option.

   reference.path is the OTHER document - the PRD a spec is built from, or the
   spec a PRD has produced. Read it for context and reconciliation. Never write
   it, never emit against it, never count it among your changed blocks: it is a
   separate session's document. A note that belongs to it is answered in your
   reply ("this changes FR-4 - take it to the PRD session"), not applied.

   Every path you have to OPEN is absolute, so it resolves whatever directory
   you are working in - use it as given, do not join it to anything. The
   *Rel twins (fileRel, pathRel, contextRel) are the project-relative form,
   for quoting to the user; never open those.

5. TALK BACK
   --doc takes the DOCUMENT PATH (the batch's pathRel), not "prd"/"spec". It
   names the session; omit it only when you are sure just one is running, which
   stops being true as soon as a feature's PRD and spec are both open.

   sw-specs-editor emit progress "<step>" --batch <id> --doc <document path>
       one status line; also tells the page you are still alive
   sw-specs-editor emit chat "<markdown>" --batch <id> --doc <document path>
       an interim message; the run stays active
   sw-specs-editor emit done --batch <id> --doc <document path> -
       the run's final answer; releases the document's lock. Body on stdin -
       post it with a heredoc so markdown stays intact:
         sw-specs-editor emit done --batch <id> --doc <document path> - <<'EOF'
         <report>
         EOF
       If the run failed, still post one line ("Run failed: <one line>") so
       the lock is released rather than left hanging.
       The server verifies the file against its pre-run snapshot and repairs
       anything the agent dropped: status tags, diagram lines, question
       ticks, and a question's advice - its (recommended) mark and its agent
       notes. A repair is reported in the chat; it is a safety net, not a
       licence to rewrite a question block from scratch.
   sw-specs-editor diagram <graph.json> <out.excalidraw>
       deterministic Excalidraw scene plus an SVG fallback

6. CLOSE
   sw-specs-editor stop --doc specs/NNNN-slug.md
   Only this document's session; the pair's other session keeps running.
   The server also exits by itself when the page has been gone for 60 s, and
   after --idle seconds (default 14400 = 4h) without a batch, poll, reply or
   page write.

   On "event: closed", or when the server has become unreachable, summarise the
   session for the user in five lines:
     - the document, by path
     - how many batches you processed
     - its final status line (sw-specs-editor status --doc <path> while it is
       still reachable, otherwise the document's own meta table)
     - the chat log: specs/.editor/<slug>-prd/chat.jsonl (or -spec)
     - how to resume: re-run the same command. Chat, unsent notes and statuses
       are all restored.

   If you are interrupted while the page is open, the server keeps serving it
   read-only and the page shows "agent disconnected" after about two minutes.
   Re-running reattaches to the same URL. If you were interrupted mid-batch the
   document stays locked - a run is never cut off for silence - and the user
   releases it with "Abort run" on the page.

sw-specs-editor status --doc specs/NNNN-slug.md
    reads session state without a URL: running, the document and its mode, its
    reference document, block counts, notes unsent, run_active, and more behind
    --json. This is the current way to check the session; there is no other read
    channel.

State lives in specs/.editor/<slug>-prd/ or <slug>-spec/ and is gitignored. The
queue itself (queue.json in that folder) is durable and survives a server
restart. The session is found from the document, so no command takes a URL.

Exit codes: 0 success, 1 server unreachable, 2 usage error.
`;

const CODEX_NOTE = `
Codex detected. Your sandbox may block the loopback bind that \`start\` needs and
the npx fetch that installs this CLI. If \`start\` cannot bind 127.0.0.1, say so
plainly and fall back to reviewing the document in chat rather than retrying.
`;

export function main() {
  out.nextStep('run `sw-specs-editor start --doc specs/NNNN-slug.md`');
  out.payload(GUIDE.trim());
  if (process.env.CODEX_SANDBOX || process.env.CODEX_THREAD_ID) out.payload(CODEX_NOTE.trim());
}
