# Data protection

What this software does about the GDPR, what it leaves to you, and the settings
you must decide before a European deployment goes live.

> **You are the controller, not us.** UBOSS is self-hosted: you run the
> database, you decide who is in it and why, and the supervisory authority's
> letter arrives at your address. This document describes the machinery the
> software gives you and marks every place where a decision is yours. Sections
> marked `<DECIDE>` cannot be answered by a codebase.
>
> It is written for the person accountable for compliance, not for a court. It
> is not legal advice, and no software can be "GDPR certified".

---

## 1. What the software does on its own

| Obligation | Where it lives | Status |
|---|---|---|
| Art. 15 access, Art. 20 portability | `POST /account/data-requests` → `privacy/export-bundle.service.ts` | Automatic. The customer clicks; a JSON bundle is built and emailed as an expiring link. |
| Art. 17 erasure | Same endpoint → `privacy/erasure.service.ts` | Staff decide; the software carries it out and records what survived and why. |
| Art. 16 rectification | `PATCH /account/profile` | Customer edits their own contact details. |
| Art. 12(3) one-month deadline | `data_requests.dueAt`, admin queue sorted by it | Automatic. Overdue rows are named as overdue. |
| Art. 5(1)(e) storage limitation | `RETENTION_*` env vars → `privacy/retention.service.ts` | Automatic once you set the windows. Runs on the worker's maintenance beat. |
| Art. 5(2) accountability | `audit_logs` + `data_requests` | Every request, decision and erasure is on the record, and survives the erasure itself. |
| Art. 32 security | Argon2id passwords, AES-256-GCM secrets, httpOnly cookies, double-submit CSRF, per-route permissions, rate limits and lockout | In place. Your deployment still has to add TLS, backups and access control around the host. |
| Art. 25 by default | Auth cookies only; no analytics, no tracking pixels, no marketing email | In place. See §5 before you add any. |

### What it deliberately does not do

- **Delete an invoiced order.** Art. 226 of the VAT Directive requires an
  invoice to carry the customer's name and address, and member-state tax law
  then requires that invoice be kept — six years in Germany and the
  Netherlands, ten in Italy and Portugal, `<DECIDE>` in yours. Erasure
  pseudonymises the account and leaves those orders intact under Art. 17(3)(b).
  The customer is told this, in the erasure dialog and again in the completion
  email.
- **Erase on demand while money is owed.** An unpaid order or an open return
  makes erasure "not yet" rather than "no". Staff see which, and the subject is
  told which.
- **Decide your retention periods.** The defaults below are conservative
  starting points, not advice.

---

## 2. Settings you must decide before going live in the EU

### 2.1 `FEATURE_ADMIN_LOGIN_LOCATION` — set this to `false`

**This is the single most important line in this document.**

The default is `true`, and while it is on the admin panel refuses every route
until the browser hands over the device's precise position, which is then sent
to a third-party geocoder and stored to six decimal places against the session.

That is continuous location monitoring of employees, imposed as a condition of
doing their job. In the EU:

- Consent is not a workable lawful basis for it. An employee cannot freely
  refuse something that locks them out of their work, so Art. 7(4) and the
  EDPB's guidance treat that consent as invalid.
- Legitimate interest (Art. 6(1)(f)) would have to survive a balancing test
  against precise, continuous, individually-attributed position data — a test
  this feature is unlikely to pass when a source IP address answers the same
  security question.
- In Germany it additionally engages works-council co-determination under
  § 87(1) No. 6 BetrVG; in France, prior information and consultation of the CSE.
  Switching it on without that is unlawful regardless of the GDPR analysis.

```
FEATURE_ADMIN_LOGIN_LOCATION=false
```

If a specific deployment has a genuine, documented reason to keep it: complete a
DPIA first (Art. 35 — systematic monitoring of employees is squarely in scope),
consult the works council where one exists, tell staff plainly in an employment
privacy notice, and keep `RETENTION_SESSION_LOCATION_DAYS` short.

### 2.2 Retention windows

Defaults, in days. `0` disables that sweep.

| Variable | Default | What it removes |
|---|---|---|
| `RETENTION_ABANDONED_CART_DAYS` | 90 | Baskets that were never bought. |
| `RETENTION_ASSISTANT_CONVERSATION_DAYS` | 180 | Storefront chat enquiries: a stranger's name, mobile, email and transcript. |
| `RETENTION_AUDIT_LOG_DAYS` | 730 | The audit trail. |
| `RETENTION_SESSION_LOCATION_DAYS` | 90 | Sign-in position, IP and user-agent; and failed sign-in attempts. |
| `RETENTION_SENT_NOTIFICATION_DAYS` | 365 | Delivered notifications, body and all. An order confirmation is the customer’s name and delivery address written out in prose. |
| `DATA_REQUEST_DOWNLOAD_TTL_HOURS` | 72 | How long an Art. 15 bundle stays downloadable. |

`<DECIDE>` — these must match the retention schedule you publish in your privacy
notice. If your schedule is longer, raise them; if you have no schedule yet,
these are a defensible place to start.

Order, payment and refund records are **not** swept. They fall under tax
retention and are handled by erasure instead.

### 2.3 Storage

`STORAGE_DRIVER=local` is refused in production. Report exports and personal
data bundles are written under a `private/` prefix that the static media route
is not mounted over; if you implement an S3 driver, keep that bucket prefix
private and non-listable.

### 2.4 Third-country transfers

Every one of these is optional and off unless you configure it. Each is a
processor or a recipient you must name in your privacy notice and cover with an
Art. 28 contract, plus an Art. 46 transfer mechanism where it leaves the EEA.

| Service | Configured by | Where | Turn it off with |
|---|---|---|---|
| Reverse geocoder (Nominatim by default) | `GEOCODE_REVERSE_URL` | OSMF is EU-based; a clone may not be | Empty string, or `FEATURE_ADMIN_LOGIN_LOCATION=false` |
| Exchange rates (`open.er-api.com`) | `FX_RATE_URL` | Third country | Point at an EU feed; no personal data is sent either way |
| Anthropic (chat assistant) | `ANTHROPIC_API_KEY` | United States | Leave the key unset |
| Google Gemini (chat assistant) | `GEMINI_API_KEY` | United States | Leave the key unset |
| Stripe | `STRIPE_SECRET_KEY` | EEA + US | — |
| Razorpay | `RAZORPAY_KEY_ID` | India | Not an EEA acquirer; use Stripe for EU trade |
| Your SMTP provider | `SMTP_HOST` | `<DECIDE>` | — |

The chat assistant sends the visitor's question and the catalogue to the model
provider. It does not send account or order data — see the system prompt in
`assistant.service.ts` — but the question is free text a visitor may put
anything into.

---

## 3. Records of processing (Art. 30)

A skeleton for your own register. The purposes and lawful bases below follow
from what the software actually does; the retention column follows from §2.2.

| Purpose | Categories of data | Subjects | Lawful basis | Retention |
|---|---|---|---|---|
| Operating a customer account | Name, email, phone, organisation, department, tax registration, country, language | Customers | Art. 6(1)(b) contract | Life of account, then erasure on request |
| Taking and fulfilling orders | Order lines, amounts, billing and delivery address, delivery notes | Customers | Art. 6(1)(b) contract | Tax retention, `<DECIDE>` years |
| Payment processing | Provider transaction references, amounts, status | Customers | Art. 6(1)(b) + 6(1)(c) | As above. No card data is ever stored |
| Recurring order authority | Schedule, consent timestamp and version, mandate reference | Customers | Art. 6(1)(b) + explicit consent recorded per schedule | Until cancelled, then tax retention |
| Purchasing limits and credit control | Per-currency caps, approval thresholds, internal notes | Customers | Art. 6(1)(f) legitimate interest | Life of account |
| Storefront enquiries | Name, mobile, email, organisation, transcript, IP, user-agent | Prospective customers | Art. 6(1)(f), or 6(1)(a) if you present it as consent | `RETENTION_ASSISTANT_CONVERSATION_DAYS` |
| Security and accountability logging | Actor, action, resource, before/after, IP, user-agent | Staff and customers | Art. 6(1)(c) + 6(1)(f) | `RETENTION_AUDIT_LOG_DAYS` |
| Staff account management | Email, roles, MFA state, sign-in history | Staff | Art. 6(1)(b) employment | Life of employment + `<DECIDE>` |
| Admin sign-in location | Coordinates, accuracy, place name | Staff | **See §2.1 — off by default in the EU** | `RETENTION_SESSION_LOCATION_DAYS` |

`<DECIDE>` — controller identity and contact, DPO (Art. 37: appoint one if your
core activities require regular and systematic monitoring at scale, or
large-scale special-category processing), EU representative if you are
established outside the Union (Art. 27), and your recipients and transfer
mechanisms from §2.4.

---

## 4. Handling a request

1. It arrives in the console under **Data requests**, and by email to whoever
   holds `data_request.read`.
2. The clock is one month from receipt (Art. 12(3)). The queue is sorted by
   deadline and says which rows are overdue.
3. **Identity is already proven.** The person clicked the button inside their
   own authenticated session — that is what Art. 12(6) is asking for. Do not
   demand a passport scan; collecting an identity document to answer an access
   request is itself excessive processing.
4. **Export** fulfils itself. Nothing to decide.
5. **Erasure** needs a decision:
   - The screen lists blockers. Unpaid orders and open returns mean "not yet" —
     approve once they are settled, and tell the customer that is what you are
     doing.
   - Approving is irreversible. It anonymises the account and keeps invoiced
     orders; the customer has already been shown this.
   - Refusing requires a reason, which is emailed verbatim along with the
     Art. 12(4) reminder that they may complain to a supervisory authority.
6. An extension of two further months is available under Art. 12(3) for complex
   requests, but you must tell the subject within the first month and say why.
   The software does not do this for you — `<DECIDE>` how you handle it.

---

## 5. Cookies and tracking

This software sets **only** strictly necessary cookies:

| Cookie | Purpose |
|---|---|
| `uboss_shop_at` / `uboss_admin_at` | Access token, httpOnly |
| `uboss_shop_rt` / `uboss_admin_rt` | Refresh token, httpOnly |
| `uboss_shop_csrf` / `uboss_admin_csrf` | CSRF double-submit token, readable by the page |
| `uboss.language` (localStorage) | The language the visitor picked |

Under Art. 5(3) of the ePrivacy Directive these are exempt from consent: they
are strictly necessary to provide the service the user asked for. **You do not
need a cookie banner for what ships here**, though you still need a privacy
notice describing them.

That exemption is yours to lose. Add Google Analytics, a Meta pixel, a
heatmapper or any advertising tag and you will need a consent banner that
blocks those scripts until the visitor opts in — and a banner with no "reject"
button of equal prominence is itself a finding. Adding one is a decision to take
deliberately, not a tag somebody drops into `index.html`.

---

## 6. A personal data breach

`<DECIDE>` — the timings below are the law; the names and phone numbers are
yours to fill in.

1. **Contain**, then assess. `docs/RUNBOOK.md` covers the technical side.
2. **72 hours** from becoming aware, notify your lead supervisory authority
   (Art. 33) unless the breach is unlikely to result in a risk to individuals.
   Late is still better than silent — notify with what you have and supplement
   later, which Art. 33(4) expressly permits.
3. **Without undue delay**, notify affected individuals (Art. 34) if the risk to
   them is high. Encryption of the affected data can remove this obligation.
4. **Record every breach**, including ones you decide not to report, and why.
   Art. 33(5) requires the register regardless of the outcome.

Queries that scope an incident:

```sql
-- Who could have been affected, by activity in a window.
SELECT DISTINCT actorUserId, actorEmail FROM audit_logs
WHERE createdAt BETWEEN ? AND ?;

-- Sessions live during a window, with the addresses they came from.
SELECT id, userId, ipAddress, createdAt, lastUsedAt FROM sessions
WHERE createdAt <= ? AND (revokedAt IS NULL OR revokedAt >= ?);

-- Personal-data bundles that existed in a window. Each is one full record.
SELECT id, subjectUserId, fileKey, downloadedAt FROM data_requests
WHERE type = 'EXPORT' AND fileKey IS NOT NULL;
```

---

## 7. Adding a table that holds personal data

`tests/unit/export-bundle-completeness.test.ts` fails when a model gains a
`userId`, `customerProfileId`, `actorUserId`, `subjectUserId` or
`visitorEmailNormalized` and is not accounted for in the Art. 15 bundle. That
failure is the feature. Resolve it by doing one of three things, in the test's
`DISPOSITION` map:

1. Add it to the bundle in `export-bundle.service.ts` and name the section.
2. Add it to `SECTIONS.withheld` with a reason the subject will read.
3. Mark it out of scope with the reason why.

Then ask the second question the test cannot: **does erasure need to touch it?**
`erasure.service.ts` deletes, pseudonymises or knowingly retains every table it
knows about. A new one is invisible to it until somebody says which.
