/**
 * Reading a shop's identity out of a Host header.
 *
 * This is a security boundary, not a routing convenience: the answer decides
 * whose catalogue a shopper sees and whose prices they are charged. So the
 * cases worth pinning are the ones where a wrong answer is dangerous rather
 * than merely wrong.
 *
 * The ones that matter:
 *
 *   - **Off by default.** With no domain configured, every host is the
 *     operator's, which is what every existing deployment is.
 *   - **The bare domain is never a seller.** Nor is `www`, which a shop's
 *     domain conventionally also answers on — a seller who registered the slug
 *     `www` must not get the shop front.
 *   - **A host outside the configured domain is not a seller.** Somebody
 *     pointing `evil.example` at this server must not be able to name a seller
 *     by choosing a hostname.
 *   - **One label only.** `a.b.uboss.example` is not seller `a.b`; slugs have
 *     no dots, and treating a wildcard host as one would turn any subdomain
 *     into a shop.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as EnvModule from '../../src/config/env.js';
import type * as StorefrontModule from '../../src/modules/seller/storefront.service.js';

/**
 * Load the module with a chosen domain.
 *
 * The setting is read at module scope through `env`, so each case imports a
 * fresh copy rather than mutating a frozen object.
 */
async function withDomain(domain: string): Promise<typeof StorefrontModule> {
  vi.resetModules();

  // Spread the real module and override the one setting. Replacing it wholesale
  // breaks every other consumer of `env` that this module's imports drag in —
  // the logger and the Prisma client both read it at module scope.
  vi.doMock('../../src/config/env.js', async (importOriginal) => {
    const actual = await importOriginal<typeof EnvModule>();
    return { ...actual, env: { ...actual.env, SELLER_STOREFRONT_DOMAIN: domain } };
  });

  return import('../../src/modules/seller/storefront.service.js');
}

afterEach(() => {
  vi.doUnmock('../../src/config/env.js');
  vi.resetModules();
});

describe('sellerLabelFromHost', () => {
  it('names no seller when the feature is off', async () => {
    const { sellerLabelFromHost } = await withDomain('');

    // The default, and every deployment that has not opted in. Even a host that
    // looks exactly like a seller subdomain resolves to the operator.
    expect(sellerLabelFromHost('northwind.uboss.example')).toBeNull();
  });

  it('reads the label off a subdomain of the configured domain', async () => {
    const { sellerLabelFromHost } = await withDomain('uboss.example');

    expect(sellerLabelFromHost('northwind.uboss.example')).toBe('northwind');
  });

  it('ignores the port and the case', async () => {
    const { sellerLabelFromHost } = await withDomain('uboss.example');

    expect(sellerLabelFromHost('NorthWind.UBOSS.example:5174')).toBe('northwind');
  });

  it('treats the bare domain and www as the operator', async () => {
    const { sellerLabelFromHost } = await withDomain('uboss.example');

    expect(sellerLabelFromHost('uboss.example')).toBeNull();
    // A seller who managed to register the slug `www` must not get the shop
    // front the operator's own domain answers on.
    expect(sellerLabelFromHost('www.uboss.example')).toBeNull();
  });

  it('refuses a host outside the configured domain', async () => {
    const { sellerLabelFromHost } = await withDomain('uboss.example');

    // Somebody pointing their own name at this server must not be able to pick
    // a seller by choosing a hostname.
    expect(sellerLabelFromHost('northwind.evil.example')).toBeNull();
    // And a domain that merely ENDS with the same letters is not under it.
    expect(sellerLabelFromHost('northwind.notuboss.example')).toBeNull();
  });

  it('takes one label only', async () => {
    const { sellerLabelFromHost } = await withDomain('uboss.example');

    // Slugs have no dots. Reading `a.b` as a seller would make every wildcard
    // host a shop.
    expect(sellerLabelFromHost('a.b.uboss.example')).toBeNull();
  });

  it('handles a missing or empty host', async () => {
    const { sellerLabelFromHost } = await withDomain('uboss.example');

    expect(sellerLabelFromHost(undefined)).toBeNull();
    expect(sellerLabelFromHost('')).toBeNull();
  });

  it('is not confused by an empty label', async () => {
    const { sellerLabelFromHost } = await withDomain('uboss.example');

    expect(sellerLabelFromHost('.uboss.example')).toBeNull();
  });
});
