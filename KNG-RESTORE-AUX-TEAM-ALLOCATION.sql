-- KNG: Restore team selection immediately after approving a website access request.
-- AUX+ may allocate newly approved Member/AUX/ADM accounts to Actions or Interactions.
-- This does NOT grant site access or change their roster rank; it only creates/moves
-- the roster allocation and starts them at MEMBER when no roster row exists.

create or replace function public.allocate_approved_entertainment_staff(
  p_staff_id uuid,
  p_team text
)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_staff public.staff%rowtype;
  v_access_level text;
begin
  if auth.uid() is null or public.kng_schedule_access_rank() < 2 then
    raise exception 'AUX access or higher is required to allocate approved staff.';
  end if;

  if lower(trim(coalesce(p_team, ''))) not in ('actions','interactions') then
    raise exception 'Choose Actions or Interactions.';
  end if;

  select * into v_staff
  from public.staff
  where id = p_staff_id and active = true
  limit 1;

  if v_staff.id is null then
    raise exception 'Approved staff member could not be found.';
  end if;

  select lower(sa.access_level) into v_access_level
  from public.staff_access_requests sar
  join public.staff_access sa on sa.user_id = sar.user_id and sa.active = true
  where sar.discord_id = v_staff.discord_id
    and sar.status = 'approved'
    and lower(sa.access_level) in ('member','aux','adm')
  order by sar.reviewed_at desc nulls last, sar.created_at desc
  limit 1;

  if v_access_level is null then
    raise exception 'This account does not have a confirmed Member, AUX or ADM access request.';
  end if;

  insert into public.entertainment_roster(
    staff_id, display_name, team, hierarchy_level, kng_id, discord_id,
    strikes, mentor, notes, active, created_by, updated_by
  )
  values(
    v_staff.id,
    coalesce(nullif(trim(v_staff.name),''),'Discord user'),
    lower(trim(p_team)),
    'member',
    '',
    coalesce(v_staff.discord_id,''),
    0,
    false,
    '',
    true,
    auth.uid(),
    auth.uid()
  )
  on conflict (staff_id) do update set
    team = excluded.team,
    display_name = case
      when nullif(trim(public.entertainment_roster.display_name),'') is null
        or lower(trim(public.entertainment_roster.display_name)) = 'discord user'
      then excluded.display_name
      else public.entertainment_roster.display_name
    end,
    discord_id = excluded.discord_id,
    active = true,
    updated_by = auth.uid(),
    updated_at = now();

  return true;
end;
$$;

grant execute on function public.allocate_approved_entertainment_staff(uuid,text) to authenticated;
