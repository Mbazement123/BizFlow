# Sales + Services app: Vercel (frontend) + Render backend + PostgreSQL

Same app, same PIN sign-in, same Sales and Services screens, same business rules.
Only the database changes: Google Sheets → PostgreSQL.

```
frontend/   -> Vercel        (plain HTML, CSS and JavaScript, no build step)
backend/    -> Render        (Node.js + Express)
  src/        business logic (Sales, Services, router) backed by PostgreSQL
  db/         schema + one-time Google Sheets importer
  gas/        the ORIGINAL .gs files, kept for reference only
```

## How it works (short version)

1. The phone opens the Vercel site. It looks and behaves like the Apps Script pages did.
2. Every button that used to call Apps Script now sends one request to your Render API.
3. The API reads/writes PostgreSQL (one request at a time, so simultaneous saves never clash).
4. PIN routing, FIFO stock, phone-as-unique-customer, discounts and reports are all unchanged.

---

## Step 1: Create the PostgreSQL database

Use Railway (or Neon / Supabase). Create a database and copy its connection string.

Example: `postgresql://user:password@host:5432/database?sslmode=require`

Set it as `DATABASE_URL` on Render (Step 3).

## Step 2: Put the project on GitHub

Create a repository and upload this whole folder (`backend/`, `frontend/`, `render.yaml`, ...).

## Step 3: Deploy the backend on Render

1. https://render.com > **New > Web Service** > connect the GitHub repo.
   (Or **New > Blueprint** to use `render.yaml`.)
2. If you set it up by hand: **Root Directory** `backend`, **Build** `npm install`, **Start** `node server.js`.
3. **Environment variables**:

| Name | Value |
|---|---|
| `DATABASE_URL` | your PostgreSQL connection string |
| `ALLOWED_ORIGINS` | your Vercel address, e.g. `https://my-app.vercel.app` (comma separated, no trailing slash). Fill this in after Step 4. |
| `ADMIN_TOKEN` | any long random text (only needed to set up new Services businesses) |
| `TZ_NAME` | `Africa/Lagos` |

4. Deploy. Open `https://YOUR-SERVICE.onrender.com/health`. It should say `{"ok":true}`.

## Step 4: Deploy the frontend on Vercel

1. Open `frontend/js/config.js` and set `API_BASE` to your Render address (no trailing slash). Commit.
2. https://vercel.com > **Add New > Project** > pick the repo > set **Root Directory** to `frontend` > Deploy.
   (Framework preset: **Other**. No build command.)
3. Copy your Vercel address into Render's `ALLOWED_ORIGINS`, then redeploy Render.

Done. Sign in with a business PIN exactly as before. Existing links keep working
(`/?b=PIN`, `/?app=sales&b=PIN`).

---

## Migrating your existing Google Sheets data (one time)

If you have businesses already in Google Sheets, copy them into PostgreSQL:

1. Keep your service account key (from the old setup) with Editor access to the registry and every business sheet.
2. Set `GOOGLE_SERVICE_ACCOUNT_JSON` and `REGISTRY_SHEET_ID` locally, then run:

```
cd backend
npm install
npm run migrate          # creates the tables
npm run migrate:import    # copies every business's sheets into PostgreSQL
```

The importer is safe to re-run (it upserts by business + row ID) and seeds the ID
sequences to continue after your existing IDs, so you never get duplicate numbers.

> Note: `googleapis` is an optional dependency used only by the importer. You can remove it
> (and `db/import.js`) after migrating if you prefer a smaller production image.

## Day-to-day

**Add a business:** insert a row into the `businesses` table (code, name, app, active). For a new
Services business, run the one-time setup:

```
curl -X POST https://YOUR-SERVICE.onrender.com/admin/setup \
  -H "Content-Type: application/json" -H "x-admin-token: YOUR_ADMIN_TOKEN" \
  -d '{"code":"THE-BUSINESS-CODE"}'
```

**Switch a business off:** set `active = FALSE` in `businesses`.

**Run the checks:** `cd backend && npm install && npm test` (needs `DATABASE_URL`; uses an isolated
test code and cleans up after itself).

---

## What is different from the Google Sheets version

| | Before (Sheets) | Now (PostgreSQL) |
|---|---|---|
| Database | one spreadsheet per business | normalized tables, scoped by `business_id` |
| ID counters | `Next...No` Config rows | Postgres **sequences** (race-free, never duplicated) |
| Concurrent saves | script lock | per-business in-process queue + transactions |
| Save atomicity | all-or-nothing batchUpdate | SQL **transaction** (rollback on error) |
| Save PDF copy to Google Drive (Sales) | saved to Drive | **Save PDF Copy** downloads to the device |
| Receipt PDF | made by Google | made by the server (`backend/src/pdf.js`), same layout, 80 mm |
| Free Render server | sleeps after idle | same |
| Wrong-PIN guesses | unlimited | rate-limited (30/min) |
| SQL injection | n/a | prevented with parameterized queries everywhere |
| Instances | one | run **one** Render instance (keeps the in-memory queue) |

## Security

- All queries use parameterized statements (no string-built SQL except fixed, non-user fragments).
- PIN checks and `/api/call` are rate-limited.
- `ADMIN_TOKEN` gates one-time setup; CORS is restricted via `ALLOWED_ORIGINS`.
- `.env` is git-ignored; never commit `DATABASE_URL` or secrets. `.env.example` holds placeholders only.

## Honest status

Business logic was ported faithfully from the original `gas/*.gs` (PIN routing, FIFO stock layers,
phone-key customer matching, percentage discounts, ID codes, reports). The test suite (`backend/test/run.js`)
covers the same flows end-to-end against a real PostgreSQL database.

Before going live, do this smoke run:

1. `/health` opens. 2. Sign in with a PIN. 3. Add a customer and a sale in each app.
4. Print a receipt, then **Share/Save PDF**. 5. Confirm the row is in PostgreSQL.
6. Open the app on two phones and save at the same time.
