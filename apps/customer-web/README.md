# UBOSS Customer Website

The storefront: browse the catalogue, order, pay, and set up repeat purchases.
Separate from the Admin Panel and shares nothing with it but the API.

## Running it

The backend must be running first — this is a pure client.

```bash
# terminal 1
cd backend && npm run dev            # http://localhost:4000

# terminal 2 — recurring orders, notifications, exports
cd backend && npm run dev:worker

# terminal 3
cd apps/customer-web
npm install
npm run dev                          # http://localhost:5174
```

Sign in with a seeded customer: `buyer@acme.local` / `BuyerDev!2026`.
`invited@zenith.local` is left un-activated on purpose, to exercise the
invitation flow.

**The port matters.** The backend's CORS allowlist names `http://localhost:5174`
exactly, from `CUSTOMER_WEB_ORIGIN` in `backend/.env`, and the backend builds
activation and password-reset links against `CUSTOMER_WEB_PUBLIC_URL`. Vite is
configured with `strictPort` so a clash fails loudly rather than silently
moving to a port CORS will reject.

## Configuration

`.env` (copy from `.env.example`):

| Variable | Meaning |
|---|---|
| `VITE_API_BASE_URL` | API base, no trailing slash. Default `http://localhost:4000/api/v1` |

Everything else — business name, support contacts, currency, timezone, policy
links, and whether self-registration and recurring orders are available — comes
from `GET /api/v1/config` at runtime. Nothing about the business is hard-coded,
so renaming the company is an admin action, not a redeploy.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on 5174 |
| `npm run build` | Type-check and build to `dist/` |
| `npm run preview` | Serve the built output |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm run lint` | ESLint including `jsx-a11y`, zero warnings allowed |
| `npm test` | Component tests (Vitest + Testing Library) |
| `npm run verify` | typecheck + lint + test + build |

## Routes

| Path | Who | What |
|---|---|---|
| `/` | anyone | Home: categories and newest products |
| `/products` | anyone | The whole catalogue, filtered and sorted |
| `/category/:slug` | anyone | One category |
| `/search?q=` | anyone | Search results |
| `/product/:slug` | anyone | Product detail and Add to Cart |
| `/login` | anyone | Sign in |
| `/activate?token=` | anyone | Accept an invitation (link built by the backend) |
| `/forgot-password`, `/reset-password?token=` | anyone | Password reset |
| `/register` | anyone | Explains the invitation-only route |
| `/cart` | customer | Cart, with per-line corrections |
| `/checkout` | customer | Address, delivery, payment choice, review |
| `/checkout/payment/:orderId` | customer | Provider checkout and the wait for confirmation |
| `/order-confirmation/:orderId` | customer | Placed, with what happens next |
| `/schedules/new` | customer | Set up a repeat purchase |
| `/account/orders`, `/account/orders/:id` | customer | Order history and tracking |
| `/account/schedules`, `/account/schedules/:id` | customer | Repeat purchases |
| `/account/addresses`, `/account/profile` | customer | Account management |

Everything under `/account`, plus cart, checkout and payment, sits behind
`RequireCustomer`. That is a courtesy — the backend enforces the same rule on
every request, and checks the surface twice so an admin token cannot reach a
customer route.

## The rules this storefront holds to

These are not style preferences. Each one has a failure mode behind it.

- **The server owns the cart.** Every mutation returns the whole cart and that
  response replaces what is on screen. No local total, no local stock check.
  `checkoutReady` decides whether checkout is offered — not a count of issues
  computed here, which would drift the first time a new issue code appeared.
- **Nothing computes money.** Amounts arrive as `{ minor: string, formatted,
  currency }` and are displayed. `minor` is a string because a paisa-precise
  total can exceed `2^53`; `Number(minor) / 100` is the bug it exists to
  prevent.
- **The browser never decides an order is paid.** Razorpay's success callback
  fires in the customer's own tab and anyone can fire it. A closed sheet
  produces a Processing state and a question to the backend; only a
  signature-verified webhook changes the answer.
- **One order per checkout.** The idempotency key is generated when the
  checkout page mounts, outside the submit handler where nothing can
  regenerate it, and reused for every attempt. A double-click, a retry after a
  timeout, and a refresh-and-resubmit all resolve to the same order.
- **Retrying a payment reuses the same key**, so the backend replays the
  original session rather than creating a second payment.
- **Product content is never rendered raw.** `src/lib/safe-html.tsx` is the only
  place that touches `dangerouslySetInnerHTML`. It re-sanitises server-sanitised
  HTML with `DOMParser` — an inert document where scripts never run and
  `onerror` never fires — because regex HTML stripping is how sanitisers get
  bypassed.
- **Stock is never claimed.** The public catalogue deliberately does not publish
  quantities, so the product page says availability is confirmed on add rather
  than inventing "In stock".
- **Purchasing rules are shown before Add to Cart.** A minimum of 10 discovered
  at the cart has wasted the customer twice.

## Accessibility

- Every colour pair meets WCAG 2.1 AA. `--ink-subtle` and `--border-strong` were
  darkened specifically to clear 4.5:1 and 3:1 — the originals sat at 2.56:1 and
  1.48:1, which made helper text and input borders unreadable for low-vision
  customers.
- A skip link is the first focusable element; focus moves to `<main>` on
  navigation, because a single-page app never reloads and a screen reader would
  otherwise never learn the page changed.
- Every input has a real `<label for>`. Errors are tied to their field with
  `aria-describedby` and announced with `role="alert"`.
- Colour is never the only signal — every badge carries its own text.
- `prefers-reduced-motion` is honoured.
- `eslint-plugin-jsx-a11y` runs in CI with zero warnings allowed.

## Performance

- Routes are lazily loaded, so arriving at a product page does not download the
  checkout flow, the schedule builder and the whole account section.
- Images carry explicit dimensions and `loading="lazy"` below the fold, which
  is most of what Cumulative Layout Shift measures. The product hero is
  `loading="eager"` because it *is* the Largest Contentful Paint.
- Catalogue queries cache for a minute and keep the previous page on screen
  while the next loads, so paging does not flash an empty grid.

## Search discoverability

This is a single-page app, matching the repository's existing choice. Each page
sets its own `<title>` and description through `useDocumentMeta`, and account,
cart and checkout pages are `noindex`. Crawlers that execute JavaScript will
index the catalogue; those that do not, will not.

If organic search becomes a priority, `useDocumentMeta` is the seam to replace
with server rendering — every page already declares its metadata through it, so
the call sites would not change.

## Testing

56 component tests cover the behaviour that is expensive to get wrong: cart
corrections, variant selection, quantity rules, payment states, and the HTML
scrubber. They stub `fetch` at the boundary rather than mocking the API client,
so the client's own CSRF handling, error-envelope parsing and shared refresh are
exercised by every test rather than bypassed.

End-to-end scripts against the running backend live alongside them and cover
activation, cart, checkout, payment and recurring — including the ones a
component test cannot prove: that three concurrent checkouts produce one order,
that a token is single-use, and that cancelling a schedule leaves existing
orders byte-for-byte unchanged.
