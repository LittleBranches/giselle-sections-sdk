import { ContentConflictError } from './errors';
import type { ContentLanguage } from './section';

/** One saved version of an entry, as the backend holds it. `content` is whatever was saved: not yet checked against a schema. */
export type ContentVersionRecord = {
  /** 1, 2, 3 ... for this entry; never reused. */
  version: number;
  /** `draft` until the version has been published once. The entry's published pointer says which version is live. */
  status: 'draft' | 'published';
  content: unknown;
  changedBy: string | null;
  changedByEmail: string | null;
  changedAt: string;
  /** The version whose content this one was restored from, if it was made by a restore. */
  restoredFrom: number | null;
};

/**
 * Where entries are kept. The SDK defines the shape it needs and knows nothing about the backend: a database, a headless
 * CMS or a plain list each implement this, and the provider on top (`createContentProvider`) adds the schema checks and
 * the language fallback, so the same rules hold whatever the backend is.
 *
 * An entry is one section in one language. Who may read a draft or write is the backend's decision (a database's own
 * rules, for instance): a refused write rejects rather than silently doing nothing, and a visitor's `readNewest` finds
 * no draft.
 */
export interface ContentStore {
  /** The version the entry's published pointer names, or `null` if the entry has never been published. */
  readPublished(key: string, language: ContentLanguage): Promise<ContentVersionRecord | null>;

  /** The newest version, draft or not, or `null` if there is none or the caller may not read drafts. */
  readNewest(key: string, language: ContentLanguage): Promise<ContentVersionRecord | null>;

  /** Every version, newest first, without its content. Empty for a caller who may not read history. */
  listVersions(key: string, language: ContentLanguage): Promise<Omit<ContentVersionRecord, 'content'>[]>;

  /**
   * Saves a new draft version and returns its number. `baseVersion` is the version the content was edited from (`null`
   * for the first save of an entry). Rejects with `ContentConflictError`, writing nothing, if it is not the newest.
   */
  saveDraft(key: string, language: ContentLanguage, content: unknown, baseVersion: number | null): Promise<number>;

  /**
   * Makes `version` the live one. It must be the newest version; otherwise rejects with `ContentConflictError`.
   */
  publish(key: string, language: ContentLanguage, version: number): Promise<void>;

  /**
   * Saves the content of an old `version` as a new draft version and returns its number; the old version is untouched.
   * `baseVersion` is checked like a save's.
   */
  restore(key: string, language: ContentLanguage, version: number, baseVersion: number | null): Promise<number>;
}

/**
 * A store that keeps entries in memory, for tests and for content that has no backend yet. It follows the same rules as
 * a real backend (version numbers, stale saves, publish pointer) but has no notion of who is asking.
 */
export function createInMemoryContentStore(): ContentStore {
  type Entry = { versions: ContentVersionRecord[]; published: number | null };
  const entries = new Map<string, Entry>();
  const entryOf = (key: string, language: ContentLanguage) => {
    const id = `${key}/${language}`;
    let entry = entries.get(id);
    if (!entry) entries.set(id, (entry = { versions: [], published: null }));
    return entry;
  };
  const newest = (entry: Entry) => entry.versions[entry.versions.length - 1];
  const copy = (record: ContentVersionRecord): ContentVersionRecord => structuredClone(record);

  function append(entry: Entry, content: unknown, baseVersion: number | null, restoredFrom: number | null): number {
    const latest = newest(entry);
    if (latest && latest.version !== baseVersion) throw new ContentConflictError(copy(latest));
    if (!latest && baseVersion !== null) throw new ContentConflictError({ version: 0, status: 'draft', content: null, changedBy: null, changedByEmail: null, changedAt: new Date().toISOString(), restoredFrom: null });
    const version = (latest?.version ?? 0) + 1;
    entry.versions.push({ version, status: 'draft', content: structuredClone(content), changedBy: null, changedByEmail: null, changedAt: new Date().toISOString(), restoredFrom });
    return version;
  }

  return {
    async readPublished(key, language) {
      const entry = entryOf(key, language);
      const live = entry.versions.find((v) => v.version === entry.published);
      return live ? copy(live) : null;
    },
    async readNewest(key, language) {
      const latest = newest(entryOf(key, language));
      return latest ? copy(latest) : null;
    },
    async listVersions(key, language) {
      return [...entryOf(key, language).versions].reverse().map(({ content: _content, ...info }) => info);
    },
    async saveDraft(key, language, content, baseVersion) {
      return append(entryOf(key, language), content, baseVersion, null);
    },
    async publish(key, language, version) {
      const entry = entryOf(key, language);
      const latest = newest(entry);
      if (!latest) throw new Error('There is nothing to publish.');
      if (latest.version !== version) throw new ContentConflictError(copy(latest));
      latest.status = 'published';
      entry.published = version;
    },
    async restore(key, language, version, baseVersion) {
      const entry = entryOf(key, language);
      const old = entry.versions.find((v) => v.version === version);
      if (!old) throw new Error(`There is no version ${version} to restore.`);
      return append(entry, old.content, baseVersion, version);
    },
  };
}
