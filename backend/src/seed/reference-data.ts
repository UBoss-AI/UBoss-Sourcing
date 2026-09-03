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
const COUNTRIES: readonly CountrySeed[] = [
  { code: 'IN', name: 'India', currencyCode: 'INR', phonePrefix: '+91', sortOrder: 1 },

  { code: 'AE', name: 'United Arab Emirates', currencyCode: 'AED', phonePrefix: '+971' },
  { code: 'AT', name: 'Austria', currencyCode: 'EUR', phonePrefix: '+43' },
  { code: 'AU', name: 'Australia', currencyCode: 'USD', phonePrefix: '+61' },
  { code: 'BE', name: 'Belgium', currencyCode: 'EUR', phonePrefix: '+32' },
  { code: 'CA', name: 'Canada', currencyCode: 'USD', phonePrefix: '+1' },
  { code: 'DE', name: 'Germany', currencyCode: 'EUR', phonePrefix: '+49' },
  { code: 'ES', name: 'Spain', currencyCode: 'EUR', phonePrefix: '+34' },
  { code: 'FR', name: 'France', currencyCode: 'EUR', phonePrefix: '+33' },
  { code: 'GB', name: 'United Kingdom', currencyCode: 'GBP', phonePrefix: '+44' },
  { code: 'IE', name: 'Ireland', currencyCode: 'EUR', phonePrefix: '+353' },
  { code: 'IT', name: 'Italy', currencyCode: 'EUR', phonePrefix: '+39' },
  { code: 'JP', name: 'Japan', currencyCode: 'JPY', phonePrefix: '+81' },
  { code: 'KR', name: 'South Korea', currencyCode: 'KRW', phonePrefix: '+82' },
  { code: 'MY', name: 'Malaysia', currencyCode: 'SGD', phonePrefix: '+60' },
  { code: 'NL', name: 'Netherlands', currencyCode: 'EUR', phonePrefix: '+31' },
  { code: 'NZ', name: 'New Zealand', currencyCode: 'USD', phonePrefix: '+64' },
  { code: 'OM', name: 'Oman', currencyCode: 'AED', phonePrefix: '+968' },
  { code: 'QA', name: 'Qatar', currencyCode: 'AED', phonePrefix: '+974' },
  { code: 'SA', name: 'Saudi Arabia', currencyCode: 'AED', phonePrefix: '+966' },
  { code: 'SG', name: 'Singapore', currencyCode: 'SGD', phonePrefix: '+65' },
  { code: 'US', name: 'United States', currencyCode: 'USD', phonePrefix: '+1' },
];

export async function seedReferenceData(): Promise<{
  currencies: number;
  countries: number;
  backfilledPrices: number;
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

  const base = CURRENCIES.find((currency) => currency.isBase === true)?.code ?? 'INR';
  const backfilledPrices = await backfillBaseCurrencyPrices(base);

  return {
    currencies: CURRENCIES.length,
    countries: COUNTRIES.length,
    backfilledPrices,
  };
}
