import { z } from 'zod';

import { idSchema, keySchema, timestampSchema } from './keys';

/** A hard cap the database also enforces, so a slot cannot grow without end. */
export const MAX_ITEMS_PER_SLOT = 100;
export const MAX_SECTIONS_PER_PAGE = 50;

/** One section of a page: which template it uses and which items fill the template's slots, in order. */
export const layoutSectionSchema = z
  .object({
    /** Unique within the page; stable, so a section can be moved and still be recognised. */
    key: keySchema,
    template: keySchema,
    /** The id the section is linked to on the page (`#anchor`), for navigation. */
    anchor: keySchema.optional(),
    /** Slot key to the ids of the items in it, in order. A slot with no items may be left out. */
    slots: z.record(keySchema, z.array(idSchema).max(MAX_ITEMS_PER_SLOT)),
  })
  .strict();
export type LayoutSection = z.infer<typeof layoutSectionSchema>;

/**
 * The content of a page layout version: an ordered list of sections. The layout is a versioned document like an item's
 * entry (it is not translated: the words live in the items).
 */
export const pageLayoutContentSchema = z
  .object({ sections: z.array(layoutSectionSchema).max(MAX_SECTIONS_PER_PAGE) })
  .strict()
  .superRefine((layout, ctx) => {
    const seen = new Set<string>();
    layout.sections.forEach((section, index) => {
      if (seen.has(section.key)) ctx.addIssue({ code: 'custom', message: `Duplicate section key "${section.key}"`, path: ['sections', index, 'key'] });
      seen.add(section.key);
    });
  });
export type PageLayoutContent = z.infer<typeof pageLayoutContentSchema>;

/** A page layout: one per page key, per site. Its content is versioned like an item's. */
export const pageLayoutSchema = z
  .object({
    id: idSchema,
    /** Which route reads it. Routes are fixed in each app; the route asks for its layout by this key. */
    pageKey: keySchema,
    publishedVersion: z.number().int().min(1).nullable(),
    createdAt: timestampSchema,
  })
  .strict();
export type PageLayout = z.infer<typeof pageLayoutSchema>;

/**
 * A layout as a page reads it: the published version, or, in a preview by an editor, the newest one. Who the caller is
 * decides, not the flag: anyone else gets the published version.
 */
export type PageLayoutReadRecord = {
  pageKey: string;
  version: number;
  status: 'draft' | 'published';
  /** `true` when `content` is a version that is not published, which only a preview by an editor returns. */
  isDraft: boolean;
  content: unknown;
  changedAt: string;
};

/** One saved version of a layout, as the backend returns it, content unchecked (check it with `pageLayoutContentSchema`). */
export type PageLayoutVersionRecord = {
  pageKey: string;
  version: number;
  status: 'draft' | 'published';
  content: unknown;
  changedBy: string | null;
  changedByEmail: string | null;
  changedAt: string;
  restoredFrom: number | null;
};
