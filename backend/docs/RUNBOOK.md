# Operations runbook

Backup, restore, migration and incident procedures for the UBOSS Sourcing
backend.

> **Numbers this document deliberately does not state.** RPO, RTO, availability
> target and incident-acknowledgement time are business commitments, not
> engineering defaults. Dev Plan §12 and SOP §15 require them to be approved by
> the client before production. Where a figure is needed below it is written as
> `<APPROVE>` — fill it in once, in one place, and reference it from the SLA.
>
> The Dev Plan's §12.1 *suggested starting points* (RPO ≤ 24h, RTO ≤ 4h,
> acknowledgement within 15 minutes) are proposals for that conversation, not
> settled values, and are not encoded anywhere in this codebase.

---

## 1. What has to survive

| Data | Where | Loss impact |
|---|---|---|
| Orders, order items, payments, refunds | MariaDB | **Unrecoverable.** Money moved that we can no longer account for. |
| Inventory ledger (`inventory_movements`) | MariaDB | Balances can be replayed from it; without it, stock is guesswork. |
| Audit log | MariaDB | Compliance and dispute evidence. |
| Customers, addresses, schedules | MariaDB | Re-invitation possible but disruptive. |
| Chat enquiries (`assistant_conversations`) | MariaDB | Sales leads and the questions they asked. Recoverable only if the visitor comes back. |
| Catalog + product media | MariaDB + object storage | Re-creatable from source, slowly. |
| Export files | Object storage | Regenerable. **Contains personal data** — see §6. |
| Queue and outbox rows | MariaDB | In-flight notifications and jobs. |

Everything that matters is in one database. That is the thing to back up.

---

## 2. Backup

### What to run

```bash
# Consistent, non-blocking dump of the whole schema.
mysqldump \
  --single-transaction \
  --routines \
  --triggers \
  --hex-blob \
  --default-character-set=utf8mb4 \
  -u backup_user -p uboss \
  | gzip > "uboss-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
```

`--single-transaction` is what makes this safe on a live InnoDB database: the
dump sees one consistent snapshot without locking writers. Omitting it produces
a dump that can contain an order without its items.

### Frequency and retention

Both are `<APPROVE>` decisions, driven by the agreed RPO. Point-in-time
recovery requires binary logging, which MariaDB does not enable by default:

```ini
# my.ini  [mysqld]
log_bin = mysql-bin
binlog_format = ROW
expire_logs_days = <APPROVE>
```

Without binlogs, the recovery point is the last full dump — no better.

### Object storage

Product media and export files are **not** in the database dump. Under
`STORAGE_DRIVER=s3`, enable bucket versioning and a lifecycle policy. Under
`STORAGE_DRIVER=local` there is no durability at all, which is why
`config/env.ts` refuses to start in production with it.

### Verify the backup, not just the job

A backup that has never been restored is a hope, not a plan.

```bash
# Restore into a scratch database and check it is coherent.
mysql -u root -p -e "CREATE DATABASE uboss_restore_check;"
gunzip < uboss-<timestamp>.sql.gz | mysql -u root -p uboss_restore_check

mysql -u root -p uboss_restore_check -e "
  SELECT COUNT(*) AS orders FROM orders;
  SELECT COUNT(*) AS orphan_items FROM order_items oi
    LEFT JOIN orders o ON o.id = oi.orderId WHERE o.id IS NULL;
  SELECT MAX(finished_at) AS last_migration FROM _prisma_migrations;
"
```

`orphan_items` must be 0. A non-zero value means the dump was taken without
`--single-transaction`.

Restore drills are a quarterly item in SOP §16.

---

## 3. Restore

1. **Stop writes.** Stop the API and worker. Leaving the worker running means it
   will process the queue against a half-restored database.
   ```bash
   # However the deployment runs them.
   pm2 stop uboss-api uboss-worker    # or systemctl, or scale to 0
   ```
2. **Preserve the damaged database.** Rename rather than drop — it is evidence,
   and it may hold rows the backup does not.
   ```sql
   CREATE DATABASE uboss_damaged_<date>;
   -- then move tables, or take a dump of the damaged state first
   ```
3. **Restore the dump** into a clean `uboss`.
4. **Replay binlogs** to the target point, if binary logging is enabled:
   ```bash
   mysqlbinlog --start-datetime="<last dump time>" \
               --stop-datetime="<target time>" mysql-bin.* | mysql -u root -p uboss
   ```
5. **Check migration state matches the deployed code.**
   ```bash
   npx prisma migrate status
   ```
   If the restored database is behind the running code, deploy the matching
   older build first, or apply the migrations. Never run new code against an
   old schema.
6. **Reconcile payments before accepting traffic.** This is the step most likely
   to be skipped and most expensive to skip. See §5.
7. **Start the worker, then the API.** In that order: the worker drains any
   stranded outbox rows before customers can create more.

---

## 4. Migrations

```bash
# Production and CI. Never prompts.
npm run db:migrate:deploy

# Local development only. Prompts, and will hang in a script.
npm run db:migrate
```

**MariaDB 10.4 has no transactional DDL.** A migration that fails halfway
leaves the schema partly changed and cannot roll itself back. Therefore:

1. Take a backup immediately before any migration. Not "recently" — immediately.
2. Apply to staging against a copy of production data first.
3. Prefer additive changes (add a column, backfill, then switch reads) over
   destructive ones. A dropped column cannot be un-dropped.
4. If a migration fails, do not re-run it blindly. Inspect
   `_prisma_migrations`, decide whether to finish it by hand or restore.

### Adding a CHECK constraint

Prisma cannot express them, so they live in hand-written migrations — see
`prisma/migrations/*_add_check_constraints/`. Adding one to a table with
existing violating rows fails; fix the data first.

---

## 5. Payment reconciliation

Run after any restore, and whenever `uboss_payments_unreconciled` is non-zero.

```sql
-- Payments the provider may have taken that no order records.
SELECT pt.id, pt.providerOrderId, pt.status, pt.amountMinor, o.orderNumber, o.status
  FROM payment_transactions pt
  JOIN orders o ON o.id = pt.orderId
 WHERE pt.status IN ('CREATED','PENDING','AUTHORIZED')
   AND pt.createdAt < NOW() - INTERVAL 1 HOUR;

-- Verified provider events we refused. Each one needs a human decision.
SELECT id, eventType, processingError, receivedAt
  FROM payment_events
 WHERE processingStatus = 'REJECTED'
 ORDER BY receivedAt DESC;

-- Orders whose money does not add up. Should always be empty:
-- chk_order_refund_within_paid and chk_order_paid_within_total enforce it.
SELECT id, orderNumber, paidMinor, refundedMinor, grandTotalMinor
  FROM orders
 WHERE refundedMinor > paidMinor OR paidMinor > grandTotalMinor;
```

To reconcile one payment against the provider:

```
POST /api/v1/admin/payments/:paymentId/reconcile
```

This re-queries the provider and applies the result. **It will not confirm an
order whose amount does not match** — a mismatch is alerted to Finance instead
(SOP §10.4). Never confirm an order by hand to "fix" a mismatch.

---

## 6. Data retention and privacy

| Item | Handling |
|---|---|
| Export files | Deleted when the download window closes (6h). The job row survives as an audit record. Handled automatically by worker maintenance. |
| Sessions | `purgeExpiredSessions()` removes rows expired more than 30 days. |
| Idempotency records | Expire after 24h; `purgeExpiredIdempotencyRecords()` clears them. |
| Payment events | Retained. They are dispute evidence. Retention period is `<APPROVE>`. |
| Audit log | Retained. Retention period is `<APPROVE>`; see §7 for the access rule. |
| Chat enquiries | Retained, with no automatic purge. Each row holds a name, a mobile number, an email address and the transcript — all typed by a visitor into the storefront chat widget and none of it verified. Readable by any role holding `assistant_chat.read`. Retention period is `<APPROVE>`. |
| Customer deletion / anonymisation | **Not implemented.** Requires a business decision on what "delete" means for an account with orders — SOP §17 requires an approved policy first. |

Backups contain personal data. Encrypt them at rest and restrict access to the
same people who may read the production database.

---

## 7. Production hardening checklist

Things this codebase enforces, and things only the deployment can:

**Enforced in code** (`config/env.ts` refuses to start otherwise):
- `COOKIE_SECURE=true`
- `EMAIL_DRIVER` is not `log`
- `STORAGE_DRIVER` is not `local`
- No `rzp_live_` / `sk_live_` key outside production, and no test key inside it
- No leftover `.env.example` placeholder secrets

**Deployment must do:**
- [ ] Set a MariaDB root password. XAMPP ships with none.
- [ ] Create a dedicated application user — **not** root:
      ```sql
      CREATE USER 'uboss_app'@'%' IDENTIFIED BY '<strong>';
      GRANT SELECT, INSERT, UPDATE, DELETE ON uboss.* TO 'uboss_app'@'%';
      -- The audit trail is append-only. Deny UPDATE and DELETE on it, so a
      -- compromised application cannot rewrite its own history.
      REVOKE UPDATE, DELETE ON uboss.audit_logs FROM 'uboss_app'@'%';
      ```
- [ ] Separate backup user with `SELECT, LOCK TABLES, SHOW VIEW` only.
- [ ] Bind MariaDB to a private interface. Never expose 3306 publicly.
- [ ] TLS terminated in front of the API; `trustProxy` is already on in production.
- [ ] `/metrics` on an internal port or behind a network policy. It is
      unauthenticated by design (a scraper has no session) and exposes no
      customer data, but it does reveal system shape.
- [ ] Rotate `SECRETS_ENCRYPTION_KEY` only with a re-encryption plan — every
      `credentialsEnc` value is bound to the current key.
- [ ] Configure the Razorpay dashboard webhook to the public
      `/api/v1/payments/webhooks/razorpay` with the `RAZORPAY_WEBHOOK_SECRET`
      from `.env`.
- [ ] Set `internalRecipientsJson` on the `notification_settings` rows for
      `inventory.low_stock` and `payment.failed`. Without recipients, those
      alerts are logged and dropped.

---

## 8. Incident response

Mapped from SOP §15.

| Symptom | First action | Then |
|---|---|---|
| API unreachable | `GET /health/live`. If it answers, the process is fine — look at the proxy. | Check `/health/ready` for which dependency is down. |
| Database down | `/health/ready` reports it. The API returns 503 and the load balancer drains. | Do **not** restart the API; it fixes nothing and loses in-flight work. |
| Queue backing up (`uboss_queue_depth{state="pending"}` climbing) | Is the worker running? Check `uboss_jobs_processed_total`. | Workers scale horizontally; the claim guard prevents double-processing. |
| Dead jobs (`state="dead"`) | Read `job_queue.lastError`. | Fix the cause, then set the row back to `PENDING` to replay it. |
| Payments failing | `GET /api/v1/admin/payments/webhook-health`. | If signatures are failing, the webhook secret has drifted from the dashboard. |
| Amount mismatch alert | **Stop.** Do not confirm the order manually. | Reconcile against the provider (§5). SOP §15 escalates to Finance. |
| Recurring schedule paused | `GET /api/v1/admin/reports/recurring` → `needsAttention`. | Fix the cause, then resume. Resuming clears the failure count and does **not** fire for missed slots. |
| Suspected account compromise | Deactivate the account. Sessions are revoked immediately. | Preserve `audit_logs` and `login_attempts` before anything else. |
| Connector circuit open | Expected behaviour after 5 consecutive failures. | It half-opens after 5 minutes. Fix the remote; do not disable the breaker. |

### Emergency stops

```sql
-- Stop all recurring charging immediately, without a deploy.
UPDATE recurring_schedules SET status = 'PAUSED', nextRunAt = NULL
 WHERE status = 'ACTIVE';

-- Stop taking new payments.
UPDATE payment_provider_connections SET isActive = 0;

-- Stop a runaway connector.
UPDATE integration_connections SET isActive = 0 WHERE id = '<id>';
```

Each is reversible and none loses data. The recurring pause is the one worth
knowing by heart: it is the fastest way to stop money moving.

---

## 9. Monitoring

Scrape `/metrics`. The signals worth alerting on:

| Metric | Why it matters |
|---|---|
| `uboss_queue_depth{state="dead"}` | Work that will never complete on its own. |
| `uboss_notification_outbox_depth{state="dead"}` | Invitations and payment links that never reached anyone. |
| `uboss_payment_rejections_total` | A verified event we refused. Security or finance signal. |
| `uboss_payments_unreconciled` | Money the provider may hold that no order records. |
| `uboss_recurring_occurrences_total{outcome="failed"}` | Charges not being taken. |
| `uboss_http_request_duration_seconds` p95 | Against the `<APPROVE>` latency target. |
| `uboss_http_errors_total{code="server"}` | Against the `<APPROVE>` error-rate target. |
| `uboss_low_stock_products` | Operational, not technical, but it is what the SOP's daily routine asks for. |

Alert thresholds are `<APPROVE>` and belong with the SLA, not in this file.

---

## 10. Known operational constraints

These are properties of MariaDB 10.4 (XAMPP), not oversights:

- **No `SKIP LOCKED`.** Job and schedule claiming use lease-based conditional
  updates instead. Correct, and proven by concurrency tests, but it does more
  round-trips under heavy contention than a 10.6+ deployment would.
- **No transactional DDL.** See §4.
- **`max_connections` is 151 by default.** The API and worker each open a pool
  of `DB_POOL_SIZE`. Count every process before scaling out.
- **Server timezone is `Asia/Calcutta` on this install.** The application pins
  its session to UTC and stores every instant in UTC, so this does not matter —
  but a DBA running ad-hoc queries will see local times.
