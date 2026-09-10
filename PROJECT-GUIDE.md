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
   - [9.9 A customer changes the address they sign in with](#99-a-customer-changes-the-address-they-sign-in-with)
   - [9.10 A customer closes their own account](#910-a-customer-closes-their-own-account)
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

White and sky blue, with blue as the accent — and a dark theme beside it,
described below. The rule that produces the light one:

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

### There are two themes, and one of them is dark

The palette above is the light one. There is a dark one beside it in the same
file, and the appearance control in the storefront header and the admin top bar
switches between them.

**Three preferences, two themes.** A segmented control, three icons wide,
with the one in force drawn as a lifted tile:

| Preference | What it means | What is on `<html>` |
|---|---|---|
| **Match my device** (the default) | Follow `prefers-color-scheme`, now and later | nothing |
| **Light** | This site is light, whatever the machine says | `data-theme="light"` |
| **Dark** | This site is dark, whatever the machine says | `data-theme="dark"` |

The empty cell is load-bearing. `data-theme` is **not** a cache of the theme on
screen: its *absence* is what hands the decision to the
`@media (prefers-color-scheme: dark)` block, so somebody following their device
keeps following it when the device changes at sunset. Writing the resolved
value there would look identical in a screenshot and silently freeze them in
whichever theme they happened to be in.

The choice is kept in `localStorage` under `uboss.theme` and nowhere else — not
on the profile. A theme belongs to the screen somebody is looking at, not to
their account: the same buyer wants dark on the phone they check orders on in
the evening and light on the warehouse terminal, and a synced preference would
fight them on one of the two. It also means it works for a guest, on the
sign-in page, and before any request has been made. The two apps share the key,
so a deployment serving the panel under `/admin` gets one choice for the whole
product.

**The first paint is handled in `index.html`, not in React.** A six-line
blocking script in the head stamps the attribute before the document is
painted. React mounts *after* the first paint, so a provider structurally
cannot prevent the white flash a dark-themed visitor would otherwise get on
every page load — the one bug that makes a dark theme feel bolted on.
`src/app/ThemeProvider.tsx` adopts whatever that script decided and owns it
from there. The key and the three values appear in both files and have to stay
in step; each says so.

### Why every colour has two tokens now

This is the part that is arithmetic rather than taste, and the part most likely
to be undone by somebody tidying up.

`--brand` was used two ways: as the fill under a white button label, and as the
colour of a link on the page. On a dark card those pull in opposite directions.
White on the fill needs 4.5:1, which caps the fill's luminance; the link on the
card needs 4.5:1 against a surface that is nowhere near black. **No single blue
satisfies both.**

So every hue that appears as both a fill and as text carries two tokens:

| Token | Role | In dark mode |
|---|---|---|
| `--brand` | text and accent — `text-brand`, `border-brand/25`, `bg-brand/10` | lightens |
| `--brand-fill` | the solid plate under a light label — `bg-brand-fill text-white` | stays saturated |

In light mode the two hold the same value, so the light theme is unchanged by
their existence. The same split exists for `operational`, `success`, `warning`,
`danger` and `action`. Orange had half of it already: `action-strong` was
introduced as the fill under a white CTA label, and it has now separated
further — `action-strong` is orange as *text* (the cart control's label), and
`action-fill` is the plate.

**Which one to reach for:** if a light label sits on it, it is a `-fill`. If it
is a coloured mark with no text on it — a status dot, a proportion bar, a tab
underline, the connector between checkout steps — it is the bare token, and a
light hue on a dark ground is the correct reading for it.

Two more tokens exist for the same reason:

- `--surface-media` stays white in both themes. It is the plate behind an
  uploaded logo or product photo, and an operator's logo is frequently a dark
  PNG with no transparency — which on a dark plate is a black square.
- `--surface-inverse` and `--navy` stay dark in both themes, so the two
  `inverse` button variants and the dialog scrim keep working without a second
  set of rules. A dark theme where the "on dark" variant becomes "on light" is
  a dark theme that has to reimplement its own components.

The warehouse map's tiles do not follow the theme either, and
`WarehouseMap.tsx` says why: the imagery is the operator's, and the usual
shortcut — a CSS `invert()` over the tile layer — turns their basemap into a
photographic negative. The chrome, markers and popups around it do follow it.

### How far the tint can go is not a matter of taste

`npm run audit:contrast` (in both apps) reads the token block directly and
checks every pair the components actually put together against WCAG 2.1 AA —
4.5:1 for text, 3:1 for anything that identifies a control. It exits non-zero
on a failure and runs as part of `npm run verify`.

**It audits both palettes, separately, and it has to.** The version before the
dark theme read the whole stylesheet with one regular expression, so adding a
second `:root` block below the first would have made the last match win: the
audit would have quietly begun reporting on dark values only, under headings
that said nothing had changed. It now parses the light block and the dark
overrides as two palettes and measures every pair in each. It also compares the
two copies of the dark block against one another — dark is declared twice, once
under `prefers-color-scheme` and once under `[data-theme='dark']`, and a token
that drifted between them would mean the theme the operating system asks for
and the theme the toggle asks for are different themes.

That audit is what sets the ceiling on the sky tint. A tinted ground is a
*darker* ground, and the quietest text in the app — `--ink-subtle`, which
carries SKUs, timestamps and every table column header — is the first thing
that stops passing on it. It sits at 4.98:1 on the light page ground today. A
couple of steps deeper and the audit fails, which is the correct outcome: the
alternative is a slightly prettier blue that a low-vision buyer cannot read a
part number on.

It earned its keep the day the dark palette was added: it failed on two pairs
nobody had thought about — a buy button that got *lighter* on hover, walking
its white label to 4.09:1, and the cart control's orange label sitting at
2.92:1 on its own tinted ground.

`color-scheme` is now `light dark`, and pinned to one value when the visitor
has made an explicit choice. That is what makes the browser draw its own parts
— the scrollbar, and the option list of a native `<select>` — to match the
page. A page stamped `data-theme="dark"` on a machine set to light would
otherwise get a light scrollbar on a dark page, which is worse than no dark
theme at all.

### How the product reflows

Both apps are used on phones — a buyer reordering from a ward, a manager
checking an order on the way to a meeting — so both are built to work from
320px up. Two rules hold everywhere, and they are the ones to check against
when adding a screen:

1. **A page never scrolls sideways.** Horizontal scrolling belongs to a
   named container that opted into it — a wide table, a code block, a
   diagram — never to the page, because taking the page sideways takes the
   navigation and the cart off screen with it.
2. **Nothing overflows its own box.** A control that spills over its
   container is worse than one that scrolled: it silently covers the control
   next to it, and the covered one is usually the important one.

Where the two apps reflow:

- **The storefront header is one band at every width.** Brand on the left;
  appearance, market, account and basket on the right. It used to be three
  bands below `md` — a market strip, an identity band and a search row — and
  it is one now because two of the controls were removed outright: see *The
  header* in section 4 for the global search box and the category bar, and why
  neither should come back.

  The three market controls that needed a strip of their own are now one
  control that states all three answers and opens a panel. That is what freed
  the rows. It is not a fold-away, either — a buyer reading a quote in the
  wrong currency is the most expensive misreading this app can cause, and the
  currency is on the trigger at every width above `lg` and one press away
  below it.

- **The account area is two columns from `lg` and a disclosure below it.** The
  content column carries `min-w-0`, which is load bearing: a grid track's
  default minimum is its content's min-content, and that column holds order
  tables and product grids whose min-content is wider than a laptop. Without
  it the track refuses to shrink and the whole page scrolls sideways, taking
  the sidebar with it — which is rule 1 above, broken by a default.

- **The admin panel's sidebar becomes a drawer below `lg`** — a real modal,
  with focus moved into it, Tab cycling inside it and Escape closing it. The
  language picker moves to the foot of that drawer below `sm`, because at
  320px the top bar's five controls came to 351px and what silently lost was
  the breadcrumb — the only thing telling a phone user which section they
  are in. The drawer is navigation, not a settings screen, so the picker is
  still one tap from every page.

- **Wide admin tables scroll inside themselves,** and `DataTable` columns can
  be marked `secondary` (hidden below `lg`) or `tertiary` (hidden below `xl`)
  so a phone shows identity, status and one number rather than a crushed
  fourteen.

- **Dialogs are capped to the viewport and only their body scrolls.** The cap
  is `100dvh` — the dynamic viewport, so a mobile browser's collapsing
  toolbar is counted rather than guessed at. Before, the body alone was
  capped at `70vh`, which is fine until the viewport is short: on a phone in
  landscape the header and footer no longer fitted around it and the footer —
  the row with Save and Cancel in it — fell off the bottom of the screen.

- **Every grid declares its base column count** (`grid-cols-1`), not just its
  wider ones. A grid track sized `auto` or `1fr` cannot go below its
  content's min-content width, so one long product name in a sidebar column
  widened a whole checkout page by 254px. `grid-cols-1` and `minmax(0,1fr)`
  have a floor of zero and cannot do that. This is the single most common way
  a page in either app starts scrolling sideways.

- **The breakpoints are measured, not guessed.** Each one in the storefront
  header is the width at which the controls actually stop fitting, and the
  numbers are recorded in the comments beside them, so a future nudge earlier
  can see what it would reintroduce.

Two conventions worth knowing before adding to a page:

- **`--page-bottom-bar`** is how much of the bottom edge a page-level action
  bar is occupying — `0px` on the pages that have none. `StickyBottomBar`
  (the cart's Checkout row) measures itself and publishes its height there,
  and anything else pinned to the bottom edge offsets itself by it. The chat
  launcher is why: 56px in the same corner, and before the offset it sat
  exactly on top of the Checkout button.
- **A short viewport is its own case.** A phone held sideways is ~400px tall,
  where the storefront's sticky rows would be 40% of the screen, so they trim
  their vertical padding under `max-height: 480px`.

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
| `/confirm-contact` | Confirm a new email address or telephone number (from the emailed link) | Asks for one |
| `/schedules/new` | Build a repeating order | **Yes** |
| `/ai` | AI Mode: the assistant. A history needs an account | No |

Everything under `/account` shares one frame — a profile card and a grouped
sidebar on the left, the page on the right — and one session guard, which sits
on the layout route rather than on each page:

| Path | Page | Sidebar group |
|---|---|---|
| `/account` | Redirects to `/account/profile` | — |
| `/account/orders` | Order history | Orders |
| `/account/orders/:id` | One order | Orders |
| `/account/schedules` | Repeating orders | Orders |
| `/account/schedules/:id` | One repeating order | Orders |
| `/account/profile` | Name, email, telephone, password, limits, your data, closing the account | Account settings |
| `/account/company` | Company name, department, delivery contact number | Account settings |
| `/account/addresses` | Saved addresses | Account settings |
| `/account/region` | Language, country and currency | Account settings |
| `/account/payment-methods` | Saved cards | Payments |
| `/account/autopay` | Autopay: consent, limits, which card | Payments |
| `/account/billing` | VAT number, GSTIN, billing address | Payments |
| `/account/erp` | What the ERP hand-off does and who sets it up (no form) | Integrations |
| `/account/coupons` | Codes available, and codes used | My stuff |
| `/account/wishlist` | Lines saved without buying them | My stuff |
| `/account/notifications` | A record of what has been sent to this account | My stuff |

`/account/schedules` is absent from the sidebar on a deployment with
`recurringOrders` off — absent, not greyed out. The one list of destinations
that both the sidebar and the header dropdown read is
`apps/customer-web/src/pages/account/account-nav.ts`; two hand-written arrays
is how the header ends up offering a screen the sidebar has forgotten.

**Browsing does not need an account.** The sign-in wall sits at the *cart*, not
at the front door — because the backend puts it there too. A visitor can see
the whole catalogue and prices, and is only asked to identify themselves when
they want to actually buy.

**AI Mode is in front of that wall too.** `/ai` is a page, not a panel, and
anybody may ask it a question — the same reasoning as the catalogue: somebody
deciding whether this store has what they need should be able to ask before
opening an account. Signing in is what adds a *history*, not what buys an
answer. See *The AI assistant* in section 8 for what a guest gets and what they
do not, and for the setting that closes the door again.

**There is no longer a floating chat button.** The widget that used to sit in
the bottom-right corner of every page has been removed outright — the launcher,
the panel, the fixed positioning, and the per-tab conversation it kept in
`sessionStorage`. What replaced it is a route with a URL and, for a signed-in
customer, a conversation history that belongs to the *account* rather than to
the browser tab.

**Image search is the one thing behind the wall.** The camera button on the
front page's search bar spends the operator's AI provider budget on every
press, and unlike a chat message there is no cheap version of it — a vision
call is the most expensive single request this API makes. So it sits behind the
session, and a guest is offered a way in rather than a file picker that ends in
a 401. Browsing, searching and filtering the catalogue stay open to everybody.

## The header

One band over a tinted page, and five things in it: the brand on the left,
then the appearance control, the market control, the account control and the
basket on the right. That is all. Two things that used to be here are gone, and both removals are
the point of the current shape.

**The global search box is gone.** The front page opens on a large search
module, and a second, smaller search field in the chrome directly above
it was two front doors to the same room — behaving differently, at that: the
header field always went to `/search`, while the hero bar goes to the catalogue
with the filters and facets applied. Searching from anywhere is still one press
away, and the catalogue page grew a search field of its own **at the top of its
filter panel**, which is where it belongs: it is one more thing narrowing that
listing, alongside price, stock and the facets. (Clear all deliberately keeps
the term — it is the intent behind the listing rather than one of the
constraints on it.)

**The horizontal category bar is gone.** It was a second sticky row spending
44px of every viewport on the top-level departments, which are also the first
section of the front page and the whole left rail of the catalogue page. On a
phone it scrolled sideways, so the department you were in was frequently half
off screen — a navigation aid you have to navigate. The header no longer asks
for `/catalog/categories` either; a removed bar that still fetches is a removed
bar in name only.

What is left is deliberately not padded out to fill the space they left. The
brand shrinks and the controls do not, so the gap between them is whatever is
over. A `flex-1` element in the middle would be a named, measurable hole where
a control used to be.

**The appearance control is the fifth thing, and the quietest.** It is the
only control up here that changes nothing about the order somebody is
placing, so it sits first, and it is the one thing in the band that changes
shape with the width:

| Width | What it is |
|---|---|
| From `sm` | Three segments — *match my device*, *light*, *dark* — 109px |
| Below `sm` | One icon that advances through the same three — 40px |

That is a measurement rather than a preference. At 345px the band has about
44px left once the brand, the market chip, the account and the basket have
taken theirs, and a segmented control forced in there takes the page
sideways. Dropping a *segment* instead would be worse: the one that would go
is "match my device", so a phone user who pressed "light" once could never
hand the decision back. Adding the fifth control also cost the band four
pixels of gap below `sm`, which is written down beside it in `Header.tsx`.

Why "match my device" is a preference rather than a third look is in *There
are two themes* in section 2.

`chrome.test.tsx` asserts both absences. A comment explains a deliberate
removal; a test is what stops it being quietly reinstated by somebody who finds
the header looking sparse.

### One control for language, country and currency

They used to be three `<select>`s in a row. Together they came to 481px of
chrome in a 345px viewport, which made the whole page scroll sideways on a
phone and forced the header to grow a *second* sticky band to hold them. And a
`<select>` of 43 countries cannot be searched: the platform picker's type-ahead
matches the first letter only, so finding Netherlands means pressing N four
times.

So the three collapse into one control. The trigger states the current answer —
flag, language code, country, currency — and the panel changes all three
together:

| Part | Why it is there |
|---|---|
| Flag | The fastest of the four to read, so it leads |
| `EN` | The interface language, as a code, at every width |
| Country and currency | Wide screens only; below `lg` the flag says it and the panel spells it out |
| Chevron | It is a disclosure, and says so |

**Nothing is applied until Apply.** Every other control in the header acts on
change, and this one deliberately does not: it is three coupled answers, and a
country whose currency this catalogue holds no prices for has to be *shown* to
be a problem before it is acted on. Applying them together also matters —
picking "Germany" and then "euro" as two separate acts reprices the whole
catalogue twice and restamps the cart twice, and the shopper watches two rounds
of skeletons for one decision.

**Applying it says that the numbers moved.** Every price on screen has just
been requoted from the server — a different price list, and a different
destination's tax on top of it — and the open cart with them. A catalogue whose
figures change while somebody is reading it, with nothing said, is the most
expensive silence this storefront can produce, so a toast names the new market
and currency.

**The location is offered, never taken.** The browser's own reading — from the
time zone, which needs no permission — appears as a suggestion beside the list
with a "Use that". Nothing here raises a location permission prompt; the only
screen that does is the first-run picker, where the shopper can see why it is
being asked.

The panel is an anchored dropdown from `lg` and a bottom sheet below it. A
43-row list in a 280px popover pinned to the corner of a phone is a list you
scroll with your thumb over the content you were reading.

`/account/region` asks the same three questions with room to explain them, and
writes to exactly the same place. Both go through `LocaleProvider.choose`,
which is what invalidates every priced query and lets the server restamp the
cart; a second implementation of "reprice the catalogue" is how a header ends
up saying one currency while the grid shows another.

### The flags are drawn, not fetched

Three approaches were possible and two are wrong for this product.

**Not emoji.** `🇮🇳` is two regional-indicator code points a font is expected
to compose into a flag, and Windows ships no font that does — every browser on
it except Firefox renders the pair as the letters "IN" in two boxes. Since this
control is in the header of every page, on the platform an operator is most
likely to be running, "the flag is sometimes two letters in a box" would not be
a rendering detail, it would be the design.

**Not images.** UBOSS is self-hosted, and the front page's rule applies to the
chrome as well: it has to look finished with nothing supplied. A sprite sheet is
a request that can 404 behind a firewall, and a CDN is a third party in the
page.

**So they are drawn, and they are stylised.** `components/CountryFlag.tsx`
holds every served market as a handful of equal bands plus, where a flag needs
one, a single mark — a disc, a chakra, a cross, a leaf. At 24×16 CSS pixels a
stylised flag and an exact one are the same picture, and an exact one would be
kilobytes of path data per country for detail no display can resolve. A country
with no entry falls back to its two-letter code in a tinted plate, which is not
a failure state: `Country` is a table an operator can add rows to, so an
unknown code is an ordinary event and a deliberate letter chip reads as a
design decision where a blank box would read as a bug.

Every flag is `aria-hidden`. The country's own name is beside it in text
everywhere it appears, and a screen reader hearing "flag of India, India" has
been told the same thing twice.

### The account control

A guest gets a **Sign in** button — not a menu with one item in it, because
there is exactly one thing a stranger can do here and a control offering one
action should *be* that action.

A signed-in customer gets a dropdown headed by who they are (name, address,
company) and then the account destinations in four short groups: the profile,
orders, payments, and the odds and ends. It reads the same table the account
sidebar reads.

Four decisions worth knowing:

- **It is a disclosure, not an ARIA menu.** `role="menu"` promises a composite
  widget where Tab enters once and arrow keys move between items. This is a
  list of links, and announcing it as a menu would describe keyboard behaviour
  it does not have — and would replace "link" in every announcement, so a user
  who cannot tell that following an entry navigates has been told *less*.
- **The groups are headings, but not document headings.** They are `<p>`s
  referenced by each group's `aria-labelledby`, so a screen reader says
  "Payments, list, 3 items" on entering one without filling its heading list
  with "Payments" every time somebody opens the dropdown. In the account
  sidebar, which genuinely is a document region, the same titles are `<h2>`s.
- **The current page is marked.** `NavLink` sets `aria-current="page"` and the
  row is filled, because half of "where am I and what else is there" is
  answered by showing where you are.
- **Signing out asks first.** It sits one row under Notifications in a list
  people scan quickly, and on a shared purchasing machine an accidental
  sign-out costs somebody their basket. The confirmation is a real dialog
  rather than a second click on the same button, and it says what is *kept*.

Escape closes it and returns focus to the trigger; so does a click outside.
Below `sm` it is a bottom sheet with its own close button, because a sheet
covering half a phone needs a visible way out that is not a gesture.

## The front page: the search module

To the left of the sourcing graphic, under the headline, sits the thing this
page exists to offer: **one large search bar, with a two-item row above it.**

| Item | What pressing it does |
|---|---|
| **AI Mode** | Opens `/ai` — the AI Mode page — immediately |
| **Products** | Nothing. It is where you already are, and the bar below it is the catalogue search |

It replaced a pair of call-to-action buttons, and the swap is the point. The
old buttons said "Browse the catalogue" and "Sign in"; the first of those asked
somebody to go and *look* for a thing they could already name. Nothing was lost
with them — submitting an empty box goes to the same browse-all page the orange
button did, and the sign-in path is in the header on every screen.

**Submitting searches the catalogue, and only that.** The term goes into the
URL as `/products?q=…`, and the catalogue page owns what a result looks like —
so the filters, facets, pagination and category structure that already exist
are the ones the results arrive in. An empty box is the whole catalogue rather
than a no-op. A second grid of search results on the front page would be a
second definition of "a search result".

### AI Mode is a link, and it used to be a tab

The row looks like two tabs and is not two tabs. Pressing **AI Mode** goes
straight to the AI Mode page.

It used to select a tab: the bar switched its placeholder to "Ask anything
about medical sourcing", and pressing **Search** then navigated. That was two
presses to reach a page that is simply better at the job than a one-line bar
with a Search button can be — AI Mode has a composer that grows, a transcript,
and a list of previous conversations. So the row now does the obvious thing:
the item that leads somewhere leads there when pressed.

**Whatever is already typed travels with it.** It is parked in
`sessionStorage` and collected once on arrival, with intent `compose` — the
words land in the composer ready to finish, rather than being asked on
somebody's behalf, because pressing a link is not the same act as pressing
Search. `lib/ai-mode.ts` holds both the mechanism and why it is not a query
parameter: a question can be a paragraph, and it has no business in a link that
gets pasted into a chat window, logged by a proxy, or kept in browser history.

**There is no `role="tablist"` here any more, and there was.** A tablist
promises that its items switch panels inside the page and that arrow keys move
between them. One of these two items leaves the page, so announcing it as tab
selection describes a control that no longer exists. What is left is a labelled
row: the current item carries `aria-current`, the other is a link. The sliding
underline went with it — nothing moves, so the underline is a `span` inside the
current item, which is exact in all eight languages without a `ResizeObserver`,
a font-load handler and a layout effect.

The AI Mode item is **absent, not disabled**, on a deployment with no AI
provider configured. The bar is then a search bar with nothing above it, which
is the honest shape for that deployment — the same rule the rest of the
storefront follows for a capability the operator has not switched on.

### The catalogue is simply on the page

Below the hero, the greeting page lists products. It is not conditional on
anything: the bar above it searches the catalogue, and this is the catalogue.

| Step | What happens |
|---|---|
| 1 | The section mounts with the page |
| 2 | `/catalog/products` is read for the current currency, destination and language |
| 3 | Skeleton cards while it is in flight, in the grid the results land in |
| 4 | A failed read reports the reason with a **Try again**; an empty catalogue says so plainly |

**Two earlier shapes are worth not repeating**, and the tests record both.
Mounting the list only once the Products *tab* had been pressed saved one
catalogue read and left that tab sitting visibly selected, blue underline and
all, with nothing underneath it — which reads as a broken page to exactly the
person least able to tell that it is not. Tying it to *which tab was current*
then meant choosing AI Mode unmounted it, and the section scrolled itself into
view when it came back, which was right after a press and wrong on arrival.
With AI Mode a link, Products is the only thing the bar can be, and all of that
machinery is gone: nothing reveals the list, so nothing scrolls.

**It is a taste of the catalogue, not a second catalogue.** The section reuses
`ProductCard`, the same `/catalog/products` read and the same pricing as every
other listing, and adds a sort order and a page. The facets, price bounds,
attribute filters and category tree stay on `/products`, one link away —
reimplementing any of them here would be a second answer to "what is in this
catalogue" that could disagree with the first.

`home-products.test.tsx` guards the two things that rot. It counts the
catalogue reads and asserts there is exactly **one** — a section that mounts
twice, or a stale second query key, shows up here and nowhere else. And it
spies on `scrollIntoView` to assert that nothing scrolls on arrival, which is
the half of the old behaviour that was always wrong and the one a re-invention
would bring back first.

The bar carries four controls:

| Control | What it does |
|---|---|
| Text input | Enter submits, as does the Search button |
| Clear | Empties the box without submitting |
| Microphone | Dictates into the box using the browser's own speech engine |
| Camera | Opens image search — see below |

**Voice search never submits.** The transcript lands in the box and stops
there; the customer reads what was heard and presses Search themselves. Speech
recognition is confident and frequently wrong, and a search that runs itself on
a misheard word is a page of results for something nobody asked for. Dictation
is *appended* to what was typed rather than replacing it, so somebody who typed
"syringe" and then said "18 gauge" gets both.

It uses the browser's `SpeechRecognition`, so **nothing leaves the page**. The
alternative — recording audio and posting it to a transcription service — would
mean shipping a microphone recording of whoever is standing near the machine to
a third party, paying per second for it, and adding that vendor to the privacy
notice. Chrome, Edge and Safari have an engine; Firefox does not, and there the
microphone button is simply absent rather than present and broken. A refused
permission, a missing microphone and a dropped connection each get their own
message.

**Image search matches on what the model recognises the item to *be*.** It is
not a perceptual-similarity search over product photographs, and the interface
says so by showing the customer the sentence the picture was read as — "a
series of disposable plastic hypodermic syringes without needles" — above the
matches, so a misreading looks like a misreading rather than like a catalogue
full of the wrong stock. The photograph is sent to the provider and never
stored. See *Image search* in section 8 for how the slugs are validated.

**The camera is a live camera now, not only a file picker.** "Take a photo"
used to be `<input type="file" capture="environment">`, and the `capture`
attribute is a *hint* the spec lets a browser ignore. A phone honours it and
opens the platform's own camera app, which is the better tool — autofocus, a
flash, the full sensor. A laptop ignores it and opens a file picker, so
somebody sitting in front of a webcam with the product in their hand had no way
to photograph it. So `getUserMedia` leads now: a live preview and a shutter,
inside the dialog, on every device whose browser will lend one. The file input
stays as the fallback for the browsers that have no `mediaDevices` at all —
which includes any deployment served over plain HTTP, because that is not a
secure context.

The captured frame goes down **exactly the same path as a chosen file**: the
same size and type checks, the same upload, the same analysis, the same
description shown back. A photograph is a photograph however it arrived, and a
second pipeline would be a second set of limits to keep in step. It is a JPEG
at quality 0.9 and the video's own pixel dimensions — not a PNG, which for a
photograph of a real scene is several megabytes and would fail the 5 MB limit
the server enforces for no gain.

Four rules hold, and `camera.test.tsx` asserts each of them:

- **Nothing starts until somebody presses the button.** `start` is called from
  a click and never from an effect. A page that turns a camera on because a
  dialog opened is a page that turns a camera on without being asked, and the
  light on the bezel is how the customer finds out.
- **Every track is stopped on the way out** — on cancel, on unmount, and
  immediately after the shutter. A `MediaStreamTrack` left live holds the
  device open and the indicator light on for the rest of the visit, and on a
  laptop it also stops every other application getting the camera. This is the
  one a refactor breaks silently, because a webcam light is behind the screen
  you are looking at.
- **A refusal is a state, not an error.** Declining the prompt, a machine with
  no camera, and a camera that failed to start are three different sentences,
  because the customer's next move differs — and all three point at the file
  picker, which needs no permission. The message never explains how to change a
  browser permission: those instructions differ per browser and per version,
  and a wrong instruction is worse than none when there is already another way
  to do the thing.
- **The frame never leaves the tab except as the upload.** No object URL
  outlives the preview, nothing is written to storage, and no copy is kept
  after the search.

**Photographing something and then asking about it is one flow.** AI Mode's
paperclip opens this same dialog, so a customer photographs what they have in
their hand, the provider reads it, and what came back becomes context in the
composer for the question they were going to ask about it — "is this the one
that fits a 10 Fr port?" against a picture of the thing. That was already true
for an uploaded picture; it is now true for one taken on the spot.

**A capability the operator has not configured is absent, not disabled.** On a
deployment with no AI provider there is no AI Mode link and no camera button —
and with only one item left, no row above the bar either, because one item is a
label pretending to be a choice.

## The sourcing hub

Beside the search module, `/` carries one large animated graphic: a central
glass orb labelled **Sourcing**, two orbital rings turning in opposite
directions, and **four** capabilities riding those rings around it.

| Node | Ring | What pressing it does |
|---|---|---|
| AI Assistant | outer | Goes to `/ai` |
| Scheduled Orders | inner | Goes to `/account/schedules` |
| Autopay | inner | Goes to `/account/autopay` |
| ERP Integration | outer | Explains that a connection is created in the admin panel |

**Two nodes were removed and should not come back without a screen behind
them.** *Warehouse Network* and *Inventory Sync* both described the operator's
own logistics rather than anything a buyer could act on, and both resolved to
the catalogue in the end — so the hub was spending a third of its circle
pointing twice at a page the search bar beside it already reaches. What a buyer
can act on is what that network can ship. The node table's own header records
this, and `greeting.test.tsx` asserts the four ids, so re-adding one fails a
test before it reaches a review.

**A node never links somewhere the person pressing it cannot go.** That is the
rule the whole thing is built on, and it is why some nodes are `<a>` and some
are `<button>` depending on who is looking:

- A **guest** pressing Scheduled Orders or Autopay gets a short explanation and
  a **Sign in** link, never the guarded route.
- **AI Assistant is the exception, and it is the rule being followed rather
  than broken.** AI Mode is open, so there is nowhere a guest pressing it
  cannot go — it is a plain link for everybody, and the only node with no
  session branch at all.
- A capability this deployment has **switched off** (`recurringOrders`,
  `assistant`) explains that instead of linking to a page that would 404.
- **ERP always explains**, for everybody. It has no customer screen and is not
  supposed to grow one — a connection is a URL plus a credential belonging to
  whoever runs the installation, which is exactly why the screen for it is
  Settings → ERP in the admin panel. `/account/erp` says the same thing at
  greater length.

The decision table lives in
`apps/customer-web/src/components/greeting/orchestration-nodes.ts`, on its own,
so it can be read and tested without rendering an SVG.

### The animation

Everything that moves animates **`transform` and `opacity` only** — the orb's
wireframe rotates in three dimensions, its specular highlight orbits, an arc
travels round its rim, its aura breathes, the two drawn ring guides
counter-rotate, particles ride them, a light travels out along each spoke, and
the cards float. All of it composites on the GPU and does no layout
for the life of the page. The travelling lights are circles that translate
rather than the usual animated `stroke-dashoffset`, which would repaint the
whole path every frame.

**The whole thing has to be visible at once, and that sets its size.** This is
a diagram of four capabilities around a hub: a ring with one branch below the
fold is a diagram somebody has to scroll to read, which defeats the point of
drawing it. At a 34rem frame with cards that sized themselves to their own
wording the ring came to 562px tall, the hero band to 641px, and the page to
750px with the header on top — so on a 717px laptop viewport the bottom card
was cut off. Three numbers were changed together:

| | Was | Is |
|---|---|---|
| The frame | 34rem | 30rem |
| The card | 8rem wide, 152-171px tall, each sizing itself | 9.5rem square, all four identical |
| Supporting line | up to three lines | two, from `lg` |

The ring now sweeps 507px in both directions — the card is square, so the
composition is a circle rather than an ellipse — the hero band is 577px, and
the whole graphic sits between 139px and 649px of a 717px viewport with the
header ending at 77. The 14px it spills past the frame on each side lands in
the hero's own 48px padding.

**Four identical cards, not four cards that fit their own text.** The heights
were 152, 155, 171 and 152 pixels, which on a ring reads as four cards that
happen to be near each other rather than as one arrangement — and the tallest
of them was deciding how much vertical room the composition needed. A fixed
height also means a translation that runs long cannot change the geometry: the
supporting line clamps to two lines from `lg`, and the full sentence is still
what the phone list shows and what a screen reader reads either way.

**The whole ring turns, and nothing on it ends up upside down.** From `lg` all
four cards orbit the orb together — one direction, 64 seconds — and each sits
inside a layer turning the *opposite* way at the *same period*, so the two
cancel and the wording is upright and sharp in every frame. The pairing is the
one thing in this file that cannot be got wrong: the period is a CSS custom
property declared once on `.orch` and read by both layers, because a
counter-rotation a second out of step is a card that slowly tips over. The
radial spokes under the cards take the same period in the same direction, so a
line always points at the card it belongs to.

**One period for all four cards is a fix, not the original design.** They were
two counter-rotating groups at 64 and 97 seconds, which read better as a
description than it looked on screen: all four cards ride the *same* circle, so
two groups turning at different rates have to pass through each other, and
twice a minute one card sat on top of another with its wording clipped. Four
cards 90° apart on one orbit stay 90° apart forever. Only the two drawn ring
guides still counter-rotate, on their own period — they are dashes on a circle,
and a dash can pass anything without covering it, which is where the variety
the two node groups were reaching for actually belongs.

No two periods here are multiples of one another — the orbit, the wireframe,
the gleam, the rim arc, the aura and the two ring guides are all coprime by
intention. Two loops that share a factor visibly re-sync, and the pattern that
emerges is more noticeable than any of the motions on its own.

**The word "Sourcing" does not rotate.** It is a sibling layer of the orb with
no transform at all, because a word painted onto a spinning sphere is
unreadable for most of every revolution. The orb itself is nine layers of pure
CSS — a breathing aura, a soft ground, a travelling rim arc, a deep
navy-to-royal body, a graded conic rim, a wireframe globe, an orbiting gleam, a
fixed glass crescent and the label — with three concentric hairlines outside
it, and the glow kept deliberately tight, because a halo wide enough to be
noticed on its own is a halo washing out the headline beside it.

The aura and the rim arc were added when the hero's top band was tightened: the
sphere is 33% of the stage rather than 30%, and a larger orb in a shorter card
wants something happening at its shoulder or it reads as a static logo dropped
into a diagram. Both are `transform` and `opacity` only — the arc is a conic
gradient masked to a hairline ring and *rotated*, not a gradient whose position
is animated.

33% is as large as the sphere goes, and the margin is 14px: that is the gap
between the aura's visible edge and the nearest a card comes to it, which
happens due north and due east rather than on the diagonal. The note on
`NODE_RADIUS_FRACTION` has the arithmetic and the four numbers it depends on.

`prefers-reduced-motion: reduce` stops every rotation, the orbit *and its
counter-rotation together*, the aura, the rim arc, the float and the pointer
parallax. The parallax is written straight to two CSS custom properties on the
element and re-reads the media query on each frame, so switching reduced motion
on mid-visit takes effect without a reload.

**Below `lg` the circle becomes a still list.** Same DOM, same four controls,
same tab order: the orb stays as a smaller graphic and the cards drop into a
grid under it — one column on a phone, two from `sm` — with no rotation at all.
A radial layout that merely scaled down would put one node's label on top of
another's, and a rotating one would have four cards taking turns to cover each
other.

### What used to sit underneath

A panel headed **Your account** — five quick actions (View dashboard, Ask AI,
Build a cart, Schedule a cart, Connect ERP API), a next-delivery strip and an
Autopay promotion. **It has been removed outright.**

Every one of those destinations is now in the account menu in the header,
which is where somebody looking for their own account actually goes, and the
whole account area behind it has a sidebar of its own. A landing page that
spends its second screen on links for the minority of visitors who are signed
in is a landing page not doing its one job. Nothing was lost with it: the
dashboard, the assistant, the catalogue, the schedule builder and the ERP
explanation are all one press away, and the setup guidance it carried is on the
screens that can act on it — a card that can no longer be charged is reported
on `/account/autopay`, where it can be replaced.

What survives of it is the one line that was about the *page* rather than about
the account: the greeting above the headline still uses the customer's first
name where the profile has one. It comes from `useAccountIdentity`, shared with
the header button and the profile sidebar so all three greet somebody the same
way, and it is never derived from the email address — `ops.procurement@` is not
a person's name.

### A text field lights up its own edge, and not a box around it

Every focusable thing in both apps gets one ring, from a single
`:focus-visible` rule — except the things you type into, which show focus on
their own border instead.

The reason is a piece of the specification that surprises people: **a text
field matches `:focus-visible` on a mouse click.** An element that expects
typed input always matches, whatever focused it, because a caret alone is a
poor indicator. So one rule meant to show a ring only for keyboard users was
drawing an offset ring around every input the moment it was clicked — and an
offset ring around a control that already has a border is a second box drawn
around the first, which is exactly what it looked like. In the panel, which is
mostly forms, it was mostly that.

| | Before | Now |
|---|---|---|
| Buttons, links, checkboxes, radios | 2px offset ring | unchanged |
| Text inputs, textareas, selects | 2px offset ring | their border goes brand |
| The shared field skin | as above | border plus a 1px inset hairline, so the perimeter is 2px |

Nothing lost an indicator. A brand border clears 3:1 against the surface and
against the colour it replaces, which is what WCAG 1.4.11 asks of the boundary
of a control, and it is a visible change of state, which is what 2.4.7 asks
for. The rule sets `border-color` and nothing else, deliberately: several
fields in this app are borderless inputs inside a bordered wrapper that carries
`focus-within` for them — the AI composer, the hero search bar, the market
panel's search box — and on those the rule resolves to nothing rather than
drawing a line inside the wrapper.

The exclusions are written as `:not()` over the input types nobody types into,
rather than `:is()` over the text types, so a text-entry type nobody has
thought of yet is included rather than forgotten.

### The product photograph magnifies under the pointer

Hovering the image on a product page shows the part of it under the cursor at
2.5x. This catalogue is photographs of things with printed scales, gauge
markings and product codes on them, and a 530px square is not enough to read
those — so looking closer at one particular bit of the image is the thing a
buyer most wants to do with it.

**A second image and a transform, not a moving background.** The obvious
implementation is one element with `background-size: 250%` and an animated
`background-position`, and it repaints the whole square on every frame of the
hover. This is a second `<img>` at 2.5x the box, `translate3d` to put the right
part of it under the cursor: one composited property, no paint, and no extra
request, because it is the same `src` the layer underneath already loaded.

**The arithmetic, once.** To keep the point under the cursor *under the
cursor*, the layer moves by `-u × box × (scale - 1)`, which as a fraction of
the layer's own width is `-u × (scale - 1) / scale`. At 2.5 that is `-60%`.
`lib/pointer-zoom.ts` supplies `u` and `v` — where the pointer is in the box,
0 to 1 on each axis, clamped — and `.zoom-layer` in index.css does the rest.

**Both images share one content box.** The padding that keeps a photograph off
the frame's edge moved from the image to the *frame*. Two images with different
padding have different content boxes, and the magnified point is then near the
point that was hovered rather than the point that was hovered.

**It is sharp because the asset is big.** The product images in this catalogue
are around 4000px square, so 2.5x of a 530px box is 1330px from a 4000px
source — the magnifier resolves detail the page-sized image cannot show. On a
deployment whose photographs are small it degrades to a soft zoom rather than
to a broken one.

**A finger gets nothing**, for the reason every hover effect in this app skips
touch: a touch screen has no hover, so the zoom would open on a tap and stay
open until the next tap somewhere else. Visibility is keyed off a `data-zooming`
attribute the hook sets only for a mouse, rather than off `:hover`, which is
what sticks after a tap.

**Reduced motion keeps the zoom and loses the easing.** Unlike the card tilt
this is not decoration — it is how somebody reads a product code off a
photograph, and removing it would remove the information. So the transitions
go and the tracking stays, which is the same trade `scroll-behavior` makes.

`pointer-zoom.test.tsx` holds down the fractions, the clamp, and the three
cases that must do nothing.

### A product card leans towards the pointer

Hovering a product card tilts it a few degrees in perspective, lifts it very
slightly, and slides a soft highlight across the photograph. It is the one
piece of decoration in this storefront aimed at a specific moment: a buyer
scanning a grid of cards, deciding which one to open. That is the front page
strip, the related-products rail and the wishlist — a category listing is rows
now, and rows do not tilt.

| Part | What it is |
|---|---|
| The lean | `rotateX` / `rotateY`, at most 6° each, following the pointer's position in the card |
| The lift | `scale3d(1.012)`, on top of the shadow and border step the card already had |
| The highlight | A brand-tinted radial gradient over the media frame, translated with the pointer |

**Six degrees, and 1000px of perspective.** Shorter perspective or a wider
angle and it stops looking like a surface catching the light and starts looking
like a fairground mirror; it is also the angle at which a 14px product name
begins to look blurred on a non-retina screen, which is what makes this kind of
effect read as cheap.

**The highlight is on the photograph, not on the card.** It was briefly over
the whole card, which put an 18% blue veil across the price and the product
code — a contrast cost paid for decoration, which is the one trade a product
card must never make. On the media frame it is doing what a specular actually
does: sliding across the surface of the thing being looked at.

**Three cases get nothing at all**, and each of them is a bug if it is missed:

- **A finger.** `pointerType` is checked, because a touch screen has no hover:
  a tilt driven by touch fires as a tap lands and then stays leaning until the
  next tap somewhere else, which reads as a rendering fault.
- **A keyboard.** `focus-within` still gets the lift, the shadow and the
  border, so tabbing through a grid moves the same highlight a pointer does —
  but there is no pointer to lean towards, so there is no lean.
- **`prefers-reduced-motion: reduce`.** Checked in the hook *and* in the
  stylesheet, so the two cannot disagree, and the resting transform is removed
  rather than merely frozen.

**It costs one composited property and no re-renders.** `lib/pointer-tilt.ts`
writes four CSS custom properties straight to the node through a ref, so React
never hears about the pointer — putting the angle in state would re-render the
card, its price, its chips and its image dozens of times a second. The events
are coalesced into one `requestAnimationFrame` callback, and the card's box is
measured once when the pointer arrives rather than on every move, because that
measurement is a layout read. Everything that then moves is `transform`.

`ProductCardTilt.test.tsx` holds down the three exemptions and the arithmetic,
including the sign of `rotateX`: a pointer near the bottom edge has to tip the
*far* edge away, and the version that tips the near edge away instead still
looks like an effect, which is why it needs a test rather than an eye.

## Opening a category: the listing layout

`/category/:slug` and `/products` are one page — `CatalogPage` — because a
department, a search result and "everything" are the same list with different
filters applied, and three pages would be three copies of the filter, sort and
pagination logic drifting apart. What that page looks like changed: it was a
grid of cards and it is now a **list of wide rows beside a filter rail**, which
is the shape a department is actually read in.

```
Home / Products / Line Access
CATEGORY
Line Access   7 products
┌──────────────────────────────────────────────────────────────┐
│ Sort by  Newest first  Price: low to high  …                 │
└──────────────────────────────────────────────────────────────┘
┌───────────────┐  ┌─────────────────────────────────────────┐
│ Filters       │  │ ▢  Name of the product          ₹4,500  │
│               │  │    CODE                       +5% GST   │
│ CATEGORIES    │  │    What it is, in a sentence            │
│ ‹ All products│  │    • Sterilisation: Sterile (EO)        │
│   Line Access │  │    • Latex: Latex-free                  │
│               │  ├─────────────────────────────────────────┤
│ SEARCH        │  │ ▢  The next product              ₹3,050 │
│ BRAND    ⌄    │  │    …                                    │
│  ▢ …          │  └─────────────────────────────────────────┘
└───────────────┘
```

**Why rows.** A card 240px wide holds a name, a code and a price. A buyer
choosing between eleven infusion sets needs the *differences* — the bore, the
sterilisation method, the safety feature, the minimum order — which is four
more facts than a card has room for. A row has room, so the middle column
carries up to four of the product's own attributes as a list. Those come from
the catalogue rather than from a template: an administrator decides which
attributes a product has, and the row shows the first four.

`ProductCard` is untouched and still used by the front page strip, the
related-products rail and the wishlist. Two presentations of one product is not
duplication when they answer different questions — "here are some products"
against "which of these eleven".

**The sort is a bar, not a dropdown.** Five options, of which a dropdown hides
four behind a press, on the page where the fastest thing a shopper does is try
another order. Each option is a button reporting `aria-pressed`, in a group
named "Sort by" — not a `radiogroup`, which promises arrow-key movement between
the options. It scrolls sideways below `sm` rather than wrapping, because five
labels in eight languages is a bar that would change height and push the
results down the page.

**The panel says where you are in the tree.** At the top of the filters: the
parent as a link with a back chevron, the current category stated in bold and
not a link, and the children beneath it with their product counts. With no
category chosen it lists the top level instead. It reads
`/catalog/categories` — the tree, which every page that shows categories has
already loaded — rather than the category endpoint, which returns the category
and not its family.

**A long facet gets a search box.** Once a facet has more than twice as many
values as the panel shows collapsed, a box appears above it, and typing in it
implies unfolding: a term that matched the thirtieth value and then hid it
behind "show all" would be a search box that does not search.

### What the reference layout has that this does not

The layout came from a Flipkart category page, and five things on it are
deliberately absent here, because the data does not exist and inventing it
would be a claim the operator never made:

| On the reference | Why not here |
|---|---|
| A star rating and a review count | There is no reviews system. A rating is the most persuasive thing on a listing row and a fabricated one the most dishonest. |
| "Sponsored" | Nothing in this catalogue is paid placement. |
| A trust badge | Assurance is the operator's to claim, not this software's to assert for them. |
| A bank offer | Discounts here are a price and a compare-at price; card-issuer promotions are not modelled. |
| Add to Compare | There is no comparison view to add to. |

What fills the space they would have taken is the specification list, the
purchase rules that vary between products, and the saving — which is worked out
from the two prices in `BigInt` minor units and **truncated**, because a
percentage on a listing row is a claim and 33.6% off must read as 33 rather
than 34. `ProductRow.test.tsx` asserts both that arithmetic and the absence of
all five.

## AI Mode

`/ai` is the assistant as a page, and it replaced the chat widget that used to
be pinned to the corner of every screen. Two panes: a conversation list on the
left, the conversation on the right.

**Why it was worth moving rather than making the panel bigger:**

- **The history belongs to the account.** The widget kept one conversation id
  in `sessionStorage` and forgot it when the tab closed. The threads now come
  from the API, scoped to the caller's own profile on every read — so a buyer
  who asked something on Tuesday finds it on Thursday from a different machine,
  and cannot reach anybody else's.
- **There is room to answer properly.** A 23rem panel over a product grid is
  the wrong shape for a reply that lists eight product codes.
- **It can be linked, guarded and returned to.** The front page's search bar
  sends a question here; a guest goes to sign-in first and arrives with the
  question intact. That flow has nowhere to live in a widget.

| Left rail | Main pane |
|---|---|
| New chat | Welcome heading and a short introduction |
| Conversation history, most recent first | Five suggested starters |
| Rename a thread | The transcript, with the reply streaming in |
| Delete a thread (asks first) | Composer: text, attach, voice, Send / Stop |
| Collapse the rail | Copy and **Ask again** under a finished reply |
| The account, and Sign out | The AI disclosure and the retention notice |

**The rail is a drawer below `lg` and a rail above it** — one component, two
presentations, because two components is how the pair stops agreeing about what
"selected" looks like.

**Delete is soft, and the interface does not pretend otherwise.** From the
customer's side the thread is gone for good: it leaves the list, leaves every
read, and cannot be continued. What survives is the transcript, because what
this deployment's AI told a buyer about a medical device is a record it has to
be able to produce — staff still read it under Chat enquiries, and the
retention sweep is what eventually clears it. Erasure under Art. 17 is a
different act with its own route, and that one deletes the rows.

**It is "Ask again", not "Regenerate", and the wording is the honest one.** It
re-sends the question as a new turn; it does not replace the reply already
given. The transcript lives on the server, and a button that quietly deleted a
recorded answer would make that record a fiction.

**The paperclip is image search.** The customer photographs what they have, and
what came back — the description, and the matched products written as
`/product/…` paths — is dropped into the composer as context for the question
they were about to ask. It is not sent on its own.

**Anybody may ask; only an account gets a history.** The page is public and so
are `/assistant/start` and `/assistant/chat`. What differs is the rail:

| | A customer | A guest |
|---|---|---|
| Proof it is their conversation | Their session | An opaque token the API minted |
| Conversation history | Listed, renameable, deletable | None — the rail invites them to sign in |
| Survives a reload | Yes | No, and deliberately |
| Chat allowance | `ASSISTANT_RATE_LIMIT_PER_5MIN` | `ASSISTANT_GUEST_RATE_LIMIT_PER_5MIN`, which is lower |

**A guest's token is never persisted, and that is a decision rather than an
oversight.** Storing it would let a reload resume the conversation — but a
guest cannot re-read a transcript, because that route belongs to accounts. The
page would come back empty while the model carried context nobody could see,
and the next answer would refer to things that are not on screen. Starting
fresh keeps what is shown and what the server holds the same thing.

**Signing out does not throw anybody off the page.** The session ends, the
conversation goes with it, and the visitor carries on as a guest. There is
nowhere to be ejected to, and dropping somebody onto the home page for pressing
Sign out would be a worse answer than simply forgetting who they were.

An operator who would rather pay only for their own customers sets
`ASSISTANT_ALLOW_GUESTS=false`, and a guest's first send comes back 401.

**The shell gets out of the way for this one route.** `<main>` drops the
storefront's reading measure and its padding, the footer is not rendered, and
the column is an exact `100dvh` rather than a `min-height` — a two-pane chat
application inside a centred 80rem column with 16px gutters is a page
pretending to be an app, and a `min-height` leaves `flex-1` with no leftover
space to claim, which puts the composer below the fold.

## The account area

Everything under `/account` shares one frame: a profile card and a grouped
sidebar on the left, the page on the right, and one session guard on the layout
route rather than on each page. The sidebar stays mounted across a navigation,
so the scroll position holds, the profile read is not repeated, and the active
row moves rather than the whole column redrawing.

Below `lg` the sidebar collapses to a **disclosure** rather than to nothing.
Hiding the navigation entirely strands somebody who arrived on a deep link with
no way to the rest of their account, so on a phone the current page's name is a
button that opens the list. (Longest path match wins, so
`/account/orders/ORD-1` is labelled "My orders" rather than "Account".)

### Profile information

A column of panels, each a heading with an **Edit** beside it that swaps a read
view for a form. That shape is not decoration: a screen of twenty live inputs
all saved together is a screen where somebody correcting a phone number can
blank their job title and not notice for a month. One panel open, one Save, one
thing changed.

Every Edit carries the panel's own name in its accessible label — "Edit
personal information" — because eight controls all called "Edit" are eight
controls a screen-reader user cannot tell apart in a list.

**The name is captured in two parts and composed on the server.** `fullName`
stays the canonical name — what an order, an invoice, a delivery note and the
header greeting all use — and `updateCustomer` builds it from `firstName` and
`lastName` whenever either is sent. The composition only ever runs in that
direction:

> Given the parts, joining them is exact. Given a full name, splitting it is a
> guess that is wrong for a large fraction of real names in the markets this
> ships into: "Van der Berg" is one surname, "Jean Paul" is one forename, and
> plenty of Indonesian and Tamil accounts hold a single mononym. A guessed
> split is one the customer cannot tell was guessed.

So an account created by invitation or by import opens with the two parts empty
and its full name shown beside them, which is honest. Clearing both parts never
empties `fullName` — the parts simply become unknown again.

The panel also shows the country, language and currency and **does not edit
them**: they are one coupled answer that reprices the whole catalogue, there
are already two places that ask it properly, and a third editor is a third
chance for them to disagree. It links to `/account/region`.

Beneath the panels: the password (current one always required), the purchasing
limits (read-only — set by the supplier, and absent from the update schema on
the server as well as from this screen), a short FAQ about contact changes
written for this product rather than borrowed from a marketplace, the **Your
data** panel from section 12, and **closing the account**.

### Changing an email address or a telephone number

Neither is saved by the profile form. Both go through a confirmation link, and
the reason is worth stating plainly:

> `users.email` is what the account signs in with and where every order
> confirmation, payment link, invoice and password reset is sent. Writing a
> typed string straight into it means one typo locks somebody out of their own
> purchasing account with no way back — the confirmation would go to the
> address that does not exist.

So the requested value is parked in `users.pendingEmail` (or `pendingPhone`), a
single-use two-hour token is minted, and only consuming that link promotes it.
Throughout, the account carries on working on the value it already has, and the
screen shows the pending one as pending so nobody is ever looking at an address
their account does not actually use.

**Two emails go out per request, and the second one is the point:**

| Sent to | Carries |
|---|---|
| The **new** address | The confirmation link. Owning that mailbox is the only thing the link proves, so it is the only place it is sent |
| The **old** address | A warning with no link. If somebody else has got into the account, this is the message that reaches the real holder while their address still works — and it says that changing the password stops the pending request |

**Uniqueness is checked twice**, at request and again at confirmation. Minutes
pass between the two, and in that window another account can register or
confirm the same address; checking once is how two accounts end up sharing a
sign-in identity. Both refusals are `EMAIL_ALREADY_IN_USE` with the same
wording whether the address is *registered* or merely *requested* — a distinct
message would turn the endpoint into an oracle for whether a given company buys
here.

**Confirming an address revokes every session, including the caller's.** The
address is the sign-in identity, so a token minted against the old one is a
credential for an account that no longer exists under that name. The panel says
so *before* the request rather than after it, so somebody about to be signed
out of every device can finish what they were doing first.

**A telephone number is confirmed by a link sent to the email address.**
`NotificationChannel` names SMS and nothing in this installation sends it, so
the link proves control of the *account* — which is what stops somebody else
altering the number — and not control of the number. The screen and the FAQ
both say so, because a customer waiting for a text that is never coming
concludes the feature is broken. Wiring an SMS provider is what upgrades this,
and the only thing that has to change is where the message is sent.
Confirming a number moves **both** copies, `users.phone` and
`customer_profiles.phone`: two columns for one fact, and a change that updated
one would leave a courier ringing the old number. It revokes no sessions,
because a number is not the sign-in identity.

The link lands on `/confirm-contact?token=…&kind=email|phone`. That page is
public in the router and guarded by itself: it has to be reachable from a mail
client carrying no cookie, and a 302 to sign-in would lose the token out of the
query string and tell the customer their perfectly good link was invalid. The
`kind` is a hint and never trusted — the token carries its own purpose and the
server refuses a mismatch, so a link minted to confirm a number cannot be
replayed to promote a pending address.

### Closing the account

Two different acts, and the screen's job is to stop somebody confusing them.

**Deactivate** stops the account being used: every session revoked, nothing can
sign in, nothing deleted, and a member of staff can reopen it. It requires the
current password — this is one click from a sidebar, and on a shared purchasing
machine the person at the keyboard is not reliably the account holder.

What it must not do is leave money moving. A deactivated account with an ACTIVE
scheduled order and a live card mandate is a worker charging somebody weeks
after they closed their account, which happens *by default* unless the closure
prevents it. So it does three things in order, each through the service that
owns it:

1. Every ACTIVE schedule is **paused** through `pauseSchedule`, which asserts
   the transition. Paused rather than cancelled: cancelling is irreversible and
   the customer did not ask for it.
2. Auto-pay is **disabled** through `disableAutoPay`, which withdraws the
   stored consent and detaches the mandate at the provider.
3. The user row goes to DEACTIVATED and every session is revoked.

The confirmation dialog reads `GET /account/closure` first, so the warning
names the customer's own arrangements — "this will pause 2 scheduled orders" is
a sentence somebody can act on, where "scheduled orders may be affected" is one
they scroll past. It also states how many orders are still **owed**, because
closing the account does not cancel them and a customer must not be able to
believe it did. The audit entry is written with `actorType: 'CUSTOMER'`, unlike
the identical action written by the admin panel's own `setCustomerStatus` — "who
closed this account" has two very different answers.

**Delete** means erasure under Art. 17, and it is *not* a second endpoint. It
goes through `POST /account/data-requests` with `ERASURE` like every other
data-subject right, because it has to be assessed against the obligations that
survive it — an unpaid order, an open return, an invoice a tax authority
requires be kept for years. That path already refuses with a reason, already
tracks the one-month clock and already tells the subject what was kept. The
closing panel points at it rather than growing a second control: two ways to
ask for the same irreversible thing is one too many.

### Coupons, notifications and saved lines

**Coupons** (`/account/coupons`) lists the advertised codes for the currency
this customer is quoted in, read from the same `listPublicCoupons` the cart
reads — so a code offered here is a code the cart will accept. It deliberately
does **not** say whether a coupon is eligible: eligibility depends on what is
in the basket, and a page printing "eligible" against an empty cart would be
promising something it cannot know. The minimum order value is stated instead.
Redemptions are listed from `codeSnapshot`, not from the coupon's current code:
a coupon can be renamed or repercentaged afterwards, and what an order actually
received must not move.

**Notifications** (`/account/notifications`) is a record of what has been sent
to this address, read out of the outbox and filtered to `SENT` — a queued
message has not arrived and a failed one never will. Three deliberate
absences: nothing to mark as read (the server does not track whether an email
was opened, so a read state here would be an invention), no message **body**
(these are rendered emails and several carry a single-use link — a payment
link, a reset token, an export download — so a list endpoint handing them back
would turn one borrowed session into every live link the account has ever been
sent), and no preferences. The event key is turned into a family label in the
frontend, matched on its prefix so a new `schedule.*` event arrives grouped
correctly without a table growing a row.

**Saved for later** (`/account/wishlist`) is the narrowest useful feature, and
the absences are the design: no quantity, no note, no reordering.

> A wishlist that carries a quantity is a second basket with none of a basket's
> rules — no minimum order quantity, no increment, no stock reservation, no
> priced total — and the moment one exists somebody tries to check it out.

Saving a line says "remind me about this"; buying it means putting it in the
cart. That is also why the row's action goes to the product page rather than
straight into the basket: adding from here would have to invent a quantity, and
the quantity is exactly what a purchase rule constrains.

Lines are saved from a quiet **Save for later** control under the buy path on
the product page — offered to guests too, where it explains what signing in
buys them, because somebody browsing without an account is exactly who wants to
keep a line for later. It saves the chosen option where exactly one is chosen.

Prices come from the same shelf-pricing path as the catalogue, so a saved line
carries the destination's tax like every other figure on the storefront. **A
saved line whose product has gone is shown, not hidden**: unpublished,
deactivated variant, or not priced in the currency now being browsed, the row
stays with `isAvailable` false and no price. A saved item that silently
vanishes is indistinguishable from a bug, and the customer is owed the chance
to see that the thing they were waiting for has gone.

## The product page: choosing more than one option

A product with options — sizes, pack quantities — used to be a single choice:
pick 3 ml, pick a quantity, add to cart. A buyer who needed the 3 ml **and**
the 5 ml had to add one, navigate back, and add the other.

So the picker is a **multiple** choice. Every option can be switched on, and
each one that is on carries **its own quantity beside it**, because "two boxes
of the 3 ml and ten of the 5 ml" is the ordinary request in this trade rather
than the unusual one.

```
Choose your options
Pick as many as you need — each one gets its own quantity.
Ordered minimum 10, in multiples of 5.

┌────────────────────────────────────┬───────────────────────┐
│ [x]  3 ml            Size: 3 ml    │  Quantity of 3 ml     │
│                          ₹10.00    │  [ − ]  10  [ + ]     │
├────────────────────────────────────┼───────────────────────┤
│ [x]  5 ml            Size: 5 ml    │  Quantity of 5 ml     │
│                          ₹14.50    │  [ − ]  25  [ + ]     │
├────────────────────────────────────┴───────────────────────┤
│ [ ]  10 ml           Size: 10 ml         ₹19.00            │
└────────────────────────────────────────────────────────────┘

              ₹10.00 to ₹14.50
              The lowest and the highest of the 2 options you chose.

              [ Add 2 options to cart ]
```

Four rules hold this together.

**One request, not one per option.** Add to Cart sends
`POST /api/v1/cart/items/bulk` with every chosen option in one body, and the
backend writes them in a single transaction. Two requests would mean a customer
could be shown "added to your cart" with only half of what they chose actually
in it — and a customer whose *first* cart is being created could have two adds
race into two separate carts.

**The price panel never adds anything up.** With one option chosen it shows
that option's price, as it always did. With several it shows a **band** — the
lowest and the highest of the figures the server sent, chosen by comparing
them. A total across the options would be a second pricing engine on the one
page whose rule is that it has none, and it would eventually disagree with the
cart, which is where a total is actually worked out. Each option's own price is
printed in its own row instead.

**Only a single option preselects itself.** A product with exactly one option
has it switched on when the page opens, because a choice with one candidate is
not a choice. A product with several opens with none on: with a multiple
choice, a preselection is a decision made on the customer's behalf, and the one
it would make is "you want the first one".

**A repeat purchase still takes one option at a time.** `/schedules/new` builds
a plan around one product and one option, so the "Schedule your Cart" button
appears only where exactly one thing is chosen. Where two are chosen the page
says so and points at the path that does work — put them in the cart, then
schedule the whole cart.

Each chosen option becomes **its own cart line**. That was always true of the
database: `unique(cartId, productId, variantKey)` gives every option a row of
its own. What is new is that a cart line now publishes `variantName`, and the
cart page prints it under the product name. Two lines of one product carry the
same name and the same photograph, so the option name is the only thing on the
row that says which is which — and a cart that cannot be read is a cart that
gets ordered wrong.

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
- Whether AI Mode and image search should be offered, and which model answers

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
| `/chat-enquiries` | Chat enquiries | Transcripts from AI Mode, and whose account each one belongs to |
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

**Five rules, all enforced on the server.**

1. **A warehouse that has been used is never deleted, only retired.** Every
   stock movement ever booked against it points at that row, so deleting it
   would orphan the ledger that explains where stock went. Retiring takes it
   out of the receipt and adjustment pickers and leaves all of its history
   readable.
2. **A warehouse that was never used can be deleted outright**, and that is
   the whole of what delete does. It is there for the duplicate somebody
   created with a typo in its code and the site that was planned and never
   opened — a row nothing points at. The moment a balance, a movement, a
   reservation or a scheduled order names it, the answer is
   `LOCATION_HAS_HISTORY` and a message saying which of the four is in the way
   and how much of it there is; retiring is then the only way to get it off
   the working list. Deleting frees the code for reuse, which retiring
   deliberately does not. The default warehouse is refused whatever its
   history, and since a deployment's only warehouse is always the default,
   that is also what stops the last one being deleted. All four tables
   reference the row with `onDelete: Restrict`, so the database is what makes
   this safe; the guard in `location.service.ts` is what makes the refusal
   explain itself instead of surfacing as a foreign-key error. Nothing
   cascades, and there is no force flag.
3. **Retiring is refused while it still holds stock**, and the refusal says how
   many units. Retiring a full warehouse would not move the stock — it would
   hide it, by removing the only place from which it could be adjusted back
   out.
4. **There is always exactly one default, and it is always active.** Stock
   received without a warehouse named lands in the default. Promoting another
   one demotes the previous holder in the same write; demoting the only default
   is refused, because a deployment with no default cannot book a receipt at
   all. The first warehouse ever created becomes the default whatever the form
   said.
5. **A code belongs to one warehouse forever, in practice.** It is stamped on
   every movement, and the codes are stored in capitals because MariaDB's
   collation is case-insensitive — `main` and `MAIN` would collide anyway.
   "Forever" means for as long as the warehouse exists: deleting an unused one
   hands its code back, because nothing was ever stamped with it.

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
Three providers — a Google map, raster tiles, or nothing — and with none of
them configured the map still works: it pans, zooms, carries a scale bar and
places every marker correctly relative to the others. It just has no picture of
the ground behind it, and the screen says so. That default is deliberate: both
providers tell whoever serves them which part of the world is being looked at,
and in a self-hosted product that is where the buyer's warehouses are. Nothing
is sent anywhere until the operator asks for it. See
[Configuration](#14-configuration).

**What the screen deliberately does not show is a valuation per warehouse.**
Product prices here are per currency, so adding up the SKUs in one building
would put rupees and euros in the same total and print it as though it meant
something. Units are what a warehouse holds; money belongs on the screens that
know which currency they are quoting.

**Two map implementations, and the operator's settings choose.**
`WarehouseMap.tsx` does nothing but pick between them: Google Maps where a key
and a map ID are configured, Leaflet for raster tiles and for the
no-background default. Each one's library loads by dynamic `import()` inside
its own module, so it lands in its own chunk — a deployment on Google never
downloads Leaflet, one on tiles never fetches a line of Google's API, and
somebody who opens this screen to correct a postcode downloads neither. What a
marker looks like lives in `warehouse-marker.ts`, shared by both, so the two
maps cannot drift apart. See §14's warehouse-map settings for why Google
cannot simply be another tile URL.

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
| `GET /inventory/warehouses` | `inventory.read` | Every warehouse with its stock roll-up, plus the `map` provider the panel should draw them on. Takes `q`, `countryCode`, `status` (repeatable) and `includeInactive` |
| `POST /inventory/warehouses` | `inventory.location.write` | Opens one. Country required |
| `PATCH /inventory/warehouses/:id` | `inventory.location.write` | Corrects, moves, retires or promotes one. Absent fields are left alone |
| `DELETE /inventory/warehouses/:id` | `inventory.location.write` | Removes one that was never used. Refused for the default, and for any warehouse a balance, movement, reservation or scheduled order names. 404 for a warehouse already gone, which is also the answer to a second press |
| `PUT /inventory/warehouses/:id/erp-status` | `inventory.location.write` | The connector reports where the warehouse stands with the ERP |
| `POST /inventory/warehouses/geocode` | `inventory.location.write` | An address to coordinates. A POST so the address stays out of access logs |
| `GET /inventory/warehouse-countries` | `inventory.read` | The countries a warehouse may be in, for the pickers |
| `GET /inventory/locations` | `inventory.read` | The *pickers'* list — active only, no stock roll-up. Deliberately not the same endpoint |

The `DELETE` is narrow on purpose and cannot be widened by a parameter: the
four tables that reference a warehouse do so with `onDelete: Restrict`, so a
row with any history behind it stays whatever the caller asks. It leaves one
`inventory_location.deleted` entry in the audit log carrying the whole record —
code, name, country, position — because after the write there is nothing left
to look the warehouse up in.

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
| `assistant` | AI Mode on the storefront, for signed-in customers |
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

Three columns here exist only because a contact detail is confirmed before it
is adopted. `users.pendingEmail`, `users.pendingEmailNormalized` and
`users.pendingPhone` hold what somebody has asked to move to, and the live
`email` / `phone` are untouched until the emailed link is consumed — see *The
account area* in section 4 for why writing an unconfirmed address into the
sign-in identity locks people out of their own accounts. `pendingEmailNormalized`
is indexed but deliberately **not unique**: two accounts abandoning a change to
the same address is not a corrupt state, it is two rows nobody ever confirmed,
and a collision is an ordinary race to be refused with a sentence rather than a
1062 from the database. `auth_tokens.type` grew `EMAIL_CHANGE` and
`PHONE_CHANGE` to go with them — separate values rather than a reuse of
`EMAIL_VERIFICATION`, so a link minted to prove one thing cannot be replayed to
prove another. (Enum values are only ever appended: MariaDB stores an ENUM as
an ordinal, so inserting one in the middle silently renumbers every row already
written.)

`customer_profiles` carries `firstName`, `lastName` and `jobTitle` beside
`fullName`. `fullName` remains the one canonical name on every order and
invoice and is *composed* from the two parts; the parts are nullable and are
null for every account created by invitation or by import, which is correct
rather than a gap to backfill.

**Saved for later**
`wishlist_items` — a link to a person, a link to a product, a `variantKey` and
a timestamp. Nothing else, and see section 4 for why there is no quantity
column. `variantKey` is the same device the cart and the schedule items use,
for the MariaDB reason below: a UNIQUE index treats every NULL as distinct, so a
nullable `variantId` inside the composite unique would not stop the same
variant being saved twice. There is no foreign key on the variant on purpose —
the alternative would make somebody's wishlist a reason an administrator cannot
tidy up a product.

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

**AI Mode**
`assistant_conversations`, `assistant_messages`. The transcript lives here
rather than in the browser, which is what lets staff read what was actually
said and lets the retention sweep reach it. A conversation carries the
customer's own `title` (usually null — the sidebar falls back to the opening
question) and `hiddenAt`, the soft delete described in section 8.

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
of bug is designed out rather than guarded against. Where a path does carry an
id it is the id of a *row*, and the owner is still the session's: deleting a
saved wishlist line is a `deleteMany` scoped by both, so another customer's row
resolves to "not found" rather than needing an ownership check somebody will
eventually forget to write.

## The customer account endpoints

`/api/v1/account/*`, all behind `requireCustomer`, all deriving the profile
from the session. The rate limits are on the ones that send mail or move
identity, not on the reads.

| Endpoint | Notes |
|---|---|
| `GET /account/profile` | Also carries `pendingEmail` / `pendingPhone`, so the screen renders the pending value beside the live one from one read |
| `PATCH /account/profile` | Name parts, job title, company, department, delivery number, VAT number, GSTIN. **Not** the email address, the account number, `customerCode` or any purchasing limit — those are absent from the schema, which is a stronger guarantee than remembering to strip them |
| `GET`/`PUT /account/locale` | Country, currency and the browser's own reading, kept apart |
| `GET`/`POST`/`PATCH`/`DELETE /account/addresses` | Scoped by the session's profile id |
| `POST /account/email-change` | `202`. Parks the address, mints a link, mails **both** addresses. `5/hour` |
| `POST /account/email-change/confirm` | Promotes it, verifies it, revokes every session. Re-checks uniqueness |
| `DELETE /account/email-change` | Abandons it and consumes the outstanding token |
| `POST /account/phone-change` | `202`. The link goes to the account's email — no SMS driver here |
| `POST /account/phone-change/confirm` | Moves both copies of the number. Revokes nothing |
| `DELETE /account/phone-change` | As above |
| `GET /account/closure` | What closing this account would pause, withdraw and leave owed |
| `POST /account/deactivate` | Password required. Pauses schedules, withdraws auto-pay, deactivates, revokes sessions. `5/hour` |
| `GET /account/coupons` | Advertised codes for the quoted currency, plus this customer's redemptions |
| `GET /account/notifications` | Outbox rows for this address, `SENT` only, **subjects without bodies** |
| `GET`/`POST /account/wishlist`, `DELETE /account/wishlist/:itemId` | Priced through the catalogue's own shelf-pricing path |
| `GET`/`POST /account/data-requests` | Art. 15 and Art. 17. **Deleting an account is this, not `/deactivate`** |

Two of these are worth restating because they are easy to get backwards:

- **`POST /account/deactivate` deletes nothing.** It closes the account and
  stops anything that would charge it later. Erasure is
  `POST /account/data-requests` with `ERASURE`, which is queued for a decision
  because Art. 17(3) has exemptions a person has to weigh.
- **`POST /account/wishlist` is idempotent and answers `200`, never `201`.**
  Saving something already saved is the customer getting what they wanted, and
  a `201` would be a claim that a row was created.

## The AI assistant

Six endpoints. **The first two answer anybody; the other four need an account.**

| Endpoint | Sign-in | Body | Answers |
|---|---|---|---|
| `POST /api/v1/assistant/start` | No | *(empty)* | `{ conversationId }`, plus `conversationToken` for a guest |
| `POST /api/v1/assistant/chat` | No | `{ conversationId, message, conversationToken? }` | A Server-Sent Event stream |
| `GET /api/v1/assistant/conversations` | **Yes** | — | The caller's own threads, most recent first |
| `GET /api/v1/assistant/conversations/:id` | **Yes** | — | One transcript in full |
| `PATCH /api/v1/assistant/conversations/:id` | **Yes** | `{ title }` | `204`. An empty title clears the name |
| `DELETE /api/v1/assistant/conversations/:id` | **Yes** | — | `204`. A soft delete — see below |

### Who owns a conversation

Two authorities, and they do not cross. A **customer** owns theirs through
their account, so it follows them between machines and appears in their
history. A **guest** owns exactly one, through an opaque token returned by
`/start` and required on every turn.

`optionalCustomer` is the guard on the open pair, and its rule is **no
credential means guest; a credential means prove it.** A request with no access
token is anonymous. One that presents a token is asking to be treated as that
customer, so it goes through the whole check — expiry, revocation, surface,
account status, CSRF — and a failure is a failure. Quietly demoting a broken
credential to guest would strand a customer from their own conversation and
would let a cross-site POST that fails the CSRF check carry on regardless.

What a guest token buys is one conversation and nothing else:

- Only its **SHA-256 is stored**, so a database read cannot resume a
  conversation and neither can a leaked backup. The comparison is
  constant-time.
- It **cannot open a conversation that has an account behind it**, and a
  customer cannot pick up a guest's by its id — each branch demands the column
  the other one leaves null.
- Somebody else's conversation is a **404, never a 403**. Whether it exists is
  not something an anonymous caller gets to learn.

The four history routes share one guarantee worth saying once: **every service
call takes `customerProfileId` from the session guard and puts it in the
`where`.** There is no parameter a browser can send that widens the query, so
one customer's history cannot reach another's — and no token stands in for an
account, so a guest never reaches them at all.

### What letting guests in costs

An anonymous caller spends the operator's AI provider budget. A rate limit
bounds that; it does not remove it. Three things bound it:

| | |
|---|---|
| `ASSISTANT_ALLOW_GUESTS` | Off, and the two open routes answer a guest 401 again |
| `ASSISTANT_GUEST_RATE_LIMIT_PER_5MIN` | The guest allowance per IP. Lower than the signed-in one |
| The fixed parameters | The control that matters most. The body cannot name a model, a system prompt or a token budget, which is what stops the endpoint being driven as a relay to somebody else's AI bill |

The rate-limit hook runs before the route's guard, so the allowance is chosen
from whether the request carries a customer access cookie at all. That is a
heuristic for **sizing a bucket, nothing else** — its worst case is a junk
cookie of the right name buying the difference between the two numbers, and no
access to anything.

**Delete is a soft delete.** `hiddenAt` is stamped, and from the customer's
side that is total: the thread leaves the list, leaves every read, and
`authoriseConversation` refuses to let it be continued. The transcript itself
survives for staff and for the retention sweep, because what the AI told a
buyer about a medical device is a record the deployment has to be able to
produce. An erasure request is a different act with a different route, and that
one still deletes the rows.

**The title column is usually null, and that is not a gap.** The sidebar falls
back to the opening question, which is a better label than anything generated
and costs no provider call to make. It is written only when somebody renames a
thread by hand.

**Nobody is asked who they are, signed in or not.** The widget once opened with
a form asking for a name, a mobile number and an email, and that form was the
only answer to "who is asking". Nothing typed into it was ever verified, so it
bought friction rather than safety. It is gone and is not coming back: a
visitor is anonymous, which is both cheaper and more truthful than an unchecked
claim.

Where a customer *does* present a credential, this is what it is checked for
before a single token is bought:

| Check | Failure |
|---|---|
| A token that verifies and has not expired | `401 SESSION_EXPIRED` |
| A session that has not been revoked (logout, password change, deactivation) | `401 SESSION_EXPIRED` |
| An account that is still `ACTIVE` and not archived | `401 ACCOUNT_DEACTIVATED` |
| A customer with no `CustomerProfile` | `403 ACCOUNT_NOT_ACTIVATED` |
| The CSRF double-submit header | `403 FORBIDDEN` |
| The conversation belongs to **this** caller | `404 NOT_FOUND` |

A **staff** credential is not one of these failures and never reaches the
customer surface at all: the admin cookies are named apart, so a member of
staff on the storefront is simply an anonymous visitor. What they must never be
is a customer, and the row proves it — no owner, and a guest token instead.

The 404 on the last row is deliberate: somebody else's conversation must not be
distinguishable from one that never existed, or a conversation id becomes a way
to ask whose it is.

**Rate limits.** `/start` allows 30 per 15 minutes per address — deliberately
generous, because a procurement office is often a dozen people behind one NAT
address. `/chat` uses `ASSISTANT_RATE_LIMIT_PER_5MIN`, or the guest number
where there is no session. A limit says how much may be spent; it does not stop
the endpoint being driven as a general-purpose relay. Only the fixed parameters
do that: the request body cannot name a model, a system prompt or a token
budget, and a body carrying one is a `400`.

**What the assistant knows about the customer.** Because a signed-in caller is
authenticated, it never has to ask. The system prompt carries a few lines read
from their account under that session — full name, organisation, department,
account number, preferred currency and country — and nothing else. No address,
no order history, no VAT or GST number, no internal note. The test for a field
is not "could it help" but "would an answer be wrong without it", because every
line is sent to the AI provider on every turn. Those lines go **last** in the
prompt, below the catalogue snapshot, so the cacheable prefix stays identical
for every customer.

**A guest's prompt simply has no customer block**, which is the correct
degradation rather than a missing feature: a visitor with no account has no
name, organisation or account number for it to be right about, and putting a
box on screen to type one into is the capture form all over again.

**Nothing sensitive is logged.** The conversation id, the model and the token
counts go to the log. The question, the reply and the customer's details do
not: a transcript belongs in the database, where the retention sweep can reach
it and an erasure request can delete it.

**The four `visitor*` columns are still there and still never written.**
`assistant_conversations` keeps `visitorName`, `visitorPhone`, `visitorEmail`
and `visitorEmailNormalized`, nullable. The rows that already have them are
somebody's enquiry from the capture-form era, and they leave on the schedule
`RETENTION_ASSISTANT_CONVERSATION_DAYS` has always set for them. The Chat
enquiries screen reads both eras and labels which is which — details from an
account are marked verified; details typed into the old form are marked as the
unchecked claims they always were, and a guest's row carries no details at all.

**`sessionTokenHash` is in use again**, and it is worth being clear that this
is not the old mechanism returning. It holds the hash of a guest's conversation
token: a secret this server minted, which proves one conversation and says
nothing about who anybody is. The old column held the same *kind* of value for
the same *kind* of reason — separating one anonymous visitor from another — and
what has not come back is the form that sat in front of it.

**Staff see hidden conversations too.** `hiddenAt` narrows the *customer's*
reads and nothing else: the Chat enquiries screen lists a thread the customer
has deleted, because the point of keeping it was that staff can still read it.

## Image search

`POST /api/v1/catalog/image-search` — multipart, one file in a field named
`image`.

**It is the one authenticated route under `/catalog`, and the exception is
deliberate.** Every other read in that zone costs a database query; this one
spends the operator's AI provider budget on every call. Left open, any script
on the internet could bill a self-hosted deployment for as many vision calls as
it cared to make — which is the same reasoning that put `/assistant/*` behind
the session guard. It is rate limited to **12 in five minutes**, well below the
chat endpoint, because a vision call is the most expensive single request this
API makes and nobody legitimately photographs ten products a minute.

**How it actually works**, because "image search" covers several very different
things and this is only one of them:

1. The published catalogue is rendered as a short index — slug, category, name,
   one summary line. Not the full snapshot the chat assistant gets: matching a
   photograph does not need prices, tax classes, ordering rules or variants,
   and leaving them out roughly quarters the prompt. Cached for 60 seconds.
2. The image and that index go to the deployment's own AI provider, with one
   instruction: identify what is in the picture and name the entries from the
   index that match it.
3. **Every slug that comes back is checked against the index before it is
   used.** A model that invents `blue-syringe-box` has its answer silently
   dropped rather than turned into a card that 404s. The same check covers a
   slug remembered from training data and a product unpublished in the sixty
   seconds since the index was built.

The matches are then priced through exactly the same path as the grid, and
returned **in the model's ranking** — a product with no price row in the
requested currency is not sold in it and is left out, as it would be from the
listing.

**What this is not:** a perceptual-similarity search over product photographs.
There is no embedding index and no pretence of one. Matching is on what the
model recognises the item *to be*, which is why `description` comes back with
the results and the storefront shows it.

**The bytes are never stored.** The type is sniffed from magic bytes and the
client's `Content-Type` and filename are both ignored — SVG is refused, as it
is on the admin upload, because it is a script-capable document rather than a
picture. The photograph goes to the provider and is dropped when the request
ends: a picture taken inside a hospital store room is not something this system
should be holding.

Two failures, two codes, because they need different words and different
actions:

| Code | Status | Means |
|---|---|---|
| `IMAGE_SEARCH_BUSY` | 503 | The provider is over quota or overloaded. Wait |
| `IMAGE_SEARCH_UNREADABLE` | 502 | A reply came back that could not be used. Try a clearer photograph |

Neither reuses `SERVICE_UNAVAILABLE`, which the storefront reads as "the whole
store is down" and puts a site-wide maintenance banner behind. One camera
button failing is not an outage.

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
│ One option:   POST /api/v1/cart/items                        │
│                 { productId, variantId, quantity }           │
│ Two or more:  POST /api/v1/cart/items/bulk                   │
│                 { items: [ { productId, variantId, qty } ] } │
│               ONE transaction: all of it, or none of it      │
│                                                              │
│ Checks: is it published? does the option belong to that      │
│ product? is the quantity above the product's minimum?        │
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

## 9.9 A customer changes the address they sign in with

The long version, and the reasoning behind each step, is *Changing an email
address or a telephone number* in section 4. The sequence:

1. `POST /account/email-change` with the new address. The server checks that no
   other account signs in with it **or is already moving to it**, parks it in
   `users.pendingEmail`, and mints a two-hour single-use `EMAIL_CHANGE` token.
2. Two emails are queued: the link to the **new** address, and a warning with
   no link to the **old** one. The endpoint answers `202` — accepted, not done.
3. The account carries on working. Sign-in, order confirmations, payment links
   and invoices all still use the old address. The profile screen shows the
   pending one as pending.
4. The customer opens the link, which lands on
   `/confirm-contact?token=…&kind=email`. The page requires a session; if there
   is none it offers sign-in **with the address the account still has**, which
   is why not promoting it early matters.
5. `POST /account/email-change/confirm` consumes the token, re-checks
   uniqueness (minutes have passed), promotes the address, stamps
   `emailVerifiedAt`, clears the pending columns and **revokes every session**.
6. The customer signs in again with the new address.

Anywhere it can fail, it fails without changing the live value: a taken address
refuses at step 1 *and* again at step 5, an expired or reused link refuses at
step 5, and a link belonging to a different signed-in account refuses at step 5.
Cancelling at step 3 consumes the outstanding token, so the link in the inbox
stops working.

A telephone number follows the same six steps with `kind=phone`, one honest
difference — the link goes to the account's **email** address, because this
installation has no SMS driver — and one behavioural difference: it moves both
`users.phone` and `customer_profiles.phone`, and revokes no sessions.

## 9.10 A customer closes their own account

1. `GET /account/closure` reports what closing would do to *this* account: how
   many ACTIVE schedules would be paused, whether a charging authority would be
   withdrawn, and how many orders are still owed. The dialog states all three.
2. `POST /account/deactivate` with the current password. A wrong password
   refuses and nothing changes.
3. Every ACTIVE schedule is paused through `pauseSchedule`, which asserts the
   transition — not a bulk `UPDATE` on `status`, because plan status is only
   ever changed through `domain/schedule-state.ts`.
4. Auto-pay is disabled through `disableAutoPay`, withdrawing the stored
   consent and detaching the mandate at the provider.
5. `users.status` goes to DEACTIVATED, every session is revoked, and the
   closure is audited with `actorType: 'CUSTOMER'`.
6. The holder is emailed a summary at the address that still works, because a
   deactivation they did not ask for is something they need to hear about while
   it can still be reversed.

Steps 3 and 4 are the point of the whole flow. Without them a closed account
still has a live mandate against a live schedule, and the worker charges
somebody weeks after they closed their account.

**Nothing is deleted.** Erasure is a different act with its own route —
`POST /account/data-requests` with `ERASURE` — because Art. 17(3) has
exemptions a person has to weigh, and an invoice a tax authority requires be
kept for years is one of them.

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

Invitation links, password resets, contact-change confirmations and payment
links are 32 bytes from a cryptographically secure random generator. **Only the
SHA-256 hash is stored.** A stolen database backup contains no usable links.

Each token carries its **purpose**, and `consumeToken` refuses a mismatch
before it looks at anything else. That is what stops a link minted to prove
somebody owns a new telephone number being replayed to promote a pending email
address, or a password-reset link being redeemed as an invitation. Issuing a
token supersedes the outstanding ones of the same purpose, so a resent link
invalidates the previous one rather than leaving two live.

## Changing what identifies an account

Two properties are load bearing here, and both are asserted in
`tests/integration/account-self-service.test.ts`:

- **The live value never changes before the link is followed.** An unconfirmed
  address written into `users.email` is a typo that locks somebody out of their
  own purchasing account, because the confirmation would go to the address that
  does not exist. The intermediate state — parked value, old address still in
  force — is the one the tests assert.
- **Confirming an address revokes every session, including the caller's.** The
  address is the sign-in identity; a live token minted against the previous one
  is a credential for an account that no longer exists under that name.

The old address is told that a change was requested, with no link in the
message and a pointer at the password reset. If somebody else has got into the
account, that email is what reaches the real holder while their address still
works — and changing the password revokes every session and supersedes the
pending request.

Closing an account requires the current password. It is one click from a
sidebar menu, and on a shared purchasing machine the person at the keyboard is
not reliably the account holder. The closure is audited with
`actorType: 'CUSTOMER'`, distinct from the identical action written when a
member of staff deactivates somebody: "who closed this account" has two very
different answers, and only the audit trail can tell them apart afterwards.

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

They share **one control** in the storefront header and one screen at
`/account/region`, and that is a presentation decision rather than a retreat
from the distinction: three separate `<select>`s made the header scroll
sideways on a phone. Inside the panel they are three separate answers, each
with its own explanation of what it decides, and the language is applied
through the i18n provider while the country and currency go through
`LocaleProvider.choose`. What the shared Apply buys is that changing all three
reprices the catalogue **once** instead of three times.

**A market change is announced.** Applying a new country or currency requotes
every price on screen from the server and restamps the open cart, and a toast
names the market and currency it is now quoting in. A catalogue whose figures
change while somebody is reading it, with nothing said, is the most expensive
silence this storefront can produce.

**And a country the catalogue cannot price says so.** Staff can activate a
country before anything is priced in the currency it uses. The panel does not
silently leave the shopper on their old currency and let them find out on the
grid — it states which currency they will keep being quoted in, before Apply.

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
| `ASSISTANT_ENABLED` | — | AI Mode and image search |
| `ASSISTANT_ALLOW_GUESTS` | `true` | May somebody with no account use AI Mode? On, and a visitor may ask before signing up; off, and `/start` and `/chat` answer a guest 401. Understand what it costs before leaving it on — an anonymous caller spends the operator's AI provider budget, and a rate limit bounds that rather than removing it |

## The warehouse map

| Variable | Default | Effect |
|---|---|---|
| `MAP_GOOGLE_API_KEY` | *(empty)* | A Google Maps browser key. Set it — with a map ID — and the Warehouses map is a Google map: vector rendering, and whatever style the operator built in the Cloud console |
| `MAP_GOOGLE_MAP_ID` | *(empty)* | The Cloud console's map ID. **Required alongside the key**, and `env.ts` refuses to start without it: it is what carries the style, and what Advanced Markers need |
| `MAP_TILE_URL` | *(empty)* | The XYZ raster tile template behind the Warehouses map. Empty means no tiles: markers are plotted on a plain ground and everything else on the screen works unchanged |
| `MAP_TILE_ATTRIBUTION` | *(empty)* | Shown in the corner of the map. Every tile licence requires it |
| `GEOCODE_FORWARD_URL` | Nominatim | Turns a typed address into coordinates for the "look up" button. `{query}` is substituted. Empty switches it off |

**Three providers, and the panel has an implementation of each.** The
warehouses response carries a `map` field — `{ provider: 'NONE' }`,
`{ provider: 'RASTER', tiles }` or `{ provider: 'GOOGLE', apiKey, mapId }` —
and that is what decides which map library the browser downloads. A deployment
on Google never downloads Leaflet; one on tiles never fetches a line of
Google's API.

**Google wins when both are configured.** Somebody who sets a Google key on an
installation that has been running on OpenStreetMap tiles means to move to
Google, and making them also clear two other variables would give them a screen
that ignored the setting they just added.

**Empty is the default for all of them, and it is the private one.** Both
providers disclose which part of the world is being looked at, and in this
product that is where the buyer's warehouses are — so nothing is requested until
the operator asks for it. With none set the markers sit on a plain ground, the
scale bar still works, and the screen says in words that there is no background.

**Google's tiles cannot be used as raster tiles.** There is no public XYZ
endpoint and their terms forbid reaching for one, which is why Google is a
second setting rather than another value for `MAP_TILE_URL`, and why the panel
carries two map implementations rather than one. The raster path stays for the
installation behind a firewall with its own tile server, and for the operator
who will not send warehouse coordinates to Google.

**What the operator has to do in the Google Cloud console**, once, and none of
it is something this software can do for them:

1. A project with a **billing account** attached. Maps Platform does not run
   without one, free monthly allowance included.
2. **Maps JavaScript API** enabled.
3. A **browser key**, restricted — *Application restrictions* → HTTP referrers,
   listing the panel's own origin, and *API restrictions* → Maps JavaScript API
   only. The key reaches the browser and always will: the Maps JavaScript API
   has no server side, so every deployment's key is visible to anybody who
   opens the screen. **The referrer restriction is what stops it being spent
   elsewhere**, and an unrestricted key can be lifted off the page by anyone.
4. A **map ID** (Map management → type JavaScript, rendering Vector) with a
   **style** attached. The style is where the map stops looking like a default
   Google map, and it is editable in the console afterwards without touching
   this software.

A key restricted by referrer needs the browser to send one, so the panel's
document must never carry `<meta name="referrer" content="no-referrer">`. The
API's own no-referrer policy is set on API responses and does not affect this.
The map is loaded with `authReferrerPolicy: 'origin'`, so what Google is told
is the panel's origin and not the URL — this screen keeps its search and its
filters in the address bar, and none of that is Google's business.

Google rejecting a key — a referrer that does not match, billing switched off,
the API not enabled — is reported on the screen as its own state, separate from
a map that failed to load, because the two have different fixes and neither is
fixable by the person reading the panel.

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
│   │   ├── schema.prisma           ← THE DATABASE SHAPE. 86 models.
│   │   └── migrations/             29 numbered, committed SQL steps
│   ├── src/
│   │   ├── config/env.ts           ← Every setting, validated at boot
│   │   ├── domain/                 Pure rules, no I/O
│   │   │   ├── money.ts            BigInt arithmetic, rounding
│   │   │   ├── errors.ts           ← The 152 error codes
│   │   │   ├── permissions.ts      ← Roles and ~50 permissions
│   │   │   ├── order-state-machine.ts  ← Legal order transitions
│   │   │   └── schedule-state.ts   ← Legal plan and occurrence transitions
│   │   ├── infra/                  Database, crypto, ids, queue, email, storage
│   │   ├── http/
│   │   │   ├── app.ts              ← Plugin order, CORS, raw body, error envelope
│   │   │   ├── server.ts           Entry point
│   │   │   ├── openapi.ts          Hand-written summaries over the live route table
│   │   │   └── routes/             26 route files
│   │   ├── modules/                ← The business logic
│   │   │   └── customers/          Profiles, registration, limits,
│   │   │                           contact-change, account-closure, wishlist
│   │   ├── worker/                 The background worker
│   │   └── seed/                   Development data
│   ├── tests/                      Unit and integration tests
│   └── docs/                       RUNBOOK, EU-VAT, DATA-PROTECTION, ...
│
├── apps/customer-web/src/
│   ├── app/router.tsx              ← Every storefront page
│   ├── app/ThemeProvider.tsx       Light, dark, or match the device
│   ├── pages/                      One file per page
│   │   ├── AiModePage.tsx          ← AI Mode, the assistant as a page
│   │   ├── ai/                     Its sidebar, composer and message
│   │   ├── ConfirmContactPage.tsx  Where a contact-change link lands
│   │   └── account/                ← The account area: its frame, its
│   │                               sidebar table, and every panel
│   ├── components/                 Shared UI
│   │   ├── greeting/               The sourcing hub
│   │   ├── hero-search/            ← The front page's search module
│   │   ├── home/InlineProducts.tsx The catalogue, on the greeting page
│   │   ├── market/MarketMenu.tsx   ← Language, country and currency, in one
│   │   ├── account/AccountMenu.tsx The header's account dropdown
│   │   ├── ThemeToggle.tsx         The appearance control, in both apps
│   │   └── CountryFlag.tsx         Every served market, drawn in SVG
│   ├── lib/pointer-tilt.ts         The product card's lean, in four CSS vars
│   ├── lib/pointer-zoom.ts         Where the pointer is, for the image magnifier
│   ├── lib/camera.ts               The device camera, as one still photograph
│   ├── components/ProductRow.tsx   A product as a listing row, with its specs
│   ├── lib/api.ts                  ← The single HTTP helper
│   ├── lib/voice-search.ts         Dictation, on the browser's own engine
│   ├── lib/image-search.ts         Upload rules, and the search call
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
| Change how a product card behaves on hover | `lib/pointer-tilt.ts` for the maths, `.tilt` / `.tilt-sheen` in `index.css` for the look |
| Change the product image magnifier | `lib/pointer-zoom.ts` for the maths, `.zoom-layer` in `index.css` for the scale and the easing |
| Change how a photograph is taken or what it is taken as | `lib/camera.ts` — the constraints, the JPEG quality, and every path that releases the device |
| Change what image search accepts | `lib/image-search.ts` in the browser **and** `UPLOAD_MAX_BYTES` plus the magic-byte sniffer on the API; the browser's checks are for speed, the server's are the control |
| Change what a category listing looks like | `pages/CatalogPage.tsx` for the rail, the sort bar and the layout; `components/ProductRow.tsx` for one row |
| Change how many specs a listing row shows | `SPECS_SHOWN` in `components/ProductRow.tsx` |
| Change what focus looks like | the `:focus-visible` rules in `index.css` in **both** apps — text fields are deliberately excluded from the ring |
| Change the hero band's height or how its two columns align | `pages/HomePage.tsx` — the comment on the grid says what each value is holding |
| Change the front page search bar, or the AI Mode link above it | `components/hero-search/HeroSearch.tsx` |
| Change the catalogue's filters or facets | `FilterFields` in `pages/CatalogPage.tsx`; the facet list itself is the administrator's, from `/catalog/filters` |
| Change a colour | `src/index.css` in **both** apps — the light block and the dark one — then `npm run audit:contrast` |
| Add a theme option, or change what the appearance control does | `app/ThemeProvider.tsx` and `components/ThemeToggle.tsx` in both apps, plus the inline script in each `index.html` |
| Change what AI Mode looks like | `pages/AiModePage.tsx` and `pages/ai/` |
| Change how a photograph is matched to products | `backend/src/modules/assistant/image-search.service.ts` |
| Move a control in the storefront header | `apps/customer-web/src/layout/Header.tsx` — the comment beside each breakpoint says what it is holding |
| Change what the language/country/currency control offers | `components/market/MarketMenu.tsx`; `/account/region` asks the same three questions and both go through `LocaleProvider.choose` |
| Add or correct a flag | `components/CountryFlag.tsx` — bands plus at most one mark; an unlisted country falls back to a letter chip |
| Add a destination to the account menu **and** the account sidebar | `pages/account/account-nav.ts` — one table, both surfaces |
| Change what the account dropdown looks like | `components/account/AccountMenu.tsx` |
| Change the account area's frame or its sidebar | `pages/account/AccountLayout.tsx` |
| Add a panel to My Profile | `pages/account/ProfileInformationPage.tsx`, using `AccountPanel` / `PanelRow` |
| Change how an email address or telephone number is confirmed | `modules/customers/contact-change.service.ts`; the link lands on `/confirm-contact` |
| Change what closing an account does | `modules/customers/account-closure.service.ts` — and remember erasure is a data request, not this |
| Change what a saved line shows or costs | `modules/customers/wishlist.service.ts` for the read, `pages/account/WishlistPage.tsx` for the screen |
| Pin an action bar to the bottom of a phone screen | `components/StickyBottomBar.tsx` — it publishes `--page-bottom-bar` for anything that has to clear it |
| Change which language a country's staff read | the `countries` row's `languageCode` |
| Add or move a warehouse | `/warehouses` in the panel; `modules/inventory/location.service.ts` |
| Put a background behind the warehouse map | `MAP_GOOGLE_API_KEY` + `MAP_GOOGLE_MAP_ID`, or `MAP_TILE_URL`, in `backend/.env` |
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
