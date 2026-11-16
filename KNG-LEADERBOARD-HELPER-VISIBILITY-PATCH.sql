-- KNG leaderboard/helper visibility repair
-- Run once in Supabase SQL Editor.
-- Keep management writes restricted, but allow every active staff rank to read
-- helper assignments so the Interactions hosting leaderboard is complete.

create or replace function public.kng_schedule_access_rank()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case lower(trim(coalesce((
    select sa.access_level
    from public.staff_access sa
    where sa.user_id = auth.uid()
      and sa.active = true
    limit 1
  ), 'public')))
    when 'public' then 0
    when 'member' then 1
    when 'aux' then 1
    when 'adm' then 2
    when 'entertainment' then 2
    when 'entertainment_resp' then 3
    when 'culture_manager' then 3
    when 'manager' then 3
    when 'director' then 4
    when 'admin' then 4
    else 0
  end;
$$;

drop policy if exists ops_helpers_read on public.ops_helpers;
create policy ops_helpers_read
on public.ops_helpers
for select
to authenticated
using (public.kng_schedule_access_rank() >= 1);

-- Preserve the existing ops_helpers_write policy: it remains ADM+ only
-- through public.kng_schedule_can_manage().
