/**
 * Currencies, countries, and which one a given shopper is quoted in.
 *
 * The catalogue is priced per currency, not converted. `product_prices` holds a
 * real, staff-entered figure for each currency a SKU is sold in, so the number
 * on the page is the number charged. There is deliberately no exchange rate
 * anywhere in this module: a rate would make the displayed price drift from the
 * settled one, which is the failure `domain/pricing.ts` exists to prevent.
 *
 * Currency resolution, most specific first:
 *
 *   1. The customer's own `preferredCurrency`, once they have chosen.
 *   2. The default currency of their `preferredCountry`.
 *   3. The business's base currency.
 *
 * A signed-out visitor only ever gets step 3 until they pick, because there is
 * nowhere to remember a choice.
 */
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { currencyExponent } from '../../domain/money.js';
import { prisma } from '../../infra/prisma.js';

export interface CurrencyView {
  code: string;
  name: string;
  symbol: string;
  exponent: number;
  isBase: boolean;
}

export interface CountryView {
  code: string;
  name: string;
  currencyCode: string;
  phonePrefix: string | null;
}

export async function listActiveCurrencies(): Promise<CurrencyView[]> {
  return prisma.currency.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    select: { code: true, name: true, symbol: true, exponent: true, isBase: true },
  });
}

export async function listActiveCountries(): Promise<CountryView[]> {
  return prisma.country.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { code: true, name: true, currencyCode: true, phonePrefix: true },
  });
}

/**
 * The business's reporting currency, and the fallback for anyone who has not
 * chosen. Falls back to the business profile if no row is flagged, so a
 * half-seeded database still serves pages.
 */
export async function getBaseCurrency(): Promise<string> {
  const flagged = await prisma.currency.findFirst({
    where: { isBase: true, isActive: true },
    select: { code: true },
  });
  if (flagged !== null) return flagged.code;

  const business = await prisma.businessProfile.findFirst({ select: { currency: true } });
  return business?.currency ?? 'INR';
}

/** Throws unless the code is an active currency this deployment sells in. */
export async function assertSellableCurrency(code: string): Promise<string> {
  const normalised = code.trim().toUpperCase();
  const row = await prisma.currency.findFirst({
    where: { code: normalised, isActive: true },
    select: { code: true },
  });

  if (row === null) {
    throw badRequest(
      ErrorCode.CURRENCY_NOT_SUPPORTED,
      `${normalised} is not a currency this store sells in.`,
      [{ field: 'currency', code: ErrorCode.CURRENCY_NOT_SUPPORTED }],
    );
  }
  return row.code;
}

/**
 * Which currency to quote this shopper in.
 *
 * `customerProfileId` is null for a signed-out visitor, who gets the base
 * currency. An explicit `requested` override is honoured only if it names a
 * currency the store actually sells in.
 */
export async function resolveCurrencyFor(
  customerProfileId: string | null,
  requested?: string | null,
): Promise<string> {
  if (requested !== undefined && requested !== null && requested.trim() !== '') {
    return assertSellableCurrency(requested);
  }

  if (customerProfileId !== null) {
    const profile = await prisma.customerProfile.findUnique({
      where: { id: customerProfileId },
      select: { preferredCurrency: true, preferredCountry: true },
    });

    if (profile !== null && profile.preferredCurrency !== null) {
      // A currency can be retired after somebody chose it. Fall through rather
      // than serving prices in something no longer sold.
      const live = await prisma.currency.findFirst({
        where: { code: profile.preferredCurrency, isActive: true },
        select: { code: true },
      });
      if (live !== null) return live.code;
    }

    if (profile !== null && profile.preferredCountry !== null) {
      const country = await prisma.country.findFirst({
        where: { code: profile.preferredCountry, isActive: true },
        select: { currency: { select: { code: true, isActive: true } } },
      });
      if (country?.currency.isActive === true) return country.currency.code;
    }
  }

  return getBaseCurrency();
}

export interface LocaleChoice {
  /** What the shopper says. Required - this is the answer to the prompt. */
  country: string;
  /** Optional override; defaults to the country's own currency. */
  currency?: string | null;
  /**
   * What the browser's geolocation resolved to, when permission was granted.
   * Stored beside the stated country rather than replacing it, so the two can
   * disagree visibly instead of one silently winning.
   */
  detectedCountry?: string | null;
}

export interface LocaleView {
  country: string;
  currency: string;
  detectedCountry: string | null;
  /** True when geolocation was available and disagreed with the stated country. */
  detectedMismatch: boolean;
  chosenAt: string | null;
}

/** Record the shopper's country/currency choice against their profile. */
export async function setCustomerLocale(
  customerProfileId: string,
  choice: LocaleChoice,
): Promise<LocaleView> {
  const countryCode = choice.country.trim().toUpperCase();

  const country = await prisma.country.findFirst({
    where: { code: countryCode, isActive: true },
    select: { code: true, currencyCode: true },
  });

  if (country === null) {
    throw badRequest(
      ErrorCode.COUNTRY_NOT_SUPPORTED,
      `${countryCode} is not a country this store ships to.`,
      [{ field: 'country', code: ErrorCode.COUNTRY_NOT_SUPPORTED }],
    );
  }

  const currency =
    choice.currency !== null && choice.currency !== undefined && choice.currency.trim() !== ''
      ? await assertSellableCurrency(choice.currency)
      : await assertSellableCurrency(country.currencyCode);

  const detected =
    choice.detectedCountry !== null &&
    choice.detectedCountry !== undefined &&
    choice.detectedCountry.trim() !== ''
      ? choice.detectedCountry.trim().toUpperCase()
      : null;

  const now = new Date();
  const updated = await prisma.customerProfile.update({
    where: { id: customerProfileId },
    data: {
      preferredCountry: country.code,
      preferredCurrency: currency,
      localeChosenAt: now,
      ...(detected !== null ? { detectedCountry: detected, detectedAt: now } : {}),
    },
    select: {
      preferredCountry: true,
      preferredCurrency: true,
      detectedCountry: true,
      localeChosenAt: true,
    },
  });

  return toLocaleView(updated);
}

/** The shopper's current choice, or null when they have not been asked yet. */
export async function getCustomerLocale(customerProfileId: string): Promise<LocaleView | null> {
  const profile = await prisma.customerProfile.findUnique({
    where: { id: customerProfileId },
    select: {
      preferredCountry: true,
      preferredCurrency: true,
      detectedCountry: true,
      localeChosenAt: true,
    },
  });

  if (profile === null) throw notFound('Customer profile');
  if (profile.preferredCountry === null || profile.preferredCurrency === null) return null;

  return toLocaleView(profile);
}

function toLocaleView(profile: {
  preferredCountry: string | null;
  preferredCurrency: string | null;
  detectedCountry: string | null;
  localeChosenAt: Date | null;
}): LocaleView {
  const country = profile.preferredCountry ?? '';

  return {
    country,
    currency: profile.preferredCurrency ?? '',
    detectedCountry: profile.detectedCountry,
    detectedMismatch: profile.detectedCountry !== null && profile.detectedCountry !== country,
    chosenAt: profile.localeChosenAt?.toISOString() ?? null,
  };
}

/**
 * Boot check: every active currency must carry the same exponent here and in
 * `domain/money.ts`.
 *
 * They are two independent statements of the same fact, and a disagreement
 * would mis-scale every amount in that currency by a factor of ten or a
 * hundred. Refusing to start is the only safe response.
 */
export async function assertCurrencyTableMatchesMoneyModule(): Promise<void> {
  const rows = await prisma.currency.findMany({
    where: { isActive: true },
    select: { code: true, exponent: true },
  });

  const problems: string[] = [];

  for (const row of rows) {
    let expected: number;
    try {
      expected = currencyExponent(row.code);
    } catch {
      problems.push(`${row.code} is active but unknown to domain/money.ts`);
      continue;
    }

    if (expected !== row.exponent) {
      problems.push(
        `${row.code} has exponent ${String(row.exponent)} in the database but ` +
          `${String(expected)} in domain/money.ts`,
      );
    }
  }

  const baseCount = await prisma.currency.count({ where: { isBase: true } });
  if (baseCount > 1) {
    problems.push(`${String(baseCount)} currencies are flagged isBase; exactly one may be`);
  }

  if (problems.length > 0) {
    throw new Error(
      `refusing to start: currency configuration is inconsistent.\n  - ${problems.join('\n  - ')}`,
    );
  }
}
