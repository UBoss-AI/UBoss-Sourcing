/**
 * Who is acting on a request for quotation, and which requests they may reach.
 *
 * TWO SIDES, NEVER MIXED
 *
 * A BUYER reaches a request through its owner - the person, or the company
 * they are acting for - and nothing else. A SELLER reaches a request only
 * through an invitation addressed to its own account, resolved from the
 * session's membership. Neither side ever names the other in a path it could
 * change to reach somebody else's request: a request id the caller cannot
 * reach answers 404, exactly like one that does not exist.
 *
 * THE BUYER'S SCOPE is the same line orders draw (`orderScopeWhere`):
 *
 *   - For themselves: requests they raised that were not raised for a
 *     company. Their company requests are not shown here.
 *   - For a company, as a BUYER: the company requests they raised.
 *   - For a company, in any other role: every request raised for it. Those
 *     roles exist to oversee the company's purchasing.
 *
 * What a member may DO inside that scope is decided by the company capability
 * at the route (PURCHASE for anything that asks sellers or commits to terms);
 * this file only decides what they may see.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { notFound } from '../../domain/errors.js';
import type { BuyerContext } from '../buyer-companies/context.service.js';
import type { SellerMembership } from '../seller/account.service.js';

export interface RfqBuyer {
  userId: string;
  email: string;
  customerProfileId: string;
  context: BuyerContext;
}

export interface RfqSupplier {
  sellerAccountId: string;
  displayName: string;
  userId: string;
  memberId: string;
  customerProfileId: string;
}

export function supplierFromMembership(
  membership: SellerMembership,
  userId: string,
): RfqSupplier {
  return {
    sellerAccountId: membership.sellerAccountId,
    displayName: membership.displayName,
    userId,
    memberId: membership.memberId,
    customerProfileId: membership.customerProfileId,
  };
}

/** The company a buyer acts for, or null for the person themselves. */
export function companyOf(buyer: RfqBuyer): string | null {
  return buyer.context.kind === 'COMPANY' ? buyer.context.companyId : null;
}

/** The `where` that keeps a request query inside this buyer's scope. */
export function buyerScopeWhere(buyer: RfqBuyer): Prisma.RfqRequestWhereInput {
  const context = buyer.context;
  if (context.kind === 'INDIVIDUAL') {
    return { customerProfileId: buyer.customerProfileId, buyerCompanyId: null };
  }
  if (context.role === 'BUYER') {
    return { customerProfileId: buyer.customerProfileId, buyerCompanyId: context.companyId };
  }
  return { buyerCompanyId: context.companyId };
}

/** Throw the one answer for "not yours" and "not there". */
export function rfqNotFound(): never {
  throw notFound('Request for quotation');
}
