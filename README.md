# Sales + Services app: Vercel (frontend) + Render (backend)

Same app, same Google Sheets, same PIN sign-in, same Sales and Services screens.
Nothing about how a business's data is stored changes: only where the code runs.

```
frontend/   -> Vercel   (plain HTML, CSS and JavaScript, no build step)
backend/    -> Render   (Node.js + Express)
  gas/        your ORIGINAL Router.gs, Sales.gs, Services.gs, running unchanged
  src/        adapter that lets that code talk to Google Sheets from Node
```

## How it works (short version)

1. The phone opens the Vercel site. It looks and behaves like the Apps Script pages did.
2. Every button that used to call Apps Script now sends one request to your Render API.
3. The API loads that business's spreadsheet, runs your original Sales/Services code on it,
   saves the changes to Google Sheets in one go, and sends the answer back.
4. Requests are handled one at a time, so 2-3 people saving together never clash.

---

## Step 1: Let the server open your spreadsheets (service account)

Apps Script used to open your sheets "as you". The server needs its own Google identity.

1. Go to https://console.cloud.google.com and create a project (any name).
2. **APIs & Services > Library** > search **Google Sheets API** > **Enable**.
3. **APIs & Services > Credentials > Create credentials > Service account**. Give it a name, finish.
4. Open the new service account > **Keys > Add key > Create new key > JSON**. A file downloads. Keep it private.
5. Open that JSON and copy the `client_email` (looks like `name@project.iam.gserviceaccount.com`).
6. In Google Sheets, **Share** with that email as **Editor**:
   - the registry spreadsheet (the one with the **Businesses** sheet), and
   - **every business spreadsheet** listed in it (Sales ones and Services ones).

> Every time you add a business, share its new spreadsheet with this email too.

## Step 2: Put the project on GitHub

Create a repository and upload this whole folder (`backend/`, `frontend/`, `render.yaml`, ...).

## Step 3: Deploy the backend on Render

1. https://render.com > **New > Web Service** > connect the GitHub repo.
   (Or **New > Blueprint** to use `render.yaml`.)
2. If you set it up by hand: **Root Directory** `backend`, **Build** `npm install`, **Start** `node server.js`.
3. **Environment variables**:

| Name | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the **whole** JSON key file, pasted as one value |
| `REGISTRY_SHEET_ID` | the ID of the spreadsheet that has the **Businesses** sheet (the long text between `/d/` and `/edit` in its address) |
| `ALLOWED_ORIGINS` | your Vercel address, e.g. `https://my-app.vercel.app` (add a custom domain too, comma separated). Fill this in after Step 4. |
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

## Day-to-day

**Add a business:** same as today. Add rows to the **Businesses** sheet (code, name, SheetID, Active, App),
and share that business's spreadsheet with the service account. For a new Services business, run the
one-time setup (this replaces `setupBusiness()` in the Apps Script editor):

```
curl -X POST https://YOUR-SERVICE.onrender.com/admin/setup \
  -H "Content-Type: application/json" -H "x-admin-token: YOUR_ADMIN_TOKEN" \
  -d '{"code":"THE-BUSINESS-CODE"}'
```

**Switch a business off:** put `NO` in Active. It takes up to 10 minutes to apply.

**Edit the sheet by hand:** fine. Changes show in the app within about 20 seconds, and any save
re-reads the sheet first, so manual edits are never overwritten.

**Run the checks:** `cd backend && npm install && npm test`.

---

## What is different from Apps Script (please read)

| | Before | Now |
|---|---|---|
| "Created by a Google Apps Script user" banner | shown | **gone** |
| Save PDF copy **to Google Drive** (Sales app) | saved to Drive | button is now **Save PDF Copy**: downloads the PDF to the device. Drive is not used. |
| Receipt PDF | made by Google | made by the server (`backend/src/pdf.js`), same layout, 80 mm wide |
| Free Render server | always on | **sleeps after ~15 min idle**; first request after a nap can take 30-60 s. Use a paid instance, or a free uptime monitor (e.g. UptimeRobot) that opens `/health` every 5 minutes. |
| Saving | each write applied as it ran | a save is **all or nothing**: if something fails, nothing is half-saved |
| Dates in new rows | locale default format | shown as `yyyy-mm-dd hh:mm:ss` (still real dates) |
| Who can use it | anyone with the link | same, plus a limit on wrong-PIN guesses per minute |
| Instances | n/a | run **one** Render instance (it keeps the one-at-a-time queue in memory) |

## Honest status

Tested here: your original Router/Sales/Services code, run through the new adapter against an
in-memory imitation of Google Sheets (19 checks: PIN routing, products, customers with leading-zero
phones, sales, stock limits, three simultaneous saves, failed-save rollback, real date cells,
services setup, expenses, reports), plus the frontend's request layer against a fake server.

**Not** tested here (no internet or Google account in my workspace): calls to the real Google Sheets API,
the PDF drawing, Express/CORS on Render, and the pages in a real browser. Do this test run first:

1. `/health` opens. 2. Sign in with a PIN. 3. Add a customer and a sale in each app.
4. Print a receipt, then **Share/Save PDF**. 5. Check the row appeared in the right spreadsheet.
6. Open the app on two phones and save at the same time.
