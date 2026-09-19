/**
 * Becoming a seller, and the application that follows.
 *
 * These are the only seller routes reachable WITHOUT an existing seller
 * organisation - `POST /apply` creates one and `GET /me` answers "does this
 * account sell here?", which the storefront header asks on every page load and
 * which must therefore answer "no" rather than throwing.
 *
 * Everything below them uses `requireSeller`, so the seller account id comes
 * from the session and never from the request.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ErrorCode } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { logoUrlFor, removeSellerLogo, uploadSellerLogo } from '../../modules/seller/logo.service.js';
import {
  changeMemberRole,
  findSellerMembership,
  resolveSellerMembership,
  isDisplayNameAvailable,
  removeMember,
  startSellerApplication,
} from '../../modules/seller/account.service.js';
import {
  lockSeller,
  sellerLockState,
  setSellerLock,
  unlockSeller,
} from '../../modules/seller/lock.service.js';
import {
  SELLER_UPLOADABLE_KINDS,
  createSellerDocumentLink,
  listSellerDocuments,
  redeemDocumentLink,
  uploadSellerDocument,
  withdrawSellerDocument,
} from '../../modules/seller/document.service.js';
import {
  acceptAgreement,
  readOnboarding,
  requirementsFor,
  saveBusinessProfile,
  saveStoreProfile,
  submitApplication,
} from '../../modules/seller/onboarding.service.js';
import { prisma } from '../../infra/prisma.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { currentUser, requireCustomer } from '../plugins/auth.js';
import { currentSeller, requireSeller } from '../plugins/seller.js';

const applySchema = z.object({
  legalName: z.string().trim().min(2).max(255),
  displayName: z.string().trim().min(2).max(160),
  registrationCountry: z.string().trim().length(2).toUpperCase(),
  kind: z
    .enum(['MANUFACTURER', 'AUTHORISED_DISTRIBUTOR', 'WHOLESALER', 'RESELLER'])
    .optional(),
});

const businessProfileSchema = z.object({
  representativeName: z.string().trim().max(160).nullable().optional(),
  representativeEmail: z.string().trim().email().max(320).nullable().optional(),
  representativePhone: z.string().trim().max(32).nullable().optional(),
  representativeRole: z.string().trim().max(120).nullable().optional(),
  supportEmail: z.string().trim().email().max(320).nullable().optional(),
  supportPhone: z.string().trim().max(32).nullable().optional(),
  preferredLanguage: z.string().trim().max(12).nullable().optional(),
  timezone: z.string().trim().max(64).nullable().optional(),
  companyRegistrationNumber: z.string().trim().max(64).nullable().optional(),
  taxRegistrationNumber: z.string().trim().max(64).nullable().optional(),
  eoriNumber: z.string().trim().max(32).nullable().optional(),
  eudamedSrn: z.string().trim().max(64).nullable().optional(),
  websiteUrl: z.string().trim().url().max(512).nullable().optional(),
  yearsInBusiness: z.number().int().min(0).max(500).nullable().optional(),
  /*
   * The registered address, as six fields rather than one.
   *
   * These columns have existed since this table did; until the Seller Hub's
   * Business Identity step learned to ask for the parts, only line 1 was ever
   * written and it held whatever prose somebody typed into a single box.
   *
   * The limits below are the ones the brief names (200/200/100/100/20/2) where
   * they are TIGHTER than the column, and the column's own where they are not:
   * line 1 and 2 are `VARCHAR(255)` and there is no reason to refuse a genuine
   * 220-character Indian industrial-estate address that the database would
   * store perfectly well. The postcode is the one that moves - 20, matching
   * the brief, inside a `VARCHAR(24)` column, so the cap a seller meets is the
   * one the form told them about.
   *
   * `.trim()` on every one of them, so whitespace never reaches the database
   * and " " is not a city.
   *
   * The postcode is deliberately NOT pattern-checked here. It cannot be: which
   * pattern applies depends on the country, and the country arrives in the same
   * body and may not have been sent at all on a patch that changes only the
   * postcode. That check runs in `assertRegisteredAddress` below, against the
   * country the profile will actually have once this patch lands.
   */
  registeredAddressLine1: z.string().trim().max(255).nullable().optional(),
  registeredAddressLine2: z.string().trim().max(255).nullable().optional(),
  registeredCity: z.string().trim().max(120).nullable().optional(),
  registeredRegion: z.string().trim().max(120).nullable().optional(),
  registeredPostcode: z.string().trim().max(20).nullable().optional(),
  registeredCountry: z.string().trim().length(2).toUpperCase().nullable().optional(),
  billingAddressLine1: z.string().trim().max(255).nullable().optional(),
  billingAddressLine2: z.string().trim().max(255).nullable().optional(),
  billingCity: z.string().trim().max(120).nullable().optional(),
  billingRegion: z.string().trim().max(120).nullable().optional(),
  billingPostcode: z.string().trim().max(24).nullable().optional(),
  billingCountry: z.string().trim().length(2).toUpperCase().nullable().optional(),
  extraIdentifiers: z.record(z.string(), z.string().max(255)).nullable().optional(),
});

/**
 * The store details step.
 *
 * An empty support email arrives as `null` rather than as an empty string,
 * because `.email()` would refuse `''` and the seller would be told their
 * details could not be saved when what they did was clear a field.
 */
const storeProfileSchema = z.object({
  description: z.string().trim().max(4000).nullable().optional(),
  supportEmail: z.string().trim().email().max(320).nullable().optional(),
  supportPhone: z.string().trim().max(32).nullable().optional(),
});

const agreementSchema = z.object({
  kind: z.enum([
    'MARKETPLACE_AGREEMENT',
    'COMMISSION_SCHEDULE',
    'RETURNS_POLICY',
    'PRIVACY_POLICY',
    'INTELLECTUAL_PROPERTY_DECLARATION',
  ]),
  version: z.string().trim().min(1).max(32),
  acceptedName: z.string().trim().min(2).max(160),
  /**
   * The drawn signature, as an object key from a previous upload.
   *
   * Accepted as EVIDENCE beside the click-through, never as a verified legal
   * signature - see `acceptAgreement`, where the distinction is enforced and
   * explained. The interface must not describe it as a signature that has been
   * verified, because nothing here verified anything.
   */
  signatureStorageKey: z.string().trim().max(512).nullable().optional(),
});

/**
 * The transport ceiling for a certificate.
 *
 * Ten megabytes, matching the service's own limit. `UPLOAD_MAX_BYTES` would be
 * the wrong one - it defaults to five and exists to keep RAW files out of the
 * catalogue, while a multi-page certificate scanned at 300dpi is routinely
 * larger than any product photograph.
 */
const SELLER_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The fields that arrive beside an uploaded document.
 *
 * Multipart carries everything as text, so the two dates are parsed here rather
 * than trusted: `2026-02-31` is a string a browser will happily send and is not
 * a day. Both are optional - not every kind of evidence has dates printed on
 * it.
 */
const documentUploadFields = z.object({
  kind: z.enum(SELLER_UPLOADABLE_KINDS),
  requirementFieldKey: z.string().trim().max(64).nullable().optional(),
  issuedOn: z.coerce.date().nullable().optional(),
  expiresOn: z.coerce.date().nullable().optional(),
});

/**
 * A filename safe to put in a Content-Disposition header.
 *
 * Quotes, newlines and control characters are stripped rather than escaped: a
 * newline in this header is response splitting, and the seller's own filename
 * is decoration on a download nobody needs to round-trip exactly.
 */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[^\w.\-() ]+/g, '_').slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'document';
}

/**
 * Routes that answer before a seller organisation exists.
 *
 * Registered with `requireCustomer` rather than `requireSeller`, which is the
 * whole reason they are in a separate function: `requireSeller` refuses an
 * account that has never applied, and these two are how an account applies.
 */
export function registerSellerEntryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCustomer);

  /**
   * "Do I sell here, and how is it going?"
   *
   * Answers 200 with `{ seller: null }` for an ordinary buyer rather than 403.
   * The storefront header calls this on every page to decide between "Become a
   * seller" and "Seller Hub", and a 403 on the common case would put an error
   * in the console of every page view.
   */
  app.get('/me', async (request, reply) => {
    const auth = currentUser(request);
    const membership = await findSellerMembership(auth.customerProfileId ?? '');

    if (membership === null) {
      return reply.header('cache-control', 'no-store').status(200).send({ seller: null });
    }

    return reply.header('cache-control', 'no-store').status(200).send({
      seller: {
        sellerAccountId: membership.sellerAccountId,
        displayName: membership.displayName,
        legalName: membership.legalName,
        slug: membership.slug,
        status: membership.status,
        role: membership.role,
        isTrading: membership.isTrading,
        isApplicationEditable: membership.isApplicationEditable,
        /*
         * The seller's own mark, so the Hub can put it above their name.
         *
         * Here rather than only on the profile screen because the Hub's frame
         * is on every page a seller works in, and a workspace headed by the
         * marketplace's branding and a line of text is a workspace that never
         * quite feels like the seller's own. Null is a working state - the
         * frame draws their initial instead of the operator's logo.
         */
        logoUrl: logoUrlFor(membership.logoStorageKey),
        permissions: [...membership.permissions],
        /*
         * The Hub's second lock, as this browser finds it.
         *
         * Carried on the identity query rather than discovered by a 403,
         * because the Hub has to know before it draws: a seller with no
         * password yet gets a "choose one" screen and a seller with one gets a
         * "enter it" screen, and a frontend that learned the difference from a
         * refusal would flash the workspace first.
         */
        lock: sellerLockState(membership, {
          sellerUnlockedAt: auth.sessionSellerUnlockedAt,
          sellerUnlockedForId: auth.sessionSellerUnlockedForId,
        }),
      },
    });
  });

  /**
   * Choose the Seller Hub password, or change it.
   *
   * On the entry routes rather than behind `requireSeller`, because a seller
   * who has not chosen one yet cannot pass that guard — it is the guard that
   * sends them here.
   */
  app.post('/lock', async (request, reply) => {
    const auth = currentUser(request);
    const membership = await resolveSellerMembership(auth.customerProfileId ?? '');

    const body = z
      .object({
        currentPassword: z.string().min(1).max(128).nullable().optional(),
        newPassword: z
          .string()
          .min(12, 'Your Seller Hub password must be at least 12 characters.')
          .max(128, 'Your Seller Hub password must be at most 128 characters.'),
      })
      .parse(request.body);

    const state = await setSellerLock(
      membership,
      auth.sessionId,
      auth.id,
      body,
      request.correlationId,
    );

    return reply.status(200).send({ lock: state });
  });

  /** Open the Hub for this session. */
  app.post('/lock/open', async (request, reply) => {
    const auth = currentUser(request);
    const membership = await resolveSellerMembership(auth.customerProfileId ?? '');

    const body = z.object({ password: z.string().min(1).max(128) }).parse(request.body);

    const state = await unlockSeller(
      membership,
      auth.sessionId,
      auth.id,
      body.password,
      request.correlationId,
    );

    return reply.status(200).send({ lock: state });
  });

  /**
   * Shut it again, without signing out of the shop.
   *
   * The Hub and the storefront share a browser, so somebody handing the
   * machine over needs a way to close the Hub that does not cost them their
   * basket.
   */
  app.post('/lock/close', async (request, reply) => {
    const auth = currentUser(request);
    const state = await lockSeller(auth.sessionId);

    return reply.status(200).send({ lock: state });
  });

  /** Is this public shop name free? Called as the seller types it. */
  app.get('/display-name-available', async (request, reply) => {
    const query = z.object({ name: z.string().trim().min(1).max(160) }).parse(request.query);
    const available = await isDisplayNameAvailable(query.name);

    return reply.header('cache-control', 'no-store').status(200).send({ available });
  });

  /**
   * Start a seller application.
   *
   * Rate-limited because it creates a tenant. Without a limit, one account
   * could not create more than one - `SellerMember.customerProfileId` is
   * unique - but a script could still burn through display names, and a taken
   * name is not recoverable without an operator.
   */
  app.post(
    '/apply',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const auth = currentUser(request);
      const body = applySchema.parse(request.body);

      const membership = await startSellerApplication({
        customerProfileId: auth.customerProfileId ?? '',
        legalName: body.legalName,
        displayName: body.displayName,
        registrationCountry: body.registrationCountry,
        ...(body.kind === undefined ? {} : { kind: body.kind }),
        correlationId: request.correlationId,
        userId: auth.id,
      });

      return reply.status(201).send({
        sellerAccountId: membership.sellerAccountId,
        displayName: membership.displayName,
        status: membership.status,
        role: membership.role,
      });
    },
  );

  return Promise.resolve();
}

/** Everything that needs an existing seller organisation. */
export function registerSellerAccountRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSeller());

  /** The onboarding checklist: every step, its state, and what it still needs. */
  app.get('/onboarding', async (request, reply) => {
    const view = await readOnboarding(currentSeller(request));
    return reply.header('cache-control', 'no-store').status(200).send(view);
  });

  /** The fields this seller's country and kind demand, for a single step. */
  app.get('/onboarding/requirements', async (request, reply) => {
    const seller = currentSeller(request);

    const account = await prisma.sellerAccount.findUnique({
      where: { id: seller.sellerAccountId },
      select: { kind: true, registrationCountry: true },
    });

    const requirements = await requirementsFor(
      account?.registrationCountry ?? seller.registrationCountry,
      account?.kind ?? 'RESELLER',
    );

    return reply.status(200).send({ requirements });
  });

  app.get('/business-profile', async (request, reply) => {
    const seller = currentSeller(request);

    const [account, profile] = await Promise.all([
      prisma.sellerAccount.findUnique({
        where: { id: seller.sellerAccountId },
        select: {
          legalName: true,
          displayName: true,
          slug: true,
          kind: true,
          registrationCountry: true,
          description: true,
          status: true,
          statusReason: true,
          version: true,
          logoStorageKey: true,
        },
      }),
      prisma.sellerBusinessProfile.findUnique({
        where: { sellerAccountId: seller.sellerAccountId },
      }),
    ]);

    return reply.header('cache-control', 'no-store').status(200).send({
      // The key never leaves the server; the URL is built from it on read, so
      // moving the object store cannot leave a screen pointing at nothing.
      account:
        account === null
          ? null
          : { ...account, logoStorageKey: undefined, logoUrl: logoUrlFor(account.logoStorageKey) },
      // `internalNotes` is deliberately not in either select. It is the
      // operator's private assessment and a seller must never read it.
      profile,
    });
  });

  app.patch('/business-profile', async (request, reply) => {
    const body = businessProfileSchema.parse(request.body);

    const result = await saveBusinessProfile(
      currentSeller(request),
      body,
      request.correlationId,
    );

    return reply.status(200).send(result);
  });

  /**
   * The mark on the seller's own shop front.
   *
   * `UPLOAD_MAX_BYTES` as the transport ceiling, and the service applies the
   * real check once the bytes have said what they are — a 40 MB file claiming
   * to be a PNG is still refused, and so is an SVG, whatever it is named.
   */
  app.post(
    '/logo',
    { preHandler: requireSeller(SellerPermission.ACCOUNT_WRITE) },
    async (request, reply) => {
      const upload = await request.file({ limits: { fileSize: env.UPLOAD_MAX_BYTES } });

      if (upload === undefined) {
        return reply.status(400).send({
          error: { code: ErrorCode.VALIDATION_FAILED, message: 'No file was attached.' },
        });
      }

      const result = await uploadSellerLogo({
        membership: currentSeller(request),
        buffer: await upload.toBuffer(),
        correlationId: request.correlationId,
      });

      return reply.status(200).send(result);
    },
  );

  app.delete(
    '/logo',
    { preHandler: requireSeller(SellerPermission.ACCOUNT_WRITE) },
    async (request, reply) => {
      await removeSellerLogo({
        membership: currentSeller(request),
        correlationId: request.correlationId,
      });

      return reply.status(204).send();
    },
  );

  /**
   * The store details step: the description and the support contacts.
   *
   * Answers with the state of the step and what is still missing, the way
   * `/business-profile` does. A 204 told the form nothing, so it said "Store
   * details saved" and left the seller looking at a step with no tick on it
   * and no explanation.
   */
  app.patch('/store-profile', async (request, reply) => {
    const body = storeProfileSchema.parse(request.body);

    const result = await saveStoreProfile(currentSeller(request), body, request.correlationId);

    return reply.status(200).send(result);
  });

  // --- Evidence -----------------------------------------------------------
  //
  // Certificates, licences and the paperwork behind the application. The bytes
  // go to private storage and come back only through a short-lived, single-use
  // link - see `document.service.ts`, where the reasoning lives.

  /** Everything this seller has up, and what the marketplace made of each. */
  app.get('/documents', async (request, reply) => {
    const documents = await listSellerDocuments(currentSeller(request));
    return reply.header('cache-control', 'no-store').status(200).send({ documents });
  });

  /**
   * Attach one.
   *
   * `UPLOAD_MAX_BYTES` would be the wrong transport ceiling here: it is sized
   * for a product photograph, and a multi-page certificate scanned at 300dpi is
   * routinely larger. Raised to the document ceiling, and the service applies
   * the real check once the bytes have said what they are.
   *
   * Rate-limited, because this writes to object storage: sixty in a quarter of
   * an hour is far more than a seller assembling an application will ever need
   * and well short of a script filling a disk.
   */
  app.post(
    '/documents',
    {
      preHandler: requireSeller(SellerPermission.ACCOUNT_WRITE),
      config: { rateLimit: { max: 60, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const upload = await request.file({ limits: { fileSize: SELLER_DOCUMENT_MAX_BYTES } });

      if (upload === undefined) {
        return reply.status(400).send({
          error: { code: ErrorCode.VALIDATION_FAILED, message: 'No file was attached.' },
        });
      }

      // Read once, into memory. Bounded by the limit above, and streaming to
      // disk first would buy nothing but a temporary file to clean up.
      const buffer = await upload.toBuffer();

      const fields = upload.fields as Record<string, { value?: unknown } | undefined>;
      const field = (name: string): string | null =>
        typeof fields[name]?.value === 'string' && fields[name].value.length > 0
          ? fields[name].value
          : null;

      const parsed = documentUploadFields.parse({
        kind: field('kind'),
        requirementFieldKey: field('requirementFieldKey'),
        issuedOn: field('issuedOn'),
        expiresOn: field('expiresOn'),
      });

      const document = await uploadSellerDocument({
        membership: currentSeller(request),
        kind: parsed.kind,
        requirementFieldKey: parsed.requirementFieldKey ?? null,
        // `upload.filename` is the browser's, so it is shown back to the seller
        // and never used to build a path - the storage key is generated.
        fileName: upload.filename,
        bytes: buffer,
        issuedOn: parsed.issuedOn ?? null,
        expiresOn: parsed.expiresOn ?? null,
        correlationId: request.correlationId,
      });

      return reply.status(201).send(document);
    },
  );

  /** Withdraw one nobody has decided yet. */
  app.delete(
    '/documents/:id',
    { preHandler: requireSeller(SellerPermission.ACCOUNT_WRITE) },
    async (request, reply) => {
      const params = z.object({ id: z.string().length(26) }).parse(request.params);
      await withdrawSellerDocument(currentSeller(request), params.id, request.correlationId);
      return reply.status(204).send();
    },
  );

  /** A link to read one back. Minutes, and single use. */
  app.post('/documents/:id/link', async (request, reply) => {
    const params = z.object({ id: z.string().length(26) }).parse(request.params);
    const auth = currentUser(request);

    const link = await createSellerDocumentLink(currentSeller(request), auth.id, params.id);

    return reply.header('cache-control', 'no-store').status(200).send(link);
  });

  /**
   * Redeem it.
   *
   * Served as an ATTACHMENT with `nosniff`, never inline. A PDF rendered in the
   * page would be a PDF running in this origin, and the whole point of the
   * private prefix is that these bytes never become part of a page.
   */
  app.get('/documents/:id/download', async (request, reply) => {
    const params = z.object({ id: z.string().length(26) }).parse(request.params);
    const query = z.object({ token: z.string().min(1).max(256) }).parse(request.query);
    const auth = currentUser(request);
    const seller = currentSeller(request);

    const file = await redeemDocumentLink(
      'seller',
      auth.id,
      params.id,
      query.token,
      seller.sellerAccountId,
    );

    return reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="${safeFileName(file.fileName)}"`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .status(200)
      .send(file.body);
  });

  app.post('/agreements', async (request, reply) => {
    const body = agreementSchema.parse(request.body);

    await acceptAgreement({
      membership: currentSeller(request),
      kind: body.kind,
      version: body.version,
      acceptedName: body.acceptedName,
      signatureStorageKey: body.signatureStorageKey ?? null,
      // Both recorded as evidence of the act. A click-through with neither is
      // worth very little if it is ever challenged.
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      correlationId: request.correlationId,
    });

    return reply.status(204).send();
  });

  app.get('/agreements', async (request, reply) => {
    const seller = currentSeller(request);

    const rows = await prisma.sellerAgreementAcceptance.findMany({
      where: { sellerAccountId: seller.sellerAccountId },
      orderBy: { acceptedAt: 'desc' },
      select: {
        id: true,
        kind: true,
        version: true,
        method: true,
        acceptedName: true,
        acceptedAt: true,
      },
    });

    return reply.status(200).send({ agreements: rows });
  });

  /** Hand the application to the marketplace. */
  app.post(
    '/submit',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (request, reply) => {
      await submitApplication(currentSeller(request), request.correlationId);
      return reply.status(204).send();
    },
  );

  // --- The team -----------------------------------------------------------

  app.get('/members', { preHandler: requireSeller(SellerPermission.MEMBER_READ) }, async (request, reply) => {
    const seller = currentSeller(request);

    const rows = await prisma.sellerMember.findMany({
      where: { sellerAccountId: seller.sellerAccountId, removedAt: null },
      orderBy: { joinedAt: 'asc' },
      select: {
        id: true,
        role: true,
        joinedAt: true,
        customerProfile: { select: { fullName: true, user: { select: { email: true } } } },
      },
    });

    return reply.status(200).send({
      members: rows.map((row) => ({
        id: row.id,
        role: row.role,
        joinedAt: row.joinedAt.toISOString(),
        name: row.customerProfile.fullName,
        email: row.customerProfile.user.email,
      })),
    });
  });

  app.patch(
    '/members/:memberId',
    { preHandler: requireSeller(SellerPermission.MEMBER_WRITE) },
    async (request, reply) => {
      const params = z.object({ memberId: z.string().length(26) }).parse(request.params);
      const body = z
        .object({
          role: z.enum([
            'OWNER',
            'ADMIN',
            'CATALOGUE_MANAGER',
            'INVENTORY_MANAGER',
            'ORDER_MANAGER',
            'FINANCE_VIEWER',
            'SUPPORT_MEMBER',
          ]),
        })
        .parse(request.body);

      await changeMemberRole(
        currentSeller(request),
        params.memberId,
        body.role,
        request.correlationId,
      );

      return reply.status(204).send();
    },
  );

  app.delete(
    '/members/:memberId',
    { preHandler: requireSeller(SellerPermission.MEMBER_WRITE) },
    async (request, reply) => {
      const params = z.object({ memberId: z.string().length(26) }).parse(request.params);
      await removeMember(currentSeller(request), params.memberId, request.correlationId);
      return reply.status(204).send();
    },
  );

  // --- The seller's own record of what happened --------------------------

  app.get(
    '/audit',
    { preHandler: requireSeller(SellerPermission.AUDIT_READ) },
    async (request, reply) => {
      const seller = currentSeller(request);
      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
        .parse(request.query);

      const rows = await prisma.sellerAuditLog.findMany({
        where: { sellerAccountId: seller.sellerAccountId },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        // `beforeJson`/`afterJson` are deliberately omitted from the list. The
        // seller reads `summary`; the diffs are for support, and shipping them
        // to a browser by default is how a redaction bug becomes a disclosure.
        select: {
          id: true,
          action: true,
          actorLabel: true,
          resourceType: true,
          resourceId: true,
          summary: true,
          createdAt: true,
        },
      });

      return reply.status(200).send({
        entries: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      });
    },
  );

  /** An idempotency-safe id the client can use for a draft it is about to create. */
  app.get('/new-id', async (_request, reply) => reply.status(200).send({ id: newId() }));

  return Promise.resolve();
}
