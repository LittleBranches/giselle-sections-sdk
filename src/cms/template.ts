import { z } from 'zod';

import { keySchema, timestampSchema } from './keys';
import { slotDefinitionSchema } from './content-type';

/**
 * A named layout for a section: which container type it is, and its slots with the item types each allows and how many
 * items. Templates are data in the database, composed from registry types; a few are built in and seeded.
 */
export const sectionTemplateSchema = z
  .object({
    key: keySchema,
    name: z.string().min(1).max(80),
    /** The key of a registered container type (for the built-ins, `section`). */
    containerTypeKey: keySchema,
    /** Each slot narrows the container type's slot of the same key: its allowed types are a subset, its limits are inside the container's. */
    slots: z.array(slotDefinitionSchema).min(1),
    builtIn: z.boolean().default(false),
  })
  .strict()
  .superRefine((template, ctx) => {
    const seen = new Set<string>();
    template.slots.forEach((slot, index) => {
      if (seen.has(slot.key)) ctx.addIssue({ code: 'custom', message: `Duplicate slot key "${slot.key}"`, path: ['slots', index, 'key'] });
      seen.add(slot.key);
    });
  });
export type SectionTemplate = z.infer<typeof sectionTemplateSchema>;
export type SectionTemplateInput = z.input<typeof sectionTemplateSchema>;

/** A template as stored, with its timestamps. */
export type SectionTemplateRecord = SectionTemplate & { createdAt: string; updatedAt: string };
export const sectionTemplateRecordSchema = sectionTemplateSchema.and(
  z.object({ createdAt: timestampSchema, updatedAt: timestampSchema }),
);

/**
 * The block and container type keys the built-in templates are written against. A site registers types under these
 * keys to use the built-in templates; it may register more types and add its own templates beside them.
 */
export const BUILTIN_TYPE_KEYS = {
  section: 'section',
  banner: 'banner',
  card: 'card',
  timeline: 'timeline',
} as const;

/**
 * The built-in templates. The shared migration seeds exactly these rows (same keys, names, slots and limits); a test in
 * the SDK and one in the migration's tests each compare against this list so the two cannot drift.
 */
export const BUILTIN_SECTION_TEMPLATES: readonly SectionTemplate[] = [
  {
    key: 'banner-section',
    name: 'Banner section',
    containerTypeKey: BUILTIN_TYPE_KEYS.section,
    slots: [{ key: 'banner', label: 'Banner', allowedTypeKeys: [BUILTIN_TYPE_KEYS.banner], min: 1, max: 1 }],
    builtIn: true,
  },
  {
    key: 'help-section',
    name: 'Help section with cards',
    containerTypeKey: BUILTIN_TYPE_KEYS.section,
    slots: [{ key: 'cards', label: 'Cards', allowedTypeKeys: [BUILTIN_TYPE_KEYS.card], min: 0, max: 24 }],
    builtIn: true,
  },
  {
    key: 'timeline-section',
    name: 'Timeline section',
    containerTypeKey: BUILTIN_TYPE_KEYS.section,
    slots: [{ key: 'timeline', label: 'Timeline', allowedTypeKeys: [BUILTIN_TYPE_KEYS.timeline], min: 1, max: 1 }],
    builtIn: true,
  },
];
