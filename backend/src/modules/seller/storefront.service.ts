/**
 * Which shop a request is for.
 *
 * The operator's own storefront and a seller's are the same code serving
 * different catalogues, and what distinguishes them is the HOST the browser
 * asked for. `northwind.uboss.example` is Northwind's shop;
 * `uboss.example` is the operator's. Nothing else — no query parameter, no
 * header a client can set, no cookie — decides this, because all of those can
 * be forged by the shopper and the answer decides whose prices they are
 * charged.
 *
 * WHY BY HOST AND NOT BY A PICKER
 *
 * The obvious alternative is one storefront listing every seller's offer beside
 * the operator's, and it was built and removed. On `uboss.example` a shopper is
 * buying from the operator, and putting a competitor's cheaper price on that
 * page is not a choice that storefront should be offering. A seller who wants
 * to compete does it on their own shop front, at their own address, under their
 * own name.
 *
 * OFF BY DEFAULT
 *
 * `SELLER_STOREFRONT_DOMAIN` empty means there are no seller subdomains, which
 * is what every single-supplier deployment is and what every existing one is
 * today. Then this resolves to `null` for every request and the storefront
 * behaves exactly as it did before any of this existed.
 *
 * AN UNKNOWN SUBDOMAIN IS NOT THE OPERATOR
 *
 * `nosuchseller.uboss.example` resolves to a REFUSAL, not to the operator's
 * shop. Quietly serving the operator's catalogue under somebody else's name is
 * how a mistyped link becomes a shop that looks like a seller's and sells the
 * operator's stock at the operator's prices.
 */
import { env } from '../../config/env.js';
import { prisma } from '../../infra/prisma.js';
import { logoUrlFor } from './logo.service.js';

export interface SellerStorefront {
  sellerAccountId: string;
  slug: string;
  displayName: string;
  legalName: string;
  description: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  /** Built from the stored key on read, so moving the object store cannot
   *  leave a shop pointing at nothing. Null where the seller has not set one. */
  logoUrl: string | null;
}

/**
 * The result of looking at a host.
 *
 * Three states, and they are genuinely different. `OPERATOR` is the bare domain
 * or a deployment with the feature off. `SELLER` carries the shop. `UNKNOWN` is
 * a subdomain under the configured domain that matches no trading seller, and
 * it must be refused rather than folded into either of the others.
 */
export type HostResolution =
  | { kind: 'OPERATOR' }
  | { kind: 'SELLER'; seller: SellerStorefront }
  | { kind: 'UNKNOWN'; label: string };

/**
 * The subdomain label, or null where the host is not under the seller domain.
 *
 * Port and case are stripped; `www` is treated as the operator, because it is
 * the one label a shop's bare domain conventionally also answers on and nobody
 * should be able to register a seller slug that hijacks it.
 */
export function sellerLabelFromHost(host: string | undefined): string | null {
  const domain = env.SELLER_STOREFRONT_DOMAIN;
  if (domain.length === 0) return null;
  if (host === undefined || host.length === 0) return null;

  // `Host` carries the port, and an IPv6 literal carries brackets. Neither is
  // part of the name being matched.
  const name = host.toLowerCase().split(':')[0]?.replace(/^\[|\]$/g, '') ?? '';

  if (name === domain || name === `www.${domain}`) return null;
  if (!name.endsWith(`.${domain}`)) return null;

  const label = name.slice(0, -(domain.length + 1));

  // One level only. `a.b.uboss.example` is not seller `a.b` — slugs have no
  // dots — and treating it as one would make an arbitrary wildcard host look
  // like a shop.
  if (label.length === 0 || label.includes('.')) return null;
  if (label === 'www') return null;

  return label;
}

/**
 * Resolve a request's host to the shop it is for.
 *
 * Only an APPROVED seller gets a storefront. A business still applying, or one
 * that has been suspended, has no shop — serving one would keep taking orders
 * from a seller the operator has just stopped.
 */
export async function resolveHost(host: string | undefined): Promise<HostResolution> {
  const label = sellerLabelFromHost(host);

  if (label === null) return { kind: 'OPERATOR' };

  const seller = await prisma.sellerAccount.findFirst({
    where: { slug: label, status: 'APPROVED', archivedAt: null },
    select: {
      id: true,
      slug: true,
      displayName: true,
      legalName: true,
      description: true,
      businessProfile: { select: { supportEmail: true, supportPhone: true } },
      logoStorageKey: true,
    },
  });

  if (seller === null) return { kind: 'UNKNOWN', label };

  return {
    kind: 'SELLER',
    seller: {
      sellerAccountId: seller.id,
      slug: seller.slug,
      displayName: seller.displayName,
      legalName: seller.legalName,
      description: seller.description,
      supportEmail: seller.businessProfile?.supportEmail ?? null,
      supportPhone: seller.businessProfile?.supportPhone ?? null,
      logoUrl: logoUrlFor(seller.logoStorageKey),
    },
  };
}
