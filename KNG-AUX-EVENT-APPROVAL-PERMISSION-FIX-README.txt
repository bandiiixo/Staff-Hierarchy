KNG AUX EVENT APPROVAL PERMISSION FIX

WHY THIS IS NEEDED
The website checks AUX+ correctly, but the deployed Supabase role-rank function
was overwritten by a later migration that omitted the AUX role. The later
migration's staff_access constraint also omitted AUX. This caused the approval
modal to open in the website but Supabase to reject the approval RPC.

WHAT TO DO
1. Open Supabase Dashboard -> SQL Editor.
2. Open and run KNG-AUX-EVENT-APPROVAL-PERMISSION-FIX.sql.
3. Refresh the KNG Schedule website (Ctrl + Shift + R).
4. Sign in as an AUX account and retry the event approval.

EXPECTED PERMISSION RANKS
Member: 1
AUX: 2
ADM: 3
Entertainment Resp / Culture Manager / Manager: 4
Director: 5

This patch does not alter event submissions, existing events, or staff
assignments. It corrects the stored role constraint and the database permission
rank function. No website redeployment is required for this specific fix.

If the AUX account still fails after the patch, inspect its active row in
public.staff_access and confirm access_level = 'aux' and active = true.
