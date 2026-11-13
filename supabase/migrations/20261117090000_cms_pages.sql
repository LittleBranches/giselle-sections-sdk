-- Pages an editor makes: a page layout with a public address (a slug), a title and a description per language. A site
-- serves them through one catch-all route; its fixed routes keep reading their layouts by page key as before. A page's
-- layout is an ordinary row of `cms_layouts` (same versions, same draft and publish rules); this file only adds the
-- address and the words a page needs around its sections.
--
-- Same rules as the earlier files: RLS on, no write grant and no write policy, every write through a `security definer`
-- function that begins with its role check. New error code: CM009 the slug or the page key is already taken (detail:
-- `{"field": "slug" | "pageKey", "value": "..."}`). The SDK's reserved slugs (a site's fixed routes) are checked by the
-- SDK, not here: the database does not know a site's routes.

-- ----------------------------------------------------------------------
-- The table
-- ----------------------------------------------------------------------

-- A map of language code to text, every value 1 to `p_max` characters, English present when `p_require_en`. Used by the
-- table's checks and by the functions, so the rule is written once.
create function cms_valid_page_texts(p_texts jsonb, p_max integer, p_require_en boolean) returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_texts is not null
    and jsonb_typeof(p_texts) = 'object'
    and (not p_require_en or p_texts ? 'en')
    and not exists (
      select 1 from jsonb_each(p_texts) as t (code, value)
      where t.code !~ '^[a-z]{2}$'
         or jsonb_typeof(t.value) <> 'string'
         or char_length(btrim(t.value #>> '{}')) not between 1 and p_max
    );
$$;

create table cms_pages (
  id uuid primary key default gen_random_uuid(),
  -- the page's layout; one page per layout, and a layout made by a fixed route is never a page
  layout_id uuid not null unique references cms_layouts (id) on delete cascade,
  -- a copy of the layout's key, so a page is found by either; never changes (trigger below)
  page_key text not null unique check (page_key ~ '^[a-z][a-z0-9-]*$' and char_length(page_key) <= 64),
  -- the address: lowercase words joined by single hyphens, unique in this database
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 100),
  titles jsonb not null check (public.cms_valid_page_texts(titles, 120, true)),
  descriptions jsonb not null default '{}'::jsonb check (public.cms_valid_page_texts(descriptions, 300, false)),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  created_by_email text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_by_email text
);

-- A page keeps its layout and its key; only the slug, the words and the update stamp change. No delete in this slice.
create function cms_guard_page_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id or new.layout_id is distinct from old.layout_id or new.page_key is distinct from old.page_key
     or new.created_at is distinct from old.created_at or new.created_by is distinct from old.created_by
     or new.created_by_email is distinct from old.created_by_email then
    raise exception 'Only the slug, the titles and the descriptions of a page can change' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function cms_guard_page_update() from public, anon, authenticated;

create trigger cms_pages_guard_update before update on cms_pages
  for each row execute function cms_guard_page_update();
create trigger cms_pages_no_delete before delete on cms_pages
  for each row execute function cms_forbid_change();
create trigger cms_pages_no_truncate before truncate on cms_pages
  for each statement execute function cms_forbid_change();

-- The change log learns two actions.
alter table cms_change_log drop constraint cms_change_log_action_check;
alter table cms_change_log add constraint cms_change_log_action_check
  check (action in ('publish_item', 'publish_layout', 'delete_item', 'save_template', 'register_asset', 'create_page', 'update_page'));

-- ----------------------------------------------------------------------
-- Row-level security and grants: a visitor sees a page once its layout is published, and not who made it
-- ----------------------------------------------------------------------

alter table cms_pages enable row level security;

create policy "Anyone can read a page whose layout is published"
  on cms_pages for select
  using (
    exists (
      select 1 from public.cms_layouts as layout
      where layout.id = cms_pages.layout_id and layout.published_version is not null
    )
  );

revoke all on cms_pages from anon, authenticated;
grant select (id, layout_id, page_key, slug, titles, descriptions, created_at, updated_at) on cms_pages to anon, authenticated;

-- ----------------------------------------------------------------------
-- Functions
-- ----------------------------------------------------------------------

-- Refuses a slug or a page key that is taken, with which one as the detail.
create function cms_raise_page_taken(p_field text, p_value text) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'That % is already taken', case p_field when 'slug' then 'address' else 'page key' end
    using errcode = 'CM009', detail = jsonb_build_object('field', p_field, 'value', p_value)::text;
end;
$$;

-- Checks the arguments a page is written with; null leaves a field out of the check (an update that keeps it).
create function cms_check_page_args(p_slug text, p_titles jsonb, p_descriptions jsonb) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_slug is not null and (p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(p_slug) > 100) then
    raise exception 'An address is lowercase letters and digits in words joined by single hyphens, at most 100 characters' using errcode = '22023';
  end if;
  if p_titles is not null and not public.cms_valid_page_texts(p_titles, 120, true) then
    raise exception 'Titles are a map of language code to a title of 1 to 120 characters, with English present' using errcode = '22023';
  end if;
  if p_descriptions is not null and not public.cms_valid_page_texts(p_descriptions, 300, false) then
    raise exception 'Descriptions are a map of language code to a text of 1 to 300 characters' using errcode = '22023';
  end if;
end;
$$;

-- A page as the functions return it: no one's name or email, and its layout's published version.
create function cms_page_row(p_page_id uuid)
returns table (
  id uuid, page_key text, slug text, titles jsonb, descriptions jsonb, published_version integer, created_at timestamptz, updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.page_key, p.slug, p.titles, p.descriptions, l.published_version, p.created_at, p.updated_at
  from public.cms_pages as p
  join public.cms_layouts as l on l.id = p.layout_id
  where p.id = p_page_id;
$$;

-- Editors: makes a page with an empty draft layout (version 1, no sections). The page shows to visitors once that layout
-- is published. A page key that already names a layout (a fixed route's, or another page's) is refused, as is a taken slug.
create function cms_create_page(p_page_key text, p_slug text, p_titles jsonb, p_descriptions jsonb default '{}'::jsonb)
returns table (
  id uuid, page_key text, slug text, titles jsonb, descriptions jsonb, published_version integer, created_at timestamptz, updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  the_layout uuid;
  created public.cms_pages;
begin
  if not public.can_edit() then
    raise exception 'Only editors and owners can change content' using errcode = '42501';
  end if;
  if p_page_key is null or p_page_key !~ '^[a-z][a-z0-9-]*$' or char_length(p_page_key) > 64 then
    raise exception 'A page key is lowercase letters, digits and hyphens, starting with a letter' using errcode = '22023';
  end if;
  if p_slug is null or p_titles is null then
    raise exception 'A page needs an address and a title' using errcode = '22023';
  end if;
  perform public.cms_check_page_args(p_slug, p_titles, coalesce(p_descriptions, '{}'::jsonb));

  if exists (select 1 from public.cms_layouts as l where l.page_key = p_page_key) then
    perform public.cms_raise_page_taken('pageKey', p_page_key);
  end if;
  if exists (select 1 from public.cms_pages as p where p.slug = p_slug) then
    perform public.cms_raise_page_taken('slug', p_slug);
  end if;

  perform public.cms_add_layout_version(p_page_key, null, '{"sections": []}'::jsonb, '{}'::uuid[], null);
  select l.id into the_layout from public.cms_layouts as l where l.page_key = p_page_key;

  begin
    insert into public.cms_pages (layout_id, page_key, slug, titles, descriptions, created_by, created_by_email, updated_by, updated_by_email)
    values (the_layout, p_page_key, p_slug, p_titles, coalesce(p_descriptions, '{}'::jsonb),
            (select auth.uid()), (select auth.jwt() ->> 'email'), (select auth.uid()), (select auth.jwt() ->> 'email'))
    returning * into created;
  exception when unique_violation then
    -- two editors racing for the same address: the second one is told, as if it had been taken before
    perform public.cms_raise_page_taken('slug', p_slug);
  end;

  insert into public.cms_change_log (user_id, user_email, action, subject_id, detail)
  values ((select auth.uid()), (select auth.jwt() ->> 'email'), 'create_page', created.id, jsonb_build_object('pageKey', p_page_key, 'slug', p_slug));
  return query select * from public.cms_page_row(created.id);
end;
$$;

-- Editors: changes a page's slug, titles or descriptions; a null argument leaves that field as it is.
create function cms_update_page(p_page_key text, p_slug text default null, p_titles jsonb default null, p_descriptions jsonb default null)
returns table (
  id uuid, page_key text, slug text, titles jsonb, descriptions jsonb, published_version integer, created_at timestamptz, updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  existing public.cms_pages;
  updated public.cms_pages;
begin
  if not public.can_edit() then
    raise exception 'Only editors and owners can change content' using errcode = '42501';
  end if;
  perform public.cms_check_page_args(p_slug, p_titles, p_descriptions);

  select * into existing from public.cms_pages as p where p.page_key = p_page_key for update;
  if existing.id is null then
    raise exception 'There is no page "%"', p_page_key using errcode = 'CM001', detail = jsonb_build_object('kind', 'page', 'id', p_page_key)::text;
  end if;
  if p_slug is not null and p_slug <> existing.slug and exists (select 1 from public.cms_pages as p where p.slug = p_slug) then
    perform public.cms_raise_page_taken('slug', p_slug);
  end if;

  begin
    update public.cms_pages as p
    set slug = coalesce(p_slug, p.slug),
        titles = coalesce(p_titles, p.titles),
        descriptions = coalesce(p_descriptions, p.descriptions),
        updated_at = now(),
        updated_by = (select auth.uid()),
        updated_by_email = (select auth.jwt() ->> 'email')
    where p.id = existing.id
    returning * into updated;
  exception when unique_violation then
    perform public.cms_raise_page_taken('slug', p_slug);
  end;

  insert into public.cms_change_log (user_id, user_email, action, subject_id, detail)
  values ((select auth.uid()), (select auth.jwt() ->> 'email'), 'update_page', updated.id, jsonb_build_object('pageKey', p_page_key, 'slug', updated.slug));
  return query select * from public.cms_page_row(updated.id);
end;
$$;

-- Everyone: a page by its address with the layout to show. A visitor gets a row only when the layout is published, and
-- the published version; an editor with `p_preview` gets the newest version, also of a page never published.
create function cms_read_page_by_slug(p_slug text, p_preview boolean default false)
returns table (
  id uuid, page_key text, slug text, titles jsonb, descriptions jsonb, published_version integer, created_at timestamptz,
  updated_at timestamptz, version integer, status text, content jsonb, changed_at timestamptz, is_draft boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  newest_wanted boolean := coalesce(p_preview, false) and public.can_edit();
begin
  return query
  select p.id, p.page_key, p.slug, p.titles, p.descriptions, l.published_version, p.created_at, p.updated_at,
         v.version, v.status, v.content, v.changed_at, (v.status = 'draft')
  from public.cms_pages as p
  join public.cms_layouts as l on l.id = p.layout_id
  join public.cms_layout_versions as v on v.layout_id = l.id
    and v.version = case
      when newest_wanted then (select max(v2.version) from public.cms_layout_versions as v2 where v2.layout_id = l.id)
      else l.published_version
    end
  where p.slug = p_slug;
end;
$$;

-- Editors: every page, published or not, by address. Anyone else gets an empty list.
create function cms_list_pages()
returns table (
  id uuid, page_key text, slug text, titles jsonb, descriptions jsonb, published_version integer, created_at timestamptz, updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.* from public.cms_pages as p cross join lateral public.cms_page_row(p.id) as r
  where public.can_edit()
  order by p.slug;
$$;

revoke all on function cms_valid_page_texts(jsonb, integer, boolean) from public, anon, authenticated;
revoke all on function cms_page_row(uuid) from public, anon, authenticated;
revoke all on function cms_raise_page_taken(text, text) from public, anon, authenticated;
revoke all on function cms_check_page_args(text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function cms_create_page(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function cms_update_page(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function cms_read_page_by_slug(text, boolean) from public, anon, authenticated;
revoke all on function cms_list_pages() from public, anon, authenticated;

grant execute on function cms_read_page_by_slug(text, boolean) to anon, authenticated;
grant execute on function cms_list_pages() to authenticated;
grant execute on function cms_create_page(text, text, jsonb, jsonb) to authenticated;
grant execute on function cms_update_page(text, text, jsonb, jsonb) to authenticated;
