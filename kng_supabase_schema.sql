-- KNG Staff Portal: Supabase PostgreSQL schema
-- Run this once in Supabase Dashboard -> SQL Editor -> New query.
-- Uses Discord IDs as the identity key because the portal currently authenticates via Discord OAuth.

begin;

create extension if not exists pgcrypto;

-- 1) Teams --------------------------------------------------------------------
create table if not exists public.teams (
  id text primary key,
  name text not null,
  sort_order integer not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.teams (id, name, sort_order) values
  ('gangs', 'Gangs', 1),
  ('legal', 'Legal', 2),
  ('actions', 'Actions', 3),
  ('interactions', 'Interactions', 4),
  ('calls', 'Calls', 5),
  ('order', 'Order', 6),
  ('knowledge', 'Knowledge', 7),
  ('discord', 'Discord', 8),
  ('tickets', 'Tickets', 9),
  ('wallstreet', 'WallStreet', 10)
on conflict (id) do update
set name = excluded.name, sort_order = excluded.sort_order;

-- 2) Staff profiles -----------------------------------------------------------
-- A row is created/updated by the backend after successful Discord OAuth.
-- Never let a browser/client decide is_management.
create table if not exists public.staff_profiles (
  discord_id text primary key
    check (discord_id ~ '^[0-9]{17,20}$'),
  username text not null,
  display_name text not null,
  avatar_hash text,
  is_management boolean not null default false,
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3) Team-specific permissions -----------------------------------------------
-- A staff member can hold ADM permission for multiple teams.
-- Management is global and is stored on staff_profiles.is_management.
create table if not exists public.team_permissions (
  team_id text not null references public.teams(id) on update cascade on delete cascade,
  staff_discord_id text not null references public.staff_profiles(discord_id) on update cascade on delete cascade,
  permission_role text not null default 'ADM'
    check (permission_role in ('ADM')),
  granted_by text references public.staff_profiles(discord_id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (team_id, staff_discord_id)
);

create index if not exists idx_team_permissions_staff
  on public.team_permissions (staff_discord_id);

-- 4) Team rosters -------------------------------------------------------------
-- One Discord account can have one rank per team, but can appear in multiple teams.
create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id text not null references public.teams(id) on update cascade on delete cascade,
  discord_id text not null check (discord_id ~ '^[0-9]{17,20}$'),
  username text not null default '',
  display_name text not null default '',
  rank text not null
    check (rank in ('ADM', 'AUX', 'LEAD', 'SUB-LEAD', 'MEMBERS', 'HELPERS')),
  sort_order integer not null default 0,
  added_by text references public.staff_profiles(discord_id) on delete set null,
  updated_by text references public.staff_profiles(discord_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, discord_id)
);

create index if not exists idx_team_members_team_rank
  on public.team_members (team_id, rank, sort_order, display_name);

create index if not exists idx_team_members_discord
  on public.team_members (discord_id);

-- 5) Organisation chart -------------------------------------------------------
-- parent_id creates the reporting-line tree. The backend must reject cycles.
create table if not exists public.organisation_chart (
  id text primary key,
  role text not null,
  name text not null default '',
  parent_id text references public.organisation_chart(id)
    on update cascade on delete set null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Seed the current KNG chart structure. Names are intentionally blank.
insert into public.organisation_chart (id, role, name, parent_id, sort_order) values
  ('gm', 'General Manager', '', null, 1),
  ('community', 'Community Director', '', 'gm', 2),
  ('orgs', 'Orgs Director', '', 'gm', 3),
  ('wallstreet', 'WallStreet Director', '', 'gm', 4),
  ('admin-manager', 'Administration Manager', '', 'community', 5),
  ('culture-manager', 'Culture Manager', '', 'community', 6),
  ('gangs-manager', 'Manager Of Gangs', '', 'orgs', 7),
  ('legal-manager', 'Manager Of Legal', '', 'orgs', 8),
  ('wolf', 'Wolf of WallStreet', '', 'wallstreet', 9),
  ('tickets-resp', 'Tickets Responsible', '', 'admin-manager', 10),
  ('admin-resp', 'Administration Responsible', '', 'admin-manager', 11),
  ('entertainment', 'Entertainment Responsible', '', 'culture-manager', 12),
  ('moderation', 'Moderation Responsible', '', 'culture-manager', 13),
  ('influencer-resp', 'Influencer Responsible', '', 'culture-manager', 14),
  ('gang-adms', 'Gangs ADMs', '', 'gangs-manager', 15),
  ('legal-adm', 'Legal ADM', '', 'legal-manager', 16),
  ('ws-resp', 'WallStreet Responsible', '', 'wolf', 17),
  ('tickets-team', 'Tickets Team ADM', '', 'tickets-resp', 18),
  ('knowledge', 'Knowledge ADM', '', 'admin-resp', 19),
  ('discord', 'Discord ADM', '', 'admin-resp', 20),
  ('action', 'Action ADM', '', 'entertainment', 21),
  ('interactions', 'Interactions ADM', '', 'entertainment', 22),
  ('calls', 'Calls ADM', '', 'moderation', 23),
  ('order', 'Order ADM', '', 'moderation', 24),
  ('influencer-team', 'Influencer Team', '', 'influencer-resp', 25),
  ('ws-a', 'WS_CriminalA ADM', '', 'ws-resp', 26),
  ('ws-b', 'WS_CriminalB ADM', '', 'ws-resp', 27)
on conflict (id) do update
set role = excluded.role,
    parent_id = excluded.parent_id,
    sort_order = excluded.sort_order;

-- 6) Portal settings ----------------------------------------------------------
-- Optional key/value storage for portal-wide editable settings.
create table if not exists public.portal_settings (
  setting_key text primary key,
  setting_value jsonb not null default '{}'::jsonb,
  updated_by text references public.staff_profiles(discord_id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.portal_settings (setting_key, setting_value) values
  ('organisation_chart', '{"title":"KNG ESTATE","subtitle":"Organisation structure"}'::jsonb)
on conflict (setting_key) do nothing;

-- 7) Audit log ----------------------------------------------------------------
-- Append-only by convention. Backend writes one row for permission/roster/chart changes.
create table if not exists public.permission_audit_log (
  id bigint generated always as identity primary key,
  actor_discord_id text references public.staff_profiles(discord_id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_created_at
  on public.permission_audit_log (created_at desc);

create index if not exists idx_audit_actor
  on public.permission_audit_log (actor_discord_id, created_at desc);

-- 8) updated_at triggers ------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_staff_profiles_updated_at on public.staff_profiles;
create trigger trg_staff_profiles_updated_at
before update on public.staff_profiles
for each row execute function public.set_updated_at();

drop trigger if exists trg_team_members_updated_at on public.team_members;
create trigger trg_team_members_updated_at
before update on public.team_members
for each row execute function public.set_updated_at();

drop trigger if exists trg_organisation_chart_updated_at on public.organisation_chart;
create trigger trg_organisation_chart_updated_at
before update on public.organisation_chart
for each row execute function public.set_updated_at();

drop trigger if exists trg_portal_settings_updated_at on public.portal_settings;
create trigger trg_portal_settings_updated_at
before update on public.portal_settings
for each row execute function public.set_updated_at();

-- 9) Atomic roster replacement -----------------------------------------------
-- Call this from the Node backend with supabase.rpc('replace_team_roster', ...).
-- This prevents a half-saved roster if an insert fails after old rows are removed.
create or replace function public.replace_team_roster(
  p_team_id text,
  p_members jsonb,
  p_actor text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  member_count integer;
begin
  if not exists (select 1 from public.teams where id = p_team_id and is_active = true) then
    raise exception 'Unknown or inactive team';
  end if;

  if jsonb_typeof(p_members) <> 'array' then
    raise exception 'Roster members must be a JSON array';
  end if;

  member_count := jsonb_array_length(p_members);
  if member_count > 1200 then
    raise exception 'Roster is too large';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_members) as x(
      discord_id text, username text, display_name text, rank text, sort_order integer
    )
    where x.discord_id is null
       or x.discord_id !~ '^[0-9]{17,20}$'
       or x.rank not in ('ADM', 'AUX', 'LEAD', 'SUB-LEAD', 'MEMBERS', 'HELPERS')
  ) then
    raise exception 'Roster contains an invalid Discord ID or rank';
  end if;

  if (
    select count(*) <> count(distinct x.discord_id)
    from jsonb_to_recordset(p_members) as x(
      discord_id text, username text, display_name text, rank text, sort_order integer
    )
  ) then
    raise exception 'A Discord account can only appear once in a team roster';
  end if;

  delete from public.team_members where team_id = p_team_id;

  insert into public.team_members (
    team_id, discord_id, username, display_name, rank, sort_order, added_by, updated_by
  )
  select
    p_team_id,
    x.discord_id,
    left(coalesce(x.username, ''), 80),
    left(coalesce(nullif(x.display_name, ''), x.username, x.discord_id), 80),
    x.rank,
    coalesce(x.sort_order, 0),
    p_actor,
    p_actor
  from jsonb_to_recordset(p_members) as x(
    discord_id text, username text, display_name text, rank text, sort_order integer
  );
end;
$$;

-- This function is intended for the trusted Node backend only.
revoke all on function public.replace_team_roster(text, jsonb, text) from public;
revoke all on function public.replace_team_roster(text, jsonb, text) from anon, authenticated;
grant execute on function public.replace_team_roster(text, jsonb, text) to service_role;

-- Atomically replace all ADM team assignments for one staff member.
create or replace function public.replace_team_permissions(
  p_staff_discord_id text,
  p_team_ids text[],
  p_actor text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_staff_discord_id !~ '^[0-9]{17,20}$' then
    raise exception 'Invalid Discord user ID';
  end if;

  if cardinality(coalesce(p_team_ids, array[]::text[])) > 0
     and not exists (select 1 from public.staff_profiles where discord_id = p_staff_discord_id) then
    raise exception 'Staff profile must exist before permissions can be granted';
  end if;

  if exists (
    select 1 from unnest(coalesce(p_team_ids, array[]::text[])) as requested(team_id)
    where not exists (select 1 from public.teams t where t.id = requested.team_id and t.is_active)
  ) then
    raise exception 'Unknown or inactive team in permission list';
  end if;

  delete from public.team_permissions
  where staff_discord_id = p_staff_discord_id;

  insert into public.team_permissions(team_id, staff_discord_id, permission_role, granted_by)
  select distinct requested.team_id, p_staff_discord_id, 'ADM', p_actor
  from unnest(coalesce(p_team_ids, array[]::text[])) as requested(team_id);
end;
$$;

revoke all on function public.replace_team_permissions(text, text[], text) from public;
revoke all on function public.replace_team_permissions(text, text[], text) from anon, authenticated;
grant execute on function public.replace_team_permissions(text, text[], text) to service_role;

-- Atomically replace the organisation chart after the Node backend validates its tree.
create or replace function public.replace_organisation_chart(
  p_nodes jsonb,
  p_actor text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if jsonb_typeof(p_nodes) <> 'array' or jsonb_array_length(p_nodes) > 500 then
    raise exception 'Invalid organisation chart payload';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_nodes) as n(id text, role text, name text, parent_id text, sort_order integer)
    where coalesce(n.id, '') = '' or coalesce(n.role, '') = ''
  ) then
    raise exception 'Every organisation position requires an ID and role';
  end if;

  delete from public.organisation_chart;

  insert into public.organisation_chart(id, role, name, parent_id, sort_order)
  select n.id, n.role, coalesce(n.name, ''), n.parent_id, coalesce(n.sort_order, 0)
  from jsonb_to_recordset(p_nodes) as n(
    id text, role text, name text, parent_id text, sort_order integer
  );
end;
$$;

revoke all on function public.replace_organisation_chart(jsonb, text) from public;
revoke all on function public.replace_organisation_chart(jsonb, text) from anon, authenticated;
grant execute on function public.replace_organisation_chart(jsonb, text) to service_role;

-- 10) Row Level Security ------------------------------------------------------
-- The current site uses its own signed Discord OAuth session, not Supabase Auth.
-- Therefore, do NOT add permissive anon/authenticated policies here.
-- The Node backend uses the Supabase SERVICE ROLE key, which bypasses RLS, and
-- must enforce requireLogin / requireManagement / team-specific ADM checks.
-- This prevents browser-side access with the anon key.
alter table public.teams enable row level security;
alter table public.staff_profiles enable row level security;
alter table public.team_permissions enable row level security;
alter table public.team_members enable row level security;
alter table public.organisation_chart enable row level security;
alter table public.portal_settings enable row level security;
alter table public.permission_audit_log enable row level security;

commit;

-- Quick verification after running:
-- select id, name, sort_order from public.teams order by sort_order;
-- select id, role, parent_id from public.organisation_chart order by sort_order;
