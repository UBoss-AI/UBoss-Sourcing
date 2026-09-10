/**
 * Which background the Warehouses map gets - unit, no database, no process.
 *
 * Four providers and one rule between them, and the rule is the part worth a
 * test: **Google beats a style URL, and a style URL beats a tile URL.** An
 * installation running on OpenStreetMap raster tiles that is handed a MapLibre
 * style is being moved to vector tiles - which is how a deployment gets its
 * place names in one language - and an installation handed a Google key is
 * being moved to Google. A precedence the other way round would give that
 * operator a screen still drawing the provider they left, with nothing on it
 * saying why the setting they just added did nothing.
 *
 * Tested through `resolveMapConfig` rather than `mapConfig` on purpose.
 * `config/env.ts` parses the environment once when it is imported, so a test
 * that wanted to try every combination through `mapConfig` would need a child
 * process for each. The pure function takes the strings, and `mapConfig` is
 * the one-line caller that hands it the real ones.
 */
import { describe, expect, it } from 'vitest';
import { resolveMapConfig } from '../../src/modules/inventory/location.service.js';

/** Nothing configured, which is what a fresh installation looks like. */
const NOTHING = {
  googleApiKey: '',
  googleMapId: '',
  styleUrl: '',
  styleAttribution: '',
  tileUrl: '',
  tileAttribution: '',
};

describe('nothing configured', () => {
  it('is NONE, which is a working state rather than a fault', () => {
    expect(resolveMapConfig(NOTHING)).toEqual({ provider: 'NONE' });
  });

  it('is NONE for settings that hold only whitespace', () => {
    expect(
      resolveMapConfig({
        googleApiKey: '  ',
        googleMapId: '\t',
        styleUrl: '\n',
        styleAttribution: ' ',
        tileUrl: ' ',
        tileAttribution: ' ',
      }),
    ).toEqual({ provider: 'NONE' });
  });
});

/**
 * The vector path, which is the one an operator reaches for when the labels
 * matter.
 *
 * A raster tile carries its place names drawn into the image in whatever
 * language is local to that place; a vector tile carries them as fields, so
 * the panel can ask for `name:en` and get one language worldwide. That is the
 * whole reason this provider exists rather than being another tile URL.
 */
describe('vector tiles', () => {
  it('carries the style URL the browser has to fetch', () => {
    expect(
      resolveMapConfig({
        ...NOTHING,
        styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
      }),
    ).toEqual({
      provider: 'VECTOR',
      style: { url: 'https://tiles.openfreemap.org/styles/liberty', attribution: '' },
    });
  });

  /**
   * An empty attribution is the ordinary case here, and that is the difference
   * from the raster path rather than an oversight: a style JSON declares its
   * own sources and each one carries its own attribution, so the credit
   * reaches the corner of the map without the operator setting anything. The
   * variable exists for a self-hosted style that declares none.
   */
  it('carries an extra attribution line where the operator set one', () => {
    expect(
      resolveMapConfig({
        ...NOTHING,
        styleUrl: 'https://tiles.internal/styles/warehouse.json',
        styleAttribution: 'Basemap: ACME GIS',
      }),
    ).toEqual({
      provider: 'VECTOR',
      style: {
        url: 'https://tiles.internal/styles/warehouse.json',
        attribution: 'Basemap: ACME GIS',
      },
    });
  });

  it('wins over raster tiles that are still set', () => {
    const config = resolveMapConfig({
      ...NOTHING,
      styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
      tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      tileAttribution: '© OpenStreetMap contributors',
    });

    expect(config.provider).toBe('VECTOR');
  });

  it('trims what somebody pasted with a newline on the end', () => {
    expect(
      resolveMapConfig({ ...NOTHING, styleUrl: ' https://tiles.internal/style.json\n' }),
    ).toMatchObject({ style: { url: 'https://tiles.internal/style.json' } });
  });
});

describe('raster tiles', () => {
  it('carries the template and the attribution the licence asks for', () => {
    expect(
      resolveMapConfig({
        ...NOTHING,
        tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        tileAttribution: '© OpenStreetMap contributors',
      }),
    ).toEqual({
      provider: 'RASTER',
      tiles: {
        urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: '© OpenStreetMap contributors',
      },
    });
  });

  /**
   * A tile URL with no attribution is still RASTER.
   *
   * Refusing it here would be this software deciding what somebody else's
   * tile licence requires. A private tile server inside the buyer's own
   * network owes attribution to nobody, and the operator is who knows.
   */
  it('is offered even where the operator set no attribution', () => {
    const config = resolveMapConfig({ ...NOTHING, tileUrl: 'https://tiles.internal/{z}/{x}/{y}.png' });

    expect(config).toEqual({
      provider: 'RASTER',
      tiles: { urlTemplate: 'https://tiles.internal/{z}/{x}/{y}.png', attribution: '' },
    });
  });

  it('trims what somebody pasted with a newline on the end', () => {
    expect(
      resolveMapConfig({ ...NOTHING, tileUrl: ' https://tiles.internal/{z}/{x}/{y}.png\n' }),
    ).toMatchObject({
      tiles: { urlTemplate: 'https://tiles.internal/{z}/{x}/{y}.png' },
    });
  });
});

describe('Google Maps', () => {
  it('carries the key and the map ID the browser needs', () => {
    expect(
      resolveMapConfig({ ...NOTHING, googleApiKey: 'AIza-test-key', googleMapId: 'uboss-light' }),
    ).toEqual({ provider: 'GOOGLE', apiKey: 'AIza-test-key', mapId: 'uboss-light' });
  });

  it('wins over both of the OpenStreetMap paths when they are still set', () => {
    const config = resolveMapConfig({
      googleApiKey: 'AIza-test-key',
      googleMapId: 'uboss-light',
      styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
      styleAttribution: '',
      tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      tileAttribution: '© OpenStreetMap contributors',
    });

    expect(config.provider).toBe('GOOGLE');
  });

  /**
   * Half a pair falls back rather than being offered.
   *
   * `env.ts` refuses to start a process with a key and no map ID, so this is
   * belt to that braces - but the fallback has to be the *safe* direction. A
   * Google map with no map ID renders unstyled and then cannot place a single
   * Advanced Marker on it, so a screen with no background at all is the better
   * of the two failures: it says in words that nothing is configured.
   */
  it('is not offered with a key and no map ID', () => {
    expect(resolveMapConfig({ ...NOTHING, googleApiKey: 'AIza-test-key' })).toEqual({
      provider: 'NONE',
    });
  });

  it('is not offered with a map ID and no key', () => {
    expect(resolveMapConfig({ ...NOTHING, googleMapId: 'uboss-light' })).toEqual({
      provider: 'NONE',
    });
  });

  it('falls back to the tiles rather than to nothing when only half a pair is set', () => {
    const config = resolveMapConfig({
      ...NOTHING,
      googleApiKey: 'AIza-test-key',
      tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      tileAttribution: '© OpenStreetMap contributors',
    });

    expect(config.provider).toBe('RASTER');
  });

  it('falls back to the style rather than the tiles when both are behind it', () => {
    const config = resolveMapConfig({
      ...NOTHING,
      googleApiKey: 'AIza-test-key',
      styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
      tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      tileAttribution: '© OpenStreetMap contributors',
    });

    expect(config.provider).toBe('VECTOR');
  });

  it('trims a key pasted with surrounding whitespace', () => {
    expect(
      resolveMapConfig({ ...NOTHING, googleApiKey: ' AIza-test-key ', googleMapId: ' uboss-light ' }),
    ).toEqual({ provider: 'GOOGLE', apiKey: 'AIza-test-key', mapId: 'uboss-light' });
  });
});
