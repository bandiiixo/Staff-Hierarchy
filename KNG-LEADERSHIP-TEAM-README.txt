KNG LEADERSHIP TEAM

This update adds a separate KNG Leadership allocation alongside Actions and Interactions. It is intended for Director, Management, Entertainment Resp, ADM and AUX-level accounts.

Deploy the website files to Render, then run KNG-LEADERSHIP-TEAM-ALLOCATION-PATCH.sql in Supabase SQL Editor.

Leadership allocation is Director-only. AUX+ can continue allocating eligible approved staff to Actions or Interactions. The Leadership roster appears as its own section in Staff Roster for management-level viewers and is not duplicated into the Actions/Interactions team lists.

The Leadership assignment uses the existing single entertainment_roster row per staff member; moving a person to Leadership moves that row rather than creating a duplicate. Their existing site access is not changed by allocation.
