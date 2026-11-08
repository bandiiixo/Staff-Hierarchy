KNG ENTERTAINMENT - COMPLETE INTEGRATED BUILD

This pack keeps the KNG Schedule red/black theme and background, the KNG Estate Roleplay Hall of Fame frame system, the existing schedule, Discord login, operations, prizes/commands, access hierarchy and the integrated interaction tools.

FILES TO UPLOAD TO YOUR REPO
- index.html
- supabase.js
- app.js
- style.css
- kng-background.png
- kng-hof-original.png
- kng-hof-gold.png
- kng-hof-emerald.png
- kng-hof-ocean.png
- kng-hof-sunset.png
- kng-hof-pink.png
- kng-hof-grey-scale.png
- hof-frame-source-original.png

DATABASE
- Run KNG-ENTERTAINMENT-COMPLETE-MIGRATION.sql ONCE in the Supabase SQL Editor.
- This migration is intended to repair the missing schema used by the site and is re-runnable.
- It adds the event completion/attendance/winner fields, public feedback and suggestions, the Actions/Interactions roster, crashout protection, hungry-pool claim RPCs, prize commands, Hall of Fame permissions and the requested Party/Event/Battle Royale/Community Meeting/Staff Meeting event types.

IMPORTANT BEHAVIOUR
- Events do NOT auto-complete. Staff must open a passed event, enter attendance, optionally enter the winner, then confirm completion.
- Completed events show attendance and winner on the calendar and feed the most/least popular event leaderboards.
- Meetings are separate from event statistics. Only Managers and Directors can create meetings.
- Community Meeting is configured as a fortnightly recurring staff-only meeting series when no existing series is present.
- Daily Goal target changes are Director-only.
- Announcements and Logs are no longer navigation tabs.
- Event feedback and event suggestions are public. The Event Suggestions forum is public.
- Actions/Interactions roster allocation is one-side-only per staff member.
- Roster uses the KNG-style hierarchy: Director, Manager Of Actions/Interactions, ADM, AUX, LD, Sub-LD, Member, with ALOPA, Mentor, Strikes, Notes, Promote, Edit and Delete controls.
- Export to Discord generates a copyable KNG-style hierarchy output.
- Prize command default: /giveitem {discord_id} {code} {amount}
- Crashout protection defaults to 3 removals in 60 minutes, then a 30-minute timeout. Directors can change these limits in Security.

DEPLOYMENT
1. Replace the files above in the repo.
2. Keep the existing Render/Supabase deployment settings.
3. Commit and push to GitHub so Render redeploys.
4. Run the SQL migration in Supabase.
5. Hard refresh the website (Ctrl+F5).

LAYOUT PATCH 30 OCT 2026
- Restored the crown mark in the top-left KNG header badge.
- Reordered navigation into Public/Community, Staff, then Operations.
- Removed stale Announcements/Logs navigation states.
- Fixed the Month calendar markup to use the existing month-cell styling so dates/events render at the intended size.
- The supplied migration already normalises legacy event types F3/BR/Meeting/Large Action to Party/Battle Royale/Community Meeting/Event.
