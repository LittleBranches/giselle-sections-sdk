import { ContentConflictError, ContentValidationError } from '../content/errors';
import type { ContentVersionRecord } from '../content/store';
import type { Asset } from './asset';
import {
  CMS_ERROR_CODES,
  ContentNotFoundError,
  ContentPermissionError,
  ContentReferenceError,
  ContentReferencedError,
  LayoutRuleError,
  PageTakenError,
} from './errors';
import type { ContentItem, ContentItemSummary, ItemUsage, ItemVersionRecord } from './item';
import { formatLayoutProblem, type LayoutProblem } from './layout-rules';
import type { EntryLanguage } from './languages';
import type { PageLayout, PageLayoutReadRecord, PageLayoutVersionRecord } from './page-layout';
import type { CmsContentStore, ResolvedItemRecord } from './store';
import type { CmsPage } from './page';
import type { SectionTemplateRecord } from './template';

/** What a failed call looks like (the shape the Supabase client gives, `PostgrestError`-like). */
export type CmsRpcError = { code?: string | null; message?: string | null; details?: string | null; hint?: string | null };
export type CmsRpcResult = { data: unknown; error: CmsRpcError | null };

/** A table read: `select(columns)`, optionally narrowed with `eq`, awaited for the rows or ended with `maybeSingle()`. */
export interface CmsTableQuery extends PromiseLike<CmsRpcResult> {
  eq(column: string, value: unknown): CmsTableQuery;
  maybeSingle(): PromiseLike<CmsRpcResult>;
}

/** The part of a Supabase client the store uses. A real client is passed as it is. */
export interface CmsSupabaseClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<CmsRpcResult>;
  from(table: string): { select(columns: string): CmsTableQuery };
}

/**
 * The columns of contracts 5.1 that a visitor may select, and nothing else (a select of a column with no grant fails
 * the whole read). The file size (`cms_assets.bytes`) is one of them.
 */
export const TEMPLATE_COLUMNS = 'key, name, container_type_key, slots, built_in, created_at, updated_at';
export const ASSET_COLUMNS = 'id, bucket, path, mime, bytes, width, height, label, created_at';

type Row = Record<string, any>;
type NotFoundContext = { kind?: ContentNotFoundError['kind']; id?: string };

const asRows = (data: unknown): Row[] => (Array.isArray(data) ? (data as Row[]) : data === null || data === undefined ? [] : [data as Row]);
const firstRow = (data: unknown): Row | undefined => asRows(data)[0];

function parseDetail(details: string | null | undefined): unknown {
  if (!details) return undefined;
  try {
    return JSON.parse(details);
  } catch {
    const lines = details.split('\n').map((line) => line.trim()).filter(Boolean);
    try {
      return lines.map((line) => JSON.parse(line));
    } catch {
      return undefined;
    }
  }
}
const idsOf = (detail: unknown): string[] => {
  const list = Array.isArray(detail) ? detail : Array.isArray((detail as { ids?: unknown })?.ids) ? (detail as { ids: unknown[] }).ids : [];
  return list.filter((entry): entry is string => typeof entry === 'string');
};
const pick = (row: Row, snake: string, camel: string) => row[snake] ?? row[camel];

function toVersionRecord(row: Row | undefined): ContentVersionRecord {
  return {
    version: Number(row?.version ?? 0),
    status: row?.status === 'published' ? 'published' : 'draft',
    content: row?.content ?? null,
    changedBy: pick(row ?? {}, 'changed_by', 'changedBy') ?? null,
    changedByEmail: pick(row ?? {}, 'changed_by_email', 'changedByEmail') ?? null,
    changedAt: pick(row ?? {}, 'changed_at', 'changedAt') ?? '',
    restoredFrom: pick(row ?? {}, 'restored_from', 'restoredFrom') ?? null,
  };
}

/** A usage as the list function returns it (snake_case columns) or as the CM002 detail carries it (camelCase keys). */
const toUsage = (row: Row): ItemUsage => ({
  sourceKind: pick(row, 'source_kind', 'sourceKind'),
  sourceId: pick(row, 'source_id', 'sourceId'),
  sourceLabel: pick(row, 'source_label', 'sourceLabel') ?? '',
  sourceLanguage: pick(row, 'source_language', 'sourceLanguage') ?? null,
  inPublished: Boolean(pick(row, 'in_published', 'inPublished')),
  inNewest: Boolean(pick(row, 'in_newest', 'inNewest')),
});

/** Turns what a database function raised into the error classes of `errors.ts`, by `CMS_ERROR_CODES`. */
export function mapCmsError(error: CmsRpcError, context: NotFoundContext & { itemId?: string } = {}): Error {
  const message = error.message ?? 'The database refused the call.';
  const detail = parseDetail(error.details);
  switch (error.code) {
    case CMS_ERROR_CODES.stale:
      return new ContentConflictError(toVersionRecord(detail && typeof detail === 'object' && !Array.isArray(detail) ? (detail as Row) : undefined));
    case CMS_ERROR_CODES.permission:
      return new ContentPermissionError(message);
    case CMS_ERROR_CODES.invalid:
    case CMS_ERROR_CODES.assetInvalid:
      return new ContentValidationError(message, [message]);
    case CMS_ERROR_CODES.notFound: {
      const named = detail && typeof detail === 'object' && !Array.isArray(detail) ? (detail as { kind?: ContentNotFoundError['kind']; id?: string }) : {};
      return new ContentNotFoundError(named.kind ?? context.kind ?? 'item', named.id ?? context.id ?? '');
    }
    case CMS_ERROR_CODES.referenced:
      return new ContentReferencedError(context.itemId ?? context.id ?? '', (Array.isArray(detail) ? (detail as Row[]) : []).map(toUsage));
    case CMS_ERROR_CODES.danglingReference:
      return new ContentReferenceError('missing', idsOf(detail));
    case CMS_ERROR_CODES.notReusable:
      return new ContentReferenceError('not-reusable', idsOf(detail));
    case CMS_ERROR_CODES.cycle:
      return new ContentReferenceError('cycle', idsOf(detail));
    case CMS_ERROR_CODES.pageTaken: {
      const named = detail && typeof detail === 'object' && !Array.isArray(detail) ? (detail as { field?: unknown; value?: unknown }) : {};
      return new PageTakenError(named.field === 'pageKey' ? 'pageKey' : 'slug', typeof named.value === 'string' ? named.value : '');
    }
    case CMS_ERROR_CODES.slotRule:
    case CMS_ERROR_CODES.layoutIncomplete: {
      const problems = (Array.isArray(detail) ? (detail as Row[]) : []).map((entry): LayoutProblem => ({ section: String(entry.section ?? ''), slot: entry.slot ?? null, message: String(entry.message ?? '') }));
      return new LayoutRuleError(message, problems.map(formatLayoutProblem));
    }
    default: {
      const unknown = new Error(`${message}${error.code ? ` (${error.code})` : ''}`);
      (unknown as Error & { cause?: unknown }).cause = error;
      return unknown;
    }
  }
}

/**
 * The legacy section entries' functions, which the campaign site already has. The argument names are the ones the
 * existing store passes; see docs/cms/wp1-notes.md.
 */
const LEGACY = {
  readPublished: 'content_read_published',
  readNewest: 'content_read_newest',
  listVersions: 'content_list_versions',
  saveDraft: 'content_save_draft',
  publish: 'content_publish',
  restore: 'content_restore',
} as const;

/**
 * The store over Supabase. It calls exactly the functions of contracts section 4, reads exactly the columns of 5.1,
 * and maps every error code of `CMS_ERROR_CODES` to its error class. The database makes every decision; this file only
 * carries arguments and rows. The legacy `ContentStore` methods call the existing `content_*` functions.
 */
export function createSupabaseCmsStore(client: CmsSupabaseClient): CmsContentStore {
  async function call(fn: string, args: Record<string, unknown>, context: NotFoundContext & { itemId?: string } = {}): Promise<unknown> {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw mapCmsError(error, context);
    return data;
  }
  async function readTable(table: string, columns: string, filters: [string, unknown][] = [], single = false): Promise<Row[]> {
    let query = client.from(table).select(columns);
    for (const [column, value] of filters) query = query.eq(column, value);
    const { data, error } = await (single ? query.maybeSingle() : query);
    if (error) throw mapCmsError(error);
    return asRows(data);
  }

  const toItem = (row: Row): ContentItem => ({ id: row.id, typeKey: row.type_key, title: row.title, reusable: Boolean(row.reusable), translatable: Boolean(row.translatable), createdAt: row.created_at });
  const toItemVersion = (itemId: string, language: EntryLanguage, row: Row): ItemVersionRecord => ({
    itemId,
    language,
    version: row.version,
    status: row.status,
    content: row.content,
    changedBy: row.changed_by ?? null,
    changedByEmail: row.changed_by_email ?? null,
    changedAt: row.changed_at,
    restoredFrom: row.restored_from ?? null,
  });
  const withoutContent = <T extends { content: unknown }>(record: T): Omit<T, 'content'> => {
    const { content: _content, ...rest } = record;
    return rest;
  };
  const toLayoutRead = (pageKey: string, row: Row): PageLayoutReadRecord => ({
    pageKey,
    version: row.version,
    status: row.status,
    isDraft: Boolean(row.is_draft),
    content: row.content,
    changedAt: row.changed_at,
  });
  const toLayoutVersion = (pageKey: string, row: Row): PageLayoutVersionRecord => ({
    pageKey,
    version: row.version,
    status: row.status,
    content: row.content,
    changedBy: row.changed_by ?? null,
    changedByEmail: row.changed_by_email ?? null,
    changedAt: row.changed_at,
    restoredFrom: row.restored_from ?? null,
  });
  const toTemplate = (row: Row): SectionTemplateRecord => ({
    key: row.key,
    name: row.name,
    containerTypeKey: row.container_type_key,
    slots: row.slots,
    builtIn: Boolean(row.built_in),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  const toAsset = (row: Row): Asset => ({
    id: row.id,
    bucket: row.bucket,
    path: row.path,
    mime: row.mime,
    bytes: row.bytes ?? 0,
    width: row.width ?? null,
    height: row.height ?? null,
    label: row.label ?? null,
    createdAt: row.created_at,
  });

  const items: CmsContentStore['items'] = {
    async createItem(input) {
      const data = await call('cms_create_item', { p_type_key: input.typeKey, p_title: input.title, p_reusable: input.reusable ?? false, p_translatable: input.translatable });
      return toItem(firstRow(data) as Row);
    },
    async updateItem(itemId, changes) {
      const data = await call('cms_update_item', { p_item_id: itemId, p_title: changes.title ?? null, p_reusable: changes.reusable ?? null }, { kind: 'item', id: itemId });
      return toItem(firstRow(data) as Row);
    },
    async listItems(filter) {
      const data = await call('cms_list_items', { p_type_key: filter?.typeKey ?? null });
      return asRows(data).map(
        (row): ContentItemSummary => ({ ...toItem(row), publishedLanguages: row.published_languages ?? [], usageCount: Number(row.usage_count ?? 0) }),
      );
    },
    async readPublished(itemId, language) {
      const row = firstRow(await call('cms_read_published', { p_item_id: itemId, p_language: language }, { kind: 'item', id: itemId }));
      return row ? toItemVersion(itemId, language, row) : null;
    },
    async readNewest(itemId, language) {
      const row = firstRow(await call('cms_read_newest', { p_item_id: itemId, p_language: language }, { kind: 'item', id: itemId }));
      return row ? toItemVersion(itemId, language, row) : null;
    },
    async listVersions(itemId, language) {
      const data = await call('cms_list_versions', { p_item_id: itemId, p_language: language }, { kind: 'item', id: itemId });
      return asRows(data).map((row) => withoutContent(toItemVersion(itemId, language, row)));
    },
    async resolveItems(itemIds, language, preview) {
      const data = await call('cms_resolve_items', { p_item_ids: [...itemIds], p_language: language, p_preview: preview });
      return asRows(data).map(
        (row): ResolvedItemRecord => ({
          itemId: row.item_id,
          typeKey: row.type_key,
          reusable: Boolean(row.reusable),
          translatable: Boolean(row.translatable),
          language: row.language,
          version: row.version,
          status: row.status,
          isDraft: Boolean(row.is_draft),
          content: row.content,
        }),
      );
    },
    async saveDraft(itemId, language, content, refs, baseVersion) {
      const data = await call('cms_save_item_draft', { p_item_id: itemId, p_language: language, p_base_version: baseVersion, p_content: content, p_refs: [...refs] }, { kind: 'item', id: itemId });
      return Number(data);
    },
    async publish(itemId, language, version) {
      await call('cms_publish_item', { p_item_id: itemId, p_language: language, p_version: version }, { kind: 'item', id: itemId });
    },
    async restore(itemId, language, version, baseVersion) {
      const data = await call('cms_restore_item', { p_item_id: itemId, p_language: language, p_version: version, p_base_version: baseVersion }, { kind: 'item', id: itemId });
      return Number(data);
    },
    async listUsages(itemId) {
      return asRows(await call('cms_list_usages', { p_item_id: itemId }, { kind: 'item', id: itemId })).map(toUsage);
    },
    async deleteItem(itemId) {
      await call('cms_delete_item', { p_item_id: itemId }, { kind: 'item', id: itemId, itemId });
    },
  };

  const layouts: CmsContentStore['layouts'] = {
    async readPublished(pageKey) {
      const row = firstRow(await call('cms_read_layout', { p_page_key: pageKey, p_preview: false }, { kind: 'layout', id: pageKey }));
      return row ? toLayoutVersion(pageKey, row) : null;
    },
    async read(pageKey, preview) {
      // `cms_read_layout` is granted to visitors too; the database ignores `p_preview` for anyone who is not an editor.
      const row = firstRow(await call('cms_read_layout', { p_page_key: pageKey, p_preview: preview }, { kind: 'layout', id: pageKey }));
      return row ? toLayoutRead(pageKey, row) : null;
    },
    async readNewest(pageKey) {
      const row = firstRow(await call('cms_read_layout_newest', { p_page_key: pageKey }, { kind: 'layout', id: pageKey }));
      return row ? toLayoutVersion(pageKey, row) : null;
    },
    async listVersions(pageKey) {
      const data = await call('cms_list_layout_versions', { p_page_key: pageKey }, { kind: 'layout', id: pageKey });
      return asRows(data).map((row) => withoutContent(toLayoutVersion(pageKey, row)));
    },
    async listLayouts() {
      return asRows(await call('cms_list_layouts', {})).map((row): PageLayout => ({ id: row.id, pageKey: row.page_key, publishedVersion: row.published_version ?? null, createdAt: row.created_at }));
    },
    async saveDraft(pageKey, content, refs, baseVersion) {
      return Number(await call('cms_save_layout_draft', { p_page_key: pageKey, p_base_version: baseVersion, p_content: content, p_refs: [...refs] }, { kind: 'layout', id: pageKey }));
    },
    async publish(pageKey, version) {
      await call('cms_publish_layout', { p_page_key: pageKey, p_version: version }, { kind: 'layout', id: pageKey });
    },
    async restore(pageKey, version, baseVersion) {
      return Number(await call('cms_restore_layout', { p_page_key: pageKey, p_version: version, p_base_version: baseVersion }, { kind: 'layout', id: pageKey }));
    },
    async reorderSlot(pageKey, sectionKey, slotKey, itemIds, baseVersion) {
      return Number(
        await call('cms_reorder_slot', { p_page_key: pageKey, p_base_version: baseVersion, p_section_key: sectionKey, p_slot_key: slotKey, p_item_ids: [...itemIds] }, { kind: 'layout', id: pageKey }),
      );
    },
  };

  const templates: CmsContentStore['templates'] = {
    async list() {
      return asRows(await call('cms_list_templates', {})).map(toTemplate);
    },
    async get(key) {
      const [row] = await readTable('cms_templates', TEMPLATE_COLUMNS, [['key', key]], true);
      return row ? toTemplate(row) : null;
    },
    async save(template) {
      const data = await call('cms_save_template', { p_key: template.key, p_name: template.name, p_container_type_key: template.containerTypeKey, p_slots: template.slots }, { kind: 'template', id: template.key });
      return toTemplate(firstRow(data) as Row);
    },
  };

  const assets: CmsContentStore['assets'] = {
    async list() {
      return (await readTable('cms_assets', ASSET_COLUMNS)).map(toAsset);
    },
    async get(assetId) {
      const [row] = await readTable('cms_assets', ASSET_COLUMNS, [['id', assetId]], true);
      return row ? toAsset(row) : null;
    },
    async register(asset) {
      const data = await call('cms_register_asset', { p_path: asset.path, p_mime: asset.mime, p_bytes: asset.bytes, p_width: asset.width, p_height: asset.height, p_label: asset.label });
      return toAsset(firstRow(data) as Row);
    },
  };

  const toPage = (row: Row): CmsPage => ({
    id: row.id,
    pageKey: row.page_key,
    slug: row.slug,
    titles: row.titles ?? {},
    descriptions: row.descriptions ?? {},
    publishedVersion: row.published_version ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  const pages: CmsContentStore['pages'] = {
    async create(page) {
      const data = await call('cms_create_page', { p_page_key: page.pageKey, p_slug: page.slug, p_titles: page.titles, p_descriptions: page.descriptions ?? {} });
      return toPage(firstRow(data) as Row);
    },
    async update(pageKey, changes) {
      const data = await call(
        'cms_update_page',
        { p_page_key: pageKey, p_slug: changes.slug ?? null, p_titles: changes.titles ?? null, p_descriptions: changes.descriptions ?? null },
        { kind: 'page', id: pageKey },
      );
      return toPage(firstRow(data) as Row);
    },
    async list() {
      return asRows(await call('cms_list_pages', {})).map(toPage);
    },
    async readBySlug(slug, preview) {
      const row = firstRow(await call('cms_read_page_by_slug', { p_slug: slug, p_preview: preview }));
      if (!row) return null;
      return {
        page: toPage(row),
        layout: toLayoutRead(row.page_key, row),
      };
    },
  };

  const legacy = (row: Row): ContentVersionRecord => toVersionRecord(row);
  const legacyArgs = (section: string, language: string) => ({ p_section: section, p_language: language });

  return {
    async readPublished(key, language) {
      const row = firstRow(await call(LEGACY.readPublished, legacyArgs(key, language)));
      return row ? legacy(row) : null;
    },
    async readNewest(key, language) {
      const row = firstRow(await call(LEGACY.readNewest, legacyArgs(key, language)));
      return row ? legacy(row) : null;
    },
    async listVersions(key, language) {
      return asRows(await call(LEGACY.listVersions, legacyArgs(key, language))).map((row) => withoutContent(legacy(row)));
    },
    async saveDraft(key, language, content, baseVersion) {
      return Number(await call(LEGACY.saveDraft, { ...legacyArgs(key, language), p_base_version: baseVersion, p_content: content }));
    },
    async publish(key, language, version) {
      await call(LEGACY.publish, { ...legacyArgs(key, language), p_version: version });
    },
    async restore(key, language, version, baseVersion) {
      return Number(await call(LEGACY.restore, { ...legacyArgs(key, language), p_version: version, p_base_version: baseVersion }));
    },
    items,
    layouts,
    templates,
    assets,
    pages,
  };
}
