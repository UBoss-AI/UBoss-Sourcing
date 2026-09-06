# Accessibility

What this software does about the European Accessibility Act, what it cannot
do for you, and the statement you are obliged to publish.

> **A green build is not a conformance claim.** Automated tooling catches
> somewhere between a third and a half of WCAG failures, and none of the ones
> that matter most — whether a screen reader can actually complete a checkout,
> whether the focus order makes sense, whether an error message says something
> useful. The rest needs a person. §4 says what that means in practice.

---

## 1. What applies, and to what

Directive (EU) 2019/882 — the European Accessibility Act — has applied since
**28 June 2025**. E-commerce services are in scope (Art. 2(2)(f)), and the
harmonised standard behind it, **EN 301 549**, adopts **WCAG 2.1 level AA**.

| Surface | In scope? |
|---|---|
| `apps/customer-web` — the storefront | **Yes.** It is the e-commerce service. |
| `apps/admin-web` — the console | No. An internal business tool is not a service offered to consumers. |
| The API | Only through the storefront that renders it. |

The console is held to the same standards here anyway. The EAA does not reach
it, but the people running the shop are as likely to use a screen reader as the
people buying from it, and in several member states failing to provide an
accessible working environment is its own problem under employment law.

**Microenterprise exemption.** Art. 4(5) exempts a service provider with fewer
than 10 employees and under €2M turnover. `<DECIDE>` — if that is you, the
obligation does not attach, and none of §2 stops being a good idea.

---

## 2. What the build enforces

Three layers, each catching what the others cannot.

| Layer | Command | Catches |
|---|---|---|
| `eslint-plugin-jsx-a11y` | `npm run lint` | Static JSX: missing alt, unlabelled controls, ARIA misuse, non-interactive click handlers. |
| axe-core in vitest | `npm run test` | The rendered DOM: accessible names composed at runtime, duplicate ids, `aria-describedby` pointing at nothing, dialog semantics. |
| Palette contrast audit | `npm run audit:contrast` | WCAG 1.4.3 and 1.4.11 ratios, computed from the design tokens. |

All three run in `npm run verify` in both apps.

### Why three

Each is blind where the next one sees.

`jsx-a11y` reads source. It cannot see an accessible name assembled from three
runtime values, or the same component rendered twice producing a duplicate
`id`, or an `aria-describedby` whose target a conditional never rendered.

axe-core reads the DOM — but under **jsdom**, which has no layout engine.
Nothing has a size, a position or a computed colour there, so the rules about
contrast, target size and reflow cannot produce a meaningful answer and are
disabled by name in `src/test/axe.ts`, each with its reason. A rule disabled
without one is how a suite quietly stops testing what it was written for.

That leaves contrast with no automated cover at all, which is why it has its
own script reading the palette directly. It is the accessibility property most
likely to be broken by an innocent-looking design tweak, and it was the one
thing nothing in this repository watched.

**The guard has its own guard.** `src/test/accessibility.test.tsx` opens by
asserting that axe *fails* on a known-bad fixture. Without it, every green
assertion in that file could be green because axe silently stopped running — a
misconfigured rule set, a container that resolved to nothing, a version bump
that changed the API. A suite that cannot fail is not testing anything.

---

## 3. Decisions worth knowing

**The account dropdown is a disclosure, not a menu.** It used `role="menu"` and
`role="menuitem"`. Those roles promise a composite widget — Tab enters it once,
arrow keys move between items — which this implementation did not provide, and
`menuitem` replaces "link" in the announcement, so a user could no longer tell
that activating one navigates. It is now a labelled `<nav>` of ordinary links
behind `aria-expanded`.

**Wide tables are focusable regions.** A box that scrolls sideways and cannot
be focused is unreachable without a mouse (WCAG 2.1.1), so every wide table is
`role="region"` + `aria-label` + `tabIndex={0}`. `jsx-a11y/no-noninteractive-tabindex`
is configured to allow `region` rather than the occurrences being disabled one
by one — a per-line disable is a per-line invitation to add an unlabelled
focusable div beside it.

**`<dialog>` is polyfilled in tests, partly.** jsdom implements neither
`showModal()` nor `close()`, so dialog components throw on mount and could not
be tested at all. `src/test/setup.ts` adds the smallest shim that lets them
render. It does **not** emulate the top layer, the backdrop, inertness or
Escape — so a test can assert that a dialog is labelled and that its contents
are sound, and **cannot** assert that focus is trapped. That one is on the
manual list below, deliberately, rather than papered over.

**Safety warnings are plain text.** GPSR warnings render with
`whitespace-pre-line`, never `dangerouslySetInnerHTML`. A safety warning is the
last field in this application that should be able to carry markup.

---

## 4. What still needs a person

Automated tooling does not cover these, and no amount of it will.

- **A screen reader completing a purchase, end to end.** NVDA or JAWS on
  Windows, VoiceOver on macOS and iOS. Catalogue → product → cart → address →
  payment → confirmation. This is the test that matters; everything else is a
  proxy for it.
- **Keyboard only, no mouse, same journey.** Including: does focus stay inside
  an open dialog, and does it return to the trigger when the dialog closes?
- **200% zoom and 320px width** (WCAG 1.4.10 reflow) — jsdom has no viewport.
- **Real contrast in the browser**, including text over images and any state
  the token audit does not model.
- **Motion.** `prefers-reduced-motion` is respected in `index.css`; whether the
  result is comfortable is a judgement.
- **Error recovery.** WCAG 3.3.3 asks for a *suggestion*, not just an
  identification. Whether "Enter a valid postcode" actually helps is not
  something a rule can score.

`<DECIDE>` — how often, by whom, and whether you commission an external audit.
For a product sold to other businesses, a dated third-party report is usually
what a buyer's procurement team asks for.

---

## 5. The accessibility statement you must publish

Art. 13 and Annex V oblige a service provider to explain, in the terms and
conditions or equivalent, how the service meets the accessibility requirements.
In practice that is a published accessibility statement.

**The software gives you a place to put it.** `policyLinks` on the business
profile renders in the storefront footer and beside the terms checkbox on
sign-up. Add an entry — for example `Accessibility` → your statement's URL — and
it appears in both.

**The software cannot write it for you.** It is a statement of fact about your
deployment: your contact address, your testing, your known gaps. Here is the
skeleton Annex V asks for.

```
Accessibility statement for <SERVICE NAME>

Commitment
  <ORGANISATION> is committed to making this service accessible, in
  accordance with Directive (EU) 2019/882.

Conformance status
  This service <conforms fully / conforms partially / does not conform> to
  EN 301 549 v3.2.1 (WCAG 2.1 level AA).
  <Where partial: list the non-conforming content and why.>

How the service meets the requirements
  <Describe the accessibility features: keyboard operation, screen-reader
   support, text alternatives, contrast, the eight interface languages.>

Known limitations
  <Be specific. "Some content may not be accessible" satisfies nobody.
   Name the page, the barrier and the workaround.>

Assessment
  Assessed by <self-assessment / third party, NAME> on <DATE>,
  using <tools and assistive technologies>.

Feedback and contact
  Report a barrier: <EMAIL>, <PHONE>, <POSTAL ADDRESS>.
  We aim to respond within <PERIOD>.

Enforcement procedure
  If you are not satisfied with our response, contact
  <NATIONAL ENFORCEMENT AUTHORITY> at <CONTACT>.
```

The last two sections are the ones most often left out and the ones a
supervisory authority looks for first: a statement with no way to report a
barrier and no escalation route is not a statement, it is a claim.

---

## 6. If you change the palette

Run `npm run audit:contrast` in both apps. It fails the build on a ratio below
threshold and names the pair.

Two token pairs are exempt by decision and listed in the script with the
reasoning: `--border` and `--border-subtle` on `--surface` are decorative
hairlines. WCAG 1.4.11 covers what a user needs in order to identify a control
or its state, and a card is identified by its contents rather than by the line
around it. Flagging them would teach whoever reads the report that the failures
are noise — and the next real one would be skipped too.

If you add a token pair that carries meaning, add it to `TEXT_PAIRS` or
`UI_PAIRS`. A renamed token that no pair references any more is reported as
`MISSING` rather than passing silently, which is how a guard like this
otherwise rots.
