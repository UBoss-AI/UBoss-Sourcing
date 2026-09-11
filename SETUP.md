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
| `MAP_STYLE_URL` | *(empty)* | A MapLibre style URL — vector tiles, and **the setting that puts every place name on the map in one language**. A keyless public one exists. See below. |
| `MAP_TILE_URL` | *(empty)* | Raster tiles instead, from any XYZ service. Their place names arrive painted into the picture in the local language and cannot be changed. With every map setting empty the Warehouses map plots its markers on a plain ground, with no map behind them. That is a working state, and it is the private one — nothing is requested from anybody until you set one of these. See below. |
| `DELIVERY_COVERAGE_RADIUS_KM` | `500` | How far a warehouse delivers **when the warehouse itself does not say**. Every warehouse carries its own radius on the warehouse form; this is the fallback for the ones that have not been given one, so changing it moves the whole business's promise at once. Drives the coverage ring, the "Delivers to" list beside it, and which warehouses the storefront offers a buyer. A commercial promise, so it is yours to set — and the country boundaries it is measured against ship with the software, so it needs no network. |
| `SCHEDULE_MIN_NOTICE_DAYS` | `7` | How many calendar days of notice a scheduled order's **first delivery** needs, counted on the customer's own clock. The storefront's calendar greys out everything below it and the API refuses anything inside it, so this is what a buyer can actually pick. Zero is a real setting if you deliver from stock in the buyer's own city. |
| `FULFILMENT_QUOTE_TTL_MINUTES` | `15` | How long a warehouse option at checkout stays an offer. Each option is a stored quote with an expiry, which is what makes the total on the card the total the customer is charged; the checkout page re-asks before it lapses. Shorter, and somebody reading the page loses their offer mid-decision; longer, and you are holding a price against stock that has moved. |
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

### Letting customers connect *their own* ERP

A third thing, and the one most easily confused with the two above. Both of
those are about **your** warehouse system. This one is about your **customers'**:
a hospital group's SAP, a distributor's NetSuite, a clinic chain's Tally, a
practice's in-house API. They connect it themselves, from **Account → ERP
integration**, and what they get is their own purchase orders, goods receipts,
invoices and payment references appearing in their own system without anybody
re-keying them.

The wizard offers a catalogue of twenty named systems — SAP S/4HANA and ECC,
monday.com, Odoo, NetSuite, Oracle Fusion, Dynamics 365 (Business Central and
F&O), SAP Business One, Zoho Inventory, Acumatica, QuickBooks Online, Sage X3,
Epicor Kinetic, Infor ION, TCS iON, Tally Prime, Marg, Busy, and *any other
system* — searchable by name. Nothing here needs configuring by the operator:
the catalogue is data in the backend, and four connectors underneath it cover
every entry. **The one exception is monday.com**, which needs an app registered
by you before a customer can use it in production; see below.

It is off by default:

```
FEATURE_CUSTOMER_ERP=true
```

With it off, the account screens are hidden, every customer-facing route refuses
with `FEATURE_DISABLED`, no dispatch or polling job is enqueued, and the inbound
webhook endpoint answers 404.

**The tenant is the customer's business, not the customer.** A connection
belongs to a *buyer organisation*, which is provisioned the first time somebody
opens the integrations area and which other people join by invitation. That is
why a connection configured by somebody who then leaves keeps working, and why
their successor can fix it. Three roles: an **owner** manages access, an
**integration manager** configures and runs the connection, and a **member** can
see how it is doing. Nobody, at any role, can read back a credential.

**Support can watch and cannot touch.** **Customer ERP** in the admin panel
lists every customer connection with its state, its host, its failure count and
the safe error message — enough to say "your firewall is refusing us" on a
phone call. It shows no credentials, no hints, no endpoint paths, no field
mappings and no request or response bodies, and it has no write actions at all.
Acting against a system this business does not own, with a credential its
customer supplied for their own purposes, is not something support should be
able to do on somebody's behalf.

| Setting | Default | What it does |
|---|---|---|
| `FEATURE_CUSTOMER_ERP` | `false` | The master switch described above. |
| `CUSTOMER_ERP_MAX_CONNECTIONS_PER_ORG` | `5` | Connections one customer may hold. Room for a sandbox, a production system and a migration. |
| `CUSTOMER_ERP_MAX_ATTEMPTS` | `6` | Attempts at one event before it needs a person. Every attempt reuses the same idempotency key, so this bounds noise rather than risking a duplicate. |
| `CUSTOMER_ERP_RETRY_BASE_SECONDS` | `30` | First retry delay. Doubled each attempt, and overridden entirely by the customer's own `Retry-After`. |
| `CUSTOMER_ERP_RETRY_MAX_SECONDS` | `3600` | The cap on that backoff. |
| `CUSTOMER_ERP_FAILURE_THRESHOLD` | `5` | Consecutive failures before a connection is taken out of service until a test passes. |
| `CUSTOMER_ERP_MAX_SYNC_RECORDS` | `5000` | Records read from a customer's ERP in one pass. The rest are taken next pass, from the stored cursor. |
| `CUSTOMER_ERP_MAX_RESPONSE_BYTES` | `2097152` | Bytes of one response held in memory. |
| `CUSTOMER_ERP_OAUTH_STATE_TTL_SECONDS` | `900` | How long an authorisation may stay in flight. |
| `CUSTOMER_ERP_OAUTH_REDIRECT_URI` | *(empty)* | Where a customer's ERP sends them back to. Empty derives it from `API_PUBLIC_URL`, which is right for an ordinary deployment. Set it where a gateway's public address is not the API's own. |
| `CUSTOMER_ERP_ALLOWED_HOST_SUFFIXES` | *(empty)* | Host suffixes a customer's address may end in. Empty means any publicly routable host — see below. |
| `CUSTOMER_ERP_INVITE_TTL_HOURS` | `168` | How long an invitation to join an organisation stays valid. |
| `MONDAY_OAUTH_CLIENT_ID` | *(empty)* | Your registered monday.com app — see below. |
| `MONDAY_OAUTH_CLIENT_SECRET` | *(empty)* | Its secret. Must be set together with the id, or the process refuses to start. |
| `MONDAY_OAUTH_SCOPES` | `boards:read boards:write workspaces:read me:read` | What customers are asked to grant. |

**Registering a monday.com app is optional and changes what customers can do.**
monday's production OAuth uses an app registered by *you*, not by each customer;
every buyer authorises the same app. Without one, the monday connector offers
only the personal-token path, which is restricted to **sandbox** connections —
so a customer can try monday out and cannot run their business on it. Register
an app at monday.com's developer centre, set the redirect URI to whatever
`CUSTOMER_ERP_OAUTH_REDIRECT_URI` resolves to, and put the id and secret here.
The secret is yours: no customer ever sees or types it.

**SAP and custom connections need nothing from you.** Their OAuth client id and
secret belong to the customer, are entered by them, and are encrypted per
connection.

**The host allowlist is a second lock, not the first one.** Every address a
customer types is already refused unless it is HTTPS, resolves to a publicly
routable address, and stays there — the hostname is resolved here, the socket is
pinned to an address that passed, and every redirect target is re-checked. That
is what makes it safe to let a customer supply an address at all. If your
deployment additionally wants to restrict *which* hosts, set:

```
CUSTOMER_ERP_ALLOWED_HOST_SUFFIXES=.monday.com,.ondemand.com,erp.acme.example
```

A leading dot means the domain and its subdomains; anything else is an exact
host. Leave it empty unless you have a reason — customers' ERPs live at
addresses you cannot predict, and the address checks apply either way.

**`ALLOW_PRIVATE_ERP_TARGETS` applies here too**, with the same production
refusal. It is how you point a customer connection at a mock ERP on `localhost`
during development.

**The inbound address** a customer registers with their ERP is
`{API_PUBLIC_URL}/api/v1/erp-inbound/{slug}` and is shown on their connection
screen once they switch webhooks on. Same caveat as above: over a tunnel it has
to be the tunnel's URL.

**The warehouse map has five settings and no required one.** Leaving all of
them empty is a deliberate default rather than something to tidy up: every
provider tells whoever serves it which part of the world is being looked at,
and that is where your warehouses are, so this software does not disclose it on
your behalf. With none set, the markers sit on a plain ground, the scale bar
still works, and the screen says so in words.

**Which one you choose decides what language the place names are in**, and for
most installations that is the only difference that matters. Pick
`MAP_STYLE_URL` if your staff read one language: a vector tile carries every
place's English name as data, so the map reads "Greece", "China" and "Germany"
wherever it is opened. Raster tiles arrive as finished pictures with the local
name already painted in — Ελλάς, 中国, Deutschland — and nothing can translate
them afterwards.

For a **vector map** — one language everywhere, and the recommended choice —
set one variable:

```
MAP_STYLE_URL=https://tiles.openfreemap.org/styles/liberty
```

That one is OpenFreeMap: planet-wide OpenStreetMap data, no API key, no billing
account, run on donations. Their `positron` and `bright` styles are the same
data drawn differently. Commercial providers (MapTiler, Stadia, Protomaps) give
you a style URL with a key in the query string, and a firewalled installation
can serve the whole thing itself with tileserver-gl or Martin over planet
MBTiles.

What goes here is a **style JSON URL, not a tile template**: the style is what
names the tile source, the fonts and every layer's colours. There is a second
setting, `MAP_STYLE_ATTRIBUTION`, which almost nobody needs — a style declares
its own sources and each carries its own attribution, so the credit reaches the
corner of the map on its own.

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

Google's tiles cannot go in `MAP_STYLE_URL` or `MAP_TILE_URL` — they have no
public tile endpoint and their terms forbid reaching for one, which is why they
are separate settings. **The order is Google, then vector, then raster**, so
moving an installation forward means setting the new provider's variables and
nothing else — you never also have to clear the ones behind it.

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

They now carry a geofence too: a delivery radius, a lead-time window, a
delivery fee and a handful of closed countries with real reasons, so the
coverage panel and the storefront's delivery options have something to show. One
of the four deliberately carries **no** radius of its own, because "this
warehouse runs on the deployment default" is a state the screens say something
different about and a fixture list has to produce it.

**`db:seed` stocks every product at every warehouse**, and does two things to
get there worth knowing about:

- It creates a balance row for every stock-keeping unit at every active
  warehouse, with a deterministic quantity — about one in nine lands on zero,
  so "Athens is out of it, Antwerp has it" appears on the storefront's delivery
  options without anybody editing stock by hand. Rows that already exist are
  **left alone**: stock you received while testing is worth more than this
  fixture's opinion. Each row it does create gets the matching `RECEIPT`
  movement, so the ledger explains the balance.
- It switches **stock tracking on** for any unarchived product that has it off,
  and gives it a reorder threshold of 10. A product with `isStockTracked =
  false` holds no quantity anywhere by definition, so a catalogue imported with
  the flag off is a catalogue where every warehouse is empty and nothing on
  screen explains why. This is the one place the seed edits the catalogue; it
  says how many products it changed, and it only ever runs in development —
  the seed refuses `NODE_ENV=production` outright.

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
