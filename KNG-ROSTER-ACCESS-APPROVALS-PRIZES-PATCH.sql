-- KNG ROSTER REMOVAL, ACCESS REVOCATION, AUX+ MEMBER APPROVALS,
-- AND MEMBER PRIZE-WIN LOGGING
-- Run in Supabase SQL Editor after deploying the matching website ZIP.

-- Rank model used by the current KNG security patch:
-- member=1, AUX=2, ADM=3, management (Manager/Culture Manager/
-- Entertainment Resp)=4, Director=5.

create or replace function public.remove_entertainment_roster_member(p_roster_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
    v_caller_rank integer := public.kng_schedule_access_rank();
    v_target_rank integer;
    v_target_discord text;
begin
    if auth.uid() is null or v_caller_rank < 3 then
        raise exception 'ADM access or higher is required to remove roster members.';
    end if;

    select
        case lower(coalesce(er.hierarchy_level,'member'))
            when 'member' then 1 when 'sub_ld' then 1 when 'ld' then 1
            when 'aux' then 2 when 'adm' then 3
            when 'entertainment_resp' then 4 when 'culture_manager' then 4
            when 'manager' then 4 when 'director' then 5 else 0
        end,
        s.discord_id
    into v_target_rank, v_target_discord
    from public.entertainment_roster er
    join public.staff s on s.id = er.staff_id
    where er.id = p_roster_id and er.active = true
    for update of er;

    if not found then raise exception 'Active roster member not found.'; end if;
    if v_caller_rank <= coalesce(v_target_rank,0) then
        raise exception 'You can only remove staff below your own permission level.';
    end if;

    update public.entertainment_roster
       set active = false, updated_by = auth.uid(), updated_at = now()
     where id = p_roster_id;

    return true;
end;
$$;

create or replace function public.revoke_entertainment_roster_access(p_roster_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
    v_caller_rank integer := public.kng_schedule_access_rank();
    v_target_rank integer;
    v_target_discord text;
    v_target_user uuid;
begin
    if auth.uid() is null or v_caller_rank < 2 then
        raise exception 'AUX access or higher is required to revoke staff access.';
    end if;

    select
        case lower(coalesce(er.hierarchy_level,'member'))
            when 'member' then 1 when 'sub_ld' then 1 when 'ld' then 1
            when 'aux' then 2 when 'adm' then 3
            when 'entertainment_resp' then 4 when 'culture_manager' then 4
            when 'manager' then 4 when 'director' then 5 else 0
        end,
        s.discord_id
    into v_target_rank, v_target_discord
    from public.entertainment_roster er
    join public.staff s on s.id = er.staff_id
    where er.id = p_roster_id and er.active = true
    for update of er;

    if not found then raise exception 'Active roster member not found.'; end if;
    if v_caller_rank <= coalesce(v_target_rank,0) then
        raise exception 'You can only revoke access from staff below your own permission level.';
    end if;

    select i.user_id into v_target_user
    from auth.identities i
    where i.provider = 'discord' and i.provider_id = v_target_discord
    order by i.created_at desc
    limit 1;

    -- First remove the roster row. Existing roster-sync triggers may map an
    -- inactive roster record to Member; therefore deactivate site access LAST.
    update public.entertainment_roster
       set active = false, updated_by = auth.uid(), updated_at = now()
     where id = p_roster_id;

    if v_target_user is not null then
        update public.staff_access
           set active = false, updated_at = now()
         where user_id = v_target_user;
    end if;

    return true;
end;
$$;

grant execute on function public.remove_entertainment_roster_member(uuid) to authenticated;
grant execute on function public.revoke_entertainment_roster_access(uuid) to authenticated;

-- AUX+ may approve Member access. Higher approvals remain strictly tiered:
-- AUX -> Member; ADM -> Member/AUX; Management -> up to ADM; Director -> any.
create or replace function public.approve_staff_access_request(
    p_request_id uuid,
    p_access_level text default 'member'
)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
    v_req public.staff_access_requests%rowtype;
    v_caller_rank integer := public.kng_schedule_access_rank();
    v_target_rank integer;
    v_staff public.staff%rowtype;
    v_staff_name text;
begin
    if auth.uid() is null or v_caller_rank < 2 then
        raise exception 'AUX access or higher is required to approve Member access requests.';
    end if;

    p_access_level := lower(trim(coalesce(p_access_level,'member')));
    if p_access_level not in ('member','aux','adm','entertainment_resp','culture_manager','manager','director') then
        raise exception 'Invalid access level.';
    end if;

    v_target_rank := case p_access_level
        when 'member' then 1
        when 'aux' then 2
        when 'adm' then 3
        when 'entertainment_resp' then 4
        when 'culture_manager' then 4
        when 'manager' then 4
        when 'director' then 5
        else 99
    end;

    if not (v_caller_rank > v_target_rank or (v_caller_rank = 5 and v_target_rank = 5)) then
        raise exception 'You cannot approve access at or above your own permission level.';
    end if;

    select * into v_req
    from public.staff_access_requests
    where id = p_request_id
    for update;

    if v_req.id is null then raise exception 'Access request not found.'; end if;
    if v_req.status <> 'pending' then raise exception 'This request has already been decided.'; end if;
    if lower(coalesce(v_req.requested_access_level,'member')) <> p_access_level then
        raise exception 'Approval level does not match the requested access level.';
    end if;

    v_staff_name := coalesce(nullif(trim(v_req.requested_name),''), nullif(trim(v_req.discord_username),''), 'Discord user');

    select * into v_staff
    from public.staff
    where discord_id = v_req.discord_id
    order by active desc, created_at asc
    limit 1;

    if v_staff.id is null then
        insert into public.staff(name, discord_id, active)
        values(v_staff_name, v_req.discord_id, true)
        returning * into v_staff;
    else
        update public.staff
           set active = true,
               name = case
                   when nullif(trim(name),'') is null or lower(trim(name)) = 'discord user'
                   then v_staff_name else name end,
               updated_at = now()
         where id = v_staff.id;
    end if;

    insert into public.staff_access(user_id, access_level, active, updated_at)
    values(v_req.user_id, p_access_level, true, now())
    on conflict (user_id) do update
       set access_level = excluded.access_level,
           active = true,
           updated_at = now();

    update public.staff_access_requests
       set status = 'approved',
           review_note = 'Access confirmed by staff.',
           reviewed_by = auth.uid(),
           reviewed_at = now()
     where id = p_request_id;

    return true;
end;
$$;

grant execute on function public.approve_staff_access_request(uuid,text) to authenticated;

-- Members can read prize catalogue and submit prize-win records as themselves.
-- Only ADM+ can mark a prize win as completed or manage the catalogue.
alter table public.ops_prizes enable row level security;
alter table public.ops_prize_wins enable row level security;

drop policy if exists ops_prizes_authenticated_read on public.ops_prizes;
create policy ops_prizes_authenticated_read
on public.ops_prizes for select to authenticated
using (active = true or public.kng_schedule_access_rank() >= 3);

drop policy if exists ops_prize_wins_authenticated_read on public.ops_prize_wins;
create policy ops_prize_wins_authenticated_read
on public.ops_prize_wins for select to authenticated
using (public.kng_schedule_access_rank() >= 1);

drop policy if exists ops_prize_wins_member_insert on public.ops_prize_wins;
create policy ops_prize_wins_member_insert
on public.ops_prize_wins for insert to authenticated
with check (
    public.kng_schedule_access_rank() >= 1
    and won_by = auth.uid()
);

drop policy if exists ops_prize_wins_management_update on public.ops_prize_wins;
create policy ops_prize_wins_management_update
on public.ops_prize_wins for update to authenticated
using (public.kng_schedule_access_rank() >= 3)
with check (public.kng_schedule_access_rank() >= 3);

notify pgrst, 'reload schema';
