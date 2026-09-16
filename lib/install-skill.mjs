// `install-skill` - put this package's stub skill on a host's disk.
//
// The skill and the CLI it drives are versioned and released together, so the
// package is the single source for both. No plugin mechanism pulls a skill out
// of an npm tarball, so something has to copy it, and this is that something.
//
// It writes exactly one file and touches nothing else. It is NOT a "set up my
// agent" command: registering servers, writing permissions and asking the user
// for consent belong to the host's own setup skill, which calls this.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as out from './out.mjs';
import { canonical, resolveRoot, display } from './paths.mjs';

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE = path.join(PKG, 'skills', 'sw-specs-editor', 'SKILL.md');

const USAGE = 'usage: sw-specs-editor install-skill [--target <dir>] [--root <path>] [--print] [--force]';

// Where each harness keeps its skills. The host's setup skill normally passes
// --target outright; these are the fallbacks for a bare run.
const TARGETS = [
  ['.claude/skills', 'Claude Code'],
  ['.codex/skills', 'Codex'],
];

export function parseArgs(argv) {
  const o = { target: '', rootFlag: '', root: '', print: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') o.target = argv[++i];
    else if (a === '--root') o.rootFlag = argv[++i];
    else if (a === '--print') o.print = true;
    else if (a === '--force') o.force = true;
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
    out.usage(`the packaged skill is missing at ${SOURCE}\nnext_step: reinstall the package`);
    return;
  }

  // --print hands the content to a caller that would rather write it itself,
  // with its own diff and its own confirmation.
  if (opts.print) {
    out.line('source', SOURCE);
    out.nextStep('write this content to <skills dir>/sw-specs-editor/SKILL.md');
    out.payload(body);
    return;
  }

  const dir = opts.target
    ? canonical(opts.target, opts.root)
    : path.join(opts.root, (TARGETS.find(([rel]) => fs.existsSync(path.join(opts.root, rel))) || TARGETS[0])[0]);

  const dest = path.join(dir, 'sw-specs-editor', 'SKILL.md');
  const existing = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;

  if (existing === body) {
    out.line('skill', display(opts.root, dest));
    out.line('changed', 'false');
    out.nextStep('already up to date - nothing to do');
    return;
  }
  if (existing !== null && !opts.force) {
    // A host may have edited its copy. Overwriting that silently is the kind of
    // thing a package should never do to a file it does not own.
    out.line('skill', display(opts.root, dest));
    out.line('changed', 'false');
    out.nextStep(`a different copy is already installed\n  show the diff, then re-run with --force to replace it, or --print to read the packaged version`);
    return;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body);
  out.line('skill', display(opts.root, dest));
  out.line('changed', 'true');
  out.nextStep('reload the agent session so the new skill is picked up');
}
