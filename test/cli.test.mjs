// CLI acceptance tests - black box, through bin/cli.mjs in a temp host repo.
//
// Everything runs against the real CLI so the entry-point wiring itself is under
// test. An earlier design gated each main() on comparing process.argv[1] to its
// own module path, which does not match through npx's node_modules/.bin symlink,
// so the command exited 0 having silently done nothing. Only a black-box run
// catches that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canBind, run, spawnCli, exec, field, hostRepo, teardown, PKG, sleep } from './helpers.mjs';

const DOC = 'specs/0099-mini.md';
const SESSION = 'specs/.editor/0099-mini';

test('guide prints the protocol and the poll rules', async () => {
  const r = await run(['guide'], os.tmpdir());
  assert.equal(r.code, 0);
  assert.match(r.out, /Specs Editor - session protocol/);
  assert.match(r.out, /Never background it with/);
  assert.match(r.out, /Exit codes: 0 success, 1 server unreachable, 2 usage error/);
  // guide is the single source of the protocol, so it must itself carry the
  // next_step line every other command carries.
  assert.equal((r.out.match(/^next_step: /gm) || []).length, 1);
  assert.ok(r.out.indexOf('next_step:') < r.out.indexOf('Specs Editor - session protocol'), 'next_step must come before the payload');
});

test('an unknown command is a usage error', async () => {
  const r = await run(['bogus'], os.tmpdir());
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command bogus/);
});

test('no command at all is a usage error', async () => {
  const r = await run([], os.tmpdir());
  assert.equal(r.code, 2);
});

test('a command against a server that is not running exits 1', async () => {
  const root = hostRepo();
  try {
    const r = await run(['poll', '--doc', DOC], root);
    assert.equal(r.code, 1);
    assert.match(r.err, /no running Specs Editor/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('diagram renders a graph to a scene and an SVG', async () => {
  const root = hostRepo();
  try {
    const r = await run(['diagram', 'specs/0099-mini.architecture.graph.json', 'specs/0099-mini-spec.architecture.excalidraw'], root);
    assert.equal(r.code, 0, r.err);
    assert.equal(field(r.out, 'nodes'), '5');
    assert.equal(field(r.out, 'edges'), '5', 'the count is of the input, before dangling edges are dropped');
    assert.match(r.out, /^next_step: /m);

    const scene = JSON.parse(fs.readFileSync(path.join(root, field(r.out, 'excalidraw')), 'utf8'));
    assert.equal(scene.type, 'excalidraw');
    assert.ok(scene.elements.some(e => e.id === 'n:order'));

    // --svg auto is the default and lands in the session folder.
    assert.equal(field(r.out, 'svg'), path.join(SESSION, 'architecture.svg'));
    assert.match(fs.readFileSync(path.join(root, field(r.out, 'svg')), 'utf8'), /^<svg /);

    // --svg none writes only the scene.
    const none = await run(['diagram', 'specs/0099-mini.architecture.graph.json', 'specs/other.excalidraw', '--svg', 'none'], root);
    assert.equal(none.code, 0, none.err);
    assert.equal(field(none.out, 'svg'), undefined);

    const usage = await run(['diagram'], root);
    assert.equal(usage.code, 2);

    // A missing input file is a usage error, not an uncaught ENOENT stack trace.
    const missing = await run(['diagram', 'specs/does-not-exist.graph.json', 'specs/out.excalidraw'], root);
    assert.equal(missing.code, 2);
    assert.match(missing.err, /diagram: cannot read/);
    assert.doesNotMatch(missing.err, /at Object\.readFileSync/, 'no raw stack trace');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migrate converts a legacy question table without starting a server', async () => {
  const root = hostRepo();
  const spec = path.join(root, 'specs/0099-mini-spec.md');
  try {
    assert.match(fs.readFileSync(spec, 'utf8'), /^\| # \| Question \|/m);

    const r = await run(['migrate', '--doc', 'specs/0099-mini-spec.md'], root);
    assert.equal(r.code, 0, r.err);

    const after = fs.readFileSync(spec, 'utf8');
    assert.ok(!/^\| # \| Question \|/m.test(after), 'the table is gone');
    assert.match(after, /^\*\*Q-1\*\* \[adr\] Which calendar/m);
    assert.match(after, /^- \[ \] A: Shipping country of the order \(recommended\)$/m);

    // No server was started, so no lock was left behind.
    assert.equal(fs.existsSync(path.join(root, SESSION, 'session.lock')), false);

    // Running it again finds no table and leaves the file alone.
    const again = await run(['migrate', '--doc', 'specs/0099-mini-spec.md'], root);
    assert.equal(again.code, 0, again.err);
    assert.equal(fs.readFileSync(spec, 'utf8'), after);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('batch --kind selects the one flag that changes a batch, and rejects anything else', async t => {
  if (!(await canBind())) return t.skip('cannot bind 127.0.0.1 in this environment');
  const root = hostRepo();
  try {
    await run(['start', '--doc', DOC], root);
    const body = JSON.stringify({ docs: { prd: { notes: [{ id: 'FR-1', text: 'write the spec' }] } } });

    // --kind spec is the only difference: it asks the agent to create the sibling.
    const spec = await run(['batch', '--kind', 'spec', '--doc', DOC, '-'], root, body);
    assert.equal(spec.code, 0, spec.err);
    const got = await run(['poll', '--wait', '2', '--doc', DOC], root);
    assert.equal(field(got.out, 'event'), 'batch');
    const payload = JSON.parse(got.out.slice(got.out.indexOf('{')));
    assert.equal(payload.createSpec, true);
    assert.deepEqual(payload.touched, ['prd']);
    assert.equal(payload.docs.prd.notes[0].id, 'FR-1', 'the body survives the flag');

    // --kind notes is the default and leaves the flag off.
    await run(['emit', 'done', 'done', '--batch', payload.id, '--doc', 'prd'], root);
    await run(['batch', '--kind', 'notes', '--doc', DOC, '-'], root, body);
    const plain = await run(['poll', '--wait', '2', '--doc', DOC], root);
    assert.equal(JSON.parse(plain.out.slice(plain.out.indexOf('{'))).createSpec, false);

    // Anything else is a usage error, and nothing is queued.
    const bogus = await run(['batch', '--kind', 'analysis', '--doc', DOC, '-'], root, body);
    assert.equal(bogus.code, 2);
    assert.match(bogus.err, /unknown batch kind analysis/);

    // An empty body is a usage error too, not an empty batch.
    const empty = await run(['batch', '--kind', 'notes', '--doc', DOC, '-'], root, '');
    assert.equal(empty.code, 2);
    const notJson = await run(['batch', '--kind', 'notes', '--doc', DOC, '-'], root, 'nonsense');
    assert.equal(notJson.code, 2);
    assert.match(notJson.err, /not valid JSON/);

    // --kind is required: a missing one must not silently default to notes.
    const noKind = await run(['batch', '--doc', DOC, '-'], root, body);
    assert.equal(noKind.code, 2);
    assert.match(noKind.err, /missing --kind/);

    // An unrecognised flag anywhere is a usage error, not silently ignored.
    const unknownFlag = await run(['batch', '--kind', 'notes', '--bogus', 'hi', '--doc', DOC, '-'], root, body);
    assert.equal(unknownFlag.code, 2);
    assert.match(unknownFlag.err, /unknown flag --bogus/);
  } finally {
    await teardown(root);
  }
});

test('start / status / reattach / poll / batch / stop', async t => {
  if (!(await canBind())) return t.skip('cannot bind 127.0.0.1 in this environment');
  const root = hostRepo();
  try {
    const start = await run(['start', '--doc', DOC], root);
    assert.equal(start.code, 0);
    const url = (start.out.match(/^SPECS_EDITOR_URL=(.*)$/m) || [])[1];
    assert.ok(url, `start printed no URL: ${start.out}${start.err}`);
    assert.match(start.out, /^next_step: /m);

    // GET /health carries the package's own version, read from its package.json
    const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
    const health = await (await fetch(url + 'health')).json();
    assert.equal(health.name, pkgJson.name);
    assert.equal(health.version, pkgJson.version);
    assert.equal(health.slug, '0099-mini');
    assert.equal(typeof health.pid, 'number');

    // status reports what the skills used to read from GET /api/session
    const status = await run(['status', '--doc', DOC], root);
    assert.equal(status.code, 0);
    assert.equal(field(status.out, 'running'), 'true');
    assert.equal(field(status.out, 'url'), url);
    assert.equal(field(status.out, 'agent_present'), 'false');
    assert.equal(field(status.out, 'run_active'), 'none');

    // starting again reattaches instead of binding a second port
    const again = await run(['start', '--doc', DOC], root);
    assert.equal(again.code, 0);
    assert.match(again.out, new RegExp(`^SPECS_EDITOR_URL=${url}$`, 'm'));
    assert.match(again.out, /^reattached: /m);

    // nothing queued yet
    const idle = await run(['poll', '--wait', '2', '--doc', DOC], root);
    assert.equal(idle.code, 0);
    assert.equal(field(idle.out, 'event'), 'idle');
    assert.match(idle.out, /run `sw-specs-editor poll` again/);

    // a queued batch comes back from the next poll
    const body = JSON.stringify({ docs: { prd: { notes: [{ id: 'FR-1', text: 'tighten this' }] } }, chat: 'please look' });
    const queued = await run(['batch', '--kind', 'notes', '--doc', DOC, '-'], root, body);
    assert.equal(queued.code, 0);
    const id = field(queued.out, 'batch');
    assert.ok(id, `batch printed no id: ${queued.out}${queued.err}`);

    const got = await run(['poll', '--wait', '5', '--doc', DOC], root);
    assert.equal(got.code, 0);
    assert.equal(field(got.out, 'event'), 'batch');
    assert.equal(field(got.out, 'batch'), id);
    // The machine field is absolute, so an agent whose cwd is not the project
    // root still opens the right file; the *_rel twin is the display form.
    const batchFile = field(got.out, 'batch_file');
    assert.ok(path.isAbsolute(batchFile), `batch_file must be absolute, got ${batchFile}`);
    assert.ok(fs.existsSync(batchFile));
    assert.equal(path.resolve(root, field(got.out, 'batch_file_rel')), batchFile);
    assert.equal(field(got.out, 'root'), root);
    // next_step must precede the payload, so a truncated read still works
    assert.ok(got.out.indexOf('next_step:') < got.out.indexOf('"id"'), 'next_step must come before the payload');

    // emit reaches the chat log
    const emit = await run(['emit', 'progress', 'doing the thing', '--batch', id, '--doc', 'prd'], root);
    assert.equal(emit.code, 0);
    const chat = fs.readFileSync(path.join(root, SESSION, 'chat.jsonl'), 'utf8');
    assert.match(chat, /doing the thing/);

    const stop = await run(['stop', '--doc', DOC], root);
    assert.equal(stop.code, 0);
    assert.match(stop.out, /^stopped: /m);
    await sleep(300);
    assert.equal(fs.existsSync(path.join(root, SESSION, 'session.lock')), false);
  } finally {
    await teardown(root);
  }
});

test('start restarts a running server whose version differs, reattaches when it matches', async t => {
  if (!(await canBind())) return t.skip('cannot bind 127.0.0.1 in this environment');
  const root = hostRepo();
  const pkgPath = path.join(PKG, 'package.json');
  const original = fs.readFileSync(pkgPath, 'utf8');
  try {
    const start = await run(['start', '--doc', DOC], root);
    const url = (start.out.match(/^SPECS_EDITOR_URL=(.*)$/m) || [])[1];
    assert.ok(url, `start printed no URL: ${start.out}${start.err}`);
    const pid = field(start.out, 'pid');

    // Bump the on-disk version: a fresh CLI process now disagrees with the
    // already-running (stale, in-memory) server about what version it is.
    const pkgJson = JSON.parse(original);
    fs.writeFileSync(pkgPath, JSON.stringify({ ...pkgJson, version: '99.0.0' }, null, 2));

    const restarted = await run(['start', '--doc', DOC], root);
    assert.equal(restarted.code, 0, restarted.err);
    assert.doesNotMatch(restarted.out, /^reattached: /m, 'a version mismatch must not reattach');
    const newUrl = (restarted.out.match(/^SPECS_EDITOR_URL=(.*)$/m) || [])[1];
    assert.ok(newUrl, `restart printed no URL: ${restarted.out}${restarted.err}`);
    const newPid = field(restarted.out, 'pid');
    assert.notEqual(newPid, pid, 'the stale server must have been replaced, not reattached to');

    // The new server cached the bumped version at startup; a client that still
    // sees the same (still bumped) package.json reattaches to it.
    const again = await run(['start', '--doc', DOC], root);
    assert.match(again.out, /^reattached: /m);
    assert.match(again.out, new RegExp(`^SPECS_EDITOR_URL=${newUrl}$`, 'm'));
  } finally {
    fs.writeFileSync(pkgPath, original);
    await teardown(root);
  }
});

test('poll reports a closed session so the agent stops looping', async t => {
  if (!(await canBind())) return t.skip('cannot bind 127.0.0.1 in this environment');
  const root = hostRepo();
  try {
    await run(['start', '--doc', DOC], root);
    const polling = run(['poll', '--wait', '10', '--doc', DOC], root);
    await sleep(200);
    await run(['stop', '--doc', DOC], root);

    const r = await polling;
    assert.equal(r.code, 0);
    assert.equal(field(r.out, 'event'), 'closed');
    assert.match(r.out, /^next_step: the session is over/m);
  } finally {
    await teardown(root);
  }
});

test('a killed poll redelivers the same batch', async t => {
  if (!(await canBind())) return t.skip('cannot bind 127.0.0.1 in this environment');
  const root = hostRepo();
  try {
    await run(['start', '--doc', DOC], root);
    const body = JSON.stringify({ docs: { prd: { notes: [{ id: 'FR-1', text: 'a note' }] } } });
    const queued = await run(['batch', '--kind', 'notes', '--doc', DOC, '-'], root, body);
    const id = field(queued.out, 'batch');

    // Kill the poll while the batch is in flight: it was never delivered, so it
    // must go back to the front of the queue rather than being lost with the run
    // left locked behind it.
    const doomed = spawnCli(['poll', '--wait', '2', '--doc', DOC], root);
    await sleep(150);
    doomed.child.kill('SIGKILL');
    await doomed.done;

    const retry = await run(['poll', '--wait', '2', '--doc', DOC], root);
    assert.equal(field(retry.out, 'event'), 'batch');
    assert.equal(field(retry.out, 'batch'), id, 'the same batch comes back, not "idle"');
  } finally {
    await teardown(root);
  }
});

test('the batch queue survives a server restart', async t => {
  if (!(await canBind())) return t.skip('cannot bind 127.0.0.1 in this environment');
  const root = hostRepo();
  try {
    await run(['start', '--doc', DOC], root);
    const body = JSON.stringify({ docs: { prd: { notes: [{ id: 'FR-1', text: 'a note' }] } } });
    const id = field((await run(['batch', '--kind', 'notes', '--doc', DOC, '-'], root, body)).out, 'batch');

    await run(['stop', '--doc', DOC], root);
    await sleep(300);
    await run(['start', '--doc', DOC], root);

    const r = await run(['poll', '--wait', '2', '--doc', DOC], root);
    assert.equal(field(r.out, 'event'), 'batch');
    assert.equal(field(r.out, 'batch'), id, 'an undelivered batch outlives the server that took it');
  } finally {
    await teardown(root);
  }
});

test('poll --reply posts the reply and waits again in one call', async t => {
  if (!(await canBind())) return t.skip('cannot bind 127.0.0.1 in this environment');
  const root = hostRepo();
  try {
    await run(['start', '--doc', DOC], root);
    const first = JSON.stringify({ docs: { prd: { notes: [{ id: 'FR-1', text: 'one' }] } } });
    const id = field((await run(['batch', '--kind', 'notes', '--doc', DOC, '-'], root, first)).out, 'batch');
    await run(['poll', '--wait', '2', '--doc', DOC], root);

    // One command closes the finished batch and parks for the next one.
    const replying = run(['poll', '--wait', '2', '--reply', 'done with ' + id, '--doc', DOC], root);
    await sleep(300);
    const second = JSON.stringify({ docs: { spec: { notes: [{ id: 'AC-2', text: 'two' }] } } });
    await run(['batch', '--kind', 'notes', '--doc', DOC, '-'], root, second);

    const r = await replying;
    assert.equal(r.code, 0);
    assert.equal(field(r.out, 'event'), 'batch');
    assert.notEqual(field(r.out, 'batch'), id, 'the reply released the first run and the next batch arrived');
    assert.match(fs.readFileSync(path.join(root, SESSION, 'chat.jsonl'), 'utf8'), /done with b-1/);
  } finally {
    await teardown(root);
  }
});

test('the packed file list stays inside the files allow-list', async () => {
  const r = await exec('npm', ['pack', '--dry-run', '--json'], PKG);
  if (r.code !== 0) return; // npm unavailable; the release gate covers this too
  // Derived from the manifest, never restated here: a second copy of the
  // allow-list is a second thing to forget to update.
  const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
  const allowed = [...manifest.files, 'package.json'];
  const files = JSON.parse(r.out)[0].files.map(f => f.path);
  const outside = files.filter(f => !allowed.some(a => (a.endsWith('/') ? f.startsWith(a) : f === a)));
  assert.deepEqual(outside, [], `these would ship outside the allow-list: ${outside.join(', ')}`);
  assert.ok(files.includes('bin/cli.mjs') && files.includes('lib/server.mjs'), 'the entry point and the server must ship');
  // The skill ships with the CLI it describes - that is why the package owns it.
  assert.ok(files.includes('skills/sw-specs-editor/SKILL.md'), 'the stub skill must ship');
  assert.ok(!files.some(f => f.startsWith('test/')), 'tests must never ship');
});

test('every command works through the installed .bin symlink', async t => {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'specs-editor-pack-'));
  try {
    const packed = await exec('npm', ['pack', '--json', '--pack-destination', tmp], PKG);
    if (packed.code !== 0) return t.skip('npm unavailable; the release gate covers this');
    const tarball = path.join(tmp, JSON.parse(packed.out)[0].filename);

    const host = path.join(tmp, 'host');
    fs.mkdirSync(path.join(host, 'specs'), { recursive: true });
    fs.writeFileSync(path.join(host, 'package.json'), '{"name":"host","private":true}');
    const install = await exec('npm', ['install', tarball, '--no-audit', '--no-fund', '--ignore-scripts'], host);
    if (install.code !== 0) return t.skip(`npm install failed in this environment: ${install.err.slice(0, 200)}`);

    // This is the whole point: reached through the symlink, not by its real path.
    const bin = path.join(host, 'node_modules', '.bin', 'sw-specs-editor');
    assert.ok(fs.existsSync(bin), 'the package must expose its bin');

    // Paths resolve from the caller's cwd, not from the package directory it was
    // installed into - and the project root comes from the document.
    for (const f of ['0099-mini.md', '0099-mini-spec.md', '0099-mini.architecture.graph.json']) {
      fs.copyFileSync(path.join(PKG, 'test', 'fixtures', f), path.join(host, 'specs', f));
    }

    // Every command in the tree, with arguments that need no running server.
    // Each must produce output and its documented exit code: a command that
    // exits 0 in silence is indistinguishable from one that worked.
    const cases = [
      { args: ['guide'], code: 0, expect: /Specs Editor - session protocol/ },
      { args: ['status', '--doc', DOC], code: 0, expect: /^running: false$/m },
      // stopping an already-stopped session is not an error, it is a no-op.
      { args: ['stop', '--doc', DOC], code: 0, expect: /^next_step: nothing to stop$/m },
      { args: ['poll', '--doc', DOC], code: 1, expect: /no running Specs Editor/ },
      { args: ['emit', 'progress', 'x'], code: 1, expect: /no running Specs Editor/ },
      { args: ['batch', '--kind', 'bogus', '--doc', DOC], code: 2, expect: /unknown batch kind/ },
      { args: ['diagram'], code: 2, expect: /usage: sw-specs-editor diagram/ },
      { args: ['migrate', '--doc', 'specs/0099-mini-spec.md'], code: 0, expect: /^spec: converted 2 question\(s\)$/m },
      { args: ['install-skill', '--print'], code: 0, expect: /name: sw-specs-editor/ },
      { args: ['bogus'], code: 2, expect: /unknown command bogus/ },
    ];
    for (const c of cases) {
      const r = await exec(bin, c.args, host);
      const both = r.out + r.err;
      assert.equal(r.code, c.code, `${c.args[0]} exited ${r.code}: ${both}`);
      assert.ok(both.trim().length > 0, `${c.args[0]} printed nothing - it did not run`);
      assert.match(both, c.expect, `${c.args[0]} output: ${both}`);
    }
    // Derived from bin/cli.mjs's own COMMANDS table, so a newly added verb that
    // gets no case here fails the test instead of shipping untested.
    const cliSrc = fs.readFileSync(path.join(PKG, 'bin', 'cli.mjs'), 'utf8');
    // A key with a dash has to be quoted in an object literal, so accept both forms.
    const commandNames = [...cliSrc.matchAll(/^\s{2}'?(\w[\w-]*)'?:\s*\(\)\s*=>\s*import/gm)].map(m => m[1]);
    const covered = cases.filter(c => c.args[0] !== 'bogus').map(c => c.args[0]);
    assert.deepEqual(covered.sort(), commandNames.filter(n => n !== 'start').sort(), 'every command in bin/cli.mjs must have a case here, except start, which needs a server');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
