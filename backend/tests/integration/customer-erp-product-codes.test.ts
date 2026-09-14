/**
 * The product-code cross-reference: "their code X is our product Y".
 *
 * This exists because of a real connection rather than a hypothetical one. A
 * buyer's monday.com board held 708 finished-goods codes (`FG/1BZ1B1-G`); the
 * store's catalogue held 247 products (`EV-CANNULA-WP`). Both carry a barcode
 * column and the catalogue's was empty on every row, so the two systems shared
 * **no identifier at all**. The sync read 708 records and recorded one, and
 * that one was an accidental collision between two unrelated code systems.
 *
 * So the claims worth holding still are the ones that made that connection
 * work, plus the ones that stop it working WRONGLY:
 *
 *   - A mapping makes the sync resolve a code it could not resolve before.
 *   - **A mapping beats a matching SKU.** A mapping is a decision somebody is
 *     accountable for; a matching string is a coincidence, and both live
 *     catalogues contained one.
 *   - The reconciliation screen and the sync agree EXACTLY. A screen that
 *     reports a product as unmatched while the sync is quietly recording
 *     figures against it sends somebody hunting for a problem that is not there.
 *   - Nothing is ever guessed. No case folding, no punctuation stripping.
 *   - A bulk file skips its bad rows and imports the rest, because a file of
 *     seven hundred rows will have a few stale ones and refusing all of it is
 *     how somebody gives up and does nothing.
 *   - The tenant boundary holds, as everywhere else in this feature.
 *
 * Cleanup is in `afterAll` as well as `beforeEach` - orders are ON DELETE
 * RESTRICT and rows left behind break the FIRST file of the next run rather
 * than this one. See CLAUDE.md.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isAppError } from '../../src/domain/errors.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { listOrgAudit } from '../../src/modules/customer-erp/audit.service.js';
import { createConnection } from '../../src/modules/customer-erp/connection.service.js';
import {
  importProductCodes,
  linkProductCode,
  listProductCodes,
  unlinkProductCode,
} from '../../src/modules/customer-erp/product-code.service.js';
import {
  resolveMembership,
  type Membership,
} from '../../src/modules/customer-erp/organization.service.js';
import type { OrgActor } from '../../src/modules/customer-erp/audit.service.js';

const actor: OrgActor = {
  customerProfileId: null,
  email: 'buyer@example.test',
  correlationId: null,
};

/** The two code systems from the connection that motivated this. */
const THEIR_CODE = 'FG/1BZ1B1-G';
const OUR_SKU = 'XREF-EV-CANNULA-WP';
const SECOND_SKU = 'XREF-EF-SALINE';

let createdCategoryId: string | null = null;
let createdTaxClassId: string | null = null;

async function reset(): Promise<void> {
  await prisma.customerErpProductCode.deleteMany({});
  await prisma.customerErpInventoryLink.deleteMany({});
  await prisma.customerErpCredential.deleteMany({});
  await prisma.customerErpEndpoint.deleteMany({});
  await prisma.customerErpFieldMapping.deleteMany({});
  await prisma.customerErpSyncPolicy.deleteMany({});
  await prisma.customerErpConnection.deleteMany({});
  await prisma.customerErpAuditLog.deleteMany({});
  await prisma.buyerOrganizationMember.deleteMany({});
  await prisma.buyerOrganization.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.product.deleteMany({ where: { sku: { startsWith: 'XREF-' } } });
}

async function tidyReferenceRows(): Promise<void> {
  // Only what this file created, and only if nothing else adopted it.
  if (createdCategoryId !== null) {
    await prisma.category.deleteMany({ where: { id: createdCategoryId } }).catch(() => undefined);
    createdCategoryId = null;
  }
  if (createdTaxClassId !== null) {
    await prisma.taxClass.deleteMany({ where: { id: createdTaxClassId } }).catch(() => undefined);
    createdTaxClassId = null;
  }
}

async function referenceRows(): Promise<{ categoryId: string; taxClassId: string }> {
  const category = await prisma.category.findFirst({ select: { id: true } });
  const taxClass = await prisma.taxClass.findFirst({ select: { id: true } });

  let categoryId = category?.id ?? null;
  let taxClassId = taxClass?.id ?? null;

  if (categoryId === null) {
    const id = newId();
    await prisma.category.create({
      data: { id, name: 'XREF fixture', slug: `xref-${id.slice(-8).toLowerCase()}`, isActive: false },
    });
    createdCategoryId = id;
    categoryId = id;
  }

  if (taxClassId === null) {
    const id = newId();
    await prisma.taxClass.create({
      data: {
        id,
        code: `XREF-${id.slice(-6)}`,
        name: 'XREF fixture',
        ratePercent: '19',
        isActive: false,
      },
    });
    createdTaxClassId = id;
    taxClassId = id;
  }

  return { categoryId, taxClassId };
}

async function makeProduct(sku: string, name: string): Promise<string> {
  const { categoryId, taxClassId } = await referenceRows();
  const id = newId();

  await prisma.product.create({
    data: {
      id,
      categoryId,
      taxClassId,
      name,
      slug: `${sku.toLowerCase()}-${id.slice(-6).toLowerCase()}`,
      sku,
      basePriceMinor: 100_00n,
      currency: 'EUR',
      status: 'ACTIVE',
      isPublished: true,
    },
  });

  return id;
}

async function makeBuyer(): Promise<Membership> {
  const userId = newId();
  const profileId = newId();
  const email = `xref-${userId.slice(-8).toLowerCase()}@example.test`;

  await prisma.user.create({
    data: {
      id: userId,
      type: 'CUSTOMER',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword('Correct-Horse-9'),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });

  await prisma.customerProfile.create({
    data: { id: profileId, userId, fullName: 'Buyer', organization: 'XREF Medical' },
  });

  return resolveMembership(profileId);
}

async function makeConnection(membership: Membership): Promise<string> {
  // A monday connection, because monday is the case that motivated this: a
  // board id is required (`validateConfiguration` refuses without one), and a
  // personal token is allowed on SANDBOX and refused on PRODUCTION.
  const connection = await createConnection(membership, actor, {
    name: 'monday.com',
    system: 'MONDAY',
    environment: 'SANDBOX',
    baseUrl: 'https://api.monday.com',
    authMethod: 'MONDAY_PERSONAL_TOKEN',
    mondayBoardId: '5004637227',
    secrets: { personalToken: 'not-a-real-token' },
  } as never);

  return connection.id;
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await tidyReferenceRows();
});

describe('mapping a code to a product', () => {
  it('records the pairing and reads it back with the product it names', async () => {
    const membership = await makeBuyer();
    const connectionId = await makeConnection(membership);
    const productId = await makeProduct(OUR_SKU, 'Easy-Vein IV Cannula');

    const row = await linkProductCode(membership, actor, connectionId, {
      erpCode: THEIR_CODE,
      productId,
    });

    expect(row.erpCode).toBe(THEIR_CODE);
    expect(row.sku).toBe(OUR_SKU);

    const listed = await listProductCodes(membership, connectionId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.erpCode).toBe(THEIR_CODE);
    expect(listed[0]?.productName).toBe('Easy-Vein IV Cannula');
  });

  it('never guesses: case and punctuation are part of the code', async () => {
    // The whole value of this table is that it is an exact statement somebody
    // made. A lookup that case-folded would attach a stock figure to the wrong
    // item and be believed.
    const membership = await makeBuyer();
    const connectionId = await makeConnection(membership);
    const productId = await makeProduct(OUR_SKU, 'Easy-Vein IV Cannula');

    await linkProductCode(membership, actor, connectionId, { erpCode: THEIR_CODE, productId });

    const stored = await prisma.customerErpProductCode.findFirst({ where: { connectionId } });
    expect(stored?.erpCode).toBe('FG/1BZ1B1-G');
    // Not normalised into any of the shapes a helpful implementation reaches for.
    expect(stored?.erpCode).not.toBe('fg/1bz1b1-g');
    expect(stored?.erpCode).not.toBe('FG1BZ1B1G');
  });

  it('trims surrounding whitespace, because a code is pasted out of a spreadsheet', async () => {
    const membership = await makeBuyer();
    const connectionId = await makeConnection(membership);
    const productId = await makeProduct(OUR_SKU, 'Easy-Vein IV Cannula');

    const row = await linkProductCode(membership, actor, connectionId, {
      erpCode: `  ${THEIR_CODE}\t`,
      productId,
    });

    // Trailing cell whitespace is not a different product. Nothing INSIDE the
    // code is touched - `FG/1BZ1 B1` and `FG/1BZ1B1` genuinely might differ.
    expect(row.erpCode).toBe(THEIR_CODE);
  });

  it('re-mapping a code is an update, not a refusal', async () => {
    const membership = await makeBuyer();
    const connectionId = await makeConnection(membership);
    const wrong = await makeProduct(OUR_SKU, 'Wrong product');
    const right = await makeProduct(SECOND_SKU, 'Right product');

    await linkProductCode(membership, actor, connectionId, { erpCode: THEIR_CODE, productId: wrong });
    await linkProductCode(membership, actor, connectionId, { erpCode: THEIR_CODE, productId: right });

    const listed = await listProductCodes(membership, connectionId);
    // Somebody who mapped a code to the wrong product needs to fix it;
    // making them delete first would be ceremony.
    expect(listed).toHaveLength(1);
    expect(listed[0]?.productId).toBe(right);
  });

  it('refuses a product this catalogue does not have', async () => {
    const membership = await makeBuyer();
    const connectionId = await makeConnection(membership);

    await expect(
      linkProductCode(membership, actor, connectionId, { erpCode: THEIR_CODE, productId: newId() }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isAppError(error) && error.code === 'CUSTOMER_ERP_PRODUCT_CODE_INVALID',
    );
  });

  it('lets two of their codes mean one of our products', async () => {
    // A buyer whose ERP holds the same item under an old code and a new one
    // maps both, and both must resolve.
    const membership = await makeBuyer();
    const connectionId = await makeConnection(membership);
    const productId = await makeProduct(OUR_SKU, 'Easy-Vein IV Cannula');

    await linkProductCode(membership, actor, connectionId, { erpCode: 'FG/OLD-CODE', productId });
    await linkProductCode(membership, actor, connectionId, { erpCode: 'FG/NEW-CODE', productId });

    expect(await listProductCodes(membership, connectionId)).toHaveLength(2);
  });

  it('records who mapped what in the audit trail', async () => {
    // This is why the table itself carries no `createdByProfileId`: who did it
    // is recorded properly here, once, rather than copied into a catalogue
    // table the Art. 15 export would then have to account for.
    const membership = await makeBuyer();
    const connectionId = await makeConnection(membership);
    const productId = await makeProduct(OUR_SKU, 'Easy-Vein IV Cannula');

    await linkProductCode(membership, actor, connectionId, { erpCode: THEIR_CODE, productId });

    const audit = await listOrgAudit(membership.organizationId, { connectionId, limit: 20 });
    expect(audit.rows.some((entry) => entry.action === 'mapping.linked')).toBe(true);
  });
});

describe('removing a mapping', () => {
  it('takes the code back out', async () => {
    const membership = await makeBuyer();
    const connectionId = await makeConnection(membership);
    const productId = await makeProduct(OUR_SKU, 'Easy-Vein IV Cannula');

    const row = await linkProductCode(membership, actor, connectionId, {
      erpCode: THEIR_CODE,
      productId,
    });

    await unlinkProductCode(membership, actor, connectionId, row.id);

    expect(await listProductCodes(membership, connectionId)).toHaveLength(0);
  });
});

describe('a mapping whose product has gone', () => {
  it('reads back as broken rather than disappearing', async () => {
    // There is no foreign key to `products` - a restrictive one would let one
    // buyer's private mapping veto the operator's own catalogue, and a
    // cascading one would silently delete an afternoon's work when a product
    // was merely renamed and re-added. So a mapping can outlive its product,
    // and the screen has to be able to show that.
    const membership = await makeBuyer();
    const connectionId = await makeConnection(membership);
    const productId = await makeProduct(OUR_SKU, 'Easy-Vein IV Cannula');

    await linkProductCode(membership, actor, connectionId, { erpCode: THEIR_CODE, productId });
    await prisma.product.delete({ where: { id: productId } });

    const listed = await listProductCodes(membership, connectionId);

    expect(listed).toHaveLength(1);
    expect(listed[0]?.sku).toBeNull();
    expect(listed[0]?.productName).toBeNull();
  });
});

describe('the bulk file', () => {
  it('imports a two-column list and reports what it did', async () => {
    const membership = await makeBuyer();
    const connectionId = await makeConnection(membership);
    await makeProduct(OUR_SKU, 'Easy-Vein IV Cannula');
    await makeProduct(SECOND_SKU, 'Easy-Flush Saline');

    const result = await importProductCodes(
      membership,
      actor,
      connectionId,
      [
        'erp_code,sku',
        `${THEIR_CODE},${OUR_SKU}`,
        `FG/1BZ1B3-G,${SECOND_SKU}`,
      ].join('\n'),
    );

    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.skipped).toHaveLength(0);
    expect(await listProductCodes(membership, connectionId)).toHaveLength(2);
  });

  it('accepts semicolons and tabs, because a German Excel writes semicolons', async () => {
    const membership = await makeBuyer();
    const connectionId = await makeConnection(membership);
    await makeProduct(OUR_SKU, 'Easy-Vein IV Cannula');
    await makeProduct(SECOND_SKU, 'Easy-Flush Saline');

    const result = await importProductCodes(
      membership,
      actor,
      connectionId,
      [`${THEIR_CODE};${OUR_SKU}`, `FG/1BZ1B3-G\t${SECOND_SKU}`].join('\n'),
    );

    expect(result.created).toBe(2);
    expect(result.skipped).toHaveLength(0);
  });

  it('honours quoted fields, for a code containing the delimiter', async () => {
    const membership = await makeBuyer();
    const connectionId = await makeConnection(membership);
    await makeProduct(OUR_SKU, 'Easy-Vein IV Cannula');

    const result = await importProductCodes(
      membership,
      actor,
      connectionId,
      `"FG,WITH,COMMAS",${OUR_SKU}`,
    );

    expect(result.created).toBe(1);
    expect((await listProductCodes(membership, connectionId))[0]?.erpCode).toBe('FG,WITH,COMMAS');
  });

  it('skips the bad rows and imports the rest, naming the line', async () => {
    // A file of seven hundred rows will have a few stale ones. Refusing all of
    // it because of three is how somebody gives up and does nothing.
    const membership = await makeBuyer();
    const connectionId = await makeConnection(membership);
    await makeProduct(OUR_SKU, 'Easy-Vein IV Cannula');

    const result = await importProductCodes(
      membership,
      actor,
      connectionId,
      [
        `${THEIR_CODE},${OUR_SKU}`,
        'FG/GONE,XREF-NO-SUCH-SKU',
        'only-one-column',
        '',
        '# a comment',
      ].join('\n'),
    );

    expect(result.created).toBe(1);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0]?.line).toBe(2);
    expect(result.skipped[0]?.reason).toContain('XREF-NO-SUCH-SKU');
    expect(result.skipped[1]?.line).toBe(3);
  });

  it('counts a re-import of the same codes as updates, not duplicates', async () => {
    const membership = await makeBuyer();
    const connectionId = await makeConnection(membership);
    await makeProduct(OUR_SKU, 'Easy-Vein IV Cannula');

    const csv = `${THEIR_CODE},${OUR_SKU}`;

    await importProductCodes(membership, actor, connectionId, csv);
    const second = await importProductCodes(membership, actor, connectionId, csv);

    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(await listProductCodes(membership, connectionId)).toHaveLength(1);
  });
});

describe('the tenant boundary', () => {
  it('does not show one organisation another organisation mappings', async () => {
    const alice = await makeBuyer();
    const bob = await makeBuyer();

    const aliceConnection = await makeConnection(alice);
    const productId = await makeProduct(OUR_SKU, 'Easy-Vein IV Cannula');

    await linkProductCode(alice, actor, aliceConnection, { erpCode: THEIR_CODE, productId });

    // Bob asking about Alice's connection id by guessing it.
    expect(await listProductCodes(bob, aliceConnection)).toHaveLength(0);
  });

  it('refuses to map against another organisation connection', async () => {
    const alice = await makeBuyer();
    const bob = await makeBuyer();

    const aliceConnection = await makeConnection(alice);
    const productId = await makeProduct(OUR_SKU, 'Easy-Vein IV Cannula');

    await expect(
      linkProductCode(bob, actor, aliceConnection, { erpCode: THEIR_CODE, productId }),
    ).rejects.toThrow();
  });
});
