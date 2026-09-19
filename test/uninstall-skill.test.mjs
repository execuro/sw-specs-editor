// `uninstall-skill` - the other end of install-skill.
//
// It deletes a file on a host's disk, which makes it the most dangerous verb
// this package has. These tests pin the blast radius: exactly the one file the
// package wrote, never a copy the host has edited, never anything else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run, field, PKG } from './helpers.mjs';

const PACKAGED = path.join(PKG, 'skills', 'sw-specs-editor', 'SKILL.md');

function host() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-uninstall-')));
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

test('uninstall-skill removes the file install-skill wrote, and prunes the directory it emptied', async () => {
  const root = host();
  try {
    await run(['install-skill', '--root', root], root);
    const dest = path.join(root, '.claude', 'skills', 'sw-specs-editor', 'SKILL.md');
    assert.ok(fs.existsSync(dest), 'precondition: the skill is installed');

    const r = await run(['uninstall-skill', '--root', root], root);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(field(r.out, 'changed'), 'true');
    assert.equal(field(r.out, 'skill'), '.claude/skills/sw-specs-editor/SKILL.md');
    assert.ok(!fs.existsSync(dest), 'the file must be gone');
    assert.ok(!fs.existsSync(path.dirname(dest)), 'the emptied skill directory must be pruned');
    // The skills directory itself is the host's, not ours.
    assert.ok(fs.existsSync(path.join(root, '.claude', 'skills')), 'the host skills directory must survive');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an absent skill is nothing to do, not an error', async () => {
  const root = host();
  try {
    const r = await run(['uninstall-skill', '--root', root], root);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(field(r.out, 'changed'), 'false');
    assert.match(r.out, /nothing to remove/);

    // Same answer after a real uninstall: the command is idempotent.
    await run(['install-skill', '--root', root], root);
    await run(['uninstall-skill', '--root', root], root);
    const again = await run(['uninstall-skill', '--root', root], root);
    assert.equal(again.code, 0);
    assert.equal(field(again.out, 'changed'), 'false');
    assert.match(again.out, /nothing to remove/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a copy the host has edited is kept, and the command says so', async () => {
  const root = host();
  const dest = path.join(root, '.claude', 'skills', 'sw-specs-editor', 'SKILL.md');
  try {
    await run(['install-skill', '--root', root], root);
    fs.appendFileSync(dest, '\nlocal house rule\n');
    const edited = fs.readFileSync(dest, 'utf8');

    const r = await run(['uninstall-skill', '--root', root], root);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(field(r.out, 'changed'), 'false');
    assert.equal(field(r.out, 'skill'), '.claude/skills/sw-specs-editor/SKILL.md');
    assert.match(r.out, /kept/);
    assert.equal(fs.readFileSync(dest, 'utf8'), edited, 'the edit must survive');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--target picks the directory, and a directory holding anything else is left standing', async () => {
  const root = host();
  try {
    const target = path.join(root, 'somewhere', 'skills');
    await run(['install-skill', '--root', root, '--target', target], root);
    const dest = path.join(target, 'sw-specs-editor', 'SKILL.md');
    assert.ok(fs.existsSync(dest));

    // A neighbouring skill, and a file of the host's own inside ours.
    const neighbour = path.join(target, 'someone-elses-skill');
    fs.mkdirSync(neighbour, { recursive: true });
    fs.writeFileSync(path.join(neighbour, 'SKILL.md'), 'not ours\n');
    fs.writeFileSync(path.join(target, 'sw-specs-editor', 'notes.md'), 'host notes\n');

    const r = await run(['uninstall-skill', '--root', root, '--target', target], root);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(field(r.out, 'changed'), 'true');
    assert.ok(!fs.existsSync(dest), 'our file must be gone');
    assert.ok(fs.existsSync(path.join(target, 'sw-specs-editor', 'notes.md')), 'a non-empty directory must never be removed');
    assert.ok(fs.existsSync(path.join(neighbour, 'SKILL.md')), 'a sibling skill must never be touched');

    // The default target is untouched by a --target run.
    assert.ok(!fs.existsSync(path.join(root, '.claude')), '--target must not reach the default location');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unknown flag is a usage error', async () => {
  const r = await run(['uninstall-skill', '--bogus'], os.tmpdir());
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown flag --bogus/);
});
