/**
 * Puts values into the `{slot}` markers of a piece of copy: a number or name filled in at run time is written as
 * `{count}` in the text, and this replaces it. Every occurrence of a slot is filled; a slot with no value is left as
 * it is, so a missing value shows up in the output instead of vanishing. Values go in as plain text.
 *
 * @example fillSlots('{finished} / {total} done', { finished: 2, total: 5 }) // '2 / 5 done'
 */
export function fillSlots(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (marker, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : marker
  );
}
