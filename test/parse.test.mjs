// lib/parse.mjs - markdown to document model. Pure, no server, no fixtures written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  parse, collect, findBlock, STATUS_TAGS,
  docTypeFromPath, siblingPath, slugFromPath, stripTag,
} from '../lib/parse.mjs';
import { FIXTURES } from './helpers.mjs';

const PRD_PATH = 'specs/0099-mini.md';
const SPEC_PATH = 'specs/0099-mini-spec.md';
const prdText = fs.readFileSync(path.join(FIXTURES, '0099-mini.md'), 'utf8');
const specText = fs.readFileSync(path.join(FIXTURES, '0099-mini-spec.md'), 'utf8');

const prd = parse(prdText, { path: PRD_PATH });
const spec = parse(specText, { path: SPEC_PATH });
const byKind = (model, kind) => collect(model.blocks).filter(b => b.kind === kind);

test('the meta table, title and numbered sections come out of parse()', () => {
  assert.equal(prd.doc, 'prd');
  assert.equal(prd.title, 'PRD-0099 — Mini fixture');

  // The headerless two-column preamble table becomes meta, and is not a block.
  assert.equal(prd.meta.status, 'Draft');
  assert.equal(prd.meta.created, '2026-09-01');
  assert.equal(prd.meta.confidence, 72, 'the "72%" cell is read as a number');
  assert.equal(prd.metaRaw.confidence, '72%', 'metaRaw keeps the cell verbatim');
  assert.equal(byKind(prd, 'table').length, 0, 'the meta table must not also appear as a block');

  // `## 4. Domain Impact` -> id s4: the number, not the position, names the section.
  assert.deepEqual(prd.blocks.map(b => b.id), ['s1', 's4', 's5', 's7', 's11']);
  assert.equal(prd.blocks.find(b => b.id === 's4').title, '4. Domain Impact');

  // The spec side reads its own meta key and both templates share the shape.
  assert.equal(spec.doc, 'spec');
  assert.equal(spec.meta.sourcePrd, 'specs/0099-mini.md');
});

test('FR/AC ids carry their status tag, and an untagged requirement is open', () => {
  const items = Object.fromEntries(byKind(prd, 'item').map(b => [b.id, b.status]));
  assert.deepEqual(items, { 'FR-1': 'done', 'FR-2': 'partly', 'FR-3': 'open', 'AC-1': 'done', 'AC-2': 'open' });
  for (const s of Object.values(items)) assert.ok(STATUS_TAGS.includes(s));

  // The tag is stripped from the text, so it never leaks into the rendered body.
  assert.ok(!findBlock(prd, 'FR-1').md.includes('[done]'));
  assert.match(findBlock(prd, 'FR-1').md, /^The checkout shows a delivery date picker/);

  // AC children stay with their item.
  assert.match(findBlock(prd, 'AC-1').md, /\*\*Given\*\* a shopper on the confirm page/);

  assert.deepEqual(stripTag(' [partly] rest'), { status: 'partly', text: 'rest' });
  assert.deepEqual(stripTag('no tag here'), { status: null, text: 'no tag here' });

  // On the spec side the same tagging works at part level.
  assert.equal(findBlock(spec, 'AC-1').status, 'partly');
  assert.equal(findBlock(spec, 'AC-1.decision').status, 'done');
  assert.equal(findBlock(spec, 'AC-2.decision').status, 'open');
  assert.deepEqual(
    byKind(spec, 'part').filter(p => p.id.startsWith('AC-1.')).map(p => p.key),
    ['depends', 'decision', 'plan', 'tests'],
  );
});

test('a **Q-n** block yields its tag, Blocks line, options and per-option agent notes', () => {
  const q1 = findBlock(prd, 'Q-1');
  assert.equal(q1.kind, 'question');
  assert.equal(q1.legacy, false);
  assert.equal(q1.kindTag, 'adr', 'the [adr] tag sits on the question, not in its text');
  assert.equal(q1.question, 'Which calendar defines the non-working days?');
  assert.deepEqual(q1.blocks, ['FR-2', '§4']);

  assert.deepEqual(q1.options.map(o => o.id), ['A', 'B', 'C']);
  const recommended = q1.options.filter(o => o.recommended);
  assert.equal(recommended.length, 1, 'exactly one option may be recommended');
  assert.equal(recommended[0].id, 'A');
  assert.equal(recommended[0].text, 'The shipping country of the order', '"(recommended)" is stripped from the text');

  // An indented note belongs to the option it sits under.
  assert.deepEqual(q1.agentNotes.map(n => [n.agent, n.options]), [['pm', ['A']], ['architect', ['A']]]);
  assert.equal(q1.answer, null, 'an unticked question is unanswered');

  // A tick on one option is the answer.
  assert.deepEqual(findBlock(prd, 'Q-2').answer, { option: 'A' });
});

test('a Diagram: line becomes a diagram block named after the file', () => {
  assert.deepEqual(prd.diagrams, ['diagram:domain']);
  const d = findBlock(prd, 'diagram:domain');
  assert.equal(d.kind, 'diagram');
  assert.equal(d.file, 'specs/0099-mini.domain.excalidraw');
  assert.equal(d.name, 'domain');
  assert.equal(d.line, prdText.split('\n').findIndex(l => l.startsWith('Diagram:')) + 1);

  // The spec's own diagram is named from its own suffix, so the two never collide.
  assert.deepEqual(spec.diagrams, ['diagram:architecture']);
  assert.equal(findBlock(spec, 'diagram:architecture').file, 'specs/0099-mini-spec.architecture.excalidraw');
});

test('requirements inside a fenced code block are not parsed as requirements', () => {
  // The fixture's fence contains lines shaped exactly like FR-9 / AC-9.
  assert.ok(prdText.includes('**FR-9**'), 'the fixture must actually contain the decoy');
  assert.equal(findBlock(prd, 'FR-9'), null);
  assert.equal(findBlock(prd, 'AC-9'), null);

  const code = byKind(prd, 'code');
  assert.equal(code.length, 1);
  assert.match(code[0].md, /\*\*FR-9\*\* This line lives inside a fence/);
});

test('docTypeFromPath / siblingPath / slugFromPath round-trip both ways', () => {
  assert.equal(docTypeFromPath(PRD_PATH), 'prd');
  assert.equal(docTypeFromPath(SPEC_PATH), 'spec');

  assert.equal(siblingPath(PRD_PATH), SPEC_PATH);
  assert.equal(siblingPath(SPEC_PATH), PRD_PATH);
  assert.equal(siblingPath(siblingPath(PRD_PATH)), PRD_PATH, 'two hops return to the start');

  assert.equal(slugFromPath(PRD_PATH), '0099-mini');
  assert.equal(slugFromPath(SPEC_PATH), '0099-mini', 'both documents share one session slug');

  // parse() infers the type when the caller does not name it.
  assert.equal(parse(specText, { path: SPEC_PATH }).doc, 'spec');
});
