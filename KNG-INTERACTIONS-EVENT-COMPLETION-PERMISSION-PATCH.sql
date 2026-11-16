-- Allow any active Interactions roster member to complete Interactions events.
-- Management keeps its existing permissions. This does not grant Actions access.

create or replace function public.kng_schedule_is_interactions_roster_member()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from auth.identities i
    join public.staff s on s.discord_id = i.provider_id and s.active = true
    join public.entertainment_roster r on r.staff_id = s.id
      and r.active = true
      and lower(r.team) = 'interactions'
    where i.user_id = auth.uid()
      and i.provider = 'discord'
  );
$$;

grant execute on function public.kng_schedule_is_interactions_roster_member() to authenticated;

drop policy if exists events_staff_update on public.events;
create policy events_staff_update on public.events
for update to authenticated
using (
  public.kng_schedule_can_manage()
  or (
    lower(coalesce(workspace, 'interactions')) = 'interactions'
    and public.kng_schedule_is_interactions_roster_member()
  )
)
with check (
  public.kng_schedule_can_manage()
  or (
    lower(coalesce(workspace, 'interactions')) = 'interactions'
    and public.kng_schedule_is_interactions_roster_member()
  )
);

notify pgrst, 'reload schema';
