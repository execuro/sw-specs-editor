// One session, one document.
//
// This suite exists because of a specific defect. A session used to serve a PRD
// and its tech spec as two tabs sharing one folder, one chat log, one queue and
// one batch id space, and a batch carried `touched: ["prd"] | ["spec"] | both`.
// A session opened by `sw-design-requirements` could therefore be handed a batch
// whose touched document was the spec, and dispatch `sw-design-solution` out of
// it - a different skill, different rules, different document - while both runs
// wrote into the same chat history.
//
// The fix is structural rather than advisory: the batch has no field an agent
// could loop over to reach the other skill, and the other document is reachable
// only as a read-only path. These tests assert that shape, not the advice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { resolveDoc } from '../lib/server.mjs';
import { sessionDirs } from '../lib/session.mjs';
import { sessionSlugFor } from '../lib/parse.mjs';
import { canBind, hostRepo, j, sseReader, cleanup, sleep, run, field, startFixtureServer } from './helpers.mjs';

const PRD = 'specs/0099-mini.md';
const SPEC = 'specs/0099-mini-spec.md';
const bindable = await canBind();
const skip = !bindable && 'cannot bind 127.0.0.1 in this environment';

/**
 * Stop every detached session in `root`, then remove it.
 *
 * `teardown` in helpers.mjs removes the root after stopping one document, which
 * is wrong here: the pair's other session is still running, and its `stop` would
 * spawn into a directory that no longer exists.
 */
async function stopAll(root, docs) {
  for (const doc of docs) { try { await run(['stop', '--doc', doc], root); } catch { /* already gone */ } }
  const locks = docs.map(d => path.join(root, 'specs', '.editor', sessionSlugFor(d), 'session.lock'));
  for (let i = 0; i < 20 && locks.some(l => fs.existsSync(l)); i++) await sleep(50);
  await sleep(250);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

// `Session.shutdown` ends by calling `process.exit`, which an in-process server
// must not do to the test runner. Stubbed once for the whole file, never restored:
// this suite runs two servers at a time, and restoring after the first lets the
// second's exit timer fire against the real one and kill the run mid-file.
process.exit = () => {};

/** `startFixtureServer` on one document, plus its event stream. */
async function serve(root, doc, t) {
  const { session } = await startFixtureServer(root, { docs: [doc] });
  const sse = await sseReader(session.url);
  t.after(() => cleanup({ sse, session }));
  return { session, sse, url: session.url };
}

test('resolveDoc picks the mode from the filename and keeps the sibling as reference', () => {
  const root = '/repo';
  const prd = resolveDoc(root, 'specs/0099-mini.md');
  assert.equal(prd.doc, 'prd');
  assert.equal(prd.sessionSlug, '0099-mini-prd');
  assert.equal(prd.referenceRel, 'specs/0099-mini-spec.md');

  const spec = resolveDoc(root, 'specs/0099-mini-spec.md');
  assert.equal(spec.doc, 'spec');
  assert.equal(spec.sessionSlug, '0099-mini-spec');
  assert.equal(spec.referenceRel, 'specs/0099-mini.md');

  // Same feature, same slug - and still two sessions, which is the point.
  assert.equal(prd.slug, spec.slug);
  assert.notEqual(prd.sessionDir, spec.sessionDir);
  assert.equal(prd.legacyDir, spec.legacyDir, 'both know the one pre-split folder to retire');
});

test('a second --doc is refused: a session edits one document', async t => {
  if (!bindable) return t.skip(skip);
  const root = hostRepo();
  try {
    const r = await run(['start', '--doc', PRD, '--doc', SPEC], root);
    assert.equal(r.code, 2);
    assert.match(r.err, /a session edits one document; start a second session for specs\/0099-mini-spec\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the PRD and the spec run as two sessions that share nothing', { skip }, async t => {
  const root = hostRepo();
  const a = await serve(root, PRD, t);
  const b = await serve(root, SPEC, t);
  // Registered last, so it runs last: `after` hooks fire in order, and removing
  // the repo before the servers are down leaves their watchers and sockets held.
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

  // Separate ports, separate folders, separate locks.
  assert.notEqual(a.url, b.url);
  assert.equal(a.session.dir, path.join(root, 'specs', '.editor', '0099-mini-prd'));
  assert.equal(b.session.dir, path.join(root, 'specs', '.editor', '0099-mini-spec'));
  for (const s of [a, b]) assert.ok(fs.existsSync(path.join(s.session.dir, 'session.lock')));

  // A note for each, sent to its own page.
  await j(a.url + 'api/batch', { notes: [{ id: 'FR-1', text: 'a requirement note' }] });
  await j(b.url + 'api/batch', { notes: [{ id: 'AC-2', text: 'an implementation note' }] });

  const fromA = await j(a.url + 'api/next?wait=1');
  const fromB = await j(b.url + 'api/next?wait=1');

  // Each session hands its agent its own document and its own note, so which
  // design skill to run follows from the session, not from anything in the body.
  assert.equal(fromA.body.batch.doc, 'prd');
  assert.equal(fromA.body.batch.pathRel, PRD);
  assert.deepEqual(fromA.body.batch.notes.map(n => n.id), ['FR-1']);
  assert.equal(fromB.body.batch.doc, 'spec');
  assert.equal(fromB.body.batch.pathRel, SPEC);
  assert.deepEqual(fromB.body.batch.notes.map(n => n.id), ['AC-2']);

  // The assertion that makes the old bug unreproducible rather than merely
  // absent: there is no `touched` to iterate, no `docs` map to index by the
  // other side, and no `createSpec` to branch on.
  for (const batch of [fromA.body.batch, fromB.body.batch]) {
    assert.ok(!('touched' in batch), 'no touched array to loop over');
    assert.ok(!('docs' in batch), 'no per-document envelope to index');
    assert.ok(!('createSpec' in batch), 'no createSpec to dispatch the other skill');
    assert.ok(!('paths' in batch) && !('pathsRel' in batch), 'no path pair');
  }

  // Finishing one run leaves the other's lock exactly where it was.
  assert.equal(a.session.lock, 'b-1');
  assert.equal(b.session.lock, 'b-1', 'its own id space, starting at b-1 again');
  await j(a.url + 'api/agent/reply', { batch: 'b-1', markdown: 'PRD done.' });
  assert.equal(a.session.lock, null);
  assert.equal(b.session.lock, 'b-1', 'the spec session is untouched by the PRD reply');

  // And the histories never mix - the reason the split exists.
  const chatA = fs.readFileSync(path.join(a.session.dir, 'chat.jsonl'), 'utf8');
  const chatB = fs.readFileSync(path.join(b.session.dir, 'chat.jsonl'), 'utf8');
  assert.match(chatA, /a requirement note/);
  assert.ok(!chatA.includes('an implementation note'), 'the PRD log holds no spec note');
  assert.match(chatB, /an implementation note/);
  assert.ok(!chatB.includes('a requirement note'), 'the spec log holds no PRD note');
  assert.ok(!chatB.includes('PRD done.'), 'nor the other run\'s reply');
});

test('the sibling is a read-only path for the agent, never content for the page', { skip }, async t => {
  const root = hostRepo();
  const { url } = await serve(root, SPEC, t);
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

  // The page is told the PRD exists and where it is. Nothing more: a parsed
  // sibling model is what would let notes, ticks and locks find their way back
  // to the other document.
  const { body } = await j(url + 'api/session');
  assert.equal(body.doc, 'spec');
  assert.equal(body.reference.pathRel, PRD);
  assert.equal(body.reference.exists, true);
  assert.ok(!body.reference.model && !body.reference.blocks && !body.reference.title && !body.reference.text);

  // The agent gets an absolute path it can actually open, flagged read-only.
  await j(url + 'api/batch', { notes: [{ id: 'AC-2', text: 'check this against the PRD' }] });
  const next = await j(url + 'api/next?wait=1');
  const ref = next.body.batch.reference;
  assert.equal(ref.doc, 'prd');
  assert.ok(path.isAbsolute(ref.path));
  assert.ok(fs.existsSync(ref.path));
  assert.equal(ref.pathRel, PRD);
  assert.equal(ref.readOnly, true);
});

test('a missing sibling is absent from the batch rather than a broken path', { skip }, async t => {
  const root = hostRepo(['0099-mini.md']); // no spec on disk
  const { url } = await serve(root, PRD, t);
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

  const { body } = await j(url + 'api/session');
  assert.equal(body.reference.exists, false);

  await j(url + 'api/batch', { notes: [{ id: 'FR-1', text: 'note' }] });
  const next = await j(url + 'api/next?wait=1');
  assert.equal(next.body.batch.reference, undefined, 'nothing to read, so nothing to offer');
});

test('sessionDirs ignores a pre-split folder, and start archives it', { skip }, async t => {
  const root = hostRepo();
  try {
    // A folder from when one session served both documents. Its chat log
    // interleaves the two, and its `system` lines name neither, so it cannot be
    // split honestly - it is archived, never adopted.
    const legacy = path.join(root, 'specs', '.editor', '0099-mini');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'chat.jsonl'), '{"type":"system","text":"session started on http://127.0.0.1:1/"}\n');

    assert.deepEqual(sessionDirs(root).map(d => d.sessionSlug), [], 'invisible to resolution');

    const started = await run(['start', '--doc', PRD], root);
    assert.equal(started.code, 0, started.err);
    await sleep(300);

    assert.ok(!fs.existsSync(legacy), 'the pre-split folder is gone');
    assert.ok(fs.existsSync(`${legacy}.pre-split`), 'archived, not deleted');
    assert.ok(fs.existsSync(path.join(root, 'specs', '.editor', '0099-mini-prd')), 'a fresh session takes its place');

    // The archive is announced where the user is looking, not only in a terminal.
    const chat = fs.readFileSync(path.join(root, 'specs', '.editor', '0099-mini-prd', 'chat.jsonl'), 'utf8');
    assert.match(chat, /previous combined PRD\+spec session was archived/);

    assert.deepEqual(sessionDirs(root).map(d => d.sessionSlug), ['0099-mini-prd']);
  } finally {
    await stopAll(root, [PRD]);
  }
});

test('emit names its session by document path once both sessions are live', { skip }, async t => {
  const root = hostRepo();
  try {
    for (const doc of [PRD, SPEC]) assert.equal((await run(['start', '--doc', doc], root)).code, 0);
    await sleep(300);
    for (const doc of [PRD, SPEC]) {
      const body = JSON.stringify({ notes: [{ id: 'X', text: 'note' }] });
      await run(['batch', '--kind', 'notes', '--doc', doc, '-'], root, body);
      await run(['poll', '--wait', '2', '--doc', doc], root);
    }

    // With one session live the no-flag form was unambiguous. With a feature's
    // PRD and spec both open it is not, so it must say so rather than guess -
    // guessing is how a reply reaches the wrong document.
    const ambiguous = await run(['emit', 'progress', 'working'], root);
    assert.equal(ambiguous.code, 2);
    assert.match(ambiguous.err, /several editor sessions are running/);
    // It names the documents, because a document path is what the caller has to pass back.
    assert.match(ambiguous.err, /specs\/0099-mini\.md/);
    assert.match(ambiguous.err, /specs\/0099-mini-spec\.md/);
    assert.match(ambiguous.err, /next_step: repeat the command with --doc <document path>/);

    // The path picks one, and the line lands only in that session's log.
    const toSpec = await run(['emit', 'progress', 'reading the spec', '--batch', 'b-1', '--doc', SPEC], root);
    assert.equal(toSpec.code, 0, toSpec.err);
    const specLog = fs.readFileSync(path.join(root, 'specs', '.editor', '0099-mini-spec', 'chat.jsonl'), 'utf8');
    const prdLog = fs.readFileSync(path.join(root, 'specs', '.editor', '0099-mini-prd', 'chat.jsonl'), 'utf8');
    assert.match(specLog, /reading the spec/);
    assert.ok(!prdLog.includes('reading the spec'), 'the PRD session never hears about it');

    // The pair-side literal cannot disambiguate, so it degrades to the ambiguity
    // error rather than silently picking a session.
    const legacy = await run(['emit', 'progress', 'x', '--doc', 'prd'], root);
    assert.equal(legacy.code, 2);
    assert.match(legacy.err, /several editor sessions are running/);
  } finally {
    await stopAll(root, [PRD, SPEC]);
  }
});

test('status reports the mode and the reference document', { skip }, async t => {
  const root = hostRepo();
  try {
    assert.equal((await run(['start', '--doc', PRD], root)).code, 0);
    await sleep(300);

    const r = await run(['status', '--doc', PRD], root);
    assert.equal(field(r.out, 'doc'), 'prd');
    assert.equal(field(r.out, 'path'), PRD);
    assert.equal(field(r.out, 'reference'), SPEC);
  } finally {
    await stopAll(root, [PRD]);
  }
});

