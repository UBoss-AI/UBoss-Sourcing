# UBOSS Sourcing — Backend

Node.js + TypeScript API and worker for the UBOSS Sourcing deployment, serving
two separate React frontends (Admin Panel, Customer Website) from one backend.

Implements Prompt 1 of `UBOSS_Claude_Implementation_Prompts.docx`.

---

## Stack, and where it deviates from the plan documents

| Layer | Plan document says | This build uses | Why |
|---|---|---|---|
| Database | PostgreSQL | **MariaDB 10.4.32** (XAMPP) | Client directive. XAMPP's "MySQL" is MariaDB. |
| Framework | NestJS + Fastify preferred | **Fastify + TypeScript**, layered | Dev Plan §1.1 also permits "Express/Fastify architecture". Fewer moving parts inside the delivery window. |
| ORM | Mature ORM, versioned migrations | **Prisma 7.10** (`mysql` provider) | Meets the requirement. `db push` is never used. |
| Queue / locks | Redis-compatible | **MariaDB-backed**, Redis adapter behind config | XAMPP ships no Redis. See *Queue* below — this is a real implementation, not a stub. |
| Validation | Schema at every boundary | **Zod** | Same schemas feed OpenAPI, so contracts cannot drift. |

### MariaDB 10.4 constraints that shaped the design

- **No `FOR UPDATE SKIP LOCKED`** (MariaDB 10.6+). Job and schedule claiming
  uses an optimistic conditional `UPDATE` + `affectedRows` check instead.
  Verified by an integration test that races 10 workers over 5 jobs.
- **No native `UUID` type** (10.7+). Primary keys are ULIDs in `CHAR(26)` —
  sortable, so InnoDB clustered-index inserts stay append-only.
- **Server timezone is `Asia/Calcutta`.** Every instant is `DATETIME(3)` in UTC;
  the driver session is pinned to `Z`. Recurrence carries its own IANA zone.
- **A MySQL `UNIQUE` index treats every `NULL` as distinct.** Composite uniques
  involving an optional variant therefore store `variantKey` (`''` for the base
  product), never `NULL` — otherwise duplicate cart/inventory rows slip through.
- **No transactional DDL.** A failed migration must be rolled back by hand.
- `CHECK` constraints **are** enforced on 10.4 (verified) — 82 of them are live.

---

## Setup

Requires Node ≥ 20.11 and XAMPP MySQL/MariaDB running on `3306`.

```bash
cd backend
npm install

cp .env.example .env
# Generate real secrets (the placeholders are rejected at boot in production):
node -e "console.log('SESSION_COOKIE_SECRET='+require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('ACCESS_TOKEN_SECRET='+require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('REFRESH_TOKEN_SECRET='+require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('SECRETS_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('base64'))"
```

Create the databases (the `_shadow` one is used by `prisma migrate dev`):

```sql
CREATE DATABASE uboss              CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE uboss_shadow       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE uboss_test         CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE uboss_test_shadow  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Apply migrations and start:

```bash
npm run db:migrate:deploy                              # apply to uboss
PRISMA_TARGET_TEST_DB=1 npx prisma migrate deploy      # apply to uboss_test
npm run db:generate

npm run dev          # API on :4000
npm run dev:worker   # background worker
```

Verify:

```bash
curl http://localhost:4000/health/live
curl http://localhost:4000/health/ready   # checks database + queue
```

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` / `dev:worker` | API / worker with reload |
| `npm run verify` | typecheck + lint + tests — the gate before any commit |
| `npm run build` / `start` | Production build / run |
| `npm run db:migrate` | Create + apply a migration (interactive) |
| `npm run db:migrate:deploy` | Apply pending migrations (CI/production) |
| `npm run db:reset` | Drop, re-migrate, re-seed |
| `npm test` | Unit + integration tests |

> `npm run db:migrate` (`prisma migrate dev`) prompts interactively. In scripts
> and CI use `db:migrate:deploy`, which never prompts.

---

## Layout

```
prisma/
  schema.prisma            54 models, 32 enums
  migrations/
    ..._init/              tables, indexes, foreign keys
    ..._add_check_constraints/   82 CHECK constraints (Prisma cannot express these)
src/
  config/env.ts            Zod-validated environment; refuses to boot when invalid
  domain/                  Business rules, no I/O
    money.ts               BigInt minor units, half-up rounding, apportionment
    errors.ts              AppError + the published error-code contract
    order-state-machine.ts Guarded transitions, the only path to a status change
  infra/                   Adapters
    prisma.ts              Client + MariaDB driver adapter + pool
    crypto.ts              Argon2id, SHA-256 tokens, AES-256-GCM secrets
    logger.ts              Pino with redaction paths
    ids.ts                 ULIDs, variantKey helpers
    queue/                 JobQueueDriver + MariaDB implementation
  http/
    app.ts                 Plugin order, CORS allowlist, raw-body capture, error envelope
    server.ts              Entrypoint, graceful shutdown
    routes/health.ts       /health/live, /health/ready
tests/
  unit/                    money, order state machine, crypto
  integration/             job queue against real MariaDB
```

### Layering rule

`http` → `modules` (services) → `domain` → `infra`.
Domain code imports no adapter and performs no I/O, so business rules are
testable without a database. Route handlers never contain business rules.

---

## Invariants that must not be weakened

These are load-bearing. Each is enforced in more than one place on purpose.

**Money.** Always `BigInt` minor units. No `Float`, no JS `number`, anywhere in
a money path — ESLint bans `parseFloat` outright. Crosses the API boundary as a
string. `bigIntAsNumber: false` on the driver keeps `BIGINT` from silently
becoming a lossy `Number`.

**Order history is immutable.** `order_items` stores name/SKU/price/tax
snapshots. Editing a product never rewrites a historical order.

**Payment success comes only from a verified webhook.** Signature is checked
against the *raw* request body (captured in `app.ts` before JSON parsing).
A client redirect never confirms an order.

**Idempotency is structural, not procedural:**

| Risk | Guard |
|---|---|
| Duplicate webhook delivery | `unique(payment_events.providerEventId)` |
| Duplicate checkout submission | `unique(idempotency_records.scope, key)` + request-body hash |
| Duplicate recurring order | `unique(schedule_occurrences.scheduleId, plannedRunAt)` |
| One occurrence fanning into two orders | `unique(orders.scheduleOccurrenceId)` |
| Duplicate refund | `unique(refunds.idempotencyKey)` |
| Duplicate notification | `unique(notification_outbox.dedupeKey)` |

An idempotency key replayed with a **different** body is rejected
(`IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY`), never silently answered with the
earlier response.

**No card data, ever.** Provider references and tokenised mandates only.
`chk_order_refund_within_paid` makes over-refunding impossible at the database
level, independent of application logic.

**Notifications use a transactional outbox.** Side-effect jobs are enqueued in
the same transaction as the business write, so a committed order cannot lose its
confirmation email and a rolled-back one cannot send a phantom.

---

## Queue

`QUEUE_DRIVER=database` (default) runs the queue on MariaDB. Claiming is
lock-free because 10.4 lacks `SKIP LOCKED`:

1. `SELECT` a batch of candidate ids — no locks held.
2. Per candidate, `UPDATE ... WHERE id = ? AND status = 'PENDING'`.
3. Proceed only when `affectedRows === 1`.

Step 2 is atomic at the InnoDB row level, so exactly one worker wins. A crashed
worker leaves an expired `leaseExpiresAt`; `reapExpiredLeases()` returns those
rows to `PENDING`. Exhausted jobs become `DEAD` rather than being deleted, so
they stay visible and replayable.

`QUEUE_DRIVER=redis` throws a clear error until `redis-queue.ts` exists —
booting a production instance that believes it has Redis and quietly does not
is worse than refusing to start.

---

## Security posture

- Argon2id (19 MiB, t=2, p=1) for passwords; parameters live in the digest, so
  raising them later rehashes on next login.
- Invitation / reset / payment-link tokens: 32 bytes CSPRNG, **only the SHA-256
  is stored**. A database dump contains no usable tokens.
- Gateway and connector credentials: AES-256-GCM, with the record identity as
  AAD — a credential row copied elsewhere fails to decrypt rather than yielding
  a working secret.
- `safeCompare` (constant-time) for every attacker-submittable comparison.
- Exact CORS allowlist, no wildcards. `trustProxy` only in production, so a
  local client cannot spoof its IP past the per-IP rate limits.
- Logger redacts credentials, tokens, signatures, card fields and address JSON
  by path, so an accidental wholesale object log stays safe.
- 500s disclose nothing: no stack, no driver message, no SQL — only an error
  code and the correlation id.
- `audit_logs` is append-oriented. In production, grant the application user
  `INSERT`/`SELECT` only on that table.

---

## Status

Prompt 1 Steps 1–2 are complete and verified. Steps 3–12 are not yet built —
see `docs/STATUS.md` for the exact breakdown and what remains.
