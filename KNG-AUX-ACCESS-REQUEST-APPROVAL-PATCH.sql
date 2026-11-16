-- KNG: Allow AUX+ to view access requests and approve only levels below theirs.
-- Safe to run after the existing KNG security/role migrations.

-- AUX (rank 2) and above can read the approval queue.
drop policy if exists staff_access_requests_select on public.staff_access_requests;
create policy staff_access_requests_select
on public.staff_access_requests
for select
to authenticated
using (
  user_id = auth.uid()
  or public.kng_schedule_access_rank() >= 2
);

-- Approval RPC: AUX -> Member; ADM -> Member/AUX;
-- Management -> levels below Management; Director -> any level.
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

    p_access_level := lower(trim(coalesce(p_access_level, 'member')));
    if p_access_level not in ('member','aux','adm','entertainment_resp','culture_manager','manager','director') then
        raise exception 'Invalid approval level.';
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
    if lower(coalesce(v_req.requested_access_level, 'member')) <> p_access_level then
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
