---
'@littlebranches/giselle-sections-sdk': minor
---

CMS: a page read with `preview: true` by a visitor now returns the published layout instead of a permission error. The stores gain `layouts.read(pageKey, preview)` (Supabase: `cms_read_layout`, which every caller may run; the database still shows drafts to editors only), and the provider's `page()` reads through it. `describeFields` also leaves out a list of lists whose innermost elements it cannot build, so a `custom` type with such a field registers. A custom `CmsContentStore` must add `layouts.read` to keep working.
