import type { ContentStore } from '../content/store';
import type { Asset, NewAsset } from './asset';
import type { ContentItem, ContentItemSummary, ItemUsage, ItemVersionRecord, NewContentItem } from './item';
import type { EntryLanguage, CmsLanguage } from './languages';
import type { PageLayout, PageLayoutReadRecord, PageLayoutVersionRecord } from './page-layout';
import type { SectionTemplate, SectionTemplateRecord } from './template';

/** An item's newest or published version, with the item's fields a visitor may see and the language it was actually found in. */
export type ResolvedItemRecord = {
  itemId: string;
  typeKey: string;
  reusable: boolean;
  translatable: boolean;
  /** The entry language the content comes from (the one asked for, `'en'`, or `'all'`). */
  language: EntryLanguage;
  version: number;
  status: 'draft' | 'published';
  /** `true` when `content` is a draft version, which only a preview by an editor returns. */
  isDraft: boolean;
  content: unknown;
};

/**
 * Items: instances of a content type, each versioned per language entry (one entry, language `'all'`, for a type that is
 * not translatable) with the same rules as the existing entries: immutable versions, a save carries its base version,
 * only the newest version can be published, restore makes a new version.
 *
 * `refs` on a write is the set of item ids the content points at (every `{ "$ref": id }` found in it), collected by the
 * provider; the store records it in the reference index and the database checks it.
 */
export interface ItemStore {
  /** Makes an item. The type's `translatable` flag is passed by the provider (the store does not know types). */
  createItem(input: NewContentItem & { translatable: boolean }): Promise<ContentItem>;
  /** Renames an item and/or marks it reusable. Rejects with `ContentReferenceError` (`not-reusable`) if it would stop being reusable while used in more than one place. */
  updateItem(itemId: string, changes: { title?: string; reusable?: boolean }): Promise<ContentItem>;
  /** Editors: every item, optionally of one type, with where its published languages are and its usage count. */
  listItems(filter?: { typeKey?: string }): Promise<ContentItemSummary[]>;

  /** The exact entry's published version, no fallback. `null` if the entry has none. */
  readPublished(itemId: string, language: EntryLanguage): Promise<ItemVersionRecord | null>;
  /** The exact entry's newest version, draft or not. `null` if none, or the caller may not read drafts. */
  readNewest(itemId: string, language: EntryLanguage): Promise<ItemVersionRecord | null>;
  /** Every version of the entry, newest first, without content. Empty for a caller who may not read history. */
  listVersions(itemId: string, language: EntryLanguage): Promise<Omit<ItemVersionRecord, 'content'>[]>;

  /**
   * Many items for a page, in one call, with the language fallback applied by the store (the requested language, then
   * `'en'`, then `'all'`). `preview: true` returns the newest version where the caller may read drafts and the
   * published one where not; `false` always the published one. Items with nothing to show are left out.
   */
  resolveItems(itemIds: readonly string[], language: CmsLanguage, preview: boolean): Promise<ResolvedItemRecord[]>;

  saveDraft(itemId: string, language: EntryLanguage, content: unknown, refs: readonly string[], baseVersion: number | null): Promise<number>;
  publish(itemId: string, language: EntryLanguage, version: number): Promise<void>;
  restore(itemId: string, language: EntryLanguage, version: number, baseVersion: number | null): Promise<number>;

  /** Editors: where an item is used. Empty if it is not. */
  listUsages(itemId: string): Promise<ItemUsage[]>;
  /** Owners: deletes the item and its history if nothing uses it; otherwise rejects with `ContentReferencedError` listing the usages. */
  deleteItem(itemId: string): Promise<void>;
}

/** Page layouts: one versioned document per page key. Same version rules as an item's entry. */
export interface LayoutStore {
  /** The published layout of a page, or `null`. Never a draft. */
  readPublished(pageKey: string): Promise<PageLayoutVersionRecord | null>;
  /**
   * What a page shows, for anyone: the published layout; with `preview: true` and a caller who may read drafts, the
   * newest. A caller who may not gets the published one whatever `preview` says (never an error). `null` if there is
   * nothing to show.
   */
  read(pageKey: string, preview: boolean): Promise<PageLayoutReadRecord | null>;
  /** The newest version, draft or not. `null` if none or the caller may not read drafts. */
  readNewest(pageKey: string): Promise<PageLayoutVersionRecord | null>;
  listVersions(pageKey: string): Promise<Omit<PageLayoutVersionRecord, 'content'>[]>;
  listLayouts(): Promise<PageLayout[]>;
  /** `refs`: every item id in the layout's slots. Checks the slot rules of each section's template (types allowed, at most `max`); the minimums are checked on publish. */
  saveDraft(pageKey: string, content: unknown, refs: readonly string[], baseVersion: number | null): Promise<number>;
  /** Must be the newest version; checks the slot minimums too (`LayoutRuleError` otherwise). */
  publish(pageKey: string, version: number): Promise<void>;
  restore(pageKey: string, version: number, baseVersion: number | null): Promise<number>;
  /** Saves the newest version with one slot's items put in the given order, as a new draft. `itemIds` must be the same set the slot holds now. Returns the new version number. */
  reorderSlot(pageKey: string, sectionKey: string, slotKey: string, itemIds: readonly string[], baseVersion: number): Promise<number>;
}

/** Templates: data, read by everyone (a visitor's page needs them), written by owners. */
export interface TemplateStore {
  list(): Promise<SectionTemplateRecord[]>;
  get(key: string): Promise<SectionTemplateRecord | null>;
  /** Owners: creates or replaces a template (a built-in's `builtIn` flag cannot be changed). */
  save(template: SectionTemplate): Promise<SectionTemplateRecord>;
}

/** Assets: files in the bucket, registered. Uploading the file itself is the bucket's job (the site's client does it). */
export interface AssetStore {
  list(): Promise<Asset[]>;
  get(assetId: string): Promise<Asset | null>;
  /** Editors: records a file that was already uploaded to the bucket. Rejects with `ContentValidationError` if the file is not there. */
  register(asset: NewAsset): Promise<Asset>;
}

/**
 * The store a CMS site needs: the existing section entries (`ContentStore`, unchanged) plus items, layouts, templates
 * and assets. Implementations: an in-memory one (tests, WP1) and a Supabase-backed one (WP1), both following the same
 * rules and the same error classes.
 */
export interface CmsContentStore extends ContentStore {
  readonly items: ItemStore;
  readonly layouts: LayoutStore;
  readonly templates: TemplateStore;
  readonly assets: AssetStore;
}
