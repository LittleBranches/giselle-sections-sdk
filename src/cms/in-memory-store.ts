import { ContentConflictError, ContentValidationError } from '../content/errors';
import { createInMemoryContentStore, type ContentVersionRecord } from '../content/store';
import { newAssetSchema, type Asset, type NewAsset } from './asset';
import {
  ContentNotFoundError,
  ContentPermissionError,
  ContentReferenceError,
  ContentReferencedError,
  LayoutRuleError,
  PageTakenError,
} from './errors';
import type { ContentItem, ContentItemSummary, ItemUsage, ItemVersionRecord } from './item';
import { newContentItemSchema } from './item';
import { checkLayoutSlots, formatLayoutProblem } from './layout-rules';
import { NEUTRAL_LANGUAGE, UNIVERSAL_FALLBACK_LANGUAGE, type EntryLanguage } from './languages';
import { keySchema } from './keys';
import { cmsPageChangesSchema, newCmsPageSchema, type CmsPage } from './page';
import { pageLayoutContentSchema, type PageLayout, type PageLayoutContent, type PageLayoutVersionRecord } from './page-layout';
import type { CmsContentStore, ResolvedItemRecord } from './store';
import { BUILTIN_SECTION_TEMPLATES, sectionTemplateSchema, type SectionTemplate, type SectionTemplateRecord } from './template';

/** Who the in-memory store pretends the caller is. The database knows this from the session; a test sets it. */
export type CmsRole = 'visitor' | 'member' | 'editor' | 'owner';

export type ChangeLogEntry = {
  at: string;
  action: 'publish_item' | 'publish_layout' | 'delete_item' | 'save_template' | 'register_asset' | 'create_page' | 'update_page';
  subjectId: string;
  language: string | null;
  version: number | null;
};

export interface InMemoryCmsStore extends CmsContentStore {
  /** Test hook: who the caller is from now on. Starts as `visitor`, the least a caller can be. */
  setRole(role: CmsRole): void;
  getRole(): CmsRole;
  /** Test hook: puts a file in the pretend bucket, so an asset can be registered for it. */
  uploadObject(path: string): void;
  /** The append-only change log (publishes, deletes, template saves, asset registrations). */
  changeLog(): readonly ChangeLogEntry[];
}

export type InMemoryCmsStoreOptions = { role?: CmsRole; now?: () => Date; newId?: () => string };

const BUCKET = 'site-images';
const MAX_RESOLVE_IDS = 500;
const LANGUAGE_PATTERN = /^([a-z]{2}|all)$/;

type EntryRecord = { id: string; itemId: string; language: EntryLanguage; versions: ItemVersionRecord[]; published: number | null };
type LayoutRecord = { id: string; pageKey: string; createdAt: string; versions: PageLayoutVersionRecord[]; published: number | null };
/** One row of the reference index: which version of which source points at which item. */
type RefRow = { kind: 'item' | 'layout'; sourceId: string; place: string; version: number; target: string };

const copy = <T>(value: T): T => structuredClone(value);
const lastOf = <T>(list: T[]): T | undefined => list[list.length - 1];
const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A store that keeps everything in memory and follows every rule of the database (contracts sections 3 to 6): versions,
 * stale saves, the publish pointer, restore, the reference checks, usages, delete, slot rules, language fallback, roles
 * and the preview rule. For tests and for sites that have no database yet. Everything it returns is a copy.
 */
export function createInMemoryCmsStore(options: InMemoryCmsStoreOptions = {}): InMemoryCmsStore {
  let role: CmsRole = options.role ?? 'visitor';
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID());
  const stamp = () => now().toISOString();

  const items = new Map<string, ContentItem>();
  const entries = new Map<string, EntryRecord>(); // `${itemId}/${language}`
  const layouts = new Map<string, LayoutRecord>(); // by page key
  const pages = new Map<string, Omit<CmsPage, 'publishedVersion'>>(); // by page key
  const refs: RefRow[] = [];
  const assets = new Map<string, Asset>();
  const bucket = new Set<string>();
  const log: ChangeLogEntry[] = [];
  const templates = new Map<string, SectionTemplateRecord>();
  for (const template of BUILTIN_SECTION_TEMPLATES) templates.set(template.key, { ...copy(template), createdAt: stamp(), updatedAt: stamp() });

  const canEdit = () => role === 'editor' || role === 'owner';
  const requireEditor = () => {
    if (!canEdit()) throw new ContentPermissionError('Only editors and owners can change content.');
  };
  const requireOwner = () => {
    if (role !== 'owner') throw new ContentPermissionError('Only owners can do that.');
  };
  const record = (action: ChangeLogEntry['action'], subjectId: string, language: string | null, version: number | null) =>
    log.push({ at: stamp(), action, subjectId, language, version });

  const mustItem = (itemId: string): ContentItem => {
    const item = items.get(itemId);
    if (!item) throw new ContentNotFoundError('item', itemId);
    return item;
  };
  const entryOf = (itemId: string, language: EntryLanguage) => entries.get(`${itemId}/${language}`);
  const mustLayout = (pageKey: string): LayoutRecord => {
    const layout = layouts.get(pageKey);
    if (!layout) throw new ContentNotFoundError('layout', pageKey);
    return layout;
  };

  const asConflict = (latest: { version: number; status: 'draft' | 'published'; content: unknown; changedBy: string | null; changedByEmail: string | null; changedAt: string; restoredFrom: number | null } | undefined): ContentConflictError => {
    const current: ContentVersionRecord = latest
      ? { version: latest.version, status: latest.status, content: copy(latest.content), changedBy: latest.changedBy, changedByEmail: latest.changedByEmail, changedAt: latest.changedAt, restoredFrom: latest.restoredFrom }
      : { version: 0, status: 'draft', content: null, changedBy: null, changedByEmail: null, changedAt: stamp(), restoredFrom: null };
    return new ContentConflictError(current);
  };
  /** A write carries the version it was based on (`null` for the first save); anything but the newest is stale. */
  const assertBase = (latest: { version: number } & Parameters<typeof asConflict>[0] | undefined, base: number | null) => {
    if (latest ? latest.version !== base : base !== null) throw asConflict(latest);
  };

  // ---- the reference index -------------------------------------------------------------------------------------

  const itemPlace = (itemId: string) => `item:${itemId}`;
  const layoutPlace = (pageKey: string) => `layout:${pageKey}`;
  const sourceVersions = (row: RefRow): { newest: number | undefined; published: number | null } => {
    if (row.kind === 'item') {
      const entry = [...entries.values()].find((candidate) => candidate.id === row.sourceId);
      return { newest: lastOf(entry?.versions ?? [])?.version, published: entry?.published ?? null };
    }
    const layout = [...layouts.values()].find((candidate) => candidate.id === row.sourceId);
    return { newest: lastOf(layout?.versions ?? [])?.version, published: layout?.published ?? null };
  };
  /** A reference counts when its version is the source's newest or published one (contracts 3.7). */
  const counts = (row: RefRow) => {
    const { newest, published } = sourceVersions(row);
    return row.version === newest || row.version === published;
  };
  /** The item (all its languages together) or the layout that holds a reference: one source for the CM005 rule. */
  const holderOf = (row: RefRow): string =>
    row.kind === 'item' ? ([...entries.values()].find((entry) => entry.id === row.sourceId)?.itemId ?? row.sourceId) : row.sourceId;
  const countingRefsTo = (target: string) => refs.filter((row) => row.target === target && counts(row));
  const refsOfVersion = (sourceId: string, version: number) => refs.filter((row) => row.sourceId === sourceId && row.version === version).map((row) => row.target);
  const outgoing = (itemId: string): string[] =>
    refs.filter((row) => row.kind === 'item' && row.place === itemPlace(itemId) && counts(row)).map((row) => row.target);

  /** The ids on a path from `from` to `to` through counting references, or `null`. */
  const pathBetween = (from: string, to: string): string[] | null => {
    const parent = new Map<string, string | null>([[from, null]]);
    const stack = [from];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === to) {
        const path: string[] = [];
        for (let node: string | null | undefined = current; node; node = parent.get(node)) path.unshift(node);
        return path;
      }
      for (const next of outgoing(current)) {
        if (!parent.has(next)) {
          parent.set(next, current);
          stack.push(next);
        }
      }
    }
    return null;
  };

  /** Contracts 4.6, in this order: missing (CM003), cycle (CM008), not reusable (CM005). */
  function checkRefs(kind: 'item' | 'layout', place: string, sourceItemId: string | null, wanted: readonly string[]): void {
    const ids = [...new Set(wanted)];
    const missing = ids.filter((id) => !items.has(id));
    if (missing.length > 0) throw new ContentReferenceError('missing', missing);
    if (kind === 'item' && sourceItemId) {
      for (const target of ids) {
        const path = pathBetween(target, sourceItemId);
        if (path) throw new ContentReferenceError('cycle', [sourceItemId, ...path]);
      }
    }
    const notReusable = ids.filter((id) => !items.get(id)?.reusable && countingRefsTo(id).some((row) => row.place !== place));
    if (notReusable.length > 0) throw new ContentReferenceError('not-reusable', notReusable);
  }

  function usagesOf(itemId: string): ItemUsage[] {
    const bySource = new Map<string, ItemUsage>();
    for (const row of countingRefsTo(itemId)) {
      const { newest, published } = sourceVersions(row);
      const existing = bySource.get(row.sourceId);
      const inPublished = (existing?.inPublished ?? false) || row.version === published;
      const inNewest = (existing?.inNewest ?? false) || row.version === newest;
      if (row.kind === 'item') {
        const entry = [...entries.values()].find((candidate) => candidate.id === row.sourceId) as EntryRecord;
        bySource.set(row.sourceId, { sourceKind: 'item', sourceId: entry.itemId, sourceLabel: items.get(entry.itemId)?.title ?? '', sourceLanguage: entry.language, inPublished, inNewest });
      } else {
        const layout = [...layouts.values()].find((candidate) => candidate.id === row.sourceId) as LayoutRecord;
        bySource.set(row.sourceId, { sourceKind: 'layout', sourceId: layout.id, sourceLabel: layout.pageKey, sourceLanguage: null, inPublished, inNewest });
      }
    }
    return [...bySource.values()];
  }

  // ---- items -------------------------------------------------------------------------------------------------

  const asVersionRecord = (entry: EntryRecord, version: ItemVersionRecord): ItemVersionRecord => ({ ...copy(version), itemId: entry.itemId, language: entry.language });

  function checkItemLanguage(item: ContentItem, language: string): void {
    if (!LANGUAGE_PATTERN.test(language)) throw new ContentValidationError(`"${language}" is not a language code.`, [`language: "${language}" is not a language code`]);
    if (item.translatable && language === NEUTRAL_LANGUAGE) throw new ContentValidationError('A translatable item has an entry per language, not one for all.', ['language: use a real language']);
    if (!item.translatable && language !== NEUTRAL_LANGUAGE) throw new ContentValidationError('An item that is not translatable has one entry, language "all".', ['language: use "all"']);
  }
  function checkObject(content: unknown): void {
    if (!isPlainObject(content)) throw new ContentValidationError('The content must be an object.', ['(content): must be an object']);
  }

  function appendItemVersion(item: ContentItem, language: EntryLanguage, content: unknown, targets: readonly string[], base: number | null, restoredFrom: number | null): number {
    const existing = entryOf(item.id, language);
    assertBase(existing ? lastOf(existing.versions) : undefined, base);
    const entryId = existing?.id ?? newId();
    checkRefs('item', itemPlace(item.id), item.id, targets);
    const entry = existing ?? { id: entryId, itemId: item.id, language, versions: [], published: null };
    const version = (lastOf(entry.versions)?.version ?? 0) + 1;
    entry.versions.push({ itemId: item.id, language, version, status: 'draft', content: copy(content), changedBy: null, changedByEmail: null, changedAt: stamp(), restoredFrom });
    entries.set(`${item.id}/${language}`, entry);
    for (const target of new Set(targets)) refs.push({ kind: 'item', sourceId: entry.id, place: itemPlace(item.id), version, target });
    return version;
  }

  const itemStore: CmsContentStore['items'] = {
    async createItem(input) {
      requireEditor();
      const parsed = newContentItemSchema.safeParse({ typeKey: input.typeKey, title: input.title, reusable: input.reusable });
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`);
        throw new ContentValidationError(`That item is not valid: ${issues.join('; ')}`, issues);
      }
      const item: ContentItem = { id: newId(), typeKey: parsed.data.typeKey, title: parsed.data.title, reusable: parsed.data.reusable, translatable: input.translatable, createdAt: stamp() };
      items.set(item.id, item);
      return copy(item);
    },

    async updateItem(itemId, changes) {
      requireEditor();
      const item = mustItem(itemId);
      if (changes.title !== undefined && (changes.title.length < 1 || changes.title.length > 120)) {
        throw new ContentValidationError('A title is 1 to 120 characters.', ['title: 1 to 120 characters']);
      }
      if (changes.reusable === false && item.reusable) {
        const holders = new Set(countingRefsTo(itemId).map((row) => `${row.kind}:${holderOf(row)}`));
        if (holders.size > 1) throw new ContentReferenceError('not-reusable', [...new Set(countingRefsTo(itemId).map(holderOf))]);
      }
      if (changes.title !== undefined) item.title = changes.title;
      if (changes.reusable !== undefined) item.reusable = changes.reusable;
      return copy(item);
    },

    async listItems(filter) {
      if (!canEdit()) return [];
      return [...items.values()]
        .filter((item) => !filter?.typeKey || item.typeKey === filter.typeKey)
        .map((item): ContentItemSummary => {
          const own = [...entries.values()].filter((entry) => entry.itemId === item.id && entry.published !== null);
          return { ...copy(item), publishedLanguages: own.map((entry) => entry.language), usageCount: new Set(usagesOf(item.id).map((usage) => `${usage.sourceKind}:${usage.sourceId}`)).size };
        });
    },

    async readPublished(itemId, language) {
      const entry = entryOf(itemId, language);
      const live = entry?.versions.find((version) => version.version === entry.published);
      return entry && live ? asVersionRecord(entry, live) : null;
    },

    async readNewest(itemId, language) {
      if (!canEdit()) return null;
      const entry = entryOf(itemId, language);
      const latest = lastOf(entry?.versions ?? []);
      return entry && latest ? asVersionRecord(entry, latest) : null;
    },

    async listVersions(itemId, language) {
      if (!canEdit()) return [];
      const entry = entryOf(itemId, language);
      if (!entry) return [];
      return [...entry.versions].reverse().map((version) => {
        const { content: _content, ...info } = asVersionRecord(entry, version);
        return info;
      });
    },

    async resolveItems(itemIds, language, preview) {
      if (itemIds.length > MAX_RESOLVE_IDS) throw new ContentValidationError(`At most ${MAX_RESOLVE_IDS} items can be resolved at once.`, ['itemIds: too many']);
      const showDrafts = preview && canEdit();
      const resolved: ResolvedItemRecord[] = [];
      for (const itemId of new Set(itemIds)) {
        const item = items.get(itemId);
        if (!item) continue;
        const candidates: EntryLanguage[] = item.translatable ? [...new Set<EntryLanguage>([language, UNIVERSAL_FALLBACK_LANGUAGE])] : [NEUTRAL_LANGUAGE];
        for (const candidate of candidates) {
          const entry = entryOf(itemId, candidate);
          const shown = showDrafts ? lastOf(entry?.versions ?? []) : entry?.versions.find((version) => version.version === entry.published);
          if (!entry || !shown) continue;
          resolved.push({
            itemId,
            typeKey: item.typeKey,
            reusable: item.reusable,
            translatable: item.translatable,
            language: candidate,
            version: shown.version,
            status: shown.status,
            isDraft: shown.version !== entry.published,
            content: copy(shown.content),
          });
          break;
        }
      }
      return resolved;
    },

    async saveDraft(itemId, language, content, targets, baseVersion) {
      requireEditor();
      checkObject(content);
      const item = mustItem(itemId);
      checkItemLanguage(item, language);
      return appendItemVersion(item, language, content, targets, baseVersion, null);
    },

    async publish(itemId, language, version) {
      requireEditor();
      mustItem(itemId);
      const entry = entryOf(itemId, language);
      if (!entry) throw new ContentValidationError('There is nothing to publish: the entry has no versions.', ['version: no such entry']);
      const latest = lastOf(entry.versions) as ItemVersionRecord;
      if (latest.version !== version) throw asConflict(latest);
      if (entry.published === version) return;
      latest.status = 'published';
      entry.published = version;
      record('publish_item', itemId, language, version);
    },

    async restore(itemId, language, version, baseVersion) {
      requireEditor();
      const item = mustItem(itemId);
      const entry = entryOf(itemId, language);
      const old = entry?.versions.find((candidate) => candidate.version === version);
      if (!entry || !old) throw new ContentValidationError(`There is no version ${version} to restore.`, ['version: no such version']);
      return appendItemVersion(item, language, old.content, refsOfVersion(entry.id, version), baseVersion, version);
    },

    async listUsages(itemId) {
      if (!canEdit() || !items.has(itemId)) return [];
      return usagesOf(itemId);
    },

    async deleteItem(itemId) {
      requireOwner();
      mustItem(itemId);
      const usages = usagesOf(itemId);
      if (usages.length > 0) throw new ContentReferencedError(itemId, usages);
      const own = [...entries.values()].filter((entry) => entry.itemId === itemId);
      const ownIds = new Set(own.map((entry) => entry.id));
      for (let index = refs.length - 1; index >= 0; index -= 1) if (ownIds.has((refs[index] as RefRow).sourceId)) refs.splice(index, 1);
      for (const entry of own) entries.delete(`${itemId}/${entry.language}`);
      items.delete(itemId);
      record('delete_item', itemId, null, null);
    },
  };

  // ---- layouts -----------------------------------------------------------------------------------------------

  const asLayoutRecord = (layout: LayoutRecord, version: PageLayoutVersionRecord): PageLayoutVersionRecord => ({ ...copy(version), pageKey: layout.pageKey });

  function parseLayout(content: unknown): PageLayoutContent {
    const parsed = pageLayoutContentSchema.safeParse(content);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(content)'}: ${issue.message}`);
      throw new ContentValidationError(`That layout is not valid: ${issues.join('; ')}`, issues);
    }
    return parsed.data;
  }
  function assertSlots(content: PageLayoutContent, forPublish: boolean): void {
    const problems = checkLayoutSlots(content, { template: (key) => templates.get(key), itemType: (id) => items.get(id)?.typeKey }, forPublish);
    if (problems.length === 0) return;
    const issues = problems.map(formatLayoutProblem);
    const onlyMinimums = forPublish && problems.every((problem) => /^holds \d+ items; at least/.test(problem.message));
    throw new LayoutRuleError(onlyMinimums ? `This page is not complete enough to publish: ${issues.join('; ')}` : `This page breaks the rules of its templates: ${issues.join('; ')}`, issues);
  }
  function appendLayoutVersion(pageKey: string, content: PageLayoutContent, targets: readonly string[], base: number | null, restoredFrom: number | null, checkSlots: boolean): number {
    const existing = layouts.get(pageKey);
    assertBase(existing ? lastOf(existing.versions) : undefined, base);
    checkRefs('layout', layoutPlace(pageKey), null, targets);
    if (checkSlots) assertSlots(content, false);
    const layout = existing ?? { id: newId(), pageKey, createdAt: stamp(), versions: [], published: null };
    const version = (lastOf(layout.versions)?.version ?? 0) + 1;
    layout.versions.push({ pageKey, version, status: 'draft', content: copy(content), changedBy: null, changedByEmail: null, changedAt: stamp(), restoredFrom });
    layouts.set(pageKey, layout);
    for (const target of new Set(targets)) refs.push({ kind: 'layout', sourceId: layout.id, place: layoutPlace(pageKey), version, target });
    return version;
  }

  const layoutStore: CmsContentStore['layouts'] = {
    async readPublished(pageKey) {
      const layout = layouts.get(pageKey);
      const live = layout?.versions.find((version) => version.version === layout.published);
      return layout && live ? asLayoutRecord(layout, live) : null;
    },
    async read(pageKey, preview) {
      const layout = layouts.get(pageKey);
      if (!layout) return null;
      const shown = preview && canEdit() ? lastOf(layout.versions) : layout.versions.find((version) => version.version === layout.published);
      if (!shown) return null;
      return { pageKey, version: shown.version, status: shown.status, isDraft: shown.status === 'draft', content: copy(shown.content), changedAt: shown.changedAt };
    },
    async readNewest(pageKey) {
      if (!canEdit()) return null;
      const layout = layouts.get(pageKey);
      const latest = lastOf(layout?.versions ?? []);
      return layout && latest ? asLayoutRecord(layout, latest) : null;
    },
    async listVersions(pageKey) {
      if (!canEdit()) return [];
      const layout = layouts.get(pageKey);
      if (!layout) return [];
      return [...layout.versions].reverse().map((version) => {
        const { content: _content, ...info } = asLayoutRecord(layout, version);
        return info;
      });
    },
    async listLayouts() {
      if (!canEdit()) return [];
      return [...layouts.values()].map((layout): PageLayout => ({ id: layout.id, pageKey: layout.pageKey, publishedVersion: layout.published, createdAt: layout.createdAt }));
    },
    async saveDraft(pageKey, content, targets, baseVersion) {
      requireEditor();
      const key = keySchema.safeParse(pageKey);
      if (!key.success) throw new ContentValidationError(`"${pageKey}" is not a valid page key.`, ['pageKey: use lowercase letters, digits and hyphens']);
      return appendLayoutVersion(pageKey, parseLayout(content), targets, baseVersion, null, true);
    },
    async publish(pageKey, version) {
      requireEditor();
      const layout = mustLayout(pageKey);
      const latest = lastOf(layout.versions) as PageLayoutVersionRecord;
      if (latest.version !== version) throw asConflict(latest);
      if (layout.published === version) return;
      assertSlots(parseLayout(latest.content), true);
      latest.status = 'published';
      layout.published = version;
      record('publish_layout', layout.id, null, version);
    },
    async restore(pageKey, version, baseVersion) {
      requireEditor();
      const layout = mustLayout(pageKey);
      const old = layout.versions.find((candidate) => candidate.version === version);
      if (!old) throw new ContentValidationError(`There is no version ${version} to restore.`, ['version: no such version']);
      return appendLayoutVersion(pageKey, parseLayout(old.content), refsOfVersion(layout.id, version), baseVersion, version, true);
    },
    async reorderSlot(pageKey, sectionKey, slotKey, itemIds, baseVersion) {
      requireEditor();
      const layout = mustLayout(pageKey);
      const latest = lastOf(layout.versions) as PageLayoutVersionRecord;
      const content = parseLayout(copy(latest.content));
      const section = content.sections.find((candidate) => candidate.key === sectionKey);
      const held = section?.slots[slotKey];
      if (!section || !held) throw new ContentValidationError(`There is no slot "${slotKey}" in section "${sectionKey}".`, [`${sectionKey}.${slotKey}: no such slot`]);
      const same = held.length === itemIds.length && [...held].sort().join() === [...itemIds].sort().join();
      if (!same) throw new ContentValidationError('The new order must hold exactly the items the slot holds now.', [`${sectionKey}.${slotKey}: not the same items`]);
      section.slots[slotKey] = [...itemIds];
      return appendLayoutVersion(pageKey, content, refsOfVersion(layout.id, latest.version), baseVersion, null, false);
    },
  };

  // ---- templates and assets ----------------------------------------------------------------------------------

  const templateStore: CmsContentStore['templates'] = {
    async list() {
      return [...templates.values()].map(copy);
    },
    async get(key) {
      const template = templates.get(key);
      return template ? copy(template) : null;
    },
    async save(template: SectionTemplate) {
      requireOwner();
      const parsed = sectionTemplateSchema.safeParse(template);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(template)'}: ${issue.message}`);
        throw new ContentValidationError(`That template is not valid: ${issues.join('; ')}`, issues);
      }
      for (const slot of parsed.data.slots) {
        if (slot.min > 100 || (slot.max ?? 0) > 100) throw new ContentValidationError('A slot holds at most 100 items.', [`slots.${slot.key}: min and max are at most 100`]);
      }
      const existing = templates.get(parsed.data.key);
      const saved: SectionTemplateRecord = { ...parsed.data, builtIn: existing?.builtIn ?? false, createdAt: existing?.createdAt ?? stamp(), updatedAt: stamp() };
      templates.set(saved.key, saved);
      record('save_template', saved.key, null, null);
      return copy(saved);
    },
  };

  const assetStore: CmsContentStore['assets'] = {
    async list() {
      return [...assets.values()].map(copy);
    },
    async get(assetId) {
      const asset = assets.get(assetId);
      return asset ? copy(asset) : null;
    },
    async register(asset: NewAsset) {
      requireEditor();
      const parsed = newAssetSchema.safeParse(asset);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(asset)'}: ${issue.message}`);
        throw new ContentValidationError(`That file cannot be registered: ${issues.join('; ')}`, issues);
      }
      if (!bucket.has(parsed.data.path)) throw new ContentValidationError(`There is no file "${parsed.data.path}" in the bucket.`, ['path: not in the bucket']);
      const existing = [...assets.values()].find((candidate) => candidate.path === parsed.data.path);
      if (existing) return copy(existing);
      const created: Asset = { id: newId(), bucket: BUCKET, ...parsed.data, createdAt: stamp() };
      assets.set(created.id, created);
      record('register_asset', created.id, null, null);
      return copy(created);
    },
  };

  // ---- pages ------------------------------------------------------------------------------------------------------

  const invalid = (what: string, error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }) => {
    const issues = error.issues.map((issue) => `${issue.path.map(String).join('.') || `(${what})`}: ${issue.message}`);
    return new ContentValidationError(`That ${what} is not valid: ${issues.join('; ')}`, issues);
  };
  const asPage = (page: Omit<CmsPage, 'publishedVersion'>): CmsPage => ({ ...copy(page), publishedVersion: layouts.get(page.pageKey)?.published ?? null });
  const slugTaken = (slug: string, except?: string) => [...pages.values()].some((page) => page.slug === slug && page.pageKey !== except);

  const pageStore: CmsContentStore['pages'] = {
    async create(input) {
      requireEditor();
      const parsed = newCmsPageSchema.safeParse(input);
      if (!parsed.success) throw invalid('page', parsed.error);
      const { pageKey, slug, titles, descriptions } = parsed.data;
      if (layouts.has(pageKey)) throw new PageTakenError('pageKey', pageKey);
      if (slugTaken(slug)) throw new PageTakenError('slug', slug);
      appendLayoutVersion(pageKey, { sections: [] }, [], null, null, false);
      const at = stamp();
      const page = { id: newId(), pageKey, slug, titles, descriptions: descriptions ?? {}, createdAt: at, updatedAt: at };
      pages.set(pageKey, page);
      record('create_page', page.id, null, null);
      return asPage(page);
    },
    async update(pageKey, changes) {
      requireEditor();
      const parsed = cmsPageChangesSchema.safeParse(changes);
      if (!parsed.success) throw invalid('page', parsed.error);
      const page = pages.get(pageKey);
      if (!page) throw new ContentNotFoundError('page', pageKey);
      if (parsed.data.slug !== undefined && slugTaken(parsed.data.slug, pageKey)) throw new PageTakenError('slug', parsed.data.slug);
      const next = {
        ...page,
        ...(parsed.data.slug !== undefined ? { slug: parsed.data.slug } : {}),
        ...(parsed.data.titles !== undefined ? { titles: parsed.data.titles } : {}),
        ...(parsed.data.descriptions !== undefined ? { descriptions: parsed.data.descriptions } : {}),
        updatedAt: stamp(),
      };
      pages.set(pageKey, next);
      record('update_page', page.id, null, null);
      return asPage(next);
    },
    async list() {
      if (!canEdit()) return [];
      return [...pages.values()].sort((a, b) => a.slug.localeCompare(b.slug)).map(asPage);
    },
    async readBySlug(slug, preview) {
      const page = [...pages.values()].find((candidate) => candidate.slug === slug);
      if (!page) return null;
      const layout = await layoutStore.read(page.pageKey, preview);
      return layout ? { page: asPage(page), layout } : null;
    },
  };

  return {
    ...createInMemoryContentStore(),
    items: itemStore,
    layouts: layoutStore,
    templates: templateStore,
    assets: assetStore,
    pages: pageStore,
    setRole(next) {
      role = next;
    },
    getRole: () => role,
    uploadObject(path) {
      bucket.add(path);
    },
    changeLog: () => log.map(copy),
  };
}
