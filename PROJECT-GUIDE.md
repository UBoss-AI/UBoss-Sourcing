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
   - [9.5 Scheduled orders — Buy Later and Subscribe & Reorder](#95-scheduled-orders--buy-later-and-subscribe--reorder)
   - [9.5.1 Autopay: charging a card nobody is looking at](#951-autopay-charging-a-card-nobody-is-looking-at)
   - [9.5.2 The ERP hand-off](#952-the-erp-hand-off)
   - [9.8 The ERP connection, and Autopay](#98-the-erp-connection-and-autopay)
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
| Inventory Manager | Admin panel | Record stock arriving, fix stock counts, keep the warehouses |
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

## The look, and the one place it is defined

The two frontends share no browser code, but they *do* share one palette — and
that is deliberate, because they are one product to the company that bought it.

The palette lives in two files that are kept **identical**:

```
apps/customer-web/src/index.css   ← the :root token block
apps/admin-web/src/index.css      ← the same block, same values
```

**A colour changes in both files or it has not really changed.** Only the prose
around the tokens differs; each app describes the shared palette in its own
terms. Below the palette the two diverge on purpose — the storefront is the
spacious one and the panel the dense one — but that difference lives in
padding, type steps and radii, never in the colours.

### What the product looks like

White and sky blue, with blue as the accent. The rule that produces it:

- **The page ground is a blue-tinted white** (`--surface-sunken`), and
  everything that sits on it — cards, the storefront header, the admin sidebar,
  the top bar — is **pure white**. That inversion is the whole scheme. Both
  chromes used to be a navy band; the separation now comes from the page being
  cool rather than from the chrome being dark.
- **Hairlines are tinted to match** (`--border`), so a card edge belongs to the
  ground it is drawn on instead of being a grey line over a cool surface.
- **Blue is navigation and primary actions. Orange is the buy path, and
  nothing else.** Add to Cart, Checkout, Place Order — and the storefront's
  basket button, which is the only orange in the chrome. A CTA that looked
  like a link would stop being noticed as either.
- **Teal is a standing arrangement** — schedules, Autopay — so committing to
  a repeat delivery never has to borrow the buy path's orange.

### How far the tint can go is not a matter of taste

`npm run audit:contrast` (in both apps) reads the token block directly and
checks every pair the components actually put together against WCAG 2.1 AA —
4.5:1 for text, 3:1 for anything that identifies a control. It exits non-zero
on a failure and runs as part of `npm run verify`.

That audit is what sets the ceiling on the sky tint. A tinted ground is a
*darker* ground, and the quietest text in the app — `--ink-subtle`, which
carries SKUs, timestamps and every table column header — is the first thing
that stops passing on it. It sits at 4.98:1 on the page ground today. A couple
of steps deeper and the audit fails, which is the correct outcome: the
alternative is a slightly prettier blue that a low-vision buyer cannot read a
part number on.

There is no dark theme, and `color-scheme: light` says so to the browser. The
parts of a page the browser draws itself — the scrollbar, and the option list
of a native `<select>` — would otherwise render dark for a visitor whose
operating system is, on a product that is white everywhere else.

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
| `/account/autopay` | Autopay: consent, limits, which card | **Yes** |

**Browsing does not need an account.** The sign-in wall sits at the *cart*, not
at the front door — because the backend puts it there too. A visitor can see
the whole catalogue and prices, and is only asked to identify themselves when
they want to actually buy.

**The AI chat widget is the second thing behind that wall.** A guest sees the
launcher and, on pressing it, a "Sign in to use AI" panel — never a composer.
Signing in from there returns them to the page they were on with the panel
already open. See *The AI assistant* in section 8 for why the API insists on it
too. It can also be opened from the front page — see below.

## The front page, and the sourcing hub

`/` is a greeting page. Above the catalogue it carries one large animated
graphic: a central orb labelled **Sourcing**, two orbital rings turning in
opposite directions, and six capabilities arranged on a circle around it.

| Node | What pressing it does |
|---|---|
| AI Assistant | Opens the chat panel in the corner of the page |
| Scheduled Orders | Goes to `/account/schedules` |
| Autopay | Goes to `/account/autopay` |
| Inventory Sync | Goes to `/products` — a synchronised stock level is shown on the product |
| Warehouse Network | Explains that the network belongs to the operator, and offers the catalogue |
| ERP Integration | Explains that a connection is created in the admin panel |

**A node never links somewhere the person pressing it cannot go.** That is the
rule the whole thing is built on, and it is why three of the six are `<a>` and
three are `<button>` depending on who is looking:

- A **guest** pressing Scheduled Orders, Autopay or AI Assistant gets a short
  explanation and a **Sign in** link — never the guarded route, and never an
  AI composer.
- A capability this deployment has **switched off** (`recurringOrders`,
  `assistant`) explains that instead of linking to a page that would 404.
- **Warehouses and ERP always explain**, for everybody. Neither has a customer
  screen and neither is supposed to grow one — an ERP connection is a URL plus
  a credential belonging to whoever runs the installation, which is exactly why
  the screen for it is Settings → ERP in the admin panel.

The decision table lives in
`apps/customer-web/src/components/greeting/orchestration-nodes.ts`, on its own,
so it can be read and tested without rendering an SVG.

### What a signed-in customer sees underneath

A panel that renders **nothing at all for a guest**, and makes no request for
one. For a customer it carries:

- A personalised greeting, *if* the account has a name on it. `fullName` is
  nullable and blank in plenty of real purchasing accounts, so a missing name
  falls back to "Welcome back" rather than breaking the page. It is never
  derived from the email address.
- Actions: **View dashboard**, **Ask AI**, **Build a cart**, **Schedule a
  cart**, **Connect ERP API**. Each appears only where it leads somewhere —
  no schedule action without `recurringOrders`, no AI action without an
  assistant.
- The **next scheduled order**: the soonest run across every active plan, with
  the plan's status, the server's own description of the recurrence, and a
  link straight to that schedule.
- **Setup guidance**, when there is any: a card that can no longer be charged,
  a paused Autopay authority, or a repeat purchase running with no standing
  authority behind it.

**Guidance never gates.** A setup notice changes nothing about the actions
beside it: a customer who has not finished setting up Autopay can
still open their orders, build a basket and schedule one.

**The page never claims an ERP is connected.** There is no customer-facing
endpoint for that and there should not be one, so the ERP entry is worded as
an explanation of how the hand-off works and of who sets it up. A green "ERP
connected" chip here would be a decoration pretending to be a status.

### The animation

Everything that moves animates **`transform` and `opacity` only** — the orb's
wireframe rotates in three dimensions, the rings counter-rotate, particles ride
them, a light travels out along each spoke, and the six nodes float. All of it
composites on the GPU and does no layout for the life of the page. The
travelling lights are circles that translate rather than the usual animated
`stroke-dashoffset`, which would repaint the whole path every frame.

**The word "Sourcing" does not rotate.** It is a sibling layer of the orb with
no transform at all, because a word painted onto a spinning sphere is
unreadable for most of every revolution.

`prefers-reduced-motion: reduce` stops every rotation, the float and the
pointer parallax. The parallax is written straight to two CSS custom
properties on the element and re-reads the media query on each frame, so
switching reduced motion on mid-visit takes effect without a reload.

**Below `lg` the circle becomes a list.** Same DOM, same six controls, same tab
order: the orb stays as a smaller graphic and the nodes drop into a grid under
it — one column on a phone, two from `sm`. A radial layout that merely scaled
down would put one node's label on top of another's.

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
| `/warehouses` | Warehouses | The places stock is held, drawn on a map, with search and filters |
| `/orders` | Orders | Every order, filterable |
| `/orders/:id` | Order detail | Items, payments, shipments, status actions |
| `/payments` | Payments | Transactions, refunds, payment links |
| `/recurring` | Recurring | Customers' repeating-order schedules |
| `/customers` | Customers | Accounts, including "awaiting approval" |
| `/customers/:id` | Customer detail | Their prices, limits, addresses, orders |
| `/chat-enquiries` | Chat enquiries | Transcripts from the AI widget, and whose account each one belongs to |
| `/reports` | Reports | Sales, stock and tax reports; exports |
| `/data-requests` | Data requests | GDPR access and erasure requests |
| `/manufacturers` | Manufacturers | Economic operators required by EU product law |
| `/audit` | Audit log | Who changed what, and when |
| `/integrations` | Integrations | Payment gateway credentials, connectors |
| `/staff` | Staff | Staff accounts and their roles |
| `/settings` | Settings | Business profile, tax, shipping, currencies, notifications |
| `/settings/erp` | Settings → ERP | The ERP connection: address, credentials, endpoints, field mapping, test, sync, activity |

## Warehouses, and the map

`/warehouses` is where a business describes the buildings its stock sits in.
Every balance, movement and reservation in the system already carried a
location; this is the screen that creates and corrects them.

**Four rules, all enforced on the server.**

1. **A warehouse is never deleted, only retired.** Every stock movement ever
   booked against it points at that row, so deleting it would orphan the ledger
   that explains where stock went. Retiring takes it out of the receipt and
   adjustment pickers and leaves all of its history readable.
2. **Retiring is refused while it still holds stock**, and the refusal says how
   many units. Retiring a full warehouse would not move the stock — it would
   hide it, by removing the only place from which it could be adjusted back
   out.
3. **There is always exactly one default, and it is always active.** Stock
   received without a warehouse named lands in the default. Promoting another
   one demotes the previous holder in the same write; demoting the only default
   is refused, because a deployment with no default cannot book a receipt at
   all. The first warehouse ever created becomes the default whatever the form
   said.
4. **A code belongs to one warehouse forever, in practice.** It is stamped on
   every movement, and the codes are stored in capitals because MariaDB's
   collation is case-insensitive — `main` and `MAIN` would collide anyway.

**What a warehouse record holds.**

| Field | Notes |
|---|---|
| `code`, `name` | The code is stamped on every stock movement, and is unique |
| `addressJson` | Street, city, region, postcode. Free text, read by people |
| `countryCode` | A column with a foreign key to `countries`, **not** a field inside the address — the console filters and searches on it |
| `timezone` | IANA, e.g. `Europe/Brussels`. Stored rather than derived: Spain spans two zones |
| `latitude`, `longitude` | `DECIMAL(9,6)`, about 11cm |
| `operationalStatus` | `OPERATIONAL` / `LIMITED` / `MAINTENANCE` / `SUSPENDED` |
| `isDefault`, `isActive` | Where unqualified receipts land; whether the record is retired |
| `erpExternalId` | The warehouse's id in the ERP. Master data a person enters |
| `erpSyncStatus`, `erpLastSyncAt`, `erpSyncMessage` | Written **only** by the connector, through `PUT .../erp-status` |

**Active and operational are different questions**, and conflating them is the
mistake the second field exists to prevent. `isActive` asks whether the place
is part of the business at all — retiring one archives it and takes it out of
every stock picker. `operationalStatus` asks whether one that *is* can move a
box today. A warehouse closed for a roof repair is thoroughly active and cannot
ship a thing.

**The ERP fields are a per-warehouse view, not the run history.** `sync_runs`
records what a job did; one ERP connection syncs many warehouses, and "when did
Antwerp last agree with the ERP" is a different question with a different
reader. `erpLastSyncAt` moves only on a terminal outcome — a `PENDING` leaves
it where it was, because stamping the time when a job *starts* would make a
warehouse that has been failing for a week look freshly synced.

**Where a warehouse is.** Both coordinates are nullable, and **null is an
ordinary state**: a warehouse with no coordinates works exactly like the others
and is simply listed under the map rather than drawn on it. A database CHECK
constraint holds the pair together, so there is no such thing as a latitude
with no longitude — that names a line around the planet, not a place.

The API reports a third case as well. A pair that is *stored* and cannot be
drawn — a latitude of 999, a lone axis — comes back with null coordinates and
`coordinatesInvalid: true`, and the panel names those warehouses instead of
quietly showing a shorter list. That state is unreachable through the API,
which is exactly why it is carried: MariaDB enforces CHECK constraints, **MySQL
5.7 parses them and silently ignores them**, and this software is installed by
whoever buys it.

The panel offers to look coordinates up from the typed address, and fills the
two fields in for the reader to check rather than saving silently. A geocoder
that is switched off, firewalled or simply wrong about a town must never be
able to stop somebody recording a building.

**The map's background is the operator's decision, and the default is none.**
With no `MAP_TILE_URL` set the map still works — it pans, zooms, carries a
scale bar and places every marker correctly relative to the others — it just
has no picture of the ground behind it, and the screen says so. That default is
deliberate: a tile request tells whoever serves it which part of the world is
being looked at, and in a self-hosted product that is where the buyer's
warehouses are. Nothing is sent anywhere until the operator asks for it. See
[Configuration](#14-configuration).

**What the screen deliberately does not show is a valuation per warehouse.**
Product prices here are per currency, so adding up the SKUs in one building
would put rupees and euros in the same total and print it as though it meant
something. Units are what a warehouse holds; money belongs on the screens that
know which currency they are quoting.

Leaflet draws the map, loaded by a dynamic `import()` inside the map component
so it lands in its own chunk. Somebody who opens this screen to correct a
postcode never downloads it.

**Finding one.** The search matches the name, the code **and the country's
name** — somebody hunting for the Greek warehouse types "greece", not "GR" —
and it runs on the server, which is the only place that join is available.
Alongside it are an operational-status filter and a country filter. All three
live in the URL, the way the Dashboard's reporting window does, so a colleague
can be sent the address bar.

**Clicking a marker opens a side panel** with the whole record: the address,
the coordinates, the local time at that warehouse, the stock roll-up, and where
it stands with the ERP. A panel rather than a map popup, because a popup has to
fit inside the map and would either cover the markers around it or truncate
what it says. On a desktop it sits beside the map; below `lg` the page stacks
and it lands underneath.

**Every state on the screen has a message.** Loading, no warehouses at all, no
warehouse matching the filters (with a button to clear them), coordinates that
cannot be drawn, and a failed request — the last of those puts one error region
with a **Try again** on it in place of the map and the table, rather than two
retries for one failure.

**Access.** The route is behind `RequirePermission` with `inventory.read`, and
every endpoint behind it is behind `requireAdmin`, which authenticates as
`ADMIN`, refuses an account still on a temporary password, refuses a session
that has not said where it signed in from, and then checks the permission.
Editing needs `inventory.location.write` on top. The frontend guard only
decides what is *shown*; the server decides what is allowed.

**The endpoints.** All under `/api/v1/admin`.

| Method and path | Permission | What it does |
|---|---|---|
| `GET /inventory/warehouses` | `inventory.read` | Every warehouse with its stock roll-up, plus the tile source. Takes `q`, `countryCode`, `status` (repeatable) and `includeInactive` |
| `POST /inventory/warehouses` | `inventory.location.write` | Opens one. Country required |
| `PATCH /inventory/warehouses/:id` | `inventory.location.write` | Corrects, moves, retires or promotes one. Absent fields are left alone |
| `PUT /inventory/warehouses/:id/erp-status` | `inventory.location.write` | The connector reports where the warehouse stands with the ERP |
| `POST /inventory/warehouses/geocode` | `inventory.location.write` | An address to coordinates. A POST so the address stays out of access logs |
| `GET /inventory/warehouse-countries` | `inventory.read` | The countries a warehouse may be in, for the pickers |
| `GET /inventory/locations` | `inventory.read` | The *pickers'* list — active only, no stock roll-up. Deliberately not the same endpoint |

There is no `DELETE`, and there will not be one: movements reference the
location with `onDelete: Restrict`.

## The five staff roles

A member of staff has a role, and a role is a fixed bundle of permissions.
There are about 50 permission keys, like `product.write` or `order.approve`.

| Role | Can do |
|---|---|
| **Business Owner / Super Admin** | Everything, including staff and settings |
| **Catalog Manager** | Categories, products, media, pricing, publishing |
| **Inventory Manager** | Stock receipts, adjustments, reservations, warehouses, alerts |
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
| `assistant` | The AI chat widget on the storefront, for signed-in customers |
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

**Scheduled and repeating orders**
`recurring_schedules`, `recurring_schedule_items`, `schedule_occurrences`,
`customer_payment_methods`, `erp_order_pushes`

**Integrations**
The OPERATOR's own connector: `integration_connections`, `sync_runs`,
`sync_errors`, `import_jobs`, `import_row_errors`, `export_jobs`

The ERP connected under Settings → ERP — see 9.8, and note that nothing here
may write `inventory_balances`: `erp_connections`, `erp_inventory_snapshots`,
`erp_inventory_sync_runs`, `erp_sync_record_errors`, `integration_events`,
`erp_webhook_receipts`, `customer_autopay_settings`

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

## The zones

| Zone | Prefix | Who may call it |
|---|---|---|
| **Public** | `/api/v1/config`, `/api/v1/catalog` | Anyone, no login |
| **Customer** | `/api/v1/auth`, `/account`, `/cart`, `/orders`, `/recurring-schedules`, `/assistant` | A signed-in customer |
| **Webhooks** | `/api/v1/payments/webhooks/:provider`, `/api/v1/integrations/erp/webhooks/:slug` | A machine, proving itself with a signature over the raw bytes. See *The webhook exception* |
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

## The AI assistant

Two endpoints, both in the **Customer** zone.

| Endpoint | Body | Answers |
|---|---|---|
| `POST /api/v1/assistant/start` | *(empty)* | `{ conversationId }` |
| `POST /api/v1/assistant/chat` | `{ conversationId, message }` | A Server-Sent Event stream |

**It used to be public, and it is not any more.** The widget opened with a form
asking for a name, a mobile number and an email, and that form was the only
answer to "who is asking". Nothing typed into it was verified, so it bought
friction rather than safety. Both the form and the anonymous access are gone.

What every request is now checked for, before a single token is bought:

| Check | Failure |
|---|---|
| An access token for the **customer** surface | `401 UNAUTHENTICATED` |
| A token that verifies and has not expired | `401 SESSION_EXPIRED` |
| A session that has not been revoked (logout, password change, deactivation) | `401 SESSION_EXPIRED` |
| An account that is still `ACTIVE` and not archived | `401 ACCOUNT_DEACTIVATED` |
| A staff credential presented here | `403 FORBIDDEN` |
| A customer with no `CustomerProfile` | `403 ACCOUNT_NOT_ACTIVATED` |
| The CSRF double-submit header | `403 FORBIDDEN` |
| The conversation belongs to **this** account | `404 NOT_FOUND` |

The 404 on the last row is deliberate: somebody else's conversation must not be
distinguishable from one that never existed, or a conversation id becomes a way
to ask whose it is.

**Rate limits stay.** `/start` allows 30 per 15 minutes per address —
deliberately generous, because a procurement office is often a dozen people
behind one NAT address. `/chat` uses `ASSISTANT_RATE_LIMIT_PER_5MIN`.
Authentication says *who* may spend the deployment's provider budget; it does
not say how much, and it does not stop one signed-in account from driving the
endpoint as a general-purpose relay. Only the fixed parameters do that: the
request body cannot name a model, a system prompt or a token budget, and a body
carrying one is a `400`.

**What the assistant knows about the customer.** Because the caller is
authenticated, it never has to ask. The system prompt carries a few lines read
from their account under that session — full name, organisation, department,
account number, preferred currency and country — and nothing else. No address,
no order history, no VAT or GST number, no internal note. The test for a field
is not "could it help" but "would an answer be wrong without it", because every
line is sent to the AI provider on every turn. Those lines go **last** in the
prompt, below the catalogue snapshot, so the cacheable prefix stays identical
for every customer.

**Nothing sensitive is logged.** The conversation id, the model and the token
counts go to the log. The question, the reply and the customer's details do
not: a transcript belongs in the database, where the retention sweep can reach
it and an erasure request can delete it.

**The old columns are still there.** `assistant_conversations` keeps
`visitorName`, `visitorPhone`, `visitorEmail`, `visitorEmailNormalized` and
`sessionTokenHash`, now nullable and never written. The rows that already have
them are somebody's enquiry, and they leave on the schedule
`RETENTION_ASSISTANT_CONVERSATION_DAYS` has always set for them. The Chat enquiries screen
reads both eras and labels which is which — details from an account are marked
verified; details typed into the old form are marked as the unchecked claims
they always were.

## The webhook exception

`POST /api/v1/payments/webhooks/razorpay` and `.../stripe` are the only
unauthenticated endpoints that change money. Their authority is the
**cryptographic signature over the raw body**, not a cookie. This is correct:
the caller is Stripe's server, which has no browser and no cookie, but does
hold a shared signing secret.

`POST /api/v1/integrations/erp/webhooks/:slug` is the same exception for the
same reason, one layer out: the caller is the business's ERP pushing a stock
update. Its authority is an HMAC-SHA256 over the raw bytes, compared in constant
time against a secret held by that connection and the ERP alone, at an
unguessable per-connection path. There is no unsigned mode.

**Both are registered in `RAW_BODY_ROUTES`**, and that is not a detail. A
signature is over the exact bytes that were sent; verifying against a
re-serialised object fails for every honest sender, because key order and
whitespace change on a JSON round trip — and the usual "fix" for that is to stop
verifying.

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

## 9.5 Scheduled orders — Buy Later and Subscribe & Reorder

Checkout offers three things to do with a basket:

| Option | What it means | What it creates |
|---|---|---|
| **Buy Now** | Pay now, as always | An order |
| **Buy Later** | Deliver this basket once, on a date I pick | A ONE_TIME plan |
| **Subscribe & Reorder** | Deliver this basket again and again | A RECURRING plan |

The last two are the same machinery with a different frequency. Both are
optional, and neither charges anybody until the customer has read a review
screen and confirmed it.

### The two records

A **plan** (`recurring_schedules`) is the standing instruction: this basket,
this often, to this address, on this card. An **occurrence**
(`schedule_occurrences`) is one billing cycle of it. One plan, many
occurrences — and every occurrence is priced, validated and charged on its own.

### Plan statuses

| Status | Meaning |
|---|---|
| `DRAFT` | Configured, not yet authorised. Charges nobody; `nextRunAt` is NULL, so the worker cannot see it |
| `ACTIVE` | Live. The only status the worker will run |
| `PAUSED` | Stopped by the customer, or by the engine because something needs them — a dead card, a withdrawn product |
| `COMPLETED` | Ran its course: the end date passed, or the occurrence limit was reached. A Buy Later lands here after its one delivery |
| `CANCELLED` | Somebody stopped it. Terminal |
| `FAILED` | Too many consecutive failures. Suspended, not withdrawn — the customer can fix their card and resume |

`COMPLETED` and `CANCELLED` are deliberately different. "This has finished"
and "you cancelled this" are different sentences, and the customer's screen
says a different thing for each.

### Occurrence statuses

| Status | Meaning |
|---|---|
| `SCHEDULED` | Created ahead of time so the customer has a row to skip, re-date or cancel |
| `AWAITING_VALIDATION` | A worker has claimed it and is revalidating. No money has moved |
| `PAYMENT_PENDING` | Priced and validated; a charge is in flight, or a payment link is out |
| `ACTION_REQUIRED` | The bank wants the cardholder (3-D Secure). Nothing retries on its own |
| `PROCESSING` | Paid. The order exists and is being handed on |
| `PAID_ERP_PENDING` | **Paid, order real, ERP has not taken it.** Retries under the same key; never re-charges |
| `COMPLETED` | Paid, ordered, ERP notified, customer told |
| `SKIPPED` | Not run — the customer skipped it, or it could not be supplied |
| `CANCELLED` | This cycle was cancelled |
| `FAILED` | Something broke before payment. Bounded retries |

`PENDING`, `ORDER_CREATED` and `PAID` also exist in the enum. Nothing writes
them; they are kept so rows from the previous engine still read correctly.

### How often — the intervals offered

The builder's **Repeat** dropdown offers six intervals, grouped as *Common
intervals*:

| The customer picks | Stored as | Which day it lands on |
|---|---|---|
| Every 15 days | `EVERY_N_DAYS`, `intervalDays` 15 | Counted from the start date |
| Every month | `MONTHLY`, `monthDay` from the start date | The same date each month, clamped in short months |
| Every 2 months | `EVERY_N_MONTHS`, `intervalMonths` 2 | The start date's day, every second month |
| Every 3 months | `EVERY_N_MONTHS`, `intervalMonths` 3 | …every third month |
| Every 6 months | `EVERY_N_MONTHS`, `intervalMonths` 6 | …every sixth |
| Once a year | `EVERY_N_MONTHS`, `intervalMonths` 12 | The same date next year |

Under *Something else* are the three cadences that shipped before the presets:
every so many days, weekly on a chosen weekday, and monthly on a chosen date.
Each asks a follow-up question, which is why they are grouped apart — a
customer wanting "every three months" should not have to answer "which day of
the month?" when they already picked a start date.

**`EVERY_N_MONTHS` is not `EVERY_N_DAYS` with a bigger number, and that is the
point.** A quarter is not ninety days and a year is not 365 of them, so a
month-interval plan counted in days walks backwards through the calendar — an
"every 90 days" order starting 15 January is billing on the 14th by its second
year and in the previous month within four. `intervalMonths` counts calendar
months from the start date, so the date holds for ever. `domain/recurrence.ts`
owns the arithmetic and `tests/unit/recurrence.test.ts` states the drift as a
test.

There is deliberately no `intervalMonths` of 1: that is `MONTHLY`, and two
storable spellings of one cadence is how a screen reading a plan's own settings
reports it back wrongly. The day of the month is not stored for
`EVERY_N_MONTHS` either — it comes from `startDate`, because "every three
months" is a choice about spacing and the date was settled when the customer
picked their first delivery.

Adding another member to `ScheduleFrequency` needs a migration for
`chk_schedule_frequency_field_present`. That CHECK names each frequency and the
column it depends on, and a CHECK matching no branch **fails** — so a frequency
absent from it cannot be inserted at all. See
`20260909160000_schedule_month_intervals`.

### Which products can be repeated

By default, **all of them**: anything a customer can buy, they can schedule.

`FEATURE_SCHEDULE_ANY_PRODUCT` (default `true`) is what says so. Turn it off
and eligibility falls back to the per-product **Eligible for repeat purchase**
tick on the product form, which is how a store curates its repeatable range —
clearance lines, one-per-customer devices, anything sold against a single
tender.

The question is asked in one place, `modules/catalog/recurring-eligibility.ts`,
and every caller goes through it: the product badge, the cart badge, the cart
panel's count, the builder's item list, `quoteSchedule`, and
`createSchedule`'s own refusal. Computing it separately in six places is six
chances for the storefront to offer a schedule the API then refuses.

### Where a customer starts one

Four doors, all leading to `/schedules/new`:

| From | What they see |
|---|---|
| A product page | The **Schedule your Cart** button, beside Add to Cart |
| `/cart` | A **Need this again?** panel beside Checkout, when at least one line is eligible |
| `/checkout` | **Repeat this order on a schedule**, directly under Place Order |
| `/account/schedules` | The list of plans they already have, and its empty state |

The cart and checkout doors are the ones that matter, because they are where
the decision is actually being made — a customer who has just added a case of
syringes is at the exact moment they think "I need these every week", and one
standing at Place Order is thinking "I will be doing this again next month".

The checkout offer is deliberately **not** a second orange button and sits
*below* Place Order. Place Order is what that page is for; this is an
alternative to it, and two equally loud calls to action is how somebody ends up
on a subscription they meant to buy once. It appears only when the store offers
repeat purchases and the basket has at least one eligible line, so it never
leads to the builder's empty state.

### Autopay, from the cart

The cart panel shows the state of **Autopay** — On, Paused or Off —
with the card that would be charged, and it is actionable. One control per
state, never two:

| State | Control | What happens |
|---|---|---|
| On | **Manage Autopay** → `/account/autopay` | Limits and withdrawal belong on the page that explains both |
| Off, no card saved | **Set up a card for Autopay** | Card enrolment, then the consent step |
| Off, card saved | **Turn on Autopay** | The consent step alone |
| Paused | **Resume Autopay** | One call. Consent is already on record, so nothing is asked again |

The label names the *first step*, not the destination. A customer promised
"turn on Autopay" and handed a card form has been surprised by it;
one offered "set up a card for Autopay" has not.

**Nothing is authorised from the panel itself.** Both the card and the consent
are collected in a dialog with the wording in front of the customer, and the
two are kept apart because they are different agreements: saving a card is not
agreeing to be charged with it. A customer can reasonably want the first
without the second, and one tick covering both would be consent to the larger
thing obtained by asking about the smaller one. Spending limits are not asked
for in the dialog either — it links to `/account/autopay` instead of
reproducing that page badly.

Both halves of the panel fail quietly. A store that does not offer Autopay
(`available: false`) gets the schedule button and no Autopay block, and a
failed read of `/account/autopay` does the same. A cart must not lose its
checkout button because an account endpoint hiccoughed. The panel itself is
hidden entirely when no line is eligible, because `/schedules/new` filters the
cart by the same flag and would otherwise greet the customer with its empty
state.

### The flow

```
Cart → POST /recurring-schedules/preview
        │  prices the basket under the proposed schedule.
        │  Writes nothing. Shows items, quantities, price,
        │  discount, tax, delivery, total, address, payment
        │  method, frequency and the next processing date.
        ▼
POST /recurring-schedules/from-cart  →  a DRAFT
        │  the cart is untouched: an abandoned draft must not
        │  cost the customer their basket
        ▼
POST /recurring-schedules/:id/activate
        │  explicit consent, recorded and versioned.
        │  The cart is emptied here, not before.
        ▼  upcoming occurrences are materialised
SCHEDULED rows the customer can skip, re-date or cancel
        │
        ▼  worker: schedule.run, on a beat
claim the plan (lease) → claim the slot (conditional UPDATE)
        │
        ▼  AWAITING_VALIDATION
revalidate EVERYTHING: account, products, current prices,
tax, delivery, platform stock, ERP stock, order limits,
address, payment method
        │
        ▼  price tolerance checked against what was quoted
PAYMENT_PENDING → create ONE order, hold the stock
        │
        ▼  off-session Stripe PaymentIntent
      ┌─────────────┼─────────────┐
      ▼             ▼             ▼
  captured    requires_action   declined
      │             │             │
      │        ACTION_REQUIRED   FAILED
      │        (customer told,   (order cancelled,
      │         plan carries on)  stock released,
      ▼                           plan carries on)
  PROCESSING → push to ERP
      │
      ├── accepted → COMPLETED, inventory reconciled, customer told
      └── refused  → PAID_ERP_PENDING, retried under the SAME key
```

### The endpoints

**Customer** — under `/api/v1`, all requiring a signed-in customer, all scoped
to the caller's own profile. That scope *is* the where clause on every query, so
one customer naming another's plan gets a 404 rather than a 403.

| Method | Path | What it does |
|---|---|---|
| `POST` | `/recurring-schedules/preview` | The review screen. Prices the cart under a proposed schedule. Writes nothing |
| `POST` | `/recurring-schedules/from-cart` | Creates a DRAFT from the cart |
| `POST` | `/recurring-schedules/:id/activate` | Confirms it. Records consent, empties the cart |
| `GET` | `/recurring-schedules` | The customer's plans. Filter by `status` and `kind` |
| `GET` | `/recurring-schedules/:id` | One plan, with its items and recent deliveries |
| `POST` | `/recurring-schedules` | Creates a plan from a product list rather than a cart |
| `PATCH` | `/recurring-schedules/:id` | Date, frequency, quantities, address, card, tolerance |
| `GET` | `/recurring-schedules/:id/occurrences` | The deliveries. `?upcomingOnly=true` for the future ones |
| `POST` | `/recurring-schedules/:id/skip-next` | Skips the next delivery |
| `POST` | `/recurring-schedules/occurrences/:id/skip` | Skips one named delivery |
| `DELETE` | `/recurring-schedules/occurrences/:id` | Cancels one delivery |
| `POST` | `/recurring-schedules/:id/pause` | Pauses the plan |
| `POST` | `/recurring-schedules/:id/resume` | Resumes it, recomputing the next date from now |
| `DELETE` | `/recurring-schedules/:id` | Cancels future runs. Placed orders are untouched |
| `GET` | `/account/payment-methods` | Saved cards, display fields only |
| `POST` | `/account/payment-methods/setup-intent` | Begins enrolment |
| `POST` | `/account/payment-methods` | Finishes it. Re-reads Stripe; requires consent |
| `POST` | `/account/payment-methods/:id/default` | Sets the default |
| `DELETE` | `/account/payment-methods/:id` | Removes one. Refused while a live plan needs it |

The payment-method routes are refused entirely unless
`FEATURE_SUBSCRIPTION_AUTOPAY` is on. A stored card exists only to be charged
off-session, and collecting a payment credential nothing can ever use is exactly
what a deployment that turned the flag off decided not to do.

**Admin** — under `/api/v1/admin`:

| Method | Path | Permission |
|---|---|---|
| `GET` | `/schedules` | `schedule.read` |
| `GET` | `/schedules/:id` | `schedule.read` |
| `POST` | `/schedules/:id/pause` `/resume` | `schedule.write` |
| `DELETE` | `/schedules/:id` | `schedule.write` |
| `GET` | `/erp/order-pushes` | `integration.read` |
| `POST` | `/erp/order-pushes/:orderId/retry` | `integration.write` |

There is deliberately **no** "run this schedule now" endpoint. A manual trigger
is the obvious route to a duplicate charge, and the engine already retries on
its own.

### Nothing about a two-week-old plan is assumed still true

Every occurrence is repriced and revalidated from scratch. Prices move,
products get withdrawn, VAT rates change on the first of the month, stock runs
out, a card expires, a customer moves country and changes their tax treatment.

`quoteSchedule` in `recurring/schedule-quote.service.ts` is the one function
that answers "what does this basket cost". **The review screen and the worker
both call it**, so the number the customer agreed to and the number they are
charged come from the same code.

It prices through exactly the path a cart is priced through —
`loadPricesForCurrency` for the customer's own currency, `loadTaxContext`
against the *delivery address's* country, `applyLineTax` per line. That matters:
the previous engine priced from `products.basePriceMinor` and the deployment's
default currency, so a Belgian customer on a monthly plan was charged the
base-currency figure with the wrong VAT.

### The price tolerance

A total that has drifted from what the customer was last quoted is **not
charged silently**. Two tests, and the more generous wins:

- a percentage (`SCHEDULE_PRICE_TOLERANCE_PERCENT`, default 5%)
- an absolute floor (`SCHEDULE_PRICE_TOLERANCE_MINOR`, default 500 minor units)

A plan can override both. A price that has gone **down** is always within
tolerance — stopping a delivery to ask whether the customer minds paying less
would be absurd.

Beyond tolerance: nothing is charged, the occurrence is held, and the customer
gets an email whose first sentence is *"We have NOT charged you"*. Somebody
reading "the price has changed" assumes they already paid it.

### Substitution

Never, unless asked for. The default `substitutionPolicy` is `NEVER`: an
unfillable delivery is held and the customer is told. With
`SAVED_PREFERENCE`, the **one** product the customer named for that exact line
is used, and only if it is itself available. No second choice, no category
fallback — a substitution the customer did not name is one they did not
authorise.

### Out of stock is not the same as withdrawn

| Situation | What happens | Why |
|---|---|---|
| Out of stock | The delivery is held; the plan keeps running | Transient. Next month it probably can be supplied |
| Unpublished, archived, or opted out of recurring | The plan is **paused** | Permanent. Holding for ever means emailing the customer every week and nobody finding out |

Repeated holds still advance the plan's failure streak, so a product that stays
short for months stops the plan rather than nagging for ever.

### The customer can change things

Up to the **edit cutoff** — `SCHEDULE_EDIT_CUTOFF_MINUTES`, default 24 hours
before a delivery. Inside it the worker may already be pricing the order, and
an edit would race the charge: the customer would see one basket and be billed
for another. The refusal names the date they *can* change, because "too late"
without one is not an answer. Administrators are not bound by it — somebody is
usually on the phone.

They can change the date, the frequency, quantities, the address, the card;
skip the next delivery; pause and resume; or cancel. Cancelling stops future
runs only — orders already placed keep their own lifecycle.

### Reminders

Sent `SCHEDULE_REMINDER_LEAD_HOURS` before a charge (default 48), against the
materialised occurrence row — so the email names the exact delivery the
customer can then go and skip. It records `quotedTotalMinor`, which is what the
tolerance check later measures drift against: a reminder is a quote, and this is
the system remembering what it told them.

The lead time **must** exceed the edit cutoff. The process refuses to start
otherwise, because a reminder that arrives after the window shut invites the
customer to change something the API will then refuse.

### Duplicate protection

Six guards, none of which depend on the engine being careful:

| Guard | Stops |
|---|---|
| `unique(scheduleId, plannedRunAt)` | Two occurrences for one slot |
| `unique(schedule_occurrences.idempotencyKey)` | The same key on two occurrences |
| `unique(orders.scheduleOccurrenceId)` | One occurrence becoming two orders |
| `unique(payment_transactions.idempotencyKey)` | Two charges for one cycle |
| `unique(erp_order_pushes.orderId)` | One order reaching the ERP twice |
| A lease on the plan row | Two workers even trying at once |

The occurrence's key is `occ:<plan ULID>:<YYYYMMDDHHMMSSmmm>` — a *pure
function* of the plan and the slot, computed by `occurrenceIdempotencyKey`.
Every downstream key derives from it (`:payment`, `:order`, `:erp`, `:stock`),
so a retry recomputes the same values instead of minting new ones and they all
collapse together rather than half of them repeating.

Claiming uses a conditional `UPDATE` and an affected-rows check, not
`FOR UPDATE SKIP LOCKED` — MariaDB 10.4 does not have it.

## 9.5.1 Autopay: charging a card nobody is looking at

Off by default (`FEATURE_SUBSCRIPTION_AUTOPAY`). Turning it on means this
deployment takes money from people who are not present, which should be a
decision somebody made rather than a behaviour inherited by installing the
software.

### Enrolment

```
POST /account/payment-methods/setup-intent
        │  the server asks Stripe to begin, and answers with a
        │  client secret and the publishable key
        ▼
the browser confirms the SetupIntent directly with Stripe
        │  the card number goes from the customer to Stripe.
        │  It never touches this process.
        ▼
POST /account/payment-methods
        │  the server RE-READS the SetupIntent from Stripe and
        │  stores what Stripe says — not what the browser claims
        ▼
customer_payment_methods row + the off-session consent record
```

The SetupIntent is created with `usage: 'off_session'`. Getting that wrong is
what produces a card that enrols cleanly and then fails every later charge with
`authentication_required`.

### What is stored, and what is not

**Stored:** the Stripe customer id, the Stripe payment-method id, and the six
display fields Stripe returns so a person can tell which card they picked
(brand, last four, expiry month and year, funding, issuing country). Plus the
consent record: when they agreed, to which version of the terms, a **hash** of
the IP, and the user agent.

**Not stored:** any card number, any CVV, any client secret. A breach of that
table yields nothing chargeable without the deployment's own Stripe secret key.

The consent columns are not decoration. Charging off-session is only lawful
because the customer agreed to it for a stated purpose, and `consentVersion`
is what lets a change of terms demand a fresh agreement instead of quietly
inheriting the old one. Stripe's own rules require the same record.

### The charge

A backend-created PaymentIntent with `confirm: true`, `off_session: true` and
an explicit `payment_method` — never Stripe's default for the customer, which
could silently become a card they never authorised for this plan.

The application owns the scheduler. Stripe is the payment rail, not the
subscription engine — which is the whole point: the basket, the prices, the
warehouse stock and the customer's ERP rules are all rechecked by this system
on every cycle, and none of that is something Stripe Subscriptions could
decide.

### Authentication required is not a failure

A 402 whose code is `authentication_required` means the money has **not**
moved, the payment is still open, and only the customer can advance it.
Retrying it off-session gets the same answer every time and, on some issuers,
counts against the card.

So the occurrence holds at `ACTION_REQUIRED`, the customer is emailed a link to
confirm, the order stays payable, and **the next delivery is not held hostage to
it**. If the window (72 hours) closes unauthenticated, that one cycle is
skipped and the plan carries on.

### A failed charge never cancels a subscription

One dead card is not consent to stop delivering. The order is cancelled — which
releases the stock, since there is nobody present to retry against it — the
customer is told, and the plan stays `ACTIVE`. Payments are attempted
`SCHEDULE_MAX_PAYMENT_ATTEMPTS` times (default 3), counted **separately** from
validation attempts: banks read repeated declines as a signal about the card, so
three "out of stock" holds must not spend the card's budget.

## 9.5.2 The ERP hand-off

There is no named ERP in this repository, and that is deliberate: this software
is bought by companies who already have one, and it is never the same one
twice. So the connection is an `integration_connections` row an administrator
creates — base URL, auth type, encrypted credentials — named by
`ERP_ORDER_CONNECTION_NAME`. **With nothing configured the whole path is inert**
and orders are created, paid and fulfilled exactly as they were before.

### Order of operations

1. **Ask the ERP whether it can supply**, before charging. Charging for
   something the warehouse will refuse to ship is the worst available outcome.
   An ERP that cannot be *reached* holds the delivery rather than charging on an
   assumption — telling a customer their product is out of stock when the truth
   is that our ERP is down is a lie they will act on.
2. Charge the card.
3. Create the platform order.
4. Push it to the ERP with a stable idempotency key.
5. Save the ERP's reference.
6. Reconcile the inventory movement.
7. Tell the customer.
8. Generate the next occurrence.

### The request

A flat, boring JSON body — documented here so a deployment whose ERP wants a
different shape can put a small translating proxy in front of it rather than
needing this repository changed:

```json
{
  "external_order_id": "01JB...",
  "order_number": "UB-2026-000123",
  "placed_at": "2026-09-08T06:00:00.000Z",
  "source": "RECURRING",
  "currency": "INR",
  "totals": {
    "subtotal_minor": "200000",
    "discount_minor": "0",
    "tax_minor": "36000",
    "shipping_minor": "0",
    "grand_total_minor": "236000"
  },
  "customer": {
    "external_customer_id": "01JB...",
    "erp_customer_code": "CUST-0042",
    "name": "...", "company": "...", "email": "..."
  },
  "shipping_address": { },
  "billing_address": { },
  "shipping_method": "STD",
  "lines": [
    {
      "sku": "GLV-M", "name": "...", "variant": null, "quantity": 10,
      "unit_price_minor": "20000",
      "tax_amount_minor": "36000",
      "line_total_minor": "236000"
    }
  ],
  "schedule": { "schedule_id": "...", "occurrence_id": "...", "due_at": "..." }
}
```

Every money field is a **string**. A JSON number is a double, and a total that
has been through one is no longer evidence of anything.

`ERP_ORDER_REFERENCE_PATH` says where the ERP's own order id is found in its
response, as a dotted path. ERPs disagree about this more than about anything
else, which is why it is configuration.

### Paid, and the ERP will not take it

The worst state in the feature, and the one everything else here is shaped
around. The money is gone, the order is real, the warehouse cannot see it. Every
tempting response is wrong:

- Failing the occurrence tells the customer their order did not happen, which is
  false, and invites them to order again — now paying twice.
- Refunding immediately throws away an order the ERP would probably have taken
  thirty seconds later, and refunds are slow, visible and alarming.
- Retrying without a stable key risks two ERP orders, which means two deliveries
  and two stock movements for one payment.

So the occurrence holds at `PAID_ERP_PENDING` and `erp_order.retry` retries it
under the **same** idempotency key until the ERP takes it or a person is asked
to look (`ERP_ORDER_MAX_ATTEMPTS`, default 8, with a widening backoff). The
customer is emailed that their order is *confirmed* and dispatch may be late —
never that anything failed, because nothing about their order did.

A 409 from the ERP is treated as **success**: an ERP that honours the
idempotency header answers a replay that way, and it carries the reference of
the order it already made.

Abandoned pushes appear at `GET /admin/erp/order-pushes`, and
`POST /admin/erp/order-pushes/:orderId/retry` sends one again once somebody has
fixed whatever was wrong. The key is **not** regenerated on a manual retry — it
has to be the same request as the automatic ones, or the ERP could accept it as
a second order.

### Inventory

The reservation commit already moved the stock when the order was created. What
the ERP hand-off adds is a `SYNC_CORRECTION` row recording that the ERP agreed,
keyed on `inventory_movements.dedupeKey` so a retried reconciliation collides on
the unique index rather than posting a second delta. The ledger is append-only
and has no reversal, so a double post would silently corrupt on-hand for ever.

## 9.8 The ERP connection, and Autopay

### The distinction everything here rests on

Section 9.5.2 describes an ERP wired through **environment variables**: one
address, fixed paths, named by `ERP_ORDER_CONNECTION_NAME`, set when the process
starts and changed by a deployment.

This section is about the same job done from a screen. A Business Owner opens
**Settings → ERP** and configures a connection whose base URL, endpoints,
credentials, field mapping and webhook secret all live in the database. It is
tested there, switched on there, and changed there — no deployment, no restart.

Both exist and neither replaces the other. `pushOrderToErp` tries the configured
connection first and falls through to the environment one; an installation where
nobody has connected anything behaves exactly as it did before.

**Every order goes to the same ERP**, because there is only one: the business's.
Nothing here is per-customer, and there is no matching rule to get wrong.

**There is no customer-facing screen for any of this, on purpose.** A connection
is a URL plus a credential that this server then calls with the machinery of the
installation behind it. The set of people who may create one is the set already
trusted with the installation, and the guarantee is a route that does not exist
rather than a permission somebody could be granted by accident.

Autopay is the exception, and it has to be: **nobody can consent on somebody
else's behalf to money leaving their account.** That screen stays under Account
→ Autopay, where the account holder is.

### The consequences of "somebody types the address"

Everywhere else in this system the addresses we call are ours. Here a form field
becomes an authenticated outbound HTTP request, which is a server-side request
forgery primitive with a text input in front of it. An address an administrator
typed is more likely to be right than one a stranger typed; it is not thereby
right, and a copied URL, a compromised staff account or a hostname whose DNS
answer changes tomorrow are all still on the table.

`infra/outbound-http.ts` is the answer, and the rule is about **addresses**,
applied after resolution:

1. Only `http` and `https` exist. `file:`, `gopher:` and the rest are refused by
   scheme, not by pattern.
2. The hostname is resolved **by us**, before connecting.
3. **Every** address it resolves to must be globally routable unicast. Loopback,
   link-local (`169.254.169.254` — the cloud metadata endpoint on every major
   provider), all the RFC 1918 ranges, CGNAT, multicast, broadcast, and their
   IPv4-mapped IPv6 spellings (`::ffff:127.0.0.1`) are refused. A name answering
   with both a public address and `127.0.0.1` is refused outright: it is a rebind
   attempt in a round-robin costume.
4. The socket is **pinned** to an address that passed. This is why the module
   uses `node:http`/`node:https` and not `fetch`: `fetch` re-resolves the
   hostname when it opens the socket, and an attacker's DNS server is free to
   answer differently the second time. The `lookup` override closes that window.
5. **No redirect is followed automatically.** A `Location` is a fresh URL that
   has been through none of the above, so it goes back to the top of the loop
   and is re-validated, at most three times. A 301/302/303 also drops the body
   and becomes a GET — replaying a POST to a URL the first server chose is how a
   redirect turns into a way to make this server submit an order somewhere else.

`ALLOW_PRIVATE_ERP_TARGETS` lifts the address rules for local development
against a mock ERP. `env.ts` **refuses to start a production process** with it
true, because there is no deployment where it is the intended behaviour.

An endpoint path is checked separately: it must resolve onto the base URL's own
origin. An "endpoint" free to leave the authorised host would carry the
credential with it.

### The connection lifecycle

```
DRAFT ──test──▶ TESTING ──passed──▶ CONNECTED ──activate──▶ ACTIVE
  ▲                 │                                        │  ▲
  │                 └──failed──▶ ERROR ◀──repeated failures──┘  │
  │                                │                            │
  └──── edit (from anywhere) ──────┘         PAUSED ────resume───┘
                                               ▲
                                     ACTIVE ───┘ pause

  DISABLED ──reopen──▶ DRAFT
```

`domain/erp-connection-state.ts` is the only thing allowed to move a row between
these, exactly as `assertTransition` is for orders. Two edges carry the weight:

- **`CONNECTED → ACTIVE` is the only way traffic ever starts**, and it requires
  a test that passed *and* a mapping checked against a real response. It is not
  reachable from `DRAFT` or `ERROR`, both of which mean "no test has passed since
  this configuration was last touched".
- **Editing lands back in `DRAFT`.** Whatever the last test proved, it proved
  about settings that have just been replaced. Without this, somebody could
  change a base URL and have the next paid order posted to the new address
  untested.

**At most one connection may be `ACTIVE`.** MariaDB 10.4 has no partial index, so
this is enforced in the service rather than by the schema — the screen offers
several rows so a sandbox and a migration have somewhere to live, and exactly one
of them carries traffic.

`PAUSED` and `DISABLED` look similar and are not. Pause is "stop for now": every
setting intact, no re-test to resume, and **inbound webhooks refused while it
lasts** — accepting stock updates for a connection somebody deliberately stopped
is the opposite of what pausing means. Disable is "stop, and I am not coming
back soon"; the row survives so the integration ledger still reads, and coming
out of it goes through a test like any cold start.

`ERROR` is entered by the machinery, never by a person, after
`ERP_FAILURE_THRESHOLD` consecutive failures. Without it, an ERP that has been
off for a fortnight collects a failed poll against it every hour for a fortnight.

### Authentication

Four methods, one shape — all of them end as headers, and only `erp-client.ts`
ever decrypts a credential to build them:

| Method | What is sent |
|---|---|
| `API_KEY` | A key in a header the administrator names, e.g. `X-API-Key` |
| `BEARER_TOKEN` | `Authorization: Bearer <token>` |
| `BASIC` | `Authorization: Basic base64(user:pass)` |
| `OAUTH2` | Client-credentials grant, then `Authorization: Bearer <access token>` |

OAuth is client credentials rather than any interactive grant because there is
no human present: a stock poll runs at 03:00 and an order push runs inside a
webhook handler. The token is **cached on the row** (`oauthTokenEnc`, encrypted
like any other secret) rather than fetched per request — a round trip before
every stock read would double both the traffic and the failure surface. It is
cleared on any credential or method change.

**Nothing returns a credential.** `ConnectionView` has no field that could carry
one; the edit screen gets `credentialHint` — `X-API-Key: sk_liv...9f2a` — which
identifies a key without being one. And **a save that omits a secret keeps the
stored one**: the screen never receives a secret, so it never sends one back,
and if an empty box meant "clear it", editing the timeout would silently break
the connection. Sending an explicit empty string is how a credential is removed.

### Field mapping — why a second ERP costs nothing

One ERP's stock endpoint answers

```json
{ "d": { "results": [ { "Material": "X-1", "Werks": "1000", "LabSt": "42.000" } ] } }
```

and the next one's answers

```json
[ { "sku": "X-1", "warehouse": "MAIN", "qty_available": 42 } ]
```

Neither is wrong and neither will change for us. So the shape is **data**:
`fieldMappingJson` maps this platform's field names to dotted paths into the
ERP's JSON. No branch anywhere in this repository knows a vendor's name, and
changing ERP is a screen, not a release.

The fourteen mappable fields: **Product ID, SKU, Product name, Warehouse ID,
Unit of measure, Available quantity, Reserved quantity, Price, Currency,
Customer reference, Platform order ID, ERP order ID, Payment reference, Order
status** — plus `itemsPath`, which says where in the response the array of
records lives and is the single most common configuration mistake.

Three rules keep this from becoming a footgun:

1. **A mapping is validated twice.** `validateFieldMapping` checks it makes
   structural sense; `verifyAgainstSample` checks it against a document the ERP
   actually sent. A connection cannot be switched on without both, because a
   structurally perfect mapping is still a guess about somebody else's JSON.
   The sample is an inventory document, so only the product, inventory and
   pricing fields are checked against it — asking an order-creation field to
   appear in a stock response is a question with no right answer.
2. **Paths are read, never evaluated.** `readPath` walks own properties only and
   refuses `__proto__`, `constructor` and `prototype`. A mapping is typed input,
   and typed input that reaches `Object.prototype` is a prototype-pollution
   primitive with a form field in front of it.
3. **Types are coerced narrowly.** `"42.000"` is 42; `"forty-two"` is a failed
   record, not a zero. **"The ERP said nothing" and "the ERP said none left" are
   different facts**, and collapsing the first into the second empties a
   warehouse on the strength of a renamed field. Money uses string arithmetic
   throughout — `12.34 * 100` is `1233.9999999999998`.

### Test, and dry run

Two buttons answering two different questions, and **neither changes anything**:

- **Test connection** — *can we reach it?* Calls the read endpoints, reports
  connected/failed, HTTP status, response time, per-endpoint status, mapping
  validation and the timestamp. The order-creation endpoint is deliberately
  **not** called: a "test" that puts a real order in an ERP is not a test, it is
  an incident.
- **Dry run** — *do we understand what it says?* Reads the stock endpoint,
  applies the mapping, and shows the first few records as this system would read
  them. Writes no stock figure. Seeing `Price: EA` in a column is how somebody
  discovers in two seconds that their price field is reading the unit-of-measure
  column.

Everything reported is safe: a status code, a round trip, and a sentence from
`safeErrorMessage`. **Never a provider body** — an ERP's error output is written
by somebody else's software and routinely echoes back the `Authorization` header
it just rejected.

### Inventory: three doors, one path

A webhook, a scheduled poll, or somebody pressing **Sync now** all end in
`applyRecords`, so a figure arrives the same way whichever door it came through.

**What this writes, and what it must never write.** Every quantity lands in
`erp_inventory_snapshots`, which is a record of *what the ERP said*. It does
**not** touch `inventory_balances`, because a balance in this system is derived
from the append-only `inventory_movements` ledger, where every change carries a
reason and a person. A figure that arrived over HTTP through a field mapping
somebody typed has neither — and letting it overwrite the ledger would leave a
stock level nobody can explain and an audit trail with a hole in it. There is no
setting that changes this, because there is no code path to it.

**Authority** decides what happens when the two disagree, and all three answers
are right for somebody:

| Setting | What happens |
|---|---|
| `ERP` | The ERP is the system of record. Its figure is stored. |
| `PLATFORM` | This platform's figure stands. The ERP's is recorded beside it so the divergence is visible. |
| `MANUAL` | Neither is applied. The row is flagged and a person decides — the honest answer during a migration. |

A **manual override** survives the next sync, but only where the connection
allows one. Without that flag the next pass would overwrite it, and a control
that silently undoes itself is worse than no control.

**Webhooks** are HMAC-SHA256 over the exact bytes received, compared in constant
time, at an unguessable per-connection path. There is no unsigned mode — an
unauthenticated endpoint that rewrites stock is not a feature. A redelivery is
answered **200 with `duplicate: true`**, not an error: an ERP retrying a delivery
it already made has done nothing wrong, and a 4xx makes it retry harder.

**Rate limits are obeyed, not worked around.** A 429 stops the run, records the
`Retry-After`, marks the run `RATE_LIMITED` rather than `FAILED` — what was
processed is applied and the rest is taken next pass — and does **not** count
towards suspending the connection. Counting it would suspend exactly the ERPs
that are best behaved.

### Orders, and "Paid — ERP Pending"

When a normal or scheduled order is paid:

1. Find the active connection. None is an ordinary answer.
2. Validate the mapping and the SKUs.
3. Check availability.
4. Build the approved payload.
5. POST it to the configured endpoint with a **stable idempotency key** derived
   from the order.
6. Save the ERP's reference.
7. Reconcile the inventory movement.
8. Update the platform order's sync status.
9. Notify.

**The state this exists for is money taken and the ERP silent.** The order stays
`CONFIRMED` — it *is* confirmed; the customer's money is real — and an
`ErpOrderPush` row holds the retry state. Every attempt sends the **same**
idempotency key. Three guards make a duplicate structurally impossible rather
than merely unlikely:

1. `unique(erp_order_pushes.orderId)` — one push row per order, ever.
2. `unique(integration_events.idempotencyKey)` — one ledger row per logical
   operation, so a redelivered webhook collides instead of starting a second
   push.
3. The same key in the header on every attempt, so an ERP that honours it
   de-duplicates too — and one that answers a replay with **409 is read as
   success**, because retrying for hours against an ERP that took the order on
   the first attempt would eventually abandon an order the warehouse is picking.

**"Paid — ERP Pending" is a derived state, not an eleventh `OrderStatus`.** The
ten statuses are fixed by the SOP, and telling a customer their order failed
because of a hiccup in a back-office system would be a lie about their money.
`erpSyncStateFor` turns "order paid + push pending" into words. The customer is
told nothing while a retry is running; the **staff** notification is the one that
fires, because it is the business's own warehouse system and the business is who
can act on it.

A **permanent** refusal — a 400, a mapping the ERP rejects — is never retried
automatically. Sending identical bytes to a 400 gets an identical answer, and
hammering a server over a typo in a field name is not a strategy. It is shown
with a **Retry** button, and that retry reuses the original key: if the earlier
attempt did reach the ERP despite reporting failure, it has to collide rather
than create a second order.

### The integration ledger

`integration_events` is what the Activity panel reads, what a retry consults, and
what answers *why has this order not reached the warehouse*. Each row carries the
event type, the connection, the platform and ERP order ids, the **correlation
id** (shared by every log line, audit row and event from one incident, so it
reads back as one story), the idempotency key, the attempt count, the status, a
safe provider response, and its timestamps.

### Autopay

This is the one part of the feature that belongs to the **customer**, and it has
to: nobody can consent on somebody else's behalf to money leaving their account.
It lives under **Account → Autopay**.

**A saved card is not permission to use it.** `customer_payment_methods` says an
instrument exists; `customer_autopay_settings` says the account holder asked us
to use it, up to this much, under these rules. Two tables because they are two
facts, and conflating them is how somebody is billed for something they never
agreed to.

Turning it on requires a chargeable instrument **and** an explicit consent tick,
recorded with the wording version, the time, a hash of the address it came from
and the user agent. A `CHECK` constraint refuses a non-disabled row with no
consent on it: "we had permission" is a claim somebody will one day have to
prove.

Stripe does the rest: a **SetupIntent** saves a reusable instrument, an
off-session **PaymentIntent** charges it, and **only a signature-verified
webhook** confirms the result. No raw card or bank detail is ever stored here —
only Stripe's identifiers and the consent record.

Two limits, which are different instructions rather than degrees of one:

| Setting | Above it |
|---|---|
| `maxTransactionMinor` | **Refuse.** Nothing is charged and nobody is asked. |
| `approvalThresholdMinor` | **Ask.** Nothing is charged; the customer is consulted. |

Both are compared in the same currency **or not at all**. A cap of 5000 typed
against EUR is not a cap on a JPY total, and converting one silently is a
decision about somebody's money this system is not entitled to make — so a
mismatch refuses with its own code. `AUTOPAY_PLATFORM_MAX_MINOR` is the
operator's backstop on top, so a pricing bug cannot become a five-figure charge.

The customer also controls the retry preference, pause/resume, which card, and
which notifications they get. **Withdrawing consent is not gated on the feature
flag** — a right to withdraw that depends on a deployment setting is not a right.

### Saving a card

Enrolment happens in a dialog (`components/CardSetupDialog.tsx`), reachable
from **Account → Autopay** and from the cart panel. Three requests,
and the third is the one that matters:

1. `POST /account/payment-methods/setup-intent` — the server asks Stripe to
   begin and answers with a client secret and a publishable key.
2. The browser confirms the SetupIntent **directly with Stripe**. The card
   number goes from the customer to Stripe and nowhere else; this origin never
   sees it, which is what keeps the deployment out of PCI scope.
3. `POST /account/payment-methods` — the server **re-reads** the intent from
   Stripe and stores what Stripe says.

Step 3 not trusting step 2 is the whole design. The browser sends an intent id
and a consent flag; every display detail of the stored card comes from the
provider. A page claiming a card was enrolled when it was not gets a refusal,
not a row — the same rule that stops a client redirect confirming a payment.

The dialog carries its own consent tick, never pre-ticked, and it is a
different tick from the Autopay one: this one says the card may be *stored in
a form that can be charged later*, which is the thing a customer typing a card
into a checkout has not agreed to.

### Coordination, in order

1. Verify inventory and ERP readiness.
2. Check the payment authorisation (`evaluateAutoPay`).
3. Take the Stripe payment.
4. Create the ERP order **after** the payment succeeds.
5. Reconcile inventory.
6. Update the final status and notify.

If step 3 succeeds and step 4 fails, the transaction holds at **Paid — ERP
Pending** and retries under the same key. The customer is never charged twice,
and the ERP cannot end up with two copies.

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
| `schedule.run` | Turns due schedules into orders, and charges them |
| `schedule.reminder` | Warns a customer their scheduled order is coming, and records the amount quoted |
| `schedule.occurrence_retry` | Retries cycles that failed **before** any money moved |
| `schedule.action_expire` | Closes out cycles the customer never authenticated |
| `schedule.materialise` | Builds the upcoming rows customers skip and re-date |
| `erp_order.retry` | Retries a **paid** order the ERP has not accepted. The exit from `PAID_ERP_PENDING` |
| `erp.inventory_poll` | Asks the ERP for stock, where it has no webhooks. See 9.8 |
| `erp.push_retry` | Retries a **paid** order the ERP has not accepted, under the original key |
| `integration_event.retry` | Retries other integration operations whose failure looked transient |
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

That covers the ERP credentials under Settings → ERP too (9.8), with two
additions: no read path anywhere returns one — the screen gets
`X-API-Key: sk_liv...9f2a`, which identifies a key without being one — and a
save that omits a secret keeps the stored one, so editing a timeout cannot
silently wipe a working credential.

## Calling an address somebody typed

The one place in this system where a form field becomes an authenticated
outbound HTTP request. `infra/outbound-http.ts` resolves the hostname itself,
refuses **every** address it resolves to that is not globally routable unicast
(loopback, link-local — where cloud metadata lives — every private range, CGNAT,
and their IPv4-mapped IPv6 spellings), **pins the socket** to one that passed so
DNS cannot answer differently a moment later, and follows no redirect without
putting the new URL through all of it again.

It is built on `node:http` rather than `fetch` specifically because `fetch`
re-resolves the hostname when it opens the socket, which reopens the rebind
window the check just closed. `ALLOW_PRIVATE_ERP_TARGETS` lifts the address
rules for local development, and configuration validation **refuses to start a
production process** with it on.

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
| `FEATURE_RECURRING_ORDERS` | `true` | Subscribe & Reorder |
| `FEATURE_SCHEDULED_ORDERS` | `true` | Buy Later — one delivery, on a chosen date |
| `FEATURE_SCHEDULE_ANY_PRODUCT` | `true` | Every published product may be put on a repeat purchase. Off means only products an administrator ticked, which is how a store curates its repeatable range |
| `FEATURE_SUBSCRIPTION_AUTOPAY` | `false` | Charging a saved card off-session. Needs Stripe |
| `FEATURE_ERP_INTEGRATION` | `false` | **Settings → ERP.** An ERP configured from a screen rather than from environment variables. Off means the screen says so, the routes refuse, no polling job runs and the webhook endpoint 404s |
| `FEATURE_CUSTOMER_AUTOPAY` | `false` | A customer's standing authority to be charged, with their own limits. Needs Stripe **and** `FEATURE_SUBSCRIPTION_AUTOPAY`, which is what lets them save a card at all |
| `ALLOW_PRIVATE_ERP_TARGETS` | `false` | Lets a customer-supplied ERP address resolve to a private or loopback network. **Development only — `env.ts` refuses to start a production process with it on**, because it makes the cloud metadata endpoint reachable from a form field |
| `FEATURE_ADMIN_LOGIN_LOCATION` | `true` | Ask staff's browser for its location at sign-in |
| `ASSISTANT_ENABLED` | — | The AI chat widget |

## The warehouse map

| Variable | Default | Effect |
|---|---|---|
| `MAP_TILE_URL` | *(empty)* | The XYZ raster tile template behind the Warehouses map. Empty means no tiles: markers are plotted on a plain ground and everything else on the screen works unchanged |
| `MAP_TILE_ATTRIBUTION` | *(empty)* | Shown in the corner of the map. Every tile licence requires it |
| `GEOCODE_FORWARD_URL` | Nominatim | Turns a typed address into coordinates for the "look up" button. `{query}` is substituted. Empty switches it off |

Empty is the default for the tile URL **and it is the private one**. A tile
request discloses which part of the world is being looked at, and in this
product that is where the buyer's warehouses are — so nothing is requested
until the operator sets this. OpenStreetMap's own tiles are
`https://tile.openstreetmap.org/{z}/{x}/{y}.png`; read their tile usage policy
before pointing at them, because attribution is required and an installation
with many staff is expected to run its own tile server or pay a provider.

`GEOCODE_FORWARD_URL` is the mirror of `GEOCODE_REVERSE_URL` (used by the
sign-in location check) and shares its `GEOCODE_TIMEOUT_MS`. Both are
best-effort: unreachable, slow or unconfigured, and the panel reports that it
found nothing and lets somebody type the coordinates. Neither can block a save.

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
│   │   └── migrations/             21 numbered, committed SQL steps
│   ├── src/
│   │   ├── config/env.ts           ← Every setting, validated at boot
│   │   ├── domain/                 Pure rules, no I/O
│   │   │   ├── money.ts            BigInt arithmetic, rounding
│   │   │   ├── errors.ts           ← The 108 error codes
│   │   │   ├── permissions.ts      ← Roles and ~50 permissions
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
| Add or move a warehouse | `/warehouses` in the panel; `modules/inventory/location.service.ts` |
| Put a background behind the warehouse map | `MAP_TILE_URL` in `backend/.env` |
| Change what happens in the background | `src/worker/handlers.ts` |
| Change what a scheduled order costs | `modules/recurring/schedule-quote.service.ts` — the review screen and the worker both use it |
| Add a plan or occurrence status rule | `domain/schedule-state.ts` |
| Change when a customer can still edit a delivery | `SCHEDULE_EDIT_CUTOFF_MINUTES` |
| Change how far a price may drift before asking | `SCHEDULE_PRICE_TOLERANCE_*` |
| Change what is sent to the ERP | `modules/integrations/erp-order.service.ts` (`buildPayload`) |
| Point at a different ERP | `ERP_ORDER_CONNECTION_NAME` plus a connection in the panel |
| Find a paid order the ERP refused | `GET /admin/erp/order-pushes` |
| Connect an ERP from a screen | `FEATURE_ERP_INTEGRATION`; `modules/integrations/erp-connection.service.ts`; Settings → ERP |
| Add a field a customer's ERP can map | `MAPPING_FIELDS` in `modules/integrations/erp-field-mapping.ts` — the screen is generated from it, so no frontend change |
| Change what a customer's ERP is sent | `modules/integrations/customer-erp-order.service.ts` (`buildOrderPayload`) |
| Change which addresses may be called | `infra/outbound-http.ts` |
| Add a connection status rule | `domain/erp-connection-state.ts` |
| Change how stock conflicts are resolved | `inventoryAuthority` on the connection; `applyRecords` in `erp-inventory-sync.service.ts` |
| Change what a customer may authorise us to charge | `modules/payments/autopay.service.ts` (`evaluateAutoPay`) |
| Cap every automatic charge, store-wide | `AUTOPAY_PLATFORM_MAX_MINOR` |
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
