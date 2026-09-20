#!/usr/bin/env node
// sw-specs-editor - the single entry point.
//
// Every other file in this package exports main(argv) and never looks at
// process.argv. That is the whole point: the previous entry points gated their
// main() on comparing process.argv[1] to their own module path, which does not
// match when the package is reached through npx's node_modules/.bin symlink, so
// the command exited 0 having silently done nothing.

import * as out from '../lib/out.mjs';

// A consumer that stops reading (`| head`, a truncating harness) closes our
// stdout, and the next write raises EPIPE. That is the reader's choice, not an
// error of ours, so exit quietly instead of dumping a stack over the output.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', e => { if (e?.code === 'EPIPE') process.exit(out.EXIT_OK); throw e; });
}

const COMMANDS = {
  start: () => import('../lib/server.mjs'),
  status: () => import('../lib/server.mjs'),
  stop: () => import('../lib/server.mjs'),
  migrate: () => import('../lib/server.mjs'),
  poll: () => import('../lib/poll.mjs'),
  emit: () => import('../lib/emit.mjs'),
  batch: () => import('../lib/batch.mjs'),
  diagram: () => import('../lib/diagram.mjs'),
  guide: () => import('../lib/guide.mjs'),
  'install-skill': () => import('../lib/install-skill.mjs'),
  'uninstall-skill': () => import('../lib/uninstall-skill.mjs'),
};

const USAGE = `usage: sw-specs-editor <command> [options]

  start    --doc <path> [--port N] [--grace S] [--agent-timeout S] [--idle S] [--foreground] [--root <path>]
  status   [--doc <path>] [--json] [--root <path>]
  stop     [--doc <path>] [--root <path>]
  poll     [--wait 90] [--reply "<text>"] [--doc <path>] [--root <path>]
  emit     progress|chat|done "<text>" [--batch <id>] [--doc <path>] [--since <iso>] [--root <path>]
  batch    --kind notes [--doc <path>] - [--root <path>]
  diagram  <graph.json> <out.excalidraw> [--svg <path>|auto|none]
  migrate  --doc <path> [--root <path>]
  guide    print the session protocol
  install-skill   [--target <dir>] [--print] [--force]   install this package's skill into a host
  uninstall-skill [--target <dir>]                      remove the skill this package installed

A session edits one document; the filename picks the mode: a path ending in
-spec.md opens a tech-spec session, anything else a PRD session. A PRD and its
spec are separate sessions and may run side by side, so pass --doc <path>
whenever both are open.

The project root is taken from the document: the nearest ancestor holding .git,
or the current directory when there is no document. --root overrides it. Session
state always lands in <project root>/specs/.editor/<slug>-prd/ or <slug>-spec/,
whatever directory the command was run from.

Run \`sw-specs-editor guide\` first: it is the current session protocol.`;

const argv = process.argv.slice(2);
const cmd = argv[0];

if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  process.stdout.write(`${USAGE}\n`);
  process.exit(cmd ? out.EXIT_OK : out.EXIT_USAGE);
}

const load = COMMANDS[cmd];
if (!load) {
  process.stderr.write(`unknown command ${cmd}\n${USAGE}\n`);
  process.exit(out.EXIT_USAGE);
}

const SERVER_COMMANDS = ['start', 'status', 'stop', 'migrate'];
// Only the commands that take a --doc need to turn one into a session
// directory, and only they pay for loading the server module.
const NEEDS_RESOLVE = ['poll', 'batch', 'emit'];

try {
  const mod = await load();
  const args = SERVER_COMMANDS.includes(cmd) ? argv : argv.slice(1);
  const ctx = NEEDS_RESOLVE.includes(cmd) ? { resolveDoc: (await import('../lib/server.mjs')).resolveDoc } : {};
  await mod.main(args, ctx);
} catch (e) {
  process.stderr.write(`${e?.stack || e?.message || e}\n`);
  process.exit(1);
}
