/**
 * Who issues commission invoices, and how they are numbered.
 *
 * One row, entered by the business that runs this deployment. Nothing here has
 * a default for a name, an address or a registration number - a placeholder on
 * a tax document is a false statement - so until the required fields are set
 * every draft carries an issue saying which one is missing, and none can be
 * issued.
 *
 * A save is versioned: two finance staff editing at once collide on the
 * version rather than one silently overwriting the other.
 */
import { z } from 'zod';

import type { CommissionInvoiceSettings } from '../../generated/prisma/client.js';
import { isValidDocumentPrefix } from '../../domain/commission-invoice.js';
import { ErrorCode, badRequest, conflict } from '../../domain/errors.js';
import { GST_STATE_CODES } from '../../domain/gst.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';

export interface FinanceActor {
  userId: string;
  email: string | null;
  ipAddress?: string | null;
  correlationId?: string | null;
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === undefined || value === null || value === '' ? null : value));

export const settingsInputSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    legalEntityCode: z.string().trim().regex(/^[A-Z0-9]{1,16}$/),
    legalName: optionalText(255),
    tradeName: optionalText(255),
    addressLine1: optionalText(255),
    addressLine2: optionalText(255),
    city: optionalText(120),
    region: optionalText(120),
    postcode: optionalText(24),
    country: optionalText(2),
    stateCode: optionalText(4),
    taxRegime: z.enum(['IN_GST', 'VAT', 'OTHER', 'NONE']),
    taxRegistrationLabel: z.string().trim().min(1).max(32),
    taxRegistrationNumber: optionalText(32),
    businessIdentifierLabel: z.string().trim().min(1).max(32),
    businessIdentifier: optionalText(32),
    businessEmail: optionalText(320),
    supportContact: optionalText(160),
    jurisdictionNote: optionalText(255),
    serviceCode: optionalText(16),
    serviceCodeLabel: z.string().trim().min(1).max(16),
    serviceDescription: z.string().trim().min(3).max(255),
    invoicePrefix: z.string().trim().min(1).max(16),
    creditNotePrefix: z.string().trim().min(1).max(16),
    sequencePadding: z.number().int().min(3).max(9),
    financialYearStartMonth: z.number().int().min(1).max(12),
    eligibleStage: z.enum(['CONFIRMED', 'SHIPPED', 'DELIVERED']),
    paymentTermsDays: z.number().int().min(0).max(365).nullable(),
    roundGrandTotal: z.boolean(),
    requireSellerTaxId: z.boolean(),
    exportLutReference: optionalText(64),
    zeroTaxDocumentType: z.enum(['INVOICE', 'BILL_OF_SUPPLY']),
    allowVoidAfterIssue: z.boolean(),
    footerNote: optionalText(1000),
  })
  .strict();

export type SettingsInput = z.infer<typeof settingsInputSchema>;

/** The settings, or a blank row's defaults when none has been saved yet. */
export async function loadSettings(client: PrismaTransaction | typeof prisma = prisma): Promise<CommissionInvoiceSettings> {
  const row = await client.commissionInvoiceSettings.findUnique({ where: { singleton: 'default' } });
  if (row !== null) return row;
  const now = new Date();
  return {
    id: '',
    singleton: 'default',
    legalEntityCode: 'MAIN',
    legalName: null,
    tradeName: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    region: null,
    postcode: null,
    country: null,
    stateCode: null,
    taxRegime: 'NONE',
    taxRegistrationLabel: 'GSTIN',
    taxRegistrationNumber: null,
    businessIdentifierLabel: 'PAN',
    businessIdentifier: null,
    businessEmail: null,
    supportContact: null,
    jurisdictionNote: null,
    serviceCode: null,
    serviceCodeLabel: 'SAC',
    serviceDescription: 'Marketplace platform commission for Order {orderNumber}',
    invoicePrefix: 'GM/COM',
    creditNotePrefix: 'GM/CCN',
    sequencePadding: 6,
    financialYearStartMonth: 4,
    eligibleStage: 'DELIVERED',
    paymentTermsDays: null,
    roundGrandTotal: false,
    requireSellerTaxId: true,
    exportLutReference: null,
    zeroTaxDocumentType: 'INVOICE',
    allowVoidAfterIssue: false,
    footerNote: null,
    version: 0,
    updatedByUserId: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function serialiseSettings(row: CommissionInvoiceSettings) {
  return {
    version: row.version,
    saved: row.id !== '',
    legalEntityCode: row.legalEntityCode,
    legalName: row.legalName,
    tradeName: row.tradeName,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    region: row.region,
    postcode: row.postcode,
    country: row.country,
    stateCode: row.stateCode,
    taxRegime: row.taxRegime,
    taxRegistrationLabel: row.taxRegistrationLabel,
    taxRegistrationNumber: row.taxRegistrationNumber,
    businessIdentifierLabel: row.businessIdentifierLabel,
    businessIdentifier: row.businessIdentifier,
    businessEmail: row.businessEmail,
    supportContact: row.supportContact,
    jurisdictionNote: row.jurisdictionNote,
    serviceCode: row.serviceCode,
    serviceCodeLabel: row.serviceCodeLabel,
    serviceDescription: row.serviceDescription,
    invoicePrefix: row.invoicePrefix,
    creditNotePrefix: row.creditNotePrefix,
    sequencePadding: row.sequencePadding,
    financialYearStartMonth: row.financialYearStartMonth,
    eligibleStage: row.eligibleStage,
    paymentTermsDays: row.paymentTermsDays,
    roundGrandTotal: row.roundGrandTotal,
    requireSellerTaxId: row.requireSellerTaxId,
    exportLutReference: row.exportLutReference,
    zeroTaxDocumentType: row.zeroTaxDocumentType,
    allowVoidAfterIssue: row.allowVoidAfterIssue,
    footerNote: row.footerNote,
    missing: issuerGaps(row).map((gap) => gap.field),
    updatedAt: row.id === '' ? null : row.updatedAt.toISOString(),
  };
}

/** What the issuer still has to fill in. Tax-specific checks are the tax resolution's. */
export function issuerGaps(row: CommissionInvoiceSettings): { field: string; code: string; message: string }[] {
  const gaps: { field: string; code: string; message: string }[] = [];
  const need = (value: string | null, field: string, what: string) => {
    if ((value ?? '').trim() === '') {
      gaps.push({ field: `settings.${field}`, code: 'ISSUER_DETAIL_MISSING', message: `The issuing entity's ${what} is missing from the commission invoice settings.` });
    }
  };
  need(row.legalName, 'legalName', 'legal name');
  need(row.addressLine1, 'addressLine1', 'registered address');
  need(row.city, 'city', 'city');
  need(row.country, 'country', 'country');
  need(row.businessEmail, 'businessEmail', 'business email');
  if (row.taxRegime === 'IN_GST') {
    need(row.serviceCode, 'serviceCode', `${row.serviceCodeLabel} code`);
    need(row.businessIdentifier, 'businessIdentifier', row.businessIdentifierLabel);
  }
  return gaps;
}

export async function saveSettings(actor: FinanceActor, raw: unknown) {
  const input = settingsInputSchema.parse(raw);
  const problems: { field: string; code: string }[] = [];
  if (!isValidDocumentPrefix(input.invoicePrefix)) problems.push({ field: 'invoicePrefix', code: 'PREFIX' });
  if (!isValidDocumentPrefix(input.creditNotePrefix)) problems.push({ field: 'creditNotePrefix', code: 'PREFIX' });
  if (input.invoicePrefix === input.creditNotePrefix) problems.push({ field: 'creditNotePrefix', code: 'SAME_AS_INVOICE' });
  const country = input.country === null ? null : input.country.toUpperCase();
  if (country !== null && !/^[A-Z]{2}$/.test(country)) problems.push({ field: 'country', code: 'COUNTRY' });
  if (input.taxRegime === 'IN_GST') {
    if (country !== null && country !== 'IN') problems.push({ field: 'country', code: 'GST_OUTSIDE_INDIA' });
    if (input.stateCode !== null && GST_STATE_CODES[input.stateCode] === undefined) problems.push({ field: 'stateCode', code: 'GST_STATE' });
  }
  if (input.businessEmail !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.businessEmail)) problems.push({ field: 'businessEmail', code: 'EMAIL' });
  if (problems.length > 0) {
    throw badRequest(ErrorCode.COMMISSION_INVOICE_SETTINGS_INVALID, 'Some commission invoice settings are not valid.', problems);
  }

  const { expectedVersion, ...fields } = input;
  const data = {
    ...fields,
    country,
    taxRegistrationNumber: fields.taxRegistrationNumber?.toUpperCase() ?? null,
    businessIdentifier: fields.businessIdentifier?.toUpperCase() ?? null,
    updatedByUserId: actor.userId,
  };

  const { before, after } = await prisma.$transaction(async (tx) => {
    const current = await tx.commissionInvoiceSettings.findUnique({ where: { singleton: 'default' } });
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== expectedVersion) {
      throw conflict(ErrorCode.COMMISSION_INVOICE_SETTINGS_CONFLICT, 'Someone else changed these settings. Reload them and try again.', [
        { code: 'VERSION', meta: { currentVersion } },
      ]);
    }
    const row =
      current === null
        ? await tx.commissionInvoiceSettings.create({ data: { id: newId(), singleton: 'default', ...data, version: 1 } })
        : await tx.commissionInvoiceSettings.update({ where: { id: current.id }, data: { ...data, version: currentVersion + 1 } });
    return { before: current, after: row };
  });

  await recordAudit({
    action: AuditAction.COMMISSION_INVOICE_SETTINGS_SAVED,
    resourceType: 'commission_invoice_settings',
    resourceId: after.id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: before === null ? null : serialiseSettings(before),
    after: serialiseSettings(after),
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });
  return serialiseSettings(after);
}
