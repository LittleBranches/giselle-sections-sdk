import { z } from 'zod';

import { idSchema, keySchema, timestampSchema } from './keys';
import { CMS_LANGUAGES, UNIVERSAL_FALLBACK_LANGUAGE, type CmsLanguage } from './languages';
import type { PageLayoutReadRecord } from './page-layout';

/**
 * A page an editor makes from the dashboard: a page layout (same versions, draft and publish as any layout) with a public
 * address and its own words. A site serves these through one catch-all route; its fixed routes keep reading their
 * layouts by page key. Visitors see a page only once its layout is published.
 */

export const MAX_SLUG_LENGTH = 100;
export const MAX_PAGE_TITLE_LENGTH = 120;
export const MAX_PAGE_DESCRIPTION_LENGTH = 300;

/** A page's address: lowercase letters and digits in words joined by single hyphens (`about-us`, `2026-summer`). */
export const slugSchema = z
  .string()
  .min(1)
  .max(MAX_SLUG_LENGTH)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters and digits, words joined by single hyphens.');

const pageText = (max: number) => z.string().trim().min(1).max(max);

/** A title per language. English is required: it is what a language with no title of its own falls back to. */
export const pageTitlesSchema = z
  .partialRecord(z.enum(CMS_LANGUAGES), pageText(MAX_PAGE_TITLE_LENGTH))
  .refine((titles) => typeof titles[UNIVERSAL_FALLBACK_LANGUAGE] === 'string', { message: 'An English title is required.', path: [UNIVERSAL_FALLBACK_LANGUAGE] });
export type PageTitles = z.infer<typeof pageTitlesSchema>;

/** A description per language (for search results and link previews), all optional. */
export const pageDescriptionsSchema = z.partialRecord(z.enum(CMS_LANGUAGES), pageText(MAX_PAGE_DESCRIPTION_LENGTH));
export type PageDescriptions = z.infer<typeof pageDescriptionsSchema>;

/** What an editor gives to make a page. `pageKey` names its layout and never changes; `slug` is its address. */
export const newCmsPageSchema = z
  .object({
    pageKey: keySchema,
    slug: slugSchema,
    titles: pageTitlesSchema,
    descriptions: pageDescriptionsSchema.optional(),
  })
  .strict();
export type NewCmsPage = z.infer<typeof newCmsPageSchema>;

/** What an editor may change on a page; a field left out stays as it is. */
export const cmsPageChangesSchema = z
  .object({
    slug: slugSchema.optional(),
    titles: pageTitlesSchema.optional(),
    descriptions: pageDescriptionsSchema.optional(),
  })
  .strict();
export type CmsPageChanges = z.infer<typeof cmsPageChangesSchema>;

export const cmsPageSchema = z
  .object({
    id: idSchema,
    pageKey: keySchema,
    slug: slugSchema,
    titles: pageTitlesSchema,
    descriptions: pageDescriptionsSchema,
    /** The layout's published version; `null` until the page is first published (visitors then see nothing). */
    publishedVersion: z.number().int().min(1).nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type CmsPage = z.infer<typeof cmsPageSchema>;

/** A page found by its address, with the layout version to show (published, or the newest in an editor's preview). */
export type PageBySlugRecord = { page: CmsPage; layout: PageLayoutReadRecord };

/** A page's title and description in a language, each falling back to English on its own. */
export type PageMeta = {
  title: string;
  /** The language the title is in: the one asked for, or `'en'`. */
  titleLanguage: CmsLanguage;
  description: string | null;
};

export function pageMeta(page: Pick<CmsPage, 'titles' | 'descriptions'>, language: CmsLanguage): PageMeta {
  const own = page.titles[language];
  const title = own ?? page.titles[UNIVERSAL_FALLBACK_LANGUAGE] ?? '';
  return {
    title,
    titleLanguage: own !== undefined ? language : UNIVERSAL_FALLBACK_LANGUAGE,
    description: page.descriptions[language] ?? page.descriptions[UNIVERSAL_FALLBACK_LANGUAGE] ?? null,
  };
}
