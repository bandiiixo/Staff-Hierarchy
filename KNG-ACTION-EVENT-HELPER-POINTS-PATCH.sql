-- KNG ACTION EVENT HOST + HELPER DAILY-GOAL POINTS
-- Run once in Supabase SQL Editor after deploying the matching website ZIP.
-- Each unique staff member recorded as host or helper for an action event
-- receives exactly 1 point for that event date. Duplicate saves do not award
-- duplicate points. Staff must have linked their Discord account to KNG so
-- their staff.discord_id can be matched to auth.identities.provider_id.

create table if not exists public.kng_action_event_contributions (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.kng_action_tracker(id) on delete cascade,
    event_date date not null,
    staff_id uuid not null references public.staff(id) on delete cascade,
    created_by uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    unique(event_id, staff_id)
);

alter table public.kng_action_event_contributions enable row level security;

drop policy if exists kng_action_event_contributions_read on public.kng_action_event_contributions;
create policy kng_action_event_contributions_read
on public.kng_action_event_contributions
for select to authenticated
using (
    exists (
        select 1
        from public.staff s
        join auth.identities i
          on i.provider = 'discord'
         and i.provider_id = s.discord_id
        where s.id = staff_id
          and i.user_id = auth.uid()
    )
    or public.kng_schedule_can_manage()
);

drop policy if exists kng_action_event_contributions_manage on public.kng_action_event_contributions;
create policy kng_action_event_contributions_manage
on public.kng_action_event_contributions
for all to authenticated
using (public.kng_schedule_can_manage())
with check (public.kng_schedule_can_manage());

create or replace function public.kng_award_action_event_points(
    p_event_id uuid,
    p_event_date date,
    p_staff_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
    v_staff_id uuid;
    v_discord_id text;
    v_user_id uuid;
    v_inserted uuid;
    v_awarded integer := 0;
begin
    if auth.uid() is null or not public.kng_schedule_can_manage() then
        raise exception 'You do not have permission to record event participation.';
    end if;

    if not exists (select 1 from public.kng_action_tracker where id = p_event_id) then
        raise exception 'The action event could not be found.';
    end if;

    foreach v_staff_id in array coalesce(p_staff_ids, array[]::uuid[])
    loop
        if v_staff_id is null then
            continue;
        end if;

        insert into public.kng_action_event_contributions
            (event_id, event_date, staff_id, created_by)
        values
            (p_event_id, p_event_date, v_staff_id, auth.uid())
        on conflict (event_id, staff_id) do nothing
        returning id into v_inserted;

        if v_inserted is not null then
            select s.discord_id into v_discord_id
            from public.staff s
            where s.id = v_staff_id and s.active = true;

            select i.user_id into v_user_id
            from auth.identities i
            where i.provider = 'discord'
              and i.provider_id = v_discord_id
            limit 1;

            if v_user_id is not null then
                insert into public.ix_daily_goals
                    (user_id, goal_date, target_points, points_earned)
                values
                    (v_user_id, p_event_date, 8, 1)
                on conflict (user_id, goal_date)
                do update set points_earned = public.ix_daily_goals.points_earned + 1;
                v_awarded := v_awarded + 1;
            end if;
        end if;

        v_inserted := null;
        v_user_id := null;
        v_discord_id := null;
    end loop;

    return v_awarded;
end;
$$;

revoke all on function public.kng_award_action_event_points(uuid,date,uuid[]) from public;
grant execute on function public.kng_award_action_event_points(uuid,date,uuid[]) to authenticated;

notify pgrst, 'reload schema';
