# Setup

How to get UBOSS Sourcing running from nothing, and how to start it again on
any ordinary day.

There are three parts. Do **Part 1** once per machine. Do **Part 2** every time
you sit down to work. **Part 3** is only for when somebody who is not at this
computer needs to see the app.

```
backend/            API + background worker.  Node 20.11+, Fastify, Prisma, MariaDB.
apps/admin-web/     Admin panel for staff.    Vite + React.  Port 5173.
apps/customer-web/  Customer storefront.      Vite + React.  Port 5174.
```

| What | Where |
|---|---|
| API | http://localhost:4000 |
| Admin panel | http://localhost:5173 |
| Storefront | http://localhost:5174 |

---

## A note on shells

This project is developed on Windows. Most commands below are identical
everywhere, but **setting an environment variable is not**, and getting it
wrong is a silent failure rather than an error:

```bash
# bash / zsh (macOS, Linux, Git Bash)
SOME_VAR=1 npm run something
```
```powershell
# PowerShell - the line above is a parse error here
$env:SOME_VAR = '1'; npm run something
```

Wherever that difference matters, both forms are given. If a step seems to do
nothing, check you used the form for the shell you are actually in.

---

# Part 1 — First-time setup

## 1. Prerequisites

| Need | Version | Check with |
|---|---|---|
| Node.js | 20.11 or newer | `node --version` |
| npm | ships with Node | `npm --version` |
| MariaDB or MySQL | on `localhost:3306` | XAMPP is what this was built against |
| ngrok | only for Part 3 | `ngrok version` |

Start MariaDB before anything else. In XAMPP that is the **MySQL** row in the
Control Panel — XAMPP labels it MySQL, but it is MariaDB, and the schema is
written for MariaDB 10.4's limits.

## 2. Get the code

```bash
git clone https://github.com/UBoss-AI/UBoss-Sourcing.git
cd UBoss-Sourcing
```

## 3. Create the databases

Four of them. The test suite **refuses to run against `DATABASE_URL`** because
it truncates tables, so it gets its own. The `_shadow` pair is only used by
`prisma migrate dev` when you author a new migration — create them now so that
day is not a surprise.

```bash
mysql -u root -e "CREATE DATABASE uboss             CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -e "CREATE DATABASE uboss_shadow      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -e "CREATE DATABASE uboss_test        CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -e "CREATE DATABASE uboss_test_shadow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

If `mysql` is not on your PATH, use phpMyAdmin (XAMPP ships it at
http://localhost/phpmyadmin) and create the same four with the same
collation.

## 4. Configure the backend

```bash
cd backend
npm install
cp .env.example .env
```

Open `backend/.env`. Two values have **no working default** — a wrong one stops
the server at boot rather than letting it run half-configured:

```
DATABASE_URL="mysql://root:@127.0.0.1:3306/uboss"
TEST_DATABASE_URL="mysql://root:@127.0.0.1:3306/uboss_test"
```

(That is the XAMPP default: user `root`, no password. If your MariaDB has a
root password, it goes between the `:` and the `@`.)

Now generate real secrets. The `.env.example` placeholders are rejected
outright once `NODE_ENV=production`, and there is no reason to run on
guessable ones even in development:

```bash
node -e "for (const k of ['SESSION_COOKIE_SECRET','ACCESS_TOKEN_SECRET','REFRESH_TOKEN_SECRET']) console.log(k+'='+require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('SECRETS_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('base64'))"
```

Paste the four lines it prints over the matching lines in `.env`.

Everything else in `.env.example` ships with working localhost values. Two
worth knowing about now, because they change what you see later:

| Setting | Default | What it means |
|---|---|---|
| `EMAIL_DRIVER` | `log` | Emails are **printed into the worker terminal**, not sent. Fine for development — and that terminal is where you will find confirmation links and temporary passwords while testing. Set to `smtp` and fill the `SMTP_*` block to send real mail. |
| `FEATURE_CUSTOMER_SELF_REGISTRATION` | `false` | With this off the storefront shows "accounts are by invitation" instead of a sign-up form. Turn it on to let customers register themselves. |
| `MAP_GOOGLE_API_KEY`, `MAP_GOOGLE_MAP_ID` | *(empty)* | Set both and the admin panel's Warehouses map is a Google map, vector-rendered with your own style. Needs a Google Cloud project with billing attached, and a browser key restricted to this panel's origin. See below. |
| `MAP_TILE_URL` | *(empty)* | Raster tiles instead, from any XYZ service. With every map setting empty the Warehouses map plots its markers on a plain ground, with no map behind them. That is a working state, and it is the private one — nothing is requested from anybody until you set one of these. See below. |
| `FEATURE_SUBSCRIPTION_AUTOPAY` | `false` | With this off, customers can still schedule an order for a future date and still subscribe — each delivery is paid through a link emailed to them. Turn it on to let them save a card that is charged automatically, which needs Stripe connected. Storefront screens for saving a card are refused entirely while it is off. |
| `ERP_ORDER_CONNECTION_NAME` | *(empty)* | With this empty, no order is pushed to an ERP. That is a working state: orders are created, paid and fulfilled exactly as they are with one. Set it to the **name** of an integration connection you have created and activated in the admin panel. |
| `FEATURE_ERP_INTEGRATION` | `false` | With this off, **Settings → ERP** says so and does nothing else: the routes refuse, no polling job runs and the inbound webhook endpoint answers 404. Turn it on to connect an ERP from a screen rather than from environment variables — see below. |
| `FEATURE_CUSTOMER_AUTOPAY` | `false` | A customer's standing authority to be charged for scheduled deliveries, with their own per-transaction ceiling and approval threshold. Needs Stripe **and** `FEATURE_SUBSCRIPTION_AUTOPAY`, which is what lets them save a card in the first place; the backend refuses to start with one on and the other off. |
| `FEATURE_SCHEDULE_ANY_PRODUCT` | `true` | With this on, anything a customer can buy they can also put on a repeat purchase. Turn it off and only products you have ticked **Eligible for repeat purchase** on the product form may be scheduled — which is what you want if you sell things you will not repeat. On by default because that per-product tick defaults to off, and the two together mean a fresh install offers a repeat-purchase button that then refuses every basket. |

### Connecting an ERP from a screen

This is a different thing from `ERP_ORDER_CONNECTION_NAME` above, and the
difference is where the configuration lives. That one is an ERP wired through
environment variables: one address, fixed paths, set at deploy time.
`FEATURE_ERP_INTEGRATION` lets a **Business Owner** connect one from
**Settings → ERP** instead — the address, the credentials, the endpoints and the
field mapping are all entered on a screen, tested there, and stored in the
database.

Both may exist. A paid order goes to the connection configured under Settings →
ERP if one is active, and falls through to `ERP_ORDER_*` if none is.

**It is administrator-only, on purpose.** A connection is a URL plus a credential
this server then calls, so the people who can create one are the people already
trusted with the installation. There is no customer-facing route to any of it.

Nothing else needs configuring. Endpoints, authentication, field mapping and
webhook secrets are all per-connection data entered on the screen. Four settings
bound what can be asked for, and the defaults are sensible:

| Setting | Default | What it bounds |
|---|---|---|
| `ERP_MAX_CONNECTIONS` | `5` | Connections that may exist. Only **one** may be active at a time; the rest are room for a sandbox and a migration. |
| `ERP_MAX_SYNC_RECORDS` | `5000` | Records read from the ERP in a single sync. A longer feed is truncated with a warning on the run. |
| `ERP_MAX_ATTEMPTS` | `6` | Attempts at one operation before it needs a person. Paid orders are exempt and use `ERP_ORDER_MAX_ATTEMPTS` instead. |
| `ERP_FAILURE_THRESHOLD` | `5` | Consecutive failures before a connection is taken out of service and stops being polled. |

**Testing against a mock ERP on your own machine.** The server refuses to call
any address that resolves to a private or loopback network — that is what stops
a form field being pointed at your cloud provider's metadata endpoint. For local
development against a mock ERP on `localhost`, set:

```
ALLOW_PRIVATE_ERP_TARGETS=true
```

**This cannot be set in production.** `env.ts` refuses to start a process with
`NODE_ENV=production` and this on, rather than warning about it, because there
is no deployment where it is the intended behaviour.

**The webhook URL.** Switching webhooks on shows an address to paste into the
ERP, built from `API_PUBLIC_URL`. If that is wrong, the address shown is wrong —
so set it before anyone configures a connection. Over a tunnel (Part 3), it has
to be the tunnel's URL, or the ERP will be told to call `localhost`.

**The warehouse map has three settings and no required one.** Leaving all of
them empty is a deliberate default rather than something to tidy up: both
providers tell whoever serves them which part of the world is being looked at,
and that is where your warehouses are, so this software does not disclose it on
your behalf. With none set, the markers sit on a plain ground, the scale bar
still works, and the screen says so in words.

For a **Google map** — vector rendering and your own style — set both of these:

```
MAP_GOOGLE_API_KEY=AIza...
MAP_GOOGLE_MAP_ID=your-map-id
```

Create them once in the Google Cloud console: a project with a **billing
account** attached (Maps Platform does not run without one), the **Maps
JavaScript API** enabled, a **browser key** restricted to HTTP referrers
listing this panel's origin and to the Maps JavaScript API only, and a **map
ID** under Map management — type JavaScript, rendering Vector — with a style
attached. The style is where the map stops looking like a default Google map,
and you can keep editing it in the console afterwards without touching this
software.

The key reaches the browser, and that is unavoidable rather than a mistake: the
Maps JavaScript API has no server side, so every deployment's key is visible to
anybody who opens the Warehouses screen. **The referrer restriction is what
stops it being spent elsewhere** — an unrestricted key can be lifted off the
page by anyone who looks. A key restricted that way needs the browser to send a
referrer, so never add `<meta name="referrer" content="no-referrer">` to the
panel's `index.html`. The map ID is required whenever the key is set and the
server refuses to start without it, because it carries the style and the
markers need it.

For **raster tiles** instead — any XYZ service, including your own tile server
— set both of these:

```
MAP_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
MAP_TILE_ATTRIBUTION=© OpenStreetMap contributors
```

Read OpenStreetMap's tile usage policy before pointing at theirs: attribution
is required, and an installation with many staff is expected to run its own
tile server or use a commercial provider rather than lean on the volunteer one.

Google's tiles cannot go in `MAP_TILE_URL` — they have no public tile endpoint
and their terms forbid reaching for one, which is why the two are separate
settings. **Google wins if both are configured**, so moving from OpenStreetMap
to Google means setting the two Google variables and nothing else.

## 5. Build the database

```bash
cd backend
npm run db:migrate:deploy    # create the tables
npm run db:reference         # currencies and countries
npm run db:seed              # dev logins, sample catalogue, prices, warehouses
```

**`db:reference` is not optional.** Currencies and countries are reference
data, not fixtures — the catalogue is priced per currency, so without them the
storefront renders an empty shop and explains nothing about why. `db:seed` runs
it too, so it is a separate step only on a database you are not seeding.

The test database needs the migrations as well, or the suite fails on its first
query:

```bash
# bash / Git Bash
cd backend && PRISMA_TARGET_TEST_DB=1 npx prisma migrate deploy
```
```powershell
# PowerShell
cd backend
$env:PRISMA_TARGET_TEST_DB = '1'; npx prisma migrate deploy; Remove-Item Env:\PRISMA_TARGET_TEST_DB
```

### Updating a database you already have

Pulling changes and finding a column missing, or a member of staff refused
something their role is meant to allow, is almost always one of these two steps
not having been run.

```bash
cd backend
npm run db:migrate:deploy    # apply any new migrations. Never prompts, never drops anything
npm run db:seed              # re-install roles and permissions
```

`db:seed` also installs the development warehouses — four European ones with
coordinates, time zones and varied operating and ERP-sync states, so the
Warehouses map has something on it — alongside the plain default one. They are
fixtures, not defaults: a real deployment creates its own on the Warehouses
screen, and this repository never asserts where anybody's buildings are.

**`db:seed` is how new permissions reach an existing database.** Roles and
permission keys live in `src/domain/permissions.ts` and are installed by the
seed, which is idempotent — it upserts each permission and rebuilds each role's
grants, so running it again converges rather than duplicating. A change that
adds a permission key therefore does nothing at all until the seed is re-run,
and the symptom is a screen answering `PERMISSION_DENIED` to somebody whose
role clearly ought to have it.

The test database needs both steps too, and it takes the connection string
rather than the `PRISMA_TARGET_TEST_DB` flag, which only the Prisma CLI reads:

```bash
# bash / Git Bash
cd backend
PRISMA_TARGET_TEST_DB=1 npx prisma migrate deploy
# The seed reads DATABASE_URL, so paste your TEST_DATABASE_URL value here
DATABASE_URL="mysql://root:@127.0.0.1:3306/uboss_test" npx tsx src/seed/index.ts
```
```powershell
# PowerShell
cd backend
$env:PRISMA_TARGET_TEST_DB = '1'; npx prisma migrate deploy; Remove-Item Env:\PRISMA_TARGET_TEST_DB
$testUrl = (Get-Content .env | Select-String '^TEST_DATABASE_URL=').Line -replace '^TEST_DATABASE_URL=','' -replace '"',''
$env:DATABASE_URL = $testUrl; npx tsx src/seed/index.ts; Remove-Item Env:\DATABASE_URL
```

## 6. Install the frontends

```bash
cd apps/admin-web    && npm install
cd ../customer-web   && npm install
```

Both carry a committed `.env` with only `VITE_API_BASE_URL` in it. Nothing else
is needed for local work.

## 7. Check the setup worked

```bash
cd backend && npm run verify
```

That runs typecheck, lint and the full test suite. If it passes, the database,
the schema and the code all agree with each other. It is also the gate to run
before any commit.

---

# Part 2 — Running it

Four terminals. Leave all four open.

```bash
# Terminal 1 — API
cd backend && npm run dev

# Terminal 2 — Worker: emails, recurring orders, payment-link expiry, exports
cd backend && npm run dev:worker

# Terminal 3 — Admin panel
cd apps/admin-web && npm run dev

# Terminal 4 — Storefront
cd apps/customer-web && npm run dev
```

**Run exactly one worker.** Several can run safely in production — they claim
jobs under a lease — but two started from *different* builds disagree about
which job types exist, and a job the older one cannot handle goes back to the
queue and eventually dies.

**The worker is not optional.** Every email in the system goes through it:
confirmation links, password resets, staff temporary passwords. Without it an
account can be created and then never confirmed, which looks like a bug in
sign-up.

## Check it is really up

```bash
curl http://localhost:4000/health/live     # the process is alive
curl http://localhost:4000/health/ready    # database and queue answer too
```

Then open http://localhost:5174. The storefront is browsable without signing
in; the sign-in wall sits at the cart, which is where the backend puts it.

## Development logins

These come from `npm run db:seed`.

**Staff**, at http://localhost:5173:

| Email | Password | Role |
|---|---|---|
| `owner@uboss.local` | `OwnerDev!2026` | Business Owner |
| `catalog@uboss.local` | `CatalogDev!2026` | Catalog Manager |
| `inventory@uboss.local` | `StockDev!2026` | Inventory Manager |
| `orders@uboss.local` | `OrdersDev!2026` | Order Manager |
| `finance@uboss.local` | `FinanceDev!2026` | Finance Approver |

**Customers**, at http://localhost:5174:

| Email | Password | State |
|---|---|---|
| `buyer@acme.local` | `BuyerDev!2026` | Active — can order immediately |
| `invited@zenith.local` | — | Left un-activated on purpose, to exercise the invitation flow |

A staff member and a customer can be signed in at the same time in one browser:
the two surfaces name their session cookies apart (`uboss_admin_*` and
`uboss_shop_*`).

These are **development seeds**. Delete them before the system goes live —
`backend/docs/RUNBOOK.md` has the procedure.

## Stopping

`Ctrl+C` in each terminal. When a port stays stuck, or you are not sure what is
still alive:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*UBoss*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Then confirm the ports are actually free:

```powershell
Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalPort -in 4000,5173,5174 } |
  Select-Object LocalAddress, LocalPort
```

Nothing printed means nothing is running. **Do this check before starting up
again** — a stale server holding a port is the single most common cause of
"I changed something and nothing happened".

---

# Part 3 — Sharing it over the internet (ngrok)

Only for showing the app to someone who is not at this computer. It puts your
development machine on the public internet, with whatever test keys and data it
currently holds, so switch it off when you are done.

## Why the normal `npm run dev` is not enough

Three things change once the app is reached from outside:

1. **Vite blocks unknown hostnames.** It only answers to `localhost` by
   default, as a defence against DNS rebinding. A tunnel hostname is refused
   with *"Blocked request. This host is not allowed."*
2. **`localhost` stops meaning this machine.** In a visitor's browser it means
   *their* laptop. Any absolute `http://localhost:4000` URL — in the frontend
   config or in an emailed link — points at the wrong computer entirely.
3. **A free tunnel gives out one hostname**, and there are two frontends.

`npm run dev:tunnel` handles the first two: it turns off the host check, fixes
the hot-reload socket to the tunnel's port 443, and serves the admin panel
under `/admin` so both fit behind one hostname.

> The first of those is also settled permanently by `TUNNEL_HOST`, below, which
> both dev servers honour in **every** mode. Set it once and starting the
> ordinary `npm run dev` out of habit no longer greets you with *"Blocked
> request"* — the page loads either way, and what you give up by not using
> `dev:tunnel` is hot reload and the `/admin` proxy, not the whole site. The
> host check itself stays on: that one hostname is added to it, nothing else.

> Both dev servers bind `127.0.0.1` in **every** mode, not only under a
> tunnel. Vite's default host is the *name* `localhost`, which Windows resolves
> to IPv6 `::1` first — leaving the server answering on IPv6 only. A browser
> asking for `http://localhost:5173` still gets through (it retries the other
> family), but `http://127.0.0.1:5173` does not, and neither does the ngrok
> agent, which dials IPv4 and reports the upstream as refused. Either way the
> server is still loopback-only; `npm run dev -- --host` is what puts it on the
> network.

## One-time: the two settings the frontends need

Create `.env.local` in **both** app folders:

```
# apps/customer-web/.env.local  and  apps/admin-web/.env.local
VITE_API_BASE_URL=/api/v1
TUNNEL_HOST=your-reserved-name.ngrok-free.dev
```

`VITE_API_BASE_URL` — the committed `.env` uses an absolute
`http://localhost:4000/api/v1`, which breaks for a remote visitor. A relative
path is served from whatever origin the page came from, and the Vite dev server
proxies `/api` and `/media` through to the API.

`TUNNEL_HOST` — the hostname each dev server will answer to besides
`localhost`, which is what stops *"Blocked request. This host is not allowed."*
A **bare hostname**: no `https://`, no trailing slash, no path. It is the domain
you reserve in the next step, so come back and fill it in once you have it.
Leave it out entirely on a machine that never tunnels and the host check simply
stays at its default.

`.env.local` is gitignored and overrides `.env`, so neither setting affects
anyone else — which is also why the hostname belongs here rather than in the
committed `.env`: it is yours, not the project's.

## One-time: reserve a domain and configure the agent

Reserve a free static domain in the ngrok dashboard. Then find your config
file — `ngrok config check` prints its exact path, which differs per platform
(on Windows it is `%LOCALAPPDATA%\ngrok\ngrok.yml`) — and make it look like
this:

```yaml
version: "2"
tunnels:
    shop:
        proto: http
        addr: 5174
        domain: your-reserved-name.ngrok-free.dev
authtoken: <your token>
```

Without `domain:` the agent takes a **new random hostname every restart**, and
the backend builds its emailed links from a fixed host — so every confirmation
and reset link would point somewhere dead.

Validate it:

```bash
ngrok config check
```

## Each time: point the backend's email links at the tunnel

In `backend/.env`:

```
CUSTOMER_WEB_PUBLIC_URL=https://your-reserved-name.ngrok-free.dev
ADMIN_WEB_PUBLIC_URL=https://your-reserved-name.ngrok-free.dev/admin
```

Restart the API after changing these — environment is read once, at boot.

> **Put these back to `http://localhost:5174` and `http://localhost:5173` when
> you stop tunnelling**, or every link you email yourself while working locally
> will point at a tunnel that is switched off.

## Each time: start it, in this order

Order matters. Local servers first, tunnel last — the other way round leaves
ngrok connected to nothing.

```bash
# 1
cd backend && npm run dev
# 2
cd backend && npm run dev:worker
# 3
cd apps/admin-web && npm run dev:tunnel
# 4
cd apps/customer-web && npm run dev:tunnel
# 5
ngrok start shop
```

Before moving on from step 4, confirm the **tunnel badge** in the Vite output:

```
VITE v6.4.3  tunnel  ready in 317 ms      <- the "tunnel" badge
➜  Local:   http://127.0.0.1:5174/         <- printed in every mode now
```

The badge is the whole signal. The `127.0.0.1` line used to be the other half
of it, back when only tunnel mode bound that address; both modes bind it today,
so it no longer tells you which one you are in.

And in step 5:

```
started tunnel  name=shop  url=https://your-reserved-name.ngrok-free.dev
```

## Your URLs

| | |
|---|---|
| Storefront | `https://your-reserved-name.ngrok-free.dev` |
| Admin panel | `https://your-reserved-name.ngrok-free.dev/admin/` |

The first visit shows ngrok's *"You are about to visit…"* warning page — free
plan, once per visitor. Click **Visit Site**.

## Check the whole chain in one command

```bash
for p in / /admin/ /api/v1/config; do
  echo "$p -> $(curl -s -o /dev/null -w '%{http_code}' \
    -H 'ngrok-skip-browser-warning: true' \
    https://your-reserved-name.ngrok-free.dev$p)"
done
```

Three `200`s means the tunnel, both frontends and the API are all wired up.

## The inspector

http://127.0.0.1:4040 is ngrok's own request inspector. Every request through
the tunnel appears live with its full body, and any of them can be replayed
with one click. It is the fastest way to see whether a failure is happening
before or after the tunnel.

---

# Troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| `Blocked request. This host is not allowed.` | `TUNNEL_HOST` is unset, or does not match the hostname in the message | Set it in **both** `apps/*/.env.local`, bare hostname only. Vite restarts itself when you save |
| `Port 5174 is already in use` | An older server is still alive | Run the stop commands in Part 2 |
| `ERR_NGROK_3200` endpoint offline | No agent is running on that domain | Check terminal 5; check `domain:` in `ngrok.yml` |
| `ERR_NGROK_8012` connection refused | Tunnel is up, but it cannot reach Vite | Is step 4 running? Did it print the `tunnel` badge? |
| Storefront loads, but no products | Reference data missing | `cd backend && npm run db:reference` |
| Page loads, every request fails | API is down | Check terminal 1; `curl http://localhost:4000/health/ready` |
| Account created, no email arrives | Worker is down, or `EMAIL_DRIVER=log` | Check terminal 2 — on `log` the message is printed there |
| Admin panel blank, assets 404 | Admin started with `dev`, not `dev:tunnel` | Restart terminal 3 |
| Prisma: "DATABASE_URL is not set" | No `.env`, or you are in the wrong folder | `cp .env.example .env` inside `backend/` |
| Server starts, then exits immediately | A `.env` value failed validation | Read the error — it names the variable |

**Two habits that prevent most of this:**

- Before starting, check nothing is already listening on 4000, 5173 or 5174.
- Trust the process, not your memory of what you launched. On Windows:
  ```powershell
  (Get-CimInstance Win32_Process -Filter "ProcessId=1234").CommandLine
  ```
  The command line shows the flags a process is *actually* running with.

---

# Command reference

```bash
cd backend
npm run dev              # API, with reload
npm run dev:worker       # background worker
npm run verify           # typecheck + lint + tests — run before every commit
npm test                 # tests only
npm run db:studio        # browse the database in a GUI
npm run db:migrate       # author a new migration (interactive, needs _shadow DBs)
npm run db:migrate:deploy# apply pending migrations (never prompts)
npm run db:reset         # wipe, re-migrate, re-seed — development only
npm run db:seed          # re-seed
npm run db:reference     # currencies and countries only
npm run openapi:export   # regenerate openapi.json from the live route table
```

```bash
cd apps/customer-web     # or apps/admin-web
npm run dev              # normal local development
npm run dev:tunnel       # same, but reachable through an HTTPS tunnel
npm run verify           # typecheck + lint + contrast audit + tests + build
npm run build            # production build
```

---

Deeper background lives elsewhere: `README.md` covers configuration,
languages, markets and payments; `backend/README.md` covers the data model and
the invariants the system is built on; `backend/docs/RUNBOOK.md` covers going
live.
