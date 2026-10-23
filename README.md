# Freezer Map

Freezer inventory app for Lifted Farms (OHR and GVR). Tracks where every pallet is, who moved it and when.
This is for inventory tracking only. BC and METRC stay the systems of record.

- `src/`, `index.html`, `package.json`: the app (React + Vite), hosted on Vercel. Every push to `main` deploys automatically.
- `supabase/schema.sql`: database tables, security rules and actions
- `supabase/seed.sql`: starting data generated from Freezer Map 26.xlsm
- `tools/build_seed.py`: regenerates seed.sql from the workbook

## Phase 1 (this version)

- Sign in with Microsoft (Lifted accounts only)
- Freezer map for OHR and GVR, colored by strain, with fill and lbs per freezer
- Freezer detail: 2 x 9 layout, back at the top, door at the bottom
- Move a pallet: tap it, tap Move, open any freezer, tap a slot. Occupied slots can be combined.
- Take out to staging, and place from staging later
- Freezer status (On, Off, Needs Attention, Not Working). Not Working freezers can't receive pallets.
- Search by pallet number, strain or METRC tag (includes older pallets no longer in a freezer)
- Pallet history and a full activity log with who did what
- Review list: problems found in the spreadsheet during import (duplicates, items not in the pallet list, missing strain or weight)
- Live updates: when someone moves a pallet, everyone sees it

## Database updates (run in order in the Supabase SQL Editor)

`supabase/schema.sql`, `seed.sql`, then `002_split_merge.sql`, `003_settings.sql`, `004_strain_cleanup.sql`, `005_mixed_pallets.sql`, `006_loads.sql`. Each is safe to re-run.

## One-time setup

### 1. Database (Supabase SQL Editor)
1. Supabase > SQL Editor > New query. Paste all of `supabase/schema.sql`, Run.
2. New query. Paste all of `supabase/seed.sql`, Run. (Running seed.sql again wipes and reloads everything, including history. Only do it to start over.)

### 2. Lock down login (Supabase)
1. Authentication > Sign In / Providers > **Email**: turn it off. Otherwise anyone could create an email login and see inventory. Azure stays on.
2. Authentication > URL Configuration: set **Site URL** to the Vercel address (e.g. `https://freezer-map.vercel.app`) and add the same address under **Redirect URLs**.

### 3. Hosting (Vercel)
1. Put this folder in a GitHub repo (or upload it with GitHub's "Add file > Upload files").
2. Vercel > Add New > Project > import the repo.
3. **Root Directory**: `./` (repo root). Framework: Vite (auto-detected).
4. Environment Variables (from Supabase > Project Settings > API, or already added by the Vercel Supabase integration):
   - `VITE_SUPABASE_URL` = the project URL
   - `VITE_SUPABASE_ANON_KEY` = the anon / publishable key (safe for the browser; the database rules do the protecting)
5. Deploy.

Never put the service role key or the Azure client secret in the code, or in any VITE_ variable (those go to the browser). The one exception: `SUPABASE_SERVICE_ROLE_KEY` (no VITE_ prefix) is set in Vercel for the QuickBooks server functions in `api/qbo/`, which never send it to the browser.

## Local preview with demo data

```
npm install
npm run dev
```
Open http://localhost:5173/?demo. Demo mode uses a snapshot of the workbook and saves nothing.

## Next phases
2. Split (new METRC tag required, "tag pending" allowed), combine, weight adjust
3. Orders and Roshi pick list import, pick suggestions by front rank
4. Harvest table upload, scheduled Excel report to SharePoint

## Accounting: QuickBooks Online (046)

Run `supabase/046_accounting.sql`. Then in Vercel > Settings > Environment Variables:

- `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`: from the Intuit developer app (Development keys for the sandbox, Production keys for the real company)
- `QBO_ENV`: `sandbox` or `production`
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase > Project Settings > API Keys (server only)
- optional `CRON_SECRET` (the nightly payment check in `vercel.json` sends it), `QBO_REDIRECT_URI` (default `https://freezer-map-8i3h.vercel.app/api/qbo/callback`)

The redirect URI must also be listed in the Intuit app (Settings > Redirect URIs). An Accounting Admin connects in Accounting > Settings.
Server functions: `api/qbo/connect.js` (start sign-in), `callback.js` (Intuit sends the browser back), `run.js` (status, push, sync, check, setup, disconnect), `cron.js` (nightly balances).
