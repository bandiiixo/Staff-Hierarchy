-- KNG DISPLAY NAME + EVENT UNCLAIM PATCH
-- Run this after the existing KNG Entertainment migration.
-- It does not delete event data.

create or replace function public.claim_event_host_slot(p_event_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_discord_id text;
  v_staff_name text;
  v_display_name text;
begin
  if auth.uid() is null then
    raise exception 'Sign in required.';
  end if;

  select i.provider_id into v_discord_id
  from auth.identities i
  where i.user_id = auth.uid() and i.provider = 'discord'
  order by i.created_at desc
  limit 1;

  v_discord_id := nullif(trim(coalesce(v_discord_id, '')), '');
  if v_discord_id is null then
    raise exception 'No Discord account is linked to this login.';
  end if;

  select s.name into v_staff_name
  from public.staff s
  where s.discord_id = v_discord_id and s.active = true
  limit 1;

  v_display_name := nullif(trim(coalesce(
    (select u.raw_user_meta_data->>'kng_display_name'
     from auth.users u
     where u.id = auth.uid()),
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

grant execute on function public.claim_event_host_slot(uuid) to authenticated;

create or replace function public.unclaim_event_host_slot(p_event_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in required.';
  end if;

  update public.events
  set host_claimed_by = null,
      host_claimed_discord = null,
      host_claimed_name = null,
      host_claimed_at = null,
      updated_by = auth.uid()
  where id = p_event_id
    and status = 'scheduled'
    and host_claimed_by = auth.uid()
    and now() < ((event_date + start_time) at time zone 'Europe/London') - interval '1 hour';

  if not found then
    return false;
  end if;

  return true;
end;
$$;

grant execute on function public.unclaim_event_host_slot(uuid) to authenticated;

-- Repair old claims that accidentally displayed the Discord ID as the name.
update public.events e
set host_claimed_name = s.name
from public.staff s
where e.host_claimed_discord = s.discord_id
  and s.active = true
  and coalesce(e.host_claimed_name, '') ~ '^[0-9]+$';

notify pgrst, 'reload schema';
