KNG SCHEDULING FUNCTIONAL FIXES

This update preserves the existing application and changes only the requested workflows:

1. Randomiser: fills every available slot in the selected time range. Existing scheduled,
   protected and overlapping events remain untouched. Randomised events are saved as
   workspace='interactions'.
2. Claims: the client now attempts the current two-argument claim RPC and falls back to
   the legacy one-argument RPC if the database only exposes that signature.
3. Event completion: any active Interactions roster member can open and submit completion
   for an Interactions event. Existing ADM+ edit/delete permissions remain unchanged.
4. Host an Event: Actions workspace events are excluded from the Interactions Host an Event
   planner and its slot-conflict checks. New planned/manual/randomised events are tagged
   workspace='interactions'.

SUPABASE STEP REQUIRED:
Run KNG-INTERACTIONS-EVENT-COMPLETION-PERMISSION-PATCH.sql in Supabase SQL Editor.
This adds the RLS permission needed for Interactions roster members to save completion.

Then deploy the updated app.js and other files in this ZIP to Render.

No existing tables, historical events, catalogue entries, roster records, or unrelated
features have been deleted or intentionally changed.
