/**
 * Business configuration.
 *
 * Everything here changes how money is calculated or how the storefront
 * behaves, so every write is audited with before/after values and several are
 * guarded against leaving the system in a state it cannot operate in:
 *
 *   - There must always be exactly one default tax class. Without one,
 *     product creation fails.
 *   - A tax class in use by a product cannot be deleted.
 *   - Disabling a feature that live records depend on reports the dependency
 *     rather than silently stranding them.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { parseRateToScaled } from '../../domain/money.js';
import { newId } from '../../infra/ids.js';
import { env } from '../../config/env.js';
import { assistantDisclosure, isAssistantConfigured } from '../assistant/assistant.service.js';
import { prisma } from '../../infra/prisma.js';
import { stripHtml } from '../../infra/sanitize.js';
import { isValidTimeZone } from '../../domain/recurrence.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { listActiveCountries, listActiveCurrencies } from './currency.service.js';

export interface SettingsActor {
  userId: string;
  email: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

// --- Business profile ------------------------------------------------------

export interface BusinessProfileInput {
  legalName?: string;
  displayName?: string;
  supportEmail?: string;
  supportPhone?: string | null;
  gstin?: string | null;
  /**
   * The seller's EU VAT identification number. Art. 226(3) requires it on
   * every invoice.
   */
  vatNumber?: string | null;
  /**
   * The member state the business is established in for VAT.
   *
   * The single switch for the whole EU VAT engine. Null - the default - means
   * every order is taxed at its tax class's own flat rate, exactly as this
   * system behaved before EU VAT existed in it. Setting it starts resolving
   * rates against the delivery country, so it must not be set before the rate
   * table has been checked.
   */
  vatCountry?: string | null;
  /**
   * Whether product listings must satisfy GPSR Art. 19 before they publish.
   *
   * Off by default: a shop selling outside the Union has no such obligation,
   * and blocking its catalogue on one would be this software inventing law.
   */
  gpsrEnforced?: boolean;
  logoMediaId?: string | null;
  addressJson?: Record<string, unknown> | null;
  currency?: string;
  timezone?: string;
  invoicePrefix?: string;
  orderPrefix?: string;
  policyLinksJson?: Record<string, unknown> | null;
}

export async function getBusinessProfile(): Promise<Record<string, unknown> | null> {
  const profile = await prisma.businessProfile.findFirst({
    include: { logoMedia: { select: { id: true, url: true, altText: true } } },
  });

  if (profile === null) return null;

  return {
    id: profile.id,
    legalName: profile.legalName,
    displayName: profile.displayName,
    supportEmail: profile.supportEmail,
    supportPhone: profile.supportPhone,
    gstin: profile.gstin,
    vatNumber: profile.vatNumber,
    vatCountry: profile.vatCountry,
    gpsrEnforced: profile.gpsrEnforced,
    logo: profile.logoMedia,
    address: profile.addressJson,
    currency: profile.currency,
    timezone: profile.timezone,
    invoicePrefix: profile.invoicePrefix,
    orderPrefix: profile.orderPrefix,
    policyLinks: profile.policyLinksJson,
    updatedAt: profile.updatedAt.toISOString(),
  };
}

export async function updateBusinessProfile(
  input: BusinessProfileInput,
  actor: SettingsActor,
): Promise<void> {
  const existing = await prisma.businessProfile.findFirst();
  if (existing === null) throw notFound('Business profile');

  if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, `Unknown timezone: ${input.timezone}`, [
      { field: 'timezone', code: 'INVALID' },
    ]);
  }

  /**
   * Currency is deliberately immutable once orders exist.
   *
   * Changing it would reinterpret every stored minor-unit amount: 149950 paise
   * would silently become 1499.50 of something else. There is no safe
   * migration for that, so the change is refused.
   */
  if (input.currency !== undefined && input.currency !== existing.currency) {
    const orderCount = await prisma.order.count();
    if (orderCount > 0) {
      throw conflict(
        ErrorCode.CONFLICT,
        `The currency cannot be changed once orders exist (${String(orderCount)} found). ` +
          'Every stored amount is in the current currency minor unit.',
        [{ field: 'currency', code: 'IMMUTABLE_AFTER_ORDERS', meta: { orderCount } }],
      );
    }
  }

  const data: Prisma.BusinessProfileUncheckedUpdateInput = { updatedById: actor.userId };

  if (input.legalName !== undefined) data.legalName = input.legalName.trim();
  if (input.displayName !== undefined) data.displayName = input.displayName.trim();
  if (input.supportEmail !== undefined) data.supportEmail = input.supportEmail.trim().toLowerCase();
  if (input.supportPhone !== undefined) data.supportPhone = input.supportPhone;
  if (input.gstin !== undefined) data.gstin = input.gstin;
  if (input.vatNumber !== undefined) data.vatNumber = input.vatNumber;
  if (input.gpsrEnforced !== undefined) data.gpsrEnforced = input.gpsrEnforced;
  if (input.vatCountry !== undefined) {
    data.vatCountry = input.vatCountry === null ? null : input.vatCountry.toUpperCase();
  }
  if (input.logoMediaId !== undefined) data.logoMediaId = input.logoMediaId;
  if (input.addressJson !== undefined) data.addressJson = input.addressJson as never;
  if (input.currency !== undefined) data.currency = input.currency.toUpperCase();
  if (input.timezone !== undefined) data.timezone = input.timezone;
  if (input.invoicePrefix !== undefined) data.invoicePrefix = input.invoicePrefix.trim();
  if (input.orderPrefix !== undefined) data.orderPrefix = input.orderPrefix.trim();
  if (input.policyLinksJson !== undefined) data.policyLinksJson = input.policyLinksJson as never;

  await prisma.$transaction(async (tx) => {
    await tx.businessProfile.update({ where: { id: existing.id }, data });

    await recordAudit(
      {
        action: AuditAction.SETTINGS_UPDATED,
        resourceType: 'business_profile',
        resourceId: existing.id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: {
          legalName: existing.legalName,
          supportEmail: existing.supportEmail,
          currency: existing.currency,
          timezone: existing.timezone,
        },
        after: input,
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}

// --- Tax classes -----------------------------------------------------------

export interface TaxClassInput {
  code: string;
  name: string;
  /** Percent as an exact decimal string, e.g. "18.000000". Never a float. */
  ratePercent: string;
  /**
   * Which EU rate band this class falls in.
   *
   * Null - the default - means the class has no EU meaning and `ratePercent`
   * above is used wherever it is sold. Set it and the rate becomes a lookup
   * against the destination member state, and `ratePercent` is only the
   * fallback for a deployment that has not switched EU VAT on.
   */
  vatCategory?: 'STANDARD' | 'REDUCED' | 'SUPER_REDUCED' | 'ZERO' | 'EXEMPT' | null;
  isInclusive?: boolean;
  isDefault?: boolean;
  isActive?: boolean;
}

export async function listTaxClasses(): Promise<Record<string, unknown>[]> {
  const rows = await prisma.taxClass.findMany({
    orderBy: [{ isDefault: 'desc' }, { code: 'asc' }],
    include: { _count: { select: { products: true } } },
  });

  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    ratePercent: row.ratePercent.toString(),
    vatCategory: row.vatCategory,
    isInclusive: row.isInclusive,
    isDefault: row.isDefault,
    isActive: row.isActive,
    // The UI needs this to warn before deactivating one that is in use.
    productCount: row._count.products,
  }));
}

function validateRate(ratePercent: string): void {
  try {
    const scaled = parseRateToScaled(ratePercent);
    if (scaled > 100_000_000n) {
      throw new Error('over 100%');
    }
  } catch {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Enter a tax rate between 0 and 100, e.g. "18" or "18.5".',
      [{ field: 'ratePercent', code: 'INVALID_RATE' }],
    );
  }
}

export async function createTaxClass(
  input: TaxClassInput,
  actor: SettingsActor,
): Promise<{ id: string }> {
  validateRate(input.ratePercent);
  const code = input.code.trim().toUpperCase();

  const existing = await prisma.taxClass.findUnique({ where: { code } });
  if (existing !== null) {
    throw conflict(ErrorCode.CONFLICT, `A tax class with code "${code}" already exists.`, [
      { field: 'code', code: 'DUPLICATE' },
    ]);
  }

  const id = newId();

  await prisma.$transaction(async (tx) => {
    // Exactly one default. Two would make product creation pick arbitrarily.
    if (input.isDefault === true) {
      await tx.taxClass.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    }

    await tx.taxClass.create({
      data: {
        id,
        code,
        name: input.name.trim(),
        ratePercent: input.ratePercent,
        vatCategory: input.vatCategory ?? null,
        isInclusive: input.isInclusive ?? false,
        isDefault: input.isDefault ?? false,
        isActive: input.isActive ?? true,
      },
    });

    await recordAudit(
      {
        action: AuditAction.SETTINGS_UPDATED,
        resourceType: 'tax_class',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: input,
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return { id };
}

export async function updateTaxClass(
  taxClassId: string,
  input: Partial<TaxClassInput>,
  actor: SettingsActor,
): Promise<void> {
  const existing = await prisma.taxClass.findUnique({
    where: { id: taxClassId },
    include: { _count: { select: { products: true } } },
  });

  if (existing === null) throw notFound('Tax class');
  if (input.ratePercent !== undefined) validateRate(input.ratePercent);

  /**
   * Deactivating a tax class in use would break every future price
   * calculation for those products. Report the dependency instead.
   */
  if (input.isActive === false && existing._count.products > 0) {
    throw conflict(
      ErrorCode.CONFLICT,
      `${String(existing._count.products)} product(s) use this tax class. Move them first.`,
      [
        {
          field: 'isActive',
          code: 'IN_USE',
          meta: { productCount: existing._count.products },
        },
      ],
    );
  }

  // The system needs one default at all times.
  if (input.isDefault === false && existing.isDefault) {
    throw conflict(
      ErrorCode.CONFLICT,
      'Set another tax class as the default instead of clearing this one.',
      [{ field: 'isDefault', code: 'DEFAULT_REQUIRED' }],
    );
  }

  await prisma.$transaction(async (tx) => {
    if (input.isDefault === true) {
      await tx.taxClass.updateMany({
        where: { isDefault: true, id: { not: taxClassId } },
        data: { isDefault: false },
      });
    }

    const data: Prisma.TaxClassUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.ratePercent !== undefined) data.ratePercent = input.ratePercent;
    if (input.vatCategory !== undefined) data.vatCategory = input.vatCategory;
    if (input.isInclusive !== undefined) data.isInclusive = input.isInclusive;
    if (input.isDefault !== undefined) data.isDefault = input.isDefault;
    if (input.isActive !== undefined) data.isActive = input.isActive;

    await tx.taxClass.update({ where: { id: taxClassId }, data });

    await recordAudit(
      {
        action: AuditAction.SETTINGS_UPDATED,
        resourceType: 'tax_class',
        resourceId: taxClassId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: {
          name: existing.name,
          ratePercent: existing.ratePercent.toString(),
          isInclusive: existing.isInclusive,
          isDefault: existing.isDefault,
          isActive: existing.isActive,
        },
        after: input,
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}

// --- Shipping methods ------------------------------------------------------

export interface ShippingMethodInput {
  code: string;
  name: string;
  description?: string | null;
  /** Minor units as a string. */
  priceMinor: string;
  freeAboveMinor?: string | null;
  estimatedDaysMin?: number | null;
  estimatedDaysMax?: number | null;
  regionsJson?: Record<string, unknown> | null;
  isActive?: boolean;
  sortOrder?: number;
}

function parseMinor(value: string, field: string): bigint {
  if (!/^\d+$/.test(value.trim())) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Amounts must be whole minor units.', [
      { field, code: 'INVALID_MONEY' },
    ]);
  }
  return BigInt(value.trim());
}

export async function listShippingMethods(): Promise<Record<string, unknown>[]> {
  const rows = await prisma.shippingMethod.findMany({
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
  });

  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    priceMinor: row.priceMinor.toString(),
    freeAboveMinor: row.freeAboveMinor?.toString() ?? null,
    estimatedDaysMin: row.estimatedDaysMin,
    estimatedDaysMax: row.estimatedDaysMax,
    regions: row.regionsJson,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
  }));
}

export async function createShippingMethod(
  input: ShippingMethodInput,
  actor: SettingsActor,
): Promise<{ id: string }> {
  const code = input.code.trim().toUpperCase();

  const existing = await prisma.shippingMethod.findUnique({ where: { code } });
  if (existing !== null) {
    throw conflict(ErrorCode.CONFLICT, `A delivery method with code "${code}" already exists.`, [
      { field: 'code', code: 'DUPLICATE' },
    ]);
  }

  const id = newId();

  await prisma.$transaction(async (tx) => {
    await tx.shippingMethod.create({
      data: {
        id,
        code,
        name: input.name.trim(),
        description: stripHtml(input.description),
        priceMinor: parseMinor(input.priceMinor, 'priceMinor'),
        freeAboveMinor:
          input.freeAboveMinor === null || input.freeAboveMinor === undefined
            ? null
            : parseMinor(input.freeAboveMinor, 'freeAboveMinor'),
        estimatedDaysMin: input.estimatedDaysMin ?? null,
        estimatedDaysMax: input.estimatedDaysMax ?? null,
        regionsJson: (input.regionsJson ?? null) as never,
        isActive: input.isActive ?? true,
        sortOrder: input.sortOrder ?? 0,
      },
    });

    await recordAudit(
      {
        action: AuditAction.SETTINGS_UPDATED,
        resourceType: 'shipping_method',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: input,
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return { id };
}

export async function updateShippingMethod(
  methodId: string,
  input: Partial<ShippingMethodInput>,
  actor: SettingsActor,
): Promise<{ affectedSchedules: number }> {
  const existing = await prisma.shippingMethod.findUnique({ where: { id: methodId } });
  if (existing === null) throw notFound('Delivery method');

  /**
   * Recurring schedules pin a shipping method code. Deactivating one they use
   * would make every future occurrence lose its delivery cost, so the count is
   * reported back for the UI to warn with.
   */
  let affectedSchedules = 0;
  if (input.isActive === false) {
    affectedSchedules = await prisma.recurringSchedule.count({
      where: { shippingMethodCode: existing.code, status: { in: ['ACTIVE', 'PAUSED'] } },
    });
  }

  const data: Prisma.ShippingMethodUncheckedUpdateInput = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.description !== undefined) data.description = stripHtml(input.description);
  if (input.priceMinor !== undefined) data.priceMinor = parseMinor(input.priceMinor, 'priceMinor');
  if (input.freeAboveMinor !== undefined) {
    data.freeAboveMinor =
      input.freeAboveMinor === null ? null : parseMinor(input.freeAboveMinor, 'freeAboveMinor');
  }
  if (input.estimatedDaysMin !== undefined) data.estimatedDaysMin = input.estimatedDaysMin;
  if (input.estimatedDaysMax !== undefined) data.estimatedDaysMax = input.estimatedDaysMax;
  if (input.regionsJson !== undefined) data.regionsJson = input.regionsJson as never;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

  await prisma.$transaction(async (tx) => {
    await tx.shippingMethod.update({ where: { id: methodId }, data });

    await recordAudit(
      {
        action: AuditAction.SETTINGS_UPDATED,
        resourceType: 'shipping_method',
        resourceId: methodId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: {
          name: existing.name,
          priceMinor: existing.priceMinor,
          isActive: existing.isActive,
        },
        after: { ...input, affectedSchedules },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return { affectedSchedules };
}

// --- Notification settings -------------------------------------------------

export async function listNotificationSettings(): Promise<Record<string, unknown>[]> {
  const rows = await prisma.notificationSetting.findMany({ orderBy: { eventKey: 'asc' } });

  return rows.map((row) => ({
    id: row.id,
    eventKey: row.eventKey,
    name: row.name,
    emailEnabled: row.emailEnabled,
    smsEnabled: row.smsEnabled,
    subjectTemplate: row.subjectTemplate,
    bodyTemplate: row.bodyTemplate,
    internalRecipients: row.internalRecipientsJson,
    isActive: row.isActive,
  }));
}

export interface NotificationSettingInput {
  eventKey: string;
  name?: string;
  subjectTemplate?: string;
  bodyTemplate?: string;
  internalRecipients?: string[];
  emailEnabled?: boolean;
  isActive?: boolean;
}

/**
 * Upsert one notification setting.
 *
 * Absent rows fall back to the built-in templates, so this only needs to exist
 * once an administrator customises an event.
 */
export async function upsertNotificationSetting(
  input: NotificationSettingInput,
  actor: SettingsActor,
): Promise<{ id: string }> {
  const existing = await prisma.notificationSetting.findUnique({
    where: { eventKey: input.eventKey },
  });

  const id = existing?.id ?? newId();

  await prisma.$transaction(async (tx) => {
    await tx.notificationSetting.upsert({
      where: { eventKey: input.eventKey },
      update: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.subjectTemplate !== undefined ? { subjectTemplate: input.subjectTemplate } : {}),
        ...(input.bodyTemplate !== undefined ? { bodyTemplate: input.bodyTemplate } : {}),
        ...(input.internalRecipients !== undefined
          ? { internalRecipientsJson: input.internalRecipients as never }
          : {}),
        ...(input.emailEnabled !== undefined ? { emailEnabled: input.emailEnabled } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      create: {
        id,
        eventKey: input.eventKey,
        name: input.name ?? input.eventKey,
        subjectTemplate: input.subjectTemplate ?? '{{businessName}} notification',
        bodyTemplate: input.bodyTemplate ?? 'You have a new notification.',
        internalRecipientsJson: (input.internalRecipients ?? []) as never,
        emailEnabled: input.emailEnabled ?? true,
        isActive: input.isActive ?? true,
      },
    });

    await recordAudit(
      {
        action: AuditAction.SETTINGS_UPDATED,
        resourceType: 'notification_setting',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: existing === null ? null : { isActive: existing.isActive },
        after: input,
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return { id };
}

// --- Feature flags ---------------------------------------------------------

export async function listFeatureFlags(): Promise<Record<string, unknown>[]> {
  const rows = await prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });

  return rows.map((row) => ({
    key: row.key,
    enabled: row.enabled,
    description: row.description,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export interface FlagDependency {
  count: number;
  message: string;
}

/**
 * What would break if this flag were turned off.
 *
 * SOP §10 requires showing dependency impact before disabling payment,
 * shipping or recurring features. The UI calls this before the confirm dialog.
 */
export async function flagDisableImpact(key: string): Promise<FlagDependency | null> {
  if (key === 'recurring_orders') {
    const count = await prisma.recurringSchedule.count({ where: { status: 'ACTIVE' } });
    return count === 0
      ? null
      : {
          count,
          message:
            `${String(count)} active recurring schedule(s) will stop producing orders. ` +
            'Existing orders are unaffected.',
        };
  }

  if (key === 'stock_reservations') {
    const count = await prisma.stockReservation.count({ where: { status: 'ACTIVE' } });
    return count === 0
      ? null
      : {
          count,
          message:
            `${String(count)} checkout(s) currently hold reserved stock. ` +
            'New checkouts will not reserve, which allows overselling under contention.',
        };
  }

  if (key === 'order_approvals') {
    const count = await prisma.orderApproval.count({ where: { status: 'PENDING' } });
    return count === 0
      ? null
      : {
          count,
          message: `${String(count)} order(s) are awaiting approval and will need a decision anyway.`,
        };
  }

  return null;
}

export async function setFeatureFlag(
  key: string,
  enabled: boolean,
  actor: SettingsActor,
): Promise<void> {
  const existing = await prisma.featureFlag.findUnique({ where: { key } });
  if (existing === null) throw notFound('Feature flag');

  await prisma.$transaction(async (tx) => {
    await tx.featureFlag.update({
      where: { key },
      data: { enabled, updatedById: actor.userId },
    });

    await recordAudit(
      {
        action: AuditAction.FEATURE_FLAG_CHANGED,
        resourceType: 'feature_flag',
        resourceId: existing.id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { key, enabled: existing.enabled },
        after: { key, enabled },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}

/** Policy links, sanitised. Rendered on the storefront footer. */
export async function updatePolicyLinks(
  links: Record<string, string>,
  actor: SettingsActor,
): Promise<void> {
  const cleaned: Record<string, string> = {};

  for (const [key, value] of Object.entries(links)) {
    const text = stripHtml(value) ?? '';
    if (text.length === 0) continue;

    // Only http(s). A `javascript:` policy link would be a stored XSS on the
    // storefront footer.
    if (!/^https?:\/\//i.test(text)) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Policy links must start with http:// or https://', [
        { field: `policyLinks.${key}`, code: 'INVALID_URL' },
      ]);
    }
    cleaned[key] = text;
  }

  await updateBusinessProfile({ policyLinksJson: cleaned }, actor);
}

/**
 * Public storefront configuration.
 *
 * Deliberately a *separate* function from `getBusinessProfile`, not a filtered
 * view of it. This response is served to anyone with the URL, so the fields it
 * exposes are chosen by an explicit allowlist that has to be edited on purpose.
 * Deriving it by omission would leak the next field somebody adds to the
 * profile - GSTIN, the registered address, an internal prefix - the moment it
 * appeared.
 *
 * What is excluded and why:
 *   - `legalName`, `gstin`, `address` - the registered entity's details. The
 *     storefront shows a trading name, not a filing.
 *   - `invoicePrefix` / `orderPrefix` - internal numbering, which hints at
 *     volume and is not the public's business.
 *   - Anything from feature flags beyond the two the storefront must branch on.
 */
export async function getStorefrontConfig(): Promise<Record<string, unknown>> {
  const profile = await prisma.businessProfile.findFirst({
    select: {
      displayName: true,
      supportEmail: true,
      supportPhone: true,
      currency: true,
      timezone: true,
      policyLinksJson: true,
      logoMedia: { select: { url: true, altText: true } },
      // Read, never returned. It is the switch that decides whether a price
      // depends on where the buyer is, and `localisation.locationPricing`
      // below carries that as a boolean - the seller's own VAT country is a
      // registration detail and stays on this side of the allowlist.
      vatCountry: true,
    },
  });

  const [currencies, countries] = await Promise.all([
    listActiveCurrencies(),
    listActiveCountries(),
  ]);

  return {
    business: {
      displayName: profile?.displayName ?? 'UBOSS Sourcing',
      supportEmail: profile?.supportEmail ?? null,
      supportPhone: profile?.supportPhone ?? null,
      logo: profile?.logoMedia ?? null,
      // Currency and timezone are presentation facts the storefront needs
      // before it can render a price or a schedule time correctly.
      currency: profile?.currency ?? 'INR',
      timezone: profile?.timezone ?? 'Asia/Kolkata',
      policyLinks: profile?.policyLinksJson ?? null,
    },
    // The storefront asks a first-time shopper where they are and quotes them
    // in that market's currency, so it needs both lists before the first render.
    localisation: {
      currencies,
      countries,
      baseCurrency: profile?.currency ?? 'INR',
      /**
       * Whether a price in this deployment depends on where the buyer is.
       *
       * True once a seller has a VAT country, which is what puts the EU
       * treatment engine in charge of every quote: the same euro row is 19%
       * in Germany and 21% in the Netherlands. False in an Indian GST shop,
       * where every buyer is quoted the listed figure and asking somebody
       * where they are would change no number on any screen.
       *
       * It says nothing a price does not already say out loud - `taxNote`
       * names the country and the rate beside every figure - and it is what
       * lets an interface offer a location control only where the answer
       * matters. The admin console's market picker is the first caller.
       */
      locationPricing: (profile?.vatCountry ?? null) !== null,
    },
    features: {
      selfRegistration: env.FEATURE_CUSTOMER_SELF_REGISTRATION,
      // Whether a confirmed sign-up still waits for a member of staff. The
      // storefront says so on the form itself rather than only afterwards -
      // somebody who needs to order today should learn that before typing.
      selfRegistrationRequiresApproval: env.CUSTOMER_SELF_REGISTRATION_REQUIRES_APPROVAL,
      recurringOrders: env.FEATURE_RECURRING_ORDERS,
      // Whether this deployment has an Anthropic key configured. The
      // storefront mounts the chat widget only when this is true, so a
      // deployment that has not set one shows no chat button at all rather
      // than a button that 404s.
      assistant: isAssistantConfigured(),
    },

    /**
     * What the chat widget has to say about itself before anyone types.
     *
     * AI Act Art. 50(1) obliges the deployer to inform a person that they are
     * interacting with an AI system. The storefront cannot honour that from a
     * boolean feature flag, so the disclosure travels as its own block - and
     * it names the provider, because that provider receives whatever the
     * visitor types and therefore belongs in the privacy notice under
     * Art. 13(1)(e) of the GDPR.
     */
    assistant: assistantDisclosure(),
  };
}
