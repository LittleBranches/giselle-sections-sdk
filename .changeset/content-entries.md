---
'@littlebranches/giselle-sections-sdk': minor
---

Add the content contract: `defineSection({ key, languages, schema })` declares a section once with a zod schema, and `createContentProvider(store)` reads and writes its entries over any `ContentStore`. The provider reads the published version (falling back to Slovenian), reads the newest draft, saves a draft, publishes, lists versions and restores an old one as a new version. Content is checked against the schema on save and on read, and a save based on a version that is no longer the newest rejects with `ContentConflictError`, which carries the newer version. Includes `createInMemoryContentStore()` for tests. `zod` is now a peer dependency.
