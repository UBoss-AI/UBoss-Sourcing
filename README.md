<div align="center">

# UBOSS Sourcing

**A self-hosted B2B sourcing and ordering platform.**

A customer storefront, a marketplace other businesses sell through, a staff
console and a carrier portal — all on one Fastify + MariaDB backend.

<p>
<img alt="Node 24 LTS" src="https://img.shields.io/badge/Node-24%20LTS-5FA04E?style=flat-square&logo=node.js&logoColor=white">
<img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white">
<img alt="Fastify 5" src="https://img.shields.io/badge/Fastify-5-000000?style=flat-square&logo=fastify&logoColor=white">
<img alt="Prisma 7" src="https://img.shields.io/badge/Prisma-7-2D3748?style=flat-square&logo=prisma&logoColor=white">
<img alt="MariaDB 11.4 LTS" src="https://img.shields.io/badge/MariaDB-11.4%20LTS-003545?style=flat-square&logo=mariadb&logoColor=white">
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
| [Role dashboards](#role-dashboards) | The ring, the figures and the AI panel each role opens on |
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

Started with `-Tunnel`, all three frontends are published through **one**
hostname — a free tunnel only gives out one — and told apart by the path: the
storefront at `/`, the console at `/admin/`, the carrier portal at
`/logistics/`. The script prints the addresses. That path arrangement is for
development only; in a real installation each of the three has a hostname of
its own.

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
npm run seed:demo-catalog # a demonstration catalogue: every department, every shelf
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

**Before anything that touches the database reaches a server**, rehearse it
against the version production actually runs. XAMPP is 10.4 and is not strict;
production is 11.4 and is, and the difference is whether an over-long value is
truncated or rejected:

```powershell
.\scripts\db\audit-xampp.ps1        # what is installed here, as a JSON report
.\scripts\db\compat-test.ps1        # MariaDB 11.4.13 in Docker: migrations from
                                    # empty, grants, drift check, the test suite
.\scripts\db\validate-data.ps1      # ~100 integrity checks, before and after
```

Needs Docker Desktop, and it binds only to `127.0.0.1:3307` — never 3306, so it
cannot be mistaken for XAMPP. `docs/DATABASE-MIGRATION.md` explains what each
step proves.

Never run `prisma migrate dev` against this schema — it offers to drop the
database and rewrites constraint names the migrations depend on. `migrate
status` and `migrate deploy` are the two you want.

</details>

---

## Development sign-ins

Created by `npm run db:seed` in `backend`. **These are development seeds** —
delete them before the system goes live; `backend/docs/RUNBOOK.md` has the
procedure.

**The passwords below are in this repository, so they stop being passwords the
moment this installation is reachable by anybody else** — a tunnel shown to a
colleague, a static host pointed at this API, a staging box with a public
hostname. One command replaces all nine with fresh random ones, revokes every
existing session and prints the new passwords once:

```powershell
cd backend ; npm run db:rotate-seed-passwords
```

It is safe to run repeatedly, and re-seeding afterwards will not put the
published passwords back — `db:seed` writes a password only when it *creates* a
row. It is a stopgap, not a substitute for
[going live](#going-live) step 11, which is to delete these accounts and create
real ones from **Staff**.

After rotating, the tables below are wrong for that database and still right
for a fresh clone. That is the intended state; do not edit them to match.

### Making the tables true again

On a development machine that is not reachable by anybody else, the rotation is
usually just in the way: the tables below say one thing, the database says
another, and `db:seed` cannot reconcile them because it only writes a password
when it creates the row. One command does:

```powershell
cd backend ; npm run db:restore-seed-passwords
```

It writes the published password back for all nine, and clears the other things
that reject a correct password — a lockout, a failed-attempt count, an
unverified address, a deactivated account. It revokes their sessions, reports
which ones had drifted, and **refuses to run when `NODE_ENV` is production**,
where writing a password out of a public repository is the whole problem rather
than the fix.

### These credentials belong to the database, not to a URL

The three tables below are the sign-ins for **every** way this system is
reached. The front ends are files; only the API holds accounts, and every
surface points at one API and one database:

| Where the browser is | What it reaches |
|---|---|
| `localhost:5173` / `5174` / `5175` | the API on `localhost:4000` |
| A tunnel — cloudflared or ngrok | the same API, through the tunnel |
| Netlify | the same API, through that site's proxy rule |

So there is nothing per-environment to keep in step. If a credential works on
`localhost` and not on a deployed URL, the account is not the problem — the
site is pointed at a different API, or `COOKIE_SECURE` is wrong for HTTPS. Both
are in [docs/NETLIFY.md](docs/NETLIFY.md).

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

On a window 1024px or wider, every signed-out screen in all three apps puts the
form on the right and a slowly turning earth on the left, with a pin on each of
fifteen sourcing ports. The picture is decoration: it is hidden from assistive
technology, it holds no control, and it is absent on a narrow window, on a
machine without WebGL, and for anybody who has asked for reduced motion — in
each of which the screen is a drawn globe instead and is finished either way.
Nothing behind it is fetched until the form is already usable.

---

## What each surface does

<details>
<summary><b>Customer storefront</b> — browse, quote, order, reorder</summary>

Search and category browsing, a product page carrying real per-market prices,
a cart that survives sign-in, and checkout with a warehouse chosen for the
delivery address. After the order: tracking, invoices, returns, and the
customer's own purchase history.

Browsing runs off a **department strip** on `/products` and on every category
page — every top-level department in one scrolling row, each with a drawn
two-tone mark, the one you are in underlined. Opening a department shows what is
inside it as a **deck of photographic cards**, one square to the reader with its
product count and a way in, the rest tipped back behind. Both dress themselves
from the catalogue's own names: a department or shelf this software recognises
gets a picture, and one it does not gets a drawn plate rather than a guess, so a
fresh install looks finished with no images uploaded.

A product that comes in more than one form is bought in one of **two** ways,
and the product decides which. A catalogue item whose seller has declared the
dimensions it varies by gets a **narrowing selector** — colour, then size,
with combinations nobody stocks switched off as you go, "out of stock" drawn
differently from "not offered", and the choice kept in the URL so a link
opens on the thing the sender was looking at. Everything else keeps the
**option list**, where several sizes are chosen at once and each carries its
own quantity — which is how a hospital buys three sizes of syringe in one go.

Availability is published as a **boolean per SKU**, never as a quantity:
this storefront does not put warehouse figures on a shop front, but "is
there one" and "how many are there" are different questions, and only the
second is confidential. Without the first, a size that is temporarily
empty would look identical to a size that is not sold at all. The option
list gets the same answer, so the whole catalogue that was already on sale
benefits: a sold-out option is struck through, labelled, and cannot be
ticked.

Packaged goods state what is actually in the box before the button is
pressed: "500 g · Pack of 10", "each pack contains 5000 g", and, at a
quantity of 2, "2 packs is 20 units, 10000 g in total". Pack count is part of
the product; how many packs somebody wants is not.

Two ordering patterns beyond the one-off cart:

- **Recurring orders** — a schedule that places a real order on a cadence.
- **Buy Later / Subscribe & Reorder** — a cart priced by `quoteSchedule` and
  nothing else, so the figure the customer confirmed on the review screen and
  the figure charged weeks later come from one place.

A **dashboard** at `/account` opens the section, and it is a picture: one ring
of the buyer's own orders grouped the way a buyer thinks about them, with the AI
panel beside it and nothing underneath. Choosing a slice singles that group out
and narrows what the panel is asked about, and the period and the selection are
both in the URL, so a view is a link somebody can send.

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

**A listing that comes in sizes is described once.** The listing wizard's
fourth step, *Set up versions*, asks whether the product has more than one
version and — if it does — offers the candidate dimensions for that shelf from
the same 112 templates the admin Variant builder uses. Nothing is ticked on the
seller's behalf: a footwear template offers sizes 5 to 12 and the seller
switches on the two they stock, so a size nobody confirmed is genuinely *not
offered* rather than silently out of stock. The projected combination count is
shown before the table is built; regenerating after adding a colour keeps every
code, price and stock figure already typed. On approval each approved
combination becomes a `ProductVariant`, a `SellerOffer` of its own and its own
per-warehouse stock, in one transaction. A listing with no versions takes the
same path with one entry and comes out as the single offer it always did.

**A listing published without versions can gain them.** Opening one from the
listings table shows the versions it sells in — a listing that has none says
so — and offers that category's candidate options with nothing ticked. New
versions are added *beside* the original, which keeps its id, its code and its
order history; they are created off sale, and pressing Save twice adds nothing
the second time. Because it changes what a buyer is choosing between, the
listing has to be paused first, and the page offers the pause.

**Edit changes anything the seller owns, on a listing that is already live.**
*Edit* opens the listing filled in — its photographs, its price and order
rules, and every version it sells with that version's own code, price, stock,
minimum order, lead time and picture. Routine changes (price, stock, order
rules) go through while the listing is on sale, because stock changes many
times a day and a catalogue that has to be taken off sale to correct a count is
a catalogue whose counts are wrong. Structural changes — adding or removing an
option, adding or withdrawing a combination — are refused while it is live, and
*Edit* offers **Pause & Edit** instead, saying in the seller's own terms what
that does and what it does not: orders already placed are not affected. Who
paused it and when are recorded, so a colleague finding it paused is told it
was an edit rather than a compliance hold. Combinations are matched by option
signature, so adding size 10 to a run of 7–9 keeps the three ids, the three
piles of stock and the three sets of order history and creates one row.
Withdrawing a combination somebody has bought archives it instead of deleting
it. Photographs save as they are uploaded rather than with the form, and only
the seller who described the product may change them — several sellers can
share one catalogue entry.

**Pausing is how a live listing is edited.** Pause takes it out of search and
out of baskets, keeps every order already placed moving through fulfilment
untouched, and leaves everything editable; an optional reason is kept for the
seller's own team and never shown to a buyer. The editor finishes with either
**Save as paused** or **Save & resume sale**. Resume re-checks the listing
rather than trusting the state it was paused in — name, code, price,
recommended price, stock, a photograph, a tax class, and that something is
actually switched on — and each refusal names the one thing to fix. Archiving
is separate and never hard-deletes something an order references.

**A seller's listing appears in the shop the moment they put it on sale**, in
its category, in search and in the facet counts, at their own price. The
storefront grid is rooted at the price row for the shopper's currency, so a
marketplace product's rows are kept as a projection of its live offers —
written in the same transaction as the offer change, so the grid can never quote
a figure the cart will not charge. A listing sold in sizes publishes **one row
per version plus a "from" row**: the selector prices each size from its own
row, and the grid reads the cheapest thing a shopper could actually buy, so a
product whose every offer is against a version is not priced correctly on its
own page and invisible everywhere else. Availability comes from the sellers'
own stock per version, not from the operator's warehouse ledger, so one size
can be sold out while the next is not. Pausing the last offer takes it back off
the shelf. Adding one to a cart binds that seller's offer server-side, so
every existing route into a cart works without knowing marketplaces exist.

An installation that approved listings before this existed has products that are
published, offered and invisible; `cd backend; npm run marketplace:sync` builds
their rows once and is safe to re-run.

### The demonstration catalogue

A freshly installed deployment has an empty shop front, and an empty shop front
cannot be reviewed, demonstrated or tested end to end. `npm run
seed:demo-catalog` plants a broad one — **every department and every
sub-category the deployment has**, at least three product families each, each
with its own options, SKUs, prices and stock.

```powershell
cd backend
npm run seed:demo-catalog                            # plant or re-plant
npm run seed:demo-catalog -- --validate              # check the blueprints, write nothing
npm run seed:demo-catalog -- --dry-run               # work it all out, write nothing
npm run seed:demo-catalog -- --category=computers-it # one department
npm run seed:demo-catalog -- --subcategory=footwear  # one shelf
npm run seed:demo-catalog -- --per-subcategory=3     # fewer per shelf
npm run seed:demo-catalog -- --images-only           # re-resolve photographs only
```

**It cannot touch a product a person created.** Every write is addressed through
`demo_catalog_entries`; a product with no row there cannot be named by the seed,
let alone overwritten. Removing the demonstration catalogue is deleting those
rows and the products they name — there is no SKU prefix being trusted and no
"everything created that afternoon". There is deliberately no delete flag on the
seed.

**Re-running it converges, and converges on the same figures.** Every price,
stock level and SKU is derived from the blueprint's own key rather than drawn at
random, so a second run changes nothing and a run after editing one blueprint
changes one product. A seed whose diff is four hundred changed prices is a seed
nobody reviews.

**Nothing in it claims anything it cannot support.** No certification, no
approval, no clinical outcome, no "best seller" — a unit test refuses the
registry if any appears. The brands are invented and consistent. No GTIN, no
ISBN and no hazard class is written, because those are issued by somebody and a
fabricated one belongs to them.

**`ENABLE_DEMO_CATALOG=false` takes all of it off the storefront** — out of the
grid, out of search, out of the facet counts and out of its own URL — in one
place, `publicProductWhere()`. It deletes nothing and unpublishes nothing, so
switching it back on needs no second seed. It defaults to on outside production
and off in production, and the seed refuses to run in production unless it is
explicitly set to true.

**Photographs.** With `UNSPLASH_ACCESS_KEY` set, the seed resolves one per
product through the official Search API, stores the photographer, the profile,
the photo page and the download-location ping the terms require, and hotlinks
the URL the API returned. Without a key it falls back to the image library the
storefront already ships with — which is keyed on a SHELF, not a product — and
reports every one of those as needing review, because "a photograph of this
trade" is the strongest true thing that can be said about them. No photo ID is
ever invented and the deprecated `source.unsplash.com` endpoint is never used.

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

A product that comes in more than one form is built with a **Variant
builder**: the dimensions that shelf is normally stocked along, offered as
chips to switch on; values entered or picked from the template; and then the
whole table shown — every combination, its generated SKU, and whether it
already exists — before anything is written. Generating never removes and
never overwrites, so a combination that already exists keeps its price, its
stock and its hand-edited SKU, and re-running after adding one size creates
one row. A category with no template keeps the free-form option editor.

**Companies** is the way into all three audiences at once. A business can buy,
sell and carry here at the same time, and those are three accounts in three
tables under three slightly different names; that screen groups them by the
company they belong to and nests what it finds — company, then its accounts,
then the people inside them, each person badged with every account they belong
to. It is read-only: every decision still happens on the screen that owns it.
Sellers and buyers need `customer.read`, carriers `logistics.read`, and
somebody holding one of the two sees only that half.

**Warehouses has three views.** *Our warehouses* is the screen as it has always
been — the buildings this deployment runs, on a map with a search, filters and
a stock roll-up. *One seller company* and *Every seller* show where approved
sellers dispatch from, each row naming the company that owns it, on the same
map and in the same table. A seller can be chosen only when its onboarding is
approved and its account is live — not whether its brands or listings were
approved — and that rule is enforced on the warehouse endpoint itself, so a
suspended seller's id typed into the address bar answers the same way as an id
that does not exist. Both seller views need `inventory.read` **and**
`customer.read`; without the second the control is absent rather than refused.
A location with no usable coordinates stays in the table and is counted under
the map, so one bad row never takes the map down with it.

**An address is typed once and it lands on the map.** The address field on a
warehouse offers the real places matching what is being typed, and choosing one
fills the street, the town, the region, the postal code and the coordinates
together — then draws the pin, on the same map the screen uses, so the position
is checked before it is saved rather than discovered later as a marker in the
sea. A field the geocoder did not name is left exactly as it was typed, never
cleared. The same field is on the seller's dispatch addresses and on a
customer's delivery address. All of it is a convenience over fields that still
take typing: with no geocoder configured the list never opens and nothing else
changes. See `GEOCODE_FORWARD_URL`.

The dashboard is one ring of everything waiting across the queues that member
of staff can act on, the AI panel beside it, and nothing else. The month's
figures it used to carry live on the screens that own them — Reports, Orders,
Payments, Inventory, Recurring — all still in the navigation.

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

**The bell tells news apart from problems.** An order placed or a colleague
signing in is news: it clears when the person reading it has read it, and only
for them. A cold-chain excursion, a failed delivery, a data request inside its
statutory clock or a certificate nobody has decided is an *alert*: it stays on
the badge until the underlying problem reaches a terminal state, for everybody,
however many people have glanced at it. An alert closes because the thing it
describes was dealt with — in the same database transaction that dealt with it
— and the bell offers no button that could close one any other way. The single
exception is a consignment nobody has picked up, which an operator holding
`logistics.assign` may close by hand with a reason, because a collection
arranged over the telephone leaves no row anywhere that would say so. Closed
alerts are kept, never deleted: a **Resolved** tab shows each one with who
closed it, when and why. A problem that comes back opens a new occurrence
rather than reopening the old record. The Logistics Partner Portal's own bell
follows the same rule. See PROJECT-GUIDE.md, *The bell*.

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
driver's own round with proof-of-delivery capture. The dashboard is one ring
folding the twenty-seven consignment statuses into eight stages, with the AI
panel beside it, so a dispatcher can see whether the day is still to collect or
already out.

There is no public registration. A carrier is created from **Logistics →
Carriers** in the console, which sends a one-time activation link; the person
who opens it chooses their own password. The carrier starts
`PENDING_ACTIVATION` and its people cannot use the portal until the console
marks it active — accepting an invitation proves somebody read an email, not
that the checks are finished.

**Drivers and who is carrying what.** A driver is **a name on the fleet**, with
a record of what they are cleared to carry. No account, no invitation, no email
round trip: the owner types the name. A carrier employs people who will never
open this software — an agency driver covering a round, a subcontractor’s van —
and a register that could only hold people with a login is a register that does
not describe the fleet. Linking a colleague’s account is optional and additive,
and buys exactly one thing: the phone app, with its task list, scanner and
proof-of-delivery capture. Vans are added the same way, with the temperature
range a refrigerated one holds, and naming a vehicle on an assignment is
optional. Nobody with delivery history is deleted — they are stood down, and
standing somebody down while they still hold consignments asks first and says
how many.

**The marketplace can work a carrier’s fleet too.** Adding a driver or a van,
putting one on a consignment, moving it to somebody else, taking them off and
sending it on the way are all available to the operations desk as well as to
the carrier — because somebody has to when the carrier cannot, and a desk that
could only watch means a parcel that moves while its tracking page does not. It
is **one register, not a copy**: a driver added by the desk appears in the
carrier’s own portal. The fleet used on a consignment is derived from the
carrier the consignment is already with and can never be named in the request,
so one carrier’s driver cannot end up on another’s parcel, and everything the
desk writes lands in the carrier’s own audit trail named as the marketplace.
The permissions split along the line the roles already drew: `logistics.write`
is the fleet register, `logistics.assign` is putting somebody on a parcel and
moving it, and an Order Manager holds the second without the first.

A driver is put on a **consignment**, never on an order: an order splits into
one consignment per seller and warehouse, which can go to different carriers on
different days. Exactly one driver is live per consignment, and that is a
unique index rather than a rule in code — two dispatchers pressing Assign in
the same second produce one assignment and one honest refusal. Moving a
consignment between drivers needs a written reason, keeps the previous
assignment and links the two, so the chain of who carried what survives; a
consignment that is delivered, returned, lost or cancelled comes off its
driver's task list in the same transaction. Assignment is refused for another
carrier's driver, a driver who is not active, a consignment that is already
finished, and a driver not cleared for the load — cold chain, sterile handling,
dangerous goods or an expired licence.

**Creating a carrier does not sign anybody in as it**, and there is no
impersonation door. The company the portal shows is derived on the server from
the authenticated membership and nothing else: no query parameter, no stored
value and no default company can change it. A browser that already holds a
session for another carrier is told whose it is by name and offered *continue*
or *sign out and use another account*, rather than being taken silently into
that carrier's dashboard.

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
check. Production runs 11.4, which does have `SKIP LOCKED` — the lease stays
because it works on both, and because it is the pattern that survives the
database moving to a machine where a held row lock is a network round trip. A
worker that does not recognise a job type returns it to the queue for another to
take, rather than marking it dead and silently losing the work.

</details>

---

## Role dashboards

Each of the three signed-in roles opens on a dashboard built from the same two
parts: one dominant ring, and an AI panel beside it. **That is the whole
screen** — no tiles, no lists, nothing under the chart. The shape carries the
information, the paragraph beside it says what the shape means, and every figure
either of them mentions has a screen of its own in the navigation.

| Role | Where | The ring |
|---|---|---|
| Buyer | `/account` on the storefront | **My orders** — the ten order statuses folded into five groups a buyer thinks in |
| Administrator | `/dashboard` in the admin panel | **Platform operations** — what is waiting, in five groups, across the queues that member of staff can act on |
| Logistics partner | `/dashboard` in the carrier portal | **Assigned shipments** — the twenty-seven consignment statuses folded into eight stages |

**Every figure is a database aggregate, scoped on the server.** A buyer sees
their own orders, a carrier its own consignments, and a member of staff only
the queues they hold the acting grant for — a queue they cannot act on is
absent from the reply rather than returned as zero. No dashboard counts a list
it was sent.

**The chart is never the only way to read the data.** The ring is one labelled
image; the legend beside it is the control, with each entry a real button
carrying the label, the count and the share as text, plus a shape as well as a
colour. "View as a table" opens the same figures as a table. Nothing rests on
telling red from green, and nothing is reachable only by pointing at it.

**The period and the selected slice live in the URL** — `?range=30d&segment=…`
— so a view is shareable and Back behaves. Today, last 7 days, last 30 days, or
a custom pair. Choosing a slice also narrows what the AI panel is asked about,
so the paragraph is about the group the reader singled out.

**The AI panel is deliberately small**: the summary, one line saying when it was
written and by which model, and a field to ask a question. It is a reading aid
for the chart, not a second screen beside it.

The dashboards follow the theme toggle like every other screen: deep navy in
dark, a cool near-white in light, both audited by `npm run audit:contrast`.

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
| `apps/*/.env.netlify.local` → `VITE_DEMO_LOGINS` | Demo sign-ins printed on that app's login page, as JSON. Unset in every ordinary build, and gitignored so a repository build never carries one. Demonstration deployments only — see [docs/NETLIFY.md](docs/NETLIFY.md) |

The CORS allowlist is exact — a mismatch blocks every request from the browser
— and all three frontends use `strictPort`, so a clash fails loudly rather than
moving silently to a port CORS will reject.

The storefront reads its branding, timezone, policy links, capability flags and
the markets it sells in from `GET /api/v1/config` at runtime, so none of it is
hard-coded in the client. It offers only currencies the catalogue is actually
priced in — a currency staff activated but never priced anything in would
otherwise give the shopper an empty shop with no explanation.

### The AI, and checking it is actually on

One key switches on every AI surface: the storefront assistant, AI Mode, image
search and the insights panel on all three dashboards. They share one provider
seam, so they are on or off together.

**Nothing is told what you sell.** The assistant's system prompt names no
trade. Everything it knows about the catalogue is read from your database on
the way into each answer — an index of every category with something on sale in
it, then every published product with its page, its price, its unit, and the
seller behind it where a marketplace listing is what is being quoted. Image
search reads the same catalogue. So a deployment that sells fasteners and a
deployment that sells surgical gloves get an assistant that describes what it
actually has, with no prompt to edit and nothing to configure.

**And it is never a minute behind.** That snapshot is cached against a stamp
taken from the catalogue itself, not against a clock: publish a product, approve
a seller's listing, change a price, and the next question already knows. There
is nothing to restart and no cache to clear.

| Variable | What it does |
|---|---|
| `ASSISTANT_ENABLED` | The master switch. Default `true` |
| `ASSISTANT_PROVIDER` | `gemini`, `anthropic`, or blank to use whichever key is set |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | Key from [Google AI Studio](https://aistudio.google.com/apikey). Model defaults to `gemini-2.5-flash` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Key from the Anthropic Console. Model defaults to `claude-opus-5` |

**Set no key and nothing breaks**, which is the point and also the problem. The
insights panel builds its summary from your own figures and says on screen that
it did; the assistant widget does not mount at all. A deployment whose key has
quietly stopped working looks exactly the same as one that never had a key —
there is no error, just a duller dashboard nobody notices for a month.

So there is a command that goes and looks:

```powershell
cd scripts ; npm run check:ai
```

It reads `backend/.env`, makes one real call to the provider configured there,
and says which of the three things is wrong: no key, a key that is refused, or a
model that is gone or out of quota. It never prints the key. It exits `0` when
the provider answered, `1` when it is configured but broken, and `2` when no
provider is configured — so a scheduled job can read it without parsing prose.

**The trap it exists for.** Google meters its free tier **per model**. A model
that worked yesterday answers `429` today while every other model on the same
key is fine, so the fix is usually one line of `backend/.env` and a restart of
the API rather than anything to do with the key. Enable billing on the Google
Cloud project before opening any of this to real traffic.

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
| `FEATURE_ADMIN_LOGIN_LOCATION` | The requirement itself. Default `false`; enable only after a documented privacy and employment-law assessment |
| `GEOCODE_REVERSE_URL` | Turns coordinates into a place name. `{lat}` and `{lon}` are substituted. Empty switches the lookup off and the bell shows coordinates |
| `GEOCODE_FORWARD_URL` | The other direction: turns a typed address into places to choose from, which is what fills the coordinates on a warehouse, a seller's dispatch address and a customer's delivery address. `{query}` is substituted, and `{limit}` too where it is used. Empty switches the suggestions off and every field still takes typing |
| `GEOCODE_TIMEOUT_MS` | How long to wait for either of them. Default `5000` |

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

`GEOCODE_FORWARD_URL` is the same host by default and the same choice: it is
what the address fields across the product suggest from, so a deployment that
will not send a half-typed address to a third party empties it and every one of
those fields carries on as plain text. The requests it makes are POSTed from
the browser to this API and out from here, so an address never sits in a query
string, an access log or a proxy's on the way.

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

**The tax identifiers a seller is asked for are named per country, not per
deployment.** Rows are seeded for India, the UK, the US, Canada, Australia, New
Zealand, Singapore, Japan, Switzerland, the UAE, Saudi Arabia, South Africa and
thirteen EU states, each with the local name and format — GSTIN, VAT, ABN, EIN,
TRN, UEN. A seller in a country with no row of its own is asked for
**"GSTIN / VAT registration number"** and **"PAN / unique taxpayer reference"**,
dual-named so the field is answerable anywhere, with the second one optional
because plenty of countries issue only one number. A wrong format is reported
back to the seller as an unfinished step rather than refused at save, so nobody
loses what they typed.

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
3. **Migrate, tighten the grants, then install the reference data.**
   ```powershell
   cd backend
   npm run db:migrate:deploy
   ```
   ```bash
   sudo bash /srv/uboss/current/deploy/scripts/apply-grants.sh   # on the server
   ```
   ```powershell
   npm run db:reference        # safe and idempotent in production
   ```
   Without currencies and countries the catalogue cannot be priced at all.

   **The middle step is not optional and cannot be done earlier.**
   `apply-grants.sh` is what makes `audit_logs` append-only, and it has to run
   *after* the tables exist — MariaDB refuses a table-level `REVOKE` against a
   table that does not exist, and refuses to revoke at table level at all what
   was granted at database level. `release.sh` runs it after every migration
   from then on, because a migration that adds a table leaves the application
   unable to write to it. `docs/DATABASE-PRODUCTION.md` §6 has the reasoning.
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

   **On a static host — Netlify, or anything like it —**
   [`docs/NETLIFY.md`](docs/NETLIFY.md) is the whole procedure, and
   `apps/*/netlify.toml` already carries the fallback, the security headers and
   a proxy that keeps the API on the same origin as the page. One command
   builds all three and packs a zip per site:

   ```powershell
   .\scripts\pack-netlify.ps1 -ApiOrigin https://api.your-company.com
   ```

   Two things that host cannot do, and they are the reason this is a *part* of
   going live rather than an alternative to it: it does not run the API, and it
   does not run the worker. Both are long-lived processes — one holds the
   database pool, the other polls the job queue forever — so they stay on a
   machine of your own, and the static sites point at them.
10. **Give each frontend its own hostname** if you can. They no longer share
    session cookies either way, but separate origins keep the CORS allowlist and
    the cookie scopes obvious. The carrier portal is designed for this — it is a
    third application rather than a section of one of the others precisely so a
    carrier signs in somewhere that is not your console.
11. **Delete the seeded accounts** and create real ones from **Staff**.
12. **Work through `backend/docs/RUNBOOK.md`** for backups, restore drills and
    incident procedure.
13. **Turn on the timers that watch the machine.** `deploy/scripts/bootstrap.sh`
    installs them; nothing enables them for you:

    ```bash
    sudo systemctl enable --now uboss-backup.timer    # nightly, encrypted, off-site
    sudo systemctl enable --now uboss-binlog.timer    # every 15 min — see below
    sudo systemctl enable --now uboss-monitor.timer   # queue, worker, disk, certificates
    ```

    **`uboss-binlog.timer` is the difference between losing fifteen minutes of
    orders and losing everything since last night.** It ships MariaDB's binary
    logs off the machine, encrypted, so a restore can be replayed forward to a
    moment rather than only to the nightly dump. It needs `UBOSS_BINLOG_URL` in
    `/etc/uboss/backup.env`, pointing at a MariaDB user with
    `REPLICATION SLAVE, REPLICATION CLIENT, RELOAD` and no `SELECT` on anything.

    `uboss-monitor.timer` runs the checks that an external uptime service cannot
    see — a worker that has stopped claiming jobs, a queue backing up, a backup
    that did not run, a certificate three weeks from expiry. Give it somewhere to
    shout: `UBOSS_ALERT_COMMAND` in `/etc/uboss/monitor.env` is any executable,
    called with the message as its single argument.
14. **Point an external uptime check at `/health/live`,** from outside the
    network. Everything above runs *on* the machine, so none of it can report
    the one failure that matters most.

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

> **If CI fails on "The install actually built what it needed to",** a
> dependency that runs code at install time was bumped, and npm 11 re-blocked
> its script. Run `npm install-scripts ls` in that project and
> `npm install-scripts approve <pkg>` to record the decision. The approvals name
> an exact version on purpose, so a new one is reviewed rather than inherited.
> `argon2` and `@prisma/engines` are the two the backend cannot run without.

**The same checks run on every pull request**, in `.github/workflows/ci.yml`,
against **MariaDB 11.4.13** — the exact patch production runs, pinned rather
than floating — instead of the 10.4 a development machine has. So a value too
long for its column fails there rather than on launch night.

That workflow also proves four things about the database on every pull request:
that the committed migrations and `schema.prisma` still agree, that the
application's account still cannot rewrite its own audit log or create a table,
that the data-validation queries still run, and that any new migration
containing a `DROP` or a `TRUNCATE` is named in the review rather than
discovered later. Plus dependency audits, a bill of materials, and a secret scan
over the whole history.

`.github/workflows/deploy.yml` builds and activates a release. It is **manual
only** and does nothing until an owner configures the environments, the deploy
key and the API base URLs — deploying automatically is a decision, not a
default. `docs/DEPLOYMENT.md` §15 has the settings it needs.

---

### Checking the variant data after an upgrade

The migration that introduced option signatures computed them in SQL,
because a constraint and the backfill that makes it possible have to land
together. SQL cannot fold values the way the application does, so the
historical rows carry a coarser signature than anything written since.

```powershell
cd backend
npm run variants:audit            # report only, changes nothing
npm run variants:audit -- --apply # rewrite the signatures it can
```

It never merges two variants and never edits an option value. What it
reports instead is products whose variants their own options cannot tell
apart — a real thing to find in an imported catalogue, where the
difference between four SKUs went into the name and never into the
options. Those rows keep selling; the report says which to fix.

### Two demo products for looking at variants in a browser

A safety shoe and a bag of seeds, which between them exercise everything
the selector has to do: narrowing along two axes, the difference between
"out of stock" and "not offered", a size run that has to sort
numerically, and a pack count that is not a cart quantity.

```powershell
cd backend
npm run variants:demo             # creates or replaces both
npm run variants:demo -- --remove # deletes them and nothing else
```

Re-running replaces them, so it is safe to press twice.

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
- **A scheduled cart is priced by `quoteSchedule` and nothing else.** The
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
- **What a price is a price FOR is a property of the product.** A box of
  cannulas is bought by the carton and a cordless drill is bought one at a time,
  and `products.piecesPerCarton` says which — null for a piece. The storefront,
  the basket, the wishlist and the schedule quote all read it through one
  function, so the figure on the card and the figure in the basket cannot drift
  apart. `PIECES_PER_CARTON` survives as the default for a product the import
  knew was cartoned without knowing by how many; it is no longer applied to
  everything the operator owns.
- **The demonstration catalogue can only touch its own rows.** A blueprint
  resolves to a product by reading `demo_catalog_entries`, so a product a person
  created cannot be named by the seed at all.
- **One seller cannot read another seller's data.** Every owned row carries its
  `sellerAccountId`, no route takes one from the caller, and no service accepts
  a seller id without having been handed a membership first.
- **A carrier is whichever company its session says it is.** The logistics
  portal derives the company from the authenticated membership and from nothing
  else — no query parameter, no route parameter, no stored value in the browser,
  no default and no first row in the table. A missing, disabled or unactivated
  membership is refused by name; none of the three falls back to another
  carrier. Creating a carrier in the console creates no login and authenticates
  nobody, and there is no impersonation path.
- **A brand is one row; permission to sell it is one company's.** Approving a
  name puts it in the catalogue once, for everybody. Approving a seller's
  *request* is what lets that business list under it, and the picker and the
  publish gate both read the same answer — so a name approved for a competitor
  is never offered as though it were permission.
- **A seller's product is on the shelf because a live offer points at it.** The
  storefront grid is rooted at the price row for the shopper's currency, and for
  a product a seller described that row is a projection of their cheapest live
  offer, written in the same transaction as the offer change. Pausing the last
  offer takes the product out of every category; a price change moves the grid
  with it. The offer stays the only figure anybody is charged — the projection
  exists so the catalogue can find and sort the product, never to price it.
- **What a line is counted in is decided by who is selling it.** The operator
  sells cartons of `PIECES_PER_CARTON` pieces; a third-party seller sells
  pieces, at their own minimum and step. The cart resolves the offer *before*
  it resolves the quantity, because deciding "how many pieces is this" first can
  only ever produce the operator's answer — and the operator's answer on a
  seller's line multiplies their price by the carton. Never decided from a
  category, a route or a string comparison: it comes from product ownership and
  the offer's own stored unit, on the server. A request naming a unit the line
  is not sold in is refused rather than reinterpreted, either way round — a
  seller's pieces asked for by the carton, or the operator's carton asked for by
  the piece. Naming no unit at all is still the route for a caller that counts
  in pieces, and is rounded up to whole sell units.
- **A paid order raises its own consignments, one per despatching building.**
  The operator's lines leave the warehouse the order was priced against; each
  seller's leave that seller's own pickup place, and a seller who has not said
  which of theirs it is holds nobody else's up. Raising is idempotent, so a
  redelivered payment webhook produces nothing new, and it can never fail an
  order that has already been paid for. Nothing is assigned at creation: which
  carrier takes it is the operator's choice, made on
  **Logistics → Shipments**, and the buyer's order then names the carrier
  carrying it.
- **A listing decision applies to the revision that was reviewed.** A moderator
  carries `submittedVersion` back with their decision, and it is refused if the
  seller has resubmitted or a colleague has already decided. Approval makes a
  listing *eligible*; the seller still has to put it on sale.
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
- **Pack count is not cart quantity.** "Pack of 10" is one thing a warehouse
  picks, weighs and ships, with its own SKU, barcode and price. How many of
  those packs somebody wants lives on the cart line and never on the variant.
  A buyer choosing a 500 g packet, Pack of 10, quantity 2 is buying 2 packs =
  20 packets = 10 kg, and every screen says so in those words.
- **No two variants of one product may describe themselves the same way.**
  Each carries an option signature — its combination, case-folded and sorted
  by axis key — under `unique(productId, optionSignature)`. Two matching rows
  would leave the selector picking whichever the database happened to return
  first.
- **A variant axis is a choice a buyer makes, not a fact about the product.**
  Size is an axis. Country of origin is a specification. A minimum order of
  ten is a term of trade. A batch number belongs to the stock in a warehouse,
  not to the identity of the thing being sold — a 500 g packet is the same
  variant whichever delivery it came out of.

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
| **[`docs/DATABASE-PRODUCTION.md`](docs/DATABASE-PRODUCTION.md)** | Which MariaDB and why, how it is configured, its four accounts and why they are four, the connection budget, collation and time, and when one VPS stops being enough |
| **[`docs/DATABASE-MIGRATION.md`](docs/DATABASE-MIGRATION.md)** | Migrations and schema drift, getting data out of XAMPP safely, which data may reach production, the validation queries, and how to release a migration |
| **[`docs/DATABASE-RECOVERY.md`](docs/DATABASE-RECOVERY.md)** | Backups, proving a backup restores, point-in-time recovery, and the runbook for a database that is unwell |
| **[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)** | Putting it on a server: the VPS build, releases, rollback, backups, monitoring, the EU/Poland compliance matrix and what must be decided before going live |
| **[`docs/NETLIFY.md`](docs/NETLIFY.md)** | Putting the three front ends on a static host: the two routes, why the API is proxied rather than called directly, what the API side has to be told, and what Netlify cannot host |
| **[`docs/PRODUCT-READINESS.md`](docs/PRODUCT-READINESS.md)** | What is actually built, capability by capability, against the product description — what is built, what is switched off, what refuses rather than pretending, and what is missing |
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

One command is worth running on a schedule rather than on a change: `cd scripts
; npm run check:ai` asks whether the AI provider is still answering. Nothing
else in this repository fails when it is not — see "The AI, and checking it is
actually on".

`CLAUDE.md` states this as a requirement and lists what counts as a change.
