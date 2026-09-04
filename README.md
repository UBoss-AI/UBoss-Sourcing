# UBOSS Sourcing

A B2B sourcing and ordering platform: a Fastify + MariaDB backend, a staff
admin panel, and a customer storefront.

```
backend/            API, worker, database. Node 20.11+, Fastify 5, Prisma 7, MariaDB.
apps/admin-web/     Admin panel (staff). Vite, React 19, TypeScript strict. Port 5173.
apps/customer-web/  Customer storefront. Vite, React 19, TypeScript strict. Port 5174.
```

---
## Running it locally

**Prerequisites**: Node 20.11+, and MariaDB or MySQL on `localhost:3306`
(XAMPP is fine — that is what this was developed against).

### 1. Clone, and create both databases

The test suite uses its own database and **refuses to run against
`DATABASE_URL`**, because it truncates tables. Create both up front:

```bash
git clone https://github.com/utkarsh0336/UBoss-Sourcing.git
cd UBoss-Sourcing

mysql -u root -e "CREATE DATABASE uboss CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -e "CREATE DATABASE uboss_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

### 2. Configure the backend

```bash
cd backend
npm install
cp .env.example .env
```

These have no default — a wrong value stops the server at boot rather than
letting it run half-configured:

```
DATABASE_URL="mysql://root:@127.0.0.1:3306/uboss"
TEST_DATABASE_URL="mysql://root:@127.0.0.1:3306/uboss_test"
```

Generate the secrets. Leaving the `.env.example` placeholders in place is
rejected outright once `NODE_ENV=production`:

```bash
node -e "for (const k of ['SESSION_COOKIE_SECRET','ACCESS_TOKEN_SECRET','REFRESH_TOKEN_SECRET']) console.log(k+'='+require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('SECRETS_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('base64'))"
```

The rest (`API_PUBLIC_URL`, `CUSTOMER_WEB_PUBLIC_URL`, `ADMIN_WEB_PUBLIC_URL`,
`STORAGE_PUBLIC_BASE_URL`, `EMAIL_FROM_NAME`, `EMAIL_FROM_ADDRESS`) ship with
working localhost values in `.env.example`.

### 3. Prepare the database

```bash
cd backend
npm run db:migrate:deploy    # 62 tables
npm run db:reference         # currencies and countries
npm run db:seed              # dev logins, sample catalogue, per-currency prices
```

**`db:reference` is not optional.** Currencies and countries are reference
data, not fixtures: the catalogue is priced per currency, so without them the
storefront renders an empty shop and says nothing about why. `db:seed` runs it
too, so it is only a separate step on a database you are not seeding.

Migrations have to reach the test database as well, or the suite fails on the
first query:

```bash
cd backend
DATABASE_URL="mysql://root:@127.0.0.1:3306/uboss_test" npx prisma migrate deploy
```

### 4. Install the frontends

```bash
cd apps/admin-web    && npm install
cd ../customer-web   && npm install
```

Both carry a committed `.env` holding only `VITE_API_BASE_URL`; nothing else
is needed.

### 5. Run — four terminals

```bash
# 1 — API
cd backend && npm run dev

# 2 — Worker: recurring orders, notifications, payment-link expiry, exports
cd backend && npm run dev:worker

# 3 — Admin panel
cd apps/admin-web && npm run dev

# 4 — Customer storefront
cd apps/customer-web && npm run dev
```

| | |
|---|---|
| API | <http://localhost:4000> |
| Readiness, with dependency checks | <http://localhost:4000/health/ready> |
| Metrics (Prometheus) | <http://localhost:4000/metrics> |
| **Admin panel** (staff) | <http://localhost:5173> |
| **Storefront** (customers) | <http://localhost:5174> |

**Run exactly one worker.** Several can run safely in production — they claim
jobs under a lease — but two started from *different* builds will disagree
about which job types exist, and a job the older one cannot handle goes back to
the queue and eventually dies. One worker locally avoids the whole question.

### Signing in

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

The storefront is browsable without signing in. The sign-in wall sits at the
cart, which is where the backend puts it.

A staff member and a customer can be signed in at the same time in one browser:
the two surfaces name their session cookies apart (`uboss_admin_*` and
`uboss_shop_*`), because a cookie's identity ignores the port and shared names
meant signing into one silently signed you out of the other.

These are **development seeds**. Delete them before the system goes live —
`backend/docs/RUNBOOK.md` has the procedure.

### Adding a member of staff

A Business Owner creates the account from **Staff**. There is no password field
on that form: the system generates a one-time password, emails it, and nobody —
including the person who created the account — ever sees it.

What the new member of staff gets is an email with their address and that
password. Signing in with it works, and then does exactly one thing: it puts
them on a *Choose your password* screen. Until they finish, **every admin route
answers 403** — the block is `mustChangePassword` in `plugins/auth.ts`, not the
screen, so it holds for an API client too.

The temporary password lapses after **72 hours**, because unlike the activation
link it replaces it sits in an inbox rather than being single-use. If it goes
astray or expires, **Staff → Resend password** issues a new one and kills the
old; that button disappears once the holder has a password of their own, at
which point the way back in is the reset they start themselves.

Once they have a password of their own and forget it, **Forgot your password?**
on the admin sign-in page emails them a reset link. That link lasts an hour —
short, because unlike a temporary password it needs no second factor at all —
is single use, and revokes every session when spent. It is also the only way
back in at that point: **Resend password** disappears from Staff as soon as an
account has its own password, so a colleague cannot mint a credential for
somebody who already has one.

Both directions answer identically for an address with no account. A form that
said "no such staff account" would be a way to find out who works here.

For any of this to leave the machine, `EMAIL_DRIVER` must be `smtp`. On `log`
the email is printed to the worker terminal instead — fine for development, and
where you will find the password or the link while testing.

### Other commands worth knowing

```bash
cd backend
npm run db:studio       # browse the database
npm run db:reset        # wipe and re-migrate (development only)
npm run openapi:export  # regenerate openapi.json from the live route table
npm run test:watch      # tests in watch mode
```

To stop everything when a port is stuck (PowerShell):

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'UBoss-Sourcing|src/worker/index\.ts|src/http/server\.ts' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
```

---

## Configuration

Everything is read from `backend/.env` and validated at boot by
`src/config/env.ts`. The server refuses to start on a bad value rather than
running in a half-configured state.

The ones that must match:

| Variable | Must be |
|---|---|
| `ADMIN_WEB_ORIGIN` | The admin panel's exact origin. Default `http://localhost:5173` |
| `CUSTOMER_WEB_ORIGIN` | The storefront's exact origin. Default `http://localhost:5174` |
| `CUSTOMER_WEB_PUBLIC_URL` | Where activation and password-reset links point |
| `apps/*/.env` → `VITE_API_BASE_URL` | The API's base URL. Default `http://localhost:4000/api/v1` |

The CORS allowlist is exact — a mismatch blocks every request from the browser,
and both frontends use `strictPort` so a clash fails loudly rather than
silently moving to a port CORS will reject.

The storefront reads its branding, timezone, policy links, capability flags and
the list of markets it sells in from `GET /api/v1/config` at runtime, so none
of that is hard-coded in the client. It offers only currencies the catalogue is
actually priced in — a currency staff have activated but not yet priced
anything in would otherwise give the shopper an empty shop with no explanation.

### Payments

`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` in `backend/.env` are the
development fallback. In production, credentials are entered through
**Integrations** in the admin panel and stored encrypted (AES-256-GCM, bound to
the connection row).

**A live key cannot be used outside production.** `src/config/env.ts` refuses to
start when `NODE_ENV !== 'production'` and the key begins `rzp_live_` or
`sk_live_`:

> refusing to start: this is a LIVE Razorpay key and NODE_ENV is not
> production. Live keys move real money.

The same distinction runs through the admin panel: a `rzp_live_` key filed
under Test mode is rejected at save, LIVE mode is labelled *"real money"*
everywhere it appears, and activating a live connection asks for confirmation
in those words.

---

## Going live

1. **Set `NODE_ENV=production`.** This turns on the live-key guard's opposite
   number — secure cookies, proxy trust, and stricter logging. It also refuses
   to start on an `.env.example` placeholder secret, a test gateway key, the
   `log` email driver or local disk storage.
2. **Generate fresh secrets.** `SESSION_COOKIE_SECRET`, `ACCESS_TOKEN_SECRET`,
   `REFRESH_TOKEN_SECRET`, `SECRETS_ENCRYPTION_KEY`. Never reuse the development
   values.
3. **Migrate, then install the reference data.**
   ```bash
   cd backend
   npm run db:migrate:deploy
   npm run db:reference        # safe and idempotent in production
   ```
   Without currencies and countries the catalogue cannot be priced at all.
4. **Price the catalogue in every currency you intend to sell in.** A product
   with no price row for a currency is not sold in that market — it is left out
   of that grid entirely, deliberately, rather than converted at a rate. Set
   them per product under **Prices by currency**.
5. **Enable your gateway account for each of those currencies.** The order
   carries its own currency all the way to the provider, but the provider will
   refuse a currency the account is not enabled for.
6. **Point the gateway's webhook at `POST /api/v1/payments/webhooks/razorpay`**
   and paste the signing secret into **Integrations**. A gateway cannot be
   activated without one: an order is confirmed only by a signature-verified
   event, so a connection with no secret would charge customers and confirm
   nothing.
7. **Give each customer terms in every currency they may buy in.** Purchasing
   limits are per currency, and an account with terms in one market and none in
   another is refused in the second rather than having its credit control
   silently dropped.
8. **Build all three.**
   ```bash
   cd backend            && npm run build && npm run start   # and npm run start:worker
   cd apps/admin-web     && npm run build                    # serve dist/ as static files
   cd apps/customer-web  && npm run build                    # serve dist/ as static files
   ```
   Roll workers out together. Several can run at once, but two on *different*
   builds disagree about which job types exist, and one that cannot handle a
   job returns it to the queue until its attempts run out.
9. **Serve each `dist/` with a history fallback** — both are single-page apps,
   so every unknown path must return `index.html`, or a refresh on
   `/account/orders/123` gives a 404.
10. **Give the two frontends separate hostnames** if you can. They no longer
    share session cookies either way, but separate origins keep the CORS
    allowlist and the cookie scopes obvious.
11. **Delete the seeded accounts** and create real ones from **Staff**.
12. Work through `backend/docs/RUNBOOK.md` for backups, restore drills and
    incident procedure.

---

## Verifying a change

Each project gates on the same checks:

```bash
cd backend           && npm run verify   # typecheck, lint, 569 tests against a real MariaDB
cd apps/admin-web    && npm run verify   # typecheck, lint, build
cd apps/customer-web && npm run verify   # typecheck, lint, 56 tests, build
```

`backend/openapi.json` is generated from the live Fastify route table
(`npm run openapi:export`), so it cannot drift from what the server serves.
A contract test fails the build if it does.

---

## The rules this system is built on

These are enforced in code, and changing any of them is a deliberate act rather
than an edit:

- **Money is never a float.** Every amount is an integer of minor units,
  carried as a *string* on the wire because a paisa-precise total can exceed
  `2^53`. `Number(minor) / 100` is the bug the string exists to prevent.
- **An amount is never read in a currency it was not entered in.** Catalogue
  prices, coupon thresholds and customer purchasing limits are all held per
  currency, and there is no exchange rate anywhere in the system. A rate would
  make the listed price drift from the settled one; converting a threshold
  would make a business rule move with the market. A currency a figure was
  never entered for simply does not apply.
- **Tax is charged on the discounted amount.** A coupon's share is apportioned
  across the eligible lines with largest-remainder before tax is calculated, so
  the per-line figures sum to the total charged. Taxing the pre-discount value
  would charge tax on money the customer never paid.
- **A job is never destroyed by the worker that cannot run it.** Several
  workers run at once and, mid-deploy, at different versions. One that does not
  recognise a job type returns it to the queue for another to take, rather than
  marking it dead and silently losing the work.
- **An order is confirmed only by a signature-verified provider event.** Not by
  a browser redirect, not by an admin button. There is no "mark as paid"
  anywhere in the admin panel, and no simulated-success branch in the payment
  module.
- **Stock cannot oversell.** Reservations are taken inside the order
  transaction; a concurrency test drives ten workers at stock of three and
  exactly three succeed.
- **Duplicate protection is structural.** Unique indexes, not procedural
  checks — a redelivered webhook collides on insert, a double-clicked import
  confirm collides on the SKU index.
- **Nothing is published by accident.** A product reaches customers only when
  it is both Active *and* Published. Bulk import can activate; it can never
  publish.
- **The audit log is append-only.** Every state change records who, when, from
  where, and why. No screen offers a way to edit or delete an entry.
- **One order per checkout.** The idempotency key is generated once per attempt
  and reused across retries. A double-click, a timeout retry and two concurrent
  submissions all resolve to the same order.
- **Product HTML is never rendered raw.** The backend sanitises on write and the
  storefront sanitises again with `DOMParser` before display.

`backend/docs/HANDOFF.md` is the deeper reference: environment details, the
MariaDB constraints that shaped the schema, the full endpoint map, and what is
deliberately not built.
#   U B o s s - S o u r c i n g  
 #   U B o s s - S o u r c i n g  
 