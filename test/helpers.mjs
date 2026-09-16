// Shared test plumbing. Not matched by the `test/*.test.mjs` glob, so `node --test`
// never runs this file as a suite.
//
// The server half solves three problems an http test always has: an in-process
// server on an ephemeral port, a stubbed `process.exit` (Session.shutdown calls
// it), and an SSE reader that can wait for one event without racing the ones
// that already arrived.

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PKG = path.join(HERE, '..');
export const CLI = path.join(PKG, 'bin', 'cli.mjs');
export const FIXTURES = path.join(HERE, 'fixtures');

/** Some sandboxes cannot bind loopback; skip rather than fail there. */
export function canBind() {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** Run the real CLI in `cwd`. `input` is written to stdin. */
export function run(args, cwd, input) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err }));
    if (input !== undefined) p.stdin.write(input);
    p.stdin.end();
  });
}

/**
 * Like `run`, but hands back the child so a test can kill it mid-flight.
 * `done` resolves with the same `{code, out, err}` shape.
 */
export function spawnCli(args, cwd, input) {
  const child = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const done = new Promise(resolve => child.on('close', code => resolve({ code, out, err })));
  if (input !== undefined) child.stdin.write(input);
  child.stdin.end();
  return { child, done };
}

/** Run an arbitrary command, resolving rather than throwing when it is unavailable. */
export function exec(cmd, args, cwd, opts = {}) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err }));
    p.on('error', e => resolve({ code: -1, out: '', err: String(e) }));
  });
}

/** The value of a `key: value` result line. */
export const field = (out, key) => (out.match(new RegExp(`^${key}: (.*)$`, 'm')) || [])[1];

/** A throwaway host repository carrying the fixtures under `specs/`. */
export function hostRepo(files = ['0099-mini.md', '0099-mini-spec.md', '0099-mini.architecture.graph.json']) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'specs-editor-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(FIXTURES, f), path.join(root, 'specs', f));
  return root;
}

/** JSON request helper: `{status, body}`, never throws on a non-JSON body. */
export const j = async (url, body, method) => {
  const r = await fetch(url, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

/**
 * SSE reader over `api/events`. `wait(pred)` consumes events that already
 * arrived before it was called, so a test never races the stream.
 */
export async function sseReader(url) {
  const res = await fetch(url + 'api/events');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  const waiters = [];
  let buf = '', cursor = 0;
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(chunk), data = /^data: (.*)$/m.exec(chunk);
        if (!ev) continue;
        const e = { event: ev[1], data: data ? JSON.parse(data[1]) : null };
        events.push(e);
        for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
      }
    }
  })().catch(() => {});
  return {
    events,
    wait(pred, ms = 3000) {
      for (; cursor < events.length; cursor++) if (pred(events[cursor])) return Promise.resolve(events[cursor++]);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve: e => { cursor = events.length; resolve(e); } };
        waiters.push(w);
        setTimeout(() => reject(new Error('sse timeout waiting for ' + pred.toString())), ms);
      });
    },
    close() { reader.cancel().catch(() => {}); },
  };
}

/** One teardown, in this order: a failed assertion must still stop the server and the watcher. */
export async function cleanup({ heartbeat, sse, session, realExit, root }) {
  if (heartbeat) clearInterval(heartbeat);
  try { sse?.close(); } catch { /* ignore */ }
  try { session?.shutdown('test end'); } catch { /* gone */ }
  await new Promise(r => setTimeout(r, 400));
  if (realExit) process.exit = realExit;
  try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Start an in-process server on the fixture PRD, with `process.exit` stubbed. */
export async function startFixtureServer(root, overrides = {}) {
  const { startServer } = await import('../lib/server.mjs');
  const realExit = process.exit;
  process.exit = () => {};
  const session = await startServer({
    cmd: 'start', docs: ['specs/0099-mini.md'], port: 0,
    grace: 60, agentTimeout: 120, foreground: true, json: false, root,
    ...overrides,
  });
  return { session, realExit, url: session.url };
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Tear down a host repo that may still have a detached server in it.
 *
 * `stop` returns as soon as the server acknowledges; the server itself then
 * spends a moment writing session.json and closing its socket. Deleting the
 * directory during that window lets the dying server recreate it, which leaves
 * a stray temp directory behind, so wait for the lock to disappear first.
 */
export async function teardown(root, doc = 'specs/0099-mini.md') {
  try { await run(['stop', '--doc', doc], root); } catch { /* already gone */ }
  const lock = path.join(root, 'specs', '.editor', '0099-mini', 'session.lock');
  for (let i = 0; i < 20 && fs.existsSync(lock); i++) await sleep(50);
  await sleep(250);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}
