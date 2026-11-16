-- KNG Leadership allocation team
-- Adds a central leadership group without creating duplicate roster rows.

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.entertainment_roster'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%team%'
      AND pg_get_constraintdef(oid) ILIKE '%actions%'
      AND pg_get_constraintdef(oid) ILIKE '%interactions%'
  LOOP
    EXECUTE format('ALTER TABLE public.entertainment_roster DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.entertainment_roster
  ADD CONSTRAINT entertainment_roster_team_check
  CHECK (team IS NULL OR team IN ('actions','interactions','leadership'));

-- Operational allocation remains AUX+. Leadership allocation is Director-only
-- and requires an existing senior staff_access permission.
CREATE OR REPLACE FUNCTION public.allocate_approved_entertainment_staff(
  p_staff_id uuid,
  p_team text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_staff public.staff%ROWTYPE;
  v_access_level text;
  v_hierarchy_level text;
  v_user_id uuid;
  v_team text := lower(trim(coalesce(p_team,'')));
BEGIN
  IF auth.uid() IS NULL OR public.kng_schedule_access_rank() < 2 THEN
    RAISE EXCEPTION 'AUX access or higher is required to allocate approved staff.';
  END IF;

  IF v_team NOT IN ('actions','interactions','leadership') THEN
    RAISE EXCEPTION 'Choose Actions, Interactions or KNG Leadership.';
  END IF;

  IF v_team = 'leadership' AND public.kng_schedule_access_rank() < 5 THEN
    RAISE EXCEPTION 'Only a Director can allocate someone to KNG Leadership.';
  END IF;

  SELECT * INTO v_staff
  FROM public.staff
  WHERE id = p_staff_id AND active = true
  LIMIT 1;

  IF v_staff.id IS NULL THEN
    RAISE EXCEPTION 'Staff member could not be found or is inactive.';
  END IF;

  IF v_team = 'leadership' THEN
    SELECT i.user_id, lower(sa.access_level)
      INTO v_user_id, v_access_level
    FROM auth.identities i
    JOIN public.staff_access sa ON sa.user_id = i.user_id AND sa.active = true
    WHERE i.provider = 'discord'
      AND i.provider_id = v_staff.discord_id
    ORDER BY i.created_at DESC
    LIMIT 1;

    IF v_access_level IS NULL OR v_access_level NOT IN ('entertainment_resp','manager','culture_manager','director') THEN
      RAISE EXCEPTION 'KNG Leadership is reserved for Management, Entertainment Resp and Director accounts.';
    END IF;

    v_hierarchy_level := v_access_level;
  ELSE
    SELECT lower(sa.access_level)
      INTO v_access_level
    FROM public.staff_access_requests sar
    JOIN public.staff_access sa ON sa.user_id = sar.user_id AND sa.active = true
    WHERE sar.discord_id = v_staff.discord_id
      AND sar.status = 'approved'
      AND lower(sa.access_level) IN ('member','aux','adm')
    ORDER BY sar.reviewed_at DESC NULLS LAST, sar.created_at DESC
    LIMIT 1;

    IF v_access_level IS NULL THEN
      RAISE EXCEPTION 'This account does not have a confirmed Member, AUX or ADM access request.';
    END IF;

    v_hierarchy_level := 'member';
  END IF;

  INSERT INTO public.entertainment_roster(
    staff_id, display_name, team, hierarchy_level, kng_id, discord_id,
    strikes, mentor, notes, active, created_by, updated_by
  )
  VALUES(
    v_staff.id,
    coalesce(nullif(trim(v_staff.name),''),'Discord user'),
    v_team,
    v_hierarchy_level,
    '',
    coalesce(v_staff.discord_id,''),
    0,
    false,
    '',
    true,
    auth.uid(),
    auth.uid()
  )
  ON CONFLICT (staff_id) DO UPDATE SET
    team = EXCLUDED.team,
    hierarchy_level = CASE WHEN EXCLUDED.team = 'leadership' THEN EXCLUDED.hierarchy_level ELSE public.entertainment_roster.hierarchy_level END,
    display_name = CASE
      WHEN nullif(trim(public.entertainment_roster.display_name),'') IS NULL
        OR lower(trim(public.entertainment_roster.display_name)) = 'discord user'
      THEN EXCLUDED.display_name
      ELSE public.entertainment_roster.display_name
    END,
    discord_id = EXCLUDED.discord_id,
    active = true,
    updated_by = auth.uid(),
    updated_at = now();

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.allocate_approved_entertainment_staff(uuid,text) TO authenticated;

-- Allow Director/Management roster editing to move a row into or out of Leadership.
CREATE OR REPLACE FUNCTION public.update_entertainment_roster_member(
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
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  caller_rank integer;
  target_rank numeric;
BEGIN
  caller_rank := public.kng_schedule_access_rank();
  IF caller_rank < 2 THEN
    RAISE EXCEPTION 'You do not have permission to edit the entertainment roster.';
  END IF;
  IF p_team NOT IN ('actions','interactions','leadership') THEN
    RAISE EXCEPTION 'Invalid team.';
  END IF;
  IF p_team = 'leadership' AND caller_rank < 5 THEN
    RAISE EXCEPTION 'Only a Director can allocate someone to KNG Leadership.';
  END IF;
  IF p_hierarchy_level NOT IN ('director','manager','culture_manager','entertainment_resp','adm','aux','ld','sub_ld','member') THEN
    RAISE EXCEPTION 'Invalid hierarchy level.';
  END IF;

  target_rank := CASE p_hierarchy_level
    WHEN 'director' THEN 4
    WHEN 'manager' THEN 3
    WHEN 'culture_manager' THEN 3
    WHEN 'entertainment_resp' THEN 2.5
    WHEN 'adm' THEN 2
    WHEN 'aux' THEN 2
    WHEN 'ld' THEN 1
    WHEN 'sub_ld' THEN 1
    WHEN 'member' THEN 1
    ELSE 99
  END;
  IF target_rank >= caller_rank THEN
    RAISE EXCEPTION 'You can only assign roster levels below your own access level.';
  END IF;
  IF coalesce(p_strikes,0) < 0 OR coalesce(p_strikes,0) > 3 THEN
    RAISE EXCEPTION 'Strikes must be between 0 and 3.';
  END IF;

  SELECT * INTO r FROM public.entertainment_roster WHERE id=p_roster_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Roster member not found.'; END IF;

  UPDATE public.staff
  SET name=coalesce(nullif(trim(p_name),''),name),
      discord_id=nullif(trim(p_discord_id),''),
      active=true
  WHERE id=r.staff_id;

  UPDATE public.entertainment_roster
  SET display_name=coalesce(nullif(trim(p_name),''),display_name),
      discord_id=nullif(trim(p_discord_id),''),
      team=p_team,
      hierarchy_level=p_hierarchy_level,
      kng_id=nullif(trim(p_kng_id),''),
      strikes=coalesce(p_strikes,0),
      mentor=coalesce(p_mentor,false),
      notes=nullif(trim(p_notes),''),
      active=true,
      updated_by=auth.uid(),
      updated_at=now()
  WHERE id=p_roster_id;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_entertainment_roster_member(uuid,text,text,text,text,text,integer,boolean,text) TO authenticated;

NOTIFY pgrst, 'reload schema';
