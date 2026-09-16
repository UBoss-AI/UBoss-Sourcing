<!--
Delete whatever does not apply. A template nobody edits is a template nobody
reads.
-->

## What changes, and why

<!-- The why matters more than the what: the diff already says what. -->

## How it was checked

<!-- Name what you ran, not "tested". -->

- [ ] `cd backend && npm run verify` — **run the backend suite on its own.** It
      truncates tables in `uboss_test`, and two verify runs at once share that
      one database and produce a long list of failures that have nothing to do
      with the change
- [ ] `cd apps/customer-web && npm run verify`
- [ ] `cd apps/admin-web && npm run verify`
- [ ] `cd apps/logistics-web && npm run verify` — only if the carrier portal changed

## Documentation

`CLAUDE.md` asks for these in the *same* piece of work, not later. A guide that
has quietly stopped being true is worse than no guide, because people trust it
and act on it.

- [ ] **`PROJECT-GUIDE.md` and `PROJECT-GUIDE.hinglish.md`** — one document in
      two languages, updated together
- [ ] **`README.md`** — if a feature, a setting, a port, a command, a rule or a
      going-live step changed
- [ ] **`SETUP.md`** — if the way the project is started changed
- [ ] **The feature guide** — edit `scripts/build-feature-guide-doc.mjs` and run
      `cd scripts && npm run guide`. Never edit the `.docx`; the next rebuild
      throws it away
- [ ] **`docs/DEPLOYMENT.md`** — if anything about running it on a server changed

## Things this repository has been bitten by

Tick only the ones that apply; ignore the rest.

- [ ] **A migration.** Additive changes are safe in one release. A rename, a
      drop, a narrowing or a new `NOT NULL` is **two** releases — migrations run
      before the new code starts, so the old code meets the new schema.
      `docs/DEPLOYMENT.md` §15.5
- [ ] **A new `ScheduleFrequency` member** — needs a migration for
      `chk_schedule_frequency_field_present`, or every insert fails
- [ ] **A new table with a `userId` or `customerProfileId`** — the GDPR export
      test fails until it is accounted for. That is the test working
- [ ] **A new error code** — added, never repurposed, and mapped in both
      frontends
- [ ] **New copy** — all eight languages, in this piece of work
- [ ] **A dependency that runs code at install time** — `npm install-scripts ls`
      in the affected project, and record the decision
- [ ] **A test that needs a setting, a key or a provider** — state it in the test
      or in `tests/setup.ts`, never by assuming your own `backend/.env`. CI runs
      against `.env.example`, which has no AI key, no gateway credentials, and
      `PIECES_PER_CARTON=500`. All three have already broken a build
- [ ] **A test that needs data to already be there** — CI's database has only
      been migrated. Reference data comes from `tests/global-setup.ts`; anything
      else the test seeds itself

<!--
If CI fails on "The install actually built what it needed to", a dependency bump
re-blocked an install script. That is deliberate: approvals name an exact
version so a new one is reviewed rather than inherited.
-->
