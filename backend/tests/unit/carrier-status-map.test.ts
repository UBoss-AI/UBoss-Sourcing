/**
 * Translating a carrier's vocabulary into ours.
 *
 * The rule this file is really testing is the one in the module's header: an
 * unrecognised code is NEVER discarded and NEVER guessed at. Everything else
 * here is ordinary mapping; that one is the difference between a consignment
 * of reagents being flagged for a person and being quietly marked delivered.
 */
import { describe, expect, it } from 'vitest';
import {
  CarrierProviderValues,
  isCarrierProvider,
  knownCarrierCodes,
  resolveCarrierStatus,
} from '../../src/domain/carrier-status-map.js';

describe('providers', () => {
  it('knows the six the product declares', () => {
    // Pinned deliberately. Adding a provider is a decision with a mapping
    // table, an adapter and a migration behind it, and this test is what makes
    // somebody write all three rather than only the enum member.
    expect([...CarrierProviderValues].sort()).toEqual([
      'CUSTOM',
      'DHL',
      'FEDEX',
      'INDIA_POST',
      'MANUAL',
      'UPS',
    ]);
  });

  it('has no status table for India Post, and that is the honest entry', () => {
    // A mapping table is a claim about a feed, and there is no feed. Anything
    // in here would be a vocabulary nobody has confirmed - and the first time
    // one of them was wrong, a hospital would be told its consignment had
    // arrived. Events come from an authorised person instead.
    expect(resolveCarrierStatus('INDIA_POST', ['delivered'])).toMatchObject({ kind: 'UNMAPPED' });
  });

  it('refuses a provider name it does not know', () => {
    expect(isCarrierProvider('DHL')).toBe(true);
    expect(isCarrierProvider('dhl')).toBe(false);
    expect(isCarrierProvider('PIGEON')).toBe(false);
  });
});

describe('an unrecognised code', () => {
  it('resolves to UNMAPPED rather than to a status', () => {
    const result = resolveCarrierStatus('DHL', ['ZZ_NEW_CODE_2027']);
    expect(result.kind).toBe('UNMAPPED');
  });

  it('is UNMAPPED for an empty feed too', () => {
    expect(resolveCarrierStatus('FEDEX', []).kind).toBe('UNMAPPED');
    expect(resolveCarrierStatus('FEDEX', ['', '   ']).kind).toBe('UNMAPPED');
  });

  it('is never silently treated as "no change"', () => {
    /*
     * The discriminated union is the control. A `ShipmentStatusName | null`
     * would be tested with `if (!status)` somewhere and quietly become "leave
     * it alone", and "leave it alone" is not what an unknown code means - it
     * means somebody has to look.
     */
    const unmapped = resolveCarrierStatus('UPS', ['nonsense']);
    const ignored = resolveCarrierStatus('DHL', ['sd']);

    expect(unmapped.kind).toBe('UNMAPPED');
    expect(ignored.kind).toBe('IGNORED');
    expect(unmapped.kind).not.toBe(ignored.kind);
  });
});

describe('the built-in tables', () => {
  it('maps a DHL delivery and a DHL pickup', () => {
    expect(resolveCarrierStatus('DHL', ['ok'])).toEqual({ kind: 'MAPPED', status: 'DELIVERED' });
    expect(resolveCarrierStatus('DHL', ['pu'])).toEqual({ kind: 'MAPPED', status: 'PICKED_UP' });
  });

  it('is case-insensitive, because feeds change their minds', () => {
    expect(resolveCarrierStatus('FEDEX', ['DL'])).toEqual({ kind: 'MAPPED', status: 'DELIVERED' });
    expect(resolveCarrierStatus('FEDEX', ['dl'])).toEqual({ kind: 'MAPPED', status: 'DELIVERED' });
  });

  it('deliberately ignores a label-created scan', () => {
    // Recording it as a movement would start the transit clock before the
    // parcel exists, and the SLA would be measured from a moment nothing
    // happened.
    const result = resolveCarrierStatus('FEDEX', ['oc']);
    expect(result.kind).toBe('IGNORED');
  });

  it('ignores a carrier saying it does not know', () => {
    const result = resolveCarrierStatus('DHL', ['unknown']);
    expect(result.kind).toBe('IGNORED');
  });

  it('tries the most specific candidate first', () => {
    /*
     * UPS sends a coarse activity type and a detailed code. `021` means "out
     * for delivery" and the bare `i` means "in transit"; a caller passing
     * `[detail, type]` must get the detail.
     */
    expect(resolveCarrierStatus('UPS', ['021', 'i'])).toEqual({
      kind: 'MAPPED',
      status: 'OUT_FOR_DELIVERY',
    });

    // And falls back to the type when the detail means nothing to us.
    expect(resolveCarrierStatus('UPS', ['999', 'i'])).toEqual({
      kind: 'MAPPED',
      status: 'IN_TRANSIT',
    });
  });

  it('lists what it knows, sorted, for the admin screen', () => {
    const codes = knownCarrierCodes('UPS');
    expect(codes.length).toBeGreaterThan(5);
    expect(codes.map((entry) => entry.code)).toEqual(
      [...codes.map((entry) => entry.code)].sort(),
    );
  });
});

describe('operator overrides', () => {
  it('win over the built-in table', () => {
    const result = resolveCarrierStatus('DHL', ['ok'], [
      { providerCode: 'ok', canonicalStatus: 'DELIVERY_ATTEMPTED' },
    ]);

    expect(result).toEqual({ kind: 'MAPPED', status: 'DELIVERY_ATTEMPTED' });
  });

  it('can turn a code into "deliberately ignore this"', () => {
    const result = resolveCarrierStatus('DHL', ['pu'], [
      { providerCode: 'pu', canonicalStatus: null, note: 'Their pickup scan fires twice.' },
    ]);

    expect(result.kind).toBe('IGNORED');
    if (result.kind === 'IGNORED') {
      expect(result.note).toContain('twice');
    }
  });

  it('can teach the system a code it has never seen', () => {
    const result = resolveCarrierStatus('DHL', ['zz_new_code_2027'], [
      { providerCode: 'ZZ_NEW_CODE_2027', canonicalStatus: 'CUSTOMS_HOLD' },
    ]);

    // Note the case difference: an override typed in upper case still matches
    // a feed sending lower case, which is the ordinary way this goes wrong.
    expect(result).toEqual({ kind: 'MAPPED', status: 'CUSTOMS_HOLD' });
  });
});

describe('the manual and custom providers', () => {
  it('accept our own vocabulary straight through', () => {
    expect(resolveCarrierStatus('MANUAL', ['OUT_FOR_DELIVERY'])).toEqual({
      kind: 'MAPPED',
      status: 'OUT_FOR_DELIVERY',
    });

    expect(resolveCarrierStatus('CUSTOM', ['in_transit'])).toEqual({
      kind: 'MAPPED',
      status: 'IN_TRANSIT',
    });
  });

  it('still refuse a status that does not exist', () => {
    expect(resolveCarrierStatus('MANUAL', ['TELEPORTED']).kind).toBe('UNMAPPED');
  });

  it('do not let a DHL feed use our vocabulary by accident', () => {
    // A DHL integration sending "IN_TRANSIT" is a misconfigured integration,
    // not a lucky guess, and it should surface as one.
    expect(resolveCarrierStatus('DHL', ['IN_TRANSIT']).kind).toBe('UNMAPPED');
  });
});
