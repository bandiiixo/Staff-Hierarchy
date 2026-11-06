# KNG Staff Management Portal (Supabase edition)

This is the Supabase-backed KNG staff portal. It includes Discord OAuth login, Management-controlled
team ADM permissions, shared roster storage, bot-free staff lookup, and an editable organisation chart.

## Teams
Gangs, Legal, Actions, Interactions, Calls, Order, Knowledge, Discord, Tickets, WallStreet.

## Permission model
- **Management**: Discord IDs listed in `config.js` have global access to all teams, roster edits, staff permission allocation/revocation, and organisation chart editing.
- **Team ADM**: Management assigns one or more team permissions to a Discord account. An ADM can edit only the assigned team rosters.
- **Other staff**: can sign in and view team rosters but cannot edit unless granted team ADM access.
- Permission checks happen in the Node backend. Hiding a button in the browser is not treated as security.

## 1. Create the Supabase database
1. Open the Supabase project dashboard for the KNG project.
2. Go to **SQL Editor** -> **New query**.
3. Run the supplied `kng_supabase_schema.sql` file.
4. Confirm the `teams` table contains the 10 teams and that the other tables/functions were created.

The schema creates `teams`, `staff_profiles`, `team_permissions`, `team_members`, `organisation_chart`,
`portal_settings`, and `permission_audit_log`, plus the server-only RPC functions used for atomic roster,
permission and organisation-chart updates.

## 2. Configure `config.js`
Open `config.js` in the project root. Fill in the values below. Do not put this file inside `public/`.

- `discord.clientId`: Discord OAuth application Client ID.
- `discord.clientSecret`: Discord OAuth application Client Secret.
- `discord.redirectUri`: `https://YOUR-SERVICE.onrender.com/auth/discord/callback` (replace with your actual Render URL).
- `discord.sessionSecret`: a randomly generated secret of at least 32 characters. Keep it private.
- `discord.managementDiscordIds`: an array of Discord user IDs that should have global Management access, for example `['123456789012345678']`.
- `supabase.url`: already set to `https://aevjkzbfjjctfxcfjsjv.supabase.co`.
- `supabase.secretKey`: the Supabase **secret key** for that same project. Do not use the publishable key here.

The publishable key is not needed by this version of the portal. The browser talks to the Express backend;
the backend talks to Supabase using the server-only secret key. Supabase Auth is not used because login is
handled by Discord OAuth and the portal's signed session cookie.

**Security:** `config.js` contains highly sensitive credentials. Keep the GitHub repository private, limit
repository access to trusted people, and never copy these values into `public/`, browser JavaScript, screenshots,
or support messages. Anyone with the Supabase secret key can bypass normal Row Level Security protections.
If you do not want secrets stored in a private repository, use a server-side secret-file facility instead.

## 3. Discord setup
1. In Discord Developer Portal -> Applications -> your app -> OAuth2, add the exact redirect URI from `config.js`.
2. Copy the Client ID and Client Secret into `config.js`.
3. The OAuth flow requests the `identify` scope.
4. No Discord bot or server installation is required. Staff appear in the directory after their first portal login; managers can also enter a Discord user ID manually.
6. Add your own Discord user ID to `managementDiscordIds` before the first login.

## 4. Deploy
1. Push this project folder to your **private** GitHub repository. Ensure `config.js` is included in the deployment.
2. Create/use a Render **Web Service**, not a Static Site.
3. Build command: `npm install`.
4. Start command: `npm start`.
5. Deploy. The supplied `render.yaml` contains the basic service configuration.

A Render persistent disk is not required for application data because rosters, permissions, profiles and chart
data are stored in Supabase.

## 5. First login and Management bootstrap
1. Confirm your Discord ID is listed in `config.js` under `managementDiscordIds`.
2. Confirm the service has deployed successfully.
3. Log in using that Discord account.
4. Open **Management** -> **Staff & Permissions**.
5. Search for staff who have logged in, or enter a Discord user ID manually, then allocate one or more team ADM permissions. No Discord bot is required.
6. The target account can then log in with Discord and edit only its assigned team rosters.

The `managementDiscordIds` array in `config.js` is the source of truth for global Management access. The
`staff_profiles.is_management` field is updated after login for reference, but the backend never trusts a
browser-supplied Management flag.

## 6. Data and security notes
- The website uses a signed Discord OAuth session cookie. Supabase Auth is not used.
- RLS is enabled on all application tables; no direct `anon` or `authenticated` policies are added.
- All database access goes through the Express backend using the Supabase secret key.
- Every management, roster and chart API route performs a server-side permission check.
- `permission_audit_log` records roster, permission and organisation-chart changes.
- The SQL schema starts with empty team rosters. Existing JSON-file roster data is not automatically imported.
- Back up any existing JSON data before switching. Existing records must be imported into the matching Supabase
  tables before removing the old deployment.
