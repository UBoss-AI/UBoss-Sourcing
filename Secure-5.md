# Secure-5 — security pass log

One section per security prompt. Each records what was checked, what was
found and what was changed.

---

## Prompt 1 — Secret safety pass

**Date:** 2026-10-04
**Result:** No hardcoded secrets found. No code changes were needed.

### What was asked

1. Move every secret out of the source code and into environment variables.
2. Check Supabase, Stripe, database URLs, OAuth/JWT secrets and third-party API keys.
3. Make sure no sensitive value is exposed to the browser through a public env prefix.
4. Make sure `.env` is gitignored and a `.env.example` exists.
5. Make sure logs, error handlers and API responses never print secrets.
6. If a secret was ever hardcoded, add a "rotate it" warning to the README.

### Findings

| Check | Result | Detail |
|---|---|---|
| Secrets as string literals in tracked files | None | Searched for Stripe, AWS, Google/Gemini, SendGrid, Slack and GitHub key shapes, private keys, and connection strings with a password in them |
| Matches that turned out harmless | 3 kinds | `startsWith('sk_live_')` in `backend/src/config/env.ts`, `stripe.adapter.ts` and `provider.ts` only checks what kind of key it was given. `ci.yml` uses `ci-root-not-a-secret` for a throwaway database CI builds and deletes on each run. `.gitleaks.toml` lists fake test strings the scanner is told to ignore |
| Secret settings with a built-in default value | None | Every secret is read from `backend/.env` |
| Supabase / Next.js / MongoDB / Firebase | Not used | The stack is Fastify, Prisma, MariaDB 10.4 and Vite |
| Stripe keys | Server-side only | The Stripe secret key is in `backend/.env` only. The browser never receives it |
| OAuth / JWT signing secrets | Server-side only | Loaded and checked in `backend/src/config/env.ts`. Rotation is handled in `backend/src/infra/signing-secrets.ts` |
| Third-party keys (Gemini, DeepL, SMTP, carriers) | Env vars or database | Gemini, DeepL and SMTP settings are in `backend/.env`. Sellers enter their own carrier keys in Seller Hub, and those are stored on the server |
| Frontend exposure (`VITE_*`) | Clean | `apps/*/.env` and `.env.netlify` hold only `VITE_API_BASE_URL`, which is a localhost or relative address. No `VITE_*` setting has a key, secret, token or password in its name |
| `.env` in `.gitignore` | Yes | `backend/.env` and every `.env.*` copy are ignored. Only the example files and the frontend URL files are tracked on purpose |
| `.env.example` | Already existed | `backend/.env.example` lists all ~300 settings with placeholder values |
| Logs | Redacted | The logger in `backend/src/infra/logger.ts` replaces sensitive fields with `[REDACTED]`. No `console.log` prints a secret, token or connection string |
| Error responses | Clean | No stack traces or raw internal error messages are sent to clients |
| Git history | Clean | `scripts/secret-scan.ps1` (the gitleaks scan CI runs): 287 commits scanned, no leaks found |

### Secrets moved

None. Every secret was already in an environment variable.

### README rotation warning

Not added. The full git history scan found nothing ever committed, so there is
nothing to rotate, and a warning would tell readers something happened that
did not.

---

## Prompt 2 — Personal data flow audit

**Date:** 2026-10-04
**Result:** One fix: Gemini no longer receives the customer's account number.
Everything else already met the bar. Decisions were confirmed with the owner.

### 1. Where personal data is collected and where it goes

| Data | Collected at | Stored in | Sent outside |
|---|---|---|---|
| Email, name, phone | Sign-up, profile, email/phone change | MariaDB (users, customer profiles) | Email by SMTP, SMS gateway, Stripe/Razorpay (saved-card customer) |
| Password | Sign-up, sign-in, change, reset | Argon2id hash only (`backend/src/infra/crypto.ts`) | Nowhere |
| Addresses | Address book, checkout | MariaDB | The geocoder the operator configures (`GEOCODE_*_URL`): the address only |
| Payment card | Stripe/Razorpay's own hosted fields | Never touches this server | Stripe / Razorpay directly |
| IP address | Every request; captcha | Sessions, audit log | Captcha provider (Turnstile/hCaptcha) as `remoteip` |
| Location (couriers) | Logistics portal pings | Ping table, swept after 30 days | None |
| Chat messages | Pre-order chat, AI assistant | MariaDB | DeepL (message text only), Gemini (see section 3) |
| Usage events | Storefront | First-party `/analytics/events` | None. No third-party analytics or error-tracking SDK is installed |

### 2. Logs

- Pino redacts passwords, hashes, tokens, OTPs, MFA secrets, cookies, auth
  headers, provider signatures, AI keys, `req.body.email`, `req.body.phone`,
  addresses, coordinates and seller tax IDs (`backend/src/infra/logger.ts`).
- Card numbers that end up in free text are masked to their last four digits.
- The `log` email driver prints the recipient and body. That is for
  development only: `env.ts` refuses it in production.
- No `console.log` prints personal data. No change was needed.

### 3. Third-party services

| Service | What it gets | Change |
|---|---|---|
| Gemini (AI assistant) | Full name, organisation, department, currency, country, language, local time of day, and the chat text | **Removed the account number** (`assistant.service.ts`). The name is kept so the assistant can greet people (owner's decision) |
| Stripe / Razorpay | Email, name, phone | None. Phone helps their fraud checks (owner's decision) |
| DeepL | Message text only | None |
| SMTP / SMS | Recipient address or number, and the message | None (needed to deliver) |
| Captcha | Token and IP | None (needed) |
| Geocoder | Address only | None |

### 4. Passwords

Hashed with Argon2id and rehashed when parameters change. No MD5 or SHA used for
passwords. No route returns `passwordHash` or the MFA secret, and both are
redacted in logs.

### 5. Cookies and browser storage

- Session cookies are `httpOnly` and use `sameSite` from `COOKIE_SAME_SITE`.
  `secure` comes from `COOKIE_SECURE`, which production refuses to start without.
- Nothing personal is stored in `localStorage`: only theme, language,
  dismissed hints, the compare list and recently viewed products.
- `sessionStorage` holds the text of an AI question and chat transcript in
  progress. It is cleared when the tab closes.

### 6. API responses

Record IDs are kept, because every screen needs them (owner's decision). A spot
check found no route returning password hashes, MFA secrets or other users'
data. Not every endpoint has been reviewed field by field.

### 7. Data deletion

Already built. Customers can request a copy of their data or erasure
(`/account/data-requests`), close their account (`/account/closure`) or
deactivate it. Erasure pseudonymises the audit trail
(`backend/src/modules/privacy/erasure.service.ts`), and admins work the queue
in Privacy.

### What changed

- `backend/src/modules/assistant/assistant.service.ts`: removed the
  `account number` line from the prompt sent to Gemini. Typecheck is clean and
  the assistant unit tests pass (24/24).

## Prompt 3 — Pre-deployment hardening

**Date:** 2026-10-04
**Target:** Hostinger KVM 4 VPS, using the kit in `deploy/`
**Result:** 2 fixes, both rate limits. Every other check already passed.

| # | Check | Result | Detail |
|---|---|---|---|
| 1 | Required env vars refuse start | Pass | `backend/src/config/env.ts` validates with zod. A missing `DATABASE_URL`, or an `ACCESS_TOKEN_SECRET` under 32 characters, stops the app with a named error. Production also refuses insecure settings (for example `COOKIE_SECURE` off, `EMAIL_DRIVER=log`) |
| 2a | Debug `console.log` | Pass | Only in command-line tools (seed, OpenAPI export), where printing is their job. None in the API or the frontends |
| 2b | Security TODO/FIXME, commented-out code | Pass | None found |
| 2c | Hardcoded test credentials | Pass | Only in the dev seed, which refuses `NODE_ENV=production` |
| 2d | Test or debug endpoints | Pass | No `/test`, `/debug`, `/seed` or backdoor routes |
| 2e | Debug mode off by default | Pass | `LOG_LEVEL` defaults to `info`. There is no debug flag |
| 3 | Error responses | Pass | Unknown errors return `INTERNAL_ERROR` with a generic message and a `correlationId`, which is also sent as the `x-correlation-id` header. Stack traces and SQL details go to the server log only |
| 4 | Security headers | Pass | `@fastify/helmet`: `nosniff`, `frame-ancestors 'none'` plus X-Frame-Options, HSTS for 1 year with subdomains in production, and a strict API CSP (`default-src 'none'`). Nginx sets the frontends' headers |
| 5a | Login limit (5/min per IP) | Pass | 10 per 15 minutes per IP, which is stricter (`RATE_LIMIT_LOGIN_PER_15MIN`). Sign-up 5 per hour. Email and phone OTP limits are in place |
| 5b | Password reset (3/hour) | **Fixed** | `/password/forgot` was 5 per 15 minutes. It is now **3 per hour** |
| 5c | OTP endpoints | **Fixed** | Admin `/mfa/verify` (the 6-digit code when setting up 2-step sign-in) had no limit. It is now **10 per 15 minutes** |
| 6 | CORS | Pass | Allow-list from config only, never `*`. Credentials on |
| 7a | DB default credentials | Pass | The bootstrap creates separate `@'localhost'` users with long random passwords. There is no root app login |
| 7b | DB port exposed | Pass | MariaDB binds `127.0.0.1` (`deploy/mariadb/uboss.cnf`). The firewall (`ufw`) allows only SSH and nginx (ports 80 and 443) |
| 7c | DB TLS | Not needed on this deploy | The app and the database share the VPS, so traffic never leaves loopback. If the database ever moves to its own server, TLS must be added to the connection then |

### What changed

- `backend/src/http/routes/auth.ts`: `/password/forgot` is now 3 per hour.
  Admin `/mfa/verify` is now 10 per 15 minutes.
- `docs/API.md`: updated the rate-limit table and the endpoint row.
- Verified: lint and typecheck are clean, the auth tests pass (16/16) and
  `docs:check` passes.

## Prompt 4 — Deep audit of critical paths

**Date:** 2026-10-04
**Result:** 1 vulnerability found and fixed: the password reset link lifetime.
Everything else passed.

### Fixed: password reset link lived for 1 hour

- **What:** a reset link stayed valid for 60 minutes. The spec is 15 minutes at most.
- **Where:** `backend/src/modules/identity/token.service.ts`, `TOKEN_TTL_HOURS.PASSWORD_RESET`.
- **Exploit:** someone who reads the victim's inbox (a shared mailbox, a
  forwarding rule, a phone left unlocked) has an hour to use an unused link
  and take over the account.
- **Fix:** `PASSWORD_RESET: 0.25` (15 minutes). The admin screens that said
  "an hour" now say 15 minutes in all 8 languages, and so does
  `docs/UI-SCREENS.md`. The reset email prints the real expiry time, so it
  needed no change.
- **Verified:** the reset and token tests pass (136/136), and the admin i18n
  tests pass (13/13).

### Authentication and authorization — pass

| Check | Finding |
|---|---|
| Auth on protected routes | Every route declares its guard inline (`requireCustomer`, `requireAdmin(Permission.X)`, `requireAuthenticated`). `docs/reference/API-ENDPOINTS.md` lists each route's guard, and CI fails if it drifts |
| IDOR | Customer lookups scope by the signed-in `customerProfileId`, never by a user ID from the request (for example addresses: `where: { id, customerProfileId }`). `checkout.test.ts`, `customers.test.ts` and others test other customers' IDs. Spot-checked, not every endpoint |
| Reset token | Random (`generateToken`), stored as a SHA-256 hash, single-use (`consumedAt` set inside a transaction), tied to `userId`, older tokens voided when a new one is issued. Now 15 minutes |
| JWT | `ACCESS_TOKEN_SECRET` must be at least 32 characters or the app won't start. Access tokens last 1 hour for customers and 15 minutes for admins. Refresh tokens last 30 days |
| Logout | Every request checks the session in the database (`getSessionAuthState`), so logout, deactivation and password change take effect at once. A blacklist isn't needed |

### Payment logic — pass

| Check | Finding |
|---|---|
| Client-side prices | The checkout request (`checkoutSchema` in `cart.customer.ts`) accepts no price, total, tax or discount. It accepts only address, shipping, payment-method and quote IDs, each re-checked on the server |
| Tampering with price, quantity or discount | Totals are recomputed on the server. Scheduled orders are priced only by `quoteSchedule` |
| Stripe webhook | HMAC-SHA256 signature with a timestamp tolerance check (`stripe.adapter.ts`) |
| Razorpay webhook | HMAC-SHA256 over the raw body, compared in constant time with `timingSafeEqual` (`razorpay.adapter.ts`) |
| Paid status | An order is confirmed only by a signature-verified webhook, never by the browser redirect. Status changes only through `assertTransition` |

### Input handling — pass

| Check | Finding |
|---|---|
| SQL injection | Prisma, which parameterizes queries, everywhere. The 4 raw-SQL sites are safe: one fixed `SHOW VARIABLES`, two in the key-rotation tool where table and column names come from a fixed list and values are `?` parameters, and the ledger, where the column is a TypeScript union of three names |
| XSS | No `dangerouslySetInnerHTML` or `innerHTML` in any frontend. Product HTML is sanitised on the server (`sanitiseProductHtml`) and rendered through `SafeHtml`. Emails are plain text |
| File uploads | Type is decided by the file's magic bytes, not its name or the browser's label. Size is capped by `UPLOAD_MAX_BYTES`. Media is served with `nosniff` and a CSP that blocks scripts |

## Prompt 5 — Attacker's-eye review

**Date:** 2026-10-04
**Method:** live requests against the running API with no sign-in, forged
tokens and injection strings, plus a race test against the real database.
**Result:** 1 vulnerability found and fixed: a coupon redemption race.

### Fixed: a once-per-customer coupon could be used again by racing checkouts

- **What:** coupon limits (total uses, uses per customer) were checked when the
  cart was priced, outside the order transaction. Two checkouts sent at the
  same moment both passed the check, and both redeemed the coupon.
- **Where:** `recordRedemption` in `backend/src/modules/coupons/coupon.service.ts`.
- **Attack:** send the checkout request twice at once with different
  idempotency keys. Proven: a 50%, once-per-customer coupon was redeemed
  **2 times**.
- **Damage:** discount codes can be used beyond their limits. A "first 100
  customers" or "once per customer" promotion can be drained by anyone with
  a script. Direct revenue loss, no data exposure.
- **Fix:** inside the order transaction, the coupon row is locked
  (`SELECT … FOR UPDATE`) and both limits are counted again from
  `coupon_redemptions` before writing. A racing request waits, then gets
  `COUPON_USAGE_LIMIT_REACHED`, an error code that already existed.
- **Regression test:** `checkout.test.ts`, "a once-per-customer coupon cannot
  be redeemed twice by racing two keys". It failed before the fix and passes
  after (checkout and coupon suites 70/70).

### 1. Data access by changing IDs — pass

Customer data is looked up by the signed-in customer's `customerProfileId`,
never by an ID taken from the request alone. Spot-checked, not every endpoint
(see Prompt 4).

### 2. Login bypass — pass

| Probe | Result |
|---|---|
| All 36 admin, seller, logistics and account routes the generated docs list as "Public", called with no credentials | Every one refused (401/403). The docs show them as "Public" only because the guard sits in a shared variable |
| `account/config` | Public on purpose. It returns only whether self-registration is on |
| Driver location pings | Need the trip's device token |
| Admin chat socket | Checks the admin and the `PREORDER_CHAT_VIEW` permission |
| Garbage token, `alg: none` token | `SESSION_EXPIRED`. The verifier uses only HMAC-SHA256, with no algorithm field to trick |
| Default admin accounts | Only in the dev seed, which refuses `NODE_ENV=production` |

### 3. Privilege escalation — pass

Roles and permissions are loaded from the database on every request
(`loadAuthenticatedUser`), never read from the token, and the token type
(customer/admin/logistics) must match the route. Editing a token gains nothing.

### 4. Feature abuse — pass, apart from the coupon race above

| Area | Protection |
|---|---|
| Sign-up | 5 per hour per IP, plus captcha |
| Messaging | Rate-limited routes (`messages.ts`, `preorder-chats.ts`) |
| Uploads | Customer image search 12 per 5 minutes, size cap. Other uploads need a seller, logistics or admin sign-in |
| All API calls | Global limit, 300 per minute per IP (`RATE_LIMIT_GLOBAL_PER_MINUTE`) |
| Coupons | Total and per-customer limits, one coupon per order (unique index). Race now closed |
| Referrals | No referral system exists |

### 5. Content injection — pass

`' OR 1=1-- <script>` in the catalogue search returned a normal result. All
queries go through Prisma, which parameterizes them. Frontends never insert
raw HTML. Product HTML is sanitised on the server.

### 6. Internal exposure — pass

| Probe | Result |
|---|---|
| `/.env`, `/.git/config` | 404. Nginx serves only the built `dist` folders and `try_files … =404` |
| `/metrics` | Open on the API's localhost port, and blocked with `deny all` in `deploy/nginx/uboss.conf`. The API never listens publicly |
| OpenAPI or Swagger UI | Not served (`/docs` and `/api/v1/openapi.json` are 404) |
| Database admin panel | None in the deploy kit. phpMyAdmin is only in the local XAMPP install |
| Errors | Generic message and correlation ID only (Prompt 3) |

### 7. Business logic — pass

| Check | Result |
|---|---|
| Negative amounts | Quantities are `int().min(1)` (0 only on "set quantity", where it removes the line). No price or amount is accepted from the client |
| Stacking discounts | One coupon per order, enforced by a unique index on `coupon_redemptions.orderId` |
| Free-trial restart, self-referral | Neither feature exists |

### Also fixed: CI failure in `carrier-tracking-poll.test.ts`

- **Cause:** the test wrote a 36-character `webhookPathToken` into a
  `CHAR(32)` column. CI's MariaDB 11.4 is strict and refused it. The local
  XAMPP server is not strict, so it cut the value down silently and the test
  passed locally.
- **Fix 1:** the token is now `poll` plus the 26-character ID, 30 characters.
- **Fix 2 (so it cannot happen again):** `backend/src/infra/prisma.ts` sets
  the same strict `sql_mode` as production (`deploy/mariadb/uboss.cnf`) on
  every connection. Local runs now refuse over-long values exactly as CI and
  production do. Proven: the old test fails locally with CI's error, and the
  fixed one passes.
