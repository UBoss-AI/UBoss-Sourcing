# The UBOSS database in production

Everything about the database layer that is decided rather than obvious: which
MariaDB, why that one, how it is configured, who may connect to it as what, how
many connections there are, and what has actually been tested.

This document is the authority for the database. Where it touches another:

| For | Read |
|---|---|
| Getting the data out of XAMPP and into production, and what may travel | `docs/DATABASE-MIGRATION.md` |
| Backups, restore rehearsals, point-in-time recovery, the runbook for a database that is unwell | `docs/DATABASE-RECOVERY.md` |
| The whole deployment — server, nginx, TLS, releases, compliance | `docs/DEPLOYMENT.md` |
| Backup policy and incident response as operational procedure | `backend/docs/RUNBOOK.md` |
| Running the thing on a developer's machine | `SETUP.md` |

**Status of this document.** Everything labelled **[tested]** was run on
2026-09-16 and 2026-09-17 against MariaDB 11.4.13 in `deploy/compat`, on a
Windows development machine, with the repository at commit `47f0e8e` plus the
changes described here. Nothing in it has been run against a production VPS,
because there is not one yet. Section 16 lists what still has to happen once
there is.

---

## 1. What is actually installed today

| | Development | Production (planned) |
|---|---|---|
| Engine | MariaDB **10.4.32** (XAMPP, Windows) | MariaDB **11.4.13** (Ubuntu, native) |
| Support | **Ended 2024-06-18** | To **2029-05-29** |
| Installed by | XAMPP | `deploy/scripts/bootstrap.sh` |
| `sql_mode` | `NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION` — **not strict** | strict, pinned in `deploy/mariadb/uboss.cnf` |
| Server collation | `utf8mb4_general_ci` | `utf8mb4_unicode_ci`, pinned |
| Table collation | `utf8mb4_unicode_ci` on all 171 tables | same |
| Timezone | `SYSTEM` → `Asia/Calcutta` | `+00:00` |
| Binary log | off | on |
| Accounts | four, **all without passwords** | four, all with generated passwords, none of them root |
| Port | `0.0.0.0:3306` | `127.0.0.1:3306`, firewalled |

**XAMPP is a development tool and stays one.** It is not installed on the VPS,
its `my.ini` is not copied there, its accounts are not exported there, and its
phpMyAdmin is not deployed there. The only thing that travels is data, and only
data that appears on the allowlist in `docs/DATABASE-MIGRATION.md` section 8.

---

## 2. What the schema is made of

Measured, not assumed — `scripts\db\audit-xampp.ps1` produces this and writes a
JSON copy under `.dev-logs/db-audit/`.

| | Count | Why it matters |
|---|---|---|
| Tables | 171 (170 models + `_prisma_migrations`) | |
| Size | 80.7 MB with a seeded catalogue | A logical dump is the right tool at this size; see section 14 for when it stops being |
| Foreign keys | 241 | |
| CHECK constraints | 216 | A restore that loses these accepts rows the real database refuses |
| UNIQUE constraints | 136 | |
| Views, triggers, routines, events | **0 / 0 / 0 / 0** | Nothing carries a `DEFINER`, so a dump is portable between servers without rewriting anything |
| Generated columns | 0 | |
| Full-text indexes | 0 | Search is `LIKE` and application-side; no `ngram`/parser dependency to reproduce |
| `FLOAT` / `DOUBLE` / `REAL` columns | **0** | Money is `BIGINT` minor units throughout — section 9 |
| `DECIMAL` columns | 36 | Tax rates, `Decimal(9,6)` |
| `DATETIME` columns | 547 | All UTC |
| `TIMESTAMP` columns | **0** | Nothing silently re-interprets on a server-timezone change |
| Storage engine | InnoDB, `DYNAMIC`, on every table | `--single-transaction` gives a genuinely consistent dump |

That list is the reason the migration is as simple as it is. A schema with
triggers and events would need a different export plan and a different restore
procedure.

---

## 3. Which MariaDB, and why

### The decision

> **MariaDB 11.4 LTS. Pin the newest maintained 11.4 patch at deployment time.
> Tested here on 11.4.13.**

### How the candidates compare

| Candidate | Community support ends | Prisma 7 | Risk from XAMPP 10.4 | On Ubuntu | Backup tooling | Operational complexity | Decision |
|---|---|---|---|---|---|---|---|
| **10.4.32** (what XAMPP runs) | **ended 2024-06-18** | supported | none — it is the source | not packaged | `mysqldump` | lowest | **No.** Out of support means no security fixes. Nothing else about it matters |
| 10.6 LTS | **ended 2026-07-06** | supported | small | `apt` on 22.04 | `mariadb-dump` | low | **No.** Also out of community support |
| 10.11 LTS | 2028-02-16 | supported | small | **packaged in Ubuntu 24.04** | `mariadb-dump`, `mariabackup` | low | **Second choice.** One `apt install` and no third-party repository, but eighteen months less runway |
| **11.4 LTS** | **2029-05-29** | documented as supported (`11.0+`) | **[tested]** — 49 migrations, 2 323 tests | MariaDB's own apt repository, for 24.04 | `mariadb-dump`, `mariabackup` | low | **Chosen** |
| 11.8 LTS | 2028-06-04 | supported | untested here | MariaDB repository | same | low | **No.** Newer and supported for *less* time than 11.4 — see below |
| 12.3 LTS | 2029-06-12 | not listed | untested | MariaDB repository | same | medium | **No.** Released 2026-05-28. Four months old, and nothing is gained over 11.4 |
| Managed EU MariaDB | provider's | supported | different shape entirely | n/a | provider's | **higher cost, lower operational risk** | **Later.** Section 14 has the triggers |

### Why 11.4 and not something newer

The counter-intuitive part, and the reason the decision is not "take the newest
LTS": **MariaDB shortened its LTS support window from five years to three,
starting after 11.4.** So 11.4, released in May 2024, is supported until May
2029, while 11.8, released a year later, is supported only until June 2028.
Choosing the newer release would buy newer features and *lose* almost a year of
security fixes.

12.3 LTS runs to June 2029 — two weeks longer than 11.4 — and is four months
old. Two weeks is not worth being among the first to run a major release
under a payment system.

So the choice is between 10.11 and 11.4, and 11.4 wins on runway: February 2028
against May 2029. Both are one `apt` source away on Ubuntu 24.04.

### What was actually tested **[tested]**

| Test | Result |
|---|---|
| All 49 committed migrations applied to an **empty** 11.4.13 database | Pass — `All migrations have been successfully applied` |
| `prisma migrate diff` between that database and `schema.prisma` | **No difference detected** |
| Backend test suite against 11.4.13, as the least-privileged runtime account | **120 files, 2 323 tests, all passed** |
| `deploy/mariadb/uboss.cnf` boots 11.4.13 | Pass — no unknown variable, no deprecation warning, every setting took effect |
| A XAMPP 10.4 logical dump restored onto 11.4.13 | Pass — 171 tables, `CHECK TABLE` clean, collation intact, 8 s |
| The least-privilege grant model | Pass — `audit_logs` UPDATE/DELETE denied, DDL denied, ordinary writes allowed |

### Known incompatibilities between 10.4 and 11.4

All four were found here, on a laptop, rather than in production. Each is
handled; they are listed because the next upgrade will produce a list like it.

| What changed | Effect | Handled by |
|---|---|---|
| `sql_mode` gains `STRICT_TRANS_TABLES` | A value too long for its column is **rejected** rather than truncated | Pinned in `uboss.cnf`; the full story, including the defect it already found, is in `docs/DEPLOYMENT.md` §13 |
| Default collation becomes `utf8mb4_uca1400_ai_ci` | A `CREATE DATABASE` without an explicit `COLLATE` gets a collation none of the tables use, and a join across the two raises *Illegal mix of collations* at runtime | `collation-server` pinned; every `CREATE DATABASE` in this repository spells `COLLATE` out |
| The `mysql*`-named client binaries are gone | `mysqldump` is not installed. A script that names it fails with *command not found* | `deploy/scripts/backup.sh` now detects `mariadb-dump` first. This was a live defect — the nightly backup would have failed silently on the upgrade |
| `innodb_buffer_pool_instances`, `innodb_thread_concurrency` removed | **Accepted and ignored.** The server starts; `SHOW VARIABLES` does not list them | Removed from `uboss.cnf`. A setting that is accepted and ignored is worse than one that errors |

### Review

| Field | Value |
|---|---|
| Series | 11.4 LTS |
| Tested patch | 11.4.13 (`mariadb:11.4.13`, digest pinned in `deploy/compat/docker-compose.yml`) |
| Support source | https://endoflife.date/mariadb — community support to 2029-05-29 |
| Prisma source | https://www.prisma.io/docs/orm/v7/reference/supported-databases — MariaDB `10.0+`, `11.0+` |
| Upgrade strategy | Patch releases within 11.4 monthly, after the rehearsal in section 3 of `docs/DATABASE-MIGRATION.md`. A **major** upgrade is a project, not a patch window |
| Review date | **2028-05-29**, one year before support ends — or immediately if a 11.4 CVE is published with no fix |

---

## 4. Where it runs, and what that is not

MariaDB runs on the same Hostinger KVM 4 as the API, the worker and nginx.

**This is a cost decision, not an availability design.** One VPS means:

- no failover — if the machine is gone, the service is gone until it is rebuilt
- no read replica — every query competes with every other for the same four cores
- a backup restore is the *only* recovery path, so its tested duration **is**
  the recovery time
- maintenance on the database is downtime for the whole product

Say this plainly to anybody who asks about uptime. Section 14 has the triggers
for moving the database onto its own machine, and `docs/DEPLOYMENT.md` §24 has
the shape it moves into.

---

## 5. The compatibility-test environment

`deploy/compat/` holds a Docker Compose stack running the exact production
MariaDB, pinned by digest, for one job: proving something works on 11.4 before
it is done on the VPS.

**It is not the production deployment method.** Production installs MariaDB
natively; `bootstrap.sh` does that.

```powershell
cd deploy\compat
Copy-Item .env.database.example .env     # then generate four passwords
cd ..\..
.\scripts\db\compat-test.ps1 -Reset      # full rehearsal, ~7 minutes with tests
```

| Property | Value | Why |
|---|---|---|
| Image | `mariadb:11.4.13` **pinned by digest** | A floating tag moves under you, and a compatibility test whose database changed has tested nothing |
| Port | `127.0.0.1:3307` | Not `0.0.0.0` — Docker writes its own Windows firewall rule, and this database would otherwise be on the café wifi. Not 3306, so it can never be mistaken for XAMPP |
| Volume | named, `uboss-compat-data` | A bind mount of an InnoDB datadir onto Windows is slow and, on some Docker Desktop builds, wrong about `fsync` |
| Health check | the image's `healthcheck.sh --connect --innodb_initialized` | Waits for crash recovery, not just for the port |
| Accounts | the same four as production, with the same grants | A privilege the application needs and does not have should fail here |
| Passwords | from `deploy/compat/.env`, gitignored | The compose file refuses to start rather than inventing a default |
| Settings | `deploy/compat/mariadb-compat.cnf` | Small memory, but strict mode / collation / UTC / binlog identical to production |

What the rehearsal does, and the order is the point:

1. Waits for genuine health, not an open port
2. **Drops and rebuilds both databases from committed migrations only** — which
   is what go-live actually does
3. Applies the per-table grants, which cannot be applied before the tables exist
4. Proves `prisma migrate diff` is empty
5. Runs the test suite against it, as `uboss_app`

---

## 6. Accounts and least privilege

Four accounts. The application's credential must not be able to change the
schema, and must not be able to rewrite what it did.

| Account | Used by | Privileges | Where its password lives |
|---|---|---|---|
| `uboss_app` | API, worker | `SELECT, INSERT` on the database; `UPDATE, DELETE` **per table**, not on `audit_logs` or `_prisma_migrations` | `DATABASE_URL` in `/srv/uboss/shared/.env` |
| `uboss_migrate` | `prisma migrate deploy`, during a release only | `ALL PRIVILEGES` on the database. Nothing server-wide | `MIGRATE_DATABASE_URL`, same file, read by `release.sh` and never by the API |
| `uboss_backup` | the nightly dump | `SELECT, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER` on the database, and **nothing at the server level** — see below | `UBOSS_BACKUP_DATABASE_URL` |
| `uboss_binlog` | `ship-binlogs.sh` | `REPLICATION SLAVE, BINLOG MONITOR, RELOAD` server-wide. **No `SELECT` on any table** — it reads the log of changes, never the data | `UBOSS_BINLOG_URL` in `/etc/uboss/backup.env` |

`root` is reachable over the local socket only, is never in a connection
string, and is used by a person at a prompt. Remote root login is off;
anonymous users and the `test` database are removed by
`mariadb-secure-installation`.

**The backup account has no server-level privilege, and that was checked rather
than assumed** **[tested]**. With exactly those five database-scoped grants,
`mariadb-dump --single-transaction --quick --routines --triggers --events
--hex-blob --no-tablespaces` completes with no warnings and a proper
`Dump completed` marker. The two usually granted here and deliberately absent:

- **`PROCESS`** would be needed to dump tablespace definitions — which is why
  `backup.sh` passes `--no-tablespaces`. It also lets the holder read every
  other connection's running query in `SHOW PROCESSLIST`, which on this schema
  means other people's names, addresses and order amounts.
- **`RELOAD`** is for `--flush-logs` and **`BINLOG MONITOR`** for
  `--master-data`. Neither flag is used; those belong to a replication setup
  this does not have. The binary logs are shipped separately by `uboss_binlog`,
  which in turn has no `SELECT` on any table.

### The append-only audit log, and the trap in it

The obvious way to write this does not work, and it failed loudly enough to be
worth recording:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON uboss.* TO 'uboss_app'@'localhost';
REVOKE UPDATE, DELETE ON uboss.audit_logs FROM 'uboss_app'@'localhost';
--  ERROR 1147 (42000): There is no such grant defined for user 'uboss_app'
--                      on host 'localhost' on table 'audit_logs'
```

**A privilege granted at database level cannot be revoked at table level.** The
database grant is one row in `mysql.db`; there is no per-table row to subtract
from. MariaDB and MySQL have always behaved this way.

That was the documented procedure in this repository until 2026-09-16. It would
have failed at go-live, in the middle of the account-creation block, with two
of four accounts made — and if anybody had worked around it by dropping the
`REVOKE`, the audit log would have been writable by the application for the
life of the system.

The working arrangement, which `deploy/scripts/apply-grants.sh` implements:

1. Grant `SELECT, INSERT` at database level.
2. After `prisma migrate deploy`, grant `UPDATE, DELETE` on **each table
   individually**, skipping `audit_logs` and `_prisma_migrations`.
3. Verify — the generator ends by naming each protected table and whether it is
   still writable, and the script exits non-zero if either is.

The table list comes from `information_schema`, not from a list somebody
maintains, so a migration that adds a table is handled. `release.sh` runs it
after every migration; **a new table arrives with no grant on it**, and the
symptom is a feature that works in CI and fails in production with
`ERROR 1142: UPDATE command denied`.

Proven on 11.4.13 **[tested]**, and re-proven on every pull request by the CI
step *"The application account cannot rewrite its own audit log"*:

| As `uboss_app` | Result |
|---|---|
| `SELECT FROM audit_logs` | allowed |
| `UPDATE audit_logs` | **denied** — `ERROR 1142` |
| `DELETE FROM audit_logs` | **denied** — `ERROR 1142` |
| `CREATE TABLE` | **denied** — `ERROR 1142` |
| `UPDATE orders` | allowed |

### Emergency access

If every application credential is lost or compromised: connect as `root` over
the local socket from an SSH session, rotate with `ALTER USER ... IDENTIFIED
BY`, update `/srv/uboss/shared/.env`, restart the four units. The database does
not need to stop. If SSH itself is unavailable, Hostinger's hPanel browser
console is the way in — confirm it works **before** you need it.

---

## 7. Server configuration

`deploy/mariadb/uboss.cnf`, installed as
`/etc/mysql/mariadb.conf.d/99-uboss.cnf`. Every setting in it carries its
reason, its cost and how to check it; this table is the summary.

The memory budget first, because it is the constraint everything else sits
inside. **16 GB, and the database is not the only tenant:**

| | Budget |
|---|---|
| 3 API instances | up to 3 GB |
| 1 worker | up to 1.5 GB |
| nginx | ~0.2 GB |
| OS and page cache | ~2 GB |
| **MariaDB** | **6 GB** buffer pool + ~1 GB overhead |
| Headroom | ~2 GB |

6 GB is not the 70–80 % a dedicated database server would get, and should not
be. This box is not a dedicated database server.

| Setting | Value | Reason | Verify | Default |
|---|---|---|---|---|
| `sql_mode` | strict, spelled out | Behaviour, not speed. Pinned so a future default cannot change it silently | `SELECT @@sql_mode` | 11.4's own |
| `collation-server` | `utf8mb4_unicode_ci` | 11.4 changed the default; a database created without `COLLATE` would get a different one | `SELECT @@collation_server` | `utf8mb4_uca1400_ai_ci` |
| `default_time_zone` | `+00:00` | Every instant is UTC `DATETIME(3)` | `SELECT @@time_zone` | `SYSTEM` |
| `innodb_buffer_pool_size` | `6G` | Holds the catalogue, its indexes and hot orders in memory | `Innodb_buffer_pool_read%` ratio under 0.1 % | `128M` |
| `innodb_flush_log_at_trx_commit` | `1` | **Do not change.** A commit means "this card was charged" | — | `1` |
| `sync_binlog` | `1` | Makes point-in-time recovery trustworthy | — | `0` |
| `innodb_log_file_size` | `1G` | Checkout and the catalogue importer write in bursts | — | `96M` |
| `innodb_flush_method` | `O_DIRECT` | Stops the kernel caching a copy of the buffer pool | — | `fsync` |
| `innodb_io_capacity` / `_max` | `2000` / `4000` | NVMe. Lower on anything else | `iostat -x 5`, `%util` | `200` / `2000` |
| `max_connections` | `200` | Section 11's budget, with room for a rolling restart | `Max_used_connections` | `151` |
| `wait_timeout` | `600` | A crashed client holds its locks until reaped | — | `28800` |
| `table_open_cache` | `4000` | 171 tables × the connections above | `Opened_tables` climbing | `2000` |
| `thread_cache_size` | `64` | Backup, monitor and migration connect briefly and often | `Threads_created` | `0` |
| `tmp_table_size` / `max_heap_table_size` | `128M` each | An admin report that spills to disk goes from ms to seconds. Both must be set — the lower wins | `Created_tmp_disk_tables` | `16M` |
| `max_allowed_packet` | `64M` | Catalogue import and GDPR export bundles | — | `16M` |
| `transaction_isolation` | `REPEATABLE-READ` | Stock reservation depends on it — section 9 | — | same |
| `open_files_limit` | `32768` | `table_open_cache` × `max_connections` consume descriptors. MariaDB may raise it further on its own | `SELECT @@open_files_limit` | `1024`-ish |
| `performance_schema` | `OFF` | Costs ~400 MB of a budget that has other tenants. Turn on temporarily to investigate | — | `OFF` |
| `slow_query_log` / `long_query_time` | on / `1` | Statements only; Prisma sends parameters separately, so bound values do not appear | `/var/log/mysql/slow.log` | off |
| `log_bin` / `binlog_format` | on / `ROW` | Point-in-time recovery | — | off |
| `binlog_expire_logs_seconds` | `604800` | **Not** `expire_logs_days`, which is deprecated. Setting both makes retention depend on parse order | `SHOW BINARY LOGS` | `864000` |
| `bind-address` | `127.0.0.1` | A security control, not a tuning knob | `ss -lntp \| grep 3306` | `*` |
| `skip-name-resolve` | on | No reverse DNS on a VPS; every connection would wait for a failing lookup | — | off |

**None of these numbers has been load-tested.** They are reasoned from the
schema and the machine, and each row names how to check it. `[LT]` in
`docs/DEPLOYMENT.md` §26 tracks that.

**Do not turn on the general query log.** It records parameters, which on this
schema means customer names, addresses and order amounts, in a file with
different permissions from the database.

---

## 8. Character set, collation and time

### One collation, chosen and tested

`utf8mb4` / `utf8mb4_unicode_ci`, on the server, on every database and on all
171 tables.

| Property | Behaviour | Consequence |
|---|---|---|
| Case sensitivity | **insensitive** (`_ci`) | `ACME-100` and `acme-100` are the same SKU. Two sellers cannot list SKUs that differ only in case, which is what a buyer expects |
| Accent sensitivity | **sensitive** — `utf8mb4_unicode_ci` compares `ż` and `z` as different | A Polish product name sorts and matches as written |
| Emails | compared case-insensitively | The application also stores `emailNormalized` and puts the `UNIQUE` index on that, so uniqueness does not depend on the collation |
| Ordering | UCA 4.0.0 | Polish, Greek and German sort correctly |

Why not the 11.4 default `utf8mb4_uca1400_ai_ci`: it is **accent-insensitive**,
so `zaba` and `żaba` would be one value. For a catalogue in a language where
the diacritic changes the word, and for SKUs, that is wrong. It would also mean
converting 171 tables for no benefit.

**The trap, and it is the one that will catch somebody:** `CREATE DATABASE` on
11.4 without an explicit `COLLATE` gets `utf8mb4_uca1400_ai_ci`, not this. A
join between a column in each raises *Illegal mix of collations* at runtime. So
`collation-server` is pinned, and every `CREATE DATABASE` in this repository —
CI, the compat init script, the restore rehearsal — spells it out.

`categories.path` is `VARCHAR(1024)`, which is 4096 bytes in `utf8mb4` and over
InnoDB's 3072-byte index limit. MariaDB does not refuse the index; it shortens
it to the 768 characters that fit and warns. Both 10.4 and 11.4 do the same
thing, and `schema.prisma` now declares `@@index([path(length: 768)])` so the
declaration matches reality.

### Time

- **Every instant is UTC**, in `DATETIME(3)`. There are **no `TIMESTAMP`
  columns** — which matters, because `TIMESTAMP` is re-interpreted against the
  session timezone on read and `DATETIME` is not. Do not add one.
- The server runs at `+00:00`, and the driver pins its session to `Z`
  (`backend/src/infra/prisma.ts`).
- Wall-clock recurrence carries its **own IANA timezone column**. A standing
  order is "06:00 in `Europe/Warsaw`", never "04:00 UTC" — the second drifts by
  an hour twice a year.
- The arithmetic is done in Node, in `backend/src/domain/recurrence.ts`, using
  `Intl`. It does **not** use `CONVERT_TZ`, which is fortunate: XAMPP's
  `mysql.time_zone_name` table is **empty**, so named zones do not resolve at a
  SQL prompt there at all. The official MariaDB image has them loaded; a native
  Ubuntu install needs `mariadb-tzinfo-to-sql`, and section 16's checklist
  includes it.
- DST is covered by tests, including Warsaw specifically: the autumn transition
  where the UTC instant must move from 04:00Z to 05:00Z so that the local time
  stays 06:00, and the local times on the spring-forward day that do not exist
  and the autumn day that happen twice — `backend/tests/unit/recurrence.test.ts`.

---

## 9. Money and inventory

The schema is already right about this. Recorded so that a future change does
not quietly make it wrong.

| Rule | How it is held | Verified |
|---|---|---|
| Money is never a binary float | `BIGINT` minor units on every monetary column | **0** `FLOAT`/`DOUBLE`/`REAL` columns in the whole schema |
| Money crosses the API as a string | `bigIntAsNumber: false` on the adapter | `backend/src/infra/prisma.ts` |
| Currency travels with the amount | `currency CHAR(3)` on `orders`, `payment_transactions`, `refunds`, `seller_offers`, `seller_settlements`, `products` | validated against `currencies` |
| Tax rates are exact | `Decimal(9,6)` percent | 36 decimal columns |
| Rounding is defined in one place | half-up, per line, in the pricing service | |
| A scheduled basket is priced once | `quoteSchedule`, called by both the review screen and the worker that charges weeks later | `CLAUDE.md` |
| Multi-row money and stock changes are transactional | `prisma.$transaction`, and stock is claimed with `SELECT ... FOR UPDATE` | |

`transaction_isolation = REPEATABLE-READ` is load-bearing here: stock
reservation reads a balance `FOR UPDATE` and writes it in the same transaction,
and the gap locks that make that safe behave differently under `READ
COMMITTED`. The failure mode of getting this wrong is overselling under load.

### Idempotency

Every duplicate the specification asks about is prevented by a `UNIQUE` index
that already exists:

| Against | Index |
|---|---|
| Duplicate payment attempts | `payment_transactions.uq_payment_idempotency_key`, `uq_payment_provider_payment_id` |
| Duplicate refunds | `refunds.uq_refund_idempotency_key`, `uq_refund_provider_id` |
| Duplicate platform orders | `orders.uq_order_number` |
| One occurrence charged twice | `orders.uq_order_schedule_occurrence`, `schedule_occurrences.uq_occurrence_idempotency`, `uq_occurrence_schedule_run` |
| Duplicate ERP pushes | `erp_order_pushes.uq_erp_push_idempotency`, `uq_erp_push_order`, `uq_erp_push_occurrence` |
| Replayed webhooks | `payment_events.uq_payment_event_provider_id`, `erp_webhook_receipts`, `customer_erp_webhook_events`, `carrier_webhook_events` |
| Double stock movements | `inventory_movements.uq_inventory_movement_dedupe` |
| Duplicate shipment events | `logistics_shipment_events.uq_logistics_event_external`, `uq_logistics_event_idempotency` |
| Generic request replay | `idempotency_records.uq_idempotency_scope_key` |

A `UNIQUE` index in MySQL treats every `NULL` as distinct, which would defeat
several of these. The schema handles it with `variantKey` — the variant ULID,
or `''` for the base product, never `NULL`.

`scripts\db\validate-data.sql` checks every one of these as data as well as
structure, because an index dropped during a forced restore is exactly how a
customer ends up charged twice.

---

## 10. Tenant isolation

Buyers, buyer organisations, sellers, logistics partners and admins share one
database. Ownership is enforced in the backend, and the database carries the
foreign keys that make the check possible.

| Held by | Owner column | Scoped uniqueness |
|---|---|---|
| Seller listings | `seller_offers.sellerAccountId` | `uq_seller_offer_sku (sellerAccountId, sellerSku)` — two sellers may list the same manufacturer part number, which is normal trade |
| Seller stock | `seller_inventory.sellerAccountId` + `offerId` | |
| Seller orders | `seller_order_groups.sellerAccountId` | `uq_seller_order_number` |
| Settlements | `seller_settlements.sellerAccountId` | `uq_seller_settlement_reference` |
| Buyer ERP connections and credentials | `customer_erp_connections.customerProfileId` | |
| Buyer organisations | `buyer_organization_members (organizationId, customerProfileId)` | |
| Logistics | `logistics_shipments`, `logistics_partner_users`, … carry `logisticsPartnerId` | |
| Audit | `audit_logs.actorUserId` and the actor type | |

**The database cannot enforce this on its own.** MariaDB has no row-level
security; a `sellerAccountId` column stops a row being orphaned, not a seller
reading another seller's row. Every read path takes the tenant from the
verified session, never from an id in the request. That is a backend rule and
it is covered by tests.

`validate-data.sql` includes three cross-tenant checks that would catch a
leak that had already happened — a settlement line whose order group belongs to
a different seller, an order line whose offer does, seller stock against
another seller's offer. All zero **[tested]**.

---

## 11. Connections

Counted across every process, not sized for one.

| Component | Instances | Pool each | Max connections | Notes |
|---|---|---|---|---|
| API | 3 (`uboss-api@4000/4001/4002`) | `DB_POOL_SIZE` = 12 | 36 | One `PrismaClient` per process, created at module load |
| Worker | 1 (`uboss-worker`) | 12 | 12 | Its own client; `WORKER_CONCURRENCY` = 4 jobs share the pool |
| Scheduler | — | — | 0 | Inside the worker process, not separate |
| Migration job | 1, briefly, during a release | 1–2 | 2 | `uboss_migrate`, one command |
| Nightly backup | 1, briefly | 1 | 1 | `uboss_backup` |
| Binary-log shipping | 1, every 15 min | 1 | 1 | `uboss_binlog` |
| Monitoring | 1 | 1 | 1 | `monitor.sh` |
| A person at a prompt | 1 | 1 | 2 | Keep this headroom |
| **Steady state** | | | **~55** | |
| **Rolling restart** — old and new instances overlap | | | **~91** | The peak that actually has to fit |
| UBOSS AMS, if it later shares this box | `<DECIDE>` | `<DECIDE>` | **budget before installing it** | Redo this table first |
| **`max_connections`** | | | **200** | |

Utilisation at peak is 46 %. The margin exists so that a failing rolling
restart is not *also* a connection-refused incident.

Rules the code already follows, and must keep following:

- **One `PrismaClient` per process.** Created once in `src/infra/prisma.ts`,
  never per request. A client per request creates a pool per request.
- **Acquisition timeouts are finite.** `acquireTimeout` and `connectTimeout`
  are both `DB_CONNECT_TIMEOUT_MS` (10 s). An infinite wait turns a saturated
  pool into an unbounded request queue and then an out-of-memory kill.
- **Readiness fails safely.** `/health/ready` runs `SELECT 1` and reports
  latency; a database that is down produces a readiness failure, not a retry
  storm. `checkDatabase()` in `src/infra/prisma.ts`.
- **Shutdown disconnects.** `disconnectPrisma()` on SIGTERM, so a restart
  returns its connections rather than leaving them for `wait_timeout`.
- **Startup does not stampede.** The pool fills lazily; three API instances
  starting together do not open 36 connections at once.

Before raising `DB_POOL_SIZE` or adding an API instance, redo this table. A
pool that cannot get a connection surfaces as a timeout in the middle of a
checkout, not as a database alert.

---

## 12. Monitoring

What must be watched. Thresholds and routing are in `docs/DEPLOYMENT.md` §18;
this is the database-specific list and where each number comes from.

| Watch | Source | Why it is on the list |
|---|---|---|
| MariaDB process alive | `systemctl is-active mariadb` | |
| Readiness | `/health/ready` | Catches "the database is up and the application cannot reach it" |
| Active connections | `Threads_connected` | Against the 200 in section 11 |
| Peak connections | `Max_used_connections` | Within 20 of `max_connections` means the next rolling restart fails |
| Pool acquisition wait | application metric | The first symptom of saturation, before any error |
| Aborted connections | `Aborted_connects`, `Aborted_clients` | A climbing count is usually an authentication failure or a network problem |
| Slow queries | `/var/log/mysql/slow.log` | |
| Long-running transactions | `information_schema.INNODB_TRX` where `trx_started` is old | One of these blocks everything behind it |
| Deadlocks | `SHOW ENGINE INNODB STATUS` | Expected occasionally; a rising rate is a lock-ordering bug |
| Lock waits | `Innodb_row_lock_waits`, `_time_avg` | |
| Buffer pool hit rate | `Innodb_buffer_pool_read_requests` vs `_reads` | Falling means the working set no longer fits |
| Temporary disk tables | `Created_tmp_disk_tables` | A report that started spilling to disk |
| Query throughput | `Questions` | For capacity, and for noticing a stampede |
| Disk space | `df -h` on the data and log volumes | **A full disk stops MariaDB.** Alert at 75 % |
| Inodes | `df -i` | A separate way to run out of disk |
| Disk latency | `iostat -x` | The trigger for moving off a shared VPS |
| Binary-log growth | `du -sh /var/log/mysql` | A catalogue import can produce gigabytes in an afternoon |
| Database size | `information_schema.TABLES` | Capacity, and backup duration |
| Table growth | per-table row counts | Which table is driving it |
| Backup success | `uboss-backup.service` exit code | |
| **Backup age** | newest file at the off-site destination | The number that matters. A backup job that silently stopped looks exactly like one that is working |
| **Restore-test age** | the last `verify-restore` report | An untested backup is a hope |
| Corruption | `mariadb-check` on a schedule | |
| Replication lag | — | Only when there is a replica |

**What must not be logged.** The slow log records statements, and Prisma sends
parameters separately, so bound values do not appear. The general query log
does record them, and on this schema that is customer names, addresses, order
amounts and ERP credentials in a file with different permissions from the
database. `/var/log/mysql` is `mysql:adm`, `0750`, and is included in the
encrypted off-site backup — which means it is personal data under retention
policy, and `backend/docs/DATA-PROTECTION.md` covers it.

---

## 13. Security

| Control | State | Where |
|---|---|---|
| Bound to loopback | `bind-address = 127.0.0.1` | `deploy/mariadb/uboss.cnf` |
| 3306 not in the firewall | ufw opens 22, 80, 443 and nothing else | `bootstrap.sh` |
| Anonymous users removed | `mariadb-secure-installation` | go-live step 1 |
| `test` database removed | same | |
| Remote root login off | same | |
| Application cannot do DDL | `uboss_app` has no `CREATE`/`ALTER`/`DROP` | **[tested]** |
| Application cannot rewrite the audit log | per-table grants | **[tested]**, and on every pull request |
| Passwords generated, never defaults | 24+ random bytes each, four different ones | section 6 |
| Credentials outside git | `/srv/uboss/shared/.env`, `0600`, owned by the service user; `.gitignore` covers every `.env` | |
| Datadir permissions | `mysql:mysql`, `0750` | packaged default |
| Backups encrypted before leaving the disk | GPG, passphrase via fd 3 so it is not in `ps` | `backup.sh` |
| Backups off-site, different provider | rclone, and the job **fails** if it cannot | `backup.sh` |
| TLS on the database connection | **not needed today** — API and database are on one host over loopback. **Required the day the database moves**, with certificate verification, not just encryption | section 14 |
| Credential rotation | `ALTER USER`, update `.env`, restart. No downtime | section 6 |
| Administrative access audited | SSH via key only; `sudo` logged; `auth.log` shipped | `bootstrap.sh` |
| Patching | 11.4 patch releases monthly, after the rehearsal | `docs/DATABASE-MIGRATION.md` §3 |
| phpMyAdmin | **not installed.** Do not | below |

**phpMyAdmin.** A permanently public installation is a database admin console
on the internet protected by one password, and XAMPP's configuration ships with
a `pma` account that has no password at all. Neither goes near the VPS. When a
graphical client is genuinely wanted, tunnel to it:

```bash
ssh -L 3307:127.0.0.1:3306 uboss@vps      # then connect a local client to 127.0.0.1:3307
```

The tunnel is authenticated by the SSH key, closes with the session, and leaves
3306 bound to loopback.

---

## 14. When one VPS stops being enough

Move the database to its own machine, or to a managed EU service, when any of
these is true. Check them quarterly.

| Trigger | Measure | Threshold |
|---|---|---|
| CPU contention | database CPU as a share of the box | > 40 % sustained |
| Memory pressure | swap in use | anything sustained |
| Disk latency | `iostat -x` await | > 10 ms sustained |
| Storage growth | database size | > 40 GB, or doubling in a quarter |
| Backup duration | nightly dump | > 20 minutes |
| **Restore duration** | `verify-restore` | **exceeds the agreed RTO** |
| Availability | measured uptime | below the SLO in `docs/DEPLOYMENT.md` §6 |
| Recovery point | binary-log shipping interval vs what the business accepts | RPO tightens below 15 minutes |
| Scale-out | API instances | more than 3, or a second application host |
| A second tenant | UBOSS AMS installed on this box | on installation — redo section 11 first |
| Volume | orders per day | > 5 000 |
| Failover | the business needs it | the day somebody asks |

The target shape is a separate EU database — its own VPS, or managed — with a
primary/replica pair, automated failover, a pooler in front, cross-zone backups
and a disaster-recovery environment that is tested rather than assumed.

**Replication is not a backup.** A replica applies your mistakes faithfully and
instantly. A `DELETE` without a `WHERE` is on the replica before you have
finished reading the error. Backups and point-in-time recovery stay exactly as
they are when a replica is added.

---

## 15. What is still open

| # | Item | Owner | Blocking? |
|---|---|---|---|
| D1 | Exact 11.4 patch at deployment time — re-pin CI, `deploy/compat` and this document in the same commit | Tech owner | No |
| D2 | Load test against 11.4.13 with production settings. Every number in section 7 is reasoned, none measured | Tech owner | **Before high volume** |
| D3 | Retention for `audit_logs` and `logistics_location_pings` — both grow without limit and both hold personal data | Data protection adviser | **Before go-live** (GDPR) |
| D4 | Off-site backup provider and region — must be EU, and a different provider from the VPS | Business owner | **Before go-live** |
| D5 | Agreed RTO and RPO. The design gives ~15 min RPO and an RTO of the restore duration; nobody has agreed those are acceptable | Business owner | **Before go-live** |
| D6 | Whether UBOSS AMS will share this VPS | Business owner | Before installing it |
| D7 | Who holds the backup passphrase, and where it survives losing the machine | Business owner | **Before go-live** |
| D8 | Restore-test cadence — this document proposes monthly | Tech owner | No |

---

## 16. After the VPS is bought

In order. Nothing here can be done before there is a machine.

1. `bootstrap.sh` — installs MariaDB from the 11.4 repository, applies
   `uboss.cnf`, hardens the box.
2. `mariadb-secure-installation`.
3. Load the timezone tables: `mariadb-tzinfo-to-sql /usr/share/zoneinfo | mariadb mysql`
   — without them `Europe/Warsaw` does not resolve at a SQL prompt.
4. Create the database with an explicit `COLLATE utf8mb4_unicode_ci`, and the
   four accounts, with four generated passwords (`bootstrap.sh` prints the
   block).
5. `prisma migrate deploy` as `uboss_migrate`.
6. `apply-grants.sh` — **this is the step that makes the audit log
   append-only**, and it cannot run earlier.
7. Import approved data only — `docs/DATABASE-MIGRATION.md` §8.
8. `validate-data.sql`, and compare against the same report taken locally.
9. Configure and run a backup, then **restore it into a scratch database and
   prove it** — `docs/DATABASE-RECOVERY.md` §2.
10. Confirm `ss -lntp | grep 3306` shows `127.0.0.1` only, and that 3306 is
    unreachable from outside.
11. Record the measured restore duration against D5.
