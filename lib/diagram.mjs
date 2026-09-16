// Graph file -> Excalidraw scene (+ SVG fallback). Deterministic, dependency-free.
//
//   sw-specs-editor diagram <graph.json> <out.excalidraw> [--svg <out.svg>|auto|none]
//
// Layout: groups become columns (in listed order); ungrouped nodes get trailing
// columns by longest-path rank. Element ids derive from node/edge ids, seeds from
// a hash of the id, so the same graph always yields byte-identical output.

import * as out from './out.mjs';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';

export const NODE_STYLES = {
  entity: { type: 'rectangle', stroke: '#1e40af', bg: '#dbeafe' },
  actor: { type: 'ellipse', stroke: '#92400e', bg: '#fef3c7' },
  service: { type: 'rectangle', stroke: '#166534', bg: '#dcfce7' },
  external: { type: 'rectangle', stroke: '#4b5563', bg: '#f3f4f6', dashed: true },
  event: { type: 'diamond', stroke: '#c2410c', bg: '#ffedd5' },
  store: { type: 'rectangle', stroke: '#6b21a8', bg: '#f3e8ff', round: 12 },
};

const NODE_W = 180, NODE_H = 72, EVENT_H = 96, COL_GAP = 140, ROW_GAP = 44, GROUP_PAD = 28, GROUP_HEAD = 40, MARGIN = 40;

function seed(id) {
  let h = 2166136261;
  for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return (h % 2147483646) + 1;
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/** Compute positions. Returns { nodes: Map id->{x,y,w,h,...}, groups: [...], size } */
export function layout(graph) {
  const dir = (graph.direction || 'LR').toUpperCase();
  const nodes = (graph.nodes || []).map((n, i) => ({ ...n, i, type: NODE_STYLES[n.type] ? n.type : 'entity' }));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const edges = (graph.edges || []).filter(e => byId.has(e.from) && byId.has(e.to));

  // longest-path rank (cycles broken by input order)
  const rank = new Map(nodes.map(n => [n.id, 0]));
  const out = new Map(nodes.map(n => [n.id, []]));
  for (const e of edges) out.get(e.from).push(e.to);
  const state = new Map();
  const visit = (id, r) => {
    if (state.get(id) === 'active') return; // back edge
    if ((rank.get(id) || 0) < r) rank.set(id, r);
    if (state.get(id) === 'done' && (rank.get(id) || 0) >= r) return;
    state.set(id, 'active');
    for (const t of out.get(id)) visit(t, (rank.get(id) || 0) + 1);
    state.set(id, 'done');
  };
  for (const n of nodes) if (!state.has(n.id)) visit(n.id, 0);

  // columns
  const groups = (graph.groups || []).filter(g => g && g.id);
  const gIndex = new Map(groups.map((g, i) => [g.id, i]));
  const columns = new Map(); // col -> nodes[]
  const colOf = (n) => n.group && gIndex.has(n.group) ? gIndex.get(n.group) : groups.length + (rank.get(n.id) || 0);
  for (const n of nodes) { const c = colOf(n); if (!columns.has(c)) columns.set(c, []); columns.get(c).push(n); }
  const colKeys = [...columns.keys()].sort((a, b) => a - b);
  for (const k of colKeys) columns.get(k).sort((a, b) => (rank.get(a.id) - rank.get(b.id)) || (a.i - b.i));

  // geometry (LR: columns along x)
  const pos = new Map();
  const groupBoxes = [];
  let cursor = MARGIN;
  let maxCross = 0;
  for (const k of colKeys) {
    const list = columns.get(k);
    const isGroup = k < groups.length;
    let along = cursor + (isGroup ? GROUP_PAD : 0);
    let cross = MARGIN + (isGroup ? GROUP_HEAD : 0);
    let w = 0;
    for (const n of list) {
      const nh = n.type === 'event' ? EVENT_H : NODE_H;
      const box = dir === 'TB' ? { x: cross, y: along, w: NODE_W, h: nh } : { x: along, y: cross, w: NODE_W, h: nh };
      pos.set(n.id, { ...n, ...box });
      cross += (dir === 'TB' ? NODE_W : nh) + ROW_GAP;
      w = Math.max(w, dir === 'TB' ? nh : NODE_W);
    }
    cross -= ROW_GAP;
    if (isGroup) {
      const g = groups[k];
      const box = dir === 'TB'
        ? { x: MARGIN, y: cursor, w: cross - MARGIN + GROUP_PAD, h: w + 2 * GROUP_PAD + GROUP_HEAD }
        : { x: cursor, y: MARGIN, w: w + 2 * GROUP_PAD, h: cross - MARGIN + GROUP_PAD };
      groupBoxes.push({ ...g, ...box });
      cursor += (dir === 'TB' ? box.h : box.w) + COL_GAP;
    } else {
      cursor += w + COL_GAP;
    }
    maxCross = Math.max(maxCross, cross + GROUP_PAD);
  }
  const size = dir === 'TB' ? { w: maxCross + MARGIN, h: cursor - COL_GAP + MARGIN } : { w: cursor - COL_GAP + MARGIN, h: maxCross + MARGIN };
  if (!nodes.length) Object.assign(size, { w: 400, h: 120 });
  return { dir, nodes: pos, groups: groupBoxes, edges, size };
}

function edgeGeometry(l, e) {
  const a = l.nodes.get(e.from), b = l.nodes.get(e.to);
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  let s, t;
  if (Math.abs(bc.x - ac.x) >= Math.abs(bc.y - ac.y)) {
    s = bc.x >= ac.x ? { x: a.x + a.w, y: ac.y } : { x: a.x, y: ac.y };
    t = bc.x >= ac.x ? { x: b.x, y: bc.y } : { x: b.x + b.w, y: bc.y };
  } else {
    s = bc.y >= ac.y ? { x: ac.x, y: a.y + a.h } : { x: ac.x, y: a.y };
    t = bc.y >= ac.y ? { x: bc.x, y: b.y } : { x: bc.x, y: b.y + b.h };
  }
  return { s, t };
}

function base(id, type, x, y, w, h, extra = {}) {
  return {
    id, type, x: round(x), y: round(y), width: round(w), height: round(h), angle: 0,
    strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
    roughness: 0, opacity: 100, groupIds: [], frameId: null, index: null, roundness: null,
    seed: seed(id), version: 1, versionNonce: seed(id + '#n'), isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
    ...extra,
  };
}
function round(v) { return Math.round(v * 100) / 100; }

function text(id, str, x, y, w, h, extra = {}) {
  const fontSize = extra.fontSize || 16;
  const lines = String(str).split('\n');
  return base(id, 'text', x, y, w, h, {
    text: str, originalText: str, fontSize, fontFamily: 2, textAlign: 'center', verticalAlign: 'middle',
    containerId: null, lineHeight: 1.25, autoResize: true, baseline: fontSize, ...extra,
    height: round(h || lines.length * fontSize * 1.25),
  });
}

/** Build the Excalidraw scene object. */
export function toExcalidraw(graph) {
  const l = layout(graph);
  const els = [];
  for (const g of l.groups) {
    els.push(base(`g:${g.id}`, 'rectangle', g.x, g.y, g.w, g.h, { strokeColor: '#9ca3af', backgroundColor: '#f9fafb', strokeStyle: 'dashed', roundness: { type: 3 } }));
    els.push(text(`gt:${g.id}`, g.label || g.id, g.x + 12, g.y + 8, Math.min(g.w - 24, (g.label || g.id).length * 9), 20, { textAlign: 'left', verticalAlign: 'top', fontSize: 14, strokeColor: '#6b7280' }));
  }
  for (const n of l.nodes.values()) {
    const st = NODE_STYLES[n.type];
    const label = n.note ? `${n.label || n.id}\n${n.note}` : (n.label || n.id);
    const tid = `t:${n.id}`;
    els.push(base(`n:${n.id}`, st.type, n.x, n.y, n.w, n.h, {
      strokeColor: st.stroke, backgroundColor: st.bg, strokeStyle: st.dashed ? 'dashed' : 'solid',
      roundness: st.type === 'rectangle' ? { type: 3 } : null, boundElements: [{ type: 'text', id: tid }],
    }));
    els.push(text(tid, label, n.x + 10, n.y + 10, n.w - 20, n.h - 20, { containerId: `n:${n.id}`, fontSize: n.note ? 14 : 16 }));
  }
  l.edges.forEach((e, i) => {
    const { s, t } = edgeGeometry(l, e);
    const id = `e:${e.from}->${e.to}${i > 0 && l.edges.findIndex(x => x.from === e.from && x.to === e.to) !== i ? '#' + i : ''}`;
    const bound = e.label ? [{ type: 'text', id: `et:${id.slice(2)}` }] : null;
    els.push(base(id, 'arrow', s.x, s.y, Math.abs(t.x - s.x), Math.abs(t.y - s.y), {
      strokeColor: '#374151', points: [[0, 0], [round(t.x - s.x), round(t.y - s.y)]], lastCommittedPoint: null,
      startBinding: { elementId: `n:${e.from}`, focus: 0, gap: 4 }, endBinding: { elementId: `n:${e.to}`, focus: 0, gap: 4 },
      startArrowhead: null, endArrowhead: 'arrow', elbowed: false, boundElements: bound,
    }));
    if (e.label) {
      const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
      const w = Math.max(40, e.label.length * 7.5);
      els.push(text(`et:${id.slice(2)}`, e.label, mx - w / 2, my - 10, w, 20, { containerId: id, fontSize: 13, strokeColor: '#374151' }));
    }
  });
  for (const el of els) {
    if (el.type !== 'arrow' && el.type !== 'text') {
      for (const e of l.edges) {
        if (`n:${e.from}` === el.id || `n:${e.to}` === el.id) {
          const arrowId = els.find(a => a.type === 'arrow' && (a.startBinding.elementId === el.id || a.endBinding.elementId === el.id) && a.id.includes(`${e.from}->${e.to}`))?.id;
          if (arrowId) (el.boundElements ||= []).push({ type: 'arrow', id: arrowId });
        }
      }
      if (el.boundElements) el.boundElements = dedupe(el.boundElements);
    }
  }
  if (graph.title) els.unshift(text('title', graph.title, MARGIN, 8, Math.max(200, graph.title.length * 11), 24, { fontSize: 20, textAlign: 'left', verticalAlign: 'top' }));
  return { type: 'excalidraw', version: 2, source: 'specs-editor/cli diagram', elements: els, appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {} };
}

function dedupe(arr) { const seen = new Set(); return arr.filter(b => { const k = b.type + b.id; if (seen.has(k)) return false; seen.add(k); return true; }); }

/** Plain SVG rendering of the same layout (offline fallback). */
export function toSvg(graph) {
  const l = layout(graph);
  const o = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${l.size.w}" height="${l.size.h}" viewBox="0 0 ${l.size.w} ${l.size.h}" font-family="Helvetica, Arial, sans-serif" font-size="14">`);
  o.push('<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#374151"/></marker></defs>');
  o.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  if (graph.title) o.push(`<text x="${MARGIN}" y="26" font-size="18" fill="#111827">${esc(graph.title)}</text>`);
  for (const g of l.groups) {
    o.push(`<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="8" fill="#f9fafb" stroke="#9ca3af" stroke-dasharray="6 4"/>`);
    o.push(`<text x="${g.x + 12}" y="${g.y + 22}" fill="#6b7280">${esc(g.label || g.id)}</text>`);
  }
  for (const n of l.nodes.values()) {
    const st = NODE_STYLES[n.type];
    const dash = st.dashed ? ' stroke-dasharray="6 4"' : '';
    if (st.type === 'ellipse') o.push(`<ellipse cx="${n.x + n.w / 2}" cy="${n.y + n.h / 2}" rx="${n.w / 2}" ry="${n.h / 2}" fill="${st.bg}" stroke="${st.stroke}"${dash}/>`);
    else if (st.type === 'diamond') o.push(`<polygon points="${n.x + n.w / 2},${n.y} ${n.x + n.w},${n.y + n.h / 2} ${n.x + n.w / 2},${n.y + n.h} ${n.x},${n.y + n.h / 2}" fill="${st.bg}" stroke="${st.stroke}"${dash}/>`);
    else o.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${st.round || 6}" fill="${st.bg}" stroke="${st.stroke}"${dash}/>`);
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
    if (n.note) {
      o.push(`<text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="#111827">${esc(n.label || n.id)}</text>`);
      o.push(`<text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="12" fill="#4b5563">${esc(n.note)}</text>`);
    } else {
      o.push(`<text x="${cx}" y="${cy + 5}" text-anchor="middle" fill="#111827">${esc(n.label || n.id)}</text>`);
    }
  }
  for (const e of l.edges) {
    const { s, t } = edgeGeometry(l, e);
    o.push(`<line x1="${s.x}" y1="${s.y}" x2="${t.x}" y2="${t.y}" stroke="#374151" marker-end="url(#arr)"/>`);
    if (e.label) o.push(`<text x="${(s.x + t.x) / 2}" y="${(s.y + t.y) / 2 - 6}" text-anchor="middle" font-size="12" fill="#374151" style="paint-order:stroke" stroke="#ffffff" stroke-width="4">${esc(e.label)}</text>`);
  }
  o.push('</svg>');
  return o.join('\n') + '\n';
}

export function atomicWrite(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/** Default SVG location: specs/.editor/<slug>/<name>.svg next to the document's session folder. */
export function defaultSvgPath(outFile) {
  const dir = path.dirname(outFile);
  const baseName = path.basename(outFile).replace(/\.excalidraw$/i, '');
  const parts = baseName.split('.');
  const name = parts.length > 1 ? parts.pop() : 'diagram';
  const slug = parts.join('.').replace(/-spec$/i, '');
  return path.join(dir, '.editor', slug, `${name}.svg`);
}

const USAGE = 'usage: sw-specs-editor diagram <graph.json> <out.excalidraw> [--svg <out.svg>|auto|none]';

export function main(argv) {
  let svg = 'auto';
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--svg') svg = argv[++i];
    else if (argv[i].startsWith('--')) out.usage(`unknown flag ${argv[i]}\n${USAGE}`);
    else pos.push(argv[i]);
  }
  const [inFile, outFile] = pos;
  if (!inFile || !outFile) out.usage(USAGE);
  let graph;
  try {
    graph = JSON.parse(readFileSync(inFile, 'utf8'));
  } catch (e) {
    out.usage(`diagram: cannot read ${inFile} (${e.code === 'ENOENT' ? 'not found' : e.message})`);
  }
  atomicWrite(outFile, JSON.stringify(toExcalidraw(graph), null, 2) + '\n');
  const svgPath = svg === 'none' ? null : svg === 'auto' ? defaultSvgPath(outFile) : svg;
  if (svgPath) atomicWrite(svgPath, toSvg(graph));
  out.line('excalidraw', outFile);
  if (svgPath) out.line('svg', svgPath);
  out.line('nodes', String(graph.nodes?.length || 0));
  out.line('edges', String(graph.edges?.length || 0));
  out.nextStep('reference the diagram from the document, then continue the current step');
}
