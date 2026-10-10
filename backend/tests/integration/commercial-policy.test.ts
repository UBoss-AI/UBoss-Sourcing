/**
 * Doc 07 (delivery, returns, disputes) and Doc 08 (commercial, certification,
 * launch), end to end on the real database: draft schedules that never
 * activate themselves, the order-line snapshot, acceptance / import-route /
 * country / dispatch gates, safety containment, late statutory claims,
 * independent appeals, reasoned decisions, commission reversal, concurrent
 * certification recovery, security reserves, insurance, product evidence and
 * cross-role isolation. All fixtures are synthetic; nothing here is a real
 * approval, certificate, refund or launch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import * as cases from '../../src/modules/commercial-policy/cases.service.js';
import * as evidence from '../../src/modules/commercial-policy/evidence-launch.service.js';
import * as finance from '../../src/modules/commercial-policy/finance.service.js';
import * as logistics from '../../src/modules/commercial-policy/logistics-controls.service.js';
import * as orders from '../../src/modules/commercial-policy/order-controls.service.js';
import * as safety from '../../src/modules/commercial-policy/safety.service.js';
import * as schedules from '../../src/modules/commercial-policy/schedules.service.js';
import { isAmbiguousProviderOutcome } from '../../src/modules/payments/refund.service.js';
import { PaymentProviderError } from '../../src/modules/payments/provider.js';
import { assertOrderEligible } from '../../src/modules/seller-assessment/purchase-gate.service.js';
import { splitOrderToSellers } from '../../src/modules/seller/order-split.service.js';
import { asAudit, auditPerson, cleanUpAuditPeople } from '../support/audit-session.js';
import { asCustomer, asStaff, buildOrderDesk, cleanUpOrderDesk, emailFor, errorCode, staff, type OrderDesk, type StaffSession } from '../support/order-desk-fixture.js';

type App = Awaited<ReturnType<typeof buildApp>>;
const TAG = 'commpol';
const saved = { gates: env.DELIVERY_POLICY_GATES, launch: env.COUNTRY_LAUNCH_GATE };

let app: App;
let desk: OrderDesk;
let owner: StaffSession;
const u: Record<string, string> = {};
const auditPeople: Record<string, { session: Awaited<ReturnType<typeof auditPerson>>['session']; userId: string }> = {};
const created = { schedules: [] as string[], programmes: [] as string[], routes: [] as string[], security: [] as string[], insurance: [] as string[], evidence: [] as string[], safety: [] as string[], orders: [] as string[], launch: [] as string[] };

const actor = (who: string) => ({ userId: u[who] ?? '', actorType: 'ADMIN' as const });

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

async function activate(kind: Parameters<typeof schedules.draftNewVersion>[0], body?: unknown, providerRef?: string): Promise<string> {
  const { id } = await schedules.draftNewVersion(kind, actor('finance1'));
  created.schedules.push(id);
  await schedules.editDraft(id, { ...(body === undefined ? {} : { body }), effectiveFrom: new Date(Date.now() - 60_000), scheduleReference: 'Synthetic signed schedule T-1' }, actor('finance1'));
  await schedules.submitForApproval(id, actor('finance1'));
  await schedules.decideSchedule(id, { approve: true, evidence: 'Synthetic test adoption record', providerConfirmationRef: providerRef ?? null }, actor('finance2'));
  await schedules.activateSchedule(id, actor('finance2'));
  return id;
}

/** A fresh paid order for seller A, split (so it gets seller groups and snapshots) and left NEW. */
async function newOrder(country: string, company = false, quantity = 1): Promise<{ orderId: string; groupId: string; itemId: string }> {
  const base = await prisma.order.findUniqueOrThrow({ where: { id: desk.orderId } });
  const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: desk.itemId } });
  const orderId = newId();
  const itemId = newId();
  created.orders.push(orderId);
  const goods = 10_000n * BigInt(quantity);
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `UB-${TAG.toUpperCase()}-${orderId.slice(-6)}`,
      customerProfileId: base.customerProfileId,
      status: 'CONFIRMED',
      currency: 'INR',
      subtotalMinor: goods,
      discountMinor: 0n,
      taxMinor: 1_200n * BigInt(quantity),
      shippingMinor: 0n,
      grandTotalMinor: goods + 1_200n * BigInt(quantity),
      paidMinor: goods + 1_200n * BigInt(quantity),
      placedAt: new Date(),
      buyerContextKind: company ? 'COMPANY' : 'INDIVIDUAL',
      shippingAddressJson: { line1: '5 Harbour Street', city: 'Testville', postalCode: '10001', country },
      billingAddressJson: { line1: '5 Harbour Street', city: 'Testville', postalCode: '10001', country },
    },
  });
  await prisma.orderItem.create({ data: { ...item, id: itemId, orderId, quantity, lineSubtotalMinor: goods, taxAmountMinor: 1_200n * BigInt(quantity), lineTotalMinor: goods + 1_200n * BigInt(quantity) } as never });
  await prisma.$transaction(async (tx) => splitOrderToSellers(orderId, tx));
  const group = await prisma.sellerOrderGroup.findFirstOrThrow({ where: { orderId } });
  return { orderId, groupId: group.id, itemId };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUpAuditPeople(TAG);
  desk = await buildOrderDesk(app, TAG, 96);
  owner = await staff(app, TAG, 'inspadmin', Role.BUSINESS_OWNER, '10.96.0.40');
  for (const who of ['finance1', 'finance2', 'desk', 'inspadmin', 'selleraowner', 'buyer']) {
    u[who] = (await prisma.user.findFirstOrThrow({ where: { emailNormalized: emailFor(TAG, who) }, select: { id: true } })).id;
  }
  let n = 50;
  for (const [who, role] of [['reviewer', 'COMPLIANCE_REVIEWER'], ['reviewer2', 'COMPLIANCE_REVIEWER'], ['supervisor', 'SUPERVISOR']] as const) {
    n += 1;
    const p = await auditPerson(app, { tag: TAG, who, ip: `10.96.0.${String(n)}`, target: { kind: 'STAFF', role } });
    auditPeople[who] = { session: p.session, userId: p.userId };
  }
  await schedules.seedDraftSchedules();
}, 300_000);

afterAll(async () => {
  Object.assign(env, { DELIVERY_POLICY_GATES: saved.gates, COUNTRY_LAUNCH_GATE: saved.launch });
  const schedulesToDrop = created.schedules;
  await prisma.commercialScheduleEvent.deleteMany({ where: { scheduleId: { in: schedulesToDrop } } });
  await prisma.commercialSchedule.deleteMany({ where: { id: { in: schedulesToDrop } } });
  await prisma.certificationRecoveryAllocation.deleteMany({ where: { programmeId: { in: created.programmes } } });
  await prisma.certificationCostEntry.deleteMany({ where: { programmeId: { in: created.programmes } } });
  await prisma.certificationProgramme.deleteMany({ where: { id: { in: created.programmes } } });
  await prisma.importRoute.deleteMany({ where: { id: { in: created.routes } } });
  await prisma.securityReview.deleteMany({ where: { scheduleId: { in: created.security } } });
  await prisma.sellerSecuritySchedule.deleteMany({ where: { id: { in: created.security } } });
  await prisma.insurancePolicyRecord.deleteMany({ where: { id: { in: created.insurance } } });
  await prisma.productComplianceEvidence.deleteMany({ where: { id: { in: created.evidence } } });
  const safetyIds = [...created.safety, ...(await prisma.safetyCase.findMany({ where: { sellerAccountId: { in: [desk.sellerAId, desk.sellerBId] } }, select: { id: true } })).map((s) => s.id)];
  await prisma.safetyCaseAction.deleteMany({ where: { safetyCaseId: { in: safetyIds } } });
  await prisma.safetyCaseScope.deleteMany({ where: { safetyCaseId: { in: safetyIds } } });
  await prisma.safetyCase.deleteMany({ where: { id: { in: safetyIds } } });
  await prisma.recallRehearsal.deleteMany({ where: { scenario: { startsWith: TAG } } });
  await prisma.launchReadinessItem.deleteMany({ where: { countryCode: { in: created.launch } } });
  await prisma.countryLaunch.deleteMany({ where: { countryCode: { in: created.launch } } });
  await prisma.refund.deleteMany({ where: { orderId: { in: [desk.orderId, ...created.orders] } } });
  // The extra orders, then the shared fixture.
  const groups = await prisma.sellerOrderGroup.findMany({ where: { orderId: { in: created.orders } }, select: { id: true } });
  await prisma.sellerOrderSettlement.deleteMany({ where: { sellerOrderGroupId: { in: groups.map((g) => g.id) } } });
  await prisma.sellerNotification.deleteMany({ where: { subjectId: { in: groups.map((g) => g.id) } } });
  await prisma.orderLineCommercialSnapshot.deleteMany({ where: { orderId: { in: created.orders } } });
  await prisma.commissionAdjustment.deleteMany({ where: { sellerOrderGroupId: { in: groups.map((g) => g.id) } } });
  await prisma.dispatchEvidence.deleteMany({ where: { sellerOrderGroupId: { in: groups.map((g) => g.id) } } });
  await prisma.custodyHandover.deleteMany({ where: { sellerOrderGroupId: { in: groups.map((g) => g.id) } } });
  await prisma.sellerOrderLine.deleteMany({ where: { orderGroupId: { in: groups.map((g) => g.id) } } });
  await prisma.sellerOrderGroup.deleteMany({ where: { orderId: { in: created.orders } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: created.orders } } });
  await prisma.order.deleteMany({ where: { id: { in: created.orders } } });
  await cleanUpAuditPeople(TAG);
  await cleanUpOrderDesk(TAG);
  await app.close();
});

describe('commercial schedules (Doc 08 s2-s6)', () => {
  it('imports every proposal as DRAFT and never activates one by itself', async () => {
    const rows = await prisma.commercialSchedule.findMany({ where: { version: 1 } });
    expect(rows.map((r) => r.kind).sort()).toEqual(['CASE_WINDOWS', 'CERTIFICATION_RECOVERY', 'COMMISSION', 'INSURANCE', 'LARGE_ORDER_DISCOUNT', 'LOGISTICS_CHARGE', 'PAYMENT_PLAN', 'SECURITY', 'SUBSCRIPTION']);
    const commission = rows.find((r) => r.kind === 'COMMISSION');
    expect(commission?.status).toBe('DRAFT');
    expect(((commission?.bodyJson as { rows: unknown[] }).rows).length).toBe(25);
  });

  it('refuses self-approval, missing evidence and missing provider confirmation', async () => {
    const { id } = await schedules.draftNewVersion('SECURITY', actor('finance1'));
    created.schedules.push(id);
    await schedules.submitForApproval(id, actor('finance1'));
    expect(await code(schedules.decideSchedule(id, { approve: true, evidence: 'x' }, actor('finance1')))).toBe('SEPARATION_OF_DUTIES_REQUIRED');
    await schedules.decideSchedule(id, { approve: true, evidence: 'Board minute synthetic' }, actor('finance2'));
    const err = await schedules.activateSchedule(id, actor('finance2')).catch((e: { code: string; details: { code: string }[] }) => e);
    expect((err as { code: string }).code).toBe('COMMERCIAL_SCHEDULE_NOT_ACTIVATABLE');
    expect((err as { details: { code: string }[] }).details.map((d) => d.code)).toEqual(expect.arrayContaining(['SIGNED_SCHEDULE_REFERENCE_MISSING', 'EFFECTIVE_DATE_MISSING', 'PROVIDER_CONFIRMATION_MISSING']));
  });

  it('previews the Doc 08 worked example over HTTP for finance, and refuses the catalogue team', async () => {
    const draft = await prisma.commercialSchedule.findFirstOrThrow({ where: { kind: 'COMMISSION', version: 1 } });
    const ok = await asStaff(app, desk.financeOne, 'GET', `/commercial/schedules/${draft.id}/preview?goodsMinor=10000000&channel=B2B`);
    expect(ok.statusCode).toBe(200);
    const med = ok.json<{ perDepartment: { department: string; commissionMinor: string }[] }>().perDepartment.find((r) => r.department === 'Medical Devices');
    expect(med?.commissionMinor).toBe('1250000');
    const ref = await asStaff(app, desk.financeOne, 'GET', '/commercial/reference');
    expect(ref.json<{ workedExample: { platformChargesBeforeTaxMinor: string } }>().workedExample.platformChargesBeforeTaxMinor).toBe('1290000');
    expect((await asStaff(app, desk.catalog, 'GET', '/commercial/schedules')).statusCode).toBe(403);
  });
});

describe('order controls (Doc 07 s1-s2)', () => {
  it('freezes a snapshot per line with seller, term, importer, money and policy versions', async () => {
    const rows = await prisma.orderLineCommercialSnapshot.findMany({ where: { orderId: desk.orderId } });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.sellerAccountId).toBe(desk.sellerAId);
      expect(r.commissionSource.length).toBeGreaterThan(0);
      expect(r.rounding).toBe('HALF_UP_PER_LINE');
      expect(r.policyVersionsJson).not.toBeNull();
    }
  });

  it('defaults an international business order to DAP with the buyer as importer; a consumer is never assumed an importer', async () => {
    const b2b = await newOrder('US', true);
    const b2bLine = await prisma.orderLineCommercialSnapshot.findFirstOrThrow({ where: { orderId: b2b.orderId } });
    expect([b2bLine.deliveryTerm, b2bLine.importerOfRecord]).toEqual(['DAP', 'BUYER']);
    const b2c = await newOrder('US', false);
    const b2cLine = await prisma.orderLineCommercialSnapshot.findFirstOrThrow({ where: { orderId: b2c.orderId } });
    expect(b2cLine.deliveryTerm).toBe('CONSUMER');
    expect(b2cLine.controlGapsJson).toEqual(expect.arrayContaining(['IMPORTER', 'LOCAL_ACTORS']));
  });

  it('payment success is not acceptance: enforced acceptance needs the recorded controls', async () => {
    const o = await newOrder('IN', true);
    Object.assign(env, { DELIVERY_POLICY_GATES: 'enforce' });
    try {
      expect(await code(orders.assertAcceptanceControls(prisma, o.groupId))).toBe('ORDER_ACCEPTANCE_CONTROLS_MISSING');
      const res = await asCustomer(app, desk.sellerA, 'PATCH', `/seller/orders/${o.groupId}/controls`, { payload: { returnRoute: 'Return to seller site, Pune', packagingNote: '1 carton', transportRestrictionsReviewed: true, insurance: { decided: true, arrangement: 'Carrier liability; domestic courier' } }, idempotencyKey: newId() });
      expect(res.statusCode).toBe(204);
      const line = await prisma.orderLineCommercialSnapshot.findFirstOrThrow({ where: { orderId: o.orderId } });
      expect(line.controlGapsJson).not.toContain('RETURN_ROUTE');
      // B (another seller) cannot read or write A's order.
      expect((await asCustomer(app, desk.sellerB, 'GET', `/seller/orders/${o.groupId}/controls`)).statusCode).toBe(404);
    } finally {
      Object.assign(env, { DELIVERY_POLICY_GATES: 'off' });
    }
  });

  it('elects FCA only with an approval reference, DDP only with an approved arrangement', async () => {
    const o = await newOrder('DE', true);
    const ddp = await asCustomer(app, desk.sellerA, 'PATCH', `/seller/orders/${o.groupId}/controls`, { payload: { election: { term: 'DDP', approvalReference: 'none' } }, idempotencyKey: newId() });
    expect(errorCode(ddp)).toBe('ORDER_ACCEPTANCE_CONTROLS_MISSING');
    const fca = await asCustomer(app, desk.sellerA, 'PATCH', `/seller/orders/${o.groupId}/controls`, { payload: { election: { term: 'FCA', approvalReference: 'Buyer PO clause 4 election' } }, idempotencyKey: newId() });
    expect(fca.statusCode).toBe(204);
    expect((await prisma.orderLineCommercialSnapshot.findFirstOrThrow({ where: { orderId: o.orderId } })).deliveryTerm).toBe('FCA');
  });
});

describe('checkout routes, country launch and safety (Doc 07 s4, Doc 08 s11)', () => {
  it('blocks a cross-border consumer basket without an approved import route; business and domestic are untouched', async () => {
    const product = await prisma.orderItem.findUniqueOrThrow({ where: { id: desk.itemId }, select: { productId: true, sellerOfferId: true } });
    await prisma.sellerAccount.update({ where: { id: desk.sellerAId }, data: { registrationCountry: 'IN' } });
    Object.assign(env, { DELIVERY_POLICY_GATES: 'enforce' });
    try {
      const items = [{ productId: product.productId, sellerOfferId: product.sellerOfferId }];
      expect(await code(orders.assertCheckoutDeliveryRules(prisma, { countryCode: 'FR', channel: 'B2C', items }))).toBe('IMPORT_ROUTE_NOT_APPROVED');
      await orders.assertCheckoutDeliveryRules(prisma, { countryCode: 'FR', channel: 'B2B', items });
      await orders.assertCheckoutDeliveryRules(prisma, { countryCode: 'IN', channel: 'B2C', items });
      const route = (await orders.upsertImportRoute({ countryCode: 'FR', categoryId: null, channel: 'B2C', importerParty: 'APPROVED_ARRANGEMENT', importerName: 'Synthetic EU importer', localActors: [{ role: 'EU_RESPONSIBLE_PERSON', name: 'Synthetic RP', evidence: 'test', verified: true }], regulatedCategory: true, evidence: 'Synthetic route evidence' }, actor('desk'))) as { id: string };
      created.routes.push(route.id);
      expect(await code(orders.decideImportRoute(route.id, { approve: true, note: 'self' }, actor('desk')))).toBe('SEPARATION_OF_DUTIES_REQUIRED');
      await orders.decideImportRoute(route.id, { approve: true, note: 'Reviewed' }, actor('finance2'));
      await orders.assertCheckoutDeliveryRules(prisma, { countryCode: 'FR', channel: 'B2C', items });
    } finally {
      Object.assign(env, { DELIVERY_POLICY_GATES: 'off' });
    }
  });

  it('refuses a country with open launch decisions, enables none by default, and gates checkout when enforced', async () => {
    created.launch.push('NZ');
    expect(await code(evidence.enableCountry('NZ', 'try', actor('desk')))).toBe('COUNTRY_LAUNCH_BLOCKED');
    await evidence.saveLaunchItem('NZ', 'INSURANCE', { status: 'SUBMITTED', evidence: 'Broker letter synthetic', expiresAt: new Date(Date.now() + 86_400_000 * 300) }, actor('desk'));
    expect(await code(evidence.reviewLaunchItem('NZ', 'INSURANCE', { approve: true, note: 'own' }, actor('desk')))).toBe('SEPARATION_OF_DUTIES_REQUIRED');
    await evidence.reviewLaunchItem('NZ', 'INSURANCE', { approve: true, note: 'ok' }, actor('finance2'));
    const view = (await evidence.readLaunch('NZ')) as { blockers: { key: string }[] };
    expect(view.blockers.map((b) => b.key)).not.toContain('INSURANCE');
    expect(view.blockers.length).toBeGreaterThan(10);
    Object.assign(env, { COUNTRY_LAUNCH_GATE: 'enforce' });
    try {
      expect(await code(orders.assertCountryLaunched(prisma, 'NZ'))).toBe('COUNTRY_NOT_LAUNCHED');
    } finally {
      Object.assign(env, { COUNTRY_LAUNCH_GATE: 'off' });
    }
  });

  it('a safety containment stops purchase, repeat orders and dispatch at once, with every gate off, and only a different person releases it', async () => {
    const o = await newOrder('IN', true);
    const offerId = (await prisma.orderItem.findUniqueOrThrow({ where: { id: desk.itemId } })).sellerOfferId ?? '';
    const sc = await safety.openSafetyCase({ title: `${TAG} overheating`, description: 'Synthetic report', severity: 'HIGH', sourceType: 'STAFF', sellerAccountId: desk.sellerAId, scope: [{ kind: 'OFFER', ref: offerId }] }, actor('desk'));
    created.safety.push(sc.id);
    await safety.containSafetyCase(sc.id, { severity: 'HIGH', stopListings: true, stopShipments: true, stopRecurring: true, note: 'Stop affected stock' }, actor('desk'));
    expect(await code(assertOrderEligible(prisma, o.orderId, 'autopay-charge'))).toBe('PRODUCT_UNDER_SAFETY_HOLD');
    expect(await code(logistics.assertDispatchControls(prisma, o.groupId))).toBe('PRODUCT_UNDER_SAFETY_HOLD');
    const trace = (await safety.traceSafetyCase(sc.id)) as { orders: unknown[]; customers: number };
    expect(trace.orders.length).toBeGreaterThanOrEqual(2);
    expect(await code(safety.recordSafetyAction(sc.id, { kind: 'REPORTING_DECISION', detail: 'auto', decision: 'NOT_REQUIRED', authority: 'X', qualifiedRole: 'Bot', aiGenerated: true }, actor('desk')))).toBe('CASE_DECISION_NOT_REASONED');
    expect(await code(safety.releaseSafetyCase(sc.id, { note: 'done' }, actor('finance2')))).toBe('SAFETY_RELEASE_NOT_READY');
    await safety.recordCorrection(sc.id, { rootCause: 'Synthetic cause', correctionEvidence: 'Synthetic fix', verificationTests: 'Synthetic test', currentCertificates: 'Synthetic cert' }, actor('desk'));
    expect(await code(safety.releaseSafetyCase(sc.id, { note: 'own' }, actor('desk')))).toBe('SEPARATION_OF_DUTIES_REQUIRED');
    await safety.releaseSafetyCase(sc.id, { note: 'Verified correction' }, actor('finance2'));
    await assertOrderEligible(prisma, o.orderId, 'autopay-charge');
  });
});

describe('dispatch (Doc 07 s5)', () => {
  it('needs quantities, seals, photos and custody; partial shipments respect approval', async () => {
    const o = await newOrder('IN', true, 4);
    Object.assign(env, { DELIVERY_POLICY_GATES: 'enforce' });
    try {
      const err = await logistics.assertDispatchControls(prisma, o.groupId).catch((e: { code: string; details: { code: string }[] }) => e);
      expect((err as { details: { code: string }[] }).details.map((d) => d.code)).toEqual(expect.arrayContaining(['QUANTITIES', 'SEALS', 'PACKING_PHOTOS', 'CUSTODY_HANDOVER']));
      await logistics.saveDispatchEvidence(o.groupId, { quantities: [{ orderItemId: o.itemId, quantity: 4 }], seals: ['S-1'], packingPhotoRefs: ['photo://1'] }, { ...actor('desk'), role: 'STAFF' });
      await logistics.recordCustodyHandover(o.groupId, { fromParty: 'Seller A', toParty: 'Carrier X', place: 'Pune dock', handedOverAt: new Date(), packages: 1, sealsIntact: true }, { ...actor('desk'), role: 'STAFF' });
      await logistics.assertDispatchControls(prisma, o.groupId);
      expect(await code(logistics.approvePartialShipment(o.groupId, { orderApprovalRef: '', approvedByParty: 'BUYER', quantities: [{ orderItemId: o.itemId, quantity: 2 }] }, actor('desk')))).toBe('PARTIAL_SHIPMENT_NOT_ALLOWED');
      const partial = await logistics.approvePartialShipment(o.groupId, { orderApprovalRef: 'Buyer email 12', approvedByParty: 'BUYER', quantities: [{ orderItemId: o.itemId, quantity: 1 }] }, actor('desk'));
      expect(partial.billedMinor).toBe('10000');
    } finally {
      Object.assign(env, { DELIVERY_POLICY_GATES: 'off' });
    }
  });

  it('a material freight commitment needs two comparable quotes or a reason', async () => {
    const o = await newOrder('IN', true);
    const quote = { providerName: 'Carrier X', amountMinor: '6000000', currency: 'INR' };
    const base = { lane: 'IN-PNQ to IN-BOM', grossWeightGrams: 1000, dimensions: { lengthMm: 10, widthMm: 10, heightMm: 10, packages: 1 }, packaging: 'Carton', custody: [{ leg: 'L1', responsible: 'Seller' }], quotes: [quote], selectedIndex: 0 };
    expect(await code(logistics.saveFreightBooking(o.groupId, base, actor('desk')))).toBe('VALIDATION_FAILED');
    await logistics.saveFreightBooking(o.groupId, { ...base, singleSourceReason: 'Only licensed cold-chain carrier on the lane' }, actor('desk'));
  });
});

describe('cases (Doc 07 s6-s8)', () => {
  it('takes a late safety claim in for review and routes it; refuses a late ordinary delay', async () => {
    await prisma.order.update({ where: { id: desk.orderId }, data: { placedAt: new Date(Date.now() - 90 * 86_400_000) } });
    await prisma.sellerOrderGroup.updateMany({ where: { orderId: desk.orderId }, data: { deliveredAt: new Date(Date.now() - 80 * 86_400_000) } });
    const late = await asCustomer(app, desk.buyer, 'POST', '/disputes', { payload: { orderId: desk.orderId, orderItemId: desk.itemId, reasonCode: 'QUALITY', description: 'The unit sparked when switched on.', desiredOutcome: 'REPLACEMENT', case: { category: 'SAFETY', lateExplanation: 'Fault appeared only now' } }, idempotencyKey: newId() });
    expect(late.statusCode).toBe(201);
    const dispute = await prisma.dispute.findFirstOrThrow({ where: { orderId: desk.orderId, orderItemId: desk.itemId } });
    const profile = await prisma.disputeCaseProfile.findUniqueOrThrow({ where: { disputeId: dispute.id } });
    expect([profile.lateIntake, profile.lateIntakeReason, profile.urgency]).toEqual([true, 'RIGHTS_PRESERVED', 'URGENT']);
    expect(profile.safetyCaseId).not.toBeNull();
    const refused = await asCustomer(app, desk.buyer, 'POST', '/disputes', { payload: { orderId: desk.orderId, orderItemId: desk.secondItemId, reasonCode: 'NOT_RECEIVED', description: 'Arrived late.', desiredOutcome: 'REFUND_FULL', case: { category: 'DELAY' } }, idempotencyKey: newId() });
    expect(errorCode(refused)).toBe('DISPUTE_WINDOW_CLOSED');
    // The buyer sees their case controls; the rival buyer does not.
    expect((await asCustomer(app, desk.buyer, 'GET', `/disputes/${dispute.reference}/case-controls`)).statusCode).toBe(200);
    expect((await asCustomer(app, desk.rivalBuyer, 'GET', `/disputes/${dispute.reference}/case-controls`)).statusCode).toBe(404);
  });

  it('never resets the decision clock, refuses identity demands, needs a reasoned human decision and an independent appeal reviewer', async () => {
    const dispute = await prisma.dispute.findFirstOrThrow({ where: { orderId: desk.orderId, orderItemId: desk.itemId } });
    await cases.markEvidenceSufficient(dispute.id, 'Photos and inspection report agree on the defect.', actor('desk'));
    expect(await code(cases.markEvidenceSufficient(dispute.id, 'again', actor('desk')))).toBe('CONFLICT');
    expect(await code(cases.requestEvidence(dispute.id, { requestedFrom: 'BUYER', purpose: 'EVIDENCE', description: 'Send your passport scan', proportionalityNote: 'n/a' }, actor('desk')))).toBe('VALIDATION_FAILED');
    const req = await cases.requestEvidence(dispute.id, { requestedFrom: 'BUYER', purpose: 'MATERIAL_CONTRARY_EVIDENCE', description: 'The seller says the unit was dropped. Your answer?', proportionalityNote: 'Answering material contrary evidence' }, actor('desk'));
    const answer = await asCustomer(app, desk.buyer, 'POST', `/disputes/${dispute.reference}/case-controls/evidence-requests/${req.id}`, { payload: { note: 'It was not dropped; see the unopened box photo.' }, idempotencyKey: newId() });
    expect(answer.statusCode).toBe(204);
    expect(await code(cases.recordReasonedDecision(dispute.id, { reasoning: 'Model output', remedies: [{ kind: 'REFUND', amountMinor: null, payer: 'SELLER' }], returnFreightPayer: null, expectedCompletionAt: null, aiGenerated: true }, actor('desk')))).toBe('CASE_DECISION_NOT_REASONED');
    await cases.recordReasonedDecision(dispute.id, { reasoning: 'Defect proven by inspection; seller responsible for return freight.', remedies: [{ kind: 'REPLACEMENT', amountMinor: null, payer: 'SELLER' }, { kind: 'RETURN', amountMinor: null, payer: 'SELLER' }], returnFreightPayer: 'SELLER', expectedCompletionAt: new Date(Date.now() + 7 * 86_400_000) }, actor('desk'));
    // An appeal is decided only by someone who took no part.
    await prisma.dispute.update({ where: { id: dispute.id }, data: { status: 'APPEALED', decidedById: u.desk } });
    expect(await code(cases.assertDecisionControls(prisma, { id: dispute.id, status: 'APPEALED', decidedById: u.desk ?? null, approvedById: null, proposedById: null }, u.desk ?? ''))).toBe('SEPARATION_OF_DUTIES_REQUIRED');
    expect(await code(cases.assignAppealReviewer(dispute.id, u.desk ?? '', actor('finance2')))).toBe('SEPARATION_OF_DUTIES_REQUIRED');
    await cases.assignAppealReviewer(dispute.id, u.finance2 ?? '', actor('finance2'));
    await cases.assertDecisionControls(prisma, { id: dispute.id, status: 'APPEALED', decidedById: u.desk ?? null, approvedById: null, proposedById: null }, u.finance2 ?? '');
    const profile = await prisma.disputeCaseProfile.findUniqueOrThrow({ where: { disputeId: dispute.id } });
    expect(profile.appealReviewDueAt).not.toBeNull();
    await prisma.dispute.update({ where: { id: dispute.id }, data: { status: 'UNDER_REVIEW' } });
  });

  it('flags overlapping recoveries without blocking, and ignores a repeated provider event', async () => {
    const first = (await cases.recordLossRecovery({ orderId: desk.orderId, lossKey: 'transit-1', lossMinor: 20_000n, source: 'CARRIER', sourceReference: `${TAG}-c1`, amountMinor: 20_000n, currency: 'INR' }, actor('finance1'))) as { status: string };
    expect(first.status).toBe('RECORDED');
    const second = (await cases.recordLossRecovery({ orderId: desk.orderId, lossKey: 'transit-1', lossMinor: 20_000n, source: 'INSURER', sourceReference: `${TAG}-i1`, amountMinor: 15_000n, currency: 'INR' }, actor('finance1'))) as { status: string; excessMinor: string };
    expect([second.status, second.excessMinor]).toEqual(['INVESTIGATE', '15000']);
    const replay = (await cases.recordLossRecovery({ orderId: desk.orderId, lossKey: 'transit-1', lossMinor: 20_000n, source: 'INSURER', sourceReference: `${TAG}-i1`, amountMinor: 15_000n, currency: 'INR' }, null)) as { duplicate: boolean };
    expect(replay.duplicate).toBe(true);
  });
});

describe('refunds and commission (Doc 07 s9, Doc 08 s2)', () => {
  it('proposes a proportionate commission reversal once per refund, applied only by finance', async () => {
    const o = await newOrder('IN', true, 2);
    await prisma.orderLineCommercialSnapshot.updateMany({ where: { orderId: o.orderId }, data: { commissionMinor: 2_500n, commissionBaseMinor: 20_000n } });
    const pay = await prisma.paymentTransaction.findFirst({ select: { id: true } });
    if (pay === null) return; // no payment rows in this database: covered by the unit arithmetic
    await prisma.refund.create({ data: { id: newId(), orderId: o.orderId, paymentTransactionId: pay.id, provider: 'STRIPE' as never, amountMinor: 11_200n, currency: 'INR', reason: 'Synthetic', status: 'SUCCEEDED', idempotencyKey: `${TAG}-${o.orderId}` } as never });
    expect(await finance.proposeCommissionReversals(prisma, o.orderId)).toBe(1);
    expect(await finance.proposeCommissionReversals(prisma, o.orderId)).toBe(0);
    const adj = await prisma.commissionAdjustment.findFirstOrThrow({ where: { sellerOrderGroupId: o.groupId } });
    expect(adj.reversedMinor).toBe(1_250n); // half the goods refunded -> half the commission
    expect(adj.status).toBe('PROPOSED');
  });

  it('treats a timeout or 5xx as an unknown outcome, never as a failure', () => {
    expect(isAmbiguousProviderOutcome(new Error('socket hang up'))).toBe(true);
    expect(isAmbiguousProviderOutcome(new PaymentProviderError({ message: 'busy', httpStatus: 503 }))).toBe(true);
    expect(isAmbiguousProviderOutcome(new PaymentProviderError({ message: 'declined', httpStatus: 400 }))).toBe(false);
  });
});

describe('certification recovery (Doc 08 s4)', () => {
  it('cannot exceed the unrecovered cost however many checkouts race, releases and refunds give it back', async () => {
    const programme = await finance.createProgramme({ sellerAccountId: desk.sellerBId, title: `${TAG} programme`, currency: 'INR', periodStart: new Date(Date.now() - 86_400_000), periodEnd: new Date(Date.now() + 365 * 86_400_000) }, actor('finance1'));
    created.programmes.push(programme.id);
    const cost = await finance.recordProgrammeCost(programme.id, { kind: 'COST', externalReference: `${TAG}-inv-1`, supplierName: 'Synthetic body', amountMinor: 250_000n, currency: 'INR', evidence: 'Synthetic invoice' }, actor('finance1'));
    expect(await code(finance.recordProgrammeCost(programme.id, { kind: 'COST', externalReference: `${TAG}-inv-1`, supplierName: 'Again', amountMinor: 1n, currency: 'INR', evidence: 'dup' }, actor('finance1')))).toBe('CERTIFICATION_COST_DUPLICATE');
    expect(await code(finance.verifyProgrammeCost(cost.id, true, actor('finance1')))).toBe('SEPARATION_OF_DUTIES_REQUIRED');
    await finance.verifyProgrammeCost(cost.id, true, actor('finance2'));
    expect(await code(finance.setProgrammeStatus(programme.id, 'ACTIVE', actor('finance1')))).toBe('COMMERCIAL_SCHEDULE_NOT_ACTIVATABLE');
    await activate('CERTIFICATION_RECOVERY', undefined, 'Synthetic provider letter');
    await finance.setProgrammeStatus(programme.id, 'ACTIVE', actor('finance1'));
    // 20 simultaneous quotes of INR 1,00,000 each: 1% = INR 1,000 each, but only INR 2,500 is unrecovered.
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => finance.reserveCertificationCharge({ sellerAccountId: desk.sellerBId, quoteKey: `${TAG}-q${String(i)}`, netGoodsMinor: 10_000_000n, currency: 'INR' })));
    const amounts = results.map((r) => (r.status === 'fulfilled' && r.value !== null ? r.value.amountMinor : 0n));
    expect(amounts.reduce((s, a) => s + a, 0n)).toBe(250_000n);
    expect(amounts.every((a) => a <= 100_000n)).toBe(true);
    // A re-quote never raises what the buyer saw.
    const firstKey = results.findIndex((r) => r.status === 'fulfilled' && r.value !== null && r.value.amountMinor > 0n);
    const again = await finance.reserveCertificationCharge({ sellerAccountId: desk.sellerBId, quoteKey: `${TAG}-q${String(firstKey)}`, netGoodsMinor: 99_000_000n, currency: 'INR' });
    expect(again?.amountMinor).toBe(amounts[firstKey]);
    // Release one, then a refund of a confirmed one, both return to the balance.
    const allocations = await prisma.certificationRecoveryAllocation.findMany({ where: { programmeId: programme.id, amountMinor: { gt: 0n } } });
    await prisma.$transaction(async (tx) => finance.releaseCertificationCharge(tx, allocations[0]?.id ?? ''));
    await prisma.$transaction(async (tx) => finance.confirmCertificationCharge(tx, allocations[1]?.id ?? '', { orderId: desk.orderId, orderItemId: null }));
    await prisma.$transaction(async (tx) => finance.refundCertificationCharge(tx, allocations[1]?.id ?? '', 40_000n));
    const view = (await finance.readProgramme(programme.id)) as { unrecoveredMinor: string };
    expect(BigInt(view.unrecoveredMinor)).toBe((allocations[0]?.amountMinor ?? 0n) + 40_000n);
  });
});

describe('security, insurance and product evidence (Doc 07 s10, Doc 08 s6-s9)', () => {
  it('refuses stacked security without exposure, needs the adopted schedule and provider permission, and reviews monthly', async () => {
    expect(await code(finance.proposeSecuritySchedule({ sellerAccountId: desk.sellerAId, tier: 'HIGH_RISK', form: 'COMBINED', reserveBps: 1000, guaranteeMinor: 100_000n, capMinor: 50_000n, currency: 'INR', exposureBasis: 'Open disputes and returns', permittedUses: ['Refunds owed'] }, actor('finance1')))).toBe('SECURITY_EXPOSURE_REQUIRED');
    const s = await finance.proposeSecuritySchedule({ sellerAccountId: desk.sellerAId, tier: 'STANDARD', form: 'RESERVE', capMinor: 50_000n, currency: 'INR', exposureBasis: 'Trailing 90-day refund exposure', permittedUses: ['Refunds owed', 'Chargebacks lost'], scheduleReference: 'Synthetic seller schedule' }, actor('finance1'));
    created.security.push(s.id);
    expect(await code(finance.activateSecuritySchedule(s.id, { providerPermissionRef: 'Letter 1' }, actor('finance2')))).toBe('COMMERCIAL_SCHEDULE_NOT_ACTIVATABLE');
    await activate('SECURITY', undefined, 'Synthetic provider reserve permission');
    expect(await code(finance.activateSecuritySchedule(s.id, { providerPermissionRef: 'Letter 1' }, actor('finance1')))).toBe('SEPARATION_OF_DUTIES_REQUIRED');
    await finance.activateSecuritySchedule(s.id, { providerPermissionRef: 'Letter 1' }, actor('finance2'));
    const terms = await finance.activeReserveTerms(prisma, desk.sellerAId);
    expect(terms).toMatchObject({ reserveBps: 500, holdDays: 90, capMinor: 50_000n });
    await prisma.sellerSecuritySchedule.update({ where: { id: s.id }, data: { nextMonthlyReviewAt: new Date(Date.now() - 1000) } });
    expect(await finance.sweepSecurityReviews()).toBe(1);
    expect(await finance.sweepSecurityReviews()).toBe(0);
    const review = await prisma.securityReview.findFirstOrThrow({ where: { scheduleId: s.id } });
    expect(await code(finance.completeSecurityReview(review.id, { exposureMinor: 0n, outcome: 'CONSIDER_REDUCTION', note: 'Too early' }, actor('finance2')))).toBe('VALIDATION_FAILED');
    await finance.completeSecurityReview(review.id, { exposureMinor: 0n, outcome: 'NO_CHANGE', note: 'Nothing held yet' }, actor('finance2'));
  });

  it('records insurance with its gaps, verified only by a second person', async () => {
    const p = await finance.saveInsurancePolicy({ holderType: 'SELLER', sellerAccountId: desk.sellerAId, coverType: 'PRODUCT_LIABILITY', riskGroup: 'GROUP_3', insurer: 'Synthetic Insurer', policyNumber: 'PL-1', insuredEntity: 'Seller A Pvt Ltd', sites: ['Pune'], products: ['All'], territories: ['US'], currency: 'USD', perOccurrenceMinor: 100_000_000n, aggregateMinor: 200_000_000n, effectiveFrom: new Date(), expiresAt: new Date(Date.now() + 200 * 86_400_000) }, actor('finance1'));
    created.insurance.push(p.id);
    expect(await code(finance.verifyInsurancePolicy(p.id, { verified: true, method: 'self' }, actor('finance1')))).toBe('SEPARATION_OF_DUTIES_REQUIRED');
    await finance.verifyInsurancePolicy(p.id, { verified: true, method: 'Insurer portal check' }, actor('finance2'));
    const list = (await finance.listInsurance({ sellerAccountId: desk.sellerAId })) as { policies: { id: string; gaps: string[] }[] };
    expect(list.policies.find((x) => x.id === p.id)?.gaps).toEqual(expect.arrayContaining(['NO_BROKER_REVIEW', 'BELOW_PROPOSED_PER_OCCURRENCE', 'BELOW_PROPOSED_AGGREGATE']));
  });

  it('Audit records and verifies product evidence; Admin only reads it; withdrawn evidence blocks at once', async () => {
    const offerId = (await prisma.orderItem.findUniqueOrThrow({ where: { id: desk.itemId } })).sellerOfferId ?? '';
    const body = { sellerAccountId: desk.sellerAId, offerId, productKey: 'P1', productVersion: 'v1', facilityRef: 'SITE-1', countryCode: 'US', kind: 'PRODUCT_CERTIFICATE', scheme: 'Synthetic scheme', issuer: 'Synthetic body', scope: 'Model P1 v1 at site 1', requiredForTrading: true };
    // An Admin session cannot reach the Audit Console's decision routes.
    const asAdmin = await app.inject({ method: 'POST', url: '/api/v1/audit/product-evidence', headers: { cookie: owner.cookies, 'x-csrf-token': owner.csrfToken, 'x-forwarded-for': owner.ip }, payload: body });
    expect([401, 403]).toContain(asAdmin.statusCode);
    const rec = await asAudit(app, auditPeople.reviewer!.session, 'POST', '/audit/product-evidence', body);
    expect(rec.statusCode).toBe(201);
    const id = rec.json<{ id: string }>().id;
    created.evidence.push(id);
    const self = await asAudit(app, auditPeople.reviewer!.session, 'POST', `/audit/product-evidence/${id}/status`, { status: 'VERIFIED', method: 'Register', evidence: 'Found' });
    expect(errorCode(self)).toBe('SEPARATION_OF_DUTIES_REQUIRED');
    const ok = await asAudit(app, auditPeople.supervisor!.session, 'POST', `/audit/product-evidence/${id}/status`, { status: 'VERIFIED', method: 'Issuer register lookup', evidence: 'Certificate listed as valid' });
    expect(ok.statusCode).toBe(204);
    expect((await evidence.offersBlockedByEvidence(prisma, [offerId], 'US')).size).toBe(0);
    await evidence.setEvidenceStatus(id, { status: 'WITHDRAWN', reason: 'Issuer withdrew' }, actor('desk'));
    expect([...(await evidence.offersBlockedByEvidence(prisma, [offerId], 'US'))]).toEqual([offerId]);
    const adminRead = await asStaff(app, owner, 'GET', `/commercial/product-evidence?sellerAccountId=${desk.sellerAId}`);
    expect(adminRead.statusCode).toBe(200);
  });
});

describe('changed rules never rewrite a confirmed order', () => {
  it('an activated commission schedule prices new orders only', async () => {
    const before = await prisma.orderLineCommercialSnapshot.findMany({ where: { orderId: desk.orderId }, select: { commissionMinor: true, commissionBps: true } });
    const draft = await prisma.commercialSchedule.findFirstOrThrow({ where: { kind: 'COMMISSION', version: 1 } });
    const body = draft.bodyJson as { rows: { categorySlug: string | null }[] };
    const category = await prisma.product.findFirstOrThrow({ where: { slug: `${TAG}-product` }, select: { category: { select: { slug: true } } } });
    // Give the fixture's own category a row, at 7%, so the rate is visible.
    const id = await activate('COMMISSION', { ...body, rows: [...body.rows, { department: 'Synthetic', categorySlug: category.category.slug, b2bBps: 700, b2cBps: 700, consideration: 'test' }] });
    try {
      const o = await newOrder('IN', true);
      const line = await prisma.orderLineCommercialSnapshot.findFirstOrThrow({ where: { orderId: o.orderId } });
      expect([line.commissionBps, line.commissionMinor, line.commissionSource]).toEqual([700, 700n, 'COMMERCIAL_SCHEDULE']);
      const after = await prisma.orderLineCommercialSnapshot.findMany({ where: { orderId: desk.orderId }, select: { commissionMinor: true, commissionBps: true } });
      expect(after).toEqual(before);
    } finally {
      await schedules.retireSchedule(id, actor('finance2'), 'test over');
    }
  });
});
