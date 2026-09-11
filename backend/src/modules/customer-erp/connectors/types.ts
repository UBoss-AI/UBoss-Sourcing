/**
 * What a connector is, and what it is not.
 *
 * A connector knows one system's dialect: what its purchase order looks like,
 * where it puts an identifier, how it pages, what it calls a goods receipt. It
 * knows nothing about tenants, approvals, idempotency, retries or state - all of
 * that belongs to the pipeline, which is the same code whichever system is on
 * the other end.
 *
 * That line is where this design earns its keep. Adding a fourth system means
 * writing one file against this interface; it does not mean touching the
 * dispatcher, the outbox, the approval flow or the audit trail, and it cannot
 * accidentally introduce a second way for a purchase order to be raised twice.
 *
 * Three implementations exist and none of them is a "generic" one with a
 * dropdown. SAP, monday.com and a custom REST/OData/GraphQL API disagree about
 * authentication, about pagination, about what an identifier is and about
 * whether a purchase order is a document or a row on a board. A single
 * parameterised connector covering all three would be a function with three of
 * everything and a flag deciding which third runs.
 */
import type {
  CustomerErpApiKeyLocation,
  CustomerErpApiStyle,
  CustomerErpAuthMethod,
  CustomerErpEndpointPurpose,
  CustomerErpEnvironment,
  CustomerErpPagination,
} from '../../../generated/prisma/enums.js';
import type { ErpCallContext } from '../http.js';
import type { MappingRow } from '../mapping.service.js';

export type SystemName = 'SAP' | 'MONDAY' | 'ODOO' | 'CUSTOM';

export type EndpointPurpose =
  | 'PRODUCTS'
  | 'WAREHOUSES'
  | 'INVENTORY'
  | 'PURCHASE_ORDER_CREATE'
  | 'PURCHASE_ORDER_UPDATE'
  | 'GOODS_RECEIPT'
  | 'SHIPMENT_STATUS'
  | 'INVOICE'
  | 'PAYMENT_REFERENCE'
  | 'WEBHOOK';

export interface EndpointConfig {
  purpose: EndpointPurpose;
  path: string;
  method: string;
  enabled: boolean;
  pagination: CustomerErpPagination;
  paginationConfig: PaginationConfig;
  recordsPath: string | null;
  requestTemplate: Record<string, unknown> | null;
  queryParams: Record<string, string>;
}

/**
 * The parameter names a paging style uses, because every API chose differently.
 *
 * Defaults are the commonest spellings, so a buyer whose ERP uses `page` and
 * `pageSize` types nothing here at all.
 */
export interface PaginationConfig {
  pageParam?: string;
  sizeParam?: string;
  offsetParam?: string;
  limitParam?: string;
  cursorParam?: string;
  /** Where the next cursor is found in the response. */
  cursorPath?: string;
  /** Where the total is found, for a progress figure that is not a guess. */
  totalPath?: string;
  pageSize?: number;
}

/** The SAP organisational keys, absent on every other system. */
export interface SapPlacement {
  companyCode: string | null;
  purchasingOrg: string | null;
  purchasingGroup: string | null;
  plant: string | null;
  storageLocation: string | null;
  communicationScenario: string | null;
}

/** Where monday puts things. */
export interface MondayPlacement {
  workspaceId: string | null;
  boardId: string | null;
  groupId: string | null;
}

/**
 * Everything a connector is given for one operation.
 *
 * Assembled once by `loadConnectorContext` and passed down, rather than each
 * connector reading the database for itself. One loader means one place where a
 * tenant scope could be forgotten, and it is a place that has been looked at.
 */
export interface ConnectorContext {
  call: ErpCallContext;
  system: SystemName;
  apiStyle: CustomerErpApiStyle;
  environment: CustomerErpEnvironment;
  erpVersion: string | null;
  authMethod: CustomerErpAuthMethod;
  apiKeyLocation: CustomerErpApiKeyLocation | null;
  endpoints: ReadonlyMap<EndpointPurpose, EndpointConfig>;
  mappings: readonly MappingRow[];
  sap: SapPlacement;
  monday: MondayPlacement;
  /** Resolved once per job, where the connection uses OAuth. */
  accessToken: string | null;
  /** The buyer's identifier for itself inside their own system. */
  tenantIdentifier: string | null;
  /** Minor-unit exponent for the currency in play. 2 unless told otherwise. */
  currencyExponent: number;
}

// ---------------------------------------------------------------------------
// What goes out
// ---------------------------------------------------------------------------

/**
 * One line of a purchase order, in platform terms.
 *
 * Money is minor units as a STRING, never a number, all the way to the moment a
 * mapping transform turns it into whatever the ERP wants. See CLAUDE.md.
 */
export interface PurchaseOrderLine {
  sku: string;
  productId: string;
  name: string;
  quantity: number;
  unitOfMeasure: string | null;
  unitPriceMinor: string;
  netAmountMinor: string;
  taxAmountMinor: string;
  /** The ERP's plant or storage location for the warehouse this ships from. */
  erpPlant: string | null;
  erpStorageLocation: string | null;
  erpMaterialNumber: string | null;
}

export interface PurchaseOrderPayload {
  orderId: string;
  orderNumber: string;
  orderedAt: string;
  currency: string;
  netAmountMinor: string;
  taxAmountMinor: string;
  grossAmountMinor: string;
  requestedDeliveryAt: string | null;
  /** Who the buyer is buying FROM, as the buyer's ERP knows the vendor. */
  vendorId: string | null;
  /** Who the buyer is, as we know them. Their customer number with us. */
  customerId: string | null;
  lines: PurchaseOrderLine[];
  /** Present when a scheduled delivery caused this, so an ERP can group them. */
  scheduleId: string | null;
  occurrenceId: string | null;
}

export interface ShipmentPayload {
  orderId: string;
  orderNumber: string;
  erpPurchaseOrderId: string | null;
  status: string;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  dispatchedAt: string | null;
  expectedAt: string | null;
}

export interface GoodsReceiptPayload {
  orderId: string;
  orderNumber: string;
  erpPurchaseOrderId: string | null;
  receivedAt: string;
  lines: {
    sku: string;
    erpMaterialNumber: string | null;
    quantity: number;
    unitOfMeasure: string | null;
    erpPlant: string | null;
    erpStorageLocation: string | null;
  }[];
}

export interface InvoicePayload {
  invoiceId: string;
  invoiceNumber: string;
  orderId: string | null;
  orderNumber: string | null;
  erpPurchaseOrderId: string | null;
  issuedAt: string;
  dueAt: string | null;
  currency: string;
  netAmountMinor: string;
  taxAmountMinor: string;
  grossAmountMinor: string;
  /** A link on THIS platform. We never hand over somebody else's address. */
  documentUrl: string | null;
}

/**
 * What settled, and nothing about how.
 *
 * A reference and a status. No card number, no last four, no token, no bank
 * detail, no instrument type. The buyer's ERP has no business holding an
 * instrument and this platform has no business handing one over: it would move
 * somebody else's system into PCI scope on our say-so, and the buyer's accounts
 * payable needs a reference to reconcile against, which is all this is.
 */
export interface PaymentReferencePayload {
  invoiceId: string | null;
  invoiceNumber: string | null;
  orderId: string;
  orderNumber: string;
  reference: string;
  status: string;
  paidAmountMinor: string;
  currency: string;
  paidAt: string;
}

export type OutboundPayload =
  | { kind: 'PURCHASE_ORDER_CREATE'; payload: PurchaseOrderPayload }
  | { kind: 'PURCHASE_ORDER_UPDATE'; payload: PurchaseOrderPayload & { status: string } }
  | { kind: 'SHIPMENT_STATUS'; payload: ShipmentPayload }
  | { kind: 'GOODS_RECEIPT'; payload: GoodsReceiptPayload }
  | { kind: 'INVOICE_SYNC'; payload: InvoicePayload }
  | { kind: 'PAYMENT_REFERENCE'; payload: PaymentReferencePayload };

/**
 * What one outbound operation produced.
 *
 * `request` and `response` are what the ledger stores, already redacted by the
 * connector - which is the right place for it, because only the connector knows
 * which of its own fields carry anything sensitive.
 */
export interface OutboundResult {
  erpReference: string | null;
  httpStatus: number | null;
  durationMs: number;
  request: unknown;
  response: unknown;
  /**
   * True when the connector could tell that the ERP already had this - a 409
   * on a document number, a monday item found by its idempotency column. The
   * pipeline treats it as success and does NOT create a second one.
   */
  alreadyPresent: boolean;
}

// ---------------------------------------------------------------------------
// What comes in
// ---------------------------------------------------------------------------

/** One stock figure read from the buyer's ERP. */
export interface InboundInventoryRecord {
  erpMaterialNumber: string | null;
  sku: string | null;
  plant: string | null;
  onHandQty: number | null;
  onOrderQty: number | null;
  incomingQty: number | null;
  unitOfMeasure: string | null;
  /** The record as it arrived, redacted and capped, for the error report. */
  raw: unknown;
}

export interface InboundPage {
  records: InboundInventoryRecord[];
  /** Opaque. Handed back on the next pass; null when there is no more. */
  nextCursor: string | null;
  httpStatus: number;
  durationMs: number;
}

/**
 * Something the buyer's ERP told us, once its signature has verified.
 *
 * A closed set, because each one has a consequence in this platform and an
 * event type nothing acts on is a webhook that silently does nothing.
 */
export type InboundEvent =
  | {
      kind: 'GOODS_RECEIPT';
      erpPurchaseOrderId: string | null;
      erpGoodsReceiptId: string | null;
      receivedAt: string | null;
      lines: { erpMaterialNumber: string | null; sku: string | null; quantity: number }[];
    }
  | {
      kind: 'ORDER_STATUS';
      erpPurchaseOrderId: string | null;
      erpStatus: string;
    }
  | {
      kind: 'INVENTORY';
      records: InboundInventoryRecord[];
    };

// ---------------------------------------------------------------------------
// Wizard defaults
// ---------------------------------------------------------------------------

/**
 * What the wizard offers before the buyer has typed anything.
 *
 * Defaults, not decisions: every one of them is editable, because the point of
 * this feature is that a buyer's system is theirs. What they buy is the buyer
 * not having to work out from scratch that S/4HANA puts purchase orders at
 * `/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder`.
 */
export interface ConnectorDefaults {
  apiStyle: CustomerErpApiStyle;
  authMethods: readonly CustomerErpAuthMethod[];
  endpoints: readonly {
    purpose: EndpointPurpose;
    path: string;
    method: string;
    pagination?: CustomerErpPagination;
    recordsPath?: string;
  }[];
  mappings: readonly Omit<MappingRow, 'required'>[];
  /** Shown on the network step, for the buyer's IT team. */
  networkNotes: string;
  supportsWebhooks: boolean;
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface Connector {
  readonly system: SystemName;

  /** What the wizard fills in before the buyer edits anything. */
  defaults(environment: CustomerErpEnvironment): ConnectorDefaults;

  /**
   * Refuse a configuration this system cannot honour.
   *
   * Called before a connection is saved and again before it is activated. Each
   * refusal has to name a legitimate alternative - "use OAuth for a production
   * monday connection" rather than "invalid".
   */
  validateConfiguration(input: ConnectorConfigurationCheck): void;

  /**
   * A cheap call that proves the credentials work.
   *
   * Deliberately a READ, and deliberately not one of the buyer's business
   * endpoints. A test that created a purchase order to prove it could would be
   * a test nobody dares press twice.
   */
  test(context: ConnectorContext): Promise<ConnectorTestResult>;

  /** One outbound operation. */
  send(context: ConnectorContext, outbound: OutboundPayload): Promise<OutboundResult>;

  /** One page of stock, for a connection with polling or a manual sync. */
  readInventory(context: ConnectorContext, cursor: string | null): Promise<InboundPage>;

  /**
   * Make sense of a verified webhook body.
   *
   * Returns an empty array for a payload this connector has no rule for, which
   * is not an error: an ERP subscribed to everything will send us things we do
   * not act on, and refusing them would make its delivery log red for no reason.
   */
  interpretWebhook(context: ConnectorContext, payload: unknown): InboundEvent[];
}

export interface ConnectorConfigurationCheck {
  environment: CustomerErpEnvironment;
  authMethod: CustomerErpAuthMethod;
  apiStyle: CustomerErpApiStyle;
  baseUrl: string;
  sap: SapPlacement;
  monday: MondayPlacement;
  oauthTokenUrl: string | null;
  oauthAuthorizationUrl: string | null;
  mutualTlsEnabled: boolean;
}

export interface ConnectorTestResult {
  ok: boolean;
  httpStatus: number | null;
  durationMs: number;
  /** Safe to show. Never a provider body, never a header. */
  message: string;
  /**
   * A record from the buyer's own system, for the mapping check.
   *
   * The single most useful thing a test can return, because it turns "the
   * credentials work" into "and here is what your data actually looks like".
   * Redacted and capped by the connector before it gets here.
   */
  sample: unknown;
}

/** Convert the database enum to the union this module uses. */
export function toEndpointPurpose(purpose: CustomerErpEndpointPurpose): EndpointPurpose {
  return purpose;
}
