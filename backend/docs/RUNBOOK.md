# Operations runbook

Backup, restore, migration and incident procedures for the UBOSS Sourcing
backend.

> **The database layer now has three documents of its own**, and where they and
> this one touch, they are the detail and this is the procedure:
>
> | For | Read |
> |---|---|
> | Which MariaDB and why, its configuration, its four accounts, the connection budget | `docs/DATABASE-PRODUCTION.md` |
> | Migrations, schema drift, the XAMPP export, what data may travel, validation | `docs/DATABASE-MIGRATION.md` |
> | Backups, proving a backup restores, point-in-time recovery, the database runbook | `docs/DATABASE-RECOVERY.md` |
>
> Production runs **MariaDB 11.4 LTS**. Two things below changed with it: the
> dump binary is `mariadb-dump` (the mysql-named ones are gone), and the
> append-only audit log is set up by `deploy/scripts/apply-grants.sh` after the
> migration rather than by a `REVOKE` that MariaDB will not accept — §7.

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
#
# `mariadb-dump`, not `mysqldump`: MariaDB 11.4 no longer ships the mysql-named
# binaries at all, and a command naming the old one fails with
# "command not found". `deploy/scripts/backup.sh` detects whichever is present.
mariadb-dump \
  --single-transaction \
  --routines \
  --triggers \
  --events \
  --hex-blob \
  --no-tablespaces \
  --default-character-set=utf8mb4 \
  -u uboss_backup -p uboss \
  | gzip > "uboss-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
```

`--single-transaction` is what makes this safe on a live InnoDB database: the
dump sees one consistent snapshot without locking writers. Omitting it produces
a dump that can contain an order without its items.

### Frequency and retention

Both are `<APPROVE>` decisions, driven by the agreed RPO. Point-in-time
recovery requires binary logging, which MariaDB does not enable by default —
`deploy/mariadb/uboss.cnf` turns it on:

```ini
# my.ini  [mysqld]
log_bin = mysql-bin
binlog_format = ROW
expire_logs_days = <APPROVE>
```

Binary logging on its own is not recovery. The logs sit on the same disk as the
database, so they protect against a bad `UPDATE` and against nothing else.
`deploy/scripts/ship-binlogs.sh`, driven by `uboss-binlog.timer`, closes the
current log every fifteen minutes and copies the completed ones off the machine,
encrypted with the same passphrase as the nightly dump.

**That interval is the recovery point objective.** With the timer running, a
lost machine costs about fifteen minutes of orders; without it, everything since
last night's dump. On a system that takes card payments those are different
kinds of morning.

It fetches the logs over the MySQL protocol as a replica would, rather than
reading `/var/log/mysql` — so it needs no root and no filesystem access, and a
compromised application cannot use it as a path to either. Set
`UBOSS_BINLOG_URL` in `/etc/uboss/backup.env`, pointing at a user created for
this and nothing else:

```sql
CREATE USER 'uboss_binlog'@'localhost' IDENTIFIED BY '<long random>';
GRANT REPLICATION SLAVE, REPLICATION CLIENT, RELOAD ON *.* TO 'uboss_binlog'@'localhost';
```

No `SELECT` on any table: it reads the log of changes, never the data.

To restore to a moment rather than to last night: restore the dump, then replay
the decrypted logs up to just before the damage.

```bash
gpg --batch --decrypt -o mysql-bin.000123 mysql-bin.000123.gpg
mariadb-binlog --stop-datetime='2026-09-16 14:29:00' mysql-bin.000123   | mariadb -u root -p uboss
```

### Object storage

Product media and export files are **not** in the database dump. Under
`STORAGE_DRIVER=s3`, enable bucket versioning and a lifecycle policy. Under
`STORAGE_DRIVER=local` there is no durability at all, which is why
`config/env.ts` refuses to start in production with it.

### Encryption and off-site, which the automation enforces

The manual command above writes a plaintext dump, which is right for a scratch
restore on a machine you control and wrong for anything you keep. The nightly
job in `deploy/scripts/backup.sh` therefore does two further things, and a run
that cannot do them reports failure rather than succeeding quietly:

- **AES-256 on everything it writes** — the dump, the media archive and a copy
  of `.env` — with a SHA-256 written beside each file. The dump is every
  customer, address, order and invoice in the system; it must not sit in a
  directory in clear text.
- **A verified off-site copy.** `rclone copy` followed by `rclone check`, to a
  destination on a *different provider or account*. A copy the same compromised
  password can delete is not an off-site backup.

Both are configured in `/etc/uboss/backup.env` (root-owned, 0600):
`UBOSS_BACKUP_PASSPHRASE` and `UBOSS_OFFSITE_REMOTE`. The binary-log shipper
reads the same file for `UBOSS_BINLOG_URL`.

**Store the passphrase somewhere that survives losing the machine.** It is
deliberately not in the backups, and without it they are noise.

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
3. **Decrypt the dump, then restore it** into a clean `uboss`. Files written by
   the nightly job are `db-<stamp>.sql.gz.gpg` with a `.sha256` beside them —
   check the hash before trusting the bytes, because a half-finished transfer
   looks exactly like a complete one.
   ```bash
   sha256sum -c db-<stamp>.sql.gz.gpg.sha256
   gpg --batch --decrypt -o db.sql.gz db-<stamp>.sql.gz.gpg
   gunzip -c db.sql.gz | mariadb -u root -p uboss
   ```
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
- [ ] Create **four** accounts — application, migration, backup, binary log —
      and use none of them as root. The full grants are in
      `docs/DATABASE-PRODUCTION.md` §6; `deploy/scripts/bootstrap.sh` prints
      the block to paste.
- [ ] **Make the audit trail append-only, and do it in the right order.**

      The obvious form of this does not work, and it is worth knowing why
      before somebody deletes the line to get past the error:

      ```sql
      GRANT SELECT, INSERT, UPDATE, DELETE ON uboss.* TO 'uboss_app'@'localhost';
      REVOKE UPDATE, DELETE ON uboss.audit_logs FROM 'uboss_app'@'localhost';
      -- ERROR 1147: There is no such grant defined for user 'uboss_app'
      --             on host 'localhost' on table 'audit_logs'
      ```

      **A privilege granted at database level cannot be revoked at table
      level.** So the application gets `SELECT, INSERT` on the database, and
      `UPDATE, DELETE` per table — on everything except `audit_logs` and
      `_prisma_migrations`. That is what `deploy/scripts/apply-grants.sh` does,
      generating the table list from the database so a new table is not missed,
      and refusing to exit cleanly if either protected table is still writable.

      It runs **after** `prisma migrate deploy`, never before — there is no
      table to protect until the migration has made one. `release.sh` runs it
      after every migration from then on.
- [ ] Bind MariaDB to `127.0.0.1`. Never expose 3306 publicly.
- [ ] TLS terminated in front of the API. `trustProxy` is on in production and
      narrowed to `loopback`, so it trusts the nginx hop and nothing beyond it.
      **This only works alongside `proxy_set_header X-Forwarded-For $remote_addr`**
      in `deploy/nginx/snippets/uboss-proxy.conf`, which discards the client's
      own header. Appending to it instead lets a caller choose its own
      `request.ip` and walk through the per-IP rate limit and the login lockout.
- [ ] `/metrics` on an internal port or behind a network policy. It is
      unauthenticated by design (a scraper has no session) and exposes no
      customer data, but it does reveal system shape.
- [ ] Rotate `SECRETS_ENCRYPTION_KEY` only with a re-encryption plan — every
      `credentialsEnc` value is bound to the current key.
- [ ] Configure the gateway's dashboard webhook against the public endpoint
      for whichever gateway is active, with the matching signing secret:
      - Razorpay -> `/api/v1/payments/webhooks/razorpay`, secret
        `RAZORPAY_WEBHOOK_SECRET`. Subscribe to `payment.captured`,
        `order.paid`, `payment.failed`, `refund.processed`, `refund.failed`.
      - Stripe -> `/api/v1/payments/webhooks/stripe`, secret
        `STRIPE_WEBHOOK_SECRET` (the `whsec_` value). Subscribe to
        `payment_intent.succeeded`, `payment_intent.payment_failed`,
        `charge.refunded`, `refund.updated` and `refund.failed`. Do **not**
        add `charge.succeeded`: it reports the same capture as
        `payment_intent.succeeded` under a different event id, so the
        duplicate guard would not catch it and the order would be credited
        twice.
      Stripe rejects a delivery signed more than five minutes ago, so the
      server's clock must be in step - check NTP before blaming the secret.
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
