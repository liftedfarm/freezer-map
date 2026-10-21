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

Never put the service role key or the Azure client secret in Vercel or in the code.

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
