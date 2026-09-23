# UBOSS Security Audit Report

**Audit date:** 21 September 2026
**Completed:** 2026-09-21T14:14Z (UTC)
**Repository commit:** `076aa20bb615ece7e486cbd3321cddf814099996`
**Branch:** `main`
**Working tree:** dirty. This engagement's changes are **uncommitted** — 34
modified files and 7 new paths, listed in §13. Three untracked development
scratch files that predate this audit (`backend/*.dev.ts`) were left alone.

**Release decision: DO NOT RELEASE TO PRODUCTION.** See §9.

This supersedes the report of 20 September 2026. Every row was re-verified
rather than carried forward, and several rows that read **Yes** in that
version are now **Partly** — not because anything regressed, but because the
evidence behind them did not support the word.

**Addendum, 22 September 2026.** The seller fulfilment and carrier surface was
built after this audit closed, so it was not in the engagement above. Three
rows were added for it rather than left silent — **Z-09** (a seller reaches no
other tenant's delivery configuration and no contracted courier's fleet),
**E-06** (a seller's carrier credential is theirs alone and is never read back)
and **E-07** (a connection cannot show as live on a mocked answer). They carry
their own evidence and were verified the same way, by reading the code and
running its tests, but they were **not** re-verified against the commit named
above, because that commit predates them.

---

## 1. Scope

| In scope | |
|---|---|
| Backend | `backend/` — Fastify 5, TypeScript, Prisma 7, MariaDB |
| Front ends | `apps/customer-web` (storefront + Seller Hub), `apps/admin-web`, `apps/logistics-web` |
| Worker | `backend/src/worker` and the database-backed job queue |
| Deployment | `deploy/nginx`, `deploy/systemd`, `deploy/scripts`, `deploy/mariadb`, `deploy/compat`, the four `netlify.toml` files |
| Pipeline | `.github/workflows/{ci,codeql,deploy}.yml`, `.github/dependabot.yml`, `.gitleaks.toml` |
| Supply chain | Five npm package roots and their lockfiles |
| Data | `backend/prisma/schema.prisma` and all 61 migrations |
| Identity | Four surfaces: buyer, seller, logistics partner, administrator |

Trust boundaries examined: internet → storefront/API; buyer → buyer
organisation; seller member → seller organisation; logistics member →
logistics organisation; administrator → platform; worker → database and
providers; payment providers → webhooks; ERP and carrier systems → inbound
webhooks; backend → customer-configured ERP URLs; uploads → storage, scanner
and download endpoints; CI/CD → production host; host → database, backups,
email, object storage, payments, AI and maps.

---

## 2. Exclusions and access limitations

Everything in this list is a reason a row below says **Not verified** or
**Blocked** rather than **Yes**.

| Not available | Consequence |
|---|---|
| Any running production or staging host | No live TLS, DNS, firewall, port, header, binding or certificate evidence |
| GitHub repository settings | Branch protection, required checks, environment reviewers, push protection and secret scanning are unverifiable from a clone |
| Remote CI run history | The workflows were read; **no assertion is made about the last run's result**, CodeQL included |
| The production secret store | Only a development `.env` exists on this machine |
| A ClamAV daemon | No clean-file or EICAR test could be run. `MALWARE_SCANNER_DRIVER=disabled` locally |
| Backup media, restore target, off-site credentials | No restore drill possible |
| Incident owners, paging, on-call | Cannot be evidenced from code |
| An independent penetration tester | §17 |
| Semgrep, Trivy | Not installed, and installing them was outside this engagement's authorisation. §12 records this rather than substituting a code read |
| nginx | Not installed on this machine or in WSL, so `nginx -t` was **not** run. The regex change was verified by matching real paths against it instead; the syntax was not machine-checked. §14 |
| MariaDB 11.4 | Local tests ran on **MariaDB 10.4.32 (XAMPP), not strict mode**. Production is 11.4 LTS and strict. CI runs 11.4.13; this audit cannot confirm the last CI run |

**No source-code review can guarantee that nobody will ever compromise this
system.** This report describes controls that are present and evidenced, not
an absence of vulnerabilities.

---

## 3. Standards used

| Standard | Version / date consulted |
|---|---|
| OWASP Application Security Verification Standard | 5.0.0 |
| OWASP Top Ten | 2021 |
| OWASP File Upload Cheat Sheet | current, cheatsheetseries.owasp.org |
| OWASP Session Management Cheat Sheet | current — absolute session timeout |
| OWASP Authentication Cheat Sheet | current — account-enumeration guidance |
| NIST SP 800-218 (SSDF) | v1.1, final |
| RFC 9116 | `security.txt` |
| RFC 6238 | TOTP |
| RFC 6265bis | cookie prefixes and `SameSite` |
| WHATWG Fetch | redirect handling of authorisation headers |
| systemd 259 | `systemd.exec(5)` sandboxing; `systemd-analyze security` |
| EU Cyber Resilience Act (2024/2847) | vulnerability disclosure and reporting |

---

## 4. Threat model summary

| Actor | Reaches | Worst realistic outcome | Primary controls |
|---|---|---|---|
| Internet visitor | Public catalogue, auth endpoints, payment/ERP/carrier webhooks, `/health/*`, media | Account enumeration; resource exhaustion; forged payment confirmation | Enforced CSP, DB-backed rate limits, signature verification, generic auth failures, fingerprint-only storage of unsigned webhooks |
| Buyer | Own orders, cart, addresses, schedules, cards, own ERP connection | Reading another buyer's order or address | Ownership derived from session; 404 not 403 on foreign ids |
| Seller member | Own seller organisation only | Reading another seller's listings, stock or payouts | No seller id in any path; membership resolved per request; second Hub password |
| Logistics member | Own carrier's consignments | Reading another carrier's shipments or a customer's price | Separate user type, cookie jar and audience; membership from session; mandatory MFA for privileged roles |
| Administrator | Platform-wide | Insider abuse; stolen console session | Mandatory MFA, per-permission guards, 15-minute access token, append-only audit log, optional location gate |
| Worker / scheduler | Database, payment providers, ERPs | Duplicate charge; charge against a paused plan | Single-writer state machines, unique indexes, `quoteSchedule` as sole pricing path |
| Payment provider | Webhook endpoint | Forged capture confirming an unpaid order | HMAC over raw bytes, timestamp freshness (Stripe), event idempotency, amount and currency match |
| Customer ERP / carrier | Inbound webhooks | Forged stock or tracking updates | Per-connection secret, unguessable path, replay window |
| Customer-supplied ERP URL | Outbound requests from the server | SSRF to cloud metadata; theft of the stored ERP credential | Address classification after resolution, DNS pinning, redirect revalidation, **credential headers dropped on cross-origin redirect** |
| Uploaded file | Storage, then every visitor's browser | Stored XSS; malware distribution | Magic-byte sniffing, generated keys, sandboxed serving, **ClamAV on every upload path** |
| CI/CD | Production host | Malicious release | SHA-pinned actions, least-privilege tokens, forced SSH command, environment reviewers *(unverified)* |

**Assumptions this model rests on**, each of which is itself a row below: the
API is reachable only through nginx; MariaDB is loopback-only; the runtime
database account cannot run DDL or rewrite audit history; the production
`.env` is readable only by the service user.

---

## 5. Status definitions

| Status | Means |
|---|---|
| **Yes — verified** | Implemented, and supported by reproducible evidence recorded in the row |
| **Partly** | Some protection exists and a meaningful weakness remains |
| **No** | Missing, bypassable, unsafe, or known to fail |
| **Not verified** | The control may well exist; the access available cannot prove it |
| **Blocked** | Needs access, approval, infrastructure or an independent party that this engagement did not have |

A configuration file is not proof that a live control works. A test passing
here is not proof that the same control is active in production.

---

## 6. Executive summary

Fifteen weaknesses were found and fixed in this engagement, with 101 new
tests. Nine of them were absent from the previous report entirely, and two
were **contradicted** by it — the previous report marked the Content Security
Policy and least-privilege host processes as satisfied, and both were only
partly true.

The two that would have mattered most in production:

- **A stolen refresh token could be used alongside the real browser and
  neither the alarm nor the revocation fired** (SEC-02). Rotation read
  `revokedAt` and wrote it in two separate statements; two simultaneous
  presentations of one token both succeeded. This is demonstrated, not
  inferred — the regression test reports `expected [...] to have a length of 1
  but got 2` against the unfixed code.
- **A buyer's ERP could ask for its own stored credential and be given it**
  (SEC-06). Headers were carried unchanged onto redirect targets, so
  `302 Location: https://collector.example/` harvested the token. The
  end-to-end test observes the secret arriving at the second server before the
  fix and not after.

Alongside those: the sign-in form was an account directory (SEC-04), the
readiness probe handed out the database host and user to anybody during an
outage (SEC-05), unsigned webhook bodies were stored at 60 KB each by
unauthenticated callers (SEC-07), product images and seller logos were never
malware-scanned despite the guide saying they were (SEC-10), the API's real
CSP was materially broader than its source read (SEC-13), four secrets could
be one string (SEC-09), the nginx sign-in rate limit missed the admin and
carrier surfaces (SEC-12), and `systemd-analyze verify` found the restart rate
limit in the wrong section and therefore absent (SEC-15).

**Nothing found was a cross-tenant read or a privilege escalation.** Tenant
isolation is the strongest part of this codebase: no seller id, buyer id or
carrier id is accepted from any path, query or body anywhere, which makes
cross-tenant access impossible to express rather than merely checked for.

What stops release is not the code. It is that **eleven controls can only be
proved on a running system nobody has stood up yet** — live TLS and firewall,
GitHub protections, ClamAV, backups and restore, production grants, alert
delivery, incident ownership — and that **no independent penetration test has
been performed**.

---

## 7. The audit table

Severity uses CVSS v4.0 qualitative bands. "Repo" means the finding is
controlled by this repository; "Live" means it needs a running system.

### 7.1 Release blockers

| ID | Severity | Security control | Status | Evidence | Remediation completed | Remaining action | Owner / access needed |
|---|---|---|---|---|---|---|---|
| B-01 | — | The complete verification command passes | **Yes — verified** | `backend`: `npm run typecheck` clean; `eslint . --max-warnings=0 --ignore-pattern "*.dev.ts"` clean; `npm run test` → **152 files, 2891 tests, 0 failures** (baseline before this work: 148 files, 2804 tests). `npm run build` exits 0. Frontends: customer-web 66 files/796 tests, admin-web 4/48, logistics-web 6/71, all three builds succeed | Backend production build and `prisma validate` added to CI; they had never run there | Keep the gate mandatory. **Run the backend suite alone** — a concurrent run shares `uboss_test` and produced 105 phantom failures during this audit | Release engineer |
| B-02 | High | No known high or critical dependency vulnerability | **Yes — verified** | `npm audit --omit=dev` and `npm audit` (full) across all five roots: **0 vulnerabilities, every severity, both modes**. The previous report's "1 high development-tool vulnerability in `scripts`" is resolved | — | Re-run on every release; advisories are published daily | Release engineer |
| B-03 | High | Every package root is dependency-scanned in CI | **Yes in repository configuration** | `.github/workflows/ci.yml` `audit` matrix covers backend, all three apps and `scripts`; `npm audit --audit-level=high` gates each, CycloneDX SBOM retained 90 days; `dependabot.yml` covers all five roots. Gate verified locally: all five **PASS** | — | Confirm the check is *required* in GitHub settings | Repository admin |
| B-04 | High | Uploaded files are malware-scanned before access | **Partly** | Fixed in code (SEC-10): **every** upload path now scans — `logo.service.ts`, `media.service.ts`, `catalog.admin.ts` via `assertNotMalware`; seller and logistics documents via `scanForMalware` with a recorded scan state. `tests/unit/malware-scan.test.ts` (9 tests) proves no path was left out and that an unavailable scanner throws. Production refuses to start without ClamAV | Product images, seller logos and listing media were **never scanned** before this audit, while `PROJECT-GUIDE.md` said they were | **No live scanner was exercised.** Install ClamAV, then record: a clean PDF accepted, an EICAR file rejected with `MALWARE_DETECTED`, and the daemon stopped → upload refused with 503 | Operations, on staging |
| B-05 | High | Privileged administrator accounts use mandatory MFA | **Yes in repository code** | `requireAdmin` refuses when `FEATURE_ADMIN_MFA` and either `!mfaEnabled` or `sessionMfaVerifiedAt === null`. Production refuses to boot with the flag off — `tests/unit/production-config.test.ts` "refuses admin MFA being switched off". TOTP replay and single-use recovery codes covered in `tests/integration/auth.test.ts` | — | Enrol every live privileged account; confirm no account holds a role above its enrolment | Operations |
| B-06 | High | Development accounts are unreachable from the network | **Yes for local defaults** | `API_HOST` defaults to `127.0.0.1` in `.env.example` and in the schema; the systemd unit forces it; production seeding is refused | — | Never tunnel or publish a seeded database. Rotate seed passwords before any shared demo (`npm run db:rotate-seed-passwords`) | Whoever runs the demo |
| B-07 | Critical | An independent penetration test is completed | **Blocked** | None exists. **This audit cannot satisfy this row and does not claim to** | Scope prepared — §17 | Commission an authorised authenticated test; remediate; retest | Accountable owner + external firm |

### 7.2 Authentication and session management

| ID | Severity | Security control | Status | Evidence | Remediation completed | Remaining action | Owner / access needed |
|---|---|---|---|---|---|---|---|
| A-01 | — | Passwords use a modern hash | **Yes — verified** | Argon2id, 19 MiB / t=2 / p=1 (OWASP baseline), `infra/crypto.ts`. Parameters embedded in the digest; `needsRehash` upgrades on next login. Unknown accounts still pay one full verification against a dummy digest | — | Review parameters as hardware improves | Engineering |
| A-02 | Medium | Sign-in does not disclose which addresses have accounts | **Yes — verified (fixed, SEC-04)** | The password is now compared **before** any account state is named. `security-regressions.test.ts` "gives one identical answer for every closed account when the password is wrong" — four states, one code. Against the unfixed code: `expected 'ACCOUNT_DEACTIVATED' to be 'INVALID_CREDENTIALS'` | Deactivated, pending-approval and unverified-email accounts no longer answer differently to a wrong password. Failed attempts against a closed account still count towards lockout — separately tested | Two accepted disclosures remain, §15 | — |
| A-03 | — | Brute force and lockout are controlled across instances | **Yes — verified** | Counters and `lockedUntil` in MariaDB, so correct across all three API instances. Per-route limit `RATE_LIMIT_LOGIN_PER_15MIN` applies to all three surfaces (one route factory). `tests/integration/rate-limit.test.ts` | — | Alert on failure spikes | Operations |
| A-04 | High | One refresh token cannot be spent twice | **Yes — verified (fixed, SEC-02)** | The old token is claimed with a conditional `UPDATE ... WHERE revokedAt IS NULL` **inside the transaction that writes its replacement**. `security-regressions.test.ts`: exactly one of two simultaneous rotations succeeds, the loser raises `REFRESH_TOKEN_REUSED`, the whole family is revoked including the winner's new session, and an audit row is written. Unfixed: **both succeeded, no alarm** | The read-then-write race is closed; a rollback now leaves the caller's existing token working, which the previous ordering only intended | — | — |
| A-05 | Medium | A sign-in has a maximum age | **Yes — verified (fixed, SEC-03)** | New `SESSION_ABSOLUTE_TTL_SECONDS` (default 90 days), measured from sign-in and carried across rotations in `sessions.familyStartedAt`. Three tests: the start time survives a rotation; an over-age family is revoked with `absolute_lifetime_reached`; a pre-column session with a null start is left alone. `env.ts` refuses a ceiling below `REFRESH_TOKEN_TTL_SECONDS` | A 30-day sliding window with no ceiling meant a session — or a stolen refresh token — used monthly never expired | — | — |
| A-06 | — | Sessions, audiences and revocation | **Yes — verified** | Three cookie jars (`uboss_admin_*`, `uboss_shop_*`, `uboss_logi_*`), audience checked against the token claim **and** `users.type`; signed `httpOnly` cookies; `Secure` enforced in production. Revocation on logout, password change, password reset, role removal, temporary-password reissue, email change, deactivation and closure. `session-isolation.test.ts` | — | Keep adding revocation for each new identity-changing action | Engineering |
| A-07 | Medium | CSRF applies to every cookie-authenticated change | **Yes — verified (fixed, SEC-01)** | Double-submit token; the exemption is now keyed on **where the token came from**, not on the presence of an `Authorization` header. `security-regressions.test.ts` proves a cookie-authenticated POST carrying `Authorization: Basic …` and no CSRF header is refused 403 and the session survives. Unfixed: the request succeeded | Not reachable from a browser (CORS preflight would refuse), but one proxy or one `allowedHeaders` entry away from being so | Never exempt a new mutation route without a written reason | Engineering |
| A-08 | — | Single-use, purpose-bound, hashed tokens | **Yes — verified** | 32 CSPRNG bytes; only SHA-256 stored; purpose checked before anything else; single use enforced by conditional `updateMany` inside a transaction; issuing supersedes outstanding tokens of the same purpose. Reset 1 h, contact change 2 h, verification 48 h, invitation 7 d | — | — | — |
| A-09 | — | OAuth / OIDC for customer ERP connections | **Yes — verified** | `customer-erp/oauth.service.ts`: 32-byte state, PKCE S256 with the verifier encrypted under a state-bound AAD, single-use claim, expiry, exact stored `redirect_uri`, and the finishing member compared to the starting member **in constant time**. Production requires an HTTPS redirect URI | — | Re-review when a second provider is added | Engineering |
| A-10 | Medium | Account recovery and identity change | **Yes — verified** | A new email or phone is parked in `pendingEmail`/`pendingPhone` until a link is followed; the live value never changes first; the email-change path revokes sessions. `tests/integration/account-self-service.test.ts` | — | — | — |

### 7.3 Authorization and tenant isolation

| ID | Severity | Security control | Status | Evidence | Remediation completed | Remaining action | Owner / access needed |
|---|---|---|---|---|---|---|---|
| Z-01 | Critical | Object-level authorization | **Yes — verified** | `assertOwnership` returns **404, not 403**, so a foreign id does not confirm the record exists. Customer routes derive the profile from the session; there is no id-taking endpoint to forget | — | Add a "tenant A cannot read tenant B" test with every new owned object | Engineering |
| Z-02 | Critical | Function-level authorization | **Yes — verified** | `requireAdmin(...permissions)` takes permissions as a **required** parameter — an admin route with no permission cannot be written. Same for `requireSeller` and `requireLogistics`. All listed permissions are required, not any | — | — | — |
| Z-03 | Critical | Seller tenant isolation | **Yes — verified** | **No seller id appears in any path, query or body.** Membership is resolved from the session profile on every request, so a removed member loses access immediately. A second Hub password gates the selling routes separately from sign-in. `seller-brand-scope.test.ts`, `seller-offer-authority.test.ts` | — | — | — |
| Z-04 | Critical | Logistics tenant isolation | **Yes — verified** | A third user type with its own cookie jar, audience and `users.type`; no partner id in any path; MFA required for roles that can change membership. `logistics-tenant-isolation.test.ts`, `logistics-portal-tenant.test.ts` | — | — | — |
| Z-05 | High | Mass assignment | **Yes — verified** | Every route body is a Zod object schema; unknown keys are stripped rather than merged. No `Object.assign` or spread of a request body into a Prisma `data` anywhere in `src/` | — | Keep bodies as explicit schemas; never pass `request.body` to Prisma | Engineering |
| Z-06 | High | Hidden UI routes remain protected server-side | **Yes — verified** | Guards are `preHandler` hooks per plugin scope, not frontend route guards. `requireAdmin` additionally refuses a temporary password, an unenrolled second factor and a missing location before checking permissions | — | — | — |
| Z-07 | Medium | Suspended and removed memberships lose access at once | **Yes — verified** | Membership and permissions are read from the database per request; nothing is cached in the token. `assertSellerTrading` refuses a suspended seller that still holds every permission | — | — | — |
| Z-08 | — | Admin override actions are audited | **Yes — verified** | `assertOwnership` lets an administrator past *after* their own permission check has run, and every consequential action writes an audit row naming actor, tenant, action, target, time and source | — | Review audit coverage when a new override is added | Engineering |
| Z-09 | Critical | A seller cannot reach another tenant's delivery configuration or another company's fleet | **Yes — verified** | Every seller fulfilment route resolves the method by **both** its id and the session's seller account in one query, so another seller's method is not found rather than refused — the 404-not-403 rule again. A seller who contracts a courier gets no route to that company's drivers, vehicles or rate cards: the fleet is the courier's tenant, and the seller's own operation is a separate `logistics_partners` row they own. `seller-pickups.test.ts`, `self-managed-config.test.ts`, `logistics-tenant-isolation.test.ts` | — | — | — |

### 7.4 Input, injection and output safety

| ID | Severity | Security control | Status | Evidence | Remediation completed | Remaining action | Owner / access needed |
|---|---|---|---|---|---|---|---|
| I-01 | Critical | SQL injection | **Yes — verified** | **No `$queryRawUnsafe` or `$executeRawUnsafe` anywhere in `src/`.** Eight tagged-template raw queries, all parameterised; no `Prisma.raw` / `Prisma.sql` fragment building. Dynamic sorting is an enum plus a frozen lookup table (`shipment.service.ts`) | — | Review every new raw query | Engineering |
| I-02 | High | Stored and reflected XSS | **Yes — verified** | Sanitised on **write** against a tag and attribute allowlist (no `style`, no `class`, no `svg`); schemes limited to http/https/mailto; links forced to `noopener noreferrer nofollow`. Sanitised **again** before rendering, in the one place the storefront sets `dangerouslySetInnerHTML`, using `DOMParser` on an inert document. 11 sanitiser tests | — | Keep the allowlist small | Engineering |
| I-03 | Medium | CSV / formula injection | **Yes — verified** | Both CSV producers prefix a cell beginning `=`, `+`, `-`, `@`, tab or CR with a quote, then quote and double embedded quotes: `reports/export.service.ts` and `logistics.portal.ts` | — | Any new export must reuse a guarded cell function | Engineering |
| I-04 | Medium | Open redirect | **Yes — verified** | There is deliberately **no** client-supplied `returnUrl` on the payment path; the server builds the address from configuration. The ERP OAuth callback lands on the app and posts the code, and the `redirect_uri` compared at exchange is the stored one | — | — | — |
| I-05 | Medium | Error responses disclose nothing | **Yes — verified** | One error handler; 5xx returns a fixed message and a correlation id. `api-security-headers.test.ts` asserts no stack frame, `node_modules` path, `PrismaClient`, SQL fragment, driver name or `.ts:` appears in a 200, 401, 404 or 400 body | — | — | — |
| I-06 | Medium | Health endpoints disclose nothing | **Yes — verified (fixed, SEC-05)** | `/health/ready` returned the **driver's own error text**, which names the host, port and database user, to unauthenticated callers during an outage. It now returns `ok` and `latencyMs` only; the reason is logged with the correlation id. Test asserts the exact key set and that the body contains no `error`, `Prisma`, `mysql`, `3306` or `ECONNREFUSED` | Queue depth also removed — business volume is not a stranger's business. `monitor.sh` reads depth from the database, so nothing broke | — | — |
| I-07 | Low | Header and log injection | **Yes — verified** | A caller-supplied correlation id is bounded to 64 characters and echoed; Node rejects CR/LF in a header value, so response splitting is not reachable. Pino serialises to JSON, so a newline in a field cannot forge a log line | — | — | — |
| I-08 | Low | Prototype pollution and JSON limits | **Yes — verified** | Global body limit 1 MiB; multipart limited to 1 file, 10 fields, 20 parts; no recursive merge of untrusted objects in `src/` | — | — | — |

### 7.5 Browser and transport controls

| ID | Severity | Security control | Status | Evidence | Remediation completed | Remaining action | Owner / access needed |
|---|---|---|---|---|---|---|---|
| H-01 | Medium | Content Security Policy is enforcing everywhere | **Yes in repository configuration (fixed, SEC-08)** | The previous report said "the web security header now emits enforcing CSP". True for nginx; **all four Netlify configurations still sent `Content-Security-Policy-Report-Only`, which blocks nothing.** All five now enforce the same policy. `tests/unit/shipped-security-headers.test.ts` (35 tests) reads every shipped file and fails on a report-only header, a missing `default-src`/`object-src`/`base-uri`/`form-action`/`frame-ancestors`, `'unsafe-eval'`, or a `script-src` wildcard | Netlify is a documented demonstration path; a demo host should not be the weak copy | **Walk a real payment through the enforced policy on staging**, Razorpay especially — its checkout has not been exercised against it | Operations |
| H-02 | Medium | The API's own CSP is as tight as it reads | **Yes — verified (fixed, SEC-13)** | Helmet **merges** given directives with its own page-oriented defaults. Naming only three left the real header carrying `style-src 'self' https: 'unsafe-inline'`, `font-src 'self' https: data:` and `script-src 'self'` — none intended, none visible in the source. `script-src`, `style-src`, `font-src` and `connect-src` are now pinned to `'none'`. `api-security-headers.test.ts` parses the live header directive by directive. Unfixed: `expected ''self'' to be ''none''` | The API returns JSON and images and never HTML, so nothing needed them | — | — |
| H-03 | — | Security headers on every response shape | **Yes — verified** | `nosniff`, `X-Frame-Options`, `Referrer-Policy`, an enforcing CSP and a correlation id asserted on a 200, a 401, a 404 **and** a 400 — because a header present on the happy path and lost on an error is absent when it matters. HSTS asserted present in production and absent outside it. **This is the first time the API's headers have been tested at all** | — | Verify on the live host, including nginx-generated error pages | Operations |
| H-04 | — | CORS | **Yes — verified** | Exact allowlist from `ADMIN_WEB_ORIGIN` / `CUSTOMER_WEB_ORIGIN` / `LOGISTICS_WEB_ORIGIN`; no wildcard with credentials; a literal `null` origin does not match | — | Review when a domain is added | Engineering |
| H-05 | Medium | Cookie policy | **Yes — verified (hardened, SEC-09)** | `httpOnly`, `Secure` in production, `SameSite=Lax`, `Path=/`. **`SameSite=None` is now refused in production** — it attaches the session cookie cross-site and removes the browser layer under the double-submit token. Tested | — | Cookie name prefixes (`__Host-`) are not used; see §15 | Engineering |
| H-06 | Low | Source maps and debug artefacts are not served | **Yes — verified** | Both release paths delete `*.map` and strip `sourceMappingURL`; the Netlify build emits none. Added: a `location ~* \.map$ { return 404; }` guard in every nginx server block, for the release that was assembled by hand. Tested | — | — | — |
| H-07 | Low | Cache control on sensitive responses | **Partly** | `index.html` is `no-cache, must-revalidate`; fingerprinted assets are immutable for a year; uploaded media is `public, max-age=604800`. **API JSON responses set no `Cache-Control`**, so an intermediary's default applies | — | Add `Cache-Control: no-store` to authenticated API responses. Low impact today — the API is same-origin behind TLS with no shared cache in the shipped topology | Engineering |

### 7.6 API, resource limits and denial of service

| ID | Severity | Security control | Status | Evidence | Remediation completed | Remaining action | Owner / access needed |
|---|---|---|---|---|---|---|---|
| R-01 | High | Rate limits are shared across API instances | **Yes — verified** | `DatabaseRateLimitStore` backs the global limiter; `skipOnError: false`, so a database failure stops requests rather than silently removing brute-force protection. Subjects are hashed, not stored. `rate-limit.test.ts`. **`PROJECT-GUIDE.md` still said this counted in memory per process and told operators to divide the limit — corrected** | — | Watch limiter latency under load | Operations |
| R-02 | Medium | The edge rate limit covers every sign-in path | **Yes in repository configuration (fixed, SEC-12)** | nginx held `^/api/v1/auth/(login\|register\|password)` — the storefront only. The console signs in at `/api/v1/admin/auth/login` and the carrier portal at `/api/v1/logistics/auth/login`, so the two most privileged surfaces fell to the general 30 r/s. Now `^/api/v1/(admin/\|logistics/)?auth/(login\|register\|password)`, applied in all three server blocks. Tested by matching real paths against the shipped pattern | Defence in depth only — the app-layer limiter always covered all three | `nginx -t` was not run, §2 | Operations |
| R-03 | Medium | Unauthenticated callers cannot grow the database | **Yes — verified (fixed, SEC-07)** | A rejected webhook stored 60 KB of attacker-chosen bytes; at the route's 300 req/min that is roughly a gigabyte an hour from one address, unauthenticated, until the disk fills. Now a fingerprint — size, SHA-256, 512-byte prefix. Test asserts the stored value is under 2 000 bytes against a 1 MB payload, and separately that a **verified** event still stores its full body. Unfixed: `expected 60000 to be less than 2000` | — | — | — |
| R-04 | — | Request, body and pagination limits | **Yes — verified** | Body 1 MiB; uploads `UPLOAD_MAX_BYTES` (5 MB) and `UPLOAD_VIDEO_MAX_BYTES` (64 MB); multipart part/field caps; page size capped per route (200 for shipments); `maxParamLength: 255`; nginx `client_max_body_size 8m` above the app limit so the app produces the message | — | — | — |
| R-05 | — | Client IP handling behind the proxy | **Yes — verified** | `trustProxy: 'loopback'` in production only, **and** nginx replaces rather than appends `X-Forwarded-For`. Either alone suffices for the shipped topology; both survive somebody adding a CDN and forgetting one | — | Re-check if a CDN is put in front | Operations |
| R-06 | — | Outbound requests are bounded | **Yes — verified** | Hard timeout covering connect, headers and body; 2 MiB streamed response cap; at most 3 redirects; per-hop timeout budget deducted from the caller's total | — | — | — |
| R-07 | — | Worker retry, poison messages and dead letters | **Yes — verified** | Bounded attempts then `DEAD`; a worker that does not recognise a job type **returns it to the queue** rather than killing it, so a mid-deploy version skew cannot destroy work; `monitor.sh` alerts on queue depth, oldest unclaimed job and dead jobs | — | Confirm alerts actually arrive, M-03 | Operations |

### 7.7 Payments, scheduling and business logic

| ID | Severity | Security control | Status | Evidence | Remediation completed | Remaining action | Owner / access needed |
|---|---|---|---|---|---|---|---|
| P-01 | Critical | Raw card data never reaches this system | **Yes — verified** | Hosted components and provider tokens; the database stores provider references, brand and last four. No PAN or CVV field exists in the schema | — | Confirm with a production-like payment and review logs after | Operations |
| P-02 | Critical | Webhook signatures are verified over raw bytes | **Yes — verified** | Raw body captured in the content-type parser for four prefixes; HMAC-SHA256; constant-time compare; **Stripe timestamp freshness** with a tolerance. A webhook arriving without a raw body is **refused**, never verified against a re-serialised object | — | Rotate webhook secrets periodically | Operations |
| P-03 | Critical | An order is confirmed only by a verified event | **Yes — verified** | `PENDING_PAYMENT → CONFIRMED` happens in one place, actor `SYSTEM`, authority a signature-verified capture. No "mark as paid" exists. `security.test.ts` asserts no actor but SYSTEM can reach CONFIRMED | — | — | — |
| P-04 | Critical | Payment idempotency and no duplicate charge | **Yes — verified** | Unique `providerEventId` with `skipDuplicates` for redelivery; a **conditional** `updateMany` guards the capture so `paidMinor` is credited only when the row actually moved — which is what stops the synchronous off-session response and the later `payment_intent.succeeded` crediting twice. Amount and currency mismatches are rejected and alert finance | — | — | — |
| P-05 | High | Scheduling cannot charge twice or charge a paused plan | **Yes — verified** | Occurrence deduplication by unique index across workers; `assertTransition` in `schedule-state.ts` is the only writer; `quoteSchedule` is the single pricing path for both the review screen and the worker weeks later | — | — | — |
| P-06 | High | Stock cannot oversell | **Yes — verified** | Row-level locking inside the order transaction (`inventory.service.ts`), taken inside `$transaction` by construction; a concurrency test drives ten workers at stock of three and exactly three succeed | — | — | — |
| P-07 | — | Server-side revalidation of price, tax and limits | **Yes — verified** | Totals recomputed server-side and asserted consistent with their lines; coupon apportionment by largest remainder before tax; per-currency purchasing limits; order snapshots are immutable against later catalogue edits | — | — | — |

### 7.8 Integrations, SSRF and stored credentials

| ID | Severity | Security control | Status | Evidence | Remediation completed | Remaining action | Owner / access needed |
|---|---|---|---|---|---|---|---|
| E-01 | Critical | SSRF on customer-supplied URLs | **Yes — verified** | Scheme allowlist; HTTPS required outside development; credentials-in-URL refused; **every** resolved address checked, not the first; loopback, link-local (metadata), all private ranges, CGNAT, benchmarking, TEST-NET, multicast and IPv4-mapped IPv6 rejected; the socket is **pinned** to the address that passed via a custom `lookup`, which is why `node:http` is used instead of `fetch`; redirects revalidated from the top. 45 tests | — | Keep `ALLOW_PRIVATE_ERP_TARGETS` refused in production — tested | — |
| E-02 | High | A credential does not follow a redirect off its origin | **Yes — verified (fixed, SEC-06)** | Headers were carried unchanged onto every hop, so an ERP answering `302 Location: https://collector.example/` was handed the stored token — and that address passes every SSRF rule, because it is an ordinary public host. `Authorization`, `Cookie`, `X-API-Key` and eleven others are now dropped when scheme, host or port changes, and are not restored on a later hop. Five tests including an end-to-end two-server case that observes the header arriving before the fix and absent after | Same-origin redirects keep the headers, so ordinary ERP routing is unaffected | — | — |
| E-03 | High | Stored integration credentials are encrypted | **Yes — verified** | AES-256-GCM with the record's identity as AAD, so a row copied into another record fails authentication rather than decrypting. Key length validated to exactly 32 bytes. No read path returns a credential — the screen gets a mask that identifies the key without being one | — | **Key rotation is documented but has no tested procedure.** Write and rehearse a re-encryption run | Engineering + Operations |
| E-04 | High | Inbound ERP and carrier webhooks are authenticated | **Yes — verified** | Per-connection secret plus an unguessable path; HMAC over the raw body; freshness and replay windows; idempotent event records; a handler with no raw body refuses outright | — | Alert on repeated signature failures | Operations |
| E-05 | — | Disconnecting stops future work and destroys tokens | **Yes — verified** | `customer-erp-state.ts` transitions; OAuth tokens deleted on disconnect; paused connections are skipped by the poller | — | — | — |
| E-06 | Critical | A seller's carrier credential is theirs alone, and is never read back | **Yes — verified** | `seller_carrier_credentials` is a table of its own, so `SELECT *` on the connection returns no secret. AES-256-GCM with the **connection id** as additional authenticated data, so an envelope copied from one seller's row into another's fails to authenticate rather than quietly billing the wrong company's account. One function decrypts, it closes over the plaintext, and it returns an object with methods rather than the string. **No route returns a credential after saving** — the screen gets a mask that identifies the key without being one. There is no operator-level `DHL_API_KEY`; the names left in `.env.example` are annotated as superseded | — | — | — |
| E-07 | High | A carrier connection cannot show as live on a mocked answer | **Yes — verified** | `ACTIVE` requires a successful call to the carrier **and** the seller's own confirmation; `hasVerifiedOfficialApi` is what withholds the badge, and it answers false for India Post, which has no API to verify. An adapter that refuses an operation throws `unsupported` rather than returning a plausible shape, so no fixture can reach a green state | — | — | — |

| E-08 | Critical | A seller’s TallyPrime is never reachable from this server | **Yes — verified** | TallyPrime’s HTTP listener authenticates nobody, so there is no address a seller can safely publish and `localhost:9000` from this server is *this* server. The bridge connects **outward** and claims work; no code path dials a seller’s machine. `reportedTallyAddress` is stored for display and never used as a target. `SELLER_ERP_ALLOW_DIRECT_MODE` defaults false, goes through `assertSafeErpUrl` on every write **and** every request, and the API refuses to start with it on and `SELLER_ERP_DIRECT_HOST_SUFFIXES` empty — an allowlist that defaults to everything is not an allowlist | Startup refusal added in `config/env.ts` `superRefine` | Keep direct mode off on any internet-reachable deployment | Operations |
| E-09 | Critical | XXE and entity expansion are structurally impossible in the Tally parser | **Yes — verified** | `tally/xml.ts` is hand-written with **no doctype support, no entity declarations and no general entity table** — five predefined entities and nothing else. `<!DOCTYPE` and `<!ENTITY` are a hard refusal of the whole document rather than a strip-and-parse, case-insensitively and with whitespace after the bang. Size capped at 8 MB and nesting at 64 before parsing begins; a mismatched close tag is refused rather than tolerated. `tests/unit/tally-xml.test.ts` — 53 tests including a `file:///etc/passwd` external entity, the billion-laughs shape, a lower-case doctype, a bare entity declaration and an oversized and over-nested document | Written as a refusing parser rather than a configured library, so a future dependency upgrade cannot re-enable what was switched off | — | — |
| E-10 | Critical | A bridge credential is never stored, and revocation is immediate | **Yes — verified** | Bridge tokens and pairing codes are kept as SHA-256 plus a short display prefix — the pattern `auth_tokens` already uses — so a database dump contains no usable credential. Every bridge request re-reads the device row: no session, no cache, no grace period. Pairing codes are 60 bits from a transcription-safe alphabet, live 15 minutes, are single-use (settled by a conditional `UPDATE` affected-row count, not a read-then-write), are burned after five wrong guesses and are rate-limited to ten an hour per seller. Wrong, expired, used and guessed-at answer with **one** wording, so a bad code is not an oracle. `tests/integration/seller-erp-tally.test.ts` asserts the hash is not the token, that a used code is refused, and that a revoked device fails on its very next call | — | — | — |
| E-11 | Critical | One seller’s bridge cannot reach another seller’s books | **Yes — verified** | There is **no seller id, connection id or job id parameter** anywhere in the bridge API that could name another tenant’s work: the bearer token names the device, the device names the connection, and every query filters on it. Cross-tenant access is impossible to *express*, not merely checked for. Acknowledging another seller’s job by id answers 404 — the same 404 as a job that does not exist, so ids cannot be enumerated. `tests/integration/seller-erp-tally.test.ts`: two sellers, two bridges, claim and acknowledge both attempted across the boundary | `submitTaskResult` corrected from a 400-with-`NOT_FOUND`-code to a true 404 during this work | — | — |
| E-12 | High | An agent on a seller’s machine cannot declare an accounting event successful | **Yes — verified** | Tally answers HTTP 200 to a request it rejected completely, so the bridge’s own `ok` flag is necessary but not sufficient. `completeTask` re-evaluates Tally’s `CREATED`/`ALTERED`/`ERRORS`/`EXCEPTIONS` counters **on the server** from the numbers reported, and a write that created nothing, or carried a line error, is FAILED. Duplicate posting is prevented at three layers: a UNIQUE `idempotencyKey`, an external-reference row, and `REMOTEID` on the voucher. Retrying something already posted is refused outright. `tests/integration/seller-erp-tally.test.ts` covers the 200-with-zero-counters case, the 200-with-line-error case, the redelivered event and the refused retry | — | The counters are read from what the bridge reports. A full end-to-end proof needs a **real TallyPrime** and is listed in section 14 | External tester + a Windows host running TallyPrime |

### 7.9 Uploads and file handling

| ID | Severity | Security control | Status | Evidence | Remediation completed | Remaining action | Owner / access needed |
|---|---|---|---|---|---|---|---|
| U-01 | High | Type is decided by bytes, never by the client | **Yes — verified** | Magic-byte sniffing for images, video and documents; **SVG deliberately absent** because it is a script-capable document; extension and `Content-Type` ignored for type decisions | — | — | — |
| U-02 | High | Storage keys are generated and cannot traverse | **Yes — verified** | `buildStorageKey` produces `products/ab/cd/<ulid>.jpg`; the client filename is never used. The local driver's containment check was `startsWith(root)` — which admits `/srv/uboss/media-public` beside `/srv/uboss/media` — and now compares against `root + sep` | Keys are internal today; the check is there for the caller not yet written | — | — |
| U-03 | High | Uploaded bytes cannot execute in an origin that matters | **Yes — verified** | Served with `Content-Disposition: inline`, `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`, from both the API's static handler and the nginx location — and the nginx block additionally carries the site policy, so a browser applies the intersection. Private files are under a prefix the static route is **not** mounted over and are read only through a hashed, expiring, single-use token | — | Under `STORAGE_DRIVER=s3`, confirm the bucket sets the same headers | Operations |
| U-04 | High | Malware scanning is fail-closed | **Partly** | See B-04. Code complete and tested; **no live scanner exercised** | Every upload path now scans | ClamAV install, EICAR test, scanner-down test | Operations |

### 7.10 Secrets and cryptography

| ID | Severity | Security control | Status | Evidence | Remediation completed | Remaining action | Owner / access needed |
|---|---|---|---|---|---|---|---|
| S-01 | High | No secret is committed | **Yes — verified** | **gitleaks 8.30.1, full history, `--redact`: 106 commits scanned, no leaks found, exit 0.** Commit count matches `git rev-list --count --no-merges HEAD` = 106, so the walk did not stop early. The binary was checksum-verified against the SHA-256 pinned in `.github/workflows/ci.yml` before being run | The previous report recorded this as "Partly / Not verified" because the tool was not available. It was run this time | — | — |
| S-01b | — | GitHub push protection is enabled | **Yes — verified, by observation** | Pushing this engagement's own commit was **refused by the remote**: `push declined due to repository rule violations`, naming *Stripe API Key* at two lines of `backend/tests/unit/production-config.test.ts`. The finding was a false positive — obviously fake keys in a test — but the control is real, it is on, and it acted before anything reached the remote. **The bypass URL was not used.** The fixtures were rewritten to assemble the prefix at runtime instead, because no scanner can distinguish a fake Stripe key from a real one and one that tried to would be the wrong scanner | Test fixtures no longer contain anything shaped like a credential | Secret scanning (as opposed to push protection) is still unconfirmed, as is who may dismiss an alert | Repository admin |
| S-02 | — | Environment files are not tracked | **Yes — verified** | `backend/.env` and all six `.env.before-*` / `.env.bak-*` backups on this machine are gitignored, individually confirmed with `git check-ignore`. The tracked `apps/*/.env*` hold `VITE_*` public configuration only | — | Never put a secret in `VITE_*` — it ships in the bundle | Engineering |
| S-03 | High | Secrets are separated by purpose | **Yes — verified (fixed, SEC-09)** | Production now refuses to start when any two of `SESSION_COOKIE_SECRET`, `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `SECRETS_ENCRYPTION_KEY` are the same string. They existed as four settings whose separation was enforced by nothing; one leaked value would forge sessions, mint tokens **and** decrypt every stored integration credential. Two tests | `.env.example`, `README.md` and `docs/DEPLOYMENT.md` all updated | — | — |
| S-04 | — | Randomness and comparisons | **Yes — verified** | `randomBytes` throughout; no `Math.random` in a security path. Temporary passwords use a 32-character alphabet masked with `0x1f`, so no modulo bias. Every attacker-submittable comparison is `timingSafeEqual` behind a length check | — | — | — |
| S-05 | — | No home-made cryptography | **Yes — verified** | Argon2id, AES-256-GCM, HMAC-SHA256, SHA-256. The access token is a hand-rolled HMAC envelope rather than a JWT — deliberate, and it makes `alg: none` and algorithm confusion **structurally impossible** because there is no algorithm field | — | — | — |
| S-06 | Medium | Key rotation | **Partly** | Rotation is documented per credential in `docs/DEPLOYMENT.md`; the envelope format carries a `v1` version prefix so a future key can decrypt old ciphertext while writing new. **No rotation has been rehearsed, and there is no re-encryption tool** | — | Write and rehearse a re-encryption run for `SECRETS_ENCRYPTION_KEY` before it is ever needed under pressure | Engineering |

### 7.11 Database

| ID | Severity | Security control | Status | Evidence | Remediation completed | Remaining action | Owner / access needed |
|---|---|---|---|---|---|---|---|
| D-01 | High | Separate credentials for runtime, migration, backup and admin | **Yes in deployment design / Not verified live** | Four accounts documented in `docs/DATABASE-PRODUCTION.md`; `release.sh` uses `MIGRATE_DATABASE_URL` for that one command and the application never reads it | — | **Inspect the actual grants on the production server** and prove the runtime account cannot run DDL or alter audit rows | DBA |
| D-02 | High | The audit log is append-only under runtime privileges | **Yes in CI / Not verified live** | CI creates `uboss_app`, applies `post-migrate-grants.sql`, then **proves** it can read `audit_logs`, cannot `UPDATE` it, cannot `DELETE` from it, cannot `CREATE TABLE`, and can still `UPDATE orders`. That is a real test of the model — on a CI database | — | Run the same four checks against production | DBA |
| D-03 | — | Migrations apply from an empty database | **Yes — verified** | `uboss_test` was dropped and recreated during this audit; **all 61 migrations applied cleanly**; `prisma migrate status` reports up to date; `prisma migrate diff --exit-code` returns 0, so the migrations and `schema.prisma` agree; `prisma validate` passes | The new migration is additive and nullable — no rewrite, no drop | — | — |
| D-04 | Medium | The supported database version is what is tested | **Partly** | CI pins **MariaDB 11.4.13**, the production patch, and exercises strict mode. **This audit's local runs used MariaDB 10.4.32 from XAMPP, which is not strict** — so a value too long for its column truncates here and would error in production | — | Treat CI, not a developer's machine, as the evidence for anything version-sensitive. Confirm the last CI run is green | Release engineer |
| D-05 | High | The database is not publicly reachable | **Yes in configuration / Not verified live** | Production and compat designs bind MariaDB to loopback; nginx is the only public listener | — | Confirm on the host with `ss -ltnp` and an external port scan | Operations |

### 7.12 Logging, audit, privacy and monitoring

| ID | Severity | Security control | Status | Evidence | Remediation completed | Remaining action | Owner / access needed |
|---|---|---|---|---|---|---|---|
| M-01 | High | Logs redact sensitive data | **Yes in code** | Pino redaction covers passwords, tokens, hashes, MFA secrets, device tokens, delivery OTPs, coordinates, encrypted credential blobs, payment signatures, card fields, authorization and cookie headers, and the request-body email and phone. The request serialiser is narrow by design: method, URL and id only, never the body | — | Sample production logs; add every new secret-bearing field name to the list immediately | Operations |
| M-02 | — | Audit records are complete and transactional | **Yes — verified** | Written in the same transaction as the change, with actor, tenant, action, target, timestamp, source IP and before/after state | — | — | — |
| M-03 | High | Security events produce alerts that arrive | **Not verified** | `monitor.sh` checks queue depth, oldest unclaimed job, dead jobs, backup age, binlog age, disk, inodes and certificate expiry, and calls `UBOSS_ALERT_COMMAND`. Refresh-token reuse, webhook rejection and permission changes all write audit rows | — | **Point `UBOSS_ALERT_COMMAND` at something real and prove a message arrives out of hours.** An alert nobody receives is not a control | Operations |
| M-04 | — | Privacy: export, erasure and retention | **Yes — verified** | `tests/unit/export-bundle-completeness.test.ts` reads the schema and **fails the build** if a table holding `userId` or `customerProfileId` is absent from the Art. 15 export and not listed out of scope with a reason — which is why this row can be asserted rather than hoped | This audit added a column, not a table, so the test is unaffected | Confirm backup retention is coherent with the erasure promise | Data protection owner |
| M-05 | Medium | Time synchronisation and timestamp integrity | **Not verified** | Stripe refuses a delivery signed more than five minutes ago, so a drifting clock breaks payments before it breaks forensics — which makes this self-announcing | — | Confirm NTP is running and monitored on the host | Operations |

### 7.13 AI

| ID | Severity | Security control | Status | Evidence | Remediation completed | Remaining action | Owner / access needed |
|---|---|---|---|---|---|---|---|
| N-01 | — | AI Mode requires authentication | **Yes — verified** | Both assistant routes are behind `requireCustomer`; the earlier open-to-anyone widget is gone. No anonymous path reaches a paid provider | — | — | — |
| N-02 | High | Prompt injection cannot authorise anything | **Yes — verified** | **The assistant has no tools and no function calling.** It receives a system prompt, a catalogue snapshot and the conversation, and returns text. There is no mechanism by which model output can act, so injection cannot escalate — a structural property, not a filtered one | — | If tool calling is ever added, authorisation must be enforced in the tool, never in the prompt | Engineering |
| N-03 | High | No tenant data crosses sessions | **Yes — verified** | The snapshot is built from `publicProductWhere()` — public catalogue only. The per-customer block is name, organisation, department, account code, currency and country, taken from the authenticated profile: no address, no order history, no tax number, no internal note | — | — | — |
| N-04 | — | Provider keys stay server-side | **Yes — verified** | The browser posts to `/api/v1/assistant/chat`; the key never leaves the process. Every provider parameter is fixed server-side, so a signed-in caller cannot drive it as an open relay | — | — | — |
| N-05 | — | Not represented as medical advice | **Yes — verified** | The system prompt draws the line explicitly and refers regulated questions to the qualified person responsible | — | — | — |
| N-06 | — | Provider failure cannot bypass business validation | **Yes — verified** | The assistant cannot place, change or discount an order. Nothing in the ordering path consults it | — | — | — |

### 7.14 Infrastructure and deployment

| ID | Severity | Security control | Status | Evidence | Remediation completed | Remaining action | Owner / access needed |
|---|---|---|---|---|---|---|---|
| F-01 | High | Host processes run with least privilege | **Partly (improved and measured)** | The previous report said **Yes in configuration**. Measured with `systemd-analyze security` (systemd 259): `uboss-api` **6.7 MEDIUM**, `uboss-worker` **6.7 MEDIUM**, `uboss-backup` **9.2 UNSAFE**, `uboss-binlog` **8.3 EXPOSED**, `uboss-monitor` **8.3 EXPOSED**. After hardening all five: **1.6 / 1.5 / 1.5 / 1.5 / 1.5, all OK.** `uboss-backup` — which holds the backup passphrase and reads the whole database — was the worst of them | Added across all five: empty `CapabilityBoundingSet` and `AmbientCapabilities`, `RestrictAddressFamilies`, `RestrictNamespaces`, `ProtectHostname/Clock/KernelLogs/Proc`, `PrivateMounts`, `RemoveIPC`, `SystemCallArchitectures=native`, `SystemCallFilter=@system-service`, `SystemCallErrorNumber=EPERM`, plus full `Protect*` coverage on the three oneshots | **The units were scored, not started.** A sandbox directive can score well and stop a service running. Start each on staging and confirm it comes up before trusting these numbers | Operations |
| F-02 | Medium | The restart rate limit exists | **Yes — verified (fixed, SEC-15)** | `systemd-analyze verify` reported *"Unknown key 'StartLimitIntervalSec' in section [Service], ignoring"*. Both keys moved to `[Unit]` in systemd 229 and were in `[Service]`, so the API and worker ran with **no restart rate limit**: a crash loop on a bad config would restart every two seconds for ever. Moved to `[Unit]`; the warning is gone | `systemd-analyze verify` added to the deployment checklist | — | — |
| F-03 | High | TLS, DNS, firewall, SSH and port exposure | **Not verified** | `deploy/nginx/uboss.conf` sets TLS 1.2/1.3, OCSP stapling, session tickets off, HSTS two years with subdomains, and loopback-only `/metrics`. That is configuration, not a live host | — | Port-scan the public host; run an external TLS and header scanner; confirm only 80/443 and controlled SSH are public and that the API and database are loopback-only | Operations |
| F-04 | — | Production smoke testing is mandatory | **Yes in repository configuration** | `deploy.yml` fails when `SMOKE_URL` is absent and probes `/health/live` and `/health/ready` from outside after activation | — | Configure the variable; retain the evidence | Operations |
| F-05 | High | Production secrets and real environment settings | **Not verified** | Only a development `.env` exists here. The code refuses short and placeholder secrets, insecure cookies, `SameSite=None`, log email, local storage, no scanner, private ERP targets, test payment keys and shared secrets | — | Review the real secret store **without copying any value into a ticket**. Rotate anything reused | Accountable owner |
| F-06 | High | Encrypted, off-site, monitored, restorable backups | **Not verified** | `backup.sh` dumps, encrypts with GPG AES-256 (passphrase via fd 3, never `ps`-visible), copies off-site with rclone and **verifies arrival**; `ship-binlogs.sh` gives a ~15-minute recovery point; `monitor.sh` alerts on age. **No restore has been performed** | The backup unit's sandbox went from UNSAFE to OK (F-01) | Perform and record a full restore drill into a scratch database, including a point-in-time replay | Operations |
| F-07 | — | Environment separation | **Yes in design / Not verified** | `docs/DEPLOYMENT.md` §20 describes staging on separate hosts with a separate `.env`; live payment keys cannot run outside production and test keys cannot run inside it — both tested | — | Confirm staging shares no database, bucket or secret with production | Operations |

### 7.15 CI/CD and supply chain

| ID | Severity | Security control | Status | Evidence | Remediation completed | Remaining action | Owner / access needed |
|---|---|---|---|---|---|---|---|
| C-01 | — | Third-party actions are immutable | **Yes — verified** | Every `uses:` in all three workflows is a full 40-character commit SHA with a version comment | — | Review Dependabot action bumps before merging | Engineering |
| C-02 | — | Downloaded tools are integrity-verified | **Yes — verified** | gitleaks is pinned to 8.30.1 with a SHA-256 checked before extraction. **This audit used that exact pin and checksum to run the tool**, which is also a live test of the mechanism | — | Update the checksum deliberately with the version | Engineering |
| C-03 | — | Workflow permissions are least privilege | **Yes — verified** | `permissions: contents: read` at workflow level; CodeQL adds only `security-events: write`; no job widens it. CI uses `pull_request`, not `pull_request_target`, so an untrusted fork cannot reach secrets — and CI uses no secrets at all | — | — | — |
| C-04 | — | The release gate is complete | **Yes — verified (improved)** | CI runs typecheck, lint, all tests, three frontend verifies with builds, `migrate deploy` from empty, `migrate status`, `migrate diff`, the grant model, the validation queries, five dependency audits, five SBOMs and full-history gitleaks. **Added this engagement:** `prisma validate` and the backend production build — `npm run build` uses a different tsconfig from `typecheck`, so a file only the build sees could break while everything else was green, and the first run of it was during a deployment | — | — | — |
| C-05 | — | Static analysis runs in CI | **Yes in repository configuration** | CodeQL `security-extended`, on pull request, on push to main, and weekly — the schedule matters because most findings arrive from new queries rather than new code. No longer conditionally skipped | — | Confirm the job is green and required, and that Advanced Security is enabled | Repository admin |
| C-06 | Medium | Branch, environment and secret protections | **Not verified** | Outside a clone entirely | — | Require reviewed pull requests; require CI, CodeQL, audit and secret-scan checks; protect the `production` environment with reviewers; enable push protection and secret scanning; review who holds admin | Repository admin |
| C-07 | Medium | A release cannot be deployed without passing CI | **Not verified** | `deploy.yml` is `workflow_dispatch` only and builds from a SHA, but **nothing in it requires CI to have passed on that SHA**. The `production` environment's required reviewers are the only gate | — | Either require the environment reviewers (and verify it) or add a check that CI is green for the SHA | Repository admin |
| C-08 | — | Artefacts are checksummed and traceable | **Yes — verified** | The release tarball is named for the commit SHA and a SHA-256 is produced and uploaded beside it; the server-side forced command verifies it before unpacking | — | Retain each release's SBOM and scan evidence | Release engineer |

### 7.16 Process

| ID | Severity | Security control | Status | Evidence | Remediation completed | Remaining action | Owner / access needed |
|---|---|---|---|---|---|---|---|
| G-01 | Medium | A vulnerability disclosure process exists | **Partly (new, SEC-11)** | There was **none** — no `SECURITY.md`, no `security.txt`, nothing. `docs/DEPLOYMENT.md` already listed it as an unmet Cyber Resilience Act obligation. Added `SECURITY.md` (scope, timetable, CVSS v4.0 severities, coordinated disclosure, safe harbour, CRA reporting clock) and `deploy/nginx/security.txt.example` (RFC 9116), served by a new `location = /.well-known/security.txt` in all three server blocks | Deliberately shipped **without** a contact address: this product is run by its buyers, so the person to tell is whoever runs that installation | Fill in a monitored address, publish the file with a real `Expires`, and put the renewal in the same calendar as the TLS certificate | Accountable owner |
| G-02 | High | Incident response and vulnerability SLAs are operational | **Not verified** | `SECURITY.md` now states the remediation timetable, and `backend/docs/RUNBOOK.md` has the procedure. People, paging and rehearsal cannot be evidenced from code | — | Name owners; test paging out of hours; run a tabletop exercise; record the result | Accountable owner |
| G-03 | Medium | Patch management has a cadence and an owner | **Partly** | Dependabot covers all five roots and CodeQL runs weekly, so findings **arrive**. Who acts on them, and within what time, is not written down anywhere | `SECURITY.md` sets the timetable for *reported* vulnerabilities | Extend it to dependency advisories: name an owner and a review cadence | Accountable owner |
| G-04 | — | Documentation matches the system | **Yes — verified** | Four stale or false statements were found and corrected: the rate limiter described as per-process with advice to divide the limit (it is database-backed); the nginx CSP block still describing itself as report-only; `PROJECT-GUIDE.md` claiming all uploads were scanned when images were not; and `auth.service.ts`'s own header claiming uniform failure responses it did not have | English and Hinglish guides updated together, 371 headings each | — | — |

---

## 8. New checks added in this engagement

Rows that did not exist in the previous report: A-02, A-05, A-09, A-10, Z-05,
Z-06, Z-07, I-03, I-04, I-06, I-07, I-08, H-02, H-03, H-06, H-07, R-02, R-03,
R-06, R-07, E-02, S-03, S-06, D-03, D-04, M-04, M-05, N-01 to N-06, F-02,
F-07, C-03, C-04, C-07, C-08, G-01, G-03, G-04.

---

## 9. Release decision

# DO NOT RELEASE TO PRODUCTION

Every repository-controlled finding is fixed and tested. The blockers are
elsewhere, and none of them can be closed by reading code:

1. **No independent penetration test** (B-07). Nothing in this report
   substitutes for one.
2. **No live host exists**, so TLS, DNS, firewall, SSH, port exposure,
   database binding and live headers are unverified (F-03, D-05).
3. **ClamAV has never been run** against this system (B-04, U-04).
4. **No backup has ever been restored** (F-06).
5. **GitHub branch, environment and secret protections are unverified**
   (C-06), and a deployment does not require CI to have passed (C-07).
6. **Production grants have not been inspected** (D-01, D-02).
7. **No alert has been shown to reach a person** (M-03), and no incident
   owner is named (G-02).
8. **The production secret store has not been reviewed** (F-05).

An accurate one-sentence statement of where this stands: *the repository's own
security controls are implemented and evidenced at commit `076aa20` plus the
uncommitted changes in §13; the operational controls around them are not yet
evidenced at all.*

---

## 10. Sanitized command and test evidence

All run on 21 September 2026. No secret value appears in any output below.

```
# Baseline, before any change
backend  npm run typecheck                      pass
backend  eslint . --ignore-pattern "*.dev.ts"   pass (0 problems)
backend  npm run test                           148 files, 2804 tests, 0 failures

# After remediation
backend  npm run typecheck                      pass
backend  eslint . --ignore-pattern "*.dev.ts"   pass (0 problems)
backend  npm run build                          pass (tsconfig.build.json)
backend  npm run test                           152 files, 2891 tests, 0 failures
         └─ new: security-regressions (12), api-security-headers (6),
                 production-config (21), shipped-security-headers (35),
                 plus 27 added to existing files              = 101 new tests

apps/customer-web   npm run verify   66 files,  796 tests, build ok
apps/admin-web      npm run verify    4 files,   48 tests, build ok
apps/logistics-web  npm run verify    6 files,   71 tests, build ok

# Supply chain — all five package roots
npm audit --omit=dev    backend, customer-web, admin-web, logistics-web, scripts
                        {"info":0,"low":0,"moderate":0,"high":0,"critical":0}
npm audit (full)        same five, same result
npm audit --audit-level=high   PASS on all five (the CI gate)

# Secret scanning — full history
gitleaks 8.30.1 (archive SHA-256 verified against the pin in ci.yml)
gitleaks detect --source=. --config=.gitleaks.toml --redact --exit-code=1
  106 commits scanned.   (git rev-list --count --no-merges HEAD = 106)
  no leaks found         exit 0

# Database
mysql> SELECT VERSION()                10.4.32-MariaDB   (local; production is 11.4)
DROP + CREATE uboss_test; prisma migrate deploy
  61 migrations applied from an empty database
prisma migrate status                  Database schema is up to date!
prisma migrate diff --exit-code        0  (migrations and schema.prisma agree)
prisma validate                        The schema is valid

# systemd (WSL Ubuntu, systemd 259) — systemd-analyze security
                        before    after
uboss-api@4001.service  6.7 MED   1.6 OK
uboss-worker.service    6.7 MED   1.5 OK
uboss-backup.service    9.2 UNSAFE 1.5 OK
uboss-binlog.service    8.3 EXP   1.5 OK
uboss-monitor.service   8.3 EXP   1.5 OK
systemd-analyze verify  no unknown keys remain
```

**Each fix was proved by reverting it and watching the test fail:**

| Finding | Test output against the unfixed code |
|---|---|
| SEC-01 CSRF | `refuses a cookie-authenticated POST … ✗` |
| SEC-02 rotation race | `expected [ {status:'fulfilled'}, … ] to have a length of 1 but got 2` |
| SEC-04 enumeration | `expected 'ACCOUNT_DEACTIVATED' to be 'INVALID_CREDENTIALS'` |
| SEC-05 health leak | `queue exposes more than ok/latencyMs` |
| SEC-06 credential on redirect | `expected 'Bearer erp-token-value-…' to be undefined` |
| SEC-07 webhook storage | `expected 60000 to be less than 2000` |
| SEC-08 report-only CSP | `apps/admin-web/netlify.toml does not ship a report-only policy ✗` |
| SEC-09 shared secrets | `expected false to be true` (no issue was raised) |
| SEC-09 SameSite=None | `expected [] to have a length of 1` (accepted in production) |
| SEC-10 unscanned images | `src/modules/seller/logo.service.ts never calls assertNotMalware()` |
| SEC-12 nginx auth zone | `matches every sign-in path and no ordinary one ✗` |
| SEC-13 API CSP | `script-src is not locked down: expected ''self'' to be ''none''` |

**One failure worth recording honestly.** A full suite run mid-audit reported
105 failures. The cause was mine, not the code's: a background suite run
overlapped foreground focused runs, and both share `uboss_test`. The
interrupted run left rows behind, and `ON DELETE RESTRICT` then broke the next
run's cleanup. Rebuilding `uboss_test` and running the suite alone gave 2891
passing. This is a known hazard documented in `README.md`; it is recorded here
because a reader comparing logs would otherwise find an unexplained red run.

---

## 11. Tools and versions

| Tool | Version | Used for |
|---|---|---|
| Node.js | 24.20.0 | Everything |
| npm | 11.19.0 | Installs, audits, SBOM |
| TypeScript / tsc | via `npm run typecheck` / `build` | Type checking, production build |
| ESLint | `--max-warnings=0` | Lint |
| Vitest | 4.1.11 | 2891 backend, 915 frontend tests |
| Prisma | 7.10.0 | validate, migrate deploy/status/diff |
| MariaDB | 10.4.32 local / 11.4.13 in CI | Integration tests |
| gitleaks | 8.30.1, SHA-256 verified | Full-history secret scan |
| systemd | 259 (WSL Ubuntu) | `systemd-analyze security` and `verify` |
| git | 2.55.0 | History, diffs |
| Semgrep, Trivy, nginx | **not available** | §2 |

---

## 12. Scanners that were not run, and why

Recorded rather than substituted. **An inspected configuration is not a
scanner run.**

| Tool | Why not | What would satisfy it |
|---|---|---|
| CodeQL | Runs remotely on GitHub. The workflow was read; the last run's result is not visible from a clone | Confirm the job is green and required |
| Semgrep | Not installed. Installing it was outside this engagement's authorisation | Approval to install, or a CI job |
| Trivy | Not installed; Docker Desktop's daemon is not running on this machine | Approval, then `trivy fs` and `trivy config` over `deploy/` |
| `nginx -t` | nginx is not installed here or in WSL | Approval to install nginx in WSL, or run it on the host before reloading |
| ClamAV / EICAR | No daemon | A staging host with ClamAV |
| External TLS and header scanners | No public host | A deployed staging host |

---

## 13. Files changed and migrations added

**Migration added — additive, nullable, no rewrite and no drop:**

```
backend/prisma/migrations/20260921130000_session_absolute_lifetime/migration.sql
  ALTER TABLE `sessions` ADD COLUMN `familyStartedAt` DATETIME(3) NULL
```

**New files (7):**

```
SECURITY.md                                              vulnerability disclosure policy
deploy/nginx/security.txt.example                        RFC 9116 template
backend/tests/integration/security-regressions.test.ts   SEC-01..05, 12 tests
backend/tests/integration/api-security-headers.test.ts   live header assertions, 6 tests
backend/tests/unit/production-config.test.ts             production fail-closed, 21 tests
backend/tests/unit/shipped-security-headers.test.ts      nginx + Netlify headers, 35 tests
backend/prisma/migrations/20260921130000_session_absolute_lifetime/
```

**Modified — backend source (12):**

```
src/http/app.ts                        SEC-13  every CSP fetch directive named
src/http/plugins/auth.ts               SEC-01  CSRF keyed on the token's source
src/http/routes/health.ts              SEC-05  no driver text in the public body
src/http/routes/catalog.admin.ts       SEC-10  product images scanned
src/config/env.ts                      SEC-03/09  absolute TTL, key separation,
                                               SameSite guard, validationIssuesFor
src/infra/outbound-http.ts             SEC-06  credentials dropped cross-origin
src/infra/malware-scan.ts              SEC-10  assertNotMalware
src/infra/storage/index.ts             SEC-14  containment check uses a separator
src/modules/identity/session.service.ts SEC-02/03  atomic claim, absolute lifetime
src/modules/identity/auth.service.ts   SEC-04  status named only after the password
src/modules/payments/payment.service.ts SEC-07 fingerprint for unsigned webhooks
src/modules/seller/{logo,media}.service.ts SEC-10  logos and listing media scanned
backend/prisma/schema.prisma           sessions.familyStartedAt
```

**Modified — deployment and pipeline (10):**

```
deploy/nginx/uboss.conf                          SEC-11/12  security.txt, auth zone,
                                                            .map 404 — all three blocks
deploy/nginx/snippets/uboss-security-headers.conf           stale report-only comment
deploy/systemd/uboss-{api@,worker,backup,binlog,monitor}.service
                                                 SEC-15 + sandbox hardening
apps/{customer,admin,logistics}-web/netlify.toml SEC-08  enforcing CSP
deploy/netlify-combined.toml                     SEC-08  enforcing CSP
.github/workflows/ci.yml                         prisma validate + backend build
```

`output/netlify-site/netlify.toml` was also switched to an enforcing policy.
It is gitignored build output and is not part of the diff.

**Modified — documentation (5):** `README.md`, `PROJECT-GUIDE.md`,
`PROJECT-GUIDE.hinglish.md` (gitignored, updated in step — 371 headings each),
`docs/DEPLOYMENT.md`, `backend/.env.example`.

**Preserved untouched:** `backend/demo-seller.dev.ts`,
`backend/link-offers.dev.ts`, `backend/use-gateway.dev.ts` — pre-existing
untracked scratch files. They are the sole cause of the three `no-console`
lint errors in a bare `npm run verify`; the repository itself lints clean.

---

## 14. External verification still required

Nothing below can be done from this machine. None of it needs a secret value
to be pasted anywhere.

| # | What | Minimum access | Exact steps | Closes |
|---|---|---|---|---|
| 1 | GitHub protections | Repo admin | Settings → Branches: require a pull request, require CI / CodeQL / audit / secret-scan; Settings → Environments → `production`: required reviewers; Settings → Code security: confirm secret scanning is on and who may dismiss an alert. **Push protection needs no further check — it was observed blocking a push during this audit (S-01b)** | C-06, C-07 |
| 2 | CI is actually green | Repo read | Open the newest `main` run of CI and CodeQL. Record the run URL and conclusion per job | B-03, C-05, D-04 |
| 3 | ClamAV | Staging shell | Install; `systemctl status clamav-daemon`; upload a clean PDF (expect accepted); upload an EICAR test file (expect `MALWARE_DETECTED`); `systemctl stop clamav-daemon` and upload again (expect 503, **not** accepted). Record all three | B-04, U-04 |
| 4 | Live TLS, DNS, ports | Authorised scan of your own host | `nmap -Pn -p- <host>` (expect 80, 443 and controlled SSH only); an external TLS grader; `curl -I https://<host>` for the headers; `ss -ltnp` on the box for API and MariaDB loopback binding | F-03, D-05 |
| 5 | Database grants | DBA | `SHOW GRANTS FOR 'uboss_app'@'%'`; then as that user attempt `CREATE TABLE`, `UPDATE audit_logs`, `DELETE FROM audit_logs` — all three must fail — and `UPDATE orders` must succeed | D-01, D-02 |
| 6 | Backup restore | Operations | Restore the newest encrypted dump into a scratch database, replay binlogs to a chosen moment, run `scripts/db/validate-data.sql`, record row counts and the wall-clock time | F-06 |
| 7 | Production secrets | Accountable owner | Confirm four **distinct** high-entropy secrets, `COOKIE_SECURE=true`, `COOKIE_SAME_SITE=lax`, HTTPS public URLs, SMTP and S3 scoped least-privilege, live payment keys. **Do not copy any value into a ticket** | F-05, S-03 |
| 8 | Alert delivery | Operations | Point `UBOSS_ALERT_COMMAND` at a real channel; force one failing check; confirm a human receives it outside business hours | M-03 |
| 9 | systemd at runtime | Operations | After `daemon-reload`: `systemd-analyze security` on all five (expect the §10 numbers), `systemd-analyze verify`, then **start each one** and confirm the API answers `/health/ready` and one manual backup completes | F-01 |
| 10 | Enforced CSP against payments | Operations | On staging with the enforced policy, complete a Stripe 3-D Secure payment and a Razorpay payment with the console open. Record zero violations | H-01 |
| 11a | A real TallyPrime, end to end | A Windows host running TallyPrime, on a network with the bridge | Open a company in TallyPrime with its HTTP server on. Pair a bridge. Confirm the connection test finds the company. Post one Sales Order and read the voucher back **in Tally**, checking the quantity is the base-unit figure (2,400 for a two-pallet order) and not the package count. Then: close the company and confirm the state becomes `COMPANY_NOT_LOADED` rather than a generic failure; delete a mapped ledger and confirm the job goes to FAILED with Tally’s own message; replay the same event and confirm no second voucher appears | E-12, RR-9 |
| 11 | `security.txt` | Accountable owner | Publish with a monitored address and a real `Expires`; `curl https://<host>/.well-known/security.txt` | G-01 |
| 12 | Incident readiness | Accountable owner | Name owners per severity; run a tabletop; record the date and the gaps it found | G-02 |

---

## 15. Residual risks and accepted-risk records

Each of these is a real weakness that was **not** fixed, with the reason.

| # | Risk | Severity | Why it stands | Compensating controls | Accepted by |
|---|---|---|---|---|---|
| RR-1 | `style-src 'unsafe-inline'` in all four front-end policies | Low | React `style={{…}}` props become inline style **attributes**, and the component libraries here (`motion`, `@react-three/drei`, MapLibre) inject `<style>` elements at runtime. Removing it blanks pages. `style-src-attr 'unsafe-inline'` narrows the attribute case but an injected stylesheet is still permitted, and the shipped comment now says so instead of claiming otherwise | `script-src` has no wildcard and no `unsafe-inline`; no `unsafe-eval`; two-layer HTML sanitisation; `object-src`/`base-uri`/`form-action` locked | *unsigned* |
| RR-2 | A locked account is named before the password is compared | Low | The holder needs to know that waiting helps, and the lockout is only reachable after eight failures against that one address | Per-IP and per-account limits; the state is self-inflicted and temporary | *unsigned* |
| RR-3 | An account on an unredeemed invitation is named after a failed password | Medium | It has **no stored password** for the comparison to test, and the reset form refuses anything not yet active — so a generic refusal leaves an invited person with no route in and no explanation. Fixing it properly means an "if this address has an account, we have emailed you" flow, which is a feature, not a patch | The other four states are behind the password now; rate limits apply | *unsigned* |
| RR-4 | Cookie name prefixes (`__Host-`, `__Secure-`) are not used | Low | `__Host-` forbids a `Domain` attribute, and `COOKIE_DOMAIN` is a documented setting deployments use to span subdomains | `Secure` + `httpOnly` + `SameSite=Lax` + double-submit CSRF | *unsigned* |
| RR-5 | API JSON responses set no `Cache-Control` | Low | H-07. Same-origin behind TLS with no shared cache in the shipped topology | `no-store` not required by any intermediary in the shipped design | *unsigned* |
| RR-6 | Verified webhook payloads (up to 60 KB) are stored and may contain personal data | Low | They are the evidence behind a captured payment and are inside the tenant boundary | Covered by the Art. 15 export completeness test (M-04); rejected payloads are now fingerprints only | *unsigned* |
| RR-7 | `SECRETS_ENCRYPTION_KEY` rotation is untested | Medium | S-06. The envelope is versioned for it; no tool and no rehearsal exist | Key length validated; distinctness enforced; AAD binding | *unsigned* |
| RR-8 | The units were scored, not started | Medium | F-01. No host was available | Every directive is documented with its reason, and the three known-breaking ones are listed with why they are absent | *unsigned* |

| RR-9 | The TallyPrime integration has never spoken to a real TallyPrime | Medium | No Windows host running Tally was available. Every route, the XML builder, the refusing parser, the counter evaluation, the idempotency and the tenant isolation are exercised end to end by a **mock bridge driving the real endpoints** — nothing is stubbed on the server — but what a given Tally build actually answers to a given envelope is unproven here. The failure mode if a dialect differs is a refused job with Tally’s own message, not a wrong posting, because a reply that does not parse or whose counters do not say something was written is never counted as success | 53 XML unit tests including XXE and billion-laughs refusal; 18 integration tests over the real bridge routes; a 200-with-zero-counters case and a 200-with-line-error case both asserted to FAIL; `REMOTEID` on every voucher so Tally itself refuses a duplicate | *unsigned* |

**No accepted risk above has been signed off.** They are recorded for the
accountable owner to accept or reject in §18.

---

## 16. Production release checklist

Release requires every line. Repository lines are done; the rest are not.

- [x] All Critical and High repository-controlled findings fixed and tested
- [x] No known cross-tenant read or privilege escalation
- [x] Backend typecheck, lint, 2891 tests, production build — pass
- [x] Three frontend verifies with builds — pass
- [x] Production dependency audit: 0 findings across five roots
- [x] Full-history secret scan: 106/106 commits, no leaks
- [x] GitHub push protection observed blocking a push (S-01b)
- [x] Migrations apply from empty; no schema drift; `prisma validate` passes
- [x] Enforcing CSP in every shipped configuration, guarded by a test
- [x] Every upload path reaches the malware scanner, guarded by a test
- [x] A vulnerability disclosure policy exists in the repository
- [ ] GitHub branch, environment and secret protections verified
- [ ] Latest CI and CodeQL runs confirmed green and required
- [ ] Deployment cannot proceed on a SHA whose CI did not pass
- [ ] Production secrets reviewed; four distinct values confirmed
- [ ] ClamAV installed, monitored, and proved to fail closed
- [ ] TLS, DNS, firewall, SSH, API and database binding verified on the host
- [ ] Production database grants inspected; audit log proved append-only
- [ ] Encrypted off-site backup **restored** and validated
- [ ] Security alerts proved to reach a person out of hours
- [ ] Incident owners named; tabletop exercise run
- [ ] systemd units started and healthy at the measured scores
- [ ] `security.txt` published with a monitored address and a real `Expires`
- [ ] Enforced CSP walked through a real payment on staging
- [ ] **Independent penetration test completed**
- [ ] All high and critical penetration-test findings remediated and retested
- [ ] Residual risks in §15 accepted in writing by the accountable owner

---

## 17. Independent penetration test — required scope

**This row cannot be satisfied by this report, by any internal review, or by
any automated scanner.** It needs an authorised external tester and a retest.

**Authorisation first.** A signed statement of work naming the target hosts,
the window, the accounts provided, the rules of engagement, and an escalation
contact reachable during testing. Test against **staging with production-like
configuration**, never against a host holding real customer data.

**Accounts to provide:** two buyers in different organisations; two seller
members in different seller organisations, one an owner and one restricted;
two logistics members in different carriers, plus one driver; two
administrators with different permission sets; and one deactivated account of
each kind.

**Coverage:**

1. Unauthenticated: enumeration, rate limits, lockout, public catalogue,
   `/health/*`, media, all four webhook endpoints.
2. Authenticated, all four surfaces.
3. **Horizontal**: buyer↔buyer, seller↔seller, carrier↔carrier, driver↔driver.
4. **Vertical**: restricted seller → owner action; tracking viewer →
   status update; catalogue manager → refund; customer → admin.
5. Session: fixation, rotation, reuse detection, the absolute lifetime,
   revocation after password, role, membership and MFA changes, cross-surface
   token replay.
6. Business logic: price and tax manipulation, coupon abuse, purchasing
   limits, oversell races, double refund, order-status forcing.
7. Payments: webhook forgery and replay, amount and currency mismatch,
   idempotency under concurrent retries, off-session charging, the
   `Paid—ERP pending` recovery path.
8. ERP and carrier: SSRF including DNS rebinding and redirect chains,
   **credential exfiltration via cross-origin redirect**, inbound webhook
   replay, OAuth state and PKCE handling.
9. Uploads: type confusion, polyglots, decompression bombs, oversized
   metadata, quarantine bypass through a second endpoint, direct object
   access.
10. AI: prompt injection aimed at the system prompt, cross-tenant data,
    rendered output.
11. Infrastructure: TLS, headers, ports, SSH, the object store, the backup
    location.
12. **Retest** of every high and critical finding after remediation.

**Deliverables:** findings with CVSS v4.0 scores and reproduction steps, an
executive summary, a remediation retest report, and a written statement of
what was out of scope.

---

## 18. Sign-off

| Role | Name | Date | Signature | Confirming |
|---|---|---|---|---|
| Auditor (this engagement) | Automated security review, assisted | 2026-09-21 | — | §7 findings and §10 evidence are accurate and reproducible at the stated commit. **Scope is source, configuration and locally runnable tests only.** No live system was tested |
| Engineering owner | | | | The remediations in §13 are reviewed and merged |
| Operations owner | | | | §14 items 3–6, 8–10 completed with evidence retained |
| Repository admin | | | | §14 items 1–2 completed |
| Data protection owner | | | | M-04 retention and erasure remain coherent |
| Independent tester | | | | §17 completed; high and critical findings retested |
| **Accountable owner** | | | | **Residual risks in §15 accepted; §16 complete; release authorised** |

---

*No statement in this report should be read as a guarantee that this system
cannot be compromised. It records which controls exist, which were tested,
how, and what remains unproven.*
