/**
 * EU VAT reference data.
 *
 * > **Verify these rates before you trade.** Member states change VAT rates,
 * > and they do it with a few months' notice — Finland went to 25.5% in
 * > September 2024, Estonia to 24% in July 2025, Romania to 21% in August
 * > 2025. The figures below are a starting point so that a fresh EU
 * > deployment can price something on day one; they are not a live feed and
 * > nothing in this codebase can keep them current. Check yours against the
 * > Commission's published rates, and against your own accountant, before the
 * > first invoice goes out. The admin panel lets you correct any of them
 * > without a release.
 *
 * Three things about the shape of this data are deliberate.
 *
 *   - **Dated, not current.** Each row carries a `validFrom`, so correcting a
 *     rate is adding a row rather than overwriting one, and an invoice raised
 *     last year keeps the rate it was raised at. `validTo` is left null: the
 *     lookup takes the latest period that has started.
 *
 *   - **Only the bands that exist.** Denmark has no reduced rate at all;
 *     several states have no super-reduced band. A missing row is the correct
 *     representation of "this state does not have that band", and pricing
 *     refuses the sale rather than falling back to 0% — a silent zero would be
 *     an undercharge that only surfaces at an audit.
 *
 *   - **`isEuVat` is a flag, not a list.** The EU VAT area is not the same set
 *     as the EU: the Canary Islands are Spain and outside it, Livigno is Italy
 *     and outside it, Monaco is not the EU and is inside it for VAT purposes.
 *     A deployment that has to represent one of those cases should be able to
 *     do it in a row rather than a release.
 *
 * Idempotent, like the rest of the reference seed. Existing rows are updated
 * in place and nothing is deleted, so a rate an operator has corrected by hand
 * is not quietly overwritten with a stale default — see `seedVatReference`.
 */
import { newId } from '../infra/ids.js';
import { logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';

interface EuCountrySeed {
  code: string;
  name: string;
  currencyCode: string;
  phonePrefix: string;
  /** Standard rate. Every member state has one. */
  standard: string;
  /** Annex III bands, highest first. Empty where the state has none. */
  reduced?: string;
  /** The band a few states kept under Art. 98(2). */
  superReduced?: string;
}

/**
 * The twenty-seven, with their standard and reduced rates.
 *
 * Where a state operates two reduced bands only the higher is seeded: which of
 * the two a given product falls in is a classification question this software
 * cannot answer, and a catalogue manager who needs the lower one adds the row.
 */
const EU_MEMBER_STATES: readonly EuCountrySeed[] = [
  { code: 'AT', name: 'Austria', currencyCode: 'EUR', phonePrefix: '+43', standard: '20', reduced: '13' },
  { code: 'BE', name: 'Belgium', currencyCode: 'EUR', phonePrefix: '+32', standard: '21', reduced: '12' },
  { code: 'BG', name: 'Bulgaria', currencyCode: 'BGN', phonePrefix: '+359', standard: '20', reduced: '9' },
  { code: 'CY', name: 'Cyprus', currencyCode: 'EUR', phonePrefix: '+357', standard: '19', reduced: '9' },
  { code: 'CZ', name: 'Czechia', currencyCode: 'CZK', phonePrefix: '+420', standard: '21', reduced: '12' },
  // No reduced band at all. The absence is the data.
  { code: 'DK', name: 'Denmark', currencyCode: 'DKK', phonePrefix: '+45', standard: '25' },
  { code: 'DE', name: 'Germany', currencyCode: 'EUR', phonePrefix: '+49', standard: '19', reduced: '7' },
  { code: 'EE', name: 'Estonia', currencyCode: 'EUR', phonePrefix: '+372', standard: '24', reduced: '9' },
  { code: 'ES', name: 'Spain', currencyCode: 'EUR', phonePrefix: '+34', standard: '21', reduced: '10', superReduced: '4' },
  { code: 'FI', name: 'Finland', currencyCode: 'EUR', phonePrefix: '+358', standard: '25.5', reduced: '14' },
  { code: 'FR', name: 'France', currencyCode: 'EUR', phonePrefix: '+33', standard: '20', reduced: '10', superReduced: '2.1' },
  { code: 'GR', name: 'Greece', currencyCode: 'EUR', phonePrefix: '+30', standard: '24', reduced: '13' },
  { code: 'HR', name: 'Croatia', currencyCode: 'EUR', phonePrefix: '+385', standard: '25', reduced: '13' },
  { code: 'HU', name: 'Hungary', currencyCode: 'HUF', phonePrefix: '+36', standard: '27', reduced: '18' },
  { code: 'IE', name: 'Ireland', currencyCode: 'EUR', phonePrefix: '+353', standard: '23', reduced: '13.5', superReduced: '4.8' },
  { code: 'IT', name: 'Italy', currencyCode: 'EUR', phonePrefix: '+39', standard: '22', reduced: '10', superReduced: '4' },
  { code: 'LT', name: 'Lithuania', currencyCode: 'EUR', phonePrefix: '+370', standard: '21', reduced: '9' },
  { code: 'LU', name: 'Luxembourg', currencyCode: 'EUR', phonePrefix: '+352', standard: '17', reduced: '8', superReduced: '3' },
  { code: 'LV', name: 'Latvia', currencyCode: 'EUR', phonePrefix: '+371', standard: '21', reduced: '12' },
  { code: 'MT', name: 'Malta', currencyCode: 'EUR', phonePrefix: '+356', standard: '18', reduced: '7' },
  { code: 'NL', name: 'Netherlands', currencyCode: 'EUR', phonePrefix: '+31', standard: '21', reduced: '9' },
  { code: 'PL', name: 'Poland', currencyCode: 'PLN', phonePrefix: '+48', standard: '23', reduced: '8' },
  { code: 'PT', name: 'Portugal', currencyCode: 'EUR', phonePrefix: '+351', standard: '23', reduced: '13' },
  { code: 'RO', name: 'Romania', currencyCode: 'RON', phonePrefix: '+40', standard: '21', reduced: '11' },
  { code: 'SE', name: 'Sweden', currencyCode: 'SEK', phonePrefix: '+46', standard: '25', reduced: '12' },
  { code: 'SI', name: 'Slovenia', currencyCode: 'EUR', phonePrefix: '+386', standard: '22', reduced: '9.5' },
  { code: 'SK', name: 'Slovakia', currencyCode: 'EUR', phonePrefix: '+421', standard: '23', reduced: '19' },
];

/**
 * The date these figures are asserted from.
 *
 * Not `now()`: a rate row dated the day the seed happened to run would make
 * every historic order look as though it had been priced before any rate
 * existed. This is the start of the period the numbers above describe.
 */
const ASSERTED_FROM = new Date('2026-01-01T00:00:00.000Z');

interface RateSeed {
  countryCode: string;
  category: 'STANDARD' | 'REDUCED' | 'SUPER_REDUCED';
  ratePercent: string;
  label: string;
}

function ratesFor(state: EuCountrySeed): RateSeed[] {
  const rows: RateSeed[] = [
    {
      countryCode: state.code,
      category: 'STANDARD',
      ratePercent: state.standard,
      label: `${state.name} standard rate`,
    },
  ];

  if (state.reduced !== undefined) {
    rows.push({
      countryCode: state.code,
      category: 'REDUCED',
      ratePercent: state.reduced,
      label: `${state.name} reduced rate`,
    });
  }

  if (state.superReduced !== undefined) {
    rows.push({
      countryCode: state.code,
      category: 'SUPER_REDUCED',
      ratePercent: state.superReduced,
      label: `${state.name} super-reduced rate`,
    });
  }

  return rows;
}

export interface VatSeedResult {
  countriesFlagged: number;
  ratesCreated: number;
  ratesLeftAlone: number;
}

/**
 * Flag the member states and seed their rates.
 *
 * The countries themselves are upserted by `seedReferenceData`; this only sets
 * `isEuVat`, so the two can be read independently and neither has to know the
 * other's list.
 *
 * A rate that already exists for the same country, band and start date is
 * **left alone**. That is the important half of the idempotency: an operator
 * who corrected Finland by hand must not have the correction undone by the
 * next `npm run db:reference`. Correcting a rate deliberately means adding a
 * row with a later `validFrom`, which the lookup then prefers.
 */
export async function seedVatReference(): Promise<VatSeedResult> {
  let countriesFlagged = 0;

  for (const state of EU_MEMBER_STATES) {
    // `updateMany`, not `update`: a deployment whose country list has been
    // trimmed should skip the missing ones quietly rather than throw.
    const flagged = await prisma.country.updateMany({
      where: { code: state.code },
      data: { isEuVat: true },
    });

    countriesFlagged += flagged.count;
  }

  let ratesCreated = 0;
  let ratesLeftAlone = 0;

  for (const state of EU_MEMBER_STATES) {
    for (const rate of ratesFor(state)) {
      const existing = await prisma.vatRate.findUnique({
        where: {
          countryCode_category_validFrom: {
            countryCode: rate.countryCode,
            category: rate.category,
            validFrom: ASSERTED_FROM,
          },
        },
        select: { id: true },
      });

      if (existing !== null) {
        ratesLeftAlone += 1;
        continue;
      }

      await prisma.vatRate.create({
        data: {
          id: newId(),
          countryCode: rate.countryCode,
          category: rate.category,
          ratePercent: rate.ratePercent,
          label: rate.label,
          validFrom: ASSERTED_FROM,
        },
      });

      ratesCreated += 1;
    }
  }

  logger.info(
    { countriesFlagged, ratesCreated, ratesLeftAlone },
    'EU VAT reference data seeded - VERIFY THESE RATES before trading',
  );

  return { countriesFlagged, ratesCreated, ratesLeftAlone };
}

/** The member states this seed knows about, for the country seed to include. */
export const EU_COUNTRY_SEEDS: readonly {
  code: string;
  name: string;
  currencyCode: string;
  phonePrefix: string;
}[] = EU_MEMBER_STATES.map((state) => ({
  code: state.code,
  name: state.name,
  currencyCode: state.currencyCode,
  phonePrefix: state.phonePrefix,
}));
