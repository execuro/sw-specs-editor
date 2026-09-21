// Status-tag rewrite on a single line, plus snapshot / verify / repair of what an agent run dropped.
import { parse, collect, findBlock, STATUS_TAGS } from './parse.mjs';

const TAG_AFTER_BOLD_ID = /^(\s*(?:[-*+]|\d+[.)])\s+\*\*[A-Z]{1,4}-\d+\*\*)(\s*\[(?:done|partly|open)\])?/;
const TAG_AFTER_HEADING_ID = /^(#{3,6}\s+\*{0,2}[A-Z]{1,4}-\d+\*{0,2})(\s*\[(?:done|partly|open)\])?/;
const TAG_AFTER_BOLD_LABEL = /^(\s*(?:[-*+]|\d+[.)])?\s*\*\*[^*]+?\*\*:?)(\s*\[(?:done|partly|open)\])?/;

/**
 * Rewrite the status tag of block `id` in `text`. `status` in done|partly|open;
 * `open` removes the tag. Returns the new text (unchanged if the block is unknown).
 */
export function setStatus(text, id, status, opts = {}) {
  if (!STATUS_TAGS.includes(status)) throw new Error(`invalid status ${status}`);
  const model = parse(text, opts);
  const block = findBlock(model, id);
  if (!block || !block.line || !['item', 'part'].includes(block.kind)) return { text, changed: false, reason: 'block not found' };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const idx = block.line - 1;
  const line = lines[idx];
  const re = block.kind === 'part' ? TAG_AFTER_BOLD_LABEL : (/^#{3,6}\s/.test(line) ? TAG_AFTER_HEADING_ID : TAG_AFTER_BOLD_ID);
  const m = re.exec(line);
  if (!m) return { text, changed: false, reason: 'line shape not recognised' };
  const rest = line.slice(m[0].length);
  const tag = status === 'open' ? '' : ` [${status}]`;
  lines[idx] = m[1] + tag + (tag || rest.startsWith(' ') ? rest : ' ' + rest).replace(/^\s{2,}/, ' ');
  return { text: lines.join('\n'), changed: lines[idx] !== line };
}

// ---------------------------------------------------------------------------
// Snapshot before a run; verify and repair after it.

export function snapshot(text, opts = {}) {
  const model = parse(text, opts);
  const statuses = {};
  const diagrams = [];
  const answers = {};
  const advice = {};
  const srcLines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  for (const b of collect(model.blocks)) {
    if ((b.kind === 'item' || b.kind === 'part') && b.status && b.status !== 'open') statuses[b.id] = b.status;
    if (b.kind === 'diagram') diagrams.push({ id: b.id, file: b.file, section: sectionOf(model, b.id), line: b.md });
    if (b.kind === 'question' && !b.legacy && b.answer) answers[b.id] = b.answer;
    // Advice is expensive to produce - an agent had to be asked for it - and a
    // rewrite of the block loses it silently, so it is snapshotted with the
    // original note lines and restored verbatim.
    if (b.kind === 'question' && !b.legacy && (b.agentNotes?.length || b.options?.some(o => o.recommended))) {
      advice[b.id] = {
        recommended: b.options.find(o => o.recommended)?.id || null,
        notes: noteLinesOf(b, srcLines),
      };
    }
  }
  const qTable = collect(model.blocks).find(b => b.kind === 'table' && b.tableKind === 'questions');
  return {
    statuses,
    diagrams,
    answers,
    advice,
    legacyQuestionTable: Boolean(qTable),
    hashes: Object.fromEntries(collect(model.blocks).map(b => [b.id, b.hash])),
  };
}

const NOTE_LINE_RE = /^\s+-\s*\[/;

/** The block's agent-note lines as they stand in the file, each with its host option. */
function noteLinesOf(block, lines) {
  const out = [];
  const start = block.line - 1;
  const end = Math.min(block.endLine, lines.length);
  let host = null;
  let k = 0;
  for (let i = start; i < end; i++) {
    const l = lines[i];
    const om = Q_OPTION_LINE_RE.exec(l);
    if (om) { host = om[4].toUpperCase(); continue; }
    if (Q_OWN_LINE_RE.test(l)) { host = null; continue; }
    if (NOTE_LINE_RE.test(l)) {
      const n = block.agentNotes[k++];
      if (n) out.push({ raw: l, option: (n.options || [])[0] || host || null, agent: n.agent, text: n.text });
    }
  }
  return out;
}

function sectionOf(model, id) {
  for (const s of model.blocks) if (collect([s]).some(b => b.id === id)) return s.id;
  return null;
}

/**
 * Compare the file after a run with the snapshot; re-insert dropped status tags,
 * diagram lines and answer ticks, and convert a legacy question table.
 * @returns {{text: string, repairs: string[]}}
 */
export function verifyAndRepair(text, snap, opts = {}) {
  const repairs = [];
  let out = text;
  if (!snap) return { text, repairs };

  // 1. Status tags
  for (const [id, status] of Object.entries(snap.statuses || {})) {
    const model = parse(out, opts);
    const b = findBlock(model, id);
    if (!b) continue; // block removed by the agent: nothing to restore
    if (b.status !== status && b.status === 'open') {
      const r = setStatus(out, id, status, opts);
      if (r.changed) { out = r.text; repairs.push(`restored [${status}] on ${id}`); }
    }
  }

  // 2. Diagram lines
  for (const d of snap.diagrams || []) {
    const model = parse(out, opts);
    if (findBlock(model, d.id)) continue;
    const sec = model.blocks.find(s => s.id === d.section) || null;
    const lines = out.replace(/\r\n?/g, '\n').split('\n');
    let at = lines.length;
    if (sec) {
      const next = model.blocks[model.blocks.indexOf(sec) + 1];
      at = next ? next.line - 1 : lines.length;
      while (at > sec.line && lines[at - 1].trim() === '') at--;
    }
    lines.splice(at, 0, '', d.line);
    out = lines.join('\n');
    repairs.push(`restored diagram line ${d.file}`);
  }

  // 3. Legacy question table -> question blocks. Nothing writes a table any more;
  //    this only migrates documents that still carry one.
  if (snap.legacyQuestionTable) {
    const r = questionTableToList(out, opts);
    if (r.changed) { out = r.text; repairs.push('converted the question table to blocks'); }
  }

  // 4. Answers dropped by the run
  for (const [id, answer] of Object.entries(snap.answers || {})) {
    const model = parse(out, opts);
    const b = findBlock(model, id);
    if (!b || b.kind !== 'question' || b.legacy) continue; // question removed or now legacy: nothing to restore
    if (!b.answer) {
      const r = setAnswer(out, id, answer, opts);
      if (r.changed) { out = r.text; repairs.push(`restored answer on ${id}`); }
    }
  }

  // 5. Advice dropped by the run: the `(recommended)` mark and the agent notes.
  //    The run may legitimately have deleted the question (it was answered) or
  //    rewritten its options; only what is still there is restored.
  for (const [id, adv] of Object.entries(snap.advice || {})) {
    const r = restoreAdvice(out, id, adv, opts);
    if (r.changed) { out = r.text; repairs.push(r.repair); }
  }

  return { text: out, repairs };
}

/**
 * Put back a `(recommended)` mark and any agent notes the run dropped from question
 * `id`. One-line-insert style, like `setAnswer`: nothing else in the block is touched.
 */
export function restoreAdvice(text, id, adv, opts = {}) {
  const model = parse(text, opts);
  const b = findBlock(model, id);
  if (!b || b.kind !== 'question' || b.legacy) return { text, changed: false };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const start = b.line - 1;
  let end = Math.min(b.endLine, lines.length);
  let changed = false;
  let marked = false;

  if (adv.recommended && !b.options.some(o => o.recommended) && b.options.some(o => o.id === adv.recommended)) {
    for (let i = start; i < end; i++) {
      const om = Q_OPTION_LINE_RE.exec(lines[i]);
      if (om && om[4].toUpperCase() === adv.recommended) { lines[i] = lines[i].replace(/\s+$/, '') + ' (recommended)'; changed = true; marked = true; break; }
    }
  }

  const have = new Set((b.agentNotes || []).map(n => `${n.agent}|${n.text}`));
  const missing = (adv.notes || []).filter(n => !have.has(`${n.agent}|${n.text}`));
  for (const n of missing) {
    let at = start + 1;
    if (Q_BLOCKS_LINE_RE.test(lines[at] || '')) at++;
    if (n.option) {
      for (let i = start; i < end; i++) {
        const om = Q_OPTION_LINE_RE.exec(lines[i]);
        if (om && om[4].toUpperCase() === n.option) { at = i + 1; break; }
      }
    }
    while (at < end && NOTE_LINE_RE.test(lines[at])) at++;
    lines.splice(at, 0, n.raw);
    end++;
    changed = true;
  }
  if (!changed) return { text, changed: false };
  const what = [marked ? '(recommended)' : null, missing.length ? `${missing.length} agent note${missing.length > 1 ? 's' : ''}` : null].filter(Boolean).join(' and ');
  return { text: lines.join('\n'), changed: true, repair: `restored ${what} on ${id}` };
}

/** A note's body, keeping the stance and the option ids the table spelled out. */
function noteBody(n) {
  const stance = n.stance ? n.stance.charAt(0).toUpperCase() + n.stance.slice(1) : '';
  const ids = (n.options || []).join(', ');
  if (stance && ids) return `${stance} ${ids}: ${n.text}`;
  if (ids) return `${ids}: ${n.text}`;
  return n.text;
}

/** Markdown for one converted question block (options + notes only; `Blocks:` line if present). */
function questionBlockMarkdown(row) {
  const lines = [];
  lines.push(('**' + row.id + '**' + (row.kindTag ? ` [${row.kindTag}]` : '') + ' ' + row.question).trim());
  if (row.blocks && row.blocks.length) lines.push(`Blocks: ${row.blocks.join(', ')}`);
  const recommended = row.options.find(o => o.recommended);
  const byOption = new Map(row.options.map(o => [o.id, []]));
  const questionNotes = [];
  for (const n of row.agentNotes || []) {
    const targets = (n.options || []).filter(id => byOption.has(id));
    if (targets.length) targets.forEach(id => byOption.get(id).push(n));
    else if (recommended) byOption.get(recommended.id).push(n);
    else questionNotes.push(n);
  }
  for (const n of questionNotes) lines.push(`  - [${n.agent}] ${noteBody(n)}`);
  for (const o of row.options) {
    lines.push(`- [ ] ${o.id}: ${o.text}${o.recommended ? ' (recommended)' : ''}`);
    for (const n of byOption.get(o.id)) lines.push(`  - [${n.agent}] ${noteBody(n)}`);
  }
  return lines.join('\n');
}

/**
 * Rewrite the questions table into the `**Q-n**` list format. Idempotent: no
 * table in the document -> unchanged.
 */
export function questionTableToList(text, opts = {}) {
  const model = parse(text, opts);
  const t = collect(model.blocks).find(b => b.kind === 'table' && b.tableKind === 'questions');
  if (!t) return { text, changed: false };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const before = lines.slice(0, t.line - 1);
  const after = lines.slice(t.endLine);
  const blocksMd = t.children.map(questionBlockMarkdown).join('\n\n');
  const out = [...before, blocksMd, ...after].join('\n');
  return { text: out, changed: true };
}

const Q_OPTION_LINE_RE = /^(-\s*\[)([ xX])(\]\s*)([A-Za-z0-9]{1,3})([:.)]\s*)(.*)$/;
const Q_OWN_LINE_RE = /^(-\s*\[)([ xX])(\]\s*✎\s*)(.*)$/;
const Q_BLOCKS_LINE_RE = /^Blocks:/i;

/**
 * Tick/untick the answer on question `id`: `{option}` ticks that option and clears any
 * own-answer line; `{text}` writes/updates the `- [x] ✎ …` line and untick every option;
 * `null` clears both. One-line-rewrite style, like `setStatus`.
 */
export function setAnswer(text, id, answer, opts = {}) {
  const model = parse(text, opts);
  const block = findBlock(model, id);
  if (!block || block.kind !== 'question') return { text, changed: false, reason: 'block not found' };
  if (block.legacy) return { text, changed: false, reason: 'legacy question table' };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const start = block.line - 1;
  const end = Math.min(block.endLine, lines.length);
  let changed = false;
  let ownIdx = -1;
  let lastTopLevelIdx = start;
  for (let idx = start; idx < end; idx++) {
    const l = lines[idx];
    if (Q_BLOCKS_LINE_RE.test(l)) { lastTopLevelIdx = idx; continue; }
    const om = Q_OPTION_LINE_RE.exec(l);
    if (om) {
      lastTopLevelIdx = idx;
      const want = answer && answer.option && om[4].toUpperCase() === String(answer.option).toUpperCase() ? 'x' : ' ';
      if (om[2] !== want) { lines[idx] = om[1] + want + om[3] + om[4] + om[5] + om[6]; changed = true; }
      continue;
    }
    const wm = Q_OWN_LINE_RE.exec(l);
    if (wm) { ownIdx = idx; lastTopLevelIdx = idx; }
  }
  if (answer && answer.option) {
    if (ownIdx >= 0) { lines.splice(ownIdx, 1); changed = true; }
  } else if (answer && typeof answer.text === 'string') {
    const wantLine = `- [x] ✎ ${answer.text}`;
    if (ownIdx >= 0) { if (lines[ownIdx] !== wantLine) { lines[ownIdx] = wantLine; changed = true; } }
    else {
      // Past the last top-level line AND its indented agent notes: inserting between
      // an option and its notes would orphan them onto the recommended option.
      let at = lastTopLevelIdx + 1;
      while (at < end && /^\s+-\s*\[/.test(lines[at])) at++;
      lines.splice(at, 0, wantLine); changed = true;
    }
  } else if (ownIdx >= 0) {
    lines.splice(ownIdx, 1); changed = true;
  }
  if (!changed) return { text, changed: false };
  return { text: lines.join('\n'), changed: true };
}
