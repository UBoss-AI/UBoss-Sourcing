# Deploying UBOSS Sourcing

How to put this on a server and keep it running. `SETUP.md` covers getting it
running on a developer's machine; this covers everything after that.

Written against **one VPS** — the shape most buyers of this product start with,
and specifically a 4 vCPU / 16 GB machine such as a Hostinger KVM 4. Everything
here works unchanged on a larger single box. The section at the end says what to
do when one box is no longer enough, and how you will know.

---

## What this honestly supports

Read this before planning around a number, because the gap between "millions of
users" and "one VPS" is where deployment plans go wrong.

**One KVM 4 cannot serve millions of concurrent users.** Nothing can — that is
a fleet, a managed database, a load balancer and a CDN. What this box does
comfortably:

| | Realistic on 4 vCPU / 16 GB |
|---|---|
| Registered customers **stored** | Millions. This is a database row count, and MariaDB does not care. |
| Catalogue products | Hundreds of thousands |
| Requests per second, catalogue reads | ~800–1,500 across the three API instances |
| Requests per second, checkout writes | ~50–150, bounded by the database, not by Node |
| Concurrent active shoppers | Low thousands |
| Orders per day | Tens of thousands |

Those are the numbers for a well-indexed schema with the buffer pool sized as
this guide sizes it, and they move a long way with what the traffic actually
does. Measure yours — `/metrics` is a Prometheus endpoint and the slow query log
is on.

**Where it runs out first, in order.** Knowing this is worth more than the table
above, because it tells you what to buy:

1. **Database CPU.** A single MariaDB on four shared cores is the ceiling on
   writes. The buffer pool fixes reads; nothing on one box fixes write
   contention.
2. **API cores.** Three instances is three cores. There is no fourth to give.
3. **Disk on media**, if images are served from this machine at all — which is
   the arrangement this guide steers away from, below.
4. **RAM**, last, and only if the catalogue grows past what 6 GB of buffer pool
   holds.

**The architecture does not have to change to grow.** The API keeps no state in
the process — sessions are cookies, the job queue is in the database with a
lease, and uploads go to object storage — so the same build runs on five
machines behind a load balancer without a line of code changing. "Scaling out",
at the end, is the order to do it in.

---

## The shape of a deployment

```
                          ┌──────────────────────────────┐
    shop.example.com ───▶ │                              │
                          │            nginx             │  TLS, gzip, caching,
   admin.example.com ───▶ │                              │  edge rate limits
                          └───────────────┬──────────────┘
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    │                     │                     │
         ┌──────────▼───────┐  ┌──────────▼───────┐  ┌──────────▼───────┐
         │ uboss-api@4000   │  │ uboss-api@4001   │  │ uboss-api@4002   │
         └──────────┬───────┘  └──────────┬───────┘  └──────────┬───────┘
                    └─────────────────────┼─────────────────────┘
                                          │
                          ┌───────────────▼──────────────┐      ┌────────────────┐
                          │           MariaDB            │◀─────│ uboss-worker   │
                          │   (loopback, 6 GB pool)      │      │  (1 process)   │
                          └──────────────────────────────┘      └────────────────┘
```

Three API instances because **Node is single-threaded per process**: one
instance uses exactly one core no matter how much traffic arrives. The fourth
core is left for nginx, MariaDB and the worker, none of which is idle.

One worker, and not because two would break anything — the queue claims work
with a lease (a conditional `UPDATE` and an affected-rows check, because MariaDB
10.4 has no `SKIP LOCKED`), so a second would be correct. It is one because the
useful parallelism is already inside it via `WORKER_CONCURRENCY`, and a second
process would compete for the same four cores.

### On disk

```
/srv/uboss/
├── repo/          the git checkout release.sh builds from
├── releases/      one frozen directory per release (5 kept)
├── current →      symlink to the release being served
├── shared/.env    every secret. Survives releases. chmod 600.
├── media/         uploaded images, IF served locally. Never inside a release.
└── backups/       nightly dumps
```

`shared/` and `media/` sit outside the release directories deliberately: they
are the two things a deploy must not touch and a rollback must not revert.

---

## First deploy

### 1. Bootstrap the machine

```bash
git clone <your-repo-url> /tmp/uboss && cd /tmp/uboss
sudo bash deploy/scripts/bootstrap.sh
```

Installs nginx, MariaDB, Node 22, certbot and a firewall; creates the `uboss`
service user and the layout above; installs the nginx, systemd and MariaDB
files; adds swap and raises the connection backlog. It is idempotent — run it
again after fixing something.

It deliberately does **not** create the database, write `.env`, issue
certificates or start anything. Those need decisions and secrets, and a script
that guessed at them would produce a site that starts and is wrong.

### 2. Database

```bash
sudo mysql_secure_installation
sudo mariadb -e "CREATE DATABASE uboss CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
sudo mariadb -e "CREATE USER 'uboss'@'localhost' IDENTIFIED BY '<long random password>';"
sudo mariadb -e "GRANT ALL PRIVILEGES ON uboss.* TO 'uboss'@'localhost'; FLUSH PRIVILEGES;"
```

`utf8mb4` is not optional. This storefront runs in eight languages and holds
Greek, Polish and German product text; anything less silently truncates at the
first character outside the BMP.

### 3. The checkout

```bash
sudo -u uboss git clone <your-repo-url> /srv/uboss/repo
```

### 4. `.env`

```bash
sudo -u uboss cp /srv/uboss/repo/backend/.env.example /srv/uboss/shared/.env
sudo -u uboss nano /srv/uboss/shared/.env
sudo chmod 600 /srv/uboss/shared/.env
```

**The API validates this file and refuses to start if it is wrong**, printing
every problem at once. That is the single most useful thing about deploying
this application, so read the failure rather than working around it.

The values that must change, and what happens if they do not:

| Setting | Production value | If you get it wrong |
|---|---|---|
| `NODE_ENV` | `production` | Every guard below is skipped |
| `SESSION_COOKIE_SECRET`<br>`ACCESS_TOKEN_SECRET`<br>`REFRESH_TOKEN_SECRET` | `openssl rand -base64 36` each | **Refuses to start** while they hold the example placeholder |
| `SECRETS_ENCRYPTION_KEY` | 32 bytes, base64 | Customer ERP credentials cannot be decrypted |
| `COOKIE_SECURE` | `true` | **Refuses to start** |
| `COOKIE_DOMAIN` | `.example.com` — leading dot | Sign in on the admin host, immediately signed out |
| `API_PUBLIC_URL` | `https://shop.example.com` | Webhook and redirect URLs point at the wrong place |
| `CUSTOMER_WEB_ORIGIN`<br>`ADMIN_WEB_ORIGIN` | the two https origins | CORS refuses the admin panel |
| `EMAIL_DRIVER` | `smtp` | **Refuses to start** — the `log` driver delivers nothing |
| `STORAGE_DRIVER` | `s3` | **Refuses to start** — see below |
| `ALLOW_PRIVATE_ERP_TARGETS` | unset / `false` | **Refuses to start** — it makes the cloud metadata endpoint reachable from a form field |
| `DB_POOL_SIZE` | `12` | See the connection arithmetic in `deploy/mariadb/uboss.cnf` |
| `DATABASE_URL` | the **`uboss_app`** user | See "Two database users" below |
| `MIGRATE_DATABASE_URL` | the **`uboss_migrate`** user | Migrations fail, or run with more rights than they should |

### Two database users

`backend/docs/RUNBOOK.md` §7 asks for an application user with
`SELECT, INSERT, UPDATE, DELETE` and nothing else — no DDL — and with `UPDATE`
and `DELETE` **revoked on `audit_logs`**, because an append-only audit trail the
application itself can rewrite is not an audit trail.

That user cannot run a migration. So there are two:

| User | Used by | Rights |
|---|---|---|
| `uboss_app` | the API and the worker, always | `SELECT, INSERT, UPDATE, DELETE`, minus `UPDATE`/`DELETE` on `audit_logs` |
| `uboss_migrate` | `release.sh`, for one command per release | everything on the schema |

`release.sh` reads `MIGRATE_DATABASE_URL` for `prisma migrate deploy` and
nothing else; the running application only ever reads `DATABASE_URL`. Leave
`MIGRATE_DATABASE_URL` unset and migrations run as the application user — which
works if you granted it everything, and the script warns you that you did.

`bootstrap.sh` prints the exact SQL for both.

Payment keys are checked too: a live Razorpay or Stripe key with
`NODE_ENV` not `production` refuses to start, and so does a **test** key with
`NODE_ENV=production` — "test keys never collect money".

### Where product images live

**`STORAGE_DRIVER=local` is refused in production**, and the reason is worth
understanding rather than working around: a VPS disk is one disk. Product
images and generated invoices are not in the database, not in git and not
recoverable from anywhere else.

Three options, best first:

1. **S3-compatible object storage.** Cloudflare R2, Backblaze B2, DigitalOcean
   Spaces, Wasabi — all speak the same API and all cost a few dollars a month at
   this scale. Set `S3_ENDPOINT`, `S3_BUCKET`, the two keys, and point
   `STORAGE_PUBLIC_BASE_URL` at the bucket's public URL or a CDN in front of it.
   Images are then durable, and serving them costs this box nothing at all.
2. **A CDN in front of that bucket.** The same as (1) plus a cache. Worth it
   once product pages are the bulk of your traffic.
3. **MinIO on this machine.** Speaks S3, so the driver is satisfied. Be honest
   with yourself that this is local disk wearing an S3 costume — it satisfies
   the check without satisfying the reason the check exists. If you do this,
   `deploy/nginx/uboss.conf`'s `/media/products/` block becomes live, and
   `backup.sh` archiving `/srv/uboss/media` is the only thing standing between
   you and a catalogue of broken images.

### 5. Certificates

Point DNS at the machine, edit `/etc/nginx/sites-available/uboss.conf` to
replace `example.com`, then:

```bash
sudo nginx -t
sudo certbot --nginx -d shop.example.com -d admin.example.com
```

### 6. Deploy and start

```bash
sudo -u uboss /srv/uboss/repo/deploy/scripts/release.sh
sudo systemctl enable --now uboss-api@4000 uboss-api@4001 uboss-api@4002
sudo systemctl enable --now uboss-worker
sudo systemctl enable --now uboss-backup.timer
```

### 7. Seed the first administrator

```bash
cd /srv/uboss/current/backend
sudo -u uboss env $(grep -v '^#' /srv/uboss/shared/.env | xargs) npx tsx src/seed/index.ts
```

Then sign in at `https://admin.example.com` and **change that password
immediately**.

---

## Releasing

```bash
sudo -u uboss /srv/uboss/repo/deploy/scripts/release.sh              # origin/main
sudo -u uboss /srv/uboss/repo/deploy/scripts/release.sh origin/hotfix
```

Builds into a new timestamped directory, runs migrations, repoints `current`,
then restarts the API instances **one at a time**, waiting for each to answer
`/health/ready` before touching the next. The site stays up throughout. If
anything fails before the symlink moves, the running site has not been touched.

### The one thing the script cannot decide for you

Migrations run **before** the new code starts, so for the length of the rolling
restart the **old code is running against the new schema**.

- **Additive** — a new table, a new nullable column, a new index — is fine.
- **Destructive** — a rename or a drop — will throw on every request the old
  instances are still serving.

A destructive change is therefore **two releases**: add the new shape and write
to both, deploy, and remove the old shape once nothing reads it. There is no way
to automate that judgement, which is why it is written here and at the top of
`release.sh`.

### Rolling back

```bash
sudo -u uboss /srv/uboss/repo/deploy/scripts/rollback.sh
```

Repoints `current` at the previous release and restarts. It does **not** roll
the database back, and must not — migrations have run, and reversing them
discards rows written since.

So it is the right tool when the new **code** is wrong, and the wrong tool when
the new **migration** is wrong. For the latter the fix is forward, with a new
migration. This is why the two-release rule above earns its keep.

---

## Day to day

```bash
# What is running
systemctl status 'uboss-*'

# Logs. The application writes structured JSON (pino) to journald.
journalctl -u uboss-api@4000 -f
journalctl -u uboss-worker -f --since '1 hour ago'
journalctl -u 'uboss-api@*' -p err --since today

# Is it healthy
curl -s localhost:4000/health/ready | jq
for p in 4000 4001 4002; do curl -sf localhost:$p/health/live >/dev/null && echo "$p up" || echo "$p DOWN"; done

# Metrics (loopback only - nginx denies this from outside)
curl -s localhost:4000/metrics | head -40

# What the database is doing
sudo mariadb -e "SHOW PROCESSLIST;"
sudo tail -f /var/log/mysql/slow.log
```

`/health/live` and `/health/ready` are different questions and the difference
matters: `live` never touches a dependency, so a database outage does not get
the process restarted (restarting fixes nothing). `ready` checks the database
and the queue and returns 503 so a load balancer drains the instance.

### Backups

**`backend/docs/RUNBOOK.md` is the authority on backup, restore and retention
policy.** It has the restore procedure, the consistency check, the retention
decisions and the quarterly drill. Do not keep a second copy of that here; this
section only covers what the automation in `deploy/` adds on top of it.

`uboss-backup.timer` runs `deploy/scripts/backup.sh` nightly at 02:30 UTC. Per
run it takes the `--single-transaction` dump the runbook specifies, archives
`/srv/uboss/media` (which the database dump does **not** contain), and encrypts
a copy of `.env` if `UBOSS_BACKUP_PASSPHRASE` is set — without those secrets a
restore has the data and no way to start the application that reads it.

It then checks the dump is readable gzip, above a minimum size, and ends with
mysqldump's completion marker. Those catch a truncated dump and a dump of an
empty database. They do **not** prove the dump is consistent; the test for that
is the restore drill in RUNBOOK.md §2, which is a quarterly item performed by a
person because it needs `CREATE DATABASE` rights the backup user is
deliberately not given.

A `Persistent=true` timer rather than a cron line, so a machine that was
rebooting at 02:30 runs the backup late instead of skipping it silently.

**The off-site line in `backup.sh` is commented out and is the most important
line in the file.** A backup on the same disk as the database protects against a
bad `UPDATE` and against nothing else — not a failed volume, not a deleted VPS.

---

## Scaling out

Do these in order. Each is cheap until it is not enough.

**1. Tune what you have.** Raise `innodb_buffer_pool_size` if the box is not
swapping. Raise `WORKER_CONCURRENCY` before adding a worker. Check the slow
query log — an index is cheaper than a server.

**2. Put a CDN in front.** Cloudflare in front of `shop.example.com` costs
nothing and removes every static asset, every product image and every
cacheable response from this machine. On a catalogue site this is usually the
single largest win available, and it is a DNS change.

**3. Move the database off the box.** The first structural step, and the right
one, because database CPU is what runs out first. A managed MariaDB or MySQL
means the four cores here become four API cores. Only `DATABASE_URL` changes.

**4. Add API machines.** The API keeps no state in the process, so this is
mechanical: build the same release on a second box, run the same units, and add
it to nginx's `upstream` block. Move nginx to its own machine or a managed load
balancer at the same time.

**5. Split the worker off.** Once it competes for cores with the API. More than
one worker is safe — the lease pattern is already there — so this also becomes a
horizontal axis.

**6. Read replicas.** Last, and only with evidence from `/metrics` that reads
are the problem. It is the first change that needs application work, because
something has to decide which queries may go to a replica and tolerate replica
lag. Everything above is configuration.

---

## Troubleshooting

**The API will not start.** Read the message — it prints every invalid setting
at once, with the setting name. `journalctl -u uboss-api@4000 -n 50`.

**Signed out immediately after signing in.** `COOKIE_DOMAIN` is wrong. It must
be the parent domain with a leading dot (`.example.com`) for one session to work
on both hostnames. Also check `X-Forwarded-Proto` is reaching the API — without
it every `Secure` cookie is refused.

**The site is blank after a release, only for regular visitors.** `index.html`
was cached. It names the current fingerprinted chunks, and a cached one points
at the previous release's files, which were pruned. The `location = /index.html`
block exists to prevent this; check it survived any edit to the nginx config.

**CORS errors in the admin panel.** `ADMIN_WEB_ORIGIN` does not exactly match
the browser's origin — scheme, host and port, no trailing slash.

**413 on an image upload.** `client_max_body_size` in nginx must be above
`UPLOAD_MAX_BYTES` in `.env`, or nginx refuses the body with a bare 413 before
the API can produce a message a person can read.

**Every third request is slow.** An API instance is down or was never enabled.
nginx is waiting out `fail_timeout` on it. `systemctl status 'uboss-api@*'`.

**Orders confirm late or not at all.** The worker. `journalctl -u uboss-worker`.
An order reaches CONFIRMED only through a signature-verified webhook, never a
client redirect — so also check the provider's own delivery log.

---

## Related

This document covers **getting the software onto a server and releasing to it**.
It is deliberately not the operations manual, and where the two touch, the
runbook wins.

| For | Read |
|---|---|
| Backup policy, restore procedure, migrations, payment reconciliation, incident response, the production hardening checklist | `backend/docs/RUNBOOK.md` |
| Running it on a developer's machine | `SETUP.md` |
| What the system is and how it is built | `PROJECT-GUIDE.md` |
| Personal data, retention and the Art. 15 export | `backend/docs/DATA-PROTECTION.md` |
| Every file referenced here, each commented with why it is what it is | `deploy/` |

Two things in the hardening checklist are **done for you** by the files in
`deploy/` and are worth knowing so you do not do them twice: `/metrics` is
already restricted to loopback in the nginx config, and MariaDB is already bound
to `127.0.0.1` in `deploy/mariadb/uboss.cnf`. Everything else on that list is
still yours — in particular the two database users, the gateway webhook
registration, and the notification recipients.
