-- KNG Entertainment roster/name + leaderboard fix
-- Run this AFTER the existing KNG Entertainment migration.
-- This does NOT remove or alter events, claims, prizes, commands, permissions, or other systems.

-- Store the name shown on the Actions/Interactions roster itself.
-- This prevents roster display names being dependent on the separate staff table.
alter table public.entertainment_roster
  add column if not exists display_name text;

-- Backfill existing roster entries from the current staff name.
update public.entertainment_roster er
set display_name = coalesce(nullif(er.display_name, ''), s.name)
from public.staff s
where s.id = er.staff_id
  and (er.display_name is null or btrim(er.display_name) = '');

-- Keep the schema cache fresh.
notify pgrst, 'reload schema';
