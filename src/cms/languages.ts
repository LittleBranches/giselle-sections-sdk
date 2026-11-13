import { z } from 'zod';

/**
 * The languages content can be written in: defined once here, for every site. Adding a language is a change to this
 * list and nowhere else (the database stores the code as text and does not repeat the list).
 */
export const CMS_LANGUAGES = ['sl', 'en', 'de'] as const;
export type CmsLanguage = (typeof CMS_LANGUAGES)[number];

/** The language served when the one asked for has no published entry, for every site and every type. */
export const UNIVERSAL_FALLBACK_LANGUAGE: CmsLanguage = 'en';

/**
 * The language code under which an item of a type that is not translatable keeps its one entry. It is not a language a
 * visitor can ask for: it is what the read functions look at last, after the visitor's language and the fallback.
 */
export const NEUTRAL_LANGUAGE = 'all' as const;
export type NeutralLanguage = typeof NEUTRAL_LANGUAGE;

/** A language an entry can be stored under: one of the languages, or the neutral code. */
export type EntryLanguage = CmsLanguage | NeutralLanguage;

export const cmsLanguageSchema = z.enum(CMS_LANGUAGES);
export const entryLanguageSchema = z.enum([...CMS_LANGUAGES, NEUTRAL_LANGUAGE]);
