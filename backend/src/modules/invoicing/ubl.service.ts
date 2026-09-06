/**
 * EN 16931 invoices, in UBL 2.1 syntax (Peppol BIS Billing 3.0).
 *
 * Several member states now require invoices to be exchanged as structured
 * data rather than as a PDF: Italy through SdI today, Germany phasing B2B in
 * across 2025-2028, France 2026-2027, with Poland and Belgium on their own
 * timetables. What they have in common is the European semantic standard,
 * EN 16931 — a list of business terms (BT-1, BT-2, …) that an invoice must
 * carry — and the two syntaxes it may be expressed in, UBL and UN/CEFACT CII.
 *
 * This emits the UBL one, profiled as Peppol BIS Billing 3.0, because that is
 * the profile the Peppol network moves and the one most national systems
 * accept directly or as a CIUS.
 *
 * ---
 *
 * **What this is not.** Producing the document is one half of an e-invoicing
 * obligation; the other half is getting it to the buyer through whatever
 * channel their member state mandates, which means a contracted Peppol access
 * point, or SdI in Italy, or Chorus Pro in France. None of that lives here and
 * none of it can: an access point is a commercial relationship, not a library.
 * `docs/EU-VAT.md` says so plainly, and `renderInvoiceUbl` is the seam an
 * integration hangs off — it returns the exact bytes an AP expects to be
 * handed.
 *
 * **Three things this gets right that a naive generator does not.**
 *
 *   1. **The VAT category code, not just the rate.** A zero on an invoice is
 *      ambiguous: it can mean zero-rated (Z), exempt (E), reverse-charged (K
 *      or AE) or outside scope (O), and the receiver's accounting system
 *      posts each one differently. The code is derived from the treatment the
 *      order was actually priced under, not guessed from the percentage.
 *
 *   2. **An exemption reason wherever the rate is zero.** BR-E-10, BR-Z-10,
 *      BR-AE-10 and friends make the reason mandatory in exactly those cases.
 *      An otherwise perfect document is rejected at validation without it.
 *
 *   3. **Amounts as decimal strings from BigInt.** Every figure here starts as
 *      minor units and is formatted by integer arithmetic. Dividing by 100 in
 *      floating point is how a tax total ends up as 19.999999999999996 in a
 *      document a tax authority reads.
 */
import { notFound } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import type { InvoiceLineView, VatBreakdownRow } from './invoice.service.js';

/**
 * The two identifiers that make this a Peppol BIS Billing 3.0 document.
 *
 * `customizationID` is EN 16931 plus the Peppol CIUS; `profileID` is the
 * billing process. A receiver's validator keys off both, and a document with
 * the wrong pair is rejected before anybody looks at the amounts.
 */
const CUSTOMIZATION_ID =
  'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0';
const PROFILE_ID = 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0';

/** UNCL1001. 380 is a commercial invoice, 381 a credit note. */
const TYPE_INVOICE = '380';
const TYPE_CREDIT_NOTE = '381';

/**
 * UNCL5305 VAT category codes.
 *
 * The distinction that matters: `K` is an intra-Community supply of goods —
 * zero-rated because the goods cross a border and the customer accounts for
 * the tax. `AE` is a *domestic* reverse charge, a different mechanism this
 * system does not produce. Emitting AE for an intra-Community supply is the
 * single most common mapping error, and it puts the transaction in the wrong
 * box on the receiver's VAT return.
 */
const VatCategory = {
  STANDARD: 'S',
  ZERO_RATED: 'Z',
  EXEMPT: 'E',
  /** Intra-Community supply. Arts. 138 and 196. */
  INTRA_COMMUNITY: 'K',
  /** Free export item, tax not charged. Art. 146. */
  EXPORT: 'G',
} as const;

type VatCategoryCode = (typeof VatCategory)[keyof typeof VatCategory];

interface CategoryDecision {
  code: VatCategoryCode;
  /**
   * BT-121. Mandatory wherever the rate is zero — BR-E-10, BR-Z-10, BR-G-10,
   * BR-IC-10 all require it, and a document without one fails validation
   * however correct its arithmetic.
   */
  exemptionReason: string | null;
}

/**
 * Which category a line falls in.
 *
 * Driven by the treatment the order was priced under rather than by the
 * percentage, because a 0% line is ambiguous and the receiver posts each
 * meaning differently.
 */
function categoryFor(treatment: string, ratePercent: string, exemptionNote: string | null): CategoryDecision {
  switch (treatment) {
    case 'INTRA_EU_REVERSE_CHARGE':
      return {
        code: VatCategory.INTRA_COMMUNITY,
        exemptionReason:
          exemptionNote ??
          'Intra-Community supply exempt under Article 138 of Council Directive 2006/112/EC. ' +
            'VAT to be accounted for by the recipient under Article 196.',
      };

    case 'EXPORT':
      return {
        code: VatCategory.EXPORT,
        exemptionReason:
          exemptionNote ??
          'Export of goods outside the Union, zero-rated under Article 146 of Council ' +
            'Directive 2006/112/EC.',
      };

    default: {
      // A domestic or destination-rated line. Zero here is a rate of zero
      // rather than an exemption, which is `Z` and still needs a reason.
      if (Number(ratePercent) === 0) {
        return {
          code: VatCategory.ZERO_RATED,
          exemptionReason: exemptionNote ?? 'Zero-rated supply.',
        };
      }

      return { code: VatCategory.STANDARD, exemptionReason: null };
    }
  }
}

/**
 * Minor units to the decimal string UBL wants.
 *
 * Integer arithmetic throughout. `Number(minor) / 100` is how a tax total
 * becomes 19.999999999999996 in a document somebody's tax authority reads.
 */
function amount(minor: bigint | string): string {
  const value = typeof minor === 'bigint' ? minor : BigInt(minor);
  const negative = value < 0n;
  const absolute = negative ? -value : value;

  const units = absolute / 100n;
  const cents = absolute % 100n;

  return `${negative ? '-' : ''}${units.toString()}.${cents.toString().padStart(2, '0')}`;
}

/** A rate as UBL renders a percentage: two decimals, no trailing noise. */
function percentage(value: string): string {
  return Number(value).toFixed(2);
}

/** `YYYY-MM-DD`, which is what UBL's date type is. */
function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * XML text escaping.
 *
 * Applied to every interpolated value without exception. A product name with
 * an ampersand in it is ordinary, and it is also enough to make the whole
 * document unparseable at the receiver — which is the kind of failure that
 * surfaces as "the tax authority rejected your invoice" rather than as an
 * error anybody here would see.
 */
function xml(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';

  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface PartyView {
  legalName?: string;
  name?: string;
  organization?: string | null;
  email?: string | null;
  address?: unknown;
  billingAddress?: unknown;
  country?: string | null;
  countryCode?: string | null;
}

interface AddressShape {
  line1?: string;
  line2?: string | null;
  city?: string;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

function addressOf(value: unknown): AddressShape {
  return typeof value === 'object' && value !== null ? (value) : {};
}

/**
 * A party block: BG-4 for the seller, BG-7 for the buyer.
 *
 * The country code is required (BT-40 / BT-55) and there is no sensible
 * default, so an absent one is emitted empty rather than guessed — a validator
 * rejecting a blank country is a better outcome than a document that silently
 * claims the wrong one.
 */
function partyXml(
  tag: 'AccountingSupplierParty' | 'AccountingCustomerParty',
  name: string,
  address: AddressShape,
  countryCode: string,
  vatNumber: string | null,
  email: string | null,
): string {
  const vat =
    vatNumber === null
      ? ''
      : `
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${xml(vatNumber)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>`;

  const contact =
    email === null
      ? ''
      : `
      <cac:Contact>
        <cbc:ElectronicMail>${xml(email)}</cbc:ElectronicMail>
      </cac:Contact>`;

  return `  <cac:${tag}>
    <cac:Party>
      <cac:PostalAddress>
        <cbc:StreetName>${xml(address.line1 ?? '')}</cbc:StreetName>${
          address.line2 === null || address.line2 === undefined || address.line2 === ''
            ? ''
            : `
        <cbc:AdditionalStreetName>${xml(address.line2)}</cbc:AdditionalStreetName>`
        }
        <cbc:CityName>${xml(address.city ?? '')}</cbc:CityName>
        <cbc:PostalZone>${xml(address.postalCode ?? '')}</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>${xml(countryCode)}</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>${vat}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${xml(name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>${contact}
    </cac:Party>
  </cac:${tag}>`;
}

export interface RenderedInvoice {
  /** The document, as the bytes an access point expects to be handed. */
  xml: string;
  fileName: string;
  /** 380 or 381. Useful to a caller routing the document. */
  typeCode: string;
}

/**
 * Render one invoice as EN 16931 UBL.
 *
 * Reads the frozen snapshot on the invoice row rather than the live order:
 * the whole reason those columns exist is that a document must not change
 * after issue, and re-deriving it from current data would defeat that on the
 * first product rename.
 */
export async function renderInvoiceUbl(invoiceId: string): Promise<RenderedInvoice> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { order: { select: { orderNumber: true } } },
  });

  if (invoice === null) throw notFound('Invoice');

  const isCreditNote = invoice.creditsInvoiceId !== null;
  const typeCode = isCreditNote ? TYPE_CREDIT_NOTE : TYPE_INVOICE;

  const seller = invoice.sellerJson as PartyView;
  const buyer = invoice.buyerJson as PartyView;
  const lines = invoice.linesJson as unknown as InvoiceLineView[];
  const breakdown = invoice.vatBreakdownJson as unknown as VatBreakdownRow[];

  const sellerAddress = addressOf(seller.address);
  const buyerAddress = addressOf(buyer.billingAddress);

  const sellerCountry = seller.countryCode ?? sellerAddress.country ?? '';
  const buyerCountry = buyerAddress.country ?? '';

  // BG-23, one per rate. The reason travels per subtotal because a mixed
  // invoice can legitimately carry a standard-rated line and a zero-rated one
  // under different provisions.
  const taxSubtotals = breakdown
    .map((row) => {
      const category = categoryFor(invoice.taxTreatment, row.ratePercent, invoice.exemptionNote);

      const reason =
        category.exemptionReason === null
          ? ''
          : `
        <cbc:TaxExemptionReason>${xml(category.exemptionReason)}</cbc:TaxExemptionReason>`;

      return `    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${invoice.currency}">${amount(row.taxableMinor)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${invoice.currency}">${amount(row.vatMinor)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>${category.code}</cbc:ID>
        <cbc:Percent>${percentage(row.ratePercent)}</cbc:Percent>${reason}
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`;
    })
    .join('\n');

  // BG-25, one per line. Quantities go out as `C62` (one, a piece) - this
  // catalogue sells countable goods, and a unit code is mandatory.
  const invoiceLines = lines
    .map((line, index) => {
      const category = categoryFor(
        invoice.taxTreatment,
        line.vatRatePercent,
        invoice.exemptionNote,
      );

      // BT-146 is the price per unit, which is NOT the line total divided by
      // quantity once a discount is applied - the discount is a line-level
      // allowance and the unit price stays what it was.
      return `  <cac:InvoiceLine>
    <cbc:ID>${String(index + 1)}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">${String(line.quantity)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${invoice.currency}">${amount(line.netMinor)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>${xml(line.description)}</cbc:Name>
      <cac:SellersItemIdentification>
        <cbc:ID>${xml(line.sku)}</cbc:ID>
      </cac:SellersItemIdentification>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>${category.code}</cbc:ID>
        <cbc:Percent>${percentage(line.vatRatePercent)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${invoice.currency}">${amount(line.unitPriceMinor)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`;
    })
    .join('\n');

  // BG-22. `TaxExclusiveAmount` is the sum of line nets; `TaxInclusiveAmount`
  // is that plus the tax. Shipping travels as a charge rather than as a line,
  // which is what keeps the line sum and the document total reconcilable -
  // BR-CO-13 checks exactly that.
  const shipping =
    invoice.shippingMinor === 0n
      ? ''
      : `
  <cac:AllowanceCharge>
    <cbc:ChargeIndicator>true</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReasonCode>DL</cbc:AllowanceChargeReasonCode>
    <cbc:AllowanceChargeReason>Delivery</cbc:AllowanceChargeReason>
    <cbc:Amount currencyID="${invoice.currency}">${amount(invoice.shippingMinor)}</cbc:Amount>
  </cac:AllowanceCharge>`;

  const discount =
    invoice.discountMinor === 0n
      ? ''
      : `
  <cac:AllowanceCharge>
    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReasonCode>95</cbc:AllowanceChargeReasonCode>
    <cbc:AllowanceChargeReason>Discount</cbc:AllowanceChargeReason>
    <cbc:Amount currencyID="${invoice.currency}">${amount(invoice.discountMinor)}</cbc:Amount>
  </cac:AllowanceCharge>`;

  const taxExclusive = invoice.subtotalMinor - invoice.discountMinor + invoice.shippingMinor;

  const document = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>${CUSTOMIZATION_ID}</cbc:CustomizationID>
  <cbc:ProfileID>${PROFILE_ID}</cbc:ProfileID>
  <cbc:ID>${xml(invoice.number)}</cbc:ID>
  <cbc:IssueDate>${isoDate(invoice.issuedAt)}</cbc:IssueDate>
  <cbc:InvoiceTypeCode>${typeCode}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${invoice.currency}</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>${xml(invoice.order.orderNumber)}</cbc:BuyerReference>
  <cac:InvoicePeriod>
    <cbc:EndDate>${isoDate(invoice.suppliedAt)}</cbc:EndDate>
  </cac:InvoicePeriod>
  <cac:OrderReference>
    <cbc:ID>${xml(invoice.order.orderNumber)}</cbc:ID>
  </cac:OrderReference>
${partyXml(
  'AccountingSupplierParty',
  seller.legalName ?? seller.name ?? '',
  sellerAddress,
  sellerCountry,
  invoice.sellerVatNumber,
  seller.email ?? null,
)}
${partyXml(
  'AccountingCustomerParty',
  buyer.organization ?? buyer.name ?? '',
  buyerAddress,
  buyerCountry,
  invoice.buyerVatNumber,
  buyer.email ?? null,
)}${discount}${shipping}
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${invoice.currency}">${amount(invoice.taxMinor)}</cbc:TaxAmount>
${taxSubtotals}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${invoice.currency}">${amount(invoice.subtotalMinor)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${invoice.currency}">${amount(taxExclusive)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${invoice.currency}">${amount(invoice.grandTotalMinor)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="${invoice.currency}">${amount(invoice.discountMinor)}</cbc:AllowanceTotalAmount>
    <cbc:ChargeTotalAmount currencyID="${invoice.currency}">${amount(invoice.shippingMinor)}</cbc:ChargeTotalAmount>
    <cbc:PayableAmount currencyID="${invoice.currency}">${amount(invoice.grandTotalMinor)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${invoiceLines}
</Invoice>
`;

  return {
    xml: document,
    fileName: `${invoice.number}.xml`,
    typeCode,
  };
}

export interface UblValidationIssue {
  /** The EN 16931 business rule or term this relates to. */
  rule: string;
  message: string;
}

/**
 * The checks a receiver will run, run here first.
 *
 * Not a schema validator — that needs the UBL XSD and the EN 16931 Schematron,
 * neither of which belongs in this dependency tree. These are the handful of
 * rules that a real deployment actually trips over, and every one of them is a
 * missing value rather than a malformed one: a seller with no VAT number, a
 * buyer with no country, an exemption with no reason.
 *
 * Surfacing them here turns "the tax authority rejected your invoice" into
 * "this invoice is missing the buyer's country", weeks earlier.
 */
export async function validateInvoiceForEn16931(invoiceId: string): Promise<UblValidationIssue[]> {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (invoice === null) throw notFound('Invoice');

  const issues: UblValidationIssue[] = [];

  const seller = invoice.sellerJson as PartyView;
  const buyer = invoice.buyerJson as PartyView;
  const sellerAddress = addressOf(seller.address);
  const buyerAddress = addressOf(buyer.billingAddress);

  if ((seller.legalName ?? seller.name ?? '').trim().length === 0) {
    issues.push({ rule: 'BT-27', message: 'The seller has no registered name.' });
  }

  if ((seller.countryCode ?? sellerAddress.country ?? '').trim().length === 0) {
    issues.push({
      rule: 'BT-40',
      message:
        'The seller address has no country code. Set the VAT country on the business profile.',
    });
  }

  if ((buyerAddress.country ?? '').trim().length === 0) {
    issues.push({
      rule: 'BT-55',
      message: 'The buyer address has no country code.',
    });
  }

  if (invoice.sellerVatNumber === null && invoice.taxMinor > 0n) {
    // BR-CO-9: a VAT-charging invoice needs the seller's VAT identifier.
    issues.push({
      rule: 'BR-CO-9',
      message:
        'VAT is charged but the seller has no VAT number. Set it on the business profile before ' +
        'sending this invoice electronically.',
    });
  }

  if (invoice.taxTreatment === 'INTRA_EU_REVERSE_CHARGE' && invoice.buyerVatNumber === null) {
    // BR-IC-11: an intra-Community supply must carry the customer's VAT id.
    issues.push({
      rule: 'BR-IC-11',
      message:
        'This invoice is zero-rated as an intra-Community supply but carries no customer VAT ' +
        'number. That combination is rejected by every EN 16931 validator.',
    });
  }

  if (invoice.taxMinor === 0n && (invoice.exemptionNote ?? '').trim().length === 0) {
    issues.push({
      rule: 'BR-E-10',
      message:
        'No VAT is charged and no exemption reason is stated. Every zero-rate category requires ' +
        'one.',
    });
  }

  return issues;
}
