// lib/diagram.mjs - graph.json -> Excalidraw scene + SVG fallback.
// The contract worth pinning is determinism: the same graph must always produce
// the same bytes, or every regeneration shows up as a diff in the user's repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { layout, toExcalidraw, toSvg, defaultSvgPath, NODE_STYLES } from '../lib/diagram.mjs';
import { FIXTURES } from './helpers.mjs';

const graph = JSON.parse(fs.readFileSync(path.join(FIXTURES, '0099-mini.architecture.graph.json'), 'utf8'));

test('the scene is byte-identical across runs of the same graph', () => {
  const a = JSON.stringify(toExcalidraw(graph), null, 2);
  const b = JSON.stringify(toExcalidraw(JSON.parse(JSON.stringify(graph))), null, 2);
  assert.equal(a, b, 'nothing in the scene may depend on the clock or on iteration order');
  assert.equal(toSvg(graph), toSvg(graph));

  // Element ids derive from node ids, so a diff stays readable.
  const ids = toExcalidraw(graph).elements.map(e => e.id);
  assert.ok(ids.includes('n:order') && ids.includes('t:order'));
  assert.ok(ids.includes('g:shop') && ids.includes('gt:shop'));
  assert.ok(ids.includes('e:customer->order'));
  assert.equal(ids[0], 'title', 'the title element is written first');
  assert.equal(new Set(ids).size, ids.length, 'element ids are unique');
});

test('groups become columns in the order they are listed, ungrouped nodes trail them', () => {
  const l = layout(graph);
  assert.deepEqual(l.groups.map(g => g.id), ['shop', 'ext']);
  assert.ok(l.groups[0].x < l.groups[1].x, 'LR puts the first group left of the second');

  // Members sit inside their group's box.
  const inside = (n, g) => n.x >= g.x && n.x + n.w <= g.x + g.w && n.y >= g.y && n.y + n.h <= g.y + g.h;
  assert.ok(inside(l.nodes.get('customer'), l.groups[0]));
  assert.ok(inside(l.nodes.get('order'), l.groups[0]));
  assert.ok(inside(l.nodes.get('holiday'), l.groups[1]));

  // `mail` has no group, so it lands in a trailing column, right of every group.
  const mail = l.nodes.get('mail');
  assert.ok(mail.x > l.groups[1].x + l.groups[1].w, 'an ungrouped node trails the groups');
  assert.equal(mail.h, 96, 'an event node is taller than the others');

  // A group with no id is not a group.
  assert.deepEqual(layout({ ...graph, groups: [{ label: 'nameless' }] }).groups, []);
});

test('an unknown node type falls back to entity, and a dangling edge is dropped', () => {
  const l = layout(graph);
  assert.equal(l.nodes.get('legacy').type, 'entity', '"widget" is not a known type');
  assert.equal(NODE_STYLES.widget, undefined);

  const el = toExcalidraw(graph).elements.find(e => e.id === 'n:legacy');
  assert.equal(el.type, NODE_STYLES.entity.type);
  assert.equal(el.backgroundColor, NODE_STYLES.entity.bg);

  // The fixture points one edge at a node that does not exist.
  assert.ok(graph.edges.some(e => e.to === 'ghost'));
  assert.equal(l.edges.length, graph.edges.length - 1);
  assert.ok(!l.edges.some(e => e.to === 'ghost'));
  assert.ok(!toExcalidraw(graph).elements.some(e => e.id.includes('ghost')));

  // An empty graph still renders rather than throwing.
  const empty = toExcalidraw({});
  assert.equal(empty.elements.length, 0);
  assert.match(toSvg({}), /^<svg /);
});

test('SVG output escapes the characters that would break the markup', () => {
  const svg = toSvg(graph);
  assert.ok(graph.nodes.some(n => n.label === 'Tea & Coffee <legacy>'), 'the fixture must carry the decoy label');
  assert.ok(svg.includes('Tea &amp; Coffee &lt;legacy&gt;'), 'the label is escaped');
  assert.ok(!svg.includes('Tea & Coffee <legacy>'), 'the raw label never reaches the markup');

  // Titles, group labels, notes and edge labels go through the same escape.
  const nasty = toSvg({
    title: 'a & b', groups: [{ id: 'g', label: '<g>' }],
    nodes: [{ id: 'x', label: '"x"', group: 'g', note: 'a < b' }, { id: 'y', label: 'y' }],
    edges: [{ from: 'x', to: 'y', label: 'a & b' }],
  });
  for (const raw of ['<g>', 'a < b']) assert.ok(!nasty.includes(raw), `${raw} must be escaped`);
  assert.ok(nasty.includes('&lt;g&gt;') && nasty.includes('a &lt; b') && nasty.includes('&quot;x&quot;'));
});

test('defaultSvgPath puts the SVG in the document session folder, for PRD and spec alike', () => {
  assert.equal(
    defaultSvgPath('specs/0099-mini.domain.excalidraw'),
    path.join('specs', '.editor', '0099-mini', 'domain.svg'),
  );
  // The `-spec` suffix names the same session as the PRD it belongs to.
  assert.equal(
    defaultSvgPath('specs/0099-mini-spec.architecture.excalidraw'),
    path.join('specs', '.editor', '0099-mini', 'architecture.svg'),
  );
  // A name with no diagram suffix still lands somewhere sane.
  assert.equal(defaultSvgPath('specs/0099-mini.excalidraw'), path.join('specs', '.editor', '0099-mini', 'diagram.svg'));
});
