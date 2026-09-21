# Reporting a security problem

This file is for two different readers, and the answer is different for each.

**If you are running UBOSS** — you bought it and it is installed on your own
server — a vulnerability in the software is reported to whoever supplied it to
you, using the address below. A problem with *your* installation (a leaked
password, a suspicious sign-in, a customer's data somewhere it should not be)
is yours to handle, and `backend/docs/RUNBOOK.md` is the procedure.

**If you found something in the software itself** — you are a researcher, a
customer's IT team, a curious buyer — please tell us before you tell anybody
else. The rest of this file is how.

---

## Where to send it

| | |
|---|---|
| Email | Fill in `SECURITY_CONTACT_EMAIL` below — see "Before you ship this" |
| Encryption | A PGP key is offered at the same address on request |
| Language | English |
| Acknowledgement | Within **2 working days** |
| First assessment | Within **5 working days** |

Please include: what you did, what happened, what you expected, and enough
detail to reproduce it. A single screenshot rarely is. If you have a proof of
concept, send it — we would rather read yours than write our own.

## What happens next

1. **Acknowledgement**, within two working days, from a person rather than an
   autoresponder.
2. **Triage**, within five working days: we reproduce it, decide the severity
   using CVSS v4.0, and tell you what we concluded and why.
3. **A fix**, on the timetable below.
4. **A retest**, by you if you are willing, before anything is announced.
5. **Disclosure**, coordinated with you. We will not publish before you have
   agreed a date, and we will not ask you to stay quiet indefinitely — 90 days
   from the report is the outside limit unless you agree otherwise.

## How quickly

Measured from triage, not from the report.

| Severity | Fixed and released within | Also |
|---|---|---|
| Critical | 7 days | Operators told within 24 hours of triage, with a mitigation |
| High | 30 days | Operators told within 5 working days |
| Medium | 90 days | Named in the release notes |
| Low | Next ordinary release | Named in the release notes |

Anything **actively exploited** is Critical regardless of its score, and EU
operators are notified on the CRA timetable: an early warning to the CSIRT and
ENISA within 24 hours of becoming aware, an intermediate report within 72
hours, and a final report within 14 days. See `docs/DEPLOYMENT.md` §26.

## What is in scope

- The API (`backend/`), the storefront, the Admin Panel, the Seller Hub and the
  Logistics Portal.
- The shipped deployment configuration: `deploy/nginx`, `deploy/systemd`,
  `deploy/scripts`, `deploy/mariadb`.
- The build and release pipeline in `.github/workflows`.

## What is not

- **Anybody's live installation.** Do not test against a running UBOSS you do
  not own. Every deployment is a different company's, with real orders and real
  people's data in it. Stand up your own copy — `SETUP.md` takes about twenty
  minutes.
- Denial of service by volume, spam, or anything that needs physical access to
  the server.
- Findings from an automated scanner with no demonstrated impact. Send the
  finding *and* what it lets somebody do.
- Missing headers or a weak TLS suite on somebody's deployment: that is the
  operator's configuration, not this software's.

## Safe harbour

If you follow this policy — your own installation, no third party's data, no
service degraded, no data destroyed, and you report promptly and give us a
reasonable time to fix it — we will not pursue or support legal action against
you, and we will say so in writing if you need it. This is a statement of our
intent and cannot bind anybody else.

We do not run a paid bounty. We will credit you by name in the release notes if
you would like us to, and we will not credit you if you would rather we did
not.

---

## Before you ship this

Two things, and both are per-installation because **UBOSS is sold to other
companies to run themselves** — nothing here may assume the author is the
operator.

**1. Fill in the address.** Replace this line with your own security contact:

```
SECURITY_CONTACT_EMAIL = security@your-company.example
```

Use a monitored group address, not a person's. A researcher who gets a bounce
publishes instead of waiting.

**2. Publish `security.txt`.** RFC 9116 says a machine-readable copy lives at
`/.well-known/security.txt`, which is where scanners and researchers look first.
`deploy/nginx/security.txt.example` is the template; copy it to
`/srv/uboss/current/customer-web/.well-known/security.txt`, fill in the two
fields, set an `Expires` date less than a year out, and put a reminder in the
calendar to renew it. An expired `security.txt` is treated as no policy at all.

The nginx site file already serves that path — see `location =
/.well-known/security.txt` in `deploy/nginx/uboss.conf`.
