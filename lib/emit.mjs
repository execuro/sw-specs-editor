// `emit` - the only channel from the agent back to the Specs Editor page.
//
//   sw-specs-editor emit progress "<text>"   [--batch b-17] [--doc <path>] [--since <iso>]
//   sw-specs-editor emit chat "<markdown>"   [--batch b-17] [--doc <path>] [--since <iso>]
//   sw-specs-editor emit done "<markdown>"    --batch b-17  --doc <path>   [--since <iso>]
//   sw-specs-editor emit reply ...            alias of done
//
// `done` is the run's final reply and releases the document's lock; `chat` is
// interim and leaves the run active. `--doc` is the document path - it names the
// session, and a feature's PRD and spec are two of them.
//
// --since <ISO-8601> prefixes the text with "+m:ss" (elapsed since that
// instant). An unparseable or missing --since is ignored rather than an error,
// because a missing timestamp must never cost the agent its message.
//
// The text may be piped on stdin, with "-" as the text argument.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { settle } from './paths.mjs';
import { resolveSession } from './session.mjs';
import * as out from './out.mjs';

const ENDPOINTS = {
  progress: '/api/agent/progress',
  chat: '/api/agent/chat',
  done: '/api/agent/reply',
  reply: '/api/agent/reply',
};

const USAGE = 'usage: sw-specs-editor emit progress|chat|done "<text>" [--batch <id>] [--doc <document path>] [--since <iso>]';

export function parseArgs(argv) {
  const o = { batch: '', doc: '', since: '', rootFlag: '', root: '', rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--batch') o.batch = argv[++i];
    else if (a === '--doc') o.doc = argv[++i];
    else if (a === '--since') o.since = argv[++i];
    else if (a === '--root') o.rootFlag = argv[++i];
    else if (a === '--') { o.rest.push(...argv.slice(i + 1)); break; }   // end of options: the rest is message text
    else if (a.startsWith('--')) out.usage(`unknown flag ${a}\n${USAGE}\n(a message that starts with -- goes after a bare --, or on stdin with -)`);
    else o.rest.push(a);
  }
  // A skill pinned to an older CLI still passes the pair-side literal. It names
  // nothing on disk, so drop it rather than canonicalise it into a bogus path.
  if (o.doc === 'prd' || o.doc === 'spec') { o.legacyDoc = o.doc; o.doc = ''; }
  return settle(o);
}

/** "+m:ss " prefix, or the text untouched when --since is absent or unparseable. */
export function withElapsed(text, since) {
  if (!since) return text;
  const started = Date.parse(since);
  if (Number.isNaN(started)) return text;
  const elapsed = Math.max(0, Math.floor((Date.now() - started) / 1000));
  return `+${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')} ${text}`;
}

export async function main(argv, { resolveDoc } = {}) {
  const opts = parseArgs(argv);
  if (opts.legacyDoc) out.note(`--doc ${opts.legacyDoc} is legacy; pass the document path`);
  const [cmd, ...textParts] = opts.rest;
  if (!cmd) out.usage(USAGE);

  const endpoint = ENDPOINTS[cmd];
  if (!endpoint) out.usage(`unknown emit command ${cmd}\n${USAGE}`);

  let text = textParts.join(' ');
  if (text === '-' || (!text && !process.stdin.isTTY)) text = readFileSync(0, 'utf8');
  text = withElapsed(text, opts.since);

  // With no --doc the single live session is used, which is ambiguous the moment
  // a PRD and its spec are both open - hence the flag.
  const found = await resolveSession(opts.root, opts.doc, resolveDoc);
  if (found.error) {
    if (found.error.kind === 'usage') out.usage(found.error.message);
    out.unreachable(found.error.message);
  }
  const base = found.lock.url.replace(/\/+$/, '');

  try {
    const res = await fetch(`${base}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, markdown: text, batch: opts.batch || undefined }),
    });
    const body = await res.text();
    if (!res.ok) out.unreachable(`emit ${cmd}: HTTP ${res.status} ${body}`);
    out.line('emitted', cmd);
    if (cmd === 'done' || cmd === 'reply') out.nextStep('run `sw-specs-editor poll` to wait for the next batch');
    else out.nextStep('continue the work, then `sw-specs-editor emit done` when the batch is finished');
    if (body.trim() && body.trim() !== '{"ok":true}') out.payload(body.trim());
  } catch (e) {
    out.unreachable(`emit ${cmd}: ${e.message} (is the Specs Editor running at ${base}?)`);
  }
}
