-- The section entries store, as a file that can be applied to any database, again and again: entries and versions, with draft
-- and publish, keyed by (section, language). A database that already has these tables and functions (made by an earlier
-- migration with the same text) is left as it is; a database that has none gets them. Every object is created only if it is
-- missing, functions are replaced with the same text, and policies are dropped and created again.
--
-- The new content model (the `cms_` tables) does not use these tables and does not alter them.
--
--   An entry is one section in one language. Its words are a JSON document; the section's schema (in the app, checked
--   by the SDK) says what shape it must have, and the database only insists it is an object.
--   An entry has versions: 1, 2, 3 ... each saved by one person at one time, never changed afterwards except that a version
--   is marked 'published' once it has been published. The entry's `published_version` says which one is live.
--
-- Who may do what (the helpers are the standard ones from the roles file):
--   anyone, no sign-in   read the published version of an entry
--   editors and owners   read drafts and history, save drafts, publish, restore
--   members, strangers, visitors   nothing beyond the published version
--
-- All writing goes through the functions below, never straight to the tables: a save carries the version it was based
-- on and is refused if that is no longer the newest, and that check and the numbering must happen in one step.

-- ----------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------

create table if not exists content_entries (
  id bigint generated always as identity primary key,
  section text not null check (section ~ '^[a-z][a-z0-9-]*$'),
  language text not null check (language in ('sl', 'en', 'de')),
  -- the live version; null until the first publish
  published_version integer,
  created_at timestamptz not null default now(),
  unique (section, language)
);

create table if not exists content_versions (
  entry_id bigint not null references content_entries (id),
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
  foreign key (entry_id, restored_from) references content_versions (entry_id, version)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'content_entries_published_fk' and conrelid = 'public.content_entries'::regclass
  ) then
    alter table public.content_entries
      add constraint content_entries_published_fk
      foreign key (id, published_version) references public.content_versions (entry_id, version)
      deferrable initially deferred;
  end if;
end;
$$;

-- Every publish, append-only, like the other logs.
create table if not exists content_publish_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid references auth.users (id) on delete set null,
  user_email text,
  entry_id bigint not null references content_entries (id),
  version integer not null
);

alter table content_entries enable row level security;
alter table content_versions enable row level security;
alter table content_publish_log enable row level security;

-- ----------------------------------------------------------------------
-- Reading
-- ----------------------------------------------------------------------

-- A visitor sees an entry once it has a live version, and only that version's row. Drafts and old versions have no
-- policy that lets anyone in; editors reach them through the functions further down.
drop policy if exists "Anyone can read a published entry" on content_entries;
create policy "Anyone can read a published entry"
  on content_entries for select
  using (published_version is not null);

drop policy if exists "Anyone can read the published version" on content_versions;
create policy "Anyone can read the published version"
  on content_versions for select
  using (
    exists (
      select 1 from public.content_entries as entry
      where entry.id = content_versions.entry_id and entry.published_version = content_versions.version
    )
  );

drop policy if exists "Editors and owners can read the publish record" on content_publish_log;
create policy "Editors and owners can read the publish record"
  on content_publish_log for select
  using (can_edit());

-- No writes through the API, for anyone: the functions below do them. Reads are limited to columns that are safe to
-- show a visitor (not who saved a version, which only editors see).
revoke all on content_entries, content_versions, content_publish_log from anon, authenticated;
grant select (id, section, language, published_version, created_at) on content_entries to anon, authenticated;
grant select (entry_id, version, status, content, changed_at, restored_from) on content_versions to anon, authenticated;
grant select on content_publish_log to authenticated;

-- The live version of an entry: the one call a public page makes. Runs as the caller, so the rules above decide.
create or replace function content_read_published(p_section text, p_language text)
returns table (version integer, status text, content jsonb, changed_at timestamptz, restored_from integer)
language sql
stable
set search_path = ''
as $$
  select v.version, v.status, v.content, v.changed_at, v.restored_from
  from public.content_entries as e
  join public.content_versions as v on v.entry_id = e.id and v.version = e.published_version
  where e.section = p_section and e.language = p_language;
$$;

-- The newest version, draft or not, with who saved it. Editors and owners only: for anyone else it returns nothing.
create or replace function content_read_newest(p_section text, p_language text)
returns table (version integer, status text, content jsonb, changed_by uuid, changed_by_email text, changed_at timestamptz, restored_from integer)
language sql
stable
security definer
set search_path = ''
as $$
  select v.version, v.status, v.content, v.changed_by, v.changed_by_email, v.changed_at, v.restored_from
  from public.content_entries as e
  join public.content_versions as v on v.entry_id = e.id
  where public.can_edit() and e.section = p_section and e.language = p_language
  order by v.version desc
  limit 1;
$$;

-- Every version, newest first, without its content. Editors and owners only.
create or replace function content_list_versions(p_section text, p_language text)
returns table (version integer, status text, changed_by uuid, changed_by_email text, changed_at timestamptz, restored_from integer)
language sql
stable
security definer
set search_path = ''
as $$
  select v.version, v.status, v.changed_by, v.changed_by_email, v.changed_at, v.restored_from
  from public.content_entries as e
  join public.content_versions as v on v.entry_id = e.id
  where public.can_edit() and e.section = p_section and e.language = p_language
  order by v.version desc;
$$;

-- ----------------------------------------------------------------------
-- Writing
-- ----------------------------------------------------------------------

-- Refuses a write based on an old version. The error code is ours (CE001) and its detail is the newest version as JSON, so
-- the app can show the person what the other save changed. Nothing has been written when this is raised.
create or replace function content_raise_stale(p_entry bigint) returns void
language plpgsql
set search_path = ''
as $$
declare
  newest jsonb;
begin
  select jsonb_build_object(
           'version', v.version,
           'status', v.status,
           'content', v.content,
           'changedBy', v.changed_by,
           'changedByEmail', v.changed_by_email,
           'changedAt', v.changed_at,
           'restoredFrom', v.restored_from
         )
  into newest
  from public.content_versions as v
  where v.entry_id = p_entry
  order by v.version desc
  limit 1;

  raise exception 'This entry changed since it was opened; nothing was saved' using errcode = 'CE001', detail = coalesce(newest::text, '{}');
end;
$$;

-- Adds a new draft version and returns its number. Not callable through the API: `content_save_draft` and
-- `content_restore` call it, so only a restore can say where a version's words came from. `p_base_version` is the version
-- the content was edited from (null for the first save of an entry); it must still be the newest.
create or replace function content_add_version(
  p_section text,
  p_language text,
  p_base_version integer,
  p_content jsonb,
  p_restored_from integer
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  the_entry bigint;
  newest integer;
begin
  if not public.can_edit() then
    raise exception 'Only editors and owners can change content' using errcode = '42501';
  end if;
  if p_content is null or jsonb_typeof(p_content) <> 'object' then
    raise exception 'The content must be an object' using errcode = '22023';
  end if;

  insert into public.content_entries (section, language) values (p_section, p_language)
  on conflict (section, language) do nothing;

  -- Lock the entry, so two saves at once are taken one after the other and the second sees the first.
  select e.id into the_entry from public.content_entries as e where e.section = p_section and e.language = p_language for update;

  select coalesce(max(v.version), 0) into newest from public.content_versions as v where v.entry_id = the_entry;
  if newest <> coalesce(p_base_version, 0) then
    perform public.content_raise_stale(the_entry);
  end if;

  insert into public.content_versions (entry_id, version, content, changed_by, changed_by_email, restored_from)
  values (the_entry, newest + 1, p_content, (select auth.uid()), (select auth.jwt() ->> 'email'), p_restored_from);

  return newest + 1;
end;
$$;

-- Saves a new draft version and returns its number (see `content_add_version`).
create or replace function content_save_draft(p_section text, p_language text, p_base_version integer, p_content jsonb) returns integer
language sql
security definer
set search_path = ''
as $$
  select public.content_add_version(p_section, p_language, p_base_version, p_content, null);
$$;

-- Makes a version the live one. It must be the newest: publishing an older version over a newer draft would silently
-- drop the draft's words. To go back to old words, restore them first (which makes a new version), then publish that.
create or replace function content_publish(p_section text, p_language text, p_version integer) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  the_entry bigint;
  newest integer;
begin
  if not public.can_edit() then
    raise exception 'Only editors and owners can change content' using errcode = '42501';
  end if;

  select e.id into the_entry from public.content_entries as e where e.section = p_section and e.language = p_language for update;
  if the_entry is null then
    raise exception 'There is nothing to publish' using errcode = '22023';
  end if;

  select max(v.version) into newest from public.content_versions as v where v.entry_id = the_entry;
  if newest is distinct from p_version then
    perform public.content_raise_stale(the_entry);
  end if;

  -- Publishing what is already live changes nothing and is not recorded again.
  if exists (select 1 from public.content_entries as e where e.id = the_entry and e.published_version = p_version) then
    return;
  end if;

  update public.content_versions as v set status = 'published' where v.entry_id = the_entry and v.version = p_version;
  update public.content_entries as e set published_version = p_version where e.id = the_entry;
  insert into public.content_publish_log (user_id, user_email, entry_id, version)
  values ((select auth.uid()), (select auth.jwt() ->> 'email'), the_entry, p_version);
end;
$$;

-- Saves an old version's words as a new draft version; the old version is untouched. The base version is checked like a save's.
create or replace function content_restore(p_section text, p_language text, p_version integer, p_base_version integer) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_content jsonb;
begin
  if not public.can_edit() then
    raise exception 'Only editors and owners can change content' using errcode = '42501';
  end if;

  select v.content into old_content
  from public.content_entries as e
  join public.content_versions as v on v.entry_id = e.id
  where e.section = p_section and e.language = p_language and v.version = p_version;
  if old_content is null then
    raise exception 'There is no version % to restore', p_version using errcode = '22023';
  end if;

  return public.content_add_version(p_section, p_language, p_base_version, old_content, p_version);
end;
$$;

-- Supabase's default privileges hand every new function to anon and authenticated, so each is revoked by name first and
-- then granted back only where it belongs. Visitors read the live version; the rest need a signed-in session (and the
-- role, checked inside as a second guard).
revoke all on function content_read_published(text, text) from public, anon, authenticated;
revoke all on function content_read_newest(text, text) from public, anon, authenticated;
revoke all on function content_list_versions(text, text) from public, anon, authenticated;
revoke all on function content_raise_stale(bigint) from public, anon, authenticated;
revoke all on function content_add_version(text, text, integer, jsonb, integer) from public, anon, authenticated;
revoke all on function content_save_draft(text, text, integer, jsonb) from public, anon, authenticated;
revoke all on function content_publish(text, text, integer) from public, anon, authenticated;
revoke all on function content_restore(text, text, integer, integer) from public, anon, authenticated;

grant execute on function content_read_published(text, text) to anon, authenticated;
grant execute on function content_read_newest(text, text) to authenticated;
grant execute on function content_list_versions(text, text) to authenticated;
grant execute on function content_save_draft(text, text, integer, jsonb) to authenticated;
grant execute on function content_publish(text, text, integer) to authenticated;
grant execute on function content_restore(text, text, integer, integer) to authenticated;
