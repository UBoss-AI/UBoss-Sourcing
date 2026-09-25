/**
 * One gateway Customer per person, and one person per gateway Customer.
 *
 * Stripe keeps a customer's saved cards on a Customer object (cus_...). Every
 * Checkout Session for that person must be opened against THE SAME one: it is
 * what makes Stripe offer them the card they saved last time, and it is what
 * keeps a card saved today next to the one saved in March rather than on a
 * parallel record nothing joins back to.
 *
 * The rules, each of which is a way this has gone wrong elsewhere:
 *
 *   1. **Ownership is our customer profile id and nothing else.** Never an
 *      email address - two people share a purchasing inbox, one person has two
 *      addresses, and an address can be changed - and never an id a browser
 *      sent. A request can only ever reach the Customer filed under the
 *      profile its session belongs to.
 *   2. **Race-safe by the database.** Two first checkouts in two tabs both
 *      find no row, both create a Customer, and both insert. The UNIQUE index
 *      on (profile, gateway, mode) lets exactly one insert land; the other
 *      reads the winner back and uses it. Its own Customer is left orphaned at
 *      Stripe, which is harmless - it has no cards and nothing points at it.
 *   3. **Per mode.** A test-mode cus_ does not exist in live mode.
 *   4. **A Customer Stripe no longer has is forgotten, not trusted.** Deleted
 *      in the dashboard, or from before the operator changed Stripe accounts:
 *      the caller drops the row and a fresh Customer is made.
 */
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import type { CardVaultProvider } from './provider.js';

export interface CustomerIdentity {
  customerProfileId: string;
  email: string | null;
  name: string | null;
  phone: string | null;
}

/** The customer's gateway record, if one is on file. A read; creates nothing. */
export async function findProviderCustomer(
  provider: Pick<CardVaultProvider, 'kind' | 'mode'>,
  customerProfileId: string,
): Promise<string | null> {
  const row = await prisma.paymentProviderCustomer.findUnique({
    where: {
      customerProfileId_provider_mode: {
        customerProfileId,
        provider: provider.kind,
        mode: provider.mode,
      },
    },
    select: { providerCustomerId: true },
  });

  return row?.providerCustomerId ?? null;
}

/**
 * Find or create this person's Customer at the gateway, and file it.
 *
 * Adopts the cus_ from their saved cards when there is no row yet - every
 * customer who saved a card before this table existed already has one, and a
 * second Customer would split their cards across two records.
 */
export async function ensureProviderCustomer(
  provider: CardVaultProvider,
  identity: CustomerIdentity,
): Promise<string> {
  const filed = await findProviderCustomer(provider, identity.customerProfileId);
  if (filed !== null) return filed;

  const fromSavedCard = await prisma.customerPaymentMethod.findFirst({
    where: {
      customerProfileId: identity.customerProfileId,
      provider: provider.kind,
      providerCustomerId: { not: '' },
    },
    orderBy: { createdAt: 'desc' },
    select: { providerCustomerId: true },
  });

  const candidate =
    fromSavedCard?.providerCustomerId ??
    (await provider.ensureVaultCustomer({
      providerCustomerId: null,
      customerEmail: identity.email,
      customerName: identity.name,
      customerPhone: identity.phone,
      customerProfileId: identity.customerProfileId,
      // Fresh per attempt. Concurrency is the index's job below, and a fixed
      // key would replay a Customer the gateway has since deleted.
      idempotencyKey: `vault-customer:${identity.customerProfileId}:${provider.mode}:${newId()}`,
    }));

  await prisma.paymentProviderCustomer.createMany({
    data: [
      {
        id: newId(),
        customerProfileId: identity.customerProfileId,
        provider: provider.kind,
        mode: provider.mode,
        providerCustomerId: candidate,
      },
    ],
    skipDuplicates: true,
  });

  // Read back rather than trust the insert: under a race, the row that landed
  // may be the other request's, and that is the one everybody must use.
  const winner = await findProviderCustomer(provider, identity.customerProfileId);

  if (winner === null) {
    /*
     * Nothing is filed under this profile, yet the insert was refused. The only
     * index left that could refuse it is the one on the cus_ itself: this
     * Customer is already filed under SOMEBODY ELSE. Using it would show this
     * person another customer's saved cards, so it is refused outright.
     */
    logger.error(
      { customerProfileId: identity.customerProfileId, provider: provider.kind },
      'a gateway customer record is already filed under a different customer; refusing to share it',
    );
    throw new Error('The gateway customer record belongs to another customer.');
  }

  if (winner !== candidate) {
    logger.info(
      { customerProfileId: identity.customerProfileId, provider: provider.kind },
      'two requests created a gateway customer at once; using the one that was filed first',
    );
  }

  return winner;
}

/**
 * Drop a filed Customer the gateway says it does not have.
 *
 * Conditional on the id, so a request holding a stale id cannot delete a row
 * another request has just replaced.
 */
export async function forgetProviderCustomer(
  provider: Pick<CardVaultProvider, 'kind' | 'mode'>,
  customerProfileId: string,
  providerCustomerId: string,
): Promise<void> {
  await prisma.paymentProviderCustomer.deleteMany({
    where: {
      customerProfileId,
      provider: provider.kind,
      mode: provider.mode,
      providerCustomerId,
    },
  });
}
