-- The content model's tables: items, their entries and versions, page layouts and their versions, templates, assets, the
-- reference index and the change log. Every table is in `public`, prefixed `cms_`, has row-level security on, and has no
-- insert, update or delete grant and no write policy: everything is written by the functions of the next file.
--
--   item      one thing an editor makes (a banner, a card); its words are versioned per language entry
--   layout    one page: an ordered list of sections, each a template filled with item ids; versioned like an item
--   template  a named arrangement of slots (what types go where, how many)
--
-- The legacy section entries tables are neither used nor altered here. The shape of each table is the contract in the
-- SDK's `docs/cms/contracts.md`; later changes are new files with later timestamps, never edits of this one.

-- ----------------------------------------------------------------------
-- Items
-- ----------------------------------------------------------------------

create table cms_items (
  id uuid primary key default gen_random_uuid(),
  type_key text not null check (type_key ~ '^[a-z][a-z0-9-]*$' and char_length(type_key) <= 64),
  -- for editors only: no column grant lets a visitor read it
  title text not null check (char_length(title) between 1 and 120),
  reusable boolean not null default false,
  -- fixed at creation (a trigger below refuses a change)
  translatable boolean not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  created_by_email text
);

create index cms_items_type_key_idx on cms_items (type_key);

-- One entry per item and language. A translatable item has entries in real languages; one that is not translatable has
-- exactly one entry, in the language 'all' (the functions enforce this).
create table cms_item_entries (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references cms_items (id) on delete cascade,
  language text not null check (language ~ '^[a-z]{2}$' or language = 'all'),
  -- the live version; null until the first publish
  published_version integer,
  created_at timestamptz not null default now(),
  unique (item_id, language)
);

create table cms_item_versions (
  entry_id uuid not null references cms_item_entries (id) on delete cascade,
  version integer not null check (version >= 1),
  status text not null default 'draft' check (status in ('draft', 'published')),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  -- who saved it; the email is kept as written, so the history still reads if the user is later deleted
  changed_by uuid references auth.users (id) on delete set null,
  changed_by_email text,
  changed_at timestamptz not null default now(),
  -- the version whose content this one was copied from, if it was made by a restore
  restored_from integer,
  primary key (entry_id, version),
  foreign key (entry_id, restored_from) references cms_item_versions (entry_id, version)
);

alter table cms_item_entries
  add constraint cms_item_entries_published_fk
  foreign key (id, published_version) references cms_item_versions (entry_id, version)
  deferrable initially deferred;

-- ----------------------------------------------------------------------
-- Page layouts (one row per page, not translated: the words live in the items)
-- ----------------------------------------------------------------------

create table cms_layouts (
  id uuid primary key default gen_random_uuid(),
  page_key text not null unique check (page_key ~ '^[a-z][a-z0-9-]*$' and char_length(page_key) <= 64),
  published_version integer,
  created_at timestamptz not null default now()
);

create table cms_layout_versions (
  layout_id uuid not null references cms_layouts (id) on delete cascade,
  version integer not null check (version >= 1),
  status text not null default 'draft' check (status in ('draft', 'published')),
  content jsonb not null check (jsonb_typeof(content) = 'object' and jsonb_typeof(content -> 'sections') = 'array'),
  changed_by uuid references auth.users (id) on delete set null,
  changed_by_email text,
  changed_at timestamptz not null default now(),
  restored_from integer,
  primary key (layout_id, version),
  foreign key (layout_id, restored_from) references cms_layout_versions (layout_id, version)
);

alter table cms_layouts
  add constraint cms_layouts_published_fk
  foreign key (id, published_version) references cms_layout_versions (layout_id, version)
  deferrable initially deferred;

-- ----------------------------------------------------------------------
-- Templates
-- ----------------------------------------------------------------------

create table cms_templates (
  key text primary key check (key ~ '^[a-z][a-z0-9-]*$' and char_length(key) <= 64),
  name text not null check (char_length(name) between 1 and 80),
  container_type_key text not null check (container_type_key ~ '^[a-z][a-z0-9-]*$' and char_length(container_type_key) <= 64),
  -- an array of slot definitions: key, label, allowedTypeKeys, min, max
  slots jsonb not null check (jsonb_typeof(slots) = 'array' and jsonb_array_length(slots) >= 1),
  built_in boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------
-- Assets: a registered file of the images bucket. Never updated, never deleted: content versions keep pointing at it.
-- ----------------------------------------------------------------------

create table cms_assets (
  id uuid primary key default gen_random_uuid(),
  bucket text not null default 'site-images',
  path text not null check (
    char_length(path) between 1 and 500
    and path !~ '^/'
    and path !~ '(^|/)\.\.(/|$)'
  ),
  mime text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  bytes integer not null check (bytes between 1 and 5242880),
  width integer check (width > 0),
  height integer check (height > 0),
  label text check (char_length(label) <= 200),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  created_by_email text,
  unique (bucket, path)
);

-- ----------------------------------------------------------------------
-- The reference index and the change log
-- ----------------------------------------------------------------------

-- Which version of which source points at which item. `source_id` is the id of an entry or of a layout (it points at one of
-- two tables, so no foreign key), and `target_item_id` has no foreign key either: an old version may point at an item that
-- has since been deleted.
create table cms_references (
  source_kind text not null check (source_kind in ('item', 'layout')),
  source_id uuid not null,
  source_version integer not null,
  target_item_id uuid not null,
  primary key (source_kind, source_id, source_version, target_item_id)
);

create index cms_references_target_idx on cms_references (target_item_id);
create index cms_references_source_idx on cms_references (source_kind, source_id);

create table cms_change_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid references auth.users (id) on delete set null,
  user_email text,
  action text not null check (action in ('publish_item', 'publish_layout', 'delete_item', 'save_template', 'register_asset')),
  subject_id uuid,
  language text,
  version integer,
  detail jsonb
);

create index cms_change_log_subject_idx on cms_change_log (subject_id, at desc);

-- ----------------------------------------------------------------------
-- Append-only rules. Grants alone are not enough, because the functions run as the table owner; each rule is a trigger.
-- ----------------------------------------------------------------------

-- A delete is allowed only while `cms.deleting` is 'on'. Only `cms_delete_item` sets it, and only for its own transaction.
create function cms_deleting() returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(current_setting('cms.deleting', true), '') = 'on';
$$;

-- Versions: the only change ever allowed is status 'draft' to 'published'.
create function cms_guard_version_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'draft' and new.status = 'published' and (to_jsonb(new) - 'status') = (to_jsonb(old) - 'status') then
    return new;
  end if;
  raise exception 'A saved version cannot be changed; only a draft can be marked published' using errcode = '42501';
end;
$$;

create function cms_guard_delete() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.cms_deleting() then
    raise exception 'Saved content cannot be deleted' using errcode = '42501';
  end if;
  return old;
end;
$$;

create function cms_forbid_change() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end;
$$;

create function cms_guard_item_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id or new.type_key is distinct from old.type_key or new.translatable is distinct from old.translatable
     or new.created_at is distinct from old.created_at or new.created_by is distinct from old.created_by
     or new.created_by_email is distinct from old.created_by_email then
    raise exception 'Only the title and the reusable flag of an item can change' using errcode = '42501';
  end if;
  return new;
end;
$$;

create function cms_guard_template_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.built_in and not new.built_in then
    raise exception 'A built-in template stays built in' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create function cms_forbid_template_delete() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Templates cannot be deleted' using errcode = '42501';
end;
$$;

revoke all on function cms_deleting() from public, anon, authenticated;
revoke all on function cms_guard_version_update() from public, anon, authenticated;
revoke all on function cms_guard_delete() from public, anon, authenticated;
revoke all on function cms_forbid_change() from public, anon, authenticated;
revoke all on function cms_guard_item_update() from public, anon, authenticated;
revoke all on function cms_guard_template_update() from public, anon, authenticated;
revoke all on function cms_forbid_template_delete() from public, anon, authenticated;

create trigger cms_item_versions_no_edit before update on cms_item_versions
  for each row execute function cms_guard_version_update();
create trigger cms_item_versions_delete_guard before delete on cms_item_versions
  for each row execute function cms_guard_delete();
create trigger cms_item_versions_no_truncate before truncate on cms_item_versions
  for each statement execute function cms_forbid_change();

create trigger cms_layout_versions_no_edit before update on cms_layout_versions
  for each row execute function cms_guard_version_update();
create trigger cms_layout_versions_delete_guard before delete on cms_layout_versions
  for each row execute function cms_guard_delete();
create trigger cms_layout_versions_no_truncate before truncate on cms_layout_versions
  for each statement execute function cms_forbid_change();

create trigger cms_references_no_edit before update on cms_references
  for each row execute function cms_forbid_change();
create trigger cms_references_delete_guard before delete on cms_references
  for each row execute function cms_guard_delete();
create trigger cms_references_no_truncate before truncate on cms_references
  for each statement execute function cms_forbid_change();

create trigger cms_change_log_no_edit before update or delete on cms_change_log
  for each row execute function cms_forbid_change();
create trigger cms_change_log_no_truncate before truncate on cms_change_log
  for each statement execute function cms_forbid_change();

create trigger cms_assets_no_edit before update or delete on cms_assets
  for each row execute function cms_forbid_change();
create trigger cms_assets_no_truncate before truncate on cms_assets
  for each statement execute function cms_forbid_change();

create trigger cms_items_guard_update before update on cms_items
  for each row execute function cms_guard_item_update();
create trigger cms_items_delete_guard before delete on cms_items
  for each row execute function cms_guard_delete();

create trigger cms_templates_guard_update before update on cms_templates
  for each row execute function cms_guard_template_update();
create trigger cms_templates_no_delete before delete on cms_templates
  for each row execute function cms_forbid_template_delete();

-- ----------------------------------------------------------------------
-- Row-level security and grants
-- ----------------------------------------------------------------------

alter table cms_items enable row level security;
alter table cms_item_entries enable row level security;
alter table cms_item_versions enable row level security;
alter table cms_layouts enable row level security;
alter table cms_layout_versions enable row level security;
alter table cms_templates enable row level security;
alter table cms_assets enable row level security;
alter table cms_references enable row level security;
alter table cms_change_log enable row level security;

-- A visitor sees an item once one of its entries has a live version, and only the live version's row. Drafts and old
-- versions have no policy that lets anyone in; editors reach them through the functions of the next file.
create policy "Anyone can read an item that has a published entry"
  on cms_items for select
  using (
    exists (
      select 1 from public.cms_item_entries as entry
      where entry.item_id = cms_items.id and entry.published_version is not null
    )
  );

create policy "Anyone can read a published entry"
  on cms_item_entries for select
  using (published_version is not null);

create policy "Anyone can read the published version of an entry"
  on cms_item_versions for select
  using (
    exists (
      select 1 from public.cms_item_entries as entry
      where entry.id = cms_item_versions.entry_id and entry.published_version = cms_item_versions.version
    )
  );

create policy "Anyone can read a published layout"
  on cms_layouts for select
  using (published_version is not null);

create policy "Anyone can read the published version of a layout"
  on cms_layout_versions for select
  using (
    exists (
      select 1 from public.cms_layouts as layout
      where layout.id = cms_layout_versions.layout_id and layout.published_version = cms_layout_versions.version
    )
  );

create policy "Anyone can read the templates"
  on cms_templates for select
  using (true);

create policy "Anyone can read the assets"
  on cms_assets for select
  using (true);

create policy "Editors and owners can read the change log"
  on cms_change_log for select
  to authenticated
  using (public.can_edit());

-- No writes through the API, for anyone. Reads are limited to columns that are safe to show a visitor: not titles, not who
-- saved what. `cms_references` has no grant and no policy at all (editors read it through `cms_list_usages`).
revoke all on cms_items, cms_item_entries, cms_item_versions, cms_layouts, cms_layout_versions, cms_templates,
  cms_assets, cms_references, cms_change_log from anon, authenticated;

grant select (id, type_key, reusable, translatable, created_at) on cms_items to anon, authenticated;
grant select (id, item_id, language, published_version, created_at) on cms_item_entries to anon, authenticated;
grant select (entry_id, version, status, content, changed_at, restored_from) on cms_item_versions to anon, authenticated;
grant select (id, page_key, published_version, created_at) on cms_layouts to anon, authenticated;
grant select (layout_id, version, status, content, changed_at, restored_from) on cms_layout_versions to anon, authenticated;
grant select on cms_templates to anon, authenticated;
grant select (id, bucket, path, mime, width, height, label, created_at) on cms_assets to anon, authenticated;
grant select on cms_change_log to authenticated;
