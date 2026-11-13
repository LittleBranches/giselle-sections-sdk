---
'@littlebranches/giselle-sections-sdk': minor
---

CMS: pages an editor makes, addressed by a slug and served by a site's catch-all route. A new shared migration, `supabase/migrations/20261117090000_cms_pages.sql`, adds `cms_pages` (page key, unique slug, a title and a description per language) and the functions `cms_create_page`, `cms_update_page`, `cms_list_pages` and `cms_read_page_by_slug`, with the new error code `CM009` (slug or page key taken). The stores gain `pages` (`create`, `update`, `list`, `readBySlug`); the provider gains `createPage`, `updatePage`, `pages` and `pageBySlug`, and takes the site's `reservedSlugs` (its fixed routes), refused with the new `PageTakenError`. A new page starts with an empty draft layout and shows to visitors only once published. Sites copy the new migration file next to the six they have.
