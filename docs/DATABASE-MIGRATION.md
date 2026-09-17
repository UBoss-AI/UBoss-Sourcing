# Migrations, schema drift, and getting the data out of XAMPP

Two related jobs, in one document because they share a rule:

> **The schema is built by `prisma migrate deploy` and never by importing a
> dumped schema. Only data moves, and only data on the allowlist.**

| For | Read |
|---|---|
| Which MariaDB, the configuration, the accounts, the connection budget | `docs/DATABASE-PRODUCTION.md` |
| Backups, restore rehearsals, point-in-time recovery, the database runbook | `docs/DATABASE-RECOVERY.md` |
| The whole deployment | `docs/DEPLOYMENT.md` |

---

## 1. The rules, before anything else

| Never | Why |
|---|---|
| `prisma migrate dev` against any database that matters | Interactive, offers to reset, rewrites migration files. In this repository it also renames eighteen foreign keys and drops defaults |
| `prisma db push` anywhere near production | No migration history, no review, no rollback story |
| DDL on application startup | The API runs as an account with no DDL rights, deliberately. If startup needed them, the account would have to have them permanently |
| Copy `C:\xampp\mysql\data` to Linux | InnoDB's on-disk format is version- and platform-specific, half of it is in the redo log, and a copy taken while the server is running is a copy mid-write |
| Edit a migration that has been applied | Prisma records a SHA-256 of each file. See section 6 |
| Import XAMPP's `mysql` database | It would replace production's accounts with four passwordless root logins |

| Always | |
|---|---|
| `prisma migrate deploy` | The only command that touches production's schema |
| Rehearse on `deploy/compat` first | MariaDB 11.4.13, strict, the same collation — `.\scripts\db\compat-test.ps1 -Reset` |
| `apply-grants.sh` after every migration | A new table arrives with no grant on it |
| Expand, backfill, then contract | Section 11 |

---

## 2. What is in the repository

| | |
|---|---|
| ORM | Prisma **7.10.0** (`prisma`, `@prisma/client`) |
| Adapter | `@prisma/adapter-mariadb` **7.10.0**, over the `mariadb` driver `^3.5.4` |
| Provider | `mysql` (there is no separate MariaDB provider) |
| Schema | `backend/prisma/schema.prisma`, 170 models, all with `@@map` |
| Migrations | `backend/prisma/migrations/`, **49** directories |
| CLI config | `backend/prisma.config.ts` — Prisma 7 removed `url` from the datasource block, so the CLI reads `DATABASE_URL` from here and the runtime uses the adapter. Both read the same variable, so they cannot drift onto different databases |
| Shadow database | `SHADOW_DATABASE_URL`, or `<database>_shadow` by default. Named rather than created and dropped per run, which keeps the required privileges narrow |
| Seed | `backend/src/seed/index.ts` |

`PRISMA_TARGET_TEST_DB=1` points the CLI at `TEST_DATABASE_URL`, which is how
the integration harness prepares its own database.

---

## 3. The rehearsal

Everything below assumes it has been run. It takes about seven minutes.

```powershell
.\scripts\db\compat-test.ps1 -Reset
```

| Step | What it proves |
|---|---|
| Container healthy | Crash recovery finished, not just the port answering |
| Both databases dropped and rebuilt from committed migrations only | A database that has never seen this application can reach today's schema from the repository alone — which is exactly what go-live does |
| `apply-grants.sh`'s generator applied | The least-privilege model works against the real table list |
| `prisma migrate diff` empty | The migrations and `schema.prisma` agree; no surprise migration is waiting |
| The test suite, as `uboss_app` | Strict mode, 11.4 collation, UTC, and no privilege the production account will not have |

Result on 2026-09-17 **[tested]**: all five, and **120 test files / 2 323 tests
passed** against MariaDB 11.4.13.

`-SkipTests` stops after the drift check, which is the fast loop while writing
a migration.

---

## 4. XAMPP 10.4 against production 11.4

The differences that change behaviour. Speed differences are not in this table
because they do not cause incidents.

| | XAMPP 10.4.32 | Production 11.4.13 | What it does |
|---|---|---|---|
| **`sql_mode`** | no strict member | `STRICT_TRANS_TABLES` | An over-long or badly-typed value is **rejected** instead of truncated. **This has already found a real defect** — see below |
| **Default collation** | `utf8mb4_general_ci` | `utf8mb4_uca1400_ai_ci` | A `CREATE DATABASE` without `COLLATE` gets a collation none of the tables use. A join across the two raises *Illegal mix of collations* at runtime |
| **Client binaries** | `mysqldump.exe`, `mysql.exe` | **only** `mariadb-dump`, `mariadb` | A script naming `mysqldump` fails with *command not found*. This was a live defect in `backup.sh` |
| `lower_case_table_names` | `1` (Windows) | `0` (Linux) | Identifiers become case-sensitive. **No impact**: all 170 models carry `@@map` and every table name is lower-case snake_case **[tested]** |
| Timezone | `Asia/Calcutta` | UTC | Only `NOW()` inside a migration and a person at a prompt; the driver pins its own session either way |
| `mysql.time_zone_name` | **empty** | loaded in the image; **must be loaded by hand on Ubuntu** | `CONVERT_TZ(..., 'Europe/Warsaw')` returns `NULL` where they are missing. The application does not use it — recurrence arithmetic is `Intl` in Node — but anybody debugging a schedule at a prompt gets silent nulls and believes the data is wrong |
| `max_allowed_packet` | 1 MB | 64 MB | A catalogue import or a GDPR export bundle exceeds 1 MB |
| Removed variables | — | `innodb_buffer_pool_instances`, `innodb_thread_concurrency` | **Accepted and ignored.** The server starts; `SHOW VARIABLES` does not list them. Removed from `uboss.cnf` |
| Binary log | off | on | Point-in-time recovery |
| Accounts | four, **all passwordless** | four, generated, none of them root | |

### What strict mode already found

Running the suite with the production `sql_mode` produced **26 failures across
two files**. The cause: `correlationId` was `CHAR(26)` — the width of a ULID —
in **ten** tables, while the API accepts a client-supplied `x-correlation-id`
of up to **64** characters and echoes it back. On 10.4 the extra characters
were dropped in silence. On 11.4 the insert fails with `ERROR 1406`, and
several of those writes are **inside a transaction** — so it would not merely
have lost an audit row, it would have rolled the order back with it.

Nothing in development would have shown this. It needed a customer or an API
gateway that stamps its own trace header, and a strict server. Fixed by
`20260916210000_correlation_id_matches_what_the_api_accepts`, which widens all
ten to `VARCHAR(64)`.

**That is what the compat container is for.** The next upgrade will produce a
list like it.

---

## 5. Schema drift

### What was found, and what it was

`prisma migrate status` says only that every migration has been applied. It
does **not** say that the migrations produce what `schema.prisma` describes,
and on 2026-09-16 they did not. Diffing a freshly-migrated 11.4 database
against the schema file found **17 tables with differences**:

| Difference | Count | What it actually was |
|---|---|---|
| Foreign keys with a different name | 18 | The migrations name them `fk_order_item_seller_offer`; Prisma's default is `order_items_sellerOfferId_fkey`. Functionally identical — nothing at runtime uses a constraint name |
| `categories.path` index | 1 | The database has a 768-character prefix index, because `VARCHAR(1024)` in `utf8mb4` is 4096 bytes and InnoDB's limit is 3072. MariaDB shortened it and warned. `schema.prisma` declared the full column |
| `users.pendingEmailNormalized` index | 1 | Created by `20260909233000_account_profile_contact_change_and_wishlist` and **never declared** in `schema.prisma` |
| `updatedAt` default | 4 tables | The database has `DEFAULT current_timestamp(3)`; the schema declared only `@updatedAt` |

**None of it was a live defect** — the database had everything the application
needed. It mattered because of what it would have caused *next*: Prisma
generates migrations by diffing `schema.prisma`, so the next `migrate dev`
would have produced a migration that **dropped `ix_user_pending_email`** as a
tidy-up of something nobody appeared to want. That index is read on every
request to change an email address, against `users`.

### How it was reconciled

**By changing `schema.prisma` to describe the database, not by changing the
database and not by touching migration history.** No migration was added,
edited or removed. The file now says:

```prisma
@@index([path(length: 768)], map: "ix_category_path")
@@index([pendingEmailNormalized], map: "ix_user_pending_email")
sellerOffer SellerOffer? @relation(..., map: "fk_cart_item_seller_offer")
updatedAt DateTime @default(now()) @updatedAt @db.DateTime(3)
```

Result: `prisma migrate diff` reports **No difference detected** against both a
freshly-migrated 11.4 database and the live XAMPP one **[tested]**.

CI now runs that diff on every pull request, so this cannot silently come back.

### If drift appears again

1. **Record it.** `npx prisma migrate diff --from-config-datasource --to-schema
   prisma/schema.prisma` — paste the output into the ticket.
2. **Find the source.** A migration that did something `schema.prisma` does not
   describe, or a hand-run `ALTER` against a database.
3. **Decide which side is right.** Usually the database: it is what the
   application has been running against.
4. **If the schema file is wrong, change the schema file.** Declarative only,
   no migration. That is what happened above.
5. **If the database is wrong, write a forward migration.** Never edit an
   applied one.
6. **Test on a copy** — `compat-test.ps1 -Reset`.
7. **Ask before touching migration history.** Do not run `migrate resolve` or
   delete a migration row on somebody else's say-so.

---

## 6. Migration history

### Its state today **[tested]**

| | |
|---|---|
| Directories on disk | 49 |
| Rows in `uboss._prisma_migrations` | 49, matching exactly |
| Started and never finished | 0 |
| Rolled back | 0 |
| Recorded but not in the repository | 0 |
| Content changed since it was applied | **0** |

### The line-ending thing, because it looks alarming

Comparing each recorded checksum against the file on disk: **33 match
byte-for-byte, 16 match only after normalising CRLF to LF.** Nothing has been
edited — those 16 were applied when the working copy had LF, and the copy on
this machine now has CRLF.

Prisma tolerates it: `migrate status` reports the database up to date, because
it re-checks with normalised line endings before complaining.

`.gitattributes` has `*.sql text eol=lf`, so a fresh checkout — CI, the VPS —
gets LF consistently, and the checksums recorded there will be stable. The
mixed state is confined to this one working copy, and disappears on
`git add --renormalize`.

**A genuinely edited migration is a different problem.** `migrate deploy` stops
with *"The migration ... was modified after it was applied"*, and the fix is
never to edit the row: work out what changed, and write a forward migration.

### `uboss_test` has a duplicate row

`uboss_test._prisma_migrations` records `20260914220000_marketplace_order_split`
**twice**. Local only, not in git, harmless to read — but it means the test
database cannot be used as a template for anything. It goes away when the test
database is rebuilt.

### Two migrations recorded with zero steps

`20260914220000_marketplace_order_split` and `20260914230000_seller_logo` have
`applied_steps_count = 0` in the local `uboss`. Both files are non-empty and
both applied cleanly to an empty 11.4 database, so the schema is correct; the
rows are the trace of a `migrate resolve --applied` at some point. No action —
recorded so the next person who notices does not go looking for a missing
column.

---

## 7. Getting data out of XAMPP

### Never the data directory

`C:\xampp\mysql\data` is InnoDB's own on-disk format: version-specific,
byte-order-specific, spread across `ibdata1` and the redo log, and any copy
taken while the server is running is a copy mid-write. Moved to a Linux
MariaDB 11.4 it produces a server that either refuses to start or starts and is
quietly wrong.

A logical export produces SQL text: portable across versions, readable,
diffable, restorable anywhere.

### The binary is not what you expect

XAMPP 10.4 ships **`mysqldump.exe`** and has no `mariadb-dump`. MariaDB 11.4
ships **only** `mariadb-dump`. `scripts\db\export-xampp.ps1` looks for both, in
that order, and so does `deploy/scripts/backup.sh`.

### Taking the export

```powershell
.\scripts\db\export-xampp.ps1 -Mode Full        # local rehearsal / disaster copy
.\scripts\db\export-xampp.ps1 -Mode Reference   # the only mode that may approach production
.\scripts\db\export-xampp.ps1 -Mode Schema      # structure, for comparison only
```

It refuses any host that is not loopback, reads the connection from
`backend\.env`, never puts the password on a command line, writes a `.sha256`
beside the dump, and **deletes a dump that has no completion marker** — a
truncated file that looks like a backup is worse than no backup.

The flags, and why each:

| Flag | Reason |
|---|---|
| `--single-transaction` | A consistent snapshot without locking. Works only because every table is InnoDB — on a MyISAM table it would silently give an inconsistent dump |
| `--quick` | Streams rows. Without it a large table can exhaust memory and produce a truncated file that still looks like a dump |
| `--default-character-set=utf8mb4` | Or Polish, Greek and German text comes back as question marks |
| `--hex-blob` | Binary columns survive a text round trip unambiguously |
| `--routines --triggers --events` | There are none today. Included so a future one is not silently dropped; `audit-xampp.ps1` warns if the count stops being zero |
| `--no-tablespaces` | Avoids needing `PROCESS`, which would also let the holder read every other connection's running query — other people's data in a `SHOW PROCESSLIST` |
| **not** `--master-data` / `--set-gtid-purged` | They belong to a replication setup this does not have, and would need privileges the backup account does not need |

Measured **[tested]**: full dump 32.3 MB, restores in 8 seconds.

### Never exported

`mysql`, `performance_schema`, `information_schema`, `sys`, `phpmyadmin`,
`test`. XAMPP's accounts, its privilege tables, its phpMyAdmin configuration.
None of it has an equivalent in production, and importing `mysql` would replace
production's four accounts with four passwordless root logins.

---

## 8. What data may go to production

### The allowlist

**An allowlist, not a denylist**, and that is the whole point: a denylist is
wrong the moment somebody adds a table, and the way it is wrong is that a table
of customers' data reaches production because nobody remembered to exclude it.

`-Mode Reference` carries exactly these twelve tables, and nothing that is not
named travels:

| Table | What it is |
|---|---|
| `countries`, `currencies` | The world |
| `tax_classes`, `vat_rates` | Rates the shop charges |
| `categories`, `category_translations`, `category_attribute_definitions` | The catalogue tree, in eight languages |
| `roles`, `permissions`, `role_permissions` | The access model |
| `feature_flags` | Which features are on |
| `shipping_methods` | Configured delivery options |

None of it is about a person, an order or a payment.

### Everything else, and what happens to it

| Class | Examples | Goes to production? |
|---|---|---|
| Reference / configuration | the twelve above | **Yes**, via `-Mode Reference` |
| Product catalogue | `products`, `product_variants`, `product_prices`, `product_media` | **Decide per deployment.** A buyer's own catalogue is theirs; the demo catalogue is not real. If it travels, re-import it from the source spreadsheet with `npm run catalog:import` rather than from a dump |
| Warehouses | `inventory_locations` | **Re-enter.** Five rows, with coordinates and delivery zones that must be right |
| Stock | `inventory_balances`, `inventory_movements` | **No.** Real stock is counted on the day, not imported from a laptop |
| Sellers and buyers | `seller_accounts`, `customer_profiles`, `buyer_organizations` | **No.** They sign up |
| Users | `users` | **No.** Never migrate a password hash from a development machine — `npm run db:rotate-seed-passwords` exists because the seeded ones are public |
| Orders, payments, refunds, settlements | | **No.** They are demo records. Two of them fail the validation checks precisely because they were seeded rather than checked out |
| Sessions and tokens | `sessions`, `auth_tokens` | **No.** A session from a laptop is a valid login to production |
| Secrets | `customer_erp_credentials`, `payment_provider_connections` | **No.** Encrypted with `SECRETS_ENCRYPTION_KEY`, which is different in production, so they would not decrypt anyway |
| Sandbox payments | `payment_events`, `payment_links` | **No.** Test-mode records against a live provider is a reconciliation problem with no clean end |
| Logs and audit | `audit_logs`, `login_attempts`, `logistics_location_pings` | **No.** Production's audit trail starts on production |
| Caches and queues | `job_queue`, `rate_limit_buckets`, `idempotency_records` | **No.** Regenerated |

---

## 9. Data validation

`scripts\db\validate-data.sql` — about 100 checks. Read-only, safe against
production, and it returns **no personal data**: counts and check names only,
so its output can be pasted into a ticket.

```powershell
.\scripts\db\validate-data.ps1                       # local, human-readable, exits non-zero on a failure
.\scripts\db\validate-data.ps1 -OutputPath before.tsv
# ... migrate ...
.\scripts\db\validate-data.ps1 -OutputPath after.tsv
Compare-Object (Get-Content before.tsv) (Get-Content after.tsv)
```

**The comparison is the point, not the single run.** A row count that fell
between the two reports is what a migration going wrong looks like.

Checks whose expected value is `0` are pass/fail. Checks marked `compare` — row
counts, the table count, the `number_sequences` high-water marks — never fail a
run on their own, because a row count is only meaningful against another.

| Family | What it catches |
|---|---|
| Shape | non-InnoDB tables, mixed collations, **any binary floating-point column** |
| Row counts | data lost in a migration |
| Referential integrity | orphans — reachable by loading a dump with `FOREIGN_KEY_CHECKS` off, or in the wrong order |
| Uniqueness and idempotency | duplicate SKUs, emails, order numbers, payment and refund idempotency keys, ERP push keys, webhook event ids, scheduled occurrences, stock-movement dedupe keys |
| Money | a total that is not the sum of its lines; paid > total; refunded > paid; a settlement whose net does not reconcile; an unknown currency; a payment in a different currency from its order; an impossible tax rate |
| Inventory | negative stock, negative reservations, more reserved than held, duplicate stock rows |
| Time | rows created in the future, updated before created, confirmed before placed, occurrences with no timezone |
| State machines | an order confirmed with no captured payment; delivered with no confirmation time; a completed occurrence with no order |
| Required fields | nullable columns the application treats as mandatory |
| **Tenant ownership** | a settlement line, order line or stock row belonging to a different seller from its parent |
| Media and geography | product media pointing at a missing asset; impossible warehouse coordinates |
| Migration state | unfinished, rolled back or duplicated migrations |

### What it found locally, and why it is not a defect

Two checks are non-zero against the development database **[tested]**:

```
orders whose subtotal <> sum of lines        = 2
confirmed orders with no captured payment    = 2
```

Both are the same two rows, `UB-DEMO-WG0AG8` and `UB-DEMO-G2R728`: seeded demo
orders, marked `CONFIRMED` with `paidMinor = 0`, which never went through a
checkout. They are on the never-export list in section 8, and the fact that the
validation catches them is the validation working.

Against a freshly migrated empty database, **every pass/fail check is zero**
— which CI asserts on every pull request, so a query that silently stops
matching a renamed column is caught.

---

## 10. CI

Every pull request, against **MariaDB 11.4.13** — the exact patch production
runs, pinned rather than floating.

| Step | Fails when |
|---|---|
| Ephemeral MariaDB 11.4.13, health-checked | it never becomes ready |
| Both databases created with explicit `COLLATE` | |
| `prisma generate` | the client cannot be generated |
| `prisma migrate deploy` on **both**, from empty | any migration SQL fails |
| `prisma migrate status` | history and files disagree |
| **`prisma migrate diff --exit-code`** | the migrations and `schema.prisma` disagree. Exit 2 is drift, exit 1 is "could not run" — separated, because they are different problems |
| **Destructive-migration review** | never fails; annotates the PR when a migration new on that branch contains `DROP`/`TRUNCATE`, so a reviewer sees it |
| **Least-privilege check** | `uboss_app` can `UPDATE`/`DELETE` `audit_logs`, or create a table, or **cannot** update `orders` |
| **Validation queries** | any pass/fail check is non-zero against the empty migrated database |
| Typecheck, lint, tests | separately, so a red mark names which |

CI uses a throwaway root password in the workflow file and never a production
credential.

---

## 11. Releasing a migration

### The order, and it is not negotiable

1. CI green.
2. **A backup exists and has been verified** — `docs/DATABASE-RECOVERY.md` §2.
3. The deployment lock is acquired (`release.sh`).
4. The migration job gets `MIGRATE_DATABASE_URL` — `uboss_migrate`, for this
   one command.
5. **`prisma migrate deploy`, exactly once.**
6. **`apply-grants.sh`** — a new table has no grant on it.
7. The new application version starts.
8. Readiness passes.
9. The worker starts, in a schema-compatible order.
10. Smoke tests.
11. The lock is released.
12. The migration credential is not in the running application's environment —
    `uboss-api@.service` reads the same file but the application only ever
    reads `DATABASE_URL`.

### Expand and contract

A migration must be compatible with the code that is **already running**,
because for a few seconds both versions are.

| Release | Does | Safe because |
|---|---|---|
| 1 — expand | add the column, nullable, with a default; add the index | Old code ignores it |
| 2 — backfill | fill it, in batches, as a job — **not in the migration** | A single `UPDATE` over a large table holds locks for its whole duration |
| 3 — use | new code reads and writes it; make it `NOT NULL` once it is full | |
| 4 — contract | drop the old column, in a **later release** | Nothing reads it any more |

### What must not happen in one release

- Renaming a column. That is a drop and an add, and the running code breaks
  between them. Add, backfill, switch, drop.
- Making a column `NOT NULL` in the same migration that adds it, if it has to
  be backfilled.
- A backfill inside the migration.
- A `DROP` in the same release as the code that stopped using the column.

### Rollback

**Code rolls back. Migrations do not.** `rollback.sh` swaps the symlink and
restarts; it does not reverse a migration, and it must not — an automatic
down-migration in the middle of an incident destroys data on the strength of a
script nobody read under pressure.

That is why expand-and-contract matters: if release *n* only added things,
release *n-1* still runs against the migrated database. If a migration itself
has to be undone, that is a restore, and it is `docs/DATABASE-RECOVERY.md`.

---

## 12. Cutover

### The rehearsal, in full, before the real thing

1. `.\scripts\db\export-xampp.ps1 -Mode Full` — checksum written.
2. `.\scripts\db\verify-restore.ps1 -DumpFile <that file>` — restores into a
   throwaway database on 11.4 and checks eleven things. **[tested]**: pass,
   8 seconds.
3. `.\scripts\db\compat-test.ps1 -Reset` — a clean database from committed
   migrations only.
4. Compare the two schemas — the restored copy and the migrated one.
5. Import **only** approved data into the clean migrated schema.
6. `.\scripts\db\validate-data.ps1` against both, and compare.
7. The test suite against the result.
8. Application smoke tests.
9. Keep the reports. Destroy the disposable environment, and only that.

### The real thing

| Step | Command |
|---|---|
| 1 | `bootstrap.sh`, `mariadb-secure-installation`, timezone tables |
| 2 | `CREATE DATABASE uboss CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;` — the `COLLATE` is not optional on 11.4 |
| 3 | The four accounts, four generated passwords |
| 4 | `DATABASE_URL="$MIGRATE_DATABASE_URL" npx prisma migrate deploy` |
| 5 | `apply-grants.sh` |
| 6 | Import the reference dump. Nothing else |
| 7 | `npm run db:reference` if the deployment wants the shipped reference data instead |
| 8 | `validate-data.sql`, compared against the local report |
| 9 | Warehouses, currencies and tax rates entered in the admin console by a person |
| 10 | Backup, then **restore it and prove it** |

**Prefer building the schema from migrations and importing approved data
separately over restoring a development database.** A blind full restore brings
demo orders, sandbox payments, laptop sessions and public password hashes into
production, and there is no clean way to take them out again afterwards.
