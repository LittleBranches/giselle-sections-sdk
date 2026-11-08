import type { ZodType } from 'zod';

/** The languages content can be written in. Slovenian is the one every other language falls back to. */
export type ContentLanguage = 'sl' | 'en' | 'de';

export const CONTENT_LANGUAGES: readonly ContentLanguage[] = ['sl', 'en', 'de'];

/** The language served when the one asked for has no published entry. */
export const FALLBACK_LANGUAGE: ContentLanguage = 'sl';

/**
 * A section of content, declared once: its key, the languages it exists in and the schema its content must match. The
 * one schema gives the TypeScript type, the check on save and on read, and (later) the editor's fields.
 */
export type SectionDefinition<T> = {
  readonly key: string;
  readonly languages: readonly ContentLanguage[];
  readonly schema: ZodType<T>;
};

/** Declares a section. The key is lowercase letters, digits and hyphens: it is what the backend stores the entries under. */
export function defineSection<T>(section: SectionDefinition<T>): SectionDefinition<T> {
  if (!/^[a-z][a-z0-9-]*$/.test(section.key)) {
    throw new Error(`A section key must be lowercase letters, digits and hyphens, starting with a letter: "${section.key}".`);
  }
  if (section.languages.length === 0) throw new Error(`The section "${section.key}" needs at least one language.`);
  return section;
}
