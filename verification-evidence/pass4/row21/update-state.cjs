const fs = require('fs');

const file = 'verification-evidence/pass4/state.json';
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const row = state.rows.find((candidate) => candidate.id === 21);
if (!row) throw new Error('Master row 21 missing');

Object.assign(row, {
  status: 'FIXED_AND_VERIFIED',
  pass4Done: true,
  finding: 'The awarded RFQ exposed frozen accepted terms, but it had no binding buyer purchase order, electronic acceptance, approval matrix or approval decision flow.',
  fix: 'Added an immutable RFQ purchase-order review that freezes the awarded requirement and accepted quote into a canonical SHA-256 contract snapshot. The buyer reviews SKU/specification, quantity, price, tooling, shipping, tax disclosure, Incoterm/place, payment, inspection, warranty, ship date, certifications and documents before explicit electronic acceptance. Individual orders approve immediately; company policy creates ordered approver and finance stages with maker-checker separation, optimistic decisions, rejection handling and audit events.',
  files: 'backend: Prisma schema/generated client + migration 20261021600000_rfq_purchase_orders, modules/rfq/purchase-order.service.ts, RFQ customer routes, errors/audit/domain support and fixture cleanup; customer-web: RfqPurchaseOrderPage, API types, RFQ detail link, router, errors and 9 locale files; docs: PRD, API, database design, project guide and generated references.',
  tests: 'Backend RFQ negotiation suite adds immutable contract/totals, stale hash, idempotence, tenant isolation, individual auto-approval, company approver+finance maker-checker and simultaneous submission coverage. Storefront component tests cover preview/e-accept and an existing approval. Live authenticated Chrome checks the awarded PO page at five widths.',
  testResult: 'backend RFQ negotiation 9/9; backend typecheck and lint clean; customer full verify 157/157 files and 1649/1649 tests plus production build; focused PO page 2/2 after the mobile overflow fix; customer lint clean; docs:check and i18n checks pass.',
  verification: 'Chrome 153 + axe 4.13 at 320/375/768/1024/1440: correct authenticated route and heading; commercial, inspection, separately calculated tax and electronic-acceptance content present; no raw translation keys, main/page horizontal overflow, axe A/AA violations or JavaScript exceptions. Desktop keyboard walk shows visible focus in order. Mobile and desktop screenshots inspected.',
  security: 'Every read/write reloads the RFQ through buyer tenant scope; another buyer receives 404. POSTs use the existing authenticated CSRF-protected customer router. Contract and accepted-terms hashes prevent stale or altered acceptance. Company decisions enforce role capability, requestor/approver separation, finance/approver separation and optimistic version checks. Creation/approval/rejection are audited, and simultaneous creates converge on one purchase order and one creation audit.',
  evidence: 'backend/tests/integration/rfq-negotiation.test.ts; apps/customer-web/src/pages/rfq/RfqPurchaseOrderPage.test.tsx; verification-evidence/pass4/row21/out-final-fixed/results.json and screenshots.',
  verifiedAt: '2026-09-30',
  blocker: '—',
  manual: [
    'Sign in as a buyer and open an awarded RFQ, then choose Review purchase order.',
    'Confirm the page shows the frozen SKU/specification, quantity, price and totals, Incoterm, payment, inspection, delivery window, tax disclosure and documents.',
    'Enter the optional buyer SKU and signer details, accept the hashed terms and submit. Confirm the resulting reference and approval status replace the editable form.',
    'For a company whose approval policy requires both stages, verify the requestor cannot approve, an approver acts first, and a different finance user completes approval.'
  ],
  commands: [
    'cd backend; npm test -- tests/integration/rfq-negotiation.test.ts',
    'cd apps/customer-web; npm test -- src/pages/rfq/RfqPurchaseOrderPage.test.tsx',
    'node verification-evidence/pass4/row21/harness-row21.mjs verification-evidence/pass4/row21/out-final-fixed verification-evidence/pass4/row21/plan.json'
  ]
});

state.checkpoint.lastCompleted = 21;
state.checkpoint.next = 9;
state.checkpoint.latestTest = '2026-09-30: Master row 21 backend RFQ negotiation 9/9; customer full verify 1649/1649 and production build; focused PO page 2/2; responsive Chrome at 320–1440 has zero overflow, axe violations or JS exceptions.';
state.checkpoint.blocker = 'Row 9 needs approved launch policy text and legal sign-off. Row 12 has no payout adapter and awaits the marketplace D13 decision. Row 20 still needs the paid-sample checkout flow using existing checkout with tax and shipping calculated separately.';
state.batch = { from: 21, to: 30, lastCompleted: 21, next: 22 };

const journey = {
  id: 'JOURNEY-020',
  status: 'FIXED_AND_VERIFIED',
  evidence: 'Master row 21 implementation and tests prove that agreed RFQ terms convert into one immutable, hashed purchase order with explicit e-acceptance and policy-driven approver/finance stages; live responsive evidence is in verification-evidence/pass4/row21/out-final-fixed/results.json.',
  verifiedAt: '2026-09-30'
};
const index = state.otherBoxes.findIndex((box) => box.id === journey.id);
if (index === -1) state.otherBoxes.push(journey);
else state.otherBoxes[index] = journey;

fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);

const reportFile = 'Checklist.md';
const replacements = new Map([
  ['- Current Master row:', '- Current Master row: 22 — subsequent checklist work; row 21 is complete and verified.'],
  ['- Last completed work:', '- Last completed work: Master row 21 B2B Order / PO Review and detailed journey JOURNEY-020. Row 20 remains blocked and unchecked.'],
  ['- Next unchecked Master row:', '- Next unchecked Master row: 9 (NEEDS_HUMAN_VERIFICATION), 12 (NEEDS_HUMAN_VERIFICATION), 20 (BLOCKED); first technically workable row: 22'],
  ['- Master checked:', '- Master checked: 41'],
  ['- Master unchecked:', '- Master unchecked: 56'],
  ['- Entire document checked:', '- Entire document checked: 128'],
  ['- Entire document unchecked:', '- Entire document unchecked: 236'],
  ['- Fixed and verified:', '- Fixed and verified: 31.'],
  ['- In progress:', '- In progress: none; Master row 21 and JOURNEY-020 are verified and ticked.'],
  ['- Latest commit:', '- Latest pushed baseline: `fc9f6de9` docs(checklist): establish verified completion baseline.'],
  ['- Latest push:', '- Current change set: Master row 21 implementation, verification, documentation and the two exact checklist ticks, ready for one atomic commit and push.'],
  ['- Latest test command:', '- Latest test command: backend RFQ negotiation suite, customer full verify and focused PO page suite, docs/i18n checks, plus live authenticated Chrome at five widths.'],
  ['- Latest test result:', '- Latest test result: backend row-21 integration 9/9; customer full verify 157 files / 1649 tests and production build; focused PO page 2/2 after the responsive fix; Chrome 153 at 320/375/768/1024/1440 with no overflow, axe violations, raw keys or JavaScript exceptions.'],
  ['- Working tree:', '- Working tree: row 21 source, tests, migration, generated client, docs, `Checklist.md`, authoritative Word file and pass-4 state are the intended change set. Older backups and unrelated evidence remain unstaged.']
]);
const report = fs.readFileSync(reportFile, 'utf8').split(/\r?\n/);
let inHeader = true;
for (let index = 0; index < report.length && inHeader; index += 1) {
  if (report[index].startsWith('### ')) inHeader = false;
  for (const [prefix, replacement] of replacements) {
    if (report[index].startsWith(prefix)) report[index] = replacement;
  }
}
fs.writeFileSync(reportFile, `${report.join('\n')}\n`);
