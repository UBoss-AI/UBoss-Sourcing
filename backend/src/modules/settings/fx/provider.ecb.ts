/**
 * The European Central Bank's daily reference rates.
 *
 * WHAT THESE RATES ARE, EXACTLY
 *
 * The ECB publishes one list a working day, at around 16:00 CET, of euro
 * foreign-exchange *reference* rates. Its own description is the important
 * part, and it is repeated on the settings screen rather than buried here:
 * they are published for information purposes, they are not intended to be
 * used for transactions, and they are not a rate anybody is obliged to trade
 * at. A deployment that shows a converted catalogue price from them is doing
 * exactly what they are for. A deployment that tells a customer this is the
 * rate their bank will settle at is not, and no amount of code here can make
 * that true - which is why `fx-snapshot.service.ts` records the provider on
 * every snapshot and the storefront marks a converted figure as approximate.
 *
 * THREE CONSEQUENCES OF THE FEED'S SHAPE
 *
 *   - **It is EUR-based and only EUR-based.** There is no `?base=PLN`. Every
 *     other pair is a cross-rate through the euro, which is why `domain/fx.ts`
 *     has a pivot at all rather than just a lookup.
 *   - **It publishes on TARGET working days.** No Saturday, no Sunday, no
 *     Christmas Day. A fetch on a Sunday legitimately returns Friday's list
 *     with Friday's date, and the freshness windows are sized for that. This
 *     provider never rewrites `asOf` to now - a two-day-old rate that claims
 *     to be current is worse than one that admits its age.
 *   - **It is a fixed list of about thirty currencies.** AED and SGD-adjacent
 *     markets a deployment may sell in are simply not in it. That surfaces as
 *     `PAIR_NOT_QUOTED` and a manual price, not as a guess.
 *
 * WHY THERE IS NO XML LIBRARY HERE
 *
 * The document is a fixed, documented three-level shape that has not changed in
 * twenty years, and a targeted extraction over it cannot expand an external
 * entity, resolve a DTD or follow a billion-laughs expansion - because it never
 * interprets any of those constructs. A general parser pulled in for one feed
 * would add that attack surface to gain nothing. The document is rejected
 * outright if it declares a DOCTYPE or an ENTITY, so a feed that started
 * sending one fails loudly rather than being quietly half-read.
 */
import {
  fetchWithTimeout,
  sanitiseRates,
  RateProviderError,
  type ProviderRateSet,
  type RateProvider,
} from './provider.js';

const PIVOT = 'EUR';

/** `<Cube currency='USD' rate='1.0812'/>`, in either attribute order. */
const CUBE_RATE = /<Cube\s+([^>]*?)\/?>/gi;
const ATTRIBUTE = /([A-Za-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attributesOf(fragment: string): Map<string, string> {
  const attributes = new Map<string, string>();
  ATTRIBUTE.lastIndex = 0;

  let match: RegExpExecArray | null = ATTRIBUTE.exec(fragment);
  while (match !== null) {
    const [, name = '', doubleQuoted, singleQuoted] = match;
    attributes.set(name.toLowerCase(), doubleQuoted ?? singleQuoted ?? '');
    match = ATTRIBUTE.exec(fragment);
  }

  return attributes;
}

/**
 * The document's own date, as an instant.
 *
 * ECB stamps the day, not the minute. Interpreting it as midnight UTC is the
 * conservative reading: it makes the set look slightly OLDER than it is
 * (publication is late afternoon CET), so a freshness window can only ever be
 * stricter than reality, never laxer. Treating it as "now" would be the error
 * that matters - it would let a genuinely stale set pass a checkout gate.
 */
function parseAsOf(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RateProviderError(`The ECB feed carried an unreadable date: ${value}`, false);
  }

  const asOf = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(asOf.getTime())) {
    throw new RateProviderError(`The ECB feed carried an invalid date: ${value}`, false);
  }

  return asOf;
}

/** Parse the daily document. Exported so the tests can drive it without HTTP. */
export function parseEcbDaily(xml: string, sourceReference: string): ProviderRateSet {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new RateProviderError(
      'The ECB feed declared a DTD or an entity, which this reader will not process.',
      false,
    );
  }

  const raw: [string, string][] = [];
  let asOfText: string | null = null;

  CUBE_RATE.lastIndex = 0;
  let cube: RegExpExecArray | null = CUBE_RATE.exec(xml);

  while (cube !== null) {
    const attributes = attributesOf(cube[1] ?? '');
    const time = attributes.get('time');
    const currency = attributes.get('currency');
    const rate = attributes.get('rate');

    // The date sits on the middle Cube, one level above the rates. Taking the
    // FIRST one is deliberate: the historical feed carries many days newest
    // first, so this reader works against either document unchanged.
    if (time !== undefined && asOfText === null) asOfText = time;
    if (currency !== undefined && rate !== undefined) raw.push([currency, rate]);

    cube = CUBE_RATE.exec(xml);
  }

  if (asOfText === null) {
    throw new RateProviderError('The ECB feed carried no publication date.', false);
  }

  const { rates, rejectedCount } = sanitiseRates(raw, PIVOT);

  if (rates.size === 0) {
    throw new RateProviderError('The ECB feed carried no usable rates.', true);
  }

  return {
    provider: 'ecb',
    pivotCurrency: PIVOT,
    asOf: parseAsOf(asOfText),
    rates,
    sourceReference: `${sourceReference}#${asOfText}`,
    rejectedCount,
  };
}

export function createEcbProvider(url: string): RateProvider {
  return {
    name: 'ecb',
    pivotCurrency: PIVOT,
    publishesOnWorkingDaysOnly: true,
    description:
      'European Central Bank euro reference rates, published once each working day at about 16:00 CET. ' +
      'The ECB publishes them for information only: they are not transaction rates and not what a bank ' +
      'or payment provider will settle at.',

    async fetch(options): Promise<ProviderRateSet> {
      const body = await fetchWithTimeout(url, {
        timeoutMs: options.timeoutMs,
        accept: 'application/xml,text/xml',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });

      return parseEcbDaily(body, url);
    },
  };
}
