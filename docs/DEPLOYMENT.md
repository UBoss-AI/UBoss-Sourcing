# Deploying UBOSS Sourcing

Production deployment, security, compliance, scaling, migration, rollback and
operations plan for **UBOSS Sourcing** on a **Hostinger KVM 4** VPS.

`SETUP.md` covers a developer's machine. This covers everything after that.
`backend/docs/RUNBOOK.md` remains the authority on backup policy, restore
procedure and incident response; where the two touch, **the runbook wins** and
this document points at it rather than repeating it.

---

## 1. Document control

| Field | Value |
|---|---|
| **Document owner** | `<DECIDE>` — named individual accountable for this plan |
| **Application** | UBOSS Sourcing (B2B sourcing and marketplace platform) |
| **Repository** | `https://github.com/UBoss-AI/UBoss-Sourcing.git` (branch `main`) — *Verified from repository:* `git remote -v` |
| **Environment** | Production, initial single-node — Hostinger KVM 4 |
| **Version** | 2.1 |
| **Date of analysis** | 2026-09-16 |
| **Last reviewed** | 2026-09-16 |
| **Next mandatory review** | 2026-12-16, or immediately on any change to storage driver, payment provider, hosting region, or legal entity |
| **Approvers** | `<DECIDE>` Technical owner · `<DECIDE>` Business owner · `<DECIDE>` Data protection adviser · `<DECIDE>` Polish tax adviser |
| **Classification** | Internal. Contains no secrets and must never contain any. |

### Change log

| Version | Date | Author | Change |
|---|---|---|---|
| 1.0 | 2026-09-14 | Repository | First deployment guide: single-VPS shape, release and rollback procedure |
| 2.0 | 2026-09-16 | Deployment review | Full production-readiness review. Adds verified component inventory, capacity model, EU/Poland compliance matrix, CI/CD design, migration plan from XAMPP, risk register. **Records six blocking defects that prevent production boot.** |
| 2.1 | 2026-09-16 | Deployment review | **B1-B6 fixed and verified.** S3 storage driver implemented; `release.sh` copies `prisma.config.ts`, injects `VITE_API_BASE_URL` and builds the logistics portal; `carriers` vhost added; backups encrypted and copied off-site with verification; `.gitignore` covers environment files. Verdict moves from **NO-GO** to **CONDITIONAL GO**. |
| 2.2 | 2026-09-16 | Deployment review | **The remaining technical blockers are closed.** Release lock and sudoers rule; `X-Forwarded-For` no longer attacker-chosen, in nginx *and* in `trustProxy`; CSP extended so enforcing it will not blank checkout; Node pinned to 24 everywhere; automatic security updates, a fail2ban policy and journal caps in `bootstrap.sh`; binary-log shipping for a ~15-minute recovery point; on-box self-checks; CI, CodeQL and Dependabot. What is left in §26 is owner decisions, a penetration test and a load test. |

### Related documents

| For | Read |
|---|---|
| **What is actually built, capability by capability, against the product description** — and what is missing | `docs/PRODUCT-READINESS.md` |
| Backup policy, restore procedure, migrations, payment reconciliation, incident response, hardening checklist | `backend/docs/RUNBOOK.md` |
| Personal data held, retention, Art. 15 export, Art. 30 register skeleton | `backend/docs/DATA-PROTECTION.md` |
| VAT handling for European markets | `backend/docs/EU-VAT.md` |
| Product-safety and compliance fields (GPSR, CE, economic operators) | `backend/docs/PRODUCT-SAFETY.md` |
| Accessibility commitments and how they are tested | `backend/docs/ACCESSIBILITY.md` |
| What the system is and how it is built | `PROJECT-GUIDE.md` |
| Running it on a developer's machine | `SETUP.md` |
| Features, configuration, markets, payments, going live | `README.md` |
| Every deployment file, commented with why it is what it is | `deploy/` |

### How findings are classified

Every material statement in this document carries one of these labels. Nothing
is asserted without one.

| Label | Meaning |
|---|---|
| **[VR]** Verified from repository | Read in the source, or reproduced by running a command here. Command output is quoted. |
| **[VE]** Verified from an official external source | Primary source, URL and access date given in §27. |
| **[CD]** Configuration-dependent | True or false depending on a setting the operator chooses. |
| **[OD]** Owner decision required | Nobody but the business owner can answer it. |
| **[LT]** Requires load testing | A number that must be measured, not estimated. |
| **[LA]** Requires Polish/EU legal or tax advice | A qualified adviser must decide. |
| **[UB]** Unknown / blocker | Not determinable from what is available, and it blocks something. |
| **[NV]** Not externally verified | Could not be confirmed from a primary source in this session. The owner must verify it. |

---

## 2. Executive summary

### What is being deployed

A B2B sourcing and marketplace platform for medical equipment and consumables:
three browser applications, one API, one background worker, and one MariaDB
database, behind nginx on a single VPS.

### Verified technology stack

Every line below was read in the repository. The hypothesis given at the start
of this review was substantially correct, with the corrections noted.

| Layer | What is actually there | Evidence |
|---|---|---|
| Frontends | **Three** Vite 6 + React 19 + TypeScript 5.9 + Tailwind 3.4 SPAs | `apps/{customer-web,admin-web,logistics-web}/package.json` **[VR]** |
| Seller portal | **Not a fourth application.** The Seller Hub is a route tree inside `customer-web` | `apps/customer-web/src/pages/seller/` **[VR]** |
| API | Fastify 5.12 + TypeScript, ESM, Zod 4 schemas, pino 10 logging | `backend/package.json`, `backend/src/http/app.ts` **[VR]** |
| ORM | **Prisma 7.10.0 with the `@prisma/adapter-mariadb` driver adapter** — not the bundled query engine | `backend/src/infra/prisma.ts` **[VR]** |
| Database | MariaDB. Local dev **10.4.32** (XAMPP); production target **10.11.x** on Ubuntu 24.04 | `mysql.exe --version`; Launchpad `noble` source `mariadb 1:10.11.14` **[VR][VE]** |
| Worker | Separate Node process, `dist/worker/index.js`, database-backed queue with a lease | `backend/src/worker/index.js`, `backend/src/infra/queue/database-queue.ts` **[VR]** |
| Scheduler | **No separate scheduler process.** Periodic work is enqueued by the worker itself on a 60 s timer, deduplicated by a time-slot key against a `UNIQUE` index | `backend/src/worker/index.ts` `maintenance()`; `JobQueue.dedupeKey @unique` **[VR]** |
| Reverse proxy | nginx, static SPA serving + `/api/v1` proxy to three loopback API instances | `deploy/nginx/uboss.conf` **[VR]** |
| Process supervision | **systemd. There is no Dockerfile or compose file anywhere in the repository.** | `find . -iname "Dockerfile*" -o -iname "docker-compose*"` → no results **[VR]** |
| Cache / queue broker | **No Redis is needed or used.** `QUEUE_DRIVER` defaults to `database`; the `redis` branch throws "not implemented"; `CACHE_DRIVER` is read nowhere outside `env.ts` | `backend/src/infra/queue/index.ts`; grep for `CACHE_DRIVER` **[VR]** |
| Payments | Stripe **and** Razorpay, both hand-rolled over `fetch` (no vendor SDK). Cards are collected by **Stripe Elements in the browser** — card data never reaches this server | `backend/src/modules/payments/*.adapter.ts`; `apps/customer-web/src/components/CardSetupDialog.tsx` **[VR]** |
| AI | Anthropic (`@anthropic-ai/sdk`) and Google Gemini (`@google/genai`), selectable | `backend/src/modules/assistant/provider.*.ts` **[VR]** |
| CI/CD | **None exists.** No `.github/workflows`, no GitLab CI, no Jenkinsfile | `find . -maxdepth 3 -name ".github"` → no results **[VR]** |

### Initial infrastructure choice

One Hostinger KVM 4 (4 vCPU / 16 GB / 200 GB NVMe / 16 TB bandwidth / 1 Gbps),
in **Germany** or **Lithuania** — the two EU/EEA VPS locations Hostinger offers
that are nearest Poland. Hostinger does **not** offer a Polish VPS location
**[VE]**. See §4.2 and §9.

### Result: **CONDITIONAL GO**

The six blocking defects found by the first review have been fixed and verified
(see the table below), and so have the nine technical blockers that followed
them (the second table). What remains before launch is not code: it is the legal
and organisational work in §7 and §26, a penetration test, a load test and a
restore drill. **No technical defect now prevents the application from starting,
releasing, surviving the loss of the machine, or noticing that it is broken.**

The conditions, in full, are the rows in §26 marked *Blocker* — dominated by
**D1 (which legal entity sells into Poland)**, **R13 (India→EU transfer
mechanism)** and **R19 (medical-device economic-operator role)**. None of them
can be closed by writing code.

| # | Blocker | Status | Fix and evidence |
|---|---|---|---|
| **B1** | **No production storage driver existed.** `STORAGE_DRIVER=local` is refused by the production env guard; `STORAGE_DRIVER=s3` threw `'not implemented yet'` at module load, so the API could not boot under either setting. | **FIXED** | `backend/src/infra/storage/s3-storage.ts` implements `StorageDriver` over `@aws-sdk/client-s3`. 18 tests in `tests/unit/s3-storage.test.ts`; full suite **2319 passing** **[VR]** |
| **B2** | **`release.sh` did not copy `prisma.config.ts` into the release directory**, so `prisma migrate deploy` failed every release — Prisma 7 removed `url` from the schema's `datasource` block. | **FIXED** | One `cp` in the assemble step. The failure was reproduced beforehand in a simulated release layout, and the fix reproduced against it **[VR]** |
| **B3** | **The frontends baked `http://localhost:4000/api/v1` into the production bundle.** The site would load and every API call would go to the visitor's own machine. | **FIXED** | `release.sh` now exports `VITE_API_BASE_URL` per app from the public URLs in `shared/.env`, and refuses to build an app whose URL is unset. Verified against Vite's own `loadEnv` **[VR]** |
| **B4** | **Off-site backup was a commented-out line**, and the database dump was written unencrypted beside the database it protected. | **FIXED** | `backup.sh` encrypts the dump, the media archive and `.env` (AES-256, passphrase via fd 3 so it is not in `ps`), writes a SHA-256 beside each, copies off-site with `rclone` **and verifies the copy landed**. A run that cannot do this exits non-zero so the timer records a failure. Round trip tested locally **[VR]** |
| **B5** | **The logistics portal was undeployable** — never built by `release.sh`, and no nginx vhost. | **FIXED** | Built when `FEATURE_LOGISTICS_PORTAL=true`, and a `carriers.<DOMAIN>` server block added to `deploy/nginx/uboss.conf` **[VR]** |
| **B6** | **`.gitignore` had no `.env` rule.** `backend/.env` and three `.env.before-*` copies held live secrets one `git add -A` from permanent history. | **FIXED** | Ignore-by-default with named exceptions for `.env.example` and the three non-secret `apps/*/.env`. Verified with `git check-ignore`; no tracked file became ignored **[VR]** |

**One manual step remains from B6**, and it is not something this work should do
for you: `backend/.env.before-logistics`, `.env.before-map-tiles` and
`.env.before-tunnel` still exist in the working tree and still contain live
secrets. They can no longer be committed, but they should be deleted once you
have confirmed you need nothing from them.

The nine technical blockers recorded after that review are now closed too.

| # | Blocker | Status | Fix and evidence |
|---|---|---|---|
| **B4′** | **No point-in-time recovery.** Binary logging was on, but the logs never left the disk they protect against losing — so the recovery point was the nightly dump, **up to 24 hours of paid-for orders**. | **FIXED** | `deploy/scripts/ship-binlogs.sh` + `uboss-binlog.timer`: every 15 minutes it flushes the current log, fetches the completed ones **over the MySQL protocol as a replica would** — no root, no access to `/var/log/mysql` — checks each against the size the server reports, encrypts it, and copies it off-site with verification. **RPO ~15 min.** Needs `UBOSS_BINLOG_URL` |
| **B7** | **Concurrent releases, and a restart that could not work.** No deployment lock, and `release.sh` called bare `systemctl` as the `uboss` service user with no sudoers rule anywhere in `deploy/` — so a release built, migrated, moved the symlink and *then* failed, at the worst possible moment. | **FIXED** | `flock -n` on `shared/.release.lock` in both `release.sh` and `rollback.sh`; `restart_unit()` uses `sudo -n` and names the missing file when the rule is absent; `bootstrap.sh` installs `/etc/sudoers.d/uboss-release` with each unit listed explicitly — never a wildcard — and refuses to install it unless `visudo -c` parses it first |
| **B8** | **`X-Forwarded-For` spoofing (S1).** nginx appended to the client's own header and Fastify trusted the whole chain, so `request.ip` was attacker-chosen — defeating the application rate limit and the per-IP login lockout. | **FIXED** | Both halves. `proxy_set_header X-Forwarded-For $remote_addr` in `uboss-proxy.conf`, and `trustProxy: isProduction ? 'loopback' : false` in `app.ts`. Either alone closes it for the shipped topology; both together survive somebody adding a second proxy and forgetting one |
| **B9** | Frontend source maps published. | **FIXED** (was S4) | `release.sh` deletes `dist/**/*.map` and strips the trailing `sourceMappingURL` comment after every frontend build |
| **B10** | **Node unpinned** — three majors in play across the server, CI and development machines. | **FIXED** | `.nvmrc` = 24 (Active LTS **[VE]**); `engines: >=24.0.0` in all five `package.json` files; `NODE_MAJOR=24` in `bootstrap.sh`; CI reads `.nvmrc` rather than repeating the number anywhere |
| **B11** | **The CSP would blank checkout if enforced (S3)** — `script-src 'self'`, `connect-src 'self'` and no `frame-src`, against a storefront that loads Stripe.js and draws Elements in cross-origin iframes. | **EXTENDED — the swap to enforcing is a go-live step** | The shipped policy now carries Stripe's published origins (`js.stripe.com`, `*.js.stripe.com`, `hooks.stripe.com` for 3-D Secure, `api.stripe.com`, `*.stripe.com`) and Razorpay's loader, plus a `$uboss_csp_extra` hook for whichever map host this installation configures. **Still Report-Only**, deliberately — §11.4 |
| **B12** | **No automatic security updates and no fail2ban policy**, although the package was installed. | **FIXED** | `bootstrap.sh` writes `/etc/apt/apt.conf.d/51-uboss-unattended` (security origins only, and **no automatic reboot** — one box, no unscheduled outage), a `jail.local` with `sshd`, `nginx-http-auth` and `nginx-limit-req`, and journald caps at 2 G / 30 days |
| **B14** | **No CI.** Nothing at all stood between a commit and a release. | **FIXED** | `.github/workflows/ci.yml` — the backend against **MariaDB 10.11** with two databases (the suite refuses to run when `TEST_DATABASE_URL` equals `DATABASE_URL`), `migrate deploy` on both, `migrate status`, each frontend's own `verify`, `npm audit`, CycloneDX SBOMs, gitleaks over the full history, and a warning on any new migration containing `DROP`, `RENAME` or `NOT NULL`. Plus `codeql.yml` and `dependabot.yml`. `deploy.yml` exists but is **manual-only and inert** until an owner configures it |
| **B15** | **A worker failure was silent.** Nothing watched the queue, the backups, the disk or the certificates. | **PARTLY FIXED — the external half is still yours** | `deploy/scripts/monitor.sh` + `uboss-monitor.timer`, every 5 minutes: each instance's `/health/ready`, the worker unit, queue depth, **the age of the oldest due job** — the signal that catches a worker which is running and not claiming — DEAD jobs, backup age, binlog-shipping age, disk **and inodes**, certificate expiry. It exits non-zero and calls `UBOSS_ALERT_COMMAND`. **It runs on the machine it watches, so it can never report that machine being gone: an external uptime check is still required** |

**B13 — a penetration test and a load test — is not a code change and remains
open.**

### Major risks, briefly

1. **A single VPS is a single point of failure.** There is no configuration of
   one machine that removes this. §6 states the honest ceiling.
2. **Database and uploaded media share one disk** with the application and the
   backups. §17 and §24.
3. **The India-based team administering an EU-hosted system is an international
   transfer of personal data**, whatever the server's location. §7.
4. **The compliance surface is wide**: GDPR, ePrivacy, DSA, GPSR, MDR, EAA, AI
   Act, PSD2/PCI. Most of it is *organisational* work this document cannot do.
5. **Two applications on one KVM 4** (if UBOSS AMS joins it) will compete for
   the same four cores and the same 16 GB. §4.6.

### Limitations of the initial KVM 4 deployment

- No redundancy. Reboot, kernel panic, disk failure or a bad release is
  downtime.
- Realistic availability with one VPS and a person who sleeps: **~99.5 %**
  measured monthly — about 3.6 hours of downtime a month. §6.
- Capacity is unmeasured until a load test is run. §5 refuses to state a user
  number without one.

### Recommended growth path

Tune → CDN in front → move the database off the box → add API nodes → split the
worker → read replicas. §24 gives evidence-based triggers for each, none of them
a user count.

---

## 3. Verified application inventory

All rows **[VR]** unless marked. "Port" is the loopback port; nothing but nginx
binds a public port.

| Component | Repository path | Build command | Production start | Port | Exposure | Key env | Storage dependency | Background jobs | Health check | Scaling |
|---|---|---|---|---|---|---|---|---|---|---|
| **API** | `backend/` | `npm ci && npx prisma generate && npm run build` → `dist/` | `node dist/http/server.js` | 4000/4001/4002 | **Private** (`API_HOST=127.0.0.1` forced by the unit); public only via nginx `/api/v1/` | `DATABASE_URL`, `SESSION_COOKIE_SECRET`, `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `SECRETS_ENCRYPTION_KEY`, `API_PUBLIC_URL`, `*_WEB_ORIGIN`, `COOKIE_*`, `STORAGE_*`, `EMAIL_*`, payment keys | MariaDB; object storage for media | Enqueues only | `GET /health/live`, `GET /health/ready` | Horizontal. No in-process session state — sessions are cookies. **One exception:** the `@fastify/rate-limit` counter is per process (§19) |
| **Worker** | `backend/src/worker/` | same build | `node dist/worker/index.js` | none | **Private** | same file, plus `WORKER_CONCURRENCY`, `WORKER_LEASE_SECONDS`, `WORKER_POLL_INTERVAL_MS` | MariaDB; object storage (invoices, GDPR bundles) | **All of them** — notifications, scheduled orders, ERP push/poll/retry, retention sweeps, FX refresh, logistics maintenance | none of its own; `queue.health()` is surfaced through the API's `/health/ready` | Horizontal **and safe**: claiming is a conditional `UPDATE` + affected-rows check, and periodic work is deduplicated on a `UNIQUE` slot key. §16 |
| **Storefront + Seller Hub** | `apps/customer-web/` | `npm ci && npm run build` → `dist/` | static files served by nginx | — | **Public** | `VITE_API_BASE_URL` (**build-time**) | none | none | nginx `try_files` | Stateless; serve from CDN |
| **Admin console** | `apps/admin-web/` | `npm ci && npm run build` → `dist/` | static files served by nginx | — | **Public**, `X-Robots-Tag: noindex`; IP allowlist available (commented) in the vhost | `VITE_API_BASE_URL` | none | none | nginx `try_files` | Stateless |
| **Logistics portal** | `apps/logistics-web/` | `npm ci && npm run build` → `dist/` | static files served by nginx | — | **Public**, `X-Robots-Tag: noindex` | `VITE_API_BASE_URL` | none | none | nginx `try_files` | Stateless. Built and served **only when `FEATURE_LOGISTICS_PORTAL=true`** |
| **Database** | `backend/prisma/` | `prisma migrate deploy` | `mariadb.service` | 3306 | **Loopback only** (`bind-address = 127.0.0.1` in `deploy/mariadb/uboss.cnf`) | — | 200 GB NVMe | — | `SELECT 1` via `/health/ready` | Vertical first, then move off-box. §24 |
| **nginx** | `deploy/nginx/` | — | `nginx.service` | 80/443 | **Public** | — | serves `/srv/uboss/current/*` | — | `nginx -t`, `systemctl status` | Single instance on one box |
| **Backup timer** | `deploy/systemd/uboss-backup.timer` | — | `uboss-backup.service` nightly 02:30 UTC, `Persistent=true` | — | — | `UBOSS_BACKUP_PASSPHRASE` | writes `/srv/uboss/backups` | the backup itself | backup age alert (§18) | one per box |
| **Binlog timer** | `deploy/systemd/uboss-binlog.timer` | — | `uboss-binlog.service` every 15 min, `Persistent=true` | — | — | `UBOSS_BINLOG_URL`, `UBOSS_BACKUP_PASSPHRASE`, `UBOSS_OFFSITE_REMOTE` | reads the binlogs over the MySQL protocol; writes `/srv/uboss/backups/binlog` | point-in-time recovery | its own age check in `monitor.sh` | **one per box — two would fetch the same log twice** |
| **Self-check timer** | `deploy/systemd/uboss-monitor.timer` | — | `uboss-monitor.service` every 5 min | — | — | `UBOSS_ALERT_COMMAND` and the thresholds | reads `/health/ready`, `job_queue`, the backup directory, `df`, the certificates | none | it *is* the check | one per box |

### Component facts worth knowing before you plan around them

- **The API refuses to start on a bad environment file and prints every problem
  at once** (`backend/src/config/env.ts` `loadEnv()` → `process.exit(1)`). This
  is the most useful thing about deploying this application. Read the failure
  rather than working around it. **[VR]**
- **`/metrics` is an unauthenticated Prometheus endpoint** and the nginx config
  already restricts it to `127.0.0.1`. **[VR]**
- **Swagger is not served.** `@fastify/swagger` is a dependency but is only used
  by the `openapi:export` CLI; `app.ts` never registers it. No API documentation
  is exposed in production. **[VR]**
- **Graceful shutdown is real.** The API drains for up to 15 s on `SIGTERM`
  (`TimeoutStopSec=30`); the worker gets 120 s, deliberately, because the
  longest job it runs is a card charge. **[VR]**
- **Database objects are simple**, which makes the migration in §13 far less
  risky than it could have been. Measured on the local database:

  ```
  171 base tables · engine: InnoDB only · collation: utf8mb4_unicode_ci only
  0 views · 0 triggers · 0 stored routines · 0 events · 0 generated columns
  0 TIMESTAMP columns · 241 foreign keys · 216 CHECK constraints · 77.6 MB
  ```
  **[VR]** — `information_schema` queries run 2026-09-16.

---

## 4. Current and target system design

### 4.1 Current component architecture

```mermaid
graph TD
  subgraph Browsers
    C[Storefront + Seller Hub<br/>customer-web]
    A[Admin console<br/>admin-web]
    L[Logistics portal<br/>logistics-web]
  end

  C -->|"/api/v1 cookies + CSRF"| API
  A -->|"/api/v1"| API
  L -->|"/api/v1/logistics"| API

  subgraph "One Node codebase, two process kinds"
    API[Fastify API<br/>3 instances]
    W[Worker<br/>polling queue]
  end

  API --> DB[(MariaDB<br/>171 tables)]
  W --> DB
  API -. enqueue .-> DB
  DB -. claim w/ lease .-> W

  API --> OBJ[Object storage<br/>product images, invoices,<br/>GDPR bundles]
  W --> OBJ

  W --> SMTP[SMTP provider]
  API --> PSP[Stripe / Razorpay]
  PSP -->|signed webhook| API
  API --> AI[Anthropic / Gemini]
  W --> ERP[Operator ERP + buyers' own ERPs]
  API --> VIES[EC VIES VAT check]
  W --> FX[Exchange-rate feed]
```

### 4.2 Initial KVM 4 production topology

```mermaid
graph TD
  U[Visitors in Poland] -->|HTTPS 443| N

  subgraph "Hostinger KVM 4 — Germany or Lithuania"
    N[nginx<br/>TLS · gzip · edge rate limits<br/>static SPA serving]
    N --> A0[uboss-api@4000]
    N --> A1[uboss-api@4001]
    N --> A2[uboss-api@4002]
    A0 --> M[(MariaDB 10.11<br/>bind 127.0.0.1<br/>6 GB buffer pool)]
    A1 --> M
    A2 --> M
    WK[uboss-worker] --> M
    BK[uboss-backup.timer<br/>02:30 UTC] --> M
  end

  N -.-> OBJ[S3-compatible object storage<br/>OFF this box]
  BK -->|encrypted, checksummed| OFF[Off-site backup destination<br/>OFF this box]
  A0 --> PSP[Stripe / Razorpay]
  WK --> SMTP[SMTP provider]
```

**Public ports: 80 and 443 only.** 3306 and 4000–4002 are loopback. `ufw allow
OpenSSH` plus `Nginx Full` is what `bootstrap.sh` sets; §10 tightens SSH.

### 4.3 Request and data flow — a checkout

```mermaid
sequenceDiagram
  participant B as Browser
  participant N as nginx
  participant API as uboss-api
  participant DB as MariaDB
  participant S as Stripe
  participant W as uboss-worker

  B->>N: POST /api/v1/orders (cookie + x-csrf-token + Idempotency-Key)
  N->>API: proxy, X-Forwarded-Proto: https
  API->>DB: idempotency_records INSERT (scope,key) UNIQUE
  API->>DB: order row, assertTransition() only
  API->>S: create PaymentIntent
  API-->>B: client secret
  B->>S: confirm card directly (card never touches this server)
  S-->>API: POST /api/v1/payments/webhooks/stripe (signed, ≤5 min old)
  API->>API: HMAC over RAW body + timestamp freshness
  API->>DB: order → CONFIRMED (only here, never on redirect)
  API->>DB: enqueue notification + ERP push
  DB-->>W: claim with lease
  W->>DB: complete
```

### 4.4 CI/CD deployment flow (target — none exists today)

```mermaid
graph LR
  PR[Pull request] --> G{Gates}
  G --> L1[lint]
  G --> L2[typecheck]
  G --> L3[unit 44]
  G --> L4[integration 75<br/>MariaDB 10.11 service]
  G --> L5[secret scan · npm audit · SAST · SBOM]
  L1 & L2 & L3 & L4 & L5 --> M[merge to main<br/>protected]
  M --> BLD[Build artifact once<br/>API dist + 3 SPA dists<br/>VITE_API_BASE_URL injected]
  BLD --> SUM[sha256 manifest]
  SUM --> STG[Deploy to staging]
  STG --> SMK1[Staging smoke tests]
  SMK1 --> APR{Manual approval}
  APR --> PRD[Deploy to production<br/>single release lock]
  PRD --> MIG[prisma migrate deploy<br/>expand-only]
  MIG --> ROLL[Rolling API restart<br/>health-gated]
  ROLL --> SMK2[Production smoke tests]
  SMK2 -->|fail| RB[rollback.sh — code only]
```

### 4.5 Target high-availability architecture

```mermaid
graph TD
  DNS[DNS with health-checked failover] --> CDN[CDN + WAF]
  CDN --> LB[Managed load balancer]
  LB --> N1[App node 1<br/>nginx + 3 API]
  LB --> N2[App node 2<br/>nginx + 3 API]
  N1 & N2 --> DBP[(Managed MariaDB<br/>primary, automatic failover)]
  DBP --> DBR[(Read replica)]
  N1 & N2 --> OBJ[Object storage + CDN]
  WK1[Worker node 1] --> DBP
  WK2[Worker node 2] --> DBP
  N1 & N2 & WK1 & WK2 --> LOGS[Central logs + metrics + tracing]
  DBP --> BKX[Cross-region encrypted backups]
```

Note what does **not** change: the API keeps no state in the process, the queue
is in the database with a lease, and uploads go to object storage. The same
build runs on five machines with no code change. **[VR]**

### 4.6 The decisions behind the initial architecture, and why

| Decision | Choice | Why |
|---|---|---|
| **systemd or Docker Compose** | **systemd** | There is no Dockerfile in the repository and a complete, commented systemd layout already exists in `deploy/` with real hardening (`ProtectSystem=strict`, `ReadWritePaths`, `MemoryMax`, `NoNewPrivileges`). Introducing containers would mean writing and testing a second production path for no gain on one box, and would add a layer between the operator and a `journalctl`. **One approach only.** **[VR]** |
| **nginx serves the SPA builds** | Yes | Three fingerprinted static bundles. Proxying them through Node would spend event-loop turns that should be serving checkouts. |
| **`/api/v1` path or API subdomain** | **Path on each app's own host**, as shipped | Same-origin keeps session and CSRF cookies `SameSite=Lax` and keeps `connect-src 'self'` in the CSP. An API subdomain would need `SameSite=None`, a wider CSP and a CORS preflight on every write. |
| **API instances** | **3, loopback-bound** | Node is single-threaded per process; one instance uses one core regardless of load. The fourth core is for nginx, MariaDB and the worker. **[VR]** |
| **Worker instances** | **1 initially** | Not for correctness — the lease pattern makes several safe **[VR]** — but because `WORKER_CONCURRENCY` already parallelises inside one process and a second would compete for the same four cores. |
| **Scheduler** | **No separate process needed** | Periodic work is enqueued by the worker with a time-slot `dedupeKey` against a `UNIQUE` index, so N workers produce exactly one job per slot. No leader election, no distributed lock, no cron. **[VR]** |
| **MariaDB** | **Loopback only**, 6 GB buffer pool, binlog on | Already in `deploy/mariadb/uboss.cnf`. Binlog on means point-in-time recovery is possible — see §17. **[VR]** |
| **Media storage** | **Object storage, off this box.** `s3-storage.ts` implements it | A VPS disk is one disk. Product images and generated invoices are not in the database, not in git, and not recoverable from anywhere else. |
| **Redis** | **Not needed now** | Queue is database-backed and healthy at this volume; there is no cache layer in the code. Add Redis when §24's trigger fires, not before. **[VR]** |

### 4.7 If UBOSS AMS shares this VPS

**[UB] UBOSS AMS is not referenced anywhere in this repository.** A targeted
search for `UBOSS AMS`, `uboss-ams` and `UBOSS_AMS` across all Markdown, shell,
config and TypeScript files returned nothing. Whether it exists, and whether it
is to share this machine, is **[OD]** and is listed as a blocker in §26.

If the answer is yes, none of the following is optional.

| Concern | Requirement |
|---|---|
| Linux users | Separate service accounts: `uboss` and `ubossams`. Neither may read the other's `shared/.env`. `chmod 700` on both `shared/` directories. |
| Databases | Separate databases **and separate MariaDB users**. `GRANT ... ON uboss.*` only — never `ON *.*`. An AMS credential must not open a UBOSS table. |
| systemd | Separate units, separate `EnvironmentFile`, separate `ReadWritePaths`. |
| nginx | Separate `server` blocks and separate `access_log` / `error_log` paths. |
| Secrets | Separate files, separate rotation schedules, separate CI secrets. |
| Logs | Separate `SyslogIdentifier`; separate journald retention if volumes differ. |
| Backups | Separate destination prefixes and separate restore drills. A restore of one must never overwrite the other. |
| Release locks | Independent lock files (§15). A deploy of one must not block or restart the other. |
| Failure isolation | `MemoryMax` on **every** unit of both applications, and `CPUQuota` on the lower-priority one. Without `MemoryMax`, an AMS leak takes UBOSS down through the OOM killer. |
| **Capacity budget** | Do the arithmetic before you commit, not after. |

**Capacity budget on 16 GB, UBOSS alone (as `deploy/` configures it):**

| Consumer | Reserved |
|---|---|
| MariaDB buffer pool + overhead | ~7.0 GB |
| 3 × API `MemoryMax=1G` | 3.0 GB |
| Worker `MemoryMax=1500M` | 1.5 GB |
| nginx + OS + journald | ~1.0 GB |
| **Total** | **~12.5 GB of 16 GB** |
| Headroom | ~3.5 GB |

That headroom is what a `npm ci` and three Vite builds consume during a
server-side release. **There is not room for a second application without
reducing `innodb_buffer_pool_size`** — 4 GB would be the starting point, and it
must be re-tuned against the slow query log afterwards. CPU is the harder
problem: four vCPU already has no spare core. **[VR]** for the configured
values; **[LT]** for whether the result is acceptable.

---

## 5. Capacity model and scaling plan

### 5.1 No user-capacity claim is made here

The previous version of this document contained a table of requests per second
and "low thousands of concurrent shoppers". **Those numbers were not measured on
this application and are withdrawn.** A capacity claim without a load test is a
guess that people plan budgets around.

What can be said without measuring:

- **Registered users is a row count.** MariaDB does not care about millions of
  rows in `users`. This is not a capacity question.
- **Millions of registered users and millions of simultaneous users are
  different by three or four orders of magnitude.** One KVM 4 cannot serve
  millions of simultaneous users. Nothing single-node can.
- **Where it runs out first, in order** — this is worth more than a throughput
  number, because it tells you what to buy:
  1. **Database CPU.** A single MariaDB on four shared cores is the ceiling on
     writes. The buffer pool fixes reads; nothing on one box fixes write
     contention.
  2. **API cores.** Three instances is three cores. There is no fourth.
  3. **Disk**, if media is ever served from this machine.
  4. **RAM**, last, and only once the working set exceeds the buffer pool.

### 5.2 Metrics that must be distinguished

Do not let these collapse into one number in a planning conversation.

| Metric | Where it is observed | Current value |
|---|---|---|
| Registered users | `SELECT COUNT(*) FROM users` | **[OD]** target |
| Daily active users | audit log / session table | **[LT]** |
| Concurrent browser sessions | nginx active connections | **[LT]** |
| Requests per second | `/metrics` `http_requests_total` rate | **[LT]** |
| Concurrent checkouts | `/metrics` by route `/orders` | **[LT]** |
| Worker jobs per minute | `job_queue` completions | **[LT]** |
| AI requests per minute | assistant rate-limit counters | bounded by `ASSISTANT_RATE_LIMIT_PER_5MIN` (default 20/user), `ASSISTANT_GUEST_RATE_LIMIT_PER_5MIN` (default 10) **[VR]** |
| ERP sync jobs | `integration_events` | **[CD]**, off by default |
| Webhook volume | nginx log for `/payments/webhooks/` | tracks order volume |
| Media bandwidth | object-storage provider | **[LT]** |
| Database size and growth | `information_schema.TABLES` | **77.6 MB today** **[VR]** |

### 5.3 Load-test scenarios

**No load-testing tool is present in the repository** **[VR]**. Use **k6**:
it is a single static binary (no Node or Python runtime to install on a box that
has neither spare RAM nor spare cores), its scripts are JavaScript so they read
like the application, it emits p95/p99 natively, and it can run from a machine
*outside* the VPS — which is the only honest way to measure, since a generator
sharing the four cores changes what it measures.

Run every scenario **from outside the VPS, against staging**, never first
against production.

| # | Scenario | Shape | What it is really testing |
|---|---|---|---|
| 1 | Landing + catalogue browse | ramp 0→N over 2 min, hold 10 min | nginx static + cached catalogue reads |
| 2 | Search and filtering | steady, varied terms | index coverage; watch the slow query log |
| 3 | Login and profile | steady | argon2 hashing cost — **this is CPU-bound by design** |
| 4 | AI assistant | steady at the rate limit | provider latency and the `ASSISTANT_MAX_TURNS` ceiling |
| 5 | Product image search | 5 concurrent uploads | `UPLOAD_MAX_BYTES`, multipart memory, provider latency |
| 6 | Cart and checkout | ramp to target concurrent checkouts | **the one that matters** — transaction contention, pool waits |
| 7 | Scheduled order execution | seed N due occurrences, start worker | worker throughput and lease behaviour |
| 8 | Payment webhooks | burst at 5× expected peak | webhook path is deliberately **not** rate limited (§11) |
| 9 | ERP synchronisation | seed a backlog | outbound timeouts under load |
| 10 | Seller listing submit | steady | write path + admin queue growth |
| 11 | Admin approval | steady | admin read joins |
| 12 | Logistics status updates | steady pings | `logistics_location_pings` write rate and retention sweep |
| 13 | Concurrent media upload | 10 parallel | nginx `client_max_body_size`, object-storage throughput |

**Test parameters, fixed for every scenario:**

| Parameter | Value |
|---|---|
| Warm-up | 2 min ramp, **discarded from results** — the buffer pool is cold and the assistant snapshot is building |
| Steady state | ≥ 10 min. Anything shorter measures caches, not capacity |
| Data volume | Production-like: **≥ 50,000 products, ≥ 10,000 customers, ≥ 100,000 orders**. A catalogue of 200 rows fits in cache and proves nothing |
| Latency reported | p50, **p95, p99** — never the mean |
| Error-rate threshold | **< 0.1 %** for reads; **0 %** for checkout, payment webhook and order write |
| Pool saturation | `DB_POOL_SIZE` × 4 processes; alert if acquire-wait > 50 ms p95 |
| Host metrics | CPU per core, RAM, **swap in/out** (any sustained swap = stop), disk await, network |
| Queue delay | oldest `PENDING` job age; alert > 60 s |
| **Max acceptable utilisation** | CPU **< 70 %** sustained, RAM **< 80 %**, disk **< 70 %** used, swap **≈ 0** |
| **Safe operating headroom** | Plan to **50 % of measured breaking point**. The other half absorbs a traffic spike, a release and a backup running at once |
| **Stop conditions** | p99 > 5 s · error rate > 1 % · swap in/out sustained · any 5xx on a payment path · MariaDB connections > 150 of 200 |

### 5.4 Three stages

| Stage | Shape | Move here when |
|---|---|---|
| **1. Single KVM 4** | Everything above, media in object storage | Launch |
| **2. Scaled single region** | CDN in front; database on a managed instance; a second app node behind a load balancer; worker on its own node | §24 triggers |
| **3. High availability / multi-node** | §4.5 | RTO/RPO in §6 cannot be met by one box |

**When each thing moves off the original VPS:**

| Thing | Move when | Why then |
|---|---|---|
| **Media** | **Before launch** | One disk, no second copy. Driver built; the bucket is still an owner decision (D12) |
| **Database** | Database CPU > 70 % sustained, or RTO < 4 h | It is the first ceiling and the hardest to restore |
| **Sessions** | Never — they are cookies **[VR]** | Nothing to move |
| **Cache** | Only when one is introduced | There is none today |
| **Queue** | Only if job-claim contention appears in the slow query log | The database queue is correct and adequate |
| **Workers** | When they measurably compete with the API for cores | Safe to run several **[VR]** |

---

## 6. Availability, SLO, RTO and RPO

### 6.1 What one VPS can honestly do

There is no configuration of one machine that makes it highly available. Single
points of failure, every one of them unmitigated today:

| SPOF | Effect | Removed by |
|---|---|---|
| The VPS itself | Total outage | A second node + load balancer (§24) |
| Its NVMe volume | Total outage **and data loss if the off-site copy is not configured** | Off-site backups; managed database |
| MariaDB process | Total outage | Managed database with failover |
| nginx | Total outage | Load balancer in front |
| The host's network/hypervisor | Total outage | Multi-region |
| Let's Encrypt renewal failure | TLS failure, browser refuses the site | Renewal monitoring (§18) |
| DNS provider | Total outage | Second DNS provider |
| A bad migration | Outage plus possible data damage | Expand-and-contract + rehearsal (§15) |

### 6.2 Owner-selectable targets

**These are options, not commitments. `<DECIDE>` on each before go-live.**
Nothing in this repository defines a business availability target.

| Target | Option A — realistic for one VPS | Option B — needs §24 stage 2 | Option C — needs stage 3 |
|---|---|---|---|
| **Availability SLO** | 99.5 % monthly (≈ 3 h 39 m) | 99.9 % (≈ 43 m) | 99.95 % (≈ 22 m) |
| **API latency SLO** | p95 < 800 ms, p99 < 2 s on reads | p95 < 400 ms | p95 < 300 ms |
| **Error budget** | 0.5 % of requests/month | 0.1 % | 0.05 % |
| **RTO** | **4–8 h** (rebuild VPS, restore dump) | 1 h | < 15 min |
| **RPO** | **24 h with nightly dumps alone**; **< 15 min with binlog shipping** (§17) | 5 min | < 1 min |
| **Maintenance window** | Sun 02:00–04:00 Europe/Warsaw | same | none needed |

**An RPO of 24 hours on an ordering and payment system means losing a day of
orders, payments and stock movements.** If that is unacceptable — and for this
business it should be — binlog shipping in §17 is mandatory, not optional.

### 6.3 Incident severity

| Sev | Definition | Response | Notify |
|---|---|---|---|
| **S1** | Site down; checkout failing; payment webhooks rejected; suspected data breach | Immediate, 24/7 | Owner + technical owner. **A suspected breach starts the Art. 33 clock — §7** |
| **S2** | One surface down (admin, logistics); worker stopped; ERP backlog growing | 1 h, business hours | Technical owner |
| **S3** | Degraded latency; a non-critical job failing | Next business day | Ticket |
| **S4** | Cosmetic | Backlog | — |

**On-call:** **[OD]**. With a team in India (IST, UTC+5:30) and a market in
Poland (CET/CEST, UTC+1/+2), **Polish business hours are roughly 12:30–21:30
IST** — which is convenient. Polish *night* incidents fall in the Indian early
morning. Name who answers an S1 at 03:00 CET and how they are reached, or accept
that the availability target is Option A at best.

---

## 7. EU and Poland compliance applicability matrix

> **This section is a readiness assessment, not legal advice and not a
> certification.** Passing a technical checklist does not create legal
> compliance. Hosting data in Europe does not make an application GDPR
> compliant. Being B2B does not remove GDPR, DSA, accessibility, marketplace,
> tax or medical-device obligations. Every row marked **[LA]** needs a qualified
> Polish/EU adviser before go-live.

### 7.1 Master matrix

| Law / framework | Why it may apply | Applicable to | Technical controls | Organisational / legal controls | Evidence to retain | Owner | Readiness | Open questions | Adviser sign-off | Source (accessed 2026-09-16) |
|---|---|---|---|---|---|---|---|---|---|---|
| **GDPR** (EU) 2016/679 | Art. 3(2)(a): an India-established controller offering goods to data subjects in Poland/EU is in scope regardless of server location | Buyers, seller reps, staff, logistics users, drivers, prospects | Art. 15 export (`privacy/export-bundle.service.ts`), erasure (`erasure.service.ts`), retention sweeps (`retention.service.ts`), argon2 hashing, encrypted ERP credentials, audit log made append-only by DB grant, pino redaction | Art. 27 EU representative; Art. 30 ROPA; DPIA screening; DPAs with every processor; SCCs + TIA for India access; privacy notice in Polish | ROPA, DPIA, SCCs, TIA, DPAs, export/erasure request log, breach log | **[OD]** | **Strong technically.** `backend/docs/DATA-PROTECTION.md` already holds a ROPA skeleton and a rights runbook. Organisational work not started | Who is controller? Is an Art. 27 rep appointed? | **Yes [LA]** | [EUR-Lex 32016R0679](https://eur-lex.europa.eu/eli/reg/2016/679/oj) |
| **GDPR Art. 27** — EU representative | Controller not established in the Union, offering goods to EU subjects, processing not occasional | The legal entity | — | Appoint a representative established in a Member State where subjects are (Poland is the obvious choice); name them in the privacy notice | Written mandate; representative's contact published | **[OD]** | **Not started** | Does an EU entity exist (§26)? If yes, Art. 27 may not apply | **Yes [LA]** | same |
| **GDPR Art. 37** — DPO | Required if core activities need regular and systematic large-scale monitoring, or large-scale special-category processing | The legal entity | — | Assess and document the conclusion either way | The assessment itself | **[OD]** | Not assessed | Does GPS driver tracking + AI profiling amount to systematic monitoring at scale? | **Yes [LA]** | same |
| **GDPR Art. 35** — DPIA | Triggered by systematic monitoring, large-scale processing, new technologies | Logistics GPS tracking; AI assistant | `RETENTION_LOGISTICS_LOCATION_PING_DAYS`; lat/long redacted from logs **[VR]** | **A DPIA is very likely required for continuous driver location tracking.** Screen the AI assistant separately | The DPIA; consult UODO if residual high risk | **[OD]** | Not started | Is GPS tracking switched on at launch? | **Yes [LA]** | [UODO](https://uodo.gov.pl/en) |
| **GDPR Ch. V** — transfers | **The Indian team administers an EU-hosted system. Remote access to personal data from India is a transfer.** Anthropic/Google (US), Razorpay (India) | All personal data | Access restricted to named accounts; MFA; audit logging of admin actions | **SCCs (Module 2/3) + Transfer Impact Assessment for India.** India has no EU adequacy decision. Supplementary measures assessed and documented | Signed SCCs; TIA; access list reviewed quarterly | **[OD]** | **Not started — highest-priority legal gap** | Can EU-resident staff be the only ones with production data access? | **Yes [LA]** | [EDPB](https://www.edpb.europa.eu/) |
| **GDPR Art. 33/34** — breach | Any personal-data breach | — | Structured logs + correlation IDs; audit trail | **Notify UODO within 72 h of becoming aware** where risk to rights and freedoms; notify subjects where high risk | Breach register (required even when not notified) | **[OD]** | Runbook §8 has the technical half; `DATA-PROTECTION.md` §6 has the legal half. **Hostinger's DPA commits only to "without undue delay" with no fixed time — your 72 h clock may start after theirs** | Who decides notification, at what hour? | **Yes [LA]** | [Hostinger DPA](https://www.hostinger.com/legal/dpa) |
| **GDPR Art. 28** — processors | Hostinger, SMTP, object storage, AI, payments, maps, monitoring | — | — | A signed DPA with each; subprocessor list reviewed | DPAs; subprocessor register | **[OD]** | Hostinger's DPA exists and names subprocessors in Appendix 3 (AWS EMEA, Google Cloud EMEA, Cloudflare, MailChannels, Proofpoint, Anthropic Ireland, spectra tech UAB) **[VE]** | Which SMTP/storage/monitoring vendors? (§26) | **Yes [LA]** | same |
| **Special-category data (Art. 9)** | Medical *equipment* is being sold — that is not, by itself, health data | Possibly none | — | **Do not assume.** Assess whether any order, note or AI prompt reveals a patient's health | The assessment | **[OD]** | **Not assessed. Do not declare Art. 9 applicable or inapplicable without looking.** A free-text delivery note or an assistant prompt could carry it | Are free-text fields restricted or reviewed? | **Yes [LA]** | Art. 9 GDPR |
| **ePrivacy** (2002/58/EC) + **Polish Prawo komunikacji elektronicznej** | Cookie/terminal-storage consent; marketing | All visitors | **Only strictly necessary cookies ship** — access, refresh and CSRF tokens plus three `localStorage` preference keys; none is read by the server **[VR]** | **No cookie banner is needed for what ships.** Adding analytics, a pixel or any ad tag loses that exemption and requires a blocking banner with an equally prominent reject | Cookie inventory; consent records if any tag is added | **[OD]** | **Good** — this is a genuine advantage; do not throw it away | Is any analytics planned? | If tags added **[LA]** | `backend/docs/DATA-PROTECTION.md` §5 |
| **DSA** (EU) 2022/2065 | An **online marketplace** letting third-party sellers list to EU consumers/businesses is an online platform | Seller Hub, listings, admin approval | Seller onboarding + document upload; admin approval queue; audit log **[VR]** | Trader traceability (Art. 30); notice-and-action (Art. 16); **statement of reasons (Art. 17)** on every rejection/removal; internal complaint handling (Art. 20); T&C transparency; no dark patterns; recommender transparency; annual average-monthly-recipients publication | Statements of reasons; notice log; T&C versions | **[OD]** | **Partial.** Seller verification and approval exist; notice-and-action and statement-of-reasons machinery **do not** | Micro/small enterprise exemptions under Art. 19 — do they apply? | **Yes [LA]** | [EC DSA](https://digital-strategy.ec.europa.eu/en/policies/digital-services-act) |
| **P2B Regulation** (EU) 2019/1150 | Platform intermediating between business sellers and business buyers | Seller Hub | — | Ranking-parameter transparency; T&C changes with 15-day notice; internal complaint-handling; mediators named | T&C versions; complaint log | **[OD]** | Not started | Does the seller model make UBOSS an intermediation service? (§26) | **Yes [LA]** | EUR-Lex 32019R1150 |
| **DAC7** (EU) 2021/514 | Reporting obligation on platform operators facilitating relevant activities by sellers | Seller payouts | `seller_payouts` exists **[VR]** | Seller due-diligence data collection; annual reporting to a Member State authority | Collected seller TINs/VAT; reports filed | **[OD]** | Not started | Does the sales model make UBOSS a reporting platform operator? | **Yes [LA]** | EUR-Lex 32021L0514 |
| **VAT / cross-border B2B** | Selling into Poland | Orders, invoices | Multi-currency `BigInt` minor units; `Decimal(9,6)` tax rates; VIES check against `ec.europa.eu/taxation_customs/vies` **[VR]** | Polish VAT registration?; reverse charge; importer of record; EORI; customs | VAT registration; VIES check results; invoices | **[OD]** | `backend/docs/EU-VAT.md` exists. Entity position undecided | Who imports the goods into the EU? | **Yes [LA]** | `backend/docs/EU-VAT.md` |
| **KSeF 2.0** (Polish structured invoicing) | Mandatory e-invoicing in Poland | Invoices | None built | Determine applicability **first** | Determination memo | **[OD]** | **See §7.2 — likely does not apply** | — | **Yes [LA]** | [ksef.podatki.gov.pl](https://ksef.podatki.gov.pl/) |
| **MDR** (EU) 2017/745 | Medical devices placed on the EU market | Catalogue, sellers | GPSR/compliance fields exist (`gpsr.service.ts`, `PRODUCT-SAFETY.md`) **[VR]** | Determine role: manufacturer / authorised rep / **importer** / **distributor** / pure intermediary. CE marking, UDI, EUDAMED, Polish-language IFU and labels, batch/lot/serial/expiry, storage and transport conditions, vigilance, FSCA/recall, complaint handling | Declarations of conformity; CE certificates; UDI records; supplier files | **[OD]** | **Not assessed. This is the largest non-technical risk in the whole plan.** | Is UBOSS an economic operator or an intermediary? It changes everything | **Yes [LA]** | [EC economic operators](https://health.ec.europa.eu/medical-devices-topics-interest/economic-operators_en), [MDR](https://eur-lex.europa.eu/eli/reg/2017/745/oj) |
| **IVDR** (EU) 2017/746 | If any in-vitro diagnostic is listed | Catalogue | Category gating | Same role determination | Same | **[OD]** | Not assessed | Are IVDs in scope of the catalogue? | **Yes [LA]** | [IVDR](https://eur-lex.europa.eu/eli/reg/2017/746/oj) |
| **GPSR** (EU) 2023/988 | General product safety; **specific obligations for online marketplaces** | Listings | `gpsr.service.ts`, warning-language tracking **[VR]** | Responsible-person-in-the-Union for each product; listing content requirements; single contact point for authorities and consumers; Safety Gate registration and notice handling; recall communication | Listing compliance records; Safety Gate correspondence | **[OD]** | **Partial** — fields exist, process does not | Overlap with MDR for devices | **Yes [LA]** | [GPSR](https://eur-lex.europa.eu/eli/reg/2023/988/oj) |
| **EU AI Act** (EU) 2024/1689 | A customer-facing chatbot and an image-classification search | Assistant, image search | Provider country recorded in code; clinical-advice refusal in the system prompt; conversation retention window **[VR]** | **Art. 50 transparency: tell users they are talking to an AI.** AI literacy for staff (in force since 2 Feb 2025). Human oversight. Risk classification recorded | Risk classification memo; disclosure screenshots; training record | **[OD]** | **Transparency obligations apply from August 2026 — i.e. now** **[VE]**. Verify the disclosure is visible in all eight languages | Is the assistant a "limited risk" system only? | **Yes [LA]** | [EC AI Act](https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai) |
| **Cyber Resilience Act** (EU) 2024/2847 | **UBOSS is sold to other companies to run themselves** — that makes it a product with digital elements placed on the EU market | The product itself | Security-update mechanism; SBOM; vulnerability handling | CE marking for the software; vulnerability disclosure policy; actively-exploited-vulnerability reporting to ENISA/CSIRT; support period declared | SBOM; vulnerability register; reporting records | **[OD]** | **Not started — and this one is easy to miss because it is about the product, not the deployment** | Confirm main obligations' application date and whether a self-hosted B2B sale is in scope | **Yes [LA]** | [EC CRA](https://digital-strategy.ec.europa.eu/policies/cyber-resilience-act) |
| **NIS2** (EU) 2022/2555 + Polish **KSC** amendment | Online marketplaces are digital providers in Annex II | The operating entity | — | Registration; ISMS; incident reporting | Registration confirmation; ISMS documents | **[OD]** | **Polish KSC amendment in force 3 Apr 2026. Registration in the S46 system was due 3 Oct 2026. ISMS obligations by 3 Apr 2027** **[VE]**. Size and establishment thresholds likely exclude a small India-based entity — **but the deadline is imminent if they do not** | Does the entity meet the medium-enterprise threshold and have an EU establishment? | **Yes [LA]** | [gov.pl KSC](https://www.gov.pl/web/baza-wiedzy/nowelizacja-ustawy-o-krajowym-systemie-cyberbezpieczenstwa) |
| **DORA** (EU) 2022/2554 | — | — | — | — | — | — | **Out of scope**, and the reason is simple: DORA applies to financial entities and their critical ICT third-party providers. UBOSS is neither — it sells medical supplies and uses a regulated PSP rather than being one | Revisit only if UBOSS itself becomes a payment or credit institution | No | EUR-Lex 32022R2554 |
| **EAA** (EU) 2019/882 | **E-commerce is expressly in scope** **[VE]** | All three frontends | `eslint-plugin-jsx-a11y`, `axe-core`, per-app `audit:contrast` gate in `verify` **[VR]** | WCAG 2.2 AA via EN 301 549; published accessibility statement; testing evidence | Audit reports; statement; remediation log | **[OD]** | **Better than most** — `backend/docs/ACCESSIBILITY.md` exists and contrast auditing is a build gate. No published statement | **[NV]** Confirm the application date and the microenterprise-services exemption thresholds directly from Directive 2019/882 — EUR-Lex could not be retrieved in this session | **Yes [LA]** | [EC EAA](https://commission.europa.eu/strategy-and-policy/policies/justice-and-fundamental-rights/disability/european-accessibility-act-eaa_en) |
| **PSD2 / SCA** | Card payments to EU customers | Checkout, auto-pay | Stripe SetupIntent/PaymentIntent; off-session mandates with consent version and timestamp; `authentication_required` handling | Merchant agreement; mandate wording reviewed | Consent records per schedule | **[OD]** | **Strong** — consent version and timestamp are stored per schedule **[VR]** | Is the Stripe account EEA-acquired? | **[LA]** | [Stripe docs](https://docs.stripe.com/) |
| **PCI DSS v4.0.1** | Card acceptance | Checkout | **Card data never touches this server** — Stripe Elements posts directly to Stripe **[VR]**; TLS 1.2/1.3 only; no PAN stored | Determine the correct SAQ with the acquirer; annual attestation; script-integrity and payment-page change-detection controls | AOC/SAQ; script inventory | **[OD]** | **Good architecture, no attestation.** SAQ eligibility is not something this document can decide | Which SAQ does the acquirer require? | **Yes** | [PCI SSC](https://www.pcisecuritystandards.org/) |
| **Polish consumer / language law** | If any B2C buyer is ever admitted | Storefront | Eight languages incl. Polish **[VR]** | Withdrawal rights, price presentation, complaint handling, Polish-language T&Cs — **none of which currently exist because the platform is B2B** | T&Cs; withdrawal policy | **[OD]** | **B2B only today.** Admitting one consumer changes the obligation set materially | Will any B2C buyer be admitted? (§26) | **Yes [LA]** | — |

### 7.2 KSeF applicability — a determination, not an implementation task

The instruction was to establish applicability before turning dates into
requirements. Here is the determination, and it is the most useful compliance
finding in this review.

**Verified dates [VE]** (ksef.podatki.gov.pl, accessed 2026-09-16):

- Mandatory from **1 February 2026** for businesses whose 2024 sales exceeded
  PLN 200 m (incl. VAT).
- Mandatory from **1 April 2026** for **everyone else**.
- Transitional relief until **31 December 2026** for taxpayers whose monthly
  sales on such documents do not exceed PLN 10,000.

So KSeF is *already live and mandatory in Poland* as of today.

**But [VE]:** the Ministry of Finance states that taxpayers **without a seat of
business and without a fixed establishment (*stałe miejsce prowadzenia
działalności*, SMPD) in Poland are excluded from the obligation to issue
invoices in KSeF.** Where a fixed establishment exists but does not participate
in the supply for which the invoice is issued, the exclusion also applies. Such
entities may use KSeF **voluntarily**.

**Therefore:**

| Question | Answer |
|---|---|
| Must UBOSS itself issue Polish structured invoices? | **Only if the selling entity has a seat or a participating SMPD in Poland.** An India-established company with neither is excluded **[VE]** |
| Do sellers issue their own invoices? | **[OD]** — depends on the marketplace model chosen in §26 |
| Is UBOSS merely transmitting invoice information? | **[OD]** — if so, KSeF obligations sit with the seller, not the platform |
| Does the India entity have Polish VAT registration or establishment? | **[OD] [UB]** — **this single answer decides the whole row** |
| API authentication, certificates, permissions, outage mode, audit evidence | **Do not build any of it until the answer above is "yes".** Building a KSeF integration for an entity that is excluded is wasted work and creates a filing obligation where none existed |
| Invoice immutability and retention | Required regardless of KSeF, under Polish VAT retention rules **[LA]** |
| Currency and VAT rounding, PLN/EUR | Already handled: money is `BigInt` minor units end to end, tax rates are `Decimal(9,6)`, rounding is half-up per line **[VR]** |

**Decision required (§26):** does the selling entity have a Polish seat or
fixed establishment? Route through a Polish tax adviser. Note that
"SMPD for KSeF purposes" has its own Ministry of Finance guidance
(explanatory notes of 28 January 2026) and is **not** the same test as
VAT registration.

### 7.3 The warning that matters most

**EU hosting does not solve the transfer problem.** Placing the VPS in Germany
puts the *bytes at rest* in the EEA. It does nothing about the fact that
engineers in India will hold SSH keys, read production logs, query the database
during an incident and open the admin console. Each of those is remote access to
personal data from a third country, and each needs the same Chapter V basis as
shipping a database export there would.

Practical consequences, all **[OD]**:

- SCCs between the EU-facing controller and whoever provides Indian support.
- A Transfer Impact Assessment covering Indian government access powers.
- Access minimisation as a supplementary measure: named accounts, MFA, no
  shared credentials, admin actions written to the append-only audit log, and a
  quarterly access review (§23).
- Consider whether production data access can be restricted to EEA-resident
  personnel, with Indian engineers working against sanitised staging data. That
  is the cleanest answer and it is an architecture decision, not a paperwork one.

---

## 8. Data inventory, flows and retention

Retention values marked *(env)* are enforced by `RETENTION_SWEEP` in the worker
**[VR]**. Region depends on choices in §26.

| Category | Purpose | Lawful basis | Role | Source | Destination | Region | Encryption | Access | Retention | Deletion | Backups | Vendors | Open legal decision |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Buyer accounts** | Operate the account | Art. 6(1)(b) | Controller | Sign-up | MariaDB | VPS region | TLS in transit; argon2 password hash; **disk not encrypted at rest by default** | Admin roles | Life of account | Erasure workflow anonymises, keeps invoiced orders | In nightly dump | Hostinger | Controller identity |
| **Seller representatives** | Onboarding, listings, payouts | Art. 6(1)(b) | Controller | Seller application | MariaDB + object storage (certificates) | VPS + bucket region | as above | Admin + that seller | Life of relationship + tax period | Same | Dump + media archive | Hostinger, storage vendor | DSA trader traceability retention |
| **Admin / staff** | Run the system | Art. 6(1)(b) employment | Controller | Staff creation | MariaDB | VPS region | as above; MFA secret encrypted | Admin | Employment + `<DECIDE>` | Deactivate then erase | Dump | — | Retention after leaving |
| **Logistics users and drivers** | Assign and track shipments | Art. 6(1)(b)/(f) | Controller (or joint with carrier) | Carrier invitation | MariaDB | VPS region | device token hashed; OTP redacted from logs **[VR]** | Carrier-scoped | Life of engagement | Sweep | Dump | Carrier | **Joint controllership with the carrier company** |
| **GPS / location pings** | Live shipment tracking | Art. 6(1)(f) — **needs an LIA** | Controller | Driver device | MariaDB | VPS region | lat/long **redacted from logs** **[VR]** | Ops roles | `RETENTION_LOGISTICS_LOCATION_PING_DAYS` *(env)* | Sweep deletes | **Present in dumps until they expire** | — | **DPIA almost certainly required** |
| **Admin sign-in location** | Anti-fraud on staff sign-in | Art. 6(1)(f) | Controller | Browser geolocation | MariaDB | VPS region | redacted from logs | Admin | `RETENTION_SESSION_LOCATION_DAYS` *(env)* | Sweep | Dump | Nominatim (OSMF) | **`FEATURE_ADMIN_LOGIN_LOCATION` defaults to `true` — `DATA-PROTECTION.md` §2.1 says set it `false` in the EU. §12** |
| **Addresses** | Delivery and invoicing | Art. 6(1)(b) | Controller | Customer | MariaDB | VPS region | — | Order roles | With the order | With the order | Dump | Carriers | — |
| **Orders** | Contract performance | Art. 6(1)(b)+(c) | Controller | Checkout | MariaDB | VPS region | — | Order roles | **Tax retention — `<DECIDE>` years** | Retained through erasure where invoiced | Dump | — | Polish retention period |
| **Invoices** | Legal obligation | Art. 6(1)(c) | Controller | System | Object storage | Bucket region | Bucket-side | Finance | Polish VAT retention | Not deletable within the period | Media archive | Storage vendor | **Immutability requirement** |
| **Payment identifiers** | Reconciliation | Art. 6(1)(b)+(c) | Controller; PSP is a controller for its own purposes | PSP | MariaDB | VPS region | secrets encrypted (`SECRETS_ENCRYPTION_KEY`) | Finance | With the order | With the order | Dump | Stripe / Razorpay | **No card data is stored — verified** |
| **Card details** | — | — | — | — | **Never reaches this server** | Stripe | — | — | — | — | — | Stripe | PCI SAQ selection |
| **Auto-pay mandates** | Off-session charging | Art. 6(1)(b) + explicit consent | Controller | Customer tick | MariaDB | VPS region | — | Finance | Until cancelled + tax period | On cancellation | Dump | Stripe | Mandate wording review |
| **ERP credentials** | Connect operator/buyer ERPs | Art. 6(1)(b)/(f) | Controller / processor | Admin or buyer | MariaDB `credentialsEnc` | VPS region | **AES via `SECRETS_ENCRYPTION_KEY`** **[VR]** | Narrow | Life of connection | On disconnect | **Dump — and the key is NOT in the dump** | Buyer's ERP | Buyer is controller of their own data |
| **OAuth tokens** (monday.com, buyer ERPs) | Integration | Art. 6(1)(b) | Processor for the buyer | OAuth flow | MariaDB encrypted | VPS region | encrypted | Narrow | Until revoked | On revoke | Dump | monday.com | Art. 28 with each buyer |
| **Product data** | Catalogue | n/a mostly | — | Operator/sellers | MariaDB + object storage | VPS + bucket | — | Wide read | Life of listing | On delist | Both | — | GPSR/MDR content duties |
| **AI prompts** | Answer buyer questions | Art. 6(1)(f), or (a) if presented as consent | Controller; **provider is processor** | Visitor free text | MariaDB, **and sent to Anthropic/Google in the US** | US | TLS | Support roles | `RETENTION_ASSISTANT_CONVERSATION_DAYS` *(env)* | Sweep | Dump | Anthropic, Google | **SCCs + model-training opt-out + DPA** |
| **Search images** | Image product search | Art. 6(1)(f) | Controller | Upload | Sent to the AI provider | US | TLS | — | not persisted as a product asset | — | — | Anthropic/Google | Same |
| **Support / enquiry transcripts** | Respond to prospects | Art. 6(1)(f) or (a) | Controller | Storefront form | MariaDB | VPS region | — | Support | `RETENTION_ASSISTANT_CONVERSATION_DAYS` | Sweep | Dump | — | LIA if (f) |
| **Audit logs** | Accountability | Art. 6(1)(c)+(f) | Controller | System | MariaDB `audit_logs` | VPS region | **Append-only by DB grant: `REVOKE UPDATE, DELETE`** **[VR]** | Admin read | `RETENTION_AUDIT_LOG_DAYS` *(env)* | Sweep | Dump | — | Retention vs. minimisation |
| **Server / app logs** | Operations | Art. 6(1)(f) | Controller | journald | Local disk | VPS region | pino redaction of 40+ paths **[VR]** | root/ops | **journald default — `<DECIDE>` and cap it (§10)** | rotation | **Not backed up** | — | Log retention policy |
| **Backups** | Recovery | Art. 6(1)(c)+(f) | Controller | `backup.sh` | Local **and** the configured off-site remote | VPS region + remote region | **Dump, media archive and `.env` are all AES-256 encrypted, each with a SHA-256 beside it** | root | `KEEP_DAYS` | `find -mtime -delete` | — | Off-site vendor | **Erasure vs. backups: document that restores re-apply erasure** |

**Two things this table is designed to make impossible to miss:**

1. **Erasure and backups conflict, and the conflict must be written down, not
   solved.** A dump taken before an erasure still contains the person. The
   accepted position is: backups are not searched or edited; if a backup is ever
   restored, the erasure log is re-applied before the system is returned to
   service. That belongs in the privacy notice and in the restore runbook.
2. **The database dump is not encrypted.** `backup.sh` GPG-encrypts `.env` and
   leaves `db-*.sql.gz` in the clear **[VR]**. Fixed in §17.

---

## 9. Production prerequisites

Work top to bottom. Nothing below starts before everything above is ticked.

| # | Item | Where | Done when | Notes |
|---|---|---|---|---|
| 1 | Hostinger account with **MFA enabled** | hPanel | MFA prompt appears at sign-in | The account can rebuild the server and read the backups. It is a root credential |
| 2 | Recovery codes for that MFA stored offline | Password manager | Stored | Not on the VPS |
| 3 | **Data-centre chosen and purchased** | hPanel order flow | VPS provisioned | **Germany or Lithuania.** Poland is not offered for VPS **[VE]**. §10.1 |
| 4 | **Latency measured from Polish networks** before committing | External | Median RTT recorded from at least 3 Polish ISPs | Required. Do not choose on a map |
| 5 | Static IPv4 recorded; IPv6 decision made | hPanel | Recorded | §11 |
| 6 | Reverse DNS set if outbound mail is sent from the box | hPanel | `dig -x <IP>` resolves | Only if not using an SMTP relay — and you should use a relay |
| 7 | Domain registered; DNS provider access confirmed | Registrar | Can create records | §11 |
| 8 | GitHub access: protected `main`, deploy key or environment secrets | GitHub | Branch protection visible | §15 |
| 9 | **Production Stripe account, EEA-acquired** | Stripe | Live keys issued | `<DECIDE>` — Razorpay is an Indian acquirer and is not suitable for EU trade (`DATA-PROTECTION.md` §2.4) |
| 10 | **Production SMTP provider with a DPA and an EU region** | Vendor | Test mail delivered | `EMAIL_DRIVER=log` is refused in production **[VR]** |
| 11 | SPF, DKIM, DMARC published for the sending domain | DNS | `dig TXT` shows all three | Otherwise verification and invitation mail lands in spam — and those links cannot be read from logs |
| 12 | **AI provider account + DPA + training opt-out** | Anthropic or Google | Key issued, opt-out confirmed in writing | Or leave both keys unset and ship without the assistant |
| 13 | **S3-compatible object storage + CDN** | Vendor | Bucket created; `products/*` public-read, `private/*` not; listing off on both | Driver built; provider is **[OD]** (D12) |
| 14 | Error tracking and uptime monitoring | Vendor | Alert received in a test | §18 |
| 15 | **Off-site backup destination** | Vendor | `rclone check` passes from the VPS | Set `UBOSS_OFFSITE_REMOTE`; the nightly run fails loudly without it |
| 16 | DPA / SCC / subprocessor review for every vendor above | Legal | Signed | §7 |
| 17 | Privacy notice, cookie notice, B2B terms, seller terms, logistics terms, AUP — **in Polish** | Legal | Published | §7 |
| 18 | **Staging environment** on its own host or a second small VPS | Hostinger | Reachable | §20 |
| 19 | Incident contacts and on-call rota | — | Written down | §6 |
| 20 | Password manager / secret store for the team | Vendor | In use | §12 |

---

## 10. Server provisioning and hardening

**Placeholders used throughout.** Replace before running; never paste a real
secret into a shell that has history enabled.

| Placeholder | Meaning |
|---|---|
| `<DOMAIN>` | apex domain, e.g. `example.com` |
| `<VPS_IP>` | the VPS IPv4 |
| `<DEPLOY_USER>` | your personal admin account on the VPS |
| `<ADMIN_IP>` | the office/VPN address allowed to SSH |
| `<SERVICE_USER>` | `uboss` — the unprivileged service account |

**Legend for "Where":** **[W]** local Windows PowerShell · **[H]** Hostinger
hPanel · **[D]** DNS provider · **[G]** GitHub settings · **[S]** VPS SSH shell.

### 10.0 The one rule that prevents a lockout

**Do not disable root login or password authentication until a *second*,
separate terminal has proved key-based login works.** Keep the first session
open throughout §10.4. Hostinger's browser console in hPanel is the emergency
door if both fail — confirm you can open it **before** you need it.

### 10.1 Choosing the region — verified facts

**[VE]** Hostinger's own support page (last updated 2026-09-15, accessed
2026-09-16) lists VPS locations as: **France, Germany, Lithuania, United
Kingdom** (Europe); India, Indonesia, Malaysia; USA (Phoenix, Boston); Brazil.
The Netherlands and USA (Asheville) are **not** available for VPS.

- **Poland is not offered.** Do not claim a Polish data centre.
- **The UK is outside the EEA.** Choosing it turns hosting itself into a
  third-country transfer requiring a UK adequacy assessment. Avoid it.
- **Germany and Lithuania** are the EU/EEA candidates nearest Poland. Lithuania
  is Hostinger's home region; Germany is typically the better-connected.
- **The order flow in hPanel is authoritative**, not the support article.
  Verify availability at purchase.

**Required before committing [OD]:** run a latency test from Polish networks.

```powershell
# [W] — from a Polish network, or ask a Polish contact to run it.
# Replace each host with the IP of a trial VPS in that region.
Test-Connection -TargetName <VPS_IP> -Count 20 |
  Measure-Object -Property Latency -Average -Maximum -Minimum
```

Record median RTT per candidate region. Decide on measurement, not geography.

**Hostinger responsibilities to review and record [VE]:** the DPA (last updated
2026-09-15) names Hostinger as **processor**, contracting through Hostinger
International Ltd. (Cyprus), Hostinger UK Limited, or Hostinger Global S.à r.l
(Luxembourg); applies **EU SCCs Modules Two/Three** for transfers outside the
EEA; lists subprocessors in Appendix 3; and commits to notifying security
incidents **"without undue delay"** with no stated hour count — which is weaker
than your own Art. 33 72-hour clock, so your detection must not depend on
theirs. Security measures are in Appendix 2. **The VPS is self-managed:
operating-system and application security are yours, not Hostinger's.**

### 10.2 Operating system

**Ubuntu 24.04 LTS (noble).** Reasons, all verified:

- `deploy/scripts/bootstrap.sh` is written and commented against it **[VR]**.
- It packages **MariaDB 10.11.x** (`1:10.11.14-0ubuntu0.24.04.1` in `noble`
  updates), an **LTS release supported to 2028-02-16** **[VE]**.
- Ubuntu 26.04 LTS exists (released April 2026) but is not yet offered as an
  upgrade path in `meta-release-lts` **[VE]**, and a first production deployment
  is the wrong place to be early.

Confirm Ubuntu 24.04 is offered in the chosen region at purchase **[H]**.

### 10.3 First contact and updates

| Step | Where | Command | Expected | Verify | Rollback |
|---|---|---|---|---|---|
| 1 | **[H]** | Deploy VPS: Ubuntu 24.04 LTS, chosen region, **SSH key added at creation** | VPS running, IP shown | Note `<VPS_IP>` | Rebuild from hPanel |
| 2 | **[W]** | `ssh root@<VPS_IP>` | Root prompt | `hostnamectl` | — |
| 3 | **[S]** | `apt-get update && apt-get -y full-upgrade && apt-get -y autoremove` | Packages upgraded | `apt list --upgradable` is empty | Snapshot first **[H]** |
| 4 | **[S]** | `reboot` if a kernel was installed | Comes back | `uname -r` | hPanel console |
| 5 | **[S]** | `timedatectl set-timezone UTC && timedatectl set-ntp true` | UTC, NTP active | `timedatectl` shows `System clock synchronized: yes` | Re-run |

**Time zone policy — get this right, three layers disagree by default:**

| Layer | Setting | Why |
|---|---|---|
| **OS** | `UTC` | Logs correlate across systems; no DST discontinuity |
| **MariaDB** | `default_time_zone = '+00:00'` (already in `deploy/mariadb/uboss.cnf` **[VR]**) | Every instant is `DATETIME(3)` in UTC |
| **Driver session** | `timezone: 'Z'` (already in `src/infra/prisma.ts` **[VR]**) | Stops the driver applying a local offset |
| **Application** | `DEFAULT_TIMEZONE=Europe/Warsaw` | **The default is `Asia/Kolkata`** **[VR]** — wrong for Poland. Wall-clock recurrence carries its own IANA zone per schedule |

```bash
# [S] verification — all three must agree
timedatectl | grep -E "Time zone|synchronized"
sudo mariadb -e "SELECT @@global.time_zone, @@session.time_zone, NOW(), UTC_TIMESTAMP();"
```

### 10.4 Accounts, SSH and the lockout-safe order

| Step | Where | Command | Expected | Verify | Rollback |
|---|---|---|---|---|---|
| 1 | **[W]** | `ssh-keygen -t ed25519 -C "<DEPLOY_USER>@uboss-prod" -f $env:USERPROFILE\.ssh\uboss_prod` | Key pair written | `Get-Content ~\.ssh\uboss_prod.pub` | Delete and regenerate |
| 2 | **[S]** | `adduser --disabled-password --gecos "" <DEPLOY_USER>` then `usermod -aG sudo <DEPLOY_USER>` | User created | `id <DEPLOY_USER>` shows `sudo` | `deluser` |
| 3 | **[S]** | `install -d -m 700 -o <DEPLOY_USER> -g <DEPLOY_USER> /home/<DEPLOY_USER>/.ssh` | Directory | `ls -ld` shows `700` | — |
| 4 | **[S]** | Paste the public key into `/home/<DEPLOY_USER>/.ssh/authorized_keys`, then `chmod 600` and `chown` it | Key installed | `ls -l` | — |
| 5 | **[W]** | **In a NEW window, keeping the first open:** `ssh -i ~\.ssh\uboss_prod <DEPLOY_USER>@<VPS_IP>` | Logs in **without a password** | `sudo -v` succeeds | First window is still root |
| 6 | **[S]** | **Only after step 5 succeeded.** Write `/etc/ssh/sshd_config.d/99-uboss.conf`: `PermitRootLogin no`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PubkeyAuthentication yes`, `AllowUsers <DEPLOY_USER>`, `X11Forwarding no`, `MaxAuthTries 3`, `ClientAliveInterval 300` | File written | `sudo sshd -t` returns nothing | Delete the file |
| 7 | **[S]** | `systemctl reload ssh` | Reloaded | **Open a THIRD window and log in again** | First window still open |
| 8 | **[S]** | Close the root window only after step 7's login succeeded | — | — | — |

**Emergency access procedure — write this into the runbook now:**
1. hPanel → VPS → **Browser terminal**. Works when SSH does not.
2. If that fails: hPanel → **Recovery mode**, mount the volume, fix
   `/etc/ssh/sshd_config.d/99-uboss.conf`.
3. Last resort: restore the most recent **snapshot** (not the weekly backup —
   snapshots are point-in-time and faster).

### 10.5 Firewall

`bootstrap.sh` runs `ufw allow OpenSSH`, `ufw allow 'Nginx Full'`,
`ufw --force enable` **[VR]**. That leaves SSH open to the world. Tighten it:

```bash
# [S] — restrict SSH to known addresses where practical.
# Do this ONLY with a confirmed working hPanel browser console.
sudo ufw allow from <ADMIN_IP> to any port 22 proto tcp comment 'admin SSH'
sudo ufw delete allow OpenSSH
sudo ufw status numbered          # verify BEFORE closing your session
```

If the team has dynamic IPs, keep SSH open but rely on keys-only + fail2ban, and
record that as an accepted risk. **Never** open 3306 or 4000–4002.

**Also configure Hostinger's own firewall in hPanel [H]** as a second layer
outside the OS: inbound 80, 443, and 22 from `<ADMIN_IP>`. A UFW mistake then
cannot expose the database, and Hostinger's DDoS protection sits in front.

| Verify | Command | Expected |
|---|---|---|
| Local view | `sudo ufw status verbose` | Only 22 (restricted), 80, 443 |
| **External view** | `nmap -Pn -p 22,80,443,3306,4000-4002 <VPS_IP>` from **[W]** | 3306 and 4000–4002 `filtered`/`closed` |
| Bindings | `sudo ss -tlnp` | MariaDB and node on `127.0.0.1` only |

### 10.6 Hardening beyond what `bootstrap.sh` does

**Applied.** `bootstrap.sh` now installs `unattended-upgrades`, writes a
fail2ban `jail.local` and caps the journal. Everything below is the verification,
and the commands remain correct for a machine bootstrapped before that change.

Two choices in what it writes are worth knowing about, because both are
deliberate and both look like omissions:

- **`Unattended-Upgrade::Automatic-Reboot "false"`.** There is one machine. A
  reboot at 02:00 is an outage nobody scheduled, so a kernel update waits for a
  person — and `monitor.sh` reports `/var/run/reboot-required` so that person
  hears about it.
- **The nginx jails do not inherit `backend = systemd`.** They read
  `error.log`; a systemd backend with no `journalmatch` makes fail2ban skip the
  jail at start-up and say so in a log nobody reads.

```bash
# [S] automatic security updates — installed by bootstrap.sh; verify them
sudo apt-get install -y unattended-upgrades apt-listchanges
sudo dpkg-reconfigure -plow unattended-upgrades
# Verify:
sudo unattended-upgrade --dry-run --debug 2>&1 | tail -20
systemctl status unattended-upgrades --no-pager
```

```bash
# [S] fail2ban jail — bootstrap.sh writes this; this is what it writes
sudo tee /etc/fail2ban/jail.local >/dev/null <<'EOF'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd

[sshd]
enabled = true

[nginx-http-auth]
enabled = true

[nginx-limit-req]
enabled  = true
filter   = nginx-limit-req
logpath  = /var/log/nginx/error.log
maxretry = 20
findtime = 1m
bantime  = 10m
EOF
sudo systemctl restart fail2ban
sudo fail2ban-client status              # verify jails are listed
sudo fail2ban-client status sshd
```

```bash
# [S] journald caps — bootstrap.sh writes this too; without it logs grow
#     until the disk is full, and a full disk here stops MariaDB
sudo tee /etc/systemd/journald.conf.d/99-uboss.conf >/dev/null <<'EOF'
[Journal]
SystemMaxUse=2G
SystemKeepFree=5G
MaxRetentionSec=30day
Compress=yes
EOF
sudo systemctl restart systemd-journald
journalctl --disk-usage                  # verify
```

`MaxRetentionSec=30day` is a **[OD]** privacy decision as well as a disk one:
logs hold IP addresses and user agents. §8.

```bash
# [S] logrotate for nginx is packaged; confirm it is active
sudo logrotate -d /etc/logrotate.d/nginx 2>&1 | head -20
```

**Swap, memory and resource limits** — `bootstrap.sh` creates 2 GB of swap with
`vm.swappiness=10` **[VR]**. Keep it: it is a cushion against an OOM kill, not
a place to run. **Any sustained swap-in is a stop condition (§5).**

```bash
# [S] verify
swapon --show
sysctl vm.swappiness
systemctl show uboss-api@4000 -p MemoryMax -p MemoryHigh
systemctl show uboss-worker    -p MemoryMax -p MemoryHigh
```

**Filesystem permissions and secret files:**

```bash
# [S]
sudo chmod 750 /srv/uboss
sudo chmod 700 /srv/uboss/shared /srv/uboss/backups
sudo chown <SERVICE_USER>:<SERVICE_USER> /srv/uboss/shared/.env
sudo chmod 600 /srv/uboss/shared/.env
# Verify NOTHING else can read it:
sudo -u www-data cat /srv/uboss/shared/.env   # must fail with Permission denied
stat -c '%a %U:%G %n' /srv/uboss/shared/.env  # expect: 600 uboss:uboss
```

**Disk and inode alerting** (§18 wires the destination):

```bash
# [S] quick manual check; automate in §18
df -h /; df -i /
```

**Malware / upload controls.** Uploads are sniffed by **magic bytes**, not by
the declared MIME type or the extension **[VR]**, and served with
`X-Content-Type-Options: nosniff`, `Content-Disposition: inline` and
`Content-Security-Policy: default-src 'none'; sandbox`. Two env flags exist to
weaken this and **must stay off**:
`SELLER_ALLOW_UNSCANNED_DOCUMENTS`, `LOGISTICS_ALLOW_UNSCANNED_DOCUMENTS` **[VR]**.
An antivirus scan of seller certificate uploads is **[OD]** — if required, a
ClamAV daemon plus a worker job is the shape, and it costs memory this box does
not have to spare (§4.6).

### 10.7 systemd hardening already present

Do not redo these; verify them.

```bash
# [S]
systemd-analyze security uboss-api@4000
systemd-analyze security uboss-worker
```

Already set in `deploy/systemd/` **[VR]**: `NoNewPrivileges`, `PrivateTmp`,
`PrivateDevices`, `ProtectSystem=strict`, `ProtectHome`, `ProtectKernelTunables`,
`ProtectKernelModules`, `ProtectControlGroups`, `RestrictSUIDSGID`,
`RestrictRealtime`, `LockPersonality`, `ReadWritePaths=/srv/uboss/media`,
`MemoryMax`, `LimitNOFILE=65535`.

**Worth adding** (safe with this application, which makes only outbound
TCP/HTTPS and reads no kernel interfaces):

```ini
# [S] /etc/systemd/system/uboss-api@.service.d/override.conf
[Service]
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
SystemCallFilter=@system-service
SystemCallArchitectures=native
ProtectProc=invisible
PrivateUsers=yes
```

Apply with `systemctl daemon-reload && systemctl restart uboss-api@4000`, then
**confirm `/health/ready` still answers before touching 4001 and 4002.** A
syscall filter that is one call too tight fails at runtime, not at load.

---

## 11. DNS, domains, TLS and Nginx

### 11.1 Hostnames

The repository's nginx config ships **two** hostnames — `shop.example.com` and
`admin.example.com` **[VR]**. The code now supports **five** roles. The gap is
blocker **B5**, now fixed — the `carriers` block is in `deploy/nginx/uboss.conf`.

| Role | Proposed host | Serves | Backed by env | Status in `deploy/nginx/uboss.conf` |
|---|---|---|---|---|
| Storefront + Seller Hub | `shop.<DOMAIN>` | `customer-web/dist` | `CUSTOMER_WEB_ORIGIN`, `CUSTOMER_WEB_PUBLIC_URL` | **Present** |
| Admin console | `admin.<DOMAIN>` | `admin-web/dist` | `ADMIN_WEB_ORIGIN`, `ADMIN_WEB_PUBLIC_URL` | **Present** |
| Logistics portal | `carriers.<DOMAIN>` | `logistics-web/dist` | `LOGISTICS_WEB_ORIGIN`, `LOGISTICS_WEB_PUBLIC_URL` | **MISSING — must be written** |
| Seller storefronts | `*.shops.<DOMAIN>` | resolved per request from the `Host` header | `SELLER_STOREFRONT_DOMAIN` | **MISSING — needs a wildcard vhost and a wildcard certificate.** Off by default; leave `SELLER_STOREFRONT_DOMAIN` empty until needed |
| API | **no separate host** — `/api/v1` on each app host | `API_PUBLIC_URL` | — | Present |
| Media / CDN | `cdn.<DOMAIN>` → object storage or CDN | `STORAGE_PUBLIC_BASE_URL` | — | n/a — off this box |
| Staging | `staging.<DOMAIN>`, `staging-admin.<DOMAIN>` | separate host | separate `.env` | §20 |

**Why no API subdomain:** the SPAs call `/api/v1` on their own origin. That
keeps session and CSRF cookies `SameSite=Lax`, keeps `connect-src 'self'`, and
avoids a CORS preflight on every write. Moving the API to `api.<DOMAIN>` would
require `SameSite=None`, a widened CSP and `COOKIE_DOMAIN` gymnastics for no
benefit on one box.

**`COOKIE_DOMAIN` must be the parent domain with a leading dot** —
`.<DOMAIN>` — so one session works on all three hosts. Leave it empty and an
administrator signs in and is instantly signed out **[VR]**.

### 11.2 DNS records

| Type | Name | Value | TTL | Note |
|---|---|---|---|---|
| A | `shop` | `<VPS_IP>` | **300 during cutover**, 3600 after | |
| A | `admin` | `<VPS_IP>` | 300 → 3600 | |
| A | `carriers` | `<VPS_IP>` | 300 → 3600 | |
| A | `@` | `<VPS_IP>` or a redirect host | 3600 | **[OD]** what the apex serves |
| CNAME | `cdn` | object-storage / CDN hostname | 3600 | |
| AAAA | as above | IPv6 | 300 → 3600 | **[OD]** — see below |
| TXT | `@` | `v=spf1 include:<smtp-provider> -all` | 3600 | |
| TXT | `<selector>._domainkey` | DKIM from the SMTP provider | 3600 | |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:<addr>` | 3600 | Start at `p=none`, tighten |
| CAA | `@` | `0 issue "letsencrypt.org"` | 3600 | Stops any other CA issuing for you |

**TTL discipline:** drop every record you will move to **300 s at least 24 hours
before** cutover (§21), so the old TTL has expired everywhere. Raise back to
3600 after 48 stable hours.

**IPv6 [OD]:** publish `AAAA` only if the VPS has a working IPv6 address **and**
nginx listens on `[::]:443` (it does — `listen [::]:443 ssl` **[VR]**) **and**
you have tested the site over IPv6. A published `AAAA` that does not answer
makes the site look broken to dual-stack visitors while appearing fine to you.

```powershell
# [W] verify after publishing
nslookup shop.<DOMAIN>
nslookup -type=AAAA shop.<DOMAIN>
```

### 11.3 TLS

```bash
# [S] — DNS must already point here, and port 80 must be open.
sudo nginx -t
sudo certbot --nginx -d shop.<DOMAIN> -d admin.<DOMAIN> -d carriers.<DOMAIN> \
     --agree-tos -m <ops-email> --no-eff-email
```

| Check | Command | Expected |
|---|---|---|
| Renewal timer exists | `systemctl list-timers certbot.timer` | Scheduled |
| **Renewal actually works** | `sudo certbot renew --dry-run` | `Congratulations, all simulated renewals succeeded` |
| Chain and grade | `curl -vI https://shop.<DOMAIN>` and Qualys SSL Labs | A or better |
| Expiry | `echo \| openssl s_client -connect shop.<DOMAIN>:443 2>/dev/null \| openssl x509 -noout -dates` | > 30 days |

**Do not skip the dry run.** An expired certificate is a total outage that looks
like a hack to every visitor, and it is the most common self-inflicted
production incident there is.

**HSTS ordering.** The API sets `max-age=31536000; includeSubDomains` in
production and nginx sets `max-age=63072000; includeSubDomains` on static
responses **[VR]**. `includeSubDomains` means **every** subdomain must be
HTTPS-capable, for the whole max-age duration.

> **Enable HSTS only after every subdomain you will ever use — including
> `carriers`, `cdn`, `staging` and any future seller storefront — answers on
> HTTPS.** Do not submit to the preload list until the site has run for a month.
> Preloading is effectively irreversible on browser timescales.

### 11.4 Content-Security-Policy — extended, still watching

**The policy has been extended so that enforcing it no longer blanks checkout.**
The origins in the table below are in `uboss-security-headers.conf` now, not in
a comment, together with a `$uboss_csp_extra` variable for the map or tile host
this particular installation configures — that one cannot be guessed, because
`MAP_STYLE_URL`, `MAP_TILE_URL` and `MAP_GOOGLE_API_KEY` are the operator's
choice.

**It is still Report-Only, and that is the remaining go-live step.** Allowing an
origin never breaks a page; omitting one does. "Derived from reading the source"
and "walked through every screen on the real hostname" are different things, and
the gap between them is a storefront that cannot take an order. The procedure
below is what closes it.

The repository ships CSP in **Report-Only** mode, deliberately **[VR]**:

```
add_header Content-Security-Policy-Report-Only $uboss_csp always;
# add_header Content-Security-Policy $uboss_csp always;
```

The policy as originally written had `script-src 'self'`, `connect-src 'self'`
and **no `frame-src`**, against a storefront that loads
`https://js.stripe.com/v3/` dynamically and renders Stripe Elements in
cross-origin iframes **[VR]**. **Enforcing that would have blocked card entry
entirely** — not degraded it: an empty box where the card number goes.

**Stripe's own required directives [VE]** (docs.stripe.com/security/guide,
accessed 2026-09-16):

| Directive | Stripe.js / Elements |
|---|---|
| `connect-src` | `https://api.stripe.com` (plus `https://maps.googleapis.com` if the Address Element uses your Maps key) |
| `frame-src` | `https://*.js.stripe.com`, `https://js.stripe.com`, `https://hooks.stripe.com` (**`hooks.stripe.com` is required for 3-D Secure**) |
| `script-src` | `https://*.js.stripe.com`, `https://js.stripe.com` |
| `img-src` | `https://*.stripe.com` |

Razorpay additionally needs `https://checkout.razorpay.com` in `script-src` and
`frame-src` **[VR]** for the referenced script. All of these are now in the
shipped policy. **The Razorpay origins have not been walked through against a
real checkout in this session**, so an installation using Razorpay must watch
the reports before it enforces.

**Procedure to enforce CSP — this is a go-live condition, not a nicety:**

1. Run staging for a full day with the Report-Only header and a browser console
   open, or point `report-uri` at a collector.
2. Walk every screen: storefront, product, **image search**, cart, **checkout
   with a real 3-D Secure test card**, **card save**, account, Seller Hub,
   admin console, **admin warehouse map**, logistics portal.
3. Add each legitimately reported origin to the policy. Expected additions:
   Stripe (above), Razorpay if enabled, the `MAP_TILE_URL` / `MAP_STYLE_URL`
   hosts, and `https://maps.googleapis.com` if `MAP_GOOGLE_API_KEY` is set.
4. Only when a full day reports nothing, swap the two lines.
5. Re-verify checkout immediately after the swap. **A CSP that is one directive
   short does not degrade — it blanks the page.**

`style-src 'unsafe-inline'` is unavoidable and is honestly documented in the
snippet: React `style={{...}}` props become inline style *attributes*.
`style-src-attr 'unsafe-inline'` narrows it to attributes, so an injected
stylesheet is still refused **[VR]**.

### 11.5 CORS

Built from `ADMIN_WEB_ORIGIN` + `CUSTOMER_WEB_ORIGIN` + `LOGISTICS_WEB_ORIGIN`,
exact-match, `credentials: true` **[VR]**. Each must match scheme, host and
port exactly, with **no trailing slash**. A request with no `Origin` header
(server-to-server, webhooks) is allowed — correct, since those paths are
protected by signatures rather than by origin.

### 11.6 Real client IP — a verified rate-limit bypass

`deploy/nginx/snippets/uboss-proxy.conf` sets:

```
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

and `backend/src/http/app.ts` sets `trustProxy: isProduction` — i.e. **`true`**,
which trusts the entire forwarded chain **[VR]**.

`$proxy_add_x_forwarded_for` **appends** to any `X-Forwarded-For` the client
sent. With `trustProxy: true`, Fastify takes the left-most entry as
`request.ip`. **A client can therefore choose its own `request.ip` by sending
its own `X-Forwarded-For` header**, defeating the per-IP application rate limit
and the per-IP login lockout.

Two independent fixes. **Both are now applied.**

```nginx
# deploy/nginx/snippets/uboss-proxy.conf — APPLIED
proxy_set_header X-Forwarded-For $remote_addr;
```

```ts
// backend/src/http/app.ts — APPLIED
trustProxy: isProduction ? 'loopback' : false,
```

`'loopback'` rather than the literal `127.0.0.1` because it also covers `::1`,
which is what an upstream spelled `localhost` resolves to first.

Either fix alone closes the practical hole — nginx is the only path in, and the
API is bound to loopback by the unit. Both together survive the change that
would otherwise quietly reopen it: somebody putting a CDN or a second proxy in
front and restoring `$proxy_add_x_forwarded_for` without narrowing `trustProxy`
to that proxy's address. **If a proxy is ever added in front of this one**, the
correct shape is `set_real_ip_from <that proxy>` plus
`real_ip_header X-Forwarded-For` — trusting the header from that address and
from nowhere else.

Verify:

```bash
# [S] should log the REAL address, not 1.2.3.4
curl -s -H 'X-Forwarded-For: 1.2.3.4' https://shop.<DOMAIN>/health/live >/dev/null
sudo tail -2 /var/log/nginx/access.log
journalctl -u uboss-api@4000 -n 5
```

Note the **edge** limiter in nginx (`limit_req_zone $binary_remote_addr`) uses
`$binary_remote_addr`, which is the real peer address and **cannot** be spoofed
**[VR]**. That limiter is unaffected by this issue.

### 11.7 Upload size, timeouts, buffering

| Setting | Value | Rule |
|---|---|---|
| `client_max_body_size` | `8m` | **Must exceed `UPLOAD_MAX_BYTES`.** nginx refuses a larger body with a bare 413 before the API can produce a readable message **[VR]** |
| `proxy_connect_timeout` | `5s` | |
| `proxy_read_timeout` | `30s` general, **`60s` on `/payments/webhooks/`** | Stripe rejects a delivery signed more than 5 minutes ago, so a queue here becomes signature failures |
| `proxy_buffering` | `off` for the API | Lets a GDPR export stream without nginx holding it in memory |
| `proxy_no_cache` / `proxy_cache_bypass` | `1` | Never let a cached API response leak between customers |

**If video upload is enabled** (`UPLOAD_VIDEO_MAX_BYTES` exists **[VR]**),
`client_max_body_size` must be raised above it too, or video upload fails with an
unexplained 413.

### 11.8 WebSocket / SSE

The proxy snippet carries `Upgrade` / `Connection` headers and a
`$connection_upgrade` map **[VR]**. No route currently upgrades — the AI
assistant streams over an ordinary HTTP response — so this is harmless
future-proofing. `proxy_buffering off` is what makes assistant streaming work.

### 11.9 Caching

| Path | Policy | Why |
|---|---|---|
| `/assets/` | `public, max-age=31536000, immutable` | Vite fingerprints every file |
| `= /index.html` | `no-cache, must-revalidate` | It names the current fingerprints. **A cached `index.html` points at chunks the last release deleted, and the site goes blank for exactly the people who visit most often** |
| `/api/v1/` | `proxy_no_cache 1` | Never cache a per-customer response |
| `/media/products/` | `public, max-age=604800` | Only applies if media is served from this box |
| `/health/`, `/assets/` | `access_log off` | Noise |

**The `add_header` inheritance trap, repeated because it catches everybody
once:** a `location` that sets *any* `add_header` inherits *none* from its
parent. `nginx -t` passes, the page loads, and the CSP, HSTS and frame options
are simply gone. Every location that adds a header **must** also
`include /etc/nginx/snippets/uboss-security-headers.conf` **[VR]**.

### 11.10 SPA fallback that does not mask API 404s

```nginx
location /api/v1/        { ... proxy_pass http://uboss_api; }  # never falls through
location /assets/        { try_files $uri =404; }
location /media/products/ { try_files $uri =404; }
location /               { try_files $uri $uri/ /index.html; } # last, lowest priority
```

`/assets/` and `/media/` end in `=404` deliberately: without it, a broken image
returns `index.html` with a `200` **[VR]**.

### 11.11 Maintenance page and controlled deployment

```nginx
# [S] add near the top of each server block
set $maintenance 0;
if (-f /srv/uboss/shared/MAINTENANCE) { set $maintenance 1; }
if ($maintenance = 1) { return 503; }
error_page 503 @maintenance;
location @maintenance {
    root /srv/uboss/shared/maintenance;
    rewrite ^ /index.html break;
    add_header Retry-After 600 always;
    include /etc/nginx/snippets/uboss-security-headers.conf;
}
```

```bash
# [S] on / off
sudo -u uboss touch /srv/uboss/shared/MAINTENANCE
sudo -u uboss rm    /srv/uboss/shared/MAINTENANCE
```

**Exempt `/api/v1/payments/webhooks/` from the maintenance gate.** A provider
that receives a 503 retries for a while and then gives up, leaving a customer
charged for an order that never confirms (§22).

### 11.12 The logistics vhost (B5 — now shipped in `deploy/nginx/uboss.conf`)

```nginx
# [S] /etc/nginx/sites-available/uboss.conf — add a third server block
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name carriers.<DOMAIN>;

    ssl_certificate     /etc/letsencrypt/live/carriers.<DOMAIN>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/carriers.<DOMAIN>/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    root /srv/uboss/current/logistics-web;
    index index.html;
    client_max_body_size 8m;

    include /etc/nginx/snippets/uboss-security-headers.conf;
    include /etc/nginx/snippets/uboss-compression.conf;

    # A carrier portal must never be indexed.
    add_header X-Robots-Tag "noindex, nofollow, noarchive" always;

    location /api/v1/ {
        limit_req zone=uboss_api_zone burst=60 nodelay;
        include /etc/nginx/snippets/uboss-proxy.conf;
        proxy_pass http://uboss_api;
    }
    location ~ ^/api/v1/auth/(login|register|password) {
        limit_req zone=uboss_auth_zone burst=10 nodelay;
        include /etc/nginx/snippets/uboss-proxy.conf;
        proxy_pass http://uboss_api;
    }
    location /health/ {
        access_log off;
        include /etc/nginx/snippets/uboss-proxy.conf;
        proxy_pass http://uboss_api;
    }
    location /assets/ {
        expires 1y;
        include /etc/nginx/snippets/uboss-security-headers.conf;
        add_header X-Robots-Tag "noindex, nofollow, noarchive" always;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        access_log off;
        try_files $uri =404;
    }
    location = /index.html {
        include /etc/nginx/snippets/uboss-security-headers.conf;
        add_header X-Robots-Tag "noindex, nofollow, noarchive" always;
        add_header Cache-Control "no-cache, must-revalidate" always;
    }
    location / { try_files $uri $uri/ /index.html; }
}
```

Add `carriers.<DOMAIN>` to the port-80 redirect block's `server_name` too, or
ACME renewal for it will fail.

---

## 12. Environment and secrets

**No secret values appear in this document and none may ever be added.** The
matrix names variables and describes their shape only.

The API validates the whole file at boot and **prints every problem at once
before exiting** **[VR]**. Read the failure; do not work around it.

### 12.1 Must change for production — refuse-to-start, or silently wrong

| Variable | Component | Purpose | Req | Secret | Production value | Dev/staging difference | Rotation | Validated by | If wrong |
|---|---|---|---|---|---|---|---|---|---|
| `NODE_ENV` | API, worker | Turns on every guard below | yes | no | `production` | `development` / `test` | n/a | `env.ts` enum | **Every guard below is skipped** |
| `SESSION_COOKIE_SECRET` | API | Cookie signing | yes | **yes** | `openssl rand -base64 36` | any | Rotate in a window — everyone is signed out | placeholder check | **Refuses to start** on the `.env.example` placeholder |
| `ACCESS_TOKEN_SECRET` | API | Access token signing | yes | **yes** | as above, **distinct** | any | as above | placeholder check | **Refuses to start** |
| `REFRESH_TOKEN_SECRET` | API | Refresh token signing | yes | **yes** | as above, **distinct** | any | as above | placeholder check | **Refuses to start** |
| `SECRETS_ENCRYPTION_KEY` | API, worker | Encrypts stored ERP/OAuth credentials | yes | **yes** | 32 bytes, base64 | any | **Only with a re-encryption plan — every `credentialsEnc` value is bound to the current key** | length check | Every stored ERP credential becomes undecryptable |
| `COOKIE_SECURE` | API | `Secure` flag | yes | no | `true` | `false` | n/a | production guard | **Refuses to start** |
| `COOKIE_DOMAIN` | API | Cookie scope | yes | no | `.<DOMAIN>` — **leading dot** | empty | n/a | — | Sign in on admin, immediately signed out |
| `COOKIE_SAME_SITE` | API | CSRF posture | yes | no | `lax` | `lax` | n/a | enum | `none` without `secure` is refused by browsers |
| `API_PUBLIC_URL` | API | Webhook and redirect URLs | yes | no | `https://shop.<DOMAIN>` | `http://localhost:4000` | n/a | URL | Webhooks and links point at the wrong host |
| `CUSTOMER_WEB_ORIGIN` | API | CORS + links | yes | no | `https://shop.<DOMAIN>` | `http://localhost:5174` | n/a | origin list | CORS refuses the storefront |
| `ADMIN_WEB_ORIGIN` | API | CORS + links | yes | no | `https://admin.<DOMAIN>` | `http://localhost:5173` | n/a | origin list | CORS refuses the console |
| `LOGISTICS_WEB_ORIGIN` | API | CORS | conditional | no | `https://carriers.<DOMAIN>` | — | n/a | required when the portal is on | Portal cannot call the API |
| `LOGISTICS_WEB_PUBLIC_URL` | API | Invitation links | conditional | no | same, **https required in production** | — | n/a | https check in production | Invitations point nowhere |
| `EMAIL_DRIVER` | API, worker | Mail transport | yes | no | `smtp` | `log` | n/a | production guard | **Refuses to start** on `log` |
| `STORAGE_DRIVER` | API, worker | Media storage | yes | no | **`s3`** | `local` | n/a | production guard; `s3` requires bucket + both keys | `local` **refuses to start** in production — a VPS disk is one disk |
| `ALLOW_PRIVATE_ERP_TARGETS` | API, worker | SSRF escape hatch | no | no | unset / `false` | `true` for a mock ERP | n/a | production guard | **Refuses to start** if `true` — it makes the cloud metadata endpoint reachable from a form field |
| `DATABASE_URL` | API, worker | Runtime database | yes | **yes** | `mysql://uboss_app:...@127.0.0.1:3306/uboss` | local | Quarterly | parsed at boot | No start |
| `MIGRATE_DATABASE_URL` | `release.sh` only | Schema-owning user | yes | **yes** | `mysql://uboss_migrate:...@127.0.0.1:3306/uboss` | unset | Quarterly | warned if unset | Migrations run with the runtime user's rights |
| `DB_POOL_SIZE` | API, worker | Pool ceiling **per process** | yes | no | `12` | `10` | n/a | 1–100 | 4 processes x pool must stay under `max_connections = 200` |
| `DEFAULT_CURRENCY` | API | Fallback currency | yes | no | **`PLN`** | `INR` | n/a | 3 chars | **The default is `INR`** — wrong for Poland |
| `DEFAULT_TIMEZONE` | API | Application wall-clock | yes | no | **`Europe/Warsaw`** | `Asia/Kolkata` | n/a | — | **The default is `Asia/Kolkata`** — schedules fire at the wrong hour |
| `FEATURE_ADMIN_LOGIN_LOCATION` | API | Staff sign-in geolocation | no | no | **`false` in the EU** | `true` | n/a | — | **Defaults to `true`.** `DATA-PROTECTION.md` §2.1 says turn it off for the EU |

### 12.2 Payments

| Variable | Req | Secret | Notes |
|---|---|---|---|
| `PAYMENT_DEFAULT_PROVIDER` | yes | no | **`STRIPE` for EU trade.** Razorpay is an Indian acquirer |
| `STRIPE_SECRET_KEY` | conditional | **yes** | **A `sk_test_` key with `NODE_ENV=production` refuses to start — "test keys never collect money". An `sk_live_` key outside production also refuses** **[VR]** |
| `STRIPE_PUBLISHABLE_KEY` | conditional | no | Handed to the browser by the API at runtime, never baked into a bundle |
| `STRIPE_WEBHOOK_SECRET` | conditional | **yes** | The `whsec_` value. **Without it an order can never reach CONFIRMED** |
| `RAZORPAY_KEY_ID` / `_KEY_SECRET` / `_WEBHOOK_SECRET` | conditional | **yes** | The same live/test guards apply |
| `AUTOPAY_CONSENT_VERSION` | no | no | Bump when the mandate wording changes — stored per schedule as evidence |
| `AUTOPAY_PLATFORM_MAX_MINOR` | no | no | Hard ceiling on an off-session charge. Set it deliberately |
| `PAYMENT_LINK_TTL_HOURS` | no | no | How long an unpaid payment link stays usable |

### 12.3 Everything else

| Group | Variables | Secret | Notes |
|---|---|---|---|
| **Email** | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME` | password | Use a relay with a DPA and an EU region |
| **AI** | `ASSISTANT_ENABLED`, `ASSISTANT_PROVIDER`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `ASSISTANT_MAX_TURNS`, `ASSISTANT_MAX_TOKENS`, `ASSISTANT_ALLOW_GUESTS`, `ASSISTANT_RATE_LIMIT_PER_5MIN`, `ASSISTANT_GUEST_RATE_LIMIT_PER_5MIN` | keys | **Leaving both keys unset disables the assistant cleanly** — the simplest way to remove a US transfer |
| **Object storage** | `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `STORAGE_PUBLIC_BASE_URL`, `STORAGE_LOCAL_DIR` | keys | Required when `STORAGE_DRIVER=s3`. `S3_REGION=auto` for Cloudflare R2; `S3_FORCE_PATH_STYLE=true` for R2 and MinIO. `STORAGE_PUBLIC_BASE_URL` is the CDN or bucket base for `products/` only |
| **ERP (the operator's own)** | `FEATURE_ERP_INTEGRATION`, `ERP_ORDER_CONNECTION_NAME`, `ERP_ORDER_PATH`, `ERP_ORDER_REFERENCE_PATH`, `ERP_STOCK_PATH`, `ERP_MAX_*`, `ERP_FAILURE_THRESHOLD`, `ERP_IDEMPOTENCY_HEADER`, `ERP_VERIFY_STOCK_BEFORE_CHARGE` | no | Off by default |
| **ERP (each buyer's own)** | `FEATURE_CUSTOMER_ERP`, `CUSTOMER_ERP_*`, `CUSTOMER_ERP_ALLOWED_HOST_SUFFIXES`, `CUSTOMER_ERP_OAUTH_REDIRECT_URI`, `MONDAY_OAUTH_CLIENT_ID`, `MONDAY_OAUTH_CLIENT_SECRET`, `MONDAY_OAUTH_SCOPES` | OAuth secret | **A different feature from the operator's ERP — never conflate them.** `CUSTOMER_ERP_ALLOWED_HOST_SUFFIXES` is a second SSRF control on top of §19's address checks |
| **Maps** | `MAP_TILE_URL`, `MAP_TILE_ATTRIBUTION`, `MAP_STYLE_URL`, `MAP_STYLE_ATTRIBUTION`, `MAP_GOOGLE_API_KEY`, `MAP_GOOGLE_MAP_ID` | Google key | **A Google Maps browser key must be restricted by HTTP referrer in the Google console** — it is visible to anyone who opens the admin panel |
| **Geocoding / FX / VAT** | `GEOCODE_FORWARD_URL`, `GEOCODE_REVERSE_URL`, `GEOCODE_TIMEOUT_MS`, `FX_RATE_URL`, `FX_RATE_TIMEOUT_MS`, `VIES_CHECK_URL`, `VIES_TIMEOUT_MS` | no | Defaults: Nominatim (OSMF, EU-based), `open.er-api.com` (third country), EC VIES **[VR]** |
| **Rate limits and lockout** | `RATE_LIMIT_GLOBAL_PER_MINUTE` (300), `RATE_LIMIT_LOGIN_PER_15MIN` (10), `LOGIN_LOCKOUT_THRESHOLD`, `LOGIN_LOCKOUT_MINUTES` | no | **`RATE_LIMIT_GLOBAL_PER_MINUTE` is counted per API process — three instances means three times the number you wrote** |
| **Retention** | `RETENTION_AUDIT_LOG_DAYS`, `RETENTION_ASSISTANT_CONVERSATION_DAYS`, `RETENTION_SESSION_LOCATION_DAYS`, `RETENTION_LOGISTICS_LOCATION_PING_DAYS`, `RETENTION_SENT_NOTIFICATION_DAYS`, `RETENTION_ABANDONED_CART_DAYS`, `DATA_REQUEST_DOWNLOAD_TTL_HOURS` | no | **Art. 5(1)(e). Each is a documented legal decision, not a default to accept** |
| **Worker** | `WORKER_CONCURRENCY`, `WORKER_POLL_INTERVAL_MS`, `WORKER_LEASE_SECONDS` | no | Raise concurrency before adding a process |
| **Queue / cache** | `QUEUE_DRIVER=database`, `CACHE_DRIVER=memory`, `REDIS_URL` | no | Leave as defaults. `redis` throws "not implemented"; `CACHE_DRIVER` is read nowhere **[VR]** |
| **Backups** | `UBOSS_BACKUP_PASSPHRASE`, `UBOSS_OFFSITE_REMOTE`, `UBOSS_OFFSITE_OPTOUT` | passphrase | Read from `/etc/uboss/backup.env` (root, 0600) by `uboss-backup.service`, **not** from `shared/.env`. **Store the passphrase off this machine — it is deliberately not in the backups** |
| **Logging** | `LOG_LEVEL` | no | `info` in production. `debug` is a privacy risk as well as a disk one |
| **Schedules** | `SCHEDULE_*` (cutoff, notice days, materialise-ahead, reminder lead, price tolerance, max attempts) | no | Business rules. Review with the owner |
| **Frontend (build-time)** | `VITE_API_BASE_URL` | no | **Baked into the bundle at build time. See B3 and §14** |

### 12.4 Generating, storing, delivering and rotating secrets

```bash
# [S] generation — 36 bytes base64 for signing secrets
openssl rand -base64 36
# 32 bytes base64 for SECRETS_ENCRYPTION_KEY
openssl rand -base64 32
```

```powershell
# [W] equivalent, if a secret must be generated on Windows
$b = New-Object byte[] 36
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
[Convert]::ToBase64String($b)
```

| Concern | Rule |
|---|---|
| **On the server** | `/srv/uboss/shared/.env`, `chmod 600`, owned by the service user. Loaded by systemd `EnvironmentFile=`, **never** written into a unit file — units are world-readable and end up in `systemctl cat` output, support tickets and screenshots |
| **Off the server** | A password manager or a secret store. **Never** a spreadsheet, a chat message or a ticket |
| **Delivery to CI** | GitHub **Environment secrets** on a protected `production` environment with required reviewers. CI receives a **deploy SSH key**, not the `.env` |
| **Out of Git** | Ignore-by-default rules are in `.gitignore`, with named exceptions for `.env.example` and the three non-secret `apps/*/.env`. Still add `gitleaks` and GitHub push protection (§15) |
| **Out of logs** | pino redacts 40+ paths including `req.headers.authorization`, `cookie`, `set-cookie`, `stripe-signature`, `x-razorpay-signature`, `password*`, `token*`, `mfaSecret`, `credentialsEnc`, `cardNumber`, `cvv`, and driver `latitude`/`longitude` **[VR]** |
| **Out of bundles** | Only `VITE_`-prefixed variables reach the browser, and the only one is `VITE_API_BASE_URL` **[VR]**. **Never** prefix a secret with `VITE_` |
| **Rotation** | Signing secrets: any time, in a window. `SECRETS_ENCRYPTION_KEY`: **only with a re-encryption plan**. Database passwords: quarterly. Provider keys: per the provider's policy, and immediately on any suspicion |

---

## 13. XAMPP MariaDB to production migration

This is the highest-risk mechanical step in the plan. Do not improvise it.

### 13.1 Verified facts about both sides

| Fact | Local (XAMPP) | Production (Ubuntu 24.04) | Source |
|---|---|---|---|
| Server version | **10.4.32-MariaDB** | **10.11.x** (`1:10.11.14-0ubuntu0.24.04.1` in `noble` updates) | `mysql.exe --version` **[VR]**; Launchpad **[VE]** |
| **Support status** | **End of life since 2024-06-18 — no security fixes** | LTS until **2028-02-16** | endoflife.date **[VE]** |
| Client dump binary | **`mysqldump.exe`** — `mariadb-dump` is **not** present in `C:\xampp\mysql\bin` | `mariadb-dump`, with `mysqldump` as a compatibility symlink | directory listing **[VR]** |
| **`sql_mode`** | **`NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION`** — **no `STRICT_TRANS_TABLES`** | MariaDB's default since 10.2.4 **includes `STRICT_TRANS_TABLES`** | `SELECT @@sql_mode` **[VR]**; MariaDB docs **[VE]** |
| Server charset / collation | `utf8mb4` / **`utf8mb4_general_ci`** | `deploy/mariadb/uboss.cnf` sets `utf8mb4_unicode_ci` | **[VR]** |
| **Table collations** | **All 171 tables are `utf8mb4_unicode_ci`** — the migrations set it explicitly, so the server default never applies | same | `information_schema` **[VR]** |
| `time_zone` | `SYSTEM` → `Asia/Calcutta` | `+00:00` | **[VR]** |
| `lower_case_table_names` | **`1`** (Windows) | **`0`** (Linux) | **[VR]** / platform default |
| Storage engine | InnoDB only | InnoDB | **[VR]** |
| `max_connections` | 151 | 200 (from the shipped cnf) | **[VR]** |
| Views / triggers / routines / events / generated columns | **0 / 0 / 0 / 0 / 0** | same | **[VR]** |
| `TIMESTAMP` columns | **0** — everything is `DATETIME(3)` | same | **[VR]** |
| Foreign keys / CHECK constraints | **241 / 216** | same | **[VR]** |
| Database size today | **77.6 MB** | — | **[VR]** |
| Prisma provider / adapter | `mysql` provider with `@prisma/adapter-mariadb` 7.10.0 | same | **[VR]** |
| Schema drift | **None.** `prisma migrate status` reports *"48 migrations found ... Database schema is up to date!"* | — | **[VR]**, run 2026-09-16 |
| Money / decimal types | Money is `BigInt` minor units; tax rates `Decimal(9,6)`; rounding half-up per line | same | **[VR]** |
| Auto-increment behaviour | **None on business tables** — primary keys are ULIDs in `CHAR(26)`, so there is no sequence to reset after an import | same | **[VR]** |

### 13.2 The five real risks, and what each one actually does

**Do not assume XAMPP 10.4 can be copied into 10.11.** This list is short only
because the schema turned out to be unusually clean — no views, no triggers, no
routines, no generated columns, no `TIMESTAMP`.

| # | Risk | What actually happens | Mitigation |
|---|---|---|---|
| **M1** | **`sql_mode` becomes strict** | An `INSERT` or `UPDATE` that silently truncated or coerced a value locally **throws** in production. It surfaces weeks later as a 500 on a screen nobody tested — not as an import error | **Done once, and it found a real defect** — see below. Repeat it on staging before cutover. §13.3 step 0 |

**What the first strict run found, recorded because it is the shape of the next
one.** Setting `sql_mode` to the 10.11 default on the development server and
running the suite produced **26 failures across 2 files**. One cause:
`correlationId` was `CHAR(26)` — the width of a ULID — in **ten** tables, while
`app.ts` accepts a client-supplied `x-correlation-id` of **up to 64
characters** and echoes it back. On 10.4 the extra characters were dropped in
silence. On 10.11 the insert fails with `ERROR 1406`, and several of those
writes sit **inside a transaction**, so the failure would not merely have lost
an audit row — it would have rolled the order back with it.

Nothing in development would ever have shown this. It needed a customer or an
API gateway that stamps its own trace header, and a strict server. Fixed in
`20260916210000_correlation_id_matches_what_the_api_accepts`, which widens all
ten to `VARCHAR(64)` — a widening, so it is safe in a single release.
| **M2** | **`lower_case_table_names` 1 → 0** | Identifiers become case-sensitive. A dump written on Windows referring to a differently-cased identifier will not match on Linux | Prisma `@@map` names are consistently lower-case **[VR]**, so no impact is expected — but **verify** with the query in §13.4 |
| **M3** | **Server collation differs** (`general_ci` vs `unicode_ci`) | Sorting and `UNIQUE` comparison change for Polish, Greek and German text | **No impact expected: every table already carries `utf8mb4_unicode_ci` explicitly [VR].** Create the production database with `COLLATE utf8mb4_unicode_ci` so any future table inherits the right one |
| **M4** | **Client version skew** | A 10.4 `mysqldump` writes version-conditional comments a 10.11 server may read differently | **Build the schema from `prisma migrate deploy`, never from a dumped schema.** §13.3 separates schema from data for exactly this reason |
| **M5** | **`mysqldump` vs `mariadb-dump`** | Flags and defaults differ, and `mysqldump` is being retired in MariaDB 11.x | **Check which binary exists before choosing flags.** §13.4 |

### 13.3 The migration plan

> **The rule that governs the whole procedure: the schema is built by
> `prisma migrate deploy` and never by importing a dumped schema. Only *data*
> moves, and only data that has been explicitly approved.**

**Step 0 — make local match production before migrating anything.**

```ini
; [W] C:\xampp\mysql\bin\my.ini, under [mysqld]
sql_mode = STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION
```

```powershell
# [W] restart MariaDB from the XAMPP control panel, then:
& C:\xampp\mysql\bin\mysql.exe -u root -e "SELECT @@sql_mode;"
cd C:\Users\HP\Desktop\UBoss-Software\backend
npm run verify
```

**If `npm run verify` fails after this change, you have found M1 before your
customers did.** Fix it before going further. Run the backend tests on their
own — two `verify` runs share one test database and collide.

**Step 1 — full local backup.**

```powershell
# [W] mysqldump, because that is the binary XAMPP ships [VR]
$stamp = Get-Date -UFormat "%Y%m%d-%H%M%S"
$out   = "$env:USERPROFILE\uboss-backups"
New-Item -ItemType Directory -Force $out | Out-Null
& C:\xampp\mysql\bin\mysqldump.exe -u root --single-transaction --quick `
    --routines --events --triggers --hex-blob `
    --default-character-set=utf8mb4 uboss `
  | Out-File -Encoding utf8 "$out\uboss-full-$stamp.sql"
Get-Item "$out\uboss-full-$stamp.sql" | Select-Object Name, Length
```

`--routines --events --triggers` are included even though the database has none
**[VR]**. If a later change introduces one, this dump catches it instead of
silently losing it.

**Step 2 — prove the backup restores.** A backup that has never been restored is
a hypothesis, not a backup.

```powershell
# [W]
& C:\xampp\mysql\bin\mysql.exe -u root -e "CREATE DATABASE uboss_restore_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
Get-Content "$out\uboss-full-$stamp.sql" | & C:\xampp\mysql\bin\mysql.exe -u root uboss_restore_test
& C:\xampp\mysql\bin\mysql.exe -u root -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='uboss_restore_test';"
# Expect 171. Then drop it:
& C:\xampp\mysql\bin\mysql.exe -u root -e "DROP DATABASE uboss_restore_test;"
```

**Step 3 — clean staging database, and three database users.**

```bash
# [S] on the staging host
sudo mariadb <<'SQL'
CREATE DATABASE uboss CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER 'uboss_app'@'localhost'     IDENTIFIED BY '<long random>';
CREATE USER 'uboss_migrate'@'localhost' IDENTIFIED BY '<different long random>';
CREATE USER 'uboss_backup'@'localhost'  IDENTIFIED BY '<third long random>';

GRANT SELECT, INSERT, UPDATE, DELETE ON uboss.* TO 'uboss_app'@'localhost';
REVOKE UPDATE, DELETE ON uboss.audit_logs FROM 'uboss_app'@'localhost';

GRANT ALL PRIVILEGES ON uboss.* TO 'uboss_migrate'@'localhost';

GRANT SELECT, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER ON uboss.* TO 'uboss_backup'@'localhost';
GRANT RELOAD, REPLICATION CLIENT ON *.* TO 'uboss_backup'@'localhost';

FLUSH PRIVILEGES;
SQL
```

**Three users, each with the least it needs.** This is `RUNBOOK.md` §7's
requirement made concrete.

| User | Used by | Rights | Why |
|---|---|---|---|
| `uboss_app` | API and worker, always | DML only; **no `UPDATE`/`DELETE` on `audit_logs`** | An audit trail the application can rewrite is not an audit trail |
| `uboss_migrate` | `release.sh`, one command per release | DDL on `uboss` only | A compromised application cannot alter its own schema |
| `uboss_backup` | `backup.sh` | `SELECT, LOCK TABLES, SHOW VIEW` plus `RELOAD, REPLICATION CLIENT` for the binlog position | A nightly unattended job must not be able to drop a database |
| `uboss_binlog` | `ship-binlogs.sh`, every 15 min | `REPLICATION SLAVE, REPLICATION CLIENT, RELOAD` on `*.*` — and **no `SELECT` on any table** | It reads the log of changes, never the data. Fetching the logs this way is what keeps the shipper off the filesystem and out of root |

```bash
# [S] verify the audit-log revoke actually took effect
sudo mariadb -e "SHOW GRANTS FOR 'uboss_app'@'localhost';"
# Expect a GRANT on uboss.* AND a separate narrower line for uboss.audit_logs
```

**Step 4 — build the schema from migrations.**

```bash
# [S]
cd /srv/uboss/current/backend      # this directory MUST contain prisma.config.ts (B2)
set -a; . /srv/uboss/shared/.env; set +a
DATABASE_URL="$MIGRATE_DATABASE_URL" npx prisma migrate deploy
DATABASE_URL="$MIGRATE_DATABASE_URL" npx prisma migrate status
```

Expect `48 migrations found` and `Database schema is up to date!`.

- **Never `prisma db push` in production.** It diffs and applies without writing
  a migration record, which desynchronises every future release.
- **Never `prisma migrate dev`.** It is interactive, will offer to reset the
  database, and generates migration files.

**Step 5 — compare the migrated schema with the local one.** §13.4.

**Step 6 — decide what data may move.** Schema migration and business-data
migration are separate approvals.

| Category | Migrate? | Rationale |
|---|---|---|
| **Reference data** — currencies, countries, tax classes | **No — regenerate.** `npm run db:reference` is idempotent and safe in production **[VR]** | Generated data is not business data |
| Categories, manufacturers, brands | **Yes**, if curated | Real work |
| Products, variants, prices, images | **Yes**, if curated | Real work. **Re-price for PLN/EUR — a product with no price row in a currency is deliberately excluded from that market** |
| Warehouses, locations, stock levels | **Owner decision** | Opening balances, not history |
| GPSR / compliance fields | **Yes** | Legally required listing content |
| **Development users and staff accounts** | **No** | Seeded credentials. `README.md` step 11 says delete them **[VR]** |
| **Test customers and organisations** | **No** | |
| **Test orders, payments, refunds** | **Absolutely not** | Test-gateway references against a live account create reconciliation noise nobody can clear |
| **Sessions, refresh tokens, CSRF tokens, invitations, reset tokens** | **No** | Credentials with a shelf life |
| **ERP / OAuth credentials (`credentialsEnc`)** | **No** | Encrypted under the *development* `SECRETS_ENCRYPTION_KEY` and undecryptable in production. Re-enter them |
| **Payment methods and auto-pay mandates** | **No** | Bound to test-mode provider customers |
| **Audit logs, job queue, idempotency records, notifications** | **No** | Operational history of a different system |
| **Assistant conversations, enquiries, location pings** | **No** | Personal data with no production purpose. Migrating it is a data-minimisation failure |

**Step 7 — export only the approved tables, data only.**

```powershell
# [W] no schema, no DROP statements
$tables = "categories","manufacturers","products","product_variants","product_prices","product_images"
& C:\xampp\mysql\bin\mysqldump.exe -u root `
    --no-create-info --single-transaction --quick --hex-blob `
    --complete-insert --skip-add-locks --skip-extended-insert `
    --default-character-set=utf8mb4 `
    uboss $tables `
  | Out-File -Encoding utf8 "$out\uboss-catalog-$stamp.sql"
```

`--complete-insert` names every column, so a column added by a later migration
cannot shift the values. `--skip-extended-insert` makes the file diffable and
lets one bad row be found and fixed instead of failing a 10,000-row statement.

**Step 8 — checksum and encrypt before it leaves the machine.**

```powershell
# [W]
Get-FileHash "$out\uboss-catalog-$stamp.sql" -Algorithm SHA256 |
  Select-Object -ExpandProperty Hash |
  Out-File -Encoding ascii "$out\uboss-catalog-$stamp.sql.sha256"
Get-Content "$out\uboss-catalog-$stamp.sql.sha256"

# gpg ships with Git for Windows
gpg --batch --yes --symmetric --cipher-algo AES256 `
    -o "$out\uboss-catalog-$stamp.sql.gpg" "$out\uboss-catalog-$stamp.sql"
```

**Step 9 — transfer over SSH only.**

```powershell
# [W]
scp -i $env:USERPROFILE\.ssh\uboss_prod `
    "$out\uboss-catalog-$stamp.sql.gpg" `
    "$out\uboss-catalog-$stamp.sql.sha256" `
    <DEPLOY_USER>@<VPS_IP>:/tmp/
```

Never email it, never put it in unencrypted object storage, never paste it into
a chat.

**Step 10 — import into staging.**

```bash
# [S]
cd /tmp
gpg --batch --yes --decrypt -o uboss-catalog.sql uboss-catalog-<stamp>.sql.gpg
echo "$(cat uboss-catalog-<stamp>.sql.sha256 | tr -d '\r')  uboss-catalog.sql" | sha256sum -c -

# Import as the MIGRATE user; the app user has no rights it does not need.
mariadb -u uboss_migrate -p uboss < uboss-catalog.sql

shred -u uboss-catalog.sql uboss-catalog-<stamp>.sql.gpg
```

**Step 11 — verify.** §13.4.

**Step 12 — test against a production-like staging environment.** §20, then the
smoke tests in §21.

**Step 13 — production cutover.**

1. **Back up production immediately before the change**, even if it is empty.
   Use §17's command by hand and keep the file out of the rotation.
2. **If live data already exists**, choose one of these and write the choice down
   in advance:
   - **Write freeze — recommended at this size.** Maintenance page on (§11.11),
     drain the worker, take a final dump, migrate, verify, maintenance off.
     77.6 MB restores in minutes.
   - **Incremental synchronisation.** Only viable for tables with a reliable
     `updatedAt` and no deletes. Complex, and **not justified at this data
     volume**.
3. Run the migration.
4. Smoke tests (§21).
5. Reconcile: row counts, one known order end to end, and a payment
   reconciliation pass per `RUNBOOK.md` §5.
6. **Rollback**: §22. The database half is a restore of the pre-cutover dump,
   and it is only safe while no new production writes have happened — which is
   exactly what the write freeze buys you.

### 13.4 Verification queries — run on both sides and diff

```bash
# [S] / [W] which dump binary exists here? Decide flags from the answer.
command -v mariadb-dump || command -v mysqldump
mariadb-dump --version 2>/dev/null || mysqldump --version
```

```sql
-- Row counts per table
SELECT TABLE_NAME, TABLE_ROWS
FROM information_schema.TABLES
WHERE TABLE_SCHEMA='uboss' AND TABLE_TYPE='BASE TABLE'
ORDER BY TABLE_NAME;

-- Object inventory: must match the verified local figures
SELECT
  (SELECT COUNT(*) FROM information_schema.TABLES
     WHERE TABLE_SCHEMA='uboss' AND TABLE_TYPE='BASE TABLE')  AS tables_,
  (SELECT COUNT(DISTINCT ENGINE) FROM information_schema.TABLES
     WHERE TABLE_SCHEMA='uboss' AND TABLE_TYPE='BASE TABLE')  AS engines,
  (SELECT COUNT(DISTINCT TABLE_COLLATION) FROM information_schema.TABLES
     WHERE TABLE_SCHEMA='uboss' AND TABLE_TYPE='BASE TABLE')  AS collations,
  (SELECT COUNT(*) FROM information_schema.VIEWS
     WHERE TABLE_SCHEMA='uboss')                              AS views_,
  (SELECT COUNT(*) FROM information_schema.TRIGGERS
     WHERE TRIGGER_SCHEMA='uboss')                            AS triggers_,
  (SELECT COUNT(*) FROM information_schema.ROUTINES
     WHERE ROUTINE_SCHEMA='uboss')                            AS routines_,
  (SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA='uboss')                         AS fks,
  (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA='uboss')                         AS checks_;
-- Expect: 171, 1, 1, 0, 0, 0, 241, 216

-- M1: strict mode is on
SELECT @@sql_mode;

-- M2: any identifier that is not already lower-case
SELECT TABLE_NAME FROM information_schema.TABLES
WHERE TABLE_SCHEMA='uboss' AND BINARY TABLE_NAME <> BINARY LOWER(TABLE_NAME);
-- Expect: empty

-- M3: any table or column not on utf8mb4_unicode_ci
SELECT TABLE_NAME, TABLE_COLLATION FROM information_schema.TABLES
WHERE TABLE_SCHEMA='uboss' AND TABLE_COLLATION <> 'utf8mb4_unicode_ci';
SELECT TABLE_NAME, COLUMN_NAME, COLLATION_NAME FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA='uboss' AND COLLATION_NAME IS NOT NULL
  AND COLLATION_NAME <> 'utf8mb4_unicode_ci';
-- Expect: empty, empty

-- Timezone handling
SELECT @@global.time_zone, @@session.time_zone, NOW(), UTC_TIMESTAMP();

-- Money sanity
SELECT COUNT(*) FROM order_items   WHERE unit_price_minor < 0;
SELECT COUNT(*) FROM product_prices WHERE amount_minor    < 0;
-- Expect: 0, 0

-- Multi-currency coverage. A product with no price row in a currency is
-- deliberately excluded from that market; confirm the coverage is intended.
SELECT currency_code, COUNT(*) FROM product_prices GROUP BY currency_code;
```

```bash
# [S] content checksum per table, independent of row order
for t in categories manufacturers products product_variants product_prices; do
  printf '%-22s ' "$t"
  mariadb -u uboss_backup -p --batch --skip-column-names uboss \
    -e "CHECKSUM TABLE $t EXTENDED" | awk '{print $2}'
done
```

Run the same loop on the source. **Differences are expected where an `updatedAt`
column was touched by the import. Identical row counts with differing checksums
must be explained, not waved through.**

**Also verify by hand on staging:** prices per market, tax and VAT on a
representative order, inventory levels, order-number continuity, a scheduled
order's next occurrence date under `Europe/Warsaw`, and seller-scoped
visibility (§19).

---

## 14. Build and release process

### 14.1 Verified build facts

| Fact | Value | Evidence |
|---|---|---|
| Package manager | **npm**, lockfile v3, **five independent projects** (`backend`, three apps, `scripts`). There is **no root `package.json` and no workspace** | `find -name package-lock.json` **[VR]** |
| Node version declared | **`backend` only: `"node": ">=20.11"`. There is no `.nvmrc` and no `.node-version` anywhere** | `package.json`, `find` **[VR]** |
| Node installed by `bootstrap.sh` | **22** (`NODE_MAJOR=22`) | `deploy/scripts/bootstrap.sh:25` **[VR]** |
| Node on the development machine | **24.20.0** | `node -v` **[VR]** |
| Node release status today | **24 is Active LTS** (maintenance from 2026-10-20, EOL 2028-04-30). **22 is in Maintenance LTS**, EOL 2027-04-30 | nodejs/Release `schedule.json` **[VE]** |
| Backend build | `tsc -p tsconfig.build.json` → `dist/`, with `sourceMap: true` | `tsconfig.build.json` **[VR]** |
| Frontend builds | `tsc -b && vite build` → `dist/`, with **`sourcemap: true` in all three** | `apps/*/vite.config.ts` **[VR]** |
| Prisma client | Generated into **`src/generated/prisma/` and committed to git** | `git ls-files src/generated` **[VR]** |
| Native modules | **`argon2`** (backend) and **`sharp`** (scripts) compile or fetch platform binaries | `package.json` **[VR]** |
| Backend typecheck | **Passes.** `npm run typecheck` exited 0 | run 2026-09-16 **[VR]** |
| Test suite | 44 unit + 75 integration files, `fileParallelism: false` — **they run serially and the integration set needs a real MariaDB** | `vitest.config.ts` **[VR]** |

**Pin the Node version.** Three different majors are in play across the
developer machine (24), the server (22) and nothing at all in CI. Add
`.nvmrc` containing `24` and set `"engines": { "node": ">=24 <25" }`, and change
`NODE_MAJOR=24` in `bootstrap.sh`. **Node 24 is the Active LTS today [VE]** and
is already what development runs on. This is a code change and is listed in §26.

### 14.2 Build in CI, not on the server — and why

`release.sh` currently runs `npm ci` and three (soon four) Vite builds **on the
production box** **[VR]**. On a 4 vCPU / 16 GB machine with ~3.5 GB of headroom
(§4.6) that competes directly with the live site for CPU and memory, and a
dependency-registry outage becomes a deployment outage.

**Decision: build once in GitHub Actions, ship a verified artifact, and reduce
`release.sh` to fetch-verify-migrate-swap-restart.** The counter-argument —
`argon2` and `sharp` are native — is handled by building on the same
`ubuntu-24.04` runner image the server runs, and verifying with a post-install
smoke test.

Until CI exists, server-side builds remain the fallback. If you must build on
the server, do it during the maintenance window, not at peak.

### 14.3 The release the server performs

```
/srv/uboss/
├── repo/              git checkout release.sh builds from
├── releases/
│   └── 20260916-141212/
│       ├── backend/{dist,node_modules,prisma,package.json,prisma.config.ts}
│       ├── customer-web/     (dist contents)
│       ├── admin-web/        (dist contents)
│       ├── logistics-web/    (dist contents)
│       ├── docs/
│       ├── REVISION
│       ├── RELEASED_AT
│       └── SHA256SUMS
├── current -> releases/20260916-141212
├── shared/.env        every secret, chmod 600, survives releases
├── shared/maintenance/
├── media/             ONLY if media is ever served locally
└── backups/
```

`shared/` and `media/` sit outside the release directories deliberately: they
are the two things a deploy must not touch and a rollback must not revert.

### 14.4 Required changes to `release.sh`

**All seven are applied.** The table is kept because each row explains why the
change exists, which the diff does not.

| # | Change | Reason |
|---|---|---|
| 1 | **Copy `prisma.config.ts` into `$RELEASE/backend/`** | **B2.** Prisma 7 has no `url` in the datasource block. Reproduced failure: `Error: The datasource.url property is required in your Prisma config file when using prisma migrate status`. Adding the file back makes it resolve `dotenv` and `prisma/config` from the release's own `node_modules` |
| 2 | **Export `VITE_API_BASE_URL` before each frontend build** | **B3.** Verified: a shell variable overrides the committed `.env`; without it a fresh clone bakes `http://localhost:4000/api/v1` |
| 3 | **Build `apps/logistics-web` and copy its `dist` to `$RELEASE/logistics-web/`** | **B5.** The portal exists in the repository and is never built |
| 4 | **Take a deployment lock** — applied, in `rollback.sh` too | Two concurrent releases would interleave a symlink swap with a migration, leaving the code being served and the schema underneath it on different commits. A rollback during a release is the same hazard, sharper: it repoints `current` at old code that the release overwrites a second later |
| 5 | **`sudo -n systemctl`, with a sudoers rule from `bootstrap.sh`** — applied | `release.sh` runs as `uboss` and called bare `systemctl restart`, with **no sudoers or polkit rule anywhere in `deploy/`** **[VR]**. `sudo -n` never prompts: there is no terminal to answer, so a missing rule fails at once with the filename instead of hanging until the deploy times out |
| 6 | **Write `SHA256SUMS` for the release** — applied | Artifact integrity, §15. Written before the symlink moves, so it describes the release as assembled rather than as it stands after somebody edited a file in `current/` during an incident. `node_modules` excluded: 40,000 files, and `npm ci` already guarantees them from the lockfile, which is itself in the manifest |
| 7 | **Strip or withhold source maps** — applied | §14.5 |

The concrete shapes:

```bash
# 1 — in the "assemble" step, beside the package.json copy
cp "$REPO/backend/prisma.config.ts" "$RELEASE/backend/prisma.config.ts"
```

```bash
# 2 — before each frontend build. Read from shared/.env, so it is not in git.
set -a; . "$SHARED/.env"; set +a
export VITE_API_BASE_URL="${CUSTOMER_WEB_PUBLIC_URL%/}/api/v1"
cd "$REPO/apps/customer-web" && npm ci && npm run build
export VITE_API_BASE_URL="${ADMIN_WEB_PUBLIC_URL%/}/api/v1"
cd "$REPO/apps/admin-web" && npm ci && npm run build
export VITE_API_BASE_URL="${LOGISTICS_WEB_PUBLIC_URL%/}/api/v1"
cd "$REPO/apps/logistics-web" && npm ci && npm run build
```

```bash
# 3 — assemble
mkdir -p "$RELEASE/logistics-web"
cp -r "$REPO/apps/logistics-web/dist/." "$RELEASE/logistics-web/"
```

```bash
# 4 — deployment lock, immediately after `set -Eeuo pipefail`
exec 9>"$ROOT/shared/.release.lock"
flock -n 9 || die "another release is already running"
```

```bash
# 5 — sudoers, installed by bootstrap.sh as root
cat >/etc/sudoers.d/uboss-release <<'EOF'
uboss ALL=(root) NOPASSWD: /usr/bin/systemctl restart uboss-api@4000, \
  /usr/bin/systemctl restart uboss-api@4001, \
  /usr/bin/systemctl restart uboss-api@4002, \
  /usr/bin/systemctl restart uboss-worker, \
  /usr/bin/systemctl reload nginx
EOF
chmod 440 /etc/sudoers.d/uboss-release
visudo -c        # MUST pass before you log out
```

An explicit list, not `systemctl *`: a wildcard would let the service user
restart or mask anything on the machine.

```bash
# 6 — after assembling, before the symlink swap
( cd "$RELEASE" && find . -type f ! -path './backend/node_modules/*' \
    -exec sha256sum {} + > SHA256SUMS )
```

### 14.5 Source-map policy

All three frontends and the backend build with source maps on **[VR]**. Published
frontend source maps put the complete TypeScript source of the storefront, the
**admin console** and the **logistics portal** on the public internet. That is
not a credential leak — no secret reaches a bundle **[VR]** — but it hands an
attacker a readable map of every route, permission name and validation rule.

**Policy:**

| Artifact | Policy |
|---|---|
| Frontend `.map` files | **Generate, upload to the error tracker, then delete before the release directory is assembled** |
| Frontend bundles | Keep the `//# sourceMappingURL=` comment only if the maps are uploaded to a tracker that can resolve them privately; otherwise strip it |
| Backend `dist/*.map` | **Keep.** They never leave the server and they make a stack trace in `journalctl` readable |

**Applied.** `build_frontend` in `release.sh` runs `find dist -name '*.map' -delete` after every build, so no map reaches a release directory. Uploading them to an error tracker first is still an open step (§26, B15).

### 14.6 Release ownership, retention and verification

| Item | Value |
|---|---|
| Owner of release directories | `uboss:uboss`, mode `755`; `shared/` is `700` |
| Releases retained | **5** — enough to roll back past a bad one and the one before it. Each carries its own `node_modules`, so thirty would fill the disk **[VR]** |
| Cleanup | `ls -1dt */ \| tail -n +6 \| xargs -r rm -rf` **[VR]** |
| Health verification | Each instance must answer `/health/ready` within 60 s before the next is restarted **[VR]** |
| Failure behaviour | If anything fails before the symlink moves, **the running site has not been touched** **[VR]** |

```bash
# [S] confirm what is actually deployed
cat /srv/uboss/current/REVISION
cat /srv/uboss/current/RELEASED_AT
ls -l /srv/uboss/current
```

---

## 15. CI/CD and automatic deployments

**Provider: GitHub** (`https://github.com/UBoss-AI/UBoss-Sourcing.git`) **[VR]**.

**The workflows now exist.** `.github/workflows/ci.yml`, `codeql.yml` and
`dependabot.yml` run; `.github/workflows/deploy.yml` is written but
**deliberately manual-only and inert** — it has no `push` trigger and fails on
its first step until an owner configures the environments, the deploy key and
the API base URLs. Deploying automatically to production is a decision about who
approves a release and what happens when they are asleep, not a default.

§15.1 (branch protection) and §15.4 (how CI reaches the server) are settings in
the GitHub and server consoles rather than files in this repository, and remain
**[OD]**. What follows describes both what runs and what still has to be
switched on.

Three things in `ci.yml` differ from the design below, each for a verified
reason:

- **Two databases, not one.** `tests/setup.ts` refuses to run when
  `TEST_DATABASE_URL` equals `DATABASE_URL`, because the integration suite
  truncates every table it touches **[VR]**. The design's single
  `CI_DATABASE_URL` for both would never have run a test.
- **`migrate deploy` against both**, then `migrate status`. A migration applied
  to only one of them produces a long list of sign-in 500s and no explanation.
- **gitleaks from its published container**, not the marketplace action, which
  requires a paid licence key for organisation-owned repositories.

### 15.1 Branch protection

**`main` is unprotected today.** GitHub says so on the repository page, and it
is correct: anyone with write access can push straight to the branch that
`release.sh` deploys from, and can force-push over it.

This cannot be fixed by a file in the repository — it is a setting, at
**Settings → Rules → Rulesets → New branch ruleset** (or the older
Settings → Branches). Target `main` and apply:

| Rule | Setting | Why |
|---|---|---|
| Restrict deletions | On | `main` is what the server builds from |
| Block force pushes | On | A force-push rewrites the history that `SHA256SUMS` and `REVISION` are supposed to make answerable |
| Require a pull request | On | Nothing reaches `main` without a diff somebody could have read |
| Required approvals | **See the warning below before choosing a number** | |
| Dismiss stale approvals on new commits | On | An approval of an earlier diff is not an approval of this one |
| Require status checks to pass | On, and **require the branch to be up to date** | The checks are §15.2. Add them by name once they have each run once — GitHub only offers checks it has seen |
| Require conversation resolution | On | |
| Require linear history | On | Makes "which commit is live" answerable |
| Require signed commits | **[OD]** recommended | |
| Include administrators | **On** — the rule is worth nothing if the person most likely to be in a hurry is exempt | |

**The trap that stops a small team dead: a pull request needs an approver who is
not its author.** With "required approvals: 1" on a repository with one active
developer, every pull request is permanently unmergeable — you cannot approve
your own. If that is the situation today, set **required approvals to 0** and
keep everything else. You still get: no force-pushes, no deletions, a diff for
every change, and **CI green before merge**, which is the part that was actually
missing. Raise it to 1 the day a second person can review.

**And know what it costs before you turn it on:** direct `git push origin main`
stops working, for everybody, including whoever set it up. Every change becomes
a branch and a pull request. That is the point of it — but it should be a
decision rather than a surprise on the next hotfix.

`.github/pull_request_template.md` carries the checklist that `CLAUDE.md` asks
for, so the documentation rule travels with the diff rather than living only in
a file nobody opens mid-change.

| Environments | `staging` (auto), `production` (**required reviewers**) — separate from branch rules, at Settings → Environments |
|---|---|

### 15.2 Required gates

| Gate | Command | Blocking | Note |
|---|---|---|---|
| Locked install | `npm ci` in each of the four projects | ✅ | Fails if `package.json` and the lock disagree |
| **Install scripts actually ran** | `node -e "require('argon2')"` and `npx prisma --version` | ✅ | **See the note below. This is not a formality.** |
| Lint | `npm run lint` (`--max-warnings=0`) | ✅ | ESLint forbids the void-arrow shorthand; `lint:fix` will not add the braces |
| Typecheck | `npm run typecheck` / `tsc -b` | ✅ | Backend verified passing **[VR]** |
| Unit tests | `npm test` | ✅ | |
| Integration tests | `npm test` | ✅ | **Needs a MariaDB service container and its own migrated database — two databases, because the suite refuses to run when `TEST_DATABASE_URL` equals `DATABASE_URL`.** 120 files, 2319 tests, and they run against **10.11 with strict `sql_mode`**, which is where the `correlationId` defect above surfaced |
| Contrast audit | `npm run audit:contrast` in each app | ✅ | Accessibility evidence (§7, §19) |
| Build | `npm run build` in all four | ✅ | |
| **Migration validation** | `prisma migrate status` against a scratch database, then `prisma migrate deploy` | ✅ | Catches a migration that does not apply cleanly |
| **Migration safety review** | grep the diff for `DROP`, `RENAME`, `MODIFY`, `NOT NULL` without a default | ✅ warn | §15.5 |
| Secret scanning | `gitleaks detect` over the **full history**, version pinned, exceptions in `.gitleaks.toml` | ✅ | A secret committed and then deleted is still in the history and still valid until it is rotated. The four exceptions are test fixtures shaped like live keys, each allowlisted by its exact text — never by path, because a fixture directory is where somebody eventually pastes a real one |
| Dependency audit | `npm audit --audit-level=high` | ✅ high/critical | Green in all four projects. Where an advisory's fix is pinned away by a parent package, `overrides` in `backend/package.json` forces the patched version rather than an exception being written down — and the suite is what proves the forced version works |
| SAST | CodeQL (`javascript-typescript`, `security-extended`) | **skipped until enabled** | `.github/workflows/codeql.yml` runs only when the repository variable `ENABLE_CODEQL` is `true`. On a private repository without Advanced Security the `init` step fails on licensing, and a permanent red mark nobody can fix with code is how people stop reading CI results. A skipped job says "not run", which is the truth |
| SBOM | `npm sbom --sbom-format cyclonedx` per project, uploaded as an artifact | ✅ | **Also a Cyber Resilience Act input (§7)** |
| Licence review | `license-checker` against an allowlist | warn | **[OD]** — matters because UBOSS is *sold* |
| Artifact checksum | `sha256sum` manifest | ✅ | |

**The suite must not depend on your `.env`, and CI is what proves it.**

The backend job failed on its first four runs for three separate instances of
one mistake: a test whose result depended on a file that is not in git.

| What | On a machine whose `.env`… | In CI, which copies `.env.example` |
|---|---|---|
| `PIECES_PER_CARTON` | omits it → `??=` in `tests/setup.ts` gives 1 | sets **500**, and every quantity assertion is out by 500× |
| AI provider key | has a real Gemini key → `/assistant/*` routes exist | has none → **every one of them 404s**, and 147 tests fail |
| Gateway credentials | has test keys → webhooks sign and compare | are empty → payloads sign with `''`, and `not.toContain('')` fails for every string |

None of these was a bad test. Each was a test that quietly borrowed a
precondition from whoever wrote it. The fix in all three is the same: the suite
states what it needs — `tests/setup.ts` pins the carton size and fake gateway
credentials outright, and `assistant-conversations.test.ts` mocks
`isAssistantConfigured` the way `catalog-image-search.test.ts` already did.

**This is the value of the CI job, not a cost of it.** A suite that passes on
the author's machine and fails on a clean one is not a gate, and until there was
a clean machine running it nobody could have known which of the two it was.

**npm 11 does not run a dependency's install script unless you say so, and this
project has two that matter.**

Node 24 ships npm 11, which blocks a dependency's `preinstall`/`install`/
`postinstall` unless the package is listed in `allowScripts` in `package.json`.
It does not fail when it blocks one. It prints a warning among a hundred other
lines and **exits 0**.

Two of the backend's dependencies are useless without theirs:

| Package | Script | Without it |
|---|---|---|
| `argon2` | `node-gyp rebuild` | No native binding. Every password hash and every sign-in throws |
| `@prisma/engines` | `postinstall` | The query engine is never downloaded. Prisma cannot open a connection |

This is why the backend job failed on **every one of the first three CI runs**
while the three frontend jobs passed: the frontends' only blocked script is
esbuild's, and modern esbuild ships its binary as a per-platform optional
dependency, so it does not need one.

**The same thing would have happened on the server.** `release.sh` runs
`npm ci`, and `bootstrap.sh` installs Node 24. A release would have installed
cleanly, built cleanly, swapped the symlink and produced an API that could not
answer a single request. Both `release.sh` and the CI job now check the two
artifacts directly and stop rather than continue.

The approvals in `backend/package.json` name an **exact version** — npm's own
behaviour, and the right one: a new version of a package that runs code at
install time is reviewed rather than inherited. The consequence to expect is
that **a Dependabot bump of `argon2`, `prisma`, `@prisma/engines` or `esbuild`
will fail CI at that check** until somebody runs `npm install-scripts approve`
on the new version. That is the system working; do not turn it off.

### 15.3 Workflow shape

The shape below is the original design. **Read `.github/workflows/ci.yml` for
what actually runs** — it is the same shape with the three corrections above.

```yaml
# .github/workflows/ci.yml  — the ORIGINAL DESIGN. See the file for what runs.
name: CI
on:
  pull_request:
  push: { branches: [main] }

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify-backend:
    runs-on: ubuntu-24.04
    services:
      mariadb:
        image: mariadb:10.11
        env:
          MARIADB_ROOT_PASSWORD: ${{ secrets.CI_DB_ROOT_PASSWORD }}
          MARIADB_DATABASE: uboss_test
        options: >-
          --health-cmd="healthcheck.sh --connect --innodb_initialized"
          --health-interval=5s --health-timeout=5s --health-retries=20
        ports: ['3306:3306']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24', cache: npm, cache-dependency-path: backend/package-lock.json }
      # Match production: XAMPP is NOT strict, Ubuntu MariaDB is. See §13.
      - run: |
          mysql -h127.0.0.1 -uroot -p"${{ secrets.CI_DB_ROOT_PASSWORD }}" \
            -e "SELECT @@sql_mode;"
      - run: npm ci
        working-directory: backend
      - run: npx prisma generate
        working-directory: backend
      - run: npx prisma migrate deploy
        working-directory: backend
        env:
          DATABASE_URL: ${{ secrets.CI_DATABASE_URL }}
      - run: npm run verify           # typecheck + lint + tests
        working-directory: backend
        env:
          DATABASE_URL: ${{ secrets.CI_DATABASE_URL }}
          TEST_DATABASE_URL: ${{ secrets.CI_DATABASE_URL }}

  verify-frontends:
    runs-on: ubuntu-24.04
    strategy:
      matrix: { app: [customer-web, admin-web, logistics-web] }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24', cache: npm, cache-dependency-path: apps/${{ matrix.app }}/package-lock.json }
      - run: npm ci
        working-directory: apps/${{ matrix.app }}
      - run: npm run verify
        working-directory: apps/${{ matrix.app }}

  security:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@v2
      - uses: github/codeql-action/init@v3
        with: { languages: javascript-typescript }
      - uses: github/codeql-action/analyze@v3
```

```yaml
# .github/workflows/deploy.yml — the ORIGINAL DESIGN. The file that exists is
# workflow_dispatch-only and pins the host key rather than accepting a new one.
name: Deploy
on:
  workflow_run: { workflows: [CI], types: [completed], branches: [main] }

concurrency:
  group: deploy-production      # only one deployment at a time, ever
  cancel-in-progress: false     # never cancel a half-finished deploy

jobs:
  build:
    if: github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      # Build every frontend with the PRODUCTION API base URL. This is B3.
      - run: |
          cd apps/customer-web  && npm ci && VITE_API_BASE_URL="${{ vars.CUSTOMER_API_BASE }}" npm run build
          cd ../admin-web       && npm ci && VITE_API_BASE_URL="${{ vars.ADMIN_API_BASE }}"    npm run build
          cd ../logistics-web   && npm ci && VITE_API_BASE_URL="${{ vars.LOGISTICS_API_BASE }}" npm run build
      - run: cd backend && npm ci --omit=dev && npx prisma generate && npm run build
      - run: find apps/*/dist -name '*.map' -delete
      - run: |
          tar -czf uboss-${{ github.sha }}.tgz \
            backend/dist backend/prisma backend/prisma.config.ts \
            backend/package.json backend/package-lock.json \
            apps/customer-web/dist apps/admin-web/dist apps/logistics-web/dist
          sha256sum uboss-${{ github.sha }}.tgz > uboss-${{ github.sha }}.tgz.sha256
      - uses: actions/upload-artifact@v4
        with: { name: release, path: 'uboss-*.tgz*' }

  deploy-staging:
    needs: build
    environment: staging
    runs-on: ubuntu-24.04
    steps: [ { run: 'scp + verify checksum + activate + smoke tests' } ]

  deploy-production:
    needs: deploy-staging
    environment: production      # required reviewers = the manual gate
    runs-on: ubuntu-24.04
    steps: [ { run: 'scp + verify checksum + activate + migrate + rolling restart + smoke tests' } ]
```

### 15.4 How CI reaches the server

| Control | Requirement |
|---|---|
| Account | A dedicated `deploy` Linux user, **not** root and **not** the `uboss` service user |
| Key | An ed25519 key used only by GitHub Actions, stored as an Environment secret |
| `authorized_keys` restriction | `command="/srv/uboss/bin/deploy-activate",no-agent-forwarding,no-port-forwarding,no-pty,no-X11-forwarding ssh-ed25519 AAAA...` — CI can run **one** program, not an arbitrary shell |
| `.env` | **Never sent by CI and never printed.** It lives only in `/srv/uboss/shared/.env` |
| Logs | No `set -x` in the deploy script; no `echo` of any variable read from `.env` |
| Rotation | Rotate the deploy key on any team change |

### 15.5 Migration and rollout safety

**The rule that cannot be automated**, and the reason it is written in three
places in this repository: migrations run **before** the new code starts, so for
the length of the rolling restart **the old code runs against the new schema**
**[VR]**.

| Change | Safe in one release? |
|---|---|
| New table | **Yes** |
| New **nullable** column | **Yes** |
| New index | **Yes** — watch the lock on a large table |
| New `CHECK` constraint | **Only if every existing row already satisfies it.** Note `chk_schedule_frequency_field_present` names each `ScheduleFrequency` member: a new member that is not listed matches no branch and **every insert fails** |
| New **`NOT NULL`** column | **No.** Expand: add nullable → backfill → make `NOT NULL` in a later release |
| Rename a column or table | **No.** Add new → write both → migrate reads → drop old, over three releases |
| Drop a column or table | **No.** Only after a release in which nothing reads it |
| Narrowing a type | **No.** Same expand-and-contract |

**Worker ordering.** Workers are upgraded **after** the API. An old worker that
meets a job type it does not know **returns it to the queue with a 30-second
delay rather than destroying it** **[VR]** — so a rolling worker upgrade is safe
by construction. Roll all workers onto the same build promptly: two on different
builds disagree about which job types exist.

**Rollback means code rollback.** Migrations are **forward-only**. Reversing one
discards rows written since. The only backward path is the tested disaster
restore in §17, and it is an incident, not a deploy step.

**Payments, ERP and scheduled jobs are not duplicated by a restart**, and this is
verified rather than assumed:

- Order writes are guarded by `IdempotencyRecord` with a `UNIQUE(scope, key)`
  and a SHA-256 of the canonical body, so a replay with a *different* body is
  rejected rather than silently answered from cache **[VR]**.
- Webhook deliveries are recorded and de-duplicated by provider event id
  **[VR]**.
- Job claiming is a conditional `UPDATE` with an affected-rows check; an
  interrupted job's lease expires and is reaped **[VR]**.
- Periodic jobs carry a time-slot `dedupeKey` against a `UNIQUE` index **[VR]**.
- The worker gets 120 s to finish an in-flight card charge before `SIGKILL`
  **[VR]**.

**A UI-only release must not restart MariaDB.** Nothing in `release.sh` does
**[VR]** — keep it that way. A frontend-only change ideally skips the API
restart entirely; the simplest safe version is to compare `backend/dist`
checksums between the outgoing and incoming release and skip the rolling restart
when they match.

---

## 16. Zero / low-downtime deployment

### 16.1 What the application already supports

| Capability | Status | Evidence |
|---|---|---|
| Separate liveness and readiness | **Yes.** `/health/live` never touches a dependency, so a database outage does not get the process restarted — restarting fixes nothing. `/health/ready` checks the database and the queue and returns **503** so a balancer drains the instance | `routes/health.ts` **[VR]** |
| Startup dependency check | **Yes.** `assertCurrencyTableMatchesMoneyModule()` runs **before** `listen()` — the currency table and `domain/money.ts` state the same exponents independently, and a disagreement mis-scales every amount in that currency by a factor of ten | `http/server.ts` **[VR]** |
| Multiple API processes behind nginx | **Yes.** `upstream uboss_api` with `least_conn`, `max_fails=3`, `fail_timeout=10s`, `keepalive 64` | `deploy/nginx/uboss.conf` **[VR]** |
| Graceful shutdown | **Yes.** `SIGTERM` → stop accepting → finish in flight → `queue.shutdown()` → `$disconnect()`, 15 s ceiling, `TimeoutStopSec=30` | `http/server.ts`, unit **[VR]** |
| Worker drain | **Yes.** `SIGTERM` stops the maintenance timer and the claim loop; in-flight jobs finish. `TimeoutStopSec=120` | `worker/index.ts`, unit **[VR]** |
| Queue survives a restart | **Yes.** Jobs are rows. An expired lease is reaped and the job re-claimed | `database-queue.ts` **[VR]** |
| Scheduler singleton | **Not needed.** Time-slot `dedupeKey` + `UNIQUE` index makes N workers produce one job per slot | **[VR]** |
| Rolling restart, health-gated | **Yes**, one instance at a time, each proved ready before the next | `release.sh` step 6 **[VR]** |

**This application can do a low-downtime rolling release today.** That is
unusual and worth saying plainly.

### 16.2 What it cannot yet do, and what would be required

| Gap | Consequence | What it would take |
|---|---|---|
| **nginx does not retry the next upstream on a refused connection by default** | A request in flight to the instance being restarted can return 502 | Add `proxy_next_upstream error timeout http_502 http_503; proxy_next_upstream_tries 2;` to `uboss-proxy.conf`. **Only safe with `proxy_next_upstream_timeout` set and idempotent retries** — do not retry non-idempotent POSTs |
| **No connection draining before `SIGTERM`** | The instance stops accepting while nginx may still be routing to it | Mark the instance unready first: add a pre-stop step that makes `/health/ready` return 503, wait `fail_timeout`, then stop. Requires a small code change (a shutdown flag read by the readiness probe) |
| **Migrations run before the new code** | Old code sees the new schema | The expand-and-contract discipline in §15.5. **Cannot be automated** |
| **`release.sh` restarts the worker unconditionally** | A UI-only release bounces in-flight jobs | Skip the worker restart when `backend/dist` is unchanged |
| **No canary** | A bad release reaches 100 % of traffic in one step | Restart one instance, hold, watch `/metrics` error rate for 5 minutes, then continue |

**Honest summary: this is low-downtime, not zero-downtime.** Claiming zero
downtime requires the readiness-flag drain above. Until then, expect a small
number of 502s during the restart window unless `proxy_next_upstream` is added.

### 16.3 Webhook behaviour during a deploy

Deliveries keep arriving throughout. Three things protect them:

1. The webhook location is **never rate limited** — deliberate. A provider
   refused with a 429 retries for a while and then gives up, leaving a customer
   charged for an order that never confirms. The signature is the control, and
   it is a better one than an IP bucket **[VR]**.
2. `proxy_read_timeout 60s` on that location, above the API's own window
   **[VR]**.
3. Providers retry. **Stripe rejects a delivery signed more than five minutes
   ago**, so a long queue becomes signature failures — keep the restart window
   short and the clock on NTP **[VR]**.

**Never put the webhook path behind the maintenance page (§11.11).**

### 16.4 Abort conditions during a rollout

Stop and roll back (§22) if any of these appear while restarting:

- An instance does not answer `/health/ready` within 60 s → `release.sh` already
  aborts, leaving `current` on the previous release **[VR]**.
- 5xx rate on `/metrics` rises above the pre-deploy baseline + 1 % over 2 min.
- Any 5xx on `/api/v1/orders`, `/api/v1/payments` or the webhook path.
- `job_queue` oldest pending age climbing past 5 minutes.
- MariaDB connections climbing toward 200, or a new deadlock in the error log.

---

## 17. Backups and disaster recovery

> **`backend/docs/RUNBOOK.md` §2 and §3 remain the authority on backup policy
> and the restore procedure.** This section covers what the deployment adds on
> top of it, and the three defects that must be fixed before go-live.

### 17.1 Hostinger's weekly backup is supplementary, not a strategy

Hostinger includes **free weekly backups** and manual snapshots **[VE]**. For an
ordering and payment system, a weekly recovery point means **losing up to seven
days of orders, payments, stock movements and invoices**. It is a floor, not a
plan. Snapshots are useful for one thing in particular: take one immediately
before any risky change (§10, §13, §21).

### 17.2 What is verified about the current automation

| Fact | Status | Evidence |
|---|---|---|
| Nightly timer | `uboss-backup.timer`, `OnCalendar=*-*-* 02:30:00`, `RandomizedDelaySec=600`, **`Persistent=true`** — a machine rebooting at 02:30 runs the backup late rather than skipping it silently | **[VR]** |
| Database dump | `mysqldump --single-transaction` | **[VR]** |
| Media archive | `tar -czf media-$STAMP.tar.gz` — the database dump does **not** contain it | **[VR]** |
| `.env` backup | `gpg --symmetric --cipher-algo AES256`, only when `UBOSS_BACKUP_PASSPHRASE` is set | **[VR]** |
| Integrity checks | Readable gzip, above a minimum size, ends with mysqldump's completion marker — catches a truncated dump and a dump of an empty database | **[VR]** |
| Retention | `find -mtime +$KEEP_DAYS -delete` per file class | **[VR]** |
| **Binary logging** | **On.** `log_bin`, `binlog_format = ROW`, `expire_logs_days = 7`, `max_binlog_size = 256M` | `deploy/mariadb/uboss.cnf` **[VR]** |
| Durability | `innodb_flush_log_at_trx_commit = 1` and `sync_binlog = 1` — a committed transaction is on disk | **[VR]** |
| **Off-site copy** | **`rclone copy` then `rclone check`, and a run that cannot verify the copy exits non-zero** | `backup.sh` **[VR]** |
| **Dump encryption** | **AES-256 on the dump, the media archive and `.env`**, passphrase on fd 3 so it is never in `ps`, SHA-256 written beside each file, plaintext `shred`ded | `backup.sh` **[VR]** |
| **Binlog archiving** | **Every 15 minutes, encrypted and verified off-site.** Fetched over the MySQL protocol as a replica would, so the job needs neither root nor access to `/var/log/mysql` | `ship-binlogs.sh`, `uboss-binlog.timer` **[VR]** |
| **Backup-age alerting** | The newest dump's age, the newest shipped binlog's age, and the units' own failure state | `monitor.sh` **[VR]** |

### 17.3 The three fixes — all applied

**Fix 1 — off-site, and verify it arrived. APPLIED.**

```bash
# [S] in backup.sh, replacing the commented lines
rclone copy "$DEST" "$UBOSS_OFFSITE_REMOTE" --max-age 25h --checksum
# Prove it is actually there. A silent rclone failure is the whole risk.
rclone check "$DEST" "$UBOSS_OFFSITE_REMOTE" --one-way --max-age 25h \
  || { log "OFF-SITE VERIFY FAILED"; exit 1; }
```

The destination must be **a different provider from Hostinger**, or at minimum a
different account and region. A backup in the same account that a compromised
password can delete is not an off-site backup. **[OD]** which provider (§26).

**Fix 2 — encrypt the database dump, not just `.env`. APPLIED.**

```bash
# [S] in backup.sh, immediately after the dump and its integrity checks
gpg --batch --yes --symmetric --cipher-algo AES256 \
    --passphrase-file /srv/uboss/shared/.backup-passphrase \
    -o "$DEST/db-$STAMP.sql.gz.gpg" "$DEST/db-$STAMP.sql.gz"
shred -u "$DEST/db-$STAMP.sql.gz"
sha256sum "$DEST/db-$STAMP.sql.gz.gpg" > "$DEST/db-$STAMP.sql.gz.gpg.sha256"
```

The dump holds every customer, address, order and invoice in the system. It is
the single most sensitive file the machine produces, and it is currently the
only one left in the clear. **The passphrase must be stored somewhere that
survives losing the VPS** — a password manager, not `/srv/uboss/shared/`.

**Fix 3 — point-in-time recovery. APPLIED.**

Binary logging was already on **[VR]**, so PITR was available — but only if the
binlogs leave the box, and they did not.

`deploy/scripts/ship-binlogs.sh`, driven by `uboss-binlog.timer` every fifteen
minutes:

```bash
# [S] every 15 minutes, as the uboss user
#  1. FLUSH BINARY LOGS            close the current log; only a closed log is
#                                  safe to ship - half a transaction replays
#                                  cleanly and then silently stops
#  2. SHOW BINARY LOGS             every log the server still has, with sizes
#  3. mariadb-binlog --read-from-remote-server --raw
#                                  fetch each completed log it does not already
#                                  hold, then compare the local size with the
#                                  size the server reported
#  4. gpg --symmetric              encrypt; these are every INSERT and UPDATE
#                                  the system has made
#  5. rclone copy && rclone check  off-site, and proved to have arrived
```

**Over the MySQL protocol, not off the filesystem**, and that is a security
decision rather than a convenience. `/var/log/mysql` is readable only by
`mysql`, so copying the files would mean a root timer executing a script out of
a directory the `uboss` service user can write to — which hands anything that
compromises the application a clean path to root. Fetching them as a replica
would needs no root and no filesystem access at all, and produces the same
bytes.

It needs a user of its own, in `/etc/uboss/backup.env` as `UBOSS_BINLOG_URL`:

```sql
CREATE USER 'uboss_binlog'@'localhost' IDENTIFIED BY '<long random>';
GRANT REPLICATION SLAVE, REPLICATION CLIENT, RELOAD ON *.* TO 'uboss_binlog'@'localhost';
```

No `SELECT` on any table: it reads the log of changes, never the data.

**This is what turns an RPO of 24 hours into an RPO of about 15 minutes. For a
system that takes card payments, that difference is the difference between a
recoverable incident and a reconciliation nightmare.** The timer's interval *is*
the recovery point objective — changing one changes the other.

`monitor.sh` reports the age of the newest shipped log, so the timer failing is
not itself silent. It only reports it once shipping has been set up at all: an
installation that has knowingly accepted a 24-hour recovery point should not be
nagged about it every five minutes.

### 17.4 Target backup design

| Layer | Frequency | Retention | Encrypted | Off-site | Verified by |
|---|---|---|---|---|---|
| Database full dump | Nightly 02:30 UTC | 7 daily, 4 weekly, 12 monthly **[OD]** | **Yes (Fix 2)** | **Yes (Fix 1)** | gzip + size + completion marker, then a monthly automated restore |
| Binary logs | Every 15 min | 7 days | Yes | Yes | Replay tested in the quarterly drill |
| Media / object storage | Provider versioning + daily sync | 30 days of versions **[OD]** | Provider-side | Yes, second region | Object count and total bytes |
| `/srv/uboss/shared/.env` | On change + nightly | 30 days | **Yes (already)** | Yes | Decryptable in the drill |
| nginx, systemd, MariaDB config | On change | Keep in git | n/a | Git remote | `nginx -t` on restore |
| Hostinger snapshot | Before every risky change | Latest 1–2 | Provider-side | Provider | Boot test **[OD]** |
| Hostinger weekly backup | Weekly | Provider default | Provider-side | Provider | **Supplementary only** |

**Encryption keys are stored separately from the backups.** A passphrase kept
beside the ciphertext protects nothing.

### 17.5 Automated restore testing

```bash
# [S] monthly, as a timer. The one check that proves a backup is a backup.
set -Eeuo pipefail
LATEST=$(ls -1t /srv/uboss/backups/db-*.sql.gz.gpg | head -1)
gpg --batch --yes --decrypt --passphrase-file /root/.backup-passphrase \
    -o /tmp/restore.sql.gz "$LATEST"
mariadb -e "DROP DATABASE IF EXISTS uboss_restore_test;
            CREATE DATABASE uboss_restore_test
              CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
gunzip -c /tmp/restore.sql.gz | mariadb uboss_restore_test

TABLES=$(mariadb -N -B -e "SELECT COUNT(*) FROM information_schema.TABLES
                           WHERE TABLE_SCHEMA='uboss_restore_test';")
ORDERS=$(mariadb -N -B -e "SELECT COUNT(*) FROM uboss_restore_test.orders;")
[ "$TABLES" -eq 171 ] || { echo "RESTORE TEST FAILED: $TABLES tables"; exit 1; }
echo "restore ok: $TABLES tables, $ORDERS orders, from $LATEST"

mariadb -e "DROP DATABASE uboss_restore_test;"
shred -u /tmp/restore.sql.gz
```

Write the result to a file the monitoring in §18 reads, so a **failed or absent
restore test raises an alert**. An untested backup that silently stopped working
three months ago is the classic way to discover there is no backup.

**Quarterly disaster-recovery drill** — a person, not a script, because it needs
`CREATE DATABASE` rights the backup user is deliberately not given, and because
the point is to find out whether the *procedure* works, not whether the file
does. Record: who ran it, how long it took, what went wrong, and whether the
measured recovery time meets the RTO in §6.

### 17.6 Runbooks

| Scenario | First action | Then | Notes |
|---|---|---|---|
| **Accidental data deletion** | Do not restore the whole database. Identify the rows and the time | Restore the latest dump into `uboss_restore_test`, extract the rows, re-insert into production. With binlogs, replay to just before the statement | A full restore loses everything written since |
| **Corrupted migration** | Stop the API instances. **Do not run a down-migration** | Fix forward with a new migration if possible. If not, restore + replay binlogs to just before the migration, then reconcile payments per `RUNBOOK.md` §5 | §22 |
| **VPS loss** | Provision a new VPS in the same region | `bootstrap.sh`, restore `.env` from the encrypted copy, restore the newest dump, replay binlogs, `release.sh`, re-point DNS | **Measure this in the drill. It is the RTO** |
| **Database corruption** | `systemctl stop uboss-api@* uboss-worker` | `mariadb-check --all-databases`. If `innodb_force_recovery` is needed, dump and rebuild — do not run on it | |
| **Compromised credentials** | Rotate the affected secret, restart, invalidate all sessions | Review `audit_logs` for the period. **Assess Art. 33 notification (§7)** | Rotating signing secrets signs everyone out — that is the point |
| **Ransomware** | Isolate: Hostinger firewall to deny all inbound | Rebuild from a **clean** snapshot or from off-site backups. **Do not restore onto the compromised host** | This is why Fix 1's destination must be a different account |
| **Object / media loss** | Check provider versioning first | Restore from the media archive. Product images are not in the database and not in git | |
| **Failed payment reconciliation** | `RUNBOOK.md` §5 | Compare provider dashboard against `payment_transactions`. Never mark an order paid by hand without a signature-verified event | An order reaches CONFIRMED only via a verified webhook **[VR]** |
| **ERP backlog** | `journalctl -u uboss-worker`; check `integration_events` | Each row carries its own `nextRetryAt`. Raise `ERP_MAX_ATTEMPTS` only after the cause is known | Every row is an order somebody paid for that the warehouse cannot see |
| **DNS or certificate failure** | `certbot renew --dry-run`; check registrar and CAA | Re-issue; if DNS is down, the registrar is the incident | §18 alerts on TLS expiry |

---

## 18. Monitoring, logging and alerts

### 18.1 What exists today

| Capability | Status |
|---|---|
| Prometheus metrics | **`/metrics`**, restricted to loopback by nginx. Route-labelled (`/orders/:id`, never the URL — a label carrying an order id would create a time series per order and take the metrics store down) **[VR]** |
| Structured logs | pino JSON to journald, with a **correlation id on every request and response** (`x-correlation-id`, echoed and accepted from the client up to 64 chars) **[VR]** |
| Slow query visibility | Application-side warn at **200 ms** (without parameters — they contain personal data and money), plus MariaDB `slow_query_log` at `long_query_time = 1` **[VR]** |
| Health endpoints | `/health/live`, `/health/ready` **[VR]** |
| Queue health | `queue.health()` surfaced through `/health/ready` **[VR]** |
| **On-box self-checks** | **`deploy/scripts/monitor.sh` + `uboss-monitor.timer`, every 5 minutes.** Each instance's `/health/ready`; the worker unit; queue depth; **the age of the oldest due job**; DEAD jobs in the last 24 h; backup age; binlog-shipping age; disk **and inodes**; certificate expiry; pending reboot. Exits non-zero, so the unit shows in `systemctl --failed` |
| **Alert delivery** | **`UBOSS_ALERT_COMMAND`** — any executable, called once per finding with the message as its single argument. A command rather than an email address or a webhook URL, because whoever runs this installation already has somewhere alerts go and this should not care which. Its exit code is ignored: an alerting channel that is down must not stop the checks |
| **External uptime monitoring** | **None. Must be added — and `monitor.sh` is not a substitute.** It runs on the machine it watches, so it goes quiet at exactly the moment that matters most |
| **Metrics scraper / dashboards** | **None. Must be added** |
| **Error tracking** | **None. Must be added** |

### 18.2 Alert table

Destinations are **[OD]**; the thresholds are recommendations to confirm.

| # | Signal | Source | Warning | Critical | Owner | Escalation |
|---|---|---|---|---|---|---|
| 1 | Site reachable | External monitor, 60 s, from ≥ 2 regions incl. EU | 1 failure | **2 consecutive** | On-call | S1 |
| 2 | `/health/ready` | External monitor | 503 once | 503 for 3 min | On-call | S1 |
| 3 | Checkout synthetic | Synthetic journey, 15 min | fail once | fail twice | On-call | S1 |
| 4 | CPU | node_exporter | > 70 % for 10 min | > 90 % for 5 min | Tech owner | S2 |
| 5 | Memory | node_exporter | > 80 % | > 90 % | Tech owner | S2 |
| 6 | **Swap in/out** | node_exporter | any sustained | > 1 MB/s for 5 min | Tech owner | **S2 — a database in swap has stopped** |
| 7 | Disk used | node_exporter | **> 70 %** | > 85 % | Tech owner | S2 — 200 GB holds DB + media + backups + 5 releases |
| 8 | **Inodes** | node_exporter | > 70 % | > 85 % | Tech owner | S2 — five releases × `node_modules` is a lot of small files |
| 9 | Disk await | node_exporter | > 20 ms p95 | > 50 ms | Tech owner | S3 |
| 10 | Network errors/drops | node_exporter | any sustained | — | Tech owner | S3 |
| 11 | nginx 5xx rate | nginx log / `http_errors_total` | > 0.5 % over 5 min | > 2 % over 5 min | On-call | S1 |
| 12 | nginx 4xx spike | nginx log | 3× baseline | — | Tech owner | S3 — often a scanner or a broken client |
| 13 | **API p95 latency** | `http_request_duration` | > 800 ms 10 min | > 2 s 5 min | Tech owner | S2 |
| 14 | **API p99 latency** | same | > 2 s | > 5 s | Tech owner | S2 |
| 15 | DB connections | `SHOW STATUS Threads_connected` | > 120 of 200 | > 170 | Tech owner | S1 |
| 16 | **DB pool acquire wait** | application | > 50 ms p95 | > 200 ms | Tech owner | S2 — raise `DB_POOL_SIZE` only if `max_connections` allows |
| 17 | Slow queries | `/var/log/mysql/slow.log` | > 10/min | > 50/min | Tech owner | S3 |
| 18 | Deadlocks | `SHOW ENGINE INNODB STATUS` | any new | > 5/hour | Tech owner | S2 |
| 19 | Replication lag | *when replicas exist* | > 5 s | > 30 s | Tech owner | S2 |
| 20 | **Queue depth** | `job_queue` PENDING | > 500 | > 5000 | Tech owner | S2 |
| 21 | **Oldest pending job age** | `job_queue` | > 5 min | > 30 min | On-call | **S1 — scheduled charges are in this queue** |
| 22 | **Worker heartbeat** | `systemctl is-active uboss-worker` + job completions | no completion in 10 min | inactive | On-call | **S1 — an unmonitored worker failure is silent** |
| 23 | **DEAD jobs** | `job_queue` status DEAD | ≥ 1 new | > 10 | Tech owner | S2 |
| 24 | **Payment webhook failures** | `signatureVerified=false`, or 5xx on the webhook path | ≥ 1 | > 3 in 10 min | On-call | **S1** |
| 25 | Unconfirmed paid orders | orders paid but not CONFIRMED > 15 min | ≥ 1 | ≥ 3 | On-call | S1 |
| 26 | ERP sync failures | `integration_events` failed | > 5/hour | circuit open | Tech owner | S2 |
| 27 | Scheduled-order failures | occurrence retry count | ≥ 1 | > 5 | Tech owner | S2 |
| 28 | AI provider failures | assistant error rate | > 10 % | > 50 % | Tech owner | S3 — degrades, does not break the shop |
| 29 | Email delivery failures | SMTP bounces / provider webhook | > 2 % | > 10 % | Tech owner | **S2 — verification and invitation links cannot be read from logs** |
| 30 | **TLS expiry** | External check | **< 21 days** | < 7 days | Tech owner | S1 |
| 31 | **Backup age** | newest `db-*.gpg` mtime | > 26 h | > 50 h | Tech owner | **S1** |
| 32 | **Off-site backup age** | remote listing | > 26 h | > 50 h | Tech owner | **S1** |
| 33 | **Restore-test age** | restore-test result file | > 35 days | > 45 days | Tech owner | S2 |
| 34 | Deployment status | CI | any failure | prod failure | Tech owner | S2 |
| 35 | Certificate renewal timer | `systemctl list-timers` | inactive | — | Tech owner | S2 |
| 36 | fail2ban bans | fail2ban log | 3× baseline | — | Tech owner | S3 |

**Minimum viable stack [OD]:** an external uptime service with EU probes; an
error tracker with a DSN in `.env`; and either a hosted Prometheus scraping
`/metrics` over an SSH tunnel or a local Prometheus + Alertmanager with
`node_exporter` and `mysqld_exporter`. **A local Prometheus dies with the box —
external uptime checking is not optional.**

### 18.3 Logging policy

| Requirement | Status |
|---|---|
| Structured | **Yes** — pino JSON **[VR]** |
| Correlation id | **Yes**, on every request and response **[VR]** |
| No passwords, tokens, cards, or unnecessary PII | **Yes** — 40+ redaction paths, including driver `latitude`/`longitude`, `deliveryOtp`, `deviceToken`, `credentialsEnc`, provider signature headers **[VR]** |
| Retention documented | **[OD]** — set `MaxRetentionSec` in §10.6 and record the number in the ROPA |
| Access-controlled | journald is root/`systemd-journal` only |
| Supports audit and incident investigation | **Yes** — `audit_logs` is append-only by database grant, and survives the application |
| Audit events preserved | Admin, seller, payment, ERP and logistics actions are written to `audit_logs` with actor, action, resource and before/after **[VR]** |

**If logs are shipped off the box**, the collector becomes a processor holding
IP addresses and user agents: it needs a DPA, an EU region, and a place in the
ROPA (§7, §8).

---

## 19. Security verification

### 19.1 Controls already verified present

This is not a courtesy list. Each was read in the source and each removes a
class of finding a penetration test would otherwise raise.

| Control | Implementation | Evidence |
|---|---|---|
| Password hashing | **argon2** | `package.json`, `auth.service.ts` **[VR]** |
| User enumeration resistance | A dummy hash is computed for an unknown email so the timing matches | `auth.service.ts` **[VR]** |
| Login lockout | `LOGIN_LOCKOUT_THRESHOLD` / `_MINUTES`, counted in the **database** — correct across three API instances | `auth.service.ts`, `login_attempts` **[VR]** |
| Session cookies | `httpOnly`, `secure` (forced in production), `sameSite`, signed | `app.ts` **[VR]** |
| **CSRF** | Double-submit token on cookie-authenticated state changes; the CSRF cookie is the only one readable by JavaScript; bearer-token calls skip it correctly | `plugins/auth.ts` **[VR]** |
| **Audience separation** | Separate cookie jars and a `users.type` check per surface, plus a token audience claim — a credential minted for one surface cannot reach another | `plugins/auth.ts`, `UserType` **[VR]** |
| **Tenant isolation** | The seller storefront is resolved **once per request, from the `Host` header only** — never from a parameter, query string or cookie, because a shopper can set all of those and this decides whose prices they are charged. An unknown subdomain gets a 404 rather than falling through to the operator's catalogue | `app.ts` hook 1a **[VR]** |
| Role separation | Separate plugin trees for admin, seller and logistics, each with its own permission set | `http/plugins/` **[VR]** |
| **SSRF** | Scheme allowlist; DNS resolved **before** connecting; every non-globally-routable address rejected (loopback, link-local incl. `169.254.169.254`, private, CGNAT, multicast, IPv4-mapped IPv6); **the connection is pinned to the validated address to defeat DNS rebinding**; redirects are not followed automatically and are re-validated | `infra/outbound-http.ts` **[VR]** |
| **Webhook signatures** | HMAC over the **raw body**, `timingSafeEqual`, length-checked first; **Stripe timestamp freshness enforced** so a captured signature does not stay valid forever | `stripe.adapter.ts`, `razorpay.adapter.ts` **[VR]** |
| Webhook replay | Provider event ids recorded and de-duplicated | `PaymentEvent` **[VR]** |
| **Payment idempotency** | `IdempotencyRecord` with `UNIQUE(scope,key)`, a SHA-256 of the canonical body, and an owner scope so two customers cannot collide on a shared key | schema + services **[VR]** |
| Order state | Only `assertTransition` in `domain/order-state-machine.ts` writes `status` | **[VR]** |
| Schedule state | Only the assertions in `domain/schedule-state.ts` | **[VR]** |
| **Audit-log integrity** | `REVOKE UPDATE, DELETE ON uboss.audit_logs` from the application user — the application cannot rewrite its own history | `RUNBOOK.md` §7, §13.3 **[VR]** |
| **Upload validation** | Type decided by **magic bytes**, not the declared MIME or the extension; size limits; `files: 1`; served with `nosniff`, `Content-Disposition: inline` and `default-src 'none'; sandbox` | `infra/storage/index.ts`, nginx **[VR]** |
| Secrets at rest | ERP/OAuth credentials encrypted with `SECRETS_ENCRYPTION_KEY` | **[VR]** |
| Log redaction | 40+ paths | `infra/logger.ts` **[VR]** |
| Security headers | helmet on the API (`default-src 'none'`, `frame-ancestors 'none'`, HSTS in production); nginx headers on static | **[VR]** |
| Rate limiting | Two layers — nginx edge (`$binary_remote_addr`, unspoofable) and application | **[VR]** |
| Private ERP targets | `ALLOW_PRIVATE_ERP_TARGETS=true` **refuses to start in production** | `env.ts` **[VR]** |
| Live/test key confusion | A live key outside production and a test key inside it both refuse to start | `env.ts` **[VR]** |
| API documentation | **Not served.** Swagger is used only by an export CLI | **[VR]** |
| GDPR export completeness | `tests/unit/export-bundle-completeness.test.ts` reads the schema and **fails** if a table with `userId`/`customerProfileId` is absent from the Art. 15 export | **[VR]** |

### 19.2 Findings to close before production

| ID | Finding | Severity | Fix |
|---|---|---|---|
| ~~S1~~ | ~~**`X-Forwarded-For` spoofing** — nginx appends the client's header and Fastify trusts the whole chain, so `request.ip` is attacker-chosen~~ | **Fixed** | Both halves applied: `proxy_set_header X-Forwarded-For $remote_addr` in nginx, and `trustProxy: isProduction ? 'loopback' : false` in `app.ts`. §11.6 |
| ~~S2~~ | ~~`.gitignore` has no `.env` rule~~ | **Fixed** | Ignore-by-default with named exceptions, verified by `git check-ignore`. **Outstanding:** delete the three `backend/.env.before-*` files; enable GitHub push protection and `gitleaks` |
| **S3** | **CSP is Report-Only.** It no longer *would block* Stripe — the origins are in the shipped policy — but until the two lines are swapped it is still reporting rather than enforcing | **Medium** (was High) | §11.4 — the extension is applied; a day of staging with nothing reported, then swap, then re-test checkout immediately |
| ~~S4~~ | ~~Source maps published for all three SPAs~~ | **Fixed** | `release.sh` deletes `dist/**/*.map` after each frontend build, before the release is assembled |
| **S5** | **Application rate limit is per process** — `@fastify/rate-limit` has no shared store, so three instances give 3× the configured limit, and nginx's `least_conn` spreads one caller across all three | **Medium** | **Documented at the setting itself**, in `backend/.env.example`: divide `RATE_LIMIT_GLOBAL_PER_MINUTE` by the number of `uboss-api@` units enabled. A shared store is the real fix and the unused `RateLimitBucket` table already exists for it. **The login lockout is unaffected — it counts in the database** |
| **S6** | **`/metrics` is unauthenticated** — protected only by the nginx `allow 127.0.0.1` block | **Low** | Keep the nginx restriction; scrape over an SSH tunnel |
| **S7** | **No MFA on staff accounts by default** — MFA exists (`mfaSecretEnc`, logistics enrolment screens) but is not shown to be mandatory for admins | **Medium** | **[OD]** Require MFA for every admin. Verify in the console |
| ~~S8~~ | ~~**No automatic security updates** — `bootstrap.sh` installs neither `unattended-upgrades` nor a fail2ban jail~~ | **Fixed** | Both, plus journald caps, in `bootstrap.sh`. No automatic reboot: one box. §10.6 |
| ~~S9~~ | ~~**No dependency or secret scanning in CI**, because there is no CI~~ | **Fixed, and it found things** | `npm audit --audit-level=high` per project — which failed on first run and is now green: a **critical XSS in `maplibre-gl`** (the admin warehouse map) fixed by taking v6, and three high advisories in transitive packages Prisma pins away from, fixed with `overrides` (`mariadb@^3.5.4`, `mysql2@^3.24.4`, `deepmerge-ts@^8`) and proved by the full 2319-test suite. Plus CycloneDX SBOMs kept 90 days, gitleaks v8.30.0 pinned and run over the full history, Dependabot weekly. **Outstanding:** GitHub push protection, and `ENABLE_CODEQL=true` once Advanced Security is confirmed on the repository |
| **S10** | **MariaDB 10.4 in development is EOL** since 2024-06-18 **[VE]** | **Medium** | Production is 10.11; align development (§13) |
| **S11** | **No penetration test** | **High before launch** | **[OD]** Commission one against staging, scoped to all three surfaces |
| **S12** | **AI prompt injection and data exfiltration** not independently tested | **Medium** | The system prompt forbids clinical advice and the assistant is given the catalogue rather than account data **[VR]** — but a red-team pass on the assistant and image search is warranted before launch |

### 19.3 Pre-production checklist

Against **OWASP ASVS v4 Level 2**, appropriate for an application handling
payments and personal data but not classified data.

- [ ] **Authentication** — argon2 ✅; lockout ✅; **MFA mandatory for admins [OD]**; password reset tokens single-use and time-boxed; no user enumeration ✅
- [ ] **Session** — httpOnly ✅, secure ✅, sameSite ✅; **sign-out invalidates server-side, not just the cookie**; sessions invalidated on password change and on secret rotation ✅
- [ ] **OAuth** — `state` and `nonce` validated; redirect URIs exact-match allowlisted; `CUSTOMER_ERP_OAUTH_REDIRECT_URI` https-only in production ✅
- [ ] **CSRF** ✅ · **XSS** — React escaping + `sanitize-html` + CSP once enforced (S3) · **SQLi** — Prisma parameterised; audit every `$queryRaw`
- [ ] **IDOR** — test each surface with another tenant's ids: order, seller listing, carrier consignment, customer ERP connection
- [ ] **RBAC** — every admin route requires a permission, not just a session
- [ ] **Tenant isolation** — a seller cannot read another seller's orders, stock, payouts or customers; a carrier cannot read another carrier's consignments. **Test explicitly, with real ids**
- [ ] **Rate limiting** ✅ two layers (fix S5) · **Brute force** ✅
- [ ] **File uploads** ✅ magic bytes, size, count; `*_ALLOW_UNSCANNED_DOCUMENTS` off; malware scanning **[OD]**
- [ ] **SSRF** ✅ — re-test after any change to `outbound-http.ts`
- [ ] **Webhooks** ✅ signature + freshness + dedupe
- [ ] **Idempotency** ✅ orders, payments, ERP push, scheduled occurrences
- [ ] **Inventory consistency** — reservations released on cancel/expiry; no negative stock under concurrent checkout (load scenario 6)
- [ ] **AI** — prompt-injection attempts do not reveal other customers' data or produce clinical advice; **AI disclosure visible (AI Act Art. 50, in force **[VE]**)**
- [ ] **Supply chain** — `npm ci` only ✅; audit in CI; SBOM
- [ ] **Secrets** — gitleaks clean; no secret in any bundle ✅
- [ ] **Headers** — verify with `curl -I` on all three hosts **after** any nginx edit, because of the `add_header` inheritance trap
- [ ] **CORS** — exact origins ✅; confirm no wildcard reaches production
- [ ] **Route protection** — admin, seller and logistics routes all 401/403 without the right audience ✅
- [ ] **Audit-log integrity** ✅ database grant
- [ ] **Backup confidentiality** — after §17 Fix 2
- [ ] **Penetration test** (S11) · **Vulnerability disclosure policy and patch process [OD]** — also a Cyber Resilience Act input (§7)

### 19.4 Vulnerability severity and remediation SLA

**The deadlines below are a proposal. There is no existing policy in the
repository, so the final numbers are [OD].**

| Severity | Definition | Triage | Fix — proposed | Workaround |
|---|---|---|---|---|
| **Critical** | RCE, authentication bypass, payment manipulation, mass personal-data exposure | 4 h | **24 h** | Immediate — feature flag or maintenance mode |
| **High** | Privilege escalation, tenant data leak, stored XSS in admin, SSRF to metadata | 1 business day | **7 days** | Yes |
| **Medium** | Reflected XSS, IDOR on low-sensitivity data, rate-limit bypass | 3 business days | **30 days** | Where practical |
| **Low** | Information disclosure with no direct impact, missing hardening header | 10 business days | **90 days** | No |
| **Informational** | Best-practice deviation | Backlog | Next planned work | No |

Dependency vulnerabilities inherit the severity of their **exploitable** path,
not the advisory's headline score.

---

## 20. Testing environments and release promotion

### 20.1 The four environments

| | **Local** | **CI** | **Staging** | **Production** |
|---|---|---|---|---|
| Host | Windows + XAMPP | GitHub `ubuntu-24.04` runner | Second VPS (KVM 1 or 2) **[OD]** | Hostinger KVM 4 |
| `NODE_ENV` | `development` | `test` | **`production`** | `production` |
| Database | XAMPP MariaDB 10.4 | MariaDB 10.11 service container | **MariaDB 10.11, its own server** | MariaDB 10.11 |
| Payments | Stripe **test** keys | mocked | **Stripe test keys, a separate account** | **Stripe live keys** |
| ERP | mock on `localhost:9000` (`ALLOW_PRIVATE_ERP_TARGETS=true`) | mocked (`tests/support/mock-erp.ts`) | **sandbox or mock. `ALLOW_PRIVATE_ERP_TARGETS` must be `false`** | real, `false` |
| OAuth redirect URIs | `http://localhost:...` | n/a | **`https://staging.<DOMAIN>/...` — separately registered** | `https://shop.<DOMAIN>/...` |
| Email | `EMAIL_DRIVER=log`… **but note the development machine uses real SMTP**, so verification links cannot be read from logs there | log | **A mail-capture service or a sandbox domain. Never a real customer address** | real SMTP |
| AI | real Gemini key present locally | disabled | real key, low limits | real key |
| Storage | `local` | `local` | **`s3`, its own bucket** | **`s3`** |
| Data | dev seed | fixtures | **sanitised or synthetic. No production personal data** | real |
| nginx | Vite dev server + proxy | none | **same config as production** | production |
| Process model | `dev-stack.ps1` | vitest | **systemd, same units** | systemd |

**Staging must be production-like in the ways that break things**: the same
`NODE_ENV=production` guards, the same nginx config, the same systemd units, the
same MariaDB version and the same **strict `sql_mode`**. A staging environment
running in development mode proves nothing about the production guards, and
those guards are what a production boot depends on.

**Staging must never hold production personal data.** Copying the production
database into staging is a transfer to a system with weaker access control,
usually reachable by more people, and is a data-minimisation failure. Use
synthetic data, or a sanitised extract with emails, phones, addresses and
free-text fields replaced.

### 20.2 Promotion — one artifact, not a rebuild

```mermaid
graph LR
  A[PR + CI gates] --> B[merge to main]
  B --> C["Build ONCE<br/>backend dist + 3 SPA dists<br/>sha256 manifest"]
  C --> D[Deploy to staging]
  D --> E[Smoke tests + CSP report review]
  E --> F{Manual approval}
  F --> G[Deploy the SAME artifact to production]
  G --> H[Smoke tests]
```

**The rule:** the bytes tested on staging are the bytes that run in production.
Rebuilding for production reintroduces every difference the staging test was
supposed to eliminate.

**The one honest exception** is `VITE_API_BASE_URL`, which Vite bakes into the
bundle at build time **[VR]**, so the staging and production frontend bundles
*cannot* be byte-identical. Two ways to handle it, and you must pick one:

| Option | How | Trade-off |
|---|---|---|
| **A — build twice, from the same commit** | Build a `staging` and a `production` bundle in the same CI job, from one `npm ci`; promote the production one after the staging one passes | Simple. The bundles differ only in one string, and both come from one checked-out tree |
| **B — make the base URL runtime** | Serve `/config.js` from nginx per host and read it at boot instead of `import.meta.env` | One artifact for all environments. **Requires a code change** and is the better long-term answer |

**Option A today; Option B when the frontend is next touched.** Record the
choice in §26.

The **backend** artifact has no such problem — it reads everything from
`/srv/uboss/shared/.env` at runtime **[VR]** — so the API and worker bytes are
genuinely identical across staging and production.

---

## 21. Go-live runbook

Owners are roles; fill in names before you start. **Every step has a go/no-go
condition, and a step whose condition is not met stops the launch.**

### T-minus 7 days

| # | Step | Where | Owner | Go condition | No-go action |
|---|---|---|---|---|---|
| 1 | **Blockers B1–B12, B14 and B15 closed** — done; re-verify on the release commit | Repo | Tech owner | API boots with `NODE_ENV=production`; `release.sh` completes and writes `SHA256SUMS`; frontends call the real API; `backup.sh` reports a verified off-site copy; `ship-binlogs.sh` reports logs off-site; `monitor.sh` exits 0 | **Stop. Nothing below is possible** |
| 1a | **The three timers enabled and each proved by one run** | **[S]** | Tech owner | `systemctl list-timers` shows `uboss-backup`, `uboss-binlog` and `uboss-monitor`; `systemctl start uboss-binlog.service && journalctl -u uboss-binlog -n 20` shows a verified copy | Stop — without the binlog timer the recovery point is the nightly dump, not 15 minutes |
| 1b | **CI green on the release commit**, and branch protection on `main` | GitHub | Tech owner | Every required check passes; force-push and deletion disabled for everyone | Stop |
| 2 | Legal sign-offs: privacy notice, cookie notice, B2B terms, seller terms, logistics terms, AUP — **in Polish** | Legal | Business owner | All published | Stop |
| 3 | GDPR pack: ROPA, Art. 27 representative, DPIA screening, SCCs + TIA for India access, vendor DPAs | Legal | DPO / adviser | Signed | Stop — §7 |
| 4 | MDR/GPSR role determination for the catalogue | Legal | Business owner | Written determination | **Stop — do not sell a device whose economic-operator role is undecided** |
| 5 | KSeF applicability determination (§7.2) | Tax | Tax adviser | Written memo | Stop for invoicing; the rest may proceed |
| 6 | **Penetration test** against staging | External | Tech owner | No Critical or High open | Stop |
| 7 | **Load test** (§5), ≥ 10 min steady state | External | Tech owner | Thresholds met, headroom recorded | Stop or reduce launch scope |
| 8 | **Backup restore test** end to end (§17.5) | Staging | Tech owner | 171 tables restored, recovery time recorded | Stop |
| 9 | **Migration rehearsal** on staging (§13) | Staging | Tech owner | Verification queries match; app works | Stop |
| 10 | Monitoring and alerts live, each proved by a test alert. **`monitor.sh` is the on-box half only** — an external uptime check is the one that survives the machine | Monitoring | Tech owner | A test alert arrives on a phone from `UBOSS_ALERT_COMMAND`, **and** an external check reports the site reachable | Stop |
| 11 | Production accounts verified: Stripe live, SMTP, AI, storage, off-site backup | Vendors | Tech owner | Each returns a successful test | Stop |
| 12 | On-call rota and incident contacts published | — | Business owner | Written down | Stop |

### T-minus 2 days

| # | Step | Where | Go condition |
|---|---|---|---|
| 13 | **DNS TTL lowered to 300** on every record to be moved | **[D]** | `dig +noall +answer shop.<DOMAIN>` shows TTL ≤ 300 |
| 14 | Environment file validated on production | **[S]** | API starts and logs `UBOSS API listening` |
| 15 | `DEFAULT_CURRENCY=PLN`, `DEFAULT_TIMEZONE=Europe/Warsaw`, `FEATURE_ADMIN_LOGIN_LOCATION=false` confirmed | **[S]** | `grep` the names (not the values) in `shared/.env` |
| 16 | **CSP enforced** after a clean reporting day (§11.4) | **[S]** | Checkout works with the enforcing header |
| 17 | HSTS enabled only once every subdomain is HTTPS | **[S]** | `curl -I` on all three hosts |
| 18 | Maintenance and freeze communicated | — | Message sent |

### Launch day

| # | Step | Where | Owner | Go condition | Rollback |
|---|---|---|---|---|---|
| 19 | **Hostinger snapshot** | **[H]** | Tech owner | Snapshot listed | — |
| 20 | **Final backup**, verified and copied off-site | **[S]** | Tech owner | Checksum matches remotely | Stop |
| 21 | Maintenance page on (if replacing a live system) | **[S]** | Tech owner | 503 + page renders; **webhook path exempt** | `rm MAINTENANCE` |
| 22 | Drain the worker: `systemctl stop uboss-worker` | **[S]** | Tech owner | Exits within 120 s | Restart |
| 23 | **Deploy**: `release.sh` | **[S]** | Tech owner | Release assembled, checksums written | Nothing swapped yet |
| 24 | **Migrate**: `prisma migrate deploy` | **[S]** | Tech owner | `Database schema is up to date!` | §22 |
| 25 | Reference data: `npm run db:reference` | **[S]** | Tech owner | Currencies and countries present | Re-run — idempotent |
| 26 | Business-data import (§13) | **[S]** | Tech owner | Verification queries match | Restore step 20 |
| 27 | Start services, rolling | **[S]** | Tech owner | Each answers `/health/ready` | `rollback.sh` |
| 28 | Maintenance page off | **[S]** | Tech owner | Site serves | — |
| 29 | **Smoke tests** — §21.1 | **[W]** | Tech owner | **All pass** | `rollback.sh` |
| 30 | **DNS cutover** | **[D]** | Tech owner | Resolves to `<VPS_IP>` from ≥ 3 networks | Repoint — TTL is 300 |
| 31 | Monitoring confirmed green | Monitoring | Tech owner | No critical alerts for 30 min | Investigate |
| 32 | **Business sign-off** | — | Business owner | Owner confirms in writing | — |

### 21.1 Smoke tests — all must pass

| # | Test | Pass condition |
|---|---|---|
| 1 | `curl -sf https://shop.<DOMAIN>/health/live` | `200`, `status: ok` |
| 2 | `curl -s https://shop.<DOMAIN>/health/ready \| jq` | `ready`, database **and** queue `ok` |
| 3 | Storefront loads; **open DevTools Network and confirm requests go to `https://shop.<DOMAIN>/api/v1`, not localhost** | **This is the B3 regression check** |
| 4 | Catalogue, search, filter, product page | Products and prices render in **PLN** |
| 5 | Language switch to Polish | No raw translation keys |
| 6 | Register or sign in; **confirm the verification email arrives** | Mail delivered; link works |
| 7 | Add to cart, checkout, **pay with a live card for a small real amount** | Order reaches **CONFIRMED** |
| 8 | **Provider webhook delivered and signature-verified** | Provider dashboard shows `200`; order confirmed |
| 9 | **Refund that payment** | Refund succeeds; order and ledger reflect it |
| 10 | Save a card (Stripe Elements) | Card saved; **no card data in any log** |
| 11 | Create a scheduled order; force one occurrence | Charged once, not twice |
| 12 | Admin console sign-in | **MFA prompt appears**; console loads |
| 13 | Admin approves a seller listing | Status changes; `audit_logs` row written |
| 14 | Seller Hub: sign in, create a listing | Scoped to that seller only |
| 15 | **Cross-tenant probe**: seller A requests seller B's listing id | **403/404, never data** |
| 16 | Logistics portal sign-in and a status update | Works on `carriers.<DOMAIN>` |
| 17 | **Cross-carrier probe** | **403/404** |
| 18 | ERP test (if enabled) | Order pushed; idempotency key present |
| 19 | AI assistant | Answers; **AI disclosure visible**; refuses clinical advice |
| 20 | Image search | Returns catalogue matches |
| 21 | Upload a product image | Stored in **object storage** under `products/`, served from `STORAGE_PUBLIC_BASE_URL` |
| 21a | **Request a `private/` key directly from the bucket's public base URL** | **403 or 404 — never the file.** This is the one test that proves the bucket policy, and nothing in the application can prove it for you |
| 21b | Run a GDPR export, then fetch the bundle through the app | Downloads via the token-checked route, not via a bare URL |
| 22 | Upload a `.php` renamed to `.jpg` | **Rejected** by magic-byte sniffing |
| 23 | GDPR export for a test account | Bundle downloads; contains the expected sections |
| 24 | `curl -I` on all three hosts | HSTS, CSP (enforcing), `nosniff`, `X-Frame-Options`, `Referrer-Policy` all present |
| 25 | `curl -H 'X-Forwarded-For: 1.2.3.4' .../health/live` then check the log | Real IP logged — **the S1 fix** |
| 26 | `curl -s https://shop.<DOMAIN>/metrics` from outside | **403** |
| 27 | `nmap -Pn -p 3306,4000-4002 <VPS_IP>` | Closed or filtered |
| 28 | Worker: `journalctl -u uboss-worker --since '10 min ago'` | Jobs completing; no repeated errors |
| 29 | Backup: run `backup.sh` by hand | Exits **zero**; `db-*.sql.gz.gpg` + `.sha256` written; `rclone check` passes; then decrypt the dump into a scratch database and count the tables |
| 30 | `certbot renew --dry-run` | All simulated renewals succeed |

### Post-launch

| When | Step |
|---|---|
| **First 4 hours** | Someone watches the dashboards continuously. No other changes deployed |
| **First 24 hours** | Check order/payment reconciliation (`RUNBOOK.md` §5); review error tracker; confirm the nightly backup ran and went off-site |
| **First 72 hours** | Re-check latency against the load-test baseline; review slow query log; confirm no DEAD jobs |
| **Day 3** | **Raise DNS TTLs back to 3600** once stable |
| **Week 1** | First access review; first restore test on production backups; review CSP reports for anything the day-long staging run missed |

---

## 22. Rollback runbook

### 22.1 Decision tree

```mermaid
graph TD
  A[Problem after a release] --> B{Is data being corrupted<br/>or money mischarged?}
  B -->|Yes| C[S1 INCIDENT<br/>Maintenance mode on<br/>Stop the worker]
  B -->|No| D{Which component?}
  D -->|Frontend only| E[rollback.sh<br/>seconds, no DB impact]
  D -->|API| F{Did this release<br/>run a migration?}
  D -->|Worker| G[Stop the worker<br/>jobs wait safely in the queue]
  F -->|No| E
  F -->|Yes, additive only| E
  F -->|Yes, destructive| H[Code rollback will NOT work<br/>Fix forward with a new migration]
  C --> I{Is the data recoverable<br/>by a targeted fix?}
  I -->|Yes| J[Targeted repair + reconcile]
  I -->|No| K[Restore + binlog replay<br/>then reconcile payments]
```

### 22.2 By failure type

| Failure | Action | Command | Reversible? |
|---|---|---|---|
| **Frontend only** — blank page, broken layout, bad asset | `rollback.sh` repoints `current` and restarts | `sudo -u uboss /srv/uboss/repo/deploy/scripts/rollback.sh` | **Yes**, seconds |
| **Blank page for returning visitors only** | `index.html` was cached. Check the `location = /index.html` block survived the last nginx edit | `curl -I https://shop.<DOMAIN>/index.html` | Yes |
| **API failure, no migration in this release** | `rollback.sh` | as above | **Yes** |
| **API failure, additive migration** | `rollback.sh`. Old code + new schema is fine for anything additive | as above | **Yes** |
| **API failure, destructive migration** | **Do not roll back the code.** The old code cannot run against the new schema. Fix forward | new migration + release | **No** |
| **Worker failure** | `systemctl stop uboss-worker`. Jobs stay `PENDING`; leases expire and are reaped. **This is safe and buys time** | `sudo systemctl stop uboss-worker` | **Yes** |
| **A single bad job type** | Leave the worker running; the job dies after its attempts and is marked `DEAD` rather than churning | monitor alert 23 | Yes |
| **Payment inconsistency** | **Stop the worker first** so no further charges run. Then reconcile from the provider dashboard | `RUNBOOK.md` §5 | Manual |
| **Checkout broken but the rest is fine** | **Checkout-only maintenance**: return 503 from `/api/v1/orders` while leaving browsing and the webhook path up | nginx `location` + `return 503` | **Yes** |
| **ERP inconsistency** | Disable `FEATURE_ERP_INTEGRATION`, restart the API and worker. Rows keep their `nextRetryAt` | edit `shared/.env` | **Yes** |
| **Database corruption** | S1. Maintenance mode, stop everything, restore + replay binlogs | §17.6 | **No — data loss between the last recovery point and the failure** |
| **Severe security issue** | S1. Maintenance mode, rotate the affected secrets, restart (signs everyone out), review `audit_logs`, **assess Art. 33 notification** | §7, §17.6 | n/a |

### 22.3 Rules that must not be bent

1. **`rollback.sh` does not roll the database back, and must not.** Migrations
   have run, and reversing them discards rows written since **[VR]**.
2. **It is the right tool when the new *code* is wrong, and the wrong tool when
   the new *migration* is wrong.** For the latter, fix forward. This is why the
   expand-and-contract rule in §15.5 earns its keep.
3. **Never mark an order paid by hand.** An order reaches `CONFIRMED` only
   through a signature-verified webhook **[VR]**.
4. **Never restore a database to "undo" a bad release** while a targeted repair
   is possible. A restore throws away every legitimate order since the backup.
5. **Stopping the worker is almost always the cheapest safe first move.** It
   pauses charging, ERP pushes and notifications without touching the site.

---

## 23. Post-launch operations

| Cadence | Task | Owner | Evidence |
|---|---|---|---|
| **Daily** | Dashboard glance: error rate, p95, queue depth, disk | On-call | — |
| Daily | **Backup ran and reached the off-site destination** | Automated (alerts 31, 32) | Alert history |
| Daily | Review new `DEAD` jobs and failed webhooks | Tech owner | Ticket per item |
| Daily | Review error tracker for new issue types | Tech owner | — |
| **Weekly** | Payment reconciliation (`RUNBOOK.md` §5) | Finance | Reconciliation record |
| Weekly | Disk, inode and database growth trend | Tech owner | Graph |
| Weekly | Slow query log review | Tech owner | Index changes raised |
| Weekly | Review data-subject requests against their one-month deadline | DPO | Request log |
| Weekly | Review seller listings pending approval; DSA statements of reasons issued | Ops | — |
| **Monthly** | `apt upgrade` + reboot in the maintenance window | Tech owner | Change record |
| Monthly | Dependency updates: `npm outdated`, `npm audit`, patch/minor first | Tech owner | PR |
| Monthly | **Automated restore test** (§17.5) | Automated | Result file, alert 33 |
| Monthly | Certificate expiry check (belt and braces to alert 30) | Tech owner | — |
| Monthly | Review journald and log retention against the stated policy | Tech owner | — |
| **Quarterly** | **Disaster-recovery drill** — a person, end to end, timed against the RTO | Tech owner | Drill report |
| Quarterly | **Access review**: who has SSH, hPanel, GitHub, Stripe, database, admin console. Remove everyone who has left | Business owner | Signed list — **also the GDPR access-minimisation evidence (§7)** |
| Quarterly | **Vendor and subprocessor review**: Hostinger's subprocessor list, AI provider terms, SMTP, storage | DPO | Updated register |
| Quarterly | **Capacity test** against the §5 baseline | Tech owner | Report |
| Quarterly | **Secret rotation**: database passwords, deploy key, API keys where the provider allows | Tech owner | Rotation log |
| Quarterly | Incident exercise (tabletop): "the VPS is gone", "a seller's data leaked" | Tech owner | Notes |
| **Half-yearly** | Compliance review: has any §7 row changed? New law, new feature, new market | DPO + advisers | Updated §7 |
| Half-yearly | Review retention windows against actual legal advice | DPO | Updated `.env` + ROPA |
| **Annually** | Penetration test | External | Report + remediation |
| Annually | PCI attestation / SAQ renewal | Finance | AOC |
| Annually | **Review this document** and the next-review date in §1 | Doc owner | New version |

**Database maintenance.** InnoDB does not need scheduled `OPTIMIZE`. What it
does need:

```bash
# [S] monthly — statistics, after a large import
sudo mariadb -e "ANALYZE TABLE uboss.orders, uboss.products, uboss.job_queue;"
# watch table growth
sudo mariadb -e "SELECT TABLE_NAME, ROUND((DATA_LENGTH+INDEX_LENGTH)/1024/1024,1) mb
                 FROM information_schema.TABLES WHERE TABLE_SCHEMA='uboss'
                 ORDER BY (DATA_LENGTH+INDEX_LENGTH) DESC LIMIT 15;"
```

Expect `job_queue`, `audit_logs`, `logistics_location_pings` and
`assistant_*` to grow fastest. All four are governed by retention settings
(§12.3) — **if they grow without bound, the retention sweep is not running, and
that is a privacy finding as well as a disk one.**

**Security patch SLA:** §19.4. **Change management:** every production change
goes through a PR, CI and the §15 gates. Emergency changes made directly on the
server are permitted only during an S1, must be recorded in the incident, and
must be back-ported to the repository within one business day — otherwise the
next release silently reverts the fix.

---

## 24. Growth and high-availability roadmap

### 24.1 Why one VPS cannot be highly available

High availability means **no single component whose failure takes the service
down**. One VPS is a single machine, a single disk, a single network interface,
a single hypervisor host and a single power domain. Every one of those is a
single point of failure, and no amount of configuration on that machine changes
it. A reboot for a kernel update is downtime. A failed NVMe is downtime and, if
§17 Fix 1 is not done, data loss.

This is not a criticism of the plan. **Starting on one KVM 4 is the right
decision for a first launch** — it is cheap, it is comprehensible, and it is
enough. It just must not be described as something it is not.

### 24.2 Upgrade steps, each with an evidence-based trigger

**No trigger below is a user count.** A user count tells you nothing about
whether a machine is coping.

| # | Step | Trigger — act when any of these is true | Effort | What changes |
|---|---|---|---|---|
| **1** | **Tune what you have** | p95 latency drifts above the SLO; slow query log shows repeated full scans; buffer pool hit rate falls below ~99 % | Hours | `innodb_buffer_pool_size` up if the box is not swapping; add the index the slow log names; raise `WORKER_CONCURRENCY`. **An index is cheaper than a server** |
| **2** | **CDN + WAF in front** | Static and image bandwidth exceeds ~30 % of the 16 TB allowance; or nginx CPU is a measurable share of total; or you want DDoS absorption and bot filtering | Hours — **it is a DNS change** | Cloudflare or similar in front of `shop.<DOMAIN>`. Removes every static asset and cacheable response from this machine. **On a catalogue site this is usually the single largest win available.** Add the WAF rules for `/api/v1/auth/*` at the same time |
| **3** | **Object storage + CDN for media** | **Before launch** | Hours | Driver built; pick the provider and write the bucket policy |
| **4** | **Move the database off the box** | MariaDB CPU > 70 % sustained; pool acquire wait > 50 ms p95; **or the RTO in §6 drops below 4 hours**; or you need a maintenance window you cannot take | Days | A managed MariaDB/MySQL with automatic failover and PITR. **Only `DATABASE_URL` changes.** Four cores here become four API cores, and backup/restore becomes someone else's problem |
| **5** | **Second application node + load balancer** | Three API instances sustain > 70 % CPU at peak; **or any single-node outage has become unacceptable to the business** | Days | Build the same release on a second box, run the same units, put a managed load balancer in front. **The API keeps no state in the process, so this is mechanical — no code change** **[VR]** |
| **6** | **Split the worker onto its own node** | Worker CPU measurably competes with the API; or queue depth stays above the alert threshold with concurrency already raised | Hours | Same build, `uboss-worker` only. **More than one worker is already safe** — the lease pattern and the dedupe key are in place **[VR]** |
| **7** | **Shared Redis** | Only when a real cache is introduced, or when per-instance rate limiting (S5) becomes a problem worth solving properly | Days | `CACHE_DRIVER=redis` is a stub today; the queue does **not** need it |
| **8** | **Durable external queue** | Only if the database queue shows claim contention in the slow query log | Weeks | `QUEUE_DRIVER=redis` is a stub. **Do not migrate a working queue for aesthetics** |
| **9** | **Read replicas** | `/metrics` shows reads are the bottleneck **after** steps 1–5 | Weeks | **The first change that needs application work**: something must decide which queries may go to a replica and tolerate lag. Everything above is configuration |
| **10** | **Centralised logs, metrics, tracing** | More than one node exists | Days | Because `journalctl` on one of five boxes answers nothing |
| **11** | **Infrastructure as code** | More than one node exists, or the second time you rebuild by hand | Weeks | Terraform/Ansible. The `deploy/` scripts are already most of the configuration half |
| **12** | **Cross-region backups** | As soon as backups leave the box (§17) | Hours | A second region, ideally a second provider |
| **13** | **DNS failover** | An RTO below 1 hour is required | Days | Health-checked DNS or an anycast load balancer |
| **14** | **Disaster-recovery region** | An RTO below 15 minutes, or a business case that says a regional outage is unacceptable | Months | Warm standby with database replication |

### 24.3 Sequence

```mermaid
graph LR
  S0[Now: 1 VPS] --> S1[Tune]
  S1 --> S2[CDN + WAF]
  S2 --> S3[Media in object storage]
  S3 --> S4[Managed database]
  S4 --> S5[2nd app node + LB]
  S5 --> S6[Worker node]
  S6 --> S7[Read replicas]
  S7 --> S8[Multi-region DR]
```

Each step is cheap until it is not enough. **Do them in this order** — buying a
second application node before moving the database off the box adds a consumer
to the resource that was already the bottleneck.

---

## 25. Risk register

Probability and impact: **H**igh / **M**edium / **L**ow.

| # | Risk | Cause | P | I | Detection | Prevention | Mitigation | Contingency | Owner | Due | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **R1** | ~~No production storage driver~~ | `s3` was unimplemented | **H** | **H** | Boot test | `s3-storage.ts` built on `@aws-sdk/client-s3`; 18 unit tests | Bucket policy keeps `private/` unreadable | Fall back to a second provider — the driver is provider-agnostic | Tech owner | Done | **CLOSED.** Residual: the signature path is only proved by the §21 smoke test against the real bucket |
| **R2** | ~~Release fails at the migration step~~ | `release.sh` omitted `prisma.config.ts` | **H** | **H** | Release rehearsal | The file is copied in the assemble step | Run the migration from `repo/backend` | Manual release | Tech owner | Done | **CLOSED** |
| **R3** | ~~Frontends call `localhost` in production~~ | Committed `apps/*/.env`; no build-time override | **H** | **H** | Smoke test 3 (DevTools Network) | `release.sh` exports `VITE_API_BASE_URL` per app and **refuses to build** an app whose public URL is unset | Rebuild and redeploy | Maintenance page | Tech owner | Done | **CLOSED.** Re-check in CI when §15 is built |
| **R4** | ~~Backups are on the disk they protect, unencrypted~~ | Off-site line commented out; dump in clear | **H** | **H** | Alerts 31, 32; the run exits non-zero without a verified copy | `rclone copy` + `rclone check`; AES-256 on dump, media and `.env`; SHA-256 beside each | Hostinger weekly backup — a 7-day RPO | Accept the data loss | Tech owner | Done | **CLOSED in code. Still owner action: set `UBOSS_OFFSITE_REMOTE` and the passphrase (D9)** |
| **R5** | ~~Logistics portal is undeployable~~ | Not built; no vhost | **H** | **M** | Smoke tests 16, 17 | Built when `FEATURE_LOGISTICS_PORTAL=true`; `carriers` vhost shipped | Launch with the feature off | Feature off | Tech owner | Done | **CLOSED** |
| **R6** | **A secret is committed** | `.gitignore` had no `.env` rule | **L** (was M) | **H** | `git check-ignore`; gitleaks once CI exists | Ignore-by-default with named exceptions, verified | Rotate every secret in the file | Rotate + purge history | Tech owner | Before go-live | **Largely closed.** Remaining: delete the three `backend/.env.before-*` files, and add push protection + gitleaks (§15) |
| **R7** | **Single-VPS failure** | One machine, one disk, one host | **M** | **H** | External uptime monitor (alert 1) | Cannot be prevented on one box | Snapshots; documented rebuild; off-site backups | Rebuild and restore — measure the RTO in the drill | Tech owner | Ongoing | Accepted for launch |
| **R8** | **Database and media on one disk** | Single-node design | **M** | **H** | Disk alerts 7, 8 | Media to object storage (R1) | Alert at 70 % | Resize the VPS | Tech owner | Before go-live | Open |
| **R9** | **XAMPP → production incompatibility** | Local is non-strict 10.4; production is strict 10.11 | **M** | **M** | `SELECT @@sql_mode` on both | §13.3 step 0 — done once: it found ten `CHAR(26)` `correlationId` columns against a header the API accepts at 64, now widened. **CI runs every commit against 10.11**, so the next one of these is caught by a pull request rather than by production | Staging rehearsal | Fix forward | Tech owner | Before go-live | **Reduced — the class is now under a gate** |
| **R10** | **Connection-pool exhaustion** | `DB_POOL_SIZE` × 4 processes vs `max_connections` | **L** | **H** | Alerts 15, 16 | 12 × 4 = 48 of 200 — comfortable | Raise `max_connections` or lower the pool | Restart | Tech owner | Ongoing | Controlled |
| **R11** | **Disk exhaustion** | 5 releases × `node_modules`, backups, binlogs, journald, media | **M** | **H** | Alerts 7, 8 | Retention everywhere; journald caps (§10.6) | Prune releases; move backups off | Resize | Tech owner | Ongoing | Open |
| **R12** | **Security misconfiguration** | Hand-edited nginx; the `add_header` inheritance trap | **M** | **H** | Header check in smoke test 24 | Config in git; `nginx -t`; snippets | Re-verify after every nginx edit | Roll back the config | Tech owner | Ongoing | Open |
| **R13** | **India → EU data access without a transfer mechanism** | Team in India administering an EU-hosted system | **H** | **H** | Legal review | SCCs + TIA; access minimisation; MFA; audit logging | Restrict production access to EEA staff | Suspend access pending SCCs | DPO | **Before go-live** | **OPEN — legal blocker** |
| **R14** | **Missing DPAs / SCCs with vendors** | Nothing signed yet | **H** | **H** | Vendor register review | Sign before use | Disable the vendor (AI can simply be switched off) | Remove the vendor | DPO | **Before go-live** | **OPEN — legal blocker** |
| **R15** | **Payment or webhook duplication** | Retries, restarts | **L** | **H** | Alerts 24, 25 | Idempotency records + provider event dedupe + raw-body signature + freshness **[VR]** | Reconcile per `RUNBOOK.md` §5 | Manual refund | Finance | Ongoing | **Controlled — verified** |
| **R16** | **Scheduled-job duplication** | Several workers, restarts | **L** | **H** | Job completion logs | Time-slot `dedupeKey` on a `UNIQUE` index; lease claiming **[VR]** | Occurrence state machine caps attempts | Manual review | Tech owner | Ongoing | **Controlled — verified** |
| **R17** | **ERP SSRF or credential exposure** | Admin-typed URLs; stored credentials | **L** | **H** | Outbound request logs | Address-based validation after DNS resolution, connection pinning, no auto-redirects; `ALLOW_PRIVATE_ERP_TARGETS` refused in production; credentials encrypted **[VR]** | Disable the connection | Rotate credentials | Tech owner | Ongoing | **Controlled — verified** |
| **R18** | **AI data leakage** | Free-text prompts sent to a US provider | **M** | **M** | Conversation review | Assistant receives the catalogue, not account data; provider country recorded; retention window **[VR]** | DPA + training opt-out; red-team the prompt | Switch the assistant off by unsetting both keys | DPO | Before go-live | Open |
| **R19** | **Medical-device compliance gap** | Economic-operator role undetermined | **H** | **H** | Legal review | §7 determination before listing | Restrict the catalogue to products with complete evidence | Delist | Business owner | **Before go-live** | **OPEN — legal blocker** |
| **R20** | **Seller fraud or non-compliant listings** | Marketplace model | **M** | **H** | Admin approval queue; Safety Gate notices | Seller verification; document upload; approval workflow **[VR]** | Notice-and-action + statement of reasons (DSA) | Suspend the seller | Ops | Before go-live | Partial |
| **R21** | **KSeF applicability error** | Assuming it applies, or assuming it does not | **M** | **M** | Tax review | §7.2 determination **before** building anything | Voluntary KSeF use is permitted | Correct filings | Tax adviser | Before invoicing | Open |
| **R22** | **A backup that cannot be restored** | Never tested | **M** | **H** | Alert 33 | Automated monthly restore test (§17.5) | Quarterly human drill | Hostinger weekly backup | Tech owner | Before go-live | Open |
| **R23** | **Two applications competing for one KVM 4** | UBOSS AMS co-tenancy | **M** | **H** | CPU/memory alerts | §4.6 isolation and budget | `MemoryMax` and `CPUQuota` on every unit | Move one application to its own VPS | Business owner | **Decision needed** | **UNKNOWN — not in this repository** |
| **R24** | **Failed deployment or migration** | Human error; a destructive migration | **M** | **H** | Health-gated rolling restart aborts by itself **[VR]** | Expand-and-contract; staging rehearsal; CI gates | `rollback.sh` | Restore + reconcile | Tech owner | Ongoing | Partly controlled |
| **R25** | **DNS or certificate failure** | Renewal failure; registrar problem | **L** | **H** | Alerts 30, 35 | `certbot renew --dry-run`; CAA record | Re-issue manually | Second DNS provider | Tech owner | Ongoing | Open |
| **R26** | **Unmonitored worker failure** | It fails silently — the site looks fine | **M** | **H** | **Alerts 21, 22 exist for exactly this** | `Restart=always`; heartbeat alert | Jobs wait safely in the queue | Restart; replay | Tech owner | Before go-live | Open until monitoring exists |
| **R27** | **Insufficient capacity for a spike** | Unmeasured capacity | **M** | **M** | Latency and CPU alerts | Load test (§5); plan to 50 % of the breaking point | CDN absorbs static; edge rate limits | Resize the VPS — Hostinger allows a plan change | Tech owner | Before go-live | Open |
| **R28** | **Rate-limit bypass via `X-Forwarded-For`** | nginx appends; Fastify trusts the chain | **M** | **M** | Log the IP under a spoofed header (smoke test 25) | §11.6 | Edge limiter still uses the real peer address **[VR]** | Block at the edge | Tech owner | Before go-live | **OPEN — S1** |
| **R29** | **CSP enforcement breaks checkout** | Policy lacks Stripe directives | **M** | **H** | Staging with the enforcing header | §11.4 procedure | Revert to Report-Only | nginx rollback | Tech owner | Before go-live | Open |
| **R30** | **Node version drift** | Local 24, server 22, CI none | **L** | **M** | `node -v` | `.nvmrc` + `engines` + `NODE_MAJOR=24` | Build in CI on a pinned image | Rebuild | Tech owner | Before go-live | Open |

---

## 26. Owner decisions and blockers

**Nothing below can be decided by reading the code.** Rows marked **BLOCKER**
must be resolved before deployment.

### 26.1 Technical blockers

| # | Decision / action | Why it blocks | Owner |
|---|---|---|---|
| ~~B1~~ | ~~Implement the S3 storage driver~~ | **DONE.** `s3-storage.ts` + 18 tests. **Still yours:** choose the provider (D12), and write the bucket policy — `products/*` public-read, `private/*` not, listing off on both | Tech owner — **done; bucket policy outstanding** |
| ~~B2~~ | ~~Copy `prisma.config.ts` into the release directory~~ | **DONE** | Tech owner — done |
| ~~B3~~ | ~~Inject `VITE_API_BASE_URL` at build time~~ | **DONE** in `release.sh`. **Still yours:** promotion Option A or B (§20.2), and the same injection in CI when §15 is built | Tech owner — done; §20.2 choice outstanding |
| ~~B4~~ | ~~Encrypt the dump, verify an off-site copy, ship the binlogs~~ | **DONE.** `backup.sh` encrypts and verifies; `ship-binlogs.sh` + `uboss-binlog.timer` take the RPO from 24 h to ~15 min. **Still yours:** set `UBOSS_BACKUP_PASSPHRASE`, `UBOSS_OFFSITE_REMOTE` (D9) and `UBOSS_BINLOG_URL` in `/etc/uboss/backup.env`, create the `uboss_binlog` user, and enable the timer | Tech owner — **done; three settings and one SQL user outstanding** |
| ~~B5~~ | ~~Build `logistics-web` and add the `carriers` vhost~~ | **DONE.** Built only when `FEATURE_LOGISTICS_PORTAL=true` | Tech owner — done |
| ~~B6~~ | ~~Add `.env` rules to `.gitignore`~~ | **DONE**, verified with `git check-ignore`. **Still yours:** delete the three `backend/.env.before-*` files, and turn on GitHub push protection | Tech owner — **two manual steps outstanding** |
| ~~B7~~ | ~~`release.sh`: a `flock` deployment lock and a sudoers rule for `systemctl`~~ | **DONE.** Lock in `release.sh` and `rollback.sh`; `sudo -n` with an explicitly listed sudoers rule that `bootstrap.sh` installs and `visudo -c` validates | Tech owner — done |
| ~~B8~~ | ~~nginx `X-Forwarded-For $remote_addr`; narrow `trustProxy`~~ | **DONE, both halves.** Rate-limit and lockout bypass closed (S1) | Tech owner — done |
| ~~B9~~ | ~~Strip frontend source maps before assembling a release~~ | **DONE** in `release.sh` and in the CI deploy build | Tech owner — done |
| ~~B10~~ | ~~Pin Node: `.nvmrc` = 24, `engines`, `NODE_MAJOR=24`~~ | **DONE.** All five `package.json` files, `.nvmrc`, `bootstrap.sh`, and CI reads `.nvmrc` | Tech owner — done |
| B11 | **Enforce the CSP** (§11.4) | **Extended — the origins Stripe needs are in the shipped policy, so enforcing it no longer blocks card entry.** What remains is a day of staging with nothing reported, the two-line swap, and a 3-D Secure test card immediately afterwards | Tech owner — **the swap is a go-live step** |
| ~~B12~~ | ~~Set `unattended-upgrades` and a fail2ban jail~~ | **DONE** in `bootstrap.sh`, with journald caps. A machine bootstrapped before this change needs §10.6 run by hand | Tech owner — done |
| B13 | **Commission a penetration test** and a load test | No capacity or security evidence exists. Not a code change | Tech owner |
| ~~B14~~ | ~~Set up CI/CD (§15)~~ | **DONE for CI**, and green: `ci.yml`, `codeql.yml`, `dependabot.yml`. **Still yours, and all of it is repository settings rather than code:** branch protection on `main` — **it is unprotected right now**, §15.1 has the ruleset and the one-developer trap — GitHub push protection, `ENABLE_CODEQL`, and, before `deploy.yml` can do anything, the environments, the restricted deploy key and the API base URLs | Tech owner — **repository settings outstanding** |
| B15 | **Stand up monitoring, alerting and external uptime checks** | **The on-box half is done** — `monitor.sh` + `uboss-monitor.timer` make a silent worker failure noisy, and `UBOSS_ALERT_COMMAND` delivers it. **The external half is not, and cannot be:** an uptime check from outside this network, an error tracker and a metrics scraper are all services somebody must choose and pay for (D11) | Tech owner — **external monitoring outstanding** |

### 26.2 Business and legal decisions

| # | Decision | Notes | Blocker? |
|---|---|---|---|
| D1 | **Which legal entity sells into Poland** | Decides GDPR Art. 27, VAT, KSeF, MDR role, NIS2 — almost every row in §7 | **Yes** |
| D2 | **Contracting party on the B2B terms** | Who the buyer's contract is with | **Yes** |
| D3 | **GDPR Art. 27 EU representative** | Appoint, or document why not | **Yes** |
| D4 | **Controller / processor / joint-controller roles** — buyers, sellers, carriers | Especially the carrier relationship for driver location data | **Yes** |
| D5 | **Data centre: Germany or Lithuania** | Poland is not offered **[VE]**. Decide on measured latency (§10.1) | **Yes** |
| D6 | **Domain and subdomain structure** | §11.1 | **Yes** |
| D7 | **Availability target** — Option A, B or C (§6.2) | Drives everything in §24 | **Yes** |
| D8 | **RTO and RPO** | A 24-hour RPO on a payment system should not be accepted by default | **Yes** |
| D9 | **Backup destination and retention** | Must be a different provider or account | **Yes** |
| D10 | **Payment provider and account region** | **Stripe with an EEA acquirer** is the indicated answer; Razorpay is Indian | **Yes** |
| D11 | **SMTP, AI, map, monitoring, error-tracking providers** — each with a DPA | AI can simply be switched off by unsetting both keys | **Yes** |
| D12 | **Object-storage provider and region** | The driver is built and provider-agnostic; the bucket, its region and its policy are still yours | **Yes** |
| D13 | **Seller model** — marketplace intermediary or reseller? | Decides DSA, P2B, DAC7, VAT and MDR role | **Yes** |
| D14 | **Importer / distributor responsibilities for medical devices** | Decides MDR obligations | **Yes** |
| D15 | **VAT registration, reverse charge, EORI, KSeF position** | §7.2 — the KSeF answer follows from D1 | **Yes for invoicing** |
| D16 | **Will any B2C customer be admitted?** | Adds consumer law, withdrawal rights, different accessibility exposure | **Yes** |
| D17 | **Production launch date** | Drives §21 | **Yes** |
| D18 | **Expected traffic at launch** | Sets the load-test target | **Yes** |
| D19 | **Does UBOSS AMS share this VPS?** | **Not referenced anywhere in this repository.** If yes, §4.6 applies and `innodb_buffer_pool_size` must come down | **Yes** |
| D20 | **Operational and on-call owner**, including who answers an S1 at 03:00 CET | §6.3 | **Yes** |
| D21 | Retention windows for each `RETENTION_*` setting | §12.3 — each is a legal decision | **Yes** |
| D22 | MFA mandatory for admin accounts? | S7 | Recommended |
| D23 | Malware scanning for seller document uploads? | Costs memory this box has little of | No |
| D24 | Log retention (`MaxRetentionSec`) | §10.6 — privacy as well as disk | **Yes** |
| D25 | Vulnerability remediation SLA | §19.4 proposes; the owner decides | **Yes** |

---

## 27. Sources

Every external claim in this document traces to a row here. Accessed
**2026-09-16** unless stated.

| # | Source | Publisher | Updated | Proves | Does **not** prove |
|---|---|---|---|---|---|
| 1 | [Hostinger VPS hosting](https://www.hostinger.com/vps-hosting) | Hostinger | live page | **KVM 4 = 4 vCPU, 16 GB RAM, 200 GB NVMe, 16 TB bandwidth, 1 Gbps, free weekly backups, manual snapshots, self-managed with full root access** | Which regions are actually purchasable; performance under load |
| 2 | [Where are Hostinger servers located](https://www.hostinger.com/support/1583267-where-are-hostinger-servers-located/) | Hostinger | **2026-09-15** | **VPS locations: France, Germany, Lithuania, UK; India, Indonesia, Malaysia; USA (Phoenix, Boston); Brazil. Netherlands and USA (Asheville) are web/cloud only.** No Poland | Live availability in the order flow — **hPanel is authoritative** |
| 3 | [Hostinger Data Processing Addendum](https://www.hostinger.com/legal/dpa) | Hostinger | **2026-09-15** | Hostinger is **processor**; entities are Cyprus / UK / Luxembourg; **EU SCCs Modules Two/Three**; subprocessors in Appendix 3; security measures in Appendix 2; breach notice **"without undue delay"** | Any fixed notification deadline; any statement on self-managed VPS security responsibility |
| 4 | [KSeF — od kiedy trzeba wystawiać faktury](https://ksef.podatki.gov.pl/od-kiedy-trzeba-wystawiac-faktury-w-ksef/) | Ministerstwo Finansów (PL) | 2026-09-11 | **Mandatory 1 Feb 2026 (> PLN 200 m 2024 sales); 1 Apr 2026 for all others; relief to 31 Dec 2026 below PLN 10,000/month** | Whether a specific foreign entity is in scope |
| 5 | [KSeF — zakres obowiązkowego KSeF](https://ksef.podatki.gov.pl/informacje-ogolne-ksef-20/zakres-obowiazkowego-ksef/) | Ministerstwo Finansów (PL) | 2026 | **Taxpayers with no seat and no participating fixed establishment (SMPD) in Poland are excluded from the obligation; voluntary use is permitted.** Refers to the MF explanatory notes of 28 Jan 2026 on SMPD | Whether this business has an SMPD — that is a tax-adviser determination |
| 6 | [EU AI Act regulatory framework](https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai) | European Commission | 2026-08-03 | Entry into force 1 Aug 2024; prohibitions and AI literacy from 2 Feb 2025; GPAI from 2 Aug 2025; **transparency obligations (chatbot disclosure, AI-content identifiability) from August 2026**; high-risk 2 Dec 2027 / 2 Aug 2028; AI Omnibus adopted 19 Nov 2025, in force 27 Jul 2026 | The exact classification of this assistant |
| 7 | [European Accessibility Act](https://commission.europa.eu/strategy-and-policy/policies/justice-and-fundamental-rights/disability/european-accessibility-act-eaa_en) | European Commission | not shown | **E-commerce is expressly in scope** | **[NV]** The application date and the microenterprise-services exemption thresholds — EUR-Lex could not be retrieved in this session. **The owner must verify Articles 3, 4(5) and 31 of Directive (EU) 2019/882 directly** |
| 8 | [Nowelizacja ustawy o KSC (NIS2)](https://www.gov.pl/web/baza-wiedzy/nowelizacja-ustawy-o-krajowym-systemie-cyberbezpieczenstwa) | Ministerstwo Cyfryzacji (PL) | 2026 | **Polish NIS2 implementation in force 3 Apr 2026; registration in the S46 system due 3 Oct 2026; ISMS obligations by 3 Apr 2027**; critical vs. important entities; expanded sector list | Whether this entity meets the size and establishment thresholds |
| 9 | [Stripe integration security guide](https://docs.stripe.com/security/guide) | Stripe | live | **Exact CSP directives for Stripe.js/Elements** (`connect-src api.stripe.com`; `frame-src *.js.stripe.com, js.stripe.com, hooks.stripe.com`; `script-src *.js.stripe.com, js.stripe.com`; `img-src *.stripe.com`); TLS 1.2+; webhook signature verification and IP allowlisting; non-sensitive card metadata may be stored | **[NV]** Which SAQ applies — confirm with the acquirer |
| 10 | [Node.js release schedule](https://github.com/nodejs/Release) (`schedule.json`) | Node.js project | live | **Node 24: LTS from 2025-10-28, maintenance 2026-10-20, EOL 2028-04-30. Node 22: maintenance since 2025-10-21, EOL 2027-04-30. Node 26 becomes LTS 2026-10-28** | — |
| 11 | [Ubuntu `meta-release-lts`](https://changelogs.ubuntu.com/meta-release-lts) | Canonical | live | **24.04.5 LTS (noble) is a supported LTS; 26.04.1 LTS (resolute) exists but is not yet offered on the LTS upgrade path** | Hostinger's image availability |
| 12 | [Launchpad: `mariadb` in `noble`](https://api.launchpad.net/1.0/ubuntu/noble/+source/mariadb) | Canonical | live | **Ubuntu 24.04 packages MariaDB `1:10.11.14-0ubuntu0.24.04.1`** | — |
| 13 | [endoflife.date — MariaDB](https://endoflife.date/mariadb) | endoflife.date | live | **10.4 EOL 2024-06-18; 10.11 EOL 2028-02-16; 11.4 EOL 2029-05-29** | Aggregated, not MariaDB's own page — confirm at mariadb.org before a version decision |
| 14 | [MariaDB `sql_mode` documentation](https://mariadb.com/docs/server/server-management/variables-and-modes/sql_mode.md) | MariaDB | live | **Default since 10.2.4 is `STRICT_TRANS_TABLES, ERROR_FOR_DIVISION_BY_ZERO, NO_AUTO_CREATE_USER, NO_ENGINE_SUBSTITUTION`** | What this particular Hostinger image ships — **verify with `SELECT @@sql_mode`** |
| 15 | [GDPR (EU) 2016/679](https://eur-lex.europa.eu/eli/reg/2016/679/oj) | EUR-Lex | — | Cited as the instrument | **[NV]** Article text not retrieved in this session |
| 16 | [EDPB](https://www.edpb.europa.eu/) · [UODO](https://uodo.gov.pl/en) | EDPB · UODO | — | Named as the competent guidance and supervisory bodies | **[NV]** No specific guidance retrieved |
| 17 | [DSA](https://digital-strategy.ec.europa.eu/en/policies/digital-services-act) · [GPSR](https://eur-lex.europa.eu/eli/reg/2023/988/oj) · [MDR](https://eur-lex.europa.eu/eli/reg/2017/745/oj) · [IVDR](https://eur-lex.europa.eu/eli/reg/2017/746/oj) · [MD economic operators](https://health.ec.europa.eu/medical-devices-topics-interest/economic-operators_en) · [CRA](https://digital-strategy.ec.europa.eu/policies/cyber-resilience-act) · [NIS2](https://digital-strategy.ec.europa.eu/en/policies/nis2-directive) · [PCI SSC](https://www.pcisecuritystandards.org/) | EC · EUR-Lex · PCI SSC | — | Named as the instruments in §7 | **[NV]** Article-level obligations not individually retrieved. **Every §7 row marked [LA] needs an adviser, not a URL** |

---

## Day-to-day reference

```bash
# What is running
systemctl status 'uboss-*'

# Logs. Structured JSON (pino) to journald.
journalctl -u uboss-api@4000 -f
journalctl -u uboss-worker -f --since '1 hour ago'
journalctl -u 'uboss-api@*' -p err --since today

# Health
curl -s localhost:4000/health/ready | jq
for p in 4000 4001 4002; do
  curl -sf localhost:$p/health/live >/dev/null && echo "$p up" || echo "$p DOWN"
done

# Metrics (loopback only — nginx denies this from outside)
curl -s localhost:4000/metrics | head -40

# What the database is doing
sudo mariadb -e "SHOW PROCESSLIST;"
sudo mariadb -e "SHOW STATUS LIKE 'Threads_connected';"
sudo tail -f /var/log/mysql/slow.log

# Queue. `runAt`, not `run_at` — Prisma maps the model name, not the columns.
sudo mariadb -e "SELECT status, COUNT(*) FROM uboss.job_queue GROUP BY status;"
sudo mariadb -e "SELECT MIN(runAt) FROM uboss.job_queue WHERE status='PENDING';"

# The self-checks, on demand rather than waiting for the timer
sudo systemctl start uboss-monitor.service; journalctl -u uboss-monitor -n 30 --no-pager

# Backups and the recovery point
systemctl list-timers 'uboss-*'
ls -lt /srv/uboss/backups/db-*.gpg | head -3
ls -lt /srv/uboss/backups/binlog/*.gpg | head -3   # newest should be < 15 min old
journalctl -u uboss-binlog -n 20 --no-pager

# What is deployed, and whether it is still what was released
cat /srv/uboss/current/REVISION /srv/uboss/current/RELEASED_AT
( cd /srv/uboss/current && sha256sum -c SHA256SUMS --quiet ) && echo "release intact"

# Release / rollback. Both take the same lock; neither can run while the other is.
sudo -u uboss /srv/uboss/repo/deploy/scripts/release.sh
sudo -u uboss /srv/uboss/repo/deploy/scripts/rollback.sh
```

`/health/live` and `/health/ready` are different questions and the difference
matters: `live` never touches a dependency, so a database outage does not get
the process restarted — restarting fixes nothing. `ready` checks the database
and the queue and returns 503 so a load balancer drains the instance.

### Troubleshooting

**The API will not start.** Read the message — it prints every invalid setting
at once, with the setting name. `journalctl -u uboss-api@4000 -n 50`. If it says
`STORAGE_DRIVER`, check `S3_BUCKET` and both keys are set — `s3` requires all three.

**`prisma migrate deploy` says the datasource url is required.** `prisma.config.ts`
is missing from the release directory. `release.sh` copies it; a hand-assembled release must too.

**The site loads but nothing works, and DevTools shows calls to
`localhost:4000`.** The frontend was built without `VITE_API_BASE_URL`. **B3.**

**Signed out immediately after signing in.** `COOKIE_DOMAIN` is wrong — it must
be the parent domain with a leading dot. Also check `X-Forwarded-Proto` is
reaching the API; without it every `Secure` cookie is refused.

**The site is blank after a release, only for regular visitors.** `index.html`
was cached. It names the current fingerprinted chunks, and a cached one points
at the previous release's files, which were pruned. Check the
`location = /index.html` block survived the last nginx edit.

**Card entry is blank or the payment iframe never appears.** CSP. §11.4.

**CORS errors in the admin panel.** `ADMIN_WEB_ORIGIN` does not exactly match
the browser's origin — scheme, host and port, no trailing slash.

**413 on an image upload.** `client_max_body_size` in nginx must be above
`UPLOAD_MAX_BYTES`, or nginx refuses the body with a bare 413 before the API can
produce a readable message.

**Every third request is slow.** An API instance is down or was never enabled;
nginx is waiting out `fail_timeout`. `systemctl status 'uboss-api@*'`.

**Orders confirm late or not at all.** The worker. `journalctl -u uboss-worker`.
An order reaches `CONFIRMED` only through a signature-verified webhook, never a
client redirect — so also check the provider's own delivery log.

**Security headers vanished from one path.** A `location` that sets any
`add_header` inherits none from its parent. Add the security-headers include
back to that location.

---

## Related documents

This document covers **getting the software onto a server, releasing to it, and
the decisions that surround doing so lawfully**. It is deliberately not the
operations manual, and where the two touch, the runbook wins.

| For | Read |
|---|---|
| Backup policy, restore procedure, migrations, payment reconciliation, incident response, the production hardening checklist | `backend/docs/RUNBOOK.md` |
| Personal data, retention, the Art. 15 export, the Art. 30 register skeleton | `backend/docs/DATA-PROTECTION.md` |
| VAT handling for European markets | `backend/docs/EU-VAT.md` |
| Product-safety and compliance fields | `backend/docs/PRODUCT-SAFETY.md` |
| Accessibility commitments and how they are tested | `backend/docs/ACCESSIBILITY.md` |
| Running it on a developer's machine | `SETUP.md` |
| What the system is and how it is built | `PROJECT-GUIDE.md` |
| Features, configuration, markets, payments, going live | `README.md` |
| Every file referenced here, each commented with why it is what it is | `deploy/` |

Two things in the runbook's hardening checklist are **done for you** by the
files in `deploy/`, and are worth knowing so you do not do them twice:
`/metrics` is already restricted to loopback in the nginx config, and MariaDB is
already bound to `127.0.0.1` in `deploy/mariadb/uboss.cnf`. Everything else on
that list is still yours — in particular the database users, the gateway webhook
registration, and the notification recipients.
