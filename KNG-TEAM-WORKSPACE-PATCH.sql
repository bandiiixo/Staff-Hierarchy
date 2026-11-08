-- KNG TEAM WORKSPACE ACCESS PATCH
-- Run this AFTER KNG-ENTERTAINMENT-COMPLETE-FINAL-MIGRATION.sql
-- Purpose: allow authenticated KNG staff to read the shared Actions / Interactions
-- roster so team-aware dashboards can determine a member's workspace.
-- Write access remains ADM+ through the existing policy.

drop policy if exists entertainment_roster_read on public.entertainment_roster;

create policy entertainment_roster_read
on public.entertainment_roster
for select
to authenticated
using (true);

notify pgrst, 'reload schema';
