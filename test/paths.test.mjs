// Path resolution: where the project root comes from, and which form of a path
// goes to the agent versus to a human.
//
// The bug this suite exists to catch is invisible when everything runs from one
// directory, which is why it survived: the CLI and the agent driving it are
// separate processes, and nothing guarantees their working directories match.
// Before the root was derived from the document, a command issued from a
// subdirectory looked for `specs/.editor/` under *that* directory, found
// nothing, and opened a second session - or the agent resolved a printed
// relative path against its own cwd and edited a file the page was not showing.
//
// So every integration test below deliberately runs the CLI from somewhere
// other than the project root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonical, findGitRoot, resolveRoot, display, outsideRoot, settle } from '../lib/paths.mjs';
import { canBind, run, field, hostRepo, teardown, sleep } from './helpers.mjs';

const DOC = 'specs/0099-mini.md';

/** A host repo that looks like a real checkout, so the walk-up has something to find. */
function gitHostRepo() {
  const root = hostRepo();
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const deep = path.join(root, 'custom', 'plugins', 'SwagExample', 'src');
  fs.mkdirSync(deep, { recursive: true });
  return { root: fs.realpathSync(root), deep: fs.realpathSync(deep) };
}

// --- unit

test('canonical resolves a path that does not exist yet', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-canon-')));
  try {
    // The spec half of a pair legitimately has no file until the user creates
    // it, and it still has to produce a stable session identity.
    const missing = canonical('specs/0099-mini-spec.md', root);
    assert.equal(missing, path.join(root, 'specs', '0099-mini-spec.md'));
    assert.equal(canonical('specs/0099-mini-spec.md', root), missing, 'must be stable across calls');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonical resolves symlinks, so two spellings of one file are one session', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-link-')));
  try {
    fs.mkdirSync(path.join(root, 'specs'));
    fs.writeFileSync(path.join(root, 'specs', 'real.md'), '# x\n');
    fs.symlinkSync(path.join(root, 'specs', 'real.md'), path.join(root, 'link.md'));
    assert.equal(canonical('link.md', root), canonical('specs/real.md', root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findGitRoot accepts .git as a directory and as a worktree file', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-git-')));
  try {
    const clone = path.join(base, 'clone');
    fs.mkdirSync(path.join(clone, 'specs'), { recursive: true });
    fs.mkdirSync(path.join(clone, '.git'));
    assert.equal(findGitRoot(path.join(clone, 'specs', 'x.md')), clone);

    // A worktree or submodule has .git as a FILE holding a gitdir pointer.
    const wt = path.join(base, 'worktree');
    fs.mkdirSync(path.join(wt, 'specs'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
    assert.equal(findGitRoot(path.join(wt, 'specs', 'x.md')), wt);

    assert.equal(findGitRoot(path.join(base, 'nowhere', 'x.md')), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('resolveRoot prefers --root, then the document, then cwd', () => {
  const { root, deep } = gitHostRepo();
  try {
    const doc = path.join(root, 'specs', '0099-mini.md');
    assert.equal(resolveRoot({ docAbs: doc, cwd: deep }), root, 'the document names its own repository');
    assert.equal(resolveRoot({ rootFlag: deep, docAbs: doc, cwd: root }), deep, '--root wins outright');
    assert.equal(resolveRoot({ cwd: deep }), root, 'with no document, walk up from cwd');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('display is project-relative, and stays absolute for anything outside the root', () => {
  assert.equal(display('/a/b', '/a/b/specs/x.md'), 'specs/x.md');
  assert.equal(display('/a/b', '/elsewhere/x.md'), '/elsewhere/x.md');
});

test('outsideRoot refuses a document from another tree rather than opening a second session', () => {
  assert.equal(outsideRoot('/a/b', '/a/b/specs/x.md'), null);
  assert.match(outsideRoot('/a/b', '/other/specs/x.md'), /not inside the project root/);
});

test('settle leaves `emit --doc` alone, because there it names a side, not a file', () => {
  const emitish = settle({ doc: 'spec', rootFlag: '' }, { docIsPath: false });
  assert.equal(emitish.doc, 'spec', 'prd|spec must never be turned into a path');

  const { root } = gitHostRepo();
  try {
    const pathish = settle({ doc: 'specs/0099-mini.md', rootFlag: '' }, { cwd: root });
    assert.equal(pathish.doc, path.join(root, 'specs', '0099-mini.md'));
    assert.equal(pathish.root, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- integration: the CLI run from a directory that is NOT the project root

test('a command run from a subdirectory reaches the session started at the root', async t => {
  if (!(await canBind())) return t.skip('loopback cannot be bound in this sandbox');
  const { root, deep } = gitHostRepo();
  try {
    const started = await run(['start', '--doc', DOC], root);
    assert.equal(started.code, 0, started.out + started.err);

    // The agent is several directories deep - where a Shopware plugin lives -
    // and names the document by its absolute path, the only spelling that
    // means the same thing from both processes.
    const abs = path.join(root, DOC);
    const fromDeep = await run(['status', '--doc', abs], deep);
    assert.equal(fromDeep.code, 0, fromDeep.out + fromDeep.err);
    assert.equal(field(fromDeep.out, 'running'), 'true', 'must find the session started at the root');

    // And with no document at all. `emit` finds the one live session by
    // scanning `<root>/specs/.editor/`, so the root it derived from the
    // subdirectory has to be the repository - not the subdirectory itself,
    // which is what it used to be and where nothing would ever be found.
    const noDoc = await run(['emit', 'progress', 'working'], deep);
    assert.equal(noDoc.code, 0, noDoc.out + noDoc.err);

    // The session directory is the one at the root, not a second one created
    // under the subdirectory.
    assert.ok(fs.existsSync(path.join(root, 'specs', '.editor', '0099-mini')));
    assert.ok(!fs.existsSync(path.join(deep, 'specs')), 'no second session under the subdirectory');
  } finally {
    await teardown(root);
  }
});

test('a batch polled from a subdirectory carries paths that open from there', async t => {
  if (!(await canBind())) return t.skip('loopback cannot be bound in this sandbox');
  const { root, deep } = gitHostRepo();
  try {
    const started = await run(['start', '--doc', DOC], root);
    assert.equal(started.code, 0, started.out + started.err);
    await sleep(200);

    const body = JSON.stringify({ docs: { prd: { notes: [{ kind: 'free', file: DOC, text: 'tighten FR-1' }] } } });
    const queued = await run(['batch', '--kind', 'notes', '--doc', path.join(root, DOC), '-'], deep, body);
    assert.equal(queued.code, 0, queued.out + queued.err);

    const got = await run(['poll', '--wait', '5', '--doc', path.join(root, DOC)], deep);
    assert.equal(got.code, 0, got.out + got.err);
    assert.equal(field(got.out, 'event'), 'batch');

    // The whole point: every path the agent is handed opens from the agent's
    // own cwd, without it knowing where the CLI ran.
    const batchFile = field(got.out, 'batch_file');
    assert.ok(path.isAbsolute(batchFile), `batch_file must be absolute, got ${batchFile}`);
    assert.ok(fs.existsSync(path.resolve(deep, batchFile)), 'the batch file must open from the subdirectory');

    const batch = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
    assert.equal(batch.root, root);
    assert.ok(path.isAbsolute(batch.context), 'context (chat.jsonl) must be absolute');
    assert.ok(path.isAbsolute(batch.docs.prd.path), 'the document path must be absolute');
    assert.ok(fs.existsSync(batch.docs.prd.path));
    assert.ok(path.isAbsolute(batch.docs.prd.notes[0].file), 'a note locator must be absolute');

    // ... and the display twins stay project-relative, so logs and fixtures
    // do not carry this machine's directory layout.
    assert.equal(batch.fileRel, path.relative(root, batchFile));
    assert.equal(batch.docs.prd.pathRel, DOC);
    assert.equal(batch.docs.prd.notes[0].fileRel, DOC);
    assert.equal(field(got.out, 'batch_file_rel'), batch.fileRel);

    // The chat log is a human artefact: it keeps the relative form.
    const chat = fs.readFileSync(path.join(root, 'specs', '.editor', '0099-mini', 'chat.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    const logged = chat.find(e => e.type === 'batch');
    assert.equal(logged.docs.prd.notes[0].file, DOC, 'the chat log must not carry absolute paths');
  } finally {
    await teardown(root);
  }
});

test('start refuses a document from another tree instead of opening a session for it', async t => {
  if (!(await canBind())) return t.skip('loopback cannot be bound in this sandbox');
  const { root } = gitHostRepo();
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-other-')));
  try {
    fs.mkdirSync(path.join(other, 'specs'));
    fs.copyFileSync(path.join(root, DOC), path.join(other, DOC));
    const r = await run(['start', '--doc', path.join(other, DOC), '--root', root], root);
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.err, /not inside the project root/);
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
    await teardown(root);
  }
});
