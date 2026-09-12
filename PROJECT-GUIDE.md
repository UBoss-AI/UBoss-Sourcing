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
   - [9.3.2 Choosing a fulfilment warehouse](#932-choosing-a-fulfilment-warehouse)
   - [9.5 Scheduled orders — Buy Later and Subscribe & Reorder](#95-scheduled-orders--buy-later-and-subscribe--reorder)
   - [9.5.1 Autopay: charging a card nobody is looking at](#951-autopay-charging-a-card-nobody-is-looking-at)
   - [9.5.2 The ERP hand-off](#952-the-erp-hand-off)
   - [9.8 The ERP connection, and Autopay](#98-the-erp-connection-and-autopay)
   - [9.8.1 The customer’s own ERP](#981-the-customers-own-erp)
   - [9.9 A customer changes the address they sign in with](#99-a-customer-changes-the-address-they-sign-in-with)
   - [9.10 A customer closes their own account](#910-a-customer-closes-their-own-account)
   - [9.11 Loading a supplier product sheet](#911-loading-a-supplier-product-sheet)
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

The warehouse map's basemap does not follow the theme either, and
`WarehouseMap.tsx` says why: the imagery is the operator's, and the usual
shortcut — a CSS `invert()` over the map — turns their basemap into a
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
| `/cart` | The basket — the **Instant Buy** tab | **Yes** |
| `/accounts/schedule` | Schedule Cart: the standing orders, and where one is changed | **Yes** |
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
| `/account/integrations/erp` | Connect your own ERP — twenty named systems or any documented API; health, logs, approvals, team | Integrations |
| `/account/integrations/erp/new` | The six-step setup wizard | — |
| `/account/integrations/erp/:id` | One connection: health, activity, approvals, deliveries | — |
| `/account/integrations/erp/oauth/callback` | Where the buyer's own ERP sends them back after they authorise. Registered with that ERP, so not renameable on its own | — |
| `/account/erp` | Redirects to `/account/integrations/erp` — an old bookmark | — |
| `/account/coupons` | Codes available, and codes used | My stuff |
| `/account/wishlist` | Lines saved without buying them | My stuff |
| `/account/notifications` | A record of what has been sent to this account | My stuff |

**Schedule Cart is a sibling of the cart, not an account page.** `/cart` and
`/accounts/schedule` are two ways to spend a basket, so they share the cart's
full-width frame and are linked by a two-tab control at the top of both.
Dropping the workspace into the account section would open it with a settings
sidebar beside a list beside an editor — three columns of chrome around the one
the buyer came for. `/account/schedules` stays exactly where it was and is
still where a standing order is *read*: its delivery history, its payment
arrangement, pausing it. The workspace is where one is *changed*, and the plan's
own page links to it.

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
- **ERP used to explain itself to everybody and no longer does.** It had no
  customer screen for a long time, because a connection is a URL plus a
  credential this server then calls. It has one now — a buyer connects their
  *own* NetSuite, SAP, Tally, TCS iON or in-house system at
  `/account/integrations/erp` — so
  the node links there behind the same sign-in branch as the rest. See 9.8.1.

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
| New chat | The greeting: a name, and one question |
| Conversation history, most recent first | Five suggested starters |
| Rename a thread | The transcript, with the reply streaming in |
| Delete a thread (asks first) | Composer: text, attach, voice, Send / Stop |
| Collapse the rail | Copy and **Ask again** under a finished reply |
| The account, and Sign out | The AI disclosure and the retention notice |

### The greeting

Two lines, and nothing else above the starters:

> **Hello, Priya**
> **What are you looking for today?**

The name is the first word of the name on the account, read through the same
`useAccountIdentity` hook the header button and the account sidebar use — so
this page greets somebody by exactly the name they are greeted by everywhere
else, and on a signed-in visit it usually costs no request at all. Where there
is no name — a guest, an account with the field blank, a read still in flight —
the name line is simply absent and the question stands on its own. It is
**never** derived from the email address: a purchasing account is routinely
`ops.procurement@`, and "Hello, Ops" is worse than no greeting.

What this replaced was a heading and a four-line paragraph explaining what the
assistant could be asked and where its answers came from. All of it true, none
of it read: somebody who has opened a chat has already decided to type, and an
onboarding paragraph between them and the composer is a thing to scroll past.
The five starters below say what can be asked by being askable, which is a
better answer than a sentence claiming it.

### Product cards in an answer

When a reply is about particular products — details, a recommendation, a
comparison, a stand-in for something unavailable — the products appear as cards
under the words, with the name, the product code, the short description, the
price, the availability, **View specifications** and **Add to cart**.

**The words are the lead and the cards are the answer.** The system prompt asks
for one or two sentences — about thirty words, fifty at the outside — and
forbids walking through the products one at a time in prose. A name, a product
code, a price, a pack size or a stock figure that a card already shows is not
repeated above it, and a product on the reference line gets no `/product/…`
path in the text either: the card *is* its link, and a path beside it is the
same thing said twice. What the sentence is for is the part a card cannot
carry — what was found, or what separates one from the next. Where somebody
asks for one specific figure they are told it plainly; the rule is against
reciting a card, not against answering.

**A card is one wide row, not a tile.** The words are on the left and the
photograph is a fixed square down the right-hand edge, and the cards stack one
per row at every width. A reply names products in a line of prose, and a grid
of tall tiles with the photograph across the top pushed the rest of the
transcript off the screen — three products meant three pictures before three
names. Beside the words the picture is a glance rather than the loudest thing
in the answer. The source order is words first, so a screen reader reaches the
product's name before its picture, which is the same order the eye takes.

**The one thing taken from generated text is an identifier.** The system prompt
asks the model to end such an answer with a single reference line of its own:

```
[[products: nitrile-examination-gloves, sodium-chloride-flush]]
```

The storefront strips that line from what is read, takes the slugs, and asks
`GET /api/v1/catalog/product-cards` for them. Everything on the card is what
that endpoint answers, read from the database under the same visibility filter
every storefront read uses. So:

  - a product code the model invented produces **no card at all**, and the
    reader is told how many references could not be resolved rather than
    quietly shown fewer cards than the answer mentioned;
  - an unpublished product cannot appear, even by guessing its slug;
  - there is no path by which a URL that arrived in generated text reaches an
    `img src`.

On a catalogue of cannulae and feeding tubes that is not a stylistic
preference. A hallucinated product code with a confident price beside it is
somebody ordering the wrong device.

Two details that follow from the same rule. The half-arrived reference line is
hidden while it streams, because watching `[[products: nitrile-examin` type
itself out under an answer looks exactly like a broken renderer. And **Copy**
copies what is on screen rather than what arrived, so a procurement office
pasting a reply into a requisition does not find machinery in the middle of it.

The cards mount only under a *finished* reply. Mounting mid-stream would fire a
catalogue read for whatever slugs had arrived so far and another for each
further one, rebuilding the row under a reader three or four times.

A reply that names no products renders no heading and makes no request. Most
replies are of that kind.

**Add to cart steps aside for the two cases a card cannot decide.** A product
with options needs one chosen, and a guest has no cart to add to; both get a
link to the product page, where the next step is offered in context, rather
than a button that can only fail. Otherwise the card adds the smallest legal
quantity — the minimum, clamped to the increment — because a card has nowhere
to ask for a number.

**The reference line is a fallback away from being needed.** Where the model
writes none, the `/product/…` paths already in the prose are used instead;
those are the same references in a plainer shape, and they are already links in
the transcript. Where a reference line *is* present it wins outright, because
it carries the model's own ordering — which is its recommendation — and mixing
in wherever a link happened to fall in a sentence would silently re-order it.

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

## The cart: Instant Buy and Schedule Cart

The basket opens with two tabs above the heading, and they are the only two
things you can do with it:

| Tab | Where it goes | What it is |
|---|---|---|
| **Instant Buy** | `/cart` | The cart the storefront always had. The default, because it is what most people came for |
| **Schedule Cart** | `/accounts/schedule` | The standing orders: several independent plans, each with its own products, dates and ending |

Nothing about Instant Buy changed. Same lines, same server-owned totals, same
checkout button; the tab names what was previously unnamed and names the
alternative, which used to be a link two screens down the summary panel.

**They are links, not a tab panel**, and the distinction is not pedantry: they
lead to two different routes, so a `role="tablist"` would promise a screen
reader that the content below swaps in place when in fact the page navigates. A
navigation region with `aria-current="page"` says what is true and comes with
working middle-click, open-in-new-tab and back button. The selected state is
carried in the markup as well as in the fill, because a control whose state
lives only in a background colour is invisible to a screen reader and to
anybody who cannot tell the two blues apart.

The row appears on the **empty** cart too. Somebody with nothing in their
basket is exactly the person who has not yet found out that a standing order is
on offer, and a control that appears only once there is something to buy is one
they meet too late.

It appears at all only where the second destination exists. A deployment with
`recurringOrders` off has one way to spend a basket, and a tab leading to a
screen that explains the feature is switched off teaches the customer that the
navigation lies — the same rule `account-nav.ts` follows.

## The cart: where this can ship from

Under the order summary, the basket carries a **Where this can ship from**
panel. It is the buyer's half of [geofencing](#geofencing-how-far-a-warehouse-reaches-and-where-it-refuses-to-go):
the same geometry the admin panel's ring is drawn from, read from the other end
— *my* country is fixed, and I want to know who can serve it, when, and for how
much.

A buyer's country is often inside more than one warehouse's reach, and those
warehouses do not offer the same thing: one is two days away and charges for
it, another is five days away and free. Each option says where it ships from,
when it would arrive and what delivery costs, and the soonest and the cheapest
carry a chip. Nothing is preferred on the buyer's behalf beyond ordering the
list soonest-first — which of "two days for €12" and "five days for nothing" is
better is their call, and software that chose would be software spending their
money.

**Four things the panel refuses to do.**

  - **It never invents a promise.** A warehouse whose lead time or fee nobody
    has published is shown with the terms it actually has, which is none, said
    in words. "3-5 days, free" printed because a field was null is a promise
    this software made up.
  - **It does not hide the near miss.** A warehouse in range that holds only
    part of the basket appears under its own heading, naming the lines it is
    short of and by how much. Dropping it would leave a buyer wondering why the
    depot in their own city is missing; offering it as available would break
    the order at the picking face.
  - **It says nothing about why a country is closed.** The server sends a count
    and no reasons. The panel can therefore distinguish "none of our warehouses
    is close enough" from "we do not deliver there" — two different sentences
    with two different next steps — and nothing more. An operator's note about
    customs paperwork is theirs, not the buyer's.
  - **It never claims to have changed the total.** Choosing an option records a
    preference and says so: delivery on the order is still charged at the rate
    in the summary above, because a warehouse's own fee is not wired into cart
    pricing or fulfilment. A screen that quoted one figure and charged another
    is the single worst thing a checkout can do, so this one says which of the
    two is being charged.

**A warehouse is offered only when all four hold**: it is active, it can ship
today (`OPERATIONAL` or `LIMITED` — never `MAINTENANCE` or `SUSPENDED`, and
`LIMITED` says so on the card), its own radius reaches the destination country,
and the operator has not closed that country on it.

The endpoint is public and uncached — see [§8](#8-the-api). A buyer asks "can
you get this to Belgium, and when" before they have an account, and
availability is the input that moves fastest in the whole system.

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
| `/settings` | Settings | Business profile, policy links, tax, shipping, currencies, notifications |
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
| `deliveryRadiusKm` | How far this warehouse promises to deliver. Null means "use `DELIVERY_COVERAGE_RADIUS_KM`" — not zero, and not "no radius" |
| `deliveryLeadTimeMinDays`, `deliveryLeadTimeMaxDays` | How long delivery from here takes, as a range. Both or neither |
| `deliveryFeeMinor`, `deliveryFeeCurrency` | What delivery from here costs. `BigInt` minor units with its own currency, like every other amount |

Plus one table of its own: **`warehouse_country_exclusions`** — one row per
country this warehouse will not deliver to, with the operator's reason. See
"Reachable and offered" below for why that is a separate decision from the
radius, and the [database chapter](#7-the-database) for why it has no foreign
key to `countries`.

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
Four providers — a Google map, a vector style, raster tiles, or nothing — and
with none of them configured the map still works: it pans, zooms, carries a
scale bar and places every marker correctly relative to the others. It just has
no picture of the ground behind it, and the screen says so. That default is
deliberate: every other provider tells whoever serves it which part of the
world is being looked at, and in a self-hosted product that is where the
buyer's warehouses are. Nothing is sent anywhere until the operator asks for
it. See [Configuration](#14-configuration).

**Which provider decides what language the place names are in**, and that is
the difference an operator notices first. A raster tile arrives as a finished
picture with the names already painted into it, **in whatever language is local
to that place** — so a panel used from Pune reads Ελλάς for Greece, 中国 for
China and Deutschland for Germany, and nothing in the browser can change a
word of it. A vector tile arrives as data instead: every place carries `name`,
`name:en`, `name:de`, and `labelInEnglish` in `WarehouseMapLibre.tsx`
repoints every label on the map at the English one. A deployment whose staff
read one language and whose warehouses are in eight countries wants
`MAP_STYLE_URL`.

**What the screen deliberately does not show is a valuation per warehouse.**
Product prices here are per currency, so adding up the SKUs in one building
would put rupees and euros in the same total and print it as though it meant
something. Units are what a warehouse holds; money belongs on the screens that
know which currency they are quoting.

**Two map implementations, and the operator's settings choose.**
`WarehouseMap.tsx` does nothing but pick between them: Google Maps where a key
and a map ID are configured, MapLibre GL for the vector style, the raster tiles
and the no-background default. Each one's library loads by dynamic `import()`
inside its own module, so it lands in its own chunk — a deployment on Google
never downloads MapLibre, one on OpenStreetMap never fetches a line of Google's
API, and somebody who opens this screen to correct a postcode downloads
neither. What a marker looks like lives in `warehouse-marker.ts`, shared by
both, so the two maps cannot drift apart. See §14's warehouse-map settings for
why Google cannot simply be another style or tile URL.

MapLibre covers three of the four providers because it draws all three from one
style: the vector path is the operator's style URL, the raster path is a
one-layer style over their XYZ source, and no background is a style with no
sources at all — a real, working map with nothing in it. They stay separate
*providers* rather than one setting because only the vector one can be
relabelled, which is the reason an operator would move between them.

**MapLibre is a WebGL renderer and it is not small** — around 285 kB gzipped,
against roughly 45 kB for the raster-tile library it replaced. That is why the
dynamic `import()` matters more than it used to rather than less: it is in a
chunk of its own, it is fetched by the Warehouses screen and by nothing else,
and a deployment on Google or a member of staff who never opens Warehouses
never pays a byte of it. The trade bought the labels, which no raster library
can give at any size, and it also removed a second map library from the panel.

**Finding one.** The search matches the name, the code **and the country's
name** — somebody hunting for the Greek warehouse types "greece", not "GR" —
and it runs on the server, which is the only place that join is available.
Alongside it are an operational-status filter and a country filter. All three
live in the URL, the way the Dashboard's reporting window does, so a colleague
can be sent the address bar.


## Clicking a warehouse: what is actually in it

Every warehouse row and the detail panel carry an **Inventory** button, and it
is the primary action on both — somebody who clicked a warehouse is far more
often asking what is in it than correcting its postcode. It opens a
full-width panel of everything that warehouse holds.

**The list is the catalogue, not the balance rows**, and that is the whole
reason this is not a filter on the Inventory screen. `/inventory?locationId=`
pages over `inventory_balances`, so a product the warehouse has none of has no
row and is simply absent — and absent is indistinguishable from "not in the
catalogue". The product a warehouse manager opens this screen to find is
usually the one that ran out. So every product in the catalogue appears for
every warehouse, at zero where that is the answer, and a product added this
morning is in every warehouse's list this afternoon with nothing to backfill.

**No balance row and a zero balance are the same quantity and different
provenance**, and the panel says which. No row means stock has never been
booked here; a zero row means it has and has run out. "We have never stocked
this in Antwerp" and "Antwerp is out of it" are two different conversations
with a buyer.

**Two views, and both are the real one.** The **shelf** is the default: the
warehouse drawn as a wall of product plates in real CSS 3D — each card in its
own perspective, turned on a resting angle and turning further towards the
pointer, its photograph, name and quantity on their own planes off the plate,
and a shadow cast on the wall behind it. A warehouse *is* a physical place, and
a flat table of numbers is the one representation that never says so. The
**table** is one row per stock-keeping unit, dense, and it is what somebody
counting stock actually wants; a screen that only offered the shelf would be a
screen people stopped using by Wednesday.

**A transform above a button must not change between the press and the
release**, and that is the rule the card is arranged around rather than a
stylistic preference. When it does change, the hit region moves out from under
a cursor that has not moved, the browser fires `click` on the nearest parent —
which has no handler — and the *Show all SKUs* disclosure silently does not
open, then works on the second press. Two things kept moving it, and each has
its own answer rather than being deleted:

  - **The turn that follows the pointer** is *frozen for as long as a pointer
    is held down*. The card holds the pose it was in while it is being pressed,
    which is what a physical object does anyway.
  - **The design system's own `Button`** carries `active:translate-y-px` and
    transitions `transform`, so pressing one starts a one-pixel move all by
    itself. One rule in `apps/admin-web/src/index.css` neutralises that press
    inside a shelf card and nowhere else. It sits **outside every `@layer`**,
    and that is the mechanism: Tailwind's utilities live in `@layer utilities`,
    and in the CSS cascade an unlayered declaration beats any layered one
    whatever its specificity — so this is the only way to override it without
    `!important`. Only the transform is touched; the press still changes
    colour and the focus ring is untouched.

Either fix alone leaves the click swallowed. The event log that finally named
it, and a third arrangement that cannot be made safe at all — a rotated plate
*behind* upright content, where paint order follows Z rather than DOM order, so
the half leaning forward covers the text — are recorded at the top of the
`.shelf-*` block.

The 3D is decoration and is built so that it can be: every card is a real
heading with real buttons, every number is in the text and not only in a bar's
length, and `prefers-reduced-motion: reduce` collapses every plane so the grid
is an ordinary one.

**Grouped by product, paged by product.** A product with variants holds its
stock per variant, so a flat list of SKUs would repeat one name twenty times
down the screen; the group carries the roll-up somebody scanning reads, and the
SKUs inside it are what they act on. Paging by product means a page boundary
never falls inside one product's variants.

**The footer describes the building, not the list.** SKUs, units on hand,
available and low-on-stock are measured across the whole warehouse and do not
move when somebody types in the search box — a total that did would be read as
the warehouse's and be wrong. The count of what the filter matched is the
pager's.

**Nothing on this panel writes.** Receipts and adjustments belong on the
Inventory screen, where the movement ledger they append to is on the same page,
and each SKU here links across to it. A quantity somebody could type over on
this screen is the audit trail that explains where stock went, quietly erased.

Products that are not stock-tracked are listed and labelled rather than hidden:
a made-to-order item genuinely has no quantity anywhere, and leaving it out of
a screen headed "everything in this warehouse" would have somebody hunting for
a product that is deliberately absent from the numbers.

## Geofencing: how far a warehouse reaches, and where it refuses to go

**"Delivers to": which countries a warehouse can actually reach.** Point at a
marker and the map tilts in over a glowing ring, stands the part of each
country inside it up as a translucent 3D block, draws a curved route to the
nearest point on each border, and opens a stack of glass flaps listing them —
country, flag, and how far that border is. Move away and the camera returns to
the overview.

**The map is a globe.** At the overview zoom MapLibre draws the world as a
sphere rather than a Mercator rectangle, which is the projection the screen's
question deserves: "which countries does this warehouse reach" is a question
about a sphere, and Mercator answers it while lying about the answer — it
inflates everything away from the equator, so the same 500 km drawn near
Gdańsk covers visibly more of the picture than it does near Athens. The list
beside the map was always measured geodesically and was right either way; the
*picture* was the half that disagreed with it. It also fixes the thing an
operator notices first: on a flat world at the zoom that fits four European
warehouses, most of the world is off the edge. A **globe/flat toggle** sits
under the zoom buttons, and a deployment with no basemap configured stays flat
— a sphere with nothing drawn on it is a dark ball nobody can orient.

**The blocks encode proximity.** The nearest country stands highest, so the
answer can be ranked by looking at it rather than by reading six distances.
MapLibre eases from globe into Mercator as the camera flies in, so the coverage
view lands flat and pitched with the extrusions standing up correctly.

**The whole value of it is that the list is measured, not guessed**, and the
two cheap ways to produce it are both wrong in ways nobody would notice on
screen:

  - **A neighbours table is too generous.** Belgium borders Germany, so a
    lookup puts Germany in the answer for a warehouse in Antwerp — which is
    150 km from the German border and cannot be reached inside 100 km.
    Somebody quotes a customer on that.
  - **A country centroid is too shy.** The centre of France is 450 km from a
    warehouse in Basel; the border is 2 km away. Reduce a country to a point
    and the feature refuses deliveries that are twenty minutes down the road.

So a real geodesic circle is intersected with real country polygons — Natural
Earth at 1:50m, travelling with the repository as an npm dependency because
this software is installed behind other companies' firewalls. The distance
reported is to the country's **nearest border**, which is the only distance a
delivery radius cares about. See §14 for the endpoint and the radius setting,
and `backend/src/domain/country-boundaries.ts` for why 1:50m and not the
coarser or finer cut of the same data.

**An empty answer is an answer.** A warehouse in central Spain reaches no
foreign border inside 100 km — the nearest is Portugal at 244 km — and the
panel says exactly that rather than offering Portugal because it is closest.
The country the warehouse itself stands in is reported separately from the ones
it reaches, which is what makes the empty list mean one thing and one thing
only.

**The radius belongs to the warehouse.** Each one carries its own
`deliveryRadiusKm`, because the reach of a building is a fact about the
building: a port warehouse with its own fleet covers 800 km, a city depot
handing over to a courier covers 150, and one number for the whole business
would have to be the smallest of them. A warehouse with none set falls back to
`DELIVERY_COVERAGE_RADIUS_KM` — which is what lets an operator move the whole
business's promise by changing one line, and still override the two buildings
that are different.

**The same number is three different statements, and the panel says which.**
"This warehouse promises 500 km", "nobody has said, so the deployment's 500
applies", and "you are trying 800 out on a warehouse that promises 300" are the
three, and `radiusSource` on the answer is what tells them apart. An operator
setting up their second warehouse needs to know which one they are looking at.
The endpoint accepts any radius up to 1,000 km for the trying-out case; a
warehouse's own is capped at 2,000 km, which is the point past which a circle
intersects most of a continent and stops meaning anything.

**Reachable and offered are two different facts, stored separately.** The
radius says what geometry can reach; the closed-country list says what the
business will serve. A 500 km circle around Antwerp reaches the United Kingdom
whether or not this deployment has a customs broker for it. Keeping the two
apart is what stops a radius raised next year from quietly re-opening a country
somebody deliberately shut — and it is why the warehouse form has both a
radius field and a country picker rather than one control.

**A closed country stays on the map.** It is shaded and edged in the refusing
colour, struck through in the list, carries a **Closed** chip and the
operator's reason, and its block stands lower than the served ones. Dropping it
would make it indistinguishable from a country forty kilometres too far away —
and the first is a decision somebody made and may want to undo, where the
second is a fact about the ground. The one thing a closed country does *not*
get is an arc: the arc carries a light that travels out along it, which reads
as a van leaving, and animating a delivery to a country this warehouse will not
deliver to would be the map lying about the thing it is for.

**Exclusions outside the radius are kept and listed as dormant.** A radius
grows; somebody who closed Switzerland at 300 km has said something that must
still hold at 800, so the row is never tidied away for being inactive. Listing
them is also how an exclusion added to the wrong warehouse gets found before
the day it starts to bite.

**A warehouse may be closed in its own country.** Rare and entirely
legitimate — a bonded site serving export markets only, or one whose domestic
sales go through a distributor — so the home country carries the same flag as
every other rather than being assumed served.

**The country picker is the ISO list, not the `countries` table.** That table
is the list of markets this deployment *prices in* — a few dozen rows, each
needing a currency behind it — and it is the right list for "which country is
this warehouse in". A 500 km circle reaches countries nobody has ever sold
into, and those are exactly the ones an operator most wants to close, so the
exclusion picker offers all two hundred and fifty and the rows carry no foreign
key. See `GET /inventory/world-countries` below.

**The gesture depends on the input device, not the screen width.** With a real
pointer, hovering shows the coverage and moving away puts it back. With no
pointer there is no "moving away", so the tap that selects a warehouse opens
the coverage and the panel grows a close button. `(hover: hover) and (pointer:
fine)` is what decides, because a laptop with a narrow window still has a mouse
and a large tablet still does not.

**Opening is deliberate and closing is forgiving, which are two different
numbers.** A marker has to be held for **140ms** before anything is requested,
so dragging the map past five markers does not fire five requests and five
camera flights. Leaving only *schedules* the close, **260ms** later, and three
things cancel it: arriving at another marker, coming back to the same one, and
the pointer reaching the panel. That last one is what makes the panel readable
at all — it is in the far corner of the map with a button on every country in
it, and closing the instant the pointer left the marker took the answer away
during the journey towards it. The same delay is why moving from one marker to
its neighbour changes the subject in one step instead of blanking the map
between them. On the way out the panel fades and slides over 200ms rather than
vanishing, holding the answer it was showing while it goes.

**The markers are built once and changed in place.** Pointing at one used to
rebuild every marker on the map — which blinked, and, on the marker under the
cursor, threw away the hover the browser was tracking, so clicking a marker
closed the coverage it had just opened. The pulse and the selection ring are
now switched on the elements that are already there.

**It is reachable without a pointer at all.** The map is `aria-hidden` — the
table below it is the accessible copy of everything on it — so no marker can be
focused and hovering is not a gesture a keyboard has. The detail panel carries
a *Delivery coverage* button, and from there every flap is a real `<button>` in
the tab order. The flap panel itself is deliberately outside the hidden
subtree: it is the only place the answer exists in words.

**Under `prefers-reduced-motion: reduce` the feature is complete and still.**
The camera jumps instead of flying and stays flat, the ring does not pulse, the
light does not run along the routes, and the flaps appear without flipping.
Nothing is missing, which is the test of whether the motion was information or
decoration.

**Only the MapLibre providers draw it.** The ring, the shaded countries and the
arcs are MapLibre sources and layers; the Google map is a different renderer
with a different API for all three, and a second implementation of the same
picture would drift from the first. On a Google deployment the button is
*absent* rather than present and inert — a dead control is worse than a missing
one, because the reader cannot tell whether they misunderstood it or whether it
broke. `supportsDeliveryCoverage` in `lib/warehouses.ts` is what the page asks.

**Clicking a marker opens a side panel** with the whole record: the address,
the coordinates, the local time at that warehouse, the stock roll-up, the
delivery promise with its closed countries, and where it stands with the ERP.
A panel rather than a map popup, because a popup has to fit inside the map and
would either cover the markers around it or truncate what it says. On a desktop
it sits beside the map; below `lg` the page stacks and it lands underneath.

**And it scrolls itself into view when it opens.** The panel lives beside the
map; the *Details* button that opens it is in the table below the map, which on
this screen is around nine hundred pixels further down the page. Pressing it
therefore did the whole job and looked like it had done nothing — the row
tinted, the record rendered, and every pixel of it was off the top of the
screen. It aligns its own top to the viewport, and only when that top is not
already somewhere a person could read it, so a tall monitor showing the map and
the table at once is left alone.

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
| `POST /inventory/warehouses` | `inventory.location.write` | Opens one. Country required. Also takes the geofence: `deliveryRadiusKm`, the lead-time pair, `deliveryFeeMinor`/`deliveryFeeCurrency` and `excludedCountries` |
| `PATCH /inventory/warehouses/:id` | `inventory.location.write` | Corrects, moves, retires or promotes one. Absent fields are left alone; explicit `null` clears one. `excludedCountries` replaces the whole set — `[]` clears it, absent leaves it |
| `GET /inventory/warehouses/:id/inventory` | `inventory.read` | Everything this warehouse holds, product by product, driven from the catalogue so a product it has none of is still listed. Takes `q`, `categoryId`, `presence` (`ALL`/`IN_STOCK`/`OUT_OF_STOCK`/`LOW_STOCK`/`NEVER_STOCKED`), `page`, `limit`. Pages by product, never splitting one product's variants. Totals describe the warehouse, not the filtered list |
| `DELETE /inventory/warehouses/:id` | `inventory.location.write` | Removes one that was never used. Refused for the default, and for any warehouse a balance, movement, reservation or scheduled order names. 404 for a warehouse already gone, which is also the answer to a second press |
| `PUT /inventory/warehouses/:id/erp-status` | `inventory.location.write` | The connector reports where the warehouse stands with the ERP |
| `POST /inventory/warehouses/geocode` | `inventory.location.write` | An address to coordinates. A POST so the address stays out of access logs |
| `GET /inventory/warehouses/:id/delivery-coverage` | `inventory.read` | Which countries this warehouse reaches, measured against real country boundaries. `radiusKm` is **optional**: omitted, it measures what the warehouse actually promises and `radiusSource` says whether that came from the warehouse or the deployment default; passed, it answers a hypothetical and says so. Ceiling 1,000. Returns the home country separately from the ones reached, each with its nearest-border distance, the point it was measured to, whether the operator has closed it and why, plus the ring itself as geometry and any dormant exclusions. 422 `LOCATION_NOT_PLACED` for a warehouse with no usable coordinates |
| `GET /inventory/warehouse-countries` | `inventory.read` | The countries a warehouse may be **in**, from the `countries` reference table, for the pickers |
| `GET /inventory/world-countries` | `inventory.read` | Every country there is, from the ISO 3166-1 list, for the closed-country picker. A different list from the one above and deliberately so — see "The country picker is the ISO list" |
| `GET /inventory/locations` | `inventory.read` | The *pickers'* list — active only, no stock roll-up. Deliberately not the same endpoint |

The `DELETE` is narrow on purpose and cannot be widened by a parameter: the
four tables that reference a warehouse do so with `onDelete: Restrict`, so a
row with any history behind it stays whatever the caller asks. It leaves one
`inventory_location.deleted` entry in the audit log carrying the whole record —
code, name, country, position — because after the write there is nothing left
to look the warehouse up in.

## Settings → Policy links

The terms, privacy and returns pages this business publishes. A label and an
address each, in the order they are arranged, stored as one JSON object in
`business_profiles.policy_links_json`.

They are read in three places, which is why this is a setting and not a page
of copy somebody edits:

- the storefront footer;
- beside the terms tick on the storefront’s sign-in screen;
- beside the terms tick on the panel’s own sign-in screen.

All three read `business.policyLinks` from the public `GET /api/v1/config`, so
a link added here appears in all of them without a redeploy. A deployment that
sets none shows no links — and the terms tick is still required, because what
is accepted is the contract, not the web page.

**Three rules, and each one exists because it loses data quietly.**

- **The label is the key.** The backend stores an object, so two rows sharing
  a label are one row by the time it is written and the second silently
  replaces the first. The panel refuses to save that rather than letting
  somebody find a missing link a week later.
- **The address must be `http://` or `https://`.** Enforced on the server,
  not only in the form: a `javascript:` policy link would be stored XSS on
  the storefront footer. The server keys its refusal by label, so the message
  lands on the row it is about.
- **A blank address is a deletion.** The server drops any entry whose address
  is empty, which is a real way to lose a link by tabbing through a form. So
  the panel validates every row before the request, and removal is a button
  somebody presses.

The write is `PATCH /api/v1/admin/settings/policy-links`, needs
`SETTINGS_WRITE`, replaces the whole set, and goes through
`updateBusinessProfile` — so it lands in the audit log like any other change
to the business profile. Staff without `SETTINGS_WRITE` see the rows and no
controls.

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
| `locationPlace` | The geocoded place, or the coordinates when no geocoder answered | A row in the **top bar's locale panel**, under *Signed in from* |
| `locationCountry` | ISO-3166-1 alpha-2, or null | The market every price in the panel is quoted for |
| `locationCurrency` | What `countries.currencyCode` says that market pays in, or null | Which per-currency price list every customer-facing figure is read from |
| `locationLanguage` | What `countries.languageCode` says an office there reads, or null | The interface language, once per sign-in country |

The top-bar chip exists because the bell announces a sign-in once and has
scrolled away by the afternoon. A console shared by several staff accounts —
and a laptop handed around a warehouse — should still be able to say which
sign-in is on screen. It shows the first two parts of the geocoded name with
the whole string in its tooltip, and it renders nothing at all when the browser
told the session nothing.

**All of it is one control in the top bar now.** The place, the market and the
language switch were three separate chips: a `<select>`, a location chip and a
market chip. They answer one question between them — *where am I, and what am
I reading?* — and three of them in a bar that also carries the page title, the
notification bell and the account menu is why the account menu was the first
thing to be squeezed on a laptop. The storefront had the same problem with
three `<select>`s and one control was the answer there too, so the panel now
uses the same shape: the country's flag, the language code, a chevron, and a
panel underneath.

It uses the **same drawn flags as the storefront** — `CountryFlag`, copied
across like `ui.tsx` and `icons.tsx` before it, because a country drawn two
ways in one product is one country too many. A correction goes in both files
or it has not been made.

What the panel holds, and the distinction is the whole point:

| In the panel | What it is |
|---|---|
| Language | A **choice**, as chips, each named in its own language |
| Prices shown for | A **label**: the country and its currency |
| Signed in from | A **label**: the short place, with the full geocoded string under it |

**The two labels stay labels, and the panel says so in words.** This control
looks like the storefront's, where the market *is* a choice, so somebody
hunting for the picker will read the sentence rather than a source comment they
never open: *"Resolved from where this sign-in was made, and not editable here:
the prices you check have to be the ones a customer in front of you actually
pays."*

**The flag follows the country; the market label follows the price.** Those are
two different questions and they were briefly answered by one condition. "Which
country is this sign-in from" has an answer whenever the browser resolved one.
"Does being in that country change a price" is narrower — it needs EU VAT
configured, or a market whose currency is not the seller's — and in a
single-market deployment the answer is no. Gating the flag on the narrow
question hid it on every such install while the panel was perfectly able to say
India, so the flag now shows whenever a country is known and only the *market
sentence* waits for a price difference that actually exists.

Each part disappears independently. With no country resolved, no market that
changes a price and no geocoded place, this is a language control with a
flagless trigger — which is exactly what a single-market deployment with the
location feature switched off should see.

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
  console did before it knew about markets. And the locale panel's market row
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

**How it is boxed**
`product_packaging`, `product_pack_dimensions`

One packing row per sellable SKU — pieces per inner pack, inner packs per
carton, pieces per carton, the source's own words for both packs, and the raw
text every figure was read out of. The raw text is not redundant with the
numbers beside it: it is the only thing that can settle an argument about what
the supplier actually said, and `parseStatus` records how much of it was
understood. `NEEDS_REVIEW` means the source's own multiplication contradicts
itself, and such a row is displayed but never converted from.

`product_pack_dimensions` holds the box sizes, one per kind, as written.
`unit` is nullable and stays NULL unless the source actually named one. The
`STICKER_ARTWORK` kind is filtered out of every public read by name — it is a
print specification for the label supplier, not a fact about the product.

**Where a catalogue row came from**
`product_import_records`

Provenance and the operator-internal columns of a supplier sheet: licence
status, production capacity, launch date, the workflow state, the source file
and row, and the raw row as JSON. A separate table from `products` on purpose —
the public product select is an allowlist so they would have been safe either
way, but a separate table makes the boundary structural instead of a rule
somebody has to remember on every future read. See 9.11.

**How much of it there is**
`inventory_locations`, `inventory_balances`, `inventory_movements`,
`stock_reservations`, `warehouse_country_exclusions`,
`warehouse_delivery_zones`

**Where an order ships from**
`warehouse_delivery_zones`, `product_country_restrictions`,
`fulfilment_quotes`

A **lane** is one row of `warehouse_delivery_zones`: one warehouse, one
destination country, optionally narrowed to a list of postal prefixes, with the
handling time, the transit range, the carrier, the fee and the currency it is
priced in. It is the thing that decides whether a warehouse may serve an
address — never the radius drawn on the map, which is a picture for the person
configuring one.

A **quote** is one row of `fulfilment_quotes`: an offer that was made, with the
warehouse, the lane, the dates, the money and an expiry, tied to the cart and
the address it was priced for. It exists so the number a customer read is the
number they are charged — the alternative is recomputing at payment against a
stock ledger that has moved since. Expired rows are swept by the worker; the
one bound to an order is kept, because it is the evidence behind the delivery
date on it. See 9.3.2.

`warehouse_country_exclusions` is the one table in the schema with **no
foreign key to `countries`, on purpose.** `countries` is the list of markets
this deployment prices in — a few dozen rows, each needing a currency — and a
500 km delivery radius reaches countries nobody has ever sold into, which are
exactly the ones an operator most wants to close. An FK would make precisely
those uncloseable. The code's shape is held by a CHECK constraint and its
existence is checked against the ISO 3166-1 list in `location.service.ts`. It
is also the only table pointing at `inventory_locations` with `onDelete:
Cascade` rather than `Restrict`: the other four are *history* and deleting a
warehouse would orphan the ledger, where an exclusion is a line of
configuration that means nothing once its warehouse is gone.

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
| **Public** | `/api/v1/config`, `/api/v1/catalog`, `/api/v1/delivery` | Anyone, no login |
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

**One public endpoint is a POST, and it changes nothing.**
`POST /api/v1/delivery/options` asks which warehouses can deliver a basket to a
country. The basket is the input — up to a hundred product ids with quantities
— which does not fit in a query string a proxy will keep, and which would sit
in this server's access log and in every log in front of it if it did. There is
no caching to lose either: the answer depends on live stock, and a cached "yes,
two days" is the one answer that must never be stale, so it goes out
`no-store`.

It answers `200` with an empty `options` when nobody can deliver. That is a
real answer the storefront has a screen for; an error there would make "we do
not ship to Iceland yet" indistinguishable from a request the endpoint could
not understand, and the buyer would be shown a fault instead of a fact.
`closedByOperator` is a count and never a list — see the cart panel in
[§4](#the-cart-where-this-can-ship-from).

**Its signed-in counterpart is a POST that really does change something.**
`POST /api/v1/fulfilment/warehouse-options` answers the same shape of question
for a particular customer's basket going to a particular address of theirs, and
every answer **writes rows**: each option carries a `quoteId` naming a stored
offer with an expiry, which is what makes the total on the card the total on
the order. So the two are not variants of one endpoint. One is a browsing
answer nobody has to be signed in for; the other is an offer being made, and it
is rate-limited because it is not a free read. See 9.3.2.

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

## Verified product cards

`GET /api/v1/catalog/product-cards?refs=…` — public, like everything else
under `/catalog`, and the reason it exists is AI Mode.

The assistant is grounded in a snapshot of this catalogue and ends an answer
about specific products with a reference line of slugs. Those references are
the **only** thing the storefront takes from generated text: it brings them
here, and what is drawn on a card is what this route says. Never a name, a
price, a stock figure or — above all — an image URL that arrived in a model's
output.

| Parameter | Meaning |
|---|---|
| `refs` | Comma-separated slugs or product codes, at most twelve. A variant's own code resolves to its product |
| `currency`, `country`, `language` | The same market questions every other read in this zone asks |

The answer is the same public product shape the listing uses, plus two things:

  - `availability`: `isStockTracked`, `inStock`, `availableQty`. An
    untracked product reports `null` for the quantity, which means "we do not
    count these" and never "there are none" — the card renders no stock line
    for those rather than an alarming zero.
  - `matchedRef`, so the caller can keep the order the references were given
    in. That order is the assistant's recommendation, most relevant first.

**`unresolved` names what could not be found rather than dropping it.** A
reference that resolves to nothing is a product that was withdrawn, or a code
the model invented; either way the caller owes the reader an honest count
instead of showing fewer cards than the answer mentioned. The endpoint applies
`publicProductWhere()` like every other read here, so guessing a slug cannot
confirm an unreleased product.

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

### Accepting the terms at sign-in

Both sign-in screens — the storefront’s `/login` and the panel’s `/login` —
carry a required **I accept the terms** tick above the button. An unticked box
stops the submit and shows "You need to accept the terms to sign in."; nothing
is sent until it is ticked.

Four things about it are deliberate:

- **It is a client-side gate, not a recorded consent.** `POST /auth/login`
  still takes an email and a password and nothing else, and sending it a field
  it does not declare would be rejected by its schema. The acceptance that is
  *stored* is the one given at registration or at invitation activation, in
  `customer_profiles.consent_accepted_at` and `consent_version` — and the
  backend refuses either without it (`CONSENT_REQUIRED`). A staff invitation
  carries no consent row at all. So the tick at sign-in is a reminder of a
  standing agreement, not a new record of one. **If a deployment ever needs
  each sign-in evidenced, that is a backend change** — a column, a version to
  compare against, and a decision about what to do when the policy has moved
  on — not a checkbox.
- **It is never pre-ticked, and never remembered.** No cookie, no
  `localStorage`, no "this browser already agreed". A tick that carries itself
  forward is a tick nobody gave this time, and the panel in particular is
  shared by several staff accounts behind nothing but a password — one
  person’s acceptance must not appear as the next person’s.
- **The links beside it are the operator’s own.** They come from
  `business.policyLinks` on `GET /api/v1/config` — a label and a URL each,
  stored in `business_profiles.policy_links_json`, edited in
  **Settings → Policy links** and written by
  `PATCH /api/v1/admin/settings/policy-links` (needs `SETTINGS_WRITE`).
  Nothing in either frontend knows what a policy is called or where it
  lives: whatever labels the operator sets are the labels that appear, in
  that order. A deployment that has set none renders the sentence with no
  links rather than a link to a page that does not exist — and the tick is
  still required, because what is being accepted is the contract, not the
  web page.
- **The wording differs by surface, on purpose.** A customer accepts *terms of
  business* (`auth.login.acceptTerms` in `apps/customer-web`, the same
  sentence the sign-up form uses); a member of staff accepts *terms of use*
  (the same key in `apps/admin-web`). Staff are not buying anything.

The storefront’s three consent ticks — sign-in, sign-up and invitation
activation — are one component, `components/AcceptTermsCheckbox.tsx`, so the
sentence and the links cannot drift apart between the screens.

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
│ Before paying, the customer also chose the WAREHOUSE this    │
│ order ships from, and its quote was frozen onto the order    │
│ (see 9.3.2). The delivery figure in the total is that lane's │
│ fee, not a shipping method's.                                │
│                                                              │
│ At checkout the customer chose an INSTRUMENT — Pay with      │
│ Credit Card, Pay with Debit Card, or Pay with UPI. They were │
│ never shown a gateway; the server resolves one from that     │
│ choice (see 9.3.1).                                          │
│                                                              │
│ They either enter a card, or pick one they saved before.     │
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

## 9.3.1 How the customer is asked to pay

The checkout used to ask which **gateway** should take the money — a radio
button reading "Razorpay" beside one reading "Stripe". That is the operator's
plumbing on the customer's screen. Nobody buying laboratory consumables knows
which acquirer they would rather settle through, and asking put a decision in
front of them that they had no basis for making.

The question is now the one they can answer:

```
How would you like to pay?
  ● Pay now
      ● Pay with Credit Card     ← their saved credit cards, + "use a different card"
      ○ Pay with Debit Card      ← their saved debit cards
      ○ Pay with UPI             ← only where a gateway actually has UPI
  ○ Send a payment link
```

**No gateway is ever named to a customer.** `GET /payments/instruments` answers
with instruments only, and `domain/payment-instrument.ts` turns one into a
gateway — that file is the single place the mapping lives.

It **refuses rather than substitutes**. A customer who chose UPI and is
silently handed a card form has been told something untrue by this application,
so a UPI order with no UPI gateway is `PAYMENT_INSTRUMENT_UNAVAILABLE`, not a
quiet fallback to Stripe.

### Credit or debit is discovered, not declared

No gateway can tell which a card is until it has been entered. So:

- A **saved** card is filed under the funding the gateway reported for it, and
  appears only under that heading.
- A card of **unknown** funding — prepaid, or one the gateway would not
  describe — appears under **both**. Telling somebody their credit card is a
  debit card is worse than telling them nothing.
- A **new** card: the choice is a routing hint. Whatever button was pressed,
  the card is filed under what it turns out to be. Nobody is blocked for
  tapping "Credit" and entering a debit card.

### The two consents, which are not degrees of one thing

`customer_payment_methods.consentScope` says what a stored card's owner agreed
to, and the two values are **different agreements**:

| Scope | What was agreed | Where it comes from |
|---|---|---|
| `CHECKOUT` | "keep this so I need not type it again" | the tick on the payment page |
| `OFF_SESSION` | "charge this while I am not here" | Autopay enrolment |

`assertChargeable` in `payment-method.service.ts` refuses anything that is not
`OFF_SESSION`. **That single guard is what stops a card somebody saved to avoid
retyping it being charged in the night by the Autopay worker** — the two rows
are otherwise identical, same table, same token, same last four digits.

### What is actually stored

A **token held by the gateway**. Never a card number.

Since 1 October 2022 the RBI forbids a merchant storing card numbers at all,
and holding one would move every deployment of UBOSS inside PCI DSS scope —
which a company that installed a purchasing system has not signed up for. What
this database holds is a reference plus the brand and last four digits, which
is what a person recognises their own card by and can pay for nothing.

### The two gateways are not symmetrical

| | Stripe | Razorpay |
|---|---|---|
| Save a card at a checkout | yes | yes |
| Charge a saved card from **our** pages | yes | **no** |
| Charge a saved card off-session (Autopay) | yes | no |

Razorpay's saved cards are picked **inside Razorpay's own sheet**, which is
opened with the customer's `customer_id` so their cards are already sitting
there needing only a CVV. This is not a shortcut: charging one named Razorpay
token needs its server-to-server API, which is open only to merchants holding
PCI-DSS certification, and a UBOSS buyer will not have one.

The difference is a compile error rather than a runtime surprise —
`CardVaultProvider` and `DirectCardChargeProvider` are separate interfaces in
`modules/payments/provider.ts`, and Razorpay implements only the first.

### Where a Razorpay token comes from

Razorpay has no SetupIntent. A card becomes reusable **by being paid with**,
and the token id arrives on the `payment.captured` webhook — which makes this
the only place in the codebase where a stored payment credential is created by
an incoming event rather than by a request somebody made. Three consequences,
all in `applyEvent`:

1. It is read from a **signature-verified** webhook. The browser's success
   callback says nothing about it and is not consulted.
2. Only on a **capture**. A token from a failed payment is a card nothing shows
   works.
3. It **cannot harm the payment**. Storing the card is attempted after the
   money is applied and every failure is swallowed: a card that fails to store
   costs the customer a retype next time, and must never cost them a confirmed
   order they have already paid for.

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

## 9.3.2 Choosing a fulfilment warehouse

Checkout used to decide silently where an order would be sent from. The
customer picked an address, pressed Place Order, and the server chose a
warehouse and a delivery figure without either appearing on the screen. A
buyer whose order could have come from Pune in two days for ₹125, or from
Mumbai in five days for nothing, was never told the choice existed.

Between the address and the payment there is now a section headed **Choose
your fulfilment warehouse**, and each eligible warehouse is a card the customer
can select: where it ships from, when it arrives, which carrier, whether the
stock is there, and the whole price breakdown down to the total. Selecting one
changes the summary beside it, and the id of the offer travels with the order.

### The endpoint

```
POST /api/v1/fulfilment/warehouse-options
  { deliveryAddressId?, countryCode?, items?, currency?, requestedDeliveryDate? }
```

Signed in, unlike `POST /delivery/options` on the cart page, and the difference
is not an oversight. That one answers a **browsing** question — can you reach
Belgium, roughly when — from a country code, before anybody has an account.
This one answers a **buying** question about a particular person's basket going
to a particular address of theirs, so it needs the session for both: the cart
it prices is the one on the session, and the address is checked against the
session's own profile rather than taken on trust from an id in a body.

Each option comes back with a `quoteId` and an `expiresAt`, and those two
fields are the point of the whole endpoint. **Every answer writes rows.** A
quote is a stored offer, so the number on the card is the number that gets
charged; the alternative is repricing at payment from ids the browser hands
back, and two runs against a moving stock ledger produce two answers. That
makes this a POST with effects, which is the honest shape for it, and it is
rate-limited for the same reason. No cache header, ever: availability is the
fastest-moving input in this system, and a proxy holding "Antwerp, Thursday, in
stock" for sixty seconds is sixty seconds of promising a unit that has gone.

### What makes a warehouse eligible

All of these, and the destination is a full address rather than a country:

| Test | Where it comes from |
|---|---|
| Active, and able to ship today (`OPERATIONAL` or `LIMITED`) | `InventoryLocation` |
| An active delivery zone covering the destination country **and postcode** | `WarehouseDeliveryZone.postalPrefixes` |
| The operator has not closed that country on this warehouse | `WarehouseCountryExclusion` |
| Enough of **every** line, on hand minus what other live checkouts hold | `InventoryBalance` |
| The goods' own restrictions — cold chain, weight | `WarehouseDeliveryZone`, `Product` |
| The lane prices delivery in the basket's currency | `WarehouseDeliveryZone.shippingFeeCurrency` |
| The destination itself accepts the goods | `ProductCountryRestriction` |

**The 100 km circle on the warehouse map is a drawing, not a rule.** It shows
an operator roughly what a radius covers while they are configuring one.
Fulfilment eligibility is decided by the configured delivery zones, the postal
prefixes on them, the carrier's own limits and the stock — never by that
circle. Distance is reported on the card as information and decides nothing.

### One warehouse per order

A warehouse that holds four of the five things in a basket **is not an
option**. There is no approved split-fulfilment flow in this project, so an
offer that cannot cover every line would break at the picking face. Those
warehouses still come back, under `ineligible`, with the lines they are short
of named and their quantities given — a buyer who knows there is a depot in
their own city and cannot see it on the list will assume the list is broken.

That is what `ineligible` is for generally: a machine-readable `reason` and a
sentence for each warehouse the buyer might have expected. `NO_DELIVERY_ZONE`,
`COUNTRY_CLOSED`, `INSUFFICIENT_STOCK`, `PRODUCT_RESTRICTED`,
`COLD_CHAIN_UNSUPPORTED`, `OVER_WEIGHT`, `CURRENCY_MISMATCH`, `NOT_PLACED`. A
destination restriction wins over all of them, because a product that may not
enter the country cannot be sent from anywhere and the rest is noise beside
that.

A store that has never drawn a delivery zone gets no options and every
warehouse under `NO_DELIVERY_ZONE`. **The storefront reads that as "this shop
does not fulfil from warehouses here"**, hides nothing, blocks nothing, and
lets checkout run the way it did before this feature existed. Blocking on an
empty option list would have taken every such deployment offline.

### Estimated, and why it cannot be bought

Given a `countryCode` and no address, the answer comes back with
`isEstimate: true`. The storefront labels it and makes the cards
unselectable; `assertQuoteUsable` refuses such a quote at checkout with
`FULFILMENT_QUOTE_INVALID`. An estimate is a conversation, never an offer —
"five days from Antwerp" worked out for Belgium is a different promise from
"five days to this postcode in Ostend".

### The badges

`isFastest`, `isCheapest` and `isRecommended` are fields on the response and
are decided on the server. Nothing in either frontend works out which option is
best, and that is deliberate: two implementations of "which of these is the
cheapest" is how a **Lowest price** badge ends up on the dearer card.
Recommended is not a fourth opinion — it is a name for the default, so a card
that is already selected says why. The rule is the cheapest of the options
arriving no more than a day after the fastest, which is the trade most people
make by hand.

### From the card to the order

```
┌── The customer picks a card ─────────────────────────────────┐
│ The summary switches to that option's totals. The lane's     │
│ delivery fee is what the order will be priced through, so    │
│ showing the cart's own shipping line beside a card quoting   │
│ a different one would be a screen that quotes one number     │
│ and charges another.                                         │
└──────────────────────────────────────────────────────────────┘
                            ▼
┌── Place Order pressed ───────────────────────────────────────┐
│ POST /fulfilment/warehouse-options/:quoteId/revalidate       │
│   Answers 200 with `ok: false` and a code — never an         │
│   exception. Re-asking for options is a normal flow, and a   │
│   screen that has to catch an error to render "this expired" │
│   is a screen that renders a stack trace one day.            │
│                                                              │
│   Not ok  ─▶ no order is created, the options are re-read,   │
│              the selection is cleared, and the customer is   │
│              asked again. Nothing is ever substituted.       │
└──────────────────────────────────────────────────────────────┘
                            ▼
┌── POST /cart/checkout { …, fulfilmentQuoteId } ──────────────┐
│ The server checks the quote again — owner, cart, address,    │
│ basket digest, expiry, warehouse still shipping, stock still │
│ there — then reprices the cart with the lane's fee as a      │
│ shipping override, so the free-above threshold and           │
│ `assertTotalsConsistent` run over it exactly as they do for  │
│ a shipping method.                                           │
│                                                              │
│ If the repriced total is not the total that was quoted, the  │
│ order is REFUSED with FULFILMENT_QUOTE_STALE and both        │
│ figures in the detail. A catalogue edit, a coupon that       │
│ lapsed or a VAT rate that changed at midnight all do this.   │
│ The customer agreed to a figure, not to a method of          │
│ arriving at one.                                             │
└──────────────────────────────────────────────────────────────┘
                            ▼
┌── Frozen onto the order, and into the audit trail ───────────┐
│ fulfilmentLocationId  fulfilmentQuoteId  fulfilmentCarrier   │
│ fulfilmentServiceLevel  fulfilmentDispatchDate               │
│ fulfilmentDeliveryFrom  fulfilmentDeliveryTo                 │
│                                                              │
│ A dispute about a delivery date is answered from here,       │
│ without anybody having to reason about what the catalogue    │
│ looked like at the time.                                     │
└──────────────────────────────────────────────────────────────┘
```

The error codes are the published contract, and each is a different thing that
happened: `FULFILMENT_QUOTE_EXPIRED` (the offer lapsed),
`FULFILMENT_QUOTE_INVALID` (not this customer's, or an estimate),
`FULFILMENT_QUOTE_STALE` (the basket or the price moved),
`FULFILMENT_WAREHOUSE_UNAVAILABLE`, `FULFILMENT_STOCK_CHANGED`,
`FULFILMENT_NO_ELIGIBLE_WAREHOUSE`. Collapsing them into one sentence would
leave the customer unable to tell which of them they can do something about.

### What the section does on screen

`pages/checkout/FulfilmentWarehouseSection.tsx`. Radio buttons rather than the
cart panel's `aria-pressed` toggles, because a control that submits with the
form is a radio — the same card shape as the address list above it, since it is
the same kind of decision.

Every state it has to be able to be in: a skeleton in the shape of the cards
while the ask is in flight; the answer; "no warehouse can send this order" with
the per-warehouse reasons under a disclosure; a product the destination refuses
outright; and a failure with a Retry. **A failure does not block checkout** —
the order goes through the path it took before this feature existed, with no
quote attached, and the server still refuses anything it cannot stock or ship.
A transient outage of one endpoint must not take the shop's checkout down.

Quotes expire, so the page sets a timer for the moment the chosen one lapses,
re-asks, and says it has. If the price moved between two answers it says so
rather than absorbing it. If the chosen warehouse is not on the new list the
selection is **cleared** and the customer is asked again — moving somebody's
order to a warehouse they did not pick is exactly the substitution this must
never make.

`FULFILMENT_QUOTE_TTL_MINUTES` is how long an offer stands (15 by default), and
the browser is told it as `config.fulfilment.fulfilmentQuoteTtlSeconds` so a
figure baked into a bundle is not a figure an operator cannot change.

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

`recurring_schedules.hiddenAt` is the customer's own soft delete, added by
`20260911090000_schedule_hidden_from_list` along with
`chk_schedule_hidden_only_when_terminal` — a plan may only be hidden once it has
stopped. See *Removing a finished schedule from the list* in §9.5.

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

Four doors lead to the builder at `/schedules/new`, which turns a basket into
a plan:

| From | What they see |
|---|---|
| A product page | The **Schedule your Cart** button, beside Add to Cart |
| `/cart` | A **Need this again?** panel beside Checkout, when at least one line is eligible |
| `/checkout` | **Repeat this order on a schedule**, directly under Place Order |
| `/account/schedules` | The list of plans they already have, and its empty state |

A fifth door leads somewhere else. The cart's **Schedule Cart** tab opens
`/accounts/schedule`, which is the workspace rather than the builder: it lists
the plans that already exist, opens one for editing beside the list, and can
start a new one from nothing rather than from a basket. See *Schedule Cart*
below.

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
| `GET` | `/recurring-schedules/delivery-window` | The earliest first delivery this address and warehouse will take. What the calendar greys out; writes nothing, re-asked whenever either changes |
| `POST` | `/recurring-schedules/preview` | The review screen. Prices the cart under a proposed schedule. Writes nothing |
| `POST` | `/recurring-schedules/from-cart` | Creates a DRAFT from the cart |
| `POST` | `/recurring-schedules/:id/activate` | Confirms it. Records consent, empties the cart |
| `GET` | `/recurring-schedules` | The customer's plans. Filter by `status` and `kind`; `?estimate=true` prices each one |
| `GET` | `/recurring-schedules/:id` | One plan, with its items and recent deliveries |
| `POST` | `/recurring-schedules` | Creates a plan from a product list rather than a cart |
| `PATCH` | `/recurring-schedules/:id` | Items, quantities, frequency, start date, time of day, **timezone**, address, card, tolerance. Absolute, not incremental |
| `GET` | `/recurring-schedules/:id/estimate` | What this plan would cost if it ran now, priced by `quoteSchedule` |
| `GET` | `/recurring-schedules/:id/occurrences` | The deliveries. `?upcomingOnly=true` for the future ones |
| `POST` | `/recurring-schedules/:id/skip-next` | Skips the next delivery |
| `POST` | `/recurring-schedules/occurrences/:id/skip` | Skips one named delivery |
| `DELETE` | `/recurring-schedules/occurrences/:id` | Cancels one delivery |
| `POST` | `/recurring-schedules/:id/pause` | Pauses the plan |
| `POST` | `/recurring-schedules/:id/resume` | Resumes it, recomputing the next date from now |
| `DELETE` | `/recurring-schedules/:id` | Cancels future runs. Placed orders are untouched |
| `POST` | `/recurring-schedules/:id/hide` | Takes a **finished** plan off the customer's list. A soft delete; refused on a live one |
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

### Schedule Cart: where a plan is changed

`/accounts/schedule`, reached from the cart's second tab. A list of the
customer's plans on the left, the one being worked on beside it — because that
is the shape of the job. A hospital store keeps several independent standing
orders (gloves monthly, feeding sets quarterly, saline every fortnight) and the
work is comparing them and then changing one. A page per plan makes the
comparison a navigation exercise.

Each card in the list carries the name, the plan id, the status, the next
processing time **and its timezone**, how often, how many products, and the
estimated amount.

The editor beside it can:

| | |
|---|---|
| Add a product | A search over the catalogue, filtered to what a schedule will accept and priced for the buyer's market |
| Remove a product | |
| Change a quantity | Through the same stepper the cart uses, so the product's minimum and increment are honoured |
| Change how often, the **delivery date**, the **timezone** and the ending | The delivery date opens a calendar — see below |
| Change the delivery address | |
| **Apply changes** | One PATCH |
| **Cancel this schedule** | A confirmation that takes a reason |
| **Remove** | On the card, and only once the plan has stopped — see below |

Creating is there too: **New schedule** builds one from nothing — products,
cadence, address, payment mode, consent — rather than from a basket, so a buyer
can keep as many independent arrangements as they need without going through
the cart for each.

Which plan is open lives in the URL (`?id=`), so a schedule is linkable and
survives a refresh, and the editor is keyed on that id so switching plans
remounts the form rather than leaving one plan's unsaved quantities on
another's basket.

#### Removing a finished schedule from the list

A cancelled plan used to sit in this list forever, and there was nothing to do
about it — "cancel it again" is not an answer to a plan that is already
cancelled. Each card for a plan that has **stopped** now carries a quiet
**Remove**, which asks first and then takes the card off the list.

**It is a soft delete, and the dialog says both halves of that out loud**: the
card goes, and the schedule, the consent behind it and any orders it placed are
all kept. The row is the record that somebody authorised recurring charges —
`consentAcceptedAt`, `consentVersion`, the cart snapshot they confirmed on the
review screen — and a customer tidying a list is not a reason to destroy the
evidence behind a charge that may be disputed months later. Staff still see the
plan, the GDPR export still discloses it, and erasure under Art. 17 remains a
different act with its own route that does delete rows.

It could not be a hard delete in any case. `orders` is ON DELETE RESTRICT, so a
plan that has ever run cannot be removed without taking real orders with it —
which is precisely the protection that constraint exists to give.

**Only a terminal plan may be hidden — CANCELLED or COMPLETED — and this is the
rule the whole feature turns on.** Hiding an ACTIVE or PAUSED plan would mean
money leaving an account for an arrangement the customer can no longer see;
hiding a FAILED one would hide a plan they are still allowed to resume; hiding
a DRAFT would strand a review they can still confirm. So:

  - the control is not rendered on a plan that has not stopped;
  - `hideSchedule` refuses it, with a sentence that names the way out
    ("cancel this one first, and then remove it") rather than just saying no;
  - and MariaDB refuses it a third time —
    `chk_schedule_hidden_only_when_terminal`, in
    `20260911090000_schedule_hidden_from_list`. That one is the lock that holds
    if a future caller writes the column directly, and there is a test that
    bypasses the service to prove it is really there.

The flag narrows **every** customer-facing read, not just the list: the detail
route, the occurrences route and the estimate all answer 404 for a hidden plan,
so a stale link cannot reopen one. `VISIBLE_TO_CUSTOMER` in
`schedule.service.ts` is that `where` fragment, exported as one constant
because a plan reappearing on one screen out of four reads as the removal
having silently failed. Admin reads deliberately do not use it.

Hiding is **idempotent**: a retry, a double-tap or a second tab all mean the
same thing, and the second call neither errors nor moves the timestamp. It is
recorded in the audit log as `schedule.hidden` — not because hiding a row is
dangerous, but because the plan stops appearing at that moment, and somebody
asking later why a schedule they remember is missing deserves better than "it
must have been you".

#### The delivery date, and the week's notice

The date field opens a calendar (`components/DatePicker.tsx`), and the reason
is the constraint rather than the looks: **a first delivery needs seven days'
notice**, so most of the calendar is unavailable. A native `<input type="date">`
expresses that as a `min` attribute the browser enforces silently — the buyer
types the 14th, the field refuses it, and nothing on screen says why. The
calendar greys the days inside the notice period, marks the earliest one that
is available, says the rule in words under the grid, and offers that earliest
day as one press.

Seven is the default, not the rule. The rule is `SCHEDULE_MIN_NOTICE_DAYS` on
the deployment — a shop selling from stock in the buyer's own city sets it to
zero — and the browser is told the figure as
`config.fulfilment.scheduleMinNoticeDays`, for the same reason it is told the
currency and the timezone: a number compiled into a bundle is a number the
operator who bought this software cannot change. `DELIVERY_NOTICE_DAYS` in
`lib/schedule-cadence.ts` is what the picker draws with until that config
request answers, and if it fails.

**The floor the API enforces is not always the notice period**, and the two
things that raise it are both things a browser cannot know:

```
earliest = max( today + SCHEDULE_MIN_NOTICE_DAYS ,
                the chosen warehouse's own soonest delivery )
```

- **Whose today?** It is counted on the delivery address's own IANA zone where
  it has one, then the schedule's, then the store's. A buyer in Kolkata sending
  to a site in Rotterdam is on two different days at once for four and a half
  hours out of every twenty-four.
- **A warehouse has a floor too.** A plan pinned to one warehouse cannot arrive
  sooner than that warehouse's handling time and carrier lane allow. An `AUTO`
  plan has no warehouse yet — the engine picks one at run time from whatever
  holds the stock that week — so there is nothing to measure and the notice
  period stands alone. Inventing a floor from "the slowest warehouse we have"
  would hold every AUTO plan to a decision nobody has made.

So the screen asks for it:

```
GET /api/v1/recurring-schedules/delivery-window
      ?shippingAddressId=…&timezone=…&fulfilmentRule=…&inventoryLocationId=…
  → { earliest, noticeFloor, warehouseEarliest, timezone, noticeDays }
```

A GET, because it writes nothing and the screen re-asks it **every time the
address or the warehouse changes** — which is exactly the recalculation the
rule requires. `lib/delivery-window.ts` is the hook; `CadenceFields` and the
builder at `/schedules/new` both take the answer as their `min`, and both lift
a date already in the form onto the new floor rather than leaving an invalid
value in a form that looks valid. It only ever moves a date forwards: a date
further out is the buyer's own choice.

**The calendar draws the rule; it does not enforce it.** `createSchedule` and
`updateSchedule` refuse a first delivery inside the window with
`SCHEDULE_DATE_TOO_SOON` — a separate code from `SCHEDULE_DATE_IN_PAST`,
because "that day has gone" and "we need a week" are different problems with
different fixes, and the detail carries `earliest` as a `YYYY-MM-DD` so the
storefront can move the picker to it rather than leaving somebody guessing how
far forward to click. The rule applies to editing an eligible future schedule
exactly as it does to creating one; an occurrence that is already processing or
finished is never touched, and no migration moves an existing plan's dates.

Notice is counted in **calendar days, never in milliseconds**.
`Date.now() + 7 * 86_400_000` is the tempting version and it is wrong twice a
year in every zone that observes DST: the seventh day forward is 167 or 169
hours away, not 168. `domain/delivery-dates.ts` is the whole of that arithmetic
on the server and `lib/calendar-date.ts` in the browser, both on `YYYY-MM-DD`
strings, both tested against the boundaries.

**There is no time-of-day control on any of these screens.** It offered five
fixed times, every one of them the middle of somebody's night somewhere, and
the hour a warehouse picks an order is not a decision a buyer has any basis
for making — it is the operator's. The plan keeps the `runAtMinute` it has (the
store's own default for a new one) and the API still receives it, so nothing
about the recurrence changed. What was removed is a question nobody could
answer.

The workspace at `/accounts/schedule` lost the control first; the builder at
`/schedules/new` has now lost it too, and with it the **At 06:00** row in its
summary panel — a figure nobody had chosen. The schedule's timezone still
shows there, on the *Starting* row it was always counted against. The builder
sends `DEFAULT_RUN_AT_MINUTE`, which is `360`, the value that screen always
opened on. Both screens use the same calendar and the same notice floor.

Everything the calendar handles is a `YYYY-MM-DD` string, never a `Date` — see
the header of `lib/calendar-date.ts`. `new Date('2026-09-18')` is parsed as
UTC midnight and prints as the 17th for every reader west of Greenwich, which
is how a picker comes to show one day, send another, and be right about
neither.

It is a keyboard control as much as a pointer one: arrows by a day and a week,
Home/End across the week, PageUp/PageDown by a month, Enter to choose, Escape
to give up and hand focus back to the field. One day sits in the tab order at a
time, so tabbing past the calendar is one press rather than thirty-five. Below
`sm` it is a bottom sheet with its own Close button rather than a popover
clipped by the bottom of a phone.

**Three rules the screen keeps.**

  - **The save is absolute, not incremental.** Apply Changes sends the whole
    arrangement — every item with its quantity, the whole recurrence, the
    address — so the same request applied twice lands on the same state. That
    is what makes a retry, a double-click or a dropped response safe: there is
    no "add one more of this" for a second attempt to apply again. The server
    replaces the basket rather than merging into it.
  - **The screen refuses what the server would refuse, and says why first.** A
    plan inside its cutoff, one with a delivery being priced, and one that is
    cancelled or finished are read-only here, with the reason named above the
    form. Controls that look editable and then fail on save are worse than
    controls that say they are locked.
  - **The money comes from the server.** The estimate is `quoteSchedule`'s
    answer — the same function that prices the occurrence the customer is
    eventually charged for. Nothing on the screen multiplies a unit price by a
    quantity, because a second implementation of "what does this basket cost"
    is how somebody ends up disputing a total nobody can explain. It is
    labelled an estimate, and it is one: every delivery is repriced when it
    runs.

Apply Changes stays disabled while nothing has changed, and not for tidiness: a
PATCH that touches the recurrence re-materialises every upcoming delivery, so
an accidental no-op save is a real write against a live standing order.

### The customer can change things

Up to the **edit cutoff** — `SCHEDULE_EDIT_CUTOFF_MINUTES`, default 24 hours
before a delivery. Inside it the worker may already be pricing the order, and
an edit would race the charge: the customer would see one basket and be billed
for another. The refusal names the date they *can* change, because "too late"
without one is not an answer. Administrators are not bound by it — somebody is
usually on the phone.

They can change the date, the frequency, the timezone, quantities, which
products are on the plan, the address and the card; skip the next delivery;
pause and resume; or cancel. Cancelling stops future runs only — orders already
placed keep their own lifecycle.

**Changing the timezone re-dates every upcoming delivery**, for the same reason
changing the frequency does: the dates on file were computed against a clock
that no longer applies. It is editable because it has to be — a standing order
set up by a buyer in Kolkata and handed to a colleague in Rotterdam otherwise
fires at 06:00 in the wrong city, and "cancel it and build another" is not an
answer when the alternative is one field.

**A second guard sits beside the cutoff, and it is a fact rather than a
clock.** An edit is refused while the engine is *holding the basket* — an
occurrence at `AWAITING_VALIDATION`, where `quoteSchedule` is reading the
items, or `PROCESSING`, where the money is moving. By then `nextRunAt` has
usually moved on to the following cycle, so the cutoff window for *that* slot
is wide open while the delivery in flight is being priced, and the cutoff check
alone would let the edit through.

The list is deliberately narrow, and the boundary is the moment the order is
written. `PAYMENT_PENDING` and `ACTION_REQUIRED` are **not** on it: both sit
after the order exists, with the items already snapshotted on it, and both can
last days — a payment link out and unpaid, or a bank waiting for the
cardholder. A plan that could not be edited while a link went unpaid would be a
plan frozen by somebody else's inbox.

Editing never reaches a delivery that already happened, and the mechanism is
not care: `rematerialiseOccurrences` only removes future rows that are still
`SCHEDULED` and have no order attached. A completed cycle keeps its date, its
status and its order.

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

   **That override has to answer two callback shapes.** `net.connect` gained
   happy eyeballs in Node 20 and now asks with `{ all: true }`, meaning "give me
   the whole list", and expects `callback(err, [{ address, family }])`. The
   older contract is `callback(err, address, family)`. Answering only the older
   one left Node reading `addresses[0].address` off a string, getting
   `undefined`, and failing every outbound call with `ERR_INVALID_IP_ADDRESS` —
   which reached the buyer as *"Your system could not be reached from here"*
   about an ERP that was up and answering `curl` from the same machine. Every
   customer ERP call went down with it, not just one connector's.

   The test that would have caught it did not exist: every case here stopped at
   `resolveSafeTarget` and asserted which address the guard **picks**, which is
   the security question, and none of them opened a socket. There is now one
   that makes a real request to a local server, and it fails if the pin is
   answered wrongly.
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

### The other way a card gets saved

A card can also be kept at a checkout, and that is a **narrower** thing. The
tick sits on the payment page — beside the Pay button, where the card is
actually typed, which is the only moment the offer means anything — and it says
"save this card for next time", not "charge this while I am away".

Also never pre-ticked. A pre-ticked box is not consent under the GDPR, and a
payment credential is exactly what that rule was written for.

The two paths differ in where the truth comes from:

| | Autopay enrolment | Saved at a checkout |
|---|---|---|
| Trigger | the customer confirms a SetupIntent | a signature-verified capture webhook |
| Stripe asks for | `usage: 'off_session'` | `setup_future_usage: 'on_session'` |
| Scope stored | `OFF_SESSION` | `CHECKOUT` |
| Gateways | Stripe only | Stripe and Razorpay |
| Can Autopay charge it? | yes | **no** — `assertChargeable` refuses |

Both read the card's display fields back **from the gateway** rather than
taking them from a browser or an event body. The provider is the authority on
what it stored, and one path that reads it is easier to keep honest than two.

Both are visible at **Account → Saved cards**, where a checkout-saved card is
badged "Checkout only" — the two are otherwise indistinguishable on screen, and
that badge is the only thing telling a customer why one of their cards is not
offered on the Autopay page.

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

## 9.8.1 The customer's *own* ERP

Everything in 9.5.2 and 9.8 is about **our** ERP: the warehouse system the
operator runs, configured once under Settings → ERP, where every order this
installation takes is sent.

This section is the other direction, and it is a different feature with a
different owner. A buyer is itself a business — a hospital group, a distributor,
a private practice — and it runs SAP, or monday.com, or something written
in-house. What it wants is for the things it buys **here** to appear **there**,
without anybody re-keying them.

```
An order is confirmed here
        │
        ▼
A PURCHASE ORDER is raised in the buyer's own ERP.
The quantity becomes ON ORDER. On-hand stock does not move.
        │
        ▼  it ships
Carrier and tracking are synced. Still nothing on hand:
a crate on a lorry is not stock.
        │
        ▼  it is delivered, or their ERP posts a goods receipt
NOW on-hand may move — and only if their policy says to write
it automatically rather than ask a person.
        │
        ▼  an invoice is issued
Number, amounts, tax, due date and a document link.
        │
        ▼  it is paid
The payment provider's REFERENCE and status. Nothing about the
instrument: no card number, no last four, no token, no bank detail.
```

**Getting the first step wrong is the classic failure of this kind of
integration**, and it is not a small one. A buyer whose ERP believes stock
arrived the moment it was ordered will stop reordering, run out, and find out
during a procedure. So on-hand moves in exactly one place in the code — a goods
receipt — and the two quantities sit next to each other on the screen so the
difference is visible.

### Who owns the connection

Not the person who set it up. A **buyer organisation**, which is a tenant of its
own with its own members.

That matters because a buyer is a business with staff who come and go. A
connection tied to an individual account dies with that account: their successor
cannot fix it, cannot see why it broke, and cannot rotate a credential that is
still working perfectly well against a system they now own.

An organisation is provisioned the first time somebody in an account opens
Account → ERP integration, and they become its owner. It is deliberately **not**
matched on `customer_profiles.organization`, which is free text somebody typed
into a form: joining a tenant by typing its name is not an access-control
decision, it is an invitation to read a competitor's purchase orders. Other
people join by invitation — a link that works once, expires, is stored only as a
SHA-256, and is checked against the signed-in account's own email address.

Three roles, and they nest:

| Role | Can |
|---|---|
| **Owner** | Everything, including who else has access. |
| **Integration manager** | Configure credentials, endpoints, mappings and rules; test, dry run, sync, retry, decide approvals. Not membership. |
| **Member** | See connection health, sync history and the audit log. No credentials, no hints, not even the endpoints the connection calls. |

A member gets a **different shape** from the API, not the full one with fields
blanked — so no later serialisation mistake can leak what they were not sent.

### Brands and protocols are two different questions

A buyer says "we run NetSuite". The code needs to know something else: how
NetSuite is *spoken to*. Those are two layers, and keeping them apart is what
lets the list of supported ERPs grow without the codebase growing with it.

A **connector** is a protocol dialect, and it is **code**. There are four,
because there are four genuinely different protocols here — not because there
are four ERPs.

A **vendor preset** is a brand, and it is **data**: a name, the connector that
speaks to it, default endpoint paths, a default field mapping, the
authentication methods that system accepts, and what to ask your own IT team
for. It lives in `backend/src/modules/customer-erp/vendor-presets.ts`, and
adding NetSuite or Acumatica or QuickBooks is a change to that one array with no
new code at all — all three are REST and JSON over OAuth 2.0, which the custom
connector already speaks fluently.

Getting this the other way round — one connector per brand — is how an
integration product ends up with twenty near-identical files that drift apart,
and how adding the twenty-first takes a fortnight.

The catalogue currently offers **twenty** systems:

| Connector | Brands it serves |
|---|---|
| **SAP** | SAP S/4HANA, SAP ERP (ECC 6.0) |
| **monday.com** | monday.com |
| **Odoo** | Odoo (Online or self-hosted) |
| **Custom (REST/OData/GraphQL)** | Oracle NetSuite, Oracle Fusion Cloud ERP, Dynamics 365 Business Central, Dynamics 365 Finance & Operations, SAP Business One, Zoho Inventory, Acumatica, QuickBooks Online, Sage X3, Epicor Kinetic, Infor ION, **TCS iON**, Tally Prime, Marg ERP, Busy Accounting, and *Any other system* |

`presetsForRegion` orders the list for the market a deployment serves — an
Indian buyer should not scroll past four American mid-market systems to reach
Tally — and *Any other system* is always last, whatever the region. Every preset
is offered whatever the region: the ordering is a courtesy, not a restriction,
and the wizard's search box reaches all of them.

**How sure the defaults are is a field, not a guess.** `defaultsAreExamples`
separates two honestly different situations. False means the paths are that
vendor's own published API — the same for every customer on it — and a buyer on
a stock installation can often press **Test** straight away. True means the
paths depend on how *that customer's* system was set up: a TCS iON integration
service, an Infor ION flow, a Tally gateway somebody wrote. The preset then
carries the shape and the vocabulary, the paths are a worked example to be
replaced, and **the wizard says so on screen** rather than shipping a
confident-looking default that wastes somebody's afternoon.

Either way a wrong default cannot reach production: switching a connection on is
refused until a test has passed *and* the mapping has been checked against a
real response from that buyer's own system. The preset saves time; the guard
decides correctness.

**TCS iON** is in the list for the reason it was asked for, and it is configured
per customer, so it carries no paths of its own — the generic REST shape stands
in, flagged as an example, and the notes tell the buyer to ask their TCS iON
implementation partner for their tenant's integration API documentation (or to
paste its OpenAPI file on the Endpoints step). What it is emphatically not is a
portal login: see *What it will not connect to* below.

### The four connectors

None of them is a generic one with a dropdown. They disagree about
authentication, about pagination, about what an identifier is, and about whether
a purchase order is a document or a row on a board.

**SAP** — S/4HANA or older SAP ERP, over the OData or REST APIs a communication
arrangement exposes. Carries company code, purchasing organisation, purchasing
group, plant and storage location, because SAP will not accept a purchase order
without the first two. Handles the two SAP-shaped problems nothing else has:
OData V2 refuses a POST without a CSRF token fetched on a prior read, together
with the session cookie that came with it; and an on-premise landscape is
reached through a Cloud Connector the customer runs, not at SAP's own address.

**monday.com** — a board for purchase orders, a group per status, columns for
SKU and quantity. Everything is a POST of a GraphQL document to `/v2`, so a
GraphQL error has to be treated as a failure even though it arrives with HTTP
200. Mappings name **column ids**, not the titles the buyer sees: a title can be
renamed by anybody with edit rights, and a mapping keyed on titles breaks
silently the first time somebody tidies up a board.

Which is why **the test's sample is the flattened item**, not monday's reply.
monday returns an item's columns as a list of `{id, text, value}`, and no dotted
path can reach into that — there is no `text2` to find, only an entry whose `id`
happens to be `text2`. The inventory read has always flattened the list into an
object before mapping it; `test()` did not, so the mapping check ran against a
different shape from the one the sync produces. Every mapped field came back
"not found", the required SKU with it, `mappingVerifiedAt` was therefore never
set, and **a monday connection could never be switched on at all**. Both now go
through one `flattenItem`. The board's own reference data — its id, its columns
with their titles, its groups — rides alongside under `_board`, `_columns` and
`_groups`, underscored so that a column called `board` cannot shadow it.

The general rule that hid behind that: **a mapping check is only worth anything
run against the same shape the real sync produces.** Checking one shape and
syncing another reports a sound mapping as broken, or the reverse.

**Odoo** — JSON-RPC, which fits none of the others: one address for everything,
the model and the method inside the POST body, integer database ids where every
other system uses codes, and a fault that arrives with HTTP 200 carrying a
Python traceback. SKUs are resolved to product ids in one batched lookup and any
that are missing are named, and a purchase order is searched for by
`partner_ref` before it is created — Odoo will happily hold two orders with the
same reference otherwise.

**Your own system** — anything with a documented HTTP API, and the connector
behind most of the catalogue. REST and JSON by default, with OData and GraphQL
where the system speaks them. An OpenAPI document can be pasted in and it will
suggest which endpoint does what; the suggestions are confirmed on screen and
nothing is saved from the file itself.

Its request body is the buyer's structured data with the buyer's mapping laid
**over** it, merged deeply rather than shallowly, and **under the name their own
mapping uses**. Both halves of that sound like details and neither is.

A mapping addressing `lines.0.sku` describes the *first* line. A shallow merge
would let that one-element array replace all five lines of a real order — and
writing the full set to a fixed `lines` when the mapping says `items.0.sku`
would put it beside the mapped one rather than into it, so a system reading
`items` receives one line out of five. Either way the ERP answers 201, nothing
is logged, and the buyer finds out when the goods arrive. So the array is named
from the mapping (`items.0.sku` → `items`), and the mapping's own field wins
inside it.

**What it will not connect to.** A portal with a login and no API. That would
mean browser automation against a site whose terms almost certainly forbid it,
with a session belonging to a person rather than to an integration, breaking the
first time somebody moves a button. The wizard says so in those words rather
than offering a username and password field that would imply otherwise.

### Every step starts at the top

The wizard is one route with six panels inside it, so nothing the router does
applies: `StoreLayout` resets the scroll on a path change, and the path never
changes. Pressing Continue at the bottom of a long step therefore swapped the
panel out from under the viewport and left the reader looking at the footer of
a form they had just finished, with the new step's first question somewhere
above them — and every step began with a scroll back up.

Changing the step now puts the page at the top and moves focus to the step
rail. Both halves matter. The button that was focused has just been unmounted,
so focus would otherwise fall back to `<body>` and a screen reader would be
told nothing about the step it is now on; the rail carries `aria-current`, so
landing there announces "Setup steps, 3. Network, current step" — which is what
a real page load would have said.

It is skipped on arrival, because arriving IS a route change and the layout has
already done both.

### The wizard, in six steps

1. **Choose system** — the catalogue, with a search box: type "dyn", "tally" or
   "iON" and pick the brand. Each card carries the protocol that speaks to it,
   and a warning where that system is usually inside the buyer's own network or
   where its paths are examples rather than its published API. Picking one
   names the connection after it, narrows the authentication methods to the ones
   that system accepts, and fills the address placeholder with a real example.
   Also on this step: the ERP version, and whether this is a test system or a
   live one.
2. **Connection details** — the address, how it authenticates us, the API
   version, and the credentials. Only the fields the chosen method actually uses
   are shown.
3. **Network** — public HTTPS, behind an IP allowlist, through a VPN gateway, or
   through SAP Cloud Connector. This does not change what the code does; it
   records what the buyer's IT team has to set up, and shows them the
   instructions for it.
4. **Endpoints** — which address does what, its method, how it pages, and where
   the records are in the answer.
5. **Field mapping** — our field names against theirs, with a **Test and
   preview** button that reads one real record from their system and reports,
   field by field, what was found and what was not.
6. **Sync rules** — source of truth, direction, conflict policy, whether stock
   writes need a person, an approval threshold, which events to send, and which
   of our warehouses is which of their plants.

   **Send-only and read-their-stock cannot both be true.** A connection whose
   direction is outbound never reads the buyer's ERP, so switching stock syncing
   on as well is refused, with the two ways to resolve it — rather than quietly
   widened to two-way, which is a decision about whose numbers may change whose
   and not one this code gets to make on somebody's behalf. Accepted silently,
   it produced a sync that called the buyer's system every fifteen minutes,
   discarded every record, and reported success.

The connection is saved as a **draft** after step 2, because everything after
that needs a connection that exists — the endpoint step validates paths against
the saved address, the OAuth button needs somewhere to put the tokens, and the
mapping check needs a real response from a real call. A draft is inert: no
traffic, no jobs, nothing selectable by anything.

**Switching it on is refused** unless a test has passed, the mapping has been
checked against a real response, and an endpoint exists for everything the rules
say will be sent. All three are cleared the moment the configuration changes —
because whatever the last test proved, it proved about settings that have since
been replaced.

**What "the mapping" means depends on what the connection does.** `mappedEntitiesFor`
decides it, and every entity is gated on the policy flag that decides whether it
is ever sent: ORDER on `sendPurchaseOrders`, INVOICE on `sendInvoices`, INVENTORY
on `syncInventory`, PAYMENT on `sendPaymentReferences`. ORDER used to be ungated,
and being the only one made a **read-only connection impossible to switch on**: a
buyer whose ERP is a product list, with purchase orders switched off, was still
required to map an order number, a currency and a line quantity — to a system
that has none of the three, for a purchase order that was never going to be
raised. `sendPurchaseOrders` defaults to **true** where a connection has
expressed no opinion, matching the endpoint check beside it: purchase orders are
what this feature is for, and switching them off is the deliberate act.

### "Do the two systems hold the same products?"

The question every buyer has on the first day, and for a long time the only
answer was a sync log saying *"read 736 records and recorded 1"* — accurate, and
silent about which one and about why the other 735 went nowhere.

**Product matching** is the tab that answers it. `reconcile.service.ts` walks
the buyer's feed through the same connector the sync uses, compares it against
this store's catalogue, and returns three sets:

| | What it means |
|---|---|
| **In both systems** | A product here whose SKU was found in theirs. The only ones the integration can act on. |
| **Only in their system** | A code their ERP sent that matches no product here. Usually not an error — their ERP holds their whole catalogue, we hold the part they buy from this store. |
| **Only here** | A product in this catalogue their ERP has never mentioned. **The one that costs money**, because its stock figure will never be updated and nobody would notice. |

Three design decisions worth keeping:

- **It is a live read on a button, not a stored report.** The matched set is
  already in `customer_erp_inventory_links`; the other two are not, and nothing
  stores the codes that did *not* match. A table for them would be a schema
  carrying a copy of somebody else's catalogue, kept current, for a screen
  looked at occasionally. So it costs one sync pass and happens when a person
  asks.
- **Matching is on SKU, exactly.** Not case-folded, not fuzzy. `FG/1BZ1B1-G`
  and `EV-CANNULA-WP` are different products until somebody says otherwise, and
  a reconciliation that guessed would attach a stock figure to the wrong item
  and be believed.
- **Nothing matching at all gets its own sentence**, because it almost always
  means one thing — the two sides use different product codes — and saying so is
  worth more than three correct numbers a buyer has to interpret.

A feed longer than one pass reads sets `truncated`, and the screen says the two
"only in" figures may be higher. A partial read makes matched products look
unmatched, which is the one wrong conclusion this screen could lead somebody to.

### Authorising with OAuth, and where the redirect lands

Two of the connection's authentication methods are interactive: the buyer is
sent to their own ERP, signs in there, approves a list of permissions, and is
sent back. `OAUTH2_AUTHORIZATION_CODE` is that flow; monday.com production
connections always use it.

The route out is **Connect** on the connection screen, which calls
`POST /connections/:id/oauth/start`. That returns an authorization URL rather
than a redirect, because the caller is a `fetch` from a single-page app and a
302 in an XHR response is followed by the fetch, not by the browser — the buyer
would never see their own ERP's consent screen. The screen then assigns
`window.location`, so the consent screen is the top-level document and the buyer
can read the address they are signing in to.

The route back is a **storefront page**, `/account/integrations/erp/oauth/callback`,
and deliberately not this API:

- The API's callback is a `POST`. A browser redirected by GET found a 404 at the
  end of an authorisation that had otherwise worked.
- An authorisation code arriving as a GET parameter is an authorisation code
  written into the access log of every proxy on the way. Landing on a page keeps
  it in a request body on the buyer's own authenticated session.

The path is named in one place on each side — `OAUTH_CALLBACK_PATH` in
`oauth.service.ts` and the route in `apps/customer-web/src/app/router.tsx` — and
they have to move together, because the value is registered with the ERP and
compared byte for byte at token exchange. `CUSTOMER_ERP_OAUTH_REDIRECT_URI`
overrides it for a deployment whose public storefront address is not the one it
serves the storefront on; empty derives it from `CUSTOMER_WEB_PUBLIC_URL`.

**Nothing is carried across the redirect.** The ERP sends back exactly what it
was given — `code` and `state` — and anything the browser was holding is gone
the moment a provider decides to open the callback in a new tab. So the callback
does not send a connection id: the server recovers it from the `state` row it
issued. That relaxes nothing. The connection is still loaded through the
tenant-scoped loader, and `completeAuthorization` still refuses a state that is
used, expired, belongs to another connection, or was started by a different
member of the organisation — that last one is what stops a leaked authorisation
URL binding somebody else's ERP account to this buyer's connection.

A consent screen can also say **no**. A buyer who presses Cancel comes back with
`error` instead of `code`, and that is an ordinary outcome with its own words
rather than the failure message.

### A system with one set of OAuth addresses, and one with none

A self-hosted ERP serves OAuth wherever its administrator put it, so the wizard
asks for the token and sign-in addresses. A SaaS with one published pair does
not get asked: a connector may declare `oauthAuthorizationUrl` and
`oauthTokenUrl` in its defaults, the wizard stops asking, and the server uses
the connector's values whatever arrives in the request. monday declares
`https://auth.monday.com/oauth2/authorize` and `.../oauth2/token` — note
`auth.monday.com`, not the `api.monday.com` base address, which is precisely the
sort of thing a buyer asked to type it gets wrong once and diagnoses at a broken
consent screen.

The same step decides **what a buyer is not asked for at all**. Where the
authorisation goes through the operator's registered application — monday, via
`oauthUsesPlatformApp` — the client secret, the permissions and the redirect
address are all the operator's, so none of the three is rendered.

**A connector's offered authentication methods are narrowed by environment, and
the list may legitimately be empty.** `defaults(environment).authMethods` is the
authority: monday offers OAuth plus a personal token on a sandbox connection,
OAuth alone on a production one, and — where the operator has registered no
application — **nothing at all** in production, because the personal-token path
is sandbox-only and a production connection cannot be made. The vendor catalogue
is a static list of what a brand supports and knows nothing about environments,
so `/options` intersects the two before the screen ever sees them. Leaving that
unnarrowed is what once let a buyer pick production with a personal token, fill
in every remaining step, and be refused at the end by a rule that was knowable
at the first one.

### Why it is safe to let a customer type an address

It is, unavoidably, a server-side request forgery primitive with a form field in
front of it. The defence is in `infra/outbound-http.ts` and it is about
**addresses**, not about a blocklist of hostnames:

1. Only `http` and `https` exist. Everything else is refused by scheme.
2. HTTPS is required — credentials travel on every request.
3. The hostname is resolved **here**, before connecting, and **every** address
   it resolves to has to pass. A name answering with both a public address and
   127.0.0.1 is a rebind attempt wearing a round-robin costume.
4. Loopback, link-local (where cloud metadata lives), every private range,
   CGNAT, multicast, broadcast and their IPv4-mapped IPv6 spellings are refused.
5. The socket is **pinned** to an address that passed, so DNS cannot answer
   differently the second time.
6. Redirects are never followed automatically. A `Location` is a fresh URL that
   has been through none of the above, so it goes back to the top of the loop.
7. An endpoint path may be relative or absolute, and an absolute one is accepted
   only on the **same origin** as the connection. The same rule applies to a
   paging link the ERP hands back, with more force: that address was not typed
   by anybody, it arrived in a response body.
8. A **`#fragment` is refused everywhere**; a **query string is refused on the
   base address only**. The base address is a setting, and `?page=1` stored in
   it would be carried silently onto every call — but a request URL is where
   every paging style this platform speaks puts its cursor, so `/inventory?page=2`
   is the ordinary shape of an ordinary read. Applying the base-address rule to
   request URLs made every paginated endpoint unreachable, which is worth
   remembering before tightening it again.

On top of all that, an operator may set `CUSTOMER_ERP_ALLOWED_HOST_SUFFIXES` and
hold every customer to a list of permitted hosts. Empty is the default and the
right one for most deployments: customers' ERPs live at addresses nobody here
can predict.

### Where the secrets are

In `customer_erp_credentials`, and nowhere else. Every other table in this
feature can be read in full and handed to somebody without leaking a credential,
which is a property worth being able to state plainly.

- AES-256-GCM, with AAD binding each envelope to
  `customer_erp_credential:<connectionId>:<kind>`. A row copied into another
  connection fails authentication rather than decrypting into a working key for
  a system it was never issued for.
- **Nothing returns a secret** — not to the buyer, not to support, not to an
  admin. What a screen shows is a hint: `X-API-Key: sk_live...9f2a`. A client ID
  is shown in full, because it is not a secret and is the one part of an OAuth
  pair somebody can check against their own ERP's screen.
- **A save that omits a secret keeps the stored one.** That is what makes a
  masked edit form work: the buyer changes the timeout, the form sends no client
  secret because it never had one to send, and the secret survives. An empty
  string clears it, which is a deliberate act rather than the default.
- **Disconnecting destroys them.** Tokens are revoked where the ERP offers an
  endpoint, and every credential row is deleted either way. The audit trail
  records that a credential existed and was revoked, which is the part with
  evidential value; keeping the credential itself would mean a disconnected
  connection is still a standing authority against somebody's SAP.
- OAuth client secrets for **monday.com production** are the *operator's*, held
  in deployment configuration, because that is how monday's marketplace works.
  For SAP and custom connections they are the *buyer's* and are encrypted per
  connection. `oauthUsesPlatformApp` on the row says which applies.

### Reliability

Everything that touches a buyer's ERP goes through a row in
`customer_erp_sync_events` — the outbox — **including the things that turn out
not to need a call at all**. That is what makes "why did my purchase order not
appear" answerable: there is always a row, and it always says what happened.

Which is why **a sync counts records, not pages.** `applyInboundEvent` answers
per EVENT — a page of inventory is one event, and it is "applied" when anything
in it matched — so the poller adding the whole page's length to its applied
total reported a sync that recorded one product as having *"recorded 100"*. A
hundredfold overstatement, in the one log this feature promises can always say
what happened. The handler now returns `count` alongside `applied`, and the
poller uses it; an event with a single subject has no count and is worth its own
records.

The idempotency key is the whole design:

```
organizationId : subject : eventType : v<n>
```

Derived entirely from the thing that happened. Never from the clock, never from
a random source. A retry, a redelivered payment webhook, a second worker and a
manual send-again all derive the same key; the unique index admits one of them
and the rest find the row that is already there.

An ERP that received a purchase order and then received it again has a duplicate
liability on its books, and somebody in accounts payable finds out about it six
weeks later when two invoices arrive for one delivery. Everything else — the
leases, the backoff, the dead-letter state — is about noise. The key is about
correctness.

A genuinely new thing to say about the same order is a new `eventVersion`, and
therefore a new key and a new row. Never the old row again: **SUCCEEDED is
terminal and has no way out.**

| Connection state | Means |
|---|---|
| `DRAFT` | Being filled in. Nothing runs. |
| `TESTING` | A test is in flight. One at a time. |
| `ACTIVE` | Live. Events dispatch, polling runs, webhooks are accepted. |
| `PAUSED` | Stopped on purpose. Writes stop immediately; queued events are held, not dropped; webhooks are refused. |
| `ACTION_REQUIRED` | Waiting for a person — an expired authorisation, an undecided approval. |
| `FAILED` | Repeated failures took it out of service. Nobody chose this. |
| `DISCONNECTED` | Switched off, credentials destroyed, history kept. |

| Event state | Means |
|---|---|
| `QUEUED` | Waiting to be sent. |
| `PROCESSING` | A worker holds the lease. |
| `SUCCEEDED` | Done. Terminal. |
| `RETRYING` | Failed for a reason that may pass; `nextRetryAt` is set. |
| `FAILED` | Retries exhausted, or a failure no retry can fix. The dead letter. |
| `SKIPPED` | Deliberately not done, with the reason recorded. |

Failures are **classified** before they are retried, because the decisions are
entirely different: `AUTH` means stop and tell the buyer to reauthorise;
`RATE_LIMIT` means wait exactly as long as we were told; `TRANSPORT` and
`SERVER` mean try again later; `REJECTED` means the ERP understood perfectly and
said no, which no amount of retrying improves.

Backoff is exponential with jitter, capped, and overridden entirely by the ERP's
own `Retry-After`. An ERP that says "wait 300 seconds" and gets another request
in five has been told, by our behaviour, that its rate limiting does not work.

**A connection-level problem does not spend an event's retry budget.** Paused,
waiting on somebody, out of service — the event is fine and the connection is
not, so it is deferred and the attempt is given back. Burning six attempts over
a fortnight's pause would put a perfectly good purchase order in the dead-letter
list for a reason that was never its own.

**A platform order never fails because an ERP did.** The hand-off is queued
after the order's transaction commits and cannot roll it back. The order stands,
the money is accounted for, the dashboard shows what is still pending, and the
people who can act are told.

### Inbound: what their ERP tells us

A buyer's ERP calls us at `{API_PUBLIC_URL}/api/v1/erp-inbound/{slug}`. It is
the only unauthenticated route in the feature, because the caller is a machine
in somebody else's data centre that has no session and never will. Four checks,
in this order, before the payload is parsed as anything:

1. The slug names a connection that exists and is accepting deliveries.
2. A signing secret is configured. **There is no unsigned mode** — an
   unauthenticated endpoint that moves somebody's stock is not a feature.
3. The HMAC-SHA256 signature over the **raw bytes** verifies, in constant time.
   Raw bytes, because `JSON.parse` followed by `JSON.stringify` reorders keys
   and the signature was computed over what was sent.
4. The timestamp is inside the replay window. Without it a signature is valid
   for ever, so a captured request is a replay for ever too.

All four failures produce the same answer, with no indication of which check
failed — an endpoint that distinguishes them tells somebody probing it which
slugs are real. The row written to `customer_erp_webhook_events` *does* record
which, because only the buyer who owns the connection can read it.

The receipt is written **before** the payload is acted on, and the unique index
on `(connectionId, externalEventId)` is what makes a redelivery a no-op. Every
ERP retries, and a goods receipt applied twice is stock that does not exist.

For the ERPs with no outbound webhooks — which is most of them — there is
incremental polling with a cursor instead. The cursor is written back **only**
when a pass finishes cleanly: one advanced by a run that failed halfway is how
records get skipped for ever, and nobody notices until a stock figure has been
wrong for a month.

### Approvals

Two reasons a write waits for a person: the purchase order is at or above the
organisation's threshold, or the rules require approval for stock writes. Both
are raised at dispatch time, before a single byte goes anywhere, and the event
holds at `SKIPPED` naming the approval.

**Approving re-queues the same event under the same idempotency key**, which is
what stops an approval producing a second purchase order. Declining is final for
that event. An approval nobody decides expires, and the write does not happen —
a purchase order released three weeks late, against prices and stock that have
moved, is worse than one that never went.

### Instant Buy and Schedule Cart use the same path

Both, and by construction rather than by care. `transitionOrder` is the only
thing in the system that writes `orders.status`, so an instant purchase, a
payment link, a reconciliation sweep and every occurrence of a Schedule Cart all
arrive at the same line. Each occurrence gets its own link row and its own
events, because each delivery is receipted separately, and the occurrence id
rides along so an ERP that wants to group a subscription's deliveries can.

### What support can see

**Customer ERP** in the admin panel, behind `integration.read`. It lists every
customer connection with its tenant, system, state, host, failure count and the
safe error message — enough to say "your firewall is refusing us" or "your
authorisation expired on Tuesday" on a phone call.

It shows **no credentials and no hints** — absent, not masked. No endpoint
paths, no base URL beyond the host, no field mappings, and no request or response
bodies, because those hold the customer's own SKUs, quantities and prices.

And it is **read-only**. Staff cannot test, activate, pause, disconnect or retry
on a customer's behalf. Every one of those acts against a system this business
does not own, with a credential its customer supplied for their own purposes,
and "support pressed the button" is not a defensible answer to "who raised this
purchase order in our SAP". What support offers instead is a phone call and a
screen-share.

### Where it lives

| Thing | Where |
|---|---|
| Buyer screens | `apps/customer-web/src/pages/account/erp/` |
| Buyer API client | `apps/customer-web/src/lib/customer-erp.ts` |
| Support screen | `apps/admin-web/src/pages/CustomerErpPage.tsx` |
| Tenant, roles, invitations | `backend/src/modules/customer-erp/organization.service.ts` |
| The vault | `backend/src/modules/customer-erp/credential.service.ts` |
| The outbox | `backend/src/modules/customer-erp/event.service.ts` |
| What events mean | `backend/src/modules/customer-erp/pipeline.service.ts` |
| Connectors | `backend/src/modules/customer-erp/connectors/` |
| State machines | `backend/src/domain/customer-erp-state.ts` |
| Address safety | `backend/src/infra/outbound-http.ts` |
| Routes | `backend/src/http/routes/customer-erp.*.ts` |

Switched off by default. `FEATURE_CUSTOMER_ERP=true` turns it on; see SETUP.md
for the rest of the settings and for registering a monday.com app.


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

## 9.11 Loading a supplier product sheet

Most of this industry hands over a catalogue as a spreadsheet, and the one this
was built against is typical: 810 rows, 22 product categories stacked one under
another in a single worksheet, the same twenty-column header repeated under
every category band, and 736 product rows between them.

Three things in that file make it impossible to load with the CSV importer that
already exists:

1. **It has no prices.** Not "prices nobody has typed yet" — a B2B range is
   quoted per account, and the sheet is right not to carry one. It does have an
   MRP column, which is a consumer-facing figure from a different market under
   a different regulation, and is emphatically not this deployment's selling
   price.
2. **It sells in packs.** `100Pcs x 20Box=2000Pcs` is the whole commercial
   relationship: a hospital orders two cartons, not four thousand syringes.
3. **It carries the operator's own workflow** — licence status, production
   capacity, "Working on it" — mixed into the same rows as the product facts a
   buyer is allowed to see.

### The command

```bash
cd backend
npm run catalog:import -- "C:\path\to\sheet.xlsx"            # dry run
npm run catalog:import -- "C:\path\to\sheet.xlsx" --apply    # writes
npm run catalog:import -- "C:\path\to\sheet.xlsx" --apply --publish
```

A dry run is the default, deliberately: the destructive spelling is the one you
have to type, not the one you get by forgetting a flag. `--sheet "<name>"`
picks a worksheet, `--actor <email>` names the administrator the audit log will
record, and `--out <path>` writes the whole report as JSON.

`--publish` runs each imported product through the ordinary `publishProduct` —
the same completeness check, the same GPSR/MDR assessment and the same audit
entry as publishing one by hand. Nothing is bypassed; a product that fails the
check stays a draft and the report says why. It saves four hundred clicks, it
is not a way around the gate.

### Five rules the importer keeps

**It never touches a price or an image.** Not on create, not on update. Column
M is mapped so the contract is complete and readable, and then never read. A
product it creates gets a zero base price and the `isPriceOnRequest` flag; a
product it finds again keeps whatever an administrator has set since.

**It never publishes by itself.** Everything lands as a DRAFT, exactly like the
CSV importer. `--publish` is a separate, explicit act by the operator running
it.

**It never deletes.** A product absent from the file is left alone. A catalogue
cull is a decision, not a side effect of somebody sending a shorter sheet.

**Identity is a composite fingerprint, never one column.** The source workbook
contains 18 product codes used more than once, 50 barcodes used more than once,
six rows whose product code is literally `N/A` and seven whose code is
`Generic`. Keying on either column alone merges a 14G cannula into an 18G, and
that merge is silent, permanent and very hard to notice. The fingerprint is a
SHA-256 of the normalised category, product code, barcode, generic name, model,
brand and packing type; it lands on `products.importFingerprint` (the family)
and `product_variants.importFingerprint` (the row). Both are UNIQUE and
NULLABLE, and both halves matter — MariaDB treats every NULL in a UNIQUE index
as distinct, so every hand-made product leaves it empty while the index still
guarantees a re-import updates the row it made last time.

**A dry run and a real run share one code path.** `plan()` does all the reading,
matching and deciding; the write step only applies what the plan says. A preview
that disagrees with the outcome is worse than no preview.

### How the sheet is read

The layout is not a table, it is 22 tables stacked in one sheet, so every row is
classified before any of it is mapped:

```
row 1   6. Product Code Sheet - Monday (QF-73-01-01A Rev.00)   ← document title
row 2   Oral Dosing Syringe                                     ← CATEGORY
row 3   Name | Subitems | UDI (GTIN NO.) | …                    ← header
row 4   FG/1BZ1B1-G | 8904379806824 | 1 ML ORAL DISPENSING …    ← product
…
row 16  (a lone date)                                           ← revision stamp
row 17  Enfit syringe                                           ← CATEGORY
```

A lone value in column A is a **category** when a header row follows it and the
**document title** when another category does. A lone date is a revision stamp.
A row with fewer than three filled columns is not a product. Anything that is
none of those is recorded as skipped **with the reason** and appears in the
report — never silently dropped, and never turned into a product on the grounds
that it had some text in it.

### Products and variants

Rows group into a **product family** by category, generic name, brand,
sterilisation and packing type. The **model or size** is deliberately not in
that key — varying it is exactly what makes a row a variant. So seven gauges of
one branded cannula become one listing with seven sizes rather than seven
near-identical listings side by side in a grid. The workbook's 734 usable rows
become **223 products and 734 variants**.

Packing type *is* in the key, because the same syringe is listed as a blister
pack and as a ribbon pack with different barcodes and different carton sizes.
Those are two things to order, not one thing described twice.

**The product code is not in the key, and that one was learned the hard way.**
It was originally the fallback for a row whose column D is blank — and a
product code is unique per *row* by design, so the fallback quietly turned
every unnamed row into a product of its own. Eight safety needles differing
only in gauge came out as eight identical cards; the Easy Flush ribbon
syringes as forty. A hundred and forty rows of the workbook carry no generic
name, and all of them were affected. With no code in the key an unnamed row
groups on its category, brand, sterilisation and packing — which is what a
buyer means by "the same product" — and its gauge or fill becomes a size under
it. That correction alone took the catalogue from 340 listings to 223.

Two more things keep a grid free of cards that read alike:

- **Punctuation does not make a second brand.** `normaliseForMatch` reduces
  runs of punctuation to a single space, so the source's "Easy Flush(Balmung)"
  and "Easy Flush (Balmung)" are one brand rather than two. On a
  character-for-character comparison they split one product into four listings.
- **A name that would repeat gains what separated it.** Three products of one
  brand that differ only in packing are genuinely three things to order, and
  they were all called "Flush Syringe · Easy Flush". `disambiguateNames` runs
  over the finished plan and appends the packing type — then the sterilisation
  if that is still not enough — because "is this name unique" is not a question
  one family can answer about itself.

### Changing a grouping rule

A variant is found by its own fingerprint, which does not depend on how rows
are grouped. So correcting a grouping rule re-points existing variants onto
their new product — `productId` is in the variant *update*, not just the
create, for exactly this — and leaves the old products holding nothing.

The importer never deletes, so those are **reported rather than removed**: the
run ends with a "Products left with nothing to sell" section naming each one,
for an administrator to archive. An empty product is a listing with nothing in
it, and it stays published until somebody acts on it.

### Column N: reading "how many are in a box"

The column is free text and nobody standardised it. One workbook contains all
of these, meaning the same thing four ways:

```
100Pcs x 20Box=2000PCS          100pcs×10box=1,000 pcs/Outer
100pcs-inner/outer-100*20=2000  inner -40 pcs/outer -160 pcs
50 pcs one pouch/400 pcs        400Pcs
```

Two rules govern the parser in
`backend/src/modules/catalog/sheet-import/packing-parser.ts`:

**Never invent a number.** `400Pcs` says a carton holds four hundred. It does
not say how they are boxed inside, and a plausible-looking inner count made up
here would be picked by a warehouse and shipped. A missing figure stays missing
and the status says `PARTIAL`.

**Never silently correct one.** Where the source states all three numbers and
they do not multiply out, the row is `NEEDS_REVIEW` with every figure kept as
written. Quietly replacing the stated total with the product of the other two is
how a customer ends up disputing a quantity nobody can explain — and the sheet
is as likely to be right about the total as about the factors.

Deriving is not inventing, and the difference is **exact division**. Given 50 to
a pouch and 400 to a carton, "8 pouches" is arithmetic with one answer, and it
is recorded with a message saying where it came from. Given 50 and 410, nothing
is derived.

The raw text is kept beside whatever was read out of it, always. It is the only
thing that can settle an argument about what the supplier actually said.

### Dimensions, and the unit nobody wrote down

Columns J, K and L are box sizes and column I is the sticker artwork. The hard
part is not the separators (`460*350*210 mm`, `168 X 124 X 155`, `27 x 134`), it
is the unit: some rows state one, most do not, and one is in inches. A unit is
recorded **only when the source names it**. A dimension without one is shown as
written, with the fact that it has no unit visible rather than hidden —
assuming millimetres onto a measurement given in inches is a twenty-five-fold
error in a figure somebody sizes a pallet against.

Column I never reaches a customer. It is a print specification for the
operator's label supplier, and a buyer reading it in a list of box sizes would
measure a shelf against a label. The public select filters it out by name; the
admin panel shows it, labelled internal.

### What the report says

Every section is present even when its count is zero, so a reader can tell
"nothing was wrong" from "that check did not run":

```
Categories detected      22      Products created  223
Candidate product rows   736     Variants created  734
Rows skipped             0       Images changed    0
Exact duplicates skipped 2       Prices overwritten 0

Packing read in full        686     Rows with no barcode      50
Packing partly read         38      Reused codes and barcodes 71
Packing needing review      0       Dimensions with no unit   2099
```

Reused identifiers are listed row by row and imported **separately**, never
merged. Ambiguity is a thing for a person to look at, not a thing for an
importer to resolve.

### Where the internal columns go

Production capacity, launch date, manufacturing licence, test licence and the
workflow status live on `product_import_records`, a table of their own, together
with the source file name, the worksheet, the row number, the import timestamp
and the raw row as JSON. A separate table rather than columns on `products`
makes the boundary structural instead of a rule somebody has to remember on
every future read — and there will be future reads.

The one decision the importer takes from that data is taken once, at import
time: a product whose status is **Hold** or **Working on it** is created with
`isOrderable = false`. Nothing reads the status string afterwards, so a new word
appearing in the column next year cannot quietly change who is allowed to buy
what.

---

## Price on request, and listed-but-not-for-sale

Publication answers "may a customer **see** this". Two new columns on `products`
answer "may they **buy** it", which is a different question with different
answers.

`isPriceOnRequest` says the price is negotiated per account. The storefront
shows **Request a quote** where the figure would be, the buy button is replaced
rather than greyed out, and the publication check accepts a zero price and the
neutral placeholder image. Nothing priced on request can reach a basket — there
is no figure to charge.

`isOrderable` says the product is listed and readable but not for sale this
week. The listing and its specifications stay exactly as they are and every
purchase path is refused, with the operator's own sentence in
`unavailabilityReason` shown beside the notice. Unpublishing would 404 a URL
somebody bookmarked to read the specification; this does not.

Both default to the behaviour that was already there — price-on-request off,
orderable on — so a deployment that never sets either behaves exactly as it did.
A catalogue does not have to stay priced on request either: `catalog:prices`
takes it out of that state with a placeholder that is marked as one — see
*Placeholder prices* below.
Both are enforced in one place, `assertPurchasable` in
`backend/src/modules/catalog/purchasability.ts`, which the basket, Instant Buy
and scheduled plans all call. Two copies of that rule is how one of them
eventually forgets a case, and the case it forgets is a customer charged for
something nobody priced.

One consequence worth knowing: the storefront listing is **rooted at
`product_prices`** so that the grid can sort and filter on the figure a shopper
is actually shown. A product with no row in their currency cannot appear at all.
So the importer writes one empty row, valued at zero, per new product — created
once and never touched again, so a price typed afterwards survives every
re-import. That zero is excluded from the price-range facet and from the price
and on-offer filters, because it is a placeholder rather than an answer to a
question about price.

---

## Placeholder prices, and finding them again

A catalogue imported from a supplier sheet has no prices. Priced on request, it
is readable and correct and **cannot be demonstrated**: no basket, no checkout,
no schedule, no totals. So there is a command that gives every unpriced product
something to sell at while the real figures are gathered.

```bash
cd backend
npm run catalog:prices                        # dry run, the default
npm run catalog:prices -- --apply
npm run catalog:prices -- --apply --fallback 250
npm run catalog:prices -- --list              # what is still a placeholder
```

It sets the price, clears `isPriceOnRequest`, and the product becomes an
ordinary one: **Add to cart**, **Instant Buy** and **Schedule your Cart** all
work exactly as they do for anything else in the catalogue.

### Where the number comes from

Column M of the supplier sheet, where the sheet filled one in — 147 of the
workbook's 736 rows do. That is the operator's own figure rather than one
invented here. Everything else gets `--fallback`, one flat amount, deliberately
obvious rather than plausible.

**The importer still does not read column M**, and the note in
`sheet-mapping.ts` saying so is still true. An MRP is a consumer retail price
from another market under another regulation, and importing it *as* the selling
price — silently, as part of loading a catalogue — would put a figure in front
of a buyer that nobody in the business agreed to charge. Reading it here is a
different act: a person runs this command on purpose, knowing the result is a
placeholder, and every row it touches is flagged as one. The figure comes out of
`product_import_records.rawJson`, which is exactly the audit trail that table
exists for.

### Why there is a column for it

`products.hasProvisionalPrice`. It exists because of what happens afterwards: a
placeholder and a real price are the same `BIGINT`, so without a marker
"which of these two hundred prices did we make up?" has no answer once the run
has finished. A placeholder that cannot be found again is a placeholder that
ships — and this one would ship attached to medical consumables.

Three things keep it honest:

- **Any price edit clears it.** `updateProduct` sets it false whenever
  `basePriceMinor` is set, so a flag that had to be unticked separately can
  never drift out of step with reality. Re-typing the same figure still clears
  it: confirming a placeholder *is* confirming it.
- **The admin panel says so, loudly.** A warning sits at the top of the
  Availability card — a quiet chip would be read as decoration, and the only
  thing between a made-up figure and a real invoice is somebody noticing.
- **It is not in the public product select.** A customer sees the price behave
  exactly like any other. This is a note to the operator about their own
  catalogue, not a disclaimer on a shop.

`--list` prints every one, grouped by department, and the list only ever
shrinks.

### Two money details

The conversion from a typed decimal to minor units is `domain/money.ts`'s
`parseMajorToMinor`, not a local copy. It is currency-aware — a yen amount has
no minor units at all, and a second implementation would price every JPY item a
hundred times too high — and `Number('2.5') * 100` is 250.00000000000003, which
is the whole reason this project has a money rule.

A product listed in a currency the command has no figure for is **left alone**
rather than priced in the wrong one. Quoting a JPY item at an INR number is
precisely the mistake `product_prices` exists to prevent.

---

## Packaging, and ordering by the box

A wholesale buyer's first question about a consumable is not what it costs, it
is how it is boxed — that is the unit they order in, the unit their store room
counts in, and the unit their own purchase order is written in.

**The listing** carries one line: `100 per box · 2,000 per carton`.

**The product page** gets two new sections. *Packaging and ordering* breaks the
figures out, states the conversion as one sentence — `100 pieces × 20 boxes =
2,000 pieces` — and offers a ready-reckoner for 1, 2, 5 and 10 of whichever unit
the buyer is counting in. *Dimensions* shows the three box sizes as the supplier
recorded them.

Above the quantity boxes sits a three-way control — **Pieces / Box of 20 /
Carton of 2,000** — and under them a live line saying what the choice comes to:
*That comes to 4,000 pieces.* Only units the catalogue can actually convert are
offered, and a row whose figures contradicted each other offers pieces only.

**The price follows the unit.** Switch the control to *Carton of 2,000* and
the headline figure becomes what a carton costs, with the per-piece price kept
on the line underneath — *per carton of 2,000 · ₹100.00 per piece* — and every
option in the list repriced the same way. A buyer who is thinking in cartons
should not have to do the multiplication on a calculator beside the screen.

This is not a second pricing engine and must not become one. It multiplies one
catalogue price by one catalogue pack size, both of which came off the server,
and it still prints no total: no tax, no discount, no sum across the options
chosen. The strike-through is scaled by the same factor, because a tenth off a
piece is a tenth off a carton and scaling only one side would invent a saving
nobody offered. The arithmetic is `multiplyMinor` in
`apps/customer-web/src/lib/format.ts` — BigInt minor units multiplied by a
whole count of physical things, exact, and never a float.

Two rules hold this together.

**Quantity is always pieces.** `cart_items.quantity`, `order_items.quantity` and
`recurring_schedule_items.quantity` mean exactly what they meant before, and
every price, tax, reservation and stock path reads them unchanged. Three new
columns beside each — `orderingUnit`, `unitQuantity`, `piecesPerUnitSnapshot` —
record what the buyer chose. Had the quantity column itself learned about packs,
every one of those paths would have had to learn too, and one of them would have
been missed.

**The conversion is done on the server, from the catalogue's own packing row,
and snapshotted.** A client that could post its own "pieces per carton" could
post 1 and buy a carton at the price of a syringe. And packing gets corrected:
"2 cartons" has to keep meaning the 4,000 pieces it meant on the day it was
agreed. That matters most on a schedule, where the charge happens months later
inside a worker with nobody watching.

**Packing is not a minimum.** A carton of 2,000 does not mean 2,000 is the least
somebody may buy; the minimum order quantity is a separate rule the operator
sets deliberately. The page says so, because a B2B buyer who has met both will
assume otherwise.

---

## Product photographs, and the ones that do not exist

The supplier sheet carries no images — see 9.11 — but `Images/` does: thirty of
SPM's own product shots at 4167 x 4167, most of them captioned with the product
name. Those are the catalogue's photographs. Two commands put them on products.

```bash
cd scripts  && npm run images            # resize into backend/assets/product-images
cd backend  && npm run catalog:images    # dry run: what would be attached
cd backend  && npm run catalog:images -- --apply
```

The first is mechanical: thirteen of the thirty shots — one per distinct
product, the rest being second angles of the same thing — resized to 1200px on
the long edge and named after what they show. Thirty-nine megabytes becomes half
a megabyte, because a product shot on white compresses to almost nothing.

The second decides which product gets which photograph, and that decision lives
in `backend/src/modules/catalog/product-images/image-rules.ts` as a table a
person can read and a test does check. Three rules govern it.

**Only the operator's own photographs.** Nothing is fetched from the internet.
A stock photograph of somebody else's surgical glove attached to this
catalogue's glove is a fabricated product record, and on a medical device that
is worse than the neutral placeholder the grid already draws.

**No picture beats a near one.** An insulin syringe is not a hypodermic
syringe — same shape, same colour, different graduations, and the graduations
are the entire product. The Insulin Syringe department therefore gets the
photograph only for the plain hypodermic and auto-disable products inside it,
and the insulin syringes get none.

**It only ever adds.** A product that already has a photograph is left alone,
always: an administrator's upload outranks a table in this repository, and a
second run must not stack one on the other.

One upload per photograph, not per product — two hundred cannulae share a single
`media_assets` row, matched on the checksum the storage driver computes. On the
catalogue this was written against: **121 products photographed from 13
uploads.**

### What is still unphotographed

The run reports it by department, which is the useful half of the output:

```
Departments with no photograph in Images/
    28  Insulin Syringe          10  Ryles Tube
    15  Adult diaper              9  Suction Catheter
    12  Oral Dosing Syringe       7  Enfit syringe
    12  Surgical Gloves           5  Infant Feeding Tube
     3  Oral Syiringe             1  Disinfectant Cap
```

Those keep the placeholder. Photograph them, drop the file in `Images/`, add a
line to `prepare-product-images.mjs` and a rule to `image-rules.ts`, and re-run.
Nothing invents a picture for them in the meantime.

---

## Category marks

`components/icons.tsx` carries six abstract stock shapes for category cards, and
the reasoning beside them is sound in general: a storefront does not know what a
category contains, and a wrench beside "Cleaning chemicals" is worse than no
picture at all.

That reasoning stops applying when the catalogue is one trade and the
departments are named "IV Cannula" and "Ryles Tube". A cannula drawn beside "IV
Cannula" cannot be wrong about what is in it, and a hospital buyer scanning
twenty-two departments finds the one they came for by shape well before they
finish reading the labels.

So `lib/category-mark.ts` matches a department NAME against a list of names this
catalogue recognises and returns a drawn medical icon from
`components/category-icons.tsx` — nineteen of them, one per thing the catalogue
actually sells. Anything unrecognised falls back to the abstract geometry, which
is still the right answer for a department nobody has described.

Three details are load-bearing:

- **Order.** First match wins, so narrow names are tested before the ones that
  contain them: "Closed IV Cannula" before "IV Cannula", "ABG Kit" before "ABG
  Syringe", "Sterile Water With 10% Glycerine" before "Sterile Water". Reversed,
  three departments would get a plausible wrong picture, which is the kind of
  wrong nobody reports.
- **Whole words.** A rule matching "cannula" anywhere would claim "Cannula
  Dressings", which is a dressing.
- **The name, not the slug.** The same department is slugged differently in two
  deployments and named the same way in both.

They are drawn rather than downloaded, for the same reasons every other icon
here is: one stroke weight, `currentColor` so they follow the theme in light and
dark, no request, no licence — and each one can be drawn for the actual product,
which is why the ENFit syringe has a different tip from the oral one.

---

## Searching a catalogue sold by the code

A buyer working from a supplier's paperwork types the product code or the
barcode off it, not the marketing name — and on a catalogue whose sizes are
separate variants, both of those live on the variant rather than on the product.
So `?q=` now also matches the product's GTIN and model identifier, and every
active variant's SKU, GTIN, model identifier and name. Without the variant half,
searching for the exact code printed on the box returned nothing.

`?model=` filters on a size — `14G`, `3 ml` — across the product and its
variants. It needs its own parameter because a product attribute is unique per
name per product, and a listing with seven gauges has seven sizes.

Brand, sterility, sterilisation method, packing type and shelf life need no code
at all: the importer writes them as **filterable specifications**, so they
appear in the existing `attr=Name:Value` facet panel on both the storefront and
the admin list automatically.

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
| `DELIVERY_COVERAGE_RADIUS_KM` | `500` | How far a warehouse delivers **when the warehouse itself does not say**. A commercial promise rather than a technical limit, which is why it is a setting: 500 km is a day's run for a warehouse with its own fleet and nothing like the right number for a city depot handing over to a bike courier. Since geofencing, each warehouse carries its own `deliveryRadiusKm` and this is the fallback for the ones that have not been given one — which is the useful way round: move the whole business's promise by editing one line here, and override the two buildings that are different. The panel is told this by the warehouses response and never assumes it; the coverage endpoint accepts any radius up to 1,000 km for trying one out |
| `MAP_STYLE_URL` | *(empty)* | A MapLibre **style JSON** URL — vector tiles. **The setting that puts every place name in one language**, because a vector tile carries `name:en` as data. Keyless public ones exist (OpenFreeMap's `https://tiles.openfreemap.org/styles/liberty` is planet-wide OpenStreetMap data); commercial providers put a key in the query string; a firewalled installation points this at its own |
| `MAP_STYLE_ATTRIBUTION` | *(empty)* | Added to what the style's own sources already declare, which is why it is usually left empty. For a self-hosted style that declares none |
| `MAP_TILE_URL` | *(empty)* | The XYZ **raster** tile template behind the Warehouses map. Empty means no tiles: markers are plotted on a plain ground and everything else on the screen works unchanged. Note that raster place names are baked into the image in the local language and cannot be translated |
| `MAP_TILE_ATTRIBUTION` | *(empty)* | Shown in the corner of the map. Every tile licence requires it |
| `GEOCODE_FORWARD_URL` | Nominatim | Turns a typed address into coordinates for the "look up" button. `{query}` is substituted. Empty switches it off |

**Four providers, and the panel has an implementation of each.** The
warehouses response carries a `map` field — `{ provider: 'NONE' }`,
`{ provider: 'RASTER', tiles }`, `{ provider: 'VECTOR', style }` or
`{ provider: 'GOOGLE', apiKey, mapId }` — and that is what decides which map
library the browser downloads. A deployment on Google never downloads MapLibre;
one on OpenStreetMap never fetches a line of Google's API.

**`VECTOR` is the one that gets the labels into one language, and that is
usually the reason to configure a map at all.** A raster tile is a finished
picture with the place names already drawn into it in whatever language is
local to that place; a vector tile carries the names as fields, so
`labelInEnglish` in `WarehouseMapLibre.tsx` can point every label at
`name:en` and get English worldwide. It reads the layers the style actually
declared rather than any list kept here, so it works on a style this repository
has never seen — and it skips any symbol layer whose label does not mention a
name, because a motorway shield draws `ref` and rewriting it would blank it.
The formatting a style put in its own labels is lost in the trade: one language
everywhere is worth more to the person reading this screen than the style
author's typography.

**The order is Google, then vector, then raster**, and it is the order of how
deliberately somebody had to arrive there — nobody sets a Google key or a style
URL by accident. An operator moving an installation forward sets the new
provider's variables and nothing else; falling the other way round would leave
them looking at the provider they had just left, with nothing on the screen
saying why the setting they added did nothing.

**Empty is the default for all of them, and it is the private one.** Every
provider discloses which part of the world is being looked at, and in this
product that is where the buyer's warehouses are — so nothing is requested until
the operator asks for it. With none set the markers sit on a plain ground, the
scale bar still works, and the screen says in words that there is no background.

**Google's tiles cannot be used as a style or as raster tiles.** There is no
public tile endpoint and their terms forbid reaching for one, which is why
Google is a separate pair of settings rather than another value for
`MAP_STYLE_URL`, and why the panel carries two map implementations rather than
one. The OpenStreetMap paths stay for the installation behind a firewall with
its own style or tile server, and for the operator who will not send warehouse
coordinates to Google.

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

## Fulfilment and delivery dates

Two numbers that decide what a buyer is offered, and both are settings rather
than constants for the same reason: the operator who bought this software is
not the author, and a figure compiled into a JavaScript bundle is a figure they
cannot change. Both are published to the browsers in `/config` under
`fulfilment`, and each frontend keeps its own fallback only for the moment
before that answer lands.

| Variable | Default | Effect |
|---|---|---|
| `SCHEDULE_MIN_NOTICE_DAYS` | `7` | How many **calendar days** of notice a schedule's first delivery needs, counted on the customer's own clock. Zero is a real setting — a shop delivering from stock in the buyer's own city has no week to ask for. The picker greys out everything below it; `createSchedule` and `updateSchedule` refuse it with `SCHEDULE_DATE_TOO_SOON` whatever the browser did. Note this is only half the floor: a plan pinned to a warehouse is held to `max(this, that warehouse's soonest)` — see 9.5 |
| `FULFILMENT_QUOTE_TTL_MINUTES` | `15` | How long a warehouse option stays an offer. Each option written by `POST /fulfilment/warehouse-options` carries an expiry, and after it the quote is refused rather than repriced — which is what makes the total on the card the total on the order. Too short and a customer reading the page loses their offer mid-decision; too long and the shop is holding a price against stock that has moved. The checkout page is told the figure so it can re-ask *before* the lapse rather than after |

Neither has a feature flag, and neither needs one. A deployment that has drawn
no delivery zones gets no warehouse options, the checkout section says nothing,
and orders are fulfilled the way they were before any of this existed.

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
├── scripts/
│   ├── dev-stack.ps1               ← Start, stop and check the whole dev stack
│   ├── build-feature-guide-doc.mjs ← The plain-language feature guide, as code
│   └── auto-translate.mjs          New i18n keys into the other seven languages
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
│   │   │   ├── schedule-state.ts   ← Legal plan and occurrence transitions
│   │   │   └── ordering-unit.ts    ← Packs to pieces, done on the server
│   │   ├── infra/                  Database, crypto, ids, queue, email, storage
│   │   ├── http/
│   │   │   ├── app.ts              ← Plugin order, CORS, raw body, error envelope
│   │   │   ├── server.ts           Entry point
│   │   │   ├── openapi.ts          Hand-written summaries over the live route table
│   │   │   └── routes/             27 route files
│   │   ├── modules/                ← The business logic
│   │   │   ├── catalog/
│   │   │   │   ├── purchasability.ts   ← The one "may this be bought" rule
│   │   │   │   ├── packaging.service.ts  Packing, on its way to a screen
│   │   │   │   └── sheet-import/       ← Loading a supplier product sheet
│   │   │   │       ├── xlsx-reader.ts        A small, read-only .xlsx reader
│   │   │   │       ├── packing-parser.ts     ← "100Pcs x 20Box=2000Pcs"
│   │   │   │       ├── dimension-parser.ts   Box sizes, and the missing unit
│   │   │   │       ├── sheet-values.ts       ← Normalising, and the identity fingerprint
│   │   │   │       ├── sheet-mapping.ts      Category bands, repeated headers
│   │   │   │       ├── sheet-import.service.ts  Plan, then write
│   │   │   │       └── import-product-sheet.cli.ts  npm run catalog:import
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
│   │   ├── ai/                     Its sidebar, composer, message and
│   │   │                           the verified product cards
│   │   ├── schedule/               ← Schedule Cart: the list, the editor,
│   │   │                           the cadence fields, the product picker
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
│   ├── lib/ai-products.ts          ← What a reply is allowed to become
│   ├── lib/schedule-cadence.ts     ← "How often", both directions
│   ├── lib/calendar-date.ts        ← A calendar day, without the timezone trap
│   ├── lib/timezones.ts            The clocks a schedule can run on
│   ├── components/DatePicker.tsx   The calendar, and the notice period it draws
│   ├── lib/delivery-window.ts      ← The floor the API enforces, asked for
│   ├── lib/fulfilment.ts           ← Warehouse options, and the quote checkout takes
│   ├── pages/checkout/FulfilmentWarehouseSection.tsx  ← "Choose your fulfilment warehouse"
│   ├── components/DeliveryOptionsPanel.tsx  The cart's browsing answer, not this one
│   ├── components/CartModeTabs.tsx Instant Buy / Schedule Cart
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
| Change the panel's language, market or sign-in place control | `apps/admin-web/src/layout/LocaleMenu.tsx` — one control; the market and the place are deliberately labels, and it says why |
| Add or correct a flag | `components/CountryFlag.tsx` in **both** apps — bands plus at most one mark; an unlisted country falls back to a letter chip |
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
| Put a background behind the warehouse map | `MAP_STYLE_URL` in `backend/.env` (or `MAP_TILE_URL`, or `MAP_GOOGLE_API_KEY` + `MAP_GOOGLE_MAP_ID`) |
| Get the map's country names in English | `MAP_STYLE_URL` — a vector style. Raster tiles have the local name painted into the picture |
| Change how long a marker must be hovered, or how long "Delivers to" lingers after the pointer leaves | `HOVER_INTENT_MS` and `HOVER_LEAVE_MS` in `pages/warehouse/WarehouseMapLibre.tsx` |
| Change how the "Delivers to" panel leaves | `COVERAGE_EXIT_MS` in `lib/delivery-coverage.ts` **and** the matching `duration-200` on the panel's root — see `lib/use-lingering.ts` for what keeps it mounted while it goes |
| Change how far one warehouse delivers | its **Delivery radius** on the warehouse form. Leave it empty and `DELIVERY_COVERAGE_RADIUS_KM` applies |
| Stop delivering to a country from one warehouse | **Countries this warehouse will not deliver to** on the warehouse form. The radius still reaches it; the storefront no longer offers it |
| Change how tall the coverage blocks stand | `EXTRUDE_MAX_M` and `EXTRUDE_MIN_M` in `pages/warehouse/coverage-visual.ts` |
| Turn the globe off, or change when it flattens | `map.setProjection` in `pages/warehouse/WarehouseMapLibre.tsx`; the globe/flat toggle is MapLibre's own `GlobeControl` |
| See or change what one warehouse holds | the **Inventory** button on the warehouse; `modules/inventory/warehouse-inventory.service.ts` reads it, and the Inventory screen is where it is written |
| Change the shelf's tilt, depth, shadow or reduced-motion behaviour | the `.shelf-*` rules in `apps/admin-web/src/index.css`, and `TILT_DEGREES` in `pages/warehouse/WarehouseInventoryDialog.tsx`. Read the note at the top of that CSS block before adding a transform to a card - it explains which ones swallow a click, and why one rule there lives outside every `@layer` |
| Change what a buyer is offered when two warehouses can serve them | `modules/inventory/delivery-options.service.ts`; the panel is `components/DeliveryOptionsPanel.tsx` in the storefront |
| Change what happens in the background | `src/worker/handlers.ts` |
| Change what a scheduled order costs | `modules/recurring/schedule-quote.service.ts` — the review screen, the estimate and the worker all use it |
| Change what a schedule's estimate returns | `modules/recurring/schedule-estimate.service.ts` — it calls `quoteSchedule` and nothing else |
| Change what the schedule editor can edit | `pages/schedule/ScheduleEditor.tsx`, and the `updateSchema` in `http/routes/schedules.ts` |
| Add or reword an interval a customer can pick | `lib/schedule-cadence.ts` — one mapping, read by the builder and the editor |
| Let a customer clear a finished plan off their list | `hideSchedule` in `modules/recurring/schedule.service.ts`, and `VISIBLE_TO_CUSTOMER` for the reads it has to narrow |
| Change which statuses may be hidden | `isTerminalPlanStatus` in `domain/schedule-state.ts` — and the CHECK constraint has to move with it |
| Change how much notice a first delivery needs | `SCHEDULE_MIN_NOTICE_DAYS` in the backend's environment — published to both browsers through `/config`, so the calendar redraws around it with no rebuild. `DELIVERY_NOTICE_DAYS` in `lib/schedule-cadence.ts` is only the fallback until that answer lands |
| Change which warehouse an order may ship from | The delivery zones on the warehouse (`WarehouseDeliveryZone`), not the map's circle — `modules/fulfilment/warehouse-options.service.ts` is what reads them |
| Change how long a warehouse quote stands | `FULFILMENT_QUOTE_TTL_MINUTES` in the backend's environment; the checkout page reads it back from `/config` and re-asks before it lapses |
| Change how a date is picked anywhere | `components/DatePicker.tsx`; the day arithmetic is `lib/calendar-date.ts` and never a `Date` |
| Change when an edit is refused because a delivery is in flight | `IN_FLIGHT_OCCURRENCE_STATUSES` in `modules/recurring/schedule.service.ts` — read the note first |
| Change what a product card under an AI answer shows | `GET /catalog/product-cards` for the data, `pages/ai/AiProductCards.tsx` for the card |
| Change what the assistant is allowed to have rendered | `lib/ai-products.ts` — the reply is split into words and identifiers there, and nothing else crosses |
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
