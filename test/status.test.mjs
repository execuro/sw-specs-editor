// lib/status.mjs - one-line status rewrites, and the snapshot/verify/repair pass
// that runs after an agent has edited the document.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setStatus, snapshot, verifyAndRepair, questionTableToList, setAnswer } from '../lib/status.mjs';
import { parse, collect, findBlock } from '../lib/parse.mjs';
import { FIXTURES } from './helpers.mjs';

const PRD_PATH = 'specs/0099-mini.md';
const SPEC_PATH = 'specs/0099-mini-spec.md';
const PRD_OPTS = { path: PRD_PATH, doc: 'prd' };
const SPEC_OPTS = { path: SPEC_PATH, doc: 'spec' };
const prdText = fs.readFileSync(path.join(FIXTURES, '0099-mini.md'), 'utf8');
const specText = fs.readFileSync(path.join(FIXTURES, '0099-mini-spec.md'), 'utf8');

const lines = s => s.split('\n');
/** Indices of the lines that differ between two texts of equal length. */
function diffLines(a, b) {
  const la = lines(a), lb = lines(b);
  assert.equal(la.length, lb.length, 'a status rewrite must not add or remove lines');
  const out = [];
  for (let i = 0; i < la.length; i++) if (la[i] !== lb[i]) out.push(i);
  return out;
}

test('setStatus rewrites exactly one line and leaves every other byte alone', () => {
  const r = setStatus(prdText, 'FR-3', 'done', PRD_OPTS);
  assert.equal(r.changed, true);

  const changed = diffLines(prdText, r.text);
  assert.equal(changed.length, 1, 'exactly one line may change');
  assert.match(lines(r.text)[changed[0]], /^- \*\*FR-3\*\* \[done\] The order confirmation email/);
  assert.equal(findBlock(parse(r.text, PRD_OPTS), 'FR-3').status, 'done');

  // Setting `open` removes the tag rather than writing "[open]".
  const cleared = setStatus(r.text, 'FR-3', 'open', PRD_OPTS);
  assert.equal(cleared.changed, true);
  assert.equal(cleared.text, prdText, 'done -> open returns the document to its original bytes');
  assert.ok(!cleared.text.includes('[open]'));

  // Re-setting the status it already has is a no-op.
  assert.equal(setStatus(prdText, 'FR-1', 'done', PRD_OPTS).changed, false);
});

test('an unknown block gives a reason, and an unknown status throws', () => {
  const r = setStatus(prdText, 'FR-404', 'done', PRD_OPTS);
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'block not found');
  assert.equal(r.text, prdText);

  // A block that exists but is not a requirement line cannot carry a status.
  const onSection = setStatus(prdText, 's5', 'done', PRD_OPTS);
  assert.equal(onSection.changed, false);
  assert.equal(onSection.reason, 'block not found');

  assert.throws(() => setStatus(prdText, 'FR-1', 'nearly', PRD_OPTS), /invalid status nearly/);
});

test('setStatus also rewrites a part-level **Decision:** line in a spec', () => {
  const r = setStatus(specText, 'AC-2.decision', 'partly', SPEC_OPTS);
  assert.equal(r.changed, true);

  const changed = diffLines(specText, r.text);
  assert.equal(changed.length, 1);
  assert.match(lines(r.text)[changed[0]], /^ {2}- \*\*Decision:\*\* \[partly\] _TBD_$/);
  assert.equal(findBlock(parse(r.text, SPEC_OPTS), 'AC-2.decision').status, 'partly');

  // The sibling AC is untouched.
  assert.equal(findBlock(parse(r.text, SPEC_OPTS), 'AC-1.decision').status, 'done');
});

test('verifyAndRepair restores a status tag and a Diagram line an agent dropped', () => {
  const snap = snapshot(prdText, PRD_OPTS);
  assert.equal(snap.statuses['FR-1'], 'done');
  assert.equal(snap.statuses['FR-3'], undefined, 'only non-open statuses are worth restoring');
  assert.deepEqual(snap.diagrams.map(d => d.id), ['diagram:domain']);
  assert.deepEqual(snap.answers['Q-2'], { option: 'A' });
  assert.equal(snap.legacyQuestionTable, false);

  // An agent rewrites the document and loses the tag, the diagram line and the tick.
  const mangled = prdText
    .replace('- **FR-1** [done] ', '- **FR-1** ')
    .replace('Diagram: specs/0099-mini.domain.excalidraw\n', '')
    .replace('- [x] A: Yes, under the delivery address', '- [ ] A: Yes, under the delivery address');
  const mangledModel = parse(mangled, PRD_OPTS);
  assert.equal(findBlock(mangledModel, 'FR-1').status, 'open');
  assert.deepEqual(mangledModel.diagrams, []);

  const r = verifyAndRepair(mangled, snap, PRD_OPTS);
  const repaired = parse(r.text, PRD_OPTS);
  assert.equal(findBlock(repaired, 'FR-1').status, 'done');
  assert.deepEqual(repaired.diagrams, ['diagram:domain']);
  assert.equal(findBlock(repaired, 'diagram:domain').file, 'specs/0099-mini.domain.excalidraw');
  assert.deepEqual(findBlock(repaired, 'Q-2').answer, { option: 'A' });

  assert.deepEqual(r.repairs, [
    'restored [done] on FR-1',
    'restored diagram line specs/0099-mini.domain.excalidraw',
    'restored answer on Q-2',
  ]);

  // A clean document needs no repairs at all.
  assert.deepEqual(verifyAndRepair(prdText, snap, PRD_OPTS).repairs, []);

  // A block the agent deliberately deleted is not resurrected.
  const dropped = prdText.replace(/^- \*\*FR-1\*\* \[done\].*\n/m, '');
  assert.deepEqual(verifyAndRepair(dropped, snap, PRD_OPTS).repairs.filter(x => x.includes('FR-1')), []);
});

test('verifyAndRepair puts back the advice a run dropped from a question', () => {
  const snap = snapshot(prdText, PRD_OPTS);

  // The run rewrote the section and lost both the mark and the notes behind it.
  const stripped = prdText.replace(/^ {2}- \[(?:pm|architect)\].*\n/gm, '').replace(' (recommended)', '');
  assert.equal(findBlock(parse(stripped, PRD_OPTS), 'Q-1').advised, false);

  const r = verifyAndRepair(stripped, snap, PRD_OPTS);
  assert.deepEqual(r.repairs, ['restored (recommended) and 2 agent notes on Q-1']);
  const q1 = findBlock(parse(r.text, PRD_OPTS), 'Q-1');
  assert.equal(q1.advised, true);
  assert.equal(q1.options.find(o => o.recommended).id, 'A');
  assert.deepEqual(q1.agentNotes.map(n => [n.agent, n.options]), [['pm', ['A']], ['architect', ['A']]],
    'each note lands back under the option it judges');

  // Idempotent, and a question the run answered away is not resurrected.
  assert.deepEqual(verifyAndRepair(r.text, snap, PRD_OPTS).repairs, []);
  const removed = prdText.replace(/\*\*Q-1\*\*[\s\S]*?\n\n/, '');
  assert.deepEqual(verifyAndRepair(removed, snap, PRD_OPTS).repairs.filter(x => x.includes('Q-1')), []);
});

test('the own-answer line goes below an option and its notes, never between them', () => {
  const doc = [
    '# T', '', '## 11. Open Questions', '',
    '**Q-5** Which source?',
    '- [ ] A: One (recommended)',
    '  - [pm] cheapest',
    '- [ ] B: Two',
    '  - [pm] costs a second lookup',
    '',
  ].join('\n');
  const r = setAnswer(doc, 'Q-5', { text: 'neither' }, PRD_OPTS);
  assert.equal(r.changed, true);
  const q5 = findBlock(parse(r.text, PRD_OPTS), 'Q-5');
  assert.deepEqual(q5.answer, { text: 'neither' });
  assert.deepEqual(q5.agentNotes.map(n => n.options), [['A'], ['B']],
    "the last option's notes stay its own instead of drifting onto the recommended one");
});

test('the legacy conversion keeps the stance of every note', () => {
  const converted = questionTableToList(specText, SPEC_OPTS).text;
  assert.match(converted, /^ {2}- \[pm\] Recommends A: matches how tax is already resolved$/m);
  assert.equal(findBlock(parse(converted, SPEC_OPTS), 'Q-1').agentNotes[0].stance, 'recommends',
    'the recommends/against verb survives the round trip');
});

test('questionTableToList converts a legacy table and is idempotent', () => {
  const before = parse(specText, SPEC_OPTS);
  assert.ok(collect(before.blocks).some(b => b.kind === 'table' && b.tableKind === 'questions'));
  assert.ok(collect(before.blocks).filter(b => b.kind === 'question').every(q => q.legacy));

  const first = questionTableToList(specText, SPEC_OPTS);
  assert.equal(first.changed, true);

  const after = parse(first.text, SPEC_OPTS);
  const questions = collect(after.blocks).filter(b => b.kind === 'question');
  assert.deepEqual(questions.map(q => q.id), ['Q-1', 'Q-2']);
  assert.ok(questions.every(q => q.legacy === false), 'every question is now a block, not a row');
  assert.ok(!collect(after.blocks).some(b => b.kind === 'table' && b.tableKind === 'questions'));

  // The content survives the conversion: tag, Blocks, options, the recommendation
  // and each agent note on the option it judged.
  const q1 = findBlock(after, 'Q-1');
  assert.equal(q1.kindTag, 'adr');
  assert.deepEqual(q1.blocks, ['FR-2', 'AC-2']);
  assert.deepEqual(q1.options.map(o => o.id), ['A', 'B', 'C']);
  assert.equal(q1.options.find(o => o.recommended).id, 'A');
  assert.deepEqual(q1.agentNotes.map(n => [n.agent, n.options]), [['pm', ['A']], ['architect', ['C']]]);
  assert.equal(findBlock(after, 'Q-2').options.length, 0, 'a question with no options converts too');

  // Idempotent: there is no table left to convert.
  const second = questionTableToList(first.text, SPEC_OPTS);
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);

  // And the converted questions can now be ticked, which the table form could not.
  const answered = setAnswer(first.text, 'Q-1', { option: 'B' }, SPEC_OPTS);
  assert.equal(answered.changed, true);
  assert.deepEqual(findBlock(parse(answered.text, SPEC_OPTS), 'Q-1').answer, { option: 'B' });
  assert.equal(setAnswer(specText, 'Q-1', { option: 'B' }, SPEC_OPTS).reason, 'legacy question table');
});
