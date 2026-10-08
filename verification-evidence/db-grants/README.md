# Audit-log grant proofs (2026-09-29, local MariaDB 10.4.32)

Each script creates a throwaway schema and throwaway accounts, runs its checks, and drops everything it made. Credentials are read from `backend/.env` at runtime; none are stored here.

| Script | What it proves | Result |
|---|---|---|
| `grantcheck.cjs` | The grant model as SQL: the app account cannot UPDATE/DELETE `audit_logs`; the maintenance account can blank `actorEmail`/`ipAddress`/`userAgent` and DELETE, and cannot rewrite `action`, `afterJson` or `actorUserId`, insert, or touch another table | 11/11 PASS |
| `gen-grant-test.sh` | `deploy/mariadb/post-migrate-grants.sql` end to end, through the same pipeline as `apply-grants.sh`: exact grants emitted; verification reports append-only + maintenance-scoped; a widened grant is reported WRONG; nothing emitted for a missing account | 7/7 PASS |
| `prisma-grant-test.sh` | The real Prisma clients under those grants: `prisma` (app) refused with `UPDATE command denied … audit_logs`; `auditMaintenancePrisma()` is a separate connection that pseudonymises and deletes, and is refused rewriting `action` | 5/5 PASS |
