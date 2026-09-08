# UBOSS Sourcing — The Complete Guide

**Read this first.** It explains what this project is, what every piece does,
and how a real request travels from a customer's click to a row in the
database. No prior knowledge assumed. Nothing here is a summary of code you
have to read separately — this *is* the explanation.

> A Hinglish version of this same document lives at
> `PROJECT-GUIDE.hinglish.md`. It is not committed to git (see `.gitignore`).
> **When anything in the project changes, both files must be updated together.**

---

## Table of contents

1. [What this project is](#1-what-this-project-is)
2. [The three programs](#2-the-three-programs)
3. [How they talk to each other](#3-how-they-talk-to-each-other)
4. [The customer storefront](#4-the-customer-storefront)
5. [The admin panel](#5-the-admin-panel)
6. [The backend](#6-the-backend)
7. [The database](#7-the-database)
8. [The API](#8-the-api)
9. [Complete flows, end to end](#9-complete-flows-end-to-end)
10. [Money — the most important rule](#10-money--the-most-important-rule)
11. [The background worker](#11-the-background-worker)
12. [Security](#12-security)
13. [Languages and markets](#13-languages-and-markets)
14. [Configuration](#14-configuration)
15. [Where to find things](#15-where-to-find-things)
16. [Keeping this document true](#16-keeping-this-document-true)

---

# 1. What this project is

## The one-sentence version

UBOSS Sourcing is **a shop on the internet for businesses** — a company sells
medical supplies to other companies, and this software runs everything from the
product page to the invoice.

## The slightly longer version

Imagine a real shop.

- There is a **shop floor** where customers walk around, look at products, put
  things in a basket, and pay at the till.
- There is a **back office** where the staff add new products, check how much
  stock is left, pack orders, and look at the books.
- There is a **stock room and filing cabinet** where everything is actually
  kept — every product, every order, every receipt.

This project is those three things, built as software:

| Real shop | This project |
|---|---|
| Shop floor | The **customer storefront** (`apps/customer-web`) |
| Back office | The **admin panel** (`apps/admin-web`) |
| Stock room + filing cabinet | The **backend and database** (`backend`) |

## What makes it "B2B" and why that matters

This is **not** Amazon. It sells business-to-business (B2B), and that changes
almost every design decision in the codebase:

| Consumer shop (Amazon) | This B2B shop |
|---|---|
| Everyone sees the same price | Each customer can have their **own prices and credit terms** |
| Buy any quantity | Products can have **minimum order quantities** (you must buy 10, not 1) |
| Anyone can sign up and buy | Accounts can require **staff approval** first |
| One country, one currency | Sells into **many countries**, each with its own real price |
| Pay now, every time | Some customers get **credit terms** and purchasing limits |
| One-off orders | Customers can set up **repeating orders** (every month, automatically) |

It also sells **medical devices**, which brings legal duties that ordinary
shops do not have — European product-safety rules (GPSR), medical-device rules
(MDR), VAT handling across EU member states, and data-protection rules (GDPR).
Those are not decorations; they are built into the database and the code.

## Who uses it

| Person | Uses | To do what |
|---|---|---|
| A buyer at a hospital or clinic | Storefront | Find supplies, order them, repeat the order monthly |
| Catalog Manager | Admin panel | Add products, set prices, publish them |
| Inventory Manager | Admin panel | Record stock arriving, fix stock counts |
| Order Manager | Admin panel | Process orders, ship them, handle returns |
| Finance / Approver | Admin panel | Approve large orders, issue refunds, watch payments |
| Business Owner | Admin panel | Everything, plus staff accounts and settings |

## One important thing about how it is sold

**This is a product other companies buy and run themselves.** Every buyer
installs it on their own server, with their own database, their own products
and their own customers. So the code can never assume "we are the ones running
it" — every business detail is a setting, not a hard-coded value.

---

# 2. The three programs

Three separate programs run at the same time. Plus one helper.

```
┌─────────────────────────┐        ┌─────────────────────────┐
│  CUSTOMER STOREFRONT    │        │      ADMIN PANEL        │
│  apps/customer-web      │        │      apps/admin-web     │
│  Port 5174              │        │      Port 5173          │
│  React + Vite           │        │      React + Vite       │
│  "the shop floor"       │        │      "the back office"  │
└───────────┬─────────────┘        └───────────┬─────────────┘
            │                                  │
            │   both speak HTTP + JSON         │
            └────────────────┬─────────────────┘
                             ▼
                ┌─────────────────────────┐
                │        BACKEND API      │
                │        backend/         │
                │        Port 4000        │
                │        Fastify + TS     │
                │   "the shop's brain"    │
                └───────────┬─────────────┘
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
   ┌────────────────────┐      ┌────────────────────┐
   │     DATABASE       │      │      WORKER        │
   │   MariaDB :3306    │      │  backend/src/worker│
   │  76 tables         │      │  "the night staff" │
   │ "filing cabinet"   │      │                    │
   └────────────────────┘      └────────────────────┘
```

## Why the frontends are separate programs

The storefront and the admin panel are two completely separate applications.
They do not share code that runs in the browser, they run on different ports,
and they name their login cookies differently (`uboss_shop_*` and
`uboss_admin_*`).

**Why bother?** Because a bug in the shop must never be able to touch the back
office. If they were one program, a mistake on a public product page could
expose an admin screen. Being separate makes that structurally impossible
rather than merely unlikely.

It also means a member of staff can be logged into the admin panel *and*
logged in as a test customer in the same browser at the same time — the two
cookies do not collide.

## Why the worker is separate

The worker is a second copy of the backend code that runs **no web server**. It
does not answer requests. It sits in a loop and does slow or scheduled work:

- Sending every email in the system
- Creating this month's repeating orders
- Expiring payment links that nobody used
- Refreshing exchange rates once a day
- Releasing stock that was reserved but never paid for
- Building data exports
- Deleting personal data that has passed its retention window

**Why not do this in the API?** Because a customer waiting for a page should
never wait for an email server. If sending mail takes 8 seconds, the checkout
would take 8 seconds. Instead, checkout writes a note saying "send this email",
finishes instantly, and the worker picks the note up a moment later.

---

# 3. How they talk to each other

## The shape of every conversation

Everything is HTTP requests carrying JSON. There is no other channel.

```
Browser                       Backend                    Database
   │                             │                           │
   │  GET /api/v1/catalog        │                           │
   │────────────────────────────▶│                           │
   │                             │  SELECT ... FROM products │
   │                             │──────────────────────────▶│
   │                             │◀──────────────────────────│
   │  { "items": [ ... ] }       │                           │
   │◀────────────────────────────│                           │
```

Every backend address starts with `/api/v1`. The `v1` is a promise: if the
shape of an answer ever has to change incompatibly, it becomes `/api/v2` and
old clients keep working.

## How the backend knows who you are

When you log in, the backend sets **cookies** in your browser. A cookie is a
small note the browser attaches to every later request to that site
automatically.

```
POST /api/v1/auth/login   { email, password }
        │
        ▼
Backend checks the password (Argon2id — see Security)
        │
        ▼
Sets three cookies:
   uboss_shop_access    — proves who you are, short-lived (15 minutes)
   uboss_shop_refresh   — used to get a fresh access cookie (30 days)
   uboss_shop_csrf      — anti-forgery token (explained below)
```

The first two are **HttpOnly**: JavaScript in the page cannot read them. If an
attacker managed to inject a script into the page, it still could not steal the
login.

The third one, the CSRF token, is deliberately *readable* by JavaScript, and
that is the whole point of it:

> **The CSRF problem, in plain words.** Cookies are sent automatically. So if
> you are logged into the shop and then visit `evil.com`, a hidden form on that
> evil page could POST to our backend — and the browser would helpfully attach
> your login cookie. The backend would think you asked for it.
>
> **The fix (double-submit).** The frontend reads the CSRF cookie with
> JavaScript and copies its value into a header, `x-csrf-token`, on every
> state-changing request. The backend checks that the cookie and the header
> match. `evil.com` cannot read our cookie (browsers forbid cross-site reads),
> so it cannot produce the header, so its forged request is rejected.

## The shape of every error

Every failure in the system — a missing field, a wrong password, a crash —
comes back in the exact same shape:

```json
{
  "error": {
    "code": "CART_QUANTITY_BELOW_MINIMUM",
    "message": "Minimum order quantity for this product is 10.",
    "details": [{ "field": "items.0.quantity", "code": "..." }],
    "correlationId": "01J8XR..."
  }
}
```

- **`code`** is a stable machine-readable name. There are about 106 of them,
  listed in `backend/src/domain/errors.ts`. The frontends map each one to a
  precise message in eight languages. **Renaming a code silently degrades both
  frontends to a generic error toast**, so codes are added, never repurposed.
- **`details`** points at the exact field that was wrong, so a form can put a
  red message under the right box.
- **`correlationId`** is the same id that was written into the server log for
  that request. A customer can read it off the screen and support can find the
  exact log line.

---

# 4. The customer storefront

`apps/customer-web` — React 19, TypeScript, Vite, Tailwind CSS.

## Every page

| Path | Page | Sign-in needed? |
|---|---|---|
| `/` | Home | No |
| `/products` | All products | No |
| `/category/:slug` | One category | No |
| `/search` | Search results | No |
| `/product/:slug` | One product | No |
| `/login` | Sign in | No |
| `/register` | Create an account | No |
| `/verify-email` | Confirm your email address (from the emailed link) | No |
| `/activate` | Set your password (from a staff invitation link) | No |
| `/forgot-password` | Ask for a reset link | No |
| `/reset-password` | Choose a new password | No |
| `/cart` | The basket | **Yes** |
| `/checkout` | Address, shipping, payment choice | **Yes** |
| `/checkout/payment/:orderId` | The payment sheet | **Yes** |
| `/order-confirmation/:orderId` | "Thank you" | **Yes** |
| `/account/orders` | Order history | **Yes** |
| `/account/orders/:id` | One order | **Yes** |
| `/account/schedules` | Repeating orders | **Yes** |
| `/schedules/new` | Build a repeating order | **Yes** |
| `/account/addresses` | Saved addresses | **Yes** |
| `/account/profile` | Name, phone, language | **Yes** |

**Browsing does not need an account.** The sign-in wall sits at the *cart*, not
at the front door — because the backend puts it there too. A visitor can see
the whole catalogue and prices, and is only asked to identify themselves when
they want to actually buy.

## How a page is built

Every page follows the same three-layer pattern:

```
Page component  (e.g. ProductPage.tsx)
      │  asks for data using React Query
      ▼
lib/ function   (e.g. lib/catalog.ts → fetchProduct(slug))
      │  calls the shared api helper
      ▼
lib/api.ts      adds /api/v1, attaches the CSRF header,
                turns an error envelope into an ApiError object
```

**Why a shared `api.ts`?** So that the CSRF header, the base URL and the error
translation are written **once**. A page that talked to `fetch()` directly
would eventually forget one of the three, and forgetting the third means the
customer sees "Something went wrong" instead of "Minimum order quantity is 10".

**React Query** is a caching layer. When two parts of a page both need the
cart, it fetches once and shares the answer. When you add something to the
cart, it knows to throw away the cached cart and fetch a fresh one.

## What the storefront learns at startup

Before it renders anything, the storefront calls `GET /api/v1/config` once and
receives:

- The business name, support email, support phone, logo, policy links
- Which currencies and countries this deployment actually sells in
- Which features are switched on (self-registration, repeating orders, the chat
  assistant)
- Whether the AI chat widget should be shown, and which model it uses

**Nothing about the business is hard-coded in the frontend.** That is what
makes this a product other companies can buy: they change a setting, and their
name, their currencies and their features appear.

---

# 5. The admin panel

`apps/admin-web` — same technology, different job.

| Path | Screen | What it is for |
|---|---|---|
| `/` | Dashboard | Today's numbers, alerts, the notification bell |
| `/categories` | Categories | The tree products are organised into |
| `/products` | Products | The catalogue list |
| `/products/:id` | Product editor | Details, media, variants, prices per currency, safety info |
| `/products/import` | Bulk import | Upload a spreadsheet of products |
| `/coupons` | Coupons | Discount codes and their rules |
| `/inventory` | Inventory | Stock per location, receipts, adjustments |
| `/orders` | Orders | Every order, filterable |
| `/orders/:id` | Order detail | Items, payments, shipments, status actions |
| `/payments` | Payments | Transactions, refunds, payment links |
| `/recurring` | Recurring | Customers' repeating-order schedules |
| `/customers` | Customers | Accounts, including "awaiting approval" |
| `/customers/:id` | Customer detail | Their prices, limits, addresses, orders |
| `/chat-enquiries` | Chat enquiries | Transcripts from the AI widget |
| `/reports` | Reports | Sales, stock and tax reports; exports |
| `/data-requests` | Data requests | GDPR access and erasure requests |
| `/manufacturers` | Manufacturers | Economic operators required by EU product law |
| `/audit` | Audit log | Who changed what, and when |
| `/integrations` | Integrations | Payment gateway credentials, connectors |
| `/staff` | Staff | Staff accounts and their roles |
| `/settings` | Settings | Business profile, tax, shipping, currencies, notifications |

## The five staff roles

A member of staff has a role, and a role is a fixed bundle of permissions.
There are about 45 permission keys, like `product.write` or `order.approve`.

| Role | Can do |
|---|---|
| **Business Owner / Super Admin** | Everything, including staff and settings |
| **Catalog Manager** | Categories, products, media, pricing, publishing |
| **Inventory Manager** | Stock receipts, adjustments, reservations, alerts |
| **Order Manager** | Orders, fulfilment, cancellation, returns |
| **Finance / Approver** | Payment review, payment links, refunds, high-value approvals |

The permission is checked **on the server**, on every request. The admin panel
also hides buttons a role cannot use, but that is only politeness — hiding a
button is not security, and the server never trusts the client about what it is
allowed to do.

## The location check at sign-in

This is unusual, so it is worth understanding.

When a member of staff signs in, the browser asks for the device's location
**before the panel opens**. Until the browser answers, the session can reach
only `/me` and `/logout`; every other admin route returns `403
LOCATION_REQUIRED`.

The place is then recorded on the session and announced in the notification
bell: *"someone@example.com signed in from Pune, Maharashtra."*

**Why?** A shared back office protected by nothing but a password gives the
people running the shop no way to notice a sign-in that nobody made. This makes
every sign-in visible to colleagues.

Two things to know:

- The location is **evidence for a human to read**, never an authorisation
  input. Nothing decides access based on *where* the coordinates point — only
  on whether they were given at all.
- The browser's geolocation API only exists in a **secure context**. On plain
  HTTP (anything other than `localhost`) no member of staff can ever satisfy
  it, and everyone is locked out. Serve the panel over HTTPS, or set
  `FEATURE_ADMIN_LOGIN_LOCATION=false`.

## What the panel does with that place

The coordinates are reverse-geocoded once, at sign-in. `/admin/auth/me` then
carries four facts, and the panel uses each of them:

| Field on `/me` | What it is | What it changes |
|---|---|---|
| `locationPlace` | The geocoded place, or the coordinates when no geocoder answered | A chip in the **top bar on every page**: *"Signed in from Mitte, Berlin"* |
| `locationCountry` | ISO-3166-1 alpha-2, or null | The market every price in the panel is quoted for |
| `locationCurrency` | What `countries.currencyCode` says that market pays in, or null | Which per-currency price list every customer-facing figure is read from |
| `locationLanguage` | What `countries.languageCode` says an office there reads, or null | The interface language, once per sign-in country |

The top-bar chip exists because the bell announces a sign-in once and has
scrolled away by the afternoon. A console shared by several staff accounts —
and a laptop handed around a warehouse — should still be able to say which
sign-in is on screen. It shows the first two parts of the geocoded name with
the whole string in its tooltip, and it renders nothing at all when the browser
told the session nothing.

**The language switch is a starting point, not a lock.** It applies once per
sign-in *country*, remembered in the browser under
`uboss.admin.language-country`:

- Sign in from Berlin, and the panel is German before you touch anything.
- Switch it to English by hand, and every later sign-in from Germany is
  English — the picker's choice is saved to the account and outranks the
  country from then on.
- Sign in from Athens, and the panel is Greek: that is a country it has not
  had its say about yet.
- Sign in from a country whose language the panel has no catalogue for, and
  **nothing changes**. `locationLanguage` is null there, and null means "leave
  this person's language alone" — never "fall back to English".

Which language a country reads is a **row, not a release**:
`countries.languageCode`. Belgium is why — a Brussels office may read French
where an Antwerp one reads Dutch, and only the operator knows which one bought
this.

## The market's currency, not the seller's

**A price is not a preference, and there is no picker for this one.** The
country decides the currency exactly as it decides the rate, because the two
are separate halves of one question:

- The **currency** decides *which price list* is read. `product_prices` holds
  one real, staff-entered figure per currency and nothing is ever converted, so
  a customer in Warsaw is quoted the złoty row.
- The **country** decides what that figure becomes once its VAT is on it.
  Germany and Ireland read the same euro row at 19% and 23%.

So a member of staff signed in from Warsaw sees, on every catalogue screen:

| Column | What it holds |
|---|---|
| Price | The figure they typed, in the currency they typed it in — ₹780.00. Editable, and untouched by the market. |
| Customer pays | The złoty row plus Poland's VAT — PLN 30.99. Read-only: it is the engine's answer, not a second place to set a price. |

Three consequences worth knowing:

- **A product with no row in that currency is not sold in that market.** The
  cell says *"Not priced in PLN"* rather than showing a figure. There is
  deliberately no fallback: quoting the rupee number in złoty would be
  inventing a price, and quoting JPY 5,000 as EUR 5,000 is the failure this
  catalogue has always refused. Where *nothing* on the page is priced in the
  market's currency the column disappears and one sentence above the table
  says so.
- **Nothing changes where nothing changes.** With no country resolved, each row
  is quoted in the currency its own price is authored in — exactly what the
  console did before it knew about markets. And the top-bar market chip
  appears only when being in that country moves a price at all: a different
  rate (EU VAT configured) or a different price list (the market's currency is
  not the base one). In a single-market Indian shop it never appears.
- **The per-currency panel marks the market's row.** Every currency stays on
  that screen — it is where prices are set — but one of them is what a customer
  in front of the reader pays, and it carries a *"Your market"* badge. That is
  a different fact from which currency is the base.

What this deliberately does **not** touch: reports, the dashboard, orders and
payments. Those are aggregates and settled facts in the currency they happened
in, and restating them in the reader's market currency would need an exchange
rate — which is exactly what this system does not have and does not want.

Which currency a country pays in is a **row, not a release**, the same as its
language: `countries.currencyCode`, the same row the storefront prices a
shopper from.

Every one of these facts survives a token refresh. Sessions rotate every few
minutes, and losing the country there would change the prices, the currency and
the language mid-shift for somebody who had not moved.

---

# 6. The backend

`backend/` — Node.js, TypeScript, Fastify 5, Prisma 7, MariaDB.

## The four layers

Code is organised in layers, and **a layer may only call the layer below it**:

```
   http/        Routes. Reads the request, checks permission, calls a service,
                shapes the reply. Contains NO business rules.
      │
      ▼
   modules/     Services. The actual business logic. "What happens when
                somebody checks out." One folder per business area.
      │
      ▼
   domain/      Pure rules with no input or output at all. Money arithmetic,
                the order state machine, the error catalogue, permissions.
      │
      ▼
   infra/       Adapters to the outside world. Database, email, storage,
                queue, crypto, id generation.
```

**Why this rule matters.** Because `domain/` performs no I/O, the business
rules can be tested without a database at all. And because route handlers hold
no business rules, the same rule cannot be enforced correctly in one route and
forgotten in another.

## The business modules

Each folder under `src/modules/` owns one area:

| Module | Owns |
|---|---|
| `identity` | Login, sessions, tokens, staff accounts, sign-in location, language |
| `customers` | Customer accounts, self-registration, purchasing limits |
| `catalog` | Categories, products, variants, prices, translations, imports, product-safety data |
| `inventory` | Stock balances, movements, reservations |
| `cart` | The basket |
| `orders` | Checkout, order status changes, idempotency |
| `payments` | Gateways (Razorpay, Stripe), transactions, webhooks, payment links, refunds |
| `fulfilment` | Shipments and returns |
| `invoicing` | Invoices, and the EU e-invoice (UBL) format |
| `recurring` | Repeating orders and their occurrences |
| `coupons` | Discount codes |
| `tax` | VAT rates and VAT-number validation against the EU VIES service |
| `settings` | Business profile, currencies, exchange rates, payment processors |
| `notifications` | Email outbox, and the admin notification bell |
| `reports` | Reports and exports |
| `privacy` | GDPR access, export and erasure; data retention |
| `integrations` | External connectors and sync runs |
| `assistant` | The AI chat widget on the storefront |
| `audit` | The record of who changed what |

## What happens to a request, step by step

```
1.  Request arrives at Fastify
2.  Raw body captured  ← ONLY for webhook paths, before JSON parsing
3.  Security headers, CORS allowlist check
4.  Rate limiting
5.  Correlation id assigned  ← the id that appears in logs and error replies
6.  Cookies read, session looked up, user + permissions loaded
7.  CSRF double-submit checked  ← state-changing, cookie-authenticated requests
8.  Zod validates the body/query against a schema
9.  Route handler calls a service in modules/
10. Service runs the business rules, using a database transaction
11. Reply serialised; errors converted to the standard envelope
```

**Step 2 deserves attention.** A payment webhook is signed by the gateway, and
the signature covers the *exact bytes* they sent. Parsing JSON and re-encoding
it changes those bytes (key order, whitespace, number formats), and the
signature would no longer match. So for webhook paths only, the raw body is
captured before anything touches it.

---

# 7. The database

MariaDB 10.4, reached through Prisma. **76 tables, 42 enums, 18 migrations.**

## How schema changes work

The database shape is described in one file: `backend/prisma/schema.prisma`.
Changes are never applied by hand. Instead:

```
edit schema.prisma
      ▼
npm run db:migrate        ← generates a numbered SQL migration file
      ▼
prisma/migrations/2026..._add_something/migration.sql   ← committed to git
      ▼
npm run db:migrate:deploy ← applies pending migrations on any machine
```

**Why?** So every machine — your laptop, a colleague's, the customer's server —
reaches exactly the same shape by running exactly the same steps in the same
order. There is no "it works on mine".

## The tables, grouped by what they are for

**Who people are**
`users`, `roles`, `permissions`, `role_permissions`, `user_roles`, `sessions`,
`auth_tokens`, `login_attempts`, `customer_profiles`, `addresses`

**What is for sale**
`categories`, `products`, `product_variants`, `product_media`,
`product_attributes`, `product_prices`, `media_assets`, `tax_classes`,
`product_translations`, `category_translations`

**How much of it there is**
`inventory_locations`, `inventory_balances`, `inventory_movements`,
`stock_reservations`

**Buying**
`carts`, `cart_items`, `orders`, `order_items`, `order_status_history`,
`order_approvals`, `idempotency_records`, `coupons`, `coupon_redemptions`,
`customer_limits`

**Money**
`payment_provider_connections`, `payment_transactions`, `payment_events`,
`payment_links`, `refunds`, `invoices`, `vat_rates`, `vat_number_checks`

**After the sale**
`shipments`, `return_requests`

**Repeating orders**
`recurring_schedules`, `recurring_schedule_items`, `schedule_occurrences`

**Machinery**
`job_queue`, `notification_outbox`, `notification_deliveries`,
`admin_notifications`, `rate_limit_buckets`, `audit_log`, `number_sequences`

**Reference and compliance**
`currencies`, `countries`, `data_requests`, `economic_operators`,
`product_device_info`

## Three database decisions worth understanding

### 1. Primary keys are ULIDs, not numbers

Every id looks like `01J8XR4M2K7QZP3V9N6TBC5DWA` — 26 characters.

**Why not `1, 2, 3`?** Because sequential numbers leak information (a
competitor can read `order/1834` and know you have had 1834 orders) and they
make merging data from two systems painful.

**Why not a random UUID?** Because InnoDB stores rows physically sorted by
primary key. Random keys mean every insert lands in a random place in the file,
which fragments the table. A **ULID** starts with a timestamp, so new ids are
always *larger* than old ones and inserts stay append-only — the speed of a
counter, without leaking the count.

### 2. Order history is frozen

When a customer buys something, `order_items` stores a **snapshot**: the
product's name, SKU, unit price and tax rate *as they were at that moment*.

**Why copy instead of just pointing at the product?** Because prices change and
products get renamed. If the order pointed at the live product, then raising a
price tomorrow would silently rewrite what a customer paid last month — and the
invoice would stop matching the order behind it. A financial record must not
move.

### 3. MariaDB 10.4 shaped the design

The client requires XAMPP's MariaDB 10.4, which lacks features newer databases
have. Two consequences you will meet in the code:

- **No `SELECT ... FOR UPDATE SKIP LOCKED`.** That is the normal way for
  several workers to grab different jobs from a queue. Instead the queue uses a
  *lease* pattern: read some candidate ids with no lock, then per candidate run
  `UPDATE ... WHERE id = ? AND status = 'PENDING'` and only proceed if
  `affectedRows === 1`. That single UPDATE is atomic at the row level, so
  exactly one worker can win.
- **A `UNIQUE` index treats every `NULL` as distinct.** So a unique index
  containing a nullable `variantId` would *not* stop duplicate rows. Wherever
  that matters, the code stores `variantKey` instead — the variant's id, or
  `''` for the base product — which is never null.

---

# 8. The API

Base path: `/api/v1`. About 22 route files.

## The three zones

| Zone | Prefix | Who may call it |
|---|---|---|
| **Public** | `/api/v1/config`, `/api/v1/catalog`, `/api/v1/assistant` | Anyone, no login |
| **Customer** | `/api/v1/auth`, `/account`, `/cart`, `/orders`, `/recurring-schedules` | A signed-in customer |
| **Admin** | `/api/v1/admin/*` | A signed-in member of staff with the right permission |

## Two design decisions in the routing

**The two login endpoints are built from one factory.**

```ts
authRoutes('ADMIN')    → /api/v1/admin/auth/*
authRoutes('CUSTOMER') → /api/v1/auth/*
```

The `kind` is fixed when the route is registered. So an admin's credentials
presented to the customer endpoint fail **before the password is even
compared** — and neither surface can be used to discover whether an account
exists on the other.

**Customer endpoints never take an id for the thing they own.**
`/api/v1/account/orders` derives the customer from the session cookie. There is
no `/api/v1/orders/:someoneElsesId` to forget an ownership check on — the class
of bug is designed out rather than guarded against.

## The webhook exception

`POST /api/v1/payments/webhooks/razorpay` and `.../stripe` are the only
unauthenticated endpoints that change money. Their authority is the
**cryptographic signature over the raw body**, not a cookie. This is correct:
the caller is Stripe's server, which has no browser and no cookie, but does
hold a shared signing secret.

---

# 9. Complete flows, end to end

## 9.1 A customer opens an account

There are two ways in, and the difference is who vouched for the person.

### Path A — staff invite them (the default)

```
Staff open Customers → Add customer, enter name and email
        │
        ▼  user row created with status = PENDING_INVITATION
An invitation email is queued in notification_outbox
        │
        ▼  the worker sends it
Customer clicks the link → /activate?token=...
        │
        ▼  the token is single-use and hashed in the database
Customer chooses their own password
        │
        ▼  status becomes ACTIVE, activatedAt is stamped
They can sign in
```

**Nobody ever sees their password**, including the colleague who created the
account. The invitation link is single-use, and only its SHA-256 hash is
stored — so a database dump contains no usable links.

### Path B — the customer signs themselves up

Only if `FEATURE_CUSTOMER_SELF_REGISTRATION=true`.

```
Customer fills in the form: name, email, mobile, country, password
        │
        ▼  user row created with status = PENDING_APPROVAL,
           emailVerifiedAt = null
A confirmation email is queued (link valid 48 hours)
        │
        ▼
Customer clicks the link → /verify-email?token=...
        │
        ├── if CUSTOMER_SELF_REGISTRATION_REQUIRES_APPROVAL = false
        │      → status becomes ACTIVE. They can sign in immediately.
        │        (This is how a consumer shop like Amazon behaves.)
        │
        └── if it is true (the shipped default)
               → status stays PENDING_APPROVAL, but emailVerifiedAt is now set.
                 The account appears under Customers → Awaiting approval.
                 A member of staff presses Approve customer.
                 An email tells the holder the account is open.
```

**Why is the country asked for on the sign-up form?** Because this catalogue
holds a *real, staff-entered price per market* rather than converting one. The
answer decides which currency every price that account ever sees is quoted in.
Asking here is also why the storefront's "where are you ordering from?" prompt
never interrupts their first visit.

**Why does the form never say "that email is already registered"?** Because
that answer is an account-enumeration oracle: anybody could walk a list of
addresses through the form and learn who buys here — and for a B2B supplier,
that list *is* the customer list. So a duplicate returns the **identical**
status code and body as a new sign-up (the password is even hashed in both
branches, so the response time matches). The truth goes to the mailbox instead:
that address receives a "you already have an account" email with a reset link.
Whoever filled in the form learns nothing they did not already know.

**Why can staff not approve an account whose email is unconfirmed?** Because
approving it would hand a live account to whoever *typed* the address rather
than to whoever *owns* it — which is the one thing the confirmation link exists
to prevent, and no amount of staff diligence at that screen can tell the two
apart. The endpoint refuses it, not just the button.

### What signing in actually checks

`login()` in `backend/src/modules/identity/auth.service.ts`, in order:

```
1. Is there an account with this email?          → no  : generic failure
2. Is it the right surface (admin vs customer)?  → no  : generic failure
3. Is it locked from too many failed attempts?   → yes : told plainly, with the wait
4. Is it archived or deactivated?                → yes : told plainly
5. Is it PENDING_INVITATION?                     → yes : "use your invitation link"
6. Is it PENDING_APPROVAL?
       emailVerifiedAt is null → "confirm your email first"
       otherwise              → "waiting to be approved"
7. Does the password match?                      → no  : generic failure
8. Has a temporary password expired?             → yes : told (checked AFTER the password)
```

Three deliberate choices here:

- **Steps 1, 2 and 7 give the identical answer**, with a comparable response
  time. When the account does not exist the code still verifies the password
  against a dummy hash — otherwise "unknown email" would return in ~1ms and
  "wrong password" in ~50ms, and that gap alone enumerates the customer list.
- **A locked account is disclosed** because the person genuinely needs to know
  that waiting will help.
- **The expired-temporary-password check runs after the password check**, on
  purpose. Telling somebody who does not know the password that it has expired
  would confirm both that the account exists and that it has never been used.

## 9.2 Browsing and being quoted a price

```
Visitor opens /products
        │
        ▼
GET /api/v1/catalog?...
        │
        ▼  publicProductWhere() filters to published, non-archived products
           that have a price row in the visitor's currency
        ▼
Backend returns each product with ONE price: the stored figure for
that currency, plus a tax note naming the country and rate.
```

**The storefront never converts a price.** If a product has no price row for
your currency, it is not sold in your market and is left out of the grid
entirely.

**Why so strict?** A converted number drifts with the exchange rate between the
moment the page renders and the moment the card is charged — and the customer
would be charged something other than what the page showed. Quoting only a
stored figure means the quoted price *is* the charged price.

Staff fill those figures in two ways:

- **Per product**, in the product editor. Every figure is one a person typed.
- **Products → Currency pricing**, which converts a whole price list at a rate
  you enter and writes the results as ordinary price rows. It converts **once,
  on write**. Nothing tracks the rate afterwards.

An optional daily job can refresh prices that the bulk tool created — and only
those. It is bounded by four rules: it only touches rows flagged
`isAutoConverted` (a flag cleared the moment a human edits that price); it
abandons the entire run if any single price would move more than
`maxDriftPercent` (15% by default); it never opens a new market; and it is off
until switched on.

## 9.3 Cart → checkout → paid

This is the most important flow in the system.

```
┌── 1. ADD TO CART ────────────────────────────────────────────┐
│ POST /api/v1/cart/items  { productId, quantity }             │
│ Checks: is it published? is the quantity above the product's │
│ minimum? is there stock?                                     │
└──────────────────────────────────────────────────────────────┘
                            ▼
┌── 2. CHECKOUT SUBMITTED ─────────────────────────────────────┐
│ POST /api/v1/orders/checkout                                 │
│ Header: Idempotency-Key: <a key the browser generated>       │
│                                                              │
│ Inside ONE database transaction — all of it, or none of it:  │
│   a. Allocate an order number (UB-2026-000123) from a        │
│      counter row, incremented under an InnoDB row lock       │
│   b. Freeze every line into order_items: name, SKU, unit     │
│      price, tax rate — snapshots, not references             │
│   c. Reserve the stock                                       │
│   d. Work out tax (see below)                                │
│   e. Apply any coupon                                        │
│   f. Check the customer's purchasing limit for this currency │
│   g. Write the outbox row for the confirmation email         │
│   h. Write the admin notification for the bell               │
│   i. Convert the cart                                        │
└──────────────────────────────────────────────────────────────┘
                            ▼
        Does this order need approval? (high value, or credit terms)
                 │                              │
                yes                             no
                 ▼                              ▼
        status = PENDING_APPROVAL       status = PENDING_PAYMENT
        Finance approves it ───────────────────▶│
                                                ▼
┌── 3. PAYMENT ────────────────────────────────────────────────┐
│ The customer is shown the gateway's payment sheet            │
│ (Razorpay or Stripe) and pays.                               │
│                                                              │
│ The browser then returns to /order-confirmation/:orderId.    │
│ THIS REDIRECT CONFIRMS NOTHING.                              │
└──────────────────────────────────────────────────────────────┘
                            ▼
┌── 4. THE WEBHOOK — the only thing that confirms an order ────┐
│ The gateway's own server calls:                              │
│   POST /api/v1/payments/webhooks/stripe                      │
│                                                              │
│   · Signature verified against the RAW bytes                 │
│   · providerEventId is UNIQUE — a re-delivered event is a    │
│     duplicate-key error, not a second payment                │
│   · paidMinor updated, status → CONFIRMED                    │
│   · Stock reservation becomes a real deduction               │
│   · Confirmation email queued                                │
└──────────────────────────────────────────────────────────────┘
```

### Why the redirect confirms nothing

The redirect happens in the **customer's browser**, which the customer
controls. Anyone could type the confirmation URL by hand. The webhook comes
from the gateway's own server and is signed with a secret only the two servers
know. So money moves the order forward *only* on a signature-verified event.

This is why a payment gateway **cannot be activated without a signing secret**:
a connection with no secret would charge customers and confirm nothing.

### Why the idempotency key exists

The customer presses "Place order", the connection stutters, they press it
again. Without protection, that is two orders and two charges.

The key is stored in `idempotency_records` with a **hash of the request body**:

- Same key, same body → the first response is replayed. No second order.
- Same key, **different** body → rejected outright with
  `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY`. It is never silently answered
  with the earlier response, because that would confirm an order the customer
  did not place.

The same idea is applied structurally, in the database, everywhere it matters:

| Risk | The guard |
|---|---|
| Duplicate webhook delivery | `unique(payment_events.providerEventId)` |
| Duplicate checkout | `unique(idempotency_records.scope, key)` + body hash |
| Duplicate recurring order | `unique(schedule_occurrences.scheduleId, plannedRunAt)` |
| One occurrence becoming two orders | `unique(orders.scheduleOccurrenceId)` |
| Duplicate refund | `unique(refunds.idempotencyKey)` |
| Duplicate email | `unique(notification_outbox.dedupeKey)` |

These are **database constraints**, not code checks. Application logic can be
bypassed by a bug; a unique index cannot.

### How tax is worked out

Two completely different worlds, decided by whether the seller has an EU VAT
country configured:

- **Flat rate** (for example an Indian GST shop). Every buyer is quoted the
  listed figure. Asking where they are would change no number on any screen.
- **EU VAT.** The rate depends on the buyer's member state — the same euro row
  is 19% in Germany and 21% in the Netherlands. A business buyer with a valid
  VAT number in another member state may be zero-rated (reverse charge), and
  that number is validated against the EU's VIES service.

Whatever was decided is **frozen onto the order**: `taxTreatment`, `taxCountry`
and both parties' VAT numbers as they stood at checkout. Rates change and VAT
numbers get cancelled — an invoice already issued must not start disagreeing
with the order behind it.

## 9.4 The order's life

Ten statuses. **Every** change goes through `assertTransition` in
`backend/src/domain/order-state-machine.ts`. No service writes `status`
directly.

```
                 DRAFT
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
 PENDING_APPROVAL  ──▶  PENDING_PAYMENT
        │                     │
        │  (zero balance)     │  ◀── only from a verified webhook
        └────────┐            │
                 ▼            ▼
               CONFIRMED ◀────┘
                   │
                   ▼
              PROCESSING
                   │
                   ▼
                SHIPPED
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
    DELIVERED             RETURNED
                              │
                              ▼
                          REFUNDED   (terminal)

CANCELLED is reachable from DRAFT, PENDING_APPROVAL, PENDING_PAYMENT,
CONFIRMED and PROCESSING — always with a written reason.
```

Three transitions are **deliberately missing**, and the reasons are the
interesting part:

- **CONFIRMED → PENDING_PAYMENT.** The money has already settled. Re-opening
  payment would let a second charge attach to a paid order.
- **DELIVERED → CANCELLED.** After delivery the only route back is RETURNED.
  You cannot un-deliver something.
- **Anything out of REFUNDED.** It is terminal by design.

Each rule also records **who** may request it (`SYSTEM`, `ADMIN`, `CUSTOMER`),
which permission an admin needs, and whether a written reason is required.
Because this table is the single source of truth, the admin panel can ask "what
can I do with this order?" and get an answer guaranteed to match what the API
will accept.

Every change appends a row to `order_status_history`. The order's past is never
overwritten.

## 9.5 Repeating orders

A customer builds a schedule: these products, this quantity, every month on the
5th.

```
Customer creates a recurring_schedule with recurring_schedule_items
        │
        ▼  the worker runs schedule.run on a beat
For each schedule that is due, create a schedule_occurrence
        │
        ▼  unique(scheduleId, plannedRunAt) — a schedule can never
           produce two occurrences for the same date
Turn the occurrence into a real order
        │
        ▼  unique(orders.scheduleOccurrenceId) — one occurrence can
           never become two orders
The customer is emailed a reminder before it runs
```

Two unique constraints, at two different levels. Because a *repeating* order
that duplicates itself would keep duplicating, silently, forever.

## 9.6 A new member of staff

```
Business Owner opens Staff → Add
        │
        ▼  There is no password field on that form
The system generates a one-time password and emails it.
Nobody — including the person who created the account — ever sees it.
        │
        ▼
The new staff member signs in with it.
It works, and does exactly ONE thing: puts them on "Choose your password".
        │
        ▼  Until they finish, EVERY admin route answers 403.
           The block is `mustChangePassword` in plugins/auth.ts —
           the server, not the screen, so an API client is blocked too.
        ▼
They choose a password. Now the panel opens.
```

The temporary password lapses after **72 hours** — unlike a single-use
activation link, it sits in an inbox. **Staff → Resend password** issues a new
one and kills the old, and that button **disappears** once the holder has a
password of their own. From then on the only way back in is a reset they start
themselves, so a colleague cannot mint a credential for somebody who already
has one.

## 9.7 Refunds and returns

A refund is money leaving, so it is guarded in three separate places:

1. `unique(refunds.idempotencyKey)` — the same refund cannot be issued twice.
2. A database `CHECK` constraint, `chk_order_refund_within_paid`, makes
   over-refunding **impossible at the database level**, independent of any
   application logic.
3. Only the Finance / Approver role and the Business Owner hold
   `payment.refund`.

The refund's real outcome comes back the same way a payment does — from a
signature-verified provider event, plus a `refund.poll` job for gateways that
settle asynchronously.

---

# 10. Money — the most important rule

## Never use decimals for money

```ts
0.1 + 0.2 === 0.3   // false, in every language that uses IEEE-754 floats
                    // it is 0.30000000000000004
```

Computers store decimals in binary, and one tenth cannot be written exactly in
binary any more than one third can be written exactly in decimal. Every
arithmetic operation adds a tiny error. Do that across a few million order
lines and the books do not balance.

## What this project does instead

**Every amount is an integer of the smallest unit of the currency.**

| Real amount | Stored as | Meaning |
|---|---|---|
| ₹1,234.56 | `123456` | paise |
| €99.00 | `9900` | cents |

The type is `BigInt`, not `number`, because JavaScript's `number` loses
precision above about 9 quadrillion.

The rules, enforced in several places at once:

- Column names end in `Minor` (`subtotalMinor`, `grandTotalMinor`) so the unit
  is impossible to forget.
- **ESLint bans `parseFloat` outright** in the backend.
- `bigIntAsNumber: false` on the database driver stops MariaDB's `BIGINT` from
  silently becoming a lossy JavaScript `Number`.
- Amounts cross the API **as strings**, because JSON has only one number type
  and it is a float. `"123456"` survives; `123456` might not.
- Rounding is half-up, applied per line, in `backend/src/domain/money.ts`.

Tax rates are the exception: `Decimal(9,6)` percent, because a rate like
7.5% is not money and needs fractional precision.

---

# 11. The background worker

`backend/src/worker/` — the same codebase, started differently, with no web
server.

## The jobs

| Job | What it does |
|---|---|
| `notification.send` | Sends one email from the outbox |
| `schedule.run` | Turns due repeating schedules into orders |
| `schedule.reminder` | Warns a customer their repeating order is coming |
| `payment.reconcile` | Re-checks a payment whose outcome is unclear |
| `payment_link.expire` | Closes payment links nobody used |
| `refund.poll` | Chases a refund's final state |
| `import.process` | Processes an uploaded product spreadsheet |
| `export.generate` | Builds a report file |
| `integration.sync` | Runs an external connector |
| `reservation.sweep` | Frees stock reserved for carts that never paid |
| `low_stock.check` | Raises low-stock alerts |
| `fx_rate.refresh` | Refreshes auto-converted prices, once a day |
| `data_request.fulfil` | Builds a GDPR export, or carries out an approved erasure |
| `retention.sweep` | Deletes personal data past its retention window |

## The transactional outbox

This pattern appears everywhere, and it is worth understanding once.

**The problem.** Checkout must (a) save the order and (b) send a confirmation
email. Two different systems. If the order saves and then the mail server is
down, the customer gets no email. If the email sends and then the order fails
to save, the customer is told about an order that does not exist.

**The solution.** Do not send the email. In the *same database transaction* as
the order, write a row into `notification_outbox` saying "this email needs
sending". One transaction, so both happen or neither does.

The worker then reads that table and sends. If it crashes mid-send, the row is
still there and it tries again. `unique(dedupeKey)` stops the same email going
twice.

> A committed order cannot lose its confirmation email, and a rolled-back one
> cannot send a phantom.

## How several workers avoid doing the same job

MariaDB 10.4 has no `SKIP LOCKED`, so:

```
1. SELECT a batch of candidate job ids     ← no locks held
2. For each candidate:
      UPDATE job_queue
      SET status = 'RUNNING', leaseExpiresAt = now + 60s
      WHERE id = ? AND status = 'PENDING'
3. Proceed only if affectedRows === 1
```

Step 2 is atomic at the InnoDB row level, so exactly one worker wins each job.
A worker that crashes leaves an expired `leaseExpiresAt`, and
`reapExpiredLeases()` returns those rows to `PENDING`. A job that exhausts its
attempts becomes `DEAD` rather than being deleted, so it stays visible and can
be replayed.

**Run exactly one worker in development.** Several are safe in production, but
two started from *different builds* disagree about which job types exist, and a
job the older one cannot handle bounces back to the queue until it dies.

---

# 12. Security

## Passwords

**Argon2id**, 19 MiB memory, 2 iterations, 1 thread. Deliberately slow and
memory-hungry, so guessing at scale is expensive. The parameters are stored
inside the digest itself, so raising them later rehashes each user
transparently on their next successful login.

## Tokens

Invitation links, password resets and payment links are 32 bytes from a
cryptographically secure random generator. **Only the SHA-256 hash is stored.**
A stolen database backup contains no usable links.

## Provider credentials

Gateway keys and connector secrets are encrypted with **AES-256-GCM**, using
the record's own identity as additional authenticated data. A credential row
copied into another record fails to decrypt rather than yielding a working
secret.

## Comparisons

Every attacker-submittable comparison uses a constant-time `safeCompare`, so
the time a check takes reveals nothing about how nearly correct the guess was.

## CORS

An exact allowlist, no wildcards. The browser will not let a page on any other
origin read a reply from this API.

## Live keys cannot run outside production

The server **refuses to boot** when `NODE_ENV !== 'production'` and a key
begins `rzp_live_`, `sk_live_` or `pk_live_`:

> refusing to start: this is a LIVE Razorpay key and NODE_ENV is not
> production. Live keys move real money.

The same distinction runs through the admin panel: a live key filed under Test
mode is rejected at save, LIVE mode is labelled *"real money"* everywhere, and
activating a live connection asks for confirmation in those words.

## Configuration is validated at boot

`backend/src/config/env.ts` checks every environment variable with Zod before
the server accepts a single request. A wrong value stops the process with a
message naming the variable. **A server that runs half-configured is worse than
one that refuses to start** — the first fails quietly, in production, at the
worst moment.

## The audit log

`audit_log` records who did what, when, from which IP, with a before-and-after
snapshot. It is written in the same transaction as the change, so an action
cannot happen without leaving a trace.

---

# 13. Languages and markets

## Eight languages

English (default and fallback), Dutch, French, German, Greek, Italian, Polish
and Spanish. Built on **i18next / react-i18next**, one instance per frontend,
with translations in `src/i18n/locales/*.json`.

## Where a key goes

The catalogue is one flat file per language, and the key prefix says who owns
the string:

| Prefix | Holds | Example |
|---|---|---|
| `label.*` | A short reusable label: a column header, a field name, a metric caption | `label.status`, `label.onHand` |
| `common.*` | Chrome that appears on many screens, including a table's empty and error states | `common.nothingMatchesFilters` |
| `<page>.*` | That screen's own sentences: captions, empty states, filter wording | `inventory.stockMovements` |

**One word, one key.** "Status" is a column on eleven tables in the admin
panel; eleven `*.status` keys would be eleven chances for a translator to
render the same header eleven ways. If a string is already in `label.*` or
`common.*`, use it rather than adding a page copy.

Two things are deliberately **not** translated, and both are contracts rather
than prose: status and role values, which reach the screen through
`humanise()` and are the same words the API and the audit log use, and format
examples in placeholders (`NL123456789B01`, `PO-4471`).

A key that a component defaults to has to be resolved *inside* the component —
`emptyTitle = 'Nothing here yet'` as a default parameter is an English string
on every screen that did not pass the prop, and the hardest kind to find,
because it appears in no page's source.

## Anything that carries a message takes `t`

Two shapes recur, and both exist because `t` is only available while a
component is rendering:

- **A form schema is a function of `t`.** `buildSchema(t)` — never a
  `const schema = z.object(…)` at module scope. A schema frozen at import time
  reports every validation failure in whichever language loaded first, so the
  message a Greek member of staff reads depends on which tab they opened
  earlier. `zodResolver(buildSchema(t))` inside the component is the whole fix.
- **A lib helper takes `t` as a parameter.** `transitionLabel(t, to)` in
  `lib/orders.ts`, `applyApiErrors(…, t('common.theRequestFailed'))` in
  `lib/forms.ts`, `describeRules(t, rules)` in the storefront's
  `lib/quantity-rules.ts`. A module outside React cannot reach the catalogue
  and must not hold English of its own.
- **A failed request is worded in exactly one place.**
  `errorMessage(t, error, fallback)` in `apps/customer-web/src/lib/errors.ts`.
  The server's own `message` is already written for the person reading it and
  is used unchanged; what the helper adds is the three failures the browser
  diagnoses for itself. `api.ts` runs outside React, so it words those in
  English and marks them — `NetworkError.isOffline`, and the codes
  `SERVICE_UNAVAILABLE` and `UNEXPECTED_RESPONSE` — and `errorMessage` matches
  on the *mark*, never on the text. A screen that still reads `error.message`
  is reading the *server's* sentence, which is the one case where that is
  right.

Two shapes of string need more than a lookup:

- **A counted string** carries `count` *and* the number a second time:
  `t('catalog.productCount', { count: total, products: formatNumber(total) })`.
  `count` chooses the plural form, `{{products}}` carries the figure already
  formatted for the reader's locale — i18next would otherwise print a bare
  `1234`. Every counted key needs the forms its language actually
  distinguishes, which `Intl.PluralRules` decides and the catalogue test
  enforces: `_many` for French, Italian and Spanish, `_few` and `_many` for
  Polish.
- **A sentence with one styled word in it** is *split* on its placeholder
  rather than interpolated:
  `t('payment.orderIsPaid').split('{{order}}')`, with the order number drawn
  between the halves in its own monospace. Called with no values, so the
  placeholder survives for the split to find. This is how the order number, a
  spend figure and the support-email link keep their styling without cutting
  the sentence into fragments a translator cannot move.

A label table at module scope holds **keys**, not words —
`{ ACTIVE: 'label.active' }` — and `translateKey(t, key)` translates it where
it is drawn. The navigation map, the dashboard's period picker and the coupon
status badges all work this way.

A visitor's language is resolved most-specific-first: the signed-in account's
saved preference, then a manual choice, then the browser's setting, then
English.

In the **admin panel** one thing sits above all of those, and only once: the
country the current sign-in came from, read from `countries.languageCode`. A
member of staff signing in from Berlin lands on a German panel without touching
the picker; the moment they use the picker, their choice wins for that country
from then on. See [The location check at sign-in](#the-location-check-at-sign-in)
for the full rule. The storefront has no equivalent — a shopper is never asked
where they are.

The console's **currency** comes from the same country row and behaves the
opposite way: it is not a preference, there is no picker, and it cannot be
overridden. A language is a choice; a price is not.

## Language is not currency

This is a distinction people get wrong, so the codebase keeps them strictly
apart:

- **Language** is what the *words* are in.
- **Currency** is what the *prices* are in.

Someone in Belgium may read French and pay in euros. Someone in India may read
English and pay in rupees. A German speaker living in India buys in rupees.
Changing the language must never silently change what somebody is charged.

## A market exists only when someone has priced it

A currency being switched on is **not** a market. The catalogue holds a real,
staff-entered figure per currency, and nothing is converted at read time. So a
currency nobody has priced anything in is **invisible**: dropped from the
switcher entirely, rather than opening an empty shop that explains nothing.

---

# 14. Configuration

Everything lives in `backend/.env`, validated at boot by `src/config/env.ts`.

## The ones that must agree with each other

| Variable | Must be |
|---|---|
| `ADMIN_WEB_ORIGIN` | The admin panel's exact origin (default `http://localhost:5173`) |
| `CUSTOMER_WEB_ORIGIN` | The storefront's exact origin (default `http://localhost:5174`) |
| `CUSTOMER_WEB_PUBLIC_URL` | Where emailed customer links point |
| `ADMIN_WEB_PUBLIC_URL` | Where emailed staff links point |
| `apps/*/.env` → `VITE_API_BASE_URL` | The API's base URL |
| `apps/*/.env.local` → `TUNNEL_HOST` | The hostname of the development tunnel, if one is in use |

The CORS allowlist is exact, and both frontends use `strictPort`, so a port
clash fails loudly rather than silently moving to a port CORS will reject.

`TUNNEL_HOST` is development-only and belongs to the machine, not the project,
which is why it lives in the gitignored `.env.local` and is absent from every
deployment that is not being shown to someone over a tunnel. A Vite dev server
answers only to `localhost` — a DNS-rebinding defence — and refuses any other
hostname with *"Blocked request. This host is not allowed."* Naming the tunnel's
hostname adds it to that check, in every mode, and nothing else with it. See
`SETUP.md` Part 3.

## Feature flags

| Flag | Default | Effect |
|---|---|---|
| `FEATURE_CUSTOMER_SELF_REGISTRATION` | `false` | Shows the sign-up form |
| `CUSTOMER_SELF_REGISTRATION_REQUIRES_APPROVAL` | `true` | A confirmed sign-up still waits for staff |
| `FEATURE_STOCK_RESERVATIONS` | `true` | Reserve stock at checkout |
| `FEATURE_ORDER_APPROVALS` | `false` | Route orders through approval |
| `FEATURE_RECURRING_ORDERS` | `true` | Repeating orders |
| `FEATURE_ADMIN_LOGIN_LOCATION` | `true` | Ask staff's browser for its location at sign-in |
| `ASSISTANT_ENABLED` | — | The AI chat widget |

## Pluggable adapters

Each of these is an interface with more than one implementation, chosen by a
setting:

| Setting | Options |
|---|---|
| `QUEUE_DRIVER` | `database` (default) or `redis` |
| `CACHE_DRIVER` | `memory` or `redis` |
| `STORAGE_DRIVER` | `local` or `s3` |
| `EMAIL_DRIVER` | `log` (prints to the worker terminal) or `smtp` |
| `PAYMENT_DEFAULT_PROVIDER` | `razorpay` or `stripe` |

`EMAIL_DRIVER=log` is where you find confirmation links and temporary passwords
while developing. It is refused in production.

---

# 15. Where to find things

```
UBoss-Software/
├── SETUP.md                        How to install and run it
├── PROJECT-GUIDE.md                This file
├── PROJECT-GUIDE.hinglish.md       Same thing in Hinglish (not committed)
├── README.md                       Configuration, markets, payments, languages
│
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma           ← THE DATABASE SHAPE. 76 models.
│   │   └── migrations/             18 numbered, committed SQL steps
│   ├── src/
│   │   ├── config/env.ts           ← Every setting, validated at boot
│   │   ├── domain/                 Pure rules, no I/O
│   │   │   ├── money.ts            BigInt arithmetic, rounding
│   │   │   ├── errors.ts           ← The 106 error codes
│   │   │   ├── permissions.ts      ← Roles and ~45 permissions
│   │   │   └── order-state-machine.ts  ← Legal order transitions
│   │   ├── infra/                  Database, crypto, ids, queue, email, storage
│   │   ├── http/
│   │   │   ├── app.ts              ← Plugin order, CORS, raw body, error envelope
│   │   │   ├── server.ts           Entry point
│   │   │   └── routes/             22 route files
│   │   ├── modules/                ← The business logic
│   │   ├── worker/                 The background worker
│   │   └── seed/                   Development data
│   ├── tests/                      Unit and integration tests
│   └── docs/                       RUNBOOK, EU-VAT, DATA-PROTECTION, ...
│
├── apps/customer-web/src/
│   ├── app/router.tsx              ← Every storefront page
│   ├── pages/                      One file per page
│   ├── components/                 Shared UI
│   ├── lib/api.ts                  ← The single HTTP helper
│   ├── i18n/locales/               Eight languages
│   └── auth/                       Session context
│
└── apps/admin-web/src/             Same shape, different screens
```

## "I want to change X — where do I look?"

| Goal | Start here |
|---|---|
| Add a field to a product | `prisma/schema.prisma`, then a migration, then `modules/catalog/` |
| Change what checkout does | `modules/orders/order.service.ts` |
| Change who may do something | `domain/permissions.ts` |
| Add an order status rule | `domain/order-state-machine.ts` |
| Change an error message | `i18n/locales/*.json` in the frontend |
| Add an error code | `domain/errors.ts`, then map it in both frontends |
| Change a page's look | `apps/*/src/pages/` |
| Change which language a country's staff read | the `countries` row's `languageCode` |
| Change which language a country's staff read | the `countries` row's `languageCode` |
| Change what happens in the background | `src/worker/handlers.ts` |
| Turn a feature on or off | `backend/.env` |

---

# 16. Keeping this document true

**This document and its Hinglish twin must be updated whenever the project
changes.** That is not a nicety — a guide that has quietly stopped being true is
worse than no guide, because people trust it and act on it.

Update both files when any of these change:

- A new page, or a page that moves or disappears
- A new API endpoint, or a change in what one returns
- A database table or column
- A business rule — how tax works, when approval is needed, what a status means
- A flow — sign-up, checkout, payment, fulfilment, refunds
- A feature flag or configuration setting
- A role or permission
- Anything in the security model

The two files must stay **in step with each other**. They are the same document
in two languages, not two documents. If a section is added to one, the same
section is added to the other.

> `PROJECT-GUIDE.hinglish.md` is listed in `.gitignore`, so it never reaches the
> repository. It exists for reading, not for shipping. Keeping it out of git is
> deliberate: the committed documentation of a product sold to other companies
> stays in one language.
