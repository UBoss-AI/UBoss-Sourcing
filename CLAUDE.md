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

## `README.md` must stay true too

`README.md` is the repository's front door and its reference for **features,
configuration, markets, payments, languages and going live**. It is read by
somebody deciding whether to run this software at all, so a stale statement
there is the most expensive kind.

**Update it in the same piece of work** whenever a change alters any of:

- A feature, or which surface a feature lives on
- A program, a port, or a URL somebody opens
- An environment variable or feature flag named in it
- A command in it — a script, a `verify`, a migration or seed step
- A development sign-in
- A business rule stated under "The rules this system is built on"
- A going-live step
- Anything in the documentation map at the end

Two things to hold on to, because both have gone wrong here before:

- **Write PowerShell, not bash.** `VAR=value command` is a parse error in this
  environment. An environment variable is set on its own line
  (`$env:NAME = 'value'`), and commands are chained with `;`.
- **Never redirect into it with `>` or `Out-File` from Windows PowerShell.**
  That wrote a UTF-16 fragment onto the end of this file once, which left 36
  NUL bytes in it, made git treat it as binary and put a stray heading at the
  bottom of the rendered page. Edit it as a file.

Do not re-document setup in it. `SETUP.md` owns installation, and two copies
of those steps means one of them is wrong.

## The feature guide must stay true too

`output/UBOSS_Sourcing_Feature_Guide.docx` explains, in **plain language for
people who do not read code**, every feature the product has and how each one
works. It is what a non-technical reader is handed when they ask "what can this
system do?", so it has to describe the product as it is today, not as it was.

It is **generated**, never hand-edited. The content lives in
`scripts/build-feature-guide-doc.mjs`; editing the `.docx` in Word is throwing
the change away, because the next rebuild overwrites it.

**Whenever a feature is added, changed or removed, edit that script and rebuild
the document in the same piece of work:**

```bash
cd scripts && npm run guide
```

Write it the way the rest of the guide is written:

- **Simple English, short sentences.** The reader is a business person, not a
  developer. No file names, no endpoints, no table names, no jargon.
- **Say what the person can do and what the system does back**, in that order.
- A feature that only appears when a flag or provider is switched on goes in
  the "Optional features" section, and says what turns it on.
- Put it in the section it belongs to (customer, admin, warehouse, system,
  security) rather than appending to the end, and add it to the end-to-end
  examples if it changes how somebody actually works through a task.

Same standard as the two project guides: a guide that has quietly stopped being
true is worse than no guide, because people trust it and act on it.

## The `docs/` folder must stay true too

`docs/` holds the product's formal documents. Start at `docs/README.md`.

| File | Update it in the same piece of work when |
|---|---|
| `docs/PRD.md` | A feature, role, permission, flow, business rule, feature flag or integration is added, changed or removed — including its status (built / behind a flag / not built) |
| `docs/DATABASE-DESIGN.md` | A table, relationship, constraint, index that encodes a rule, or a state model changes |
| `docs/API.md` | Sign-in, sessions, cookies, headers, the error shape, the money format, pagination, idempotency, rate limits, webhooks, or an endpoint it explains changes |
| `docs/UI-SCREENS.md` | A page is added, moved or removed, or what a screen shows, does or calls changes |
| `docs/reference/*.md` | **Never by hand.** Regenerate with `cd scripts; npm run docs` after changing `schema.prisma`, anything in `backend/src/http/routes/` or `app.ts`, or `errors.ts` |

`docs/reference/` is generated by `scripts/build-reference-docs.mjs`, and CI's
"Reference docs match the code" job runs `npm run docs:check`, so forgetting to
regenerate turns the build red. The four hand-written documents have no such
check — that is why they are part of the change, not a follow-up. The best
thing a route can do for its entry in the reference is carry a one-line comment
directly above `app.get(...)`: that comment becomes its description.

Same standard as everything else here: simple English, short sentences,
explain a term the first time it appears, and never describe something as
built when it is not.

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
- **Plan and occurrence status is only ever changed through the assertions in
  `backend/src/domain/schedule-state.ts`.** Same rule as order status, and it
  matters more: an occurrence changes status inside a worker with nobody
  watching, and the states it moves between decide whether a card is charged.
- **A scheduled basket is priced by `quoteSchedule` and nothing else.** The
  review screen the customer confirms and the worker that charges them weeks
  later both call it, so the number they agreed to and the number they are
  charged come from one place. A second implementation of "what does this
  basket cost" is how a customer ends up disputing a total nobody can explain.
- **Adding a member to `ScheduleFrequency` needs a migration for
  `chk_schedule_frequency_field_present`.** That CHECK constraint names each
  frequency and the column it depends on, so a new one that is not listed
  matches no branch and every insert fails. It was added in
  `20260902143000_add_check_constraints` and redefined (drop and re-add) in
  `20260908181000_scheduled_orders_check_constraints` and again in
  `20260909160000_schedule_month_intervals`, which holds the current version
  (it added `EVERY_N_MONTHS`). A new migration copies that latest version and
  adds its branch.
- **A new table with a `userId` or `customerProfileId` breaks
  `tests/unit/export-bundle-completeness.test.ts` until the GDPR export
  accounts for it.** That is the test working: it reads the schema and refuses
  to let a table holding personal data be quietly absent from every Art. 15
  copy. Add it to `SECTIONS` and disclose it, or list it as out of scope with
  the reason.
- **The development environment is Windows / PowerShell.** `VAR=1 npm run x` is
  a parse error there — never put that form in a script or in documentation.

## Before committing

```bash
cd backend && npm run verify              # typecheck + lint + tests
cd apps/customer-web && npm run verify
cd apps/admin-web && npm run verify
cd apps/logistics-web && npm run verify   # only if the logistics portal changed
cd scripts && npm run docs:check          # docs/reference matches the code
```
