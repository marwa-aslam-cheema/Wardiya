# Installing Wardiya for a paying client (about 45 minutes)

The system runs **inside a Google account that the client owns**, so the data is theirs and costs nothing to host.

**Choose one approach before the setup call:**

- **A. Client's own Google account (recommended).** Do it on a screen-share (Google Meet / Zoom / WhatsApp video) while the client is signed in. Or ask them to share the Sheet with you as *Editor*, but in that case **the client must do the "Deploy" step** (step 5) themselves, because a web app runs as whoever deploys it.
- **B. A new Gmail created for the client.** You create something like `acmeclinic.attendance@gmail.com`, set everything up, then hand over the password and recovery settings on the handover call. Easiest for non-technical clients.

---

## 1. Create the Google Sheet (2 min)

1. Signed in to the client's Google account, go to <https://sheets.new>.
2. Name it, for example **"Acme Clinic – Attendance"**. This becomes the default company name.
3. **File → Settings → Time zone**: choose the client's city (e.g. *(GMT+04:00) Dubai*). Click **Save settings**.

## 2. Add the code (5 min)

1. In the Sheet: **Extensions → Apps Script**. A code editor opens.
2. Rename the project (top left) to **Wardiya**.
3. Click the **gear icon (Project Settings)** → tick **Show "appsscript.json" manifest file in editor**.
4. Back in the **Editor** (`< >` icon):
   - Click `appsscript.json`, delete everything, and paste the contents of `backend/appsscript.json`. Change `"timeZone"` if you want, then save (Ctrl+S).
   - Click `Code.gs`, delete everything, and paste the contents of `backend/Code.gs`. Save.
   - Click **+ → Script**, name it `Core` (it becomes `Core.gs`), and paste the contents of `backend/Core.gs`. Save.

## 3. Run first-time setup (3 min)

1. In the function dropdown at the top (next to **Debug**), choose **setup** → click **Run**.
2. Google asks for permission: **Review permissions** → pick the account.
3. You'll see *"Google hasn't verified this app"*. This is normal for a private script you wrote yourself. Click **Advanced → Go to Wardiya (unsafe) → Allow**. It only asks to manage **this one spreadsheet**.
4. When it finishes, open **Execution log** at the bottom. It shows:
   ```
   Admin code: ADMIN
   Temporary PIN: 483920
   ```
   **Write the PIN down.** The Sheet now has tabs: `employees`, `branches`, `records`, `audit`, `settings`.

## 4. Deploy the web API (3 min)

1. Top right: **Deploy → New deployment**.
2. Click the gear next to *Select type* → **Web app**.
3. Description: `v1`. **Execute as: Me**. **Who has access: Anyone**.
   *("Anyone" only means the address can be reached. Every action still needs a valid employee code + PIN session.)*
4. Click **Deploy** → copy the **Web app URL** (ends in `/exec`).
5. Paste that URL into a browser. You should see `{"ok":true,"data":{"version":"1.0.0",...}}`. That means it works.

## 5. Create the client's app page (5 min)

On your GitHub repository:

1. **Add file → Create new file**. Name: `docs/c/acme/config.js` (replace `acme` with a short client name, lowercase, no spaces). Content:
   ```js
   window.WARDIYA_CONFIG = {
     apiUrl: 'PASTE_THE_WEB_APP_URL_HERE',
     appName: 'Acme Attendance',   // shown in the header
     brandColor: '#0E7C66',        // client's colour (6-digit hex), optional
     logoUrl: ''                   // optional: 'logo.png' uploaded to the same folder, or an https:// link
   };
   ```
   Commit.
2. Open `docs/app/index.html` on GitHub → **Raw** → copy everything. Then **Add file → Create new file** named `docs/c/acme/index.html`, paste, and commit.
   *(Or download `docs/app/index.html` and upload it into `docs/c/acme/`.)*
3. (Optional) Upload the client's logo as `docs/c/acme/logo.png` and set `logoUrl: 'logo.png'`.
4. After about a minute the client's app is live at **`https://USERNAME.github.io/wardiya/c/acme/`**.

> Live mode is automatic: when `config.js` has an `apiUrl`, the demo banner and demo logins disappear and all data goes to the client's Sheet.

## 6. Configure with the client (15 min)

Open the client link → sign in with `ADMIN` + the temporary PIN → choose a new PIN.

1. **Settings:** company name, time zone, work start/end, grace minutes, working days, geofence rule (start with **Flag**, and switch to **Block** after a week if they want).
2. **Branches:** add each branch. Stand at the branch, or have the manager open the page there, and press **Use my current location**. Use a 100–200 m radius (GPS indoors can be off by 30–80 m).
3. **Employees:** add them one by one, or **Import** a list. One line per employee:
   `E001,Sara Ahmed,Nursing,Downtown Clinic,4821,sara@example.com,+971500000000`
   Give each person their code + starting PIN privately. They choose their own PIN at first sign-in.
4. Create a second admin account for the client's manager (Role: Admin).

## 7. Test before you hand over (5 min)

- Sign in as an employee on a phone → Check in → Check out.
- Open the Google Sheet → the `records` tab has the row.
- Dashboard shows the person; **Monthly report → Export CSV** opens in Excel.
- Tell staff to **add the page to their home screen** (iPhone: Share → Add to Home Screen; Android: ⋮ → Add to Home screen).

## Updating a client to a new version

1. Paste the new `Core.gs` / `Code.gs` into their Apps Script project and save.
2. **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.** The URL stays the same.
3. Replace `docs/c/<client>/index.html` with the new `docs/app/index.html`. Leave `config.js` alone.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Cannot reach the server" | Check `apiUrl` in `config.js` ends with `/exec`, and the deployment is **Anyone**. |
| `Sheet "records" is missing` | Run **setup** again (it never deletes data). |
| Lost the admin PIN | In the Sheet: **Wardiya menu → Reset ADMIN PIN** (or run `resetAdminPin` in the editor). |
| Employee locked out | Wait 15 minutes, or have an admin reset their PIN in **Employees → Edit**. |
| Location always "not available" | The phone has location off or the browser was denied. In browser settings, allow location for `github.io`. |
| Check-in shows "Outside area" at the branch | Re-save the branch location while standing inside it, or increase the radius. |
| App getting slow after a year or more | **Wardiya menu → Archive last year's records**. |
