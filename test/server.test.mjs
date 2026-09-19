// In-process acceptance tests for lib/server.mjs.
//
// The server runs inside the test process on an ephemeral port, in a throwaway
// host repo, with `process.exit` stubbed - `Session.shutdown()` calls it. Time is
// never waited out: `grace`/`agentTimeout` are set small, `lastBeat`/`lastPoll`
// are rewound, and `tick()` is called directly instead of waiting for the 5 s
// interval that drives it in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { canBind, hostRepo, j, sseReader, cleanup, startFixtureServer, sleep, run } from './helpers.mjs';
import { collapseSessions } from '../lib/server.mjs';

const SESSION = 'specs/.editor/0099-mini';
const bindable = await canBind();
const skip = !bindable && 'cannot bind 127.0.0.1 in this environment';

/** Boot a server plus an SSE reader in a fresh host repo. */
async function boot(t, overrides = {}) {
  const root = hostRepo();
  const { session, realExit, url } = await startFixtureServer(root, overrides);
  const sse = await sseReader(url);
  t.after(() => cleanup({ sse, session, realExit, root }));
  return { root, session, url, sse, read: d => fs.readFileSync(path.join(root, 'specs', d), 'utf8') };
}

test('the page, its assets and files under specs/ are served, and nothing else is', { skip }, async t => {
  const { root, url } = await boot(t);

  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /<html|<!doctype/i);

  const asset = await fetch(url + 'page/app.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(url + 'page/nope.js')).status, 404);

  // `/file` is how the page reads the documents and the diagram scenes.
  const doc = await fetch(url + 'file?path=specs/0099-mini.md');
  assert.equal(doc.status, 200);
  assert.match(await doc.text(), /PRD-0099/);

  // Anything outside specs/ is refused, however it is spelled.
  fs.writeFileSync(path.join(root, 'secret.txt'), 'top secret');
  for (const p of ['../secret.txt', 'secret.txt', '/etc/passwd', 'specs/../secret.txt']) {
    const r = await fetch(url + 'file?path=' + encodeURIComponent(p));
    assert.equal(r.status, 403, `${p} must be refused`);
  }
  assert.equal((await fetch(url + 'file?path=specs/missing.md')).status, 404);
});

test('api/session carries both documents of the pair', { skip }, async t => {
  const { url, session } = await boot(t);
  const { status, body } = await j(url + 'api/session');
  assert.equal(status, 200);

  assert.deepEqual(body.paths, { prd: 'specs/0099-mini.md', spec: 'specs/0099-mini-spec.md' });
  assert.equal(body.docs.prd.title, 'PRD-0099 — Mini fixture');
  assert.equal(body.docs.spec.title, 'Tech spec 0099 — Mini fixture');
  assert.equal(body.docs.spec.doc, 'spec');

  assert.equal(body.session.slug, '0099-mini');
  assert.deepEqual(body.session.locks, { prd: null, spec: null });
  assert.equal(body.session.agent.present, false);
  assert.equal(body.session.run, null);
  assert.deepEqual(body.notes, []);
  assert.ok(Array.isArray(body.chat));

  // The lock file is the only cross-process handshake, so it must exist while running.
  const lock = JSON.parse(fs.readFileSync(path.join(session.root, SESSION, 'session.lock'), 'utf8'));
  assert.equal(lock.url, url);
  assert.equal(lock.pid, process.pid);
});

test('a batch locks the documents it touches, and a page write queues while locked', { skip }, async t => {
  const { url, session, sse } = await boot(t);

  const queued = await j(url + 'api/batch', { docs: { prd: { notes: [{ id: 'FR-1', text: 'tighten this' }] } }, chat: 'please look' });
  assert.equal(queued.status, 200);
  assert.equal(queued.body.id, 'b-1');
  assert.equal(queued.body.queued, false, 'no run is active, so it is not waiting behind one');
  await sse.wait(e => e.event === 'run' && e.data.state === 'queued');
  assert.ok(fs.existsSync(path.join(session.root, SESSION, 'batches', 'b-1.json')));

  // The agent picks it up: that is what starts the run and takes the lock.
  const next = await j(url + 'api/next?wait=1');
  assert.equal(next.body.event, 'batch');
  assert.equal(next.body.batch.id, 'b-1');
  assert.deepEqual(next.body.batch.touched, ['prd']);
  const started = await sse.wait(e => e.event === 'run' && e.data.state === 'started');
  assert.equal(started.data.batch, 'b-1');

  assert.equal(session.locks.prd, 'b-1');
  assert.equal(session.locks.spec, null, 'an untouched document stays writable');
  assert.ok(fs.existsSync(path.join(session.root, SESSION, 'snapshot.json')));

  // A status toggle on the locked document is accepted but deferred, not lost.
  const blocked = await j(url + 'api/status', { doc: 'prd', id: 'FR-3', status: 'done' });
  assert.equal(blocked.status, 202);
  assert.deepEqual(blocked.body, { queued: true, lockedBy: 'b-1' });
  assert.equal(session.queued.length, 1);
  assert.ok(!fs.readFileSync(path.join(session.root, 'specs/0099-mini.md'), 'utf8').includes('**FR-3** [done]'));

  // The unlocked document takes the same write immediately.
  const direct = await j(url + 'api/status', { doc: 'spec', id: 'AC-2', status: 'partly' });
  assert.equal(direct.status, 200);
  assert.equal(direct.body.changed, true);
});

test('the agent reply unlocks, applies the queued write and releases a waiting poll', { skip }, async t => {
  const { url, session, sse, read } = await boot(t);

  await j(url + 'api/batch', { docs: { prd: { notes: [{ id: 'FR-1', text: 'note' }] } } });
  await j(url + 'api/next?wait=1');
  // An agent progress ping is evidence the batch was received, so a
  // later poll parks instead of treating the run as lost and redelivering it.
  await j(url + 'api/agent/progress', { batch: 'b-1', doc: 'prd', text: 'reading FR-1' });
  await j(url + 'api/status', { doc: 'prd', id: 'FR-3', status: 'done' });
  assert.equal(session.locks.prd, 'b-1');

  // A second poll parks: only one run may be active at a time.
  const parked = j(url + 'api/next?wait=5');

  const reply = await j(url + 'api/agent/reply', { batch: 'b-1', doc: 'prd', markdown: 'Tightened FR-1.' });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.results.map(r => r.doc), ['prd']);

  assert.equal(session.locks.prd, null, 'the reply releases the lock');
  assert.equal(session.run, null);
  await sse.wait(e => e.event === 'run' && e.data.state === 'finished');

  // The write the page made while locked is now in the file.
  assert.match(read('0099-mini.md'), /- \*\*FR-3\*\* \[done\] The order confirmation email/);
  assert.equal(session.queued.length, 0);

  // A second batch wakes the parked poll rather than leaving it to time out.
  await j(url + 'api/batch', { docs: { spec: { notes: [{ id: 'AC-2', text: 'and this' }] } } });
  const woken = await parked;
  assert.equal(woken.body.event, 'batch');
  assert.equal(woken.body.batch.id, 'b-2');
  assert.deepEqual(woken.body.batch.touched, ['spec']);
});

test('emit progress and chat reach the chat log and the page', { skip }, async t => {
  const { root, url, session, sse } = await boot(t);

  await j(url + 'api/batch', { docs: { prd: { notes: [{ id: 'FR-1', text: 'note' }] } } });
  await j(url + 'api/next?wait=1');

  // Through the real CLI, because that is how a skill calls it.
  const progress = await run(['emit', 'progress', 'reading the PRD', '--batch', 'b-1', '--doc', 'prd'], root);
  assert.equal(progress.code, 0, progress.err);
  const onWire = await sse.wait(e => e.event === 'progress');
  assert.equal(onWire.data.text, 'reading the PRD');
  assert.equal(onWire.data.batch, 'b-1');

  const chat = await run(['emit', 'chat', 'one question first', '--batch', 'b-1', '--doc', 'prd'], root);
  assert.equal(chat.code, 0, chat.err);
  await sse.wait(e => e.event === 'chat' && e.data.type === 'reply');
  assert.equal(session.locks.prd, 'b-1', 'an interim message leaves the run active');

  const done = await run(['emit', 'done', 'finished', '--batch', 'b-1', '--doc', 'prd'], root);
  assert.equal(done.code, 0, done.err);
  assert.equal(session.locks.prd, null, 'done is the final reply and releases the lock');

  const log = fs.readFileSync(path.join(root, SESSION, 'chat.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(
    log.filter(e => ['progress', 'reply'].includes(e.type)).map(e => [e.type, e.md ?? e.text]),
    [['progress', 'reading the PRD'], ['reply', 'one question first'], ['reply', 'finished']],
    'the chat log keeps the order the agent spoke in',
  );
});

test('an external edit reloads the document and reports what changed', { skip }, async t => {
  const { root, sse } = await boot(t);

  const file = path.join(root, 'specs/0099-mini.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
    'The order confirmation email states the chosen delivery date.',
    'The order confirmation email states the chosen delivery date in bold.',
  ));

  // fs.watch plus the server's 150 ms debounce; the Tender tool budgets the same 4 s.
  const ev = await sse.wait(e => e.event === 'doc' && e.data.doc === 'prd', 4000);
  assert.deepEqual(ev.data.changed, ['FR-3']);
  assert.deepEqual(ev.data.added, []);
  assert.deepEqual(ev.data.removed, []);
  assert.match(ev.data.model.blocks.find(b => b.id === 's5').children.find(b => b.id === 'FR-3').md, /in bold/);
});

test('losing the heartbeat closes the session; agent silence only warns', { skip }, async t => {
  const { root, session } = await boot(t, { grace: 1, agentTimeout: 1 });
  const lockFile = path.join(root, SESSION, 'session.lock');
  assert.ok(fs.existsSync(lockFile));

  // A run is active and the agent has gone quiet well past its timeout.
  await j(session.url + 'api/batch', { docs: { prd: { notes: [{ id: 'FR-1', text: 'note' }] } } });
  await j(session.url + 'api/next?wait=1');
  session.lastPoll = Date.now() - 10_000;
  session.beat();
  session.tick();

  assert.equal(session.closing, undefined, 'silence never ends a run: only `emit done` or the user does');
  assert.equal(session.locks.prd, 'b-1', 'the lock is held for as long as the run lasts');
  assert.equal(session.run.warned, true);
  const warned = session.chatHistory().filter(e => e.type === 'system' && /no sign of the agent/.test(e.text));
  assert.equal(warned.length, 1, 'the warning is written once, not on every tick');
  session.tick();
  assert.equal(session.chatHistory().filter(e => e.type === 'system' && /no sign of the agent/.test(e.text)).length, 1);

  // The browser tab, however, is what keeps the server alive.
  session.lastBeat = Date.now() - 5_000;
  session.tick();
  assert.equal(session.closing, true);
  await sleep(300);
  assert.equal(fs.existsSync(lockFile), false, 'shutdown removes the lock so no command believes a dead server');
});

test('malformed requests are refused rather than half-applied', { skip }, async t => {
  const { url, session } = await boot(t);

  // A batch with no notes and no chat has nothing for an agent to do.
  const empty = await j(url + 'api/batch', { docs: { prd: { notes: [] } } });
  assert.equal(empty.status, 400);
  assert.equal(session.queue.length, 0);

  const badStatus = await j(url + 'api/status', { doc: 'prd', id: 'FR-1', status: 'nearly' });
  assert.equal(badStatus.status, 400);

  // A well-formed request naming a block that does not exist is not an error,
  // but it must report that it changed nothing.
  const missing = await j(url + 'api/status', { doc: 'prd', id: 'FR-404', status: 'done' });
  assert.equal(missing.status, 200);
  assert.equal(missing.body.changed, false);

  const badJson = await fetch(url + 'api/batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(badJson.status, 400);

  assert.equal((await fetch(url + 'api/nonesuch')).status, 404);
  assert.equal((await fetch(url + 'api/batch')).status, 404, 'the batch endpoint is POST only');
});

test('a watch error degrades live reload instead of killing the process', { skip }, async t => {
  // fs.watch reports EMFILE and friends asynchronously on the FSWatcher; without
  // a listener that unhandled 'error' event takes the whole server down.
  const { url, session } = await boot(t, { watchRetry: [30, 30, 30] });
  const dead = session.watcher;
  assert.ok(dead, 'the session watches the specs directory');

  dead.emit('error', new Error('EMFILE: too many open files, watch'));
  assert.notEqual(session.watcher, dead, 'the dead watcher is dropped');

  const chat = (await j(url + 'api/session')).body.chat;
  assert.ok(chat.some(e => e.type === 'system' && /file watching stopped .*EMFILE/.test(e.text)), 'the page is told once');

  await sleep(200);
  assert.ok(session.watcher, 'the watch is re-established on the retry');
  assert.equal(session.watchAttempt, 0, 'a successful retry resets the backoff');
  assert.equal((await j(url + 'api/session')).status, 200, 'the server is still serving');
});

test('a watch that keeps failing gives up rather than retrying forever', { skip }, async t => {
  const { url, session } = await boot(t, { watchRetry: [10, 10] });
  session.watch = () => session.watchFailed(new Error('EMFILE: too many open files, watch')); // never recovers
  session.watcher.emit('error', new Error('EMFILE: too many open files, watch'));

  await sleep(200);
  const chat = (await j(url + 'api/session')).body.chat;
  assert.equal(chat.filter(e => /file watching stopped/.test(e.text || '')).length, 1, 'the warning is posted once, not per attempt');
  assert.ok(chat.some(e => /file watching gave up after 2 attempts/.test(e.text || '')), 'and the give-up is reported');
  assert.equal((await j(url + 'api/session')).status, 200, 'the server is still serving');
});

test('only the newest session banner survives; older boundaries collapse to one divider', () => {
  const log = [
    { type: 'system', text: 'session started on http://127.0.0.1:1/' },
    { type: 'reply', md: 'one' },
    { type: 'system', text: 'session closed (closed by request)' },
    { type: 'system', text: 'session resumed on http://127.0.0.1:2/' },
    { type: 'reply', md: 'two' },
    { type: 'system', text: 'session closed (closed by request)' },
    { type: 'system', text: 'session resumed on http://127.0.0.1:3/' },
  ];
  const out = collapseSessions(log);
  assert.deepEqual(out.map(e => e.text ?? e.md), ['one', 'previous session', 'two', 'session resumed on http://127.0.0.1:3/']);
  assert.deepEqual(collapseSessions(log.slice(-1)), log.slice(-1));
  assert.equal(collapseSessions([{ type: 'system', text: 'file watching resumed' }])[0].text, 'file watching resumed');
});
