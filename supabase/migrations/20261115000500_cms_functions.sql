-- The content model's functions. Nothing is written through the API: every write is one of these, each `security definer`
-- with an empty search_path and every object schema-qualified, beginning with its role check. Each is revoked by name from
-- everyone and then granted back only where it belongs (Supabase's default privileges hand new functions to every role).
--
-- Error codes (the SDK's `CMS_ERROR_CODES`): CE001 stale save (detail: the newest version as JSON), 42501 not allowed,
-- 22023 invalid argument, CM001 not found, CM002 still referenced (detail: usages), CM003 dangling reference (detail: the
-- missing ids), CM004 slot rule broken (detail: problems), CM005 not reusable and used elsewhere (detail: ids), CM006 asset
-- invalid, CM007 layout incomplete at publish (detail: problems), CM008 reference cycle (detail: ids on the cycle).
-- Every `detail` is JSON text.

-- ======================================================================
-- Internal functions: no grants to anyone (the public functions below call them as the table owner)
-- ======================================================================

-- Refuses a write based on an old version, with the newest version as the detail. `p_kind` is 'item' (p_id is an entry id)
-- or 'layout' (p_id is a layout id).
create function cms_raise_stale(p_kind text, p_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  newest jsonb;
begin
  if p_kind = 'item' then
    select jsonb_build_object('version', v.version, 'status', v.status, 'content', v.content, 'changedBy', v.changed_by,
                              'changedByEmail', v.changed_by_email, 'changedAt', v.changed_at, 'restoredFrom', v.restored_from)
    into newest
    from public.cms_item_versions as v
    where v.entry_id = p_id
    order by v.version desc
    limit 1;
  else
    select jsonb_build_object('version', v.version, 'status', v.status, 'content', v.content, 'changedBy', v.changed_by,
                              'changedByEmail', v.changed_by_email, 'changedAt', v.changed_at, 'restoredFrom', v.restored_from)
    into newest
    from public.cms_layout_versions as v
    where v.layout_id = p_id
    order by v.version desc
    limit 1;
  end if;

  raise exception 'This % changed since it was opened; nothing was saved', p_kind using errcode = 'CE001', detail = coalesce(newest::text, '{}');
end;
$$;

-- The references that count (the source's newest or published version), one row per source and target. `source_id` is the
-- entry or layout id, `source_ref_id` the id of the item that holds the reference (or the layout), which is what a "source"
-- means for the rules (all language entries of one item are one source).
create function cms_counting_refs(p_target uuid) returns table (
  source_kind text,
  source_id uuid,
  source_ref_id uuid,
  source_language text,
  target_item_id uuid,
  in_published boolean,
  in_newest boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select 'item'::text, e.id, e.item_id, e.language, r.target_item_id,
         coalesce(bool_or(r.source_version = e.published_version), false),
         coalesce(bool_or(r.source_version = (select max(v.version) from public.cms_item_versions as v where v.entry_id = e.id)), false)
  from public.cms_references as r
  join public.cms_item_entries as e on e.id = r.source_id
  where r.source_kind = 'item'
    and (p_target is null or r.target_item_id = p_target)
    and (r.source_version = e.published_version
         or r.source_version = (select max(v.version) from public.cms_item_versions as v where v.entry_id = e.id))
  group by e.id, e.item_id, e.language, r.target_item_id
  union all
  select 'layout'::text, l.id, l.id, null::text, r.target_item_id,
         coalesce(bool_or(r.source_version = l.published_version), false),
         coalesce(bool_or(r.source_version = (select max(v.version) from public.cms_layout_versions as v where v.layout_id = l.id)), false)
  from public.cms_references as r
  join public.cms_layouts as l on l.id = r.source_id
  where r.source_kind = 'layout'
    and (p_target is null or r.target_item_id = p_target)
    and (r.source_version = l.published_version
         or r.source_version = (select max(v.version) from public.cms_layout_versions as v where v.layout_id = l.id))
  group by l.id, r.target_item_id;
$$;

-- Checks the references of a save (and of a restore), before the version is written. `p_source_id` is the entry or layout
-- id; `p_source_item_id` is the item id for an item source and null for a layout.
--   1. every id must exist (CM003, the missing ids);
--   2. an item must not reach itself through the references that count (CM008, the ids along the way);
--   3. a target that is not reusable may be referenced by one source only (CM005, the target ids).
create function cms_check_refs(p_source_kind text, p_source_id uuid, p_source_item_id uuid, p_refs uuid[]) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  refs uuid[];
  missing uuid[];
  own_id uuid;
  cycle_path uuid[];
  taken uuid[];
begin
  select coalesce(array_agg(distinct r), '{}') into refs from unnest(coalesce(p_refs, '{}'::uuid[])) as r;
  if cardinality(refs) = 0 then
    return;
  end if;

  -- One check at a time, so two saves that would together make a circle cannot both pass.
  perform pg_advisory_xact_lock(7770001);

  select array_agg(r) into missing from unnest(refs) as r where not exists (select 1 from public.cms_items as i where i.id = r);
  if missing is not null then
    raise exception 'This refers to items that do not exist' using errcode = 'CM003', detail = to_jsonb(missing)::text;
  end if;

  own_id := case when p_source_kind = 'item' then p_source_item_id else p_source_id end;

  if p_source_kind = 'item' then
    with recursive edges as (
      select c.source_ref_id, c.target_item_id from public.cms_counting_refs(null) as c where c.source_kind = 'item'
    ), walk(item_id, path) as (
      select t, array[t] from unnest(refs) as t
      union all
      select e.target_item_id, w.path || e.target_item_id
      from walk as w
      join edges as e on e.source_ref_id = w.item_id
      where not (e.target_item_id = any (w.path))
    )
    select array[p_source_item_id] || w.path into cycle_path from walk as w where w.item_id = p_source_item_id limit 1;
    if cycle_path is not null then
      raise exception 'These items would refer to each other in a circle' using errcode = 'CM008', detail = to_jsonb(cycle_path)::text;
    end if;
  end if;

  select array_agg(i.id) into taken
  from public.cms_items as i
  where i.id = any (refs) and not i.reusable
    and exists (
      select 1 from public.cms_counting_refs(i.id) as c
      where not (c.source_kind = p_source_kind and c.source_ref_id = own_id)
    );
  if taken is not null then
    raise exception 'An item that is not reusable is already used elsewhere' using errcode = 'CM005', detail = to_jsonb(taken)::text;
  end if;
end;
$$;

-- Checks a layout's sections against the templates. Problems are JSON lines { section, slot, message }. A draft save checks
-- the template, the slot, the allowed types and the maximum (CM004); a publish also checks the minimum (CM007, raised only
-- when nothing else is wrong).
create function cms_check_layout(p_content jsonb, p_for_publish boolean) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  rules jsonb := '[]'::jsonb;
  minimums jsonb := '[]'::jsonb;
  sec jsonb;
  tpl public.cms_templates;
  slot jsonb;
  slot_key text;
  sec_key text;
  ids jsonb;
  item_text text;
  item_row public.cms_items;
  n integer;
  most integer;
  least_n integer;
begin
  for sec in select s.value from jsonb_array_elements(p_content -> 'sections') as s loop
    sec_key := sec ->> 'key';
    select * into tpl from public.cms_templates as t where t.key = sec ->> 'template';
    if not found then
      rules := rules || jsonb_build_object('section', sec_key, 'slot', null, 'message', format('There is no template "%s"', sec ->> 'template'));
      continue;
    end if;

    if jsonb_typeof(sec -> 'slots') = 'object' then
      for slot_key in select k from jsonb_object_keys(sec -> 'slots') as k loop
        if not exists (select 1 from jsonb_array_elements(tpl.slots) as d where d.value ->> 'key' = slot_key) then
          rules := rules || jsonb_build_object('section', sec_key, 'slot', slot_key, 'message', format('The template "%s" has no slot "%s"', tpl.key, slot_key));
        end if;
      end loop;
    end if;

    for slot in select d.value from jsonb_array_elements(tpl.slots) as d loop
      slot_key := slot ->> 'key';
      ids := coalesce(sec -> 'slots' -> slot_key, '[]'::jsonb);
      if jsonb_typeof(ids) <> 'array' then
        rules := rules || jsonb_build_object('section', sec_key, 'slot', slot_key, 'message', 'The items of a slot must be a list of ids');
        continue;
      end if;

      n := jsonb_array_length(ids);
      most := least(coalesce((slot ->> 'max')::integer, 100), 100);
      least_n := coalesce((slot ->> 'min')::integer, 0);

      if n > most then
        rules := rules || jsonb_build_object('section', sec_key, 'slot', slot_key, 'message', format('At most %s items fit in this slot, there are %s', most, n));
      end if;
      if p_for_publish and n < least_n then
        minimums := minimums || jsonb_build_object('section', sec_key, 'slot', slot_key, 'message', format('At least %s items are needed in this slot, there are %s', least_n, n));
      end if;

      for item_text in select e.value from jsonb_array_elements_text(ids) as e loop
        if item_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          rules := rules || jsonb_build_object('section', sec_key, 'slot', slot_key, 'message', format('"%s" is not an item id', item_text));
          continue;
        end if;
        select * into item_row from public.cms_items as i where i.id = item_text::uuid;
        if not found then
          rules := rules || jsonb_build_object('section', sec_key, 'slot', slot_key, 'message', format('The item %s does not exist', item_text));
        elsif not (item_row.type_key in (select a.value from jsonb_array_elements_text(slot -> 'allowedTypeKeys') as a)) then
          rules := rules || jsonb_build_object('section', sec_key, 'slot', slot_key, 'message', format('The item %s is a "%s", which this slot does not allow', item_text, item_row.type_key));
        end if;
      end loop;
    end loop;
  end loop;

  if jsonb_array_length(rules) > 0 then
    raise exception 'The layout breaks a slot rule' using errcode = 'CM004', detail = rules::text;
  end if;
  if p_for_publish and jsonb_array_length(minimums) > 0 then
    raise exception 'The layout is not complete' using errcode = 'CM007', detail = minimums::text;
  end if;
end;
$$;

-- Adds a draft version of an item's entry and returns its number. `p_base_version` is the version the content was edited
-- from (null for the first save of an entry); it must still be the newest. Only a restore can set `p_restored_from`.
create function cms_add_item_version(
  p_item_id uuid,
  p_language text,
  p_base_version integer,
  p_content jsonb,
  p_refs uuid[],
  p_restored_from integer
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  the_item public.cms_items;
  the_entry uuid;
  newest integer;
begin
  if not public.can_edit() then
    raise exception 'Only editors and owners can change content' using errcode = '42501';
  end if;
  if p_content is null or jsonb_typeof(p_content) <> 'object' then
    raise exception 'The content must be an object' using errcode = '22023';
  end if;

  select * into the_item from public.cms_items as i where i.id = p_item_id;
  if not found then
    raise exception 'There is no item %', p_item_id using errcode = 'CM001';
  end if;
  if the_item.translatable then
    if p_language is null or p_language !~ '^[a-z]{2}$' then
      raise exception 'A translatable item needs a language' using errcode = '22023';
    end if;
  elsif p_language is distinct from 'all' then
    raise exception 'An item that is not translatable has one entry, in the language all' using errcode = '22023';
  end if;

  insert into public.cms_item_entries (item_id, language) values (p_item_id, p_language)
  on conflict (item_id, language) do nothing;

  -- Lock the entry, so two saves at once are taken one after the other and the second sees the first.
  select e.id into the_entry from public.cms_item_entries as e where e.item_id = p_item_id and e.language = p_language for update;

  select coalesce(max(v.version), 0) into newest from public.cms_item_versions as v where v.entry_id = the_entry;
  if newest <> coalesce(p_base_version, 0) then
    perform public.cms_raise_stale('item', the_entry);
  end if;

  perform public.cms_check_refs('item', the_entry, p_item_id, p_refs);

  insert into public.cms_item_versions (entry_id, version, content, changed_by, changed_by_email, restored_from)
  values (the_entry, newest + 1, p_content, (select auth.uid()), (select auth.jwt() ->> 'email'), p_restored_from);

  insert into public.cms_references (source_kind, source_id, source_version, target_item_id)
  select 'item', the_entry, newest + 1, r from (select distinct unnest(coalesce(p_refs, '{}'::uuid[])) as r) as x;

  return newest + 1;
end;
$$;

-- The same for a page layout, which has no language. Also checks the slot rules, without the minimums.
create function cms_add_layout_version(
  p_page_key text,
  p_base_version integer,
  p_content jsonb,
  p_refs uuid[],
  p_restored_from integer
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  the_layout uuid;
  newest integer;
begin
  if not public.can_edit() then
    raise exception 'Only editors and owners can change content' using errcode = '42501';
  end if;
  if p_page_key is null or p_page_key !~ '^[a-z][a-z0-9-]*$' or char_length(p_page_key) > 64 then
    raise exception 'A page key is lowercase letters, digits and hyphens, starting with a letter' using errcode = '22023';
  end if;
  if p_content is null or jsonb_typeof(p_content) <> 'object' or jsonb_typeof(p_content -> 'sections') is distinct from 'array' then
    raise exception 'The content must be an object with a list of sections' using errcode = '22023';
  end if;

  insert into public.cms_layouts (page_key) values (p_page_key) on conflict (page_key) do nothing;
  select l.id into the_layout from public.cms_layouts as l where l.page_key = p_page_key for update;

  select coalesce(max(v.version), 0) into newest from public.cms_layout_versions as v where v.layout_id = the_layout;
  if newest <> coalesce(p_base_version, 0) then
    perform public.cms_raise_stale('layout', the_layout);
  end if;

  perform public.cms_check_refs('layout', the_layout, null, p_refs);
  perform public.cms_check_layout(p_content, false);

  insert into public.cms_layout_versions (layout_id, version, content, changed_by, changed_by_email, restored_from)
  values (the_layout, newest + 1, p_content, (select auth.uid()), (select auth.jwt() ->> 'email'), p_restored_from);

  insert into public.cms_references (source_kind, source_id, source_version, target_item_id)
  select 'layout', the_layout, newest + 1, r from (select distinct unnest(coalesce(p_refs, '{}'::uuid[])) as r) as x;

  return newest + 1;
end;
$$;

-- ======================================================================
-- Reads for everyone (anon and authenticated)
-- ======================================================================

-- The exact entry's published version, no fallback. Runs as the caller, so the policies decide.
create function cms_read_published(p_item_id uuid, p_language text)
returns table (version integer, status text, content jsonb, changed_at timestamptz, restored_from integer)
language sql
stable
set search_path = ''
as $$
  select v.version, v.status, v.content, v.changed_at, v.restored_from
  from public.cms_item_entries as e
  join public.cms_item_versions as v on v.entry_id = e.id and v.version = e.published_version
  where e.item_id = p_item_id and e.language = p_language;
$$;

-- Many items at once, with the language fallback applied: a translatable item tries the language asked for, then English;
-- one that is not translatable has the entry 'all' only. A visitor gets published versions only. With `p_preview` true and
-- an editor or owner signed in, the newest version of each entry counts instead (so a draft in the asked language beats a
-- published English one). An item with nothing to show gives no row.
create function cms_resolve_items(p_item_ids uuid[], p_language text, p_preview boolean default false)
returns table (
  item_id uuid, type_key text, reusable boolean, translatable boolean, language text,
  version integer, status text, is_draft boolean, content jsonb
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
  if cardinality(coalesce(p_item_ids, '{}'::uuid[])) > 500 then
    raise exception 'At most 500 items can be resolved at once' using errcode = '22023';
  end if;

  return query
  select i.id, i.type_key, i.reusable, i.translatable, pick.language, pick.version, pick.status, (pick.status = 'draft'), pick.content
  from (select distinct u as id from unnest(coalesce(p_item_ids, '{}'::uuid[])) as u) as ids
  join public.cms_items as i on i.id = ids.id
  cross join lateral (
    select e.language, v.version, v.status, v.content
    from public.cms_item_entries as e
    join public.cms_item_versions as v on v.entry_id = e.id
      and v.version = case
        when newest_wanted then (select max(v2.version) from public.cms_item_versions as v2 where v2.entry_id = e.id)
        else e.published_version
      end
    where e.item_id = i.id
      and e.language = any (case when i.translatable then array[p_language, 'en'] else array['all'] end)
    order by case when e.language = p_language then 0 else 1 end
    limit 1
  ) as pick;
end;
$$;

-- A page's layout: the published version, or with `p_preview` and an editor session the newest.
create function cms_read_layout(p_page_key text, p_preview boolean default false)
returns table (version integer, status text, content jsonb, changed_at timestamptz, is_draft boolean)
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
  select v.version, v.status, v.content, v.changed_at, (v.status = 'draft')
  from public.cms_layouts as l
  join public.cms_layout_versions as v on v.layout_id = l.id
    and v.version = case
      when newest_wanted then (select max(v2.version) from public.cms_layout_versions as v2 where v2.layout_id = l.id)
      else l.published_version
    end
  where l.page_key = p_page_key;
end;
$$;

-- All templates: they are not secret, and a visitor's page needs them. Runs as the caller; the policy lets everyone read.
create function cms_list_templates() returns setof public.cms_templates
language sql
stable
set search_path = ''
as $$
  select * from public.cms_templates as t order by t.key;
$$;

-- ======================================================================
-- Reads for editors (the role is checked inside; anyone else gets an empty result)
-- ======================================================================

create function cms_read_newest(p_item_id uuid, p_language text)
returns table (version integer, status text, content jsonb, changed_by uuid, changed_by_email text, changed_at timestamptz, restored_from integer)
language sql
stable
security definer
set search_path = ''
as $$
  select v.version, v.status, v.content, v.changed_by, v.changed_by_email, v.changed_at, v.restored_from
  from public.cms_item_entries as e
  join public.cms_item_versions as v on v.entry_id = e.id
  where public.can_edit() and e.item_id = p_item_id and e.language = p_language
  order by v.version desc
  limit 1;
$$;

create function cms_list_versions(p_item_id uuid, p_language text)
returns table (version integer, status text, changed_by uuid, changed_by_email text, changed_at timestamptz, restored_from integer)
language sql
stable
security definer
set search_path = ''
as $$
  select v.version, v.status, v.changed_by, v.changed_by_email, v.changed_at, v.restored_from
  from public.cms_item_entries as e
  join public.cms_item_versions as v on v.entry_id = e.id
  where public.can_edit() and e.item_id = p_item_id and e.language = p_language
  order by v.version desc;
$$;

-- Every item with the languages that have a live version and how many places use it (a place is an item or a layout).
create function cms_list_items(p_type_key text default null)
returns table (id uuid, type_key text, title text, reusable boolean, translatable boolean, created_at timestamptz, published_languages text[], usage_count integer)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.type_key, i.title, i.reusable, i.translatable, i.created_at,
         coalesce((select array_agg(e.language order by e.language)
                   from public.cms_item_entries as e where e.item_id = i.id and e.published_version is not null), '{}'::text[]),
         (select count(distinct c.source_ref_id)::integer from public.cms_counting_refs(i.id) as c)
  from public.cms_items as i
  where public.can_edit() and (p_type_key is null or i.type_key = p_type_key)
  order by i.created_at desc, i.id;
$$;

-- Where an item is used: only the references that count (the source's newest or published version).
create function cms_list_usages(p_item_id uuid)
returns table (source_kind text, source_id uuid, source_label text, source_language text, in_published boolean, in_newest boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select c.source_kind, c.source_ref_id, coalesce(i.title, l.page_key), c.source_language, c.in_published, c.in_newest
  from public.cms_counting_refs(p_item_id) as c
  left join public.cms_items as i on c.source_kind = 'item' and i.id = c.source_ref_id
  left join public.cms_layouts as l on c.source_kind = 'layout' and l.id = c.source_ref_id
  where public.can_edit()
  order by c.source_kind, 3, c.source_language;
$$;

create function cms_read_layout_newest(p_page_key text)
returns table (version integer, status text, content jsonb, changed_by uuid, changed_by_email text, changed_at timestamptz, restored_from integer)
language sql
stable
security definer
set search_path = ''
as $$
  select v.version, v.status, v.content, v.changed_by, v.changed_by_email, v.changed_at, v.restored_from
  from public.cms_layouts as l
  join public.cms_layout_versions as v on v.layout_id = l.id
  where public.can_edit() and l.page_key = p_page_key
  order by v.version desc
  limit 1;
$$;

create function cms_list_layout_versions(p_page_key text)
returns table (version integer, status text, changed_by uuid, changed_by_email text, changed_at timestamptz, restored_from integer)
language sql
stable
security definer
set search_path = ''
as $$
  select v.version, v.status, v.changed_by, v.changed_by_email, v.changed_at, v.restored_from
  from public.cms_layouts as l
  join public.cms_layout_versions as v on v.layout_id = l.id
  where public.can_edit() and l.page_key = p_page_key
  order by v.version desc;
$$;

create function cms_list_layouts()
returns table (id uuid, page_key text, published_version integer, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id, l.page_key, l.published_version, l.created_at
  from public.cms_layouts as l
  where public.can_edit()
  order by l.page_key;
$$;

-- ======================================================================
-- Writes by editors and owners
-- ======================================================================

create function cms_create_item(p_type_key text, p_title text, p_reusable boolean, p_translatable boolean)
returns public.cms_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  created public.cms_items;
begin
  if not public.can_edit() then
    raise exception 'Only editors and owners can change content' using errcode = '42501';
  end if;
  if p_type_key is null or p_type_key !~ '^[a-z][a-z0-9-]*$' or char_length(p_type_key) > 64 then
    raise exception 'A type key is lowercase letters, digits and hyphens, starting with a letter' using errcode = '22023';
  end if;
  if p_title is null or char_length(p_title) not between 1 and 120 then
    raise exception 'A title is 1 to 120 characters' using errcode = '22023';
  end if;
  if p_translatable is null then
    raise exception 'Say whether the item is translatable' using errcode = '22023';
  end if;

  insert into public.cms_items (type_key, title, reusable, translatable, created_by, created_by_email)
  values (p_type_key, p_title, coalesce(p_reusable, false), p_translatable, (select auth.uid()), (select auth.jwt() ->> 'email'))
  returning * into created;
  return created;
end;
$$;

-- A null argument leaves the field as it is. Making an item not reusable while more than one source uses it is refused.
create function cms_update_item(p_item_id uuid, p_title text default null, p_reusable boolean default null)
returns public.cms_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  the_item public.cms_items;
  sources uuid[];
begin
  if not public.can_edit() then
    raise exception 'Only editors and owners can change content' using errcode = '42501';
  end if;
  if p_title is not null and char_length(p_title) not between 1 and 120 then
    raise exception 'A title is 1 to 120 characters' using errcode = '22023';
  end if;

  select * into the_item from public.cms_items as i where i.id = p_item_id for update;
  if not found then
    raise exception 'There is no item %', p_item_id using errcode = 'CM001';
  end if;

  if p_reusable is false then
    select array_agg(distinct c.source_ref_id) into sources from public.cms_counting_refs(p_item_id) as c;
    if cardinality(coalesce(sources, '{}'::uuid[])) > 1 then
      raise exception 'The item is used in more than one place, so it must stay reusable' using errcode = 'CM005', detail = to_jsonb(sources)::text;
    end if;
  end if;

  update public.cms_items as i
  set title = coalesce(p_title, i.title), reusable = coalesce(p_reusable, i.reusable)
  where i.id = p_item_id
  returning * into the_item;
  return the_item;
end;
$$;

create function cms_save_item_draft(p_item_id uuid, p_language text, p_base_version integer, p_content jsonb, p_refs uuid[])
returns integer
language sql
security definer
set search_path = ''
as $$
  select public.cms_add_item_version(p_item_id, p_language, p_base_version, p_content, p_refs, null);
$$;

-- Makes a version the live one. It must be the newest: publishing an older version over a newer draft would silently drop
-- the draft's words. To go back, restore first (which makes a new version), then publish that.
create function cms_publish_item(p_item_id uuid, p_language text, p_version integer) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  the_entry uuid;
  newest integer;
begin
  if not public.can_edit() then
    raise exception 'Only editors and owners can change content' using errcode = '42501';
  end if;
  if not exists (select 1 from public.cms_items as i where i.id = p_item_id) then
    raise exception 'There is no item %', p_item_id using errcode = 'CM001';
  end if;

  select e.id into the_entry from public.cms_item_entries as e where e.item_id = p_item_id and e.language = p_language for update;
  if the_entry is null then
    raise exception 'There is nothing to publish' using errcode = '22023';
  end if;

  select max(v.version) into newest from public.cms_item_versions as v where v.entry_id = the_entry;
  if newest is distinct from p_version then
    perform public.cms_raise_stale('item', the_entry);
  end if;

  -- Publishing what is already live changes nothing and is not recorded again.
  if exists (select 1 from public.cms_item_entries as e where e.id = the_entry and e.published_version = p_version) then
    return;
  end if;

  update public.cms_item_versions as v set status = 'published' where v.entry_id = the_entry and v.version = p_version;
  update public.cms_item_entries as e set published_version = p_version where e.id = the_entry;
  insert into public.cms_change_log (user_id, user_email, action, subject_id, language, version)
  values ((select auth.uid()), (select auth.jwt() ->> 'email'), 'publish_item', p_item_id, p_language, p_version);
end;
$$;

-- Saves an old version's words and references as a new draft version (the old one is untouched). The references are
-- checked again: one whose target is gone since raises CM003.
create function cms_restore_item(p_item_id uuid, p_language text, p_version integer, p_base_version integer) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  the_entry uuid;
  old_content jsonb;
  old_refs uuid[];
begin
  if not public.can_edit() then
    raise exception 'Only editors and owners can change content' using errcode = '42501';
  end if;
  if not exists (select 1 from public.cms_items as i where i.id = p_item_id) then
    raise exception 'There is no item %', p_item_id using errcode = 'CM001';
  end if;

  select e.id, v.content into the_entry, old_content
  from public.cms_item_entries as e
  join public.cms_item_versions as v on v.entry_id = e.id
  where e.item_id = p_item_id and e.language = p_language and v.version = p_version;
  if old_content is null then
    raise exception 'There is no version % to restore', p_version using errcode = '22023';
  end if;

  select coalesce(array_agg(r.target_item_id), '{}') into old_refs
  from public.cms_references as r
  where r.source_kind = 'item' and r.source_id = the_entry and r.source_version = p_version;

  return public.cms_add_item_version(p_item_id, p_language, p_base_version, old_content, old_refs, p_version);
end;
$$;

create function cms_save_layout_draft(p_page_key text, p_base_version integer, p_content jsonb, p_refs uuid[]) returns integer
language sql
security definer
set search_path = ''
as $$
  select public.cms_add_layout_version(p_page_key, p_base_version, p_content, p_refs, null);
$$;

-- Like the item publish, and also checks the slot rules with the minimums (CM007).
create function cms_publish_layout(p_page_key text, p_version integer) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  the_layout uuid;
  newest integer;
  newest_content jsonb;
begin
  if not public.can_edit() then
    raise exception 'Only editors and owners can change content' using errcode = '42501';
  end if;

  select l.id into the_layout from public.cms_layouts as l where l.page_key = p_page_key for update;
  if the_layout is null then
    raise exception 'There is no page layout "%"', p_page_key using errcode = 'CM001';
  end if;

  select max(v.version) into newest from public.cms_layout_versions as v where v.layout_id = the_layout;
  if newest is distinct from p_version then
    perform public.cms_raise_stale('layout', the_layout);
  end if;

  if exists (select 1 from public.cms_layouts as l where l.id = the_layout and l.published_version = p_version) then
    return;
  end if;

  select v.content into newest_content from public.cms_layout_versions as v where v.layout_id = the_layout and v.version = p_version;
  perform public.cms_check_layout(newest_content, true);

  update public.cms_layout_versions as v set status = 'published' where v.layout_id = the_layout and v.version = p_version;
  update public.cms_layouts as l set published_version = p_version where l.id = the_layout;
  insert into public.cms_change_log (user_id, user_email, action, subject_id, version)
  values ((select auth.uid()), (select auth.jwt() ->> 'email'), 'publish_layout', the_layout, p_version);
end;
$$;

create function cms_restore_layout(p_page_key text, p_version integer, p_base_version integer) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  the_layout uuid;
  old_content jsonb;
  old_refs uuid[];
begin
  if not public.can_edit() then
    raise exception 'Only editors and owners can change content' using errcode = '42501';
  end if;

  select l.id into the_layout from public.cms_layouts as l where l.page_key = p_page_key;
  if the_layout is null then
    raise exception 'There is no page layout "%"', p_page_key using errcode = 'CM001';
  end if;

  select v.content into old_content from public.cms_layout_versions as v where v.layout_id = the_layout and v.version = p_version;
  if old_content is null then
    raise exception 'There is no version % to restore', p_version using errcode = '22023';
  end if;

  select coalesce(array_agg(r.target_item_id), '{}') into old_refs
  from public.cms_references as r
  where r.source_kind = 'layout' and r.source_id = the_layout and r.source_version = p_version;

  return public.cms_add_layout_version(p_page_key, p_base_version, old_content, old_refs, p_version);
end;
$$;

-- Puts the items of one slot in a new order, as a new draft version of the layout. `p_item_ids` must be exactly the ids the
-- slot holds now, in any order (a reorder cannot add or drop an item).
create function cms_reorder_slot(p_page_key text, p_base_version integer, p_section_key text, p_slot_key text, p_item_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  the_layout uuid;
  newest integer;
  old_content jsonb;
  section_index integer;
  held jsonb;
  new_content jsonb;
  old_refs uuid[];
begin
  if not public.can_edit() then
    raise exception 'Only editors and owners can change content' using errcode = '42501';
  end if;
  if p_item_ids is null then
    raise exception 'The new order must be a list of ids' using errcode = '22023';
  end if;

  select l.id into the_layout from public.cms_layouts as l where l.page_key = p_page_key for update;
  if the_layout is null then
    raise exception 'There is no page layout "%"', p_page_key using errcode = 'CM001';
  end if;

  select max(v.version) into newest from public.cms_layout_versions as v where v.layout_id = the_layout;
  if newest is distinct from p_base_version then
    perform public.cms_raise_stale('layout', the_layout);
  end if;

  select v.content into old_content from public.cms_layout_versions as v where v.layout_id = the_layout and v.version = newest;

  select (s.ord - 1)::integer into section_index
  from jsonb_array_elements(old_content -> 'sections') with ordinality as s(value, ord)
  where s.value ->> 'key' = p_section_key;
  if section_index is null then
    raise exception 'There is no section "%"', p_section_key using errcode = '22023';
  end if;

  held := coalesce(old_content -> 'sections' -> section_index -> 'slots' -> p_slot_key, '[]'::jsonb);
  if jsonb_typeof(held) <> 'array'
     or (select coalesce(array_agg(h.value order by h.value), '{}') from jsonb_array_elements_text(held) as h)
        is distinct from (select coalesce(array_agg(u::text order by u::text), '{}') from unnest(p_item_ids) as u) then
    raise exception 'The new order must hold exactly the items the slot holds now' using errcode = '22023';
  end if;

  new_content := jsonb_set(old_content, array['sections', section_index::text, 'slots', p_slot_key], to_jsonb(p_item_ids), true);

  select coalesce(array_agg(r.target_item_id), '{}') into old_refs
  from public.cms_references as r
  where r.source_kind = 'layout' and r.source_id = the_layout and r.source_version = newest;

  return public.cms_add_layout_version(p_page_key, p_base_version, new_content, old_refs, null);
end;
$$;

-- Registers a file already uploaded to the images bucket. Registering the same path again returns the existing row.
create function cms_register_asset(p_path text, p_mime text, p_bytes integer, p_width integer, p_height integer, p_label text)
returns public.cms_assets
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.cms_assets;
  created public.cms_assets;
begin
  if not public.can_edit() then
    raise exception 'Only editors and owners can change content' using errcode = '42501';
  end if;

  if p_path is null or char_length(p_path) not between 1 and 500 or p_path ~ '^/' or p_path ~ '(^|/)\.\.(/|$)' then
    raise exception 'That file path is not allowed' using errcode = 'CM006';
  end if;
  if p_mime is null or p_mime not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception 'Only JPEG, PNG and WebP images are allowed' using errcode = 'CM006';
  end if;
  if p_bytes is null or p_bytes not between 1 and 5242880 then
    raise exception 'An image is 1 byte to 5 MB' using errcode = 'CM006';
  end if;
  if p_width is not null and p_width <= 0 or p_height is not null and p_height <= 0 then
    raise exception 'The width and height must be positive' using errcode = 'CM006';
  end if;
  if p_label is not null and char_length(p_label) > 200 then
    raise exception 'A label is at most 200 characters' using errcode = 'CM006';
  end if;

  if not exists (select 1 from storage.objects as o where o.bucket_id = 'site-images' and o.name = p_path) then
    raise exception 'There is no file "%" in the images bucket', p_path using errcode = 'CM006';
  end if;

  select * into existing from public.cms_assets as a where a.bucket = 'site-images' and a.path = p_path;
  if found then
    return existing;
  end if;

  insert into public.cms_assets (bucket, path, mime, bytes, width, height, label, created_by, created_by_email)
  values ('site-images', p_path, p_mime, p_bytes, p_width, p_height, p_label, (select auth.uid()), (select auth.jwt() ->> 'email'))
  returning * into created;

  insert into public.cms_change_log (user_id, user_email, action, subject_id, detail)
  values ((select auth.uid()), (select auth.jwt() ->> 'email'), 'register_asset', created.id, jsonb_build_object('path', p_path));
  return created;
end;
$$;

-- ======================================================================
-- Writes by owners only
-- ======================================================================

-- Deletes an item with its entries and versions and its own outgoing references, unless a reference that counts still
-- points at it (CM002, the usages as the detail; nothing is deleted).
create function cms_delete_item(p_item_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  the_item public.cms_items;
  usages jsonb;
begin
  if not public.is_owner() then
    raise exception 'Only owners can delete an item' using errcode = '42501';
  end if;

  select * into the_item from public.cms_items as i where i.id = p_item_id for update;
  if not found then
    raise exception 'There is no item %', p_item_id using errcode = 'CM001';
  end if;

  -- Same lock as the reference checks, so a save cannot add a reference while this runs.
  perform pg_advisory_xact_lock(7770001);

  select jsonb_agg(jsonb_build_object(
           'sourceKind', u.source_kind, 'sourceId', u.source_id, 'sourceLabel', u.source_label,
           'sourceLanguage', u.source_language, 'inPublished', u.in_published, 'inNewest', u.in_newest))
  into usages
  from public.cms_list_usages(p_item_id) as u;
  if usages is not null then
    raise exception 'This item is still used in % place(s): it was not deleted', jsonb_array_length(usages) using errcode = 'CM002', detail = usages::text;
  end if;

  perform set_config('cms.deleting', 'on', true);
  delete from public.cms_references as r
  where r.source_kind = 'item' and r.source_id in (select e.id from public.cms_item_entries as e where e.item_id = p_item_id);
  delete from public.cms_items as i where i.id = p_item_id;
  perform set_config('cms.deleting', 'off', true);

  insert into public.cms_change_log (user_id, user_email, action, subject_id, detail)
  values ((select auth.uid()), (select auth.jwt() ->> 'email'), 'delete_item', p_item_id,
          jsonb_build_object('typeKey', the_item.type_key, 'title', the_item.title));
end;
$$;

-- Creates or replaces a template (not versioned). `built_in` is never changed by a save.
create function cms_save_template(p_key text, p_name text, p_container_type_key text, p_slots jsonb)
returns public.cms_templates
language plpgsql
security definer
set search_path = ''
as $$
declare
  slot jsonb;
  slot_key text;
  seen text[] := '{}';
  allowed jsonb;
  allowed_key jsonb;
  saved public.cms_templates;
  min_n integer;
  max_n integer;
begin
  if not public.is_owner() then
    raise exception 'Only owners can save a template' using errcode = '42501';
  end if;

  if p_key is null or p_key !~ '^[a-z][a-z0-9-]*$' or char_length(p_key) > 64 then
    raise exception 'A template key is lowercase letters, digits and hyphens, starting with a letter' using errcode = '22023';
  end if;
  if p_name is null or char_length(p_name) not between 1 and 80 then
    raise exception 'A template name is 1 to 80 characters' using errcode = '22023';
  end if;
  if p_container_type_key is null or p_container_type_key !~ '^[a-z][a-z0-9-]*$' or char_length(p_container_type_key) > 64 then
    raise exception 'The container type key is lowercase letters, digits and hyphens, starting with a letter' using errcode = '22023';
  end if;
  if p_slots is null or jsonb_typeof(p_slots) <> 'array' or jsonb_array_length(p_slots) < 1 then
    raise exception 'A template needs at least one slot' using errcode = '22023';
  end if;

  for slot in select s.value from jsonb_array_elements(p_slots) as s loop
    if jsonb_typeof(slot) <> 'object' then
      raise exception 'A slot must be an object' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_object_keys(slot) as k where k not in ('key', 'label', 'allowedTypeKeys', 'min', 'max')) then
      raise exception 'A slot has only key, label, allowedTypeKeys, min and max' using errcode = '22023';
    end if;
    slot_key := slot ->> 'key';
    if jsonb_typeof(slot -> 'key') is distinct from 'string' or slot_key !~ '^[a-z][a-z0-9-]*$' or char_length(slot_key) > 64 then
      raise exception 'A slot key is lowercase letters, digits and hyphens, starting with a letter' using errcode = '22023';
    end if;
    if slot_key = any (seen) then
      raise exception 'Duplicate slot key "%"', slot_key using errcode = '22023';
    end if;
    seen := seen || slot_key;
    if jsonb_typeof(slot -> 'label') is distinct from 'string' or char_length(slot ->> 'label') not between 1 and 80 then
      raise exception 'A slot label is 1 to 80 characters' using errcode = '22023';
    end if;
    allowed := slot -> 'allowedTypeKeys';
    if jsonb_typeof(allowed) is distinct from 'array' or jsonb_array_length(allowed) < 1 then
      raise exception 'A slot allows at least one type' using errcode = '22023';
    end if;
    for allowed_key in select a.value from jsonb_array_elements(allowed) as a loop
      if jsonb_typeof(allowed_key) <> 'string' or (allowed_key #>> '{}') !~ '^[a-z][a-z0-9-]*$' then
        raise exception 'Allowed type keys are lowercase letters, digits and hyphens, starting with a letter' using errcode = '22023';
      end if;
    end loop;
    if slot ? 'min' and (jsonb_typeof(slot -> 'min') <> 'number' or (slot ->> 'min') !~ '^[0-9]+$') then
      raise exception 'A slot minimum is a whole number from 0' using errcode = '22023';
    end if;
    if slot ? 'max' and jsonb_typeof(slot -> 'max') <> 'null' and (jsonb_typeof(slot -> 'max') <> 'number' or (slot ->> 'max') !~ '^[1-9][0-9]*$') then
      raise exception 'A slot maximum is a whole number from 1, or null' using errcode = '22023';
    end if;
    min_n := coalesce((slot ->> 'min')::integer, 0);
    max_n := (slot ->> 'max')::integer;
    if min_n > 100 or max_n > 100 or min_n > coalesce(max_n, 100) then
      raise exception 'A slot holds at most 100 items and its minimum cannot be above its maximum' using errcode = '22023';
    end if;
  end loop;

  insert into public.cms_templates (key, name, container_type_key, slots)
  values (p_key, p_name, p_container_type_key, p_slots)
  on conflict (key) do update
    set name = excluded.name, container_type_key = excluded.container_type_key, slots = excluded.slots
  returning * into saved;

  insert into public.cms_change_log (user_id, user_email, action, detail)
  values ((select auth.uid()), (select auth.jwt() ->> 'email'), 'save_template', jsonb_build_object('key', p_key));
  return saved;
end;
$$;

-- ======================================================================
-- Grants
-- ======================================================================

revoke all on function cms_raise_stale(text, uuid) from public, anon, authenticated;
revoke all on function cms_counting_refs(uuid) from public, anon, authenticated;
revoke all on function cms_check_refs(text, uuid, uuid, uuid[]) from public, anon, authenticated;
revoke all on function cms_check_layout(jsonb, boolean) from public, anon, authenticated;
revoke all on function cms_add_item_version(uuid, text, integer, jsonb, uuid[], integer) from public, anon, authenticated;
revoke all on function cms_add_layout_version(text, integer, jsonb, uuid[], integer) from public, anon, authenticated;

revoke all on function cms_read_published(uuid, text) from public, anon, authenticated;
revoke all on function cms_resolve_items(uuid[], text, boolean) from public, anon, authenticated;
revoke all on function cms_read_layout(text, boolean) from public, anon, authenticated;
revoke all on function cms_list_templates() from public, anon, authenticated;
revoke all on function cms_read_newest(uuid, text) from public, anon, authenticated;
revoke all on function cms_list_versions(uuid, text) from public, anon, authenticated;
revoke all on function cms_list_items(text) from public, anon, authenticated;
revoke all on function cms_list_usages(uuid) from public, anon, authenticated;
revoke all on function cms_read_layout_newest(text) from public, anon, authenticated;
revoke all on function cms_list_layout_versions(text) from public, anon, authenticated;
revoke all on function cms_list_layouts() from public, anon, authenticated;
revoke all on function cms_create_item(text, text, boolean, boolean) from public, anon, authenticated;
revoke all on function cms_update_item(uuid, text, boolean) from public, anon, authenticated;
revoke all on function cms_save_item_draft(uuid, text, integer, jsonb, uuid[]) from public, anon, authenticated;
revoke all on function cms_publish_item(uuid, text, integer) from public, anon, authenticated;
revoke all on function cms_restore_item(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function cms_save_layout_draft(text, integer, jsonb, uuid[]) from public, anon, authenticated;
revoke all on function cms_publish_layout(text, integer) from public, anon, authenticated;
revoke all on function cms_restore_layout(text, integer, integer) from public, anon, authenticated;
revoke all on function cms_reorder_slot(text, integer, text, text, uuid[]) from public, anon, authenticated;
revoke all on function cms_register_asset(text, text, integer, integer, integer, text) from public, anon, authenticated;
revoke all on function cms_delete_item(uuid) from public, anon, authenticated;
revoke all on function cms_save_template(text, text, text, jsonb) from public, anon, authenticated;

-- Reads for everyone
grant execute on function cms_read_published(uuid, text) to anon, authenticated;
grant execute on function cms_resolve_items(uuid[], text, boolean) to anon, authenticated;
grant execute on function cms_read_layout(text, boolean) to anon, authenticated;
grant execute on function cms_list_templates() to anon, authenticated;

-- Reads and writes that need a signed-in session (the role is checked inside as a second guard)
grant execute on function cms_read_newest(uuid, text) to authenticated;
grant execute on function cms_list_versions(uuid, text) to authenticated;
grant execute on function cms_list_items(text) to authenticated;
grant execute on function cms_list_usages(uuid) to authenticated;
grant execute on function cms_read_layout_newest(text) to authenticated;
grant execute on function cms_list_layout_versions(text) to authenticated;
grant execute on function cms_list_layouts() to authenticated;
grant execute on function cms_create_item(text, text, boolean, boolean) to authenticated;
grant execute on function cms_update_item(uuid, text, boolean) to authenticated;
grant execute on function cms_save_item_draft(uuid, text, integer, jsonb, uuid[]) to authenticated;
grant execute on function cms_publish_item(uuid, text, integer) to authenticated;
grant execute on function cms_restore_item(uuid, text, integer, integer) to authenticated;
grant execute on function cms_save_layout_draft(text, integer, jsonb, uuid[]) to authenticated;
grant execute on function cms_publish_layout(text, integer) to authenticated;
grant execute on function cms_restore_layout(text, integer, integer) to authenticated;
grant execute on function cms_reorder_slot(text, integer, text, text, uuid[]) to authenticated;
grant execute on function cms_register_asset(text, text, integer, integer, integer, text) to authenticated;
grant execute on function cms_delete_item(uuid) to authenticated;
grant execute on function cms_save_template(text, text, text, jsonb) to authenticated;
