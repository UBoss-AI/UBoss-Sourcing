/**
 * Where a commission invoice stands, and how it moves.
 *
 * The only place a commission invoice's `status` is decided - the rule the
 * order, schedule and support-ticket state machines follow. Pure: the service
 * applies what this allows inside its own transaction.
 *
 *   DRAFT ──issue──▶ ISSUED ──credit (part)──▶ PARTIALLY_CREDITED
 *     │                │ └──credit (rest)──▶ FULLY_CREDITED ◀──credit (rest)──┘
 *     └──discard──▶ VOID ◀──void (only where the settings permit)──┘
 *
 * Nothing leaves VOID or FULLY_CREDITED. An issued invoice is never edited and
 * never returns to DRAFT: a correction is a credit note, and a replacement is
 * a new invoice once the old one is fully credited.
 */
import { ErrorCode, conflict } from './errors.js';

export const CommissionInvoiceStatusValues = [
  'DRAFT',
  'ISSUED',
  'PARTIALLY_CREDITED',
  'FULLY_CREDITED',
  'VOID',
] as const;

export type CommissionInvoiceStatusName = (typeof CommissionInvoiceStatusValues)[number];

export type CommissionInvoiceMove = 'ISSUE' | 'REGENERATE' | 'DISCARD' | 'CREDIT_PART' | 'CREDIT_REST' | 'VOID_ISSUED';

const MOVES: Readonly<Record<CommissionInvoiceMove, { from: readonly CommissionInvoiceStatusName[]; to: CommissionInvoiceStatusName | null }>> = Object.freeze({
  ISSUE: { from: ['DRAFT'], to: 'ISSUED' },
  /** Rebuilding a draft from its sources. The status does not change. */
  REGENERATE: { from: ['DRAFT'], to: null },
  DISCARD: { from: ['DRAFT'], to: 'VOID' },
  CREDIT_PART: { from: ['ISSUED', 'PARTIALLY_CREDITED'], to: 'PARTIALLY_CREDITED' },
  CREDIT_REST: { from: ['ISSUED', 'PARTIALLY_CREDITED'], to: 'FULLY_CREDITED' },
  VOID_ISSUED: { from: ['ISSUED'], to: 'VOID' },
});

/** Statuses in which an invoice is the live one for its commission event. */
export const ACTIVE_STATUSES: readonly CommissionInvoiceStatusName[] = Object.freeze(['DRAFT', 'ISSUED', 'PARTIALLY_CREDITED']);

/** Statuses that carry a number, a PDF and frozen contents. */
export const ISSUED_STATUSES: readonly CommissionInvoiceStatusName[] = Object.freeze(['ISSUED', 'PARTIALLY_CREDITED', 'FULLY_CREDITED']);

export function isActiveStatus(status: string): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

export function isIssuedStatus(status: string): boolean {
  return (ISSUED_STATUSES as readonly string[]).includes(status);
}

export function canMove(status: string, move: CommissionInvoiceMove): boolean {
  return (MOVES[move].from as readonly string[]).includes(status);
}

/**
 * The status after `move`, or a conflict naming why it is not allowed. An
 * issued invoice asked to be regenerated or discarded is told it is
 * immutable, which is the answer a person actually needs.
 */
export function assertCommissionMove(status: string, move: CommissionInvoiceMove): CommissionInvoiceStatusName {
  if (!canMove(status, move)) {
    if (isIssuedStatus(status) && (move === 'REGENERATE' || move === 'DISCARD' || move === 'ISSUE')) {
      throw conflict(
        ErrorCode.COMMISSION_INVOICE_IMMUTABLE,
        'This invoice has been issued and can no longer change. Correct it with a credit note.',
        [{ code: 'ISSUED', meta: { status } }],
      );
    }
    throw conflict(ErrorCode.COMMISSION_INVOICE_INVALID_TRANSITION, `A ${status.toLowerCase().replace(/_/g, ' ')} invoice cannot be ${verb(move)}.`, [
      { code: 'INVALID_TRANSITION', meta: { status, move } },
    ]);
  }
  return MOVES[move].to ?? (status as CommissionInvoiceStatusName);
}

/** The live key an invoice holds in a status: its settlement id, or null. */
export function activeKeyFor(status: CommissionInvoiceStatusName, settlementId: string): string | null {
  return isActiveStatus(status) ? settlementId : null;
}

function verb(move: CommissionInvoiceMove): string {
  switch (move) {
    case 'ISSUE':
      return 'issued';
    case 'REGENERATE':
      return 'regenerated';
    case 'DISCARD':
      return 'discarded';
    case 'CREDIT_PART':
    case 'CREDIT_REST':
      return 'credited';
    case 'VOID_ISSUED':
      return 'voided';
  }
}
