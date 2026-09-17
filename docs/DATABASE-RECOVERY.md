# Backups, restores and the database runbook

What to do when the database is the problem, and what has to be true beforehand
for any of it to work.

| For | Read |
|---|---|
| Which MariaDB, configuration, accounts, connection budget, monitoring | `docs/DATABASE-PRODUCTION.md` |
| Migrations, schema drift, getting data out of XAMPP | `docs/DATABASE-MIGRATION.md` |
| Backup policy and incident response as operational procedure | `backend/docs/RUNBOOK.md` |
| The whole deployment | `docs/DEPLOYMENT.md` |

---

## 1. The strategy, and why it has three layers

**Hostinger's weekly VPS snapshot is not a database backup strategy.** It is
weekly, so it can lose seven days of orders; it is a whole-machine image, so
restoring it to recover one deleted table means reverting the entire server;
it is held by the same provider as the VPS, so a compromised or closed account
takes both; and nobody has ever restored one. Keep it — it is a useful last
resort for the machine — and do not count it as the database's backup.

| Layer | Tool | Recovers | Frequency | Where it goes |
|---|---|---|---|---|
| **Logical** | `mariadb-dump`, gzip, GPG | one table, one row, or everything; portable between versions | nightly | encrypted, off-site, 14 kept on the box |
| **Physical** | `mariadb-backup` | the whole instance, fast, at volume | when a logical restore becomes too slow — section 6 | same |
| **Point-in-time** | binary logs | to the minute before a mistake | shipped every 15 minutes | encrypted, off-site |
| *(machine)* | Hostinger snapshot | the VPS | weekly, the provider's | the provider's |

The recovery point the design gives is **about 15 minutes** — the binary-log
shipping interval. The recovery time is **the measured restore duration**,
which is why section 2 measures it.

### Logical backup

`deploy/scripts/backup.sh`, on `uboss-backup.timer`. It dumps with
`--single-transaction` (consistent, non-locking, and only valid because every
table is InnoDB), verifies the file, encrypts it, ships it, and **exits
non-zero if it cannot** — so a failure is recorded by the timer and somebody is
told, rather than quietly leaving the only copy on the machine it protects.

Three checks before it calls the file a backup: a size floor, `gzip -t`, and
the `Dump completed` marker that a truncated dump does not have. **None of them
proves the data is correct** — only section 2 does that.

It runs as `uboss_backup`, which can read every row and change none.

### Physical backup

`mariadb-backup` (formerly `xtrabackup`) copies InnoDB's files while the server
runs and is far faster to restore at volume. It is **not** set up today, and at
80 MB it would be premature: the logical restore takes 8 seconds. Section 6 has
the trigger.

### Point-in-time recovery

`log_bin` is on, `binlog_format = ROW`, `sync_binlog = 1`, retention 7 days via
`binlog_expire_logs_seconds`. `deploy/scripts/ship-binlogs.sh` copies them
off the machine every 15 minutes as `uboss_binlog`, an account with
`REPLICATION SLAVE, BINLOG MONITOR, RELOAD` and **no `SELECT` on any table** —
it reads the log of changes, never the data.

The nightly dump gets you to 02:30. The binary log gets you to the minute
before the mistake. Section 4.

### Off-site

Non-negotiable, and enforced: `backup.sh` refuses to write an unencrypted dump
and fails the run if it cannot reach the remote.

| Requirement | How |
|---|---|
| Encrypted before it leaves the disk | GPG, passphrase on fd 3 so it is never in `ps` output |
| A different provider or account from the VPS | a copy the same compromised password can delete is not off-site |
| Separate credentials | an rclone remote with its own key |
| Restricted permissions | write and list; ideally not delete |
| Versioning / immutability | where the provider offers it — the defence against ransomware that encrypts the backups too |
| Retention | 14 daily on the box; off-site lifecycle per D3 in `docs/DATABASE-PRODUCTION.md` §15 |
| Checksums | every dump has a `.sha256` |
| **Age monitoring** | the number that matters. A job that silently stopped looks exactly like one that is working |
| Failure alerts | non-zero exit, surfaced by the timer |
| GDPR | a dump is every customer, address, order and invoice. It is personal data, it has a retention period, and an Art. 17 erasure has to account for the copies — `backend/docs/DATA-PROTECTION.md` |

**Never keep the only backup on the same disk as the database.** It protects
against a bad `UPDATE` and nothing else — not a failed volume, not a deleted
VPS, not ransomware.

**The passphrase must survive losing the machine.** It is deliberately not in
the backups. A passphrase stored beside the ciphertext protects nothing; one
stored only on the server protects nothing once the server is gone.

---

## 2. Proving a backup works

> **A backup that has not been restored is not a backup. It is a file with a
> hopeful name.**

The failures that make a dump useless are all invisible until somebody tries:
a truncation nobody noticed, a character set that mangled Polish text, rows
loaded before the tables they point at, a schema too old for today's code.

```powershell
.\scripts\db\verify-restore.ps1 -DumpFile .dev-logs\db-exports\uboss-full-20260916-233845.sql
```

It restores into a **throwaway database it names itself** on the local
MariaDB 11.4 container — the same version production runs — and asks eleven
questions:

| # | Check | A failure means |
|---|---|---|
| 1 | SHA-256 matches the recorded one | the file changed after it was written. Do not trust it |
| 2 | The `Dump completed` marker is present | it stopped early |
| 3 | It loads without error | |
| 4 | Every table the dump declares arrived | rows or tables were dropped on the way in |
| 5 | Every table is InnoDB | |
| 6 | `CHECK TABLE` passes on all of them | the pages or indexes are damaged |
| 7 | One `utf8mb4_unicode_ci` collation throughout | a mixed restore, which will raise *Illegal mix of collations* later |
| 8 | Non-ASCII text survived | the dump or the load went through latin1 and every Polish diacritic is now `?`. Counted by `CHAR_LENGTH <> LENGTH`, which collapses to zero when that happens |
| 9 | Migration history restored, and its count matches the repository | |
| 10 | `prisma migrate diff` is empty | the backup predates the current schema — migrate it before use. Exit 2 is that; exit 1 is "the check could not run", and they are reported differently |
| 11 | The validation queries run and are compared | |

It records the **restore duration** — the recovery time objective made real,
not "we have backups" but "we can be serving orders again in *n* minutes" —
and the **recovery point**, the age of the dump.

### Safeguards

It runs `DROP DATABASE`, so:

- It takes **no host parameter**. The only server it will talk to is the named
  local container.
- The target name is generated: `uboss_restore_check_<timestamp>`. It cannot
  collide with `uboss`, `uboss_test`, or anything a person named.
- Before dropping, it re-checks the prefix and refuses anything else.
- `-KeepDatabase` leaves it in place and prints how to remove it.

### Result on 2026-09-16 **[tested]**

A 32.3 MB XAMPP 10.4 dump, restored onto MariaDB 11.4.13: **11 checks passed,
0 failed, 8.1 seconds.** 171 tables, `CHECK TABLE` clean, collation intact,
Polish text intact, schema matching `schema.prisma`.

### Cadence

| When | What |
|---|---|
| Monthly | `verify-restore` on the newest off-site backup — **fetched from off-site**, not the local copy, so the fetch path is tested too |
| Quarterly | A full point-in-time recovery rehearsal — section 4 |
| After any schema change that is not purely additive | Restore the previous night's backup and confirm check 10 |
| Before any deliberately destructive migration | Take a backup and verify it first |
| After changing the backup script, the passphrase or the remote | Immediately |

**Record the date and the duration each time.** Restore-test age is on the
monitoring list for a reason: an untested backup is a hope.

---

## 3. Restoring for real

### Before anything

1. **Stop writing.** `sudo systemctl stop uboss-api@4000 uboss-api@4001
   uboss-api@4002 uboss-worker`. Restoring under live traffic produces a
   database that is neither the backup nor the current state.
2. **Take a backup of the broken database first**, even if it is broken. It is
   the only copy of whatever happened, and it is what an investigation needs.
3. **Decide what you are recovering to.** Last night's dump? A specific minute?
   That decides whether section 4 is involved.
4. **Write down the time.** Every step below wants it later.

### Into a scratch database first

Restore into `uboss_recovery`, look at it, and only then decide. It costs
minutes and it is the difference between a recovery and a second incident.

```bash
# The dump is encrypted and gzipped.
gpg --batch --passphrase-fd 3 --decrypt db-20260916-023000.sql.gz.gpg 3< /path/to/passphrase \
  | gunzip > /tmp/restore.sql

sha256sum -c /path/to/db-20260916-023000.sql.gz.sha256   # before trusting it

sudo mariadb -e "CREATE DATABASE uboss_recovery CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
sudo mariadb --default-character-set=utf8mb4 uboss_recovery < /tmp/restore.sql

sudo mariadb -N -B uboss_recovery < /srv/uboss/current/scripts/db/validate-data.sql
```

The `COLLATE` is not optional on 11.4, and `--default-character-set=utf8mb4` on
the way **in** matters as much as on the way out.

### Then, and only then, over the real one

**This destroys the current database. There is no undo.**

```bash
sudo mariadb -e "DROP DATABASE uboss;
                 CREATE DATABASE uboss CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
sudo mariadb --default-character-set=utf8mb4 uboss < /tmp/restore.sql
sudo bash /srv/uboss/current/deploy/scripts/apply-grants.sh
```

`apply-grants.sh` is easy to forget and the symptom is bad: the restored
database has no per-table grants, so the application starts and then fails
every write with `ERROR 1142`.

### Afterwards

1. `prisma migrate status` — if the backup predates a release, apply the
   missing migrations with `migrate deploy`.
2. `validate-data.sql`, compared against the last good report.
3. Start the API, then the worker.
4. `/health/ready` on all three ports.
5. Smoke tests: sign in, open the catalogue, add to a cart, view an order.
6. **Reconcile payments.** A restore to an earlier point loses orders that were
   paid after it. The provider has them and the database does not —
   `backend/docs/RUNBOOK.md` has the reconciliation procedure. This is the step
   that gets skipped and the one that produces a customer charged for an order
   nobody can find.
7. Check what the scheduler is about to do. Occurrences whose `plannedRunAt`
   passed during the outage are overdue, and the worker will catch up on all of
   them at once — `validate-data.sql` counts them.
8. Write down the restore duration and the recovery point.

---

## 4. Point-in-time recovery

For the case the nightly dump cannot handle: a bad `UPDATE` at 14:20, noticed
at 15:00. Restoring the 02:30 dump loses twelve hours of real orders.

**The principle:** the dump gets you to 02:30; the binary logs replay
everything from 02:30 up to 14:19:59, and stop.

```bash
# 1. Restore the base dump into a scratch database. Section 3.

# 2. Find the position the dump was taken at, and the logs since.
sudo mariadb-binlog --base64-output=DECODE-ROWS -v \
  /var/log/mysql/mysql-bin.000123 | less          # find the statement and its timestamp

# 3. Replay up to the moment before it.
sudo mariadb-binlog --stop-datetime="2026-09-16 14:19:59" \
  /var/log/mysql/mysql-bin.0001{23,24,25} | sudo mariadb uboss_recovery

# 4. Check it. Then, if it is right, promote it as in section 3.
```

`mariadb-binlog`, not `mysqlbinlog` — the mysql-named tools are gone in 11.4.
`ship-binlogs.sh` already detects both.

**Rehearse this quarterly.** Doing it for the first time during an incident,
against logs whose retention you have not checked, is how a recovery becomes an
outage. The rehearsal also proves the shipped logs are actually readable —
`sync_binlog = 1` makes them trustworthy, and nothing makes them present.

---

## 5. When a restore verification fails

| Check | Usual cause | Do |
|---|---|---|
| SHA-256 | the file was truncated in transfer, or the wrong `.sha256` is beside it | Re-fetch from off-site. **Do not restore it.** If a second copy also mismatches, the backup job wrote it wrong — investigate before the next run |
| No completion marker | the dump ran out of disk or the connection dropped | Check free space at the time, and `Aborted_clients`. Take a fresh dump immediately; you currently have no valid backup |
| It will not load | a version mismatch, or a partial file | Read the first error, not the last — the rest are consequences |
| Missing tables | the dump was taken with an explicit table list, or the account could not read them all | Check which account took it. `uboss_backup` needs `SELECT, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER` |
| `CHECK TABLE` fails | corruption on the source, or a damaged transfer | Restore an older backup and compare. If the source is corrupt, take the machine out of service — `mariadb-check --check-upgrade --all-databases` |
| Mixed collations | a database created without an explicit `COLLATE` on 11.4 | Recreate with `COLLATE utf8mb4_unicode_ci` and reload. It will raise *Illegal mix of collations* at runtime otherwise |
| Non-ASCII text gone | the dump or the load went through latin1 | The dump is unusable for a Polish catalogue. Re-take with `--default-character-set=utf8mb4` and reload the same way |
| Migration count differs | the backup predates a release | Expected on an old backup. `migrate deploy` after restoring |
| Schema does not match | same | Same. If it fails on **last night's** backup, something has changed the production schema outside migrations — stop and investigate |
| Validation non-zero | compare against the source report first | Non-zero in both is a pre-existing data problem, not a restore defect |

---

## 6. When to add physical backups

`mariadb-backup` instead of, or alongside, the logical dump when:

| Trigger | Why |
|---|---|
| The dump takes more than 20 minutes | It holds a consistent read view for its whole duration, and the undo log grows behind it |
| **The restore takes longer than the agreed RTO** | The number that actually decides this. Measure it — `verify-restore` prints it |
| The database passes ~20 GB | Reloading SQL text stops being the fast way |
| A replica is added | `mariadb-backup` is how a replica is seeded |

Keep the logical dump when you add it. It is the only one that can restore a
single table, is readable, and is portable between MariaDB versions — which is
what makes an upgrade recoverable.

---

## 7. Runbook

The failures that present as "the database is down", and what each one actually
is.

### Connection refused

```bash
systemctl status mariadb
ss -lntp | grep 3306                      # expect 127.0.0.1:3306 and nothing else
sudo tail -100 /var/log/mysql/error.log
df -h /var/lib/mysql /var/log/mysql       # a full disk stops MariaDB
```

MariaDB refusing to start after a config change names the offending variable in
the error log. If it is out of disk, see below — do not delete files from
`/var/lib/mysql`.

### Pool acquisition timeout

The application is waiting for a connection it cannot get.

```bash
sudo mariadb -e "SHOW GLOBAL STATUS LIKE 'Threads_connected';
                 SHOW GLOBAL STATUS LIKE 'Max_used_connections';"
sudo mariadb -e "SELECT trx_id, trx_started, TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS seconds,
                        trx_rows_modified, LEFT(trx_query, 120) AS query
                   FROM information_schema.INNODB_TRX ORDER BY trx_started;"
```

Almost always one long transaction holding locks, not genuine load. Find it,
understand it, and only then `KILL` it. Raising `DB_POOL_SIZE` treats the
symptom and brings you closer to `max_connections` — redo the budget in
`docs/DATABASE-PRODUCTION.md` §11 before touching it.

### Too many connections

The database is refusing new ones, including yours. `max_connections = 200`
leaves administrative headroom precisely for this — connect over the local
socket as root and look at `SHOW PROCESSLIST`. If a process is leaking
connections, restarting that unit returns them immediately.

### Authentication failure

`Access denied for user 'uboss_app'@'localhost'`. Either the password in
`/srv/uboss/shared/.env` no longer matches, or the **host part** of the account
is wrong — an account created as `@'%'` is not the same account as `@'localhost'`,
and a connection over `127.0.0.1` may match either depending on
`skip-name-resolve`. Check with:

```bash
sudo mariadb -e "SELECT User, Host FROM mysql.global_priv ORDER BY User, Host;"
```

Never print or paste the password. Rotate with `ALTER USER`, update `.env`,
restart the units.

### `ERROR 1142: command denied`

Not a bug — the least-privilege model working. Either a migration added a table
and `apply-grants.sh` has not run (run it), or a runtime path is issuing DDL,
which it must not. **Do not widen the grant to make it go away.**

### DNS resolution failure

Only relevant once the database is on another host. Until then the connection
string is `127.0.0.1` and there is no lookup. When it moves: prefer an IP or a
hosts entry over a name that depends on a resolver being up during an incident.

### Disk full

**A full disk stops MariaDB and can corrupt an in-flight write.**

```bash
df -h; df -i                              # inodes run out separately
du -sh /var/lib/mysql /var/log/mysql /srv/uboss/backups
```

Usual culprits, in order: binary logs after a bulk import, the slow query log,
old backups on the box. Purge binary logs **through MariaDB**, never with `rm`
— removing the files behind its back leaves the index pointing at logs that no
longer exist:

```bash
sudo mariadb -e "PURGE BINARY LOGS BEFORE NOW() - INTERVAL 3 DAY;"
```

Confirm the off-site copy exists first.

### Read-only filesystem

The kernel has remounted it read-only after an I/O error. **Stop.** Do not
restart MariaDB hoping it clears. Check `dmesg`, take a snapshot if the
provider allows, and treat the storage as suspect — this is the case where the
off-site backup is the plan.

### Corrupt tables

```bash
sudo mariadb-check --check --all-databases       # read-only, safe
```

`mariadb-check --repair` does not apply to InnoDB. The InnoDB recovery path is
`innodb_force_recovery` in escalating steps, and it is a last resort: **restore
from backup first**, and use forced recovery only to extract data a backup does
not have. Take a filesystem copy of the datadir before touching it.

### Long-running queries

```bash
sudo mariadb -e "SELECT ID, USER, TIME, LEFT(INFO, 200) FROM information_schema.PROCESSLIST
                  WHERE COMMAND <> 'Sleep' AND TIME > 30 ORDER BY TIME DESC;"
```

`KILL <id>` ends the query; a transaction it is inside still has to roll back,
and the rollback can take as long as the work did. Check the slow log for the
pattern afterwards — one slow query at 03:00 is a report, the same one every
minute is a missing index.

---

## 8. What is not covered

| | |
|---|---|
| High availability | There is none. One VPS. `docs/DATABASE-PRODUCTION.md` §14 |
| Automatic failover | None |
| A tested disaster-recovery environment | Not built. The restore rehearsal is the nearest thing |
| Physical backups | Not configured — section 6 |
| Replica lag | No replica |

**Replication is not a backup**, for when it exists: a replica applies your
mistakes faithfully and instantly. A `DELETE` without a `WHERE` is on the
replica before you have finished reading the error.
