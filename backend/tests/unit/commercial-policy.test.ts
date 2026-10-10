import { describe, expect, it } from 'vitest';
import {
  BESPOKE_B2B_PAYMENT_PLAN,
  DOC07_ADMINISTRATIVE_WINDOWS,
  DOC08_ASSURANCE_MATRIX,
  DOC08_CATEGORY_REGISTER,
  DOC08_COMMISSION_SCHEDULE,
  DOC08_DEPARTMENT_SLUGS,
  DOC08_INSURANCE_RISK_GROUPS,
  DOC08_LAUNCH_DECISIONS,
  LARGE_B2B_ORDER_THRESHOLD_MINOR,
  acceptanceControlGaps,
  activationProblems,
  addBusinessDaysIn,
  applyBps,
  certificationAllocation,
  classifyIntake,
  commissionForLine,
  commissionReversal,
  commissionWithLargeOrderBand,
  departmentKey,
  dispatchGaps,
  doc08WorkedExample,
  duplicateRecoveryExcess,
  evidenceBlocksTrading,
  excessHeld,
  importerOfRecord,
  insuranceGaps,
  isIndependentAppealReviewer,
  largeOrderBandProblems,
  launchBlockers,
  launchDecisionsFor,
  logisticsCoordination,
  partialShipmentProblems,
  paymentPlanProblems,
  portfolioRateBps,
  proposedInsuredValue,
  quoteSelectionProblems,
  reasonedDecisionProblems,
  reconcileCategoryRegister,
  recoveryOverlap,
  refundDisplayState,
  reserveForOrder,
  resolveDeliveryTerm,
  securityStackProblem,
  splitByMilestones,
  surveillanceIntervalMonths,
  unrecoveredBalance,
  windowByKey,
  windowDeadline,
} from '../../src/domain/commercial-policy.js';
import { STARTER_DEPARTMENTS } from '../../src/seed/starter-departments.js';

const IST = { timeZone: 'Asia/Kolkata', holidays: [] as string[] };

describe('Doc 08 commission schedule import', () => {
  it('holds exactly the 25 rows and rates of section 3', () => {
    expect(DOC08_COMMISSION_SCHEDULE).toHaveLength(25);
    const rates = Object.fromEntries(DOC08_COMMISSION_SCHEDULE.map((r) => [r.department, [r.b2bBps, r.b2cBps]]));
    expect(rates['Medical Devices']).toEqual([1250, 1500]);
    expect(rates['Computers and IT']).toEqual([800, 1000]);
    expect(rates['Clothing and Textiles']).toEqual([1500, 1800]);
    expect(rates['Chemicals and Raw Materials']).toEqual([600, 800]);
    expect(rates['Energy and Environment']).toEqual([800, 1000]);
    expect(rates['Toys Hobbies and Crafts']).toEqual([1500, 1800]);
  });

  it('maps every schedule row to one seeded department slug, with no duplicates', () => {
    const slugs = Object.values(DOC08_DEPARTMENT_SLUGS);
    expect(new Set(slugs).size).toBe(25);
    const seeded = new Map(STARTER_DEPARTMENTS.map((d) => [d.slug, d.name]));
    for (const row of DOC08_COMMISSION_SCHEDULE) {
      const slug = DOC08_DEPARTMENT_SLUGS[row.department];
      expect(slug, row.department).toBeDefined();
      expect(departmentKey(seeded.get(slug!) ?? ''), row.department).toBe(departmentKey(row.department));
    }
  });

  it('reads "&" as "and" and drops punctuation, nothing else', () => {
    expect(departmentKey('Toys, Hobbies & Crafts')).toBe(departmentKey('Toys Hobbies and Crafts'));
    expect(departmentKey('Laboratory & Scientific')).toBe('laboratory and scientific');
    expect(departmentKey('Computers & IT')).not.toBe(departmentKey('Computers and ITs'));
  });
});

describe('Doc 08 appendix register against the seeded catalogue', () => {
  it('has 25 departments and 120 immediate subcategories', () => {
    expect(DOC08_CATEGORY_REGISTER).toHaveLength(25);
    expect(DOC08_CATEGORY_REGISTER.reduce((s, d) => s + d.subcategories.length, 0)).toBe(120);
  });

  it('matches the starter catalogue exactly', () => {
    const diff = reconcileCategoryRegister(STARTER_DEPARTMENTS.map((d) => ({ name: d.name, slug: d.slug, children: d.children })));
    expect(diff).toEqual([]);
  });

  it('reports a renamed or missing shelf rather than inventing one', () => {
    const live = STARTER_DEPARTMENTS.map((d) => ({ name: d.name, slug: d.slug, children: d.children }));
    const changed = live.map((d) => (d.slug === 'books-media' ? { ...d, children: d.children.filter((c) => c.name !== 'Books').concat([{ name: 'Comics', slug: 'comics' }]) } : d));
    const diff = reconcileCategoryRegister(changed);
    expect(diff).toContainEqual({ kind: 'SUBCATEGORY_MISSING_IN_CATALOGUE', department: 'Books & Media', name: 'Books' });
    expect(diff).toContainEqual({ kind: 'SUBCATEGORY_NOT_IN_REGISTER', department: 'Books & Media', name: 'Comics' });
  });
});

describe('commission', () => {
  it('reconciles the Doc 08 worked example exactly', () => {
    const ex = doc08WorkedExample();
    expect(ex.netGoodsMinor).toBe(10_000_000n); // INR 100,000
    expect(ex.commissionMinor).toBe(1_250_000n); // INR 12,500
    expect(ex.coordinationMinor).toBe(40_000n); // INR 400
    expect(ex.platformChargesBeforeTaxMinor).toBe(1_290_000n); // INR 12,900
    expect(ex.externalCostMinor).toBe(800_000n); // INR 8,000 reconciled separately
  });

  it('uses net goods after seller-funded discounts; platform-funded discounts do not cut the base', () => {
    const r = commissionForLine({ goodsMinor: 100_000n, sellerFundedDiscountMinor: 10_000n, platformFundedDiscountMinor: 5_000n, bps: 1250 });
    expect(r.baseMinor).toBe(90_000n);
    expect(r.commissionMinor).toBe(11_250n);
    expect(r.buyerGoodsMinor).toBe(85_000n);
  });

  it('rounds half-up per line in integer arithmetic', () => {
    expect(applyBps(4n, 1250)).toBe(1n); // 0.5 -> 1
    expect(applyBps(3n, 1250)).toBe(0n); // 0.375 -> 0
    expect(applyBps(-4n, 1250)).toBe(-1n);
  });

  it('applies a large-order reduction to the incremental amount only', () => {
    const base = 300_000_000n; // INR 30 lakh
    const band = { reducedBps: 800, thresholdMinor: LARGE_B2B_ORDER_THRESHOLD_MINOR, approvalReference: 'MGMT-1', contributionEvidence: 'Contribution model v2 positive' };
    const r = commissionWithLargeOrderBand(base, 1250, band, 'B2B');
    expect(r.standardCommissionMinor).toBe(31_250_000n);
    expect(r.reducedCommissionMinor).toBe(4_000_000n);
    expect(r.commissionMinor).toBe(35_250_000n);
  });

  it('refuses a band below the 5% floor, without approval, or on B2C', () => {
    expect(largeOrderBandProblems({ reducedBps: 400, thresholdMinor: 1n, approvalReference: '', contributionEvidence: '' }, 1250, 'B2C')).toEqual(['NOT_B2B', 'BELOW_FLOOR', 'APPROVAL_MISSING', 'CONTRIBUTION_EVIDENCE_MISSING']);
    const noBand = commissionWithLargeOrderBand(300_000_000n, 1250, { reducedBps: 400, thresholdMinor: LARGE_B2B_ORDER_THRESHOLD_MINOR, approvalReference: 'x', contributionEvidence: 'y' }, 'B2B');
    expect(noBand.commissionMinor).toBe(37_500_000n);
  });

  it('computes the illustrative 12.5% portfolio mix from Doc 08', () => {
    expect(portfolioRateBps([
      { baseMinor: 5_000_000n, commissionMinor: applyBps(5_000_000n, 1250) },
      { baseMinor: 2_500_000n, commissionMinor: applyBps(2_500_000n, 1000) },
      { baseMinor: 2_500_000n, commissionMinor: applyBps(2_500_000n, 1500) },
    ])).toBe(1250);
  });

  it('reverses commission proportionately and never more than charged', () => {
    expect(commissionReversal({ lineBaseMinor: 10_000_000n, lineCommissionMinor: 1_250_000n, refundedGoodsMinor: 4_000_000n, alreadyReversedMinor: 0n })).toBe(500_000n);
    expect(commissionReversal({ lineBaseMinor: 10_000_000n, lineCommissionMinor: 1_250_000n, refundedGoodsMinor: 10_000_000n, alreadyReversedMinor: 500_000n })).toBe(750_000n);
  });
});

describe('logistics, certification, insurance, security', () => {
  it('caps coordination and supports a fixed fee', () => {
    expect(logisticsCoordination(800_000n, { kind: 'COST_PLUS', bps: 500, capMinor: 30_000n })).toMatchObject({ coordinationMinor: 30_000n, capped: true, totalChargedMinor: 830_000n });
    expect(logisticsCoordination(800_000n, { kind: 'FIXED_FEE', feeMinor: 25_000n, contractReference: 'LANE-1' }).coordinationMinor).toBe(25_000n);
  });

  it('flags a cost recovered from both buyer and seller', () => {
    expect(duplicateRecoveryExcess(800_000n, [800_000n, 800_000n])).toBe(800_000n);
    expect(duplicateRecoveryExcess(800_000n, [500_000n, 300_000n])).toBe(0n);
  });

  it('caps certification recovery at 1% and the unrecovered balance, and stops at zero', () => {
    expect(certificationAllocation(10_000_000n, 100, 1_000_000n)).toBe(100_000n);
    expect(certificationAllocation(10_000_000n, 100, 30_000n)).toBe(30_000n);
    expect(certificationAllocation(10_000_000n, 100, 0n)).toBe(0n);
    expect(unrecoveredBalance({ eligibleCostMinor: 100n, confirmedMinor: 60n, reservedMinor: 30n, refundedMinor: 20n, creditedMinor: 0n })).toBe(30n);
  });

  it('proposes 110% insured value plus agreed freight', () => {
    expect(proposedInsuredValue(1_000_000n, 50_000n)).toBe(1_150_000n);
  });

  it('holds the three Doc 08 insurance groups with exact limits', () => {
    expect(DOC08_INSURANCE_RISK_GROUPS.map((g) => [g.productLiabilityPerOccurrenceMinor, g.productLiabilityAggregateMinor, g.recallLimitMinor])).toEqual([
      [100_000_000n, 200_000_000n, 50_000_000n],
      [200_000_000n, 500_000_000n, 100_000_000n],
      [500_000_000n, 1_000_000_000n, 200_000_000n],
    ]);
    const now = new Date('2026-10-09T00:00:00Z');
    expect(insuranceGaps({ verificationStatus: 'VERIFIED', brokerReviewedAt: now, insuredEntity: 'Seller Ltd', expiresAt: new Date('2027-01-01'), perOccurrenceMinor: 100_000_000n, aggregateMinor: 200_000_000n }, DOC08_INSURANCE_RISK_GROUPS[2]!, now)).toEqual(['BELOW_PROPOSED_PER_OCCURRENCE', 'BELOW_PROPOSED_AGGREGATE']);
  });

  it('respects the reserve cap and refuses unexplained stacking', () => {
    expect(reserveForOrder(1_000_000n, 500, 60_000n, 30_000n)).toBe(30_000n);
    expect(reserveForOrder(1_000_000n, 500, 60_000n, 60_000n)).toBe(0n);
    expect(securityStackProblem({ reserveCapMinor: 100n, guaranteeMinor: 100n, depositMinor: 0n, documentedExposureMinor: null })).toBe('NO_EXPOSURE_CALCULATION');
    expect(securityStackProblem({ reserveCapMinor: 100n, guaranteeMinor: 100n, depositMinor: 0n, documentedExposureMinor: 150n })).toBe('EXCEEDS_EXPOSURE');
    expect(securityStackProblem({ reserveCapMinor: 100n, guaranteeMinor: 0n, depositMinor: 0n, documentedExposureMinor: null })).toBeNull();
    expect(excessHeld(500n, 300n)).toBe(200n);
  });

  it('splits the 30/60/10 plan exactly and needs all three agreements', () => {
    const parts = splitByMilestones(1_000_001n, BESPOKE_B2B_PAYMENT_PLAN);
    expect(parts.map((p) => p.amountMinor)).toEqual([300_000n, 600_000n, 100_001n]);
    expect(paymentPlanProblems({ sellerAgreedAt: new Date(), buyerAgreedAt: null, providerConfirmationRef: null, channel: 'B2B' })).toEqual(['BUYER_NOT_AGREED', 'PROVIDER_NOT_CONFIRMED']);
  });
});

describe('delivery terms and order controls', () => {
  const base = { sellerCountry: 'IN', destinationCountry: 'US', fcaApproved: false, ddpArrangementApproved: false };
  it('defaults international B2B to DAP and keeps the buyer as importer', () => {
    const r = resolveDeliveryTerm({ ...base, channel: 'B2B', election: null });
    expect(r).toEqual({ term: 'DAP', problems: [] });
    expect(importerOfRecord('DAP', 'B2B')).toBe('BUYER');
  });
  it('allows FCA only when elected and approved, DDP only with an arrangement', () => {
    expect(resolveDeliveryTerm({ ...base, channel: 'B2B', election: 'FCA' }).problems).toEqual(['FCA_NOT_APPROVED']);
    expect(resolveDeliveryTerm({ ...base, channel: 'B2B', election: 'FCA', fcaApproved: true }).term).toBe('FCA');
    expect(resolveDeliveryTerm({ ...base, channel: 'B2B', election: 'DDP' }).problems).toEqual(['DDP_ARRANGEMENT_MISSING']);
    expect(importerOfRecord('DDP', 'B2B')).toBe('APPROVED_ARRANGEMENT');
  });
  it('treats domestic and consumer orders separately and never makes a consumer the importer', () => {
    expect(resolveDeliveryTerm({ ...base, destinationCountry: 'IN', channel: 'B2B', election: null }).term).toBe('DOMESTIC');
    expect(resolveDeliveryTerm({ ...base, channel: 'B2C', election: 'FCA' }).problems).toEqual(['FCA_B2C_NOT_ALLOWED']);
    expect(importerOfRecord('CONSUMER', 'B2C')).toBe('APPROVED_ARRANGEMENT');
  });
  it('lists every acceptance control that is missing', () => {
    const gaps = acceptanceControlGaps({ sellerAccountId: 's', manufacturer: null, approvedProductVersion: null, facilityRef: null, destinationCountry: 'US', channel: 'B2B', importer: null, localActorsSatisfied: false, goodsPriceMinor: 1n, taxesKnown: true, deliveryTerm: 'DAP', namedPlace: 'NY', leadTimeDays: 10, returnRoute: null, packagingRecorded: false, transportRestrictionsReviewed: false, insuranceDecided: false, policyVersionsRecorded: true });
    expect(gaps).toEqual(['MANUFACTURER', 'APPROVED_SKU_VERSION', 'APPROVED_FACILITY', 'IMPORTER', 'LOCAL_ACTORS', 'NAMED_PLACE', 'RETURN_ROUTE', 'PACKAGING', 'TRANSPORT_RESTRICTIONS', 'INSURANCE']);
  });
  it('blocks dispatch on a safety hold or missing evidence', () => {
    const ok = { paymentReady: true, inspectionPassed: true, requiredDocumentsValid: true, eligibilityCurrent: true, quantitiesRecorded: true, lotsOrSerialsRecorded: false, lotTrackingRequired: false, sealsRecorded: true, packingPhotosRecorded: true, custodyHandoverRecorded: true, temperatureRequired: false, temperatureEvidenceRecorded: false, handlingRequirementsMet: true, safetyHold: false };
    expect(dispatchGaps(ok)).toEqual([]);
    expect(dispatchGaps({ ...ok, safetyHold: true, temperatureRequired: true, paymentReady: false })).toEqual(['SAFETY_HOLD', 'PAYMENT_NOT_READY', 'TEMPERATURE_EVIDENCE']);
  });
  it('refuses a partial shipment the assessment forbids', () => {
    expect(partialShipmentProblems({ orderApprovalRef: 'APR-1', assessmentForbidsPartial: true, shippedQuantity: 5, orderedQuantity: 10 })).toEqual(['ASSESSMENT_NO_PARTIAL_RELEASE']);
  });
  it('needs two comparable quotes or a reason for a material commitment', () => {
    expect(quoteSelectionProblems({ materialCommitment: true, comparableQuotes: 1, singleSourceReason: null })).toEqual(['SECOND_QUOTE_OR_REASON_REQUIRED']);
    expect(quoteSelectionProblems({ materialCommitment: true, comparableQuotes: 1, singleSourceReason: 'Specialist cold-chain carrier only' })).toEqual([]);
  });
});

describe('case clocks and decisions', () => {
  it('holds the Doc 07 windows exactly', () => {
    const w = Object.fromEntries(DOC07_ADMINISTRATIVE_WINDOWS.map((x) => [x.key, `${x.amount} ${x.unit}`]));
    expect(w).toEqual({
      ACKNOWLEDGEMENT: '1 BUSINESS_DAYS',
      VISIBLE_DAMAGE_OR_SHORTAGE: '48 HOURS',
      B2B_QUANTITY_OR_SPECIFICATION: '7 CALENDAR_DAYS',
      GENERAL_CLAIM: '30 CALENDAR_DAYS',
      VOLUNTARY_RETURN: '14 CALENDAR_DAYS',
      SELLER_RESPONSE: '72 HOURS',
      INITIAL_DECISION: '7 CALENDAR_DAYS',
      APPEAL_SUBMISSION: '7 CALENDAR_DAYS',
      APPEAL_REVIEW: '10 BUSINESS_DAYS',
    });
  });

  it('counts business days in the calendar zone, skipping weekends and holidays', () => {
    // Friday 2026-10-09 18:00 IST -> Monday 2026-10-12 18:00 IST
    const fri = new Date('2026-10-09T12:30:00Z');
    expect(addBusinessDaysIn(fri, 1, IST).toISOString()).toBe('2026-10-12T12:30:00.000Z');
    expect(addBusinessDaysIn(fri, 1, { ...IST, holidays: ['2026-10-12'] }).toISOString()).toBe('2026-10-13T12:30:00.000Z');
    // Friday 23:00 IST is still Friday locally though Friday 17:30 UTC
    expect(windowDeadline(windowByKey('APPEAL_REVIEW'), fri, IST).toISOString()).toBe('2026-10-23T12:30:00.000Z');
  });

  it('accepts late safety, defect and statutory claims for review, never refusing them', () => {
    const deliveredAt = new Date('2026-08-01T00:00:00Z');
    const now = new Date('2026-10-09T00:00:00Z');
    const common = { deliveredAt, now, channel: 'B2C' as const, technicalAcceptanceUntil: null };
    expect(classifyIntake({ ...common, category: 'SAFETY', statutoryBasis: false })).toMatchObject({ kind: 'LATE_ACCEPTED_FOR_REVIEW', reason: 'RIGHTS_PRESERVED' });
    expect(classifyIntake({ ...common, category: 'DELAY', statutoryBasis: true })).toMatchObject({ kind: 'LATE_ACCEPTED_FOR_REVIEW', reason: 'STATUTORY_BASIS' });
    expect(classifyIntake({ ...common, category: 'DELAY', statutoryBasis: false })).toMatchObject({ kind: 'LATE_REFUSED' });
    expect(classifyIntake({ ...common, category: 'SHORTAGE', statutoryBasis: false, technicalAcceptanceUntil: new Date('2026-12-01') })).toMatchObject({ reason: 'TECHNICAL_ACCEPTANCE' });
    expect(classifyIntake({ ...common, now: new Date('2026-08-20T00:00:00Z'), category: 'DELAY', statutoryBasis: false })).toEqual({ kind: 'ON_TIME' });
  });

  it('requires an independent appeal reviewer and a reasoned, human decision', () => {
    expect(isIndependentAppealReviewer('u1', ['u1', 'u2'])).toBe(false);
    expect(isIndependentAppealReviewer('u3', ['u1', null])).toBe(true);
    expect(reasonedDecisionProblems({ reasoning: 'short', remedies: [{ kind: 'REFUND', amountMinor: null, payer: null }, { kind: 'RETURN', amountMinor: null, payer: 'SELLER' }], returnFreightPayer: null, expectedCompletionAt: null, aiGenerated: true })).toEqual([
      'AI_ONLY_DECISION', 'REASONING_MISSING', 'AMOUNT_MISSING:REFUND', 'PAYER_MISSING:REFUND', 'RETURN_FREIGHT_PAYER_MISSING', 'EXPECTED_COMPLETION_MISSING',
    ]);
  });

  it('never shows a provider-pending refund as complete', () => {
    expect(refundDisplayState('PROCESSING', 're_1')).toBe('PENDING_PROVIDER');
    expect(refundDisplayState('PROCESSING', null)).toBe('SUBMITTED');
    expect(refundDisplayState('SUCCEEDED', 're_1')).toBe('SUCCEEDED');
  });

  it('flags overlapping recoveries without blocking', () => {
    expect(recoveryOverlap(1000n, [{ source: 'CHARGEBACK', amountMinor: 1000n }, { source: 'CARRIER', amountMinor: 400n }])).toEqual({ excessMinor: 400n, sources: ['CHARGEBACK', 'CARRIER'] });
  });
});

describe('certification governance and launch', () => {
  it('imports all 25 assurance rows and derives surveillance intervals', () => {
    expect(DOC08_ASSURANCE_MATRIX).toHaveLength(25);
    expect(DOC08_ASSURANCE_MATRIX.map((r) => r.department)).toEqual(DOC08_COMMISSION_SCHEDULE.map((r) => r.department));
    const med = DOC08_ASSURANCE_MATRIX.find((r) => r.department === 'Medical Devices');
    const office = DOC08_ASSURANCE_MATRIX.find((r) => r.department === 'Office and Stationery');
    const tools = DOC08_ASSURANCE_MATRIX.find((r) => r.department === 'Tools and Hardware');
    expect(surveillanceIntervalMonths(med, false)).toBe(6);
    expect(surveillanceIntervalMonths(office, true)).toBe(12);
    expect(surveillanceIntervalMonths(tools, false)).toBe(12);
    expect(surveillanceIntervalMonths(tools, true)).toBe(6);
  });

  it('blocks trading on withdrawn or expired required evidence, and never invents an expiry', () => {
    const now = new Date('2026-10-09');
    expect(evidenceBlocksTrading({ requiredForTrading: true, status: 'WITHDRAWN', expiresOn: null }, now)).toBe(true);
    expect(evidenceBlocksTrading({ requiredForTrading: true, status: 'VERIFIED', expiresOn: new Date('2026-10-01') }, now)).toBe(true);
    expect(evidenceBlocksTrading({ requiredForTrading: true, status: 'VERIFIED', expiresOn: null }, now)).toBe(false);
    expect(evidenceBlocksTrading({ requiredForTrading: false, status: 'EXPIRED', expiresOn: null }, now)).toBe(false);
  });

  it('covers every Doc 08 section 11 decision and scopes EU/US/India items', () => {
    expect(DOC08_LAUNCH_DECISIONS.filter((d) => d.source.includes('s11')).length).toBeGreaterThanOrEqual(12);
    const us = launchDecisionsFor('US', false).map((d) => d.key);
    expect(us).toContain('US_MARKETPLACE_TAX_AND_CUSTOMS');
    expect(us).not.toContain('EU_VAT_DEEMED_SUPPLIER_IOSS');
    expect(launchDecisionsFor('DE', true).map((d) => d.key)).toContain('EU_VAT_DEEMED_SUPPLIER_IOSS');
  });

  it('blocks a launch with any missing, self-reviewed or expired evidence', () => {
    const now = new Date('2026-10-09');
    const required = launchDecisionsFor('US', false);
    const items = required.map((d) => ({ key: d.key, status: 'APPROVED' as const, evidence: 'ref', expiresAt: new Date('2027-10-09'), reviewerUserId: 'r', ownerUserId: 'o' }));
    expect(launchBlockers(items, required, now)).toEqual([]);
    const broken = items.map((i) => (i.key === 'INSURANCE' ? { ...i, reviewerUserId: 'o' } : i.key === 'LEGAL_REVIEW' ? { ...i, evidence: '' } : i));
    expect(launchBlockers(broken.slice(1), required, now)).toEqual([
      { key: 'COMPANY_AND_CONTACTS', reason: 'NOT_STARTED' },
      { key: 'INSURANCE', reason: 'NOT_INDEPENDENTLY_REVIEWED' },
      { key: 'LEGAL_REVIEW', reason: 'EVIDENCE_MISSING' },
    ]);
  });

  it('never activates a schedule without a second approver, evidence, schedule reference and provider confirmation', () => {
    expect(activationProblems({ kind: 'SECURITY', status: 'APPROVED', preparedById: 'p', approvedById: 'p', approvalEvidence: null, scheduleReference: null, effectiveFrom: null, providerConfirmationRef: null }, 'p')).toEqual([
      'APPROVER_IS_PREPARER', 'APPROVAL_EVIDENCE_MISSING', 'SIGNED_SCHEDULE_REFERENCE_MISSING', 'EFFECTIVE_DATE_MISSING', 'PROVIDER_CONFIRMATION_MISSING', 'ACTIVATOR_IS_PREPARER',
    ]);
    expect(activationProblems({ kind: 'COMMISSION', status: 'APPROVED', preparedById: 'p', approvedById: 'a', approvalEvidence: 'Board minute 12', scheduleReference: 'Seller schedule 2', effectiveFrom: new Date(), providerConfirmationRef: null }, 'a')).toEqual([]);
  });
});
