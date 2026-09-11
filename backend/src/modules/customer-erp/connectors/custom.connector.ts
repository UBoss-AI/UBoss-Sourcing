/**
 * Anything else with a documented HTTP API.
 *
 * The connector for the buyer whose purchasing system was written in-house, or
 * bought from somebody with two hundred customers rather than two hundred
 * thousand. REST/JSON by default, with OData and GraphQL where their system
 * speaks them.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE OTHER TWO
 *
 * Nothing is known in advance. SAP's purchase order lives at a path this
 * codebase can name; monday's is an item on a board. Here, every path, every
 * method, every field name and the shape of the request body all come from the
 * buyer - which is why this connector is almost entirely the mapping engine
 * plus a request template, and why `requestTemplateJson` exists on the endpoint
 * at all.
 *
 * THE ONE THING IT WILL NOT DO
 *
 * Connect to a system that has no API. A buyer who offers a portal login and
 * asks us to "just log in and type it in" is asking for browser automation
 * against a site whose terms almost certainly forbid it, whose session belongs
 * to a person rather than to an integration, and which breaks silently the
 * first time somebody moves a button. The honest answer is that we need an API
 * or a middleware endpoint, and the wizard says so in those words rather than
 * offering a username and password field that would imply otherwise.
 *
 * THE TEMPLATE
 *
 * `requestTemplateJson` is a JSON document with `{{platformField}}` markers.
 * Substitution only - no conditionals, no loops, no expressions - and the
 * values come from the mapping. A template language with control flow is a
 * programming language a buyer types into a form, and this is a connector, not
 * a runtime.
 */
import { env } from '../../../config/env.js';
import { ErrorCode, conflict } from '../../../domain/errors.js';
import {
  ErpCallError,
  callErpAllowingRejection,
  callErp,
  redactForLedger,
  resolveEndpointUrl,
  assertSameOriginLink,
} from '../http.js';
import {
  applyInbound,
  applyOutbound,
  extractRecords,
  readPath,
  statusToErp,
  writePath,
} from '../mapping.service.js';
import type {
  Connector,
  ConnectorConfigurationCheck,
  ConnectorContext,
  ConnectorDefaults,
  ConnectorTestResult,
  EndpointConfig,
  EndpointPurpose,
  InboundEvent,
  InboundInventoryRecord,
  InboundPage,
  OutboundPayload,
  OutboundResult,
} from './types.js';

export const customConnector: Connector = {
  system: 'CUSTOM',

  defaults(): ConnectorDefaults {
    return {
      apiStyle: 'REST_JSON',
      // Every method this platform speaks, in the order somebody should prefer
      // them. Basic is last and the wizard says why beside it.
      authMethods: [
        'OAUTH2_CLIENT_CREDENTIALS',
        'OAUTH2_AUTHORIZATION_CODE',
        'API_KEY',
        'BEARER_TOKEN',
        'BASIC',
      ],
      // Paths a great many in-house APIs actually use, offered so the form is
      // not eleven empty boxes. All of them wrong for somebody, all of them
      // editable.
      endpoints: [
        { purpose: 'PRODUCTS', path: '/products', method: 'GET', pagination: 'PAGE_NUMBER' },
        { purpose: 'WAREHOUSES', path: '/warehouses', method: 'GET', pagination: 'PAGE_NUMBER' },
        { purpose: 'INVENTORY', path: '/inventory', method: 'GET', pagination: 'PAGE_NUMBER' },
        { purpose: 'PURCHASE_ORDER_CREATE', path: '/purchase-orders', method: 'POST' },
        { purpose: 'PURCHASE_ORDER_UPDATE', path: '/purchase-orders', method: 'PATCH' },
        { purpose: 'GOODS_RECEIPT', path: '/goods-receipts', method: 'POST' },
        { purpose: 'SHIPMENT_STATUS', path: '/shipments', method: 'POST' },
        { purpose: 'INVOICE', path: '/invoices', method: 'POST' },
        { purpose: 'PAYMENT_REFERENCE', path: '/payments', method: 'POST' },
      ],
      mappings: [
        { entity: 'PRODUCT', platformField: 'sku', erpPath: 'sku', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'PRODUCT', platformField: 'name', erpPath: 'name', constantValue: null, erpValue: null, transform: null },
        { entity: 'INVENTORY', platformField: 'sku', erpPath: 'sku', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'INVENTORY', platformField: 'onHandQty', erpPath: 'onHand', constantValue: null, erpValue: null, transform: null },
        { entity: 'INVENTORY', platformField: 'onOrderQty', erpPath: 'onOrder', constantValue: null, erpValue: null, transform: null },
        { entity: 'ORDER', platformField: 'orderNumber', erpPath: 'reference', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'ORDER', platformField: 'currency', erpPath: 'currency', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
        { entity: 'ORDER', platformField: 'lineSku', erpPath: 'lines.0.sku', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'ORDER', platformField: 'lineQuantity', erpPath: 'lines.0.quantity', constantValue: null, erpValue: null, transform: null },
        { entity: 'ORDER', platformField: 'grossAmount', erpPath: 'total', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
        { entity: 'INVOICE', platformField: 'invoiceNumber', erpPath: 'number', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'INVOICE', platformField: 'grossAmount', erpPath: 'total', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
        { entity: 'INVOICE', platformField: 'currency', erpPath: 'currency', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
        { entity: 'PAYMENT', platformField: 'paymentReference', erpPath: 'reference', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'STATUS', platformField: 'CONFIRMED', erpPath: '', constantValue: null, erpValue: 'confirmed', transform: null },
        { entity: 'STATUS', platformField: 'SHIPPED', erpPath: '', constantValue: null, erpValue: 'shipped', transform: null },
        { entity: 'STATUS', platformField: 'DELIVERED', erpPath: '', constantValue: null, erpValue: 'delivered', transform: null },
        { entity: 'STATUS', platformField: 'CANCELLED', erpPath: '', constantValue: null, erpValue: 'cancelled', transform: null },
      ],
      networkNotes:
        'Your system needs an HTTPS address reachable from the internet, and a documented ' +
        'API. If it sits inside your network, put a gateway or reverse proxy in front of ' +
        'it and give us that address. If your firewall restricts who may call, ask your ' +
        'supplier for the addresses to allow.',
      supportsWebhooks: true,
    };
  },

  validateConfiguration(input: ConnectorConfigurationCheck): void {
    if (input.authMethod === 'MONDAY_PERSONAL_TOKEN') {
      throw conflict(
        ErrorCode.CUSTOMER_ERP_CONFIGURATION_REFUSED,
        'A monday.com personal token only works against monday.com. Choose one of the ' +
          'other authentication methods.',
      );
    }

    if (input.environment === 'PRODUCTION' && input.authMethod === 'BASIC') {
      // Not refused outright, unlike SAP. Some in-house APIs genuinely offer
      // nothing else, and telling a buyer their own system cannot be connected
      // when it demonstrably can would be the wrong answer. It is recorded, it
      // is shown on the dashboard, and the wizard says what it costs.
      return;
    }
  },

  /**
   * Prove the credentials work by reading one record.
   *
   * Products first, inventory second, and no third choice: a test must be a
   * READ, and those are the two endpoints every buyer configures. A test that
   * created a purchase order to prove it could is a test nobody dares press
   * twice.
   */
  async test(context: ConnectorContext): Promise<ConnectorTestResult> {
    const endpoint = context.endpoints.get('PRODUCTS') ?? context.endpoints.get('INVENTORY');

    if (endpoint === undefined) {
      throw conflict(
        ErrorCode.CUSTOMER_ERP_ENDPOINT_MISSING,
        'Add a products or inventory endpoint before testing. The test reads one record, ' +
          'so we can prove the credentials work and show you what your data looks like.',
      );
    }

    const url = resolveEndpointUrl(context.call.baseUrl, endpoint.path);

    const response =
      context.apiStyle === 'GRAPHQL'
        ? await callErp(context.call, {
            url,
            method: 'POST',
            accessToken: context.accessToken,
            body: { query: '{ __typename }' },
          })
        : await callErp(context.call, {
            url,
            method: 'GET',
            accessToken: context.accessToken,
            query: firstPageQuery(endpoint, 1),
          });

    let records: unknown[];
    try {
      records = extractRecords(response.data, endpoint.recordsPath);
    } catch {
      // An empty or unrecognised envelope during a TEST is not a failure - the
      // credentials worked, which is what a test is for. It becomes a failure
      // during a sync, where `extractRecords` is called without this guard.
      records = [];
    }

    return {
      ok: true,
      httpStatus: response.status,
      durationMs: response.durationMs,
      message:
        records.length === 0
          ? 'Your system answered and accepted the credentials. It returned no records, ' +
            'which is fine for a test - but the field mapping cannot be checked until it ' +
            'does.'
          : 'Your system answered and returned a record.',
      sample: records.length === 0 ? redactForLedger(response.data) : redactForLedger(records[0]),
    };
  },

  async send(context: ConnectorContext, outbound: OutboundPayload): Promise<OutboundResult> {
    switch (outbound.kind) {
      case 'PURCHASE_ORDER_CREATE': {
        const lines = outbound.payload.lines.map((line) => ({
          sku: line.erpMaterialNumber ?? line.sku,
          name: line.name,
          quantity: line.quantity,
          unitOfMeasure: line.unitOfMeasure,
          unitPrice: line.unitPriceMinor,
          netAmount: line.netAmountMinor,
          taxAmount: line.taxAmountMinor,
          plant: line.erpPlant,
          storageLocation: line.erpStorageLocation,
        }));

        // Placed under whatever the buyer's own mapping calls the line array -
        // see `lineArrayKey`. Writing it to a fixed `lines` regardless would
        // put the full set BESIDE the mapped one rather than into it, and a
        // system expecting `items` would be sent one line out of five.
        const extra: Record<string, unknown> = {};
        writePath(extra, lineArrayKey(context), lines);

        return write(context, 'PURCHASE_ORDER_CREATE', 'ORDER', orderValues(outbound.payload), extra);
      }

      case 'PURCHASE_ORDER_UPDATE':
        return write(context, 'PURCHASE_ORDER_UPDATE', 'ORDER', {
          ...orderValues(outbound.payload),
          shipmentStatus:
            statusToErp(context.mappings, outbound.payload.status) ?? outbound.payload.status,
        });

      case 'SHIPMENT_STATUS':
        return write(context, 'SHIPMENT_STATUS', 'ORDER', {
          orderNumber: outbound.payload.orderNumber,
          purchaseOrderNumber: outbound.payload.erpPurchaseOrderId,
          shipmentStatus:
            statusToErp(context.mappings, outbound.payload.status) ?? outbound.payload.status,
          trackingNumber: outbound.payload.trackingNumber,
        });

      case 'GOODS_RECEIPT':
        return write(
          context,
          'GOODS_RECEIPT',
          'INVENTORY',
          {
            goodsReceiptId: null,
            receiptQuantity: outbound.payload.lines.reduce(
              (total, line) => total + line.quantity,
              0,
            ),
          },
          {
            purchaseOrder: outbound.payload.erpPurchaseOrderId,
            reference: outbound.payload.orderNumber,
            receivedAt: outbound.payload.receivedAt,
            lines: outbound.payload.lines,
          },
        );

      case 'INVOICE_SYNC':
        return write(context, 'INVOICE', 'INVOICE', {
          invoiceNumber: outbound.payload.invoiceNumber,
          invoiceDate: outbound.payload.issuedAt,
          dueDate: outbound.payload.dueAt,
          currency: outbound.payload.currency,
          netAmount: outbound.payload.netAmountMinor,
          taxAmount: outbound.payload.taxAmountMinor,
          grossAmount: outbound.payload.grossAmountMinor,
          documentUrl: outbound.payload.documentUrl,
          purchaseOrderNumber: outbound.payload.erpPurchaseOrderId ?? outbound.payload.orderNumber,
        });

      case 'PAYMENT_REFERENCE':
        return write(context, 'PAYMENT_REFERENCE', 'PAYMENT', {
          paymentReference: outbound.payload.reference,
          paymentStatus: outbound.payload.status,
          paidAmount: outbound.payload.paidAmountMinor,
          currency: outbound.payload.currency,
          paidAt: outbound.payload.paidAt,
          invoiceNumber: outbound.payload.invoiceNumber,
        });
    }
  },

  async readInventory(context: ConnectorContext, cursor: string | null): Promise<InboundPage> {
    const endpoint = context.endpoints.get('INVENTORY');

    if (endpoint === undefined || !endpoint.enabled) {
      throw conflict(
        ErrorCode.CUSTOMER_ERP_ENDPOINT_MISSING,
        'No inventory endpoint is configured on this connection.',
      );
    }

    // An OData `nextLink` is an absolute URL and is followed as one, after
    // being re-checked against the connection's own origin. Every other paging
    // style puts its cursor in a query parameter on the same address.
    const url =
      endpoint.pagination === 'ODATA_NEXT_LINK' && cursor !== null
        ? assertSameOriginLink(context.call.baseUrl, cursor)
        : resolveEndpointUrl(context.call.baseUrl, endpoint.path);

    const response = await callErp(context.call, {
      url,
      method: (endpoint.method as 'GET') ?? 'GET',
      accessToken: context.accessToken,
      query: pageQuery(endpoint, cursor),
    });

    const records = extractRecords(response.data, endpoint.recordsPath);

    return {
      records: records.map((record) => toInventoryRecord(context, record)),
      nextCursor: nextCursorOf(endpoint, response.data, cursor, records.length),
      httpStatus: response.status,
      durationMs: response.durationMs,
    };
  },

  interpretWebhook(context: ConnectorContext, payload: unknown): InboundEvent[] {
    const type = (
      asText(readPath(payload, 'type')) ??
      asText(readPath(payload, 'event')) ??
      asText(readPath(payload, 'eventType')) ??
      ''
    ).toLowerCase();

    const data = (readPath(payload, 'data') ?? payload);

    if (type.includes('receipt') || type.includes('delivery')) {
      const lines = readPath(data, 'lines');

      return [
        {
          kind: 'GOODS_RECEIPT',
          erpPurchaseOrderId: asText(
            readPath(data, 'purchaseOrder') ?? readPath(data, 'purchaseOrderId'),
          ),
          erpGoodsReceiptId: asText(readPath(data, 'goodsReceiptId') ?? readPath(data, 'id')),
          receivedAt: asText(readPath(data, 'receivedAt') ?? readPath(data, 'date')),
          lines: (Array.isArray(lines) ? lines : []).map((line) => ({
            erpMaterialNumber: asText(readPath(line, 'sku') ?? readPath(line, 'material')),
            sku: asText(readPath(line, 'sku')),
            quantity: Number(readPath(line, 'quantity') ?? 0) || 0,
          })),
        },
      ];
    }

    if (type.includes('order') || type.includes('status')) {
      const status = asText(readPath(data, 'status'));
      if (status === null) return [];

      return [
        {
          kind: 'ORDER_STATUS',
          erpPurchaseOrderId: asText(
            readPath(data, 'purchaseOrder') ?? readPath(data, 'reference'),
          ),
          erpStatus: status,
        },
      ];
    }

    if (type.includes('stock') || type.includes('inventory')) {
      const records = Array.isArray(data) ? data : [data];

      return [
        {
          kind: 'INVENTORY',
          records: records.map((record) => toInventoryRecord(context, record)),
        },
      ];
    }

    return [];
  },
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * One write, built entirely from the buyer's own configuration.
 *
 * The body is the mapping's output, merged over the endpoint's request template
 * where there is one, with `extra` supplying the structured parts a flat
 * mapping cannot express - the order lines, most of all. A 409 is treated as
 * "already there", because a buyer's API that answers a duplicate reference
 * that way is telling us the record exists, and creating a second one is
 * exactly what this feature must never do.
 */
async function write(
  context: ConnectorContext,
  purpose: EndpointPurpose,
  entity: 'ORDER' | 'INVENTORY' | 'INVOICE' | 'PAYMENT',
  values: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<OutboundResult> {
  const endpoint = context.endpoints.get(purpose);

  // Not configured, or switched off. A buyer who has not given us a
  // goods-receipt endpoint has said, by omission, that they do not want goods
  // receipts posted - and the pipeline records that as SKIPPED with a reason
  // rather than as a failure.
  if (endpoint === undefined || !endpoint.enabled) {
    return {
      erpReference: null,
      httpStatus: null,
      durationMs: 0,
      request: null,
      response: null,
      alreadyPresent: true,
    };
  }

  const { body: mapped, missing } = applyOutbound(context.mappings, entity, values, {
    currencyExponent: context.currencyExponent,
  });

  if (missing.length > 0) {
    throw new ErpCallError(
      `Your ${entity.toLowerCase()} mapping is missing ${missing.join(', ')}. Add it in ` +
        'Field mapping, then retry this.',
      'REJECTED',
    );
  }

  const body =
    endpoint.requestTemplate === null
      ? mergeBody(extra, mapped)
      : mergeBody(fillTemplate(endpoint.requestTemplate, { ...values, ...extra }), mapped);

  const url = resolveEndpointUrl(context.call.baseUrl, endpoint.path);

  const response = await callErpAllowingRejection<Record<string, unknown>>(context.call, {
    url,
    method: (endpoint.method as 'POST') ?? 'POST',
    body: context.apiStyle === 'GRAPHQL' ? { query: graphqlMutation(purpose), variables: body } : body,
    accessToken: context.accessToken,
  });

  if ('rejected' in response) {
    if (response.status === 409) {
      return {
        erpReference: null,
        httpStatus: response.status,
        durationMs: 0,
        request: redactForLedger(body),
        response: { message: response.body },
        alreadyPresent: true,
      };
    }

    throw new ErpCallError(response.body, 'REJECTED', response.status);
  }

  return {
    erpReference: referenceOf(context, response.data),
    httpStatus: response.status,
    durationMs: response.durationMs,
    request: redactForLedger(body),
    response: redactForLedger(response.data),
    alreadyPresent: false,
  };
}

/**
 * What this buyer's system calls the array of order lines.
 *
 * Taken from their own mapping rather than assumed. A flat mapping can only
 * address one line, so it is written as `items.0.sku` or `lines.0.sku` or
 * `DocumentLines.0.ItemCode` - and the segment before the index is the name
 * that system gives the array. The connector supplies every line under exactly
 * that name, so the two halves of the body describe one array instead of two.
 *
 * Get this wrong and the failure is quiet and expensive: a body carrying
 * `lines` with all five and `items` with the first one, sent to a system that
 * reads `items`, is a purchase order for a fifth of the goods that was accepted
 * with a 201.
 *
 * `lines` when the mapping says nothing, which is the connector's own default
 * shape and what the sample payload shows.
 */
function lineArrayKey(context: ConnectorContext): string {
  for (const field of ['lineSku', 'lineQuantity'] as const) {
    const row = context.mappings.find(
      (entry) => entry.entity === 'ORDER' && entry.platformField === field,
    );

    const path = row?.erpPath.trim() ?? '';
    if (path.length === 0) continue;

    // `items.0.sku` -> `items`. A path with no index addresses a single value
    // rather than a line array, so it says nothing about the array's name.
    const segments = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    const indexAt = segments.findIndex((segment) => /^\d+$/.test(segment));

    if (indexAt > 0) return segments.slice(0, indexAt).join('.');
  }

  return 'lines';
}

/**
 * Lay the mapping's output over the structured parts, without flattening them.
 *
 * The two halves of a request body describe the same document at different
 * resolutions. `extra` carries what a flat mapping cannot say - every order
 * line, with its unit of measure, its plant, its amounts. The mapping carries
 * where the buyer's own API wants each field, including `lines.0.sku`, which
 * addresses the FIRST line and nothing else.
 *
 * A shallow merge resolves that disagreement the worst possible way: a mapped
 * `lines.0.sku` arrives as a one-element array and replaces all five lines of a
 * real order, so the ERP is sent a purchase order missing four lines and
 * answers 201. Nothing fails, nothing is logged, and the buyer finds out when
 * the goods arrive.
 *
 * So the merge goes deep. Objects combine key by key; arrays combine position
 * by position, keeping every element the mapping had nothing to say about; a
 * leaf present on both sides is the mapping's, because that is the buyer
 * telling us where the value goes and which transform it carries. An element
 * the mapping supplies past the end of the structured array is appended, since
 * the alternative is dropping a value the buyer explicitly mapped.
 */
function mergeBody(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    result[key] = mergeValue(result[key], value);
  }

  return result;
}

function mergeValue(base: unknown, override: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(override)) {
    const merged = [...(base as unknown[])];

    (override as unknown[]).forEach((entry, index) => {
      merged[index] = index < base.length ? mergeValue(merged[index], entry) : entry;
    });

    return merged;
  }

  if (isPlainObject(base) && isPlainObject(override)) {
    return mergeBody(base, override);
  }

  return override;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Substitute `{{field}}` markers in a template.
 *
 * Substitution and nothing else. A marker with no value becomes null rather
 * than the literal `{{field}}`, because a buyer's API receiving the string
 * "{{deliveryDate}}" as a date is a worse failure than receiving null - it will
 * either be stored as-is or rejected with a message about a date format.
 */
function fillTemplate(
  template: Record<string, unknown>,
  values: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth > 8) return {};

  const result: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(template)) {
    if (typeof entry === 'string') {
      const marker = /^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/.exec(entry);
      result[key] = marker === null ? entry : (values[marker[1] as string] ?? null);
      continue;
    }

    if (Array.isArray(entry)) {
      // `Array.isArray` narrows to `any[]`, so the element is annotated back to
      // `unknown` rather than inherited - otherwise every branch below is an
      // unchecked `any` flowing into the outbound body.
      result[key] = (entry as unknown[]).map((item: unknown) =>
        item !== null && typeof item === 'object'
          ? fillTemplate(item as Record<string, unknown>, values, depth + 1)
          : item,
      );
      continue;
    }

    if (entry !== null && typeof entry === 'object') {
      result[key] = fillTemplate(entry as Record<string, unknown>, values, depth + 1);
      continue;
    }

    result[key] = entry;
  }

  return result;
}

/**
 * A GraphQL mutation name for a purpose.
 *
 * Deliberately conventional rather than configurable. A buyer whose GraphQL
 * schema names its mutations differently is better served by REST or OData than
 * by a form field asking them to paste a mutation document - which would be a
 * query language typed into a text box, with all of that language's ability to
 * read anything the credential can reach.
 */
function graphqlMutation(purpose: EndpointPurpose): string {
  const name = purpose
    .toLowerCase()
    .replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());

  return `mutation Sync($input: JSON!) { ${name}(input: $input) { id } }`;
}

function orderValues(payload: {
  orderNumber: string;
  orderedAt: string;
  currency: string;
  vendorId: string | null;
  customerId: string | null;
  netAmountMinor: string;
  taxAmountMinor: string;
  grossAmountMinor: string;
  requestedDeliveryAt: string | null;
  lines: { sku: string; quantity: number; unitOfMeasure: string | null; erpPlant: string | null }[];
}): Record<string, unknown> {
  const first = payload.lines[0];

  return {
    orderNumber: payload.orderNumber,
    orderDate: payload.orderedAt,
    currency: payload.currency,
    vendorId: payload.vendorId,
    customerId: payload.customerId,
    netAmount: payload.netAmountMinor,
    taxAmount: payload.taxAmountMinor,
    grossAmount: payload.grossAmountMinor,
    deliveryDate: payload.requestedDeliveryAt,
    // The flat mapping can only address one line; `extra.lines` carries the
    // whole set. Both are provided so a buyer whose API takes one line per call
    // and one whose API takes an array are both served.
    lineSku: first?.sku ?? null,
    lineQuantity: first?.quantity ?? null,
    lineUnitOfMeasure: first?.unitOfMeasure ?? null,
    lineWarehouse: first?.erpPlant ?? null,
  };
}

/**
 * Where the buyer's API put the identifier of what it just created.
 *
 * Their mapping says, where they mapped `purchaseOrderNumber`. Failing that,
 * the four field names that between them cover most APIs. A null here is not
 * fatal - the event still succeeded - but it means the next event about this
 * order has nothing to reference, which the ledger records.
 */
function referenceOf(context: ConnectorContext, body: unknown): string | null {
  const mapped = context.mappings.find(
    (row) => row.entity === 'ORDER' && row.platformField === 'purchaseOrderNumber',
  );

  if (mapped !== undefined && mapped.erpPath.trim().length > 0) {
    const value = asText(readPath(body, mapped.erpPath.trim()));
    if (value !== null) return value;
  }

  for (const candidate of ['id', 'reference', 'number', 'purchaseOrderId', 'data.id']) {
    const value = asText(readPath(body, candidate));
    if (value !== null) return value;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

function firstPageQuery(endpoint: EndpointConfig, size: number): Record<string, string> {
  const config = endpoint.paginationConfig;

  switch (endpoint.pagination) {
    case 'PAGE_NUMBER':
      return {
        [config.pageParam ?? 'page']: '1',
        [config.sizeParam ?? 'pageSize']: String(size),
      };
    case 'OFFSET_LIMIT':
      return {
        [config.offsetParam ?? 'offset']: '0',
        [config.limitParam ?? 'limit']: String(size),
      };
    case 'CURSOR':
      return { [config.limitParam ?? 'limit']: String(size) };
    case 'NONE':
    case 'ODATA_NEXT_LINK':
      return {};
  }
}

/**
 * The query parameters for one page.
 *
 * The cursor is opaque to the pipeline and interpreted here according to the
 * paging style: a page number, an offset, or an actual cursor the previous
 * response handed back.
 */
function pageQuery(endpoint: EndpointConfig, cursor: string | null): Record<string, string> {
  const config = endpoint.paginationConfig;
  const size = Math.min(config.pageSize ?? 200, env.CUSTOMER_ERP_MAX_SYNC_RECORDS);

  if (cursor === null) return firstPageQuery(endpoint, size);

  switch (endpoint.pagination) {
    case 'PAGE_NUMBER':
      return {
        [config.pageParam ?? 'page']: cursor,
        [config.sizeParam ?? 'pageSize']: String(size),
      };
    case 'OFFSET_LIMIT':
      return {
        [config.offsetParam ?? 'offset']: cursor,
        [config.limitParam ?? 'limit']: String(size),
      };
    case 'CURSOR':
      return {
        [config.cursorParam ?? 'cursor']: cursor,
        [config.limitParam ?? 'limit']: String(size),
      };
    case 'NONE':
    case 'ODATA_NEXT_LINK':
      return {};
  }
}

/**
 * Where the next page starts, or null when there is no next page.
 *
 * A short page ends the run for the counting styles, which is the only
 * termination condition that works against an API with no total: asking for two
 * hundred and getting a hundred and eighty means that was the last of them.
 */
function nextCursorOf(
  endpoint: EndpointConfig,
  body: unknown,
  cursor: string | null,
  received: number,
): string | null {
  const config = endpoint.paginationConfig;
  const size = Math.min(config.pageSize ?? 200, env.CUSTOMER_ERP_MAX_SYNC_RECORDS);

  switch (endpoint.pagination) {
    case 'NONE':
      return null;

    case 'ODATA_NEXT_LINK':
      return (
        asText(readPath(body, '@odata.nextLink')) ?? asText(readPath(body, 'd.__next')) ?? null
      );

    case 'CURSOR':
      return asText(readPath(body, config.cursorPath ?? 'nextCursor'));

    case 'PAGE_NUMBER': {
      if (received < size) return null;
      const current = cursor === null ? 1 : Number.parseInt(cursor, 10) || 1;
      return String(current + 1);
    }

    case 'OFFSET_LIMIT': {
      if (received < size) return null;
      const current = cursor === null ? 0 : Number.parseInt(cursor, 10) || 0;
      return String(current + received);
    }
  }
}

function toInventoryRecord(
  context: ConnectorContext,
  record: unknown,
): InboundInventoryRecord {
  const values = applyInbound(context.mappings, 'INVENTORY', record, {
    currencyExponent: context.currencyExponent,
  });

  return {
    erpMaterialNumber: asText(values['sku']),
    sku: asText(values['sku']),
    plant: asText(values['plant']),
    onHandQty: asNumber(values['onHandQty']),
    onOrderQty: asNumber(values['onOrderQty']),
    incomingQty: asNumber(values['incomingQty']),
    unitOfMeasure: asText(values['unitOfMeasure']),
    raw: redactForLedger(record),
  };
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length === 0 ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
