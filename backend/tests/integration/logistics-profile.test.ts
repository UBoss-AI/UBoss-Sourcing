/**
 * My Profile, from the outside.
 *
 * Every assertion goes through `app.inject` with real cookies, because the
 * claims this feature makes are about what a REQUEST can do: which company it
 * reads, which fields it can change, and which files it can fetch. A test that
 * called the service directly would be handing it the membership and could not
 * tell "the session decides" from "the argument decides".
 *
 * What is proven here:
 *
 *   - the profile is the signed-in carrier's own, whatever ids a caller adds;
 *   - editable fields save, and read-only or operator-owned fields are refused;
 *   - identity fields wait for the operator and change only on approval;
 *   - a read-only role can look and cannot write;
 *   - compliance files are sniffed, stored privately, served only through a
 *     single-use link bound to the person who asked, and never to another
 *     carrier;
 *   - nothing secret appears in the response, and no integration is called
 *     connected without a recorded success.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { totpCodeAt } from '../../src/infra/totp.js';
import { inviteAsOperator } from '../../src/modules/logistics/admin.service.js';
import { signInAdmin, type AdminSession } from '../support/admin-session.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const IP = '10.61.0.1';
const OPERATOR_EMAIL = 'profile-operator@test.local';
const OPERATOR_PASSWORD = 'ProfileOperator!2026';
const CARRIER_PASSWORD = 'CarrierProfile!2026';

const A_NAME = 'Profile Probe Alpha Freight';
const B_NAME = 'Profile Probe Beta Haulage';
const A_OWNER = 'owner@alpha-profile.test';
const A_DISPATCH = 'dispatch@alpha-profile.test';
const B_OWNER = 'owner@beta-profile.test';
const EMAILS = [
  A_OWNER,
  A_DISPATCH,
  B_OWNER,
  'founder@alpha-profile.test',
  'founder@beta-profile.test',
];

/** The smallest file that is genuinely a PDF by its first five bytes. */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');
/** A 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML_AS_PDF = Buffer.from('<html><body>not a certificate</body></html>');

interface PortalSession {
  cookies: string;
  csrfToken: string;
}

let operator: AdminSession;
let operatorUserId = '';
let carrierA = '';
let carrierB = '';
let aOwner: PortalSession;
let aDispatch: PortalSession;
let bOwner: PortalSession;

// ---------------------------------------------------------------------------

async function cleanUp(): Promise<void> {
  const partners = await prisma.logisticsPartner.findMany({
    where: { displayName: { in: [A_NAME, B_NAME, `${A_NAME} Group`] } },
    select: { id: true },
  });
  const ids = partners.map((row) => row.id);

  // Documents and change requests cascade with the partner row.
  await prisma.logisticsAuditLog.deleteMany({ where: { logisticsPartnerId: { in: ids } } });
  await prisma.logisticsPartnerInvitation.deleteMany({
    where: { logisticsPartnerId: { in: ids } },
  });
  await prisma.logisticsPartnerUser.deleteMany({ where: { logisticsPartnerId: { in: ids } } });
  await prisma.logisticsPartner.deleteMany({ where: { id: { in: ids } } });

  const users = await prisma.user.findMany({
    where: { emailNormalized: { in: [...EMAILS, OPERATOR_EMAIL] } },
    select: { id: true },
  });
  const userIds = users.map((row) => row.id);
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.authToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function makeOperator(): Promise<void> {
  const role = await prisma.role.findUniqueOrThrow({
    where: { key: Role.BUSINESS_OWNER },
    select: { id: true },
  });
  const user = await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email: OPERATOR_EMAIL,
      emailNormalized: OPERATOR_EMAIL,
      passwordHash: await hashPassword(OPERATOR_PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
    select: { id: true },
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  operatorUserId = user.id;
}

async function createCarrier(displayName: string, ownerEmail: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/logistics/partners',
    headers: {
      cookie: operator.cookies,
      'x-csrf-token': operator.csrfToken,
      'x-forwarded-for': IP,
    },
    payload: {
      legalName: `${displayName} Ltd`,
      displayName,
      registrationCountry: 'IE',
      contactEmail: `ops@${displayName.replace(/[^a-z]/gi, '').toLowerCase()}.test`,
      ownerEmail,
      ownerFullName: 'Founding Owner',
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  const { id } = JSON.parse(response.body) as { id: string };
  // Activated the way an operator would, so the portal lets its people in.
  await prisma.logisticsPartner.update({ where: { id }, data: { status: 'ACTIVE' } });
  return id;
}

async function signIn(email: string): Promise<PortalSession> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/logistics/auth/login',
    headers: { 'x-forwarded-for': IP },
    payload: { email, password: CARRIER_PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const jar = login.cookies as { name: string; value: string }[];
  return {
    cookies: jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    csrfToken: jar.find((cookie) => cookie.name === 'uboss_logi_csrf')?.value ?? '',
  };
}

/** Invite, activate, sign in, and - for a role that needs it - enrol MFA. */
async function member(
  partnerId: string,
  email: string,
  role: 'LOGISTICS_PARTNER_OWNER' | 'DISPATCHER',
): Promise<PortalSession> {
  const invitation = await inviteAsOperator(
    { userId: operatorUserId, email: OPERATOR_EMAIL, permissions: [] },
    partnerId,
    { email, fullName: `${role} Person`, role },
  );
  const activated = await app.inject({
    method: 'POST',
    url: '/api/v1/logistics/auth/invitations/accept',
    headers: { 'x-forwarded-for': IP },
    payload: {
      token: invitation.token,
      password: CARRIER_PASSWORD,
      acceptedTerms: true,
      consentVersion: 'test',
    },
  });
  expect(activated.statusCode, activated.body).toBe(200);

  const session = await signIn(email);

  if (role === 'LOGISTICS_PARTNER_OWNER') {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/logistics/auth/mfa/setup',
      headers: { cookie: session.cookies, 'x-csrf-token': session.csrfToken },
    });
    expect(setup.statusCode, setup.body).toBe(200);
    const { secret } = JSON.parse(setup.body) as { secret: string };
    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/logistics/auth/mfa/verify',
      headers: { cookie: session.cookies, 'x-csrf-token': session.csrfToken },
      payload: { code: totpCodeAt(secret, Date.now()), mode: 'ENROL' },
    });
    expect(verified.statusCode, verified.body).toBe(200);
  }

  return session;
}

function call(
  session: PortalSession,
  method: 'GET' | 'PATCH' | 'POST' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: { cookie: session.cookies, 'x-csrf-token': session.csrfToken },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

function adminCall(method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: {
      cookie: operator.cookies,
      'x-csrf-token': operator.csrfToken,
      'x-forwarded-for': IP,
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

/** A multipart body with text fields BEFORE the file, which is what the route reads. */
function multipart(
  file: Buffer,
  filename: string,
  fields: Record<string, string> = {},
  contentType = 'application/pdf',
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----ubossprofileboundary';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function upload(
  session: PortalSession,
  url: string,
  file: Buffer,
  filename: string,
  fields: Record<string, string> = {},
  contentType?: string,
) {
  const body = multipart(file, filename, fields, contentType);
  return app.inject({
    method: 'POST',
    url,
    headers: { ...body.headers, cookie: session.cookies, 'x-csrf-token': session.csrfToken },
    payload: body.payload,
  });
}

interface ProfileBody {
  identity: {
    id: string;
    partnerCode: string;
    legalName: string;
    displayName: string;
    status: string;
    verificationState: string;
    logoUrl: string | null;
  };
  company: { taxNumber: string | null; operationalAddress: unknown; registeredAddress: unknown };
  contacts: { supportEmail: string | null; billingEmail: string | null; contactEmail: string };
  capabilities: {
    timeZone: string | null;
    declaredTransportModes: string[];
    operatingHours: unknown;
  };
  compliance: {
    items: { kind: string; status: string }[];
    documents: { id: string; kind: string; scanState: string; reviewState: string }[];
  };
  integrations: { key: string; status: string }[];
  review: { pendingChange: { id: string; proposed: Record<string, unknown> } | null };
  completion: { percent: number; missing: string[] };
  editing: { canEdit: boolean };
}

const PROFILE = '/api/v1/logistics/profile';

// ---------------------------------------------------------------------------

beforeAll(async () => {
  app = await buildApp();
  await cleanUp();
  await makeOperator();
  operator = await signInAdmin(app, { email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD, ip: IP });

  carrierA = await createCarrier(A_NAME, 'founder@alpha-profile.test');
  carrierB = await createCarrier(B_NAME, 'founder@beta-profile.test');

  aOwner = await member(carrierA, A_OWNER, 'LOGISTICS_PARTNER_OWNER');
  aDispatch = await member(carrierA, A_DISPATCH, 'DISPATCHER');
  bOwner = await member(carrierB, B_OWNER, 'LOGISTICS_PARTNER_OWNER');
}, 60_000);

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('reading the profile', () => {
  it('is the signed-in carrier’s own, whatever id a caller adds', async () => {
    const response = await call(
      aOwner,
      'GET',
      `${PROFILE}?logisticsPartnerId=${carrierB}&partnerId=${carrierB}`,
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');

    const body = JSON.parse(response.body) as ProfileBody;
    expect(body.identity.id).toBe(carrierA);
    expect(body.identity.displayName).toBe(A_NAME);
    expect(body.identity.partnerCode).toMatch(/^LP-\d+$/);
    expect(body.editing.canEdit).toBe(true);

    const other = JSON.parse((await call(bOwner, 'GET', PROFILE)).body) as ProfileBody;
    expect(other.identity.id).toBe(carrierB);
  });

  it('never carries notes, credentials, secrets or storage keys', async () => {
    await prisma.logisticsPartner.update({
      where: { id: carrierA },
      data: { internalNotes: 'OPERATOR-ONLY-NOTE-7731' },
    });
    const response = await call(aOwner, 'GET', PROFILE);
    expect(response.body).not.toContain('OPERATOR-ONLY-NOTE-7731');
    for (const word of [
      'internalNotes',
      'credentialsEnc',
      'webhookSecret',
      'storageKey',
      'password',
    ]) {
      expect(response.body).not.toContain(word);
    }
  });

  it('says honestly which integrations exist, and calls none of them connected', async () => {
    const body = JSON.parse((await call(aOwner, 'GET', PROFILE)).body) as ProfileBody;
    const status = Object.fromEntries(body.integrations.map((row) => [row.key, row.status]));
    expect(status).toEqual({
      DHL: 'CREDENTIALS_REQUIRED',
      FEDEX: 'CREDENTIALS_REQUIRED',
      INDIA_POST: 'MANUAL_TRACKING',
      GPS: 'NOT_CONFIGURED',
      WEBHOOK: 'NOT_CONFIGURED',
    });
  });

  it('lets a dispatcher read and not write', async () => {
    const read = await call(aDispatch, 'GET', PROFILE);
    expect(read.statusCode).toBe(200);
    expect((JSON.parse(read.body) as ProfileBody).editing.canEdit).toBe(false);

    const write = await call(aDispatch, 'PATCH', PROFILE, { supportEmail: 'desk@alpha.test' });
    expect(write.statusCode).toBe(403);
  });

  it('refuses a caller who is not signed in', async () => {
    const response = await app.inject({ method: 'GET', url: PROFILE });
    expect(response.statusCode).toBe(401);
  });
});

describe('editing the profile', () => {
  it('saves the fields a carrier owns, and audits the change', async () => {
    const response = await call(aOwner, 'PATCH', PROFILE, {
      supportEmail: 'support@alpha-profile.test',
      billingEmail: 'billing@alpha-profile.test',
      timeZone: 'Europe/Dublin',
      declaredTransportModes: ['ROAD', 'AIR'],
      operatingHours: { mon: { open: '08:00', close: '18:00' }, sat: null },
      operationalAddress: { line1: '1 Dock Road', city: 'Cork', countryCode: 'ie' },
    });
    expect(response.statusCode, response.body).toBe(200);

    const result = JSON.parse(response.body) as {
      profile: ProfileBody;
      applied: string[];
      submittedForReview: string[];
    };
    expect(result.submittedForReview).toEqual([]);
    expect(result.applied).toEqual(
      expect.arrayContaining(['supportEmail', 'billingEmail', 'timeZone', 'operationalAddress']),
    );
    expect(result.profile.contacts.supportEmail).toBe('support@alpha-profile.test');
    expect(result.profile.capabilities.timeZone).toBe('Europe/Dublin');
    expect(result.profile.capabilities.declaredTransportModes).toEqual(['ROAD', 'AIR']);
    expect(result.profile.company.operationalAddress).toMatchObject({ countryCode: 'IE' });

    const audit = await prisma.logisticsAuditLog.findFirst({
      where: { logisticsPartnerId: carrierA, action: 'logistics.profile.updated' },
    });
    expect(audit).not.toBeNull();

    // B is untouched.
    const other = JSON.parse((await call(bOwner, 'GET', PROFILE)).body) as ProfileBody;
    expect(other.contacts.supportEmail).toBeNull();
  });

  it('refuses read-only and operator-owned fields outright', async () => {
    const before = await prisma.logisticsPartner.findUniqueOrThrow({
      where: { id: carrierA },
      select: { partnerCode: true, status: true, verificationState: true },
    });

    for (const payload of [
      { id: carrierB },
      { partnerCode: 'LP-HACKED' },
      { status: 'ACTIVE' },
      { verificationState: 'VERIFIED' },
      { logisticsPartnerId: carrierB, supportEmail: 'x@y.test' },
      { internalNotes: 'mine now' },
      { contractStatus: 'ACTIVE' },
    ]) {
      const response = await call(aOwner, 'PATCH', PROFILE, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }

    const after = await prisma.logisticsPartner.findUniqueOrThrow({
      where: { id: carrierA },
      select: { partnerCode: true, status: true, verificationState: true },
    });
    expect(after).toEqual(before);
  });

  it('validates each field on the server', async () => {
    const cases: Record<string, unknown>[] = [
      { supportEmail: 'not-an-email' },
      { timeZone: 'Mars/Olympus_Mons' },
      { websiteUrl: 'javascript:alert(1)' },
      { contactPhone: 'call me maybe' },
      { operatingHours: { mon: { open: '18:00', close: '08:00' } } },
      { declaredTransportModes: ['TELEPORT'] },
    ];
    for (const payload of cases) {
      const response = await call(aOwner, 'PATCH', PROFILE, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe(
        'VALIDATION_FAILED',
      );
    }
  });

  it('holds an identity change for the operator and applies it only on approval', async () => {
    const response = await call(aOwner, 'PATCH', PROFILE, {
      legalName: `${A_NAME} Group Ltd`,
      taxNumber: 'IE9876543W',
      supportPhone: '+353 21 555 0101',
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = JSON.parse(response.body) as {
      profile: ProfileBody;
      applied: string[];
      submittedForReview: string[];
    };

    expect(result.applied).toEqual(['supportPhone']);
    expect(result.submittedForReview.sort()).toEqual(['legalName', 'taxNumber']);
    // The live record keeps the verified values.
    expect(result.profile.identity.legalName).toBe(`${A_NAME} Ltd`);
    expect(result.profile.company.taxNumber).toBeNull();
    const pending = result.profile.review.pendingChange;
    expect(pending?.proposed).toEqual({
      legalName: `${A_NAME} Group Ltd`,
      taxNumber: 'IE9876543W',
    });

    // A rejection needs a reason.
    const bare = await adminCall(
      'POST',
      `/api/v1/admin/logistics/partners/${carrierA}/profile-changes/${pending?.id ?? ''}/decision`,
      { decision: 'REJECTED' },
    );
    expect(bare.statusCode).toBe(400);

    // Another carrier's id in the path does not find it.
    const crossed = await adminCall(
      'POST',
      `/api/v1/admin/logistics/partners/${carrierB}/profile-changes/${pending?.id ?? ''}/decision`,
      { decision: 'APPROVED' },
    );
    expect(crossed.statusCode).toBe(404);

    const approved = await adminCall(
      'POST',
      `/api/v1/admin/logistics/partners/${carrierA}/profile-changes/${pending?.id ?? ''}/decision`,
      { decision: 'APPROVED' },
    );
    expect(approved.statusCode, approved.body).toBe(200);

    const now = JSON.parse((await call(aOwner, 'GET', PROFILE)).body) as ProfileBody;
    expect(now.identity.legalName).toBe(`${A_NAME} Group Ltd`);
    expect(now.company.taxNumber).toBe('IE9876543W');
    expect(now.identity.verificationState).toBe('VERIFIED');
    expect(now.review.pendingChange).toBeNull();

    const twice = await adminCall(
      'POST',
      `/api/v1/admin/logistics/partners/${carrierA}/profile-changes/${pending?.id ?? ''}/decision`,
      { decision: 'APPROVED' },
    );
    expect(twice.statusCode).toBe(409);
  });

  it('replaces an open request rather than stacking a second, and can withdraw it', async () => {
    await call(aOwner, 'PATCH', PROFILE, { registrationNumber: 'IE-111' });
    await call(aOwner, 'PATCH', PROFILE, { registrationNumber: 'IE-222' });

    const open = await prisma.logisticsPartnerProfileChange.findMany({
      where: { logisticsPartnerId: carrierA, state: 'PENDING' },
    });
    expect(open).toHaveLength(1);
    expect(open[0]?.proposedJson).toEqual({ registrationNumber: 'IE-222' });

    const withdrawn = await call(aOwner, 'DELETE', `${PROFILE}/pending-change`);
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect((JSON.parse(withdrawn.body) as ProfileBody).review.pendingChange).toBeNull();
  });

  it('refuses a trading name another carrier already uses', async () => {
    const response = await call(aOwner, 'PATCH', PROFILE, { displayName: B_NAME });
    expect(response.statusCode).toBe(409);
  });
});

describe('logo', () => {
  it('accepts a real image and refuses an SVG', async () => {
    const svg = await upload(aOwner, `${PROFILE}/logo`, SVG, 'logo.svg', {}, 'image/svg+xml');
    expect(svg.statusCode).toBe(400);

    const png = await upload(aOwner, `${PROFILE}/logo`, PNG, 'logo.png', {}, 'image/png');
    expect(png.statusCode, png.body).toBe(200);
    const { logoUrl } = JSON.parse(png.body) as { logoUrl: string };
    expect(logoUrl).toMatch(/\.png$/);

    const removed = await call(aOwner, 'DELETE', `${PROFILE}/logo`);
    expect(removed.statusCode).toBe(204);
  });
});

describe('compliance documents', () => {
  let documentId = '';

  it('decides the type from the bytes, not the name or header', async () => {
    const disguised = await upload(aOwner, `${PROFILE}/documents`, HTML_AS_PDF, 'insurance.pdf', {
      kind: 'INSURANCE_CERTIFICATE',
    });
    expect(disguised.statusCode).toBe(400);
    expect((JSON.parse(disguised.body) as { error: { code: string } }).error.code).toBe(
      'MEDIA_TYPE_NOT_ALLOWED',
    );

    const badKind = await upload(aOwner, `${PROFILE}/documents`, PDF, 'x.pdf', {
      kind: 'PASSPORT',
    });
    expect(badKind.statusCode).toBe(400);
  });

  it('files a real PDF privately, pending review, and never as clean when unscanned', async () => {
    const response = await upload(aOwner, `${PROFILE}/documents`, PDF, 'insurance.pdf', {
      kind: 'INSURANCE_CERTIFICATE',
      expiresOn: '2031-06-30',
    });
    expect(response.statusCode, response.body).toBe(201);
    const stored = JSON.parse(response.body) as {
      id: string;
      scanState: string;
      reviewState: string;
    };
    documentId = stored.id;
    expect(stored.reviewState).toBe('PENDING_REVIEW');
    expect(stored.scanState).not.toBe('CLEAN');

    const row = await prisma.logisticsPartnerDocument.findUniqueOrThrow({
      where: { id: documentId },
    });
    expect(row.storageKey.startsWith('private/')).toBe(true);
    expect(row.contentType).toBe('application/pdf');

    const profile = JSON.parse((await call(aOwner, 'GET', PROFILE)).body) as ProfileBody;
    expect(
      profile.compliance.items.find((item) => item.kind === 'INSURANCE_CERTIFICATE')?.status,
    ).toBe('PENDING_REVIEW');
    expect(profile.compliance.items.find((item) => item.kind === 'BUSINESS_LICENCE')?.status).toBe(
      'MISSING',
    );
  });

  it('will not issue a link for an unscanned file on a deployment that forbids it', async () => {
    const response = await call(aOwner, 'POST', `${PROFILE}/documents/${documentId}/link`);
    expect(response.statusCode).toBe(409);
  });

  it('serves a scanned file once, to the person who asked, and never to another carrier', async () => {
    await prisma.logisticsPartnerDocument.update({
      where: { id: documentId },
      data: { scanState: 'CLEAN' },
    });

    // Another carrier cannot even mint a link for it.
    const foreign = await call(bOwner, 'POST', `${PROFILE}/documents/${documentId}/link`);
    expect(foreign.statusCode).toBe(404);

    const minted = await call(aOwner, 'POST', `${PROFILE}/documents/${documentId}/link`);
    expect(minted.statusCode, minted.body).toBe(200);
    const { url } = JSON.parse(minted.body) as { url: string };

    // The link does not work in another carrier's session.
    const forwarded = await call(bOwner, 'GET', url);
    expect(forwarded.statusCode).toBe(403);

    const first = await call(aOwner, 'GET', url);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers['content-disposition']).toMatch(/^attachment;/);
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    expect(first.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const second = await call(aOwner, 'GET', url);
    expect(second.statusCode).toBe(403);
  });

  it('lets the operator verify it, and the carrier sees the verdict', async () => {
    const rejected = await adminCall(
      'POST',
      `/api/v1/admin/logistics/partners/${carrierA}/documents/${documentId}/decision`,
      { decision: 'REJECTED' },
    );
    expect(rejected.statusCode).toBe(400);

    const verified = await adminCall(
      'POST',
      `/api/v1/admin/logistics/partners/${carrierA}/documents/${documentId}/decision`,
      { decision: 'VERIFIED' },
    );
    expect(verified.statusCode, verified.body).toBe(200);

    const profile = JSON.parse((await call(aOwner, 'GET', PROFILE)).body) as ProfileBody;
    expect(
      profile.compliance.items.find((item) => item.kind === 'INSURANCE_CERTIFICATE')?.status,
    ).toBe('VERIFIED');

    const trail = await prisma.logisticsAuditLog.findFirst({
      where: { logisticsPartnerId: carrierA, action: 'logistics.profile.document_verified' },
    });
    expect(trail).not.toBeNull();
  });

  it('keeps the older file when a newer one of the same kind is filed', async () => {
    const response = await upload(aOwner, `${PROFILE}/documents`, PDF, 'insurance-2.pdf', {
      kind: 'INSURANCE_CERTIFICATE',
    });
    expect(response.statusCode).toBe(201);

    const rows = await prisma.logisticsPartnerDocument.findMany({
      where: { logisticsPartnerId: carrierA, kind: 'INSURANCE_CERTIFICATE' },
    });
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.supersededAt === null)).toHaveLength(1);

    const review = await adminCall('GET', `/api/v1/admin/logistics/partners/${carrierA}/profile`);
    expect(review.statusCode).toBe(200);
    expect(
      (JSON.parse(review.body) as { documentHistory: unknown[] }).documentHistory,
    ).toHaveLength(2);
  });

  it('keeps staff links single-use too', async () => {
    const minted = await adminCall(
      'POST',
      `/api/v1/admin/logistics/partners/${carrierA}/documents/${documentId}/link`,
    );
    expect(minted.statusCode, minted.body).toBe(200);
    const { url } = JSON.parse(minted.body) as { url: string };
    expect((await adminCall('GET', url)).statusCode).toBe(200);
    expect((await adminCall('GET', url)).statusCode).toBe(403);
  });
});

describe('completion', () => {
  it('counts only what is really there', async () => {
    const body = JSON.parse((await call(bOwner, 'GET', PROFILE)).body) as ProfileBody;
    expect(body.completion.percent).toBeLessThan(50);
    expect(body.completion.missing).toEqual(
      expect.arrayContaining(['logo', 'document.BUSINESS_LICENCE', 'timeZone']),
    );
  });
});
