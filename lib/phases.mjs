// The three phases of the Specs Editor process, decided in one place.
//
// Pure: no I/O, no clock. The page, `status` and any other reader call this and
// cannot disagree about where a feature stands or what to run next.
//
//   1 Design requirements   done when the PRD status reads "ready for specification"
//   2 Design solution       done when the spec status reads "ready for implementation"
//   3 Implement             never monitored: "next" once phase 2 is done, "started"
//                           once the spec carries a [done] / [partly] tag or the
//                           verification file exists
//
// Completeness is read from the status string the design skill wrote; the 90%
// threshold is not recomputed here. The one rule applied on top is the skills'
// own absolute one: a document with an open question is never ready (PRD: an
// open §11 question; spec: C-5, §6 empty). A question raised on the page after
// the last run would otherwise show "Done" next to "Open questions: 1", and the
// console report and the page would disagree until the next run. `percent` is the confidence exactly as the
// document states it, never derived from other numbers.

import { siblingPath } from './parse.mjs';

export const PHASE_NAMES = ['Design requirements', 'Design solution', 'Implement'];

const PRD_READY = /^ready for specification/i;
const SPEC_READY = /^ready for implementation/i;

const statusOf = m => String(m?.meta?.status ?? '').trim();
const percentOf = m => {
  const c = m?.meta?.confidence;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
};
const openOf = m => {
  const n = m?.meta?.openQuestions;
  return typeof n === 'number' && n > 0 ? n : 0;
};
const openNote = n => n ? `${n} open question${n === 1 ? '' : 's'}` : null;
const fwd = p => String(p || '').replace(/\\/g, '/');

/**
 * @param {{prdModel: object|null, specModel: object|null, verified?: boolean}} input
 * @returns {{phases: Array<{n: 1|2|3, name: string, state: string, percent: number|null, note: string|null}>, current: 1|2|3, next: string|null}}
 */
export function phases({ prdModel = null, specModel = null, verified = false } = {}) {
  const prdOpen = openOf(prdModel);
  const specOpen = openOf(specModel);
  const prdDone = Boolean(prdModel) && PRD_READY.test(statusOf(prdModel)) && !prdOpen;
  const specDone = Boolean(specModel) && SPEC_READY.test(statusOf(specModel)) && !specOpen;
  const orphan = Boolean(specModel) && !prdModel;

  const prdPath = prdModel ? fwd(prdModel.path) : (specModel ? fwd(specModel.path && siblingPath(specModel.path)) : '');
  const specPath = specModel ? fwd(specModel.path) : (prdModel ? fwd(prdModel.path && siblingPath(prdModel.path)) : '');

  const p1 = { n: 1, name: PHASE_NAMES[0], state: prdDone ? 'done' : 'current', percent: percentOf(prdModel), note: orphan ? 'PRD missing' : openNote(prdOpen) };
  const p2 = { n: 2, name: PHASE_NAMES[1], state: 'todo', percent: percentOf(specModel), note: null };
  const p3 = { n: 3, name: PHASE_NAMES[2], state: 'todo', percent: null, note: null };

  let next = null;
  if (!prdDone) {
    if (prdModel && prdPath) next = `sw-design-requirements ${prdPath}`;
  } else if (!specDone) {
    p2.state = specModel ? 'current' : 'next';
    if (specModel) p2.note = openNote(specOpen);
    // A spec that does not exist yet is drafted from its PRD, so the PRD path is the documented input then.
    const target = specModel ? specPath : prdPath;
    if (target) next = `sw-design-solution ${target} --editor`;
  } else {
    p2.state = 'done';
    const req = specModel?.meta?.requirements;
    const started = verified === true || ((req?.done || 0) + (req?.partly || 0)) > 0;
    p3.state = started ? 'started' : 'next';
    if (!started) next = `sw-implement-feature ${specPath}`;
  }

  // Orphan spec: nothing to hand over from, so no command either.
  if (orphan) next = null;

  const current = p3.state === 'started' ? 3 : (p1.state !== 'done' ? 1 : (p2.state !== 'done' ? 2 : 3));
  return { phases: [p1, p2, p3], current, next };
}
