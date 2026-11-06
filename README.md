# KNG Estate Organisation Chart

A shared KNG Estate hierarchy with public viewing and management-only editing.

## What is fixed in this version

- The page now connects to the Node/Express API instead of saving edits only in one browser.
- Management login is visible in the page.
- Once signed in, Management can click a position to edit it, add positions, change reporting lines, delete positions, import/export backups, and reset the starter structure.
- All successful changes are saved on the server and shown to every visitor.
- Visitors without the management password can view the chart but cannot edit it.
- Render is configured as a Node web service with a persistent disk. The previous static-site configuration could not run the API at all.

## Deploy on Render

1. Upload the contents of this folder to the GitHub repository used for the hierarchy.
2. In Render, open the existing `kng-estate-hierarchy` service.
3. Change it to a **Web Service** using the Node runtime, or create a new Web Service from this repository.
4. Build command: `npm install`
5. Start command: `npm start`
6. Add environment variables:
   - `ADMIN_PASSWORD`: a strong, unique password of at least 12 characters. Share it only with the people who manage the hierarchy.
   - `SESSION_SECRET`: a random secret of at least 32 characters. Keep it private.
7. Ensure a persistent disk is mounted at `/opt/render/project/src/data`. The supplied `render.yaml` requests a 1 GB disk on the Starter plan.
8. Deploy and test `https://YOUR-SERVICE.onrender.com/api/health`. It should return `{"ok":true,"service":"kng-estate-org-chart"}`.

## Editing

1. Open the hierarchy website.
2. Click **Management login** and enter `ADMIN_PASSWORD`.
3. Click **Edit chart** to add a position, or click any existing position to edit it.
4. Save changes. They are stored centrally on the server, not just in the current browser.

## Important

- This is a separate hierarchy website, not the KNG staff portal login. It uses its own management password.
- Do not use a Static Site deployment for this version. Static hosting cannot run `server.js` or save shared changes.
- Do not commit real passwords or session secrets into GitHub. Add them in Render's Environment settings.
- The persistent disk is essential. Without it, stored hierarchy changes can be lost when the service restarts or redeploys.
