// `batch` - queue a batch as if the page had sent one.
//
//   sw-specs-editor batch --kind notes [--doc <path>] -   (body JSON on stdin)
//
// The page is the normal source of batches here; this exists so a skill can
// queue one without a raw `curl`. The body is a set of notes for the session's
// one document, read from stdin. `--kind` has a single legal value: it used to
// also take `spec`, which set `createSpec` - that flow is gone, and the tech spec
// is now its own session, started on the spec path.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { settle } from './paths.mjs';
import { resolveSession } from './session.mjs';
import * as out from './out.mjs';

const USAGE = 'usage: sw-specs-editor batch --kind notes [--doc <path>] -   (JSON body on stdin)';

export function parseArgs(argv) {
  const o = { kind: '', doc: '', rootFlag: '', root: '', stdin: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kind') o.kind = argv[++i];
    else if (a === '--doc') o.doc = argv[++i];
    else if (a === '--root') o.rootFlag = argv[++i];
    else if (a === '-') o.stdin = true;
    else out.usage(`unknown flag ${a}\n${USAGE}`);
  }
  return settle(o);
}

export async function main(argv, { resolveDoc } = {}) {
  const opts = parseArgs(argv);
  if (opts.kind === 'spec') out.usage(`batch kind \`spec\` is gone; the tech spec is its own session\nnext_step: run \`sw-specs-editor start --doc <...-spec.md>\``);
  if (opts.kind !== 'notes') out.usage(`${opts.kind ? `unknown batch kind ${opts.kind}` : 'missing --kind'}\n${USAGE}`);

  let body;
  if (opts.stdin || !process.stdin.isTTY) {
    const raw = readFileSync(0, 'utf8').trim();
    if (!raw) out.usage(USAGE);
    try { body = JSON.parse(raw); } catch (e) { out.usage(`batch: body is not valid JSON (${e.message})`); }
  } else {
    out.usage(USAGE);
  }
  const found = await resolveSession(opts.root, opts.doc, resolveDoc);
  if (found.error) {
    if (found.error.kind === 'usage') out.usage(found.error.message);
    out.unreachable(found.error.message);
  }
  const base = found.lock.url.replace(/\/+$/, '');

  try {
    const res = await fetch(`${base}/api/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const json = JSON.parse(text || '{}');
    if (!res.ok) {
      // The server's refusal is the useful part; keep its reasons intact.
      out.line('refused', String(res.status));
      out.line('reason', json.error || text);
      process.exit(out.EXIT_USAGE);
    }
    out.line('batch', json.id || '');
    if (json.file) out.line('batch_file', json.file);
    out.line('queued', String(Boolean(json.queued)));
    out.nextStep('run `sw-specs-editor poll` to pick it up');
  } catch (e) {
    out.unreachable(`batch: ${e.message} (is the Specs Editor running at ${base}?)`);
  }
}
