-- KNG team points: separate team ledgers, team-visible leaderboards,
-- management-only point awards/removals. Safe to run more than once.

ALTER TABLE public.ops_points
  ADD COLUMN IF NOT EXISTS team text;

-- Attribute existing point entries to the staff member's current roster team.
UPDATE public.ops_points p
SET team = lower(er.team)
FROM public.entertainment_roster er
WHERE er.staff_id = p.staff_id
  AND p.team IS NULL
  AND lower(er.team) IN ('actions','interactions');

-- Legacy entries with no current roster match are kept in Interactions
-- rather than being discarded. Management can correct these individually later.
UPDATE public.ops_points
SET team = 'interactions'
WHERE team IS NULL OR lower(team) NOT IN ('actions','interactions');

ALTER TABLE public.ops_points
  ALTER COLUMN team SET DEFAULT 'interactions',
  ALTER COLUMN team SET NOT NULL;

ALTER TABLE public.ops_points
  DROP CONSTRAINT IF EXISTS ops_points_team_check;
ALTER TABLE public.ops_points
  ADD CONSTRAINT ops_points_team_check
  CHECK (team IN ('actions','interactions'));

CREATE INDEX IF NOT EXISTS ops_points_team_created_idx
  ON public.ops_points(team, created_at DESC);

-- Staff can read the points leaderboard for their own team.
-- Cross-team management roles can read both via the existing helper.
DROP POLICY IF EXISTS ops_points_read ON public.ops_points;
CREATE POLICY ops_points_read
  ON public.ops_points
  FOR SELECT
  TO authenticated
  USING (public.can_use_entertainment_team(team));

-- Only authorised management can award or remove points.
DROP POLICY IF EXISTS ops_points_write ON public.ops_points;
CREATE POLICY ops_points_write
  ON public.ops_points
  FOR INSERT
  TO authenticated
  WITH CHECK (public.kng_schedule_can_manage());

NOTIFY pgrst, 'reload schema';
