<div align="center">

# UBOSS Sourcing

**A self-hosted B2B sourcing and ordering platform.**

A customer storefront, a marketplace other businesses sell through, a staff
console and a carrier portal — all on one Fastify + MariaDB backend.

<p>
<img alt="Node 20.11+" src="https://img.shields.io/badge/Node-20.11%2B-5FA04E?style=flat-square&logo=node.js&logoColor=white">
<img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white">
<img alt="Fastify 5" src="https://img.shields.io/badge/Fastify-5-000000?style=flat-square&logo=fastify&logoColor=white">
<img alt="Prisma 7" src="https://img.shields.io/badge/Prisma-7-2D3748?style=flat-square&logo=prisma&logoColor=white">
<img alt="MariaDB 10.4" src="https://img.shields.io/badge/MariaDB-10.4-003545?style=flat-square&logo=mariadb&logoColor=white">
<img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black">
<img alt="Vite 6" src="https://img.shields.io/badge/Vite-6-646CFF?style=flat-square&logo=vite&logoColor=white">
<img alt="8 languages" src="https://img.shields.io/badge/i18n-8%20languages-4B32C3?style=flat-square">
</p>

</div>

---

## Contents

| | |
|---|---|
| [What this is](#what-this-is) | What the product does, and who runs it |
| [The programs](#the-programs) | Five processes, and which port each answers on |
| [Quick start](#quick-start) | One command on Windows; first-time setup lives in `SETUP.md` |
| [Development sign-ins](#development-sign-ins) | Seeded accounts for each surface |
| [What each surface does](#what-each-surface-does) | Storefront, Seller Hub, console, carrier portal |
| [Configuration](#configuration) | Environment, origins, sign-in location, self-registration |
| [Markets, currencies and prices](#markets-currencies-and-prices) | Opening a market, and keeping converted prices current |
| [Payments](#payments) | Razorpay and Stripe, and the live-key guard |
| [Languages](#languages) | Eight languages, and how to add or translate one |
| [Going live](#going-live) | The ordered checklist |
| [Verifying a change](#verifying-a-change) | What each project gates on |
| [The rules this system is built on](#the-rules-this-system-is-built-on) | Enforced in code, not by convention |
| [Documentation](#documentation) | Which file answers which question |

---

## What this is

A company sells to other companies, and this software runs everything from the
product page to the invoice: catalogue, stock, pricing per market, checkout,
payment, fulfilment, returns and the audit trail behind all of it.

**It is a product other companies buy and run themselves.** Nothing in it
assumes the author is the operator. Every business detail — who you are, what
you charge, which markets you sell in, whether customers may open their own
account — is a setting rather than a value in the source.

Two capabilities are optional and off until switched on:

- **The Seller Hub** turns the storefront into a marketplace. Other businesses
  apply, are approved, and sell alongside the operator; each can have a shop
  front of its own. A seller is a tenant, not a flag on a user — every listing,
  offer, stock record, order group and settlement carries its
  `sellerAccountId`, and no handler reads an owner out of a request.
- **The logistics portal** gives each carrier company its own sign-in, on its
  own hostname, to accept consignments and run its drivers.

---

## The programs

Five processes run at once. Three are browser applications, one is the API, one
is the worker that does everything nobody is waiting for.

```
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│ CUSTOMER STOREFRONT  │  │     ADMIN CONSOLE    │  │  LOGISTICS PORTAL    │
│ apps/customer-web    │  │     apps/admin-web   │  │  apps/logistics-web  │
│ Port 5174            │  │     Port 5173        │  │  Port 5175           │
│ "the shop floor"     │  │     "the back office"│  │  "the carrier's desk"│
└──────────┬───────────┘  └──────────┬───────────┘  └──────────┬───────────┘
           │                         │                         │
           │        all three speak HTTP + JSON                │
           └─────────────────────────┼─────────────────────────┘
                                     ▼
                    ┌─────────────────────────────┐
                    │         BACKEND API         │
                    │   backend/  ·  Port 4000    │
                    │      Fastify + Prisma       │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    │           WORKER            │
                    │  emails, schedules, exports │
                    │      no port; polls a queue │
                    └─────────────────────────────┘
```

| Path | What it is | Port |
|---|---|---|
| `backend/` | API and worker. Fastify 5, Prisma 7, MariaDB | `4000` |
| `apps/admin-web/` | Staff console | `5173` |
| `apps/customer-web/` | Customer storefront, and the Seller Hub inside it | `5174` |
| `apps/logistics-web/` | Carrier portal. Only where `FEATURE_LOGISTICS_PORTAL=true` | `5175` |
| `scripts/` | Stack launcher, translation, catalogue and document tooling | — |

The frontends are separate applications rather than sections of one because
each is signed into by different people on a different hostname. They use
distinct session cookie names (`uboss_admin_*`, `uboss_shop_*`), so a staff
member and a customer can be signed in at once in the same browser — a cookie's
identity ignores the port, and shared names meant signing into one silently
signed you out of the other.

---

## Quick start

Already set up? One command brings the whole stack up, checks it by port, and
restarts anything that is running but not answering:

```powershell
.\scripts\dev-stack.ps1
```

```powershell
.\scripts\dev-stack.ps1 -Status     # what is up
.\scripts\dev-stack.ps1 -Restart    # after pulling new code
.\scripts\dev-stack.ps1 -Stop       # stop everything it started
.\scripts\dev-stack.ps1 -Tunnel     # expose it to somebody not at this machine
```

It opens no windows — that is normal. Logs go to `.dev-logs/`.

> **First time on this machine?** Follow **[`SETUP.md`](SETUP.md)**. It installs
> Node and XAMPP, creates the four databases, configures `backend/.env`, and
> seeds the sample data. This file does not duplicate those steps, so that
> there is one place for them to be correct.

Once it is up:

| | |
|---|---|
| **Storefront** (customers, sellers) | <http://localhost:5174> |
| **Admin console** (staff) | <http://localhost:5173> |
| **Logistics portal** (carriers) | <http://localhost:5175> |
| API | <http://localhost:4000> |
| Readiness, with dependency checks | <http://localhost:4000/health/ready> |
| Metrics (Prometheus) | <http://localhost:4000/metrics> |

**Run exactly one worker locally.** Several can run safely in production — they
claim jobs under a lease — but two started from *different* builds disagree
about which job types exist, and a job the older one cannot handle goes back to
the queue and eventually dies. One worker avoids the whole question.

<details>
<summary><b>Other commands worth knowing</b></summary>

```powershell
cd backend
npm run db:studio        # browse the database
npm run db:seed          # restore or update the sample data
npm run db:reference     # currencies and countries; idempotent
npm run db:reset         # wipe and re-migrate (development only)
npm run openapi:export   # regenerate openapi.json from the live route table
npm run test:watch       # tests in watch mode
```

Migrations have to reach the test database too, or the suite fails on its first
query. In PowerShell an environment variable is set on its own line — the
`VAR=value command` form is a parse error here:

```powershell
cd backend
$env:DATABASE_URL = 'mysql://root@127.0.0.1:3306/uboss_test'
npx prisma migrate deploy
Remove-Item Env:\DATABASE_URL
```

Never run `prisma migrate dev` against this schema — it offers to drop the
database and rewrites constraint names the migrations depend on. `migrate
status` and `migrate deploy` are the two you want.

</details>

---

## Development sign-ins

Created by `npm run db:seed` in `backend`. **These are development seeds** —
delete them before the system goes live; `backend/docs/RUNBOOK.md` has the
procedure, and `backend/scripts/rotate-demo-passwords.ts` does it for you.

**Staff**, at <http://localhost:5173>:

| Email | Password | Role |
|---|---|---|
| `owner@uboss.local` | `OwnerDev!2026` | Business Owner |
| `catalog@uboss.local` | `CatalogDev!2026` | Catalog Manager |
| `inventory@uboss.local` | `StockDev!2026` | Inventory Manager |
| `orders@uboss.local` | `OrdersDev!2026` | Order Manager |
| `finance@uboss.local` | `FinanceDev!2026` | Finance Approver |

**Customers**, at <http://localhost:5174>:

| Email | Password | State |
|---|---|---|
| `buyer@acme.local` | `BuyerDev!2026` | Active — can order immediately |
| `invited@zenith.local` | — | Left un-activated on purpose, to exercise the invitation flow |

**Carriers**, at <http://localhost:5175> — only where the logistics portal is
switched on, and only in development. The seed refuses to create these in
production, because their passwords are printed to a log.

| Email | Password | What it shows |
|---|---|---|
| `carrier.dispatch@uboss.local` | `DispatchDev!2026` | Straight to the dispatcher's dashboard |
| `carrier.owner@uboss.local` | `CarrierDev!2026` | Has to set up a second factor first |
| `carrier.driver@uboss.local` | `DriverDev!2026` | Sees only their own round |

The storefront is browsable without signing in; the sign-in wall sits at the
cart, which is where the backend puts it. On the admin sign-in page, tick the
Terms checkbox — and allow the browser's location prompt, or the session will
not finish (see [Configuration](#configuration)).

---

## What each surface does

<details>
<summary><b>Customer storefront</b> — browse, quote, order, reorder</summary>

Search and category browsing, a product page carrying real per-market prices,
a cart that survives sign-in, and checkout with a warehouse chosen for the
delivery address. After the order: tracking, invoices, returns, and the
customer's own purchase history.

Two ordering patterns beyond the one-off basket:

- **Recurring orders** — a schedule that places a real order on a cadence.
- **Buy Later / Subscribe & Reorder** — a basket priced by `quoteSchedule` and
  nothing else, so the figure the customer confirmed on the review screen and
  the figure charged weeks later come from one place.

Optionally the customer's own ERP can collect orders and post back receipts.

</details>

<details>
<summary><b>Seller Hub</b> — other businesses selling through the same shop</summary>

Off unless enabled. A business applies, is reviewed and approved, and then has
its own console inside the storefront: listings, offers, stock, orders to pack,
shipments, returns and settlements.

**Selling shares the account somebody buys with, and the Hub has its own
password.** One email, one identity, one order history — and a second secret in
front of the Hub, chosen the first time it is opened and required to differ from
the shop password. Entering it is remembered per browser rather than per
account, so a new machine is asked again; changing it shuts the Hub everywhere
else and leaves those shop sign-ins alone. It is not a second factor and nothing
calls it one.

A **product** is the thing itself — its name, specifications, photographs. An
**offer** is what one seller will supply it for. Ten sellers offering the same
item produce one product row and ten offers, because "the same product" must
not mean "the same price". `isMarketplaceProduct` says price and stock come
from the offers rather than from the product row.

Give a seller a shop front of its own with `SELLER_STOREFRONT_DOMAIN`:
`northwind.localhost:5174` serves the shop of the seller whose slug is
`northwind`. Leave it empty and there are no seller shop fronts at all — every
request is the operator's own shop, which is what a single-supplier deployment
wants. The API reads it once at boot, so it needs a restart, not a file save.

The marketplace is **general**, not tied to one trade. Questions specific to a
trade hang off the category rather than the global field list.

**Certificates are uploaded, not emailed.** Both document steps of the
application take a PDF or a photograph of a CE certificate, a Declaration of
Conformity, an ISO certificate, a licence or a registration document. The bytes
go to private storage and come back only through a link that lives minutes and
works once. Uploading is not approving: a document sits at *Being checked* until
the marketplace accepts it on the seller's own screen in the console, a refusal
carries a reason the seller reads word for word, and an expired certificate
stops counting on the day it expires. Waiting on the marketplace never blocks
submission — the review happens after the application is sent in.

**A brand name is marketplace-wide; permission to sell it is per company.** The
brand picker shows a seller the brands their own business has been approved for
and nobody else's, so a name approved for a competitor never reads as
permission. Asking for one that already exists attaches to the same brand row,
so the catalogue never grows a second "B. Braun".

</details>

<details>
<summary><b>Admin console</b> — the back office</summary>

Catalogue and categories, inventory across warehouses, orders and payments,
customers and their credit terms, coupons, sellers and their applications,
carriers and consignments, settings, integrations, and an append-only audit
log.

**Companies** is the way into all three audiences at once. A business can buy,
sell and carry here at the same time, and those are three accounts in three
tables under three slightly different names; that screen groups them by the
company they belong to and nests what it finds — company, then its accounts,
then the people inside them, each person badged with every account they belong
to. It is read-only: every decision still happens on the screen that owns it.
Sellers and buyers need `customer.read`, carriers `logistics.read`, and
somebody holding one of the two sees only that half.

The dashboard opens on a reporting window and carries, for each headline
figure, the change against the window of equal length before it and the shape
of the days behind it — so a month's total that arrived in one afternoon does
not read as a steady month. Where the preceding window holds nothing, the tile
says so rather than reporting a rise out of nothing. Underneath, one bar shows
where every order in the period sits, from the earliest stage through to
delivered.

**The navigation rail counts what is waiting.** Every row with a queue behind
it carries a number when anything is in it — listings in review, brands asked
for, orders held for an approver, sign-ups at the approval gate, data requests,
open consignment exceptions, and seller applications together with the
certificates attached to them. Each count is gated by the permission that makes
it actionable, and a count the signed-in user may not see is absent rather than
zero. Beside the notification bell there is a **refresh control** — the Seller
Hub has the same one — which re-reads the screen without losing the scroll
position or an open dialog, for the everyday case of two people working the
same queue from two sides.

Two things it deliberately cannot do: mark an order as paid (only a
signature-verified provider event confirms one), and publish a product by
accident (a product reaches customers only when it is both Active *and*
Published; bulk import can activate, never publish).

</details>

<details>
<summary><b>Logistics portal</b> — the carrier's own desk</summary>

Gated by `FEATURE_LOGISTICS_PORTAL`. A carrier company signs in on its own
hostname and sees only its own work: consignments to accept or decline,
collections, dispatch manifests, exceptions, its drivers and vehicles, and a
driver's own round with proof-of-delivery capture. The dashboard leads with one
bar splitting the whole workload between waiting, moving, finished and gone
wrong, so a dispatcher can see whether the day is still to collect or already
out.

There is no public registration. A carrier is created from **Logistics →
Carriers** in the console, which sends a one-time activation link; the person
who opens it chooses their own password.

Live vehicle tracking is not part of this release, and nothing in the interface
suggests otherwise. Where a driver's device has reported a position the last
one is shown with the time it was recorded, kept for a limited period, visible
only to the people who need it, and never recorded outside working hours.

</details>

<details>
<summary><b>Worker</b> — everything nobody is waiting for</summary>

Emails, recurring and scheduled orders, autopay charges, payment-link expiry,
exports, exchange-rate refreshes, webhook delivery and retries.

It claims jobs under a lease rather than `FOR UPDATE SKIP LOCKED`, which
MariaDB 10.4 does not have: a conditional `UPDATE` plus an `affectedRows`
check. A worker that does not recognise a job type returns it to the queue for
another to take, rather than marking it dead and silently losing the work.

</details>

---

## Configuration

Everything is read from `backend/.env` and validated at boot by
`src/config/env.ts`. The server refuses to start on a bad value rather than
running half-configured.

The ones that must match:

| Variable | Must be |
|---|---|
| `ADMIN_WEB_ORIGIN` | The console's exact origin. Default `http://localhost:5173` |
| `CUSTOMER_WEB_ORIGIN` | The storefront's exact origin. Default `http://localhost:5174` |
| `LOGISTICS_WEB_ORIGIN` | The carrier portal's exact origin. Default `http://localhost:5175` |
| `CUSTOMER_WEB_PUBLIC_URL` | Where activation and password-reset links point |
| `apps/*/.env` → `VITE_API_BASE_URL` | The API's base URL. Default `http://localhost:4000/api/v1` |

The CORS allowlist is exact — a mismatch blocks every request from the browser
— and all three frontends use `strictPort`, so a clash fails loudly rather than
moving silently to a port CORS will reject.

The storefront reads its branding, timezone, policy links, capability flags and
the markets it sells in from `GET /api/v1/config` at runtime, so none of it is
hard-coded in the client. It offers only currencies the catalogue is actually
priced in — a currency staff activated but never priced anything in would
otherwise give the shopper an empty shop with no explanation.

<details>
<summary><b>Where each sign-in happened</b></summary>

Staff signing in to the console are asked for the device's location before the
panel opens, every time. Until the browser answers, the session can reach
`/me`, `/logout` and nothing else — every other admin route returns
`403 LOCATION_REQUIRED`, so the gate is not something a different client can
skip. The place is recorded on the session and posted to the console bell,
where anyone holding `staff.read` sees *"someone@example.com signed in from
Pune, Maharashtra"* the moment it happens.

That is the point of it: a shared console behind nothing but a password gives
the people running the shop no way to notice a sign-in nobody made. The
coordinates are evidence for a person to read and never an authorisation input
— nothing decides access from *where* they point, only from whether they were
given at all.

| Variable | What it does |
|---|---|
| `FEATURE_ADMIN_LOGIN_LOCATION` | The requirement itself. Default `true` |
| `GEOCODE_REVERSE_URL` | Turns coordinates into a place name. `{lat}` and `{lon}` are substituted. Empty switches the lookup off and the bell shows coordinates |
| `GEOCODE_TIMEOUT_MS` | How long to wait for it. Default `5000` |

**The console must be served over HTTPS.** The browser Geolocation API exists
only in a secure context, so on plain HTTP (anything but `localhost`) no member
of staff can ever satisfy this and everyone is locked out. Put the console
behind HTTPS, or set `FEATURE_ADMIN_LOGIN_LOCATION=false`.

The reverse lookup is the one part of this that leaves the building, which is
why it is a URL rather than a fixed host — point it at your own geocoder, or
switch it off. It is best-effort in every failure: a geocoder that is slow,
firewalled or down leaves the place as coordinates and never blocks a sign-in.
The default is OpenStreetMap's Nominatim, whose usage policy asks for no bulk
querying; one lookup per admin sign-in is well inside it.

</details>

<details>
<summary><b>Adding a member of staff</b></summary>

A Business Owner creates the account from **Staff**. There is no password field
on that form: the system generates a one-time password, emails it, and nobody —
including the person who created the account — ever sees it.

Signing in with it works, and then does exactly one thing: it puts them on a
*Choose your password* screen. Until they finish, **every admin route answers
403** — the block is `mustChangePassword` in `plugins/auth.ts`, not the screen,
so it holds for an API client too.

The temporary password lapses after **72 hours**, because unlike the activation
link it replaces it sits in an inbox rather than being single-use. If it goes
astray, **Staff → Resend password** issues a new one and kills the old. That
button disappears once the holder has a password of their own, at which point
the way back in is the reset they start themselves — so a colleague cannot mint
a credential for somebody who already has one.

Both directions answer identically for an address with no account. A form that
said "no such staff account" would be a way to find out who works here.

For any of this to leave the machine, `EMAIL_DRIVER` must be `smtp`. On `log`
the email is printed to the worker terminal instead — fine for development, and
where you will find the password or the link while testing.

</details>

<details>
<summary><b>Letting customers open their own account</b></summary>

Off by default. Accounts are created by invitation: a colleague adds the
customer, the system emails a single-use activation link, and the customer
chooses their own password — no administrator ever sees it.

| Variable | What it does |
|---|---|
| `FEATURE_CUSTOMER_SELF_REGISTRATION` | The sign-up form itself. Default `false` |
| `CUSTOMER_SELF_REGISTRATION_REQUIRES_APPROVAL` | Whether a confirmed account still waits for staff. Default `true` |

The form asks for a name, an email address, a mobile number and a country, plus
a password. The country is not an address field: this catalogue holds a real
price per market rather than converting one, so the answer decides what every
price that account is shown is quoted in — and answering it here is why the
storefront's "where are you ordering from?" prompt never interrupts a first
visit.

An account then passes two gates before it can order:

1. **The confirmation link**, emailed on sign-up and valid for 48 hours. Until
   it is opened the account cannot sign in — this is what stops somebody
   registering with a competitor's address, or a typo'd one that silently
   swallows every later email.
2. **A member of staff**, unless the approval flag is `false`. Prices,
   purchasing limits and credit terms here are per customer, so an unreviewed
   account is a commercial decision rather than an inbox check.

Confirmed sign-ups appear in the console bell and under **Customers → Awaiting
approval**. Approving emails the holder to say the account is open; they sign
in with the password they chose, and approval never issues a credential. The
button does not appear while the confirmation link is unopened, and the
endpoint refuses that case too: approving then would hand a live account to
whoever *typed* the address rather than to whoever owns it.

**The form never says an email address is already taken.** A sign-up that
answered "that email is registered" lets anybody walk a list of addresses
through it and learn who buys from you — for a B2B supplier, that list is the
customer list. A duplicate gets the same status code and the same body as a new
sign-up, and the truth goes to the mailbox instead: the address receives a "you
already have an account" email with a reset link. The same reasoning governs
`/auth/password/forgot`.

</details>

<details>
<summary><b>Certificates a seller uploads</b></summary>

A seller attaches evidence — a CE certificate, a Declaration of Conformity, an
ISO certificate, a licence, a registration document — from the Compliance and
Identity steps of their application. What the deployment actually *requires* is
`SellerOnboardingRequirement` rows, keyed by country and seller kind, which an
operator edits. Nothing is required by default: the marketplace is general, and
a seller of packaging has no quality certificate.

Only PDFs and pictures are accepted, decided by the file's own magic bytes and
never by what the browser claims, up to 10 MB. The bytes are written under the
private storage prefix, which the static route is not mounted over, and are
served only through a link minted per press that lives minutes and works once —
as a download with `nosniff`, never rendered in the page.

| Variable | What it does |
|---|---|
| `SELLER_ALLOW_UNSCANNED_DOCUMENTS` | Whether a file no malware scanner has seen may be opened. Default `true` |
| `LOGISTICS_DOCUMENT_URL_TTL_SECONDS` | How long a signed document link lives, for these and for carrier documents. Default `300` |

No malware scanner ships with this software, so an upload records
`SCANNER_UNCONFIGURED` rather than "clean" — and the state is shown beside every
document on both the seller's screen and the operator's. The default is `true`
because a reviewer who cannot open the evidence cannot decide the application at
all, and the alternative is certificates going back to arriving by email where
nobody can find them again. Set it `false` once a scanner is wired in, or where
policy forbids opening unscanned files.

Uploading is not approving. A document sits at *Being checked* until somebody
accepts it from the Documents card on that seller's screen in the console; a
refusal must carry a reason, which the seller reads word for word. Accepting,
refusing and opening one are all recorded — on the operator's audit trail,
where an auditor asks who accepted a certificate and when, and on the seller's,
where the marketplace appears as a role rather than as a named member of staff.

</details>

---

## Markets, currencies and prices

A currency being active is not the same as a market existing. The catalogue
holds a real, staff-entered figure per currency and the storefront never
converts at read time — a converted number drifts with the rate, and the buyer
would be charged something other than what the page showed. So a currency
nobody has priced anything in is invisible: dropped from the switcher, and the
language signal will not send anybody to it.

Two ways to fill one in:

- **Per product**, in the product editor's currency prices panel. This is the
  authority — every figure is one a person typed for that market.
- **Products → Currency pricing**, which converts an entire price list at a rate
  you enter and writes the results as ordinary price rows. It converts *once*,
  on write. Nothing tracks the rate afterwards, so the quoted price is still the
  charged price. It previews before it writes, never targets the base currency,
  leaves already-priced products alone unless told otherwise, and is capped at
  5,000 prices per run.

<details>
<summary><b>Keeping converted prices current</b></summary>

**Settings → Automatic exchange rate updates.** Once a day a background job
fetches rates, re-converts every price that conversion produced, and stores the
results. The storefront still never converts at read time — it quotes a stored
figure, so the amount charged is the amount the page showed — but that stored
figure no longer sits at last spring's rate.

Four things bound what an unattended job can do:

- **It only touches what it wrote.** `product_prices.isAutoConverted` is set by
  the bulk tool and cleared the moment anyone edits that price by hand. A
  deliberate local price is out of the job's reach, permanently.
- **It refuses a suspicious move.** If any single price would move by more than
  `maxDriftPercent` (15% by default) the whole run is abandoned and nothing is
  written — a feed returning a wrong base or a shifted decimal is a
  catalogue-wide mispricing that nobody is awake to catch.
- **It only refreshes markets that already exist.** A currency nobody has priced
  anything in stays empty. Opening a market is a decision; this is not the thing
  that makes it.
- **It is off until switched on**, and "Refresh now" runs exactly the same code
  as the schedule, so the button is a real rehearsal rather than a second path
  that resembles one.

`marginPercent` is added on top of the mid-market rate, as a buffer against it
moving between runs and against the spread the business pays to settle.

Rates come from `FX_RATE_URL`, which defaults to a free, keyless feed
(`https://open.er-api.com/v6/latest/{base}`). It lives in the environment
rather than the console so a deployment behind a firewall can point at its own
mirror, and so no administrator can aim the server at an arbitrary URL. The
pricing dialog uses the same feed to pre-fill today's rate, which staff may
overwrite.

Reference data — the currencies and countries themselves — is installed by
`npm run db:reference`. It is idempotent: an existing deployment picks up newly
added markets without touching its own settings, and staff-retired currencies
are not resurrected. **It is not optional.** The catalogue is priced per
currency, so without it the storefront renders an empty shop and says nothing
about why.

</details>

---

## Payments

Two gateways, **Razorpay** and **Stripe**, behind one interface — order code
never learns which is in use. Exactly one connection is active at a time;
`PAYMENT_DEFAULT_PROVIDER` decides which set of keys is preferred when both are
present.

`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`, or `STRIPE_PUBLISHABLE_KEY` /
`STRIPE_SECRET_KEY`, in `backend/.env` are the development fallback. In
production, credentials are entered through **Integrations** and stored
encrypted (AES-256-GCM, bound to the connection row).

For Stripe, the **publishable** key (`pk_`) goes in *Key id* — it is sent to
every customer's browser to open the payment form — and the **secret** key
(`sk_`, or `rk_` for a restricted key) goes in *Key secret*, where it never
leaves the server. Pasting them the wrong way round is refused at save rather
than after a failed test, because the secret key would otherwise be published.
A publishable key from one environment paired with a secret key from the other
is refused for the same reason it is hard to diagnose: the handshake succeeds
and no payment can ever be confirmed.

**A live key cannot be used outside production.** `src/config/env.ts` refuses
to start when `NODE_ENV !== 'production'` and the key begins `rzp_live_`,
`sk_live_` or `pk_live_`:

> refusing to start: this is a LIVE Razorpay key and NODE_ENV is not
> production. Live keys move real money.

The same distinction runs through the console: a `rzp_live_` key filed under
Test mode is rejected at save, LIVE mode is labelled *"real money"* everywhere
it appears, and activating a live connection asks for confirmation in those
words.

---

## Languages

All three front ends ship in eight languages: English (the default and the
fallback), Dutch, French, German, Greek, Italian, Polish and Spanish, on
**i18next / react-i18next**, one instance per app.

A visitor's language is resolved most-specific-first — the signed-in account's
saved `preferredLanguage`, then a choice made in this browser, then whatever
`navigator.languages` asks for, then English. The browser step puts a Polish
buyer on a Polish storefront before they have touched anything, and
`load: 'languageOnly'` is what makes Belgium work: `nl-BE` and `fr-BE` resolve
to Dutch and French without either needing a locale of its own. A choice made
in the picker is written to localStorage and outranks the browser permanently.

The **logistics portal is the exception, deliberately**: it has no account step,
so the order there is the browser choice, then `navigator.languages`, then
English. A member of staff signs in from several machines and expects the
console to follow them; a dispatcher signs in from the one desk in the depot
and a driver from the handset in their pocket, and the browser's own memory is
the right scope for both. Each app also keeps its own localStorage key
(`uboss.language`, `uboss.admin.language`, `uboss.logistics.language`), so
switching one to Greek on a host where all three are served does not switch the
other two.

The picker sits on every sign-in, activation and password screen in all three
apps, and in the header once inside. Putting it only behind a settings page
would hide it from the one person who needs it most: somebody who cannot read
the interface well enough to navigate to that page.

```
apps/*/src/i18n/config.ts        the i18next instance - detection, lazy loading, fallback
apps/*/src/i18n/languages.ts     the registry - code, endonym, Intl locale
apps/*/src/i18n/i18next.d.ts     types every key against en.json
apps/*/src/i18n/locales/en.json  the source catalogue; every other file answers to it
apps/*/src/i18n/locales/*.json   one file per language, all keys optional
backend/src/modules/identity/language.service.ts   the API's copy of the list
```

Each language is a dynamic import, so Vite emits one chunk per language
(~3 KB gzipped) and a visitor downloads only the one they read. English is
bundled with the app because it is also the fallback for every key a
translation has not covered.

Two settings are load-bearing and must match between `config.ts` and
`i18next.d.ts`: `keySeparator: false` and `nsSeparator: false`. The keys are
flat strings containing dots (`auth.login.heading`); read as paths they would
nest into unusable objects, and TypeScript would resolve every key to `never`.

The apps keep separate catalogues on purpose. They share an engine, not a
vocabulary: "Orders" is a staff work queue in the console and a buyer's own
purchase history in the storefront, and several words identical in English
diverge once translated.

> **The non-English catalogues are machine-translated and have not been
> reviewed by a native speaker.** Every app says so, under the picker, on any
> non-English language. Have a speaker read them before selling into that
> market, then delete `TranslationQualityNotice` and the `isMachineTranslated`
> flag behind it.

<details>
<summary><b>Language as a pricing signal</b></summary>

Language is not location, and the two stay separate settings — a Polish buyer
paying in euro is an ordinary case. But the interface language is often the only
signal a first-time visitor gives, so each entry in the storefront's
`languages.ts` carries a `suggestedCountry`, used in exactly two places:

- **Nobody has answered yet.** The language's market becomes the starting
  currency. It ranks below a saved profile and below a choice made in this
  browser, and above the deployment's base currency.
- **They have answered.** Nothing is repriced, ever. `MarketSuggestionBanner`
  offers the switch instead, naming both currencies, and a refusal is remembered
  in `uboss.locale.declined` so the same offer is not made twice.

Both are filtered against the deployment's own reference data: the country has
to be one staff activated, and its currency one the catalogue is actually
priced in — so a store selling only in India never sends a Polish reader to an
empty złoty shop. English carries no country: it is read across every market
this ships into, so an English reader keeps the currency they already have.

</details>

<details>
<summary><b>Translating the catalogue</b></summary>

The interface catalogues ship translated. A shop's own products cannot — every
deployment sells something different — so **Settings → Catalogue translation**
does the same job from inside the console, writing `product_translations` and
`category_translations`.

Paste a DeepL key (encrypted at rest with `SECRETS_ENCRYPTION_KEY`; only its
last four characters are ever shown again), press Estimate to see the character
cost, then Translate now. What it will not do:

- **Overwrite a reviewed row.** `isReviewed` means a person read it.
- **Overwrite an unreviewed row** unless asked, so re-running after adding ten
  products costs ten products, not the whole catalogue.
- **Translate an identifier.** `sku`, `slug` and variant names stay as they are:
  a gauge and a material are not words a translator should touch.

Copy is sent as XML so the do-not-translate terms survive, which means every
string is escaped on the way out and unescaped on the way back. One unescaped
ampersand in a product description would otherwise fail the whole batch with a
parser error naming a column rather than a product.

A run is capped at 100 rows per language so it finishes inside one request. A
large catalogue is translated by pressing the button a few times; every press
saves what it did.

`translation.service.ts` decides how rows are read: field by field, with the
base row filling any gap — so a product whose Polish name exists but whose
Polish description does not shows the Polish name beside the English
description, rather than reverting the whole product to English.

</details>

<details>
<summary><b>Adding a language</b></summary>

1. Add it to `LANGUAGES` and `LanguageCode` in every `languages.ts`. The
   storefront entry also needs a `suggestedCountry`: the market that language
   implies, or `null` when it implies none.
2. Copy `locales/en.json` to `locales/<code>.json` in each app and translate.
3. Add the code to `SUPPORTED_LANGUAGES` in the backend service. The API
   rejects anything not on that list, so a language missing here can be picked
   in the UI and then fail to save.

No loader to register: `config.ts` imports the whole `locales` directory.

Catalogues are merged over English, so a half-finished translation is a normal
state rather than a build error — missing keys render in English. `npm run
test` in `apps/customer-web` gives a per-language coverage report and three
guards a type cannot: no invented keys, no dropped `{{placeholder}}`, and every
plural form the language actually needs. That last one is not academic — it
caught French, Italian and Spanish missing their CLDR `many` form, which those
languages use at exact millions.

</details>

<details>
<summary><b>Translating in bulk</b></summary>

`en.json` is written by hand — it is the source text, and nothing should
machine-generate it. The others are filled by DeepL:

```powershell
npm install --prefix scripts          # once - pulls in deepl-node
$env:DEEPL_API_KEY = 'your-key-here'

node scripts/auto-translate.mjs apps/customer-web --dry-run   # what would be sent
node scripts/auto-translate.mjs apps/customer-web             # do it
node scripts/auto-translate.mjs apps/admin-web
node scripts/auto-translate.mjs apps/logistics-web
```

A free DeepL key covers the whole codebase: the apps come to roughly 430,000
characters across seven languages, against a 500,000/month free allowance.

The script **never overwrites an existing value.** Only keys present in
`en.json` and absent from the target file are sent, so it is safe to re-run and
a human correction is permanent. Three things it handles that a naive
`translate(json)` would get wrong:

- **Placeholders.** `{{email}}` is a token, not a word. Each is wrapped in a tag
  DeepL is told to ignore, along with `UBOSS`, `Business Owner` and the other
  terms in `KEEP`, so they come back verbatim.
- **Register.** `formality: prefer_more` pins the Sie/usted/vous form a supplier
  owes a business customer. DeepL supports it for six of the seven languages —
  **not Greek**, so Greek register needs a read-through.
- **Plurals.** English declares `_one`/`_other`; the script expands that to
  whatever CLDR says the target needs (four for Polish) before sending. It
  fills them all, because a wrong ending beats a missing key, but it prints
  every counted key at the end as needing a human — those endings cannot be
  derived from an English source.

Translation is deliberately a build step, not a runtime one. Translating on the
fly would cost per pageview, add latency, produce different wording on two
loads of the same button, and put a network dependency between a self-hosted
deployment and its own interface. Committed JSON is reviewable in a pull
request; an API response is not.

Run the guards afterwards — they are what makes machine output safe to ship:

```powershell
cd apps/customer-web
npm run test -- src/i18n
```

</details>

<details>
<summary><b>Adding a string</b></summary>

Add it to `en.json` first — it is both the source of truth and the fallback.
Two rules keep these files translatable: name keys for **where the string
appears** rather than what it says, and keep **one key per sentence a reader
sees**. A sentence assembled from two keys works in English and breaks in Greek
and Polish, where word order and case endings depend on the whole clause.

Anything that varies goes in as a `{{placeholder}}`. Anything counted gets
`_one` / `_other` suffixes and is read with `t('key', { count })`; i18next asks
`Intl.PluralRules` which form to use, and a translator adds whichever their
language takes — Polish needs four.

When a sentence has to contain a link or other markup, use react-i18next's
`<Trans>` rather than splitting the sentence into two keys. Splitting forces
English word order onto every other language in the directory.

`npm run i18n:extract` (in `customer-web` and `admin-web`) scans the source for
keys and writes them to `.extracted/` (gitignored) to diff against
`locales/`. It deliberately does not
write to `locales/` itself: `en.json` is hand-written, and keys referenced
indirectly — `labelKey: 'nav.orders'` in a navigation map rather than a literal
`t()` call — are invisible to a static scan and would be deleted.

A new key needs the dev server restarted. Raw keys in the browser after adding
one are a Vite cache, not a code bug.

</details>

---

## Going live

<details open>
<summary><b>The ordered checklist</b></summary>

1. **Set `NODE_ENV=production`.** This turns on secure cookies, proxy trust and
   stricter logging. It also refuses to start on an `.env.example` placeholder
   secret, a test gateway key, the `log` email driver or local disk storage.
2. **Generate fresh secrets** — `SESSION_COOKIE_SECRET`, `ACCESS_TOKEN_SECRET`,
   `REFRESH_TOKEN_SECRET`, `SECRETS_ENCRYPTION_KEY`. Never reuse development
   values.
3. **Migrate, then install the reference data.**
   ```powershell
   cd backend
   npm run db:migrate:deploy
   npm run db:reference        # safe and idempotent in production
   ```
   Without currencies and countries the catalogue cannot be priced at all.
4. **Price the catalogue in every currency you intend to sell in.** A product
   with no price row for a currency is not sold in that market — it is left out
   of that grid entirely, deliberately, rather than converted at a rate.
5. **Enable your gateway account for each of those currencies.** The order
   carries its own currency all the way to the provider, and the provider will
   refuse a currency the account is not enabled for.
6. **Point the gateway's webhook at its endpoint** —
   `POST /api/v1/payments/webhooks/razorpay` or
   `POST /api/v1/payments/webhooks/stripe` — and paste the signing secret into
   **Integrations**. A gateway cannot be activated without one: an order is
   confirmed only by a signature-verified event, so a connection with no secret
   would charge customers and confirm nothing.

   On Stripe, subscribe to `payment_intent.succeeded`,
   `payment_intent.payment_failed`, `charge.refunded`, `refund.updated` and
   `refund.failed`. Leave `charge.succeeded` off: it reports the same capture as
   `payment_intent.succeeded` under a different event id, so the
   duplicate-delivery guard would not catch it and the order would be credited
   twice. Stripe also refuses a delivery signed more than five minutes ago, so
   keep the server's clock on NTP.
7. **Give each customer terms in every currency they may buy in.** Purchasing
   limits are per currency, and an account with terms in one market and none in
   another is refused in the second rather than having its credit control
   silently dropped.
8. **Build everything.**
   ```powershell
   cd backend            ; npm run build ; npm run start     # and npm run start:worker
   cd apps/admin-web     ; npm run build                     # serve dist/ as static files
   cd apps/customer-web  ; npm run build
   cd apps/logistics-web ; npm run build                     # only if the portal is on
   ```
   Roll workers out together. Several can run at once, but two on *different*
   builds disagree about which job types exist, and one that cannot handle a job
   returns it to the queue until its attempts run out.
9. **Serve each `dist/` with a history fallback** — they are single-page apps,
   so every unknown path must return `index.html`, or a refresh on
   `/account/orders/123` gives a 404.
10. **Give each frontend its own hostname** if you can. They no longer share
    session cookies either way, but separate origins keep the CORS allowlist and
    the cookie scopes obvious. The carrier portal is designed for this — it is a
    third application rather than a section of one of the others precisely so a
    carrier signs in somewhere that is not your console.
11. **Delete the seeded accounts** and create real ones from **Staff**.
12. **Work through `backend/docs/RUNBOOK.md`** for backups, restore drills and
    incident procedure.

</details>

---

## Verifying a change

Each project gates on the same checks:

```powershell
cd backend            ; npm run verify   # typecheck, lint, tests against a real MariaDB
cd apps/admin-web     ; npm run verify   # typecheck, lint, contrast audit, build
cd apps/customer-web  ; npm run verify   # typecheck, lint, contrast audit, tests, build
cd apps/logistics-web ; npm run verify   # typecheck, lint, contrast audit, tests, build
```

**Run the backend suite on its own.** It truncates tables in `uboss_test`, and
two verify runs at once share that one database and produce a long list of
failures that have nothing to do with the change. The suite also refuses to run
against `DATABASE_URL` at all, for the same reason.

`backend/openapi.json` is generated from the live Fastify route table
(`npm run openapi:export`), so it cannot drift from what the server serves — a
contract test fails the build if it does.

---

## The rules this system is built on

Enforced in code. Changing any of them is a deliberate act rather than an edit.

- **Money is never a float.** Every amount is an integer of minor units,
  carried as a *string* on the wire because a paisa-precise total can exceed
  `2^53`. `Number(minor) / 100` is the bug the string exists to prevent.
- **An amount is never read in a currency it was not entered in.** Catalogue
  prices, coupon thresholds and purchasing limits are held per currency, and
  there is no exchange rate anywhere in the ordering path. A rate would make
  the listed price drift from the settled one; converting a threshold would
  make a business rule move with the market.
- **Tax is charged on the discounted amount.** A coupon's share is apportioned
  across the eligible lines with largest-remainder before tax is calculated, so
  the per-line figures sum to the total charged.
- **Order status changes only through `assertTransition`.** No service writes
  `status` itself. Plan and occurrence status go through the assertions in
  `schedule-state.ts` for the same reason, and it matters more there: an
  occurrence changes status inside a worker with nobody watching, and the states
  it moves between decide whether a card is charged.
- **A scheduled basket is priced by `quoteSchedule` and nothing else.** The
  review screen the customer confirms and the worker that charges them weeks
  later both call it, so the number agreed and the number charged come from one
  place.
- **An order is confirmed only by a signature-verified provider event.** Not by
  a browser redirect, not by an admin button. There is no "mark as paid"
  anywhere, and no simulated-success branch in the payment module.
- **A job is never destroyed by the worker that cannot run it.** Several workers
  run at once and, mid-deploy, at different versions. One that does not
  recognise a job type returns it to the queue rather than marking it dead.
- **Stock cannot oversell.** Reservations are taken inside the order
  transaction; a concurrency test drives ten workers at stock of three and
  exactly three succeed.
- **Duplicate protection is structural.** Unique indexes, not procedural checks
  — a redelivered webhook collides on insert, a double-clicked import confirm
  collides on the SKU index.
- **Nothing is published by accident.** A product reaches customers only when it
  is both Active *and* Published. Bulk import can activate; it can never
  publish.
- **One seller cannot read another seller's data.** Every owned row carries its
  `sellerAccountId`, no route takes one from the caller, and no service accepts
  a seller id without having been handed a membership first.
- **A brand is one row; permission to sell it is one company's.** Approving a
  name puts it in the catalogue once, for everybody. Approving a seller's
  *request* is what lets that business list under it, and the picker and the
  publish gate both read the same answer — so a name approved for a competitor
  is never offered as though it were permission.
- **A file is never called clean because nothing looked at it.** No malware
  scanner ships here, so an upload records `SCANNER_UNCONFIGURED`, the state is
  shown wherever the document is, and whether an unscanned file may be opened is
  a setting somebody decides rather than an assumption the code makes.
- **The audit log is append-only.** Every state change records who, when, from
  where and why. No screen offers a way to edit or delete an entry.
- **One order per checkout.** The idempotency key is generated once per attempt
  and reused across retries. A double-click, a timeout retry and two concurrent
  submissions all resolve to the same order.
- **Product HTML is never rendered raw.** The backend sanitises on write and the
  storefront sanitises again with `DOMParser` before display.
- **Error codes in `backend/src/domain/errors.ts` are a published contract.**
  Every frontend maps each code to a message in eight languages. Add new codes;
  never repurpose an existing one.
- **A table holding personal data is disclosed in the GDPR export.** A new table
  with a `userId` or `customerProfileId` fails
  `tests/unit/export-bundle-completeness.test.ts` until the Article 15 export
  accounts for it — either by disclosing it or by listing it as out of scope
  with the reason.

---

## Documentation

| File | Answers |
|---|---|
| **[`SETUP.md`](SETUP.md)** | How to install and run it on a new machine |
| **[`PROJECT-GUIDE.md`](PROJECT-GUIDE.md)** | What every piece does, and how a request travels from a click to a row. No prior knowledge assumed |
| `PROJECT-GUIDE.hinglish.md` | The same document in Hinglish (not committed; gitignored on purpose) |
| **This file** | Features, configuration, markets, payments, languages, going live |
| `backend/README.md` | Backend architecture, schema and migration notes |
| `backend/docs/HANDOFF.md` | Environment details, the MariaDB constraints that shaped the schema, the full endpoint map, and what is deliberately not built |
| `backend/docs/RUNBOOK.md` | Backups, restore drills, incident procedure, going-live tasks |
| `backend/docs/STATUS.md` | What is built, what is not, and the reasoning behind the money and tax rules |
| `backend/docs/DATA-PROTECTION.md` | GDPR: what is held, for how long, and how it is exported and erased |
| `backend/docs/EU-VAT.md` | VAT handling for European markets |
| `backend/docs/ACCESSIBILITY.md` | The accessibility commitments and how they are tested |
| `backend/docs/PRODUCT-SAFETY.md` | Product-safety and compliance fields |
| `backend/docs/FRONTEND-INTEGRATION.md` | Contract notes for a client talking to this API |
| `output/UBOSS_Sourcing_Feature_Guide.docx` | Every feature in plain language, for a non-technical reader. Generated — edit `scripts/build-feature-guide-doc.mjs` and rebuild, never the `.docx` |
| `CLAUDE.md` | The rules for working in this repository |

### Keeping the docs true

A guide that has quietly stopped being true is worse than no guide, because
people trust it and act on it. So documentation is part of the change that
causes it, not a task for later:

- **This README** is updated with every change that alters a feature, a
  surface, a setting, a port, a command or a rule stated here.
- **`PROJECT-GUIDE.md` and `PROJECT-GUIDE.hinglish.md`** are one document in two
  languages and are updated together, in the same piece of work.
- **`SETUP.md`** is updated whenever the way the project is started changes.
- **The feature guide** is regenerated from its script (`cd scripts && npm run
  guide`) whenever a feature is added, changed or removed.

`CLAUDE.md` states this as a requirement and lists what counts as a change.
