import { ContentValidationError } from './errors';
import type { ContentLanguage, SectionDefinition } from './section';
import { FALLBACK_LANGUAGE } from './section';
import type { ContentStore, ContentVersionRecord } from './store';

/** A version whose content has been checked against its section's schema. */
export type ContentVersion<T> = Omit<ContentVersionRecord, 'content'> & { content: T };

/** Published content, and the language it is actually in (the fallback's, when the one asked for had none). */
export type PublishedContent<T> = ContentVersion<T> & { language: ContentLanguage };

/** The read side: what a public page needs. Works for a visitor with no sign-in. */
export interface ContentReader {
  /** The live version for a language, falling back to Slovenian. `null` if neither has been published. */
  published<T>(section: SectionDefinition<T>, language: ContentLanguage): Promise<PublishedContent<T> | null>;
}

/** The write side, for editors. Who may call it is the backend's decision: a refused call rejects. */
export interface ContentEditor {
  /** The newest version, draft or published, or `null` if there is none or the caller may not read drafts. */
  draft<T>(section: SectionDefinition<T>, language: ContentLanguage): Promise<ContentVersion<T> | null>;
  /** Every version, newest first, without its content. */
  listVersions<T>(section: SectionDefinition<T>, language: ContentLanguage): Promise<Omit<ContentVersionRecord, 'content'>[]>;
  /** Saves a draft after checking it against the schema. Returns the new version number. Rejects with `ContentValidationError` or `ContentConflictError`. */
  saveDraft<T>(section: SectionDefinition<T>, language: ContentLanguage, content: unknown, baseVersion: number | null): Promise<number>;
  /** Publishes the newest version. */
  publish<T>(section: SectionDefinition<T>, language: ContentLanguage, version: number): Promise<void>;
  /** Saves an old version's content as a new draft version. Returns the new version number. */
  restore<T>(section: SectionDefinition<T>, language: ContentLanguage, version: number, baseVersion: number | null): Promise<number>;
}

export type ContentProvider = ContentReader & ContentEditor;

function issuesOf(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string[] {
  return error.issues.map((issue) => `${issue.path.map(String).join('.') || '(content)'}: ${issue.message}`);
}

function check<T>(section: SectionDefinition<T>, content: unknown, when: 'save' | 'read'): T {
  const result = section.schema.safeParse(content);
  if (result.success) return result.data;
  const issues = issuesOf(result.error);
  const subject = when === 'save' ? 'That content is not valid' : `The stored content of "${section.key}" is not valid`;
  throw new ContentValidationError(`${subject}: ${issues.join('; ')}`, issues);
}

function assertLanguage<T>(section: SectionDefinition<T>, language: ContentLanguage): void {
  if (!section.languages.includes(language)) {
    throw new Error(`The section "${section.key}" has no ${language} version.`);
  }
}

const validated = <T>(section: SectionDefinition<T>, record: ContentVersionRecord): ContentVersion<T> => ({
  ...record,
  content: check(section, record.content, 'read'),
});

/**
 * The provider every project uses over its own store: it checks content against the section's schema on save and on
 * read, and serves Slovenian when a language has no published entry. Invalid content is never returned to a page and
 * never handed to the store.
 */
export function createContentProvider(store: ContentStore): ContentProvider {
  return {
    async published(section, language) {
      assertLanguage(section, language);
      const own = await store.readPublished(section.key, language);
      if (own) return { ...validated(section, own), language };
      if (language !== FALLBACK_LANGUAGE && section.languages.includes(FALLBACK_LANGUAGE)) {
        const fallback = await store.readPublished(section.key, FALLBACK_LANGUAGE);
        if (fallback) return { ...validated(section, fallback), language: FALLBACK_LANGUAGE };
      }
      return null;
    },

    async draft(section, language) {
      assertLanguage(section, language);
      const newest = await store.readNewest(section.key, language);
      return newest ? validated(section, newest) : null;
    },

    async listVersions(section, language) {
      assertLanguage(section, language);
      return store.listVersions(section.key, language);
    },

    async saveDraft(section, language, content, baseVersion) {
      assertLanguage(section, language);
      return store.saveDraft(section.key, language, check(section, content, 'save'), baseVersion);
    },

    async publish(section, language, version) {
      assertLanguage(section, language);
      return store.publish(section.key, language, version);
    },

    async restore(section, language, version, baseVersion) {
      assertLanguage(section, language);
      return store.restore(section.key, language, version, baseVersion);
    },
  };
}
