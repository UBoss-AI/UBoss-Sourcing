/**
 * A seller's evidence, and what the marketplace does with it.
 *
 * The claims under test, each one a thing that would be silently wrong if it
 * broke:
 *
 *   - **Uploading is not approving.** A certificate goes up, and the step that
 *     needs it says "being checked" rather than ticking.
 *   - **A second upload supersedes the first** rather than replacing it, so the
 *     file an approval was granted against stays readable.
 *   - **Only the marketplace can accept one**, and accepting one is what
 *     completes the step - which is what decides whether the seller can submit
 *     at all.
 *   - **A refusal must say why**, and the reason reaches the seller.
 *   - **Another seller's document is invisible**, not merely un-rendered.
 *   - **The console's badge counts what is undecided**, and only for staff who
 *     hold the grant to decide it.
 *
 * The bytes are a real PDF header, because the upload path sniffs magic bytes
 * and a test that fed it `Buffer.from('hello')` would be testing nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/domain/errors.js';
import { Permission } from '../../src/domain/permissions.js';
import { permissionsForSellerRole } from '../../src/domain/seller-permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { readAttention } from '../../src/modules/notifications/attention.service.js';
import {
  decideSellerDocument,
  listSellerDocuments,
  uploadSellerDocument,
  withdrawSellerDocument,
} from '../../src/modules/seller/document.service.js';
import { readOnboarding } from '../../src/modules/seller/onboarding.service.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';

const ADMIN_EMAIL = 'documents-admin@test.local';
const REQUIREMENT = 'doc_test_ce_certificate';

let adminUserId = '';
let sellerId = '';
let rivalId = '';
let membership: SellerMembership;
let rivalMembership: SellerMembership;

/** Enough of a PDF that `sniffDocumentType` recognises it. */
function pdfBytes(marker: string): Buffer {
  return Buffer.from(`%PDF-1.7\n% ${marker}\n`, 'utf8');
}

async function makeSeller(slug: string, displayName: string): Promise<string> {
  const id = newId();

  await prisma.sellerAccount.create({
    data: {
      id,
      legalName: `${displayName} Ltd`,
      displayName,
      displayNameNormalized: displayName.toLowerCase(),
      slug,
      kind: 'WHOLESALER',
      registrationCountry: 'ZZ',
      status: 'DRAFT',
    },
  });

  return id;
}

function membershipFor(accountId: string, displayName: string, slug: string): SellerMembership {
  // Built by hand: what is under test is the service, not the login path.
  return {
    sellerAccountId: accountId,
    memberId: newId(),
    customerProfileId: newId(),
    displayName,
    legalName: `${displayName} Ltd`,
    slug,
    status: 'DRAFT',
    role: 'OWNER',
    permissions: permissionsForSellerRole('OWNER'),
    hasLock: false,
    isTrading: false,
    isApplicationEditable: true,
    registrationCountry: 'ZZ',
    logoStorageKey: null,
  };
}

async function cleanUp(): Promise<void> {
  await prisma.sellerDocument.deleteMany({});
  await prisma.sellerNotification.deleteMany({});
  await prisma.sellerAuditLog.deleteMany({});
  await prisma.adminNotificationRead.deleteMany({});
  await prisma.adminNotification.deleteMany({});
  await prisma.sellerOnboardingProgress.deleteMany({});
  await prisma.sellerAccount.deleteMany({ where: { slug: { startsWith: 'doc-' } } });
  await prisma.sellerOnboardingRequirement.deleteMany({ where: { countryKey: 'ZZ' } });
  await prisma.auditLog.deleteMany({ where: { resourceType: 'seller_document' } });
  await prisma.user.deleteMany({ where: { emailNormalized: ADMIN_EMAIL } });
}

beforeAll(async () => {
  await cleanUp();

  const admin = await prisma.user.create({
    data: {
      id: newId(),
      email: ADMIN_EMAIL,
      emailNormalized: ADMIN_EMAIL,
      passwordHash: 'x',
      type: 'ADMIN',
      status: 'ACTIVE',
    },
  });
  adminUserId = admin.id;

  /*
   * A country of this test's own, with exactly one required document.
   *
   * `ZZ` is a user-assigned ISO code, so it can never collide with a real
   * deployment's rows, and the sellers below register in it. Without a country
   * of our own the seeded global requirements would decide what "complete"
   * means and the assertions would move every time somebody edits the seed.
   */
  await prisma.sellerOnboardingRequirement.create({
    data: {
      id: newId(),
      countryKey: 'ZZ',
      stepKey: 'compliance',
      fieldKey: REQUIREMENT,
      label: 'CE certificate',
      isDocument: true,
      isRequired: true,
      sortOrder: 10,
    },
  });

  sellerId = await makeSeller('doc-acme', 'Doc Acme');
  rivalId = await makeSeller('doc-rival', 'Doc Rival');

  membership = membershipFor(sellerId, 'Doc Acme', 'doc-acme');
  rivalMembership = membershipFor(rivalId, 'Doc Rival', 'doc-rival');
});

/*
 * A clean slate per case, and the progress row is part of it.
 *
 * `SellerOnboardingProgress` is where a step's state lives, so a case that left
 * Compliance at UNDER_REVIEW would be the starting condition of the next one -
 * which is how a passing suite hides the very transition it claims to test.
 */
beforeEach(async () => {
  await prisma.sellerDocument.deleteMany({});
  await prisma.sellerOnboardingProgress.deleteMany({});
  await prisma.sellerNotification.deleteMany({});
  await prisma.adminNotificationRead.deleteMany({});
  await prisma.adminNotification.deleteMany({});
});

afterAll(async () => {
  await cleanUp();
});

describe('uploading evidence', () => {
  it('stores the file, leaves it undecided, and tells the marketplace', async () => {
    const document = await uploadSellerDocument({
      membership,
      kind: 'CE_CERTIFICATE',
      requirementFieldKey: REQUIREMENT,
      fileName: 'ce.pdf',
      bytes: pdfBytes('one'),
    });

    expect(document.status).toBe('PENDING');
    expect(document.kind).toBe('CE_CERTIFICATE');
    // The header decides nothing; the bytes said PDF and that is what is
    // recorded, whatever the browser claimed.
    expect(document.contentType).toBe('application/pdf');

    const notices = await prisma.adminNotification.findMany({
      where: { kind: 'seller.document.uploaded' },
    });

    expect(notices).toHaveLength(1);
    expect(notices[0]?.requiredPermission).toBe(Permission.CUSTOMER_READ);
    expect(notices[0]?.linkPath).toBe(`/sellers/${sellerId}`);
  });

  it('refuses anything that is not a PDF or a picture', async () => {
    await expect(
      uploadSellerDocument({
        membership,
        kind: 'CE_CERTIFICATE',
        fileName: 'notes.docx',
        // A ZIP header, which is what a .docx really is.
        bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.MEDIA_TYPE_NOT_ALLOWED });
  });

  it('supersedes the previous answer to the same requirement rather than deleting it', async () => {
    await uploadSellerDocument({
      membership,
      kind: 'CE_CERTIFICATE',
      requirementFieldKey: REQUIREMENT,
      fileName: 'first.pdf',
      bytes: pdfBytes('first'),
    });

    await uploadSellerDocument({
      membership,
      kind: 'CE_CERTIFICATE',
      requirementFieldKey: REQUIREMENT,
      fileName: 'second.pdf',
      bytes: pdfBytes('second'),
    });

    const live = await listSellerDocuments(membership);
    expect(live.map((row) => row.originalFileName)).toEqual(['second.pdf']);

    // The old row is kept. "We accepted their certificate in March" is only an
    // answer if the March file still exists.
    const all = await prisma.sellerDocument.findMany({ where: { sellerAccountId: sellerId } });
    expect(all).toHaveLength(2);
    expect(all.filter((row) => row.supersededAt !== null)).toHaveLength(1);
  });

  it('keeps one seller out of another seller’s documents', async () => {
    await uploadSellerDocument({
      membership,
      kind: 'CE_CERTIFICATE',
      requirementFieldKey: REQUIREMENT,
      fileName: 'mine.pdf',
      bytes: pdfBytes('mine'),
    });

    expect(await listSellerDocuments(rivalMembership)).toEqual([]);
  });
});

describe('the step behind the documents', () => {
  it('moves to being checked on upload and completes only on acceptance', async () => {
    const before = await readOnboarding(membership);
    expect(before.steps.find((step) => step.key === 'compliance')?.state).toBe('IN_PROGRESS');

    const document = await uploadSellerDocument({
      membership,
      kind: 'CE_CERTIFICATE',
      requirementFieldKey: REQUIREMENT,
      fileName: 'ce.pdf',
      bytes: pdfBytes('step'),
    });

    const waiting = await readOnboarding(membership);
    expect(waiting.steps.find((step) => step.key === 'compliance')?.state).toBe('UNDER_REVIEW');

    await decideSellerDocument({ documentId: document.id, decision: 'APPROVED', adminUserId });

    const done = await readOnboarding(membership);
    expect(done.steps.find((step) => step.key === 'compliance')?.state).toBe('COMPLETE');
  });

  it('drops back when the marketplace sends the document back', async () => {
    const document = await uploadSellerDocument({
      membership,
      kind: 'CE_CERTIFICATE',
      requirementFieldKey: REQUIREMENT,
      fileName: 'ce.pdf',
      bytes: pdfBytes('sendback'),
    });

    await decideSellerDocument({
      documentId: document.id,
      decision: 'REJECTED',
      reason: 'The certificate has expired.',
      adminUserId,
    });

    const after = await readOnboarding(membership);
    expect(after.steps.find((step) => step.key === 'compliance')?.state).toBe('IN_PROGRESS');

    const [seen] = await listSellerDocuments(membership);
    expect(seen?.status).toBe('REJECTED');
    expect(seen?.rejectedReason).toBe('The certificate has expired.');
  });

  it('treats an expired certificate as no certificate', async () => {
    const document = await uploadSellerDocument({
      membership,
      kind: 'CE_CERTIFICATE',
      requirementFieldKey: REQUIREMENT,
      fileName: 'ce.pdf',
      bytes: pdfBytes('expired'),
      expiresOn: new Date(Date.now() - 86_400_000),
    });

    await decideSellerDocument({ documentId: document.id, decision: 'APPROVED', adminUserId });

    const after = await readOnboarding(membership);
    // Accepted, and still not enough: a certificate that ran out yesterday is
    // not evidence today, and the seller learns that from their own checklist
    // rather than from a refusal weeks later.
    expect(after.steps.find((step) => step.key === 'compliance')?.state).toBe('IN_PROGRESS');
  });
});

describe('deciding one', () => {
  it('refuses a rejection with no reason', async () => {
    const document = await uploadSellerDocument({
      membership,
      kind: 'CE_CERTIFICATE',
      requirementFieldKey: REQUIREMENT,
      fileName: 'ce.pdf',
      bytes: pdfBytes('noreason'),
    });

    await expect(
      decideSellerDocument({ documentId: document.id, decision: 'REJECTED', adminUserId }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('tells the seller either way', async () => {
    const document = await uploadSellerDocument({
      membership,
      kind: 'CE_CERTIFICATE',
      requirementFieldKey: REQUIREMENT,
      fileName: 'ce.pdf',
      bytes: pdfBytes('notify'),
    });

    await decideSellerDocument({ documentId: document.id, decision: 'APPROVED', adminUserId });

    const notices = await prisma.sellerNotification.findMany({
      where: { sellerAccountId: sellerId, subjectType: 'seller_document' },
    });

    expect(notices).toHaveLength(1);
    expect(notices[0]?.severity).toBe('SUCCESS');
  });

  it('will not let a seller withdraw something already accepted', async () => {
    const document = await uploadSellerDocument({
      membership,
      kind: 'CE_CERTIFICATE',
      requirementFieldKey: REQUIREMENT,
      fileName: 'ce.pdf',
      bytes: pdfBytes('withdraw'),
    });

    await decideSellerDocument({ documentId: document.id, decision: 'APPROVED', adminUserId });

    await expect(withdrawSellerDocument(membership, document.id)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });
  });
});

describe('the console’s attention counts', () => {
  it('counts an undecided document and stops counting a decided one', async () => {
    const viewer = { permissions: [Permission.CUSTOMER_READ] };

    const before = await readAttention(viewer);
    const baseline = before.counts.sellerDocuments ?? 0;

    const document = await uploadSellerDocument({
      membership,
      kind: 'CE_CERTIFICATE',
      requirementFieldKey: REQUIREMENT,
      fileName: 'ce.pdf',
      bytes: pdfBytes('attention'),
    });

    const waiting = await readAttention(viewer);
    expect(waiting.counts.sellerDocuments).toBe(baseline + 1);

    await decideSellerDocument({ documentId: document.id, decision: 'APPROVED', adminUserId });

    const after = await readAttention(viewer);
    expect(after.counts.sellerDocuments).toBe(baseline);
  });

  it('omits a queue the viewer has no grant for, rather than reporting zero', async () => {
    // Zero is itself a fact about the business. The difference between "no
    // data-subject requests" and "you may not know" is the whole reason a key
    // is absent rather than nil.
    const view = await readAttention({ permissions: [Permission.CUSTOMER_READ] });

    expect(view.counts).not.toHaveProperty('dataRequests');
    expect(view.counts).not.toHaveProperty('logisticsExceptions');
    expect(view.counts).toHaveProperty('sellerApplications');
  });
});
