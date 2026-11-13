-- The standard permission model, as a file that can be applied to any database, again and again. One membership table with a
-- role per member (owner, editor, member) and three helper functions the content rules ask:
--
--   owner   manages members and edits content
--   editor  edits content
--   member  reads what members read; has no rights over content
--
-- Idempotent: a database that already has these (made by an earlier migration with the same text) is left as it is, and a
-- database that has none gets them. Nothing here copies members across; filling `site_members` is a site's own step.

create table if not exists site_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'editor', 'member')),
  created_at timestamptz not null default now()
);

-- No policies: nobody can read or change this table through the API. Only the helpers below look inside.
alter table site_members enable row level security;
revoke all on site_members from anon, authenticated;

-- True for any member, whatever the role.
create or replace function is_plan_member() returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.site_members where user_id = (select auth.uid())
  );
$$;

-- True for owners and editors: the people who may change content.
create or replace function can_edit() returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.site_members
    where user_id = (select auth.uid()) and role in ('owner', 'editor')
  );
$$;

-- True for owners only: the people who may manage members.
create or replace function is_owner() returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.site_members
    where user_id = (select auth.uid()) and role = 'owner'
  );
$$;

revoke all on function is_plan_member() from public;
revoke all on function can_edit() from public;
revoke all on function is_owner() from public;
grant execute on function is_plan_member() to anon, authenticated;
grant execute on function can_edit() to anon, authenticated;
grant execute on function is_owner() to anon, authenticated;
