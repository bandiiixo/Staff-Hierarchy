-- KNG ROLE / ACCESS PATCH
-- Run this AFTER the existing KNG entertainment migration.
-- Adds AUX as a real site permission level and lets management issue access safely.

begin;

-- =========================================================
-- PERMISSION HIERARCHY
-- public 0
-- member 1
-- aux 2  (same site capability rank as ADM)
-- adm  2  (same site capability rank as AUX)
-- manager 3
-- director 4
-- =========================================================

alter table public.staff_access
  drop constraint if exists staff_access_access_level_check;

update public.staff_access
set access_level = 'member'
where access_level is null
   or access_level not in ('member','aux','adm','manager','director');

alter table public.staff_access
  add constraint staff_access_access_level_check
  check (access_level in ('member','aux','adm','manager','director'));

create or replace function public.kng_schedule_access_rank()
returns integer
language sql stable security definer
set search_path = public
as $$
  select case coalesce((select sa.access_level
                         from public.staff_access sa
                         where sa.user_id = auth.uid()
                           and sa.active = true
                         limit 1), 'public')
    when 'public' then 0
    when 'member' then 1
    when 'aux' then 2
    when 'adm' then 2
    when 'manager' then 3
    when 'director' then 4
    when 'admin' then 4
    when 'entertainment' then 2
    else 0
  end;
$$;

create or replace function public.kng_schedule_can_manage()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.kng_schedule_access_rank() >= 2;
$$;

create or replace function public.kng_schedule_is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.kng_schedule_access_rank() >= 3;
$$;

create or replace function public.kng_schedule_is_director()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.kng_schedule_access_rank() >= 4;
$$;

-- =========================================================
-- REQUESTING THE NEXT LEVEL
-- =========================================================

create or replace function public.request_staff_access(p_requested_access_level text default 'member')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  identity_row record;
  staff_row record;
  request_id uuid;
  discord_name text;
  current_rank integer;
  requested_rank integer;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  p_requested_access_level := lower(coalesce(trim(p_requested_access_level),'member'));

  if p_requested_access_level not in ('member','aux','adm','manager') then
    raise exception 'That access level must be assigned by management.';
  end if;

  current_rank := public.kng_schedule_access_rank();
  requested_rank := case p_requested_access_level
    when 'member' then 1
    when 'aux' then 2
    when 'adm' then 2
    when 'manager' then 3
    else 99
  end;

  if requested_rank <= current_rank then
    raise exception 'You already have that level or higher.';
  end if;

  -- AUX and ADM are the same permission tier, so a member requests AUX first.
  if current_rank = 0 and p_requested_access_level <> 'member' then
    raise exception 'Access must be granted in order: Member, AUX/ADM, then Management.';
  end if;

  if current_rank = 1 and p_requested_access_level not in ('aux','adm') then
    raise exception 'Members can request AUX or ADM access.';
  end if;

  if current_rank = 2 and p_requested_access_level <> 'manager' then
    raise exception 'AUX/ADM staff can request Management access.';
  end if;

  select i.provider_id, i.identity_data
    into identity_row
  from auth.identities i
  where i.user_id = auth.uid()
    and i.provider = 'discord'
  order by i.created_at desc
  limit 1;

  if identity_row.provider_id is null then
    raise exception 'Discord sign-in is required for staff access.';
  end if;

  discord_name := coalesce(
    identity_row.identity_data->>'global_name',
    identity_row.identity_data->>'username',
    'Discord user'
  );

  select s.id, s.name
    into staff_row
  from public.staff s
  where s.discord_id = identity_row.provider_id
    and s.active = true
  limit 1;

  insert into public.staff_access_requests(
    user_id, discord_id, discord_username, requested_name,
    status, requested_access_level
  )
  values(
    auth.uid(), identity_row.provider_id, discord_name,
    coalesce(staff_row.name, discord_name), 'pending', p_requested_access_level
  )
  returning id into request_id;

  return request_id;
exception when unique_violation then
  select id
    into request_id
  from public.staff_access_requests
  where user_id = auth.uid()
    and status = 'pending'
  order by created_at desc
  limit 1;
  return request_id;
end;
$$;

-- =========================================================
-- APPROVE REQUESTS
-- =========================================================

create or replace function public.approve_staff_access_request(
  p_request_id uuid,
  p_access_level text default 'adm'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  req record;
  updated_count integer;
  target_rank integer;
  caller_rank integer;
  staff_row record;
  staff_name text;
begin
  caller_rank := public.kng_schedule_access_rank();

  if caller_rank < 2 then
    raise exception 'You do not have permission to approve staff access.';
  end if;

  p_access_level := lower(trim(p_access_level));

  if p_access_level not in ('member','aux','adm','manager') then
    raise exception 'Invalid approval level.';
  end if;

  target_rank := case p_access_level
    when 'member' then 1
    when 'aux' then 2
    when 'adm' then 2
    when 'manager' then 3
    else 99
  end;

  if caller_rank <= target_rank then
    raise exception 'You can only grant access below your own level.';
  end if;

  select * into req
  from public.staff_access_requests
  where id = p_request_id
  for update;

  if req.id is null then
    raise exception 'Access request not found.';
  end if;

  if req.status <> 'pending' then
    raise exception 'This request has already been decided.';
  end if;

  if coalesce(req.requested_access_level,'member') <> p_access_level then
    raise exception 'Approval level does not match the request.';
  end if;

  staff_name := coalesce(
    nullif(trim(req.requested_name), ''),
    nullif(trim(req.discord_username), ''),
    'Discord user'
  );

  select * into staff_row
  from public.staff
  where discord_id = req.discord_id
  order by active desc, created_at asc
  limit 1;

  if staff_row.id is null then
    insert into public.staff(name, discord_id, active)
    values(staff_name, req.discord_id, true)
    returning * into staff_row;
  else
    update public.staff
    set name = case
      when nullif(trim(staff_row.name), '') is null
        or lower(trim(staff_row.name)) = 'discord user'
      then staff_name
      else staff_row.name
    end,
    active = true
    where id = staff_row.id;
  end if;

  update public.staff_access
  set access_level = p_access_level,
      active = true,
      updated_at = now()
  where user_id = req.user_id;
  get diagnostics updated_count = row_count;

  if updated_count = 0 then
    insert into public.staff_access(user_id, access_level, active)
    values(req.user_id, p_access_level, true);
  end if;

  update public.staff_access_requests
  set status = 'approved',
      review_note = 'Access confirmed by staff.',
      reviewed_by = auth.uid(),
      reviewed_at = now()
  where id = p_request_id;

  return true;
end;
$$;

-- =========================================================
-- DIRECT MANAGEMENT OF AN EXISTING ROSTER MEMBER
-- =========================================================

create or replace function public.get_entertainment_staff_access(p_roster_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  roster_row record;
  target_user_id uuid;
  result_level text;
begin
  if public.kng_schedule_access_rank() < 2 then
    raise exception 'Management access required.';
  end if;

  select er.id, s.discord_id
    into roster_row
  from public.entertainment_roster er
  join public.staff s on s.id = er.staff_id
  where er.id = p_roster_id
    and er.active = true;

  if roster_row.id is null then
    raise exception 'Roster member not found.';
  end if;

  select i.user_id into target_user_id
  from auth.identities i
  where i.provider = 'discord'
    and i.provider_id = roster_row.discord_id
  order by i.created_at desc
  limit 1;

  if target_user_id is null then
    return 'member';
  end if;

  select sa.access_level into result_level
  from public.staff_access sa
  where sa.user_id = target_user_id
    and sa.active = true
  limit 1;

  return coalesce(result_level, 'member');
end;
$$;

grant execute on function public.get_entertainment_staff_access(uuid) to authenticated;

create or replace function public.set_entertainment_staff_access(
  p_roster_id uuid,
  p_access_level text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  roster_row record;
  target_user_id uuid;
  target_rank integer;
  caller_rank integer;
begin
  caller_rank := public.kng_schedule_access_rank();
  if caller_rank < 2 then
    raise exception 'Management access required.';
  end if;

  p_access_level := lower(trim(p_access_level));
  if p_access_level not in ('member','aux','adm','manager') then
    raise exception 'Invalid access level.';
  end if;

  target_rank := case p_access_level
    when 'member' then 1
    when 'aux' then 2
    when 'adm' then 2
    when 'manager' then 3
    else 99
  end;

  if caller_rank <= target_rank then
    raise exception 'You can only grant access below your own level.';
  end if;

  select er.id, s.discord_id
    into roster_row
  from public.entertainment_roster er
  join public.staff s on s.id = er.staff_id
  where er.id = p_roster_id
    and er.active = true;

  if roster_row.id is null then
    raise exception 'Roster member not found.';
  end if;

  select i.user_id into target_user_id
  from auth.identities i
  where i.provider = 'discord'
    and i.provider_id = roster_row.discord_id
  order by i.created_at desc
  limit 1;

  if target_user_id is null then
    raise exception 'That roster member has not linked a Discord login to this site yet.';
  end if;

  update public.staff_access
  set access_level = p_access_level,
      active = true,
      updated_at = now()
  where user_id = target_user_id;

  if not found then
    insert into public.staff_access(user_id, access_level, active)
    values(target_user_id, p_access_level, true);
  end if;

  return true;
end;
$$;

grant execute on function public.set_entertainment_staff_access(uuid,text) to authenticated;

-- Keep roster hierarchy and site access synchronized whenever a roster member is changed.
create or replace function public.sync_entertainment_roster_access()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  discord text;
  target_user uuid;
  mapped_level text;
begin
  select coalesce(nullif(trim(new.discord_id),''), s.discord_id) into discord
  from public.staff s where s.id = new.staff_id;
  if discord is null then return new; end if;
  select i.user_id into target_user
  from auth.identities i
  where i.provider='discord' and i.provider_id=discord
  order by i.created_at desc limit 1;
  if target_user is null then return new; end if;
  mapped_level := case
    when new.active=false then 'member'
    when new.hierarchy_level='director' then 'director'
    when new.hierarchy_level='manager' then 'manager'
    when new.hierarchy_level='adm' then 'adm'
    when new.hierarchy_level='aux' then 'aux'
    else 'member'
  end;
  insert into public.staff_access(user_id,access_level,active)
  values(target_user,mapped_level,true)
  on conflict(user_id) do update set access_level=excluded.access_level, active=true, updated_at=now();
  return new;
end;
$$;

drop trigger if exists entertainment_roster_access_sync on public.entertainment_roster;
create trigger entertainment_roster_access_sync
after insert or update of hierarchy_level, discord_id, active, staff_id
on public.entertainment_roster
for each row execute function public.sync_entertainment_roster_access();

-- =========================================================
-- EXISTING ROSTER -> SITE ACCESS SYNC
-- Gives existing AUX/ADM/Manager roster members the matching site access.
-- LD/Sub-LD/Member remain Member site access.
-- =========================================================

insert into public.staff_access(user_id, access_level, active)
select distinct on (i.user_id)
  i.user_id,
  case er.hierarchy_level
    when 'director' then 'director'
    when 'manager' then 'manager'
    when 'adm' then 'adm'
    when 'aux' then 'aux'
    else 'member'
  end,
  true
from public.entertainment_roster er
join public.staff s on s.id = er.staff_id
join auth.identities i on i.provider = 'discord' and i.provider_id = s.discord_id
where er.active = true
order by i.user_id, er.updated_at desc
on conflict (user_id) do update
set access_level = excluded.access_level,
    active = true,
    updated_at = now();

notify pgrst, 'reload schema';
commit;

-- =========================================================
-- HARDEN ROSTER PROMOTIONS
-- Prevent a Manager from promoting someone to Manager/Director,
-- and keep the roster hierarchy below the actor's permission level.
-- =========================================================

create or replace function public.update_entertainment_roster_member(
  p_roster_id uuid,
  p_name text,
  p_discord_id text,
  p_team text,
  p_hierarchy_level text,
  p_kng_id text,
  p_strikes integer,
  p_mentor boolean,
  p_notes text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  caller_rank integer;
  target_rank integer;
begin
  caller_rank := public.kng_schedule_access_rank();
  if caller_rank < 2 then
    raise exception 'You do not have permission to edit the entertainment roster.';
  end if;

  if p_team not in ('actions','interactions') then
    raise exception 'Invalid team.';
  end if;

  if p_hierarchy_level not in ('director','manager','adm','aux','ld','sub_ld','member') then
    raise exception 'Invalid hierarchy level.';
  end if;

  target_rank := case p_hierarchy_level
    when 'director' then 4
    when 'manager' then 3
    when 'adm' then 2
    when 'aux' then 2
    when 'ld' then 1
    when 'sub_ld' then 1
    when 'member' then 1
    else 99
  end;

  if target_rank >= caller_rank then
    raise exception 'You can only assign roster levels below your own access level.';
  end if;

  if coalesce(p_strikes,0) < 0 or coalesce(p_strikes,0) > 3 then
    raise exception 'Strikes must be between 0 and 3.';
  end if;

  select * into r
  from public.entertainment_roster
  where id = p_roster_id
  for update;

  if r.id is null then
    raise exception 'Roster member not found.';
  end if;

  update public.staff
  set name = coalesce(nullif(trim(p_name),''),name),
      discord_id = nullif(trim(p_discord_id),''),
      active = true
  where id = r.staff_id;

  update public.entertainment_roster
  set display_name = coalesce(nullif(trim(p_name),''),display_name),
      discord_id = nullif(trim(p_discord_id),''),
      team = p_team,
      hierarchy_level = p_hierarchy_level,
      kng_id = nullif(trim(p_kng_id),''),
      strikes = coalesce(p_strikes,0),
      mentor = coalesce(p_mentor,false),
      notes = nullif(trim(p_notes),''),
      active = true,
      updated_by = auth.uid(),
      updated_at = now()
  where id = p_roster_id;

  return true;
end;
$$;

grant execute on function public.update_entertainment_roster_member(uuid,text,text,text,text,text,integer,boolean,text) to authenticated;

notify pgrst, 'reload schema';
