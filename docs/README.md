# Glovia documentation

This folder explains the product in writing: what it must do, how its data is
stored, how its API is called, and what every screen does. Each document is
written so that somebody new — a developer, a tester, a product owner, a buyer
evaluating the software — can read it without knowing the code first.

## Where to start

| If you want to know… | Read |
|---|---|
| What the product is, who it is for, and what it must do | [`PRD.md`](PRD.md) — the Product Requirements Document |
| What each screen shows and lets you do | [`UI-SCREENS.md`](UI-SCREENS.md) |
| How the data is organised, and why | [`DATABASE-DESIGN.md`](DATABASE-DESIGN.md) |
| How to talk to the backend from a program | [`API.md`](API.md) |
| The exact columns of one table | [`reference/DATABASE-TABLES.md`](reference/DATABASE-TABLES.md) |
| Every endpoint, and who may call it | [`reference/API-ENDPOINTS.md`](reference/API-ENDPOINTS.md) |
| What one error code means | [`reference/ERROR-CODES.md`](reference/ERROR-CODES.md) |

A good reading order for a newcomer: **PRD → UI screens → database design →
API**. The three reference files are for looking things up, not for reading
end to end.

## The two kinds of document here

**Written by people** — `PRD.md`, `DATABASE-DESIGN.md`, `API.md`,
`UI-SCREENS.md`. They explain *why* and *how*. They are updated by hand, in the
same piece of work as the change they describe.

**Generated from the code** — everything in `reference/`. They list *what
exists*: all 226-odd tables, all ~800 endpoints, all error codes. They are
rebuilt by one command and must never be edited by hand:

```powershell
cd scripts; npm run docs
```

CI runs `npm run docs:check` and fails when the reference no longer matches the
code, so it cannot quietly fall behind.

## The other documents in this folder

| File | Answers |
|---|---|
| [`DATABASE-PRODUCTION.md`](DATABASE-PRODUCTION.md) | Which MariaDB, how it is configured, its accounts, collation and time |
| [`DATABASE-MIGRATION.md`](DATABASE-MIGRATION.md) | Migrations, schema drift, moving data safely, releasing a migration |
| [`DATABASE-RECOVERY.md`](DATABASE-RECOVERY.md) | Backups, restores, point-in-time recovery |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Putting it on a server, releases, monitoring, compliance |
| [`NETLIFY.md`](NETLIFY.md) | Hosting the three front ends on a static host |
| [`PRODUCT-READINESS.md`](PRODUCT-READINESS.md) | What is built, switched off, or missing, capability by capability |
| [`SELLER_HUB_IMPLEMENTATION.md`](SELLER_HUB_IMPLEMENTATION.md) | How the Seller Hub was built |
| [`LOGISTICS_PARTNER_PORTAL_IMPLEMENTATION.md`](LOGISTICS_PARTNER_PORTAL_IMPLEMENTATION.md) | How the logistics partner portal was built |
| [`LOGISTICS_PARTNER_PORTAL_DELIVERY.md`](LOGISTICS_PARTNER_PORTAL_DELIVERY.md) | What the logistics portal delivered, with screenshots |

Outside this folder: [`../README.md`](../README.md) (features, configuration,
going live), [`../SETUP.md`](../SETUP.md) (installing and running it),
[`../PROJECT-GUIDE.md`](../PROJECT-GUIDE.md) (the long guide to every piece).

## Keeping these documents true

A document that has quietly stopped being true is worse than none, because
people trust it and act on it. So:

| Change | Update |
|---|---|
| A feature, role, flow, rule, flag or integration | `PRD.md` |
| A page, or what a screen does | `UI-SCREENS.md` |
| A table, relationship, constraint or state model | `DATABASE-DESIGN.md`, then `npm run docs` |
| Sign-in, headers, errors, money format, webhooks, an important endpoint | `API.md`, then `npm run docs` |
| Any route file, `schema.prisma` or `errors.ts` | `cd scripts; npm run docs` |

`CLAUDE.md` at the root states this as a rule for everybody working here.
