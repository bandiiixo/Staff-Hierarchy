-- KNG Hall of Fame: link entries to the actual staff record and Discord ID.
-- Safe to run once; IF NOT EXISTS makes it repeatable.
ALTER TABLE public.ix_hall_of_fame
  ADD COLUMN IF NOT EXISTS winner_staff_id uuid NULL,
  ADD COLUMN IF NOT EXISTS winner_discord_id text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ix_hall_of_fame_winner_staff_id_fkey'
      AND conrelid = 'public.ix_hall_of_fame'::regclass
  ) THEN
    ALTER TABLE public.ix_hall_of_fame
      ADD CONSTRAINT ix_hall_of_fame_winner_staff_id_fkey
      FOREIGN KEY (winner_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_hall_of_fame_winner_staff_id_idx
  ON public.ix_hall_of_fame (winner_staff_id);
CREATE INDEX IF NOT EXISTS ix_hall_of_fame_winner_discord_id_idx
  ON public.ix_hall_of_fame (winner_discord_id);

NOTIFY pgrst, 'reload schema';
