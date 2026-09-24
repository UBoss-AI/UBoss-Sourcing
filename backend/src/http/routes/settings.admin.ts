/**
 * Settings, staff and fulfilment — admin routes.
 *
 * Three modules share this file because each is a thin HTTP surface over a
 * service that already holds the rules. Splitting them would spread twenty
 * lines of routing across three files.
 *
 * `settings.write` gates the configuration that changes how money is
 * calculated; `staff.write` and `role.assign` gate access changes; fulfilment
 * sits behind `order.fulfil` and `order.return`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Permission, type PermissionKey } from '../../domain/permissions.js';
import { prisma } from '../../infra/prisma.js';
import {
  assignableRoles,
  createStaff,
  listStaff,
  reissueTemporaryPassword,
  setStaffRoles,
  setStaffStatus,
} from '../../modules/identity/staff.service.js';
import {
  createReturnRequest,
  createShipment,
  inspectReturn,
  rejectReturn,
  shippableLines,
  updateShipmentStatus,
} from '../../modules/fulfilment/fulfilment.service.js';
import {
  createShippingMethod,
  createTaxClass,
  flagDisableImpact,
  getBusinessProfile,
  listFeatureFlags,
  listNotificationSettings,
  listShippingMethods,
  listTaxClasses,
  setFeatureFlag,
  updateBusinessProfile,
  updatePolicyLinks,
  updateShippingMethod,
  updateTaxClass,
  upsertNotificationSetting,
} from '../../modules/settings/settings.service.js';
import {
  getFxRateSettings,
  refreshNow,
  updateFxRateSettings,
} from '../../modules/settings/fx-rate.service.js';
import { fxHealth, listRateSnapshots } from '../../modules/settings/fx-snapshot.service.js';
import { AuditAction, recordAudit } from '../../modules/audit/audit.service.js';
import {
  catalogueTranslationCoverage,
  clearCatalogTranslationKey,
  getCatalogTranslationSettings,
  setCatalogTranslationKey,
  translateCatalogue,
} from '../../modules/catalog/catalog-translation.service.js';
import { processorReport } from '../../modules/settings/processors.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });
const minorUnits = z.string().regex(/^\d+$/, 'Expected whole minor units.');

/**
 * The exchange-rate panel's settings.
 *
 * Percentages arrive as decimal strings and stay strings: they end up in
 * bigint arithmetic against catalogue prices, and a JSON number would already
 * have lost precision by the time it got here.
 */
const exchangeRateSettingsBody = z.object({
  isEnabled: z.boolean().optional(),
  marginPercent: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Enter a percentage, e.g. 2.50.')
    .optional(),
  rounding: z.enum(['exact', 'whole', 'charm']).optional(),
  maxDriftPercent: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Enter a percentage, e.g. 15.00.')
    .optional(),

  /**
   * Which feed. Validated against the closed list in the service as well as
   * here - the provider decides where this server makes an outbound request
   * to, so it is never free text at any layer.
   */
  provider: z.string().min(1).max(32).optional(),

  deriveMissingPrices: z.boolean().optional(),

  /**
   * The freshness windows.
   *
   * The lower bounds are not decoration. A display window under a day would
   * blank the catalogue every night, and a checkout window under a day would
   * refuse every sale each weekend - both of which look like an outage and
   * neither of which is one. The service additionally refuses a set that is
   * out of order, which the ranges here cannot express.
   */
  displayMaxAgeHours: z.number().int().min(24).max(8760).optional(),
  checkoutMaxAgeHours: z.number().int().min(24).max(8760).optional(),
  alertMaxAgeHours: z.number().int().min(1).max(8760).optional(),
  quoteTtlSeconds: z.number().int().min(60).max(86_400).optional(),
});

function actorFrom(request: FastifyRequest): {
  userId: string;
  email: string;
  ipAddress: string;
  correlationId: string;
} {
  const auth = currentUser(request);
  return {
    userId: auth.id,
    email: auth.email,
    ipAddress: request.ip,
    correlationId: request.correlationId,
  };
}

function staffActorFrom(request: FastifyRequest): {
  userId: string;
  email: string;
  permissions: readonly PermissionKey[];
  ipAddress: string;
  correlationId: string;
} {
  const auth = currentUser(request);
  return {
    userId: auth.id,
    email: auth.email,
    // The authority check in the service is driven by these.
    permissions: auth.permissions,
    ipAddress: request.ip,
    correlationId: request.correlationId,
  };
}

export function registerAdminSettingsRoutes(app: FastifyInstance): Promise<void> {
  // --- Business profile ----------------------------------------------------

  /**
   * The store's business profile: its names, contacts, tax numbers, currency
   * and other store-wide settings.
   */
  app.get(
    '/settings/business',
    { preHandler: requireAdmin(Permission.SETTINGS_READ) },
    async (_request, reply) =>
      reply.status(200).send({ business: await getBusinessProfile() }),
  );

  /**
   * Change the business profile: names, support contacts, tax numbers, the
   * standard seller commission, logo, address, currency, time zone and
   * invoice and order number prefixes. The currency cannot change once any
   * order exists. Writes an audit entry.
   *
   * Setting `vatCountry` switches EU VAT on for the whole deployment.
   */
  app.patch(
    '/settings/business',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          legalName: z.string().trim().min(1).max(255).optional(),
          displayName: z.string().trim().min(1).max(255).optional(),
          supportEmail: z.string().trim().max(320).email().optional(),
          supportPhone: z.string().max(32).nullable().optional(),
          gstin: z.string().max(32).nullable().optional(),
          vatNumber: z.string().trim().max(32).nullable().optional(),
          // Setting this switches EU VAT resolution on for the whole
          // deployment. See ModelBusinessProfile.vatCountry.
          vatCountry: z.string().trim().length(2).nullable().optional(),
          // Turning this on refuses to publish a product that does not carry
          // what GPSR Art. 19 requires. See docs/PRODUCT-SAFETY.md.
          gpsrEnforced: z.boolean().optional(),
          // Basis points: 250 is 2.50%. The platform rate every seller without
          // one of their own is settled against.
          sellerCommissionBasisPoints: z.number().int().min(0).max(10_000).optional(),
          logoMediaId: z.string().length(26).nullable().optional(),
          addressJson: z.record(z.string(), z.unknown()).nullable().optional(),
          currency: z.string().length(3).optional(),
          timezone: z.string().max(64).optional(),
          invoicePrefix: z.string().trim().max(16).optional(),
          orderPrefix: z.string().trim().max(16).optional(),
        })
        .parse(request.body);

      await updateBusinessProfile(body, actorFrom(request));
      return reply.status(200).send({ updated: true });
    },
  );

  /**
   * Replace the policy links shown in the storefront footer (terms, privacy
   * and so on). Every link must start with http:// or https://; empty ones are
   * dropped. Writes an audit entry.
   */
  app.patch(
    '/settings/policy-links',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE) },
    async (request, reply) => {
      const body = z.record(z.string().max(64), z.string().max(1024)).parse(request.body);
      await updatePolicyLinks(body, actorFrom(request));
      return reply.status(200).send({ updated: true });
    },
  );

  // --- Tax ------------------------------------------------------------------

  /** List the tax classes, the default first, with each one's rate. */
  app.get(
    '/settings/tax-classes',
    { preHandler: requireAdmin(Permission.SETTINGS_READ) },
    async (_request, reply) => reply.status(200).send({ taxClasses: await listTaxClasses() }),
  );

  /**
   * Who this deployment actually shares data with.
   *
   * Derived from the environment rather than from a list somebody maintains,
   * because a maintained list is a claim about configuration kept where
   * configuration cannot reach it. Put this beside your Art. 30 register; the
   * gaps are the point.
   */
  app.get(
    '/settings/processors',
    { preHandler: requireAdmin(Permission.SETTINGS_READ) },
    (_request, reply) => reply.status(200).send(processorReport()),
  );

  const taxClassBody = z.object({
    code: z.string().trim().min(1).max(32),
    name: z.string().trim().min(1).max(128),
    // A decimal string, not a number: a float tax rate is how rounding drift
    // starts.
    ratePercent: z.string().regex(/^\d+(\.\d+)?$/, 'Enter a rate like "18" or "18.5".'),
    // Which EU rate band this class is. Null keeps the flat rate above, which
    // is the right answer for GST and for any deployment not selling into the
    // EU. Set it and the rate becomes a per-member-state lookup.
    vatCategory: z
      .enum(['STANDARD', 'REDUCED', 'SUPER_REDUCED', 'ZERO', 'EXEMPT'])
      .nullable()
      .optional(),
    isInclusive: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    isActive: z.boolean().optional(),
  });

  /**
   * Add a tax class with its rate and, optionally, its EU VAT band. Making it
   * the default takes that from the previous default. Writes an audit entry.
   */
  app.post(
    '/settings/tax-classes',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE) },
    async (request, reply) => {
      const created = await createTaxClass(taxClassBody.parse(request.body), actorFrom(request));
      return reply.status(201).send(created);
    },
  );

  /**
   * Change a tax class. Refused if it would switch off a class products still
   * use, or leave the store without a default. Writes an audit entry.
   */
  app.patch(
    '/settings/tax-classes/:id',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      await updateTaxClass(id, taxClassBody.partial().parse(request.body), actorFrom(request));
      return reply.status(200).send({ updated: true });
    },
  );

  // --- Shipping -------------------------------------------------------------

  /** List the store's delivery methods and their prices. */
  app.get(
    '/settings/shipping-methods',
    { preHandler: requireAdmin(Permission.SETTINGS_READ) },
    async (_request, reply) =>
      reply.status(200).send({ shippingMethods: await listShippingMethods() }),
  );

  const shippingBody = z.object({
    code: z.string().trim().min(1).max(32),
    name: z.string().trim().min(1).max(128),
    description: z.string().max(512).nullable().optional(),
    priceMinor: minorUnits,
    freeAboveMinor: minorUnits.nullable().optional(),
    estimatedDaysMin: z.number().int().min(0).max(365).nullable().optional(),
    estimatedDaysMax: z.number().int().min(0).max(365).nullable().optional(),
    regionsJson: z.record(z.string(), z.unknown()).nullable().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  });

  /**
   * Add a delivery method with its price, free-delivery threshold, delivery
   * time estimate and regions. Refused if the code is already used. Writes an
   * audit entry.
   */
  app.post(
    '/settings/shipping-methods',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE) },
    async (request, reply) => {
      const created = await createShippingMethod(shippingBody.parse(request.body), actorFrom(request));
      return reply.status(201).send(created);
    },
  );

  /**
   * Change a delivery method. Switching one off reports how many active or
   * paused recurring schedules use it, so staff can be warned. Writes an
   * audit entry.
   */
  app.patch(
    '/settings/shipping-methods/:id',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);

      // `affectedSchedules` is returned so the UI can warn about recurring
      // schedules that pin this method before the change lands.
      const result = await updateShippingMethod(
        id,
        shippingBody.partial().parse(request.body),
        actorFrom(request),
      );

      return reply.status(200).send({ updated: true, ...result });
    },
  );

  // --- Notifications --------------------------------------------------------

  /**
   * List the notifications staff have customised, with their templates,
   * recipients and whether each is switched on. Events not listed use the
   * built-in wording.
   */
  app.get(
    '/settings/notifications',
    { preHandler: requireAdmin(Permission.SETTINGS_READ) },
    async (_request, reply) =>
      reply.status(200).send({ notifications: await listNotificationSettings() }),
  );

  /**
   * Customise one notification: its email subject and body, the staff
   * addresses that receive internal alerts, and whether it is sent. Writes an
   * audit entry.
   */
  app.put(
    '/settings/notifications',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          eventKey: z.string().trim().min(1).max(96),
          name: z.string().trim().max(128).optional(),
          subjectTemplate: z.string().max(255).optional(),
          bodyTemplate: z.string().max(20_000).optional(),
          // Without recipients, low-stock and payment-failure alerts are
          // logged and dropped. The UI should surface that.
          internalRecipients: z.array(z.string().email()).max(20).optional(),
          emailEnabled: z.boolean().optional(),
          isActive: z.boolean().optional(),
        })
        .parse(request.body);

      const result = await upsertNotificationSetting(body, actorFrom(request));
      return reply.status(200).send(result);
    },
  );

  // --- Feature flags --------------------------------------------------------

  /** List the store's feature switches and whether each is on. */
  app.get(
    '/settings/feature-flags',
    { preHandler: requireAdmin(Permission.SETTINGS_READ) },
    async (_request, reply) => reply.status(200).send({ flags: await listFeatureFlags() }),
  );

  /**
   * What would break if this flag were turned off.
   *
   * SOP §10 requires showing dependency impact before disabling payment,
   * shipping or recurring features. The UI calls this before its confirm
   * dialog, not after.
   */
  app.get(
    '/settings/feature-flags/:key/impact',
    { preHandler: requireAdmin(Permission.SETTINGS_READ) },
    async (request, reply) => {
      const { key } = z.object({ key: z.string().max(96) }).parse(request.params);
      return reply.status(200).send({ impact: await flagDisableImpact(key) });
    },
  );

  /**
   * Switch one feature on or off for the whole store. Writes an audit entry.
   */
  app.patch(
    '/settings/feature-flags/:key',
    { preHandler: requireAdmin(Permission.FEATURE_FLAG_WRITE) },
    async (request, reply) => {
      const { key } = z.object({ key: z.string().max(96) }).parse(request.params);
      const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);

      await setFeatureFlag(key, enabled, actorFrom(request));
      return reply.status(200).send({ key, enabled });
    },
  );

  // --- Exchange rates -------------------------------------------------------

  /**
   * Automatic refresh of rate-maintained prices.
   *
   * Read behind `settings.read` and written behind `settings.write`, like every
   * other setting that changes how money is calculated. The screen also reads
   * the last run's outcome from here: a scheduled job that quietly stopped
   * working is worse than one that never ran, so its status is on the same
   * panel as its switch.
   */
  app.get(
    '/settings/exchange-rates',
    { preHandler: requireAdmin(Permission.SETTINGS_READ) },
    async (_request, reply) =>
      reply.status(200).send({
        settings: await getFxRateSettings(),
        // Sent with the settings rather than from a second endpoint, because
        // the switch and the state of the thing it switches belong on one
        // screen. A scheduled job that quietly stopped working is worse than
        // one that never ran, and the panel should say so without a refresh.
        health: await fxHealth(),
      }),
  );

  /**
   * What the feed has actually been doing.
   *
   * The audit trail the previous design had nowhere to put: every fetch, the
   * ones that were refused and why, and how far each one moved the market it
   * quotes. Read-only and behind `settings.read` - it contains no credential
   * and no response body, only what was published and what was made of it.
   */
  app.get(
    '/settings/exchange-rates/snapshots',
    { preHandler: requireAdmin(Permission.SETTINGS_READ) },
    async (request, reply) => {
      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
        .parse(request.query);

      return reply.status(200).send({ snapshots: await listRateSnapshots(query.limit) });
    },
  );

  /**
   * Change the automatic exchange-rate settings: on or off, the rate feed,
   * the margin added, price rounding, how far a rate may jump, and how old a
   * rate may be before it stops being used. Writes an audit entry.
   */
  app.put(
    '/settings/exchange-rates',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE) },
    async (request, reply) => {
      const body = exchangeRateSettingsBody.parse(request.body);
      const actor = actorFrom(request);

      const settings = await updateFxRateSettings(body, actor.userId);

      await recordAudit({
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        ipAddress: actor.ipAddress,
        correlationId: actor.correlationId,
        action: AuditAction.SETTINGS_UPDATED,
        resourceType: 'exchange_rates',
        after: { ...body },
      });

      return reply.status(200).send({ settings });
    },
  );

  /**
   * Run the refresh now.
   *
   * The same work the scheduler does, so this is a real rehearsal of tonight's
   * run rather than a second code path that resembles it. `settings.write`
   * because it rewrites catalogue prices.
   */
  app.post(
    '/settings/exchange-rates/refresh',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE) },
    async (request, reply) => {
      const actor = actorFrom(request);
      const result = await refreshNow(actor.userId);

      await recordAudit({
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        ipAddress: actor.ipAddress,
        correlationId: actor.correlationId,
        action: AuditAction.PRODUCT_PRICES_BULK_SET,
        resourceType: 'exchange_rates',
        after: {
          trigger: 'manual',
          status: result.status,
          updated: result.updated,
          currencies: result.currencies.map((row) => ({
            currency: row.currency,
            rate: row.rate,
            updated: row.updated,
            error: row.error,
          })),
        },
      });

      return reply
        .status(200)
        .send({ result, settings: await getFxRateSettings() });
    },
  );

  // --- Catalogue translation ------------------------------------------------

  /**
   * Machine-translating the shop's own product copy.
   *
   * The key is write-only over HTTP: it goes in, and only its last four
   * characters ever come back. `settings.write` to change it, `settings.read`
   * to see whether one is stored and how the last run went.
   */
  app.get(
    '/settings/catalogue-translation',
    { preHandler: requireAdmin(Permission.SETTINGS_READ) },
    async (_request, reply) =>
      reply.status(200).send({
        settings: await getCatalogTranslationSettings(),
        coverage: await catalogueTranslationCoverage(),
      }),
  );

  /**
   * Store or remove the API key used to machine-translate product copy. The
   * key is kept encrypted and only its last four characters are ever shown.
   * Writes an audit entry, without the key.
   */
  app.put(
    '/settings/catalogue-translation',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE) },
    async (request, reply) => {
      const body = z.object({ apiKey: z.string().max(200).nullable() }).parse(request.body);
      const actor = actorFrom(request);

      const settings =
        body.apiKey === null
          ? await clearCatalogTranslationKey(actor.userId)
          : await setCatalogTranslationKey(body.apiKey, actor.userId);

      await recordAudit({
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        ipAddress: actor.ipAddress,
        correlationId: actor.correlationId,
        action: AuditAction.SETTINGS_UPDATED,
        resourceType: 'catalogue_translation',
        // The key itself is never audited. Whether one exists, and which one by
        // its last four, is what an investigation actually needs.
        after: { hasApiKey: settings.hasApiKey, apiKeyHint: settings.apiKeyHint },
      });

      return reply.status(200).send({ settings });
    },
  );

  /**
   * Translate everything that has no copy in a language yet.
   *
   * `dryRun` reports what it would cost in provider characters without sending
   * anything, because a translation budget is consumed per character and staff
   * should be able to see the bill before agreeing to it.
   */
  app.post(
    '/settings/catalogue-translation/run',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          overwrite: z.boolean().default(false),
          dryRun: z.boolean().default(true),
        })
        .parse(request.body);

      const actor = actorFrom(request);
      const result = await translateCatalogue(body, actor.userId);

      if (!body.dryRun) {
        await recordAudit({
          actorType: 'ADMIN',
          actorUserId: actor.userId,
          actorEmail: actor.email,
          ipAddress: actor.ipAddress,
          correlationId: actor.correlationId,
          action: AuditAction.SETTINGS_UPDATED,
          resourceType: 'catalogue_translation',
          after: {
            status: result.status,
            translated: result.translated,
            characters: result.characters,
            overwrite: body.overwrite,
          },
        });
      }

      return reply.status(200).send({
        result,
        settings: await getCatalogTranslationSettings(),
        coverage: await catalogueTranslationCoverage(),
      });
    },
  );

  // --- Staff ----------------------------------------------------------------

  /**
   * List every staff account with its status, roles, the permissions those
   * roles add up to, and whether it is still waiting for its first sign-in.
   */
  app.get(
    '/staff',
    { preHandler: requireAdmin(Permission.STAFF_READ) },
    async (_request, reply) => reply.status(200).send({ staff: await listStaff() }),
  );

  /**
   * The roles this administrator may assign.
   *
   * Returned so the UI offers only what the API will accept - listing Business
   * Owner to an Order Manager is a dead end and an invitation to try.
   */
  app.get(
    '/staff/assignable-roles',
    { preHandler: requireAdmin(Permission.STAFF_READ) },
    async (request, reply) =>
      reply.status(200).send({ roles: await assignableRoles(staffActorFrom(request)) }),
  );

  app.post(
    '/staff',
    {
      preHandler: requireAdmin(Permission.STAFF_WRITE, Permission.ROLE_ASSIGN),
      config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      // No password field, deliberately. The system generates the temporary one
      // and emails it; an administrator never chooses another person's password
      // and never learns it.
      const body = z
        .object({
          email: z.string().trim().max(320).email(),
          roleKeys: z.array(z.string().max(64)).min(1).max(6),
        })
        .parse(request.body);

      const created = await createStaff(body, staffActorFrom(request));

      return reply.status(201).send({
        userId: created.userId,
        temporaryPasswordSent: true,
        temporaryPasswordExpiresAt: created.temporaryPasswordExpiresAt.toISOString(),
      });
    },
  );

  /**
   * Issue a fresh temporary password.
   *
   * For the account that never got in - mail in a spam folder, or the 72 hours
   * lapsed. Refused once the holder has a password of their own; from then on
   * the way back in is the reset they start themselves.
   */
  app.post(
    '/staff/:id/temporary-password',
    {
      preHandler: requireAdmin(Permission.STAFF_WRITE, Permission.ROLE_ASSIGN),
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().length(26) }).parse(request.params);

      const result = await reissueTemporaryPassword(id, staffActorFrom(request));

      return reply.status(200).send({
        temporaryPasswordSent: true,
        temporaryPasswordExpiresAt: result.temporaryPasswordExpiresAt.toISOString(),
      });
    },
  );

  /**
   * Replace a staff member's roles. Only roles within your own authority can
   * be added or removed, and the last Business Owner cannot drop that role.
   * Removing access signs the person out. Writes an audit entry.
   */
  app.patch(
    '/staff/:id/roles',
    { preHandler: requireAdmin(Permission.ROLE_ASSIGN) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { roleKeys } = z
        .object({ roleKeys: z.array(z.string().max(64)).min(1).max(6) })
        .parse(request.body);

      const result = await setStaffRoles(id, roleKeys, staffActorFrom(request));
      return reply.status(200).send({ updated: true, ...result });
    },
  );

  /**
   * Deactivate a staff account, signing it out everywhere, or reactivate it.
   * Refused for your own account, for someone with more access than you, and
   * for the last active Business Owner. Writes an audit entry.
   */
  app.patch(
    '/staff/:id/status',
    { preHandler: requireAdmin(Permission.STAFF_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({ active: z.boolean(), reason: z.string().max(512).optional() })
        .parse(request.body);

      const result = await setStaffStatus(id, body.active, staffActorFrom(request), body.reason);
      return reply.status(200).send({ active: body.active, ...result });
    },
  );

  // --- Fulfilment -----------------------------------------------------------

  /** What is left to ship on each line, accounting for partial shipments. */
  app.get(
    '/orders/:id/shippable',
    { preHandler: requireAdmin(Permission.ORDER_FULFIL) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.status(200).send({ lines: await shippableLines(id) });
    },
  );

  /**
   * Record a shipment of some or all of a confirmed order's items, with the
   * carrier and tracking details. The order moves to processing, and to
   * shipped once everything has gone (unless told not to). Writes an audit
   * entry.
   */
  app.post(
    '/orders/:id/shipments',
    { preHandler: requireAdmin(Permission.ORDER_FULFIL) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          carrier: z.string().trim().min(1).max(128),
          trackingNumber: z.string().max(128).nullable().optional(),
          trackingUrl: z.string().url().max(1024).nullable().optional(),
          items: z
            .array(
              z.object({
                orderItemId: z.string().length(26),
                quantity: z.number().int().min(1).max(1_000_000),
              }),
            )
            .min(1)
            .max(200),
          notes: z.string().max(512).nullable().optional(),
          markShipped: z.boolean().optional(),
        })
        .parse(request.body);

      const auth = currentUser(request);

      const result = await createShipment(
        { orderId: id, ...body },
        {
          userId: auth.id,
          email: auth.email,
          permissions: auth.permissions,
          ipAddress: request.ip,
          correlationId: request.correlationId,
        },
      );

      return reply.status(201).send(result);
    },
  );

  /**
   * Update where a shipment is: in transit, delivered, failed or returned to
   * the sender. When the last outstanding shipment of a shipped order is
   * delivered, the order is marked delivered.
   */
  app.patch(
    '/shipments/:id/status',
    { preHandler: requireAdmin(Permission.ORDER_FULFIL) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { status } = z
        .object({
          status: z.enum(['IN_TRANSIT', 'DELIVERED', 'FAILED', 'RETURNED_TO_ORIGIN']),
        })
        .parse(request.body);

      const auth = currentUser(request);

      const result = await updateShipmentStatus(id, status, {
        userId: auth.id,
        email: auth.email,
        permissions: auth.permissions,
        ipAddress: request.ip,
        correlationId: request.correlationId,
      });

      return reply.status(200).send({ status, ...result });
    },
  );

  // --- Returns --------------------------------------------------------------

  /**
   * Record a return request for some or all items on a shipped or delivered
   * order, with a reason. Quantities may not exceed what was ordered. Writes
   * an audit entry.
   */
  app.post(
    '/orders/:id/returns',
    { preHandler: requireAdmin(Permission.ORDER_RETURN) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          reason: z.string().trim().min(1).max(512),
          items: z
            .array(
              z.object({
                orderItemId: z.string().length(26),
                quantity: z.number().int().min(1).max(1_000_000),
              }),
            )
            .min(1)
            .max(200),
        })
        .parse(request.body);

      const auth = currentUser(request);

      const result = await createReturnRequest(
        { orderId: id, reason: body.reason, items: body.items, requestedById: auth.id },
        {
          userId: auth.id,
          email: auth.email,
          permissions: auth.permissions,
          ipAddress: request.ip,
          correlationId: request.correlationId,
        },
      );

      return reply.status(201).send(result);
    },
  );

  /**
   * Record the inspection outcome.
   *
   * The sellable/damaged split is the whole point: only sellable quantity
   * rejoins stock, and damaged units get their own quarantine movement so the
   * ledger explains the difference.
   */
  app.post(
    '/returns/:id/inspect',
    { preHandler: requireAdmin(Permission.ORDER_RETURN) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          outcome: z
            .array(
              z.object({
                orderItemId: z.string().length(26),
                sellableQty: z.number().int().min(0).max(1_000_000),
                damagedQty: z.number().int().min(0).max(1_000_000),
              }),
            )
            .min(1)
            .max(200),
          decisionNote: z.string().max(512).nullable().optional(),
        })
        .parse(request.body);

      const auth = currentUser(request);

      const result = await inspectReturn(
        { returnId: id, outcome: body.outcome, decisionNote: body.decisionNote ?? null },
        {
          userId: auth.id,
          email: auth.email,
          permissions: auth.permissions,
          ipAddress: request.ip,
          correlationId: request.correlationId,
        },
      );

      return reply.status(200).send(result);
    },
  );

  /**
   * Refuse a return, with a note saying why. Refused if the return has
   * already been decided. Writes an audit entry.
   */
  app.post(
    '/returns/:id/reject',
    { preHandler: requireAdmin(Permission.ORDER_RETURN) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { note } = z.object({ note: z.string().trim().min(1).max(512) }).parse(request.body);

      const auth = currentUser(request);

      await rejectReturn(id, note, {
        userId: auth.id,
        email: auth.email,
        permissions: auth.permissions,
        ipAddress: request.ip,
        correlationId: request.correlationId,
      });

      return reply.status(200).send({ status: 'REJECTED' });
    },
  );

  /**
   * List return requests, newest first, a page at a time, optionally filtered
   * by status. Each shows its order, reason, items and any decision note.
   */
  app.get(
    '/returns',
    { preHandler: requireAdmin(Permission.ORDER_READ) },
    async (request, reply) => {
      const query = z
        .object({
          page: z.coerce.number().int().min(1).max(10_000).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          status: z
            .enum(['REQUESTED', 'APPROVED', 'REJECTED', 'RECEIVED', 'INSPECTED', 'COMPLETED'])
            .optional(),
        })
        .parse(request.query);

      const where = query.status !== undefined ? { status: query.status } : {};

      const [rows, total] = await Promise.all([
        prisma.returnRequest.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
          include: {
            order: { select: { id: true, orderNumber: true, status: true } },
          },
        }),
        prisma.returnRequest.count({ where }),
      ]);

      return reply.status(200).send({
        returns: rows.map((row) => ({
          id: row.id,
          order: row.order,
          status: row.status,
          reason: row.reason,
          items: row.itemsJson,
          decisionNote: row.decisionNote,
          createdAt: row.createdAt.toISOString(),
          completedAt: row.completedAt?.toISOString() ?? null,
        })),
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      });
    },
  );

  return Promise.resolve();
}
