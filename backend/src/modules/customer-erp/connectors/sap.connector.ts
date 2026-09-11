/**
 * SAP S/4HANA and SAP ERP.
 *
 * Spoken to over the OData services a communication arrangement exposes, or over
 * whatever REST facade a buyer has put in front of an older landscape. Both are
 * supported and the difference is `apiStyle`: ODATA turns on the two things
 * that make SAP's OData different from every other HTTP API in this codebase,
 * and REST_JSON leaves them off.
 *
 * THE TWO SAP-SHAPED PROBLEMS
 *
 *   1. **CSRF tokens.** An OData V2 service refuses a POST that does not carry
 *      `X-CSRF-Token`, and the only way to get one is to ask for it on a read
 *      first - `X-CSRF-Token: Fetch` - and then send it back together with the
 *      session cookie that came with it. Miss the cookie and the token is
 *      refused; miss the token and the write is. `fetchCsrfToken` below does
 *      both, once per write, and `callErp` grew `extraHeaders`/`cookies` for
 *      exactly this.
 *
 *   2. **On-premise landscapes are not on the internet.** A buyer running ECC
 *      in their own data centre gives us the address of an SAP Cloud Connector
 *      or a reverse proxy they run, not the address of SAP. Nothing in the code
 *      changes - it is still an https host we resolve, check and pin - but the
 *      instructions the buyer's IT team needs are entirely different, which is
 *      what `networkNotes` on the defaults is for.
 *
 * WHAT THIS CONNECTOR DOES NOT DO
 *
 * It does not log into SAP GUI, drive a browser, or scrape anything. Every path
 * below is a documented API. A buyer whose SAP has no API exposed cannot be
 * connected, and the honest answer to that is a sentence telling them to ask
 * their Basis team for a communication arrangement - not a robot typing into
 * their ERP overnight.
 */
import { env } from '../../../config/env.js';
import { ErrorCode, conflict } from '../../../domain/errors.js';
import {
  ErpCallError,
  callErp,
  callErpAllowingRejection,
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
} from '../mapping.service.js';
import type {
  Connector,
  ConnectorConfigurationCheck,
  ConnectorContext,
  ConnectorDefaults,
  ConnectorTestResult,
  EndpointPurpose,
  InboundEvent,
  InboundInventoryRecord,
  InboundPage,
  OutboundPayload,
  OutboundResult,
} from './types.js';

/**
 * The standard S/4HANA API paths.
 *
 * Offered as defaults and every one of them editable, because a buyer's Basis
 * team may have exposed them under a different alias, a different service group
 * or a gateway prefix. What the defaults buy is the buyer not having to work
 * out from scratch that a purchase order lives in
 * `API_PURCHASEORDER_PROCESS_SRV`.
 */
const S4_PATHS: Readonly<Record<string, string>> = Object.freeze({
  PRODUCTS: '/sap/opu/odata/sap/API_PRODUCT_SRV/A_Product',
  WAREHOUSES: '/sap/opu/odata/sap/API_PLANT_SRV/A_Plant',
  INVENTORY: '/sap/opu/odata/sap/API_MATERIAL_STOCK_SRV/A_MatlStkInAcctMod',
  PURCHASE_ORDER_CREATE: '/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder',
  PURCHASE_ORDER_UPDATE: '/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder',
  GOODS_RECEIPT:
    '/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV/A_MaterialDocumentHeader',
  SHIPMENT_STATUS: '/sap/opu/odata/sap/API_INBOUND_DELIVERY_SRV/A_InbDeliveryHeader',
  INVOICE: '/sap/opu/odata/sap/API_SUPPLIERINVOICE_PROCESS_SRV/A_SupplierInvoice',
  PAYMENT_REFERENCE: '/sap/opu/odata/sap/API_SUPPLIERINVOICE_PROCESS_SRV/A_SupplierInvoice',
});

export const sapConnector: Connector = {
  system: 'SAP',

  defaults(): ConnectorDefaults {
    return {
      apiStyle: 'ODATA',
      // Client credentials first and by a distance: a communication arrangement
      // is what SAP itself recommends and is the only one of the three that
      // does not tie the integration to one person's account. Basic is offered
      // last because some on-premise landscapes genuinely still require it.
      authMethods: ['OAUTH2_CLIENT_CREDENTIALS', 'BEARER_TOKEN', 'BASIC'],
      endpoints: [
        { purpose: 'PRODUCTS', path: S4_PATHS.PRODUCTS ?? '', method: 'GET', pagination: 'ODATA_NEXT_LINK', recordsPath: 'd.results' },
        { purpose: 'INVENTORY', path: S4_PATHS.INVENTORY ?? '', method: 'GET', pagination: 'ODATA_NEXT_LINK', recordsPath: 'd.results' },
        { purpose: 'WAREHOUSES', path: S4_PATHS.WAREHOUSES ?? '', method: 'GET', pagination: 'ODATA_NEXT_LINK', recordsPath: 'd.results' },
        { purpose: 'PURCHASE_ORDER_CREATE', path: S4_PATHS.PURCHASE_ORDER_CREATE ?? '', method: 'POST' },
        { purpose: 'PURCHASE_ORDER_UPDATE', path: S4_PATHS.PURCHASE_ORDER_UPDATE ?? '', method: 'PATCH' },
        { purpose: 'GOODS_RECEIPT', path: S4_PATHS.GOODS_RECEIPT ?? '', method: 'POST' },
        { purpose: 'INVOICE', path: S4_PATHS.INVOICE ?? '', method: 'POST' },
      ],
      // The SAP field names, as S/4HANA spells them. A buyer on ECC or with a
      // custom facade changes them; a buyer on stock S/4HANA does not have to.
      mappings: [
        { entity: 'PRODUCT', platformField: 'sku', erpPath: 'Product', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'PRODUCT', platformField: 'name', erpPath: 'ProductDescription', constantValue: null, erpValue: null, transform: null },
        { entity: 'PRODUCT', platformField: 'unitOfMeasure', erpPath: 'BaseUnit', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
        { entity: 'INVENTORY', platformField: 'sku', erpPath: 'Material', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'INVENTORY', platformField: 'plant', erpPath: 'Plant', constantValue: null, erpValue: null, transform: null },
        { entity: 'INVENTORY', platformField: 'onHandQty', erpPath: 'MatlWrhsStkQtyInMatlBaseUnit', constantValue: null, erpValue: null, transform: null },
        { entity: 'INVENTORY', platformField: 'unitOfMeasure', erpPath: 'MaterialBaseUnit', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
        { entity: 'ORDER', platformField: 'orderNumber', erpPath: 'PurchaseOrderByCustomer', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'ORDER', platformField: 'currency', erpPath: 'DocumentCurrency', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
        { entity: 'ORDER', platformField: 'vendorId', erpPath: 'Supplier', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'ORDER', platformField: 'lineSku', erpPath: 'Material', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'ORDER', platformField: 'lineQuantity', erpPath: 'OrderQuantity', constantValue: null, erpValue: null, transform: null },
        { entity: 'ORDER', platformField: 'lineUnitOfMeasure', erpPath: 'PurchaseOrderQuantityUnit', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
        { entity: 'ORDER', platformField: 'lineUnitPrice', erpPath: 'NetPriceAmount', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
        { entity: 'ORDER', platformField: 'lineWarehouse', erpPath: 'Plant', constantValue: null, erpValue: null, transform: null },
        { entity: 'INVOICE', platformField: 'invoiceNumber', erpPath: 'SupplierInvoiceIDByInvcgParty', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'INVOICE', platformField: 'currency', erpPath: 'DocumentCurrency', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
        { entity: 'INVOICE', platformField: 'grossAmount', erpPath: 'InvoiceGrossAmount', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
        { entity: 'INVOICE', platformField: 'dueDate', erpPath: 'DueCalculationBaseDate', constantValue: null, erpValue: null, transform: 'DATE_ONLY' },
        { entity: 'STATUS', platformField: 'CONFIRMED', erpPath: '', constantValue: null, erpValue: 'Released', transform: null },
        { entity: 'STATUS', platformField: 'SHIPPED', erpPath: '', constantValue: null, erpValue: 'Goods Issued', transform: null },
        { entity: 'STATUS', platformField: 'DELIVERED', erpPath: '', constantValue: null, erpValue: 'Delivery Completed', transform: null },
        { entity: 'STATUS', platformField: 'CANCELLED', erpPath: '', constantValue: null, erpValue: 'Deleted', transform: null },
      ],
      networkNotes:
        'Give your Basis team the address of the OData service and ask them for a ' +
        'communication arrangement with a communication user, restricted to the purchase ' +
        'order, material stock and supplier invoice APIs. If your SAP is on-premise, this ' +
        'address should be your SAP Cloud Connector or reverse proxy, reachable over HTTPS ' +
        'from the internet - not the SAP host itself.',
      supportsWebhooks: true,
    };
  },

  validateConfiguration(input: ConnectorConfigurationCheck): void {
    if (input.authMethod === 'MONDAY_PERSONAL_TOKEN') {
      throw conflict(
        ErrorCode.CUSTOMER_ERP_CONFIGURATION_REFUSED,
        'A monday.com personal token cannot authenticate against SAP. Use a communication ' +
          'arrangement with OAuth client credentials.',
      );
    }

    // Not a preference. A purchase order raised without a company code and a
    // purchasing organisation is refused by SAP itself, and a plant is what
    // decides which warehouse the goods are expected at.
    if (input.sap.companyCode === null || input.sap.purchasingOrg === null) {
      throw conflict(
        ErrorCode.CUSTOMER_ERP_CONFIGURATION_REFUSED,
        'SAP needs a company code and a purchasing organisation before it will accept a ' +
          'purchase order. Your finance or purchasing team will know both.',
      );
    }

    if (input.environment === 'PRODUCTION' && input.authMethod === 'BASIC') {
      // Refused rather than merely discouraged. A username and password sent on
      // every request has no expiry, no scope and no revocation short of
      // changing it everywhere, and this is the one configuration where the
      // alternative is genuinely available on every supported SAP release.
      throw conflict(
        ErrorCode.CUSTOMER_ERP_CONFIGURATION_REFUSED,
        'A production SAP connection needs OAuth or a bearer token rather than a username ' +
          'and password. Ask your Basis team for a communication arrangement; a username ' +
          'and password can still be used on a sandbox connection.',
      );
    }
  },

  /**
   * Prove the credentials work by reading one product.
   *
   * `$top=1` rather than a full read: a test that pulled a buyer's entire
   * material master to prove it could would take a minute and time out on the
   * landscapes that most need testing.
   */
  async test(context: ConnectorContext): Promise<ConnectorTestResult> {
    const endpoint =
      context.endpoints.get('PRODUCTS') ?? context.endpoints.get('INVENTORY');

    if (endpoint === undefined) {
      throw conflict(
        ErrorCode.CUSTOMER_ERP_ENDPOINT_MISSING,
        'Add a products or inventory endpoint before testing - the test reads one record ' +
          'to prove the credentials work and to show you what your data looks like.',
      );
    }

    const url = resolveEndpointUrl(context.call.baseUrl, endpoint.path);

    const response = await callErp(context.call, {
      url,
      method: 'GET',
      accessToken: context.accessToken,
      query: odataQuery(context, { top: 1 }),
    });

    const records = safeExtract(response.data, endpoint.recordsPath);

    return {
      ok: true,
      httpStatus: response.status,
      durationMs: response.durationMs,
      message:
        records.length === 0
          ? 'Your SAP answered and accepted the credentials. It returned no records, which ' +
            'is fine for a test - but the field mapping cannot be checked until it does.'
          : 'Your SAP answered and returned a record.',
      sample: records.length === 0 ? null : redactForLedger(records[0]),
    };
  },

  async send(context: ConnectorContext, outbound: OutboundPayload): Promise<OutboundResult> {
    switch (outbound.kind) {
      case 'PURCHASE_ORDER_CREATE':
        return createPurchaseOrder(context, outbound.payload);
      case 'PURCHASE_ORDER_UPDATE':
        return updatePurchaseOrder(context, outbound.payload);
      case 'GOODS_RECEIPT':
        return postGoodsReceipt(context, outbound.payload);
      case 'SHIPMENT_STATUS':
        return postShipmentStatus(context, outbound.payload);
      case 'INVOICE_SYNC':
        return postInvoice(context, outbound.payload);
      case 'PAYMENT_REFERENCE':
        return postPaymentReference(context, outbound.payload);
    }
  },

  async readInventory(context: ConnectorContext, cursor: string | null): Promise<InboundPage> {
    const endpoint = context.endpoints.get('INVENTORY');

    if (endpoint === undefined) {
      throw conflict(
        ErrorCode.CUSTOMER_ERP_ENDPOINT_MISSING,
        'No inventory endpoint is configured on this connection.',
      );
    }

    // A cursor here is SAP's own `@odata.nextLink`, so it is followed as an
    // absolute URL - after being re-checked against the connection's origin,
    // because it arrived in a response body rather than from a person.
    const url =
      cursor === null
        ? resolveEndpointUrl(context.call.baseUrl, endpoint.path)
        : assertSameOriginLink(context.call.baseUrl, cursor);

    const response = await callErp(context.call, {
      url,
      method: 'GET',
      accessToken: context.accessToken,
      ...(cursor === null
        ? {
            query: odataQuery(context, {
              top: Math.min(
                endpoint.paginationConfig.pageSize ?? 500,
                env.CUSTOMER_ERP_MAX_SYNC_RECORDS,
              ),
            }),
          }
        : {}),
    });

    const records = extractRecords(response.data, endpoint.recordsPath);

    return {
      records: records.map((record) => toInventoryRecord(context, record)),
      nextCursor: nextLinkOf(response.data),
      httpStatus: response.status,
      durationMs: response.durationMs,
    };
  },

  interpretWebhook(context: ConnectorContext, payload: unknown): InboundEvent[] {
    // SAP event meshes and the middleware in front of on-premise landscapes
    // disagree about envelopes, so the type is looked for in the three places
    // it actually turns up rather than in one place we would rather it were.
    const type = (
      asText(readPath(payload, 'type')) ??
      asText(readPath(payload, 'eventType')) ??
      asText(readPath(payload, 'data.eventType')) ??
      ''
    ).toLowerCase();

    const data = (readPath(payload, 'data') ?? payload);

    if (type.includes('materialdocument') || type.includes('goodsreceipt')) {
      const lines = (readPath(data, 'items') ?? readPath(data, 'to_MaterialDocumentItem.results') ?? []) as unknown[];

      return [
        {
          kind: 'GOODS_RECEIPT',
          erpPurchaseOrderId: asText(readPath(data, 'PurchaseOrder')),
          erpGoodsReceiptId: asText(readPath(data, 'MaterialDocument')),
          receivedAt: asText(readPath(data, 'DocumentDate')),
          lines: (Array.isArray(lines) ? lines : []).map((line) => ({
            erpMaterialNumber: asText(readPath(line, 'Material')),
            sku: asText(readPath(line, 'Material')),
            quantity: Number(readPath(line, 'QuantityInEntryUnit') ?? 0) || 0,
          })),
        },
      ];
    }

    if (type.includes('purchaseorder')) {
      const status = asText(readPath(data, 'PurchasingDocumentStatus') ?? readPath(data, 'status'));
      if (status === null) return [];

      return [
        {
          kind: 'ORDER_STATUS',
          erpPurchaseOrderId: asText(readPath(data, 'PurchaseOrder')),
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

    // Something we have no rule for. Not an error: an event mesh subscribed to
    // a whole topic will send plenty we do not act on, and refusing them would
    // turn the buyer's delivery log red for no reason.
    return [];
  },
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Raise the purchase order.
 *
 * The header carries the buyer's organisational keys - company code,
 * purchasing organisation, purchasing group - and the lines are built through
 * the mapping so a buyer whose field names differ is not stuck. A 409 from SAP
 * on the document number is treated as "already there", which is what makes a
 * retry safe against a system that does not honour an idempotency header.
 */
async function createPurchaseOrder(
  context: ConnectorContext,
  payload: Parameters<typeof buildPurchaseOrderBody>[1],
): Promise<OutboundResult> {
  const endpoint = requireEndpoint(context, 'PURCHASE_ORDER_CREATE');
  const url = resolveEndpointUrl(context.call.baseUrl, endpoint.path);

  const body = buildPurchaseOrderBody(context, payload);
  const csrf = await fetchCsrfToken(context);

  const response = await callErpAllowingRejection<Record<string, unknown>>(context.call, {
    url,
    method: (endpoint.method as 'POST') ?? 'POST',
    body,
    accessToken: context.accessToken,
    ...csrf,
  });

  if ('rejected' in response) {
    // SAP answers a duplicate document with 409, and some gateways with 400
    // carrying a duplicate message. Either way the purchase order exists, and
    // creating a second one is precisely what this whole feature must not do.
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
    erpReference: purchaseOrderIdOf(response.data),
    httpStatus: response.status,
    durationMs: response.durationMs,
    request: redactForLedger(body),
    response: redactForLedger(response.data),
    alreadyPresent: false,
  };
}

async function updatePurchaseOrder(
  context: ConnectorContext,
  payload: Parameters<typeof buildPurchaseOrderBody>[1] & { status: string },
): Promise<OutboundResult> {
  const endpoint = requireEndpoint(context, 'PURCHASE_ORDER_UPDATE');
  const url = resolveEndpointUrl(context.call.baseUrl, endpoint.path);

  const body: Record<string, unknown> = {
    PurchaseOrderByCustomer: payload.orderNumber,
  };

  const erpStatus = statusToErp(context.mappings, payload.status);
  if (erpStatus !== null) body['PurchasingDocumentStatus'] = erpStatus;

  const csrf = await fetchCsrfToken(context);

  const response = await callErp<Record<string, unknown>>(context.call, {
    url,
    method: (endpoint.method as 'PATCH') ?? 'PATCH',
    body,
    accessToken: context.accessToken,
    ...csrf,
  });

  return {
    erpReference: purchaseOrderIdOf(response.data),
    httpStatus: response.status,
    durationMs: response.durationMs,
    request: redactForLedger(body),
    response: redactForLedger(response.data),
    alreadyPresent: false,
  };
}

/**
 * Post the goods receipt - the one write that may move on-hand stock.
 *
 * A material document against the purchase order, movement type 101, which is
 * SAP's "goods receipt for purchase order". Nothing here decides WHETHER to
 * post it; that is the pipeline's decision and it depends on the buyer's policy
 * and possibly on an approval.
 */
async function postGoodsReceipt(
  context: ConnectorContext,
  payload: Extract<OutboundPayload, { kind: 'GOODS_RECEIPT' }>['payload'],
): Promise<OutboundResult> {
  const endpoint = requireEndpoint(context, 'GOODS_RECEIPT');
  const url = resolveEndpointUrl(context.call.baseUrl, endpoint.path);

  const body: Record<string, unknown> = {
    GoodsMovementCode: '01',
    DocumentDate: payload.receivedAt.slice(0, 10),
    PostingDate: payload.receivedAt.slice(0, 10),
    ReferenceDocument: payload.orderNumber,
    to_MaterialDocumentItem: {
      results: payload.lines.map((line) => ({
        Material: line.erpMaterialNumber ?? line.sku,
        Plant: line.erpPlant ?? context.sap.plant,
        StorageLocation: line.erpStorageLocation ?? context.sap.storageLocation,
        GoodsMovementType: '101',
        PurchaseOrder: payload.erpPurchaseOrderId,
        QuantityInEntryUnit: line.quantity,
        EntryUnit: line.unitOfMeasure,
      })),
    },
  };

  const csrf = await fetchCsrfToken(context);

  const response = await callErp<Record<string, unknown>>(context.call, {
    url,
    method: 'POST',
    body,
    accessToken: context.accessToken,
    ...csrf,
  });

  return {
    erpReference: asText(readPath(unwrapOdata(response.data), 'MaterialDocument')),
    httpStatus: response.status,
    durationMs: response.durationMs,
    request: redactForLedger(body),
    response: redactForLedger(response.data),
    alreadyPresent: false,
  };
}

async function postShipmentStatus(
  context: ConnectorContext,
  payload: Extract<OutboundPayload, { kind: 'SHIPMENT_STATUS' }>['payload'],
): Promise<OutboundResult> {
  const endpoint = context.endpoints.get('SHIPMENT_STATUS');

  // A buyer who has not configured an inbound-delivery endpoint has said, by
  // omission, that they do not track our shipments in SAP. Skipping is the
  // correct answer and the pipeline records it as SKIPPED with a reason.
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

  const url = resolveEndpointUrl(context.call.baseUrl, endpoint.path);

  const body: Record<string, unknown> = {
    PurchaseOrder: payload.erpPurchaseOrderId,
    DeliveryDocumentByCustomer: payload.orderNumber,
    ShippingType: payload.carrier,
    ExternalIdentificationType: payload.trackingNumber,
    ...(statusToErp(context.mappings, payload.status) === null
      ? {}
      : { OverallSDProcessStatus: statusToErp(context.mappings, payload.status) }),
  };

  const csrf = await fetchCsrfToken(context);

  const response = await callErp<Record<string, unknown>>(context.call, {
    url,
    method: (endpoint.method as 'POST') ?? 'POST',
    body,
    accessToken: context.accessToken,
    ...csrf,
  });

  return {
    erpReference: asText(readPath(unwrapOdata(response.data), 'DeliveryDocument')),
    httpStatus: response.status,
    durationMs: response.durationMs,
    request: redactForLedger(body),
    response: redactForLedger(response.data),
    alreadyPresent: false,
  };
}

async function postInvoice(
  context: ConnectorContext,
  payload: Extract<OutboundPayload, { kind: 'INVOICE_SYNC' }>['payload'],
): Promise<OutboundResult> {
  const endpoint = requireEndpoint(context, 'INVOICE');
  const url = resolveEndpointUrl(context.call.baseUrl, endpoint.path);

  // Built through the mapping, so a buyer on ECC or behind a facade can point
  // each field wherever their own supplier-invoice API expects it.
  const { body: mapped, missing } = applyOutbound(
    context.mappings,
    'INVOICE',
    {
      invoiceNumber: payload.invoiceNumber,
      invoiceDate: payload.issuedAt,
      dueDate: payload.dueAt,
      currency: payload.currency,
      netAmount: payload.netAmountMinor,
      taxAmount: payload.taxAmountMinor,
      grossAmount: payload.grossAmountMinor,
      documentUrl: payload.documentUrl,
      purchaseOrderNumber: payload.erpPurchaseOrderId ?? payload.orderNumber,
    },
    { currencyExponent: context.currencyExponent },
  );

  if (missing.length > 0) {
    throw new ErpCallError(
      `Your invoice mapping is missing ${missing.join(', ')}.`,
      'REJECTED',
    );
  }

  const body = {
    CompanyCode: context.sap.companyCode,
    ...mapped,
  };

  const csrf = await fetchCsrfToken(context);

  const response = await callErp<Record<string, unknown>>(context.call, {
    url,
    method: (endpoint.method as 'POST') ?? 'POST',
    body,
    accessToken: context.accessToken,
    ...csrf,
  });

  return {
    erpReference: asText(readPath(unwrapOdata(response.data), 'SupplierInvoice')),
    httpStatus: response.status,
    durationMs: response.durationMs,
    request: redactForLedger(body),
    response: redactForLedger(response.data),
    alreadyPresent: false,
  };
}

/**
 * Tell SAP the invoice was paid.
 *
 * A reference and a status against the supplier invoice, and nothing else. No
 * instrument crosses this boundary, ever - see `PaymentReferencePayload`.
 */
async function postPaymentReference(
  context: ConnectorContext,
  payload: Extract<OutboundPayload, { kind: 'PAYMENT_REFERENCE' }>['payload'],
): Promise<OutboundResult> {
  const endpoint = context.endpoints.get('PAYMENT_REFERENCE');

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

  const url = resolveEndpointUrl(context.call.baseUrl, endpoint.path);

  const body: Record<string, unknown> = {
    SupplierInvoiceIDByInvcgParty: payload.invoiceNumber,
    PaymentReference: payload.reference,
    PaymentStatus: payload.status,
    CompanyCode: context.sap.companyCode,
  };

  const csrf = await fetchCsrfToken(context);

  const response = await callErp<Record<string, unknown>>(context.call, {
    url,
    method: (endpoint.method as 'PATCH') ?? 'PATCH',
    body,
    accessToken: context.accessToken,
    ...csrf,
  });

  return {
    erpReference: payload.reference,
    httpStatus: response.status,
    durationMs: response.durationMs,
    request: redactForLedger(body),
    response: redactForLedger(response.data),
    alreadyPresent: false,
  };
}

// ---------------------------------------------------------------------------
// SAP mechanics
// ---------------------------------------------------------------------------

/**
 * Get a CSRF token and the session cookie that goes with it.
 *
 * OData V2 refuses a POST without `X-CSRF-Token`, and the token is bound to the
 * session the GET established - so the cookie has to come back too. Both are
 * returned together for that reason; sending one without the other fails in a
 * way whose error message blames the credentials.
 *
 * REST_JSON connections skip this entirely: a buyer's own REST facade has its
 * own opinions and almost never has SAP's.
 */
async function fetchCsrfToken(
  context: ConnectorContext,
): Promise<{ extraHeaders?: Record<string, string>; cookies?: string[] }> {
  if (context.apiStyle !== 'ODATA') return {};

  const probe = context.endpoints.get('PRODUCTS') ?? context.endpoints.get('INVENTORY');
  if (probe === undefined) return {};

  const url = resolveEndpointUrl(context.call.baseUrl, probe.path);

  try {
    const response = await callErp(context.call, {
      url,
      method: 'GET',
      accessToken: context.accessToken,
      extraHeaders: { 'X-CSRF-Token': 'Fetch' },
      query: odataQuery(context, { top: 0 }),
    });

    const token = response.headers['x-csrf-token'];
    if (token === undefined || token.length === 0) return {};

    return { extraHeaders: { 'X-CSRF-Token': token }, cookies: response.setCookie };
  } catch {
    // A landscape that does not require CSRF answers this probe with something
    // unhelpful, and the write that follows works perfectly well without a
    // token. Failing here would break every one of those.
    return {};
  }
}

/**
 * The OData query parameters this connection needs.
 *
 * `$format=json` because OData V2 defaults to XML and a buyer should not have
 * to know that. `$top` where a caller asked for a bound. The buyer's own
 * endpoint query parameters are applied by `callErp`, so a filter they
 * configured is not overwritten here.
 */
function odataQuery(
  context: ConnectorContext,
  options: { top?: number },
): Record<string, string> {
  if (context.apiStyle !== 'ODATA') {
    return options.top === undefined ? {} : { limit: String(options.top) };
  }

  return {
    $format: 'json',
    ...(options.top === undefined ? {} : { $top: String(options.top) }),
    ...(context.sap.plant === null ? {} : { $filter: `Plant eq '${escapeODataLiteral(context.sap.plant)}'` }),
  };
}

/**
 * Quote a value for an OData filter.
 *
 * A single quote is doubled, which is what the OData grammar says and is also
 * what stops a plant code containing an apostrophe from ending the literal and
 * turning the rest of it into filter syntax. The value here comes from a form
 * field, so this is injection prevention rather than tidiness.
 */
function escapeODataLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Build the purchase order body.
 *
 * The header is SAP's vocabulary because these five fields have no plausible
 * alternative spelling in any S/4HANA release. The LINES go through the mapping,
 * because that is where buyers genuinely differ - a custom facade, an older
 * release, a Z-field for their own reference.
 */
function buildPurchaseOrderBody(
  context: ConnectorContext,
  payload: Extract<OutboundPayload, { kind: 'PURCHASE_ORDER_CREATE' }>['payload'],
): Record<string, unknown> {
  const items = payload.lines.map((line, index) => {
    const { body } = applyOutbound(
      context.mappings,
      'ORDER',
      {
        lineSku: line.erpMaterialNumber ?? line.sku,
        lineQuantity: line.quantity,
        lineUnitOfMeasure: line.unitOfMeasure,
        lineUnitPrice: line.unitPriceMinor,
        lineNetAmount: line.netAmountMinor,
        lineTaxAmount: line.taxAmountMinor,
        lineWarehouse: line.erpPlant ?? context.sap.plant,
      },
      { currencyExponent: context.currencyExponent },
    );

    return {
      // SAP numbers purchase order items in tens by convention, which leaves
      // room to insert one later without renumbering the rest.
      PurchaseOrderItem: String((index + 1) * 10),
      Plant: line.erpPlant ?? context.sap.plant,
      StorageLocation: line.erpStorageLocation ?? context.sap.storageLocation,
      ...body,
    };
  });

  const { body: header } = applyOutbound(
    context.mappings,
    'ORDER',
    {
      orderNumber: payload.orderNumber,
      orderDate: payload.orderedAt,
      currency: payload.currency,
      vendorId: payload.vendorId,
      customerId: payload.customerId,
      netAmount: payload.netAmountMinor,
      taxAmount: payload.taxAmountMinor,
      grossAmount: payload.grossAmountMinor,
      deliveryDate: payload.requestedDeliveryAt,
    },
    { currencyExponent: context.currencyExponent },
  );

  // The header mapping can legitimately write into line-level paths too, since
  // both use the ORDER entity. Those keys are dropped from the header rather
  // than sent at document level, where SAP would reject them.
  for (const key of ['Material', 'OrderQuantity', 'NetPriceAmount', 'PurchaseOrderQuantityUnit']) {
    delete header[key];
  }

  return {
    CompanyCode: context.sap.companyCode,
    PurchasingOrganization: context.sap.purchasingOrg,
    PurchasingGroup: context.sap.purchasingGroup,
    PurchaseOrderType: 'NB',
    ...header,
    to_PurchaseOrderItem: { results: items },
  };
}

function toInventoryRecord(
  context: ConnectorContext,
  record: unknown,
): InboundInventoryRecord {
  const values = applyInbound(context.mappings, 'INVENTORY', record, {
    currencyExponent: context.currencyExponent,
  });

  return {
    erpMaterialNumber: asText(values['sku'] ?? readPath(record, 'Material')),
    sku: asText(values['sku'] ?? readPath(record, 'Material')),
    plant: asText(values['plant'] ?? readPath(record, 'Plant')),
    onHandQty: asNumber(values['onHandQty']),
    onOrderQty: asNumber(values['onOrderQty']),
    incomingQty: asNumber(values['incomingQty']),
    unitOfMeasure: asText(values['unitOfMeasure']),
    raw: redactForLedger(record),
  };
}

/** OData V2 wraps everything in `d`; V4 does not. Handles both. */
function unwrapOdata(body: unknown): unknown {
  const wrapped = readPath(body, 'd');
  return wrapped === undefined ? body : wrapped;
}

function purchaseOrderIdOf(body: unknown): string | null {
  const root = unwrapOdata(body);
  return (
    asText(readPath(root, 'PurchaseOrder')) ??
    asText(readPath(root, 'results.0.PurchaseOrder')) ??
    null
  );
}

/** `@odata.nextLink` in V4, `d.__next` in V2. Null when the feed is finished. */
function nextLinkOf(body: unknown): string | null {
  return (
    asText(readPath(body, '@odata.nextLink')) ??
    asText(readPath(body, 'd.__next')) ??
    asText(readPath(body, 'odata.nextLink')) ??
    null
  );
}

/**
 * Records, without turning "the feed is empty" into a failure.
 *
 * `extractRecords` throws when it cannot find a list, which is right during a
 * sync - a mapping pointing at nothing is a real problem. During a TEST it is
 * not: proving the credentials work is the whole job, and a landscape that
 * answers a `$top=1` with an empty envelope has proved it.
 */
function safeExtract(body: unknown, recordsPath: string | null): unknown[] {
  try {
    return extractRecords(body, recordsPath);
  } catch {
    return [];
  }
}

function requireEndpoint(
  context: ConnectorContext,
  purpose: EndpointPurpose,
): NonNullable<ReturnType<ConnectorContext['endpoints']['get']>> {
  const endpoint = context.endpoints.get(purpose);

  if (endpoint === undefined || !endpoint.enabled) {
    throw conflict(
      ErrorCode.CUSTOMER_ERP_ENDPOINT_MISSING,
      `No endpoint is configured for ${purpose.toLowerCase().replace(/_/g, ' ')} on this ` +
        'connection. Add one, or switch that off in your sync rules.',
    );
  }

  return endpoint;
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
