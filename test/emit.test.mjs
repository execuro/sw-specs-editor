// lib/emit.mjs - the agent's only channel back to the page. The pure halves are
// tested directly; the exit codes go through the real CLI, because the exit code
// is the only thing an agent harness reliably sees.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, withElapsed } from '../lib/emit.mjs';
import { run, hostRepo } from './helpers.mjs';

test('parseArgs separates the flags from the text, and withElapsed prefixes the elapsed time', () => {
  const o = parseArgs(['progress', 'doing', 'the', 'thing', '--batch', 'b-7', '--doc', 'specs/0099-mini-spec.md', '--since', '2026-09-15T10:00:00Z']);
  assert.equal(o.batch, 'b-7');
  assert.ok(o.doc.endsWith(path.join('specs', '0099-mini-spec.md')), '--doc is a document path and is canonicalised');
  assert.equal(o.since, '2026-09-15T10:00:00Z');
  assert.deepEqual(o.rest, ['progress', 'doing', 'the', 'thing'], 'the command and its text stay in order');

  // A skill pinned to an older CLI still passes the pair-side literal. It names
  // nothing on disk, so it is dropped rather than canonicalised into a bogus
  // path, and the single-live-session rule applies - which is how that skill
  // behaved before the split.
  const legacy = parseArgs(['progress', 'hi', '--doc', 'prd']);
  assert.equal(legacy.doc, '');
  assert.equal(legacy.legacyDoc, 'prd');

  // A missing timestamp must never cost the agent its message.
  assert.equal(withElapsed('hello', ''), 'hello');
  assert.equal(withElapsed('hello', undefined), 'hello');
  assert.equal(withElapsed('hello', 'not a date'), 'hello');

  const since = new Date(Date.now() - 125_000).toISOString();
  assert.match(withElapsed('hello', since), /^\+2:0[45] hello$/);
  // Seconds are zero-padded, so the lines stay column-aligned in the chat log.
  assert.match(withElapsed('x', new Date(Date.now() - 61_000).toISOString()), /^\+1:0[01] x$/);
  // A timestamp in the future clamps to zero rather than going negative.
  assert.match(withElapsed('x', new Date(Date.now() + 60_000).toISOString()), /^\+0:00 x$/);
});

test('an unknown flag is a usage error, not folded into the message text', async () => {
  const root = hostRepo();
  try {
    const r = await run(['emit', 'progress', '--bogus', 'hi'], root);
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown flag --bogus/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('emit with no kind, or an unknown kind, is a usage error', async () => {
  const root = hostRepo();
  try {
    const none = await run(['emit'], root);
    assert.equal(none.code, 2);
    assert.match(none.err, /usage: sw-specs-editor emit progress\|chat\|done/);

    const bogus = await run(['emit', 'shout', 'hello'], root);
    assert.equal(bogus.code, 2);
    assert.match(bogus.err, /unknown emit command shout/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('emit exits 1 when no server is running, and reads its text from stdin', async () => {
  const root = hostRepo();
  try {
    // No session: unreachable (1), not a usage error (2) - the command was well formed.
    const r = await run(['emit', 'progress', 'still working'], root);
    assert.equal(r.code, 1);
    assert.match(r.err, /no running Specs Editor session found/);
    assert.match(r.err, /next_step: run `sw-specs-editor start/);

    // `-` reads the text from stdin; it must fail the same way, not hang on the pipe.
    const piped = await run(['emit', 'done', '-', '--batch', 'b-1', '--doc', 'prd'], root, 'a long reply\n');
    assert.equal(piped.code, 1);
    assert.match(piped.err, /no running Specs Editor session found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unknown flag is rejected, but `--` lets a message start with dashes', async () => {
  const root = hostRepo();
  try {
    // The bug this guards: an unknown flag used to be folded into the message text.
    const bogus = await run(['emit', 'progress', '--bogus', 'hi'], root);
    assert.equal(bogus.code, 2);
    assert.match(bogus.err, /unknown flag --bogus/);

    // ...but a legitimate message may start with `--`, so `--` ends the options.
    // Well-formed, so it fails as unreachable (1), not as a usage error (2).
    const sep = await run(['emit', 'progress', '--', '--force was used'], root);
    assert.equal(sep.code, 1, sep.err);
    assert.match(sep.err, /no running Specs Editor/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
