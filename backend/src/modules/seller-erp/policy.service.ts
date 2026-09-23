/**
 * What a seller wants synchronised, and when.
 *
 * THE DEFAULTS ARE THE DESIGN
 *
 * Everything that moves money in somebody's accounts starts OFF: the invoice,
 * the receipt, the credit note, the stock sync, the creation of masters. The
 * one thing that starts on is the Sales Order, and only because a Sales Order
 * recognises no revenue - it is a record that an order exists.
 *
 * A seller halfway through setup must never discover that vouchers have been
 * posting into their books since they pressed "connect". Every switch here is
 * one a person turned on, and every one of them is audited with the value it
 * had before.
 *
 * ORDER PLACEMENT AND REVENUE ARE NOT THE SAME EVENT
 *
 * `postSalesOrder` and `postSalesInvoice` are two switches on purpose. A
 * system that treated them as one would overstate a seller's turnover by every
 * order later cancelled, and would recognise revenue on the day a hospital
 * pressed "buy" rather than on the day the goods went out. `invoiceOnDispatch`
 * is the third part of the same question: some sellers invoice when the lorry
 * leaves and some when the money lands, and both are ordinary.
 */
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import {
  assertSellerOwnership,
  assertSellerPermission,
  type SellerMembership,
} from '../seller/account.service.js';
import { recordErpAudit } from './audit.service.js';
import { refreshMappingCompleteness } from './mapping.service.js';

export type InventoryAuthorityName = 'GLOVIA' | 'TALLY' | 'MANUAL' | 'DISABLED';
export type CancellationModeName = 'CREDIT_NOTE' | 'MARK_CANCELLED' | 'MANUAL';

export interface SyncPolicyView {
  postSalesOrder: boolean;
  postSalesInvoice: boolean;
  invoiceOnDispatch: boolean;
  postReceipt: boolean;
  postCreditNote: boolean;
  cancellationMode: CancellationModeName;
  syncStockItems: boolean;
  syncPartyLedgers: boolean;
  syncGodowns: boolean;
  inventoryAuthority: InventoryAuthorityName;
  inventoryPollMinutes: number | null;
  includePackagingNarration: boolean;
  narrationTemplate: string | null;
  maxAttempts: number;
  retryBaseSeconds: number;
  updatedAt: string;
}

export async function readPolicy(
  membership: SellerMembership,
  connectionId: string,
): Promise<SyncPolicyView> {
  assertSellerPermission(membership, SellerPermission.INTEGRATION_READ);
  await assertOwned(membership, connectionId);

  const policy = await prisma.sellerErpSyncPolicy.findUnique({ where: { connectionId } });

  if (policy === null) throw notFound('Sync policy');

  return toView(policy);
}

export type SyncPolicyPatch = Partial<Omit<SyncPolicyView, 'updatedAt'>>;

/**
 * Change the policy.
 *
 * A PATCH, not a replace: the screen sends the fields it changed, and a field
 * absent from the body is left alone. That matters because the policy screen
 * is several panels and a partial save must not silently switch off a panel
 * the seller was not looking at.
 *
 * Every changed field is audited individually, with its previous value. "Who
 * turned invoicing on, and when" is the question asked after an accountant
 * finds a month of unexpected vouchers, and a single "policy changed" row
 * cannot answer it.
 */
export async function updatePolicy(input: {
  membership: SellerMembership;
  connectionId: string;
  patch: SyncPolicyPatch;
  actorUserId: string | null;
  correlationId: string | null;
}): Promise<SyncPolicyView> {
  assertSellerPermission(input.membership, SellerPermission.INTEGRATION_WRITE);
  await assertOwned(input.membership, input.connectionId);

  const before = await prisma.sellerErpSyncPolicy.findUnique({
    where: { connectionId: input.connectionId },
  });

  if (before === null) throw notFound('Sync policy');

  const template = input.patch.narrationTemplate;

  if (template !== undefined && template !== null && template.length > 512) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'That narration template is too long.', [
      { field: 'narrationTemplate', code: 'TOO_LONG' },
    ]);
  }

  const after = await prisma.sellerErpSyncPolicy.update({
    where: { connectionId: input.connectionId },
    data: {
      postSalesOrder: input.patch.postSalesOrder,
      postSalesInvoice: input.patch.postSalesInvoice,
      invoiceOnDispatch: input.patch.invoiceOnDispatch,
      postReceipt: input.patch.postReceipt,
      postCreditNote: input.patch.postCreditNote,
      cancellationMode: input.patch.cancellationMode,
      syncStockItems: input.patch.syncStockItems,
      syncPartyLedgers: input.patch.syncPartyLedgers,
      syncGodowns: input.patch.syncGodowns,
      inventoryAuthority: input.patch.inventoryAuthority,
      inventoryPollMinutes: input.patch.inventoryPollMinutes,
      includePackagingNarration: input.patch.includePackagingNarration,
      narrationTemplate: template === null ? null : template?.trim() ?? undefined,
      maxAttempts: input.patch.maxAttempts,
      retryBaseSeconds: input.patch.retryBaseSeconds,
    },
  });

  /*
   * The inventory authority lives on the CONNECTION too.
   *
   * Duplicated deliberately: the dispatcher and the stock-snapshot writer both
   * read it, and both hold a connection rather than a policy. Kept in step
   * here, in the one place it can be changed, rather than joined on every read
   * of a hot path.
   */
  if (input.patch.inventoryAuthority !== undefined) {
    await prisma.sellerErpConnection.update({
      where: { id: input.connectionId },
      data: { inventoryAuthority: input.patch.inventoryAuthority },
    });
  }

  /*
   * A policy change moves what "complete" means.
   *
   * Switching invoicing on adds a required voucher type and an income ledger,
   * so a connection that was complete a moment ago is not any more - and the
   * status has to say so before the first invoice fails rather than after.
   */
  await refreshMappingCompleteness(input.connectionId);

  const fields: (keyof SyncPolicyView)[] = [
    'postSalesOrder',
    'postSalesInvoice',
    'invoiceOnDispatch',
    'postReceipt',
    'postCreditNote',
    'cancellationMode',
    'syncStockItems',
    'syncPartyLedgers',
    'syncGodowns',
    'inventoryAuthority',
    'includePackagingNarration',
  ];

  for (const field of fields) {
    const was = (before as unknown as Record<string, unknown>)[field];
    const now = (after as unknown as Record<string, unknown>)[field];
    if (was === now) continue;

    await recordErpAudit({
      sellerAccountId: input.membership.sellerAccountId,
      connectionId: input.connectionId,
      action: 'seller_erp.policy_changed',
      actor: { type: 'CUSTOMER', userId: input.actorUserId, label: input.membership.displayName },
      summary: `${field} changed from ${String(was)} to ${String(now)}.`,
      meta: {
        policyField: field,
        previousValue: typeof was === 'boolean' || typeof was === 'number' ? was : String(was),
        newValue: typeof now === 'boolean' || typeof now === 'number' ? now : String(now),
      },
      correlationId: input.correlationId,
    });
  }

  return toView(after);
}

/**
 * Let the platform create masters in Tally without being asked each time.
 *
 * Its own function rather than a field on the policy patch, and the separation
 * is the point: this is the one setting that lets this software WRITE TO
 * SOMEBODY'S CHART OF ACCOUNTS unprompted. Creating a ledger in a company's
 * books is not a convenience, it is an unrequested change to a financial
 * record, and it deserves its own decision with its own audit line rather than
 * a checkbox among fifteen.
 */
export async function setAutoCreateMasters(input: {
  membership: SellerMembership;
  connectionId: string;
  enabled: boolean;
  actorUserId: string | null;
  correlationId: string | null;
}): Promise<void> {
  assertSellerPermission(input.membership, SellerPermission.INTEGRATION_WRITE);
  await assertOwned(input.membership, input.connectionId);

  await prisma.sellerErpConnection.update({
    where: { id: input.connectionId },
    data: { autoCreateMasters: input.enabled },
  });

  await recordErpAudit({
    sellerAccountId: input.membership.sellerAccountId,
    connectionId: input.connectionId,
    action: 'seller_erp.auto_create_masters_changed',
    actor: { type: 'CUSTOMER', userId: input.actorUserId, label: input.membership.displayName },
    summary: input.enabled
      ? 'Glovia may now create ledgers, stock items and godowns in Tally without asking each time.'
      : 'Glovia will no longer create anything in Tally without being asked.',
    meta: { autoCreateMasters: input.enabled },
    correlationId: input.correlationId,
  });
}

async function assertOwned(membership: SellerMembership, connectionId: string): Promise<void> {
  const connection = await prisma.sellerErpConnection.findUnique({
    where: { id: connectionId },
    select: { sellerAccountId: true },
  });

  assertSellerOwnership(membership, connection?.sellerAccountId ?? null, 'ERP connection');
  if (connection === null) throw notFound('ERP connection');
}

function toView(policy: {
  postSalesOrder: boolean;
  postSalesInvoice: boolean;
  invoiceOnDispatch: boolean;
  postReceipt: boolean;
  postCreditNote: boolean;
  cancellationMode: string;
  syncStockItems: boolean;
  syncPartyLedgers: boolean;
  syncGodowns: boolean;
  inventoryAuthority: string;
  inventoryPollMinutes: number | null;
  includePackagingNarration: boolean;
  narrationTemplate: string | null;
  maxAttempts: number;
  retryBaseSeconds: number;
  updatedAt: Date;
}): SyncPolicyView {
  return {
    postSalesOrder: policy.postSalesOrder,
    postSalesInvoice: policy.postSalesInvoice,
    invoiceOnDispatch: policy.invoiceOnDispatch,
    postReceipt: policy.postReceipt,
    postCreditNote: policy.postCreditNote,
    cancellationMode: policy.cancellationMode as CancellationModeName,
    syncStockItems: policy.syncStockItems,
    syncPartyLedgers: policy.syncPartyLedgers,
    syncGodowns: policy.syncGodowns,
    inventoryAuthority: policy.inventoryAuthority as InventoryAuthorityName,
    inventoryPollMinutes: policy.inventoryPollMinutes,
    includePackagingNarration: policy.includePackagingNarration,
    narrationTemplate: policy.narrationTemplate,
    maxAttempts: policy.maxAttempts,
    retryBaseSeconds: policy.retryBaseSeconds,
    updatedAt: policy.updatedAt.toISOString(),
  };
}

/** Ensure a policy row exists. Used by the initial-sync path. */
export async function ensurePolicy(connectionId: string): Promise<void> {
  const existing = await prisma.sellerErpSyncPolicy.findUnique({ where: { connectionId } });
  if (existing !== null) return;
  await prisma.sellerErpSyncPolicy.create({ data: { id: newId(), connectionId } });
}
