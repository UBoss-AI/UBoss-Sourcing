/**
 * Uploading the mark that goes on a seller's own shop front.
 *
 * Small feature, one genuinely dangerous case. A seller storefront is served
 * from the seller's own subdomain, so a file this accepts is a file served
 * inline under a hostname their buyers trust — and an SVG is a script-capable
 * document, not a picture. Accepting one renamed `logo.png` is stored XSS
 * against that seller's shoppers.
 *
 * So the cases that matter are: the bytes decide the type, not the name and not
 * the header; replacing tidies up after itself rather than leaving objects
 * nobody can reach; and removing leaves a working shop rather than a broken
 * image.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { storage } from '../../src/infra/storage/index.js';
import { removeSellerLogo, uploadSellerLogo } from '../../src/modules/seller/logo.service.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';
import { permissionsForSellerRole } from '../../src/domain/seller-permissions.js';

/** A one-pixel PNG. Real magic bytes, which is all the sniffer reads. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A perfectly valid SVG, which is exactly why it must be refused. */
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

let sellerId = '';
let membership: SellerMembership;

async function cleanUp(): Promise<void> {
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: sellerId } });
  await prisma.sellerAccount.deleteMany({ where: { slug: 'logo-test' } });
}

beforeAll(async () => {
  await prisma.sellerAccount.deleteMany({ where: { slug: 'logo-test' } });

  const seller = await prisma.sellerAccount.create({
    data: {
      id: newId(),
      legalName: 'Logo Test Ltd',
      displayName: 'Logo Test',
      displayNameNormalized: 'logo test',
      slug: 'logo-test',
      kind: 'WHOLESALER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });
  sellerId = seller.id;

  // Built by hand rather than resolved from a session: what is under test is
  // the service, and creating a user, a profile and a membership to reach it
  // would make this a test of the login path that happens to upload a file.
  membership = {
    sellerAccountId: sellerId,
    memberId: newId(),
    customerProfileId: newId(),
    displayName: 'Logo Test',
    legalName: 'Logo Test Ltd',
    slug: 'logo-test',
    status: 'APPROVED',
    role: 'OWNER',
    permissions: permissionsForSellerRole('OWNER'),
    isTrading: true,
    isApplicationEditable: false,
    registrationCountry: 'IN',
  };
});

afterAll(async () => {
  await cleanUp();
});

describe('uploadSellerLogo', () => {
  it('stores a real image and records the key on the seller', async () => {
    const result = await uploadSellerLogo({ membership, buffer: PNG });

    expect(result.url).not.toBeNull();

    const account = await prisma.sellerAccount.findUniqueOrThrow({
      where: { id: sellerId },
      select: { logoStorageKey: true },
    });

    expect(account.logoStorageKey).not.toBeNull();
    // Built from the key rather than stored, so moving the object store cannot
    // leave a shop pointing at nothing.
    expect(result.url).toContain(account.logoStorageKey ?? '');
  });

  it('refuses an SVG however it is presented', async () => {
    // The dangerous case. An SVG served inline on a seller's own subdomain is
    // script running under a hostname their buyers trust.
    await expect(uploadSellerLogo({ membership, buffer: SVG })).rejects.toThrow();
  });

  it('refuses bytes that are not an image at all', async () => {
    await expect(
      uploadSellerLogo({ membership, buffer: Buffer.from('not a picture') }),
    ).rejects.toThrow();
  });

  it('deletes the old object when the logo is replaced', async () => {
    const before = await prisma.sellerAccount.findUniqueOrThrow({
      where: { id: sellerId },
      select: { logoStorageKey: true },
    });
    const oldKey = before.logoStorageKey ?? '';
    expect(oldKey).not.toBe('');

    await uploadSellerLogo({ membership, buffer: PNG });

    const after = await prisma.sellerAccount.findUniqueOrThrow({
      where: { id: sellerId },
      select: { logoStorageKey: true },
    });

    expect(after.logoStorageKey).not.toBe(oldKey);

    // A logo is replaced rather than versioned: nothing references the old one,
    // and leaving it behind is an object nobody can reach and nobody will
    // remove.
    await expect(storage.get(oldKey)).rejects.toThrow();
  });

  it('writes the change to the seller audit log', async () => {
    const entry = await prisma.sellerAuditLog.findFirst({
      where: { sellerAccountId: sellerId, action: 'seller.logo.updated' },
    });

    expect(entry).not.toBeNull();
  });
});

describe('removeSellerLogo', () => {
  it('clears the key and deletes the object', async () => {
    const before = await prisma.sellerAccount.findUniqueOrThrow({
      where: { id: sellerId },
      select: { logoStorageKey: true },
    });
    const key = before.logoStorageKey ?? '';

    await removeSellerLogo({ membership });

    const after = await prisma.sellerAccount.findUniqueOrThrow({
      where: { id: sellerId },
      select: { logoStorageKey: true },
    });

    // Null is a working shop, not a broken one: the storefront falls back to
    // the seller's initial.
    expect(after.logoStorageKey).toBeNull();
    await expect(storage.get(key)).rejects.toThrow();
  });

  it('refuses to remove a logo that is not there', async () => {
    // Told rather than silently accepted. A no-op that reports success is how
    // somebody concludes the button is broken.
    await expect(removeSellerLogo({ membership })).rejects.toThrow(/no logo to remove/i);
  });
});
