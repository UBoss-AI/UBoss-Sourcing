/**
 * The catalogue of named ERPs, checked for the mistakes data makes.
 *
 * `vendor-presets.ts` is deliberately data rather than code, which is what
 * makes "add support for <ERP>" a one-array change. The cost of that choice is
 * that the compiler cannot catch a preset whose mapping names a platform field
 * that does not exist, or whose connector is a system nothing speaks, or whose
 * status vocabulary is missing the one status a buyer's ERP actually sends. All
 * three fail silently at runtime: the field is skipped, the order is written
 * without it, and nobody finds out until a purchase order arrives incomplete.
 *
 * So the checks that a type would have given us are written here instead, and
 * they run against every entry - including the twentieth, added by somebody who
 * never read this file.
 */
import { describe, expect, it } from 'vitest';

import {
  VENDOR_PRESETS,
  presetById,
  presetsForRegion,
  type VendorPreset,
} from '../../src/modules/customer-erp/vendor-presets.js';
import { availableSystems, connectorFor } from '../../src/modules/customer-erp/connectors/index.js';
import { PLATFORM_FIELDS } from '../../src/modules/customer-erp/mapping.service.js';

const PLATFORM_STATUSES = ['CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

function knownField(entity: keyof typeof PLATFORM_FIELDS, key: string): boolean {
  return PLATFORM_FIELDS[entity].some((field) => field.key === key);
}

/**
 * What a buyer picking this preset actually starts with.
 *
 * A preset with no endpoints or mappings of its own is not unfinished: it is
 * one whose CONNECTOR already owns that list, and SAP and monday are both like
 * that. `connection.service.ts` resolves it exactly this way when a connection
 * is created, so these checks are run against the same thing the buyer gets
 * rather than against half of it.
 */
function defaultsFor(preset: VendorPreset): {
  endpoints: readonly { purpose: string; path: string; method: string }[];
  mappings: readonly {
    entity: string;
    platformField: string;
    erpPath: string;
    constantValue: string | null;
    erpValue: string | null;
  }[];
} {
  const connector = connectorFor(preset.connector).defaults('PRODUCTION');

  return {
    endpoints: preset.endpoints.length > 0 ? preset.endpoints : connector.endpoints,
    mappings: preset.mappings.length > 0 ? preset.mappings : connector.mappings,
  };
}

describe('the vendor catalogue', () => {
  it('is not empty and names each system once', () => {
    expect(VENDOR_PRESETS.length).toBeGreaterThan(0);

    const ids = VENDOR_PRESETS.map((preset) => preset.id);

    expect(new Set(ids).size).toBe(ids.length);

    for (const id of ids) {
      // The id is stored on the connection and read back by screens, so it has
      // to survive a URL and a column without quoting.
      expect(id, `"${id}" is not a plain identifier`).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(id.length).toBeLessThanOrEqual(48);
    }
  });

  it('points every preset at a connector that exists', () => {
    const systems = availableSystems();

    for (const preset of VENDOR_PRESETS) {
      expect(systems, `${preset.label} names connector ${preset.connector}`).toContain(
        preset.connector,
      );
    }
  });

  it('offers at least one way to authenticate, and an https example address', () => {
    for (const preset of VENDOR_PRESETS) {
      expect(preset.authMethods.length, `${preset.label} has no auth method`).toBeGreaterThan(0);
      expect(new Set(preset.authMethods).size).toBe(preset.authMethods.length);

      // The address is a placeholder rather than a value, but a placeholder
      // showing http:// teaches the wrong thing - and the outbound guard would
      // refuse it anyway.
      expect(preset.baseUrlExample, `${preset.label} has a non-https example`).toMatch(
        /^https:\/\//,
      );
    }
  });

  it('maps only platform fields that exist', () => {
    for (const preset of VENDOR_PRESETS) {
      for (const row of defaultsFor(preset).mappings) {
        if (row.entity === 'STATUS') {
          expect(
            PLATFORM_STATUSES,
            `${preset.label} maps unknown status ${row.platformField}`,
          ).toContain(row.platformField);

          // A status row carries the ERP's word in `erpValue`, not a path.
          expect((row.erpValue ?? '').length, `${preset.label}: ${row.platformField}`)
            .toBeGreaterThan(0);
          continue;
        }

        expect(
          knownField(row.entity as keyof typeof PLATFORM_FIELDS, row.platformField),
          `${preset.label} maps ${row.entity}.${row.platformField}, which is not a platform field`,
        ).toBe(true);

        // Every non-status row has to say where the value goes, one way or the
        // other. A row with neither is a row that does nothing.
        const hasSomewhere =
          row.erpPath.trim().length > 0 || (row.constantValue ?? '').trim().length > 0;

        expect(hasSomewhere, `${preset.label}: ${row.entity}.${row.platformField} goes nowhere`)
          .toBe(true);
      }
    }
  });

  it('gives every preset the four statuses a buyer can be told about', () => {
    for (const preset of VENDOR_PRESETS) {
      const mapped = defaultsFor(preset)
        .mappings.filter((row) => row.entity === 'STATUS')
        .map((row) => row.platformField);

      for (const status of PLATFORM_STATUSES) {
        expect(mapped, `${preset.label} cannot translate ${status}`).toContain(status);
      }
    }
  });

  it('warns wherever a brand is standing on the generic REST paths', () => {
    for (const preset of VENDOR_PRESETS) {
      // Every preset starts a buyer with SOMETHING - its own paths, or its
      // connector's. An empty Endpoints step with no explanation is the one
      // outcome that helps nobody.
      expect(defaultsFor(preset).endpoints.length, `${preset.label} starts with nothing`)
        .toBeGreaterThan(0);

      if (preset.endpoints.length > 0 || preset.connector !== 'CUSTOM') continue;

      /*
       * This is the case worth catching. A preset over the CUSTOM connector
       * with no paths of its own inherits `/products`, `/purchase-orders` and
       * the rest - generic REST conventions that are right for some in-house
       * APIs and wrong for most named products. Shown under a brand name with
       * no warning, they read as "this is where TCS iON keeps its purchase
       * orders", which is not something anybody here knows.
       */
      expect(
        preset.defaultsAreExamples,
        `${preset.label} inherits the generic REST paths without saying they are examples`,
      ).toBe(true);
      expect(preset.notes.length, `${preset.label} has no paths of its own and no guidance`)
        .toBeGreaterThan(80);
    }
  });

  it('describes each endpoint completely enough to call it', () => {
    for (const preset of VENDOR_PRESETS) {
      for (const endpoint of preset.endpoints) {
        expect(endpoint.path.length, `${preset.label}: an endpoint has no path`).toBeGreaterThan(0);
        expect(
          ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
          `${preset.label}: ${endpoint.purpose} has method ${endpoint.method}`,
        ).toContain(endpoint.method);
      }

      // One purpose, one endpoint. Two rows for PURCHASE_ORDER_CREATE means one
      // of them is never reached, and which one is an accident of order.
      const purposes = preset.endpoints.map((endpoint) => endpoint.purpose);
      expect(new Set(purposes).size, `${preset.label} configures a purpose twice`).toBe(
        purposes.length,
      );
    }
  });

  it('finds a preset by id, and refuses an unknown one', () => {
    const first = VENDOR_PRESETS[0] as VendorPreset;

    expect(presetById(first.id)?.label).toBe(first.label);
    expect(presetById('not-an-erp')).toBeNull();
    expect(presetById(null)).toBeNull();
    expect(presetById(undefined)).toBeNull();
  });
});

describe('TCS iON', () => {
  /**
   * Asked for by name, and worth its own test for the reason it was added
   * carefully: TCS iON is delivered configured per customer, so this entry is a
   * shape and a vocabulary rather than a set of addresses. What it must never
   * become is a portal login driven by a browser.
   */
  it('is in the catalogue, over the custom REST connector', () => {
    const tcs = presetById('tcs-ion');

    expect(tcs).not.toBeNull();
    expect(tcs?.label).toBe('TCS iON');
    expect(tcs?.connector).toBe('CUSTOM');
    expect(tcs?.apiStyle).toBe('REST_JSON');
  });

  it('says its paths are per-tenant and sends the buyer to their partner', () => {
    const tcs = presetById('tcs-ion') as VendorPreset;

    expect(tcs.defaultsAreExamples).toBe(true);
    expect(tcs.endpoints).toHaveLength(0);
    expect(tcs.notes).toMatch(/implementation partner/i);
    expect(tcs.notes).toMatch(/API/);
  });

  it('offers no way to connect that is not an API', () => {
    const tcs = presetById('tcs-ion') as VendorPreset;

    // The authentication methods are the whole surface here. None of them is a
    // portal username and password, because there is no portal path: a
    // connection needs a documented API or a middleware in front of one.
    for (const method of tcs.authMethods) {
      expect(['OAUTH2_CLIENT_CREDENTIALS', 'OAUTH2_AUTHORIZATION_CODE', 'API_KEY', 'BEARER_TOKEN'])
        .toContain(method);
    }
  });
});

describe('ordering the catalogue for a market', () => {
  it('puts the region first and the escape hatch last', () => {
    const indian = presetsForRegion('india');

    expect(indian.length).toBe(VENDOR_PRESETS.length);
    expect(indian[indian.length - 1]?.id).toBe('custom');

    const tcsAt = indian.findIndex((preset) => preset.id === 'tcs-ion');
    const euOnlyAt = indian.findIndex((preset) => !preset.regions.includes('india'));

    expect(tcsAt).toBeGreaterThanOrEqual(0);
    expect(tcsAt, 'an Indian buyer should not scroll past EU-only systems to find TCS iON')
      .toBeLessThan(euOnlyAt);
  });

  it('keeps every preset whatever the region', () => {
    for (const region of ['global', 'india', 'eu'] as const) {
      const ordered = presetsForRegion(region);

      expect(new Set(ordered.map((preset) => preset.id)).size).toBe(VENDOR_PRESETS.length);
    }
  });
});
