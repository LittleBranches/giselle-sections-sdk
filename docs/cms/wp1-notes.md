---
sidebar_label: 'CMS WP1 notes'
---

# CMS SDK implementation: notes

Where `contracts.md` was ambiguous or the shared migration chose differently, the migration's behaviour was followed for the database rules and the most conservative reading elsewhere.

1. **One source for the non-reusable rule.** A holding item (all its languages together) or a layout is one source, as the migration does.
2. **Reference collection and trust.** `collectItemRefs` collects every object with a string `$ref`, so a bad marker reaches the database and is refused there. Like the database, the in-memory store trusts the `refs` it is given for the index.
3. **Resolved references.** After a page or an item is read, each `{ "$ref" }` marker is replaced by the referenced `ResolvedItem` (id, type, language, version, `isDraft`, content), to depth `MAX_REFERENCE_DEPTH`. The content is checked against its schema before substitution, so the substituted shape differs from the schema's marker type. Markers that could not be resolved stay as they were and are reported.
4. **`ResolveProblem.reason`** gained two values, `reference-too-deep` and `reference-cycle` (additive change in `src/cms/provider.ts`).
5. **Templates are checked against the registry on save** by the provider: the container must be a registered container type, and each template slot must narrow the container's slot of the same key (fewer types, limits inside).
6. **`describeFields(type, { blockTypeKeys })`.** An `item-ref` field with no override lists the keys passed in; without them the list is empty and the editor reads that as every block type. A schema field the generator cannot build is left out (custom types).
7. **Unknown base for a collection update.** `baseUpdatedAt = null` is refused as stale (it cannot be shown to be current). The adapter helper expects the site's row store to compare and set in one statement.
8. **`cms_assets.bytes` is not a column visitors may select (5.1)**, yet `Asset.bytes` is required. The Supabase store reads exactly the 5.1 columns and reports `bytes: 0` for a file read from the table; the row returned by `cms_register_asset` carries the real size. Granting `bytes` in the migration would remove the gap.
9. **In-memory defaults.** The caller starts as a `visitor`; a test sets the role. Registering an asset needs the file to be put in the pretend bucket first (`uploadObject`).
10. **Restore is not schema-checked by the provider** (the stores copy an old version's content; the provider has no call to read an old version's content). The stored content is checked on every read.
11. **The provider does not check that an item is of the type it saves under** (that would cost a round trip per save); a read refuses an item of another type.
12. **Not verified:** the Supabase store was tested only against a fake client; it was not run against the real client's types or a database. The legacy `content_*` argument names (`p_section`, `p_language`, `p_base_version`, `p_content`, `p_version`) were taken from the migration's legacy file.
