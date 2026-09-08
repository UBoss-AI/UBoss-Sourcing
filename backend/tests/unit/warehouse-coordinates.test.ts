/**
 * Classifying a warehouse's stored coordinates - unit, no database.
 *
 * Three outcomes, not two, and the third is the reason the function exists:
 *
 *   - a point, which the map draws;
 *   - nothing, which is the ordinary state of a warehouse nobody has geocoded;
 *   - **something stored that cannot be drawn**, which has to be reported
 *     rather than silently dropped.
 *
 * That third case is deliberately unreachable through the API - the CHECK
 * constraints added in 20260908090000 refuse it - so why carry the code at
 * all? Because this product is installed and run by the company that buys it,
 * and the constraint is only as strong as the engine underneath. MariaDB 10.4
 * enforces CHECK constraints; **MySQL 5.7 parses them and silently ignores
 * them**, which the repository's own migration says in as many words. A buyer
 * on 5.7, an import script, or a DBA with a `SET FOREIGN_KEY_CHECKS`-shaped
 * afternoon can all leave a latitude of 999 in that column, and a warehouse
 * that then goes quietly missing from the map is the worst possible outcome -
 * it is simply absent, with nothing saying so.
 *
 * Tested here rather than over HTTP for a concrete reason: reaching the case
 * against a real database means dropping a constraint mid-suite, and a run
 * that fails between the drop and the restore leaves every later test file
 * working against a weakened schema. That is not a trade worth making for
 * coverage of a pure function.
 */
import { describe, expect, it } from 'vitest';
import { classifyCoordinates } from '../../src/modules/inventory/location.service.js';

describe('a usable pair', () => {
  it('passes both axes through as numbers', () => {
    expect(classifyCoordinates({ latitude: '51.219400', longitude: '4.402500' })).toEqual({
      latitude: 51.2194,
      longitude: 4.4025,
      coordinatesInvalid: false,
    });
  });

  it('accepts the extremes of both axes', () => {
    expect(classifyCoordinates({ latitude: 90, longitude: 180 }).coordinatesInvalid).toBe(false);
    expect(classifyCoordinates({ latitude: -90, longitude: -180 }).coordinatesInvalid).toBe(false);
  });

  it('accepts null island, which is a real point and not a missing value', () => {
    // 0,0 is in the Gulf of Guinea. It is a daft place for a warehouse and a
    // perfectly valid coordinate, and a falsy check here would have called it
    // unplaced.
    expect(classifyCoordinates({ latitude: 0, longitude: 0 })).toEqual({
      latitude: 0,
      longitude: 0,
      coordinatesInvalid: false,
    });
  });
});

describe('no position at all', () => {
  it('is not reported as a problem', () => {
    expect(classifyCoordinates({ latitude: null, longitude: null })).toEqual({
      latitude: null,
      longitude: null,
      coordinatesInvalid: false,
    });
  });
});

describe('a pair that cannot be drawn', () => {
  it('rejects a latitude past the pole', () => {
    expect(classifyCoordinates({ latitude: 999, longitude: 10 })).toEqual({
      latitude: null,
      longitude: null,
      coordinatesInvalid: true,
    });
  });

  it('rejects a longitude past the antimeridian', () => {
    expect(classifyCoordinates({ latitude: 10, longitude: -200 }).coordinatesInvalid).toBe(true);
  });

  it('rejects a lone latitude', () => {
    // Not partial knowledge - a latitude on its own names a line right around
    // the planet, so there is nowhere to put the marker.
    expect(classifyCoordinates({ latitude: 51.2194, longitude: null })).toEqual({
      latitude: null,
      longitude: null,
      coordinatesInvalid: true,
    });
  });

  it('rejects a lone longitude', () => {
    expect(classifyCoordinates({ latitude: null, longitude: 4.4025 }).coordinatesInvalid).toBe(
      true,
    );
  });

  it('rejects a value that is not a number at all', () => {
    // A `Json`-shaped import or a hand-written UPDATE can leave text in a
    // column the driver hands back as a string.
    expect(classifyCoordinates({ latitude: 'north', longitude: '4.4' }).coordinatesInvalid).toBe(
      true,
    );
  });

  it('never hands a bad number to the caller, whatever was stored', () => {
    // The load-bearing guarantee: the map is handed null, so it cannot plot a
    // marker in the sea however wrong the row is.
    for (const bad of [
      { latitude: 999, longitude: 999 },
      { latitude: Number.NaN, longitude: 0 },
      { latitude: Number.POSITIVE_INFINITY, longitude: 0 },
      { latitude: 91, longitude: null },
    ]) {
      const result = classifyCoordinates(bad);
      expect(result.latitude).toBeNull();
      expect(result.longitude).toBeNull();
      expect(result.coordinatesInvalid).toBe(true);
    }
  });
});
