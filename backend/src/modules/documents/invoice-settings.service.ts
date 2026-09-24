/**
 * How a seller numbers and signs their invoices, and the trade codes on their
 * listings that a GST invoice and a packing list print.
 *
 * Both are the seller's own statements about their own business: nothing here
 * is defaulted into a tax registration they did not give. The GSTIN itself
 * lives on the business profile (`taxRegistrationNumber`) the seller filled in
 * at onboarding, so there is exactly one place it is kept.
 */
import { z } from 'zod';

import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { checkGstin } from '../../domain/gst.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import type { SellerMembership } from '../seller/account.service.js';
import { recordSellerAudit } from '../seller/audit.service.js';

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();

export const invoiceSettingsSchema = z
  .object({
    jurisdiction: z.enum(['IN_GST', 'EU_VAT', 'GENERIC']).nullable(),
    invoiceSeries: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{1,6}$/),
    creditNoteSeries: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{1,6}$/),
    financialYearStartMonth: z.number().int().min(1).max(12),
    signatoryName: z.string().trim().max(160).nullable(),
    signatoryDesignation: z.string().trim().max(120).nullable(),
    lutReference: z.string().trim().max(64).nullable(),
    lutValidFrom: day,
    lutValidTo: day,
    footerNotes: z.string().trim().max(1000).nullable(),
  })
  .strict();

function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(`${value}T00:00:00.000Z`);
}

export async function readInvoiceSettings(
  membership: SellerMembership,
): Promise<Record<string, unknown>> {
  const [row, seller] = await Promise.all([
    prisma.sellerInvoiceSettings.findUnique({
      where: { sellerAccountId: membership.sellerAccountId },
    }),
    prisma.sellerAccount.findUniqueOrThrow({
      where: { id: membership.sellerAccountId },
      select: {
        legalName: true,
        registrationCountry: true,
        businessProfile: { select: { taxRegistrationNumber: true, registeredRegion: true } },
      },
    }),
  ]);
  const taxNumber = seller.businessProfile?.taxRegistrationNumber ?? null;
  return {
    settings:
      row === null
        ? null
        : {
            jurisdiction: row.jurisdiction,
            invoiceSeries: row.invoiceSeries,
            creditNoteSeries: row.creditNoteSeries,
            financialYearStartMonth: row.financialYearStartMonth,
            signatoryName: row.signatoryName,
            signatoryDesignation: row.signatoryDesignation,
            lutReference: row.lutReference,
            lutValidFrom: row.lutValidFrom?.toISOString().slice(0, 10) ?? null,
            lutValidTo: row.lutValidTo?.toISOString().slice(0, 10) ?? null,
            footerNotes: row.footerNotes,
            version: row.version,
          },
    // What the invoice will be issued under, read-only here.
    identity: {
      legalName: seller.legalName,
      registrationCountry: seller.registrationCountry,
      taxRegistrationNumber: taxNumber,
      gstinProblem: seller.registrationCountry === 'IN' ? checkGstin(taxNumber) : null,
    },
  };
}

export async function saveInvoiceSettings(
  membership: SellerMembership,
  input: z.infer<typeof invoiceSettingsSchema>,
): Promise<Record<string, unknown>> {
  if (
    input.lutValidFrom !== null &&
    input.lutValidTo !== null &&
    input.lutValidTo < input.lutValidFrom
  ) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The LUT end date is before its start date.', [
      { field: 'lutValidTo', code: 'INVALID' },
    ]);
  }
  const data = {
    jurisdiction: input.jurisdiction,
    invoiceSeries: input.invoiceSeries,
    creditNoteSeries: input.creditNoteSeries,
    financialYearStartMonth: input.financialYearStartMonth,
    signatoryName: input.signatoryName === '' ? null : input.signatoryName,
    signatoryDesignation: input.signatoryDesignation === '' ? null : input.signatoryDesignation,
    lutReference: input.lutReference === '' ? null : input.lutReference,
    lutValidFrom: toDate(input.lutValidFrom),
    lutValidTo: toDate(input.lutValidTo),
    footerNotes: input.footerNotes === '' ? null : input.footerNotes,
  };
  await prisma.sellerInvoiceSettings.upsert({
    where: { sellerAccountId: membership.sellerAccountId },
    create: { id: newId(), sellerAccountId: membership.sellerAccountId, ...data },
    update: { ...data, version: { increment: 1 } },
  });
  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'invoice_settings.saved',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_invoice_settings',
    after: {
      invoiceSeries: data.invoiceSeries,
      creditNoteSeries: data.creditNoteSeries,
      jurisdiction: data.jurisdiction,
    },
    summary: 'Invoice settings saved',
  });
  return readInvoiceSettings(membership);
}

export const tradeCodesSchema = z
  .object({
    hsnCode: z
      .string()
      .trim()
      .regex(/^\d{4,10}$/, 'An HSN or HS code is 4 to 10 digits.')
      .nullable(),
    countryOfOrigin: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/)
      .nullable(),
  })
  .strict();

export async function saveTradeCodes(
  membership: SellerMembership,
  offerId: string,
  input: z.infer<typeof tradeCodesSchema>,
): Promise<Record<string, unknown>> {
  const offer = await prisma.sellerOffer.findUnique({
    where: { id: offerId },
    select: { sellerAccountId: true },
  });
  if (offer === null || offer.sellerAccountId !== membership.sellerAccountId)
    throw notFound('Listing');
  const updated = await prisma.sellerOffer.update({
    where: { id: offerId },
    data: { hsnCode: input.hsnCode, countryOfOrigin: input.countryOfOrigin },
    select: { id: true, hsnCode: true, countryOfOrigin: true },
  });
  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'listing.trade_codes_saved',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_offer',
    resourceId: offerId,
    after: { hsnCode: input.hsnCode, countryOfOrigin: input.countryOfOrigin },
    summary: 'HSN code and country of origin saved',
  });
  return updated;
}

export async function readTradeCodes(
  membership: SellerMembership,
  offerId: string,
): Promise<Record<string, unknown>> {
  const offer = await prisma.sellerOffer.findUnique({
    where: { id: offerId },
    select: { id: true, sellerAccountId: true, hsnCode: true, countryOfOrigin: true },
  });
  if (offer === null || offer.sellerAccountId !== membership.sellerAccountId)
    throw notFound('Listing');
  return { id: offer.id, hsnCode: offer.hsnCode, countryOfOrigin: offer.countryOfOrigin };
}
