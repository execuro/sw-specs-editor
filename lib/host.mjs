// The agent's heartbeat source: the process chain a CLI call runs under.
//
// The server cannot tell a busy agent from a dead one by how long it has been quiet:
// a design run can think for minutes without a word, and a session killed from the
// console is silent the same way. What does tell them apart is whether the agent's
// own process still exists. Every `poll` therefore sends this process's ancestor
// chain (`x-agent-chain`, nearest first, starting with this process); the server takes
// the nearest ancestor its recent polls all have in common as the agent's host process
// and checks it is alive on every tick. Shells, `npx` and this CLI change from poll to
// poll, the host (Claude Code, Codex, ...) does not.
//
// Best effort: no `ps` (Windows, a locked-down sandbox) means no chain, and the
// server falls back to judging presence by polls alone.

import { execFileSync } from 'node:child_process';

export const CHAIN_HEADER = 'x-agent-chain';
const MAX_DEPTH = 30;

let cached = null;

/** This process followed by its ancestors, nearest first. `[]` when they cannot be read. */
export function ancestry() {
  if (cached) return cached;
  cached = [];
  if (process.platform === 'win32') return cached;
  let table;
  try {
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return cached; }
  const parent = new Map();
  for (const line of table.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) parent.set(Number(m[1]), Number(m[2]));
  }
  const chain = [process.pid];
  let p = process.ppid;
  while (p > 1 && chain.length < MAX_DEPTH && !chain.includes(p)) {
    chain.push(p);
    if (!parent.has(p)) break;
    p = parent.get(p);
  }
  cached = chain;
  return cached;
}

/** Headers for a request to the server: the chain, when there is one. */
export function chainHeaders(extra = {}) {
  const chain = ancestry();
  return chain.length > 1 ? { ...extra, [CHAIN_HEADER]: chain.join(',') } : { ...extra };
}

/** Parses the header back into pids; anything malformed becomes `[]`. */
export function parseChain(value) {
  if (typeof value !== 'string' || !value) return [];
  const pids = value.split(',').map(Number);
  return pids.every(n => Number.isInteger(n) && n > 1) ? pids.slice(0, MAX_DEPTH) : [];
}

/**
 * The agent's host process: the nearest ancestor shared by every chain in `chains`
 * (newest last), which must come from at least two different invocations. `null`
 * otherwise. The legs of one `poll` share every pid, their own shell included, so a
 * single invocation never names a host; and two invocations started by one shell
 * command share that shell, which is why the server only feeds `poll` calls here,
 * each a command of its own, and intersects several of them, not just two.
 */
export function commonHost(chains) {
  const distinct = new Set((chains || []).map(c => c[0]));
  if (distinct.size < 2) return null;
  const newest = chains[chains.length - 1];
  for (const pid of newest.slice(1)) if (chains.every(c => c.includes(pid))) return pid;
  return null;
}

/** True while `pid` exists. EPERM means it exists but belongs to someone else. */
export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
