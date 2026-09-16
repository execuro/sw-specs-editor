// `install-skill` - the one command that writes outside the session folder.
//
// It exists because no plugin mechanism pulls a skill out of an npm tarball, so
// the package has to hand its own skill over. That makes it the only place this
// package can damage a file it does not own, which is what these tests guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run, field, PKG } from './helpers.mjs';

const PACKAGED = path.join(PKG, 'skills', 'sw-specs-editor', 'SKILL.md');

function host() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-install-')));
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

test('the packaged skill exists and is a stub, not a second copy of the protocol', () => {
  const body = fs.readFileSync(PACKAGED, 'utf8');
  assert.match(body, /^---\nname: sw-specs-editor\n/, 'must carry skill frontmatter');
  assert.match(body, /guide/, 'must send the agent to the CLI for the protocol');
  // The session protocol lives in `guide` alone. A stub that restates the steps
  // is exactly the drift that publishing the skill with the CLI is meant to end.
  for (const restated of [/^###? *\d\.? *(START|Start)/m, /--wait 90/, /emit done --batch/]) {
    assert.doesNotMatch(body, restated, `the stub must not restate the protocol: ${restated}`);
  }
});

test('install-skill writes the packaged skill, and says so in project-relative terms', async () => {
  const root = host();
  try {
    const r = await run(['install-skill', '--root', root], root);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(field(r.out, 'changed'), 'true');
    assert.equal(field(r.out, 'skill'), '.claude/skills/sw-specs-editor/SKILL.md');
    const dest = path.join(root, '.claude', 'skills', 'sw-specs-editor', 'SKILL.md');
    assert.equal(fs.readFileSync(dest, 'utf8'), fs.readFileSync(PACKAGED, 'utf8'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a second run changes nothing', async () => {
  const root = host();
  try {
    await run(['install-skill', '--root', root], root);
    const again = await run(['install-skill', '--root', root], root);
    assert.equal(again.code, 0);
    assert.equal(field(again.out, 'changed'), 'false');
    assert.match(again.out, /already up to date/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a copy the host has edited is never overwritten without --force', async () => {
  const root = host();
  const dest = path.join(root, '.claude', 'skills', 'sw-specs-editor', 'SKILL.md');
  try {
    await run(['install-skill', '--root', root], root);
    fs.appendFileSync(dest, '\nlocal house rule\n');
    const edited = fs.readFileSync(dest, 'utf8');

    const refused = await run(['install-skill', '--root', root], root);
    assert.equal(refused.code, 0);
    assert.equal(field(refused.out, 'changed'), 'false');
    assert.match(refused.out, /already installed/);
    assert.equal(fs.readFileSync(dest, 'utf8'), edited, 'the edit must survive');

    const forced = await run(['install-skill', '--root', root, '--force'], root);
    assert.equal(field(forced.out, 'changed'), 'true');
    assert.equal(fs.readFileSync(dest, 'utf8'), fs.readFileSync(PACKAGED, 'utf8'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--target picks the directory, and --print writes nothing at all', async () => {
  const root = host();
  try {
    const target = path.join(root, 'somewhere', 'skills');
    const r = await run(['install-skill', '--root', root, '--target', target], root);
    assert.equal(r.code, 0, r.out + r.err);
    assert.ok(fs.existsSync(path.join(target, 'sw-specs-editor', 'SKILL.md')));

    const printed = await run(['install-skill', '--root', root, '--print'], root);
    assert.equal(printed.code, 0);
    assert.match(printed.out, /name: sw-specs-editor/);
    assert.ok(!fs.existsSync(path.join(root, '.claude')), '--print must not write');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unknown flag is a usage error', async () => {
  const r = await run(['install-skill', '--bogus'], os.tmpdir());
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown flag --bogus/);
});
