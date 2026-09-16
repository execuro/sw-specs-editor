// Old vs new document model -> changed/added/removed block ids.
import { collect } from './parse.mjs';

/** Flat id -> hash map of every addressable block (containers hash their own head only). */
export function hashMap(model) {
  const map = new Map();
  if (!model) return map;
  for (const b of collect(model.blocks)) map.set(b.id, b.hash);
  return map;
}

/**
 * @returns {{changed: string[], added: string[], removed: string[]}}
 */
export function diff(oldModel, newModel) {
  const a = hashMap(oldModel);
  const b = hashMap(newModel);
  const changed = [], added = [], removed = [];
  for (const [id, h] of b) {
    if (!a.has(id)) added.push(id);
    else if (a.get(id) !== h) changed.push(id);
  }
  for (const id of a.keys()) if (!b.has(id)) removed.push(id);
  return { changed, added, removed };
}

/** Ids whose content differs, including added ones - what the page highlights. */
export function touched(oldModel, newModel) {
  const d = diff(oldModel, newModel);
  return [...d.changed, ...d.added];
}
