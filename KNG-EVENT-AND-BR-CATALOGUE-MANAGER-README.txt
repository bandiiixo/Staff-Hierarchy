KNG EVENT & BR CATALOGUE MANAGER

Deploy this website ZIP to Render, then run KNG-EVENT-AND-BR-CATALOGUE-MANAGER-PATCH.sql once in Supabase SQL Editor.

Where to manage the lists:
- INTERACTIONS workspace > Host an Event > Manage Activity Names. This manages the named scheduled activity list.
- ACTIONS workspace > BR Tracker > Manage BR Names. This manages the BR formats list.

Both controls are ADM+ only. The lists are shared across staff accounts. Removing a name deactivates it for future dropdowns; existing scheduled events and tracker records remain unchanged.

The SQL patch creates and seeds the editable Host an Event catalogue. BR names continue to use the existing kng_action_types table (kind='br').
