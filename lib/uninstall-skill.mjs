// `uninstall-skill` - take this package's stub skill back off a host's disk.
//
// The mirror image of install-skill, and it exists for the same reason: the
// package owns the skill file end to end, so it has to be able to remove it
// again when a host drops the add-on.
//
// It removes exactly the one file install-skill would have written, plus the
// directory that held it once it is empty. It is NOT a "tear down my agent"
// command: unregistering servers and revoking permissions belong to the host's
// own setup skill, which calls this.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as out from './out.mjs';
import { canonical, resolveRoot, display } from './paths.mjs';

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE = path.join(PKG, 'skills', 'sw-specs-editor', 'SKILL.md');

const USAGE = 'usage: sw-specs-editor uninstall-skill [--target <dir>] [--root <path>]';

// The same fallbacks install-skill uses, so the two commands always land on the
// same file when neither is given a --target.
const TARGETS = [
  ['.claude/skills', 'Claude Code'],
  ['.codex/skills', 'Codex'],
];

export function parseArgs(argv) {
  const o = { target: '', rootFlag: '', root: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') o.target = argv[++i];
    else if (a === '--root') o.rootFlag = argv[++i];
    else out.usage(`unknown flag ${a}\n${USAGE}`);
  }
  o.root = resolveRoot({ rootFlag: o.rootFlag });
  return o;
}

export function main(argv) {
  const opts = parseArgs(argv);

  let body;
  try {
    body = fs.readFileSync(SOURCE, 'utf8');
  } catch {
    // Without the packaged copy there is nothing to compare against, and a
    // blind delete is exactly what this command must never do.
    out.usage(`the packaged skill is missing at ${SOURCE}\nnext_step: reinstall the package`);
    return;
  }

  const dir = opts.target
    ? canonical(opts.target, opts.root)
    : path.join(opts.root, (TARGETS.find(([rel]) => fs.existsSync(path.join(opts.root, rel))) || TARGETS[0])[0]);

  const dest = path.join(dir, 'sw-specs-editor', 'SKILL.md');
  const existing = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;

  if (existing === null) {
    out.line('skill', display(opts.root, dest));
    out.line('changed', 'false');
    out.nextStep('nothing to remove - no skill is installed there');
    return;
  }
  if (existing !== body) {
    // A host may have edited its copy. Deleting that silently is the kind of
    // thing a package should never do to a file it does not own.
    out.line('skill', display(opts.root, dest));
    out.line('changed', 'false');
    out.nextStep(`a different copy is installed - kept, nothing was removed\n  it differs from the packaged skill; delete ${display(opts.root, dest)} by hand if you no longer want it`);
    return;
  }

  fs.rmSync(dest);
  // Only the directory this command just emptied, and only when it is empty:
  // anything else in there belongs to somebody else.
  const skillDir = path.dirname(dest);
  if (fs.readdirSync(skillDir).length === 0) fs.rmdirSync(skillDir);

  out.line('skill', display(opts.root, dest));
  out.line('changed', 'true');
  out.nextStep('reload the agent session so the skill is dropped');
}
