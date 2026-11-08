-- KNG roster permission hardening
-- Run this patch once in Supabase after deploying the matching website ZIP.
-- AUX can promote staff progressively up to AUX and edit display names only.
-- Management can manage both teams and assign roles up to ADM, but cannot
-- change management/Director roles or access. Director retains full control.

create or replace function public.update_entertainment_roster_member(
  p_roster_id uuid,
  p_name text,
  p_discord_id text,
  p_team text,
  p_hierarchy_level text,
  p_kng_id text,
  p_strikes integer,
  p_mentor boolean,
  p_notes text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.entertainment_roster%rowtype;
  caller_rank integer;
  target_rank integer;
  same_role_name_edit boolean := false;
  target_discord text;
  target_user_id uuid;
begin
  caller_rank := public.kng_schedule_access_rank();
  if caller_rank < 2 then
    raise exception 'AUX access or higher is required to edit the roster.';
  end if;

  select * into r
  from public.entertainment_roster
  where id = p_roster_id
  for update;
  if not found then
    raise exception 'Roster member not found.';
  end if;

  if p_team not in ('actions','interactions') then
    raise exception 'Invalid team.';
  end if;
  if p_hierarchy_level not in ('director','manager','culture_manager','entertainment_resp','adm','aux','ld','sub_ld','member') then
    raise exception 'Invalid hierarchy level.';
  end if;
  if coalesce(p_strikes,0) < 0 or coalesce(p_strikes,0) > 3 then
    raise exception 'Strikes must be between 0 and 3.';
  end if;

  target_rank := case p_hierarchy_level
    when 'director' then 5
    when 'manager' then 4
    when 'culture_manager' then 4
    when 'entertainment_resp' then 4
    when 'adm' then 3
    when 'aux' then 2
    when 'ld' then 1
    when 'sub_ld' then 1
    when 'member' then 1
    else 99
  end;

  target_discord := coalesce(nullif(trim(p_discord_id),''), r.discord_id);
  select i.user_id into target_user_id
  from auth.identities i
  where i.provider = 'discord'
    and i.provider_id = target_discord
  order by i.created_at desc
  limit 1;
  if target_user_id = auth.uid() then
    raise exception 'You cannot change your own roster record.';
  end if;

  -- AUX may change names and promote ordinary staff, but cannot change any
  -- other roster fields. Their promotion ceiling is AUX itself.
  if caller_rank = 2 then
    if p_team is distinct from r.team
       or coalesce(target_discord,'') is distinct from coalesce(r.discord_id,'')
       or nullif(trim(p_kng_id),'') is distinct from nullif(trim(r.kng_id),'')
       or coalesce(p_strikes,0) is distinct from coalesce(r.strikes,0)
       or coalesce(p_mentor,false) is distinct from coalesce(r.mentor,false)
       or nullif(trim(p_notes),'') is distinct from nullif(trim(r.notes),'') then
      raise exception 'AUX can only edit display names and promote staff up to AUX.';
    end if;
    if p_hierarchy_level = r.hierarchy_level then
      -- Name-only edit is allowed even when the target is above AUX.
      same_role_name_edit := true;
    elsif target_rank > 2 then
      raise exception 'AUX cannot promote staff above AUX.';
    elsif target_rank = 2 and r.hierarchy_level not in ('member','sub_ld','ld') then
      raise exception 'AUX can only promote Member, Sub-LD or LD staff to AUX.';
    end if;
  elsif caller_rank < 5 then
    if target_rank > caller_rank then
      raise exception 'You cannot assign a role above your own access level.';
    end if;
    if target_rank = caller_rank then
      if p_hierarchy_level <> r.hierarchy_level then
        raise exception 'You cannot promote staff into your own management tier.';
      end if;
      same_role_name_edit := true;
      -- Equal-rank records are name-only edits. This protects peer managers
      -- from having their team, role, ID, strikes, mentor status or notes changed.
      if p_team is distinct from r.team
         or target_discord is distinct from coalesce(r.discord_id,'')
         or nullif(trim(p_kng_id),'') is distinct from nullif(trim(r.kng_id),'')
         or coalesce(p_strikes,0) is distinct from coalesce(r.strikes,0)
         or coalesce(p_mentor,false) is distinct from coalesce(r.mentor,false)
         or nullif(trim(p_notes),'') is distinct from nullif(trim(r.notes),'') then
        raise exception 'You can only update the display name of staff at your management level.';
      end if;
    end if;
  end if;

  update public.staff
  set name = coalesce(nullif(trim(p_name),''), name),
      active = true
  where id = r.staff_id;

  update public.entertainment_roster
  set display_name = coalesce(nullif(trim(p_name),''), display_name),
      discord_id = case when caller_rank = 2 or same_role_name_edit then r.discord_id else nullif(trim(p_discord_id),'') end,
      team = case when caller_rank = 2 or same_role_name_edit then r.team else p_team end,
      hierarchy_level = p_hierarchy_level,
      kng_id = case when caller_rank = 2 or same_role_name_edit then r.kng_id else nullif(trim(p_kng_id),'') end,
      strikes = case when caller_rank = 2 or same_role_name_edit then r.strikes else coalesce(p_strikes,0) end,
      mentor = case when caller_rank = 2 or same_role_name_edit then r.mentor else coalesce(p_mentor,false) end,
      notes = case when caller_rank = 2 or same_role_name_edit then r.notes else nullif(trim(p_notes),'') end,
      active = true,
      updated_by = auth.uid(),
      updated_at = now()
  where id = p_roster_id;

  return true;
end;
$$;

grant execute on function public.update_entertainment_roster_member(uuid,text,text,text,text,text,integer,boolean,text) to authenticated;
notify pgrst, 'reload schema';
