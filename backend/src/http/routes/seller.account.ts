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
  renewSellerSession,
  sellerIdleView,
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
import {
  confirmCarrierForProduction,
  createCarrierConnection,
  listCarrierConnections,
  pauseCarrierConnection,
  testCarrierConnection,
} from '../../modules/seller/carrier-connection.service.js';
import {
  credentialFieldsFor,
  destroyCarrierCredential,
  storeCarrierCredential,
} from '../../modules/seller/carrier-credential.service.js';
import {
  createSelfManagedOrganisation,
  inviteDedicatedPartner,
  readRelationshipHistory,
  requestExistingPartner,
  revokePartnerInvitation,
  searchPartnersForSeller,
} from '../../modules/seller/logistics-organisation.service.js';
import {
  archiveFulfilmentRule,
  changeMethodStatus,
  chooseFulfilmentMethod,
  describeFulfilmentOptions,
  listFulfilmentRules,
  setMethodRole,
  upsertFulfilmentRule,
} from '../../modules/seller/fulfilment-method.service.js';
import {
  LogisticsCapabilityKind,
  LogisticsRegionScope,
} from '../../generated/prisma/enums.js';
import {
  listCapabilities,
  listPickupProfiles,
  listRateCards,
  listServiceAreas,
  publishRateCard,
  removeServiceArea,
  requestCapability,
  savePickupProfile,
  saveServiceArea,
} from '../../modules/seller/self-managed-config.service.js';
import { currentSeller, requireSeller } from '../plugins/seller.js';

/**
 * Money on the wire, always as a string of whole minor units.
 *
 * Never a JSON number: a delivery charge that passed through a JavaScript
 * float is a charge that can disagree with the invoice by a cent, and the cent
 * is the one the customer writes in about.
 */
const minorUnits = z.string().regex(/^\d+$/, 'Expected whole minor units, e.g. "450".');

/** `HH:MM`, wall-clock at the warehouse - which is why the location owns the timezone. */
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM.');

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
        /*
         * When the open Hub re-locks without further activity, and the
         * deployment's idle and warning settings, so the page times its
         * warning from the server rather than from its own guess.
         */
        session: sellerIdleView({
          sellerUnlockedAt:
            auth.sessionSellerUnlockedForId === membership.sellerAccountId
              ? auth.sessionSellerUnlockedAt
              : null,
          sellerUnlockedForId: auth.sessionSellerUnlockedForId,
          sellerLastActivityAt: auth.sessionSellerLastActivityAt,
        }),
      },
    });
  });

  /**
   * When the open Seller Hub re-locks without further activity. Reading it
   * does not count as activity, so a tab can check without keeping itself
   * open. Refused with SELLER_SESSION_EXPIRED once the Hub has re-locked.
   */
  app.get('/session', { preHandler: requireSeller() }, async (request, reply) => {
    const auth = currentUser(request);
    return reply
      .header('cache-control', 'no-store')
      .status(200)
      .send({
        session: sellerIdleView({
          sellerUnlockedAt: auth.sessionSellerUnlockedAt,
          sellerUnlockedForId: auth.sessionSellerUnlockedForId,
          sellerLastActivityAt: auth.sessionSellerLastActivityAt,
        }),
      });
  });

  /**
   * "Stay signed in": keep the open Seller Hub open for another full idle
   * period. Needs the Hub to still be open; once it has re-locked this is
   * refused with SELLER_SESSION_EXPIRED and the password is needed again.
   * Writes an audit entry.
   */
  app.post(
    '/session/renew',
    { preHandler: requireSeller(), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = currentUser(request);
      const session = await renewSellerSession(auth.sessionId, {
        userId: auth.id,
        memberId: currentSeller(request).memberId,
        correlationId: request.correlationId,
      });
      return reply.header('cache-control', 'no-store').status(200).send({ session });
    },
  );

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
    const membership = await resolveSellerMembership(auth.customerProfileId ?? '');
    const state = await lockSeller(auth.sessionId, {
      userId: auth.id,
      memberId: membership.memberId,
      correlationId: request.correlationId,
    });

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

  /**
   * The seller's company details and business profile as entered in the
   * application, with their logo. The marketplace's private notes on the
   * seller are never included.
   */
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

  /**
   * Save the business details step of the seller application - contacts,
   * registration and tax numbers, address - and return what is still missing.
   * Refused once the application is under review. Writes an audit entry.
   */
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

  /** Remove the seller's shop logo. Writes an audit entry. */
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

  /**
   * Accept one of the marketplace's seller agreements at a given version, by
   * typed name or drawn signature. Only the account owner may do this. The time,
   * IP address and browser are kept as evidence. Writes an audit entry.
   */
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

  /** Every agreement the seller has accepted, newest first: which one, which version, by whom and when. */
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

  // --- How this seller's goods get delivered -------------------------------
  //
  // The Logistics Partner onboarding step, and the Seller Hub screen it turns
  // into once the application is approved. One set of routes for both, because
  // they are the same question asked at two moments - and a second
  // implementation for "the settings version" is how the two end up disagreeing
  // about what a seller has configured.
  //
  // EVERY ROUTE TAKES THE SELLER FROM THE SESSION. None of them accepts a
  // `sellerAccountId`, and the service has no function that would take one.

  /**
   * The five options, with this seller's own state folded into each.
   *
   * One call rather than two, so the cards never render as "not started"
   * against something the seller finished last week while a second request is
   * still in flight.
   */
  app.get(
    '/fulfilment/options',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_READ) },
    async (request, reply) => {
      const seller = currentSeller(request);
      const result = await describeFulfilmentOptions(seller.sellerAccountId);

      // no-store: which carriers a business uses and whether each is healthy is
      // commercially sensitive, and a shared cache holding it would serve one
      // seller's configuration to the next.
      return reply.header('cache-control', 'no-store').status(200).send(result);
    },
  );

  /**
   * Choose a way of delivering.
   *
   * Creates the METHOD and nothing else. Connecting a carrier account,
   * creating a logistics organisation and inviting a partner are separate,
   * deliberate acts: one call that did all of them would make "show me what
   * DHL involves" indistinguishable from "store my DHL credentials".
   */
  app.post(
    '/fulfilment/methods',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          mode: z.enum([
            'INTEGRATED_CARRIER',
            'SELF_MANAGED',
            'DEDICATED_PARTNER',
            'OPERATOR_FULFILLED',
          ]),
          provider: z.enum(['DHL', 'FEDEX', 'INDIA_POST', 'UPS', 'CUSTOM', 'MANUAL']).nullable().optional(),
          environment: z.enum(['SANDBOX', 'PRODUCTION']).nullable().optional(),
          publicDisplayName: z.string().trim().min(1).max(160).nullable().optional(),
          makePrimary: z.boolean().optional(),
        })
        .parse(request.body);

      const seller = currentSeller(request);

      const method = await chooseFulfilmentMethod({
        sellerAccountId: seller.sellerAccountId,
        actor: {
          memberId: seller.memberId,
          userId: null,
          label: seller.displayName,
        },
        mode: body.mode,
        provider: body.provider ?? null,
        environment: body.environment ?? null,
        publicDisplayName: body.publicDisplayName ?? null,
        makePrimary: body.makePrimary,
      });

      return reply.header('cache-control', 'no-store').status(201).send({ method });
    },
  );

  /**
   * Make a method the default, the fallback, or neither.
   *
   * Changing the default does not touch consignments already raised - the
   * method chosen for a parcel is written onto the shipment when it is chosen.
   */
  app.patch(
    '/fulfilment/methods/:methodId/role',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE) },
    async (request, reply) => {
      const params = z.object({ methodId: z.string().length(26) }).parse(request.params);
      const body = z
        .object({ role: z.enum(['PRIMARY', 'FALLBACK', 'ADDITIONAL']) })
        .parse(request.body);

      const seller = currentSeller(request);

      const method = await setMethodRole({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        methodId: params.methodId,
        role: body.role,
      });

      return reply.header('cache-control', 'no-store').status(200).send({ method });
    },
  );

  /**
   * Pause a method, restart it, or disconnect it for good.
   *
   * The seller's half of the state machine. The marketplace's half - approve,
   * refuse, ask for changes - is an admin route and goes through the same
   * assertion, for the same reason order status does.
   */
  app.patch(
    '/fulfilment/methods/:methodId/status',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE) },
    async (request, reply) => {
      const params = z.object({ methodId: z.string().length(26) }).parse(request.params);
      const body = z
        .object({
          // The three a SELLER may ask for. Approving their own method is not
          // on this list and is not reachable from here.
          status: z.enum(['PAUSED', 'APPROVED', 'DISCONNECTED']),
          reason: z.string().trim().max(512).nullable().optional(),
        })
        .parse(request.body);

      const seller = currentSeller(request);

      const method = await changeMethodStatus({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        methodId: params.methodId,
        status: body.status,
        reason: body.reason ?? null,
      });

      return reply.header('cache-control', 'no-store').status(200).send({ method });
    },
  );

  /** The rules that route a parcel, in the order they are tried. */
  app.get(
    '/fulfilment/rules',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_READ) },
    async (request, reply) => {
      const seller = currentSeller(request);
      const rules = await listFulfilmentRules(seller.sellerAccountId);

      return reply.header('cache-control', 'no-store').status(200).send({ rules });
    },
  );

  /**
   * Write a routing rule, or move the one that already exists.
   *
   * PUT rather than POST: a rule is identified by what it matches on, not by
   * an id the client chose, so saving the same rule twice is the same rule.
   * The service computes the precedence and the key from the scope, so a
   * client never has to know either.
   */
  app.put(
    '/fulfilment/rules',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          scope: z.enum(['PRODUCT', 'WAREHOUSE', 'DESTINATION', 'SELLER_DEFAULT']),
          fulfilmentMethodId: z.string().length(26),
          sellerOfferId: z.string().length(26).nullable().optional(),
          sellerLocationId: z.string().length(26).nullable().optional(),
          destinationCountry: z.string().trim().length(2).nullable().optional(),
          destinationPostalPrefix: z.string().trim().max(16).nullable().optional(),
          note: z.string().trim().max(255).nullable().optional(),
        })
        .parse(request.body);

      const seller = currentSeller(request);

      const rule = await upsertFulfilmentRule({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        scope: body.scope,
        fulfilmentMethodId: body.fulfilmentMethodId,
        sellerOfferId: body.sellerOfferId ?? null,
        sellerLocationId: body.sellerLocationId ?? null,
        destinationCountry: body.destinationCountry ?? null,
        destinationPostalPrefix: body.destinationPostalPrefix ?? null,
        note: body.note ?? null,
      });

      return reply.header('cache-control', 'no-store').status(200).send({ rule });
    },
  );

  /**
   * Retire a rule.
   *
   * Archived rather than deleted: consignments point at it, so that "why did
   * this go by DHL?" has an answer months later.
   */
  app.delete(
    '/fulfilment/rules/:ruleId',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE) },
    async (request, reply) => {
      const params = z.object({ ruleId: z.string().length(26) }).parse(request.params);
      const seller = currentSeller(request);

      await archiveFulfilmentRule({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        ruleId: params.ruleId,
      });

      return reply.status(204).send();
    },
  );

  // --- The seller's own carrier accounts -----------------------------------
  //
  // NOT the operator's. `CarrierIntegration` holds one set of credentials for
  // the whole installation; these are each seller's own account with DHL or
  // FedEx, and the distinction is a tenant boundary at the credential: a key
  // in a shared row would let one seller's consignment bill another seller's
  // account.
  //
  // NOTHING BELOW EVER RETURNS A CREDENTIAL. The list returns a state and a
  // four-character hint; there is no route that could be asked for more,
  // because there is no service function that would answer.

  /**
   * The seller's own carrier accounts (DHL, FedEx and others) connected here,
   * with the state of each. Never returns a key - only its last few characters.
   */
  app.get(
    '/fulfilment/connections',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_READ) },
    async (request, reply) => {
      const seller = currentSeller(request);
      const connections = await listCarrierConnections(seller.sellerAccountId);

      return reply.header('cache-control', 'no-store').status(200).send({ connections });
    },
  );

  /**
   * Add one of the seller's own carrier accounts, for testing or live use, with
   * its account numbers and defaults. It starts unconfigured, with no key
   * stored; refused if the seller already has that carrier for that
   * environment. Writes an audit entry.
   */
  app.post(
    '/fulfilment/connections',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          provider: z.enum(['DHL', 'FEDEX', 'UPS', 'INDIA_POST', 'CUSTOM']),
          environment: z.enum(['SANDBOX', 'PRODUCTION']).default('SANDBOX'),
          accountNumber: z.string().trim().max(64).nullable().optional(),
          billingAccountNumber: z.string().trim().max(64).nullable().optional(),
          defaultServiceCode: z.string().trim().max(48).nullable().optional(),
          labelFormat: z.string().trim().max(24).nullable().optional(),
        })
        .parse(request.body);

      const seller = currentSeller(request);

      const connection = await createCarrierConnection({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        provider: body.provider,
        environment: body.environment,
        accountNumber: body.accountNumber ?? null,
        billingAccountNumber: body.billingAccountNumber ?? null,
        defaultServiceCode: body.defaultServiceCode ?? null,
        labelFormat: body.labelFormat ?? null,
      });

      return reply.header('cache-control', 'no-store').status(201).send({ connection });
    },
  );

  /**
   * Which boxes this carrier's connection screen should show.
   *
   * Asked rather than hard-coded in the frontend, so adding a provider does
   * not mean editing two places and discovering the mismatch when a seller
   * cannot save.
   */
  app.get(
    '/fulfilment/connections/fields/:provider',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_READ) },
    async (request, reply) => {
      const params = z
        .object({ provider: z.enum(['DHL', 'FEDEX', 'UPS', 'INDIA_POST', 'CUSTOM']) })
        .parse(request.params);

      return reply
        .header('cache-control', 'no-store')
        .status(200)
        .send({ fields: credentialFieldsFor(params.provider) });
    },
  );

  /**
   * Store or rotate the key.
   *
   * `CARRIER_CREDENTIAL_WRITE`, which OWNER and ADMIN hold and nobody else -
   * choosing to ship by DHL and holding the key that bills the company's DHL
   * account are different acts.
   *
   * Storing one drops the connection back behind the test gate. A rotated key
   * that was typed wrongly must not inherit the previous key's green tick.
   */
  app.put(
    '/fulfilment/connections/:connectionId/credentials',
    {
      preHandler: requireSeller(SellerPermission.CARRIER_CREDENTIAL_WRITE),
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const params = z.object({ connectionId: z.string().length(26) }).parse(request.params);
      const body = z
        .object({ fields: z.record(z.string(), z.string().min(1).max(512)) })
        .parse(request.body);

      const seller = currentSeller(request);

      await storeCarrierCredential({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        connectionId: params.connectionId,
        fields: body.fields,
      });

      // 204. There is nothing safe to return about a credential that was just
      // stored, and returning the connection here would invite a client to
      // treat the response as confirmation the key is correct - which only a
      // test can say.
      return reply.status(204).send();
    },
  );

  /**
   * Call the carrier for real, and write down what happened.
   *
   * The only route that can lead to `lastTestPassedAt` being set, which is
   * the first of the two gates a connection passes before it carries a real
   * parcel.
   */
  app.post(
    '/fulfilment/connections/:connectionId/test',
    {
      preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE),
      // Every test is a real call to the carrier, against the seller's own
      // API quota. Ten an hour is plenty for a person fixing a typo and too
      // few to hammer DHL with somebody else's session.
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const params = z.object({ connectionId: z.string().length(26) }).parse(request.params);
      const seller = currentSeller(request);

      const result = await testCarrierConnection({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        connectionId: params.connectionId,
      });

      // 200 whether it passed or failed: the call itself succeeded, and a
      // failed carrier test is an answer the screen has a state for rather
      // than an error the client should treat as a fault.
      return reply.header('cache-control', 'no-store').status(200).send(result);
    },
  );

  /** The second gate: a person says to start shipping real parcels with it. */
  app.post(
    '/fulfilment/connections/:connectionId/activate',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE) },
    async (request, reply) => {
      const params = z.object({ connectionId: z.string().length(26) }).parse(request.params);
      const seller = currentSeller(request);

      const connection = await confirmCarrierForProduction({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        connectionId: params.connectionId,
      });

      return reply.header('cache-control', 'no-store').status(200).send({ connection });
    },
  );

  /**
   * Stop using one of the seller's carrier accounts without deleting its key,
   * or put it back into service. Resuming is refused until the connection has
   * passed a test. Writes an audit entry.
   */
  app.post(
    '/fulfilment/connections/:connectionId/pause',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE) },
    async (request, reply) => {
      const params = z.object({ connectionId: z.string().length(26) }).parse(request.params);
      const body = z.object({ resume: z.boolean().default(false) }).parse(request.body ?? {});
      const seller = currentSeller(request);

      const connection = await pauseCarrierConnection({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        connectionId: params.connectionId,
        resume: body.resume,
      });

      return reply.header('cache-control', 'no-store').status(200).send({ connection });
    },
  );

  /**
   * Disconnect, and destroy the key.
   *
   * The credential row goes rather than being blanked. The connection keeps
   * its history and its shipments; what it does not keep is anything that
   * could still authenticate.
   */
  app.delete(
    '/fulfilment/connections/:connectionId/credentials',
    { preHandler: requireSeller(SellerPermission.CARRIER_CREDENTIAL_WRITE) },
    async (request, reply) => {
      const params = z.object({ connectionId: z.string().length(26) }).parse(request.params);
      const seller = currentSeller(request);

      await destroyCarrierCredential({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        connectionId: params.connectionId,
      });

      return reply.status(204).send();
    },
  );

  /**
   * Create the seller's own delivery arm.
   *
   * Creates the organisation AND invites the person who will run it, in one
   * call - an organisation with nobody in it is one nobody can activate.
   *
   * Note what it does not do: grant this seller's team any logistics
   * permission. The named operations owner gets their own portal account, at
   * their own address, because `users.emailNormalized` is unique across all
   * three audiences and a fleet is a different body of personal data from a
   * catalogue.
   */
  app.post(
    '/fulfilment/self-managed',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          fulfilmentMethodId: z.string().length(26),
          displayName: z.string().trim().min(2).max(160),
          legalName: z.string().trim().min(2).max(255),
          registrationCountry: z.string().trim().length(2),
          registrationNumber: z.string().trim().max(64).nullable().optional(),
          taxNumber: z.string().trim().max(64).nullable().optional(),
          contactEmail: z.string().trim().email().max(320),
          contactPhone: z.string().trim().max(32).nullable().optional(),
          emergencyPhone: z.string().trim().max(32).nullable().optional(),
          addressJson: z.unknown().optional(),
          licenceNumber: z.string().trim().max(64).nullable().optional(),
          operationsOwnerEmail: z.string().trim().email().max(320),
          operationsOwnerName: z.string().trim().min(2).max(160),
        })
        .parse(request.body);

      const seller = currentSeller(request);

      const organisation = await createSelfManagedOrganisation({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        fulfilmentMethodId: body.fulfilmentMethodId,
        displayName: body.displayName,
        legalName: body.legalName,
        registrationCountry: body.registrationCountry,
        registrationNumber: body.registrationNumber ?? null,
        taxNumber: body.taxNumber ?? null,
        contactEmail: body.contactEmail,
        contactPhone: body.contactPhone ?? null,
        emergencyPhone: body.emergencyPhone ?? null,
        addressJson: body.addressJson,
        licenceNumber: body.licenceNumber ?? null,
        operationsOwnerEmail: body.operationsOwnerEmail,
        operationsOwnerName: body.operationsOwnerName,
        correlationId: request.correlationId,
      });

      return reply.header('cache-control', 'no-store').status(201).send({ organisation });
    },
  );

  /**
   * Which delivery companies could this seller ask to work for them.
   *
   * Names, coverage and approved capabilities. No contact details, no address,
   * no contract reference, and nothing about which other sellers use them - a
   * picker is a list a seller can request from, not a directory of other
   * businesses' arrangements.
   */
  app.get(
    '/fulfilment/partners/search',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_READ) },
    async (request, reply) => {
      const query = z
        .object({ q: z.string().trim().max(120).optional() })
        .parse(request.query);

      const seller = currentSeller(request);
      const partners = await searchPartnersForSeller(seller.sellerAccountId, query.q ?? '');

      return reply.header('cache-control', 'no-store').status(200).send({ partners });
    },
  );

  /** Ask a delivery company that is already here to work for this seller. */
  app.post(
    '/fulfilment/partners/request',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          fulfilmentMethodId: z.string().length(26),
          logisticsPartnerId: z.string().length(26),
        })
        .parse(request.body);

      const seller = currentSeller(request);

      const result = await requestExistingPartner({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        fulfilmentMethodId: body.fulfilmentMethodId,
        logisticsPartnerId: body.logisticsPartnerId,
      });

      return reply.header('cache-control', 'no-store').status(201).send(result);
    },
  );

  /**
   * Invite a delivery company that is not here yet.
   *
   * The response carries no token. It is generated, hashed into the row and
   * handed to the mail job; a seller who could read it could redeem it and
   * become the courier, which is the one thing this flow exists to prevent.
   */
  app.post(
    '/fulfilment/partners/invite',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          fulfilmentMethodId: z.string().length(26),
          proposedLegalName: z.string().trim().min(2).max(255),
          proposedDisplayName: z.string().trim().min(2).max(160),
          businessEmail: z.string().trim().email().max(320),
          businessPhone: z.string().trim().max(32).nullable().optional(),
          registrationNumber: z.string().trim().max(64).nullable().optional(),
          countryCode: z.string().trim().length(2),
          addressJson: z.unknown().optional(),
          primaryContactName: z.string().trim().max(160).nullable().optional(),
          expectedServiceCountries: z.array(z.string().trim().length(2)).max(60).optional(),
          requiredCapabilities: z.array(z.string().trim().max(48)).max(40).optional(),
          relationshipDescription: z.string().trim().max(2000).nullable().optional(),
        })
        .parse(request.body);

      const seller = currentSeller(request);

      const invitation = await inviteDedicatedPartner({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        fulfilmentMethodId: body.fulfilmentMethodId,
        proposedLegalName: body.proposedLegalName,
        proposedDisplayName: body.proposedDisplayName,
        businessEmail: body.businessEmail,
        businessPhone: body.businessPhone ?? null,
        registrationNumber: body.registrationNumber ?? null,
        countryCode: body.countryCode,
        addressJson: body.addressJson,
        primaryContactName: body.primaryContactName ?? null,
        expectedServiceCountries: body.expectedServiceCountries ?? null,
        requiredCapabilities: body.requiredCapabilities ?? null,
        relationshipDescription: body.relationshipDescription ?? null,
      });

      /*
       * `rawToken` is deliberately destructured away and dropped.
       *
       * The mail job is what carries it to the invited company. It is not in
       * this response, it is not logged, and the only stored form is its
       * SHA-256.
       */
      const { rawToken: _rawToken, ...safe } = invitation;

      return reply.header('cache-control', 'no-store').status(201).send({ invitation: safe });
    },
  );

  /** Withdraw an invitation nobody has taken up. */
  app.delete(
    '/fulfilment/partners/invitations/:invitationId',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE) },
    async (request, reply) => {
      const params = z.object({ invitationId: z.string().length(26) }).parse(request.params);
      const seller = currentSeller(request);

      await revokePartnerInvitation({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        invitationId: params.invitationId,
      });

      return reply.status(204).send();
    },
  );

  /**
   * How an arrangement reached the state it is in.
   *
   * Carries a label for whoever moved it and never an actor id. Which named
   * individual at the marketplace refused a request is the marketplace's
   * business; the seller learns that it was refused, when, and why.
   */
  app.get(
    '/fulfilment/arrangements/:linkId/history',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_READ) },
    async (request, reply) => {
      const params = z.object({ linkId: z.string().length(26) }).parse(request.params);
      const seller = currentSeller(request);

      const history = await readRelationshipHistory(seller.sellerAccountId, params.linkId);

      return reply.header('cache-control', 'no-store').status(200).send({ history });
    },
  );

  // --- Configuring an operation the seller runs themselves ----------------
  //
  // Four things a self-managed method needs before it is more than a name:
  // where it collects from, where it delivers to, what it may carry, and what
  // it charges.
  //
  // NONE OF THESE TAKES AN ORGANISATION ID. Every one resolves the delivery
  // company from the seller's own method, so there is no shape of request that
  // could point at another company's coverage or prices - including the
  // dedicated courier this seller contracts with, which sets its own coverage
  // in its own portal.

  /**
   * The collection set-up for each of the seller's buildings under one of their
   * delivery methods: days, time window, cut-off, contact and limits.
   */
  app.get(
    '/fulfilment/methods/:methodId/pickup-profiles',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_READ) },
    async (request, reply) => {
      const params = z.object({ methodId: z.string().length(26) }).parse(request.params);
      const seller = currentSeller(request);

      const profiles = await listPickupProfiles(seller.sellerAccountId, params.methodId);

      return reply.header('cache-control', 'no-store').status(200).send({ profiles });
    },
  );

  /**
   * How goods leave one building under one method.
   *
   * An upsert rather than a create/update pair: there is at most one profile
   * per method per building, and a seller saving the same screen twice has
   * changed their mind, not created a second arrangement.
   */
  app.put(
    '/fulfilment/methods/:methodId/pickup-profiles',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE) },
    async (request, reply) => {
      const params = z.object({ methodId: z.string().length(26) }).parse(request.params);
      const body = z
        .object({
          sellerLocationId: z.string().length(26),
          // Monday = 1. 31 is Mon-Fri, 127 every day; nothing outside a
          // seven-bit mask means anything.
          pickupDaysMask: z.number().int().min(0).max(127).optional(),
          windowStart: clockTime.nullable().optional(),
          windowEnd: clockTime.nullable().optional(),
          cutoffOverride: clockTime.nullable().optional(),
          handlingTimeDaysOverride: z.number().int().min(0).max(90).nullable().optional(),
          maxDailyShipments: z.number().int().min(1).max(100000).nullable().optional(),
          contactName: z.string().trim().max(160).nullable().optional(),
          contactPhone: z.string().trim().max(32).nullable().optional(),
          instructions: z.string().trim().max(2000).nullable().optional(),
          maxPackageWeightGrams: z.number().int().min(1).max(50000000).nullable().optional(),
        })
        .parse(request.body);

      const seller = currentSeller(request);

      const profile = await savePickupProfile({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        fulfilmentMethodId: params.methodId,
        ...body,
      });

      return reply.header('cache-control', 'no-store').status(200).send({ profile });
    },
  );

  /**
   * The countries and regions a delivery method covers or excludes, with
   * delivery days, transit times and any remote-area surcharge.
   */
  app.get(
    '/fulfilment/methods/:methodId/service-areas',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_READ) },
    async (request, reply) => {
      const params = z.object({ methodId: z.string().length(26) }).parse(request.params);
      const seller = currentSeller(request);

      const areas = await listServiceAreas(seller.sellerAccountId, params.methodId);

      return reply.header('cache-control', 'no-store').status(200).send({ areas });
    },
  );

  /**
   * Add or update a country or region that a delivery method the seller runs
   * themselves covers - or excludes, since an exclusion beats any overlapping
   * area. Writes an audit entry.
   */
  app.put(
    '/fulfilment/methods/:methodId/service-areas',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE) },
    async (request, reply) => {
      const params = z.object({ methodId: z.string().length(26) }).parse(request.params);
      const body = z
        .object({
          // Straight off the generated enum. A hand-typed list here drifts
          // the moment a scope is added, and drifts silently.
          scope: z.enum(LogisticsRegionScope),
          countryCode: z.string().trim().length(2),
          regionValue: z.string().trim().max(120).nullable().optional(),
          isExclusion: z.boolean().optional(),
          supportsPickup: z.boolean().optional(),
          supportsDelivery: z.boolean().optional(),
          deliveryDaysMask: z.number().int().min(0).max(127).optional(),
          transitDaysMin: z.number().int().min(0).max(365).nullable().optional(),
          transitDaysMax: z.number().int().min(0).max(365).nullable().optional(),
          // Minor units as a string, like every other money field on this API.
          remoteAreaSurchargeMinor: minorUnits.nullable().optional(),
          maxShipmentWeightGrams: z.number().int().min(1).max(50000000).nullable().optional(),
        })
        .parse(request.body);

      const seller = currentSeller(request);

      const area = await saveServiceArea({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        fulfilmentMethodId: params.methodId,
        ...body,
        remoteAreaSurchargeMinor:
          body.remoteAreaSurchargeMinor === null || body.remoteAreaSurchargeMinor === undefined
            ? null
            : BigInt(body.remoteAreaSurchargeMinor),
      });

      return reply.header('cache-control', 'no-store').status(200).send({ area });
    },
  );

  /**
   * Remove a country or region from a delivery method the seller runs
   * themselves. Writes an audit entry.
   */
  app.delete(
    '/fulfilment/methods/:methodId/service-areas/:areaId',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE) },
    async (request, reply) => {
      const params = z
        .object({ methodId: z.string().length(26), areaId: z.string().length(26) })
        .parse(request.params);

      const seller = currentSeller(request);

      await removeServiceArea({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        fulfilmentMethodId: params.methodId,
        areaId: params.areaId,
      });

      return reply.header('cache-control', 'no-store').status(204).send();
    },
  );

  /**
   * What a delivery method has asked to be allowed to carry (for example
   * chilled goods), and whether the marketplace approved each request.
   */
  app.get(
    '/fulfilment/methods/:methodId/capabilities',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_READ) },
    async (request, reply) => {
      const params = z.object({ methodId: z.string().length(26) }).parse(request.params);
      const seller = currentSeller(request);

      const capabilities = await listCapabilities(seller.sellerAccountId, params.methodId);

      return reply.header('cache-control', 'no-store').status(200).send({ capabilities });
    },
  );

  /**
   * Ask to be allowed to carry something.
   *
   * REQUEST, not grant. There is no parameter on this route that would let a
   * seller approve their own capability, because the approval is the whole
   * difference between "our vans have a fridge" and "somebody checked", and
   * only an approved capability is matched against a consignment that needs it.
   */
  app.post(
    '/fulfilment/methods/:methodId/capabilities',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE) },
    async (request, reply) => {
      const params = z.object({ methodId: z.string().length(26) }).parse(request.params);
      const body = z
        .object({
          kind: z.enum(LogisticsCapabilityKind),
          evidenceReference: z.string().trim().max(255).nullable().optional(),
          evidenceExpiresAt: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD.')
            .nullable()
            .optional(),
        })
        .parse(request.body);

      const seller = currentSeller(request);

      const capability = await requestCapability({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        fulfilmentMethodId: params.methodId,
        kind: body.kind,
        evidenceReference: body.evidenceReference ?? null,
        evidenceExpiresAt:
          body.evidenceExpiresAt === null || body.evidenceExpiresAt === undefined
            ? null
            : new Date(`${body.evidenceExpiresAt}T00:00:00.000Z`),
      });

      return reply.header('cache-control', 'no-store').status(201).send({ capability });
    },
  );

  /**
   * Every price list published for one of the seller's delivery methods, with
   * all its versions and price bands.
   */
  app.get(
    '/fulfilment/methods/:methodId/rate-cards',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_READ) },
    async (request, reply) => {
      const params = z.object({ methodId: z.string().length(26) }).parse(request.params);
      const seller = currentSeller(request);

      const rateCards = await listRateCards(seller.sellerAccountId, params.methodId);

      return reply.header('cache-control', 'no-store').status(200).send({ rateCards });
    },
  );

  /**
   * Publish what this operation charges.
   *
   * There is no route that EDITS a published card, deliberately. Publishing
   * again makes version 2 and leaves version 1 on the record, because a quote
   * points at the version it was priced from and a customer disputing a
   * delivery charge six weeks later has to be shown the card as it stood on
   * the day.
   */
  app.post(
    '/fulfilment/methods/:methodId/rate-cards',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE) },
    async (request, reply) => {
      const params = z.object({ methodId: z.string().length(26) }).parse(request.params);
      const body = z
        .object({
          name: z.string().trim().min(1).max(120),
          currency: z.string().trim().length(3),
          minimumChargeMinor: minorUnits.nullable().optional(),
          freeShippingThresholdMinor: minorUnits.nullable().optional(),
          taxInclusive: z.boolean().optional(),
          bands: z
            .array(
              z.object({
                basis: z.enum(['FLAT', 'WEIGHT', 'DISTANCE', 'POSTAL_ZONE', 'PACKAGE_SIZE']),
                serviceType: z
                  .enum(['STANDARD', 'EXPRESS', 'SAME_DAY', 'ECONOMY', 'FREIGHT', 'WHITE_GLOVE'])
                  .optional(),
                minValue: z.number().int().min(0).optional(),
                maxValue: z.number().int().min(0).nullable().optional(),
                postalPrefix: z.string().trim().max(16).optional(),
                amountMinor: minorUnits,
                perUnitMinor: minorUnits.nullable().optional(),
              }),
            )
            .min(1)
            .max(200),
        })
        .parse(request.body);

      const seller = currentSeller(request);

      const rateCard = await publishRateCard({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        fulfilmentMethodId: params.methodId,
        name: body.name,
        currency: body.currency,
        minimumChargeMinor:
          body.minimumChargeMinor === null || body.minimumChargeMinor === undefined
            ? null
            : BigInt(body.minimumChargeMinor),
        freeShippingThresholdMinor:
          body.freeShippingThresholdMinor === null ||
          body.freeShippingThresholdMinor === undefined
            ? null
            : BigInt(body.freeShippingThresholdMinor),
        ...(body.taxInclusive === undefined ? {} : { taxInclusive: body.taxInclusive }),
        bands: body.bands,
      });

      return reply.header('cache-control', 'no-store').status(201).send({ rateCard });
    },
  );

  // --- The team -----------------------------------------------------------

  /** The seller's current team members, with each one's name, email, role and joining date. */
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

  /**
   * Change a team member's role. Refused if it would leave the business with no
   * owner, or would grant a role the person making the change does not hold.
   * Writes an audit entry.
   */
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

  /**
   * Remove someone from the seller's team. Their past actions still show their
   * name, and removing the last owner is refused. Writes an audit entry.
   */
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

  /**
   * The seller's own activity log, newest first: who did what, to what, and
   * when. Shows a short summary of each change, not the full before-and-after.
   */
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
