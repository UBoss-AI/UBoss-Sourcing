# Incident and recovery readiness

What has to be true, and proven, before go-live: backups restore, somebody is
told when something breaks, and everyone knows who decides what during an
incident. This page collects what the software provides and lists what **the
operator** has to fill in and rehearse. Nothing on this page is a claim that a
rehearsal has happened. The record at the end says when one has.

Related: `docs/DATABASE-RECOVERY.md` (backup layers and restores),
`docs/DEPLOYMENT.md` §6 (availability targets, RPO, RTO, severity),
`backend/docs/RUNBOOK.md` §8 (symptom-by-symptom incident steps).

## 1. What the software already does

| Need | Where | Proven by |
| --- | --- | --- |
| Nightly encrypted backup, off-site copy, failure exits non-zero | `deploy/scripts/backup.sh`, `uboss-backup.timer` | The script refuses to finish without a verified off-site copy |
| Point-in-time recovery (RPO about 15 minutes) | `deploy/scripts/ship-binlogs.sh`, `uboss-binlog.timer` | `docs/DATABASE-RECOVERY.md` §4 |
| Restore verification on a developer machine | `scripts/db/verify-restore.ps1` | 11 checks, last run 2026-09-16 on a development dump |
| Restore verification on the server, into a scratch database only | `deploy/scripts/verify-restore.sh` | Writes one evidence line per run (section 4) |
| Alert when backups, restore tests, queues, certificates or the scanner fail | `deploy/scripts/monitor.sh` every 5 minutes, calls `UBOSS_ALERT_COMMAND` | Alerts on the age of the newest backup and of the last passing restore test |
| Health endpoints | `GET /health/live`, `GET /health/ready` (database and dependencies) | `tests/integration/anonymous-access.test.ts`, `security-regressions.test.ts` |
| Metrics for queues, payments, reconciliation, encryption | `GET /metrics` (Prometheus) | `infra/metrics.ts` |
| Security signals | Fraud and risk review queue (admin → Risk review), sign-in alerts, audit log | `tests/integration/risk-signals.test.ts` |
| Audit of operational and security actions | Append-only `audit_logs` (database grant) | CI step "The application account cannot rewrite its own audit log" |

## 2. Severity levels

Use the four levels in `docs/DEPLOYMENT.md` §6.3 (S1 site or checkout down or a
suspected breach, S2 one surface down, S3 degraded, S4 cosmetic). A suspected
personal-data breach is always S1, because the notification clock starts when
it is discovered.

## 3. Who owns which alert — **the operator fills this in**

Leave no row blank at go-live. "Nobody" is an answer the go-live review should
refuse.

| Alert or event | Source | Owner (name) | Backup owner | How they are reached |
| --- | --- | --- | --- | --- |
| Site or API down (S1) | `monitor.sh` → `UBOSS_ALERT_COMMAND`; external uptime check | _to be named_ | _to be named_ | _phone / pager_ |
| Payment webhooks failing or amount mismatch | `monitor.sh`, `/metrics`, admin payments health | _to be named_ | _to be named_ | |
| Backup failed or older than threshold | `uboss-backup.timer` failure, `monitor.sh` | _to be named_ | _to be named_ | |
| Restore test overdue | `monitor.sh` (`UBOSS_RESTORE_TEST_MAX_DAYS`) | _to be named_ | _to be named_ | |
| High or critical risk signal | Admin bell → Risk review | _to be named (risk owner)_ | _to be named_ | |
| Suspected account compromise or breach | Sign-in alerts, risk signals, reports | _to be named (security owner)_ | _to be named_ | |
| Certificate or disk nearly exhausted | `monitor.sh` | _to be named_ | _to be named_ | |
| Personal-data breach notification decision | Security owner escalates | _to be named (data protection lead)_ | _to be named_ | |

Set `UBOSS_ALERT_COMMAND` to a script that actually reaches these people (for
example a webhook into the team's chat and a paging service). Prove it: run
`UBOSS_ALERT_COMMAND="..." deploy/scripts/monitor.sh` with one check broken on a
staging box and confirm the message arrived.

## 4. Restore-test evidence format

`deploy/scripts/verify-restore.sh` appends one JSON line per run to
`$UBOSS_STATE_DIR/restore-tests.jsonl` (default `/var/lib/uboss`):

```json
{"at":"2026-11-02T03:10:00Z","host":"uboss-1","file":"db-20261102-020000.sql.gz.gpg","backupAgeHours":1,"restoreSeconds":96,"tables":312,"migrations":214,"result":"PASS","note":"tables=312 migrations=214"}
```

`backupAgeHours` is the recovery point you would have had, and
`restoreSeconds` the restore part of the recovery time. Keep the file; attach the
lines for each rehearsal to the go-live record.

## 5. Disaster-recovery rehearsal checklist

Run on a **staging or freshly built machine**, never by restoring over
production. Record the result in section 6.

1. Fetch the newest backup **from off-site** with `rclone copy`.
2. Run `deploy/scripts/verify-restore.sh <file>` and keep its evidence line.
3. Build a fresh application server from `deploy/scripts/bootstrap.sh`.
4. Restore the dump into it (`docs/DATABASE-RECOVERY.md` §3), then replay
   binary logs to a chosen moment (§4). Note the time from start to first
   successful order: that is the measured recovery time.
5. Restore the media archive and the encrypted environment file.
6. Sign in to the admin console, open three recent orders and compare them with
   the source system.
7. Confirm the worker runs, payments webhooks verify and `monitor.sh` reports
   all checks green.
8. Trigger one alert on purpose and confirm the named owner received it.
9. Write down what went wrong and fix the runbook before the next rehearsal.

Cadence: monthly restore test (step 1–2), quarterly full rehearsal (1–9).

## 6. Rehearsal record

| Date | Environment | Who | Recovery point | Recovery time | Alert reached owner | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| _none yet_ | | | | | | | |

The go-live checklist items for backup, restore, disaster recovery and incident
response (SEC-010, LIVE-015) stay open until a row above records a passing
rehearsal on the production infrastructure and every owner in section 3 is
named.
