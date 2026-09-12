/**
 * The monday connector, checked for the two mistakes it has actually made.
 *
 * Both were silent. Neither would have failed a typecheck, a lint or any test
 * that only asked "does this call monday" - they were mismatches between two
 * halves of the feature that each looked correct on its own, and the symptom in
 * both cases was a buyer reaching the end of the setup wizard and being told no.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/modules/customer-erp/http.js', async () => {
  const actual =
    await vi.importActual<ErpHttpModule>('../../src/modules/customer-erp/http.js');

  // Only the call is faked. `redactForLedger` and `resolveEndpointUrl` shape
  // what the connector returns, so stubbing them would test a different
  // function from the one that runs.
  return { ...actual, callErp: vi.fn() };
});

import type * as erpHttp from '../../src/modules/customer-erp/http.js';
import { callErp } from '../../src/modules/customer-erp/http.js';

type ErpHttpModule = typeof erpHttp;
import { mondayConnector } from '../../src/modules/customer-erp/connectors/monday.connector.js';
import type { ConnectorContext } from '../../src/modules/customer-erp/connectors/types.js';
import {
  verifyAgainstSample,
  type MappingRow,
} from '../../src/modules/customer-erp/mapping.service.js';

/** A board as monday replies about it: columns as a list, not as fields. */
const BOARD = {
  id: '1234567890',
  name: 'Purchase orders',
  columns: [
    { id: 'name', title: 'Item', type: 'name' },
    { id: 'text2', title: 'SKU', type: 'text' },
    { id: 'numbers3', title: 'On hand', type: 'numbers' },
  ],
  groups: [{ id: 'topics', title: 'Ordered' }],
  items_page: {
    items: [
      {
        id: '99',
        name: 'PO-1',
        column_values: [
          { id: 'text2', text: 'SKU-001', value: '"SKU-001"' },
          { id: 'numbers3', text: '42', value: '42' },
        ],
      },
    ],
  },
};

function contextFor(mappings: readonly MappingRow[]): ConnectorContext {
  return {
    call: {
      id: 'conn',
      organizationId: 'org',
      baseUrl: 'https://api.monday.com',
      authMethod: 'MONDAY_PERSONAL_TOKEN',
      apiKeyLocation: null,
      apiKeyName: null,
      apiVersion: null,
      customHeaders: {},
      tenantIdentifier: null,
      timeoutMs: 10_000,
      mutualTlsEnabled: false,
    },
    system: 'MONDAY',
    apiStyle: 'GRAPHQL',
    environment: 'SANDBOX',
    erpVersion: null,
    authMethod: 'MONDAY_PERSONAL_TOKEN',
    apiKeyLocation: null,
    endpoints: new Map(),
    mappings,
    sap: {
      companyCode: null,
      purchasingOrg: null,
      purchasingGroup: null,
      plant: null,
      storageLocation: null,
      communicationScenario: null,
    },
    monday: { workspaceId: null, boardId: '1234567890', groupId: null },
    accessToken: null,
    tenantIdentifier: null,
    currencyExponent: 2,
  };
}

/** The connector's own defaults, with the mapping service's required flags. */
function defaultMappings(): MappingRow[] {
  return mondayConnector.defaults('SANDBOX').mappings.map((row) => ({
    ...row,
    required: row.entity === 'INVENTORY' && row.platformField === 'sku',
  }));
}

beforeEach(() => {
  vi.mocked(callErp).mockReset();
  vi.mocked(callErp).mockResolvedValue({
    data: { data: { me: { id: '1', name: 'A Manager' }, boards: [BOARD] } },
    status: 200,
    durationMs: 12,
  } as Awaited<ReturnType<typeof callErp>>);
});

describe('the sample a monday test returns', () => {
  /**
   * The regression this file exists for.
   *
   * `test()` used to hand back monday's reply almost verbatim - the item with
   * its `column_values` array intact - while the mapping was written against
   * flattened column ids, because that is the shape `readInventory` builds for
   * the real sync. So `readPath(sample, 'text2')` found nothing, every mapped
   * field came back "not found", the required SKU with it, `mappingVerifiedAt`
   * was never set, and the connection could never be switched on. A test that
   * only asserted "the call happened" would have passed throughout.
   */
  it('is the shape the mapping is actually written against', async () => {
    const mappings = defaultMappings();
    const result = await mondayConnector.test(contextFor(mappings));

    expect(result.ok).toBe(true);

    const check = verifyAgainstSample(mappings, 'INVENTORY', result.sample);

    expect(check.missing).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.fields.find((field) => field.erpPath === 'text2')?.sample).toBe('SKU-001');
  });

  it('still carries the board reference a buyer reads the column ids from', async () => {
    const result = await mondayConnector.test(contextFor(defaultMappings()));
    const sample = result.sample as Record<string, unknown>;

    // Underscored, so a monday column called `board` or `groups` cannot shadow
    // the reference data and leave the buyer with no column list to map from.
    expect(sample['_board']).toMatchObject({ id: '1234567890' });
    expect(sample['_columns']).toEqual(BOARD.columns);
    expect(sample['_groups']).toEqual(BOARD.groups);
  });
});

describe('which authentication methods monday offers', () => {
  /**
   * The other silent one. A personal token is refused outright on a production
   * connection, and offering it there anyway meant the wizard presented exactly
   * one choice and `validateConfiguration` refused that same choice at the end
   * - after the buyer had filled in every other step.
   */
  it('offers nothing in production when this store has registered no app', () => {
    // The suite runs with MONDAY_OAUTH_CLIENT_ID unset, which is the case that
    // produced the dead end.
    expect(mondayConnector.defaults('PRODUCTION').authMethods).toEqual([]);
  });

  it('offers the personal token on a sandbox connection', () => {
    expect(mondayConnector.defaults('SANDBOX').authMethods).toEqual(['MONDAY_PERSONAL_TOKEN']);
  });

  it('never offers a method its own validation would refuse', () => {
    for (const environment of ['SANDBOX', 'PRODUCTION'] as const) {
      for (const authMethod of mondayConnector.defaults(environment).authMethods) {
        expect(() =>
          mondayConnector.validateConfiguration({
            environment,
            authMethod,
            apiStyle: 'GRAPHQL',
            baseUrl: 'https://api.monday.com',
            sap: {
              companyCode: null,
              purchasingOrg: null,
              purchasingGroup: null,
              plant: null,
              storageLocation: null,
              communicationScenario: null,
            },
            monday: { workspaceId: null, boardId: '1234567890', groupId: null },
            oauthTokenUrl: null,
            oauthAuthorizationUrl: null,
            mutualTlsEnabled: false,
          }),
        ).not.toThrow();
      }
    }
  });
});

describe('monday’s OAuth addresses', () => {
  it('are declared by the connector rather than asked of the buyer', () => {
    const defaults = mondayConnector.defaults('PRODUCTION');

    // `auth.monday.com`, not the `api.monday.com` base address - which is
    // exactly the thing a buyer asked to type it gets wrong once and then
    // diagnoses at a broken consent screen.
    expect(defaults.oauthAuthorizationUrl).toBe('https://auth.monday.com/oauth2/authorize');
    expect(defaults.oauthTokenUrl).toBe('https://auth.monday.com/oauth2/token');
  });
});
