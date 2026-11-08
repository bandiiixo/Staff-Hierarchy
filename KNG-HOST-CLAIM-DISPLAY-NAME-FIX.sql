-- KNG Host Event Claim Display Name Fix
-- Run this AFTER the main KNG Entertainment migration.
-- This makes the claim action explicitly pass the user's saved KNG display name,
-- while the database still falls back safely to Discord/staff identity.

create or replace function public.claim_event_host_slot(
  p_event_id uuid,
  p_display_name text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_discord_id text;
  v_staff_name text;
  v_saved_display_name text;
  v_display_name text;
begin
  if auth.uid() is null then
    raise exception 'Sign in required.';
  end if;

  select i.provider_id into v_discord_id
  from auth.identities i
  where i.user_id = auth.uid()
    and i.provider = 'discord'
  order by i.created_at desc
  limit 1;

  v_discord_id := nullif(trim(coalesce(v_discord_id, '')), '');
  if v_discord_id is null then
    raise exception 'No Discord account is linked to this login.';
  end if;

  select s.name into v_staff_name
  from public.staff s
  where s.discord_id = v_discord_id
    and s.active = true
  limit 1;

  select nullif(trim(coalesce(u.raw_user_meta_data->>'kng_display_name', '')), '')
    into v_saved_display_name
  from auth.users u
  where u.id = auth.uid();

  v_display_name := nullif(trim(coalesce(
    p_display_name,
    v_saved_display_name,
    v_staff_name,
    'Staff'
  )), '');

  update public.events
  set host_claimed_by = auth.uid(),
      host_claimed_discord = v_discord_id,
      host_claimed_name = left(coalesce(v_display_name, 'Staff'), 120),
      host_claimed_at = now(),
      updated_by = auth.uid()
  where id = p_event_id
    and status = 'scheduled'
    and host_claimed_by is null;

  if not found then
    return false;
  end if;

  return true;
end;
$$;

grant execute on function public.claim_event_host_slot(uuid, text) to authenticated;

-- Repair existing claims where the visible name is still the generic label
-- or an old numeric Discord ID. It prefers the user's saved KNG display name,
-- then the active staff name.
update public.events e
set host_claimed_name = left(coalesce(
  nullif(trim((select u.raw_user_meta_data->>'kng_display_name'
              from auth.users u
              where u.id = e.host_claimed_by)), ''),
  (select s.name
   from public.staff s
   where s.discord_id = e.host_claimed_discord
     and s.active = true
   limit 1),
  e.host_claimed_name,
  'Staff'
), 120)
where e.host_claimed_by is not null
  and (
    coalesce(trim(e.host_claimed_name), '') = ''
    or lower(trim(e.host_claimed_name)) in ('staff', 'staff member')
    or trim(e.host_claimed_name) ~ '^[0-9]+$'
  );

notify pgrst, 'reload schema';
