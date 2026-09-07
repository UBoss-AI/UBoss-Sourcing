# Working in this repository

## Documentation must stay true

This project has two guides that are **the same document in two languages**:

| File | Language | In git? |
|---|---|---|
| `PROJECT-GUIDE.md` | English | Yes |
| `PROJECT-GUIDE.hinglish.md` | Hinglish | **No** — gitignored on purpose |

**Whenever you change the project, update both files in the same piece of
work.** Not later, not "if there is time". A guide that has quietly stopped
being true is worse than no guide, because people trust it and act on it.

Update both when any of these change:

- A page is added, moved or removed
- An API endpoint is added, or what one returns changes
- A database table or column changes
- A business rule changes — tax, approval, what a status means
- A flow changes — sign-up, checkout, payment, fulfilment, refunds
- A feature flag or configuration setting changes
- A role or permission changes
- Anything in the security model changes

The two files must stay in step with each other: a section added to one is
added to the other. They are one document, not two.

`SETUP.md` (how to install and run) follows the same rule when the way the
project is started changes.

## Facts about this project that are easy to get wrong

- **This is a product other companies buy and run themselves.** Nothing may
  assume the author is the operator. Every business detail is a setting, never
  a hard-coded value.
- **Money is always `BigInt` minor units.** Never a float, never a JS `number`,
  anywhere in a money path. It crosses the API as a string.
- **The database is MariaDB 10.4**, not PostgreSQL and not a modern MySQL. No
  `SKIP LOCKED`, no native UUID, and a `UNIQUE` index treats every `NULL` as
  distinct. Check `backend/prisma/schema.prisma`'s header before assuming a
  feature exists.
- **Order status is only ever changed through `assertTransition`** in
  `backend/src/domain/order-state-machine.ts`. No service writes `status`.
- **An order is confirmed only by a signature-verified webhook**, never by a
  client redirect.
- **Error codes in `backend/src/domain/errors.ts` are a published contract.**
  Both frontends map each code to a message in eight languages. Add new codes;
  never repurpose an existing one.
- **The development environment is Windows / PowerShell.** `VAR=1 npm run x` is
  a parse error there — never put that form in a script or in documentation.

## Before committing

```bash
cd backend && npm run verify              # typecheck + lint + tests
cd apps/customer-web && npm run verify
cd apps/admin-web && npm run verify
```
