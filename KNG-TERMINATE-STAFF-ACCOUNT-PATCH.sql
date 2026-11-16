-- KNG: Director-only access termination. Re-requesting access remains allowed.
begin;

create or replace function public.director_terminate_staff_account(
    p_discord_id text,
    p_reason text default 'Staff departure'
)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
    v_discord_id text := trim(coalesce(p_discord_id, ''));
    v_target_user uuid;
    v_target_rank integer := 0;
begin
    if auth.uid() is null or not public.kng_schedule_is_director() then
        raise exception 'Director access is required to terminate staff accounts.';
    end if;
    if v_discord_id = '' then raise exception 'Discord ID is required.'; end if;

    select i.user_id into v_target_user
    from auth.identities i
    where i.provider = 'discord' and i.provider_id::text = v_discord_id
    order by i.created_at desc
    limit 1;

    if v_target_user is null then
        raise exception 'No linked Discord account was found for this ID.';
    end if;
    if v_target_user = auth.uid() then
        raise exception 'You cannot terminate your own account.';
    end if;

    select case lower(coalesce(sa.access_level, 'public'))
        when 'public' then 0 when 'member' then 1 when 'aux' then 2
        when 'adm' then 3 when 'manager' then 4
        when 'entertainment_resp' then 4 when 'culture_manager' then 4
        when 'director' then 5 else 0 end
      into v_target_rank
    from public.staff_access sa
    where sa.user_id = v_target_user;

    if coalesce(v_target_rank,0) >= 5 then
        raise exception 'A Director account cannot be terminated through this action.';
    end if;

    -- Deactivate roster allocations first to avoid roster-sync triggers
    -- reactivating or downgrading site access.
    update public.entertainment_roster er
       set active = false, updated_by = auth.uid(), updated_at = now()
      from public.staff s
     where er.staff_id = s.id
       and s.discord_id::text = v_discord_id
       and er.active = true;

    update public.staff_access
       set active = false, updated_at = now()
     where user_id = v_target_user;

    update public.staff
       set active = false, updated_at = now()
     where discord_id::text = v_discord_id;

    update public.staff_access_requests
       set status = 'rejected',
           review_note = 'Staff account terminated by a Director.',
           reviewed_by = auth.uid(),
           reviewed_at = now()
     where discord_id::text = v_discord_id
       and status = 'pending';

    return true;
end;
$$;

grant execute on function public.director_terminate_staff_account(text,text) to authenticated;

-- Prevent a terminated Discord account from creating a fresh access request.
create or replace function public.request_staff_access(p_requested_access_level text default 'member')
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
    identity_row record;
    staff_row record;
    request_id uuid;
    discord_name text;
    current_level text;
    current_rank integer;
    requested_rank integer;
begin
    if auth.uid() is null then raise exception 'You must be signed in.'; end if;

    select i.provider_id, i.identity_data
      into identity_row
    from auth.identities i
    where i.user_id = auth.uid() and i.provider = 'discord'
    order by i.created_at desc
    limit 1;

    if identity_row.provider_id is null then
        raise exception 'Discord sign-in is required for staff access.';
    end if;


    p_requested_access_level := lower(trim(coalesce(p_requested_access_level,'member')));
    if p_requested_access_level not in ('member','aux','adm','manager') then
        raise exception 'That access level must be assigned by staff.';
    end if;

    select coalesce(sa.access_level,'public') into current_level
    from public.staff_access sa
    where sa.user_id = auth.uid() and sa.active = true
    limit 1;

    current_rank := public.kng_schedule_access_rank();
    requested_rank := case p_requested_access_level
        when 'member' then 1 when 'aux' then 2 when 'adm' then 3
        when 'manager' then 4 else 99 end;

    if requested_rank <= current_rank then
        raise exception 'You already have that level or higher.';
    end if;
    if current_level is null then current_level := 'public'; end if;
    if current_level = 'public' and p_requested_access_level <> 'member' then
        raise exception 'Access must begin with Member.';
    end if;
    if current_level = 'member' and p_requested_access_level <> 'aux' then
        raise exception 'Members can request AUX access next.';
    end if;
    if current_level = 'aux' and p_requested_access_level <> 'adm' then
        raise exception 'AUX staff can request ADM access next.';
    end if;
    if current_level = 'adm' and p_requested_access_level <> 'manager' then
        raise exception 'ADM staff can request Management access next.';
    end if;

    discord_name := coalesce(
        identity_row.identity_data->>'global_name',
        identity_row.identity_data->>'username',
        'Discord user'
    );

    select s.id, s.name into staff_row
    from public.staff s
    where s.discord_id::text = identity_row.provider_id::text
      and s.active = true
    limit 1;

    insert into public.staff_access_requests(
        user_id, discord_id, discord_username, requested_name,
        status, requested_access_level
    ) values (
        auth.uid(), identity_row.provider_id, discord_name,
        coalesce(staff_row.name, discord_name), 'pending', p_requested_access_level
    ) returning id into request_id;

    return request_id;
exception when unique_violation then
    select id into request_id
    from public.staff_access_requests
    where user_id = auth.uid() and status = 'pending'
    order by created_at desc limit 1;
    return request_id;
end;
$$;

grant execute on function public.request_staff_access(text) to authenticated;

-- Prevent the ordinary Director access editor from reactivating a terminated ID.
create or replace function public.director_set_staff_access(
    p_discord_id text,
    p_access_level text
)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
    target_user_id uuid;
    target_staff_id uuid;
    target_name text;
begin
    if not public.kng_schedule_is_director() then
        raise exception 'Director access required.';
    end if;
    p_discord_id := trim(coalesce(p_discord_id, ''));
    p_access_level := lower(trim(coalesce(p_access_level, 'member')));
    if p_discord_id = '' then raise exception 'Discord ID is required.'; end if;
    if p_access_level not in ('member','aux','adm','entertainment_resp','culture_manager','manager','director') then
        raise exception 'Invalid access level.';
    end if;

    select i.user_id into target_user_id
    from auth.identities i
    where i.provider = 'discord' and i.provider_id::text = p_discord_id
    order by i.created_at desc limit 1;
    if target_user_id is null then raise exception 'That Discord account has not logged into KNG Schedule yet.'; end if;
    if target_user_id = auth.uid() then raise exception 'You cannot change your own access.'; end if;

    select s.id, nullif(trim(s.name), '') into target_staff_id, target_name
    from public.staff s where s.discord_id::text = p_discord_id limit 1;
    if target_staff_id is null then
        insert into public.staff(name, discord_id, active)
        values (coalesce(nullif(target_name,''),p_discord_id),p_discord_id,true)
        returning id into target_staff_id;
    else
        update public.staff set active = true, updated_at = now() where id = target_staff_id;
    end if;

    update public.staff_access
       set access_level = p_access_level, active = true, updated_at = now()
     where user_id = target_user_id;
    if not found then
        insert into public.staff_access(user_id, access_level, active)
        values (target_user_id,p_access_level,true);
    end if;
    return true;
end;
$$;

grant execute on function public.director_set_staff_access(text,text) to authenticated;

drop table if exists public.kng_terminated_staff_accounts;

notify pgrst, 'reload schema';
commit;
