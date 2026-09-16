// The shared editor-CLI contract.
//
// VENDORED FILE. A byte-identical copy lives in the sibling editor CLI. The two
// packages deliberately do not share code - they ship and version separately,
// and a shared dependency would break the zero-dependency rule both of them
// keep. What they do share is a contract, and this file is it.
//
// It exists because of what happened without it: the two CLIs drifted into
// opposite refusal contracts (stdout and exit 2 in one, stderr and exit 1 in
// the other), disagreed on whether a flag was required or defaulted, silently
// swallowed unknown flags, and one of them folded them into the message text.
// Every one of those was invisible to both green suites, because each package
// only ever tested itself.
//
// So this suite asserts behaviour through the CLI, never implementation. Either
// package may satisfy it however it likes. When it changes, it changes in both
// copies in the same sitting - that is the whole discipline, and there is no
// mechanism enforcing it beyond this paragraph.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { run } from './helpers.mjs';

// The commands this package exposes. The other package's copy lists its own.
const COMMANDS = ['start', 'status', 'stop', 'poll', 'emit', 'batch', 'diagram', 'migrate', 'guide', 'install-skill'];

// Commands that answer without a running server and without arguments.
const SELF_CONTAINED = ['guide'];

test('conformance: the exit codes mean the same thing everywhere', async () => {
  // 2 = the caller made a mistake. 1 = the caller was right but nothing is
  // listening. An agent branches on these, so they cannot be approximate.
  const usage = await run(['bogus-command'], os.tmpdir());
  assert.equal(usage.code, 2, 'an unknown command is a usage error');

  const unreachable = await run(['poll', '--wait', '1'], os.tmpdir());
  assert.equal(unreachable.code, 1, 'no server running is exit 1, not 2 and not 0');
});

test('conformance: a usage error goes to stderr, never to stdout', async () => {
  // stdout is the result channel. An agent that reads stdout for a result must
  // not find an error message sitting there looking like one.
  const r = await run(['bogus-command'], os.tmpdir());
  assert.equal(r.out, '', `stdout must stay empty on a usage error, got: ${r.out}`);
  assert.match(r.err, /unknown command/);
});

test('conformance: every command carries a next_step line', async () => {
  for (const cmd of SELF_CONTAINED) {
    const r = await run([cmd], os.tmpdir());
    assert.equal(r.code, 0, `${cmd}: ${r.err}`);
    assert.match(r.out, /^next_step: /m, `${cmd} printed no next_step`);
  }
  // Even the failure paths say what to do next, or the agent is stuck.
  const unreachable = await run(['poll', '--wait', '1'], os.tmpdir());
  assert.match(unreachable.err, /next_step: /, 'an unreachable server must still say what to do');
});

test('conformance: next_step precedes any large payload', async () => {
  // An agent that reads only the head of a long output still has to learn what
  // to do next, so the instruction cannot sit underneath the data.
  const r = await run(['guide'], os.tmpdir());
  const step = r.out.indexOf('next_step:');
  const body = r.out.indexOf('Specs Editor - session protocol');
  assert.ok(step >= 0 && body >= 0, 'expected both a next_step and a payload');
  assert.ok(step < body, 'next_step must come before the payload');
});

test('conformance: an unknown flag is refused, not ignored', async () => {
  // Silently ignoring a flag is worse than refusing it: the agent believes it
  // asked for something it did not get.
  for (const args of [['poll', '--nonsense'], ['emit', 'progress', 'x', '--nonsense'], ['batch', '--nonsense']]) {
    const r = await run(args, os.tmpdir());
    assert.equal(r.code, 2, `${args.join(' ')} should be a usage error`);
    assert.match(r.err, /unknown flag --nonsense/);
  }
});

test('conformance: `--` ends the options, so a message may start with dashes', async () => {
  // Rejecting unknown flags made a legitimate message beginning with "--"
  // unsendable. The end-of-options marker is the fix, and it has to exist in
  // both packages or the same message works in one and not the other.
  const r = await run(['emit', 'progress', '--', '--not-a-flag'], os.tmpdir());
  assert.notEqual(r.code, 2, `"--" must end the options, got a usage error: ${r.err}`);
});

test('conformance: no command exits 0 in silence', async () => {
  // A command that does nothing and says nothing is indistinguishable from one
  // that worked. Every verb has to account for itself.
  for (const cmd of COMMANDS) {
    const r = await run([cmd, '--help-me-fail'], os.tmpdir());
    assert.ok(r.out.length + r.err.length > 0, `${cmd} produced no output at all`);
    if (r.code === 0) assert.ok(r.out.length > 0, `${cmd} exited 0 without saying anything`);
  }
});

test('conformance: --help lists every command the dispatcher accepts', async () => {
  const r = await run(['--help'], os.tmpdir());
  assert.equal(r.code, 0);
  for (const cmd of COMMANDS) {
    assert.ok(r.out.includes(cmd), `--help does not mention ${cmd}`);
  }
});
