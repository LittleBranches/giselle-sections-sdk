import type { ContentType } from './content-type';
import type { Asset, NewAsset } from './asset';
import type { ContentItem, ContentItemSummary, ItemUsage, NewContentItem, ResolvedItem } from './item';
import type { CmsLanguage } from './languages';
import type { PageLayout, PageLayoutContent, PageLayoutVersionRecord } from './page-layout';
import type { ContentTypeRegistry } from './registry';
import type { CmsContentStore } from './store';
import type { SectionTemplate } from './template';
import type { ItemVersionRecord } from './item';

/** Why something a page asked for is missing from it. The page still renders; the editor can show the list. */
export type ResolveProblem = {
  sectionKey: string;
  slotKey: string | null;
  itemId: string | null;
  reason: 'unknown-template' | 'item-not-published' | 'unknown-type' | 'invalid-content' | 'reference-too-deep' | 'reference-cycle';
  message: string;
};

export type ResolvedSection = {
  key: string;
  anchor: string | null;
  template: SectionTemplate;
  /** Slot key to its items, in order, each checked against its type's schema. An item that could not be shown is left out and reported in `problems`. */
  slots: Record<string, ResolvedItem[]>;
};

/** A page ready to render. */
export type ResolvedPage = {
  pageKey: string;
  /** The layout version shown. */
  version: number;
  /** `true` when a preview shows a layout that is not (yet) the published one. Always `false` for a visitor. */
  isDraft: boolean;
  language: CmsLanguage;
  sections: ResolvedSection[];
  problems: ResolveProblem[];
};

export type ReadOptions = {
  /**
   * Show drafts where the caller may. A visitor, or a signed-in person who is not an editor, gets the published
   * version whatever this says: the database decides, not the flag.
   */
  preview?: boolean;
};

/** What a public page needs. Works with no sign-in. */
export interface CmsReader {
  /** The layout of a page with every section's items resolved in the language (fallback `'en'`). `null` if the page has no published layout (and, in preview, no draft either). */
  page(pageKey: string, language: CmsLanguage, options?: ReadOptions): Promise<ResolvedPage | null>;
  /** One item by id, content checked against `type`'s schema. `null` if it has nothing to show. */
  item<T>(itemId: string, type: ContentType<T>, language: CmsLanguage, options?: ReadOptions): Promise<ResolvedItem<T> | null>;
  /** The templates, for a site that builds its own page rendering. */
  templates(): Promise<SectionTemplate[]>;
}

/** What editors need. Who may call each is the backend's decision; a refused call rejects with `ContentPermissionError`. */
export interface CmsEditor {
  listItems(filter?: { typeKey?: string }): Promise<ContentItemSummary[]>;
  /** Makes an item of a registered document type (the provider passes the type's `translatable` flag). */
  createItem(input: NewContentItem): Promise<ContentItem>;
  updateItem(itemId: string, changes: { title?: string; reusable?: boolean }): Promise<ContentItem>;
  /** The newest version of the entry for editing: the exact language, no fallback. For a type that is not translatable, `language` is ignored and `'all'` is used. */
  draft<T>(itemId: string, type: ContentType<T>, language: CmsLanguage): Promise<(Omit<ItemVersionRecord, 'content'> & { content: T }) | null>;
  listItemVersions(itemId: string, type: ContentType, language: CmsLanguage): Promise<Omit<ItemVersionRecord, 'content'>[]>;
  /** Checks `content` against the type's schema (`ContentValidationError`), collects its `$ref`s, saves. Returns the new version number. */
  saveItemDraft<T>(itemId: string, type: ContentType<T>, language: CmsLanguage, content: unknown, baseVersion: number | null): Promise<number>;
  publishItem(itemId: string, type: ContentType, language: CmsLanguage, version: number): Promise<void>;
  restoreItem(itemId: string, type: ContentType, language: CmsLanguage, version: number, baseVersion: number | null): Promise<number>;
  usages(itemId: string): Promise<ItemUsage[]>;
  /** Rejects with `ContentReferencedError` while the item is used. */
  deleteItem(itemId: string): Promise<void>;

  layouts(): Promise<PageLayout[]>;
  /** The newest layout version, content checked with `pageLayoutContentSchema`. */
  layoutDraft(pageKey: string): Promise<(Omit<PageLayoutVersionRecord, 'content'> & { content: PageLayoutContent }) | null>;
  listLayoutVersions(pageKey: string): Promise<Omit<PageLayoutVersionRecord, 'content'>[]>;
  saveLayoutDraft(pageKey: string, content: unknown, baseVersion: number | null): Promise<number>;
  publishLayout(pageKey: string, version: number): Promise<void>;
  restoreLayout(pageKey: string, version: number, baseVersion: number | null): Promise<number>;
  reorderSlot(pageKey: string, sectionKey: string, slotKey: string, itemIds: readonly string[], baseVersion: number): Promise<number>;

  saveTemplate(template: SectionTemplate): Promise<SectionTemplate>;
  assets(): Promise<Asset[]>;
  registerAsset(asset: NewAsset): Promise<Asset>;
}

export type CmsProvider = CmsReader & CmsEditor;

/**
 * The factory the sites call (implemented in WP1 as `createCmsProvider`): it checks content against each type's schema
 * on save and on read, collects references, applies the language fallback and refuses drafts to visitors. Invalid
 * content is never returned to a page and never handed to the store.
 */
export type CreateCmsProvider = (dependencies: { store: CmsContentStore; registry: ContentTypeRegistry }) => CmsProvider;
