-- KNG ENTERTAINMENT RESP ROLE PATCH
-- Run ONCE after the existing KNG Culture Manager / Role Access patches.
-- Adds Entertainment Resp below Manager/Culture Manager and above ADM/AUX.
-- Entertainment Resp has management-tier site permissions (rank 3), including
-- access to BOTH Actions and Interactions, but cannot promote people to Manager,
-- Culture Manager, or Director.

begin;

-- 1) Allow the new roster hierarchy level.
alter table public.entertainment_roster
  drop constraint if exists entertainment_roster_hierarchy_level_check;

alter table public.entertainment_roster
  add constraint entertainment_roster_hierarchy_level_check
  check (hierarchy_level in ('director','manager','culture_manager','entertainment_resp','adm','aux','ld','sub_ld','member'));

-- 2) Allow the corresponding site access level.
alter table public.staff_access
  drop constraint if exists staff_access_access_level_check;

update public.staff_access
set access_level = 'member'
where access_level is null
   or access_level not in ('member','aux','adm','entertainment_resp','manager','culture_manager','director');

alter table public.staff_access
  add constraint staff_access_access_level_check
  check (access_level in ('member','aux','adm','entertainment_resp','manager','culture_manager','director'));

-- 3) Management-tier permissions. Entertainment Resp = same permission rank as Manager.
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
    when 'entertainment_resp' then 3
    when 'manager' then 3
    when 'culture_manager' then 3
    when 'director' then 4
    when 'admin' then 4
    when 'entertainment' then 2
    else 0
  end;
$$;

-- 4) Keep roster hierarchy -> site access synchronised.
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
    when new.hierarchy_level='culture_manager' then 'culture_manager'
    when new.hierarchy_level='entertainment_resp' then 'entertainment_resp'
    when new.hierarchy_level='adm' then 'adm'
    when new.hierarchy_level='aux' then 'aux'
    else 'member'
  end;

  insert into public.staff_access(user_id,access_level,active)
  values(target_user,mapped_level,true)
  on conflict(user_id) do update
    set access_level=excluded.access_level,
        active=true,
        updated_at=now();

  return new;
end;
$$;

drop trigger if exists entertainment_roster_access_sync on public.entertainment_roster;
create trigger entertainment_roster_access_sync
after insert or update of hierarchy_level, discord_id, active, staff_id
on public.entertainment_roster
for each row execute function public.sync_entertainment_roster_access();

-- 5) Allow Management/Director to assign Entertainment Resp.
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
  target_rank numeric;
begin
  caller_rank := public.kng_schedule_access_rank();
  if caller_rank < 2 then
    raise exception 'You do not have permission to edit the entertainment roster.';
  end if;

  if p_team not in ('actions','interactions') then
    raise exception 'Invalid team.';
  end if;

  if p_hierarchy_level not in ('director','manager','culture_manager','entertainment_resp','adm','aux','ld','sub_ld','member') then
    raise exception 'Invalid hierarchy level.';
  end if;

  target_rank := case p_hierarchy_level
    when 'director' then 4
    when 'manager' then 3
    when 'culture_manager' then 3
    when 'entertainment_resp' then 2.5
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

  select * into r from public.entertainment_roster where id=p_roster_id for update;
  if r.id is null then raise exception 'Roster member not found.'; end if;

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

-- 6) Allow management-tier site access to be assigned.
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
  target_rank numeric;
  caller_rank integer;
begin
  caller_rank := public.kng_schedule_access_rank();
  if caller_rank < 2 then raise exception 'Management access required.'; end if;

  p_access_level := lower(trim(p_access_level));
  if p_access_level not in ('member','aux','adm','entertainment_resp','manager','culture_manager') then
    raise exception 'Invalid access level.';
  end if;

  target_rank := case p_access_level
    when 'member' then 1
    when 'aux' then 2
    when 'adm' then 2
    when 'entertainment_resp' then 2.5
    when 'manager' then 3
    when 'culture_manager' then 3
    else 99
  end;

  if caller_rank <= target_rank then
    raise exception 'You can only grant access below your own level.';
  end if;

  select er.id, s.discord_id into roster_row
  from public.entertainment_roster er
  join public.staff s on s.id=er.staff_id
  where er.id=p_roster_id and er.active=true;
  if roster_row.id is null then raise exception 'Roster member not found.'; end if;

  select i.user_id into target_user_id
  from auth.identities i
  where i.provider='discord' and i.provider_id=roster_row.discord_id
  order by i.created_at desc limit 1;
  if target_user_id is null then raise exception 'That roster member has not linked a Discord login to this site yet.'; end if;

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

notify pgrst, 'reload schema';
commit;
