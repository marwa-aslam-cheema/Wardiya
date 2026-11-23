# Wardiya — Staff Attendance on Google Sheets

Employees check in and out from their phone, with GPS geofencing, late and overtime rules, a live admin dashboard and payroll-ready monthly reports. Each client's data lives in **their own Google Sheet**. Hosting costs nothing (GitHub Pages + Google Apps Script).

- **Landing page:** `docs/index.html` → `https://YOUR-USERNAME.github.io/wardiya/`
- **Live demo:** `docs/app/` → `https://YOUR-USERNAME.github.io/wardiya/app/` (demo logins: `ADMIN` / `1234`, `E001` / `1111`)

## Folder structure

```
wardiya/
├── docs/                    ← everything GitHub Pages publishes
│   ├── index.html           ← landing page (edit your email + WhatsApp here)
│   ├── assets/              ← logo + screenshots
│   ├── app/index.html       ← the app (demo mode when there is no config.js)
│   └── c/<client>/          ← one folder per paying client (index.html + config.js)
├── backend/                 ← paste these into the client's Google Apps Script project
│   ├── Core.gs              ← business logic (generated from src/core.js)
│   ├── Code.gs              ← Google Sheets storage + web API + setup tools
│   └── appsscript.json      ← project settings
├── src/                     ← source code (edit here, then run `node build.js`)
│   ├── core.js              ← shared logic, used by both demo and live mode
│   └── app.html             ← the interface
├── guides/
│   ├── DEPLOYMENT.md        ← publish your landing page + demo (do this first)
│   ├── CLIENT_INSTALL.md    ← set up a paying client (about 45 minutes)
│   └── HANDOVER_TEMPLATE.md ← document you give the client
├── test/                    ← automated tests
└── build.js
```

## How it works

| Mode | When | Where the data goes |
|------|------|---------------------|
| **Demo** | No `config.js` next to `index.html` | This browser only (localStorage). Use it for sales demos. |
| **Live** | `config.js` sets `apiUrl` | The client's Google Sheet, through their Apps Script web app |

The same `core.js` logic runs in both modes, so the demo behaves exactly like the real product.

## Features

- Check in / check out from any phone browser (no app install), with an optional note
- GPS geofence per branch: off, flag, or block check-ins outside the radius
- Late detection with a grace period; overtime against the standard working day; overnight shifts
- Configurable working days (Sun–Thu or Mon–Fri), hours and time zone
- Admin dashboard: present / late / not in / on leave, 14-day trend, 30-day on-time rate, missing check-outs
- Attendance log with filters (date, employee, branch, late, missing check-out, location flag, leave, manual) and CSV export
- Manual entries, edits and leave days, each with a required reason recorded in the audit log
- Employees: add, edit, deactivate, reset PIN, bulk import from CSV
- Branches with a map link and a "use my current location" button
- Monthly report per employee: present, absent, leave, late days and minutes, hours, overtime, average check-in, attendance %, plus CSV export and print
- English / Arabic with full right-to-left layout
- Per-client branding: app name, colour and logo through `config.js`

## Security

- PINs are stored as salted, iterated SHA-256 hashes, never as plain text. Hash columns are hidden in the sheet.
- 5 wrong PINs lock the account code for 15 minutes.
- Random session tokens expire after 6 hours (Google's cache limit).
- New accounts and PIN resets force a PIN change at first sign-in. Obvious PINs (1111, 1234…) are rejected.
- Every admin action is checked on the server, not just hidden in the interface.
- Locking prevents double check-ins when two requests arrive at once.
- Spreadsheet formula injection is neutralised, and all output is HTML-escaped (XSS).
- **Demo mode keeps its data in the browser and is for demonstration only.** Real clients always use live mode.

## Free-tier limits (read before selling)

| Service | Limit that matters | What it means |
|---|---|---|
| Google Apps Script (free Gmail) | 30 simultaneous executions per user; 6 min per execution; quotas reset every 24 h | Fine for teams of about 100 staff. Not suitable for 500+ people checking in in the same minute. |
| Google Sheets | 10 million cells per spreadsheet | About 400,000 attendance rows. Use **Wardiya → Archive last year's records** once a year to keep the app fast. |
| CacheService | 6-hour maximum | Employees sign in again after 6 hours. |
| GitHub Pages (free) | Repository must be **public**; 1 GB site; about 100 GB/month bandwidth | Fine. The code is public, but **client data never touches GitHub**. |

Google may change quotas without notice. See the [official quotas page](https://developers.google.com/apps-script/guides/services/quotas).

## Development

```bash
node build.js            # rebuild docs/app/index.html and backend/Core.gs from src/
node test/gas-test.js    # backend tests in a simulated Apps Script runtime
node test/ui-test.js     # browser tests of the demo (needs Playwright + Chrome)
node test/live-test.js   # browser tests of live mode against a simulated API
```
