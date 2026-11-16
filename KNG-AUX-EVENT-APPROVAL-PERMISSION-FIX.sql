-- KNG AUX EVENT APPROVAL PERMISSION FIX
-- Fixes the mismatch where the website recognises AUX but the database
-- permission-rank function and access-level constraint do not.
-- Safe to run in Supabase SQL Editor after the existing KNG migrations.
-- Does not change event submissions, existing events, or staff assignments.

begin;

-- Keep legacy role names compatible while retaining the current hierarchy.
alter table public.staff_access
  drop constraint if exists staff_access_access_level_check;

update public.staff_access
set access_level = case lower(trim(coalesce(access_level, 'member')))
  when 'viewer' then 'member'
  when 'admin' then 'director'
  when 'entertainment' then 'adm'
  else lower(trim(coalesce(access_level, 'member')))
end
where access_level is null
   or lower(trim(access_level)) in ('viewer', 'admin', 'entertainment');

-- AUX must be a valid stored access level. Keep all current KNG roles.
alter table public.staff_access
  add constraint staff_access_access_level_check
  check (access_level in (
    'member', 'aux', 'adm', 'entertainment_resp',
    'culture_manager', 'manager', 'director'
  ));

-- This is the canonical permission hierarchy used by the website:
-- public 0, member 1, AUX 2, ADM 3,
-- Entertainment Resp/Culture Manager/Manager 4, Director 5.
create or replace function public.kng_schedule_access_rank()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case lower(coalesce((
    select sa.access_level
    from public.staff_access sa
    where sa.user_id = auth.uid()
      and sa.active = true
    limit 1
  ), 'public'))
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

grant execute on function public.kng_schedule_access_rank() to authenticated;

commit;

-- Verification after running:
-- Sign in as an AUX account and run:
-- select public.kng_schedule_access_rank();
-- Expected result: 2
-- ADM should return 3; Manager/Culture Manager/Entertainment Resp 4;
-- Director 5.
