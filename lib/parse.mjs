// Markdown -> document model. Zero dependencies.
// Recognises the PRD template (sw-design-requirements) and the tech-spec
// template (sw-design-solution); unknown headings land in Details.

import { createHash } from 'node:crypto';
import path from 'node:path';

export const STATUS_TAGS = ['done', 'partly', 'open'];

const ITEM_ID_RE = /^([A-Z]{1,4}-\d+)$/;
const TAG_RE = /\s*\[(done|partly|open)\]/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const DIAGRAM_RE = /^\s*(?:\*\*)?Diagram:?(?:\*\*)?:?\s*`?([^\s`]+\.excalidraw)`?\s*$/i;
const FENCE_RE = /^\s*(```|~~~)/;
const LABEL_RE = /^\*\*([^*]+?)\*\*:?\s*$/; // bold-only line => group label

export function hash(text) {
  return createHash('sha1').update(normalize(text)).digest('hex').slice(0, 12);
}

export function normalize(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').trim().replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n');
}

export function docTypeFromPath(p) {
  return /-spec\.md$/i.test(p) ? 'spec' : 'prd';
}

export function siblingPath(p) {
  return docTypeFromPath(p) === 'spec' ? p.replace(/-spec\.md$/i, '.md') : p.replace(/\.md$/i, '-spec.md');
}

export function slugFromPath(p) {
  return path.basename(p).replace(/-spec\.md$/i, '').replace(/\.md$/i, '');
}

/**
 * The session directory name for a document, `<slug>-prd` or `<slug>-spec`: a
 * feature's PRD and its spec share a slug but never a session. `sessionDirs`
 * parses this back apart - keep the two in step.
 */
export function sessionSlugFor(p) {
  return `${slugFromPath(p)}-${docTypeFromPath(p)}`;
}

export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/** Split a markdown table row into trimmed cells (handles escaped pipes and pipes inside `code spans`). */
export function splitRow(line) {
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '`') inCode = !inCode;
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** Strip a leading status tag; returns { status, text }. */
export function stripTag(text) {
  const m = /^\s*\[(done|partly|open)\]\s*/.exec(text);
  if (m) return { status: m[1], text: text.slice(m[0].length) };
  return { status: null, text };
}

export function parseOptions(cell) {
  if (!cell || cell.trim() === '' || /^_?tbd_?$/i.test(cell.trim()) || cell.trim() === '—' || cell.trim() === '-') return [];
  return cell.split(/<br\s*\/?>/i).map(s => s.trim()).filter(Boolean).map((s, i) => {
    const m = /^([A-Za-z0-9]{1,3})[:.)]\s*(.*)$/.exec(s);
    let id = m ? m[1].toUpperCase() : String.fromCharCode(65 + i);
    let text = m ? m[2] : s;
    const recommended = /\(recommended\)/i.test(text);
    text = text.replace(/\s*\(recommended\)\s*/i, ' ').trim();
    return { id, text, recommended };
  });
}

/**
 * `[pm] Recommends A: reason` / `[architect] A, C — reason` / `[pm] reason`.
 * A note may name one or more option ids; those are the options it is shown on.
 * `stance` keeps the leading verb (recommends / against / …) when there is one.
 */
const NOTE_OPTIONS_RE = /^(?:(recommends?|recommended|against|supports?|agrees? with|disagrees? with|option|options|on|re)\s+)?([A-Za-z0-9](?:\s*(?:,|\/|&|and|\+)\s*[A-Za-z0-9])*)\s*[:.–—-]\s*(.+)$/i;

export function parseAgentNotes(cell) {
  if (!cell || cell.trim() === '' || cell.trim() === '—' || cell.trim() === '-') return [];
  return cell.split(/<br\s*\/?>/i).map(s => s.trim()).filter(Boolean).map(s => {
    const m = /^\[([^\]]+)\]\s*(.*)$/.exec(s);
    const agent = m ? m[1].trim() : 'agent';
    const body = m ? m[2] : s;
    const om = NOTE_OPTIONS_RE.exec(body);
    if (!om) return { agent, options: [], stance: null, text: body };
    const options = om[2].split(/\s*(?:,|\/|&|and|\+)\s*/i).map(x => x.trim().toUpperCase()).filter(Boolean);
    return { agent, options, stance: om[1] ? om[1].toLowerCase() : null, text: om[3].trim() };
  });
}

/**
 * A question is advised when an agent has put a recommendation on it: one option
 * marked `(recommended)` and at least one agent note behind it. `[user]` is not an
 * agent - it marks a question the user raised on the page, which needs no advice.
 */
export function isAdvised(q) {
  if (!q || !q.options || !q.options.length) return false;
  if (!q.options.some(o => o.recommended)) return false;
  return (q.agentNotes || []).some(n => n.agent && n.agent.toLowerCase() !== 'user');
}

/** A question the user raised on the page: exempt from the advice invariant. */
export function isUserRaised(q) {
  return (q?.agentNotes || []).some(n => (n.agent || '').toLowerCase() === 'user');
}

/** Stable serialization of one agent note, for the question hash. */
function noteKey(n) {
  return `${n.agent}|${(n.options || []).join('+')}|${n.stance || ''}|${n.text}`;
}

function questionKind(text) {
  const m = /^\[(adr|gate)\]\s*/i.exec(text);
  return m ? { kindTag: m[1].toLowerCase(), text: text.slice(m[0].length) } : { kindTag: null, text };
}

const Q_HEAD_RE = /^\*\*(Q-\d+)\*\*\s*(?:\[(adr|gate)\])?\s*(.*)$/;
const Q_OPTION_RE = /^-\s*\[([ xX])\]\s*(.*)$/;
const Q_OWN_RE = /^✎\s*(.*)$/;
const Q_OPTION_ID_RE = /^([A-Za-z0-9]{1,3})[:.)]\s*(.*)$/;
const Q_NOTE_RE = /^\s+-\s*\[/;
const Q_BLOCKS_RE = /^Blocks:\s*(.*)$/i;

/**
 * `**Q-n**` list format: question line already stripped of the id/tag by the
 * caller. `body` are the lines that follow, up to the next blank line / heading / `**Q-`.
 */
function parseQuestionList(id, kindTag, question, body) {
  const blocks = [];
  const options = [];
  const agentNotes = [];
  let answer = null;
  let curOptionId = null;
  let idx = 0;
  const bm = body[0] != null ? Q_BLOCKS_RE.exec(body[0]) : null;
  if (bm) { blocks.push(...bm[1].split(/[,;]/).map(s => s.trim()).filter(Boolean)); idx = 1; }
  for (; idx < body.length; idx++) {
    const l = body[idx];
    const om = Q_OPTION_RE.exec(l);
    if (om) {
      const checked = om[1].toLowerCase() === 'x';
      const rest = om[2];
      const own = Q_OWN_RE.exec(rest.trim());
      if (own) {
        if (checked) answer = { text: own[1].trim() };
        curOptionId = null;
        continue;
      }
      const idm = Q_OPTION_ID_RE.exec(rest);
      const oid = idm ? idm[1].toUpperCase() : String.fromCharCode(65 + options.length);
      let text = idm ? idm[2] : rest;
      const recommended = /\(recommended\)/i.test(text);
      text = text.replace(/\s*\(recommended\)\s*/i, ' ').trim();
      options.push({ id: oid, text, recommended, checked });
      if (checked) answer = { option: oid };
      curOptionId = oid;
      continue;
    }
    if (Q_NOTE_RE.test(l)) {
      const bodyLine = l.replace(/^\s+-\s*/, '');
      const [note] = parseAgentNotes(bodyLine);
      if (note) {
        const opts = note.options.length ? note.options : (curOptionId ? [curOptionId] : []);
        agentNotes.push({ ...note, options: opts });
      }
      continue;
    }
    // unrecognised line inside the block: ignore (keeps the parser lenient for hand edits).
  }
  return { blocks, options, agentNotes, answer };
}

// ---------------------------------------------------------------------------

/**
 * Parse a markdown document.
 * @param {string} text
 * @param {{path?: string, doc?: 'prd'|'spec'}} opts
 */
export function parse(text, opts = {}) {
  const docPath = opts.path || 'document.md';
  const doc = opts.doc || docTypeFromPath(docPath);
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');

  const model = { doc, path: docPath, title: '', meta: {}, blocks: [], layout: {}, diagrams: [] };

  // 1. Split into top-level sections (## headings). Lines before the first ## are the preamble.
  const sections = [];
  let cur = { id: 'pre', kind: 'section', title: '', level: 1, line: 1, lines: [], children: [] };
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) inFence = !inFence;
    const hm = !inFence && HEADING_RE.exec(line);
    if (hm && hm[1].length === 1 && !model.title) { model.title = hm[2].trim(); cur.lines.push(line); continue; }
    if (hm && hm[1].length === 2) {
      sections.push(cur);
      const title = hm[2].trim();
      cur = { id: sectionId(title, sections.length), kind: 'section', title, level: 2, line: i + 1, lines: [], children: [] };
      continue;
    }
    cur.lines.push(line);
  }
  sections.push(cur);

  // 2. Preamble: meta table.
  const pre = sections[0];
  const preBlocks = parseBlocks(pre.lines, pre.line + 1, 'pre', doc);
  const metaTable = preBlocks.find(b => b.kind === 'table');
  if (metaTable) {
    for (const row of metaTable.children) {
      const key = row.cells[0].replace(/\*\*/g, '').replace(/:$/, '').trim().toLowerCase();
      const val = (row.cells[1] ?? '').trim();
      if (key) model.meta[key] = val;
    }
  }
  model.metaRaw = { ...model.meta };
  model.meta = normalizeMeta(model.meta, doc);
  model.preamble = preBlocks.filter(b => b !== metaTable);

  // 3. Body sections.
  const usedIds = new Set(['pre']);
  for (let s = 1; s < sections.length; s++) {
    const sec = sections[s];
    while (usedIds.has(sec.id)) sec.id = sec.id + 'x';
    usedIds.add(sec.id);
    sec.children = parseBlocks(sec.lines, sec.line + 1, sec.id, doc);
    sec.hash = hash(sec.title);
    delete sec.lines;
    model.blocks.push(sec);
  }

  // 4. Make ids unique (a duplicated item id gets a numeric suffix), then diagrams, layout, derived meta.
  const seen = new Set();
  for (const b of collect(model.blocks)) {
    if (seen.has(b.id)) { let k = 2; while (seen.has(`${b.id}~${k}`)) k++; b.id = `${b.id}~${k}`; }
    seen.add(b.id);
  }
  annotateAncestry(model.blocks, []);
  model.diagrams = collect(model.blocks).filter(b => b.kind === 'diagram').map(b => b.id);
  model.layout = buildLayout(model, doc);
  deriveMeta(model, doc);
  return model;
}

/**
 * Post-pass: give every block a `path` (labels of its ancestors, outermost first — the breadcrumb a
 * note carries so an agent can find the block) and give containers (sections, groups, tables, items)
 * an `endLine` covering their last descendant. Returns the subtree's last line.
 */
function annotateAncestry(blocks, path) {
  let last = 0;
  for (const b of blocks || []) {
    b.path = path;
    const label = b.kind === 'section' || b.kind === 'group' ? b.title : b.kind === 'item' ? b.id : b.kind === 'table' ? `table (${(b.header || []).slice(0, 3).join(' | ')})` : null;
    const childPath = label != null ? [...path, label] : path;
    let end = b.endLine ?? b.line ?? 0;
    if (b.children) end = Math.max(end, annotateAncestry(b.children, childPath));
    if (b.parts) end = Math.max(end, annotateAncestry(b.parts, childPath));
    if (b.endLine == null || end > b.endLine) b.endLine = end;
    last = Math.max(last, end);
  }
  return last;
}

function sectionId(title, n) {
  const m = /^(\d+)[.)]?\s+/.exec(title);
  if (m) return 's' + m[1];
  const known = {
    'decision log': 'slog', 'dependencies': 'sdeps', 'open questions': 'squestions', 'clarification log': 'sclog',
    'readiness': 'sready', 'toolchain conformance': 'stool', 'architecture': 'sarch', 'scope': 'sscope',
  };
  const k = title.toLowerCase().replace(/[^a-z ]/g, '').trim();
  if (known[k]) return known[k];
  return 's-' + slugify(title).slice(0, 24) + (n > 20 ? n : '');
}

/**
 * Parse the lines of one section into blocks. `startLine` is the 1-based line
 * number of lines[0].
 */
function parseBlocks(lines, startLine, secId, doc, depth = 0) {
  const blocks = [];
  const counters = { p: 0, b: 0, c: 0, t: 0, h: 0 };
  let i = 0;
  let group = null; // { id, kind:'group', title, children }
  const push = (b) => (group ? group.children : blocks).push(b);

  while (i < lines.length) {
    const line = lines[i];
    const ln = startLine + i;
    if (line.trim() === '') { i++; continue; }

    // Sub-heading (### ...) => sub-section. In a spec, `### AC-n [status]` is a per-AC block.
    const hm = HEADING_RE.exec(line);
    if (hm && hm[1].length >= 3) {
      const raw = hm[2].trim();
      const idm = /^\*{0,2}([A-Z]{1,4}-\d+)\*{0,2}(.*)$/.exec(raw);
      let j = i + 1;
      const sub = [];
      while (j < lines.length && !(HEADING_RE.test(lines[j]) && HEADING_RE.exec(lines[j])[1].length <= hm[1].length)) { sub.push(lines[j]); j++; }
      counters.h++;
      if (idm) {
        const { status, text } = stripTag(idm[2]);
        const item = { id: idm[1], kind: 'item', status: status || 'open', md: (idm[1] + text).trim(), line: ln, endLine: ln + sub.length, hash: hash(text) };
        attachParts(item, parseBlocks(sub, ln + 1, idm[1], doc, depth + 1));
        push(item);
      } else {
        const sec = { id: `${secId}.${counters.h}`, kind: 'section', title: raw, level: hm[1].length, line: ln, hash: hash(raw), children: parseBlocks(sub, ln + 1, `${secId}.${counters.h}`, doc, depth + 1) };
        push(sec);
      }
      i = j;
      continue;
    }

    // Fenced code block.
    if (FENCE_RE.test(line)) {
      let j = i + 1;
      while (j < lines.length && !FENCE_RE.test(lines[j])) j++;
      counters.c++;
      const md = lines.slice(i, Math.min(j + 1, lines.length)).join('\n');
      push({ id: `${secId}.c${counters.c}`, kind: 'code', md, line: ln, endLine: startLine + j, hash: hash(md) });
      i = j + 1;
      continue;
    }

    // Diagram link line.
    const dm = DIAGRAM_RE.exec(line);
    if (dm) {
      const file = dm[1];
      const name = diagramName(file);
      push({ id: `diagram:${name}`, kind: 'diagram', name, file, line: ln, endLine: ln, md: line.trim(), hash: hash(file) });
      i++;
      continue;
    }

    // `**Q-n**` question block: consume contiguous non-blank lines until a
    // blank line, a heading, or the next `**Q-` line.
    const qm = Q_HEAD_RE.exec(line);
    if (qm) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '' && !HEADING_RE.test(lines[j]) && !Q_HEAD_RE.test(lines[j])) j++;
      const body = lines.slice(i + 1, j);
      const parsed = parseQuestionList(qm[1], qm[2] ? qm[2].toLowerCase() : null, qm[3].trim(), body);
      const md = lines.slice(i, j).join('\n');
      // The notes are part of the hash: losing a question's advice has to read as a
      // change, not as a no-op the diff and the repair pass both miss.
      const hashSrc = parsed.blocks.join(',') + '\n' + qm[3].trim() + '\n'
        + parsed.options.map(o => `${o.id}:${o.text}${o.recommended ? '*' : ''}`).join('\n') + '\n'
        + parsed.agentNotes.map(noteKey).join('\n');
      push({
        id: qm[1], kind: 'question', kindTag: qm[2] ? qm[2].toLowerCase() : null, question: qm[3].trim(),
        blocks: parsed.blocks, options: parsed.options, agentNotes: parsed.agentNotes, answer: parsed.answer,
        advised: isAdvised(parsed), userRaised: isUserRaised(parsed),
        legacy: false, line: ln, endLine: startLine + j - 1, md, hash: hash(hashSrc),
      });
      i = j;
      continue;
    }

    // Table.
    if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const header = splitRow(line);
      let j = i + 2;
      const rows = [];
      while (j < lines.length && TABLE_ROW_RE.test(lines[j])) { rows.push({ cells: splitRow(lines[j]), line: startLine + j }); j++; }
      counters.t++;
      const tid = depth === 0 ? `t${secId.replace(/^s/, '')}` : `${secId}.t${counters.t}`;
      const table = { id: counters.t > 1 && depth === 0 ? `${tid}.${counters.t}` : tid, kind: 'table', header, line: ln, endLine: startLine + j - 1, hash: hash(header.join('|')), children: [] };
      table.tableKind = tableKind(header);
      rows.forEach((r, k) => table.children.push(rowBlock(table, r, k + 1)));
      push(table);
      i = j;
      continue;
    }

    // Bold-only label line => opens a group (e.g. **In scope**, **Edge cases**).
    const lm = LABEL_RE.exec(line.trim());
    if (lm) {
      const label = lm[1].trim();
      const gid = groupId(secId, label);
      group = { id: gid, kind: 'group', title: label, line: ln, hash: hash(label), children: [] };
      blocks.push(group);
      i++;
      continue;
    }

    // List: each top-level bullet is a block; nested lines belong to it.
    const bm = BULLET_RE.exec(line);
    if (bm && bm[1].length <= 1) {
      let j = i + 1;
      const nested = [];
      while (j < lines.length) {
        const nl = lines[j];
        if (nl.trim() === '') { if (j + 1 < lines.length && /^\s{2,}\S/.test(lines[j + 1])) { nested.push(nl); j++; continue; } break; }
        if (/^\s{2,}\S/.test(nl)) { nested.push(nl); j++; continue; }
        break;
      }
      const head = bm[3];
      const idm = /^\*\*([A-Z]{1,4}-\d+)\*\*\s*(.*)$/.exec(head);
      const mdAll = [line, ...nested].join('\n');
      if (idm && (ITEM_ID_RE.test(idm[1]))) {
        const { status, text } = stripTag(idm[2]);
        const item = { id: idm[1], kind: 'item', status: status || 'open', line: ln, endLine: ln + nested.length };
        const parts = nested.length ? parseBlocks(dedent(nested), ln + 1, idm[1], doc, depth + 1) : [];
        const labelled = parts.filter(p => p.kind === 'bullet' && /^\*\*[^*]+\*\*/.test(p.md));
        if (doc === 'spec' && labelled.length >= 2) {
          item.md = text.trim();
          item.hash = hash(text);
          attachParts(item, parts);
        } else {
          item.md = [text, ...dedent(nested)].join('\n').trim();
          item.hash = hash(item.md);
        }
        push(item);
      } else {
        counters.b++;
        const md = [head, ...dedent(nested)].join('\n');
        push({ id: `${secId}.b${counters.b}`, kind: 'bullet', md, line: ln, endLine: ln + nested.length, hash: hash(md) });
      }
      i = j;
      continue;
    }

    // Paragraph: contiguous plain lines.
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== '' && !HEADING_RE.test(lines[j]) && !FENCE_RE.test(lines[j]) && !BULLET_RE.test(lines[j]) && !TABLE_ROW_RE.test(lines[j]) && !LABEL_RE.test(lines[j].trim()) && !DIAGRAM_RE.test(lines[j])) j++;
    counters.p++;
    const md = lines.slice(i, j).join('\n');
    push({ id: `${secId}.p${counters.p}`, kind: 'paragraph', md, line: ln, endLine: startLine + j - 1, hash: hash(md) });
    i = j;
  }
  return blocks;
}

function dedent(lines) {
  const indents = lines.filter(l => l.trim()).map(l => /^\s*/.exec(l)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map(l => l.slice(Math.min(min, /^\s*/.exec(l)[0].length)));
}

function groupId(secId, label) {
  const k = label.toLowerCase();
  if (k === 'in scope') return `${secId}.in`;
  if (k === 'out of scope') return `${secId}.out`;
  return `${secId}.${slugify(label).slice(0, 20)}`;
}

function diagramName(file) {
  const base = path.basename(file).replace(/\.excalidraw$/i, '');
  const parts = base.split('.');
  return parts.length > 1 ? parts[parts.length - 1] : base;
}

/** Spec per-AC parts: `**Decision:** …`, `**Implementation plan …:**`, `**Tests:**`, `**Depends on:**`. */
function attachParts(item, blocks) {
  const parts = [];
  const rest = [];
  for (const b of blocks) {
    const m = b.kind === 'bullet' || b.kind === 'paragraph' ? /^\*\*([^*]+?)\*\*:?\s*([\s\S]*)$/.exec(b.md) : null;
    if (!m) { rest.push(b); continue; }
    const label = m[1].replace(/:$/, '').trim();
    const key = partKey(label);
    const { status, text } = stripTag(m[2]);
    parts.push({ id: `${item.id}.${key}`, kind: 'part', label, key, status: status || 'open', md: text.trim(), line: b.line, endLine: b.endLine, hash: hash(text) });
  }
  if (parts.length) item.parts = parts;
  if (rest.length) item.children = rest;
}

function partKey(label) {
  const k = label.toLowerCase();
  if (k.startsWith('depends')) return 'depends';
  if (k.startsWith('decision')) return 'decision';
  if (k.startsWith('implementation')) return 'plan';
  if (k.startsWith('test')) return 'tests';
  return slugify(label).slice(0, 16);
}

function tableKind(header) {
  const h = header.map(c => c.toLowerCase().replace(/\*/g, '').trim());
  if (h.includes('question') && (h.includes('options') || h.includes('blocks') || h.includes('impact'))) return 'questions';
  if (h.includes('topic') && h.includes('decision')) return 'log';
  if (h[0] === 'adr' || h.includes('blocks readiness')) return 'adrs';
  if (h.includes('dimension') && h.includes('weight')) return 'confidence';
  return 'generic';
}

function rowBlock(table, row, n) {
  const first = row.cells[0]?.replace(/\*\*/g, '').trim() ?? '';
  const idm = ITEM_ID_RE.exec(first);
  const base = { kind: 'row', cells: row.cells, line: row.line, endLine: row.line, hash: hash(row.cells.join('|')) };
  if (table.tableKind === 'questions' && idm) {
    const col = (name) => table.header.findIndex(c => c.toLowerCase().replace(/\*/g, '').trim() === name);
    const qi = col('question'), bi = col('blocks'), oi = col('options'), ni = col('agent notes');
    const { kindTag, text } = questionKind(row.cells[qi] ?? '');
    const options = oi >= 0 ? parseOptions(row.cells[oi]) : [];
    const agentNotes = ni >= 0 ? parseAgentNotes(row.cells[ni]) : [];
    return {
      ...base,
      id: idm[1], kind: 'question', kindTag, question: text,
      blocks: (row.cells[bi] ?? '').split(/[,;]/).map(s => s.trim()).filter(s => s && s !== '—' && s !== '-'),
      options,
      agentNotes,
      answer: null,
      advised: isAdvised({ options, agentNotes }), userRaised: isUserRaised({ agentNotes }),
      legacy: true,
    };
  }
  if (idm && table.tableKind === 'log') return { ...base, id: idm[1] };
  return { ...base, id: `${table.id}.r${n}` };
}

// ---------------------------------------------------------------------------

function normalizeMeta(meta, doc) {
  const out = {
    status: meta.status || '',
    updated: meta.updated || '',
    created: meta.created || '',
    source: meta.source || meta['source prd'] || '',
  };
  const c = /(\d+(?:\.\d+)?)\s*%/.exec(meta.confidence || '');
  out.confidence = c ? Number(c[1]) : null;
  if (doc !== 'prd') {
    out.sourcePrd = meta['source prd'] || '';
    out.openAdrs = (meta['open adrs'] || '').split(/[,;]/).map(s => s.trim()).filter(s => s && !/^none$/i.test(s) && s !== '—');
  }
  return out;
}

export function collect(blocks, out = []) {
  for (const b of blocks || []) {
    out.push(b);
    if (b.children) collect(b.children, out);
    if (b.parts) collect(b.parts, out);
  }
  return out;
}

export function findBlock(model, id) {
  return collect(model.blocks).find(b => b.id === id) || null;
}

function findSection(model, matchers) {
  for (const m of matchers) {
    const hit = model.blocks.find(b => b.kind === 'section' && m.test(b.title));
    if (hit) return hit;
  }
  return null;
}

function buildLayout(model, doc) {
  const questions = findSection(model, [/open questions/i]);
  const scope = findSection(model, [/^\d+[.)]?\s*scope$/i, /^scope$/i]);
  const reqs = doc === 'prd' ? findSection(model, [/functional requirements/i, /requirements/i]) : findSection(model, [/per-ac/i, /implementation plan/i]);
  const acc = doc === 'prd' ? findSection(model, [/acceptance criteria/i]) : null;
  const overviewIds = doc === 'prd' ? [] : [];
  const used = new Set([questions?.id, scope?.id, reqs?.id, acc?.id].filter(Boolean));
  const details = model.blocks.filter(b => b.kind === 'section' && !used.has(b.id)).map(b => b.id);
  const scopeGroups = scope ? scope.children.filter(b => b.kind === 'group') : [];
  return {
    questions: questions?.id || null,
    scope: scope?.id || null,
    scopeIn: scopeGroups.find(g => g.id.endsWith('.in'))?.id || (scope && !scopeGroups.length ? scope.id : null),
    outOfScope: scopeGroups.find(g => g.id.endsWith('.out'))?.id || null,
    diagrams: model.diagrams,
    requirements: reqs?.id || null,
    acceptance: acc?.id || null,
    details,
    overview: overviewIds,
  };
}

function deriveMeta(model, doc) {
  const all = collect(model.blocks);
  const questions = all.filter(b => b.kind === 'question');
  model.meta.openQuestions = questions.length;
  model.meta.questionsWithoutOptions = questions.filter(q => !q.options.length).length;
  // The ids an advising run still owes. A `[user]` question is the user's own and
  // never counted; an option-less one is not advisable, so it is.
  model.meta.unadvised = questions.filter(q => !q.advised && !q.userRaised).map(q => q.id);
  model.meta.legacyQuestionTable = questions.some(q => q.legacy);
  if (doc === 'prd') {
    const weak = all.find(b => b.kind === 'paragraph' && /^\*\*weakest dimension/i.test(b.md));
    model.meta.weakest = weak ? weak.md.replace(/^\*\*weakest dimension:?\*\*:?\s*/i, '').trim() : '';
    const frs = all.filter(b => b.kind === 'item' && /^FR-/.test(b.id));
    model.meta.requirements = { total: frs.length, done: frs.filter(f => f.status === 'done').length, partly: frs.filter(f => f.status === 'partly').length };
    const acs = all.filter(b => b.kind === 'item' && /^AC-/.test(b.id));
    model.meta.acceptance = { total: acs.length, done: acs.filter(f => f.status === 'done').length, partly: acs.filter(f => f.status === 'partly').length };
    model.meta.readyThreshold = 90;
    model.meta.belowThreshold = model.meta.confidence == null || model.meta.confidence < 90;
  } else {
    const acs = all.filter(b => b.kind === 'item' && /^AC-/.test(b.id));
    const filled = (p) => p && p.md && p.md.split('\n').some(l => { const t = l.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').replace(/^[^:]{0,40}:\s*/, '').trim(); return t && !/^_?tbd_?$/i.test(t); });
    const covered = acs.filter(a => a.parts && filled(a.parts.find(p => p.key === 'plan')) && filled(a.parts.find(p => p.key === 'tests')));
    model.meta.acCoverage = { total: acs.length, covered: covered.length };
    model.meta.requirements = { total: acs.length, done: acs.filter(f => f.status === 'done').length, partly: acs.filter(f => f.status === 'partly').length };
    const adrTable = all.find(b => b.kind === 'table' && b.tableKind === 'adrs');
    if (adrTable) {
      model.meta.openAdrs = adrTable.children.filter(r => /proposed|rejected|missing/i.test(r.cells[1] || '')).map(r => r.cells[0].replace(/`/g, '').trim());
    }
    model.meta.belowThreshold = acs.length === 0 || covered.length < acs.length;
  }
  model.meta.inProgress = /in progress/i.test(model.meta.status || '') || !model.meta.status;
}
