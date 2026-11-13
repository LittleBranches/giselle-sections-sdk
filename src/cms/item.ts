import { z } from 'zod';

import { entryLanguageSchema, type EntryLanguage } from './languages';
import { idSchema, keySchema, timestampSchema } from './keys';

/**
 * A reference to a shared item, by the item's id. Inside any item's content, or a layout slot, it stands for the item
 * as it is published (`$ref` is the marker the database and the SDK both look for when they collect references).
 */
export const itemRefSchema = z.object({ $ref: idSchema }).strict().meta({ widget: 'item-ref' });

/** How many levels of references a page resolves: an item inside an item inside an item. Deeper references are left unresolved and reported. */
export const MAX_REFERENCE_DEPTH = 3;
export type ItemRef = z.infer<typeof itemRefSchema>;

/** One instance of a content type: the part that is the same in every language and every version. */
export const contentItemSchema = z
  .object({
    id: idSchema,
    typeKey: keySchema,
    /** A name for people to find the item by in the editor. Not shown to visitors, not translated. */
    title: z.string().min(1).max(120),
    /** `true`: other items and layouts may reference it from several places. `false`: it is used in one place only. */
    reusable: z.boolean(),
    /** Copied from the type when the item is made and never changed: it decides whether the item keeps one entry or one per language. */
    translatable: z.boolean(),
    createdAt: timestampSchema,
  })
  .strict();
export type ContentItem = z.infer<typeof contentItemSchema>;

export const newContentItemSchema = z
  .object({ typeKey: keySchema, title: z.string().min(1).max(120), reusable: z.boolean().default(false) })
  .strict();
export type NewContentItem = z.input<typeof newContentItemSchema>;

/** An item with what the editor's list shows. */
export type ContentItemSummary = ContentItem & {
  /** Languages that have a published entry. `['all']` for an item that is not translatable. */
  publishedLanguages: EntryLanguage[];
  /** How many places use it (see `ItemUsage`). */
  usageCount: number;
};

/** The marker of one saved version of an item's entry, as the backend returns it, content unchecked. */
export type ItemVersionRecord = {
  itemId: string;
  /** The language the entry is stored under: `'all'` for an item that is not translatable. */
  language: EntryLanguage;
  version: number;
  status: 'draft' | 'published';
  content: unknown;
  changedBy: string | null;
  changedByEmail: string | null;
  changedAt: string;
  restoredFrom: number | null;
};

/** An item as a page needs it (its title is for editors and is not part of it): its published (or, in preview, newest) version, in the language it is actually in. */
export type ResolvedItem<T = unknown> = {
  id: string;
  typeKey: string;
  /** The language the content is in: the one asked for, the fallback, or `'all'`. */
  language: EntryLanguage;
  version: number;
  status: 'draft' | 'published';
  /** `true` when this is a draft shown because the call was a preview. Always `false` for a visitor. */
  isDraft: boolean;
  content: T;
};

/** A place that uses an item. */
export const itemUsageSchema = z
  .object({
    sourceKind: z.enum(['item', 'layout']),
    /** The id of the item that holds the reference, or of the page layout. */
    sourceId: idSchema,
    /** The title of the item, or the page key of the layout. */
    sourceLabel: z.string(),
    /** The entry language of the source item; `null` for a layout. */
    sourceLanguage: entryLanguageSchema.nullable(),
    /** The reference is in the source's published version: removing the item would break a live page. */
    inPublished: z.boolean(),
    /** The reference is in the source's newest version (a draft, or the published one when nothing is newer). */
    inNewest: z.boolean(),
  })
  .strict();
export type ItemUsage = z.infer<typeof itemUsageSchema>;

/**
 * What a site writes for a collection type (rows in a table the site already has, such as blog posts), so the same
 * generated form can edit it. The blog table stays as it is; the adapter is the only code that knows its columns.
 * Collection records have no versions here and cannot be referenced by `ItemRef`.
 */
export interface CollectionAdapter<T = unknown> {
  /** Matches `ContentType.adapter`. */
  readonly key: string;
  /** Rows for the editor's list, newest first. The visitor-facing reads stay in the site's own code. */
  list(options?: { status?: 'draft' | 'published'; limit?: number; cursor?: string }): Promise<{ records: CollectionRecord<T>[]; nextCursor: string | null }>;
  get(id: string): Promise<CollectionRecord<T> | null>;
  /** `value` has been checked against the type's schema. Returns the stored record. */
  create(value: T): Promise<CollectionRecord<T>>;
  /** `baseUpdatedAt` is the `updatedAt` the value was edited from (`null` if unknown); when the stored record has moved on, rejects with `CollectionConflictError` carrying the stored record. */
  update(id: string, value: T, baseUpdatedAt: string | null): Promise<CollectionRecord<T>>;
  /** Moves a record between draft and published. */
  setStatus(id: string, status: 'draft' | 'published'): Promise<CollectionRecord<T>>;
  remove(id: string): Promise<void>;
}

export type CollectionRecord<T = unknown> = {
  id: string;
  status: 'draft' | 'published';
  value: T;
  updatedAt: string;
};
