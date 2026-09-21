/**
 * Exchange-rate arithmetic and provider parsing.
 *
 * The failures these catch are the expensive kind: silent, plausible-looking
 * and catalogue-wide. A cross-rate computed the wrong way round misprices a
 * whole market by the square of the rate; a float in the margin drifts a
 * fraction of a percent that nobody notices until a reconciliation; a stale
 * rate that passes a freshness check takes money at a number that cannot be
 * explained afterwards.
 */
import { describe, expect, it } from 'vitest';
import {
  FxError,
  QUOTE_DP,
  applyAdjustment,
  crossRate,
  formatRate,
  isFreshEnough,
  isUsableRate,
  parseRate,
  rateAgeMs,
  resolveRate,
  type FreshnessPolicy,
  type RateSet,
} from '../../src/domain/fx.js';
import { convert, conversionFor } from '../../src/modules/catalog/bulk-price.service.js';
import { parseEcbDaily } from '../../src/modules/settings/fx/provider.ecb.js';
import { parseJsonFeed } from '../../src/modules/settings/fx/provider.json.js';
import { RateProviderError } from '../../src/modules/settings/fx/provider.js';
import { validateRateSet } from '../../src/modules/settings/fx-snapshot.service.js';

/**
 * A euro-pivoted set, the shape the European Central Bank publishes.
 *
 * The numbers are plausible rather than real; nothing here asserts what a
 * currency is worth, only that the arithmetic over it is right.
 */
const ASOF = new Date('2026-09-18T00:00:00.000Z');

function euroSet(overrides: Record<string, string> = {}): RateSet {
  return {
    pivotCurrency: 'EUR',
    asOf: ASOF,
    provider: 'ecb',
    snapshotId: 'snap-1',
    rates: new Map(
      Object.entries({
        USD: '1.100000000000',
        INR: '92.400000000000',
        PLN: '4.400000000000',
        JPY: '160.000000000000',
        ...overrides,
      }),
    ),
  };
}

/** The shipped defaults, which these tests are partly here to justify. */
const POLICY: FreshnessPolicy = {
  displayMaxAgeMs: 168 * 3_600_000,
  checkoutMaxAgeMs: 96 * 3_600_000,
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parseRate', () => {
  it('keeps twelve places exactly', () => {
    expect(formatRate(parseRate('1.000000000001'))).toBe('1.000000000001');
    expect(formatRate(parseRate('92.4'))).toBe('92.400000000000');
  });

  it('refuses anything that is not a plain positive decimal', () => {
    // Each of these has been seen from a real feed or a real misconfiguration:
    // a European decimal comma, exponent notation, a negative, a zero, and an
    // HTML error page that reached the parser as text.
    for (const bad of ['1,05', '1e-3', '-1.05', '0', '0.000000000000', '<html>', '', ' ']) {
      expect(() => parseRate(bad), bad).toThrow(FxError);
    }
  });

  it('answers isUsableRate without throwing', () => {
    expect(isUsableRate('1.05')).toBe(true);
    expect(isUsableRate('1,05')).toBe(false);
    expect(isUsableRate(1.05)).toBe(false);
    expect(isUsableRate(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross rates
// ---------------------------------------------------------------------------

describe('crossRate', () => {
  it('returns exactly one for the same currency, without a lookup', () => {
    // Note the currency is not even in the set: identity must never depend on
    // the feed quoting it.
    const set = euroSet();
    expect(crossRate('AED', 'AED', set)).toBe('1.000000000000');
    expect(crossRate('EUR', 'EUR', set)).toBe('1.000000000000');
  });

  it('reads a pivot-quoted pair straight off the set', () => {
    expect(crossRate('EUR', 'USD', euroSet())).toBe('1.100000000000');
  });

  it('inverts for a pair quoted the other way round', () => {
    // 1 / 1.1 = 0.909090909090..., half-up at twelve places.
    expect(crossRate('USD', 'EUR', euroSet())).toBe('0.909090909091');
  });

  it('crosses two non-pivot currencies through the pivot', () => {
    // PLN -> INR = (EUR->INR) / (EUR->PLN) = 92.4 / 4.4 = 21 exactly.
    expect(crossRate('PLN', 'INR', euroSet())).toBe('21.000000000000');
  });

  it('crosses USD -> INR through the euro', () => {
    // 92.4 / 1.1 = 84 exactly.
    expect(crossRate('USD', 'INR', euroSet())).toBe('84.000000000000');
  });

  it('keeps a pair and its reciprocal consistent', () => {
    const set = euroSet();
    const forward = parseRate(crossRate('PLN', 'USD', set));
    const backward = parseRate(crossRate('USD', 'PLN', set));

    // forward * backward should be 1 to within one unit at the last place.
    const product = (forward * backward) / 10n ** 12n;
    const one = 10n ** 12n;
    const drift = product > one ? product - one : one - product;

    expect(drift <= 1n).toBe(true);
  });

  it('is case-insensitive about currency codes', () => {
    expect(crossRate('pln', 'inr', euroSet())).toBe('21.000000000000');
  });

  it('refuses a pair the provider does not quote', () => {
    // The ECB has never quoted the dirham and is not going to start.
    expect(() => crossRate('EUR', 'AED', euroSet())).toThrow(FxError);

    try {
      crossRate('EUR', 'AED', euroSet());
    } catch (error) {
      expect((error as FxError).reason).toBe('PAIR_NOT_QUOTED');
    }
  });

  it('refuses a set carrying a malformed rate rather than skipping it', () => {
    const set = euroSet({ PLN: 'not-a-rate' });
    expect(() => crossRate('EUR', 'PLN', set)).toThrow(FxError);
  });
});

// ---------------------------------------------------------------------------
// Adjustment
// ---------------------------------------------------------------------------

describe('applyAdjustment', () => {
  it('is the identity at zero', () => {
    expect(applyAdjustment('92.400000000000', '0.00')).toBe('92.400000000000');
  });

  it('applies a positive spread exactly', () => {
    // 92.4 * 1.025 = 94.71
    expect(applyAdjustment('92.400000000000', '2.50')).toBe('94.710000000000');
  });

  it('applies a negative adjustment', () => {
    // 100 * 0.985 = 98.5
    expect(applyAdjustment('100.000000000000', '-1.50')).toBe('98.500000000000');
  });

  it('does not lose precision the way the float version did', () => {
    // The implementation this replaced did Math.round(Number(percent) * 100).
    // 1.15 * 100 is 114.99999999999999 as a double, so Math.round saved it -
    // but only by luck, and the exactness is what is being asserted here:
    // 200 * 1.0115 = 202.3 with no trailing drift at the twelfth place.
    expect(applyAdjustment('200.000000000000', '1.15')).toBe('202.300000000000');
  });

  it('refuses an adjustment that would erase the rate', () => {
    expect(() => applyAdjustment('1.000000000000', '-100.00')).toThrow(FxError);
  });

  it('refuses a percentage that is not a plain decimal', () => {
    expect(() => applyAdjustment('1.000000000000', '2,5')).toThrow(FxError);
  });
});

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

describe('freshness', () => {
  // The whole point of this block. A snapshot is dated from the provider's own
  // document, and the ECB dates by the day, read here as midnight UTC. So an
  // ordinary weekend is much longer than it feels, and the shipped windows are
  // sized against these numbers rather than against intuition.
  const friday = new Date('2026-09-18T00:00:00.000Z');

  it('still prices AND still takes money on a Monday morning', () => {
    // Friday 00:00 -> Monday 09:00 is 81 hours, not the ~50 a weekend feels
    // like. A 72 hour window - the number that looks right - would blank every
    // derived price and refuse every derived checkout, every Monday.
    const mondayMorning = new Date('2026-09-21T09:00:00.000Z');
    expect(Math.round(rateAgeMs(friday, mondayMorning) / 3_600_000)).toBe(81);

    expect(isFreshEnough(friday, 'display', POLICY, mondayMorning)).toBe(true);
    expect(isFreshEnough(friday, 'checkout', POLICY, mondayMorning)).toBe(true);
  });

  it('still takes money on a Monday evening, which is the tightest case', () => {
    // 90 hours. This is the number the 96 hour checkout window exists to
    // clear; anything less breaks derived-currency checkout every weekend.
    const mondayEvening = new Date('2026-09-21T18:00:00.000Z');
    expect(Math.round(rateAgeMs(friday, mondayEvening) / 3_600_000)).toBe(90);

    expect(isFreshEnough(friday, 'checkout', POLICY, mondayEvening)).toBe(true);
  });

  it('stops taking money once the feed has genuinely been quiet for days', () => {
    // By Wednesday the weekend excuse has run out: a live feed would have
    // published twice by now, so this is an outage and checkout must refuse.
    const wednesday = new Date('2026-09-23T09:00:00.000Z');

    expect(isFreshEnough(friday, 'checkout', POLICY, wednesday)).toBe(false);
    // The catalogue keeps showing marked-approximate figures a while longer.
    expect(isFreshEnough(friday, 'display', POLICY, wednesday)).toBe(true);
  });

  it('does not pretend a weekend took no time', () => {
    // A feed that stopped publishing on Friday must eventually look stale.
    // Excusing the weekend would leave a dead feed looking healthy on Monday,
    // which is precisely the failure this check exists to catch.
    const tenDaysLater = new Date('2026-09-28T09:00:00.000Z');
    expect(isFreshEnough(friday, 'display', POLICY, tenDaysLater)).toBe(false);
  });

  it('never reports a negative age for a rate dated in the future', () => {
    const future = new Date('2026-09-25T00:00:00.000Z');
    expect(rateAgeMs(future, new Date('2026-09-20T00:00:00.000Z'))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveRate
// ---------------------------------------------------------------------------

describe('resolveRate', () => {
  const now = new Date('2026-09-18T06:00:00.000Z');

  it('reports the mid rate and the adjusted rate separately', () => {
    const resolved = resolveRate('EUR', 'PLN', euroSet(), {
      purpose: 'checkout',
      policy: POLICY,
      adjustmentPercent: '2.00',
      now,
    });

    expect(resolved.midRate).toBe('4.40000000');
    expect(resolved.rate).toBe('4.48800000');
    expect(resolved.adjustmentPercent).toBe('2.00');
    expect(resolved.snapshotId).toBe('snap-1');
    expect(resolved.provider).toBe('ecb');
    expect(resolved.pivotCurrency).toBe('EUR');
  });

  it('quotes to eight places, which is what conversionFor accepts', () => {
    const resolved = resolveRate('USD', 'EUR', euroSet(), {
      purpose: 'display',
      policy: POLICY,
      now,
    });

    expect(resolved.rate.split('.')[1]).toHaveLength(QUOTE_DP);
  });

  it('never charges a spread on a currency converted to itself', () => {
    const resolved = resolveRate('PLN', 'PLN', euroSet(), {
      purpose: 'checkout',
      policy: POLICY,
      adjustmentPercent: '5.00',
      now,
    });

    expect(resolved.rate).toBe('1.00000000');
    expect(resolved.adjustmentPercent).toBe('0.00');
  });

  it('refuses a stale set for checkout while still allowing display', () => {
    const late = new Date('2026-09-23T12:00:00.000Z');

    expect(() =>
      resolveRate('EUR', 'PLN', euroSet(), { purpose: 'checkout', policy: POLICY, now: late }),
    ).toThrow(FxError);

    expect(
      resolveRate('EUR', 'PLN', euroSet(), { purpose: 'display', policy: POLICY, now: late }).rate,
    ).toBe('4.40000000');
  });

  it('reports RATE_TOO_OLD rather than a generic failure', () => {
    const late = new Date('2026-10-30T12:00:00.000Z');

    try {
      resolveRate('EUR', 'PLN', euroSet(), { purpose: 'display', policy: POLICY, now: late });
      expect.unreachable('a stale set must not resolve');
    } catch (error) {
      expect((error as FxError).reason).toBe('RATE_TOO_OLD');
    }
  });
});

// ---------------------------------------------------------------------------
// End to end: a rate turning into money
// ---------------------------------------------------------------------------

describe('a resolved rate priced through the existing conversion', () => {
  const now = new Date('2026-09-18T06:00:00.000Z');

  /** What the storefront does: resolve, then convert with the shared helper. */
  function priceIn(target: string, amount: bigint, rounding: 'exact' | 'whole' | 'charm') {
    const resolved = resolveRate('EUR', target, euroSet(), {
      purpose: 'display',
      policy: POLICY,
      now,
    });

    return convert(
      amount,
      conversionFor({
        sourceCurrency: 'EUR',
        targetCurrency: target,
        rate: resolved.rate,
        rounding,
      }),
    );
  }

  it('converts EUR 10.00 to INR 924.00 exactly', () => {
    expect(priceIn('INR', 1_000n, 'exact')).toBe(92_400n);
  });

  it('handles a zero-decimal currency without inventing minor units', () => {
    // EUR 10.00 at 160 JPY/EUR is JPY 1600, and JPY has no minor unit.
    expect(priceIn('JPY', 1_000n, 'exact')).toBe(1_600n);
  });

  it('collapses charm pricing to whole units in a zero-decimal currency', () => {
    // There is no .99 yen to land on, so charm must not produce 1599.
    expect(priceIn('JPY', 1_000n, 'charm')).toBe(1_600n);
  });

  it('converts zero to zero in every currency', () => {
    expect(priceIn('INR', 0n, 'exact')).toBe(0n);
    expect(priceIn('JPY', 0n, 'exact')).toBe(0n);
  });

  it('stays exact on an amount far past Number.MAX_SAFE_INTEGER', () => {
    // 90,071,992,547,409.91 EUR in cents - deliberately past 2^53 minor units,
    // which is where a float implementation starts silently losing rupees.
    const huge = 9_007_199_254_740_991n;
    expect(priceIn('INR', huge, 'exact')).toBe((huge * 924n) / 10n);
  });
});

// ---------------------------------------------------------------------------
// Provider parsing
// ---------------------------------------------------------------------------

const ECB_DOCUMENT = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <gesmes:Sender><gesmes:name>European Central Bank</gesmes:name></gesmes:Sender>
  <Cube>
    <Cube time='2026-09-18'>
      <Cube currency='USD' rate='1.1000'/>
      <Cube currency='INR' rate='92.4000'/>
      <Cube currency='PLN' rate='4.4000'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

describe('the ECB reader', () => {
  it('reads the daily document', () => {
    const set = parseEcbDaily(ECB_DOCUMENT, 'https://example.test/daily.xml');

    expect(set.provider).toBe('ecb');
    expect(set.pivotCurrency).toBe('EUR');
    expect(set.asOf.toISOString()).toBe('2026-09-18T00:00:00.000Z');
    expect(set.rates.get('INR')).toBe('92.4000');
    expect(set.rates.size).toBe(3);
    expect(set.sourceReference).toContain('2026-09-18');
  });

  it('dates the set from the document, never from the clock', () => {
    // The feature that makes weekend behaviour correct. Fetching on Sunday
    // must produce a set that admits it is Friday's.
    const set = parseEcbDaily(ECB_DOCUMENT, 'x');
    expect(set.asOf.getTime()).toBeLessThan(Date.now());
  });

  it('reads attributes written with double quotes', () => {
    const doubled = ECB_DOCUMENT.replace(/'/g, '"');
    expect(parseEcbDaily(doubled, 'x').rates.get('USD')).toBe('1.1000');
  });

  it('takes the first date when handed the historical multi-day document', () => {
    const historical = `<Cube>
      <Cube time='2026-09-18'><Cube currency='USD' rate='1.1000'/></Cube>
      <Cube time='2026-09-17'><Cube currency='USD' rate='1.0900'/></Cube>
    </Cube>`;

    expect(parseEcbDaily(historical, 'x').asOf.toISOString()).toBe('2026-09-18T00:00:00.000Z');
  });

  it('refuses a document that declares a DTD or an entity', () => {
    const hostile = `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${ECB_DOCUMENT}`;
    expect(() => parseEcbDaily(hostile, 'x')).toThrow(RateProviderError);
  });

  it('refuses a document with no date', () => {
    const undated = `<Cube><Cube><Cube currency='USD' rate='1.10'/></Cube></Cube>`;
    expect(() => parseEcbDaily(undated, 'x')).toThrow(RateProviderError);
  });

  it('refuses an HTML error page that reached the reader', () => {
    expect(() => parseEcbDaily('<html><body>503</body></html>', 'x')).toThrow(RateProviderError);
  });

  it('drops an unusable row and counts it rather than failing the fetch', () => {
    const partly = ECB_DOCUMENT.replace("rate='4.4000'", "rate='N/A'");
    const set = parseEcbDaily(partly, 'x');

    expect(set.rates.has('PLN')).toBe(false);
    expect(set.rates.size).toBe(2);
    expect(set.rejectedCount).toBe(1);
  });

  it('refuses a document whose every row is unusable', () => {
    const broken = ECB_DOCUMENT.replace(/rate='[\d.]+'/g, "rate='N/A'");
    expect(() => parseEcbDaily(broken, 'x')).toThrow(RateProviderError);
  });
});

describe('the JSON reader', () => {
  it('reads the common envelope', () => {
    const set = parseJsonFeed(
      JSON.stringify({ base: 'EUR', date: '2026-09-18', rates: { USD: 1.1, INR: 92.4 } }),
      'EUR',
      'https://example.test',
    );

    expect(set.pivotCurrency).toBe('EUR');
    expect(set.rates.get('USD')).toBe('1.100000000000');
    expect(set.asOf.toISOString().slice(0, 10)).toBe('2026-09-18');
  });

  it('drops a rate that is not a positive finite number', () => {
    const set = parseJsonFeed(
      JSON.stringify({ base: 'EUR', rates: { USD: 1.1, INR: 0, PLN: -4.4, JPY: null } }),
      'EUR',
      'x',
    );

    expect([...set.rates.keys()]).toEqual(['USD']);
    expect(set.rejectedCount).toBe(3);
  });

  it('ignores a key that is not a currency code', () => {
    const set = parseJsonFeed(
      JSON.stringify({ base: 'EUR', rates: { USD: 1.1, 'DROP TABLE': 1, XXXX: 2 } }),
      'EUR',
      'x',
    );

    expect([...set.rates.keys()]).toEqual(['USD']);
  });

  it('refuses a body that is not JSON', () => {
    expect(() => parseJsonFeed('<html>502</html>', 'EUR', 'x')).toThrow(RateProviderError);
  });

  it('refuses a body with no rates object', () => {
    expect(() => parseJsonFeed(JSON.stringify({ base: 'EUR' }), 'EUR', 'x')).toThrow(
      RateProviderError,
    );
  });

  it('refuses a rates object with nothing usable in it', () => {
    expect(() => parseJsonFeed(JSON.stringify({ rates: { USD: 'x' } }), 'EUR', 'x')).toThrow(
      RateProviderError,
    );
  });
});

// ---------------------------------------------------------------------------
// Validation before activation
// ---------------------------------------------------------------------------

describe('validateRateSet', () => {
  const candidate = {
    provider: 'ecb',
    pivotCurrency: 'EUR',
    asOf: new Date('2026-09-18T00:00:00.000Z'),
    rates: new Map([
      ['USD', '1.100000000000'],
      ['INR', '92.400000000000'],
      ['PLN', '4.400000000000'],
    ]),
    sourceReference: 'x',
    rejectedCount: 0,
  };

  const previous = new Map([
    ['USD', '1.090000000000'],
    ['INR', '92.000000000000'],
    ['PLN', '4.390000000000'],
  ]);

  it('accepts the first set, having nothing to compare against', () => {
    const verdict = validateRateSet(candidate, {
      requiredCurrencies: ['EUR', 'INR'],
      previous: null,
      previousAsOf: null,
      maxDriftPercent: '15.00',
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.maxDriftPercent).toBeNull();
  });

  it('accepts an ordinary daily move and reports the largest', () => {
    const verdict = validateRateSet(candidate, {
      requiredCurrencies: ['EUR', 'INR', 'PLN'],
      previous,
      previousAsOf: new Date('2026-09-17T00:00:00.000Z'),
      maxDriftPercent: '15.00',
    });

    expect(verdict.ok).toBe(true);
    // USD moved 1.09 -> 1.10, about 0.917%.
    expect(verdict.maxDriftCurrency).toBe('USD');
    expect(Number(verdict.maxDriftPercent)).toBeCloseTo(0.9174, 3);
  });

  it('refuses a decimal shift, which is what the drift guard is for', () => {
    const shifted = {
      ...candidate,
      rates: new Map([...candidate.rates, ['INR', '924.000000000000']]),
    };

    const verdict = validateRateSet(shifted, {
      requiredCurrencies: ['EUR', 'INR'],
      previous,
      previousAsOf: new Date('2026-09-17T00:00:00.000Z'),
      maxDriftPercent: '15.00',
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('INR');
    expect(verdict.maxDriftCurrency).toBe('INR');
  });

  it('refuses a feed that quotes none of the currencies in use', () => {
    const verdict = validateRateSet(candidate, {
      requiredCurrencies: ['EUR', 'AED', 'SGD'],
      previous: null,
      previousAsOf: null,
      maxDriftPercent: '15.00',
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('wrong feed');
  });

  it('tolerates one uncovered currency, which is an ordinary gap', () => {
    // The ECB does not quote AED. That market keeps its manual prices; it is
    // not a reason to refuse the whole list.
    const verdict = validateRateSet(candidate, {
      requiredCurrencies: ['EUR', 'INR', 'AED'],
      previous: null,
      previousAsOf: null,
      maxDriftPercent: '15.00',
    });

    expect(verdict.ok).toBe(true);
  });

  it('refuses a document older than the one already live', () => {
    const verdict = validateRateSet(candidate, {
      requiredCurrencies: ['EUR', 'INR'],
      previous,
      previousAsOf: new Date('2026-09-19T00:00:00.000Z'),
      maxDriftPercent: '15.00',
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('older');
  });

  it('ignores a currency the previous set did not carry', () => {
    // A newly quoted currency has no "before", so it cannot have drifted.
    const withNew = {
      ...candidate,
      rates: new Map([...candidate.rates, ['CZK', '25.000000000000']]),
    };

    const verdict = validateRateSet(withNew, {
      requiredCurrencies: ['EUR', 'CZK'],
      previous,
      previousAsOf: new Date('2026-09-17T00:00:00.000Z'),
      maxDriftPercent: '15.00',
    });

    expect(verdict.ok).toBe(true);
  });
});
