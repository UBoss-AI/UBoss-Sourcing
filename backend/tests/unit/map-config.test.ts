/**
 * Which background the Warehouses map gets - unit, no database, no process.
 *
 * Three providers and one rule between them, and the rule is the part worth a
 * test: **a Google key wins over a tile URL when both are set.** An
 * installation that has been running on OpenStreetMap tiles and is handed a
 * Google key is being moved to Google; a precedence the other way round would
 * give that operator a screen still drawing tiles, with nothing on it saying
 * why the setting they just added did nothing.
 *
 * Tested through `resolveMapConfig` rather than `mapConfig` on purpose.
 * `config/env.ts` parses the environment once when it is imported, so a test
 * that wanted to try four combinations of two variables through `mapConfig`
 * would need four child processes to do it. The pure function takes the four
 * strings, and `mapConfig` is the one-line caller that hands it the real ones.
 */
import { describe, expect, it } from 'vitest';
import { resolveMapConfig } from '../../src/modules/inventory/location.service.js';

/** Nothing configured, which is what a fresh installation looks like. */
const NOTHING = {
  googleApiKey: '',
  googleMapId: '',
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
        tileUrl: ' ',
        tileAttribution: ' ',
      }),
    ).toEqual({ provider: 'NONE' });
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

  it('wins over a tile URL that is still set', () => {
    const config = resolveMapConfig({
      googleApiKey: 'AIza-test-key',
      googleMapId: 'uboss-light',
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
      googleApiKey: 'AIza-test-key',
      googleMapId: '',
      tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      tileAttribution: '© OpenStreetMap contributors',
    });

    expect(config.provider).toBe('RASTER');
  });

  it('trims a key pasted with surrounding whitespace', () => {
    expect(
      resolveMapConfig({ ...NOTHING, googleApiKey: ' AIza-test-key ', googleMapId: ' uboss-light ' }),
    ).toEqual({ provider: 'GOOGLE', apiKey: 'AIza-test-key', mapId: 'uboss-light' });
  });
});
