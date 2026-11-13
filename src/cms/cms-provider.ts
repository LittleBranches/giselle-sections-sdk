import { ContentValidationError } from '../content/errors';
import { newAssetSchema } from './asset';
import { collectItemRefs, collectLayoutItemIds } from './collect';
import { ContentPermissionError } from './errors';
import type { ContentType } from './content-type';
import { cmsLanguageSchema, NEUTRAL_LANGUAGE, type CmsLanguage, type EntryLanguage } from './languages';
import { MAX_REFERENCE_DEPTH, type ResolvedItem } from './item';
import { pageLayoutContentSchema, type PageLayoutContent } from './page-layout';
import type { CreateCmsProvider, ResolveProblem, ResolvedPage, ResolvedSection } from './provider';
import type { ContentTypeRegistry } from './registry';
import type { ResolvedItemRecord } from './store';
import { sectionTemplateSchema, type SectionTemplate } from './template';

const MAX_IDS_PER_CALL = 500;

type Validated = { ok: true; content: unknown } | { ok: false; reason: 'unknown-type' | 'invalid-content'; message: string };
type Issue = { path: readonly PropertyKey[]; message: string };
const issuesOf = (error: { issues: readonly Issue[] }): string[] => error.issues.map((issue) => `${issue.path.map(String).join('.') || '(content)'}: ${issue.message}`);

function check<T>(type: ContentType<T>, content: unknown, when: 'save' | 'read'): T {
  const result = type.schema.safeParse(content);
  if (result.success) return result.data;
  const issues = issuesOf(result.error);
  throw new ContentValidationError(when === 'save' ? `That content is not valid: ${issues.join('; ')}` : `The stored content of "${type.key}" is not valid: ${issues.join('; ')}`, issues);
}

function parseLayout(content: unknown, when: 'save' | 'read'): PageLayoutContent {
  const result = pageLayoutContentSchema.safeParse(content);
  if (result.success) return result.data;
  const issues = issuesOf(result.error);
  throw new ContentValidationError(`${when === 'save' ? 'That layout is not valid' : 'The stored layout is not valid'}: ${issues.join('; ')}`, issues);
}

function assertLanguage(language: string): asserts language is CmsLanguage {
  if (!cmsLanguageSchema.safeParse(language).success) throw new Error(`"${language}" is not a language this site has.`);
}

const isMarker = (value: unknown): value is { $ref: string } =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as Record<string, unknown>)['$ref'] === 'string';

/**
 * The provider every CMS site uses over its own store and registry. It checks content against each type's schema on
 * save and on read, collects references, resolves a page (layout, items, then references to a depth of
 * `MAX_REFERENCE_DEPTH`) with the language fallback done by the store, reports what could not be shown instead of
 * failing, and asks the store for drafts only when the caller says `preview`; the store decides whether that caller
 * may have them. Invalid content is never returned to a page and never handed to the store.
 */
export const createCmsProvider: CreateCmsProvider = ({ store, registry }) => {
  const entryLanguage = (type: ContentType, language: CmsLanguage): EntryLanguage => (type.translatable ? language : NEUTRAL_LANGUAGE);

  function assertDocument(type: ContentType): void {
    if (type.storage !== 'document') throw new ContentValidationError(`"${type.key}" is a collection type: its records are kept in the site's own table.`, ['type: not a document type']);
  }

  /** Fetches items level by level and expands `$ref` markers into the referenced `ResolvedItem`s. */
  function resolution(language: CmsLanguage, preview: boolean, extraTypes: ContentType[] = []) {
    const fetched = new Map<string, ResolvedItemRecord | null>();
    const validatedCache = new Map<string, Validated>();
    const typeOf = (key: string) => extraTypes.find((type) => type.key === key) ?? registry.get(key);
    let trips = 0;

    async function fetchIds(ids: string[]): Promise<void> {
      const need = [...new Set(ids)].filter((id) => !fetched.has(id));
      for (let start = 0; start < need.length; start += MAX_IDS_PER_CALL) {
        const chunk = need.slice(start, start + MAX_IDS_PER_CALL);
        trips += 1;
        const records = await store.items.resolveItems(chunk, language, preview);
        for (const id of chunk) fetched.set(id, null);
        for (const record of records) fetched.set(record.itemId, record);
      }
    }

    function validated(record: ResolvedItemRecord): Validated {
      const cached = validatedCache.get(record.itemId);
      if (cached) return cached;
      const type = typeOf(record.typeKey);
      let result: Validated;
      if (!type) result = { ok: false, reason: 'unknown-type', message: `The type "${record.typeKey}" is not registered.` };
      else {
        const parsed = type.schema.safeParse(record.content);
        result = parsed.success ? { ok: true, content: parsed.data } : { ok: false, reason: 'invalid-content', message: `The stored content is not valid: ${issuesOf(parsed.error).join('; ')}` };
      }
      validatedCache.set(record.itemId, result);
      return result;
    }

    /** Fetches the roots, then the references found in what came back, `MAX_REFERENCE_DEPTH` times at most. */
    async function load(rootIds: string[]): Promise<void> {
      await fetchIds(rootIds);
      let frontier = [...new Set(rootIds)];
      for (let level = 0; level < MAX_REFERENCE_DEPTH; level += 1) {
        const next: string[] = [];
        for (const id of frontier) {
          const record = fetched.get(id);
          const result = record ? validated(record) : undefined;
          if (result?.ok) next.push(...collectItemRefs(result.content));
        }
        const unique = [...new Set(next)];
        if (unique.length === 0) break;
        await fetchIds(unique);
        frontier = unique;
      }
    }

    function expand(id: string, path: string[], depth: number, report: (problem: Omit<ResolveProblem, 'sectionKey' | 'slotKey'>) => void): ResolvedItem | null {
      const record = fetched.get(id);
      if (!record) return null;
      const result = validated(record);
      if (!result.ok) return null;
      const here = [...path, id];
      const substitute = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(substitute);
        if (isMarker(value)) {
          const target = value.$ref;
          if (here.includes(target)) {
            report({ itemId: target, reason: 'reference-cycle', message: `The item ${target} refers back to itself through ${id}.` });
            return value;
          }
          if (depth + 1 > MAX_REFERENCE_DEPTH) {
            report({ itemId: target, reason: 'reference-too-deep', message: `The reference to ${target} is more than ${MAX_REFERENCE_DEPTH} levels deep and was not resolved.` });
            return value;
          }
          const targetRecord = fetched.get(target);
          if (!targetRecord) {
            report({ itemId: target, reason: 'item-not-published', message: `The referenced item ${target} has nothing to show${preview ? '' : ' (it is not published)'}.` });
            return value;
          }
          const targetResult = validated(targetRecord);
          if (!targetResult.ok) {
            report({ itemId: target, reason: targetResult.reason, message: targetResult.message });
            return value;
          }
          return expand(target, here, depth + 1, report) ?? value;
        }
        if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substitute(entry)]));
        return value;
      };
      return {
        id,
        typeKey: record.typeKey,
        language: record.language,
        version: record.version,
        status: record.status,
        isDraft: record.isDraft,
        content: substitute(result.content),
      };
    }

    return { fetched, load, validated, expand, trips: () => trips };
  }

  const reportInto = (problems: ResolveProblem[], sectionKey: string, slotKey: string | null) => (problem: Omit<ResolveProblem, 'sectionKey' | 'slotKey'>) => {
    const full: ResolveProblem = { sectionKey, slotKey, ...problem };
    if (!problems.some((existing) => existing.sectionKey === full.sectionKey && existing.slotKey === full.slotKey && existing.itemId === full.itemId && existing.reason === full.reason)) problems.push(full);
  };

  return {
    // ---- the public reads -----------------------------------------------------------------------------------

    async page(pageKey, language, options) {
      assertLanguage(language);
      const preview = options?.preview === true;
      const published = await store.layouts.readPublished(pageKey);
      // The store decides who may read drafts: a caller it refuses (a visitor who sends the flag) gets the published page.
      let newest: Awaited<ReturnType<typeof store.layouts.readNewest>> = null;
      if (preview) {
        try {
          newest = await store.layouts.readNewest(pageKey);
        } catch (error) {
          if (!(error instanceof ContentPermissionError)) throw error;
        }
      }
      const record = newest ?? published;
      if (!record) return null;
      const isDraft = newest !== null && (published === null || newest.version !== published.version);
      const layout = parseLayout(record.content, 'read');

      const templates = new Map((await store.templates.list()).map(({ createdAt: _c, updatedAt: _u, ...template }) => [template.key, template as SectionTemplate]));
      const problems: ResolveProblem[] = [];
      const known = layout.sections.filter((section) => templates.has(section.template));
      for (const section of layout.sections) {
        if (!templates.has(section.template)) {
          problems.push({ sectionKey: section.key, slotKey: null, itemId: null, reason: 'unknown-template', message: `The template "${section.template}" does not exist.` });
        }
      }

      const resolved = resolution(language, preview);
      await resolved.load(collectLayoutItemIds({ sections: known }));

      const sections: ResolvedSection[] = known.map((section) => {
        const template = templates.get(section.template) as SectionTemplate;
        const slots: Record<string, ResolvedItem[]> = {};
        for (const slot of template.slots) {
          const shown: ResolvedItem[] = [];
          for (const itemId of section.slots[slot.key] ?? []) {
            const report = reportInto(problems, section.key, slot.key);
            const itemRecord = resolved.fetched.get(itemId);
            if (!itemRecord) {
              report({ itemId, reason: 'item-not-published', message: `The item ${itemId} has nothing to show${preview ? '' : ' (it is not published)'}.` });
              continue;
            }
            const result = resolved.validated(itemRecord);
            if (!result.ok) {
              report({ itemId, reason: result.reason, message: result.message });
              continue;
            }
            const item = resolved.expand(itemId, [], 0, report);
            if (item) shown.push(item);
          }
          slots[slot.key] = shown;
        }
        return { key: section.key, anchor: section.anchor ?? null, template, slots };
      });

      const page: ResolvedPage = { pageKey, version: record.version, isDraft, language, sections, problems };
      return page;
    },

    async item<T>(itemId: string, type: ContentType<T>, language: CmsLanguage, options?: { preview?: boolean }) {
      assertLanguage(language);
      const resolved = resolution(language, options?.preview === true, [type as ContentType]);
      await resolved.load([itemId]);
      const record = resolved.fetched.get(itemId);
      if (!record) return null;
      if (record.typeKey !== type.key) throw new ContentValidationError(`The item ${itemId} is a "${record.typeKey}", not a "${type.key}".`, ['type: does not match']);
      check(type, record.content, 'read');
      const problems: ResolveProblem[] = [];
      const item = resolved.expand(itemId, [], 0, reportInto(problems, '', null));
      return (item as ResolvedItem<T> | null) ?? null;
    },

    async templates() {
      return (await store.templates.list()).map(({ createdAt: _c, updatedAt: _u, ...template }) => template as SectionTemplate);
    },

    // ---- items ----------------------------------------------------------------------------------------------

    listItems: (filter) => store.items.listItems(filter),

    async createItem(input) {
      const type = registry.get(input.typeKey);
      if (!type) throw new ContentValidationError(`There is no content type "${input.typeKey}".`, ['typeKey: not registered']);
      assertDocument(type);
      return store.items.createItem({ ...input, translatable: type.translatable });
    },

    updateItem: (itemId, changes) => store.items.updateItem(itemId, changes),

    async draft<T>(itemId: string, type: ContentType<T>, language: CmsLanguage) {
      assertLanguage(language);
      const newest = await store.items.readNewest(itemId, entryLanguage(type, language));
      return newest ? { ...newest, content: check(type, newest.content, 'read') } : null;
    },

    async listItemVersions(itemId, type, language) {
      assertLanguage(language);
      return store.items.listVersions(itemId, entryLanguage(type, language));
    },

    async saveItemDraft<T>(itemId: string, type: ContentType<T>, language: CmsLanguage, content: unknown, baseVersion: number | null) {
      assertLanguage(language);
      assertDocument(type);
      const checked = check(type, content, 'save');
      return store.items.saveDraft(itemId, entryLanguage(type, language), checked, collectItemRefs(checked), baseVersion);
    },

    async publishItem(itemId, type, language, version) {
      assertLanguage(language);
      return store.items.publish(itemId, entryLanguage(type, language), version);
    },

    async restoreItem(itemId, type, language, version, baseVersion) {
      assertLanguage(language);
      return store.items.restore(itemId, entryLanguage(type, language), version, baseVersion);
    },

    usages: (itemId) => store.items.listUsages(itemId),
    deleteItem: (itemId) => store.items.deleteItem(itemId),

    // ---- layouts --------------------------------------------------------------------------------------------

    layouts: () => store.layouts.listLayouts(),

    async layoutDraft(pageKey) {
      const newest = await store.layouts.readNewest(pageKey);
      return newest ? { ...newest, content: parseLayout(newest.content, 'read') } : null;
    },

    listLayoutVersions: (pageKey) => store.layouts.listVersions(pageKey),

    async saveLayoutDraft(pageKey, content, baseVersion) {
      const checked = parseLayout(content, 'save');
      return store.layouts.saveDraft(pageKey, checked, collectLayoutItemIds(checked), baseVersion);
    },

    publishLayout: (pageKey, version) => store.layouts.publish(pageKey, version),
    restoreLayout: (pageKey, version, baseVersion) => store.layouts.restore(pageKey, version, baseVersion),
    reorderSlot: (pageKey, sectionKey, slotKey, itemIds, baseVersion) => store.layouts.reorderSlot(pageKey, sectionKey, slotKey, itemIds, baseVersion),

    // ---- templates and assets -------------------------------------------------------------------------------

    async saveTemplate(template) {
      const parsed = sectionTemplateSchema.safeParse(template);
      if (!parsed.success) {
        const issues = issuesOf(parsed.error);
        throw new ContentValidationError(`That template is not valid: ${issues.join('; ')}`, issues);
      }
      assertNarrowsContainer(registry, parsed.data);
      const { createdAt: _c, updatedAt: _u, ...saved } = await store.templates.save(parsed.data);
      return saved as SectionTemplate;
    },

    assets: () => store.assets.list(),

    async registerAsset(asset) {
      const parsed = newAssetSchema.safeParse(asset);
      if (!parsed.success) {
        const issues = issuesOf(parsed.error);
        throw new ContentValidationError(`That file cannot be registered: ${issues.join('; ')}`, issues);
      }
      return store.assets.register(parsed.data);
    },
  };
};

/** A template's slots narrow its container type's slots of the same key: fewer types, limits inside. */
function assertNarrowsContainer(registry: ContentTypeRegistry, template: SectionTemplate): void {
  const container = registry.get(template.containerTypeKey);
  const problems: string[] = [];
  if (!container || container.kind !== 'container') problems.push(`"${template.containerTypeKey}" is not a registered container type`);
  else {
    for (const slot of template.slots) {
      const base = container.slots.find((candidate) => candidate.key === slot.key);
      if (!base) {
        problems.push(`the container "${container.key}" has no slot "${slot.key}"`);
        continue;
      }
      const extra = slot.allowedTypeKeys.filter((key) => !base.allowedTypeKeys.includes(key));
      if (extra.length > 0) problems.push(`slot "${slot.key}" allows ${extra.join(', ')}, which the container does not`);
      if (slot.min < base.min) problems.push(`slot "${slot.key}" has a minimum below the container's ${base.min}`);
      if (base.max !== null && (slot.max === null || slot.max > base.max)) problems.push(`slot "${slot.key}" has a maximum above the container's ${base.max}`);
    }
  }
  if (problems.length > 0) throw new ContentValidationError(`That template does not fit its container: ${problems.join('; ')}`, problems);
}
