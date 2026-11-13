import type { PageLayoutContent } from './page-layout';
import type { SectionTemplate } from './template';

/** One broken slot rule, as the database reports it: a JSON line `{ section, slot, message }`. */
export type LayoutProblem = { section: string; slot: string | null; message: string };

export const formatLayoutProblem = (problem: LayoutProblem): string =>
  problem.slot ? `${problem.section}.${problem.slot}: ${problem.message}` : `${problem.section}: ${problem.message}`;

/**
 * The slot rules of contracts 4.7, shared by the in-memory store and the tests of the database mapping: for each
 * section the template exists, each slot named exists in it, every item exists and its type is allowed there, and there
 * are at most `max` items. With `forPublish`, every slot of the template also holds at least `min` items (a slot the
 * section does not mention holds none).
 */
export function checkLayoutSlots(
  content: PageLayoutContent,
  lookup: { template(key: string): SectionTemplate | undefined; itemType(id: string): string | undefined },
  forPublish: boolean,
): LayoutProblem[] {
  const problems: LayoutProblem[] = [];
  for (const section of content.sections) {
    const template = lookup.template(section.template);
    if (!template) {
      problems.push({ section: section.key, slot: null, message: `uses the template "${section.template}", which does not exist` });
      continue;
    }
    for (const [slotKey, ids] of Object.entries(section.slots)) {
      const slot = template.slots.find((candidate) => candidate.key === slotKey);
      if (!slot) {
        problems.push({ section: section.key, slot: slotKey, message: `the template "${template.key}" has no slot "${slotKey}"` });
        continue;
      }
      for (const id of ids) {
        const typeKey = lookup.itemType(id);
        if (typeKey === undefined) problems.push({ section: section.key, slot: slotKey, message: `the item ${id} does not exist` });
        else if (!slot.allowedTypeKeys.includes(typeKey)) {
          problems.push({ section: section.key, slot: slotKey, message: `an item of type "${typeKey}" is not allowed here (allowed: ${slot.allowedTypeKeys.join(', ')})` });
        }
      }
      if (slot.max !== null && ids.length > slot.max) {
        problems.push({ section: section.key, slot: slotKey, message: `holds ${ids.length} items; at most ${slot.max} are allowed` });
      }
    }
    if (forPublish) {
      for (const slot of template.slots) {
        const count = section.slots[slot.key]?.length ?? 0;
        if (count < slot.min) problems.push({ section: section.key, slot: slot.key, message: `holds ${count} items; at least ${slot.min} are needed` });
      }
    }
  }
  return problems;
}
