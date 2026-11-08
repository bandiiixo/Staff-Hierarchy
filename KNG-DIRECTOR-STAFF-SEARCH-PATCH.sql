-- KNG DIRECTOR STAFF SEARCH / ACCESS CONTROL
-- Run once after KNG-SECURITY-AND-DIRECTOR-PERMISSIONS-PATCH.sql
-- Directors can search the full linked staff database, including people who
-- are not on Actions/Interactions rosters, and set their site access.

begin;

create or replace function public.get_kng_director_staff_search(p_search text default '')
returns table(
  staff_id uuid,
  user_id uuid,
  name text,
  discord_id text,
  teams text,
  roster_roles text,
  access_level text,
  access_active boolean,
  linked boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.kng_schedule_is_director() then
    raise exception 'Director access required.';
  end if;

  return query
  with discord_identities as (
    select distinct on (i.provider_id)
      i.user_id,
      i.provider_id::text as discord_id,
      coalesce(
        nullif(trim(i.identity_data->>'global_name'), ''),
        nullif(trim(i.identity_data->>'username'), ''),
        'Discord user'
      ) as identity_name
    from auth.identities i
    where i.provider = 'discord'
      and i.provider_id is not null
    order by i.provider_id, i.created_at desc
  ),
  roster_summary as (
    select
      s.id as staff_id,
      string_agg(distinct er.team, ', ' order by er.team) as teams,
      string_agg(distinct er.hierarchy_level, ', ' order by er.hierarchy_level) as roster_roles
    from public.staff s
    left join public.entertainment_roster er
      on er.staff_id = s.id
     and er.active = true
    group by s.id
  ),
  staff_rows as (
    select
      s.id as staff_id,
      di.user_id,
      coalesce(nullif(trim(s.name), ''), di.identity_name, s.discord_id, 'Discord user') as name,
      s.discord_id::text as discord_id,
      rs.teams,
      rs.roster_roles,
      coalesce(sa.access_level, 'member') as access_level,
      coalesce(sa.active, false) as access_active,
      (di.user_id is not null) as linked
    from public.staff s
    left join discord_identities di on di.discord_id = s.discord_id::text
    left join roster_summary rs on rs.staff_id = s.id
    left join public.staff_access sa on sa.user_id = di.user_id and sa.active = true
  ),
  identity_only as (
    select
      null::uuid as staff_id,
      di.user_id,
      di.identity_name as name,
      di.discord_id,
      null::text as teams,
      null::text as roster_roles,
      coalesce(sa.access_level, 'member') as access_level,
      coalesce(sa.active, false) as access_active,
      true as linked
    from discord_identities di
    left join public.staff s on s.discord_id::text = di.discord_id
    left join public.staff_access sa on sa.user_id = di.user_id and sa.active = true
    where s.id is null
  ),
  combined as (
    select * from staff_rows
    union all
    select * from identity_only
  )
  select *
  from combined c
  where nullif(trim(coalesce(p_search, '')), '') is null
     or lower(coalesce(c.name, '')) like '%' || lower(trim(p_search)) || '%'
     or lower(coalesce(c.discord_id, '')) like '%' || lower(trim(p_search)) || '%'
  order by
    case c.access_level
      when 'director' then 0
      when 'manager' then 1
      when 'culture_manager' then 2
      when 'entertainment_resp' then 3
      when 'adm' then 4
      when 'aux' then 5
      when 'member' then 6
      else 7
    end,
    c.name;
end;
$$;

grant execute on function public.get_kng_director_staff_search(text) to authenticated;

create or replace function public.director_set_staff_access(
  p_discord_id text,
  p_access_level text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  target_user_id uuid;
  target_staff_id uuid;
  target_name text;
  target_rank integer;
  current_rank integer;
begin
  if not public.kng_schedule_is_director() then
    raise exception 'Director access required.';
  end if;

  p_discord_id := trim(coalesce(p_discord_id, ''));
  p_access_level := lower(trim(coalesce(p_access_level, 'member')));

  if p_discord_id = '' then
    raise exception 'Discord ID is required.';
  end if;

  if p_access_level not in ('member','aux','adm','entertainment_resp','culture_manager','manager','director') then
    raise exception 'Invalid access level.';
  end if;

  select i.user_id
    into target_user_id
  from auth.identities i
  where i.provider = 'discord'
    and i.provider_id::text = p_discord_id
  order by i.created_at desc
  limit 1;

  if target_user_id is null then
    raise exception 'That Discord account has not logged into KNG Schedule yet.';
  end if;

  if target_user_id = auth.uid() then
    raise exception 'You cannot change your own access.';
  end if;

  target_rank := case p_access_level
    when 'member' then 1
    when 'aux' then 2
    when 'adm' then 3
    when 'entertainment_resp' then 4
    when 'culture_manager' then 4
    when 'manager' then 4
    when 'director' then 5
    else 0
  end;

  select s.id, nullif(trim(s.name), '')
    into target_staff_id, target_name
  from public.staff s
  where s.discord_id::text = p_discord_id
  limit 1;

  if target_staff_id is null then
    insert into public.staff(name, discord_id, active)
    values (coalesce(nullif(target_name, ''), p_discord_id), p_discord_id, true)
    returning id into target_staff_id;
  end if;

  update public.staff_access
  set access_level = p_access_level,
      active = true,
      updated_at = now()
  where user_id = target_user_id;

  if not found then
    insert into public.staff_access(user_id, access_level, active)
    values (target_user_id, p_access_level, true);
  end if;

  return true;
end;
$$;

grant execute on function public.director_set_staff_access(text,text) to authenticated;

notify pgrst, 'reload schema';
commit;
