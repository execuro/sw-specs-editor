// lib/diff.mjs - old model vs new model -> the ids the page highlights.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { diff, hashMap, touched } from '../lib/diff.mjs';
import { parse } from '../lib/parse.mjs';
import { FIXTURES } from './helpers.mjs';

const OPTS = { path: 'specs/0099-mini.md', doc: 'prd' };
const text = fs.readFileSync(path.join(FIXTURES, '0099-mini.md'), 'utf8');
const model = t => parse(t, OPTS);

test('editing one requirement reports exactly that id as changed', () => {
  const edited = text.replace(
    'The order confirmation email states the chosen delivery date.',
    'The order confirmation email states the chosen delivery date in bold.',
  );
  const d = diff(model(text), model(edited));
  assert.deepEqual(d.changed, ['FR-3']);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(touched(model(text), model(edited)), ['FR-3']);

  // Whitespace-only noise is normalised away, so it is not a change.
  assert.deepEqual(diff(model(text), model(text.replace('- **FR-3** ', '- **FR-3**  '))).changed, []);

  // A document compared with itself has nothing in any bucket.
  assert.deepEqual(diff(model(text), model(text)), { changed: [], added: [], removed: [] });
});

test('added and removed requirements land in their own buckets', () => {
  const edited = text
    .replace(/^- \*\*FR-2\*\* \[partly\].*\n/m, '')
    .replace(
      '- **FR-3** The order confirmation email states the chosen delivery date.',
      '- **FR-3** The order confirmation email states the chosen delivery date.\n- **FR-4** The account order list shows the delivery date.',
    );
  const d = diff(model(text), model(edited));
  assert.deepEqual(d.removed, ['FR-2']);
  assert.deepEqual(d.added, ['FR-4']);
  assert.deepEqual(d.changed, [], 'the surviving requirements are untouched');

  // `touched` is what the page highlights: changed plus added, never removed.
  assert.deepEqual(touched(model(text), model(edited)), ['FR-4']);
});

test('a null model on either side is safe', () => {
  const m = model(text);
  assert.equal(hashMap(null).size, 0);
  assert.equal(hashMap(undefined).size, 0);

  // Document created: everything is added.
  const created = diff(null, m);
  assert.deepEqual(created.changed, []);
  assert.deepEqual(created.removed, []);
  assert.ok(created.added.includes('FR-1') && created.added.includes('Q-1'));

  // Document deleted: everything is removed.
  const deleted = diff(m, null);
  assert.deepEqual(deleted.changed, []);
  assert.deepEqual(deleted.added, []);
  assert.deepEqual(deleted.removed.sort(), created.added.sort());

  assert.deepEqual(diff(null, null), { changed: [], added: [], removed: [] });
  assert.deepEqual(touched(null, null), []);
});
