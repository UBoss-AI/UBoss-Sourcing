/**
 * Held funds, the transaction ledger, settlement and payouts (D13 facilitator
 * model): the finance console, the seller's own view in Seller Hub, and the
 * buyer's view of how their payment is protected.
 *
 * Reads need PAYMENT_READ (finance) or the seller's FINANCE_READ; anything
 * that moves or stops money needs FINANCE_POLICY_WRITE, and an early release
 * needs a second member of staff.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Permission } from '../../domain/permissions.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { prisma } from '../../infra/prisma.js';
import { notFound } from '../../domain/errors.js';
import {
  assertEscrowEnabled,
  decideEarlyRelease,
  evaluateHolds,
  liftManualHold,
  placeManualHold,
  requestEarlyRelease,
  runPayouts,
  sweepPaymentsAndRefunds,
  type StaffActor,
} from '../../modules/finance/escrow.service.js';
import {
  buyerPaymentProtection,
  listHolds,
  listLedgerOrders,
  listReconciliations,
  orderLedger,
  readReconciliation,
  refundsAndChargebacks,
  runReconciliation,
  sellerFinance,
  sellerHolds,
} from '../../modules/finance/finance-views.service.js';
import { listEntries } from '../../modules/finance/ledger.service.js';
import { currentUser, orderScopeWhere, requireAdmin, requireCustomer } from '../plugins/auth.js';
import { currentSeller, requireSeller } from '../plugins/seller.js';

const idParam = z.object({ id: z.string().length(26) });
const paging = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const reasonBody = z.object({ reason: z.string().trim().min(5).max(1000) });

const LEDGER_KINDS = [
  'PAYMENT_CAPTURED',
  'SALE_ALLOCATED',
  'REFUND_ISSUED',
  'REFUND_CHARGED_TO_SELLER',
  'FUNDS_RELEASED',
  'RESERVE_RELEASED',
  'PAYOUT_INITIATED',
  'PAYOUT_SETTLED',
  'CHARGEBACK_OPENED',
  'CHARGEBACK_WON',
  'CHARGEBACK_LOST',
  'CHARGEBACK_FEE',
  'REVERSAL',
] as const;

function staff(request: FastifyRequest): StaffActor {
  const user = currentUser(request);
  return { userId: user.id, label: user.email };
}

export function registerAdminFinanceRoutes(app: FastifyInstance): Promise<void> {

  // Orders with ledger activity, each with gross, fees, tax, refunds and settlement state.
  app.get('/finance/ledger/orders', { preHandler: requireAdmin(Permission.PAYMENT_READ) }, async (request, reply) => {
    const { page, pageSize } = paging.parse(request.query);
    return reply.header('cache-control', 'no-store').send(await listLedgerOrders(page, pageSize));
  });

  // One order's ledger: its summary, every journal entry, held funds, refunds and chargebacks.
  app.get('/finance/ledger/orders/:id', { preHandler: requireAdmin(Permission.PAYMENT_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.header('cache-control', 'no-store').send(await orderLedger(id));
  });

  // Journal entries, newest first, filtered by order, seller or kind.
  app.get('/finance/ledger/entries', { preHandler: requireAdmin(Permission.PAYMENT_READ) }, async (request, reply) => {
    const query = paging
      .extend({
        orderId: z.string().length(26).optional(),
        sellerAccountId: z.string().length(26).optional(),
        kind: z.enum(LEDGER_KINDS).optional(),
      })
      .parse(request.query);
    return reply.header('cache-control', 'no-store').send(await listEntries(query));
  });

  // Refunds and chargebacks with their accounting status in the ledger.
  app.get('/finance/refunds-chargebacks', { preHandler: requireAdmin(Permission.PAYMENT_READ) }, async (request, reply) => {
    const { page, pageSize } = paging.parse(request.query);
    return reply.header('cache-control', 'no-store').send(await refundsAndChargebacks(page, pageSize));
  });

  // Held funds per seller order, with their release conditions and any pending early release.
  app.get('/finance/holds', { preHandler: requireAdmin(Permission.PAYMENT_READ) }, async (request, reply) => {
    const query = paging.extend({ status: z.enum(['HELD', 'ON_HOLD', 'RELEASED']).optional() }).parse(request.query);
    return reply.header('cache-control', 'no-store').send(await listHolds(query.status, query.page, query.pageSize));
  });

  // Put held funds on hold by hand, with a reason.
  app.post('/finance/holds/:id/suspend', { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { reason } = reasonBody.parse(request.body);
    await placeManualHold(id, reason, staff(request));
    return reply.status(204).send();
  });

  // Lift a hold placed by staff.
  app.post('/finance/holds/:id/resume', { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await liftManualHold(id);
    return reply.status(204).send();
  });

  // Ask for an early release of held funds; a different member of staff decides it.
  app.post('/finance/holds/:id/release', { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { reason } = reasonBody.parse(request.body);
    return reply.status(201).send(await requestEarlyRelease(id, reason, staff(request)));
  });

  // Approve or reject an early release asked for by someone else.
  app.post('/finance/release-requests/:id/decide', { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z
      .object({ approve: z.boolean(), note: z.string().trim().max(1000).nullable().default(null) })
      .parse(request.body);
    await decideEarlyRelease(id, body.approve, body.note, staff(request));
    return reply.status(204).send();
  });

  // Post new payments and refunds to the ledger and re-check every hold's release terms now.
  app.post('/finance/escrow/refresh', { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE) }, async (_request, reply) => {
    assertEscrowEnabled();
    const posted = await sweepPaymentsAndRefunds();
    const evaluated = await evaluateHolds();
    return reply.send({ ...posted, ...evaluated });
  });

  // Send every seller's available balance to their connected payout account.
  app.post('/finance/payouts/run', { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE) }, async (request, reply) => {
    assertEscrowEnabled();
    return reply.send(await runPayouts(staff(request).label));
  });

  // Reconcile the ledger with payments, refunds, settlements and the provider's transfers for a period.
  app.post('/finance/reconcile', { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE) }, async (request, reply) => {
    const body = z
      .object({ periodStart: z.coerce.date(), periodEnd: z.coerce.date() })
      .refine((value) => value.periodEnd > value.periodStart, { message: 'periodEnd must be after periodStart' })
      .parse(request.body);
    return reply.status(201).send(await runReconciliation(body.periodStart, body.periodEnd, staff(request).label));
  });

  // Past reconciliation runs, newest first.
  app.get('/finance/reconciliations', { preHandler: requireAdmin(Permission.PAYMENT_READ) }, async (_request, reply) => {
    return reply.header('cache-control', 'no-store').send({ runs: await listReconciliations() });
  });

  // One reconciliation run and the differences it found.
  app.get('/finance/reconciliations/:id', { preHandler: requireAdmin(Permission.PAYMENT_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.header('cache-control', 'no-store').send(await readReconciliation(id));
  });

  return Promise.resolve();
}

export function registerSellerFinanceRoutes(app: FastifyInstance): Promise<void> {
  // The seller's receivables: gross, fees, refunds, held, reserve, available, in transit and paid out.
  app.get('/finance/balances', { preHandler: requireSeller(SellerPermission.FINANCE_READ) }, async (request, reply) => {
    return reply.header('cache-control', 'no-store').send(await sellerFinance(currentSeller(request).sellerAccountId));
  });

  // The seller's held funds per order, with each release condition and the payout that carried it.
  app.get('/finance/holds', { preHandler: requireSeller(SellerPermission.FINANCE_READ) }, async (request, reply) => {
    const { page, pageSize } = paging.parse(request.query);
    return reply
      .header('cache-control', 'no-store')
      .send(await sellerHolds(currentSeller(request).sellerAccountId, page, pageSize));
  });

  return Promise.resolve();
}

export function registerCustomerPaymentProtectionRoutes(app: FastifyInstance): Promise<void> {
  // How the buyer's payment on their own order is held and released: method, status, terms, per-seller milestones, receipts.
  app.get('/:id/payment-protection', { preHandler: requireCustomer }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const order = await prisma.order.findFirst({ where: { id, ...orderScopeWhere(request) }, select: { id: true } });
    if (order === null) throw notFound('Order');
    return reply.header('cache-control', 'no-store').send(await buyerPaymentProtection(order.id));
  });

  return Promise.resolve();
}
