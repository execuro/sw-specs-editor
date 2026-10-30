// `overview` - every feature under specs/ with its three phases and the next command.
//
// Read-only. Which phase a feature is in, and what to run next, is decided by
// phases() and nowhere else; this file only finds the documents, reads them and
// lays the answer out. An unreadable document marks its row and never fails the run.

import fs from 'node:fs';
import path from 'node:path';
import * as out from './out.mjs';
import { settle, display } from './paths.mjs';
import { parse, slugFromPath } from './parse.mjs';
import { phases } from './phases.mjs';

const USAGE = 'usage: sw-specs-editor overview [--json] [--root <path>]';
const FEATURE_FILE = /^\d{4}-.+\.md$/;

function parseArgs(argv) {
  const o = { json: false, rootFlag: '', root: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--root') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) out.usage(`--root needs a path\n${USAGE}`);
      o.rootFlag = argv[++i];
    } else if (a.startsWith('--')) out.usage(`unknown flag ${a}\n${USAGE}`);
    else out.usage(`unexpected argument ${a}\n${USAGE}`);
  }
  return settle(o);
}

/** Feature documents in specs/, sorted by file name; ADRs and verification reports are not features. */
function featureFiles(specsDir) {
  let names;
  try { names = fs.readdirSync(specsDir); } catch { return []; }
  return names
    .filter(n => FEATURE_FILE.test(n) && !/-verification\.md$/i.test(n) && !n.includes('-adr-'))
    .sort();
}

/** 'missing' when the file is absent, 'unreadable' when it cannot be read or parsed, else the model. */
function load(root, abs, rel, doc) {
  if (!fs.existsSync(abs)) return { state: 'missing' };
  try {
    return { state: 'ok', model: parse(fs.readFileSync(abs, 'utf8'), { path: rel, doc }) };
  } catch {
    return { state: 'unreadable' };
  }
}

export function collectFeatures(root) {
  const specsDir = path.join(root, 'specs');
  const slugs = [...new Set(featureFiles(specsDir).map(n => slugFromPath(n)))];
  return slugs.map(slug => {
    const prdAbs = path.join(specsDir, `${slug}.md`);
    const specAbs = path.join(specsDir, `${slug}-spec.md`);
    const prdRel = display(root, prdAbs);
    const specRel = display(root, specAbs);
    const prd = load(root, prdAbs, prdRel, 'prd');
    const spec = load(root, specAbs, specRel, 'spec');
    const row = { feature: slug.replace('-', ' '), slug, prd: prdRel, spec: specRel, unreadable: false, phases: null, current: null, next: null };
    if (prd.state === 'unreadable' || spec.state === 'unreadable') { row.unreadable = true; return row; }
    const verified = fs.existsSync(path.join(specsDir, `${slug}-verification.md`));
    const result = phases({ prdModel: prd.model || null, specModel: spec.model || null, verified });
    row.phases = result.phases;
    row.current = result.current;
    row.next = result.next;
    row.hasPrd = prd.state === 'ok';
    row.hasSpec = spec.state === 'ok';
    return row;
  });
}

const BAR = 10;
function bar(percent) {
  const n = Math.max(0, Math.min(BAR, Math.floor(percent / 10)));
  return `[${'#'.repeat(n)}${'-'.repeat(BAR - n)}] ${percent}%`;
}

function cell(row, p) {
  if (p.n === 3) return p.state === 'next' ? 'next' : p.state === 'started' ? 'started' : 'n/a';
  const exists = p.n === 1 ? row.hasPrd : row.hasSpec;
  if (!exists || p.state === 'todo' || p.percent === null) return 'n/a';
  return bar(p.percent);
}

function table(rows) {
  const head = ['feature', 'phase 1 requirements', 'phase 2 solution', 'phase 3 implement', 'next command'];
  const body = rows.map(r => r.unreadable
    ? [r.feature, 'unreadable', 'unreadable', 'unreadable', '-']
    : [r.feature, ...r.phases.map(p => cell(r, p)), r.next || '-']);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map(b => b[i].length)));
  const fmt = cols => cols.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(head), fmt(widths.map(w => '-'.repeat(w))), ...body.map(fmt)].join('\n');
}

export async function main(argv) {
  const opts = parseArgs(argv);
  const rows = collectFeatures(opts.root);
  const first = rows.find(r => r.next);

  out.line('features', rows.length);
  if (first) out.nextStep(`run ${first.next}`);
  else out.nextStep(rows.length ? 'nothing is pending' : 'no feature documents in specs/, nothing is pending');

  if (opts.json) {
    out.payload({
      features: rows.map(r => ({
        feature: r.feature,
        prd: r.prd,
        spec: r.spec,
        unreadable: r.unreadable,
        current: r.current,
        phases: r.phases,
        next: r.next,
      })),
    });
  } else if (rows.length) {
    out.payload(table(rows));
  }
  process.exitCode = out.EXIT_OK;
}
