-- KNG ACCESS CONSTRAINT REPAIR
-- Fixes the existing staff_access check constraint BEFORE any roster sync can write AUX.
-- Run this FIRST after the failed KNG role/actions patch.
-- Do NOT rerun the giant original migration.

-- =========================================================
-- PHASE 1: FIX THE CONSTRAINT AND COMMIT IT SEPARATELY
-- =========================================================
BEGIN;

ALTER TABLE public.staff_access
  DROP CONSTRAINT IF EXISTS staff_access_access_level_check;

-- Existing legacy values are still valid. Anything unexpected becomes member.
UPDATE public.staff_access
SET access_level = 'member'
WHERE access_level IS NULL
   OR access_level NOT IN ('member','aux','adm','manager','director');

ALTER TABLE public.staff_access
  ADD CONSTRAINT staff_access_access_level_check
  CHECK (access_level IN ('member','aux','adm','manager','director'));

COMMIT;

-- =========================================================
-- PHASE 2: INSTALL THE ROSTER -> SITE ACCESS SYNC
-- This is deliberately AFTER the constraint commit.
-- =========================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.sync_entertainment_roster_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  discord text;
  target_user uuid;
  mapped_level text;
BEGIN
  SELECT COALESCE(NULLIF(TRIM(NEW.discord_id), ''), s.discord_id)
    INTO discord
  FROM public.staff s
  WHERE s.id = NEW.staff_id;

  IF discord IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT i.user_id
    INTO target_user
  FROM auth.identities i
  WHERE i.provider = 'discord'
    AND i.provider_id = discord
  ORDER BY i.created_at DESC
  LIMIT 1;

  IF target_user IS NULL THEN
    RETURN NEW;
  END IF;

  mapped_level := CASE
    WHEN NEW.active = false THEN 'member'
    WHEN LOWER(COALESCE(NEW.hierarchy_level, '')) = 'director' THEN 'director'
    WHEN LOWER(COALESCE(NEW.hierarchy_level, '')) = 'manager' THEN 'manager'
    WHEN LOWER(COALESCE(NEW.hierarchy_level, '')) = 'adm' THEN 'adm'
    WHEN LOWER(COALESCE(NEW.hierarchy_level, '')) = 'aux' THEN 'aux'
    ELSE 'member'
  END;

  INSERT INTO public.staff_access(user_id, access_level, active)
  VALUES (target_user, mapped_level, true)
  ON CONFLICT (user_id) DO UPDATE
    SET access_level = EXCLUDED.access_level,
        active = true,
        updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entertainment_roster_access_sync
ON public.entertainment_roster;

CREATE TRIGGER entertainment_roster_access_sync
AFTER INSERT OR UPDATE OF hierarchy_level, discord_id, active, staff_id
ON public.entertainment_roster
FOR EACH ROW
EXECUTE FUNCTION public.sync_entertainment_roster_access();

-- Backfill existing linked roster members.
-- The constraint is already committed, so AUX can now be inserted safely.
INSERT INTO public.staff_access(user_id, access_level, active)
SELECT DISTINCT ON (i.user_id)
  i.user_id,
  CASE LOWER(COALESCE(er.hierarchy_level, ''))
    WHEN 'director' THEN 'director'
    WHEN 'manager' THEN 'manager'
    WHEN 'adm' THEN 'adm'
    WHEN 'aux' THEN 'aux'
    ELSE 'member'
  END,
  true
FROM public.entertainment_roster er
JOIN public.staff s
  ON s.id = er.staff_id
JOIN auth.identities i
  ON i.provider = 'discord'
 AND i.provider_id = s.discord_id
WHERE er.active = true
ORDER BY i.user_id, er.updated_at DESC NULLS LAST
ON CONFLICT (user_id) DO UPDATE
SET access_level = EXCLUDED.access_level,
    active = true,
    updated_at = now();

NOTIFY pgrst, 'reload schema';

COMMIT;

-- =========================================================
-- VERIFICATION
-- =========================================================
SELECT access_level, COUNT(*) AS staff_count
FROM public.staff_access
GROUP BY access_level
ORDER BY CASE access_level
  WHEN 'member' THEN 1
  WHEN 'aux' THEN 2
  WHEN 'adm' THEN 3
  WHEN 'manager' THEN 4
  WHEN 'director' THEN 5
  ELSE 99
END;
