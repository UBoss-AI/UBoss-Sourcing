# UBOSS Sourcing — Local Setup

This guide gets the whole project running on this Windows computer: the
database, the API, the background worker, the Admin Panel and the Customer
Storefront.

There are two parts:

- **Start the project** — what you do every day. One command.
- **First-time setup** — done once per computer. Only needed if the daily
  command does not work yet.

---

# Start the project

Open PowerShell and run these two lines:

```powershell
cd C:\Users\HP\Desktop\UBoss-Software
.\scripts\dev-stack.ps1
```

That is the whole thing. This one command starts **every part**, in the right
order, and waits until each one answers before it moves to the next:

| Part | Port | What it is |
|---|---|---|
| MariaDB (XAMPP calls it MySQL) | 3306 | The database |
| API | 4000 | The backend |
| Worker | — | Emails, scheduled jobs, exports |
| Admin Panel | 5173 | Staff use this |
| Customer Storefront | 5174 | Customers use this |
| Logistics Portal | 5175 | Carrier companies use this — **only started when `FEATURE_LOGISTICS_PORTAL=true` in `backend\.env`** |

**You do not need to open XAMPP.** The script starts the database itself.

When it finishes, open:

- Customer Storefront — http://localhost:5174
- Admin Panel — http://localhost:5173
- Logistics Portal — http://localhost:5175, if it is switched on

### No windows open? That is normal

The script starts everything **detached** — in the background, with no terminal
windows. Nothing is on your screen, but everything is running. This is on
purpose: windows tied to an editor or a terminal get closed together when the
computer runs low on memory, which leaves half the project running and half
stopped.

So never judge the project by what windows are open. Ask the script instead:

```powershell
.\scripts\dev-stack.ps1 -Status
```

It prints every part and whether it is UP or DOWN, and changes nothing.

### The other three commands

```powershell
.\scripts\dev-stack.ps1 -Status    # What is running? Changes nothing.
.\scripts\dev-stack.ps1 -Restart   # Stop everything, then start it again.
.\scripts\dev-stack.ps1 -Stop      # Stop the app. Leaves the database running.
```

Use `-Restart` when you have changed something and a server seems to be holding
on to old code, or when a port is reported as already in use.

`-Stop` deliberately leaves the database running, because phpMyAdmin, Prisma
Studio and anything else on this computer share that one database server. Add
`-IncludeDatabase` if you really want the database stopped too.

### If PowerShell refuses to run the script

If you see a message about scripts being disabled, run this once in that
window, then run the start command again:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

It applies to that window only, and is undone when you close it.

---

# Check that it really started

Running is not the same as working. The honest test is whether the API answers:

```powershell
Invoke-WebRequest http://localhost:4000/health/ready
```

You want HTTP `200` and a body that looks like this:

```json
{"status":"ready","dependencies":{"database":{"ok":true},"queue":{"ok":true}}}
```

- `200` with `"database":{"ok":true}` — everything is fine.
- Connection refused — the API is not running. See the table below.
- `503` — the API is running, but the database or the job queue is not.

There is also http://localhost:4000/health/live, which only says "the API
process is alive". `/health/ready` is the useful one, because it checks the
database too.

---

# When something is wrong

| What you see | What it really means | What to do |
|---|---|---|
| The website shows **500** | The page loaded, but the API behind it is down, so the site could not reach it | `.\scripts\dev-stack.ps1 -Restart`, then check `/health/ready` |
| Sign-in says network error, or `Failed to fetch` | The API or the database is stopped | Same as above |
| `ECONNREFUSED`, or no MySQL connection | The database is not running | `.\scripts\dev-stack.ps1 -Restart` — it starts the database too |
| A terminal shows the API running, but the site still fails | The API crashed at startup and its watcher stayed alive, so the terminal lies | `.\scripts\dev-stack.ps1 -Status` tells you the truth; then read the log below |
| `Port 4000`, `5173`, `5174` or `5175` is already in use | An old server is still holding the port | `.\scripts\dev-stack.ps1 -Restart` |
| `DATABASE_URL is not set` | `backend\.env` is missing | Copy `.env.example` to `.env` inside `backend` |
| A Prisma table or column error | New migrations have not been applied | `cd backend`, then `npm run db:migrate:deploy` |
| Sign-in says the credentials are wrong | Sample data is missing, it is the wrong site, or the passwords were rotated | Run `npm run db:seed`. Admin logins only work on 5173, customer logins only on 5174. If `db:rotate-seed-passwords` was run on this database, the ones in this file no longer apply and re-seeding will not bring them back — rotate again for a fresh set |
| The storefront opens but has no products | Sample data is missing | `cd backend`, then `npm run db:seed` |
| No emails appear anywhere | The worker is not running | `.\scripts\dev-stack.ps1 -Restart` |
| The site is reaching a public ngrok address | The project is in tunnel mode | `.\scripts\dev-stack.ps1 -Restart -Local` |

**Almost every failure has the same cause: the database was not started, so the
API died a second later.** `-Restart` fixes it, because it starts them in the
right order.

### Reading the logs

Every part writes its output to a file in `.dev-logs\`:

```powershell
Get-Content .\.dev-logs\api.out.log -Tail 100
Get-Content .\.dev-logs\worker.out.log -Tail 100
```

If the API will not stay up, `api.out.log` says why on its last few lines.

---

# Development sign-ins

These accounts are created by `npm run db:seed`.

**The moment this machine's API is reachable from outside** — a tunnel, or a
Netlify site pointed at it — these passwords are in a public repository and are
no longer passwords. Replace all nine with random ones, in one command:

```powershell
cd backend ; npm run db:rotate-seed-passwords
```

It prints the new passwords once, revokes every session, and does not need to
be undone: `npm run db:seed` sets a password only when it *creates* an account,
so re-seeding leaves the rotated ones alone. The tables below then describe a
fresh clone rather than your database, which is correct — leave them as they
are.

| Where | Email | Password |
|---|---|---|
| Admin Panel (5173) | `owner@uboss.local` | `OwnerDev!2026` |
| Admin Panel — catalogue role | `catalog@uboss.local` | `CatalogDev!2026` |
| Storefront (5174) | `buyer@acme.local` | `BuyerDev!2026` |

The three below exist **only where the logistics portal is switched on**, and
only in development — the seed refuses to create them in production, because
their passwords are printed in a log.

| Where | Email | Password | Note |
|---|---|---|---|
| Logistics Portal (5175) | `carrier.dispatch@uboss.local` | `DispatchDev!2026` | Goes straight to the dashboard |
| Logistics Portal (5175) | `carrier.owner@uboss.local` | `CarrierDev!2026` | Has to set up a second factor first |
| Logistics Portal (5175) | `carrier.driver@uboss.local` | `DriverDev!2026` | Sees only their own round |

In production **nobody is seeded**. The portal has no public registration and
no password is ever emailed: a carrier is created from **Logistics → Carriers**
in the admin panel, which sends a one-time activation link, and the person who
opens it chooses their own password. In development the email driver is
`log`, so that link appears in the worker's log and nowhere else.

On the Admin sign-in page, tick the Terms checkbox. The browser may ask for
location permission after you sign in — allow it, or the admin session will not
finish.

---

# First-time setup

Do this once on a new computer. If `.\scripts\dev-stack.ps1` already works, skip
this whole section.

### 1. Install Node.js and XAMPP

You need:

- Node.js **24** (the Active LTS release). `.nvmrc` in the repository root names
  it, every `package.json` requires it, and the server and CI both run it
- XAMPP, installed at `C:\xampp` — it supplies MariaDB

Check Node in PowerShell:

```powershell
node --version
npm --version
```

If `node` is not recognised, or it reports a version below 24, install the
current Node.js LTS release, close PowerShell, open it again, and check once
more. An older major appears to work and then fails in CI or on the server,
which is a slower way to find out.

> XAMPP's **MySQL** is MariaDB. For this project they are the same thing. Do
> not install PostgreSQL or Redis for local development.

### 2. Create the four databases

The database server has to be running for this one step. Start **MySQL** in
`C:\xampp\xampp-control.exe`, or let the stack script do it:

```powershell
.\scripts\dev-stack.ps1
```

Then create the databases. XAMPP's default user is `root` with no password:

```powershell
& 'C:\xampp\mysql\bin\mysql.exe' -u root -e "CREATE DATABASE IF NOT EXISTS uboss CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE DATABASE IF NOT EXISTS uboss_shadow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE DATABASE IF NOT EXISTS uboss_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE DATABASE IF NOT EXISTS uboss_test_shadow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

If your `root` user has a password, add `-p` after `root`; MySQL will then ask
for it without showing what you type.

Four databases, because each has a different job:

| Database | Used for |
|---|---|
| `uboss` | Your data while developing |
| `uboss_test` | Automated tests — they erase its contents |
| `uboss_shadow`, `uboss_test_shadow` | Prisma uses these while building migrations |

### 3. Set up the backend

```powershell
cd C:\Users\HP\Desktop\UBoss-Software\backend
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm install
```

Open `backend\.env` and check these two lines:

```env
DATABASE_URL="mysql://root@127.0.0.1:3306/uboss"
TEST_DATABASE_URL="mysql://root@127.0.0.1:3306/uboss_test"
```

If MariaDB's `root` has a password, put it after `root:` — a password of
`my-password` becomes:

```env
DATABASE_URL="mysql://root:my-password@127.0.0.1:3306/uboss"
```

`.env` holds local secrets. Keep it private, and never commit it.

#### Optional: give each seller their own shop front

Sellers can have a web address of their own — `northwind.localhost:5174` serves
the shop of the seller whose slug is `northwind`. It is off unless you say which
domain the subdomains hang off:

```env
SELLER_STOREFRONT_DOMAIN="localhost"
```

Leave it empty and there are no seller shop fronts at all: every request is the
operator's own shop, which is what a single-supplier deployment wants and what
the software does without this line.

Two things to know when trying it locally:

- **`*.localhost` needs no hosts-file entry.** Chrome, Edge and Firefox all
  resolve it to 127.0.0.1 on their own. `curl` does not, so test it with
  `curl -H "Host: northwind.localhost" http://127.0.0.1:4000/api/v1/config`.
- **The API must be restarted after changing this.** It is read once at boot,
  so `tsx watch` reloading a source file does not pick it up —
  `scripts\dev-stack.ps1 -Restart`.

### 4. Create the tables and the sample data

Still inside `backend`:

```powershell
npm run db:migrate:deploy
npm run db:generate
npm run db:seed
```

This builds every table and adds development users, roles, products, prices and
warehouses.

### 5. Install the frontends

```powershell
cd C:\Users\HP\Desktop\UBoss-Software\apps\admin-web
npm install

cd ..\customer-web
npm install
```

The logistics portal is a third frontend, and is only needed if you are going
to switch it on:

```powershell
cd C:\Users\HP\Desktop\UBoss-Software\apps\logistics-web
npm install
```

First-time setup is done. From now on, use **Start the project** at the top.

### 6. Optional: the database rehearsal environment

Only if you are going to change the schema, write a migration, or prepare a
release. Everyday work does not need it.

**XAMPP runs MariaDB 10.4. The server will run 11.4, and they behave
differently.** 10.4 is not strict: a value too long for its column is quietly
truncated. 11.4 rejects it. So a migration, or a feature that writes a longer
string than a column allows, can pass every test here and fail on the server.

`deploy\compat\` runs the exact version the server will, in Docker, so that
difference appears on this machine instead. It needs Docker Desktop.

```powershell
cd C:\Users\HP\Desktop\UBoss-Software\deploy\compat
Copy-Item .env.database.example .env
```

Open `.env` and fill in the four passwords. Generate each one separately:

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Then, from the project root:

```powershell
.\scripts\db\compat-test.ps1 -Reset
```

That builds the whole database from the committed migrations on MariaDB 11.4,
applies the same permissions the server uses, checks that the migrations and
`schema.prisma` still agree, and runs the backend tests against it. About seven
minutes. `-SkipTests` stops after the check, which is the quick loop while
writing a migration.

**It never touches XAMPP.** It listens on `127.0.0.1:3307`, not 3306, and the
script refuses to run if that is ever changed to 3306.

---

# After pulling new code

When you receive project changes, run this from `backend` before starting:

```powershell
cd C:\Users\HP\Desktop\UBoss-Software\backend
npm install
npm run db:migrate:deploy
npm run db:generate
npm run db:seed
```

If the frontends gained dependencies, run `npm install` inside
`apps\admin-web` and `apps\customer-web` as well — and inside
`apps\logistics-web` if you use the logistics portal. Then start as usual.

---

# Starting by hand

Only do this when you want to watch one part's log live while you work on it.
For everyday use the stack script is better, because it starts things in the
right order and tells you the truth about what is up.

**There are five things to start, not four.** The database is first, and it is
not an `npm` command — that is the step people miss. Without it the API starts,
fails to reach the database, and stops, while its terminal still looks healthy.

```powershell
# 1. The database — start MySQL here, and wait for it to say Running
C:\xampp\xampp-control.exe
```

Confirm it before going on:

```powershell
Test-NetConnection 127.0.0.1 -Port 3306      # TcpTestSucceeded : True
```

Then four terminals, each left open:

```powershell
# Terminal 1 — API
cd C:\Users\HP\Desktop\UBoss-Software\backend
npm run dev
```

```powershell
# Terminal 2 — worker (emails, scheduled jobs, exports)
cd C:\Users\HP\Desktop\UBoss-Software\backend
npm run dev:worker
```

```powershell
# Terminal 3 — Admin Panel
cd C:\Users\HP\Desktop\UBoss-Software\apps\admin-web
npm run dev
```

```powershell
# Terminal 4 — Customer Storefront
cd C:\Users\HP\Desktop\UBoss-Software\apps\customer-web
npm run dev
```

```powershell
# Terminal 5 — Logistics Portal, only where FEATURE_LOGISTICS_PORTAL=true
cd C:\Users\HP\Desktop\UBoss-Software\apps\logistics-web
npm run dev
```

Keep the worker running. Password-reset, invitation and confirmation emails are
handled there, and in local development they print in that terminal instead of
being delivered.

Starting by hand for a **tunnel**, all three frontends run `npm run dev:tunnel`
instead of `npm run dev`, and the ngrok agent goes last — it connects to
nothing if it starts before the servers it points at.

Whichever way you started, check it the same way:

```powershell
Invoke-WebRequest http://localhost:4000/health/ready
```

---

# Showing the app to somebody else

To let someone who is not at this computer see it, start in tunnel mode:

```powershell
.\scripts\dev-stack.ps1 -Restart -Tunnel
```

The script prints the three public addresses, and they are also in the ngrok
inspector at http://localhost:4040. This needs ngrok configured first.

One free tunnel gives out **one hostname**, so all three apps share it and are
told apart by the path:

| | |
|---|---|
| Storefront | `https://<your-host>.ngrok-free.dev/` |
| Admin panel | `https://<your-host>.ngrok-free.dev/admin/` |
| Logistics portal | `https://<your-host>.ngrok-free.dev/logistics/` — only where it is switched on |

The storefront owns the root and passes `/admin` and `/logistics` through to
the other two. That is a **development** arrangement only: in a real
installation a carrier signs into the logistics portal on its own hostname, and
`LOGISTICS_WEB_PUBLIC_URL` in `backend\.env` is what an invited carrier's
activation link points at — set it to the tunnel address while tunnelling, and
back to `http://localhost:5175` afterwards, exactly like the other two
`*_PUBLIC_URL` settings.

A `200` from `/admin/` or `/logistics/` is **not** proof either one is up: with
the frontends started in plain `dev` mode the storefront answers those paths
with its own page. Check what the page actually loads instead — each app names
its own entry script:

```powershell
curl.exe -s -H 'ngrok-skip-browser-warning: true' https://<your-host>.ngrok-free.dev/logistics/ |
  Select-String -Pattern 'src="[^"]*main\.tsx'
```

`/logistics/src/main.tsx` is the portal. `/src/main.tsx` is the storefront
answering in its place, which means the frontends are not in tunnel mode.

Tunnel mode **stays on across a restart**, on purpose — quietly dropping the
tunnel would break the link the other person is using. To come back to plain
local mode, ask for it:

```powershell
.\scripts\dev-stack.ps1 -Restart -Local
```

### A link that does not depend on this computer being on

A tunnel is the fastest way to show somebody the app, and it lasts exactly as
long as your machine does. For a link a manager or a reviewer can keep — three
proper URLs, one per application — put the three front ends on Netlify:

```powershell
.\scripts\pack-netlify.ps1 -ApiOrigin https://api.your-company.com
```

That builds all three and writes one zip per site to `output\netlify`, ready to
drop into Netlify's **Deploy manually** box.

**It does not move the API.** Netlify serves files; the API holds a database
connection pool and the worker polls the job queue forever, so both stay on a
machine that keeps running — a server of your own, or this one behind a tunnel,
which is what `-ApiOrigin` points at. Without a reachable API the three sites
render their sign-in screens and cannot sign anybody in.

To tunnel the API from this machine, use **cloudflared, not ngrok**:

```powershell
& "$env:ProgramFiles(x86)\cloudflared\cloudflared.exe" tunnel --protocol http2 --url http://localhost:4000
```

ngrok's free plan answers anything with a browser `User-Agent` — including the
app's own `fetch()` calls — with its warning page, so behind Netlify every API
call comes back as HTML and nothing in the site works. `--protocol http2` is
required wherever outbound UDP 7844 is blocked, or the tunnel registers and
then returns Cloudflare error 1033 to everything. `docs/NETLIFY.md` has both in
full.

`docs/NETLIFY.md` is the full procedure, including the settings the API has to
be given in return — `COOKIE_SECURE=true` above all, because on an HTTPS site
without it the sign-in returns 200 and silently does nothing.

---

# Useful commands

```powershell
# From backend
npm run verify              # Type-check, lint and test the backend
npm test                    # Backend tests only
npm run db:studio           # Browse the database in a web page
npm run db:migrate:deploy   # Apply existing migrations safely
npm run db:migrate          # Create a new migration (asks questions)
npm run db:seed             # Restore or update the sample data
npm run db:rotate-seed-passwords   # Fresh random passwords for the nine seeded accounts
```

`npm run db:reset` erases and rebuilds the development database. Do not run it
unless you mean to lose your local data.

---

# Further reading

- Backend architecture, schema and migration notes — `backend/README.md`
- **Putting it on a server** — `docs/DEPLOYMENT.md`
- **Putting the three front ends on Netlify** — `docs/NETLIFY.md`
- Which MariaDB the server runs, and why — `docs/DATABASE-PRODUCTION.md`
- Writing a migration, and getting data out of XAMPP safely — `docs/DATABASE-MIGRATION.md`
- Backups and proving one restores — `docs/DATABASE-RECOVERY.md`
- Backups and production recovery — `backend/docs/RUNBOOK.md`
- Features and business configuration — `README.md`
- How the whole product works — `PROJECT-GUIDE.md`

Everything above this line is about a **developer's machine**. Nothing in this
file is safe to copy onto a server: the sign-ins are shared, the secrets are
placeholders, and the API here listens on every interface. `docs/DEPLOYMENT.md`
starts from a bare VPS and ends with a site taking orders, and
`deploy/` holds the nginx, systemd and MariaDB files it installs.
