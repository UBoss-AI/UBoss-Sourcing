/**
 * The named ERPs a buyer can pick, and what we already know about each.
 *
 * TWO LAYERS, AND THE DISTINCTION IS THE WHOLE POINT
 *
 * A **connector** is a protocol dialect, and it is code: how the thing
 * authenticates, how it pages, what shape its purchase order is, whether a
 * GraphQL error arrives with HTTP 200. There are four, and there are four
 * because there are four genuinely different protocols in this list - not
 * because there are four ERPs.
 *
 * A **preset** is a brand, and it is data: a name, the connector that speaks to
 * it, its default endpoint paths, its default field mapping, the authentication
 * it accepts, and what to ask your IT team for. Adding NetSuite or Acumatica or
 * QuickBooks needs a preset and no code at all, because all three are REST and
 * JSON over OAuth 2.0 and the `CUSTOM` connector already speaks that fluently.
 *
 * Getting this the other way round - one connector per brand - is how an
 * integration product ends up with twenty near-identical files that drift, and
 * how adding the twenty-first takes a fortnight.
 *
 * HOW SURE THE DEFAULTS ARE, AND WHY THAT IS A FIELD
 *
 * `defaultsAreExamples` separates two honestly different situations.
 *
 * **False** means the paths below are the vendor's own published API, the same
 * for every customer on it: SAP's `API_PURCHASEORDER_PROCESS_SRV`, NetSuite's
 * `/services/rest/record/v1/purchaseOrder`, Business Central's
 * `/api/v2.0/companies({id})/purchaseOrders`. A buyer on a stock installation
 * can very often press Test straight away.
 *
 * **True** means the paths depend on how *that customer's* system was set up -
 * a TCS iON integration service, a Tally middleware somebody wrote, an Infor
 * ION flow. The preset then carries the shape and the vocabulary, and the paths
 * are a worked example to be replaced rather than a promise. Saying so in a
 * field, and rendering it on the screen, is better than shipping a confident
 * default that wastes somebody's afternoon.
 *
 * Either way a wrong default cannot reach production: activation is refused
 * until a test has passed AND the mapping has been checked against a real
 * response from that buyer's own system. The preset saves time; the guard
 * decides correctness.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * Any ERP without a documented HTTP API or a middleware in front of one. Tally
 * and Marg are in the list precisely because they need one and the preset says
 * so: both speak XML on a LAN port, so what this platform connects to is a JSON
 * endpoint the customer or their partner puts in front of them. Offering a
 * username and password field for a portal and driving it with a browser is not
 * an integration, it is a robot with somebody's password, and it breaks the
 * first time a button moves.
 */
import type {
  CustomerErpApiStyle,
  CustomerErpAuthMethod,
  CustomerErpPagination,
} from '../../generated/prisma/enums.js';
import type { EndpointPurpose, SystemName } from './connectors/types.js';
import type { MappingRow } from './mapping.service.js';

export interface PresetEndpoint {
  purpose: EndpointPurpose;
  path: string;
  method: string;
  pagination?: CustomerErpPagination;
  recordsPath?: string;
}

export interface VendorPreset {
  /** Stable, stored on the connection so a screen can name the brand. */
  id: string;
  label: string;
  /** Which code speaks to it. */
  connector: SystemName;
  apiStyle: CustomerErpApiStyle;
  /** In the order a buyer should prefer them. The first is the default. */
  authMethods: CustomerErpAuthMethod[];
  /** Shown as the address field's placeholder. Never filled in for them. */
  baseUrlExample: string;
  endpoints: PresetEndpoint[];
  mappings: Omit<MappingRow, 'required'>[];
  /** What to ask their own IT team for. Rendered on the network step. */
  notes: string;
  /** See this file's header. Rendered as a warning where true. */
  defaultsAreExamples: boolean;
  /**
   * Typically inside the customer's own network.
   *
   * Not a capability flag - it changes nothing in the code. It decides which
   * network mode the wizard suggests, and it is the difference between "press
   * Connect" and "ask your IT team for a gateway", which is the single most
   * common reason a first attempt fails.
   */
  onPremiseTypical: boolean;
  /** Sorts the list so a buyer sees what they are likely to have. */
  regions: ('global' | 'india' | 'eu')[];
}

// ---------------------------------------------------------------------------
// Mapping fragments
//
// Written once and shared, because six of these systems genuinely do call a SKU
// `sku` and a quantity `quantity`, and repeating that eleven times is eleven
// places to fix a typo.
// ---------------------------------------------------------------------------

const REST_CONVENTIONAL: Omit<MappingRow, 'required'>[] = [
  { entity: 'PRODUCT', platformField: 'sku', erpPath: 'sku', constantValue: null, erpValue: null, transform: 'TRIM' },
  { entity: 'PRODUCT', platformField: 'name', erpPath: 'name', constantValue: null, erpValue: null, transform: null },
  { entity: 'INVENTORY', platformField: 'sku', erpPath: 'sku', constantValue: null, erpValue: null, transform: 'TRIM' },
  { entity: 'INVENTORY', platformField: 'onHandQty', erpPath: 'quantityOnHand', constantValue: null, erpValue: null, transform: null },
  { entity: 'ORDER', platformField: 'orderNumber', erpPath: 'externalId', constantValue: null, erpValue: null, transform: 'TRIM' },
  { entity: 'ORDER', platformField: 'currency', erpPath: 'currency', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
  { entity: 'ORDER', platformField: 'lineSku', erpPath: 'items.0.sku', constantValue: null, erpValue: null, transform: 'TRIM' },
  { entity: 'ORDER', platformField: 'lineQuantity', erpPath: 'items.0.quantity', constantValue: null, erpValue: null, transform: null },
  { entity: 'ORDER', platformField: 'grossAmount', erpPath: 'total', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
  { entity: 'INVOICE', platformField: 'invoiceNumber', erpPath: 'number', constantValue: null, erpValue: null, transform: 'TRIM' },
  { entity: 'INVOICE', platformField: 'currency', erpPath: 'currency', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
  { entity: 'INVOICE', platformField: 'grossAmount', erpPath: 'total', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
  { entity: 'PAYMENT', platformField: 'paymentReference', erpPath: 'reference', constantValue: null, erpValue: null, transform: 'TRIM' },
];

/** The four order statuses every preset has to translate, in that ERP's words. */
function statuses(
  confirmed: string,
  shipped: string,
  delivered: string,
  cancelled: string,
): Omit<MappingRow, 'required'>[] {
  return [
    { entity: 'STATUS', platformField: 'CONFIRMED', erpPath: '', constantValue: null, erpValue: confirmed, transform: null },
    { entity: 'STATUS', platformField: 'SHIPPED', erpPath: '', constantValue: null, erpValue: shipped, transform: null },
    { entity: 'STATUS', platformField: 'DELIVERED', erpPath: '', constantValue: null, erpValue: delivered, transform: null },
    { entity: 'STATUS', platformField: 'CANCELLED', erpPath: '', constantValue: null, erpValue: cancelled, transform: null },
  ];
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export const VENDOR_PRESETS: readonly VendorPreset[] = Object.freeze([
  // --- SAP ---------------------------------------------------------------
  {
    id: 'sap-s4hana',
    label: 'SAP S/4HANA',
    connector: 'SAP',
    apiStyle: 'ODATA',
    authMethods: ['OAUTH2_CLIENT_CREDENTIALS', 'BEARER_TOKEN', 'BASIC'],
    baseUrlExample: 'https://my123456.s4hana.ondemand.com',
    // The SAP connector supplies its own paths and mapping; repeating them here
    // would be two lists to keep in step. An empty array means "ask the
    // connector", which `presetDefaults` below does.
    endpoints: [],
    mappings: [],
    notes:
      'Ask your Basis team for a communication arrangement with a communication user, ' +
      'restricted to the purchase order, material stock and supplier invoice APIs. If your ' +
      'SAP is on-premise, give us your SAP Cloud Connector address rather than SAP’s own.',
    defaultsAreExamples: false,
    onPremiseTypical: false,
    regions: ['global', 'india', 'eu'],
  },
  {
    id: 'sap-ecc',
    label: 'SAP ERP (ECC 6.0)',
    connector: 'SAP',
    apiStyle: 'ODATA',
    authMethods: ['OAUTH2_CLIENT_CREDENTIALS', 'BEARER_TOKEN', 'BASIC'],
    baseUrlExample: 'https://sap-gateway.example.com',
    endpoints: [],
    mappings: [],
    notes:
      'ECC exposes these through NetWeaver Gateway rather than as standard cloud APIs, so ' +
      'the service names are whatever your Basis team activated. Confirm each path with ' +
      'them, and give us the Gateway address - almost always through a reverse proxy, ' +
      'because ECC is rarely on the public internet.',
    defaultsAreExamples: true,
    onPremiseTypical: true,
    regions: ['global', 'india', 'eu'],
  },
  {
    id: 'sap-business-one',
    label: 'SAP Business One',
    connector: 'CUSTOM',
    apiStyle: 'ODATA',
    authMethods: ['BASIC', 'BEARER_TOKEN'],
    baseUrlExample: 'https://b1-server.example.com:50000/b1s/v1',
    endpoints: [
      { purpose: 'PRODUCTS', path: '/Items', method: 'GET', pagination: 'ODATA_NEXT_LINK', recordsPath: 'value' },
      { purpose: 'WAREHOUSES', path: '/Warehouses', method: 'GET', pagination: 'ODATA_NEXT_LINK', recordsPath: 'value' },
      { purpose: 'INVENTORY', path: '/Items', method: 'GET', pagination: 'ODATA_NEXT_LINK', recordsPath: 'value' },
      { purpose: 'PURCHASE_ORDER_CREATE', path: '/PurchaseOrders', method: 'POST' },
      { purpose: 'PURCHASE_ORDER_UPDATE', path: '/PurchaseOrders', method: 'PATCH' },
      { purpose: 'GOODS_RECEIPT', path: '/PurchaseDeliveryNotes', method: 'POST' },
      { purpose: 'INVOICE', path: '/PurchaseInvoices', method: 'POST' },
    ],
    mappings: [
      { entity: 'PRODUCT', platformField: 'sku', erpPath: 'ItemCode', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'PRODUCT', platformField: 'name', erpPath: 'ItemName', constantValue: null, erpValue: null, transform: null },
      { entity: 'INVENTORY', platformField: 'sku', erpPath: 'ItemCode', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'INVENTORY', platformField: 'onHandQty', erpPath: 'QuantityOnStock', constantValue: null, erpValue: null, transform: null },
      { entity: 'ORDER', platformField: 'orderNumber', erpPath: 'NumAtCard', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'currency', erpPath: 'DocCurrency', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
      { entity: 'ORDER', platformField: 'vendorId', erpPath: 'CardCode', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'lineSku', erpPath: 'DocumentLines.0.ItemCode', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'lineQuantity', erpPath: 'DocumentLines.0.Quantity', constantValue: null, erpValue: null, transform: null },
      { entity: 'ORDER', platformField: 'grossAmount', erpPath: 'DocTotal', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
      { entity: 'INVOICE', platformField: 'invoiceNumber', erpPath: 'NumAtCard', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'INVOICE', platformField: 'currency', erpPath: 'DocCurrency', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
      { entity: 'INVOICE', platformField: 'grossAmount', erpPath: 'DocTotal', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
      ...statuses('Open', 'Delivered', 'Closed', 'Cancelled'),
    ],
    notes:
      'Business One is reached through the Service Layer, normally on port 50000. It issues ' +
      'a session cookie from /Login rather than a bearer token, so most installations put a ' +
      'small gateway in front of it - give us that address. It is almost never on the public ' +
      'internet as it stands.',
    defaultsAreExamples: false,
    onPremiseTypical: true,
    regions: ['global', 'india', 'eu'],
  },

  // --- Oracle ------------------------------------------------------------
  {
    id: 'netsuite',
    label: 'Oracle NetSuite',
    connector: 'CUSTOM',
    apiStyle: 'REST_JSON',
    authMethods: ['OAUTH2_CLIENT_CREDENTIALS', 'BEARER_TOKEN'],
    baseUrlExample: 'https://1234567.suitetalk.api.netsuite.com',
    endpoints: [
      { purpose: 'PRODUCTS', path: '/services/rest/record/v1/inventoryItem', method: 'GET', pagination: 'OFFSET_LIMIT', recordsPath: 'items' },
      { purpose: 'WAREHOUSES', path: '/services/rest/record/v1/location', method: 'GET', pagination: 'OFFSET_LIMIT', recordsPath: 'items' },
      { purpose: 'INVENTORY', path: '/services/rest/record/v1/inventoryItem', method: 'GET', pagination: 'OFFSET_LIMIT', recordsPath: 'items' },
      { purpose: 'PURCHASE_ORDER_CREATE', path: '/services/rest/record/v1/purchaseOrder', method: 'POST' },
      { purpose: 'PURCHASE_ORDER_UPDATE', path: '/services/rest/record/v1/purchaseOrder', method: 'PATCH' },
      { purpose: 'GOODS_RECEIPT', path: '/services/rest/record/v1/itemReceipt', method: 'POST' },
      { purpose: 'INVOICE', path: '/services/rest/record/v1/vendorBill', method: 'POST' },
    ],
    mappings: [
      { entity: 'PRODUCT', platformField: 'sku', erpPath: 'itemId', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'PRODUCT', platformField: 'name', erpPath: 'displayName', constantValue: null, erpValue: null, transform: null },
      { entity: 'INVENTORY', platformField: 'sku', erpPath: 'itemId', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'INVENTORY', platformField: 'onHandQty', erpPath: 'quantityOnHand', constantValue: null, erpValue: null, transform: null },
      { entity: 'ORDER', platformField: 'orderNumber', erpPath: 'externalId', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'currency', erpPath: 'currency.refName', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
      { entity: 'ORDER', platformField: 'vendorId', erpPath: 'entity.id', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'lineSku', erpPath: 'item.items.0.item.refName', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'lineQuantity', erpPath: 'item.items.0.quantity', constantValue: null, erpValue: null, transform: null },
      { entity: 'ORDER', platformField: 'grossAmount', erpPath: 'total', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
      { entity: 'INVOICE', platformField: 'invoiceNumber', erpPath: 'tranId', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'INVOICE', platformField: 'currency', erpPath: 'currency.refName', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
      { entity: 'INVOICE', platformField: 'grossAmount', erpPath: 'total', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
      ...statuses('pendingReceipt', 'pendingBilling', 'fullyBilled', 'closed'),
    ],
    notes:
      'Create an integration record in Setup → Integration with OAuth 2.0 enabled, and give ' +
      'the role the REST Web Services permission. Your account ID is the number in the ' +
      'address. NetSuite is on the public internet, so there is nothing to open up.',
    defaultsAreExamples: false,
    onPremiseTypical: false,
    regions: ['global', 'eu'],
  },
  {
    id: 'oracle-fusion',
    label: 'Oracle Fusion Cloud ERP',
    connector: 'CUSTOM',
    apiStyle: 'REST_JSON',
    authMethods: ['OAUTH2_CLIENT_CREDENTIALS', 'BASIC'],
    baseUrlExample: 'https://your-instance.fa.ocs.oraclecloud.com',
    endpoints: [
      { purpose: 'PRODUCTS', path: '/fscmRestApi/resources/11.13.18.05/itemsV2', method: 'GET', pagination: 'OFFSET_LIMIT', recordsPath: 'items' },
      { purpose: 'INVENTORY', path: '/fscmRestApi/resources/11.13.18.05/onhandQuantities', method: 'GET', pagination: 'OFFSET_LIMIT', recordsPath: 'items' },
      { purpose: 'PURCHASE_ORDER_CREATE', path: '/fscmRestApi/resources/11.13.18.05/purchaseOrders', method: 'POST' },
      { purpose: 'PURCHASE_ORDER_UPDATE', path: '/fscmRestApi/resources/11.13.18.05/purchaseOrders', method: 'PATCH' },
      { purpose: 'GOODS_RECEIPT', path: '/fscmRestApi/resources/11.13.18.05/receivingReceiptRequests', method: 'POST' },
      { purpose: 'INVOICE', path: '/fscmRestApi/resources/11.13.18.05/invoices', method: 'POST' },
    ],
    mappings: [
      { entity: 'PRODUCT', platformField: 'sku', erpPath: 'ItemNumber', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'PRODUCT', platformField: 'name', erpPath: 'ItemDescription', constantValue: null, erpValue: null, transform: null },
      { entity: 'INVENTORY', platformField: 'sku', erpPath: 'ItemNumber', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'INVENTORY', platformField: 'onHandQty', erpPath: 'PrimaryOnhandQuantity', constantValue: null, erpValue: null, transform: null },
      { entity: 'ORDER', platformField: 'orderNumber', erpPath: 'OrderNumber', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'currency', erpPath: 'CurrencyCode', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
      { entity: 'ORDER', platformField: 'lineSku', erpPath: 'lines.0.ItemNumber', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'lineQuantity', erpPath: 'lines.0.Quantity', constantValue: null, erpValue: null, transform: null },
      { entity: 'INVOICE', platformField: 'invoiceNumber', erpPath: 'InvoiceNumber', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'INVOICE', platformField: 'currency', erpPath: 'InvoiceCurrency', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
      { entity: 'INVOICE', platformField: 'grossAmount', erpPath: 'InvoiceAmount', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
      ...statuses('OPEN', 'IN_TRANSIT', 'CLOSED_FOR_RECEIVING', 'CANCELED'),
    ],
    notes:
      'The version in the path is the REST API release your pod is on - confirm it, because ' +
      'it changes with an upgrade. Your administrator registers the client in Oracle ' +
      'Identity Cloud Service and grants the procurement roles.',
    defaultsAreExamples: false,
    onPremiseTypical: false,
    regions: ['global', 'eu'],
  },

  // --- Microsoft ---------------------------------------------------------
  {
    id: 'dynamics-365-bc',
    label: 'Microsoft Dynamics 365 Business Central',
    connector: 'CUSTOM',
    apiStyle: 'ODATA',
    authMethods: ['OAUTH2_CLIENT_CREDENTIALS'],
    baseUrlExample: 'https://api.businesscentral.dynamics.com/v2.0/{tenant}/Production/api/v2.0',
    endpoints: [
      { purpose: 'PRODUCTS', path: '/companies({companyId})/items', method: 'GET', pagination: 'ODATA_NEXT_LINK', recordsPath: 'value' },
      { purpose: 'WAREHOUSES', path: '/companies({companyId})/locations', method: 'GET', pagination: 'ODATA_NEXT_LINK', recordsPath: 'value' },
      { purpose: 'INVENTORY', path: '/companies({companyId})/items', method: 'GET', pagination: 'ODATA_NEXT_LINK', recordsPath: 'value' },
      { purpose: 'PURCHASE_ORDER_CREATE', path: '/companies({companyId})/purchaseOrders', method: 'POST' },
      { purpose: 'PURCHASE_ORDER_UPDATE', path: '/companies({companyId})/purchaseOrders', method: 'PATCH' },
      { purpose: 'INVOICE', path: '/companies({companyId})/purchaseInvoices', method: 'POST' },
    ],
    mappings: [
      { entity: 'PRODUCT', platformField: 'sku', erpPath: 'number', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'PRODUCT', platformField: 'name', erpPath: 'displayName', constantValue: null, erpValue: null, transform: null },
      { entity: 'INVENTORY', platformField: 'sku', erpPath: 'number', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'INVENTORY', platformField: 'onHandQty', erpPath: 'inventory', constantValue: null, erpValue: null, transform: null },
      { entity: 'ORDER', platformField: 'orderNumber', erpPath: 'vendorOrderNumber', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'currency', erpPath: 'currencyCode', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
      { entity: 'ORDER', platformField: 'vendorId', erpPath: 'vendorNumber', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'lineSku', erpPath: 'purchaseOrderLines.0.itemId', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'lineQuantity', erpPath: 'purchaseOrderLines.0.quantity', constantValue: null, erpValue: null, transform: null },
      { entity: 'ORDER', platformField: 'grossAmount', erpPath: 'totalAmountIncludingTax', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
      { entity: 'INVOICE', platformField: 'invoiceNumber', erpPath: 'number', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'INVOICE', platformField: 'currency', erpPath: 'currencyCode', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
      { entity: 'INVOICE', platformField: 'grossAmount', erpPath: 'totalAmountIncludingTax', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
      ...statuses('Open', 'Released', 'Received', 'Cancelled'),
    ],
    notes:
      'Register an application in Microsoft Entra ID, grant it the Business Central API ' +
      'permission, and grant admin consent. Replace {tenant} with your tenant ID and ' +
      '{companyId} with the company GUID - both come from your Business Central ' +
      'administrator. The token address is Entra’s, not Business Central’s.',
    defaultsAreExamples: false,
    onPremiseTypical: false,
    regions: ['global', 'eu', 'india'],
  },
  {
    id: 'dynamics-365-fo',
    label: 'Microsoft Dynamics 365 Finance & Operations',
    connector: 'CUSTOM',
    apiStyle: 'ODATA',
    authMethods: ['OAUTH2_CLIENT_CREDENTIALS'],
    baseUrlExample: 'https://your-org.operations.dynamics.com/data',
    endpoints: [
      { purpose: 'PRODUCTS', path: '/ReleasedProductsV2', method: 'GET', pagination: 'ODATA_NEXT_LINK', recordsPath: 'value' },
      { purpose: 'WAREHOUSES', path: '/Warehouses', method: 'GET', pagination: 'ODATA_NEXT_LINK', recordsPath: 'value' },
      { purpose: 'INVENTORY', path: '/InventOnHandItemListPages', method: 'GET', pagination: 'ODATA_NEXT_LINK', recordsPath: 'value' },
      { purpose: 'PURCHASE_ORDER_CREATE', path: '/PurchaseOrderHeadersV2', method: 'POST' },
      { purpose: 'PURCHASE_ORDER_UPDATE', path: '/PurchaseOrderHeadersV2', method: 'PATCH' },
      { purpose: 'INVOICE', path: '/VendorInvoiceHeaders', method: 'POST' },
    ],
    mappings: [
      { entity: 'PRODUCT', platformField: 'sku', erpPath: 'ItemNumber', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'PRODUCT', platformField: 'name', erpPath: 'ProductName', constantValue: null, erpValue: null, transform: null },
      { entity: 'INVENTORY', platformField: 'sku', erpPath: 'ItemNumber', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'INVENTORY', platformField: 'onHandQty', erpPath: 'AvailablePhysical', constantValue: null, erpValue: null, transform: null },
      { entity: 'ORDER', platformField: 'orderNumber', erpPath: 'VendorReference', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'currency', erpPath: 'CurrencyCode', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
      { entity: 'ORDER', platformField: 'vendorId', erpPath: 'OrderVendorAccountNumber', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'lineSku', erpPath: 'lines.0.ItemNumber', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'lineQuantity', erpPath: 'lines.0.OrderedPurchaseQuantity', constantValue: null, erpValue: null, transform: null },
      { entity: 'INVOICE', platformField: 'invoiceNumber', erpPath: 'InvoiceNumber', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'INVOICE', platformField: 'currency', erpPath: 'CurrencyCode', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
      ...statuses('Backorder', 'Received', 'Invoiced', 'Canceled'),
    ],
    notes:
      'Register an application in Microsoft Entra ID and add it under System administration ' +
      '→ Azure Active Directory applications with a user that has the procurement duties. ' +
      'Entity names differ between versions - confirm them in Data management → Data entities.',
    defaultsAreExamples: false,
    onPremiseTypical: false,
    regions: ['global', 'eu', 'india'],
  },

  // --- Open source and mid-market ---------------------------------------
  {
    id: 'odoo',
    label: 'Odoo',
    connector: 'ODOO',
    apiStyle: 'REST_JSON',
    authMethods: ['BASIC'],
    baseUrlExample: 'https://your-company.odoo.com',
    // Odoo is one address and one method - see `odoo.connector.ts`. The paths
    // exist so the pipeline's "is there an endpoint for this" question has an
    // answer per purpose.
    endpoints: [
      { purpose: 'PRODUCTS', path: '/jsonrpc', method: 'POST' },
      { purpose: 'WAREHOUSES', path: '/jsonrpc', method: 'POST' },
      { purpose: 'INVENTORY', path: '/jsonrpc', method: 'POST' },
      { purpose: 'PURCHASE_ORDER_CREATE', path: '/jsonrpc', method: 'POST' },
      { purpose: 'PURCHASE_ORDER_UPDATE', path: '/jsonrpc', method: 'POST' },
      { purpose: 'GOODS_RECEIPT', path: '/jsonrpc', method: 'POST' },
      { purpose: 'INVOICE', path: '/jsonrpc', method: 'POST' },
    ],
    mappings: [
      { entity: 'PRODUCT', platformField: 'sku', erpPath: 'default_code', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'PRODUCT', platformField: 'name', erpPath: 'name', constantValue: null, erpValue: null, transform: null },
      { entity: 'INVENTORY', platformField: 'sku', erpPath: 'default_code', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'INVENTORY', platformField: 'onHandQty', erpPath: 'qty_available', constantValue: null, erpValue: null, transform: null },
      { entity: 'ORDER', platformField: 'orderNumber', erpPath: 'partner_ref', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'currency', erpPath: 'currency_id', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
      { entity: 'ORDER', platformField: 'lineSku', erpPath: 'order_line.0.name', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'lineQuantity', erpPath: 'order_line.0.product_qty', constantValue: null, erpValue: null, transform: null },
      { entity: 'ORDER', platformField: 'grossAmount', erpPath: 'amount_total', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
      { entity: 'INVOICE', platformField: 'invoiceNumber', erpPath: 'name', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'INVOICE', platformField: 'grossAmount', erpPath: 'amount_total', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
      ...statuses('purchase', 'done', 'done', 'cancel'),
    ],
    notes:
      'Generate an API key from Preferences → Account Security and use your login as the ' +
      'username - Odoo accepts the key wherever a password goes. Put your database name in ' +
      '"Your reference with us"; a self-hosted Odoo needs to be reachable over HTTPS.',
    defaultsAreExamples: false,
    onPremiseTypical: false,
    regions: ['global', 'eu', 'india'],
  },
  {
    id: 'zoho-inventory',
    label: 'Zoho Inventory / Books',
    connector: 'CUSTOM',
    apiStyle: 'REST_JSON',
    authMethods: ['OAUTH2_AUTHORIZATION_CODE', 'OAUTH2_CLIENT_CREDENTIALS'],
    baseUrlExample: 'https://www.zohoapis.in/inventory/v1',
    endpoints: [
      { purpose: 'PRODUCTS', path: '/items', method: 'GET', pagination: 'PAGE_NUMBER', recordsPath: 'items' },
      { purpose: 'WAREHOUSES', path: '/settings/warehouses', method: 'GET', recordsPath: 'warehouses' },
      { purpose: 'INVENTORY', path: '/items', method: 'GET', pagination: 'PAGE_NUMBER', recordsPath: 'items' },
      { purpose: 'PURCHASE_ORDER_CREATE', path: '/purchaseorders', method: 'POST' },
      { purpose: 'PURCHASE_ORDER_UPDATE', path: '/purchaseorders', method: 'PUT' },
      { purpose: 'GOODS_RECEIPT', path: '/purchasereceives', method: 'POST' },
      { purpose: 'INVOICE', path: '/bills', method: 'POST' },
    ],
    mappings: [
      { entity: 'PRODUCT', platformField: 'sku', erpPath: 'sku', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'PRODUCT', platformField: 'name', erpPath: 'name', constantValue: null, erpValue: null, transform: null },
      { entity: 'INVENTORY', platformField: 'sku', erpPath: 'sku', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'INVENTORY', platformField: 'onHandQty', erpPath: 'stock_on_hand', constantValue: null, erpValue: null, transform: null },
      { entity: 'ORDER', platformField: 'orderNumber', erpPath: 'reference_number', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'currency', erpPath: 'currency_code', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
      { entity: 'ORDER', platformField: 'lineSku', erpPath: 'line_items.0.sku', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'lineQuantity', erpPath: 'line_items.0.quantity', constantValue: null, erpValue: null, transform: null },
      { entity: 'ORDER', platformField: 'grossAmount', erpPath: 'total', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
      { entity: 'INVOICE', platformField: 'invoiceNumber', erpPath: 'bill_number', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'INVOICE', platformField: 'currency', erpPath: 'currency_code', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
      { entity: 'INVOICE', platformField: 'grossAmount', erpPath: 'total', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
      ...statuses('issued', 'partially_received', 'received', 'cancelled'),
    ],
    notes:
      'Register a Self Client in the Zoho API Console and note your data centre - the ' +
      'address ends .in, .com, .eu or .com.au and using the wrong one fails ' +
      'authentication rather than 404ing. Your organization ID goes in "Your reference ' +
      'with us"; Zoho needs it as a header on every call.',
    defaultsAreExamples: false,
    onPremiseTypical: false,
    regions: ['india', 'global', 'eu'],
  },
  {
    id: 'acumatica',
    label: 'Acumatica',
    connector: 'CUSTOM',
    apiStyle: 'REST_JSON',
    authMethods: ['OAUTH2_CLIENT_CREDENTIALS', 'BASIC'],
    baseUrlExample: 'https://your-instance.acumatica.com/entity/Default/23.200.001',
    endpoints: [
      { purpose: 'PRODUCTS', path: '/StockItem', method: 'GET' },
      { purpose: 'WAREHOUSES', path: '/Warehouse', method: 'GET' },
      { purpose: 'INVENTORY', path: '/InventoryQuantityAvailable', method: 'GET' },
      { purpose: 'PURCHASE_ORDER_CREATE', path: '/PurchaseOrder', method: 'PUT' },
      { purpose: 'PURCHASE_ORDER_UPDATE', path: '/PurchaseOrder', method: 'PUT' },
      { purpose: 'GOODS_RECEIPT', path: '/PurchaseReceipt', method: 'PUT' },
      { purpose: 'INVOICE', path: '/Bill', method: 'PUT' },
    ],
    mappings: [
      { entity: 'PRODUCT', platformField: 'sku', erpPath: 'InventoryID.value', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'PRODUCT', platformField: 'name', erpPath: 'Description.value', constantValue: null, erpValue: null, transform: null },
      { entity: 'INVENTORY', platformField: 'sku', erpPath: 'InventoryID.value', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'INVENTORY', platformField: 'onHandQty', erpPath: 'QtyOnHand.value', constantValue: null, erpValue: null, transform: null },
      { entity: 'ORDER', platformField: 'orderNumber', erpPath: 'VendorRef.value', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'currency', erpPath: 'CurrencyID.value', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
      { entity: 'ORDER', platformField: 'lineSku', erpPath: 'Details.0.InventoryID.value', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'lineQuantity', erpPath: 'Details.0.OrderQty.value', constantValue: null, erpValue: null, transform: null },
      { entity: 'INVOICE', platformField: 'invoiceNumber', erpPath: 'ReferenceNbr.value', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'INVOICE', platformField: 'grossAmount', erpPath: 'Amount.value', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
      ...statuses('Open', 'Receiving', 'Closed', 'Cancelled'),
    ],
    notes:
      'Acumatica wraps every field as {"value": ...}, which is why the mapping paths end in ' +
      '.value. The version in the address is your endpoint version - check it under ' +
      'Integration → Web Service Endpoints.',
    defaultsAreExamples: false,
    onPremiseTypical: false,
    regions: ['global', 'eu'],
  },
  {
    id: 'quickbooks-online',
    label: 'QuickBooks Online',
    connector: 'CUSTOM',
    apiStyle: 'REST_JSON',
    authMethods: ['OAUTH2_AUTHORIZATION_CODE'],
    baseUrlExample: 'https://quickbooks.api.intuit.com/v3/company/{realmId}',
    endpoints: [
      { purpose: 'PRODUCTS', path: '/query', method: 'GET', recordsPath: 'QueryResponse.Item' },
      { purpose: 'INVENTORY', path: '/query', method: 'GET', recordsPath: 'QueryResponse.Item' },
      { purpose: 'PURCHASE_ORDER_CREATE', path: '/purchaseorder', method: 'POST' },
      { purpose: 'PURCHASE_ORDER_UPDATE', path: '/purchaseorder', method: 'POST' },
      { purpose: 'INVOICE', path: '/bill', method: 'POST' },
    ],
    mappings: [
      { entity: 'PRODUCT', platformField: 'sku', erpPath: 'Sku', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'PRODUCT', platformField: 'name', erpPath: 'Name', constantValue: null, erpValue: null, transform: null },
      { entity: 'INVENTORY', platformField: 'sku', erpPath: 'Sku', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'INVENTORY', platformField: 'onHandQty', erpPath: 'QtyOnHand', constantValue: null, erpValue: null, transform: null },
      { entity: 'ORDER', platformField: 'orderNumber', erpPath: 'DocNumber', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'currency', erpPath: 'CurrencyRef.value', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
      { entity: 'ORDER', platformField: 'lineSku', erpPath: 'Line.0.ItemBasedExpenseLineDetail.ItemRef.name', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'lineQuantity', erpPath: 'Line.0.ItemBasedExpenseLineDetail.Qty', constantValue: null, erpValue: null, transform: null },
      { entity: 'ORDER', platformField: 'grossAmount', erpPath: 'TotalAmt', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
      { entity: 'INVOICE', platformField: 'invoiceNumber', erpPath: 'DocNumber', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'INVOICE', platformField: 'grossAmount', erpPath: 'TotalAmt', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
      ...statuses('Open', 'Open', 'Closed', 'Closed'),
    ],
    notes:
      'QuickBooks is an accounting system rather than a full ERP: it will take purchase ' +
      'orders and bills, and it has no goods receipt or warehouse of its own. Register an ' +
      'app in the Intuit Developer portal and replace {realmId} with your company ID.',
    defaultsAreExamples: false,
    onPremiseTypical: false,
    regions: ['global', 'eu'],
  },
  {
    id: 'sage-x3',
    label: 'Sage X3',
    connector: 'CUSTOM',
    apiStyle: 'REST_JSON',
    authMethods: ['OAUTH2_CLIENT_CREDENTIALS', 'BASIC'],
    baseUrlExample: 'https://your-x3-host/api1/x3/erp/YOURFOLDER',
    endpoints: [
      { purpose: 'PRODUCTS', path: '/ITMMASTER', method: 'GET', pagination: 'PAGE_NUMBER', recordsPath: '$resources' },
      { purpose: 'INVENTORY', path: '/ITMMVT', method: 'GET', pagination: 'PAGE_NUMBER', recordsPath: '$resources' },
      { purpose: 'PURCHASE_ORDER_CREATE', path: '/PORDER', method: 'POST' },
      { purpose: 'PURCHASE_ORDER_UPDATE', path: '/PORDER', method: 'PATCH' },
      { purpose: 'GOODS_RECEIPT', path: '/PRECEIPT', method: 'POST' },
      { purpose: 'INVOICE', path: '/PINVOICE', method: 'POST' },
    ],
    mappings: [
      { entity: 'PRODUCT', platformField: 'sku', erpPath: 'ITMREF', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'PRODUCT', platformField: 'name', erpPath: 'ITMDES1', constantValue: null, erpValue: null, transform: null },
      { entity: 'INVENTORY', platformField: 'sku', erpPath: 'ITMREF', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'INVENTORY', platformField: 'onHandQty', erpPath: 'PHYSTO', constantValue: null, erpValue: null, transform: null },
      { entity: 'ORDER', platformField: 'orderNumber', erpPath: 'BPRORD', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'currency', erpPath: 'CUR', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
      { entity: 'ORDER', platformField: 'lineSku', erpPath: 'LINES.0.ITMREF', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'lineQuantity', erpPath: 'LINES.0.QTYPUU', constantValue: null, erpValue: null, transform: null },
      { entity: 'INVOICE', platformField: 'invoiceNumber', erpPath: 'NUM', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'INVOICE', platformField: 'currency', erpPath: 'CUR', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
      ...statuses('Firm', 'Received', 'Closed', 'Cancelled'),
    ],
    notes:
      'X3 exposes representations through Syracuse; which ones exist depends on what your ' +
      'partner published, so confirm each path with them. The folder name in the address is ' +
      'your X3 folder.',
    defaultsAreExamples: true,
    onPremiseTypical: true,
    regions: ['global', 'eu'],
  },
  {
    id: 'epicor-kinetic',
    label: 'Epicor Kinetic',
    connector: 'CUSTOM',
    apiStyle: 'ODATA',
    authMethods: ['API_KEY', 'BASIC', 'OAUTH2_CLIENT_CREDENTIALS'],
    baseUrlExample: 'https://your-host/server/api/v2/odata/{company}',
    endpoints: [
      { purpose: 'PRODUCTS', path: '/Erp.BO.PartSvc/Parts', method: 'GET', pagination: 'ODATA_NEXT_LINK', recordsPath: 'value' },
      { purpose: 'WAREHOUSES', path: '/Erp.BO.WarehseSvc/Warehses', method: 'GET', pagination: 'ODATA_NEXT_LINK', recordsPath: 'value' },
      { purpose: 'INVENTORY', path: '/Erp.BO.PartBinSearchSvc/PartBinSearches', method: 'GET', pagination: 'ODATA_NEXT_LINK', recordsPath: 'value' },
      { purpose: 'PURCHASE_ORDER_CREATE', path: '/Erp.BO.POSvc/POs', method: 'POST' },
      { purpose: 'PURCHASE_ORDER_UPDATE', path: '/Erp.BO.POSvc/POs', method: 'PATCH' },
      { purpose: 'GOODS_RECEIPT', path: '/Erp.BO.RcvHeadSvc/RcvHeads', method: 'POST' },
      { purpose: 'INVOICE', path: '/Erp.BO.APInvoiceSvc/APInvoices', method: 'POST' },
    ],
    mappings: [
      { entity: 'PRODUCT', platformField: 'sku', erpPath: 'PartNum', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'PRODUCT', platformField: 'name', erpPath: 'PartDescription', constantValue: null, erpValue: null, transform: null },
      { entity: 'INVENTORY', platformField: 'sku', erpPath: 'PartNum', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'INVENTORY', platformField: 'onHandQty', erpPath: 'OnhandQty', constantValue: null, erpValue: null, transform: null },
      { entity: 'ORDER', platformField: 'orderNumber', erpPath: 'EntryPerson', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'currency', erpPath: 'CurrencyCode', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
      { entity: 'ORDER', platformField: 'lineSku', erpPath: 'PODetails.0.PartNum', constantValue: null, erpValue: null, transform: 'TRIM' },
      { entity: 'ORDER', platformField: 'lineQuantity', erpPath: 'PODetails.0.OrderQty', constantValue: null, erpValue: null, transform: null },
      { entity: 'INVOICE', platformField: 'invoiceNumber', erpPath: 'InvoiceNum', constantValue: null, erpValue: null, transform: 'TRIM' },
      ...statuses('Open', 'Received', 'Closed', 'Void'),
    ],
    notes:
      'Kinetic needs an API key from the admin console alongside whatever user credential ' +
      'you use - both travel on every call. Replace {company} with your company ID.',
    defaultsAreExamples: true,
    onPremiseTypical: true,
    regions: ['global', 'eu'],
  },
  {
    id: 'infor-ion',
    label: 'Infor (via ION API)',
    connector: 'CUSTOM',
    apiStyle: 'REST_JSON',
    authMethods: ['OAUTH2_CLIENT_CREDENTIALS'],
    baseUrlExample: 'https://mingle-ionapi.inforcloudsuite.com/TENANT/M3/m3api-rest/v2',
    endpoints: [],
    mappings: [...REST_CONVENTIONAL, ...statuses('Released', 'Delivered', 'Received', 'Cancelled')],
    notes:
      'Infor covers several products - M3, LN, CloudSuite - and ION API sits in front of all ' +
      'of them, so the paths depend on which you run and which flows your partner published. ' +
      'Download the .ionapi credentials file from ION API and use the client ID and secret ' +
      'from it; the token address is in there too.',
    defaultsAreExamples: true,
    onPremiseTypical: false,
    regions: ['global', 'eu'],
  },

  // --- India ------------------------------------------------------------
  {
    id: 'tcs-ion',
    label: 'TCS iON',
    connector: 'CUSTOM',
    apiStyle: 'REST_JSON',
    authMethods: ['OAUTH2_CLIENT_CREDENTIALS', 'API_KEY', 'BEARER_TOKEN'],
    baseUrlExample: 'https://api.tcsion.com/your-tenant/procurement/v1',
    // Deliberately empty, which means the CUSTOM connector's generic REST paths
    // stand in - `/purchase-orders`, `/inventory` and the rest. That is the
    // right stand-in for a system whose real paths depend on which iON modules
    // this customer runs and how their implementation partner exposed them:
    // they are a starting shape rather than a promise, and `defaultsAreExamples`
    // is what puts that on the screen beside them. Writing confident-looking
    // TCS-specific paths here instead would be a guess dressed as a fact.
    endpoints: [],
    mappings: [...REST_CONVENTIONAL, ...statuses('APPROVED', 'DISPATCHED', 'RECEIVED', 'CANCELLED')],
    notes:
      'TCS iON is configured per customer, so the procurement API paths are yours rather ' +
      'than standard. Ask your TCS iON implementation partner for the integration API ' +
      'documentation for your tenant - specifically the purchase order, goods receipt and ' +
      'invoice services - along with the client credentials and the token address. Paste ' +
      'their OpenAPI file on the Endpoints step and we will fill in what we can. If your ' +
      'iON instance is not reachable from the internet, they will need to expose it through ' +
      'a gateway.',
    defaultsAreExamples: true,
    onPremiseTypical: false,
    regions: ['india'],
  },
  {
    id: 'tally-prime',
    label: 'Tally Prime (through a JSON gateway)',
    connector: 'CUSTOM',
    apiStyle: 'REST_JSON',
    authMethods: ['API_KEY', 'BEARER_TOKEN', 'BASIC'],
    baseUrlExample: 'https://tally-gateway.your-company.com/api',
    endpoints: [],
    mappings: [...REST_CONVENTIONAL, ...statuses('Accepted', 'Dispatched', 'Received', 'Cancelled')],
    notes:
      'Tally speaks XML over a LAN port and is not reachable from the internet, so this ' +
      'platform does not talk to Tally directly. What it connects to is a small JSON ' +
      'service your IT team or Tally partner puts in front of it - most Tally partners ' +
      'already have one. Give us that service’s address, and it decides which Tally ' +
      'vouchers a purchase order becomes.',
    defaultsAreExamples: true,
    onPremiseTypical: true,
    regions: ['india'],
  },
  {
    id: 'marg-erp',
    label: 'Marg ERP (through a JSON gateway)',
    connector: 'CUSTOM',
    apiStyle: 'REST_JSON',
    authMethods: ['API_KEY', 'BEARER_TOKEN', 'BASIC'],
    baseUrlExample: 'https://marg-gateway.your-company.com/api',
    endpoints: [],
    mappings: [...REST_CONVENTIONAL, ...statuses('Pending', 'Dispatched', 'Received', 'Cancelled')],
    notes:
      'Marg is widely used in pharmaceutical distribution and runs on a local server, so - ' +
      'like Tally - what this platform connects to is a JSON endpoint in front of it. Marg ' +
      'partners generally provide one; ask yours for its address and credentials.',
    defaultsAreExamples: true,
    onPremiseTypical: true,
    regions: ['india'],
  },
  {
    id: 'busy-accounting',
    label: 'Busy Accounting (through a JSON gateway)',
    connector: 'CUSTOM',
    apiStyle: 'REST_JSON',
    authMethods: ['API_KEY', 'BEARER_TOKEN', 'BASIC'],
    baseUrlExample: 'https://busy-gateway.your-company.com/api',
    endpoints: [],
    mappings: [...REST_CONVENTIONAL, ...statuses('Pending', 'Dispatched', 'Received', 'Cancelled')],
    notes:
      'Busy runs on a local server and exposes XML, so this platform connects to a JSON ' +
      'service in front of it rather than to Busy itself. Ask your Busy partner for its ' +
      'address.',
    defaultsAreExamples: true,
    onPremiseTypical: true,
    regions: ['india'],
  },

  // --- Boards used as ERPs, and the escape hatch -------------------------
  {
    id: 'monday',
    label: 'monday.com',
    connector: 'MONDAY',
    apiStyle: 'GRAPHQL',
    authMethods: ['OAUTH2_AUTHORIZATION_CODE', 'MONDAY_PERSONAL_TOKEN'],
    baseUrlExample: 'https://api.monday.com',
    endpoints: [],
    mappings: [],
    notes:
      'monday.com is on the public internet, so there is nothing for your IT team to open ' +
      'up. Sign in as somebody who can edit the board you want purchase orders created on.',
    defaultsAreExamples: false,
    onPremiseTypical: false,
    regions: ['global', 'eu', 'india'],
  },
  {
    id: 'custom',
    label: 'Something else with an API',
    connector: 'CUSTOM',
    apiStyle: 'REST_JSON',
    authMethods: [
      'OAUTH2_CLIENT_CREDENTIALS',
      'OAUTH2_AUTHORIZATION_CODE',
      'API_KEY',
      'BEARER_TOKEN',
      'BASIC',
    ],
    baseUrlExample: 'https://erp.your-company.com/api',
    endpoints: [],
    mappings: [],
    notes:
      'Anything with a documented HTTP API. If you have an OpenAPI file, paste it on the ' +
      'Endpoints step and we will suggest which endpoint does what.',
    defaultsAreExamples: true,
    onPremiseTypical: false,
    regions: ['global', 'eu', 'india'],
  },
]);

const BY_ID: ReadonlyMap<string, VendorPreset> = new Map(
  VENDOR_PRESETS.map((preset) => [preset.id, preset]),
);

export function presetById(id: string | null | undefined): VendorPreset | null {
  if (id === null || id === undefined) return null;
  return BY_ID.get(id) ?? null;
}

/**
 * The catalogue, ordered for the market this deployment serves.
 *
 * An Indian buyer should not have to scroll past four American mid-market ERPs
 * to find Tally, and a German one should not lead with Marg. Within a region
 * the declared order stands, which puts SAP first because it is both the
 * commonest and the one with the most to configure.
 */
export function presetsForRegion(region: 'global' | 'india' | 'eu'): VendorPreset[] {
  return [...VENDOR_PRESETS].sort((a, b) => {
    // `custom` is the escape hatch and belongs last whatever the region -
    // which has to be decided BEFORE the region grouping, or a region it
    // happens to list sorts it above every named ERP the region does not.
    if (a.id === 'custom') return b.id === 'custom' ? 0 : 1;
    if (b.id === 'custom') return -1;

    const aHas = a.regions.includes(region) ? 0 : 1;
    const bHas = b.regions.includes(region) ? 0 : 1;
    if (aHas !== bHas) return aHas - bHas;

    // Equal rank keeps the declared order, which is deliberate: within a region
    // the catalogue is written commonest-first.
    return 0;
  });
}
