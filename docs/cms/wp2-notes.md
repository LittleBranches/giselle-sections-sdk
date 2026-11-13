# WP2 notes: where the migration made a choice

The contract (`contracts.md`, sections 3 to 5) is implemented as written. These are the places where it was ambiguous and
the most conservative reading was taken. Each is covered by a test in `supabase/tests/`.

1. **What "one source" means for a non-reusable item (CM005).** A source is a layout, or an item (all language entries of
   one item count as one source). Reading it per entry would make a non-reusable block unusable from both language entries
   of the same parent. `cms_references.source_id` is still the entry or layout id, as in 3.7.
2. **`cms_list_usages` and the CM002 detail.** `source_id` is the id of the holding item (or the layout), as the SDK's
   `ItemUsage` documents, not the entry id; there is one row per source entry (so one per language). The CM002 `detail`
   is a JSON array of `ItemUsage` objects with camelCase keys (`sourceKind`, `sourceId`, `sourceLabel`, `sourceLanguage`,
   `inPublished`, `inNewest`). `usage_count` in `cms_list_items` counts distinct holding items and layouts.
3. **CM005 detail** is the JSON array of target item ids (on a save) or of the holding source ids (on `cms_update_item`).
   **CM008 detail** is the path: the source item id, then the ids walked until the source is reached again (a self
   reference is `[a, a]`). **CM003 detail** is the JSON array of missing ids.
4. **Order of checks on a save:** content shape and role (42501, 22023), the item (CM001), the language rule (22023),
   stale (CE001), references (CM003, CM008, CM005), then for a layout the slot rules (CM004). A layout item id that is not in
   `p_refs` and does not exist is a CM004 problem line; one that is in `p_refs` is CM003.
5. **At publish of a layout** every slot rule is checked again (a template can change after a save): a broken maximum,
   type or unknown slot is CM004; CM007 is raised only when the only problems are minimums.
6. **Slot `max` null** (no limit) is capped at 100 on check; `cms_save_template` refuses a `min` or `max` above 100 and a
   slot with fields other than `key`, `label`, `allowedTypeKeys`, `min`, `max` (22023).
7. **Templates:** the owner may replace a built-in template's slots (only `built_in` is protected); a later run of the
   seed file puts the built-in rows back. The change log row for a template save has no `subject_id` (a template key is not
   a uuid); the key is in `detail`.
8. **Errors for missing things:** an unknown item or layout is CM001; publishing an entry or restoring a version that does
   not exist is 22023 (as the legacy functions do); an invalid asset argument is CM006 (the contract lists CM006 for "path
   or type not allowed").
9. **Concurrency:** reference checks, and `cms_delete_item`, take one advisory transaction lock, so two saves that would
   together form a cycle cannot both pass.
10. **Truncate** is refused by trigger on the append-only tables (versions, references, assets, change log).
11. **Tests need `@electric-sql/pglite`** (added as a devDependency, as in the existing site's database tests).
