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

## Processing: dry flower (047)

Run `supabase/047_processing.sql`. It adds the Processing module (Off / View / User / Admin), a product on every pallet
(fresh frozen, wet, unbucked, bucked, standards, smalls, trim), 4 reefer trailers at GVR (R1-R4, 26 spots each, processor license),
processors (CCP, STACS, Strong Ag, our trailers), bucking and trimming runs, trim requests, and dry products on sales orders.

- Drying: dry harvest > wet package (raw wet weight + METRC tag) > sent to a processor or dried in house > back unbucked (not weighed).
- Runs: bucking takes whole unbucked packages and makes bucked + buck trim + mold; moisture = wet - everything out. Trimming takes bucked
  (whole or part) and makes standards, smalls, trim + mold. Outputs land as "Needs a spot" packages (D + last digits of the tag).
- Requests: what to trim and by when (customer or stock). Packages get committed to confirmed order lines from Inventory (whole, or split).
- "Fill next tags" uses tag ranges with purpose "Processing packages" (Admin > Settings > Licenses).
- The open menu, reserves and fresh frozen numbers only count fresh frozen.

## Piece rate pay (048)

Run `supabase/048_piece_rate.sql`, then `supabase/import_piece_fl25.sql` (FL25 history from the workbook; built by `tools/import_piece_fl25.py`).

- Processing > Crew: the crew lead logs each person's day (hours, flower lbs, mold, smalls, trim) against a run or a strain, in English or Spanish.
  Productivity by person and by strain (lbs/hr, days at target, labor cost per lb).
- Rule from the FL25 workbook: if flower lbs / hours reaches the target, pay every flower lb x the rate; otherwise no piece pay that day.
  Bucking $3/lb at 2 lb/hr, trimming $10/lb at 0.75 lb/hr (rates with start dates in Accounting > Settings > Crew and piece rates).
- Accounting > Payroll: bi-weekly periods (from 12/22/2025), per person by task and farm, adjustments with a reason, close (locks the lines),
  CSV for payroll, mark sent to payroll. Accounting Admins can reopen.

## Processing, simpler flow (049)

Run `supabase/049_processing_flow.sql`. Each package's sheet (Processing › Inventory) shows its next steps: Put in a trailer, Buck (straight from wet too),
Send to processor (prints a manifest sheet), Back unbucked, Trim, Sell as bucked, Commit to an order. Forecasts per strain (this strain's runs + FL25 Totals,
then all strains, then a default wet-to-bucked % in Settings). Forecast standards / smalls / trim can be promised from bucked packages only; when the package
is trimmed, the real packages go on the order automatically. Available shows what's free to sell per strain. Yields show labor $/lb per strain.

## Compliance (055)

Run `supabase/055_compliance.sql`. It adds the Compliance module (Off / View / User / Admin; Beth = Admin), a private storage
bucket `compliance` for documents, the document library (types = SharePoint folders), deadlines, CCOF approval on the
Production and Nursery product lists, the application log (from the Feed and Spray logs), a METRC to-do queue fed by the
activity log, METRC Active Packages reconciliation, a METRC error log and playbook, results files on Production > Testing
entries (shown on every package from that harvest), and customer license expiry.

SharePoint backup (`api/compliance/backup.js`, nightly at 3:17am Pacific, or Run now in Compliance > Settings):
an Entra app with the Microsoft Graph application permission `Sites.Selected` and write access to the one site, then in Vercel
`MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` (plus `SUPABASE_SERVICE_ROLE_KEY`). Set the site and top folder in the app.
