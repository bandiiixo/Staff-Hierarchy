KNG Event Ideas Moderation Update

Changes:
- AUX+ can permanently delete Event Ideas from the forum.
- The website blocks prohibited language before posting.
- A database trigger also blocks prohibited language, including simple punctuation/space obfuscation.
- Public users cannot delete suggestions.
- Existing forum behaviour is preserved.

SQL:
Run KNG-EVENT-IDEAS-MODERATION-PATCH.sql once in Supabase.
Do not rerun the giant migration.
