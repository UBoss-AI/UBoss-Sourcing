/**
 * Raising a request for quotation (checklist Master row 16).
 *
 * Everything runs over HTTP through the real guards, the real idempotency hook
 * and the real buyer context: drafts saved and resumed, server-side validation
 * at save and again at submission, supplier matching on category, approval and
 * destination market rules, hand-picked and excluded sellers, duplicate
 * submission, ownership (another buyer, another company), company roles and
 * approval, the private files, the feature flag and the audit trail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { env } from '../../src/config/env.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  as,
  buildRfqWorld,
  cleanRfqWorld,
  completeDraft,
  errorCode,
  errorDetails,
  key,
  submitted,
  type RfqWorld,
} from '../support/rfq-fixture.js';

const PREFIX = 'rfqc-';
let world: RfqWorld;
const mutableEnv = env as unknown as Record<string, unknown>;

interface RfqBody {
  id: string;
  reference: string;
  status: string;
  version: number;
  matchOutcome: string | null;
  currentRequirementVersion: number;
  requirement: Record<string, unknown>;
  owner: { kind: string };
  invitations: { id: string; source: string; status: string; supplier: { sellerAccountId: string } }[];
  attachments: { id: string; requirementVersion: number | null }[];
  versions: { versionNumber: number }[];
  timeline: { kind: string }[];
}

const rfqOf = (response: LightMyRequestResponse): RfqBody => response.json<{ rfq: RfqBody }>().rfq;
const invitedIds = (rfq: RfqBody): string[] =>
  rfq.invitations.map((invitation) => invitation.supplier.sellerAccountId).sort();

function pdf(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
}

function upload(person: RfqWorld['buyer'], url: string, bytes: Buffer, name: string): Promise<LightMyRequestResponse> {
  const boundary = '----rfqboundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return world.app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers: {
      cookie: person.cookie,
      'x-csrf-token': person.csrf,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
}

async function draft(person = world.buyer, body: Record<string, unknown> = completeDraft(world)): Promise<RfqBody> {
  const response = await as(world, person, 'POST', '/rfqs', body, { 'idempotency-key': key() });
  expect(response.statusCode, response.body).toBe(201);
  return rfqOf(response);
}

beforeAll(async () => {
  const app = await buildApp();
  await app.ready();
  world = await buildRfqWorld(app, PREFIX);
});

afterAll(async () => {
  await cleanRfqWorld(PREFIX);
  await world.app.close();
});

describe('who may reach requests for quotation', () => {
  it('refuses a visitor who is not signed in', async () => {
    const list = await world.app.inject({ method: 'GET', url: '/api/v1/rfqs' });
    expect(list.statusCode).toBe(401);
    const create = await world.app.inject({ method: 'POST', url: '/api/v1/rfqs', payload: {} });
    expect(create.statusCode).toBe(401);
  });

  it('answers 404 for another buyer’s request, for every verb', async () => {
    const mine = await draft();
    const rival = world.rival;
    expect((await as(world, rival, 'GET', `/rfqs/${mine.id}`)).statusCode).toBe(404);
    expect(
      (await as(world, rival, 'PUT', `/rfqs/${mine.id}`, { ...completeDraft(world), expectedVersion: 0 })).statusCode,
    ).toBe(404);
    expect((await as(world, rival, 'DELETE', `/rfqs/${mine.id}`)).statusCode).toBe(404);
    expect(
      (await as(world, rival, 'POST', `/rfqs/${mine.id}/submit`, { expectedVersion: 0 }, { 'idempotency-key': key() }))
        .statusCode,
    ).toBe(404);
    // A company context is a different owner: the buyer's own request is not the company's.
    expect((await as(world, world.owner, 'GET', `/rfqs/${mine.id}`)).statusCode).toBe(404);
    const list = await as(world, rival, 'GET', '/rfqs');
    expect(list.json<{ items: { id: string }[] }>().items.map((item) => item.id)).not.toContain(mine.id);
  });
});

describe('drafts', () => {
  it('saves a half-written draft and resumes it, conditional on the version it was opened at', async () => {
    const started = await draft(world.buyer, { title: 'Half a thought' });
    expect(started.status).toBe('DRAFT');
    expect(started.reference).toMatch(/^RFQ-\d{4}-\d{6}$/);
    expect(started.version).toBe(0);

    const saved = await as(world, world.buyer, 'PUT', `/rfqs/${started.id}`, {
      ...completeDraft(world),
      expectedVersion: 0,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(rfqOf(saved).version).toBe(1);
    expect(rfqOf(saved).requirement['quantity']).toBe('12000');

    const staleSave = await as(world, world.buyer, 'PUT', `/rfqs/${started.id}`, {
      ...completeDraft(world, { title: 'Overwritten?' }),
      expectedVersion: 0,
    });
    expect(staleSave.statusCode).toBe(409);
    expect(errorDetails(staleSave)[0]?.code).toBe('STALE');

    const resumed = rfqOf(await as(world, world.buyer, 'GET', `/rfqs/${started.id}`));
    expect(resumed.requirement['title']).toBe('Nitrile examination gloves, powder free');

    const listed = await as(world, world.buyer, 'GET', '/rfqs?status=DRAFT');
    expect(listed.json<{ items: { id: string }[] }>().items.map((item) => item.id)).toContain(started.id);
  });

  it('refuses malformed fields on every save: bounds, pairs, codes and past dates', async () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ quantity: '-5' }, 'quantity', 'VALIDATION_FAILED'],
      [{ quantity: '1.2345' }, 'quantity', 'VALIDATION_FAILED'],
      [{ quantity: '0' }, 'quantity', 'VALIDATION_FAILED'],
      [{ incoterm: 'XYZ' }, 'incoterm', 'VALIDATION_FAILED'],
      [{ unitOfMeasure: 'BUCKET' }, 'unitOfMeasure', 'VALIDATION_FAILED'],
    ];
    for (const [overrides] of cases) {
      const response = await as(world, world.buyer, 'POST', '/rfqs', completeDraft(world, overrides), {
        'idempotency-key': key(),
      });
      expect(response.statusCode, JSON.stringify(overrides)).toBe(400);
      expect(errorCode(response)).toBe('VALIDATION_FAILED');
    }

    const past = await as(
      world,
      world.buyer,
      'POST',
      '/rfqs',
      completeDraft(world, { responseDeadline: new Date(Date.now() - 60_000).toISOString() }),
      { 'idempotency-key': key() },
    );
    expect(past.statusCode).toBe(400);
    expect(errorDetails(past)).toContainEqual(expect.objectContaining({ field: 'responseDeadline', code: 'IN_PAST' }));

    const halfPrice = await as(world, world.buyer, 'POST', '/rfqs', completeDraft(world, { targetCurrency: null }), {
      'idempotency-key': key(),
    });
    expect(errorDetails(halfPrice)).toContainEqual(expect.objectContaining({ code: 'PAIR_REQUIRED' }));

    const badCurrency = await as(world, world.buyer, 'POST', '/rfqs', completeDraft(world, { targetCurrency: 'ZZZ' }), {
      'idempotency-key': key(),
    });
    expect(errorDetails(badCurrency)).toContainEqual(expect.objectContaining({ field: 'targetCurrency', code: 'UNKNOWN' }));

    const badCountry = await as(world, world.buyer, 'POST', '/rfqs', completeDraft(world, { destinationCountry: 'QQ' }), {
      'idempotency-key': key(),
    });
    expect(errorDetails(badCountry)).toContainEqual(expect.objectContaining({ field: 'destinationCountry', code: 'UNKNOWN' }));

    const badCategory = await as(
      world,
      world.buyer,
      'POST',
      '/rfqs',
      completeDraft(world, { categoryId: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' }),
      { 'idempotency-key': key() },
    );
    expect(errorDetails(badCategory)).toContainEqual(expect.objectContaining({ field: 'categoryId', code: 'UNKNOWN' }));
  });

  it('deletes a draft, and never a request already sent', async () => {
    const doomed = await draft();
    expect((await as(world, world.buyer, 'DELETE', `/rfqs/${doomed.id}`)).statusCode).toBe(204);
    expect((await as(world, world.buyer, 'GET', `/rfqs/${doomed.id}`)).statusCode).toBe(404);

    const sent = await submitted(world);
    const refused = await as(world, world.buyer, 'DELETE', `/rfqs/${sent.id}`);
    expect(refused.statusCode).toBe(409);
    expect(errorCode(refused)).toBe('RFQ_NOT_EDITABLE');
  });
});

describe('submission', () => {
  it('re-validates on the server and names every missing or wrong field at once', async () => {
    const empty = await draft(world.buyer, { title: '' });
    const response = await as(world, world.buyer, 'POST', `/rfqs/${empty.id}/submit`, { expectedVersion: 0 }, {
      'idempotency-key': key(),
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('RFQ_INCOMPLETE');
    const fields = errorDetails(response).map((detail) => `${detail.field ?? ''}:${detail.code}`);
    for (const field of ['categoryId', 'title', 'specification', 'quantity', 'unitOfMeasure', 'destinationCountry', 'incoterm', 'responseDeadline']) {
      expect(fields).toContain(`${field}:REQUIRED`);
    }

    const noPort = await draft(world.buyer, completeDraft(world, { destinationAddress: null, destinationPort: null }));
    const cif = await as(world, world.buyer, 'POST', `/rfqs/${noPort.id}/submit`, { expectedVersion: 0 }, {
      'idempotency-key': key(),
    });
    expect(errorDetails(cif)).toContainEqual(expect.objectContaining({ code: 'DESTINATION_NEEDED' }));

    const far = await draft(
      world.buyer,
      completeDraft(world, {
        responseDeadline: new Date(Date.now() + (env.RFQ_MAX_RESPONSE_DAYS + 5) * 86_400_000).toISOString(),
        deliveryTargetDate: null,
      }),
    );
    const tooFar = await as(world, world.buyer, 'POST', `/rfqs/${far.id}/submit`, { expectedVersion: 0 }, {
      'idempotency-key': key(),
    });
    expect(errorDetails(tooFar)).toContainEqual(expect.objectContaining({ field: 'responseDeadline', code: 'TOO_FAR' }));

    const early = await draft(
      world.buyer,
      completeDraft(world, { deliveryTargetDate: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) }),
    );
    const before = await as(world, world.buyer, 'POST', `/rfqs/${early.id}/submit`, { expectedVersion: 0 }, {
      'idempotency-key': key(),
    });
    expect(errorDetails(before)).toContainEqual(expect.objectContaining({ field: 'deliveryTargetDate', code: 'BEFORE_DEADLINE' }));

    // Nothing was sent for any of them.
    expect(await prisma.rfqInvitation.count({ where: { rfqId: { in: [empty.id, noPort.id, far.id, early.id] } } })).toBe(0);
  });

  it('invites only approved sellers of the category, records each, tells each and audits it', async () => {
    const sent = await submitted(world);
    expect(sent).toMatchObject({ status: 'OPEN', matchOutcome: 'MATCHED', currentRequirementVersion: 1 });
    const { alpha, beta, delta, gamma, pending } = world.sellers;
    // PENDING is not approved and GAMMA sells in another category.
    expect(invitedIds(sent as unknown as RfqBody)).toEqual([alpha.id, beta.id, delta.id].sort());
    expect(sent.invitations.every((invitation) => invitation.status === 'INVITED')).toBe(true);
    expect(invitedIds(sent as unknown as RfqBody)).not.toContain(pending.id);
    expect(invitedIds(sent as unknown as RfqBody)).not.toContain(gamma.id);

    const body = rfqOf(await as(world, world.buyer, 'GET', `/rfqs/${sent.id}`));
    expect(body.versions.map((version) => version.versionNumber)).toEqual([1]);
    expect(body.timeline.map((event) => event.kind)).toEqual(
      expect.arrayContaining(['CREATED', 'SUBMITTED', 'SUPPLIERS_MATCHED', 'SUPPLIER_INVITED']),
    );

    const alert = await prisma.sellerNotification.findFirst({
      where: { sellerAccountId: alpha.id, kind: 'RFQ_INVITATION', subjectId: sent.id },
    });
    expect(alert).toMatchObject({ class: 'ALERT', status: 'ACTIVE', linkPath: `/seller/rfqs/${sent.id}` });
    const email = await prisma.notificationOutbox.findFirst({
      where: { eventKey: 'rfq.invitation', recipientEmail: alpha.owner.email, relatedId: sent.id },
    });
    expect(email?.body).toContain(sent.reference);

    const audit = await prisma.auditLog.findMany({
      where: { resourceType: 'rfq_request', resourceId: sent.id },
      select: { action: true, actorUserId: true },
    });
    expect(audit.map((row) => row.action)).toEqual(expect.arrayContaining(['rfq.created', 'rfq.submitted']));
    expect(audit.every((row) => row.actorUserId === world.buyer.userId)).toBe(true);
  });

  it('leaves out a seller whose only product is blocked for the destination', async () => {
    const sent = await submitted(world, world.buyer, { destinationCountry: 'DE' });
    const { alpha, beta, delta } = world.sellers;
    expect(invitedIds(sent as unknown as RfqBody)).toEqual([alpha.id, beta.id].sort());
    expect(invitedIds(sent as unknown as RfqBody)).not.toContain(delta.id);
  });

  it('refuses a category the marketplace does not sell into the destination, and sends nothing', async () => {
    const blocked = await draft(world.buyer, completeDraft(world, { destinationCountry: 'BR' }));
    const response = await as(world, world.buyer, 'POST', `/rfqs/${blocked.id}/submit`, { expectedVersion: 0 }, {
      'idempotency-key': key(),
    });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('RFQ_DESTINATION_BLOCKED');
    const after = rfqOf(await as(world, world.buyer, 'GET', `/rfqs/${blocked.id}`));
    expect(after.status).toBe('DRAFT');
    expect(after.invitations).toEqual([]);
  });

  it('honours sellers the buyer excluded and picked by name, and refuses one that is not approved', async () => {
    const { alpha, beta, delta, gamma, pending } = world.sellers;
    const sent = await submitted(world, world.buyer, { excludeSellerIds: [beta.id], includeSellerIds: [gamma.id] });
    expect(invitedIds(sent as unknown as RfqBody)).toEqual([alpha.id, delta.id, gamma.id].sort());
    expect(sent.invitations.find((invitation) => invitation.supplier.sellerAccountId === gamma.id)).toMatchObject({
      source: 'BUYER_SELECTED',
    });

    const withPending = await draft(world.buyer, completeDraft(world, { includeSellerIds: [pending.id] }));
    const refused = await as(world, world.buyer, 'POST', `/rfqs/${withPending.id}/submit`, { expectedVersion: 0 }, {
      'idempotency-key': key(),
    });
    expect(refused.statusCode).toBe(409);
    expect(errorCode(refused)).toBe('RFQ_SUPPLIER_NOT_ELIGIBLE');
  });

  it('never invites the buyer’s own business', async () => {
    // ALPHA's owner, buying for themselves, asks the category ALPHA sells in.
    const sent = await submitted(world, world.sellers.alpha.owner);
    expect(invitedIds(sent as unknown as RfqBody)).not.toContain(world.sellers.alpha.id);
    expect(invitedIds(sent as unknown as RfqBody)).toContain(world.sellers.beta.id);
  });

  it('says honestly when nothing matched, and lets the buyer invite by name afterwards', async () => {
    const { gamma, pending } = world.sellers;
    // Nobody sells in the empty category.
    const sent = await submitted(world, world.buyer, { categoryId: world.emptyCategoryId });
    expect(sent).toMatchObject({ status: 'OPEN', matchOutcome: 'NO_MATCH' });
    expect(sent.invitations).toEqual([]);
    const body = rfqOf(await as(world, world.buyer, 'GET', `/rfqs/${sent.id}`));
    expect(body.timeline.map((event) => event.kind)).toContain('NO_SUPPLIERS_MATCHED');

    const search = await as(world, world.buyer, 'GET', `/rfqs/suppliers?q=${encodeURIComponent('Gamma')}`);
    const found = search.json<{ suppliers: { sellerAccountId: string }[] }>().suppliers.map((row) => row.sellerAccountId);
    expect(found).toContain(gamma.id);
    const pendingSearch = await as(world, world.buyer, 'GET', `/rfqs/suppliers?q=${encodeURIComponent('Pending')}`);
    expect(pendingSearch.json<{ suppliers: unknown[] }>().suppliers).toEqual([]);

    const invite = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/invitations`, { sellerAccountId: gamma.id });
    expect(invite.statusCode, invite.body).toBe(200);
    expect(invitedIds(rfqOf(invite))).toEqual([gamma.id]);
    // Twice is still once.
    const again = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/invitations`, { sellerAccountId: gamma.id });
    expect(rfqOf(again).invitations).toHaveLength(1);
    const notApproved = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/invitations`, { sellerAccountId: pending.id });
    expect(errorCode(notApproved)).toBe('RFQ_SUPPLIER_NOT_ELIGIBLE');
  });

  it('sends a request once however many times submit is pressed', async () => {
    const one = await draft();
    const idempotency = key();
    const first = await as(world, world.buyer, 'POST', `/rfqs/${one.id}/submit`, { expectedVersion: 0 }, {
      'idempotency-key': idempotency,
    });
    const replay = await as(world, world.buyer, 'POST', `/rfqs/${one.id}/submit`, { expectedVersion: 0 }, {
      'idempotency-key': idempotency,
    });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const second = await as(world, world.buyer, 'POST', `/rfqs/${one.id}/submit`, { expectedVersion: 0 }, {
      'idempotency-key': key(),
    });
    expect(second.statusCode).toBe(409);
    expect(errorCode(second)).toBe('RFQ_TRANSITION_NOT_ALLOWED');
    expect(await prisma.rfqInvitation.count({ where: { rfqId: one.id } })).toBe(3);
    expect(await prisma.rfqRequirementVersion.count({ where: { rfqId: one.id } })).toBe(1);

    // Two presses at the same moment with different keys: one wins.
    const two = await draft();
    const results = await Promise.allSettled([
      as(world, world.buyer, 'POST', `/rfqs/${two.id}/submit`, { expectedVersion: 0 }, { 'idempotency-key': key() }),
      as(world, world.buyer, 'POST', `/rfqs/${two.id}/submit`, { expectedVersion: 0 }, { 'idempotency-key': key() }),
    ]);
    const statuses = results.map((result) => (result.status === 'fulfilled' ? result.value.statusCode : 0)).sort();
    expect(statuses).toEqual([200, 409]);
    expect(await prisma.rfqInvitation.count({ where: { rfqId: two.id } })).toBe(3);
  });

  it('cancels an open request and tells every seller, whose alerts then close', async () => {
    const sent = await submitted(world);
    const cancelled = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/cancel`, {
      expectedVersion: sent.version,
      reason: 'Budget withdrawn',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(rfqOf(cancelled).status).toBe('CANCELLED');
    const update = await prisma.sellerNotification.findFirst({
      where: { sellerAccountId: world.sellers.alpha.id, kind: 'RFQ_UPDATE', subjectId: sent.id },
    });
    expect(update).not.toBeNull();
    const alert = await prisma.sellerNotification.findFirst({
      where: { sellerAccountId: world.sellers.alpha.id, kind: 'RFQ_INVITATION', subjectId: sent.id },
    });
    expect(alert?.status).toBe('RESOLVED');
    const again = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/close`, {
      expectedVersion: rfqOf(cancelled).version,
      reason: null,
    });
    expect(errorCode(again)).toBe('RFQ_TRANSITION_NOT_ALLOWED');
  });
});

describe('buying for a company', () => {
  it('files the request under the company, visible to its viewer and to nobody outside it', async () => {
    const sent = await submitted(world, world.owner);
    const body = rfqOf(await as(world, world.owner, 'GET', `/rfqs/${sent.id}`));
    expect(body.owner.kind).toBe('COMPANY');
    expect((await as(world, world.viewer, 'GET', `/rfqs/${sent.id}`)).statusCode).toBe(200);
    expect((await as(world, world.buyer, 'GET', `/rfqs/${sent.id}`)).statusCode).toBe(404);
  });

  it('refuses a role without the purchase capability, and a company not yet approved', async () => {
    const viewerCreate = await as(world, world.viewer, 'POST', '/rfqs', completeDraft(world), { 'idempotency-key': key() });
    expect(viewerCreate.statusCode).toBe(403);
    expect(errorCode(viewerCreate)).toBe('BUYER_COMPANY_ROLE_FORBIDDEN');

    await prisma.buyerCompany.update({ where: { id: world.companyId }, data: { status: 'UNDER_REVIEW' } });
    try {
      // A draft may be written while the company is reviewed; sending it waits for approval.
      const pendingDraft = await draft(world.owner);
      const refused = await as(world, world.owner, 'POST', `/rfqs/${pendingDraft.id}/submit`, { expectedVersion: 0 }, {
        'idempotency-key': key(),
      });
      expect(refused.statusCode).toBe(403);
      expect(errorCode(refused)).toBe('BUYER_COMPANY_NOT_APPROVED');
    } finally {
      await prisma.buyerCompany.update({ where: { id: world.companyId }, data: { status: 'APPROVED' } });
    }
  });
});

describe('files on the requirement', () => {
  it('refuses files when no scanner is configured and unscanned files are not accepted', async () => {
    const one = await draft();
    const response = await upload(world.buyer, `/rfqs/${one.id}/attachments`, pdf(), 'drawing.pdf');
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('RFQ_ATTACHMENTS_UNAVAILABLE');
  });

  it('checks type and size by content, keeps them private, and freezes them on submission', async () => {
    mutableEnv['RFQ_ALLOW_UNSCANNED_ATTACHMENTS'] = true;
    try {
      const one = await draft();
      const stored = await upload(world.buyer, `/rfqs/${one.id}/attachments`, pdf(), 'drawing.pdf');
      expect(stored.statusCode, stored.body).toBe(201);
      const attachment = stored.json<{ attachment: { id: string; contentType: string; requirementVersion: number | null } }>()
        .attachment;
      expect(attachment).toMatchObject({ contentType: 'application/pdf', requirementVersion: null });

      const text = await upload(world.buyer, `/rfqs/${one.id}/attachments`, Buffer.from('just words'), 'notes.pdf');
      expect(text.statusCode).toBe(400);
      expect(errorCode(text)).toBe('MEDIA_TYPE_NOT_ALLOWED');

      const limit = env.RFQ_ATTACHMENT_MAX_BYTES;
      mutableEnv['RFQ_ATTACHMENT_MAX_BYTES'] = 20;
      try {
        const big = await upload(world.buyer, `/rfqs/${one.id}/attachments`, pdf(), 'big.pdf');
        // Cut off while it streams in, before a byte is stored.
        expect(big.statusCode).toBe(413);
        expect(errorCode(big)).toBe('PAYLOAD_TOO_LARGE');
      } finally {
        mutableEnv['RFQ_ATTACHMENT_MAX_BYTES'] = limit;
      }

      const url = `/rfqs/${one.id}/attachments/${attachment.id}/download`;
      const mine = await as(world, world.buyer, 'GET', url);
      expect(mine.statusCode).toBe(200);
      expect(mine.headers['content-disposition']).toMatch(/^attachment;/);
      expect(mine.headers['content-security-policy']).toContain('sandbox');
      expect((await as(world, world.rival, 'GET', url)).statusCode).toBe(404);

      const sent = await as(world, world.buyer, 'POST', `/rfqs/${one.id}/submit`, { expectedVersion: 0 }, {
        'idempotency-key': key(),
      });
      expect(sent.statusCode, sent.body).toBe(200);
      expect(rfqOf(sent).attachments[0]?.requirementVersion).toBe(1);
      const remove = await as(world, world.buyer, 'DELETE', `/rfqs/${one.id}/attachments/${attachment.id}`);
      expect(remove.statusCode).toBe(409);
      expect(errorCode(remove)).toBe('RFQ_NOT_EDITABLE');

      const audit = await prisma.auditLog.findMany({ where: { resourceId: one.id }, select: { action: true } });
      expect(audit.map((row) => row.action)).toEqual(
        expect.arrayContaining(['rfq.attachment_uploaded', 'rfq.attachment_downloaded']),
      );
    } finally {
      mutableEnv['RFQ_ALLOW_UNSCANNED_ATTACHMENTS'] = false;
    }
  });
});

describe('the feature flag', () => {
  it('refuses every route and says so in the public configuration when switched off', async () => {
    mutableEnv['FEATURE_RFQ'] = false;
    try {
      const list = await as(world, world.buyer, 'GET', '/rfqs');
      expect(list.statusCode).toBe(404);
      expect(errorCode(list)).toBe('FEATURE_DISABLED');
      const config = await world.app.inject({ method: 'GET', url: '/api/v1/config' });
      expect(config.json<{ features: { rfq: boolean } }>().features.rfq).toBe(false);
    } finally {
      mutableEnv['FEATURE_RFQ'] = true;
    }
    expect((await as(world, world.buyer, 'GET', '/rfqs')).statusCode).toBe(200);
  });
});
