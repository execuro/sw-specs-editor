// `emit` - the only channel from the agent back to the Specs Editor page.
//
//   sw-specs-editor emit progress "<text>"   [--batch b-17] [--doc prd|spec] [--since <iso>]
//   sw-specs-editor emit chat "<markdown>"   [--batch b-17] [--doc prd|spec] [--since <iso>]
//   sw-specs-editor emit done "<markdown>"    --batch b-17  --doc prd        [--since <iso>]
//   sw-specs-editor emit reply ...            alias of done
//
// `done` is the final reply for one document and releases its lock; `chat` is
// interim and leaves the run active.
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

const USAGE = 'usage: sw-specs-editor emit progress|chat|done "<text>" [--batch <id>] [--doc prd|spec] [--since <iso>]';

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
  return settle(o, { docIsPath: false });
}

/** "+m:ss " prefix, or the text untouched when --since is absent or unparseable. */
export function withElapsed(text, since) {
  if (!since) return text;
  const started = Date.parse(since);
  if (Number.isNaN(started)) return text;
  const elapsed = Math.max(0, Math.floor((Date.now() - started) / 1000));
  return `+${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')} ${text}`;
}

export async function main(argv) {
  const opts = parseArgs(argv);
  const [cmd, ...textParts] = opts.rest;
  if (!cmd) out.usage(USAGE);

  const endpoint = ENDPOINTS[cmd];
  if (!endpoint) out.usage(`unknown emit command ${cmd}\n${USAGE}`);

  let text = textParts.join(' ');
  if (text === '-' || (!text && !process.stdin.isTTY)) text = readFileSync(0, 'utf8');
  text = withElapsed(text, opts.since);

  // The document the reply is for also identifies the session, so the agent
  // never has to carry a URL around. --doc prd|spec names a tab of a session,
  // not a path, so it cannot be used to find one.
  const found = await resolveSession(opts.root, '', null);
  if (found.error) {
    if (found.error.kind === 'usage') out.usage(found.error.message);
    out.unreachable(found.error.message);
  }
  const base = found.lock.url.replace(/\/+$/, '');

  try {
    const res = await fetch(`${base}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, markdown: text, batch: opts.batch || undefined, doc: opts.doc || undefined }),
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
