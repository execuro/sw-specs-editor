// The three phases: the pure function as a table, and the `status` line it feeds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from '../lib/parse.mjs';
import { phases } from '../lib/phases.mjs';
import { hostRepo, run, field } from './helpers.mjs';

const PRD = 'specs/0099-mini.md';
const SPEC = 'specs/0099-mini-spec.md';

const prd = (status, confidence) => parse(
  `# PRD\n\n| | |\n| --- | --- |\n| **Status** | ${status} |\n${confidence != null ? `| **Confidence** | ${confidence}% |\n` : ''}\n## 5. Functional Requirements\n\n- **FR-1** The checkout shows a date.\n`,
  { path: PRD, doc: 'prd' });
const spec = (status, confidence, tag = '') => parse(
  `# Spec\n\n| | |\n| --- | --- |\n| **Status** | ${status} |\n${confidence != null ? `| **Confidence** | ${confidence}% |\n` : ''}| **Source PRD** | ${PRD} |\n\n## 3. Per-AC Implementation Plan\n\n- **AC-1**${tag ? ` [${tag}]` : ''} Show the picker.\n`,
  { path: SPEC, doc: 'spec' });

const READY_PRD = 'Ready for specification';
const READY_SPEC = 'Ready for implementation';
const states = r => r.phases.map(p => p.state).join(',');

const table = [
  { name: 'no PRD and no spec', in: {}, states: 'current,todo,todo', current: 1, next: null },
  { name: 'PRD at 70%', in: { prdModel: prd('In progress', 70) }, states: 'current,todo,todo', current: 1, next: `sw-design-requirements ${PRD}`, percent: [70, null, null] },
  { name: 'PRD ready and no spec', in: { prdModel: prd(READY_PRD, 93) }, states: 'done,next,todo', current: 2, next: `sw-design-solution ${PRD} --editor`, percent: [93, null, null] },
  { name: 'spec at 60%', in: { prdModel: prd(READY_PRD, 93), specModel: spec('In progress', 60) }, states: 'done,current,todo', current: 2, next: `sw-design-solution ${SPEC} --editor`, percent: [93, 60, null] },
  { name: 'spec ready with no tags', in: { prdModel: prd(READY_PRD, 93), specModel: spec(READY_SPEC, 95) }, states: 'done,done,next', current: 3, next: `sw-implement-feature ${SPEC}`, percent: [93, 95, null] },
  { name: 'spec with a [partly] tag', in: { prdModel: prd(READY_PRD, 93), specModel: spec(READY_SPEC, 95, 'partly') }, states: 'done,done,started', current: 3, next: null },
  { name: 'PRD not ready but a spec present', in: { prdModel: prd('In progress', 70), specModel: spec(READY_SPEC, 95) }, states: 'current,todo,todo', current: 1, next: `sw-design-requirements ${PRD}`, percent: [70, 95, null] },
  { name: 'orphan spec', in: { specModel: spec(READY_SPEC, 95) }, states: 'current,todo,todo', current: 1, next: null, note: 'PRD missing' },
  { name: 'verified file', in: { prdModel: prd(READY_PRD, 93), specModel: spec(READY_SPEC, 95), verified: true }, states: 'done,done,started', current: 3, next: null },
];

for (const row of table) {
  test(`phases: ${row.name}`, () => {
    const r = phases(row.in);
    assert.equal(states(r), row.states);
    assert.equal(r.current, row.current);
    assert.equal(r.next, row.next);
    assert.deepEqual(r.phases.map(p => p.n), [1, 2, 3]);
    assert.equal(r.phases[2].percent, null, 'phase 3 is never monitored');
    if (row.percent) assert.deepEqual(r.phases.map(p => p.percent), row.percent);
    if (row.note) assert.equal(r.phases[0].note, row.note);
  });
}

test('phases: the status string decides, not the percentage', () => {
  const r = phases({ prdModel: prd('In progress', 99) });
  assert.equal(r.phases[0].state, 'current');
  assert.equal(r.phases[0].percent, 99);
});

test('phases: a Windows-style model path still yields forward slashes', () => {
  const m = parse('# P\n\n| | |\n| --- | --- |\n| **Status** | Ready for specification |\n', { path: 'specs\\0099-mini.md', doc: 'prd' });
  assert.equal(phases({ prdModel: m }).next, `sw-design-solution ${PRD} --editor`);
});

test('status prints the phase line from the files with no server running', async t => {
  const root = hostRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = await run(['status', '--doc', PRD], root);
  assert.equal(r.code, 0);
  assert.equal(field(r.out, 'running'), 'false');
  assert.equal(field(r.out, 'phase'), '1 of 3 Design requirements 72%');

  const s = await run(['status', '--doc', SPEC], root);
  assert.equal(field(s.out, 'phase'), '1 of 3 Design requirements 72%');

  fs.writeFileSync(`${root}/${PRD}`, fs.readFileSync(`${root}/${PRD}`, 'utf8').replace('| **Status** | Draft |', '| **Status** | Ready for specification |'));
  const ready = await run(['status', '--doc', PRD], root);
  assert.equal(field(ready.out, 'phase'), '2 of 3 Design solution current');
});
