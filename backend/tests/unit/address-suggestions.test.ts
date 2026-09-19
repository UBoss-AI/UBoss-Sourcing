/**
 * What comes back when somebody is halfway through typing an address.
 *
 * `suggestAddresses` is what every address field in the product types into -
 * the warehouse form in the console, the seller's dispatch addresses, and the
 * customer's delivery address - so three screens share one answer to "which
 * places match this?". The parts worth a test are the two that have bitten:
 *
 *   1. **The shipped default URL carries `limit=1`.** It was written when the
 *      only caller wanted one answer. An installation that has been running
 *      for a year has that exact string in its own `.env`, so a suggestions
 *      list that trusted the template would be one row long everywhere.
 *   2. **Every failure is an empty list, never a throw.** The dropdown sits
 *      beside fields somebody can always type into, and a geocoder that is
 *      unconfigured, slow, firewalled or simply ignorant of the street must
 *      leave the form working.
 *
 * No database and no network: `fetch` is stubbed, which is the whole of this
 * function's outside world.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * A geocoder, set before the service is loaded.
 *
 * `tests/setup.ts` blanks `GEOCODE_FORWARD_URL` so that no test suite ever
 * calls OpenStreetMap by accident, and `config/env.ts` parses the environment
 * once when it is imported - so this has to be assigned before the import
 * below, which is why the import is dynamic. The value is the shipped default
 * with the host changed: `limit=1` and all, because that string is the whole
 * point of the first test here.
 */
process.env.GEOCODE_FORWARD_URL =
  'https://geocoder.invalid/search?format=jsonv2&limit=1&q={query}';

const { forwardGeocode, suggestAddresses } = await import(
  '../../src/modules/inventory/location.service.js'
);

/** One Nominatim row, with the `addressdetails` payload the fields read. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lat: '51.2194',
    lon: '4.4025',
    display_name: 'Grote Markt, Antwerpen, Vlaanderen, 2000, België',
    address: {
      house_number: '1',
      road: 'Grote Markt',
      city: 'Antwerpen',
      state: 'Vlaanderen',
      postcode: '2000',
      country_code: 'be',
    },
    ...overrides,
  };
}

/** Stub `fetch`, and hand back the URLs it was called with. */
function answerWith(body: unknown, status = 200): { urls: string[] } {
  const urls: string[] = [];

  vi.stubGlobal('fetch', (input: unknown) => {
    urls.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  return { urls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the URL a search is fetched from', () => {
  it('overrides the limit=1 the shipped default carries', async () => {
    const seen = answerWith([row()]);

    await suggestAddresses('Grote Markt, Antwerpen', 6);

    const url = new URL(seen.urls[0] ?? '');
    expect(url.searchParams.get('limit')).toBe('6');
  });

  it('asks for the address breakdown the fields are filled from', async () => {
    const seen = answerWith([row()]);

    await suggestAddresses('Grote Markt, Antwerpen', 6);

    const url = new URL(seen.urls[0] ?? '');
    expect(url.searchParams.get('addressdetails')).toBe('1');
  });

  it('puts the typed address in the query the operator nominated', async () => {
    const seen = answerWith([row()]);

    await suggestAddresses('Grote Markt, Antwerpen', 6);

    const url = new URL(seen.urls[0] ?? '');
    expect(url.searchParams.get('q')).toBe('Grote Markt, Antwerpen');
  });

  it('never asks for more than the ceiling, whatever it is handed', async () => {
    const seen = answerWith([row()]);

    await suggestAddresses('Antwerpen', 500);

    const url = new URL(seen.urls[0] ?? '');
    expect(url.searchParams.get('limit')).toBe('10');
  });
});

describe('what a suggestion carries', () => {
  it('breaks the address back out into the fields a form has', async () => {
    answerWith([row()]);

    const [first] = await suggestAddresses('Grote Markt, Antwerpen', 6);

    expect(first).toEqual({
      latitude: 51.2194,
      longitude: 4.4025,
      label: 'Grote Markt, Antwerpen, Vlaanderen, 2000, België',
      line1: '1 Grote Markt',
      city: 'Antwerpen',
      region: 'Vlaanderen',
      postalCode: '2000',
      countryCode: 'BE',
    });
  });

  it('takes the town from whichever level the place actually sits at', async () => {
    answerWith([
      row({
        address: {
          road: 'Industrieweg',
          village: 'Zwijndrecht',
          county: 'Antwerpen',
          country_code: 'be',
        },
      }),
    ]);

    const [first] = await suggestAddresses('Industrieweg', 6);

    expect(first?.city).toBe('Zwijndrecht');
  });

  it('leaves a field null rather than inventing one the geocoder did not give', async () => {
    answerWith([
      row({ address: { road: 'Grote Markt', city: 'Antwerpen', country_code: 'be' } }),
    ]);

    const [first] = await suggestAddresses('Grote Markt', 6);

    expect(first?.postalCode).toBeNull();
    expect(first?.region).toBeNull();
  });

  it('reads the clones that wrap the same rows in { results }', async () => {
    answerWith({ results: [row()] });

    const suggestions = await suggestAddresses('Grote Markt', 6);

    expect(suggestions).toHaveLength(1);
  });

  it('drops a row that cannot be plotted rather than the whole answer', async () => {
    answerWith([{ display_name: 'Somewhere', lat: 'not a number', lon: '4.4' }, row()]);

    const suggestions = await suggestAddresses('Grote Markt', 6);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.city).toBe('Antwerpen');
  });

  it('drops coordinates outside the world', async () => {
    answerWith([row({ lat: '999', lon: '4.4' })]);

    expect(await suggestAddresses('Grote Markt', 6)).toEqual([]);
  });
});

describe('a geocoder having a bad afternoon', () => {
  it('is an empty list on a non-200, not an error', async () => {
    answerWith({ error: 'rate limited' }, 429);

    expect(await suggestAddresses('Grote Markt', 6)).toEqual([]);
  });

  it('is an empty list when the request throws', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));

    expect(await suggestAddresses('Grote Markt', 6)).toEqual([]);
  });

  it('is an empty list for a body in a shape nobody recognises', async () => {
    answerWith({ nothing: 'useful' });

    expect(await suggestAddresses('Grote Markt', 6)).toEqual([]);
  });

  it('does not call anybody for an empty query', async () => {
    const seen = answerWith([row()]);

    expect(await suggestAddresses('   ', 6)).toEqual([]);
    expect(seen.urls).toEqual([]);
  });
});

describe('the single lookup the buttons still use', () => {
  it('is the first suggestion', async () => {
    answerWith([row(), row({ display_name: 'Somewhere else' })]);

    const found = await forwardGeocode('Grote Markt, Antwerpen');

    expect(found).toMatchObject({
      latitude: 51.2194,
      longitude: 4.4025,
      label: 'Grote Markt, Antwerpen, Vlaanderen, 2000, België',
    });
  });

  it('asks for one, so nothing pays for a list it will throw away', async () => {
    const seen = answerWith([row()]);

    await forwardGeocode('Grote Markt, Antwerpen');

    const url = new URL(seen.urls[0] ?? '');
    expect(url.searchParams.get('limit')).toBe('1');
  });

  it('is null when nothing was found', async () => {
    answerWith([]);

    expect(await forwardGeocode('Nowhere at all')).toBeNull();
  });
});
