/**
 * Currency and country reference data.
 *
 * Unlike `seed/index.ts` this is not development-only: a production deployment
 * needs these rows too, because the storefront cannot price anything without
 * them. It is idempotent and safe to re-run — existing rows are updated in
 * place, and nothing is ever deleted, so a currency staff have deactivated on
 * purpose stays deactivated.
 *
 * Every currency here must also appear in `domain/money.ts` CURRENCY_EXPONENT.
 * `assertCurrencyTableMatchesMoneyModule` refuses to boot if the two disagree,
 * because a wrong exponent mis-scales every amount by a factor of a hundred.
 */
import { currencyExponent } from '../domain/money.js';
import { prisma } from '../infra/prisma.js';
import { backfillBaseCurrencyPrices } from '../modules/catalog/price.service.js';
import { EU_COUNTRY_SEEDS, seedVatReference } from './vat-reference.js';

interface CurrencySeed {
  code: string;
  name: string;
  symbol: string;
  isBase?: boolean;
  sortOrder: number;
}

const CURRENCIES: readonly CurrencySeed[] = [
  { code: 'INR', name: 'Indian Rupee', symbol: '₹', isBase: true, sortOrder: 10 },
  { code: 'USD', name: 'US Dollar', symbol: '$', sortOrder: 20 },
  { code: 'EUR', name: 'Euro', symbol: '€', sortOrder: 30 },
  { code: 'GBP', name: 'Pound Sterling', symbol: '£', sortOrder: 40 },
  { code: 'AED', name: 'UAE Dirham', symbol: 'AED', sortOrder: 50 },
  { code: 'SGD', name: 'Singapore Dollar', symbol: 'S$', sortOrder: 60 },
  // The seven EU member states outside the euro, seeded together.
  //
  // Selling into the EU means selling into all twenty-seven, and a Swedish
  // hospital quoted in euro because SEK was missing from this list is not a
  // rounding problem - it is a price the buyer cannot reconcile against their
  // own budget. Each of these must also appear in domain/money.ts
  // CURRENCY_EXPONENT, which refuses to boot if the two disagree.
  { code: 'PLN', name: 'Polish Złoty', symbol: 'zł', sortOrder: 65 },
  { code: 'BGN', name: 'Bulgarian Lev', symbol: 'лв', sortOrder: 66 },
  { code: 'CZK', name: 'Czech Koruna', symbol: 'Kč', sortOrder: 67 },
  { code: 'DKK', name: 'Danish Krone', symbol: 'kr', sortOrder: 68 },
  { code: 'HUF', name: 'Hungarian Forint', symbol: 'Ft', sortOrder: 69 },
  { code: 'RON', name: 'Romanian Leu', symbol: 'lei', sortOrder: 70 },
  { code: 'SEK', name: 'Swedish Krona', symbol: 'kr', sortOrder: 71 },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥', sortOrder: 70 },
  { code: 'KRW', name: 'South Korean Won', symbol: '₩', sortOrder: 80 },
];

interface CountrySeed {
  code: string;
  name: string;
  currencyCode: string;
  phonePrefix: string;
  sortOrder?: number;
}

/**
 * The markets this deployment quotes in. Sort order puts the home market first;
 * everything else is alphabetical by name.
 */
/** Markets outside the EU VAT area. The twenty-seven come from the VAT seed. */
const NON_EU_COUNTRIES: readonly CountrySeed[] = [
  { code: 'IN', name: 'India', currencyCode: 'INR', phonePrefix: '+91', sortOrder: 1 },

  { code: 'AE', name: 'United Arab Emirates', currencyCode: 'AED', phonePrefix: '+971' },
  { code: 'AU', name: 'Australia', currencyCode: 'USD', phonePrefix: '+61' },
  { code: 'CA', name: 'Canada', currencyCode: 'USD', phonePrefix: '+1' },
  { code: 'CH', name: 'Switzerland', currencyCode: 'EUR', phonePrefix: '+41' },
  { code: 'GB', name: 'United Kingdom', currencyCode: 'GBP', phonePrefix: '+44' },
  { code: 'JP', name: 'Japan', currencyCode: 'JPY', phonePrefix: '+81' },
  { code: 'KR', name: 'South Korea', currencyCode: 'KRW', phonePrefix: '+82' },
  { code: 'MY', name: 'Malaysia', currencyCode: 'SGD', phonePrefix: '+60' },
  { code: 'NO', name: 'Norway', currencyCode: 'EUR', phonePrefix: '+47' },
  { code: 'NZ', name: 'New Zealand', currencyCode: 'USD', phonePrefix: '+64' },
  { code: 'OM', name: 'Oman', currencyCode: 'AED', phonePrefix: '+968' },
  { code: 'QA', name: 'Qatar', currencyCode: 'AED', phonePrefix: '+974' },
  { code: 'SA', name: 'Saudi Arabia', currencyCode: 'AED', phonePrefix: '+966' },
  { code: 'SG', name: 'Singapore', currencyCode: 'SGD', phonePrefix: '+65' },
  { code: 'US', name: 'United States', currencyCode: 'USD', phonePrefix: '+1' },
];

/**
 * Every market, sorted with the home market first and the rest by name.
 *
 * The EU-27 are taken from `vat-reference.ts` rather than listed again here.
 * Two lists of member states is one list too many: the day they disagree, a
 * country is sellable with no VAT rate behind it, and pricing refuses the sale
 * for a reason nobody can find.
 */
const COUNTRIES: readonly CountrySeed[] = [
  ...NON_EU_COUNTRIES,
  // The member states carry no sortOrder of their own - they are alphabetical
  // among the rest, behind the home market.
  ...EU_COUNTRY_SEEDS.map((state): CountrySeed => ({ ...state })),
].sort((a, b) => (a.sortOrder ?? 100) - (b.sortOrder ?? 100) || a.name.localeCompare(b.name));

export async function seedReferenceData(): Promise<{
  currencies: number;
  countries: number;
  backfilledPrices: number;
  vatRates: number;
}> {
  for (const currency of CURRENCIES) {
    // Throws if money.ts does not know this code, which is the point: a
    // currency the arithmetic cannot handle must never reach the database.
    const exponent = currencyExponent(currency.code);

    await prisma.currency.upsert({
      where: { code: currency.code },
      // isActive is deliberately absent from `update`: staff may have retired a
      // currency, and re-running the seed must not quietly bring it back.
      update: {
        name: currency.name,
        symbol: currency.symbol,
        exponent,
        isBase: currency.isBase ?? false,
        sortOrder: currency.sortOrder,
      },
      create: {
        code: currency.code,
        name: currency.name,
        symbol: currency.symbol,
        exponent,
        isBase: currency.isBase ?? false,
        sortOrder: currency.sortOrder,
      },
    });
  }

  for (const [index, country] of COUNTRIES.entries()) {
    const sortOrder = country.sortOrder ?? 100 + index;

    await prisma.country.upsert({
      where: { code: country.code },
      update: {
        name: country.name,
        currencyCode: country.currencyCode,
        phonePrefix: country.phonePrefix,
        sortOrder,
      },
      create: {
        code: country.code,
        name: country.name,
        currencyCode: country.currencyCode,
        phonePrefix: country.phonePrefix,
        sortOrder,
      },
    });
  }

  // Flags the twenty-seven and seeds their standard and reduced rates. Runs
  // after the countries exist, because it only sets `isEuVat` on rows the
  // loop above has already created.
  //
  // The rates it writes are a starting point and NOT a live feed - see the
  // warning at the top of vat-reference.ts. A deployment must verify them
  // before it invoices anything.
  const vat = await seedVatReference();

  const base = CURRENCIES.find((currency) => currency.isBase === true)?.code ?? 'INR';
  const backfilledPrices = await backfillBaseCurrencyPrices(base);

  return {
    currencies: CURRENCIES.length,
    countries: COUNTRIES.length,
    backfilledPrices,
    vatRates: vat.ratesCreated,
  };
}
