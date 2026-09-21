/* Specs Editor page - vanilla JS, no build step. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- state
  // One session, one editable document - the `{prd, spec}` maps this page used to
  // carry are what let a note or a tick reach the other one. `reference` says
  // where the sibling is, never what is in it.
  const S = {
    session: null, doc: 'prd', path: '', model: null, reference: null,
    notes: [], chat: [], changed: new Set(), lock: null,
    queuedWrites: 0, agent: { present: false, everPolled: false }, run: null, queue: [], closed: false, serverGone: false,
    diagrams: new Map(), tab: Math.random().toString(36).slice(2, 10), diagramState: {},
    annotate: false, openNotes: new Set(), ownPending: new Set(), ownFocus: null, queuedOpen: true,
  };
  const ANNOTATE_KEY = 'specs-editor:annotate';
  const RUN_TIP = 'Reconciling the document with its sub-agents\u2019 consensus - this usually takes 7-10 minutes.';
  const $ = (sel, el = document) => el.querySelector(sel);
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v; else if (k === 'dataset') Object.assign(n.dataset, v); else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v != null) n.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------------------------------------------------------------- markdown (raw HTML disabled)
  const renderer = new marked.Renderer();
  renderer.html = ({ text }) => esc(text);
  marked.use({ renderer, gfm: true, breaks: false });
  const md = (text) => { try { return marked.parse(String(text ?? '')); } catch { return esc(text); } };
  const mdInline = (text) => { try { return marked.parseInline(String(text ?? '')); } catch { return esc(text); } };
  function linkifyIds(html) {
    return html.replace(/(^|[\s(>])((?:FR|BR|AC|Q|C|D)-\d+(?:\.[a-z]+)?)(?=[\s.,;:)<]|$)/g, (m, pre, id) => `${pre}<a class="blocklink" href="#${id}" data-goto="${id}">${id}</a>`);
  }

  // ---------------------------------------------------------------- api
  async function api(path, body, method) {
    const r = await fetch(path, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 202) throw new Error(j.error || `HTTP ${r.status}`);
    j._status = r.status;
    return j;
  }

  // ---------------------------------------------------------------- helpers over the model
  function allBlocks(model, out = []) {
    for (const b of (model?.blocks || [])) walk(b, out);
    return out;
  }
  function walk(b, out) { out.push(b); (b.children || []).forEach(c => walk(c, out)); (b.parts || []).forEach(c => walk(c, out)); }
  function findBlock(id) { return allBlocks(S.model).find(b => b.id === id) || null; }
  function findByHash(hash) { return hash ? allBlocks(S.model).find(b => b.hash === hash) || null : null; }
  function blockText(b) {
    if (!b) return '';
    if (b.kind === 'question') return b.question;
    if (b.kind === 'row') return b.cells.join(' | ');
    if (b.kind === 'section' || b.kind === 'group') return b.title;
    if (b.kind === 'diagram') return b.file;
    return b.md || '';
  }
  /** Markdown-ish source of a block, what the agent gets to recognise and rework it. */
  function blockMarkdown(b) {
    if (!b) return '';
    if (b.kind === 'question') return b.md || ('| ' + (b.cells || []).join(' | ') + ' |');
    if (b.kind === 'row') return '| ' + (b.cells || []).join(' | ') + ' |';
    if (b.kind === 'section' || b.kind === 'group') return b.title;
    if (b.kind === 'table') return '| ' + (b.header || []).join(' | ') + ' |';
    return b.md || '';
  }
  /**
   * Locator every block-bound note carries - id, breadcrumb and line range: enough for the design skill
   * to find the block by path + line range, verify by md/hash, and fall back to the quote if lines shifted.
   */
  function noteContext(block) {
    return {
      doc: S.doc, file: S.path || S.model?.path || null,
      block: block.id, blockKind: block.kind, path: (block.path || []).join(' › '),
      line: block.line ?? null, endLine: block.endLine ?? block.line ?? null, hash: block.hash,
      quote: blockText(block).slice(0, 200), md: blockMarkdown(block).slice(0, 2000),
    };
  }
  function docLabel(doc = S.doc) {
    const n = (S.session?.slug || '').match(/^\d+/)?.[0] || '';
    return doc === 'prd' ? (n ? `PRD-${n}` : 'PRD') : (n ? `Spec ${n}` : 'Tech spec');
  }

  /** Ticks/unticks the answer in the file to match the note; best effort, ignored on failure or while queued (202). */
  function syncAnswer(id, answer) {
    const body = { id, ...(answer && answer.option ? { option: answer.option } : answer && answer.text != null ? { text: answer.text } : {}) };
    api('/api/answer', body).catch(() => {});
  }

  // ---------------------------------------------------------------- notes
  function noteFor(block) { return S.notes.find(n => n.block === block && n.kind !== 'answer'); }
  function addNote(n) {
    n.id = n.id || 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    if (n.kind === 'answer') S.notes = S.notes.filter(x => !(x.kind === 'answer' && x.block === n.block));
    S.notes.push(n);
    S.queuedOpen = true;
    saveNotes(); renderQueued(); markNoted();
  }
  let saveTimer = null;
  function saveNotes() { clearTimeout(saveTimer); saveTimer = setTimeout(() => api('/api/notes', { notes: S.notes, tab: S.tab }).catch(() => {}), 400); }
  function rebindNotes() {
    for (const n of S.notes) {
      if (!n.block || n.kind === 'free') continue;
      if (!S.model) { n.missing = true; continue; }
      const hit = findByHash(n.hash) || findBlock(n.block);
      if (hit) { Object.assign(n, noteContext(hit)); n.missing = false; continue; }
      n.missing = true;
    }
  }
  function markNoted() {
    document.querySelectorAll('.blk.noted, tr.noted').forEach(e => e.classList.remove('noted'));
    for (const n of S.notes) if (n.block) document.querySelectorAll(`[data-id="${CSS.escape(n.block)}"]`).forEach(e => e.classList.add('noted'));
  }
  function renderQueued() {
    const box = $('#queued'), host = $('#queued-list'), chat = $('#chat');
    const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 24;
    box.hidden = false;
    box.classList.toggle('collapsed', !S.queuedOpen);
    $('#queued-toggle').setAttribute('aria-expanded', String(S.queuedOpen));
    $('#queued-count').textContent = S.notes.length ? `(${S.notes.length})` : '';
    $('#queued-clear').hidden = !S.notes.length;
    host.innerHTML = '';
    if (!S.notes.length) host.append(el('div', { class: 'q-empty' }, 'No queued messages'));
    else for (const n of S.notes) host.append(queuedRow(n));
    if (atBottom) chat.scrollTop = chat.scrollHeight;
    updateSendButton();
  }
  function queuedRow(n) {
    const title = [n.missing ? 'block missing - the referenced block no longer exists' : null, n.path ? n.path + (n.line ? ` · L${n.line}${n.endLine && n.endLine !== n.line ? '–' + n.endLine : ''}` : '') : null, n.quote ? '“' + n.quote + '”' : null, n.selection].filter(Boolean).join('\n');
    const row = el('div', { class: 'q-row' + (n.missing ? ' missing' : ''), dataset: { nid: n.id }, title: title || null },
      n.missing ? el('span', { class: 'q-kind' }, '⚠') : null,
      n.block ? el('span', { class: 'q-ref', onclick: () => gotoBlock(n.block) }, n.block) : el('span', { class: 'q-kind' }, n.kind),
      n.option ? el('span', { class: 'q-kind' }, 'opt ' + n.option) : null,
      el('div', { class: 'q-text' }, n.text || (n.kind === 'answer' ? '(option only)' : '')),
      el('button', { class: 'q-x', type: 'button', title: 'Remove from the batch', onclick: () => removeQueued(n) }, '✕'));
    return row;
  }
  function removeQueued(n) {
    S.notes = S.notes.filter(x => x !== n);
    if (n.kind === 'answer' && n.block) syncAnswer(n.block, null);
    saveNotes(); renderQueued(); markNoted(); renderDoc();
  }
  function clearQueued() {
    if (!S.notes.length) return;
    if (!confirm(`Remove all ${S.notes.length} queued item(s)? Nothing is sent to the agent.`)) return;
    const gone = S.notes; S.notes = [];
    for (const n of gone) if (n.kind === 'answer' && n.block) syncAnswer(n.block, null);
    saveNotes(); renderQueued(); markNoted(); renderDoc();
  }
  function updateSendButton() {
    const b = $('#chat-send'), n = S.notes.length, text = ($('#chat-text') && $('#chat-text').value || '').trim();
    b.disabled = S.closed || (!n && !text);
    b.textContent = n ? `Send (${n})` : 'Send';
  }

  async function sendBatch(chatText) {
    const body = { notes: S.notes, chat: chatText || '', remaining: [] };
    if (!S.notes.length && !(chatText || '').trim()) return;
    if (!S.agent.present) {
      if (!confirm('The agent is not connected (no session loop polling). The batch will wait in the queue until the skill is (re)started. Send anyway?')) return;
    }
    try {
      const r = await api('/api/batch', body);
      S.notes = []; S.queuedOpen = true; saveNotes(); renderQueued(); markNoted();
      S.changed.clear();
      $('#chat-text').value = ''; $('#chat-text').style.height = '';
      renderDoc();
      return r;
    } catch (e) { alert('Send failed: ' + e.message); }
  }

  // ---------------------------------------------------------------- note popover (floats next to the annotated block)
  const pop = { open: false, id: null, ctx: null, existing: null, selection: '', selOffset: null };
  const popEl = () => $('#note-popover');
  function anchorEl() { return pop.id ? document.querySelector(`#doc [data-id="${CSS.escape(pop.id)}"]`) : null; }
  function closeNoteEditors() {
    const p = popEl();
    if (!pop.open) return;
    pop.open = false; p.hidden = true;
    document.querySelectorAll('#doc .anchored').forEach(e => e.classList.remove('anchored'));
  }
  /** extra: { selection, selOffset } — selOffset is the highlighted range's rect relative to the block, so the popover can follow the text. */
  function openNoteEditor(blockEl, block, extra = {}) {
    const p = popEl();
    if (pop.open && pop.id === block.id && !extra.selection) { p.querySelector('textarea').focus(); return; }
    closeNoteEditors();
    const existing = noteFor(block.id);
    const ctx = noteContext(block);
    Object.assign(pop, { open: true, id: block.id, ctx, existing, selection: extra.selection || '', selOffset: extra.selOffset || null });
    const meta = p.querySelector('.ne-ctx'); meta.innerHTML = '';
    meta.append(el('span', { class: 'id' }, block.id), el('span', { class: 'muted' }, ' ' + [ctx.path, ctx.line ? `L${ctx.line}${ctx.endLine !== ctx.line ? '–' + ctx.endLine : ''}` : ''].filter(Boolean).join(' · ')));
    const sel = p.querySelector('.ne-sel'); sel.hidden = !pop.selection; sel.textContent = pop.selection ? '“' + pop.selection + '”' : '';
    const ta = p.querySelector('textarea'); ta.value = existing ? existing.text : '';
    p.querySelector('.save').textContent = existing ? 'Update note' : 'Add note';
    p.querySelector('.delete').hidden = !existing;
    p.hidden = false;
    positionPopover();
    ta.focus();
  }
  function positionPopover() {
    const p = popEl();
    if (!pop.open) return;
    const a = anchorEl();
    if (!a) { closeNoteEditors(); return; }
    a.classList.add('anchored');
    const docR = $('#doc').getBoundingClientRect();
    const br = a.getBoundingClientRect();
    const r = pop.selOffset ? { left: br.left + pop.selOffset.dx, top: br.top + pop.selOffset.dy, width: pop.selOffset.w, height: pop.selOffset.h } : { left: br.left, top: br.top, width: br.width, height: br.height };
    r.right = r.left + r.width; r.bottom = r.top + r.height;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(420, vw - 16);
    p.style.width = w + 'px';
    const h = p.offsetHeight;
    const gap = 10;
    const fitsBelow = r.bottom + gap + h <= Math.min(vh, docR.bottom) - 8;
    const fitsAbove = r.top - gap - h >= Math.max(0, docR.top) + 8;
    let top, above = false;
    if (fitsBelow) top = r.bottom + gap;
    else if (fitsAbove) { top = r.top - gap - h; above = true; }
    else { top = Math.max(docR.top + 8, Math.min(r.bottom + gap, vh - h - 8)); }
    let left = Math.min(Math.max(8, r.left), vw - w - 8);
    if (pop.selOffset) left = Math.min(Math.max(8, r.left - 16), vw - w - 8);
    p.style.top = top + 'px'; p.style.left = left + 'px';
    p.classList.toggle('above', above);
    const arrow = p.querySelector('.arrow');
    const ax = Math.min(Math.max(14, r.left + Math.min(24, r.width / 2) - left), w - 26);
    arrow.style.left = ax + 'px';
    // anchor scrolled out of the document pane → tuck the popover to the pane edge but keep it visible
    p.classList.toggle('detached', r.bottom < docR.top || r.top > docR.bottom);
  }
  /**
   * Agent-note popovers are absolutely positioned against their own icon, and the
   * document pane clips horizontally - a popover that overflows it is lost, not
   * scrollable. Shift any that would fall outside the pane back inside it.
   */
  function clampAgentPops() {
    const host = $('#doc'); if (!host) return;
    const paneR = host.getBoundingClientRect();
    const left = paneR.left + 8, right = paneR.right - 8;
    for (const p of document.querySelectorAll('.agent-info.open .ai-pop')) {
      p.style.transform = '';                                  // measure unshifted
      p.style.maxWidth = Math.max(180, right - left) + 'px';
      const r = p.getBoundingClientRect();
      const dx = r.left < left ? left - r.left : r.right > right ? right - r.right : 0;
      if (dx) p.style.transform = `translateX(${Math.round(dx)}px)`;
    }
  }
  function savePopover() {
    const p = popEl();
    const text = p.querySelector('textarea').value.trim();
    if (!text) { p.querySelector('textarea').focus(); return; }
    if (pop.existing) { pop.existing.text = text; if (pop.selection) pop.existing.selection = pop.selection; Object.assign(pop.existing, pop.ctx); saveNotes(); renderQueued(); }
    else addNote({ kind: 'comment', ...pop.ctx, ...(pop.selection ? { selection: pop.selection } : {}), text });
    closeNoteEditors();
  }
  {
    const p = popEl();
    p.querySelector('.save').addEventListener('click', savePopover);
    p.querySelector('.cancel').addEventListener('click', closeNoteEditors);
    p.querySelector('.delete').addEventListener('click', () => {
      if (pop.existing) { S.notes = S.notes.filter(x => x !== pop.existing); saveNotes(); renderQueued(); markNoted(); }
      closeNoteEditors();
    });
    p.querySelector('textarea').addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); savePopover(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeNoteEditors(); }
    });
    $('#doc').addEventListener('scroll', positionPopover, { passive: true });
    window.addEventListener('resize', () => { positionPopover(); clampAgentPops(); });
    document.addEventListener('mousedown', (e) => {
      if (!pop.open || p.contains(e.target)) return;
      if (S.annotate && e.target.closest('#doc [data-id]')) return; // another block: mouseup re-opens on it
      closeNoteEditors();
    });
  }

  // ---------------------------------------------------------------- annotate mode (header switch; click any block to note it)
  const INTERACTIVE = 'a, button, input, textarea, select, label.option, .answer, .canvas, summary, .d-head .btn';
  let pressedBlock = null;
  function blockElAt(target) { return target.closest ? target.closest('#doc [data-id]') : null; }
  function setAnnotate(on, persist = true) {
    S.annotate = Boolean(on);
    document.body.classList.toggle('annotating', S.annotate);
    $('#annotate-toggle').checked = S.annotate;
    if (!S.annotate) closeNoteEditors();
    if (persist) { try { localStorage.setItem(ANNOTATE_KEY, S.annotate ? '1' : '0'); } catch { /* storage unavailable */ } }
  }
  function selectionInside(elm) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
    const range = sel.getRangeAt(0);
    if (!elm.contains(range.commonAncestorContainer)) return '';
    return sel.toString().trim().slice(0, 500);
  }
  $('#doc').addEventListener('mousedown', (e) => { pressedBlock = S.annotate && e.button === 0 ? blockElAt(e.target) : null; });
  $('#doc').addEventListener('mouseup', (e) => {
    if (!S.annotate || e.button !== 0) return;
    const blockEl = blockElAt(e.target);
    const pressed = pressedBlock; pressedBlock = null;
    if (!blockEl || blockEl !== pressed) return;
    if (e.target.closest(INTERACTIVE)) return;
    const block = findBlock(blockEl.dataset.id);
    if (!block) return;
    const selection = selectionInside(blockEl);
    let selOffset = null;
    if (selection) {
      const rr = window.getSelection().getRangeAt(0).getBoundingClientRect(), br = blockEl.getBoundingClientRect();
      if (rr.width || rr.height) selOffset = { dx: rr.left - br.left, dy: rr.top - br.top, w: rr.width, h: rr.height };
    }
    openNoteEditor(blockEl, block, selection ? { selection, selOffset } : {});
  });
  $('#annotate-toggle').addEventListener('change', (e) => setAnnotate(e.target.checked));
  document.addEventListener('keydown', (e) => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (e.key === 'Escape' && !inField) { if (pop.open) closeNoteEditors(); else if (S.annotate) setAnnotate(false); return; }
    if ((e.key === 'a' || e.key === 'A') && !inField && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); setAnnotate(!S.annotate); }
  });
  try { if (localStorage.getItem(ANNOTATE_KEY) === '1') setAnnotate(true, false); } catch { /* storage unavailable */ }

  // ---------------------------------------------------------------- block rendering
  function changedMark(id) { return S.changed.has(id) ? el('span', { class: 'changed-mark' }, 'changed') : null; }
  function blk(block, extraClass, ...content) {
    const d = el('div', { class: `blk ${block.kind} ${extraClass || ''}` + (S.changed.has(block.id) ? ' changed' : ''), dataset: { id: block.id, kind: block.kind } }, ...content);
    return d;
  }
  /** Read-only status label: the tag is set by agents and skills, never by hand in the page. */
  function statusToggle(block) {
    const s = block.status || 'open';
    return el('span', { class: 'status ' + s, title: `status: ${s} — updated automatically by the implementing/verifying agents` }, s);
  }
  function renderMd(text) { const d = el('div', { class: 'md' }); d.innerHTML = linkifyIds(md(text)); return d; }

  function renderBlock(block) {
    switch (block.kind) {
      case 'section': return renderSection(block, true);
      case 'group': {
        const g = el('div', { class: 'group' }, el('div', { class: 'group-title' }, block.title));
        block.children.forEach(c => g.append(renderBlock(c)));
        return g;
      }
      case 'item': return renderItem(block);
      case 'table': return renderTable(block);
      case 'question': return renderQuestion(block);
      case 'diagram': return blk(block, '', el('span', { class: 'muted' }, 'Diagram: '), el('a', { href: '#' + block.id, dataset: { goto: block.id } }, block.file), el('span', { class: 'muted' }, ' (shown in Diagrams)'));
      case 'code': { const b = blk(block, '', renderMd(block.md)); return b; }
      default: return blk(block, '', renderMd(block.md), changedMark(block.id));
    }
  }
  function renderSection(sec, nested) {
    const host = el('div', { class: nested ? 'subsection' : 'section-inner' });
    if (nested) host.append(el('h3', {}, sec.title));
    sec.children.forEach(c => host.append(renderBlock(c)));
    if (!sec.children.length) host.append(el('div', { class: 'muted' }, '(empty)'));
    return host;
  }
  function renderItem(block) {
    const body = el('div', { class: 'item-body' });
    body.innerHTML = linkifyIds(md(block.md || ''));
    const head = el('div', { class: 'item-head' }, el('span', { class: 'item-id' }, block.id), body, statusToggle(block), changedMark(block.id));
    const node = blk(block, '', head);
    if (block.parts) {
      const parts = el('div', { class: 'parts' });
      for (const p of block.parts) {
        const pb = el('div', { class: 'md' }); pb.innerHTML = linkifyIds(md(p.md || ''));
        // The label is a sub-header over its content, not a left column: a TDD plan or a
        // list of test files needs the full width, and reads top-to-bottom.
        parts.append(blk(p, 'part', el('div', { class: 'part-head' }, el('span', { class: 'part-label' }, p.label), statusToggle(p), changedMark(p.id)), pb));
      }
      node.append(parts);
    }
    if (block.children) block.children.forEach(c => node.append(renderBlock(c)));
    return node;
  }
  function renderTable(t) {
    const table = el('table', { class: 'blk-table', dataset: { id: t.id } });
    const thead = el('thead', {}, el('tr', {}, ...t.header.map(h => el('th', {}, h))));
    const tbody = el('tbody');
    for (const r of t.children) {
      const tr = el('tr', { class: 'row-blk blk' + (S.changed.has(r.id) ? ' changed' : ''), dataset: { id: r.id, kind: r.kind } });
      const cells = r.kind === 'question' ? [r.id, (r.kindTag ? `[${r.kindTag}] ` : '') + r.question, r.blocks.join(', '), r.options.map(o => `${o.id}: ${o.text}${o.recommended ? ' (recommended)' : ''}`).join('<br>'), r.agentNotes.map(n => `[${n.agent}] ${n.text}`).join('<br>')] : r.cells;
      for (const c of cells) { const td = el('td'); td.innerHTML = linkifyIds(mdInline(String(c).replace(/<br\s*\/?>/gi, '\n'))).replace(/\n/g, '<br>'); tr.append(td); }
      tbody.append(tr);
    }
    table.append(thead, tbody);
    return el('div', { class: 'table-wrap', style: 'overflow-x:auto' }, table);
  }

  /** Info icon carrying agent notes; collapsed unless the user opened this one before. */
  function agentInfo(notes, key) {
    const wrap = el('span', { class: 'agent-info' + (S.openNotes.has(key) ? ' open' : '') });
    const btn = el('button', {
      class: 'ai-btn', type: 'button', title: notes.map(n => `[${n.agent}] ${n.text}`).join('\n'),
      'aria-label': `Agent note from ${notes.map(n => n.agent).join(', ')}`,
      onclick: (e) => {
        e.preventDefault(); e.stopPropagation();
        if (S.openNotes.has(key)) S.openNotes.delete(key); else S.openNotes.add(key);
        wrap.classList.toggle('open', S.openNotes.has(key));
        clampAgentPops();
      },
    }, 'i');
    const pop = el('span', { class: 'ai-pop', onclick: (e) => { e.preventDefault(); e.stopPropagation(); } });
    for (const n of notes) {
      const d = el('span', { class: 'agent-note' });
      d.innerHTML = `<b>[${esc(n.agent)}]</b>${n.stance ? ` <i>${esc(n.stance)}</i>` : ''} ${mdInline(n.text)}`;
      pop.append(d);
    }
    wrap.append(btn, pop);
    return wrap;
  }

  function renderQuestion(q) {
    // Checked state: the pending note if there is one, else the tick already in the file.
    const noteAnswer = S.notes.find(n => n.kind === 'answer' && n.block === q.id);
    const answer = noteAnswer || (q.answer ? { option: q.answer.option, text: q.answer.text } : null);
    const card = el('div', { class: 'question blk' + (S.changed.has(q.id) ? ' changed' : ''), dataset: { id: q.id, kind: 'question' } });
    // Meta row (id · kind · blocks) above the full-width question text so long questions never get squeezed.
    const meta = el('div', { class: 'q-meta' }, el('span', { class: 'id' }, q.id));
    if (q.kindTag) meta.append(el('span', { class: 'badge' }, q.kindTag === 'adr' ? 'ADR decision' : 'readiness gate'));
    // An option with no notes looks exactly like one whose notes were lost, so the
    // question says it plainly: no agent has put a recommendation on this yet.
    if ((S.model?.meta?.unadvised || []).includes(q.id)) meta.append(el('span', { class: 'badge pending', title: 'No agent recommendation on this question yet' }, 'advice pending'));
    if (q.blocks.length) meta.append(el('span', { class: 'q-blocks' }, el('span', { class: 'lbl' }, 'blocks'), ...q.blocks.map(b => el('a', { href: '#' + b, dataset: { goto: b } }, b))));
    const cm = changedMark(q.id); if (cm) meta.append(cm);
    const text = el('div', { class: 'q-text' }); text.innerHTML = linkifyIds(mdInline(q.question));
    card.append(meta, text);
    let options = q.options;
    if (q.kindTag && !options.length) options = q.kindTag === 'adr' ? [{ id: 'A', text: 'Extract as ADR', recommended: true }, { id: 'B', text: 'Keep inside the spec' }] : [{ id: 'A', text: 'Wait for ADR decisions', recommended: true }, { id: 'B', text: 'Override - proceed with open ADRs' }];
    // Agent notes are hidden by default; each note is shown behind an info icon on
    // the option(s) it names. A note naming no option is adopted by the recommended
    // option — agents judge options, never the question — and only falls back to the
    // question head when the row has no recommended option to hang it on.
    const loose = q.agentNotes.filter(n => !(n.options || []).length);
    const host = loose.length ? options.find(o => o.recommended) : null;
    const notesFor = (id) => {
      const own = q.agentNotes.filter(n => (n.options || []).includes(id));
      return host && host.id === id ? [...own, ...loose] : own;
    };
    if (loose.length && !host) meta.append(agentInfo(loose, q.id + ':q'));
    const radioName = 'q-' + q.id;
    const list = el('div', { class: q.kindTag ? 'decision' : 'options' });
    for (const o of options) {
      const optText = el('span', { class: 'opt-text' }); optText.innerHTML = linkifyIds(mdInline(o.text));
      const opt = el('label', { class: 'option' + (answer?.option === o.id ? ' selected' : '') },
        el('input', { type: 'radio', name: radioName, value: o.id, ...(answer?.option === o.id ? { checked: '' } : {}), onchange: () => {
          S.ownPending.delete(q.id); S.ownFocus = null;
          addNote({ kind: 'answer', ...noteContext(q), option: o.id, text: `Chose option ${o.id}: ${o.text}` });
          syncAnswer(q.id, { option: o.id });
          renderDoc();
        } }),
        el('span', { class: 'opt-id' }, o.id), optText, o.recommended ? el('span', { class: 'rec' }, 'recommended') : el('span'));
      const on = notesFor(o.id);
      if (on.length) opt.append(agentInfo(on, q.id + ':' + o.id));
      list.append(opt);
    }
    // Own answer: one more radio in the same group, with an inline text field. Picking it drops a
    // chosen option; the answer note is written once the text is saved (Enter / Save / blur).
    const ownSelected = Boolean(answer && !answer.option);
    const ownKey = q.id;
    // "own picked, nothing typed yet" lives in S.ownPending so the server's doc event (which
    // re-renders the card after the tick is cleared in the file) does not bounce the radio back.
    const ownChecked = ownSelected || (!answer && S.ownPending.has(ownKey));
    const input = el('input', { type: 'text', class: 'own-input', placeholder: options.length ? 'Answer in your own words…' : 'Answer…', value: ownSelected ? (answer.text || '') : '' });
    const ownRadio = el('input', { type: 'radio', name: radioName, value: '_own', ...(ownChecked ? { checked: '' } : {}), onchange: () => {
      S.ownPending.add(ownKey); S.ownFocus = ownKey;
      if (answer && answer.option) {
        // Drop the chosen option: the note (if any), the tick in the file, and the local model.
        S.notes = S.notes.filter(x => x !== answer); q.answer = null; syncAnswer(q.id, null);
        saveNotes(); renderQueued(); markNoted(); renderDoc();
      }
      const again = document.querySelector(`#doc .question[data-id="${CSS.escape(q.id)}"] .own-input`);
      (again || input).focus();
    } });
    const saveOwn = () => {
      const text = input.value.trim();
      S.ownFocus = null;
      if (!text) { if (ownSelected) { S.ownPending.add(ownKey); S.notes = S.notes.filter(x => x !== answer); q.answer = null; syncAnswer(q.id, null); saveNotes(); renderQueued(); markNoted(); renderDoc(); } return; }
      if (ownSelected && text === (answer.text || '')) return;
      S.ownPending.delete(ownKey);
      addNote({ kind: 'answer', ...noteContext(q), text });
      syncAnswer(q.id, { text });
      renderDoc();
    };
    if (S.ownFocus === ownKey) queueMicrotask(() => { if (document.contains(input) && document.activeElement !== input) input.focus(); });
    const ownBtn = el('button', { class: 'btn sm', type: 'button', onclick: (e) => { e.preventDefault(); saveOwn(); } }, ownSelected ? 'Update' : 'Save');
    input.addEventListener('focus', () => { if (!ownRadio.checked) { ownRadio.checked = true; ownRadio.dispatchEvent(new Event('change')); } });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveOwn(); } });
    input.addEventListener('blur', () => { if (input.value.trim() && (!ownSelected || input.value.trim() !== answer.text)) saveOwn(); });
    const own = el('label', { class: 'option own' + (ownChecked ? ' selected' : '') }, ownRadio, el('span', { class: 'opt-id', title: 'your own answer' }, '✎'), input, ownBtn);
    list.append(own);
    card.append(list);
    if (answer) card.append(el('div', { class: 'answered' }, '✓ ' + (answer.option ? 'Option ' + answer.option + ' selected' : 'Own answer: ' + (answer.text || '')) + (noteAnswer ? ' · in notes' : ' · ticked in file')));
    return card;
  }

  function renderDiagram(block) {
    // One document per session, so the block id alone is unique - it used to be
    // prefixed with the document to keep the two apart in one page.
    const key = block.id;
    const wrap = el('div', { class: 'diagram blk', dataset: { id: block.id, kind: 'diagram' } });
    const svgRel = (S.session?.dir || '') + '/' + block.name + '.svg';
    const head = el('div', { class: 'd-head' }, el('span', { class: 'd-name' }, block.name), el('code', {}, block.file), el('span', { class: 'spacer' }),
      el('button', { class: 'btn sm', onclick: () => S.diagrams.get(key)?.handle?.reload() }, 'Reload'),
      el('button', { class: 'btn sm', onclick: () => {
        if (!confirm('Ask the agent to regenerate this diagram from its graph file? Manual edits in the canvas will be overwritten.')) return;
        const text = prompt('What should change in the diagram? (optional)', '') || '';
        addNote({ kind: 'diagram', ...noteContext(block), quote: block.file, text: 'regenerate' + (text ? ': ' + text : '') });
      } }, 'Ask agent to regenerate'), changedMark(block.id));
    const canvas = el('div', { class: 'canvas' });
    wrap.append(head, canvas);
    const prev = S.diagrams.get(key);
    if (prev?.handle) prev.handle.destroy();
    const handle = window.SpecsDiagram.mount(canvas, {
      file: block.file, svg: svgRel, doc: S.doc, id: block.id,
      onSave: async (scene, svg) => {
        const r = await api('/api/diagram', { id: block.id, scene, svg });
        if (r._status === 202) throw new Error('queued until the current run ends');
      },
      onState: (st) => { S.diagramState[key] = st; renderBanners(); },
    });
    S.diagrams.set(key, { handle, block });
    return wrap;
  }

  // ---------------------------------------------------------------- overview
  function renderOverview(model) {
    const m = model.meta;
    const ready = /ready/i.test(m.status || '');
    const kpi = (k, v, small) => el('div', { class: 'kpi' }, el('div', { class: 'k' }, k), el('div', { class: 'v' + (small ? ' small' : '') }, v));
    const grid = el('div', { class: 'overview' });
    grid.append(kpi('Status', el('span', { class: 'pill ' + (ready ? 'ready' : 'progress') }, m.status || 'unknown')));
    if (S.doc === 'prd') {
      grid.append(kpi('Confidence', m.confidence != null ? m.confidence + '%' : '—'));
      grid.append(kpi('Open questions', `${m.openQuestions}`));
      { // "Domain impact — long explanation" → tile shows the name, the explanation goes to a tooltip.
        const [name, ...rest] = String(m.weakest || '—').split(/\s+[—-]\s+/);
        const k = kpi('Weakest dimension', name, true); if (rest.length) { k.title = rest.join(' - '); k.classList.add('has-tip'); }
        grid.append(k);
      }
      grid.append(kpi('Requirements', `${m.requirements.done}/${m.requirements.total} done` + (m.requirements.partly ? ` · ${m.requirements.partly} partly` : '')));
    } else {
      grid.append(kpi('Readiness', ready ? 'Ready for implementation' : 'In progress', true));
      grid.append(kpi('Confidence', m.confidence != null ? m.confidence + '%' : '—'));
      grid.append(kpi('Open ADRs', (m.openAdrs || []).length ? m.openAdrs.map(a => a.replace(/^specs\//, '')).join(', ') : 'none', true));
      grid.append(kpi('Open questions', `${m.openQuestions}`));
      grid.append(kpi('AC coverage', `${m.acCoverage.covered}/${m.acCoverage.total} ACs with plan + tests`, true));
    }
    grid.append(kpi('Updated', m.updated || '—', true));
    return el('div', { class: 'card' }, el('h2', {}, 'Overview'), grid);
  }

  // ---------------------------------------------------------------- document
  function renderDoc() {
    const doc = S.doc;
    const model = S.model;
    const host = $('#doc');
    for (const [k, v] of S.diagrams) { v.handle?.destroy(); S.diagrams.delete(k); }
    const scrollY = host.scrollTop || window.scrollY;
    host.innerHTML = '';
    if (!model) {
      // No Create button: the tech spec is a separate session, started by the
      // user with its own command, so the page states the fact and stops.
      host.append(el('div', { class: 'card empty' }, doc === 'spec'
        ? `${S.path} does not exist yet. Ask the agent on this page to draft it, or close the session.`
        : `${S.path} not found.`));
      return;
    }
    const L = model.layout;
    const byId = (id) => id ? allBlocks(model).find(b => b.id === id) : null;
    host.append(el('h1', { class: 'doc-title' }, model.title || model.path));
    host.append(renderOverview(model));

    // Open questions
    const qs = allBlocks(model).filter(b => b.kind === 'question');
    const qCard = el('div', { class: 'card' }, el('h2', {}, 'Open questions', el('span', { class: 'count' }, `(${qs.length})`)));
    if (!qs.length) qCard.append(el('div', { class: 'muted' }, 'none'));
    qs.forEach(q => qCard.append(renderQuestion(q)));
    host.append(qCard);

    // Scope / out of scope
    const inScope = byId(L.scopeIn), outScope = byId(L.outOfScope);
    if (inScope) host.append(el('div', { class: 'card' }, el('h2', {}, 'Scope'), ...(inScope.children || []).map(c => renderBlock(c))));
    if (outScope) host.append(el('div', { class: 'card' }, el('h2', {}, 'Out of scope'), ...(outScope.children || []).map(c => renderBlock(c))));
    if (L.scope && !inScope && !outScope) { const s = byId(L.scope); host.append(el('div', { class: 'card' }, el('h2', {}, 'Scope'), renderSection(s, false))); }

    // Diagrams
    const dCard = el('div', { class: 'card' }, el('h2', {}, 'Diagrams'));
    const diagrams = allBlocks(model).filter(b => b.kind === 'diagram');
    if (!diagrams.length) dCard.append(el('div', { class: 'muted' }, doc === 'prd' ? 'No domain diagram linked yet - ask the agent for one ("add a domain model diagram").' : 'No architecture diagram linked yet - ask the agent for one.'));
    diagrams.forEach(d => dCard.append(renderDiagram(d)));
    host.append(dCard);

    // Requirements / per-AC
    const req = byId(L.requirements);
    if (req) host.append(el('div', { class: 'card' }, el('h2', {}, doc === 'prd' ? 'Requirements' : 'Per-AC implementation plan'), renderSection(req, false)));
    const acc = byId(L.acceptance);
    if (acc) host.append(el('div', { class: 'card' }, el('h2', {}, 'Acceptance criteria'), renderSection(acc, false)));

    // Details
    const det = el('details', { class: 'card' }, el('summary', {}, 'Details', el('span', { class: 'count' }, `(${L.details.length} sections)`)));
    if (S.detailsOpen) det.open = true;
    det.addEventListener('toggle', () => { S.detailsOpen = det.open; });
    for (const id of L.details) {
      const s = byId(id); if (!s) continue;
      const sub = el('div', { class: 'subsection blk', dataset: { id: s.id, kind: 'section' } }, el('h3', {}, s.title));
      s.children.forEach(c => sub.append(renderBlock(c)));
      det.append(sub);
    }
    host.append(det);
    markNoted();
    host.scrollTop = scrollY; window.scrollTo(0, scrollY);
    positionPopover(); clampAgentPops();
  }

  /**
   * The hand-off. A finished PRD names the command and stops there: the tech spec
   * is a separate session, and starting it from here is what used to mix the two
   * documents' histories. The trigger is the status the design skill wrote - the
   * page must not re-derive the rule behind it, and `^ready for specification`
   * keeps the spec's own "Ready for implementation" from lighting this.
   */
  function readyBanner() {
    if (S.doc !== 'prd' || !S.reference || !/^ready for specification/i.test(S.model?.meta?.status || '')) return null;
    return el('div', { class: 'banner good' },
      'Ready for Technical Specification. The tech spec is a separate session - run ',
      copyableCommand(`sw-design-solution ${S.reference.pathRel} --editor`),
      ' in your agent. This PRD session stays open.');
  }

  /** A command the user would otherwise retype. Copying it is not dispatching it. */
  function copyableCommand(cmd) {
    const code = el('code', { class: 'cmd', title: 'Click to copy', onclick: () => {
      navigator.clipboard?.writeText(cmd).then(() => { code.classList.add('copied'); setTimeout(() => code.classList.remove('copied'), 1200); }).catch(() => {});
    } }, cmd);
    return code;
  }

  function gotoBlock(id) {
    const target = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!target) { const det = $('details.card'); if (det && !det.open) { det.open = true; S.detailsOpen = true; return gotoBlock(id); } return; }
    const det = target.closest('details'); if (det) det.open = true;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash');
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-goto]');
    if (a) { e.preventDefault(); gotoBlock(a.dataset.goto); }
  });

  // ---------------------------------------------------------------- tabs, banners, header
  /** The header names the one document. It replaces the tab bar: there is no second tab. */
  function renderChip() {
    const host = $('#doc-chip'); host.innerHTML = '';
    const chip = el('div', { class: 'doc-chip-inner ' + S.doc, title: S.path }, docLabel());
    host.append(chip);
    document.title = `${docLabel()} · Specs Editor`;
  }
  function renderBanners() {
    const host = $('#banners'); host.innerHTML = '';
    if (S.closed) host.append(el('div', { class: 'banner bad' }, 'Session ended. Re-run the skill to open it again.'));
    else if (S.serverGone) host.append(el('div', { class: 'banner bad' }, 'Server unreachable - the session may have ended (heartbeat timeout or stop).'));
    if (S.lock) host.append(el('div', { class: 'banner info' }, `Agent working on ${docLabel()} - diagram saves and status updates are queued until the run ends.`));
    const ready = readyBanner(); if (ready) host.append(ready);
    // Only while no run is open: during a run the header already says "agent working",
    // and a disconnect banner next to it would contradict it. A run that has genuinely
    // lost its agent is recoverable through the Abort control below instead.
    if (!S.closed && !S.serverGone && !S.run && !S.agent.present && (S.agent.everPolled || uptimeSec() > (S.session?.agent?.timeout || 120))) host.append(el('div', { class: 'banner' }, 'Agent disconnected - re-run the skill on this document to resume. The page keeps working; batches wait in the queue.'));
    // Only once the server says the run has gone quiet (RUN_SILENCE, 15 min). A normal run
    // takes minutes and reports nothing between steps, so a banner tied to the 2-minute
    // presence dot would fire on every healthy run.
    if (!S.closed && !S.serverGone && S.run?.silent) host.append(el('div', { class: 'banner' },
      `No progress from the agent for ${Math.round((S.session?.runSilence || 900) / 60)} min. It may still be working on a long step - the editor waits as long as it takes. Abort only if you know its session was closed or interrupted. `,
      el('button', { class: 'btn sm', title: 'End this run so the document unlocks and your queued changes are applied; edits already written are kept', onclick: abortRun }, 'Abort run')));
    if (Object.values(S.diagramState).includes('fallback')) host.append(el('div', { class: 'banner' }, 'Offline - diagram shown as SVG.'));
    if (S.queuedWrites) { $('#queued-badge').hidden = false; $('#queued-badge').textContent = `${S.queuedWrites} queued`; } else $('#queued-badge').hidden = true;
    // Session dot = is there an agent session loop polling this server right now?
    //   green: agent connected and idle · yellow (pulsing): agent working on a batch · red: no agent polling, server gone or session closed
    const dot = $('#status-dot'), txt = $('#status-text');
    const state = S.closed || S.serverGone ? 'bad' : S.run ? 'busy' : S.agent.present ? 'ok' : 'bad';
    dot.className = 'dot ' + state;
    txt.className = 'muted ' + state;
    txt.textContent = S.closed ? 'session closed' : S.serverGone ? 'server unreachable'
      : S.run ? 'agent working' + (S.queue.length ? ` · ${S.queue.length} waiting` : '')
      : S.agent.present ? 'agent connected' : 'agent not connected';
    dot.title = txt.title = S.closed ? 'The session has ended.' : S.serverGone ? 'The editor server does not answer.'
      : S.run ? 'The agent session is processing a batch.'
      : S.agent.present ? 'The skill session loop is polling this server; notes you send are processed right away.'
      : 'No skill session loop is polling this server. Notes you send wait in the queue - re-run sw-specs-editor (or the design skill with --editor) on this document to resume.';
    updateSendButton();
  }
  function uptimeSec() { return S.session?.started ? (Date.now() - Date.parse(S.session.started)) / 1000 : 0; }
  // A batch is delivered under a lease: the documents stay locked until the agent
  // replies. If the agent is gone for good nothing will ever send that reply, so the
  // user ends the run by hand. Edits the agent already wrote to the file are kept.
  async function abortRun() {
    if (!S.run || !confirm('Abort this run? Edits already applied stay; the message is marked aborted.')) return;
    try { await api('/api/run/abort', { reason: 'aborted from the page' }); } catch (e) { alert('Abort failed: ' + e.message); }
  }

  // Instructions from an earlier session live on in the chat log the agent reads as
  // context and in any batch left pending, which the next session redelivers. This wipes
  // both so the conversation starts clean; the documents are not touched.
  async function clearCache() {
    if (!confirm('Clear the agent conversation and any pending batches? The PRD and tech spec are not touched.')) return;
    try { await api('/api/cache/clear', {}); await load(); } catch (e) { alert('Clear failed: ' + e.message); }
  }

  // ---------------------------------------------------------------- chat
  function renderChat() {
    const host = $('#chat'); host.innerHTML = '';
    const progress = new Map(); // batch -> lines
    let liveFor = null;         // batch whose live working bubble is already drawn
    const entries = S.chat;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.type === 'progress') {
        const k = e.batch || '_';
        if (!progress.has(k)) progress.set(k, []);
        progress.get(k).push(e.text);
        // live bubble only if no reply yet for that batch after this point
        const later = entries.slice(i + 1).some(x => (x.type === 'reply' && x.batch === e.batch) || x.type === 'progress' && (x.batch || '_') === k);
        if (!later) { host.append(progressBubble(progress.get(k), true)); liveFor = k; }
        continue;
      }
      if (e.type === 'batch') host.append(batchBubble(e));
      else if (e.type === 'reply') { const lines = progress.get(e.batch || '_'); host.append(replyBubble(e, lines)); }
      else if (e.type === 'system') host.append(el('div', { class: 'msg system' }, e.text));
      else if (e.type === 'divider') host.append(el('div', { class: 'msg divider' }, e.text));
    }
    // A run that has not reported a step yet leaves no progress entry to draw
    // from, so without this the chat stays silent between dispatch and the
    // agent's first emit - which for a design run is minutes.
    if (S.run && liveFor !== S.run.id) host.append(progressBubble(['picked up your message'], true));
    host.scrollTop = host.scrollHeight;
  }
  function progressBubble(lines, live) {
    const body = el('div', { class: 'm-body progress' }, ...lines.map((l, i) => el('div', { class: 'line' + (live && i === lines.length - 1 ? ' last' : '') }, l)));
    // Same pulsing dot as the header's status, so "working" reads the same in both places.
    const head = el('div', { class: 'm-head', title: RUN_TIP }, 'agent · working', el('span', { class: 'dot busy' }));
    return el('div', { class: 'msg agent' }, head, body);
  }
  function batchBubble(e) {
    const m = el('div', { class: 'msg user' }, el('div', { class: 'm-head' }, 'you', e.queued ? el('span', { class: 'badge' }, 'queued') : null));
    const notes = e.notes || [];
    if (notes.length) {
      m.append(el('details', { class: 'sent' },
        el('summary', {}, `Sent (${notes.length})`),
        el('ul', { class: 'note-list' }, ...notes.map(n => el('li', {},
          n.block ? el('a', { href: '#' + n.block, dataset: { goto: n.block } }, n.block) : null,
          n.block ? ' ' : '',
          n.kind === 'answer' && n.option ? `option ${n.option}` + (n.text ? ' - ' : '') : '',
          n.text || '')))));
    }
    if (e.chat) { const b = el('div', { class: 'm-body' }); b.innerHTML = md(e.chat); m.append(b); }
    return m;
  }
  function replyBubble(e, progressLines) {
    // No document badge: every line in this log is this session's one document.
    const m = el('div', { class: 'msg agent' }, el('div', { class: 'm-head' }, 'agent', e.interim ? el('span', { class: 'badge' }, 'interim') : null));
    const body = el('div', { class: 'm-body' }); body.innerHTML = linkifyIds(md(e.md || ''));
    m.append(body);
    if (e.changed?.length) m.append(el('div', { class: 'changed-links' }, el('span', { class: 'muted' }, 'changed: '), ...e.changed.slice(0, 40).map(id => el('a', { href: '#' + id, dataset: { goto: id } }, id))));
    if (e.repairs?.length) m.append(el('div', { class: 'repairs' }, 'repaired: ' + e.repairs.join('; ')));
    if (progressLines?.length) m.append(el('details', { class: 'progress-log' }, el('summary', {}, `progress log (${progressLines.length})`), ...progressLines.map(l => el('div', {}, '› ' + l))));
    return m;
  }

  // ---------------------------------------------------------------- events
  function connect() {
    const es = new EventSource('/api/events');
    es.addEventListener('hello', (ev) => { S.serverGone = false; applySession(JSON.parse(ev.data).session); renderBanners(); });
    es.addEventListener('doc', (ev) => {
      const d = JSON.parse(ev.data);
      S.model = d.model;
      for (const id of [...(d.changed || []), ...(d.added || [])]) S.changed.add(id);
      rebindNotes(); renderQueued();
      renderDoc(); renderBanners();
    });
    es.addEventListener('chat', (ev) => { S.chat.push(JSON.parse(ev.data)); renderChat(); });
    es.addEventListener('progress', () => { /* chat event carries it too */ });
    es.addEventListener('run', (ev) => {
      const r = JSON.parse(ev.data);
      if ('lock' in r) S.lock = r.lock; S.queue = r.queue || [];
      S.run = r.active ? { id: r.active, silent: Boolean(r.silent) } : null;
      renderBanners(); renderDoc(); renderChat();
    });
    es.addEventListener('agent', (ev) => { const a = JSON.parse(ev.data); S.agent.present = a.present; S.agent.everPolled = a.everPolled || S.agent.everPolled; renderBanners(); });
    es.addEventListener('queued', (ev) => { S.queuedWrites = JSON.parse(ev.data).count; renderBanners(); });
    es.addEventListener('notes', (ev) => { const n = JSON.parse(ev.data); if (n.tab && n.tab !== S.tab) { S.notes = n.notes || []; rebindNotes(); renderQueued(); markNoted(); } });
    es.addEventListener('diagram', (ev) => { const d = JSON.parse(ev.data); const h = S.diagrams.get(d.id); if (h?.handle) h.handle.reload(); });
    es.addEventListener('closing', () => { S.closed = true; es.close(); renderBanners(); document.body.append(el('div', { class: 'overlay' }, 'Session ended. You can close this tab.')); });
    es.onerror = () => { if (S.closed) return; S.serverGone = true; renderBanners(); };
    es.onopen = () => { if (S.serverGone) { S.serverGone = false; load(); } };
  }
  function applySession(info) {
    S.session = info; if ('lock' in info) S.lock = info.lock; if (info.doc) S.doc = info.doc; if (info.path) S.path = info.path; S.agent = info.agent || S.agent; S.run = info.run; S.queue = info.queue || []; S.queuedWrites = info.queuedWrites || 0;
  }

  async function load() {
    const j = await api('/api/session');
    applySession(j.session);
    S.doc = j.doc; S.path = j.path; S.model = j.model; S.reference = j.reference || null;
    S.notes = j.notes || []; S.chat = j.chat || [];
    rebindNotes(); renderChip(); renderDoc(); renderQueued(); renderChat(); renderBanners();
  }

  function heartbeat() {
    if (S.closed) return;
    fetch('/api/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tab: S.tab }) })
      .then(r => r.json()).then(j => { if (S.serverGone) { S.serverGone = false; renderBanners(); } if (j.agent && j.agent.present !== S.agent.present) { S.agent.present = j.agent.present; renderBanners(); } })
      .catch(() => { S.serverGone = true; renderBanners(); });
  }

  // ---------------------------------------------------------------- wiring
  $('#chat-send').addEventListener('click', () => sendBatch($('#chat-text').value));
  $('#queued-toggle').addEventListener('click', () => { S.queuedOpen = !S.queuedOpen; renderQueued(); });
  $('#queued-clear').addEventListener('click', clearQueued);
  $('#agent-clear').addEventListener('click', clearCache);
  // Enter sends; Shift/Ctrl/⌘/Alt+Enter insert a new line (IME composition Enter is left alone).
  $('#chat-text').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) {
      e.preventDefault();
      const ta = e.target, s = ta.selectionStart, t = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + '\n' + ta.value.slice(t);
      ta.selectionStart = ta.selectionEnd = s + 1;
      ta.dispatchEvent(new Event('input'));
      return;
    }
    e.preventDefault();
    if (e.target.value.trim() || S.notes.length) sendBatch(e.target.value);
  });
  // grow the chat box with its content (up to ~8 lines)
  $('#chat-text').addEventListener('input', (e) => { const ta = e.target; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 8 * 20 + 14) + 'px'; updateSendButton(); });
  $('#stop-btn').addEventListener('click', async () => {
    if (!confirm('End the editor session? The server stops; the skill in the terminal reports and exits.')) return;
    try { await api('/api/close', {}); } catch { /* already gone */ }
  });
  window.addEventListener('beforeunload', () => { /* heartbeat stops; server closes after the grace period */ });

  load().then(() => { connect(); heartbeat(); setInterval(heartbeat, 5000); setInterval(renderBanners, 15000); })
    .catch(e => { document.body.append(el('div', { class: 'overlay' }, 'Could not load the session: ' + e.message)); });
})();
