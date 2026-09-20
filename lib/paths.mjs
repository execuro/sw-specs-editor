// Where the project starts, and which form of a path goes to whom.
//
// Two separate problems live here.
//
// 1. THE ROOT. Session state belongs at `<project root>/specs/.editor/<slug>/`,
//    inside the repository the documents live in - never in the user's home and
//    never wherever the command happened to be run. The CLI and the agent that
//    drives it are separate processes with no guarantee their working
//    directories match, so the root cannot be inferred from `process.cwd()`
//    without occasionally being wrong. It is derived from the document instead:
//    a document names its own repository by sitting inside it.
//
//      --root <path>  >  nearest ancestor of the document holding .git  >  cwd
//
//    The walk-up is deterministic: every cwd inside the repository resolves to
//    the same root, and the session directory hangs off the document's own
//    directory, so no root has to be remembered between commands.
//
// 2. WHICH FORM. Paths the agent acts on are absolute and canonical, so they
//    resolve from any working directory. Paths a human or a diff reads are
//    project-relative, so transcripts and fixtures stay portable. Both forms
//    are emitted; neither is inferred from the other by the reader.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Absolute, symlink-resolved path, for a file that need not exist yet.
 *
 * `fs.realpathSync` throws on a missing path, but `--doc` legitimately names a
 * spec that has not been written (the page offers "Create tech spec"). So the
 * nearest existing ancestor is canonicalised and the missing tail re-appended:
 * the answer is stable whether or not the file exists, which is what makes it
 * usable as a session identity.
 */
export function canonical(p, cwd = process.cwd()) {
  const abs = path.resolve(cwd, p);
  let head = abs;
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return abs;   // reached the filesystem root, nothing to resolve
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/**
 * Nearest ancestor of `from` containing `.git`, or null.
 *
 * `.git` counts as a directory (an ordinary clone) or a file (a worktree or a
 * submodule, where it holds a gitdir pointer).
 */
export function findGitRoot(from) {
  let dir = fs.existsSync(from) && fs.statSync(from).isDirectory() ? from : path.dirname(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The project root for this command.
 *
 * `docAbs` is a canonical document path when the command took one. Without a
 * document there is nothing to anchor to, so the walk starts at the working
 * directory - the only other thing the caller has told us about.
 */
export function resolveRoot({ rootFlag = '', docAbs = '', cwd = process.cwd() } = {}) {
  if (rootFlag) return canonical(rootFlag, cwd);
  return findGitRoot(docAbs || cwd) || canonical(cwd, cwd);
}

/** Project-relative, forward slashes, for display and logs. Absolute if outside the root. */
export function display(root, abs) {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return abs;
  return rel.split(path.sep).join('/');
}

/** Absolute form of a project-relative path. The inverse of `display`. */
export function absolute(root, rel) {
  return path.resolve(root, rel);
}

/**
 * Guard against a document that does not belong to the root in play.
 *
 * Returns an error message, or null when the pair is coherent. Reported as a
 * usage error rather than silently opening a second session somewhere else.
 */
export function outsideRoot(root, docAbs) {
  const rel = path.relative(root, docAbs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return `${docAbs} is not inside the project root ${root}\nnext_step: run the command from the project, or pass --root <path>`;
  }
  return null;
}

/**
 * Finish a parsed option object: canonicalise its document(s), then derive the
 * root from them. Order matters - the root comes from the document, so the
 * document has to be resolved against the caller's cwd first, not against a
 * root that does not exist yet.
 *
 * Handles `doc` (one path) and `docs` (the server's list).
 */
export function settle(o, { cwd = process.cwd() } = {}) {
  if (Array.isArray(o.docs)) o.docs = o.docs.map(d => canonical(d, cwd));
  // `--doc` is a document path in every command. It used to name a side of the
  // PRD/spec pair on `emit`; a session now edits one document, so the path both
  // identifies the session and says which file, exactly as it does for `poll`.
  if (typeof o.doc === 'string' && o.doc) o.doc = canonical(o.doc, cwd);
  const anchor = (Array.isArray(o.docs) && o.docs[0]) || o.doc || '';
  o.root = resolveRoot({ rootFlag: o.rootFlag || '', docAbs: anchor, cwd });
  return o;
}
