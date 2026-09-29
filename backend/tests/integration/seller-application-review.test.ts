/**
 * The seller application review (checklist Master row 12), at the service
 * layer: the ownership-and-registrations section, manual screening, the
 * evidence gate on approval, what the reviewer's read leaves out, the
 * expired-document sweep, and the existing document rules that had no test.
 *
 * Requirement rows are written for a made-up country, `QZ`, so nothing here
 * changes what any other file's sellers are asked for. India's rules (CIN by
 * legal form, the GSTIN check character, Udyam and IEC) are code, not rows, so
 * they need none.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { permissionsForSellerRole } from '../../src/domain/seller-permissions.js';
import type { SellerApplicationStatusName } from '../../src/domain/seller-state.js';
import { SELLER_EDITABLE_STATUSES, SELLER_TRADING_STATUSES } from '../../src/domain/seller-state.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';
import { approvalReadiness, recordScreening } from '../../src/modules/seller/application-review.service.js';
import { sweepExpiredSellerDocuments } from '../../src/modules/seller/document-expiry.service.js';
import {
  createSellerDocumentLink,
  decideSellerDocument,
  uploadSellerDocument,
} from '../../src/modules/seller/document.service.js';
import { readKyb, saveKyb, type KybInput } from '../../src/modules/seller/kyb.service.js';
import { decideApplication, readApplication } from '../../src/modules/seller/moderation.service.js';
import { saveBusinessProfile, submitApplication } from '../../src/modules/seller/onboarding.service.js';

const PREFIX = 'r12-';
const ADMIN_EMAIL = 'r12-reviewer@test.local';
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n', 'latin1');
const DAY = 24 * 60 * 60 * 1000;

let adminUserId = '';
let categoryId = '';
const sellers: string[] = [];

const ALL_STEPS_COMPLETE = Object.fromEntries(
  ['account_verification', 'business_identity', 'kyb_kyc', 'store_profile', 'locations', 'payout', 'compliance', 'agreements'].map(
    (key) => [key, { state: 'COMPLETE', updatedAt: new Date().toISOString(), message: null }],
  ),
);

function membershipFor(
  sellerAccountId: string,
  slug: string,
  status: SellerApplicationStatusName,
  country: string,
): SellerMembership {
  return {
    sellerAccountId,
    memberId: newId(),
    customerProfileId: newId(),
    displayName: `${slug} shop`,
    legalName: `${slug} Private Limited`,
    slug,
    status,
    role: 'OWNER',
    permissions: permissionsForSellerRole('OWNER'),
    hasLock: false,
    isTrading: SELLER_TRADING_STATUSES.includes(status),
    isApplicationEditable: SELLER_EDITABLE_STATUSES.includes(status),
    registrationCountry: country,
    logoStorageKey: null,
  };
}

async function makeSeller(
  name: string,
  status: SellerApplicationStatusName,
  country = 'QZ',
): Promise<SellerMembership> {
  const id = newId();
  const slug = `${PREFIX}${name}`;
  await prisma.sellerAccount.create({
    data: {
      id,
      legalName: `${slug} Private Limited`,
      displayName: `${slug} shop`,
      displayNameNormalized: `${slug}shop`.replace(/[^a-z0-9]/g, ''),
      slug,
      kind: 'WHOLESALER',
      registrationCountry: country,
      status,
    },
  });
  await prisma.sellerBusinessProfile.create({ data: { id: newId(), sellerAccountId: id } });
  await prisma.sellerOnboardingProgress.create({
    data: { id: newId(), sellerAccountId: id, stepsJson: {}, completedSteps: 0, requiredSteps: 0 },
  });
  sellers.push(id);
  return membershipFor(id, slug, status, country);
}

function baseKyb(overrides: Partial<KybInput> = {}): KybInput {
  return {
    legalForm: 'OTHER',
    udyamNumber: null,
    iecNumber: null,
    exportCapable: false,
    exportMarkets: [],
    yearsExporting: null,
    intendedCategoryIds: [],
    beneficialOwners: [
      {
        fullName: 'Asha Rao',
        nationality: 'IN',
        ownershipBasisPoints: 6000,
        role: 'Director',
        isControllingPerson: true,
        isPoliticallyExposed: false,
      },
    ],
    ...overrides,
  };
}

async function errorOf(promise: Promise<unknown>): Promise<{ code: string; details: { code?: string; field?: string }[] }> {
  try {
    await promise;
  } catch (error) {
    const typed = error as { code: string; details?: { code?: string; field?: string }[] };
    return { code: typed.code, details: typed.details ?? [] };
  }
  throw new Error('expected the call to be refused');
}

async function approvedDocument(
  sellerAccountId: string,
  fieldKey: string,
  expiresOn: Date | null,
): Promise<string> {
  const id = newId();
  await prisma.sellerDocument.create({
    data: {
      id,
      sellerAccountId,
      kind: 'REGULATORY_LICENCE',
      requirementFieldKey: fieldKey,
      storageKey: `private/r12/${id}.pdf`,
      originalFileName: 'licence.pdf',
      contentType: 'application/pdf',
      byteSize: PDF.length,
      contentHash: 'a'.repeat(64),
      scanState: 'SCANNER_UNCONFIGURED',
      approvedAt: new Date(),
      approvedByUserId: adminUserId,
      expiresOn,
    },
  });
  return id;
}

async function cleanUp(): Promise<void> {
  const ids = (
    await prisma.sellerAccount.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } })
  ).map((row) => row.id);
  await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerScreeningCheck.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerBeneficialOwner.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerTrustProfile.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerDocument.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerAgreementAcceptance.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerPayoutAccountReference.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: ids } } });
  await prisma.sellerOnboardingRequirement.deleteMany({ where: { countryKey: 'QZ' } });
  await prisma.marketRule.deleteMany({ where: { ownerName: 'r12 test' } });
  await prisma.category.deleteMany({ where: { slug: `${PREFIX}category` } });
  await prisma.auditLog.deleteMany({ where: { actorUserId: adminUserId } });
  await prisma.user.deleteMany({ where: { emailNormalized: ADMIN_EMAIL } });
}

beforeAll(async () => {
  await cleanUp();

  const admin = await prisma.user.create({
    data: { id: newId(), email: ADMIN_EMAIL, emailNormalized: ADMIN_EMAIL, passwordHash: 'x', type: 'ADMIN', status: 'ACTIVE' },
  });
  adminUserId = admin.id;

  categoryId = newId();
  await prisma.category.create({
    data: { id: categoryId, name: 'R12 Surgical gloves', slug: `${PREFIX}category`, isActive: true },
  });
  await prisma.marketRule.create({
    data: {
      id: newId(),
      scope: 'CATEGORY',
      categoryId,
      countryCode: 'DE',
      effect: 'BLOCK',
      reason: 'Not sold into Germany under this deployment.',
      source: 'test',
      version: '1',
      ownerName: 'r12 test',
      effectiveFrom: new Date(Date.now() - DAY),
    },
  });

  // One required document on the compliance step, for QZ sellers only.
  await prisma.sellerOnboardingRequirement.create({
    data: {
      id: newId(),
      countryCode: 'QZ',
      countryKey: 'QZ',
      stepKey: 'compliance',
      fieldKey: 'qz_licence',
      label: 'Trade licence',
      isRequired: true,
      isDocument: true,
    },
  });
  await prisma.sellerOnboardingRequirement.create({
    data: {
      id: newId(),
      countryCode: 'QZ',
      countryKey: 'QZ',
      stepKey: 'compliance',
      fieldKey: 'qz_optional',
      label: 'Optional certificate',
      isRequired: false,
      isDocument: true,
    },
  });
});

afterAll(async () => {
  await cleanUp();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe('the ownership, registrations and exports section', () => {
  it('refuses every malformed answer at once, each on its field', async () => {
    const seller = await makeSeller('bad-answers', 'DRAFT', 'IN');

    const error = await errorOf(
      saveKyb(
        seller,
        baseKyb({
          udyamNumber: 'UDYAM-12-3',
          iecNumber: 'ABC',
          exportCapable: true,
          exportMarkets: ['QQ'],
          intendedCategoryIds: [newId()],
          beneficialOwners: [
            { fullName: 'One', nationality: 'IN', ownershipBasisPoints: 7000, role: null, isControllingPerson: false, isPoliticallyExposed: false },
            { fullName: 'Two', nationality: 'XX', ownershipBasisPoints: 4000, role: null, isControllingPerson: false, isPoliticallyExposed: false },
          ],
        }),
      ),
    );

    expect(error.code).toBe('VALIDATION_FAILED');
    const codes = error.details.map((detail) => `${detail.field ?? ''}:${detail.code ?? ''}`);
    expect(codes).toContain('udyamNumber:UDYAM_FORMAT');
    expect(codes).toContain('iecNumber:IEC_FORMAT');
    expect(codes).toContain('exportMarkets:UNKNOWN_COUNTRY');
    expect(codes).toContain('intendedCategoryIds:UNKNOWN_CATEGORY');
    expect(codes).toContain('beneficialOwners.1.nationality:UNKNOWN_COUNTRY');
    expect(codes).toContain('beneficialOwners:OWNERSHIP_OVER_100');

    // Nothing was written.
    expect(await prisma.sellerTrustProfile.findUnique({ where: { sellerAccountId: seller.sellerAccountId } })).toBeNull();
  });

  it("refuses India's identifiers for a seller registered elsewhere", async () => {
    const seller = await makeSeller('not-india', 'DRAFT', 'QZ');
    const error = await errorOf(saveKyb(seller, baseKyb({ udyamNumber: 'UDYAM-MH-01-0000001' })));
    expect(error.details).toContainEqual(expect.objectContaining({ field: 'udyamNumber', code: 'NOT_APPLICABLE' }));
  });

  it('stores identifiers in their printed form and audits which parts changed, never a value', async () => {
    const seller = await makeSeller('good-answers', 'DRAFT', 'IN');

    const view = await saveKyb(
      seller,
      baseKyb({
        legalForm: 'SOLE_PROPRIETORSHIP',
        udyamNumber: 'udyam mh 01 0000001',
        iecNumber: 'abcde1234f',
        exportCapable: true,
        exportMarkets: ['de', 'AE'],
        yearsExporting: 4,
        intendedCategoryIds: [categoryId],
      }),
    );

    expect(view.udyamNumber).toBe('UDYAM-MH-01-0000001');
    expect(view.iecNumber).toBe('ABCDE1234F');
    expect(view.exportMarkets).toEqual(['DE', 'AE']);
    expect(view.intendedCategories).toEqual([{ id: categoryId, name: 'R12 Surgical gloves' }]);
    expect(view.ownershipTotalBasisPoints).toBe(6000);
    // A proprietorship has no CIN, so none is asked for.
    expect(view.registrationNumberName).toBeNull();
    expect(view.outstanding).toEqual([]);

    const audit = await prisma.sellerAuditLog.findFirstOrThrow({
      where: { sellerAccountId: seller.sellerAccountId, action: 'seller.kyb.saved' },
    });
    const written = JSON.stringify(audit);
    expect(written).not.toContain('0000001');
    expect(written).not.toContain('ABCDE1234F');
    expect(written).not.toContain('Asha Rao');
    expect(audit.summary).toContain('registrations');
  });

  it('keeps an owner edited in place, and archives one no longer listed', async () => {
    const seller = await makeSeller('owners', 'DRAFT', 'QZ');
    const first = await saveKyb(
      seller,
      baseKyb({
        beneficialOwners: [
          { fullName: 'Keep Me', nationality: null, ownershipBasisPoints: 5000, role: null, isControllingPerson: true, isPoliticallyExposed: false },
          { fullName: 'Drop Me', nationality: null, ownershipBasisPoints: 5000, role: null, isControllingPerson: false, isPoliticallyExposed: true },
        ],
      }),
    );
    const kept = first.beneficialOwners.find((owner) => owner.fullName === 'Keep Me');
    const dropped = first.beneficialOwners.find((owner) => owner.fullName === 'Drop Me');
    expect(dropped?.isPoliticallyExposed).toBe(true);

    const second = await saveKyb(
      seller,
      baseKyb({
        beneficialOwners: [
          { id: kept?.id ?? null, fullName: 'Keep Me', nationality: 'IN', ownershipBasisPoints: 10_000, role: 'Proprietor', isControllingPerson: true, isPoliticallyExposed: false },
        ],
      }),
    );

    expect(second.beneficialOwners).toHaveLength(1);
    expect(second.beneficialOwners[0]?.id).toBe(kept?.id);
    const archived = await prisma.sellerBeneficialOwner.findUniqueOrThrow({ where: { id: dropped?.id ?? '' } });
    expect(archived.archivedAt).not.toBeNull();
  });

  it('cannot be changed while the application is with a reviewer', async () => {
    const seller = await makeSeller('locked', 'SUBMITTED', 'QZ');
    const error = await errorOf(saveKyb(seller, baseKyb()));
    expect(error.code).toBe('SELLER_APPLICATION_TRANSITION_NOT_ALLOWED');
  });

  it('asks a company for its CIN and an LLP for its LLPIN, by legal form', async () => {
    const seller = await makeSeller('company', 'DRAFT', 'IN');
    const company = await saveKyb(seller, baseKyb({ legalForm: 'PRIVATE_LIMITED_COMPANY' }));
    expect(company.registrationNumberName).toBe('CIN');
    expect(company.outstanding.map((gap) => gap.code)).toContain('REGISTRATION_NUMBER_REQUIRED');

    await saveBusinessProfile(seller, { companyRegistrationNumber: 'U12345MH2020PTC123456' });
    expect((await readKyb(seller)).outstanding).toEqual([]);

    const llp = await saveKyb(seller, baseKyb({ legalForm: 'LIMITED_LIABILITY_PARTNERSHIP' }));
    expect(llp.registrationNumberName).toBe('LLPIN');
    expect(llp.outstanding.map((gap) => gap.code)).toContain('REGISTRATION_NUMBER_FORMAT');

    // The checklist says it in the same words.
    const progress = await prisma.sellerOnboardingProgress.findUniqueOrThrow({
      where: { sellerAccountId: seller.sellerAccountId },
    });
    const steps = progress.stepsJson as Record<string, { state: string; message: string | null }>;
    expect(steps['kyb_kyc']?.state).toBe('IN_PROGRESS');
    expect(steps['kyb_kyc']?.message).toContain('LLPIN');
  });

  it('names the owners the policy asks for until one is given', async () => {
    const seller = await makeSeller('no-owners', 'DRAFT', 'QZ');
    const view = await saveKyb(seller, baseKyb({ beneficialOwners: [] }));
    expect(view.policy.beneficialOwnersRequired).toBe(true);
    expect(view.outstanding.map((gap) => gap.code)).toContain('BENEFICIAL_OWNER_REQUIRED');
  });
});

describe('the GSTIN check character', () => {
  it('refuses a GSTIN whose check character does not match, and accepts one that does', async () => {
    const seller = await makeSeller('gstin', 'DRAFT', 'IN');
    const error = await errorOf(saveBusinessProfile(seller, { taxRegistrationNumber: '27AAGCN4521R1ZP' }));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toContainEqual(expect.objectContaining({ field: 'taxRegistrationNumber', code: 'GSTIN_CHECKSUM' }));

    await expect(saveBusinessProfile(seller, { taxRegistrationNumber: '27AAPFU0939F1ZV' })).resolves.toBeDefined();
  });
});

describe('the submit gate', () => {
  it('refuses an unfinished application, one entry per unfinished step', async () => {
    const seller = await makeSeller('unfinished', 'DRAFT', 'QZ');
    const error = await errorOf(submitApplication(seller));
    expect(error.code).toBe('SELLER_ONBOARDING_INCOMPLETE');
    expect(error.details.map((detail) => detail.field)).toContain('kyb_kyc');
  });
});

describe('resubmission', () => {
  it('refuses to reopen a rejection that closed the door, and reopens one that did not', async () => {
    const closed = await makeSeller('closed', 'UNDER_REVIEW', 'QZ');
    await decideApplication({
      sellerAccountId: closed.sellerAccountId,
      to: 'REJECTED',
      reason: 'Not a business we can work with.',
      resubmissionAllowed: false,
      adminUserId,
    });
    const refused = await errorOf(
      decideApplication({ sellerAccountId: closed.sellerAccountId, to: 'ACTION_REQUIRED', reason: 'Try again', adminUserId }),
    );
    expect(refused.code).toBe('SELLER_RESUBMISSION_NOT_ALLOWED');

    const open = await makeSeller('reopenable', 'UNDER_REVIEW', 'QZ');
    await decideApplication({
      sellerAccountId: open.sellerAccountId,
      to: 'REJECTED',
      reason: 'The licence is unreadable.',
      resubmissionAllowed: true,
      adminUserId,
    });
    await decideApplication({ sellerAccountId: open.sellerAccountId, to: 'ACTION_REQUIRED', reason: 'Send a clearer copy.', adminUserId });
    const account = await prisma.sellerAccount.findUniqueOrThrow({ where: { id: open.sellerAccountId } });
    expect(account.status).toBe('ACTION_REQUIRED');
  });
});

// ---------------------------------------------------------------------------

describe('manual screening', () => {
  it('records a person’s check as manual, and keeps the one it replaces', async () => {
    const seller = await makeSeller('screened', 'UNDER_REVIEW', 'QZ');

    const first = await recordScreening({
      sellerAccountId: seller.sellerAccountId,
      subjectType: 'ENTITY',
      result: 'POTENTIAL_MATCH',
      listsChecked: 'UN consolidated list; OFAC SDN',
      note: 'Similar name on the SDN list, different country.',
      adminUserId,
    });
    expect(first.provider).toBe('manual');
    expect(first.automated).toBe(false);
    expect(first.reviewedBy).toBe(ADMIN_EMAIL);

    const second = await recordScreening({
      sellerAccountId: seller.sellerAccountId,
      subjectType: 'ENTITY',
      result: 'CLEAR',
      listsChecked: 'UN consolidated list; OFAC SDN; EU consolidated list',
      adminUserId,
    });

    const rows = await prisma.sellerScreeningCheck.findMany({
      where: { sellerAccountId: seller.sellerAccountId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === first.id)?.isCurrent).toBe(false);
    expect(rows.find((row) => row.id === second.id)?.isCurrent).toBe(true);
    expect(rows.every((row) => !row.automated && row.provider === 'manual')).toBe(true);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'seller_screening.recorded', resourceId: second.id },
    });
    expect(audit).not.toBeNull();

    // Never told to the seller.
    expect(await prisma.sellerAuditLog.count({ where: { sellerAccountId: seller.sellerAccountId } })).toBe(0);
    expect(await prisma.sellerNotification.count({ where: { sellerAccountId: seller.sellerAccountId } })).toBe(0);
  });

  it("refuses an owner who belongs to another seller", async () => {
    const mine = await makeSeller('owner-a', 'DRAFT', 'QZ');
    const theirs = await makeSeller('owner-b', 'DRAFT', 'QZ');
    const saved = await saveKyb(theirs, baseKyb());

    const error = await errorOf(
      recordScreening({
        sellerAccountId: mine.sellerAccountId,
        subjectType: 'BENEFICIAL_OWNER',
        beneficialOwnerId: saved.beneficialOwners[0]?.id ?? null,
        result: 'CLEAR',
        listsChecked: 'UN list',
        adminUserId,
      }),
    );
    expect(error.code).toBe('NOT_FOUND');
  });
});

describe('the approval gate', () => {
  it('names every missing piece of evidence, then approves once each is in place', async () => {
    const seller = await makeSeller('gate', 'UNDER_REVIEW', 'QZ');

    const refused = await errorOf(
      decideApplication({ sellerAccountId: seller.sellerAccountId, to: 'APPROVED', adminUserId }),
    );
    expect(refused.code).toBe('SELLER_APPROVAL_EVIDENCE_MISSING');
    const missing = refused.details.map((detail) => `${detail.code ?? ''}:${detail.field ?? ''}`);
    expect(missing).toContain('STEP_INCOMPLETE:account_verification');
    expect(missing).toContain('DOCUMENT_NOT_APPROVED:qz_licence');
    expect(missing).toContain('SCREENING_REQUIRED:entity');
    // An optional document is never demanded.
    expect(missing.some((entry) => entry.endsWith(':qz_optional'))).toBe(false);
    expect((await prisma.sellerAccount.findUniqueOrThrow({ where: { id: seller.sellerAccountId } })).status).toBe('UNDER_REVIEW');

    // Everything the seller owes.
    await prisma.sellerOnboardingProgress.update({
      where: { sellerAccountId: seller.sellerAccountId },
      data: { stepsJson: ALL_STEPS_COMPLETE },
    });
    const owners = await saveKyb({ ...seller, status: 'DRAFT', isApplicationEditable: true }, baseKyb());
    const licence = await approvedDocument(seller.sellerAccountId, 'qz_licence', new Date(Date.now() - DAY));

    // An expired licence is named as expired, not as missing.
    const expired = await approvalReadiness(seller.sellerAccountId);
    expect(expired.missing).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_EXPIRED', field: 'qz_licence' }));
    await prisma.sellerDocument.update({ where: { id: licence }, data: { expiresOn: new Date(Date.now() + 365 * DAY) } });

    // A possible match is not clear.
    await recordScreening({ sellerAccountId: seller.sellerAccountId, subjectType: 'ENTITY', result: 'POTENTIAL_MATCH', listsChecked: 'UN list', adminUserId });
    const ownerId = owners.beneficialOwners[0]?.id ?? '';
    await recordScreening({ sellerAccountId: seller.sellerAccountId, subjectType: 'BENEFICIAL_OWNER', beneficialOwnerId: ownerId, result: 'CLEAR', listsChecked: 'UN list', adminUserId });
    const unclear = await approvalReadiness(seller.sellerAccountId);
    expect(unclear.missing.map((item) => `${item.code ?? ''}:${item.field ?? ''}`)).toEqual(['SCREENING_NOT_CLEAR:entity']);

    await recordScreening({ sellerAccountId: seller.sellerAccountId, subjectType: 'ENTITY', result: 'CLEAR', listsChecked: 'UN list; OFAC SDN', adminUserId });
    expect((await approvalReadiness(seller.sellerAccountId)).ready).toBe(true);

    await decideApplication({ sellerAccountId: seller.sellerAccountId, to: 'APPROVED', adminUserId });
    expect((await prisma.sellerAccount.findUniqueOrThrow({ where: { id: seller.sellerAccountId } })).status).toBe('APPROVED');
  });

  it('asks for a new screening when an owner is renamed after being screened', async () => {
    const seller = await makeSeller('renamed', 'DRAFT', 'QZ');
    const saved = await saveKyb(seller, baseKyb());
    const owner = saved.beneficialOwners[0];
    await recordScreening({ sellerAccountId: seller.sellerAccountId, subjectType: 'BENEFICIAL_OWNER', beneficialOwnerId: owner?.id ?? null, result: 'CLEAR', listsChecked: 'UN list', adminUserId });

    await saveKyb(seller, baseKyb({ beneficialOwners: [{ id: owner?.id ?? null, fullName: 'Asha R. Rao', nationality: 'IN', ownershipBasisPoints: 6000, role: 'Director', isControllingPerson: true, isPoliticallyExposed: false }] }));

    const readiness = await approvalReadiness(seller.sellerAccountId);
    expect(readiness.missing).toContainEqual(expect.objectContaining({ code: 'SCREENING_REQUIRED', field: owner?.id }));
  });

  it('does not ask for screening where the deployment has switched it off', async () => {
    const seller = await makeSeller('no-screening', 'UNDER_REVIEW', 'QZ');
    const settings = env as unknown as { SELLER_REQUIRE_SCREENING: boolean };
    settings.SELLER_REQUIRE_SCREENING = false;
    try {
      const readiness = await approvalReadiness(seller.sellerAccountId);
      expect(readiness.missing.some((item) => (item.code ?? '').startsWith('SCREENING'))).toBe(false);
    } finally {
      settings.SELLER_REQUIRE_SCREENING = true;
    }
  });
});

// ---------------------------------------------------------------------------

describe("the reviewer's read", () => {
  it('leaves out every internal the review does not need', async () => {
    const seller = await makeSeller('readable', 'UNDER_REVIEW', 'QZ');
    await saveKyb({ ...seller, status: 'DRAFT', isApplicationEditable: true }, baseKyb({ intendedCategoryIds: [categoryId] }));
    await prisma.sellerAccount.update({
      where: { id: seller.sellerAccountId },
      data: { logoStorageKey: 'public/logos/r12-secret-logo.png', createdByProfileId: newId() },
    });
    await prisma.sellerAgreementAcceptance.create({
      data: {
        id: newId(),
        sellerAccountId: seller.sellerAccountId,
        kind: 'MARKETPLACE_AGREEMENT',
        version: '1',
        method: 'DRAWN_CONSENT',
        acceptedName: 'Asha Rao',
        signatureStorageKey: 'private/signatures/r12-secret-signature.png',
        ipAddress: '203.0.113.9',
        userAgent: 'R12-Secret-Browser/1.0',
      },
    });
    await prisma.sellerPayoutAccountReference.create({
      data: {
        id: newId(),
        sellerAccountId: seller.sellerAccountId,
        provider: 'stripe_connect',
        providerAccountId: 'acct_r12secret',
        state: 'ENABLED',
        pendingRequirementsJson: ['r12-secret-requirement'],
        bankName: 'State Bank',
        accountLast4: '6789',
        bankAccountStatus: 'verified',
      },
    });
    await approvedDocument(seller.sellerAccountId, 'qz_licence', null);

    const application = await readApplication(seller.sellerAccountId);
    const json = JSON.stringify(application, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));

    for (const secret of [
      'r12-secret-signature',
      'R12-Secret-Browser',
      'acct_r12secret',
      'r12-secret-requirement',
      'r12-secret-logo',
      'private/r12/',
      'signatureStorageKey',
      'pendingRequirementsJson',
      'storageKey',
      'createdByProfileId',
      'userAgent',
    ]) {
      expect(json, secret).not.toContain(secret);
    }

    expect(application.payoutAccount?.accountLast4).toBe('6789');
    expect(application.payoutAccount?.bankAccountStatus).toBe('verified');
    expect(application.kyb.intendedCategories[0]?.blockedIn).toEqual([
      { countryCode: 'DE', reason: 'Not sold into Germany under this deployment.' },
    ]);
    expect(application.kyb.screening.provider).toBe('manual');
    expect(application.kyb.screening.automatedProviderConfigured).toBe(false);
    expect(application.kyb.readiness.ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('seller documents', () => {
  it('judges an upload by its bytes, refuses an empty or oversized one, and records that nothing scanned it', async () => {
    const seller = await makeSeller('uploads', 'DRAFT', 'QZ');

    const text = await errorOf(
      uploadSellerDocument({ membership: seller, kind: 'REGULATORY_LICENCE', fileName: 'licence.pdf', bytes: Buffer.from('this is not a pdf at all') }),
    );
    expect(text.code).toBe('MEDIA_TYPE_NOT_ALLOWED');

    const empty = await errorOf(
      uploadSellerDocument({ membership: seller, kind: 'REGULATORY_LICENCE', fileName: 'empty.pdf', bytes: Buffer.alloc(0) }),
    );
    expect(empty.code).toBe('IMPORT_FILE_INVALID');

    const large = await errorOf(
      uploadSellerDocument({
        membership: seller,
        kind: 'REGULATORY_LICENCE',
        fileName: 'huge.pdf',
        bytes: Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]),
      }),
    );
    expect(large.code).toBe('MEDIA_TOO_LARGE');

    // No scanner is configured in tests: the file is kept, marked as unscanned,
    // and not served (SELLER_ALLOW_UNSCANNED_DOCUMENTS is false).
    const stored = await uploadSellerDocument({
      membership: seller,
      kind: 'REGULATORY_LICENCE',
      requirementFieldKey: 'qz_licence',
      fileName: 'licence.pdf',
      bytes: PDF,
    });
    expect(stored.scanState).toBe('SCANNER_UNCONFIGURED');
    expect(stored.isDownloadable).toBe(false);
    expect(stored.contentType).toBe('application/pdf');
    await expect(createSellerDocumentLink(seller, adminUserId, stored.id)).rejects.toThrow();

    // Another seller cannot even learn it exists.
    const rival = await makeSeller('rival', 'DRAFT', 'QZ');
    const hidden = await errorOf(createSellerDocumentLink(rival, adminUserId, stored.id));
    expect(hidden.code).toBe('NOT_FOUND');
  });

  it('refuses a rejection with no reason, and keeps the reason the seller will read', async () => {
    const seller = await makeSeller('decisions', 'UNDER_REVIEW', 'QZ');
    const stored = await uploadSellerDocument({ membership: seller, kind: 'REGULATORY_LICENCE', fileName: 'licence.pdf', bytes: PDF });

    const silent = await errorOf(decideSellerDocument({ documentId: stored.id, decision: 'REJECTED', reason: '  ', adminUserId }));
    expect(silent.code).toBe('VALIDATION_FAILED');
    expect(silent.details).toContainEqual(expect.objectContaining({ field: 'reason' }));

    await decideSellerDocument({ documentId: stored.id, decision: 'REJECTED', reason: 'The licence number is cut off.', adminUserId });
    const row = await prisma.sellerDocument.findUniqueOrThrow({ where: { id: stored.id } });
    expect(row.rejectedReason).toBe('The licence number is cut off.');
    expect(row.approvedAt).toBeNull();
  });
});

describe('the expired-document sweep', () => {
  it('sends an approved seller back when a required document expires, once, and tells them why', async () => {
    const seller = await makeSeller('lapsed', 'APPROVED', 'QZ');
    await approvedDocument(seller.sellerAccountId, 'qz_licence', new Date(Date.now() - 2 * DAY));

    await sweepExpiredSellerDocuments();

    const account = await prisma.sellerAccount.findUniqueOrThrow({ where: { id: seller.sellerAccountId } });
    expect(account.status).toBe('ACTION_REQUIRED');
    expect(account.statusReason).toContain('Trade licence expired on');

    const notice = await prisma.sellerNotification.findFirstOrThrow({
      where: { sellerAccountId: seller.sellerAccountId, kind: 'APPLICATION_STATUS' },
    });
    expect(notice.severity).toBe('WARNING');
    expect(notice.body).toContain('Trade licence');

    const trail = await prisma.sellerAuditLog.findFirst({
      where: { sellerAccountId: seller.sellerAccountId, action: 'seller.application.action_required' },
    });
    expect(trail?.actorType).toBe('SYSTEM');
    expect(await prisma.auditLog.count({ where: { action: 'seller_application.lapsed', resourceId: seller.sellerAccountId } })).toBe(1);

    // A second pass does nothing more.
    await sweepExpiredSellerDocuments();
    expect(await prisma.sellerNotification.count({ where: { sellerAccountId: seller.sellerAccountId } })).toBe(1);
  });

  it('leaves an approved seller alone when only an optional document has expired', async () => {
    const seller = await makeSeller('optional-lapse', 'APPROVED', 'QZ');
    await approvedDocument(seller.sellerAccountId, 'qz_licence', null);
    await approvedDocument(seller.sellerAccountId, 'qz_optional', new Date(Date.now() - 2 * DAY));

    await sweepExpiredSellerDocuments();

    const account = await prisma.sellerAccount.findUniqueOrThrow({ where: { id: seller.sellerAccountId } });
    expect(account.status).toBe('APPROVED');
  });
});
