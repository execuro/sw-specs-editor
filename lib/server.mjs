// Specs Editor server - zero-dependency Node http server.
//
//   sw-specs-editor start   --doc specs/NNNN-slug.md [--port N] [--grace 60] [--agent-timeout 120] [--foreground]
//   sw-specs-editor status  --doc specs/NNNN-slug.md [--json]
//   sw-specs-editor stop    --doc specs/NNNN-slug.md
//   sw-specs-editor migrate --doc specs/NNNN-slug.md   converts a legacy question table to blocks, no server
//
// `start` prints `SPECS_EDITOR_URL=<url>` and returns; the server itself runs
// detached (unless --foreground) and exits on heartbeat timeout or POST /api/close.
//
// Entry point is bin/cli.mjs. This module exports main(argv) and never reads
// process.argv itself, so it works the same through an npx `.bin` symlink.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { settle, display, outsideRoot } from './paths.mjs';
import { parse, docTypeFromPath, siblingPath, slugFromPath, findBlock, collect } from './parse.mjs';
import { diff } from './diff.mjs';
import { setStatus, setAnswer, snapshot, verifyAndRepair, questionTableToList } from './status.mjs';
import { readLock, liveLock } from './session.mjs';
import * as out from './out.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = path.join(HERE, '..', 'page');

/** Backoff between attempts to re-establish the file watcher after it errors. */
const WATCH_RETRY = [2000, 5000, 15000];

/**
 * Real path of the CLI entry point, for re-exec of the detached server child.
 * Resolved through realpath so the child is spawned with a true path even when
 * the package is reached through an npx `.bin` symlink or --preserve-symlinks.
 */
function cliPath() {
  const p = path.join(HERE, '..', 'bin', 'cli.mjs');
  try { return fs.realpathSync(p); } catch { return p; }
}

/** The package's own name/version, read once at module load (this process's code version). */
const PKG_INFO = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')); } catch { return {}; }
})();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.excalidraw': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const o = { cmd: argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'start', docs: [], port: Number(process.env.SPECS_EDITOR_PORT || 0), grace: 60, agentTimeout: 120, idle: 14400, foreground: false, json: false, rootFlag: '', root: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--doc') o.docs.push(argv[++i]);
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--grace') o.grace = Number(argv[++i]);
    else if (a === '--agent-timeout') o.agentTimeout = Number(argv[++i]);
    else if (a === '--idle') o.idle = Number(argv[++i]);
    else if (a === '--root') o.rootFlag = argv[++i];
    else if (a === '--foreground') o.foreground = true;
    else if (a === '--json' && o.cmd === 'status') o.json = true;
    else if (!a.startsWith('--')) o.docs.push(a);
    else out.usage(`unknown flag ${a}\nusage: sw-specs-editor start|status|stop|migrate --doc specs/NNNN-slug.md [--port N] [--grace S] [--agent-timeout S] [--idle S] [--foreground]`);
  }
  return settle(o);
}

export function resolvePair(root, docArg) {
  const rel = path.relative(root, path.resolve(root, docArg)).split(path.sep).join('/');
  const type = docTypeFromPath(rel);
  const prd = type === 'prd' ? rel : siblingPath(rel);
  const spec = type === 'spec' ? rel : siblingPath(rel);
  const slug = slugFromPath(rel);
  const specsDir = path.dirname(path.resolve(root, rel));
  return { prd, spec, slug, specsDir, sessionDir: path.join(specsDir, '.editor', slug), start: type };
}

// ---------------------------------------------------------------------------
// Atomic file helpers

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function now() { return new Date().toISOString(); }

const LIFECYCLE = /^session (started|resumed) on |^session closed \(/;

/**
 * The chat log is append-only and shared by every session on a document, so a
 * restarted document carries one start/close banner per past run, all pointing at
 * dead ports. Keep the conversation itself, keep the newest banner, and mark each
 * older boundary with a single divider.
 */
export function collapseSessions(lines) {
  const last = lines.findLastIndex(e => e.type === 'system' && LIFECYCLE.test(e.text || ''));
  const out = [];
  lines.forEach((e, i) => {
    if (i === last || e.type !== 'system' || !LIFECYCLE.test(e.text || '')) { out.push(e); return; }
    if (e.text.startsWith('session closed')) return;
    if (!out.length || out[out.length - 1].type === 'divider') return;
    out.push({ type: 'divider', text: 'previous session', t: e.t });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Session

export class Session {
  constructor(opts) {
    this.opts = opts;
    this.root = opts.root;
    this.pair = resolvePair(this.root, opts.docs[0]);
    this.dir = this.pair.sessionDir;
    fs.mkdirSync(path.join(this.dir, 'batches'), { recursive: true });
    this.paths = { prd: this.pair.prd, spec: this.pair.spec };
    this.models = { prd: null, spec: null };
    this.texts = { prd: null, spec: null };
    this.clients = new Set();
    this.waiters = [];
    this.queue = [];
    this.loadQueueManifest();
    this.run = null; // { id, docs: [...], pending: Set, acked, batch }
    this.locks = { prd: null, spec: null };
    this.lastBeat = Date.now();
    this.lastActivity = Date.now();
    if (this.opts.idle == null) this.opts.idle = 14400;
    this.lastPoll = 0;
    this.everPolled = false;
    this.agentPresent = false;
    this.snapshots = readJson(path.join(this.dir, 'snapshot.json'), {});
    this.queued = readJson(path.join(this.dir, 'queued.json'), []);
    const prev = readJson(path.join(this.dir, 'session.json'), {});
    this.batchSeq = Number(prev.lastBatchSeq || 0);
    this.state = { slug: this.pair.slug, started: now(), ended: null, lastBatch: prev.lastBatch || null, lastBatchSeq: this.batchSeq, batches: Number(prev.batches || 0), resumed: Boolean(prev.started) };
    this.loadDocs();
    this.pendingWatch = new Map();
    this.watchAttempt = 0;
  }

  log(...a) { out.note([new Date().toISOString().slice(11, 19), ...a].join(' ')); }
  abs(rel) { return path.resolve(this.root, rel); }

  loadDocs() {
    for (const d of ['prd', 'spec']) this.reload(d, true);
  }

  reload(doc, silent = false) {
    const file = this.abs(this.paths[doc]);
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch { text = null; }
    if (text === this.texts[doc]) return null;
    const old = this.models[doc];
    this.texts[doc] = text;
    this.models[doc] = text == null ? null : parse(text, { path: this.paths[doc], doc });
    if (silent) return null;
    const d = diff(old, this.models[doc]);
    this.broadcast('doc', { doc, model: this.models[doc], changed: d.changed, added: d.added, removed: d.removed });
    return d;
  }

  // --- persistence
  /**
   * `queue.json` is the durable manifest of agent batches, independent of
   * `queued.json` (page writes deferred by a lock), `session.json.lastBatchSeq`
   * (just the id counter) and `batches/<id>.json` (the audit copy, never deleted).
   * An id whose batch file is missing or unparseable is silently dropped: it can
   * never be delivered anyway.
   */
  loadQueueManifest() {
    const manifest = readJson(path.join(this.dir, 'queue.json'), { pending: [], inFlight: null });
    const ids = [];
    if (manifest.inFlight) ids.push(manifest.inFlight);
    for (const id of manifest.pending || []) if (id !== manifest.inFlight) ids.push(id);
    for (const id of ids) {
      const batch = readJson(path.join(this.dir, 'batches', `${id}.json`), null);
      if (batch) this.queue.push(batch);
    }
  }
  saveQueueManifest() {
    atomicWrite(path.join(this.dir, 'queue.json'), JSON.stringify({ pending: this.queue.map(b => b.id), inFlight: this.run ? this.run.id : null }, null, 2));
  }
  saveState() {
    atomicWrite(path.join(this.dir, 'session.json'), JSON.stringify({ ...this.state, port: this.port, url: this.url, docs: this.paths, lastBatchSeq: this.batchSeq, agent: { present: this.agentPresent, lastPoll: this.lastPoll ? new Date(this.lastPoll).toISOString() : null }, locks: this.locks }, null, 2));
  }
  chatAppend(entry) {
    entry.t = entry.t || now();
    fs.appendFileSync(path.join(this.dir, 'chat.jsonl'), JSON.stringify(entry) + '\n');
    this.broadcast('chat', entry);
    return entry;
  }
  chatHistory(limit = 0) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(this.dir, 'chat.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* none */ }
    lines = collapseSessions(lines);
    return limit ? lines.slice(-limit) : lines;
  }
  notes() { return readJson(path.join(this.dir, 'notes.json'), []); }
  saveNotes(notes) { atomicWrite(path.join(this.dir, 'notes.json'), JSON.stringify(notes, null, 2)); }
  saveQueued() { atomicWrite(path.join(this.dir, 'queued.json'), JSON.stringify(this.queued, null, 2)); }
  saveSnapshots() { atomicWrite(path.join(this.dir, 'snapshot.json'), JSON.stringify(this.snapshots)); }

  // --- SSE
  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) { try { c.write(payload); } catch { this.clients.delete(c); } }
  }

  info() {
    return {
      slug: this.pair.slug, dir: path.relative(this.root, this.dir).split(path.sep).join('/'), port: this.port, url: this.url,
      started: this.state.started, resumed: this.state.resumed, batches: this.state.batches, lastBatch: this.state.lastBatch,
      agent: { present: this.agentPresent, everPolled: this.everPolled, lastPoll: this.lastPoll ? new Date(this.lastPoll).toISOString() : null, timeout: this.opts.agentTimeout },
      locks: this.locks, run: this.run ? { id: this.run.id, docs: this.run.docs, kind: this.run.kind } : null, queue: this.queue.map(b => b.id),
      grace: this.opts.grace, queuedWrites: this.queued.length,
    };
  }

  // --- batches
  /** A batch is only ever what the user sent from the page. Opening it runs nothing. */
  enqueue(body) {
    const kind = 'batch';
    const id = `b-${++this.batchSeq}`;
    const docs = {};
    const touched = [];
    for (const d of ['prd', 'spec']) {
      const notes = body.docs?.[d]?.notes || [];
      if (notes.length) { docs[d] = { notes }; touched.push(d); }
    }
    const chat = (body.chat || '').trim();
    const chatDoc = body.chatDoc === 'spec' ? 'spec' : 'prd';
    if (chat && !touched.includes(chatDoc)) { docs[chatDoc] = { notes: [] }; touched.push(chatDoc); }
    if (!touched.length) throw httpError(400, 'batch is empty');
    // Two forms of every path, on purpose. The agent reads this JSON from
    // its own process, whose working directory is not ours, so anything it has
    // to open is absolute and canonical. The `*Rel` twins are what the chat log
    // and the close report show, so transcripts stay portable.
    const chatLog = path.join(this.dir, 'chat.jsonl');
    const batchFile = path.join(this.dir, 'batches', `${id}.json`);
    const batch = {
      id, kind, sentAt: now(), docs, chat,
      chatDoc: body.chatDoc || null,
      createSpec: Boolean(body.createSpec),
      touched,
      root: this.root,
      paths: Object.fromEntries(Object.entries(this.paths).map(([d, rel]) => [d, this.abs(rel)])),
      pathsRel: { ...this.paths },
      session: this.url,
      context: chatLog,
      contextRel: display(this.root, chatLog),
    };
    for (const d of touched) {
      batch.docs[d].path = this.abs(this.paths[d]);
      batch.docs[d].pathRel = this.paths[d];
      for (const n of batch.docs[d].notes) {
        if (n && typeof n.file === 'string' && n.file) { n.fileRel = n.file; n.file = this.abs(n.file); }
      }
    }
    batch.file = batchFile;
    batch.fileRel = display(this.root, batchFile);
    atomicWrite(path.join(this.dir, 'batches', `${id}.json`), JSON.stringify(batch, null, 2));
    this.queue.push(batch);
    this.state.lastBatch = id; this.state.batches++;
    this.chatAppend({ type: 'batch', id, kind, docs: Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, {
      notes: v.notes.map(n => (n && n.fileRel ? { ...n, file: n.fileRel, fileRel: undefined } : n)),
    }])), chat: batch.chat, chatDoc: batch.chatDoc, queued: Boolean(this.run) });
    this.broadcast('run', { state: 'queued', batch: id, docs: touched, locks: this.locks, queue: this.queue.map(b => b.id), active: this.run?.id || null });
    this.saveState();
    this.saveQueueManifest();
    this.lastActivity = Date.now();
    this.wakeWaiters();
    return batch;
  }

  wakeWaiters() {
    if (!this.waiters.length) return;
    const next = this.reserveForAgent();
    if (!next) return;
    const w = this.waiters.shift();
    clearTimeout(w.timer);
    w.resolve(next);
  }

  /**
   * Dequeue the next batch if no run is active and starts the run (locks +
   * snapshots), OR - the redelivery rule - hand back the batch of a run that was
   * started but never acked (see `ackRun`). Delivery is a lease, not a fire and
   * forget: only evidence that the agent acted on a batch (a progress ping, a
   * chat line, a reply) commits it. A response merely reaching the socket is not
   * enough - see `releaseReservation` and the `req.on('close')` handling in
   * `/api/next` for the other half of this contract.
   */
  reserveForAgent() {
    if (this.closing) return { event: 'closed' };
    if (this.run) {
      if (this.run.acked === true) return null;
      if (!this.run.redelivered) {
        this.run.redelivered = true;
        this.chatAppend({ type: 'system', text: `batch ${this.run.id} redelivered after a lost connection` });
      }
      return { event: 'batch', batch: this.run.batch };
    }
    if (!this.queue.length) return null;
    const batch = this.queue.shift();
    this.run = { id: batch.id, kind: batch.kind, docs: batch.touched, pending: new Set(batch.touched), startedAt: Date.now(), acked: false, batch };
    for (const d of batch.touched) {
      this.locks[d] = batch.id;
      if (this.texts[d] != null) this.snapshots[d] = snapshot(this.texts[d], { path: this.paths[d], doc: d });
    }
    this.saveSnapshots();
    this.broadcast('run', { state: 'started', batch: batch.id, kind: batch.kind, docs: batch.touched, locks: this.locks, queue: this.queue.map(b => b.id), active: batch.id });
    this.saveState();
    this.saveQueueManifest();
    this.lastActivity = Date.now();
    return { event: 'batch', batch };
  }

  /** Undo an unacked reservation: puts the batch back at the front of the queue. */
  releaseReservation() {
    if (!this.run || this.run.acked === true) return;
    const batch = this.run.batch;
    if (batch) this.queue.unshift(batch);
    for (const d of this.run.docs) {
      this.locks[d] = null;
      delete this.snapshots[d];
    }
    this.saveSnapshots();
    this.run = null;
    this.saveState();
    this.saveQueueManifest();
  }

  waitForAgent(waitSec) {
    const immediate = this.reserveForAgent();
    if (immediate) return Promise.resolve(immediate);
    return new Promise(resolve => {
      const w = { resolve, timer: null };
      w.timer = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); resolve({ event: this.closing ? 'closed' : 'idle' }); }, Math.max(1, Math.min(waitSec, 3600)) * 1000);
      this.waiters.push(w);
    });
  }

  /** Marks the active run's batch as delivered: the agent gave evidence it received it. */
  ackRun() {
    if (this.run) this.run.acked = true;
  }

  /** Agent reply for one document (or all pending docs when doc is omitted). */
  reply(body) {
    const batchId = body.batch || this.run?.id;
    if (!this.run || (batchId && batchId !== this.run.id)) {
      // No active run: treat as a plain chat message so nothing is lost.
      const entry = this.chatAppend({ type: 'reply', batch: batchId || null, doc: body.doc || null, md: body.markdown || body.text || '', changed: [], orphan: true });
      return { ok: true, orphan: true, entry };
    }
    const docs = body.doc ? [body.doc] : [...this.run.pending];
    const results = [];
    for (const d of docs) {
      if (!this.run.pending.has(d)) continue;
      const r = this.finishDoc(d, body, batchId);
      results.push(r);
    }
    if (body.abort) for (const d of [...this.run.pending]) this.finishDoc(d, { markdown: body.markdown || 'Run aborted.', text: '' }, batchId);
    if (!this.run.pending.size) {
      const finished = this.run.id;
      this.run = null;
      this.broadcast('run', { state: 'finished', batch: finished, locks: this.locks, queue: this.queue.map(b => b.id), active: null });
      this.saveState();
      this.saveQueueManifest();
      setTimeout(() => this.wakeWaiters(), 10);
    }
    return { ok: true, results };
  }

  finishDoc(d, body, batchId) {
    // verify + repair
    let repairs = [];
    let changed = [], added = [], removed = [];
    const file = this.abs(this.paths[d]);
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch { text = null; }
    if (text != null && this.snapshots[d]) {
      const r = verifyAndRepair(text, this.snapshots[d], { path: this.paths[d], doc: d });
      if (r.repairs.length) { atomicWrite(file, r.text); text = r.text; repairs = r.repairs; }
      const before = this.snapshots[d].hashes || {};
      const model = parse(text, { path: this.paths[d], doc: d });
      for (const b of collect(model.blocks)) {
        if (!(b.id in before)) added.push(b.id);
        else if (before[b.id] !== b.hash) changed.push(b.id);
      }
      for (const id of Object.keys(before)) if (!findBlock(model, id)) removed.push(id);
    }
    this.reload(d); // pushes the doc event if the text changed since the last watch tick
    this.locks[d] = null;
    this.run.pending.delete(d);
    delete this.snapshots[d];
    this.saveSnapshots();
    const entry = this.chatAppend({ type: 'reply', batch: batchId, doc: d, md: body.markdown || body.text || '', changed: [...changed, ...added], removed, repairs, agents: body.agents || null });
    this.applyQueued(d);
    return { doc: d, changed, added, removed, repairs, entry };
  }

  applyQueued(d) {
    const mine = this.queued.filter(q => q.doc === d);
    if (!mine.length) return;
    this.queued = this.queued.filter(q => q.doc !== d);
    this.saveQueued();
    for (const q of mine) {
      try {
        if (q.type === 'status') this.applyStatus(q.doc, q.id, q.status);
        else if (q.type === 'diagram') this.applyDiagram(q);
        else if (q.type === 'answer') this.applyAnswer(q.doc, q.id, q.answer);
      } catch (e) { this.chatAppend({ type: 'system', text: `queued ${q.type} on ${q.id || q.name} failed: ${e.message}` }); }
    }
    this.chatAppend({ type: 'system', text: `applied ${mine.length} queued change(s) on ${d}` });
    this.broadcast('queued', { count: this.queued.length });
  }

  // --- direct writes (no agent)
  applyStatus(doc, id, status) {
    const text = this.texts[doc];
    if (text == null) throw httpError(404, 'document missing');
    const r = setStatus(text, id, status, { path: this.paths[doc], doc });
    if (!r.changed) return { changed: false, reason: r.reason };
    atomicWrite(this.abs(this.paths[doc]), r.text);
    this.reload(doc);
    this.lastActivity = Date.now();
    return { changed: true };
  }

  applyAnswer(doc, id, answer) {
    const text = this.texts[doc];
    if (text == null) throw httpError(404, 'document missing');
    const r = setAnswer(text, id, answer, { path: this.paths[doc], doc });
    if (!r.changed) return { changed: false, reason: r.reason };
    atomicWrite(this.abs(this.paths[doc]), r.text);
    this.reload(doc);
    this.lastActivity = Date.now();
    return { changed: true };
  }

  applyDiagram(q) {
    const block = this.models[q.doc] ? findBlock(this.models[q.doc], q.id || `diagram:${q.name}`) : null;
    if (!block || block.kind !== 'diagram') throw httpError(404, 'diagram block not found');
    const file = this.safeSpecsPath(block.file);
    if (q.scene) atomicWrite(file, typeof q.scene === 'string' ? q.scene : JSON.stringify(q.scene, null, 2) + '\n');
    if (q.svg) atomicWrite(path.join(this.dir, `${block.name}.svg`), q.svg);
    this.lastActivity = Date.now();
    this.broadcast('diagram', { doc: q.doc, id: block.id, file: block.file, svg: this.svgRel(block.name) });
    return { ok: true, file: block.file };
  }

  svgRel(name) { return path.relative(this.root, path.join(this.dir, `${name}.svg`)).split(path.sep).join('/'); }

  safeSpecsPath(rel) {
    const abs = path.resolve(this.root, rel);
    const specsAbs = path.resolve(this.pair.specsDir);
    if (!abs.startsWith(specsAbs + path.sep) && abs !== specsAbs) throw httpError(403, 'outside specs directory');
    return abs;
  }

  // --- lifecycle
  beat() { this.lastBeat = Date.now(); }
  tick() {
    const t = Date.now();
    if (t - this.lastBeat > this.opts.grace * 1000) { this.shutdown('heartbeat timeout'); return; }
    if (this.opts.idle && t - this.lastActivity > this.opts.idle * 1000) { this.shutdown('idle'); return; }
    const present = this.lastPoll > 0 && t - this.lastPoll < this.opts.agentTimeout * 1000;
    if (present !== this.agentPresent) {
      this.agentPresent = present;
      this.broadcast('agent', { present, everPolled: this.everPolled });
      this.saveState();
    }
    // The design skill runs in the main session and cannot poll while it works; only its
    // progress lines keep `lastPoll` fresh, and a helper-agent spawn can stay silent for
    // minutes. Silence is therefore reported once and never acted on: a run ends only when
    // the agent says so (`emit done`) or the user does (Stop). Matches the Tender tool.
    if (this.run && !this.run.warned && this.lastPoll > 0 && t - this.lastPoll > this.opts.agentTimeout * 1000) {
      this.run.warned = true;
      this.chatAppend({ type: 'system', text: `no sign of the agent for ${Math.round(this.opts.agentTimeout / 60)} min during run ${this.run.id}; still waiting. Stop the run from the page if it is stuck.` });
    }
  }
  polled() {
    this.lastPoll = Date.now(); this.everPolled = true; this.lastActivity = Date.now();
    if (!this.agentPresent) { this.agentPresent = true; this.broadcast('agent', { present: true, everPolled: true }); this.saveState(); }
  }

  shutdown(reason) {
    if (this.closing) return;
    this.closing = true;
    this.log(`closing: ${reason}`);
    this.state.ended = now(); this.state.endReason = reason;
    this.chatAppend({ type: 'system', text: `session closed (${reason})` });
    this.broadcast('closing', { reason });
    this.saveState();
    for (const w of this.waiters) { clearTimeout(w.timer); w.resolve({ event: 'closed' }); }
    this.waiters = [];
    try { fs.unlinkSync(path.join(this.dir, 'session.lock')); } catch { /* gone */ }
    for (const c of this.clients) { try { c.end(); } catch { /* ignore */ } }
    if (this.watcher) try { this.watcher.close(); } catch { /* ignore */ }
    clearTimeout(this.watchTimer);
    clearInterval(this.timer); clearInterval(this.keepalive);
    setTimeout(() => { this.server?.close(); this.server?.closeAllConnections?.(); setTimeout(() => process.exit(0), 200).unref(); }, 150);
  }

  watch() {
    const dir = this.pair.specsDir;
    const names = new Map([[path.basename(this.paths.prd), 'prd'], [path.basename(this.paths.spec), 'spec']]);
    try {
      this.watcher = fs.watch(dir, { persistent: true }, (ev, name) => {
        if (!name) return;
        const base = String(name);
        if (base.endsWith('.tmp')) return;
        clearTimeout(this.pendingWatch.get(base));
        this.pendingWatch.set(base, setTimeout(() => {
          this.pendingWatch.delete(base);
          if (names.has(base)) this.reload(names.get(base));
          else if (base.startsWith(this.pair.slug) && /\.(excalidraw|graph\.json)$/.test(base)) {
            const doc = base.startsWith(this.pair.slug + '-spec') ? 'spec' : 'prd';
            const model = this.models[doc];
            const block = model ? collect(model.blocks).find(b => b.kind === 'diagram' && path.basename(b.file) === base.replace(/\.graph\.json$/, '.excalidraw')) : null;
            if (block) this.broadcast('diagram', { doc, id: block.id, file: block.file, svg: this.svgRel(block.name), external: true });
          }
        }, 150));
      });
      this.watcher.on('error', e => this.watchFailed(e));
      if (this.watchAttempt) { this.watchAttempt = 0; this.chatAppend({ type: 'system', text: 'file watching resumed' }); }
    } catch (e) { this.watchFailed(e); }
  }

  /**
   * A watch error - EMFILE under file-descriptor pressure is the one seen in the
   * wild - arrives asynchronously on the FSWatcher, where an unhandled 'error'
   * event would kill the process. Degrade instead: drop the dead watcher, say so
   * once on the page, and try again a few times. Agent replies reload the
   * documents explicitly, so only edits made outside the page go stale meanwhile.
   */
  watchFailed(e) {
    if (this.closing) return;
    this.log('watch error', e.message);
    if (this.watcher) { try { this.watcher.close(); } catch { /* ignore */ } this.watcher = null; }
    const delays = this.opts.watchRetry || WATCH_RETRY;
    const delay = delays[this.watchAttempt++];
    if (delay == null) { this.chatAppend({ type: 'system', text: `file watching gave up after ${delays.length} attempts (${e.message}); reload the page after editing the documents outside it` }); return; }
    if (this.watchAttempt === 1) this.chatAppend({ type: 'system', text: `file watching stopped (${e.message}); edits made outside the page are not picked up while it retries` });
    clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => this.watch(), delay);
    this.watchTimer.unref?.();
  }
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// ---------------------------------------------------------------------------
// HTTP

function send(res, status, body, type = 'application/json; charset=utf-8', cb) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(data) });
  if (cb) res.end(data, cb); else res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => { chunks.push(c); if (chunks.reduce((n, b) => n + b.length, 0) > 50 * 1024 * 1024) { reject(httpError(413, 'body too large')); req.destroy(); } });
    req.on('end', () => { const s = Buffer.concat(chunks).toString('utf8'); if (!s) return resolve({}); try { resolve(JSON.parse(s)); } catch { reject(httpError(400, 'invalid JSON')); } });
    req.on('error', reject);
  });
}

async function handle(session, req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname.replace(/\/{2,}/g, '/');
  const m = req.method;
  try {
    if (m === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, path.join(PAGE_DIR, 'index.html'));
    if (m === 'GET' && p.startsWith('/page/')) {
      const f = path.resolve(PAGE_DIR, '.' + p.slice(5));
      if (!f.startsWith(PAGE_DIR)) return send(res, 403, { error: 'forbidden' });
      return serveStatic(res, f);
    }
    if (m === 'GET' && p === '/file') {
      const rel = url.searchParams.get('path') || '';
      const f = session.safeSpecsPath(rel);
      return serveStatic(res, f);
    }
    if (m === 'GET' && p === '/api/session') {
      return send(res, 200, { session: session.info(), paths: session.paths, docs: session.models, notes: session.notes(), chat: session.chatHistory(), queued: session.queued });
    }
    if (m === 'GET' && p === '/health') {
      return send(res, 200, { name: PKG_INFO.name || null, version: PKG_INFO.version || null, pid: process.pid, slug: session.pair.slug, url: session.url, started: session.state.started });
    }
    if (m === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`event: hello\ndata: ${JSON.stringify({ session: session.info() })}\n\n`);
      session.clients.add(res);
      session.beat();
      req.on('close', () => session.clients.delete(res));
      return;
    }
    if (m === 'POST' && p === '/api/heartbeat') { session.beat(); return send(res, 200, { ok: true, agent: { present: session.agentPresent }, locks: session.locks }); }
    if (m === 'POST' && p === '/api/notes') {
      const body = await readBody(req);
      session.saveNotes(Array.isArray(body.notes) ? body.notes : []);
      session.lastActivity = Date.now();
      session.broadcast('notes', { notes: body.notes || [], tab: body.tab || null });
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/batch') {
      const body = await readBody(req);
      const batch = session.enqueue(body);
      session.saveNotes(Array.isArray(body.remaining) ? body.remaining : []);
      return send(res, 200, { id: batch.id, queued: Boolean(session.run), file: batch.file });
    }
    if (m === 'POST' && p === '/api/status') {
      const body = await readBody(req);
      const doc = body.doc === 'spec' ? 'spec' : 'prd';
      if (!['done', 'partly', 'open'].includes(body.status)) throw httpError(400, 'invalid status');
      if (session.locks[doc]) {
        session.queued = session.queued.filter(q => !(q.type === 'status' && q.doc === doc && q.id === body.id));
        session.queued.push({ type: 'status', doc, id: body.id, status: body.status, t: now() });
        session.saveQueued();
        session.broadcast('queued', { count: session.queued.length });
        return send(res, 202, { queued: true, lockedBy: session.locks[doc] });
      }
      return send(res, 200, { ok: true, ...session.applyStatus(doc, body.id, body.status) });
    }
    if (m === 'POST' && p === '/api/answer') {
      const body = await readBody(req);
      const doc = body.doc === 'spec' ? 'spec' : 'prd';
      const answer = body.option ? { option: body.option } : typeof body.text === 'string' ? { text: body.text } : null;
      if (session.locks[doc]) {
        session.queued = session.queued.filter(q => !(q.type === 'answer' && q.doc === doc && q.id === body.id));
        session.queued.push({ type: 'answer', doc, id: body.id, answer, t: now() });
        session.saveQueued();
        session.broadcast('queued', { count: session.queued.length });
        return send(res, 202, { queued: true, lockedBy: session.locks[doc] });
      }
      return send(res, 200, { ok: true, ...session.applyAnswer(doc, body.id, answer) });
    }
    if (m === 'POST' && p === '/api/diagram') {
      const body = await readBody(req);
      const doc = body.doc === 'spec' ? 'spec' : 'prd';
      const q = { type: 'diagram', doc, id: body.id, name: body.name, scene: body.scene, svg: body.svg, t: now() };
      if (session.locks[doc]) {
        session.queued = session.queued.filter(x => !(x.type === 'diagram' && x.doc === doc && (x.id || x.name) === (q.id || q.name)));
        session.queued.push(q); session.saveQueued();
        session.broadcast('queued', { count: session.queued.length });
        return send(res, 202, { queued: true, lockedBy: session.locks[doc] });
      }
      return send(res, 200, session.applyDiagram(q));
    }
    if (m === 'POST' && p === '/api/close') { send(res, 200, { ok: true }); session.shutdown('closed by request'); return; }
    if (m === 'GET' && p === '/api/lock') return send(res, 200, { locks: session.locks, agent: session.info().agent, run: session.info().run, queue: session.queue.map(b => b.id) });
    // --- agent endpoints
    if (m === 'GET' && p === '/api/next') {
      session.polled();
      const wait = Number(url.searchParams.get('wait') || 30);
      let flushed = false;
      // Covers "killed before the response arrived": if the socket closes before
      // the data is flushed, the reservation (if any) never reached the agent, so
      // put it back. "Killed after" is covered by the acked-based redelivery in
      // `reserveForAgent` instead - see the comment there.
      req.on('close', () => { if (!flushed) session.releaseReservation(); });
      const r = await session.waitForAgent(wait);
      session.polled();
      return send(res, 200, r, 'application/json; charset=utf-8', () => { flushed = true; });
    }
    if (m === 'POST' && p === '/api/agent/progress') {
      const body = await readBody(req);
      session.polled();
      session.ackRun();
      const entry = session.chatAppend({ type: 'progress', batch: body.batch || session.run?.id || null, doc: body.doc || null, text: body.text || body.markdown || '' });
      session.broadcast('progress', entry);
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/agent/chat') {
      const body = await readBody(req);
      session.polled();
      session.ackRun();
      session.chatAppend({ type: 'reply', batch: body.batch || session.run?.id || null, doc: body.doc || null, md: body.markdown || body.text || '', changed: [], interim: true });
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/agent/reply') {
      const body = await readBody(req);
      session.polled();
      session.ackRun();
      return send(res, 200, session.reply(body));
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) session.log('error', e.stack || e.message);
    return send(res, status, { error: e.message });
  }
}

function serveStatic(res, file) {
  let data;
  try { data = fs.readFileSync(file); } catch { return send(res, 404, { error: 'not found' }); }
  send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
}

export function startServer(opts) {
  const session = new Session(opts);
  const server = http.createServer((req, res) => handle(session, req, res));
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 0;
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port || 0, '127.0.0.1', () => {
      session.server = server;
      session.port = server.address().port;
      session.url = `http://127.0.0.1:${session.port}/`;
      atomicWrite(path.join(session.dir, 'session.lock'), JSON.stringify({ pid: process.pid, port: session.port, url: session.url, started: session.state.started, docs: session.paths }, null, 2));
      session.saveState();
      session.watch();
      session.timer = setInterval(() => session.tick(), 5000);
      session.keepalive = setInterval(() => { for (const c of session.clients) { try { c.write(': ka\n\n'); } catch { /* ignore */ } } }, 15000);
      session.chatAppend({ type: 'system', text: session.state.resumed ? `session resumed on ${session.url}` : `session started on ${session.url}` });
      process.on('SIGINT', () => session.shutdown('SIGINT'));
      process.on('SIGTERM', () => session.shutdown('SIGTERM'));
      resolve(session);
    });
  });
}

// ---------------------------------------------------------------------------

/**
 * `status` - what the skills used to read from `GET /api/session`.
 *
 * The compact lines come first and the full payload only behind --json, so the
 * common case costs an agent a few lines instead of a whole document model.
 */
async function status(opts, pair) {
  const lock = await liveLock(pair.sessionDir);
  out.line('running', String(Boolean(lock)));
  out.line('prd', pair.prd);
  out.line('spec', pair.spec);
  out.line('session_dir', path.relative(opts.root, pair.sessionDir).split(path.sep).join('/'));
  if (!lock) {
    out.nextStep(`run \`sw-specs-editor start --doc ${opts.docs[0]}\``);
    return;
  }
  out.line('url', lock.url);
  out.line('pid', String(lock.pid));

  let session = null;
  try {
    const res = await fetch(lock.url + 'api/session');
    if (res.ok) session = await res.json();
  } catch { /* server answered api/lock a moment ago; treat a failure here as "no detail" */ }

  if (session) {
    for (const d of ['prd', 'spec']) {
      const model = session.docs?.[d];
      if (!model) continue;
      const counts = statusCounts(model);
      out.line(`${d}_blocks`, `${counts.total} (${counts.done} done, ${counts.partly} partly, ${counts.open} open)`);
    }
    out.line('notes_unsent', String((session.notes || []).length));
    out.line('queued', String(Object.values(session.queued || {}).flat().length));
    out.line('agent_present', String(Boolean(session.session?.agent?.present)));
    out.line('run_active', String(session.session?.run?.id || 'none'));
  }
  out.nextStep('run `sw-specs-editor poll` to wait for the next batch');
  if (opts.json && session) out.payload(session);
}

function statusCounts(model) {
  const counts = { total: 0, done: 0, partly: 0, open: 0 };
  for (const b of collect(model?.blocks)) {
    if (!b.status) continue;
    counts.total++;
    if (counts[b.status] !== undefined) counts[b.status]++;
  }
  return counts;
}

export async function main(argv) {
  const opts = parseArgs([...argv]);
  if (!opts.docs.length) out.usage('usage: sw-specs-editor start|status|stop|migrate --doc specs/NNNN-slug.md [--port N] [--grace S] [--agent-timeout S] [--idle S] [--foreground]');
  const pair = resolvePair(opts.root, opts.docs[0]);
  const stray = outsideRoot(opts.root, path.resolve(opts.root, pair.prd));
  if (stray) out.usage(stray);
  if (!fs.existsSync(path.resolve(opts.root, pair.prd)) && !fs.existsSync(path.resolve(opts.root, pair.spec))) out.usage(`neither ${pair.prd} nor ${pair.spec} exists`);

  if (opts.cmd === 'migrate') {
    for (const [label, rel] of [['prd', pair.prd], ['spec', pair.spec]]) {
      const file = path.resolve(opts.root, rel);
      if (!fs.existsSync(file)) { out.line(label, `${rel} not found, skipped`); continue; }
      const text = fs.readFileSync(file, 'utf8');
      const r = questionTableToList(text, { path: rel, doc: label });
      if (!r.changed) { out.line(label, 'nothing to convert'); continue; }
      atomicWrite(file, r.text);
      const n = (r.text.match(/^\*\*Q-\d+\*\*/gm) || []).length;
      out.line(label, `converted ${n} question(s)`);
    }
    out.nextStep('run `sw-specs-editor start --doc <path>` to review the result');
    return;
  }
  if (opts.cmd === 'status') return status(opts, pair);
  if (opts.cmd === 'stop') {
    const lock = await liveLock(pair.sessionDir);
    if (!lock) { out.line('running', 'false'); out.nextStep('nothing to stop'); return; }
    await fetch(lock.url + 'api/close', { method: 'POST' }).catch(() => {});
    out.line('stopped', lock.url);
    out.nextStep('the session is closed; summarise it for the user');
    return;
  }
  const live = await liveLock(pair.sessionDir);
  if (live) {
    // A server with a differing version is stopped and replaced rather than
    // reattached - stale code behind a live lock is worse than a short restart.
    // A server with no /health at all (older than this check) reattaches as
    // before: that is the only evidence available about it.
    let mismatched = false;
    try {
      const res = await fetch(live.url + 'health');
      if (res.ok) {
        const health = await res.json();
        mismatched = Boolean(health.version) && health.version !== PKG_INFO.version;
      }
    } catch { /* no /health: fall back to reattaching */ }
    if (mismatched) {
      await fetch(live.url + 'api/close', { method: 'POST' }).catch(() => {});
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && (await liveLock(pair.sessionDir))) await new Promise(r => setTimeout(r, 100));
    } else {
      console.log(`SPECS_EDITOR_URL=${live.url}`);
      out.line('reattached', `pid ${live.pid}`);
      out.nextStep('run `sw-specs-editor guide` if you have not yet, then `sw-specs-editor poll`');
      return;
    }
  }
  if (opts.foreground) {
    const s = await startServer(opts);
    console.log(`SPECS_EDITOR_URL=${s.url}`);
    out.line('prd', `${pair.prd} (${fs.existsSync(path.resolve(opts.root, pair.prd)) ? 'found' : 'missing'})`);
    out.line('spec', `${pair.spec} (${fs.existsSync(path.resolve(opts.root, pair.spec)) ? 'found' : 'missing'})`);
    out.nextStep('run `sw-specs-editor guide` if you have not yet, then `sw-specs-editor poll`');
    return;
  }
  // detach
  fs.mkdirSync(pair.sessionDir, { recursive: true });
  try { fs.unlinkSync(path.join(pair.sessionDir, 'session.lock')); } catch { /* none */ }
  const logFile = fs.openSync(path.join(pair.sessionDir, 'server.log'), 'a');
  const args = [cliPath(), 'start', '--foreground', '--root', opts.root, '--doc', opts.docs[0], '--grace', String(opts.grace), '--agent-timeout', String(opts.agentTimeout), '--idle', String(opts.idle)];
  if (opts.port) args.push('--port', String(opts.port));
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', logFile, logFile], cwd: opts.root });
  child.unref();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const lock = readLock(pair.sessionDir);
    if (lock && lock.pid === child.pid && lock.url) {
      console.log(`SPECS_EDITOR_URL=${lock.url}`);
      out.line('pid', String(child.pid));
      out.line('log', path.relative(opts.root, path.join(pair.sessionDir, 'server.log')));
      out.nextStep(`open ${lock.url} for the user, then run \`sw-specs-editor guide\` and follow it`);
      return;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  out.unreachable('server did not start within 8 s; see server.log');
}
