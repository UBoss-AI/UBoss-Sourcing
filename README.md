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

### Where each sign-in happened

Staff signing in to the admin panel are asked for the device's location before
the panel opens, every time. Until the browser answers, the session can reach
`/me`, `/logout` and nothing else — every other admin route returns
`403 LOCATION_REQUIRED`, so the gate is not something a different client can
skip. The place is then recorded on the session and posted to the console bell,
where anyone holding `staff.read` sees *"someone@example.com signed in from
Pune, Maharashtra"* the moment it happens. That is the point of it: a shared
console behind nothing but a password gives the people running the shop no way
to notice a sign-in nobody made. The coordinates are evidence for a person to
read and never an authorisation input — nothing decides access from *where*
they point, only from whether they were given at all.

| Variable | What it does |
|---|---|
| `FEATURE_ADMIN_LOGIN_LOCATION` | The requirement itself. Default `true` |
| `GEOCODE_REVERSE_URL` | Turns coordinates into a place name. `{lat}` and `{lon}` are substituted. Empty switches the lookup off and the bell shows coordinates |
| `GEOCODE_TIMEOUT_MS` | How long to wait for it. Default `5000` |

**The panel must be served over HTTPS.** The browser Geolocation API exists
only in a secure context, so on plain HTTP (anything but `localhost`) no member
of staff can ever satisfy this and everyone is locked out. Put the panel behind
HTTPS, or set `FEATURE_ADMIN_LOGIN_LOCATION=false`.

The reverse lookup is the one part of this that leaves the building, which is
why it is a URL rather than a fixed host — point it at your own geocoder, or
switch it off. It is also best-effort in every failure: a geocoder that is
slow, firewalled or down leaves the place as coordinates and never blocks a
sign-in. The default is OpenStreetMap's Nominatim, whose usage policy asks for
no bulk querying; one lookup per admin sign-in is well inside it.

### Letting customers open their own account

Off by default. Accounts are created by invitation (SOP 7.1): a colleague adds
the customer, the system emails a single-use activation link, and the customer
chooses their own password — no administrator ever sees it.

Where you want a "Create an account" form on the storefront instead, turn it
on:

| Variable | What it does |
|---|---|
| `FEATURE_CUSTOMER_SELF_REGISTRATION` | The sign-up form itself. Default `false` |
| `CUSTOMER_SELF_REGISTRATION_REQUIRES_APPROVAL` | Whether a confirmed account still waits for staff. Default `true` |

The form asks for a name, an email address, a mobile number and a country, plus
a password. The country is not an address field: this catalogue holds a real
price per market rather than converting one, so the answer decides what every
price that account is shown is quoted in — and answering it here is why the
storefront's "where are you ordering from?" prompt never interrupts their first
visit.

An account then passes two gates before it can order:

1. **The confirmation link**, emailed on sign-up and valid for 48 hours. Until
   it is opened the account cannot sign in — this is what stops somebody
   registering with a competitor's address, or a typo'd one that silently
   swallows every later email.
2. **A member of staff**, unless you set the approval flag to `false`. Prices,
   purchasing limits and credit terms here are per customer, so an unreviewed
   account is a commercial decision rather than an inbox check.

Confirmed sign-ups appear in the console bell and under
**Customers → Awaiting approval**, where the record carries an **Approve
customer** button. Approving emails the holder to say the account is open; they
sign in with the password they chose at sign-up, and approval never issues a
credential. The button does not appear while the confirmation link is unopened,
and the endpoint refuses that case too: approving then would hand a live account
to whoever *typed* the address rather than to whoever owns it, which is the one
thing the link exists to prevent.

**The form never says an email address is already taken.** A sign-up that
answered "that email is registered" lets anybody walk a list of addresses
through it and learn who buys from you — for a B2B supplier, that list is the
customer list. So a duplicate gets the same status code and the same body as a
new sign-up, and the truth goes to the mailbox instead: the address itself
receives a "you already have an account" email with a reset link. The same
reasoning already governs `/auth/password/forgot`.

### Opening a market

A currency being active is not the same as a market existing. The catalogue
holds a real, staff-entered figure per currency and the storefront never
converts at read time — a converted number drifts with the rate, and the buyer
would be charged something other than what the page showed. So a currency
nobody has priced anything in is invisible: it is dropped from the switcher,
and the language signal above will not send anybody to it.

Two ways to fill one in:

- **Per product**, in the product editor’s currency prices panel. This is the
  authority — every figure is one a person typed for that market.
- **Products → Currency pricing**, which converts an entire price list at a rate
  you enter and writes the results as ordinary price rows. It converts *once*,
  on write. Nothing tracks the rate afterwards, so the quoted price is still the
  charged price, and any product can be repriced by hand later. It previews
  before it writes, never targets the base currency, leaves already-priced
  products alone unless told otherwise, and is capped at 5,000 prices per run.

#### Keeping converted prices current

**Settings → Automatic exchange rate updates.** Once a day a background job
fetches rates, re-converts every price that conversion produced, and stores the
results. The storefront still never converts at read time — it quotes a stored
figure, so the amount charged is the amount the page showed — but that stored
figure no longer sits at last spring’s rate.

Four things bound what an unattended job can do:

- **It only touches what it wrote.** `product_prices.isAutoConverted` is set by
  the bulk tool and cleared the moment anyone edits that price by hand. A
  deliberate local price is out of the job’s reach, permanently.
- **It refuses a suspicious move.** If any single price would move by more than
  `maxDriftPercent` (15% by default) the whole run is abandoned and nothing is
  written — a feed returning a wrong base or a shifted decimal is a
  catalogue-wide mispricing that nobody is awake to catch.
- **It only refreshes markets that already exist.** A currency nobody has priced
  anything in stays empty. Opening a market is a decision; this is not the thing
  that makes it.
- **It is off until switched on**, and a "Refresh now" button runs exactly the
  same code as the schedule, so the button is a real rehearsal rather than a
  second path that resembles one.

`marginPercent` is added on top of the mid-market rate, as a buffer against it
moving between runs and against the spread the business pays to settle.

Rates come from `FX_RATE_URL` in `backend/.env`, which defaults to a free,
keyless feed (`https://open.er-api.com/v6/latest/{base}` — `{base}` is
substituted with the base currency). It lives in the environment rather than
the admin panel so a deployment behind a firewall can point at its own mirror,
and so no administrator can aim the server at an arbitrary URL. The pricing
dialog uses the same feed to pre-fill today’s rate, which staff may overwrite.

Reference data — the currencies and countries themselves — is installed by
`npm run db:reference` in `backend`. It is idempotent and safe to re-run: an
existing deployment picks up newly added markets without touching its own
settings, and staff-retired currencies are not resurrected.

### Payments

Two gateways are supported, **Razorpay** and **Stripe**, behind one interface —
order code never learns which is in use. Exactly one connection is active at a
time; `PAYMENT_DEFAULT_PROVIDER` decides which set of environment keys is
preferred when both are present.

`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`, or `STRIPE_PUBLISHABLE_KEY` /
`STRIPE_SECRET_KEY`, in `backend/.env` are the development fallback. In
production, credentials are entered through **Integrations** in the admin panel
and stored encrypted (AES-256-GCM, bound to the connection row).

For Stripe, the **publishable** key (`pk_`) goes in the *Key id* field — it is
sent to every customer's browser to open the payment form — and the **secret**
key (`sk_`, or `rk_` for a restricted key) goes in *Key secret*, where it never
leaves the server. Pasting them the wrong way round is refused at save rather
than after a failed test, because the secret key would otherwise be published.
A publishable key from one environment paired with a secret key from the other
is refused for the same reason it is hard to diagnose: the API handshake
succeeds and no payment can ever be confirmed.

**A live key cannot be used outside production.** `src/config/env.ts` refuses to
start when `NODE_ENV !== 'production'` and the key begins `rzp_live_`,
`sk_live_` or `pk_live_`:

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
6. **Point the gateway's webhook at its endpoint** —
   `POST /api/v1/payments/webhooks/razorpay` or
   `POST /api/v1/payments/webhooks/stripe` — and paste the signing secret into
   **Integrations**. A gateway cannot be activated without one: an order is
   confirmed only by a signature-verified event, so a connection with no secret
   would charge customers and confirm nothing.

   On Stripe, subscribe to `payment_intent.succeeded`,
   `payment_intent.payment_failed`, `charge.refunded`, `refund.updated` and
   `refund.failed`. Leave `charge.succeeded` off: it reports the same capture
   as `payment_intent.succeeded` under a different event id, so the
   duplicate-delivery guard would not catch it and the order would be credited
   twice. Stripe also refuses a delivery signed more than five minutes ago, so
   keep the server's clock on NTP.
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

## Languages

Both front ends ship in eight languages: English (the default and the
fallback), Dutch, French, German, Greek, Italian, Polish and Spanish. They run
on **i18next / react-i18next**, one instance per app.

A visitor's language is resolved most-specific-first — the signed-in account's
saved `preferredLanguage`, then a choice made in this browser, then whatever
`navigator.languages` asks for, then English. The browser step is what puts a
Polish buyer on a Polish storefront before they have touched anything, and
`load: 'languageOnly'` is what makes Belgium work: `nl-BE` and `fr-BE` resolve
to Dutch and French without either needing a locale of its own. A choice made
in the picker is written to localStorage and outranks the browser permanently.

The picker sits on every sign-in, activation and password screen in both apps,
and in the header once inside. Putting it only behind a settings page would
hide it from the one person who needs it most: somebody who cannot read the
interface well enough to navigate to that page.

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

Two settings are load-bearing and match between `config.ts` and `i18next.d.ts`:
`keySeparator: false` and `nsSeparator: false`. Our keys are flat strings
containing dots (`auth.login.heading`); read as paths they would nest into
unusable objects, and TypeScript would resolve every key to `never`.

The two apps keep separate catalogues on purpose. They share an engine, not a
vocabulary: "Orders" is a staff work queue in the panel and a buyer's own
purchase history in the storefront, and several words identical in English
diverge once translated.

**The non-English catalogues are machine-translated and have not been reviewed
by a native speaker.** Both apps say so, under the picker, on any non-English
language. Have a speaker read them before selling into that market, then delete
`TranslationQualityNotice` and the `isMachineTranslated` flag behind it.

### The language as a pricing signal

Language is not location, and the two stay separate settings — a Polish buyer
paying in euro is an ordinary case. But the interface language is often the only
signal a first-time visitor gives, so each entry in the storefront’s
`languages.ts` carries a `suggestedCountry`, and `LocaleProvider` uses it in
exactly two places:

- **Nobody has answered yet.** The language’s market becomes the starting
  currency. It ranks below a saved profile and below a choice made in this
  browser, and above the deployment’s base currency.
- **They have answered.** Nothing is repriced, ever. `MarketSuggestionBanner`
  offers the switch instead, naming both currencies, and a refusal is remembered
  in `uboss.locale.declined` so the same offer is not made twice.

Both are filtered against the deployment’s own reference data: the country has to
be one staff activated, and its currency has to be one the catalogue is actually
priced in — so a store selling only in India never sends a Polish reader to an
empty złoty shop. English carries no country. It is read across every market this
ships into, so an English reader keeps the currency they already have.

### Translating the catalogue

The interface catalogues ship translated. A shop’s own products cannot — every
deployment sells something different — so **Settings → Catalogue translation**
does the same job from inside the panel, writing `product_translations` and
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
string is escaped on the way out and unescaped on the way back. That is not
decoration: one unescaped ampersand in a product description fails the whole
batch with a parser error naming a column rather than a product.

A run is capped at 100 rows per language so it finishes inside one request. A
large catalogue is translated by pressing the button a few times; every press
saves what it did.

`translation.service.ts` decides how the rows are read: field by field, with the
base row filling any gap — so a product whose Polish name exists but whose
Polish description does not shows the Polish name beside the English
description, rather than reverting the whole product to English.

### Adding a language

1. Add it to `LANGUAGES` and `LanguageCode` in both `languages.ts` files.
   The storefront entry also needs a `suggestedCountry`: the market that
   language implies, or `null` when it implies none.
2. Copy `locales/en.json` to `locales/<code>.json` in both apps and translate.
3. Add the code to `SUPPORTED_LANGUAGES` in the backend service. The API
   rejects anything not on that list, so a language missing here can be picked
   in the UI and then fail to save.

No loader to register: `config.ts` imports the whole `locales` directory.

Catalogues are merged over English, so a half-finished translation is a normal
state rather than a build error — missing keys render in English. Run
`npm run test` in `apps/customer-web` for a per-language coverage report and
three guards a type cannot give you: no invented keys, no dropped
`{{placeholder}}`, and **every plural form the language actually needs**. That
last one is not academic — it caught French, Italian and Spanish missing their
CLDR `many` form, which those languages use at exact millions.

### Translating in bulk

`en.json` is written by hand — it is the source text, and nothing should
machine-generate it. The other seven are filled by DeepL:

```bash
npm install --prefix scripts     # once - pulls in deepl-node
export DEEPL_API_KEY=...
node scripts/auto-translate.mjs apps/customer-web --dry-run   # what would be sent
node scripts/auto-translate.mjs apps/customer-web             # do it
node scripts/auto-translate.mjs apps/admin-web
```

A free DeepL key covers the whole codebase: both apps at ~1,800 strings come to
roughly 430,000 characters across seven languages, against a 500,000/month free
allowance.

The script **never overwrites an existing value.** Only keys present in
`en.json` and absent from the target file are sent, so it is safe to re-run and
a human correction is permanent. Three things it handles that a naive
`translate(json)` would get wrong:

- **Placeholders.** `{{email}}` is a token, not a word. Each is wrapped in a tag
  DeepL is told to ignore, along with `UBOSS`, `Business Owner` and the other
  terms in `KEEP`, so they come back verbatim.
- **Register.** `formality: prefer_more` pins the Sie/usted/vous form a supplier
  owes a business customer. DeepL supports it for six of our seven languages —
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

```bash
cd apps/customer-web && npm run test -- src/i18n
```

### Adding a string

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

`npm run i18n:extract` scans the source for keys and writes them to
`.extracted/` (gitignored) to diff against `locales/`. It deliberately does not
write to `locales/` itself: `en.json` is hand-written, and keys referenced
indirectly — `labelKey: 'nav.orders'` in the navigation map, rather than a
literal `t()` call — are invisible to a static scan and would be deleted.

---

## Verifying a change

Each project gates on the same checks:

```bash
cd backend           && npm run verify   # typecheck, lint, 604 tests against a real MariaDB
cd apps/admin-web    && npm run verify   # typecheck, lint, build
cd apps/customer-web && npm run verify   # typecheck, lint, 117 tests, build
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