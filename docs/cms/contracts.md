---
sidebar_label: 'CMS contracts'
---

# CMS content model: contracts

This is the contract every work package of the "CMS content model" epic is built against, in parallel. The TypeScript half is in `src/cms/` (types and zod schemas only, exported from the package entry). This page is the other half: the database, the editor, the preview mode, and what each package must build. Where the two disagree, `src/cms/` wins for TypeScript and this page wins for the database; report the disagreement, do not paper over it.

Words used throughout: a **type** is a schema bound to a library component (in code); an **item** is one instance of a type; a **template** is a named layout with slots; a **page layout** is an ordered list of sections, each a template filled with items. A **site** is an app with its own database; the two sites are the campaign site and the portfolio.

Contents: 1 model at a glance, 2 TypeScript surface, 3 database, 4 functions, 5 roles and row-level security, 6 reading rules (fallback, references, preview), 7 collection types and the adapter, 8 where the migration lives, 9 the generated editor, 10 preview mode, 11 what each package builds, 12 decisions.

## 1. The model at a glance

```
type (code)  -->  item (database)  -->  slot of a section  -->  page layout (database)
 schema +          versioned JSON        template (database)     versioned JSON:
 component key     per language entry    says which types        ordered sections,
                                         and how many            each = template + slot -> item ids
```

- Types, their zod schemas, the registry and the language list are code (the SDK). Items, templates, page layouts and assets are data.
- Two storage kinds. **Document** types: versioned JSON entries in the shared tables. **Collection** types: rows in a table the site already has, reached through an adapter.
- An item is versioned on its own, per language entry. A page layout is a second versioned document. Both follow the rules of the existing entries: versions are immutable, a save carries its base version, a stale base is refused with the newest version, only the newest version can be published, a restore makes a new version.
- A reference to a shared item is the marker `{ "$ref": "<item id>" }`. It resolves to the item's published version. Deleting an item that is referenced is refused and lists where it is used.

## 2. TypeScript surface (`src/cms/`)

| File | What it holds |
|---|---|
| `languages.ts` | `CMS_LANGUAGES` (`sl`, `en`, `de`), `UNIVERSAL_FALLBACK_LANGUAGE` (`en`), `NEUTRAL_LANGUAGE` (`all`), `EntryLanguage`, schemas |
| `keys.ts` | `keySchema` (slug), `idSchema` (uuid) |
| `content-type.ts` | `contentTypeDefinitionSchema`, `ContentType`, `ContentTypeInput`, `SlotDefinition`, editor override schemas, `EDITOR_WIDGETS` |
| `registry.ts` | `ContentTypeRegistry` (register, get, require, list), `ComponentResolver` |
| `item.ts` | `ContentItem`, `ItemRef` (`itemRefSchema`), `ItemVersionRecord`, `ResolvedItem`, `ItemUsage`, `MAX_REFERENCE_DEPTH`, `CollectionAdapter`, `CollectionRecord` |
| `template.ts` | `SectionTemplate`, `BUILTIN_TYPE_KEYS`, `BUILTIN_SECTION_TEMPLATES` |
| `page-layout.ts` | `PageLayout`, `PageLayoutContent`, `layoutSectionSchema`, `PageLayoutVersionRecord`, `PageLayoutReadRecord`, limits |
| `page.ts` | `CmsPage`, `NewCmsPage`, `CmsPageChanges`, `slugSchema`, `pageTitlesSchema`, `pageDescriptionsSchema`, `PageBySlugRecord`, `PageMeta`, `pageMeta()` (3.11) |
| `asset.ts` | `Asset`, `NewAsset`, `assetRefSchema`, MIME and size limits |
| `errors.ts` | `CMS_ERROR_CODES`, `ContentNotFoundError`, `ContentPermissionError`, `ContentReferencedError`, `ContentReferenceError`, `LayoutRuleError`, `CollectionConflictError`, `PageTakenError` |
| `store.ts` | `ItemStore`, `LayoutStore`, `TemplateStore`, `AssetStore`, `PageStore`, `CmsContentStore extends ContentStore` |
| `provider.ts` | `CmsReader`, `CmsEditor`, `CmsProvider`, `ResolvedPage`, `ResolvedSlugPage`, `ResolveProblem`, `CreateCmsProvider` |
| `editor.ts` | `FieldConfig` (what the generated editor builds a field from) |

The existing content module (`defineSection`, `ContentStore`, `createContentProvider`) is unchanged by WP0 and keeps working. The errors `ContentConflictError` (a stale save, carrying the newer version) and `ContentValidationError` are reused for items and layouts, not duplicated.

## 3. Database

Every table lives in `public`, is prefixed `cms_`, and has row-level security enabled. Nothing is written through the API: there are no insert, update or delete grants and no write policies on any table. All writes go through the functions in section 4. Ids are `uuid default gen_random_uuid()`. Timestamps are `timestamptz default now()`. `changed_by` style columns are `uuid references auth.users (id) on delete set null` next to an `..._email text` copy, as in the existing entries.

### 3.1 How the existing entries tables relate

The existing tables (`content_entries`, `content_versions`, `content_publish_log`) and functions (`content_read_published`, `content_read_newest`, `content_list_versions`, `content_save_draft`, `content_publish`, `content_restore`) hold the campaign site's section entries, keyed by (section, language). **They are not reused for items and layouts and are not altered.** Reasons: an item needs an id, a type, a title, a reusable flag and a neutral language, none of which the table has, and widening a live table the campaign site already uses is a risk the epic does not need; the shared tables must also exist on the portfolio, which has no such table. The legacy tables stay as they are and keep serving the base `ContentStore` methods of the Supabase store. The shared migration ships them as an idempotent file (3.8) so both databases end up identical. Moving old section entries into items is out of scope.

### 3.2 `cms_items`

| Column | Type | Rules |
|---|---|---|
| `id` | uuid | primary key |
| `type_key` | text not null | check `type_key ~ '^[a-z][a-z0-9-]*$' and char_length(type_key) <= 64` |
| `title` | text not null | check `char_length(title) between 1 and 120`; for editors, never shown to visitors |
| `reusable` | boolean not null default false | |
| `translatable` | boolean not null | fixed at creation, never updated (trigger) |
| `created_at` | timestamptz not null | |
| `created_by`, `created_by_email` | uuid, text | |

Index: `(type_key)`. The type is not stored in the database as a row: the registry is code, so the database cannot check that `type_key` is registered (the provider does, before it calls).

### 3.3 `cms_item_entries` and `cms_item_versions`

`cms_item_entries`: one entry per item and language.

| Column | Type | Rules |
|---|---|---|
| `id` | uuid | primary key |
| `item_id` | uuid not null | references `cms_items (id)` on delete cascade |
| `language` | text not null | check `language ~ '^[a-z]{2}$' or language = 'all'` (the allowed set is the SDK's list, not repeated here) |
| `published_version` | integer | null until the first publish; foreign key `(id, published_version)` to the versions, deferrable initially deferred |
| `created_at` | timestamptz not null | |

Unique `(item_id, language)`. The functions enforce: an item with `translatable = true` has entries with a real language only, one with `translatable = false` has exactly one entry, language `all` (error 22023 otherwise).

`cms_item_versions`: one row per saved version.

| Column | Type | Rules |
|---|---|---|
| `entry_id` | uuid not null | references `cms_item_entries (id)` on delete cascade |
| `version` | integer not null | check `version >= 1`; primary key `(entry_id, version)` |
| `status` | text not null default 'draft' | check in `('draft','published')` |
| `content` | jsonb not null | check `jsonb_typeof(content) = 'object'` |
| `changed_by`, `changed_by_email`, `changed_at` | | as in the existing entries |
| `restored_from` | integer | foreign key `(entry_id, restored_from)` to the same table |

### 3.4 `cms_layouts` and `cms_layout_versions`

`cms_layouts`: `id uuid pk`, `page_key text not null unique` (check slug, as `type_key`), `published_version integer` (deferrable foreign key `(id, published_version)` to the versions, as above), `created_at`. A layout is not translated: one row per page.

`cms_layout_versions`: same columns and rules as `cms_item_versions` with `layout_id uuid not null references cms_layouts (id) on delete cascade` in place of `entry_id`; primary key `(layout_id, version)`. `content` must also satisfy `jsonb_typeof(content -> 'sections') = 'array'`.

The shape of `content` is `PageLayoutContent` in `page-layout.ts`:

```json
{ "sections": [ { "key": "hero", "template": "banner-section", "anchor": "top",
                  "slots": { "banner": ["<item id>"] } } ] }
```

### 3.5 `cms_templates`

| Column | Type | Rules |
|---|---|---|
| `key` | text | primary key, slug check |
| `name` | text not null | 1 to 80 characters |
| `container_type_key` | text not null | slug check |
| `slots` | jsonb not null | check `jsonb_typeof(slots) = 'array' and jsonb_array_length(slots) >= 1`; each element is a `SlotDefinition` (`key`, `label`, `allowedTypeKeys`, `min`, `max`) |
| `built_in` | boolean not null default false | |
| `created_at`, `updated_at` | timestamptz | |

Templates are not versioned in this slice. A built-in template (`built_in = true`) cannot be deleted or have its `built_in` flag cleared. No template can be deleted in this slice (decision D8).

### 3.6 `cms_assets`

| Column | Type | Rules |
|---|---|---|
| `id` | uuid | primary key |
| `bucket` | text not null default 'site-images' | |
| `path` | text not null | check length 1 to 500, no leading `/`, no `..` segment; unique `(bucket, path)` |
| `mime` | text not null | check in `('image/jpeg','image/png','image/webp')` |
| `bytes` | integer not null | check `between 1 and 5242880` |
| `width`, `height` | integer | check `> 0` when set |
| `label` | text | check length <= 200 |
| `created_at`, `created_by`, `created_by_email` | | |

Append-only (3.9): a row is never updated or deleted, because content versions keep pointing at it.

### 3.7 `cms_references` (the reference index) and `cms_change_log`

`cms_references`: which version of which source points at which item.

| Column | Type | Rules |
|---|---|---|
| `source_kind` | text not null | check in `('item','layout')` |
| `source_id` | uuid not null | the `cms_item_entries.id` or the `cms_layouts.id` (no foreign key: it points at one of two tables) |
| `source_version` | integer not null | |
| `target_item_id` | uuid not null | **no** foreign key: old versions may point at an item that has since been deleted |

Primary key `(source_kind, source_id, source_version, target_item_id)`; index `(target_item_id)`. Rows are written by the save functions from their `p_refs` argument, once per saved version, never changed.

A reference "counts" (it blocks a delete and shows in the usage list) when its source version is the source's **newest** version or its **published** version. An old version that nobody can reach without a restore does not count.

`cms_change_log`: `id bigint identity pk`, `at timestamptz`, `user_id`, `user_email`, `action text` (check in `'publish_item','publish_layout','delete_item','save_template','register_asset'`), `subject_id uuid`, `language text`, `version integer`, `detail jsonb`. Append-only. It replaces the per-table publish logs for the new tables.

### 3.8 Roles and the legacy entries, as shared files

The shared migration also carries, as idempotent files: the roles (`site_members`, `is_plan_member()`, `can_edit()`, `is_owner()`, exactly the existing definitions, created `if not exists` / `create or replace`), the legacy entries tables and functions (same text, `if not exists`, policies dropped then created), and the images bucket policies. In the campaign database these files change nothing; in the portfolio they create what is missing. The portfolio's one-off move of its existing single owner row into `site_members` with role `owner` is **not** shared: it is a site-local migration (WP4).

### 3.9 Append-only records

Grants alone are not enough, because the security-definer functions run as the table owner. Each of these is therefore also protected by a trigger:

| Table | Update allowed | Delete allowed |
|---|---|---|
| `cms_item_versions`, `cms_layout_versions` | only `status` `'draft'` to `'published'` (every other column unchanged) | only while the transaction setting `cms.deleting` is `'on'`, which only `cms_delete_item` sets (local to its transaction) |
| `cms_references` | never | only under `cms.deleting`, for the rows of the item being deleted |
| `cms_change_log` | never | never |
| `cms_assets` | never | never |
| `cms_items` | only `title` and `reusable`; `translatable`, `type_key`, `id` never | only under `cms.deleting` |

### 3.10 Indexes, summarised

`cms_items (type_key)`; `cms_item_entries (item_id, language)` unique; `cms_layouts (page_key)` unique; `cms_references (target_item_id)`; `cms_references (source_kind, source_id)`; `cms_assets (bucket, path)` unique; `cms_change_log (subject_id, at desc)`.

### 3.11 `cms_pages` (pages an editor makes; file `20261117090000_cms_pages.sql`)

A page an editor makes from the dashboard, served by a site's catch-all route. Its layout is an ordinary `cms_layouts` row (same versions, draft, publish, restore, slot rules); this table adds the address and the words around it. A site's fixed routes keep reading their layouts by page key and have no row here.

| Column | Type | Rules |
|---|---|---|
| `id` | uuid | primary key |
| `layout_id` | uuid not null unique | references `cms_layouts (id)` on delete cascade |
| `page_key` | text not null unique | the layout's key, copied; slug check as `type_key`; never changes |
| `slug` | text not null unique | the address: check `slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 100` (lowercase kebab, one path segment) |
| `titles` | jsonb not null | map of language code (`^[a-z]{2}$`) to text of 1 to 120 characters, `en` required (the fallback) |
| `descriptions` | jsonb not null default `{}` | same map, 1 to 300 characters, all optional |
| `created_at`, `created_by`, `created_by_email` | | as elsewhere |
| `updated_at`, `updated_by`, `updated_by_email` | | the last change |

The two maps are checked by `cms_valid_page_texts(jsonb, integer, boolean)` (immutable, used by the table checks and the functions). Trigger: only `slug`, `titles`, `descriptions` and the update stamp may change; no delete (decision D22). `cms_change_log.action` also allows `create_page` and `update_page`.

## 4. Functions

All are `language plpgsql` (or `sql` where trivial), `security definer`, `set search_path = ''`, with every object schema-qualified, as in the existing entries. Each is revoked from `public, anon, authenticated` by name and then granted back only where listed. Each privileged function begins with its role check and raises `42501` (`Only editors and owners can change content` or `Only owners can ...`).

Error codes (shared with `CMS_ERROR_CODES`, which maps each to an error class): `CE001` stale (the existing code; detail is the newest version as JSON, same keys as the existing `content_raise_stale`), `42501` permission, `22023` invalid argument, `CM001` not found, `CM002` still referenced (detail: usages JSON array), `CM003` dangling reference (detail: missing ids), `CM004` slot rule broken (detail: problems), `CM005` not reusable and already used elsewhere (detail: ids), `CM006` asset invalid, `CM007` layout incomplete at publish (detail: problems), `CM008` reference cycle (detail: ids on the cycle), `CM009` a page's slug or page key is taken (detail: `{ "field": "slug" | "pageKey", "value": "..." }`, from `20261117090000_cms_pages.sql`).

### 4.1 Reads for everyone (`anon` and `authenticated`)

| Function | Returns | Rule |
|---|---|---|
| `cms_read_published(p_item_id uuid, p_language text)` | `table (version integer, status text, content jsonb, changed_at timestamptz, restored_from integer)` | the exact entry's published version, no fallback; `security invoker`, the policies decide |
| `cms_resolve_items(p_item_ids uuid[], p_language text, p_preview boolean default false)` | `table (item_id uuid, type_key text, reusable boolean, translatable boolean, language text, version integer, status text, is_draft boolean, content jsonb)` | many items at once, with the fallback (6.1) applied; `security definer`; with `p_preview` true **and** `can_edit()` true it returns the newest version, otherwise only published versions; an item with nothing to show gives no row; at most 500 ids |
| `cms_read_layout(p_page_key text, p_preview boolean default false)` | `table (version integer, status text, content jsonb, changed_at timestamptz, is_draft boolean)` | the published version; with `p_preview` and `can_edit()` the newest; `security definer` |
| `cms_list_templates()` | `setof cms_templates` | all templates (they are not secret: a visitor's page needs them) |

`cms_resolve_items` is the one call that resolves references; there is no separate "resolve one reference" call: a single reference is a one-element array. (The brief's "resolve reference" is this function.)

### 4.2 Reads for editors (`authenticated`, `can_edit()` inside; others get an empty result)

| Function | Returns |
|---|---|
| `cms_read_newest(p_item_id uuid, p_language text)` | `table (version, status, content, changed_by, changed_by_email, changed_at, restored_from)` for the exact entry, newest first row only |
| `cms_list_versions(p_item_id uuid, p_language text)` | the same columns without `content`, newest first |
| `cms_list_items(p_type_key text default null)` | `table (id uuid, type_key text, title text, reusable boolean, translatable boolean, created_at timestamptz, published_languages text[], usage_count integer)` |
| `cms_list_usages(p_item_id uuid)` | `table (source_kind text, source_id uuid, source_label text, source_language text, in_published boolean, in_newest boolean)`; label is the source item's title or the layout's `page_key`; only references that count (3.7) |
| `cms_read_layout_newest(p_page_key text)` | `table (version, status, content, changed_by, changed_by_email, changed_at, restored_from)` |
| `cms_list_layout_versions(p_page_key text)` | the same without `content`, newest first |
| `cms_list_layouts()` | `table (id uuid, page_key text, published_version integer, created_at timestamptz)` |

### 4.3 Writes by editors and owners (`authenticated`, `can_edit()` inside)

| Function | Returns | What it does |
|---|---|---|
| `cms_create_item(p_type_key text, p_title text, p_reusable boolean, p_translatable boolean)` | the new item row | inserts an item; 22023 on a bad key or title |
| `cms_update_item(p_item_id uuid, p_title text default null, p_reusable boolean default null)` | the item row | null leaves a field unchanged; setting `reusable` to false while the item is used by more than one source raises `CM005` |
| `cms_save_item_draft(p_item_id uuid, p_language text, p_base_version integer, p_content jsonb, p_refs uuid[])` | integer, the new version | the item and language rules of 3.3; creates the entry on first save; locks the entry `for update`; refuses with `CE001` if `p_base_version` (null for the first save) is not the newest; checks the references (4.6); inserts the version and its `cms_references` rows |
| `cms_publish_item(p_item_id uuid, p_language text, p_version integer)` | void | `CE001` unless `p_version` is the newest; publishing what is already live changes nothing and is not logged; else marks the version published, moves `published_version`, writes `cms_change_log` |
| `cms_restore_item(p_item_id uuid, p_language text, p_version integer, p_base_version integer)` | integer | copies the old version's content and its references into a new version (`restored_from` set); the references are checked again (a missing target raises `CM003`) |
| `cms_save_layout_draft(p_page_key text, p_base_version integer, p_content jsonb, p_refs uuid[])` | integer | like the item save; also checks the slot rules (4.7) without the minimums |
| `cms_publish_layout(p_page_key text, p_version integer)` | void | like the item publish, and checks the slot rules **with** the minimums (`CM007`) |
| `cms_restore_layout(p_page_key text, p_version integer, p_base_version integer)` | integer | like the item restore |
| `cms_reorder_slot(p_page_key text, p_base_version integer, p_section_key text, p_slot_key text, p_item_ids uuid[])` | integer | reads the newest layout (`CE001` if its version is not `p_base_version`), requires `p_item_ids` to be exactly the set of ids the slot holds now (22023 otherwise), saves a new draft version with the slot in that order |
| `cms_register_asset(p_path text, p_mime text, p_bytes integer, p_width integer, p_height integer, p_label text)` | the asset row | the object must exist in the `site-images` bucket (`exists` on `storage.objects`), else `CM006`; registering the same path again returns the existing row |

### 4.4 Writes by owners only (`is_owner()` inside)

| Function | Returns | What it does |
|---|---|---|
| `cms_delete_item(p_item_id uuid)` | void | collects the references that count (3.7) to the item; if any, raises `CM002` with them as detail and deletes nothing; otherwise sets `cms.deleting` locally, deletes the item (entries, versions and its own outgoing references cascade or are removed), writes `cms_change_log` |
| `cms_save_template(p_key text, p_name text, p_container_type_key text, p_slots jsonb)` | the template row | upsert; validates `p_slots` as an array of slot definitions; cannot change `built_in`; writes the change log |

### 4.4a Pages (`20261117090000_cms_pages.sql`)

| Function | Grant | Returns | What it does |
|---|---|---|---|
| `cms_read_page_by_slug(p_slug text, p_preview boolean default false)` | `anon, authenticated` | `table (id, page_key, slug, titles, descriptions, published_version, created_at, updated_at, version, status, content, changed_at, is_draft)` | the page and the layout version to show: published only; with `p_preview` and `can_edit()` the newest, also of a page never published; no row (a 404) otherwise |
| `cms_list_pages()` | `authenticated` | `table (id, page_key, slug, titles, descriptions, published_version, created_at, updated_at)` | every page by slug, for editors; empty for others |
| `cms_create_page(p_page_key text, p_slug text, p_titles jsonb, p_descriptions jsonb default '{}')` | `authenticated`, `can_edit()` inside | the page, as `cms_list_pages` | 22023 on a bad key, slug, title or description; `CM009` if the key already names a layout (a fixed route's or a page's) or the slug is taken; makes the layout with an empty draft (version 1, `{"sections": []}`) and the page; logs `create_page` |
| `cms_update_page(p_page_key text, p_slug text default null, p_titles jsonb default null, p_descriptions jsonb default null)` | `authenticated`, `can_edit()` inside | the page | null leaves a field unchanged; `CM001` (detail `{"kind": "page"}`) for an unknown page; `CM009` for a taken slug; logs `update_page` |

Internal: `cms_page_row(uuid)`, `cms_raise_page_taken(text, text)`, `cms_check_page_args(text, jsonb, jsonb)`, `cms_valid_page_texts(jsonb, integer, boolean)`.

**Reserved slugs are the SDK's check, not the database's.** The database does not know a site's routes. `createCmsProvider({ store, registry, reservedSlugs })` takes the site's fixed routes and refuses those slugs with `PageTakenError` (`reason: 'reserved'`) on create and on a slug change; each entry is matched on its first path segment, case and slashes ignored (`/blog/posts` reserves `blog`). A site whose routes carry a language prefix lists the language codes too.

### 4.5 Internal functions (no grants to anyone)

`cms_raise_stale(p_kind text, p_id uuid)` (raises `CE001`, detail the newest version JSON, kind `item` or `layout`), `cms_add_item_version(...)`, `cms_add_layout_version(...)`, `cms_check_refs(p_source_kind text, p_source_id uuid, p_source_item_id uuid, p_refs uuid[])`, `cms_check_layout(p_content jsonb, p_for_publish boolean)`. Their names are not a contract; the public functions' names and signatures above are.

### 4.6 Reference checks (on every item and layout save, and on restore)

For the ids in `p_refs` (deduplicated):

1. every id must exist in `cms_items`, else `CM003` listing the missing ones;
2. a source item must not list itself, and the references reachable from each target (through the newest and published versions of its entries) must not reach the source item, else `CM008`;
3. a target with `reusable = false` may be referenced by one source only (the same source may reference it again in a later version): if another source already holds a counting reference, `CM005`.

The database trusts `p_refs` to be the set of `$ref` markers in `p_content`; it does not parse the content. The SDK collects them (WP1) from the validated content. Because only editors can call these functions, a wrong `p_refs` can only be an editor's own bug, and the usage list would be wrong for that version; the SDK's tests guard the collection.

### 4.7 Layout slot rules

`cms_check_layout` loads the templates named by the layout's sections and, for each section and slot, checks: the template exists, the slot key exists in the template, every item id exists and its `type_key` is in the slot's `allowedTypeKeys`, the number of items is at most `max`; with `p_for_publish` also at least `min`. Section keys are unique (also checked by the SDK schema). Problems are returned as JSON lines `{ "section": "...", "slot": "...", "message": "..." }` in the error detail (`CM004` for a draft save, `CM007` for the minimums at publish).

## 5. Roles and row-level security

Roles come from the existing helpers: **visitor** (the `anon` role, or a signed-in person who is not in `site_members`: treated the same), **member** (a row with role `member`: the same as a visitor for content), **editor** (`can_edit()` true), **owner** (`can_edit()` and `is_owner()` true). Members and visitors have no rights over content beyond reading the published version.

### 5.1 Table access by role (through the API directly)

R = may select, with the rows named; empty = no access.

| Table | Visitor and member | Editor | Owner |
|---|---|---|---|
| `cms_items` | R columns `id, type_key, reusable, translatable, created_at`, rows that have an entry with a published version | same as visitor (titles only through `cms_list_items`) | same |
| `cms_item_entries` | R columns `id, item_id, language, published_version, created_at`, rows with `published_version is not null` | same | same |
| `cms_item_versions` | R columns `entry_id, version, status, content, changed_at, restored_from`, only the row that is its entry's published version | same | same |
| `cms_layouts` | R columns `id, page_key, published_version, created_at`, rows with a published version | same | same |
| `cms_layout_versions` | R columns `layout_id, version, status, content, changed_at, restored_from`, only the published row | same | same |
| `cms_templates` | R all columns, all rows | same | same |
| `cms_assets` | R columns `id, bucket, path, mime, bytes, width, height, label, created_at`, all rows (the bucket is public) | same | same |
| `cms_references` | none | none | none (read through `cms_list_usages`) |
| `cms_change_log` | none | R all, policy `can_edit()` | R all |
| `cms_pages` | R columns `id, layout_id, page_key, slug, titles, descriptions, created_at, updated_at`, rows whose layout is published | same | same |

Nothing is writable through the API by anyone. Not exposed to any API role: `created_by`, `created_by_email`, `changed_by`, `changed_by_email` (who saved what), which editors read through the functions of 4.2.

Implementation: `revoke all on <each table> from anon, authenticated`, then `grant select (<columns>)` as in the table, with `create policy ... for select using (...)` on the rows rule (the published-pointer pattern of the existing entries). `cms_change_log` gets `grant select to authenticated` and a policy `using (can_edit())`.

### 5.2 Function access by role

| Function group | Visitor | Member | Editor | Owner |
|---|---|---|---|---|
| 4.1 reads for everyone | yes (published only) | yes | yes (preview: newest) | yes |
| 4.2 reads for editors | empty | empty | yes | yes |
| 4.3 writes | no (42501) | no | yes | yes |
| 4.4 `cms_delete_item`, `cms_save_template` | no | no | no | yes |

Grants: 4.1 to `anon, authenticated`; 4.2, 4.3, 4.4 to `authenticated` only, with the role check inside as the second guard (the existing pattern). Storage: the `site-images` bucket policies are the existing ones: anyone reads, editors and owners add, nobody updates or deletes.

## 6. Reading rules

### 6.1 Language fallback at read time

For an item that is **translatable**, the candidate entries, in order, are the language asked for, then `en` (`UNIVERSAL_FALLBACK_LANGUAGE`); the first candidate that has something to show wins. For an item that is **not translatable**, the only candidate is the entry `all`, whatever language is asked for. "Something to show" is a published version for a visitor, and, in a preview by an editor, the entry's newest version (so a language that has only a draft is shown to the editor instead of silently falling to English). The result carries the language it came from. A page does not fail because a translation is missing; if no candidate has anything, the item is absent from the page (reported in `problems`).

The database does this in `cms_resolve_items`; the in-memory store (WP1) must give the same results, and the provider checks it with the same tests (a missing translation falls back to English; a type that is not translatable keeps one entry). The existing `createContentProvider`, which serves Slovenian, is untouched by this slice (decision D1).

### 6.2 References

- A reference resolves to the target's published version in the language rule above. A target with no published version resolves to nothing (reported), never to a draft, except in an editor's preview.
- A provider resolves a page in at most `1 + MAX_REFERENCE_DEPTH` round trips to `cms_resolve_items`: the layout's items first, then the `$ref`s found in what came back, to a depth of `MAX_REFERENCE_DEPTH` (3). Deeper references stay as `{ "$ref": ... }` and are reported. The provider detects a cycle by id and stops with a `ResolveProblem`.
- Layout slots hold item ids directly (not `$ref` markers); item content holds `$ref` markers. Both are recorded in `cms_references`.
- A reference points at **document** items only (decision D6).

### 6.3 Reusable

`reusable = false` means the item belongs to one place: one source may reference it (CM005 otherwise). `reusable = true` may be referenced from any number of places. Page-specific blocks are created non-reusable; the editor's picker lists only reusable items for "use an existing item".

## 7. Collection types and the adapter

A collection type is registered with `storage: 'collection'`, `translatable: false` and `adapter: '<key>'`. The site supplies one `CollectionAdapter<T>` per key (`src/cms/item.ts`); the SDK knows no column names. The portfolio's blog posts stay in `blog_posts` unchanged and unmigrated. The adapter maps one blog row to `CollectionRecord<T>` (`value` being the post's fields as the type's schema describes them, `status` the row's draft or published status, `updatedAt` its timestamp) and back.

```ts
interface CollectionAdapter<T> {
  readonly key: string;
  list(options?: { status?; limit?; cursor? }): Promise<{ records: CollectionRecord<T>[]; nextCursor: string | null }>;
  get(id: string): Promise<CollectionRecord<T> | null>;
  create(value: T): Promise<CollectionRecord<T>>;
  update(id: string, value: T, baseUpdatedAt: string | null): Promise<CollectionRecord<T>>; // CollectionConflictError if stored record moved on
  setStatus(id: string, status: 'draft' | 'published'): Promise<CollectionRecord<T>>;
  remove(id: string): Promise<void>;
}
```

The generated editor treats a collection record like a document item, with these differences: no version history and no restore; draft and published are a status the actions bar toggles; a stale save is detected by `updatedAt`; no language tabs; a collection record cannot be the target of an `ItemRef`; no usage list, so deleting is the adapter's own rule. Public reads of posts stay in the site's own code. Who may write is the site's own rule through the adapter (the portfolio's existing owner becomes the owner role, so the adapter's writes are gated by `can_edit()` or `is_owner()` in the database policies of `blog_posts`, a site-local migration, WP4).

## 8. Where the shared migration lives

**Recommended and chosen: a `supabase/` folder in this SDK repository**, the migrations in `supabase/migrations/` and their database tests in `supabase/tests/`, with `supabase` added to `package.json` `files` so the published package carries them.

Why: (1) the SDK already is the one thing both sites depend on, with one version number, so a site's migration and the code that calls its functions are released together and cannot drift; (2) the functions' names, signatures and error codes are a contract with `src/cms/`, and a contract is safest in the same repository and the same PR as the code that uses it; (3) the files are public-safe (they hold no site content, no keys, no names), like the existing standard migrations; (4) a private shared repository or a copy in each site would make two copies to keep in step by hand. Cost accepted: a site must copy the files in; this is made mechanical below.

File names are fixed with their timestamps so a copy is byte-for-byte and name-for-name the same in every site; all later than any existing migration of either site:

```
supabase/migrations/20261115000100_cms_roles.sql              (idempotent)
supabase/migrations/20261115000200_cms_legacy_entries.sql     (idempotent)
supabase/migrations/20261115000300_cms_images_bucket.sql      (idempotent)
supabase/migrations/20261115000400_cms_tables.sql             (tables, indexes, triggers, RLS, grants)
supabase/migrations/20261115000500_cms_functions.sql          (functions and their grants)
supabase/migrations/20261115000600_cms_seed_templates.sql     (BUILTIN_SECTION_TEMPLATES, upserted)
supabase/migrations/20261117090000_cms_pages.sql              (pages an editor makes, 3.11 and 4.4a; added later, not idempotent)
```

A site copies them with an npm script that reads from `node_modules` (`cp node_modules/@littlebranches/giselle-sections-sdk/supabase/migrations/*.sql supabase/migrations/`) and has a test that the files in its own `supabase/migrations/` that carry the `_cms_` infix are byte-identical to the package's. During this epic, before the SDK is published, a site reads them through its local link to the SDK worktree. Later changes to the model are new files with later timestamps, never edits of these.

## 9. The generated editor

The next slice builds the editor; this slice fixes its input so the registry can be written now.

`describeFields(type: ContentType): FieldConfig[]` (WP1, pure) walks the type's zod schema, then applies `type.editor.overrides`. The form (the portfolio's dynamic form: Details and Content accordions, a live preview, a Delete / Cancel / Save bar, view mode and edit in place) consumes `FieldConfig[]` and nothing else. One field of the output is exactly the `FieldConfig` type in `src/cms/editor.ts`.

| Schema | Widget | Notes |
|---|---|---|
| `z.string()` | `text` | `minLength`/`maxLength` from checks; `maxLength` over 200 gives `textarea` |
| `z.url()` or `z.string().url()` | `url` | |
| `z.string()` for a calendar date (`z.iso.date()`) | `date` | |
| `z.number()` | `number` | `min`, `max`, `integer` from checks |
| `z.boolean()` | `switch` | |
| `z.enum([...])`, a union of literals | `select` | options are the values, labelled by the value unless an override gives labels |
| `assetRefSchema` (tagged `widget: 'image'`) | `image` | the asset picker and upload |
| `itemRefSchema` (tagged `widget: 'item-ref'`) | `item-ref` | `allowedTypeKeys` from the override, else every block type |
| `z.array(itemRefSchema)` | `item-ref-list` | |
| `z.object({...})` | `group` | `fields` are the properties, path `parent.child` |
| `z.array(x)` | `list` | `item` is the config of `x` at path `parent.*`; `min`/`max` from checks |
| `.optional()`, `.nullable()`, `.default(v)` | same widget | `required: false`; the default goes in `defaultValue` |

Precedence, per property: an override beats a marker (`.meta({ widget })` on the schema) beats the inferred widget. Label defaults to the humanised property name; group defaults to `Details`. Overrides per field (`EditorFieldOverride`): `label`, `help`, `placeholder`, `widget` (one of `EDITOR_WIDGETS`), `group`, `order`, `hidden`, `readOnly`, `rows`, `options`, `allowedTypeKeys`. Paths are dotted, with `*` for list elements (`cards.*.title`). A type's `editor.groups` orders the accordions.

Not supported by the generator: discriminated or free unions of objects, records, tuples, recursive schemas, and a field whose schema is `z.any()`/`z.unknown()`. `register()` refuses a type whose schema contains one of these unless `editor.custom` is true, in which case the site provides its own form for that type and the generated editor shows it in the same frame (accordions, preview, actions bar), and refuses overrides that name no field. A slot of a container is not a schema field: how the editor shows a slot and its allowed types is the next slice's to settle (the spec leaves it open); this slice supplies only the `SlotDefinition` data.

## 10. Preview mode

Purpose: a signed-in editor sees drafts of items and layouts on the real page; a visitor never does.

1. The site decides a request is a preview only when **both** hold: the request carries the site's preview switch (a `preview` cookie set by a "Preview" button in the site's editor chrome, not a query string that could be shared or cached), **and** the person has an editor or owner session. The site then calls the provider with `{ preview: true }` using the person's own session client (not a service key).
2. The database is the authority: `cms_resolve_items` and `cms_read_layout` return newest versions only when `p_preview` is true **and** `can_edit()` is true. For anyone else they return the published version whatever `p_preview` says; the provider then reports `isDraft: false`. A forged cookie therefore shows nothing extra. The stores read a page's layout through `layouts.read(pageKey, preview)`, which calls `cms_read_layout` (granted to `anon` and `authenticated`), never the editors-only `cms_read_layout_newest`, so a visitor who sends the flag gets the published page, not a permission error.
3. In a preview the page renders as normal and the site adds a visible "Preview: drafts shown" banner with an exit link that clears the cookie. A draft item is marked in the data (`ResolvedItem.isDraft`, `ResolvedPage.isDraft`) so the site may outline it.
4. A preview response is never cached and never indexed: `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`, no static generation or shared cache entry for a request that has the cookie.
5. Language fallback inside a preview follows 6.1 (a draft in the asked language beats a published English entry).
6. Drafts are never visible through any other path: not through the table grants (5.1), not through a sitemap, a feed or a social card.

## 11. What each package builds

### WP1 SDK (this repository, `src/`)

1. `createContentTypeRegistry(): ContentTypeRegistry`: validates with `contentTypeDefinitionSchema`, refuses a duplicate key, checks that every override path names a field of the schema (a list element is `*`), refuses an unsupported schema unless `editor.custom`, checks that a container's slot `allowedTypeKeys` name block types registered **or registered later** (checked by a separate `registry.validate()` once the site has registered all types), and that `slot.max` is at most `MAX_ITEMS_PER_SLOT`.
2. `describeFields(type): FieldConfig[]` (section 9) and `collectItemRefs(content): string[]` (every `{ $ref }` marker, deduplicated), `collectLayoutItemIds(content): string[]`.
3. `createInMemoryCmsStore(): CmsContentStore`: every rule of sections 3 to 6 (versions, stale saves, publish pointer, restore, the reference checks including `CM005` and `CM008`, usages, delete refused with usages, slot rules, fallback, the preview rule with a settable "caller is an editor" test hook), throwing the error classes of `errors.ts`.
4. `createSupabaseCmsStore(client): CmsContentStore`: calls exactly the functions of section 4 and reads exactly the columns of 5.1, mapping error codes with `CMS_ERROR_CODES` and parsing the `detail` JSON into the error classes. The legacy `ContentStore` methods call the existing `content_*` functions, so the campaign site's current store moves here unchanged.
5. `createCmsProvider(...)` (`CreateCmsProvider`): schema checks on save and read, `$ref` collection, the page resolution of 6.2, fallback, problems list, the preview option. Invalid content is never returned to a page and never handed to the store.
6. Exports: add what 5 to 8 need to `src/cms/index.ts`; keep the existing content module working; keep `FALLBACK_LANGUAGE` of the old module for `createContentProvider` (D1). Tests on the in-memory store for every acceptance criterion that is about behaviour.
7. A banned-name check by eye on everything written. No private name.

### WP2 shared migration (this repository, `supabase/`)

1. The six files of section 8, written to the table, column, check, index, trigger, policy, grant and function contracts of sections 3 to 5, with the exact names, signatures and error codes of section 4.
2. `supabase/tests/`: database tests on an in-memory Postgres loaded with the real migration files (with a small harness that stubs `auth.users`, `auth.uid()`, `auth.jwt()`, `storage.buckets` and `storage.objects`, and the `anon` and `authenticated` roles). They cover, per role: a visitor sees published only and no draft, in the table or through a function; a member and a stranger are the same as a visitor; an editor reads drafts, saves, publishes, restores; only the owner deletes an item or saves a template; a stale save and a stale publish are refused with `CE001` and the newest version, nothing written; only the newest version can be published; restore makes a new version; delete refused with `CM002` and the usages while referenced, allowed when not; `CM003`, `CM004`, `CM005`, `CM007`, `CM008` cases; a non-translatable item keeps one entry; fallback to English; the append-only triggers; per-column grants (a visitor selecting `title` or `changed_by_email` fails); the idempotent files apply twice with no error and on top of the legacy tables unchanged.
3. Add `supabase` to `package.json` `files`. (Small, and the only edit to a file WP1 may also touch; merge by taking both.)
4. A test that the seeded templates equal `BUILTIN_SECTION_TEMPLATES`.

### WP3 campaign site

1. Adopt the SDK through the local link; copy the six migration files (the three idempotent ones are no-ops there); a test that its copies equal the SDK's.
2. Register types `hero`, `thanks-banner` and `help` (and the built-in keys it uses) and the `section` container with a registry, component keys bound to its library components through its own `ComponentResolver`; site-local templates, if the built-in ones do not fit, in its own migration (and a seed with the words of the three code files, word for word, plus a test comparing them, then remove those words from the code files).
3. A landing page layout seeded and read through `createCmsProvider(...).page('landing', language)`; the page's section order comes from it.
4. Preview mode as in section 10, for editors.
5. The words are in three languages with English as the fallback (a missing `de` shows `en`).

### WP4 portfolio

1. Adopt the SDK and copy the six migration files; a site-local migration that moves its single owner row into `site_members` as role `owner` and keeps `blog_posts` as is (with write policies using `can_edit()`/`is_owner()` as its design needs).
2. The blog as a collection type through a `CollectionAdapter` over `blog_posts`: same form, same fields, same behaviour for the user.
3. One home section ported as a document type, a template if needed, and a layout, read through the provider; preview mode as in section 10.

### WP5 component library

Only if a registry binding needs something from a component (for example a slot prop). Otherwise no change.

## 12. Decisions

These were left open by the spec ("Left to settle while building"). Each is the most conservative choice.

| # | Open point | Decision |
|---|---|---|
| D1 | The spec says the universal fallback is English; the existing provider serves Slovenian (`FALLBACK_LANGUAGE = 'sl'`). | The new model uses `UNIVERSAL_FALLBACK_LANGUAGE = 'en'` (a contradiction with today's code, noted). The old `FALLBACK_LANGUAGE`, `CONTENT_LANGUAGES` and `createContentProvider` are not changed in this slice, so nothing in the campaign site changes until it moves a section to items. They are to be deprecated in the PR description. |
| D2 | Table and column design. | Section 3. New `cms_`-prefixed tables; the existing entries tables untouched (3.1). |
| D3 | Canonical home of the migration. | `supabase/` in this repository, in the published package (section 8). |
| D4 | One entry for a type that is not translatable. | Language code `all` stored in the same entries table, constrained by the item's `translatable` flag. The code is not a language a visitor can ask for. |
| D5 | Registry entry shape and how a type declares editor overrides. | `contentTypeDefinitionSchema` in `content-type.ts`; overrides keyed by dotted field path with `*` for list elements. |
| D6 | Reference targets. | Document items only; a collection record cannot be referenced. Item-to-item references are allowed, depth limited to 3 on read, cycles refused on save (`CM008`). |
| D7 | Which versions of a source count as a reference. | The source's newest and its published version (3.7). |
| D8 | Template lifecycle. | Not versioned; owners create or replace; no delete in this slice. Built-ins are seeded and protected. |
| D9 | Who may delete an item. | Owners only (the delete also removes the history). Editors may create, edit, publish, restore and register assets. |
| D10 | Non-reusable items. | May be referenced from one source only (`CM005`). |
| D11 | Slot rules enforced by the database. | Allowed types and `max` on every layout save; `min` only on publish, so an editor can save a half-built page. Container types allow block types in their slots in this slice (no nested containers). |
| D12 | Item titles. | Kept for editors; visitors cannot read them (no column grant). |
| D13 | Type keys of the built-in templates. | `section` (container), `banner`, `card`, `timeline` (blocks). A site registers types under these keys to use them, or seeds its own templates. |
| D14 | Layout section extras. | An optional `anchor` per section, for navigation links. Nothing else is added. |
| D15 | Reference collection. | The provider collects `$ref` markers and passes them as `p_refs`; the database validates them but does not parse content. |
| D16 | Preview switch. | A cookie set by the editor chrome, plus a real editor session; the database decides what is returned. Never a query string. |
| D17 | Unsupported schema shapes. | Refused at registration unless the type declares `editor.custom`. |
| D18 | Asset deletion. | None, ever, through the app (the bucket already forbids it); assets rows are append-only. |
| D19 | Change log. | One `cms_change_log` for the new tables' publishes, deletes, template saves and asset registrations. The legacy publish log stays for legacy entries. |
| D20 | Migration timestamps. | Fixed (`20261115...`), later than every existing migration of both sites; a site whose database already holds later migrations applies them with the tool's "include all" option. |
| D21 | Dynamic pages: a slug on the layout, or a pages table. | A separate `cms_pages` table pointing at an ordinary layout (3.11): the layout tables stay as they were, fixed routes need no slug or title, and the page's words live beside its layout instead of inside a versioned document. Titles and descriptions are not versioned. |
| D22 | Deleting a page. | Not in this slice: there is no function, and a trigger refuses a delete (layouts cannot be deleted either). |
| D23 | Reserved slugs. | The SDK's check (the provider's `reservedSlugs`), since only the site knows its routes; the database refuses only duplicates. |
| D24 | A page's address. | One lowercase kebab segment, unique per database, changeable; the page key is fixed at creation and must not already name any layout. |
| D25 | A page read with the preview flag by a visitor. | The stores read through `cms_read_layout` (and `cms_read_page_by_slug`), granted to everyone; the database ignores the flag for non-editors, so a visitor gets the published page, never a permission error. |

### Contradictions and cautions found in the spec

- Decision 9 (universal fallback English) against the existing fallback to Slovenian: see D1.
- "Items versioned on their own" (decision 8) and "a type that is not translatable keeps one entry" (decision 9) need a place for that one entry: see D4.
- The spec's reading order refers to an entries ticket as built; the legacy tables are therefore treated as live in the campaign database and not touched.
- The spec says "a reference to a shared item resolves to the published version" but also lets layouts reference non-shared items; a layout slot reference is therefore resolved the same way, and page-specific items are simply non-reusable (D10).
