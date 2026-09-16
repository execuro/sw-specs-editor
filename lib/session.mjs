// Finding the running session.
//
// The agent never passes `--session <url>`: a session is identified by the
// document it edits. `session.lock` inside `specs/.editor/<slug>/` is the only
// cross-process handshake, and a lock is only believed once the server behind
// it answers, so a stale lock from a killed server never resolves.

import fs from 'node:fs';
import path from 'node:path';

/** Read `session.lock` without deciding whether the server behind it is alive. */
export function readLock(sessionDir) {
  try { return JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.lock'), 'utf8')); } catch { return null; }
}

/** The lock, but only if the server it names actually answers. */
export async function liveLock(sessionDir) {
  const lock = readLock(sessionDir);
  if (!lock || !lock.url) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const res = await fetch(lock.url + 'api/lock', { signal: ctl.signal });
    clearTimeout(t);
    if (res.ok) return lock;
  } catch { /* not live */ }
  return null;
}

/** Every `specs/.editor/<slug>/` directory under `root`, whether live or not. */
export function sessionDirs(root) {
  const out = [];
  const editorRoot = path.join(root, 'specs', '.editor');
  let slugs;
  try { slugs = fs.readdirSync(editorRoot, { withFileTypes: true }); } catch { return out; }
  for (const d of slugs) {
    if (!d.isDirectory()) continue;
    out.push({ slug: d.name, sessionDir: path.join(editorRoot, d.name) });
  }
  return out;
}

/**
 * Resolve the session a command should talk to.
 *
 * With `docArg`, the session is the one belonging to that document. Without it,
 * the single live session under `root` is used; zero or several is an error the
 * caller reports, because guessing would talk to the wrong document.
 *
 * Returns `{ lock, sessionDir, slug }` or `{ error }`.
 */
export async function resolveSession(root, docArg, resolvePair) {
  if (docArg) {
    let pair;
    try { pair = resolvePair(root, docArg); } catch (e) { return { error: { kind: 'usage', message: e.message } }; }
    const lock = await liveLock(pair.sessionDir);
    if (!lock) {
      return { error: { kind: 'unreachable', message: `no running Specs Editor for ${docArg}\nnext_step: run \`sw-specs-editor start --doc ${docArg}\`` } };
    }
    return { lock, sessionDir: pair.sessionDir, slug: pair.slug, pair };
  }

  const found = [];
  for (const cand of sessionDirs(root)) {
    const lock = await liveLock(cand.sessionDir);
    if (lock) found.push({ ...cand, lock });
  }
  if (found.length === 1) return found[0];
  if (found.length === 0) {
    return { error: { kind: 'unreachable', message: 'no running Specs Editor session found\nnext_step: run `sw-specs-editor start --doc <path>`' } };
  }
  return {
    error: {
      kind: 'usage',
      message: `several sessions are running (${found.map(f => f.slug).join(', ')})\nnext_step: repeat the command with --doc <path>`,
    },
  };
}
