/**
 * The name this deployment trades under, for text a person reads.
 *
 * Every buyer of this software runs their own marketplace under their own
 * name, so a sentence that names the marketplace - a payment sheet, the issuer
 * in an authenticator app - takes it from the business profile the operator
 * filled in under Settings, never from a literal in the source. A literal is
 * how Northwind's customers end up paying "UBOSS Sourcing".
 *
 * Where no profile row exists yet (a fresh install before anybody has been
 * near Settings) it falls back to the product's own name, the same fallback
 * `getStorefrontConfig` and the storefront use: there is no shop's name to be
 * had, and naming the software is the one honest thing left.
 *
 * Text that is STORED and read later - an audit label, a notification row -
 * says "the marketplace" instead of calling this. A stored name goes stale the
 * day the operator renames their business, and a role reads correctly forever.
 *
 * Deliberately free of imports, so a payment adapter can take the fallback
 * without pulling the database client in with it. The caller hands over the
 * client - `prisma`, or the transaction it is already in.
 */

/** The product's own name. See `apps/customer-web/src/lib/brand.ts`. */
export const PRODUCT_NAME = 'Glovia';

/** The trading name to show, given whatever the profile holds. */
export function marketplaceNameFrom(displayName: string | null | undefined): string {
  const trimmed = (displayName ?? '').trim();
  return trimmed.length > 0 ? trimmed : PRODUCT_NAME;
}

/** The slice of a Prisma client this needs: the business profile, and nothing else. */
export interface BusinessProfileReader {
  businessProfile: {
    findFirst(args: { select: { displayName: true } }): Promise<{ displayName: string } | null>;
  };
}

/** The deployment's trading name, read from the business profile. */
export async function getMarketplaceName(client: BusinessProfileReader): Promise<string> {
  const profile = await client.businessProfile.findFirst({ select: { displayName: true } });
  return marketplaceNameFrom(profile?.displayName);
}
