-- KNG SECURITY / DIRECTOR PERMISSIONS PATCH
-- Run once after the existing KNG role/access patches.
-- Safe to re-run.

begin;

-- ---------------------------------------------------------
-- 1. Permission hierarchy
-- public 0
-- member 1
-- aux 2
-- adm 3
-- entertainment_resp / culture_manager / manager 4
-- director 5
-- ---------------------------------------------------------

alter table public.staff_access
  drop constraint if exists staff_access_access_level_check;

update public.staff_access set access_level = 'director' where access_level = 'admin';
update public.staff_access set access_level = 'adm' where access_level = 'entertainment';
update public.staff_access
set access_level = 'member'
where access_level is null
   or access_level not in ('member','aux','adm','entertainment_resp','culture_manager','manager','director');

alter table public.staff_access
  add constraint staff_access_access_level_check
  check (access_level in ('member','aux','adm','entertainment_resp','culture_manager','manager','director'));


-- Lock direct staff_access writes behind the security-definer RPCs.
alter table public.staff_access enable row level security;
drop policy if exists staff_access_self_read on public.staff_access;
drop policy if exists staff_access_management_read on public.staff_access;
create policy staff_access_self_read on public.staff_access for select to authenticated using (user_id = auth.uid());
create policy staff_access_management_read on public.staff_access for select to authenticated using (public.kng_schedule_access_rank() >= 4);

create or replace function public.kng_schedule_access_rank()
returns integer
language sql stable security definer
set search_path = public
as $$
  select case coalesce((
    select sa.access_level
    from public.staff_access sa
    where sa.user_id = auth.uid()
      and sa.active = true
    limit 1
  ), 'public')
    when 'public' then 0
    when 'member' then 1
    when 'aux' then 2
    when 'adm' then 3
    when 'entertainment_resp' then 4
    when 'culture_manager' then 4
    when 'manager' then 4
    when 'director' then 5
    else 0
  end;
$$;

create or replace function public.kng_schedule_can_manage()
returns boolean
language sql stable security definer
set search_path = public
as $$ select public.kng_schedule_access_rank() >= 3; $$;

create or replace function public.kng_schedule_is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$ select public.kng_schedule_access_rank() >= 4; $$;

create or replace function public.kng_schedule_is_director()
returns boolean
language sql stable security definer
set search_path = public
as $$ select public.kng_schedule_access_rank() >= 5; $$;

-- ---------------------------------------------------------
-- 2. Access requests are a Director approval queue.
-- Members can request AUX, AUX can request ADM, ADM can request
-- Management. Directors approve the request.
-- ---------------------------------------------------------

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
  current_level text;
  current_rank integer;
  requested_rank integer;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;

  p_requested_access_level := lower(trim(coalesce(p_requested_access_level,'member')));
  if p_requested_access_level not in ('member','aux','adm','manager') then
    raise exception 'That access level must be assigned by staff.';
  end if;

  select coalesce(sa.access_level,'public') into current_level
  from public.staff_access sa
  where sa.user_id = auth.uid() and sa.active = true
  limit 1;

  current_rank := public.kng_schedule_access_rank();
  requested_rank := case p_requested_access_level
    when 'member' then 1
    when 'aux' then 2
    when 'adm' then 3
    when 'manager' then 4
    else 99
  end;

  if requested_rank <= current_rank then
    raise exception 'You already have that level or higher.';
  end if;

  if current_level = 'public' and p_requested_access_level <> 'member' then
    raise exception 'Access must begin with Member.';
  end if;
  if current_level = 'member' and p_requested_access_level <> 'aux' then
    raise exception 'Members can request AUX access next.';
  end if;
  if current_level = 'aux' and p_requested_access_level <> 'adm' then
    raise exception 'AUX staff can request ADM access next.';
  end if;
  if current_level = 'adm' and p_requested_access_level <> 'manager' then
    raise exception 'ADM staff can request Management access next.';
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

  select s.id, s.name into staff_row
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
  select id into request_id
  from public.staff_access_requests
  where user_id = auth.uid() and status = 'pending'
  order by created_at desc
  limit 1;
  return request_id;
end;
$$;

grant execute on function public.request_staff_access(text) to authenticated;

create or replace function public.approve_staff_access_request(
  p_request_id uuid,
  p_access_level text default 'member'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  req record;
  target_rank integer;
  staff_row record;
  staff_name text;
begin
  if not public.kng_schedule_is_director() then
    raise exception 'Only a Director can approve staff access requests.';
  end if;

  p_access_level := lower(trim(p_access_level));
  if p_access_level not in ('member','aux','adm','manager') then
    raise exception 'Invalid approval level.';
  end if;

  select * into req
  from public.staff_access_requests
  where id = p_request_id
  for update;

  if req.id is null then raise exception 'Access request not found.'; end if;
  if req.status <> 'pending' then raise exception 'This request has already been decided.'; end if;
  if coalesce(req.requested_access_level,'member') <> p_access_level then
    raise exception 'Approval level does not match the request.';
  end if;

  staff_name := coalesce(nullif(trim(req.requested_name),''), nullif(trim(req.discord_username),''), 'Discord user');

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
      when nullif(trim(staff_row.name),'') is null or lower(trim(staff_row.name)) = 'discord user'
      then staff_name else staff_row.name end,
      active = true
    where id = staff_row.id;
  end if;

  update public.staff_access
  set access_level = p_access_level, active = true, updated_at = now()
  where user_id = req.user_id;

  if not found then
    insert into public.staff_access(user_id, access_level, active)
    values(req.user_id, p_access_level, true);
  end if;

  update public.staff_access_requests
  set status='approved', review_note='Access approved by Director.', reviewed_by=auth.uid(), reviewed_at=now()
  where id=p_request_id;

  return true;
end;
$$;

grant execute on function public.approve_staff_access_request(uuid,text) to authenticated;

create or replace function public.reject_staff_access_request(
  p_request_id uuid,
  p_reason text default 'Access not approved'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  req record;
  current_level text;
  previous_level text;
begin
  if not public.kng_schedule_is_director() then
    raise exception 'Only a Director can reject staff access requests.';
  end if;

  select * into req
  from public.staff_access_requests
  where id=p_request_id and status='pending'
  for update;

  if req.id is null then
    raise exception 'Access request not found or already decided.';
  end if;

  -- A rejected request must never leave the requester with the access
  -- level they were asking for. If they somehow received that exact level
  -- while the request was pending, roll them back to their previous level.
  -- A higher independently-granted level is left untouched.
  select sa.access_level
    into current_level
  from public.staff_access sa
  where sa.user_id=req.user_id and sa.active=true
  limit 1;

  previous_level := case lower(coalesce(req.requested_access_level,'member'))
    when 'aux' then 'member'
    when 'adm' then 'aux'
    when 'manager' then 'adm'
    else 'public'
  end;

  if current_level = lower(coalesce(req.requested_access_level,'member')) then
    if previous_level = 'public' then
      update public.staff_access
      set active=false, updated_at=now()
      where user_id=req.user_id;
    else
      update public.staff_access
      set access_level=previous_level, active=true, updated_at=now()
      where user_id=req.user_id;
    end if;
  end if;

  update public.staff_access_requests
  set status='rejected',
      review_note=coalesce(nullif(trim(p_reason),''),'Access not approved'),
      reviewed_by=auth.uid(),
      reviewed_at=now()
  where id=p_request_id;

  return true;
end;
$$;

grant execute on function public.reject_staff_access_request(uuid,text) to authenticated;

-- ---------------------------------------------------------
-- 3. Direct grants: ADM -> AUX, Management -> ADM,
-- Director -> any non-Director level. No self-promotion.
-- ---------------------------------------------------------

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
  if caller_rank < 3 then raise exception 'ADM access or higher is required.'; end if;

  p_access_level := lower(trim(p_access_level));
  if p_access_level not in ('member','aux','adm','entertainment_resp','manager','culture_manager','director') then
    raise exception 'Invalid access level.';
  end if;

  target_rank := case p_access_level
    when 'member' then 1
    when 'aux' then 2
    when 'adm' then 3
    when 'entertainment_resp' then 4
    when 'manager' then 4
    when 'culture_manager' then 4
    when 'director' then 5
    else 99
  end;

  if target_rank > caller_rank or (target_rank = caller_rank and caller_rank < 5) then
    raise exception 'Security chain: ADM grants AUX, Management grants ADM, Director grants any level.';
  end if;

  select er.id, s.discord_id, s.id as staff_id
    into roster_row
  from public.entertainment_roster er
  join public.staff s on s.id=er.staff_id
  where er.id=p_roster_id and er.active=true;

  if roster_row.id is null then raise exception 'Roster member not found.'; end if;

  select i.user_id into target_user_id
  from auth.identities i
  where i.provider='discord' and i.provider_id=roster_row.discord_id
  order by i.created_at desc limit 1;

  if target_user_id is null then raise exception 'That roster member has not linked a Discord login to this site yet.'; end if;
  if target_user_id = auth.uid() then raise exception 'You cannot change your own access.'; end if;

  update public.staff_access
  set access_level=p_access_level, active=true, updated_at=now()
  where user_id=target_user_id;

  if not found then
    insert into public.staff_access(user_id,access_level,active)
    values(target_user_id,p_access_level,true);
  end if;

  return true;
end;
$$;

grant execute on function public.set_entertainment_staff_access(uuid,text) to authenticated;

-- Prevent direct table updates from being used for self-promotion.
create or replace function public.guard_entertainment_roster_self_promotion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_user_id uuid;
  old_rank integer;
  new_rank integer;
begin
  select i.user_id into target_user_id
  from auth.identities i
  where i.provider='discord'
    and i.provider_id=coalesce(nullif(trim(new.discord_id),''), nullif(trim(old.discord_id),''))
  order by i.created_at desc limit 1;

  if target_user_id = auth.uid() and new.hierarchy_level is distinct from old.hierarchy_level then
    old_rank := case old.hierarchy_level
      when 'director' then 5 when 'manager' then 4 when 'culture_manager' then 4
      when 'entertainment_resp' then 4 when 'adm' then 3 when 'aux' then 2 else 1 end;
    new_rank := case new.hierarchy_level
      when 'director' then 5 when 'manager' then 4 when 'culture_manager' then 4
      when 'entertainment_resp' then 4 when 'adm' then 3 when 'aux' then 2 else 1 end;
    if new_rank > old_rank then
      raise exception 'You cannot promote your own account.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists entertainment_roster_self_promotion_guard on public.entertainment_roster;
create trigger entertainment_roster_self_promotion_guard
before update of hierarchy_level, discord_id, staff_id on public.entertainment_roster
for each row execute function public.guard_entertainment_roster_self_promotion();

-- ---------------------------------------------------------
-- 4. Roster hierarchy grants use the same chain and block self edits.
-- ---------------------------------------------------------

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
  target_user_id uuid;
  caller_rank integer;
  target_rank integer;
begin
  caller_rank := public.kng_schedule_access_rank();
  if caller_rank < 3 then raise exception 'ADM access or higher is required.'; end if;
  if p_team not in ('actions','interactions') then raise exception 'Invalid team.'; end if;
  if p_hierarchy_level not in ('director','manager','culture_manager','entertainment_resp','adm','aux','ld','sub_ld','member') then raise exception 'Invalid hierarchy level.'; end if;

  target_rank := case p_hierarchy_level
    when 'director' then 5
    when 'manager' then 4
    when 'culture_manager' then 4
    when 'entertainment_resp' then 4
    when 'adm' then 3
    when 'aux' then 2
    when 'ld' then 1
    when 'sub_ld' then 1
    when 'member' then 1
    else 99
  end;

  if target_rank > caller_rank or (target_rank = caller_rank and caller_rank < 5) then
    raise exception 'Security chain: ADM can assign up to AUX, Management can assign up to ADM, Director can assign any level.';
  end if;

  select * into r from public.entertainment_roster where id=p_roster_id for update;
  if r.id is null then raise exception 'Roster member not found.'; end if;

  select i.user_id into target_user_id
  from auth.identities i
  where i.provider='discord'
    and i.provider_id=coalesce(nullif(trim(p_discord_id),''), r.discord_id)
  order by i.created_at desc limit 1;

  if target_user_id = auth.uid() then raise exception 'You cannot change your own roster level.'; end if;

  if coalesce(p_strikes,0) < 0 or coalesce(p_strikes,0) > 3 then raise exception 'Strikes must be between 0 and 3.'; end if;

  update public.staff
  set name=coalesce(nullif(trim(p_name),''),name),
      discord_id=nullif(trim(p_discord_id),''),
      active=true
  where id=r.staff_id;

  update public.entertainment_roster
  set display_name=coalesce(nullif(trim(p_name),''),display_name),
      discord_id=nullif(trim(p_discord_id),''),
      team=p_team,
      hierarchy_level=p_hierarchy_level,
      kng_id=nullif(trim(p_kng_id),''),
      strikes=coalesce(p_strikes,0),
      mentor=coalesce(p_mentor,false),
      notes=nullif(trim(p_notes),''),
      active=true,
      updated_by=auth.uid(),
      updated_at=now()
  where id=p_roster_id;

  return true;
end;
$$;

grant execute on function public.update_entertainment_roster_member(uuid,text,text,text,text,text,integer,boolean,text) to authenticated;

-- ---------------------------------------------------------
-- 5. Director/management access directory for tracking teams + access.
-- ---------------------------------------------------------

create or replace function public.get_kng_access_directory()
returns table(
  staff_id uuid,
  name text,
  discord_id text,
  team text,
  hierarchy_level text,
  access_level text,
  active boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.kng_schedule_access_rank() < 4 then
    raise exception 'Management access required.';
  end if;

  return query
  select
    s.id,
    coalesce(nullif(trim(er.display_name),''), nullif(trim(s.name),''), 'Discord user'),
    s.discord_id,
    er.team,
    er.hierarchy_level,
    coalesce(sa.access_level,'member'),
    er.active
  from public.entertainment_roster er
  join public.staff s on s.id=er.staff_id
  left join auth.identities i on i.provider='discord' and i.provider_id=s.discord_id
  left join public.staff_access sa on sa.user_id=i.user_id and sa.active=true
  where er.active=true
  order by
    case er.hierarchy_level
      when 'director' then 0
      when 'manager' then 1
      when 'culture_manager' then 2
      when 'entertainment_resp' then 3
      when 'adm' then 4
      when 'aux' then 5
      else 6
    end,
    er.team,
    2;
end;
$$;

grant execute on function public.get_kng_access_directory() to authenticated;

-- ---------------------------------------------------------
-- 6. Event Ideas Forum: ensure the table + policies exist.
-- ---------------------------------------------------------

create table if not exists public.event_suggestions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete set null,
  display_name text not null default 'Anonymous',
  title text not null,
  suggestion text not null,
  status text not null default 'new' check (status in ('new','reviewed','accepted','declined')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists event_suggestions_created_idx on public.event_suggestions(created_at desc);
alter table public.event_suggestions enable row level security;

drop policy if exists event_suggestions_public_read on public.event_suggestions;
drop policy if exists event_suggestions_public_insert on public.event_suggestions;
drop policy if exists event_suggestions_staff_update on public.event_suggestions;

create policy event_suggestions_public_read
on public.event_suggestions for select to anon, authenticated using (true);

create policy event_suggestions_public_insert
on public.event_suggestions for insert to anon, authenticated
with check (
  length(trim(title)) between 1 and 120
  and length(trim(suggestion)) between 1 and 1500
);

create policy event_suggestions_staff_update
on public.event_suggestions for update to authenticated
using (public.kng_schedule_can_manage())
with check (public.kng_schedule_can_manage());

notify pgrst, 'reload schema';
commit;
