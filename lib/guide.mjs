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

0. PREPARE
   Session state is written to specs/.editor/<slug>/ and must not be committed:
     grep -q "specs/.editor" .gitignore || printf '\\n/specs/.editor/\\n' >> .gitignore

1. START
   sw-specs-editor start --doc specs/NNNN-slug.md
   Prints SPECS_EDITOR_URL=<url>. Both documents of a pair (PRD and -spec) are
   served as two tabs of one session, whichever one you pass. Starting a second
   time reattaches to the running server instead of binding a second port.

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
   A batch locks the documents it touches. While a document is locked the
   user's direct edits (status ticks, question answers, diagrams) are queued
   and applied when you release it.

   The batch JSON carries: id, touched (["prd"], ["spec"] or both),
   docs.<doc>.notes, chat, chatDoc, createSpec, root (the project root), file
   (this batch file), context (chat.jsonl). Each note has kind (comment |
   answer | free | diagram) and text; block-bound notes also carry file, block,
   blockKind, path (breadcrumb of ancestor sections), line-endLine, md (block
   source), quote, hash, and optionally selection (the exact text the user
   highlighted); answer notes may carry option.

   Every path you have to OPEN is absolute, so it resolves whatever directory
   you are working in - use it as given, do not join it to anything. The
   *Rel twins (fileRel, pathRel, contextRel) are the project-relative form,
   for quoting to the user; never open those.

5. TALK BACK
   sw-specs-editor emit progress "<step>" --batch <id> --doc prd
       one status line; also tells the page you are still alive
   sw-specs-editor emit chat "<markdown>" --batch <id> --doc prd
       an interim message; the run stays active
   sw-specs-editor emit done --batch <id> --doc prd -
       the final answer for one document; releases its lock. Body on stdin -
       post it with a heredoc so markdown stays intact:
         sw-specs-editor emit done --batch <id> --doc prd - <<'EOF'
         <report>
         EOF
       If the run failed, still post one line ("Run failed: <one line>") so
       the lock is released rather than left hanging.
       The server verifies the file against its pre-run snapshot and repairs
       anything the agent dropped: status tags, diagram lines, question
       ticks.
   sw-specs-editor diagram <graph.json> <out.excalidraw>
       deterministic Excalidraw scene plus an SVG fallback

6. CLOSE
   sw-specs-editor stop --doc specs/NNNN-slug.md
   The server also exits by itself when the page has been gone for 60 s, and
   after --idle seconds (default 14400 = 4h) without a batch, poll, reply or
   page write.

   On "event: closed", or when the server has become unreachable, summarise the
   session for the user in five lines:
     - the documents, by path
     - how many batches you processed
     - the final status line per document (sw-specs-editor status --doc <path>
       while it is still reachable, otherwise the documents' own meta tables)
     - the chat log: specs/.editor/<slug>/chat.jsonl
     - how to resume: re-run the same command. Chat, unsent notes and statuses
       are all restored.

   If you are interrupted while the page is open, the server keeps serving it
   read-only and the page shows "agent disconnected" after about two minutes.
   Re-running reattaches to the same URL.

sw-specs-editor status --doc specs/NNNN-slug.md
    reads session state without a URL: running, prd/spec block counts, notes
    unsent, run_active, and more behind --json. This is the current way to
    check the session; there is no other read channel.

State lives in specs/.editor/<slug>/ and is gitignored. The queue itself
(specs/.editor/<slug>/queue.json) is durable and survives a server restart.
The session is found from the document, so no command takes a URL.

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
