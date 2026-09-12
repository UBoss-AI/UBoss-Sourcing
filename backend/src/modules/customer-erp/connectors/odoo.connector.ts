/**
 * Odoo.
 *
 * The one system in the catalogue whose protocol genuinely needs its own file.
 * Everything else with a REST or OData API rides the `CUSTOM` connector with a
 * preset; Odoo speaks JSON-RPC, where the method, the model and the arguments
 * all travel inside one POST body to one address:
 *
 *   POST /jsonrpc
 *   {"jsonrpc":"2.0","method":"call","params":{
 *      "service":"object","method":"execute_kw",
 *      "args":[db, uid, password, model, "search_read", [domain], {fields}]}}
 *
 * There is no path per resource, no HTTP status to branch on, and no header
 * that says what went wrong - which drives the three decisions below.
 *
 * AN ERROR ARRIVES WITH HTTP 200
 *
 * Same trap as monday's GraphQL, and worse: an Odoo fault carries a Python
 * traceback in `error.data.message`. A connector that only looked at the status
 * code would record every failure as a success and write a null reference into
 * the ledger. `rpc` below treats `error` as the failure it is, and passes only
 * the short `message` through - never `debug`, which is the traceback.
 *
 * IDENTIFIERS ARE INTEGERS, NOT CODES
 *
 * `purchase.order` wants `partner_id: 42` and `product_id: 17`, not a vendor
 * code and a SKU. So a purchase order costs two lookups before the create: the
 * vendor, and each product by its `default_code`. A SKU the buyer's Odoo does
 * not carry is reported as a mapping problem naming the SKU, rather than
 * silently dropping the line - a purchase order that arrives missing two of its
 * five lines is worse than one that does not arrive.
 *
 * THERE IS NO IDEMPOTENCY HEADER
 *
 * So the guard is a search before the create, on `partner_ref` - which holds
 * our order number and is unique here because our order numbers are. A retry
 * that reaches this point after a create that in fact succeeded finds the
 * existing order and reports it rather than raising a second one.
 */
import { env } from '../../../config/env.js';
import { ErrorCode, conflict } from '../../../domain/errors.js';
import { openCredential, type PrimaryCredential } from '../credential.service.js';
import { ErpCallError, callErp, redactForLedger, resolveEndpointUrl } from '../http.js';
import { applyInbound, readPath, statusToErp } from '../mapping.service.js';
import type {
  Connector,
  ConnectorConfigurationCheck,
  ConnectorContext,
  ConnectorDefaults,
  ConnectorTestResult,
  InboundEvent,
  InboundInventoryRecord,
  InboundPage,
  OutboundPayload,
  OutboundResult,
} from './types.js';

/** Odoo's JSON-RPC entry point. One address for everything. */
const ODOO_RPC_PATH = '/jsonrpc';

export const odooConnector: Connector = {
  system: 'ODOO',

  defaults(): ConnectorDefaults {
    return {
      apiStyle: 'REST_JSON',
      // Odoo has no OAuth of its own. An API key generated from Preferences →
      // Account Security goes wherever a password goes, which is what makes
      // BASIC the honest description of it rather than a weaker choice.
      authMethods: ['BASIC'],
      endpoints: [
        { purpose: 'PRODUCTS', path: ODOO_RPC_PATH, method: 'POST' },
        { purpose: 'WAREHOUSES', path: ODOO_RPC_PATH, method: 'POST' },
        { purpose: 'INVENTORY', path: ODOO_RPC_PATH, method: 'POST' },
        { purpose: 'PURCHASE_ORDER_CREATE', path: ODOO_RPC_PATH, method: 'POST' },
        { purpose: 'PURCHASE_ORDER_UPDATE', path: ODOO_RPC_PATH, method: 'POST' },
        { purpose: 'GOODS_RECEIPT', path: ODOO_RPC_PATH, method: 'POST' },
        { purpose: 'INVOICE', path: ODOO_RPC_PATH, method: 'POST' },
      ],
      mappings: [
        { entity: 'PRODUCT', platformField: 'sku', erpPath: 'default_code', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'PRODUCT', platformField: 'name', erpPath: 'name', constantValue: null, erpValue: null, transform: null },
        { entity: 'INVENTORY', platformField: 'sku', erpPath: 'default_code', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'INVENTORY', platformField: 'onHandQty', erpPath: 'qty_available', constantValue: null, erpValue: null, transform: null },
        { entity: 'INVENTORY', platformField: 'unitOfMeasure', erpPath: 'uom_id.1', constantValue: null, erpValue: null, transform: null },
        { entity: 'ORDER', platformField: 'orderNumber', erpPath: 'partner_ref', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'ORDER', platformField: 'lineSku', erpPath: 'order_line.0.name', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'ORDER', platformField: 'lineQuantity', erpPath: 'order_line.0.product_qty', constantValue: null, erpValue: null, transform: null },
        { entity: 'ORDER', platformField: 'grossAmount', erpPath: 'amount_total', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
        { entity: 'INVOICE', platformField: 'invoiceNumber', erpPath: 'name', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'INVOICE', platformField: 'grossAmount', erpPath: 'amount_total', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
        { entity: 'STATUS', platformField: 'CONFIRMED', erpPath: '', constantValue: null, erpValue: 'purchase', transform: null },
        { entity: 'STATUS', platformField: 'SHIPPED', erpPath: '', constantValue: null, erpValue: 'done', transform: null },
        { entity: 'STATUS', platformField: 'DELIVERED', erpPath: '', constantValue: null, erpValue: 'done', transform: null },
        { entity: 'STATUS', platformField: 'CANCELLED', erpPath: '', constantValue: null, erpValue: 'cancel', transform: null },
      ],
      networkNotes:
        'Generate an API key from Preferences → Account Security and use your login as the ' +
        'username - Odoo accepts the key wherever a password goes, so you never give us your ' +
        'real password. Put your database name in "Your reference with us": a JSON-RPC call ' +
        'names the database on every request, and Odoo Online hosts several under one ' +
        'address. A self-hosted Odoo has to be reachable over HTTPS.',
      supportsWebhooks: true,
      // Self-hosted or buyer-configured: only they know where their own
      // installation serves OAuth, so there is nothing sensible to default to.
      oauthAuthorizationUrl: null,
      oauthTokenUrl: null,
    };
  },

  validateConfiguration(input: ConnectorConfigurationCheck): void {
    if (input.authMethod !== 'BASIC') {
      throw conflict(
        ErrorCode.CUSTOMER_ERP_CONFIGURATION_REFUSED,
        'Odoo authenticates with a login and an API key, which this form calls username and ' +
          'password. Generate the key from Preferences → Account Security rather than using ' +
          'your real password.',
      );
    }
  },

  /**
   * Prove the credentials work by authenticating and reading one product.
   *
   * Authenticating alone would prove less than it looks: Odoo happily returns a
   * uid for an account with no access to `product.product`, and the first real
   * sync would then fail for a reason the test said nothing about.
   */
  async test(context: ConnectorContext): Promise<ConnectorTestResult> {
    const started = Date.now();
    const session = await authenticate(context);

    const products = await rpc<unknown[]>(context, session, 'product.product', 'search_read', [
      [['type', '!=', 'service']],
    ], { fields: PRODUCT_FIELDS, limit: 1 });

    return {
      ok: true,
      httpStatus: 200,
      durationMs: Date.now() - started,
      message:
        products.length === 0
          ? `Signed in to Odoo database "${session.db}". It has no stockable products yet, ` +
            'which is fine for a test - but the field mapping cannot be checked until it does.'
          : `Signed in to Odoo database "${session.db}" and read a product.`,
      sample: products.length === 0 ? null : redactForLedger(products[0]),
    };
  },

  async send(context: ConnectorContext, outbound: OutboundPayload): Promise<OutboundResult> {
    const session = await authenticate(context);

    switch (outbound.kind) {
      case 'PURCHASE_ORDER_CREATE':
        return createPurchaseOrder(context, session, outbound.payload);

      case 'PURCHASE_ORDER_UPDATE': {
        const id = await findPurchaseOrder(context, session, outbound.payload.orderNumber);
        if (id === null) return notPresent();

        const state = statusToErp(context.mappings, outbound.payload.status);

        // `cancel` is a workflow action rather than a field write: setting
        // `state` directly leaves the stock moves and the bill behind it
        // untouched, which is how an Odoo database ends up with a cancelled
        // order that still has a receipt waiting against it.
        if (state === 'cancel') {
          await rpc(context, session, 'purchase.order', 'button_cancel', [[id]]);
        } else if (state !== null) {
          await rpc(context, session, 'purchase.order', 'write', [[id], { state }]);
        }

        return {
          erpReference: String(id),
          httpStatus: 200,
          durationMs: 0,
          request: redactForLedger({ id, state }),
          response: { ok: true },
          alreadyPresent: false,
        };
      }

      case 'SHIPMENT_STATUS': {
        const id = await findPurchaseOrder(context, session, outbound.payload.orderNumber);
        if (id === null) return notPresent();

        // Odoo has no carrier field on a purchase order, so the tracking goes
        // in the chatter as a note. That is where an Odoo user looks for it,
        // and inventing a custom field on somebody's database is not this
        // connector's business.
        await rpc(context, session, 'purchase.order', 'message_post', [[id]], {
          body:
            `Shipment ${outbound.payload.status}` +
            (outbound.payload.trackingNumber === null
              ? ''
              : ` — tracking ${outbound.payload.trackingNumber}`),
        });

        return {
          erpReference: String(id),
          httpStatus: 200,
          durationMs: 0,
          request: redactForLedger(outbound.payload),
          response: { ok: true },
          alreadyPresent: false,
        };
      }

      case 'GOODS_RECEIPT': {
        const id = await findPurchaseOrder(context, session, outbound.payload.orderNumber);
        if (id === null) return notPresent();

        // The receipt itself is an Odoo workflow that generates stock moves;
        // driving it from outside would mean guessing at lot numbers and
        // destination locations the warehouse decides. What this does is record
        // that the goods arrived, and let their warehouse validate the picking.
        await rpc(context, session, 'purchase.order', 'message_post', [[id]], {
          body: `Goods receipted at the supplier: ${outbound.payload.lines.length} line(s) on ${outbound.payload.receivedAt.slice(0, 10)}.`,
        });

        return {
          erpReference: String(id),
          httpStatus: 200,
          durationMs: 0,
          request: redactForLedger(outbound.payload),
          response: { ok: true },
          alreadyPresent: false,
        };
      }

      case 'INVOICE_SYNC': {
        const existing = await rpc<number[]>(context, session, 'account.move', 'search', [
          [
            ['ref', '=', outbound.payload.invoiceNumber],
            ['move_type', '=', 'in_invoice'],
          ],
        ], { limit: 1 });

        if (existing.length > 0) {
          return {
            erpReference: String(existing[0]),
            httpStatus: 200,
            durationMs: 0,
            request: { invoiceNumber: outbound.payload.invoiceNumber },
            response: { note: 'already present' },
            alreadyPresent: true,
          };
        }

        const partnerId = await findVendor(context, session);

        const body = {
          move_type: 'in_invoice',
          ref: outbound.payload.invoiceNumber,
          invoice_date: outbound.payload.issuedAt.slice(0, 10),
          ...(outbound.payload.dueAt === null
            ? {}
            : { invoice_date_due: outbound.payload.dueAt.slice(0, 10) }),
          ...(partnerId === null ? {} : { partner_id: partnerId }),
        };

        const id = await rpc<number>(context, session, 'account.move', 'create', [body]);

        return {
          erpReference: String(id),
          httpStatus: 200,
          durationMs: 0,
          request: redactForLedger(body),
          response: { id },
          alreadyPresent: false,
        };
      }

      case 'PAYMENT_REFERENCE': {
        const moves = await rpc<number[]>(context, session, 'account.move', 'search', [
          [['ref', '=', outbound.payload.invoiceNumber]],
        ], { limit: 1 });

        if (moves.length === 0) return notPresent();

        await rpc(context, session, 'account.move', 'message_post', [[moves[0]]], {
          body: `Payment ${outbound.payload.status}: reference ${outbound.payload.reference}.`,
        });

        return {
          erpReference: outbound.payload.reference,
          httpStatus: 200,
          durationMs: 0,
          request: redactForLedger(outbound.payload),
          response: { ok: true },
          alreadyPresent: false,
        };
      }
    }
  },

  /**
   * One page of stock.
   *
   * The cursor is an offset, because `search_read` pages by offset and limit and
   * has nothing resembling a continuation token.
   */
  async readInventory(context: ConnectorContext, cursor: string | null): Promise<InboundPage> {
    const started = Date.now();
    const session = await authenticate(context);

    const limit = Math.min(200, env.CUSTOMER_ERP_MAX_SYNC_RECORDS);
    const offset = cursor === null ? 0 : Number.parseInt(cursor, 10) || 0;

    const records = await rpc<Record<string, unknown>[]>(
      context,
      session,
      'product.product',
      'search_read',
      [[['type', '!=', 'service']]],
      { fields: PRODUCT_FIELDS, limit, offset },
    );

    return {
      records: records.map((record) => toInventoryRecord(context, record)),
      // A short page is the last page. There is no total to compare against
      // without a second `search_count` call, and that call costs as much as
      // the page it would save.
      nextCursor: records.length < limit ? null : String(offset + records.length),
      httpStatus: 200,
      durationMs: Date.now() - started,
    };
  },

  /**
   * Make sense of a verified delivery.
   *
   * Odoo has no outbound webhook of its own, so anything arriving here came
   * from an automated action somebody built - which means the shape is theirs.
   * The three fields looked for are the ones such an action would plausibly
   * send, and an unrecognised body is not an error.
   */
  interpretWebhook(context: ConnectorContext, payload: unknown): InboundEvent[] {
    const model = asText(readPath(payload, 'model')) ?? '';
    const state = asText(readPath(payload, 'state') ?? readPath(payload, 'data.state'));
    const reference = asText(
      readPath(payload, 'partner_ref') ?? readPath(payload, 'data.partner_ref'),
    );

    if (model.includes('purchase.order') && state !== null) {
      return [{ kind: 'ORDER_STATUS', erpPurchaseOrderId: reference, erpStatus: state }];
    }

    if (model.includes('stock.picking') || model.includes('stock.move')) {
      const lines = readPath(payload, 'lines') ?? readPath(payload, 'data.lines');

      return [
        {
          kind: 'GOODS_RECEIPT',
          erpPurchaseOrderId: reference,
          erpGoodsReceiptId: asText(readPath(payload, 'name') ?? readPath(payload, 'data.name')),
          receivedAt: asText(readPath(payload, 'date_done') ?? readPath(payload, 'data.date_done')),
          lines: (Array.isArray(lines) ? lines : []).map((line) => ({
            erpMaterialNumber: asText(readPath(line, 'default_code')),
            sku: asText(readPath(line, 'default_code')),
            quantity: Number(readPath(line, 'quantity') ?? readPath(line, 'qty_done') ?? 0) || 0,
          })),
        },
      ];
    }

    if (model.includes('product') || model.includes('stock.quant')) {
      const records = Array.isArray(payload) ? payload : [payload];
      return [{ kind: 'INVENTORY', records: records.map((r) => toInventoryRecord(context, r)) }];
    }

    return [];
  },
};

// ---------------------------------------------------------------------------
// The purchase order
// ---------------------------------------------------------------------------

async function createPurchaseOrder(
  context: ConnectorContext,
  session: Session,
  payload: Extract<OutboundPayload, { kind: 'PURCHASE_ORDER_CREATE' }>['payload'],
): Promise<OutboundResult> {
  const started = Date.now();

  // The duplicate guard. Odoo has no idempotency header, so this search is what
  // stops a retry raising a second purchase order.
  const existing = await findPurchaseOrder(context, session, payload.orderNumber);

  if (existing !== null) {
    return {
      erpReference: String(existing),
      httpStatus: 200,
      durationMs: Date.now() - started,
      request: { partner_ref: payload.orderNumber },
      response: { id: existing, note: 'already present' },
      alreadyPresent: true,
    };
  }

  const partnerId = await findVendor(context, session);

  if (partnerId === null) {
    throw new ErpCallError(
      'No vendor in your Odoo matches this supplier. Put the vendor’s Odoo ID or its exact ' +
        'name in "Your reference with us" on the connection.',
      'REJECTED',
    );
  }

  // SKU to product id, in one call rather than one per line.
  const skus = [...new Set(payload.lines.map((line) => line.erpMaterialNumber ?? line.sku))];

  const products = await rpc<{ id: number; default_code: string }[]>(
    context,
    session,
    'product.product',
    'search_read',
    [[['default_code', 'in', skus]]],
    { fields: ['id', 'default_code'] },
  );

  const byCode = new Map(products.map((product) => [product.default_code, product.id]));
  const missing = skus.filter((sku) => !byCode.has(sku));

  if (missing.length > 0) {
    // Named, not dropped. A purchase order arriving without two of its five
    // lines is worse than one that does not arrive, because nobody notices.
    throw new ErpCallError(
      `Your Odoo has no product with internal reference ${missing.join(', ')}. Add it, or map ` +
        'the SKU to the reference you do use.',
      'REJECTED',
    );
  }

  const body = {
    partner_id: partnerId,
    partner_ref: payload.orderNumber,
    date_order: payload.orderedAt.slice(0, 19).replace('T', ' '),
    order_line: payload.lines.map((line) => [
      // Odoo's one2many command triple: 0 means create, the 0 is a placeholder
      // id, and the object is the new line.
      0,
      0,
      {
        product_id: byCode.get(line.erpMaterialNumber ?? line.sku),
        name: line.name,
        product_qty: line.quantity,
        // Minor units to a decimal by string arithmetic, never `/ 100`.
        price_unit: Number(minorToDecimal(line.unitPriceMinor, context.currencyExponent)),
        ...(payload.requestedDeliveryAt === null
          ? {}
          : { date_planned: payload.requestedDeliveryAt.slice(0, 19).replace('T', ' ') }),
      },
    ]),
  };

  const id = await rpc<number>(context, session, 'purchase.order', 'create', [body]);

  return {
    erpReference: String(id),
    httpStatus: 200,
    durationMs: Date.now() - started,
    request: redactForLedger(body),
    response: { id },
    alreadyPresent: false,
  };
}

async function findPurchaseOrder(
  context: ConnectorContext,
  session: Session,
  orderNumber: string,
): Promise<number | null> {
  const found = await rpc<number[]>(context, session, 'purchase.order', 'search', [
    [['partner_ref', '=', orderNumber]],
  ], { limit: 1 });

  return found.length === 0 ? null : (found[0] ?? null);
}

/**
 * The vendor this platform is, in the buyer's Odoo.
 *
 * `tenantIdentifier` carries it: an integer id where they know it, otherwise
 * the exact partner name. Two shapes because a buyer setting this up rarely
 * knows Odoo's internal ids and always knows what the supplier is called.
 */
async function findVendor(
  context: ConnectorContext,
  session: Session,
): Promise<number | null> {
  const identifier = context.tenantIdentifier;
  if (identifier === null || identifier.trim().length === 0) return null;

  if (/^\d+$/.test(identifier.trim())) return Number.parseInt(identifier.trim(), 10);

  const found = await rpc<number[]>(context, session, 'res.partner', 'search', [
    [['name', '=', identifier.trim()]],
  ], { limit: 1 });

  return found.length === 0 ? null : (found[0] ?? null);
}

function notPresent(): OutboundResult {
  return {
    erpReference: null,
    httpStatus: 200,
    durationMs: 0,
    request: null,
    response: { note: 'no matching record in Odoo' },
    alreadyPresent: true,
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

interface Session {
  db: string;
  uid: number;
  password: string;
}

const PRODUCT_FIELDS = ['id', 'default_code', 'name', 'qty_available', 'uom_id'];

/**
 * Sign in and get a uid.
 *
 * Odoo's `authenticate` takes the database name, which is why it is asked for
 * on the connection: a JSON-RPC call names the database every time, and Odoo
 * Online hosts several under one address.
 */
async function authenticate(context: ConnectorContext): Promise<Session> {
  const primary = await openCredential<PrimaryCredential>(context.call.id, 'PRIMARY');

  if (primary?.username === undefined || primary.password === undefined) {
    throw new ErpCallError(
      'This Odoo connection has no login and API key configured.',
      'AUTH',
    );
  }

  const db = (context.tenantIdentifier ?? '').trim();

  if (db.length === 0) {
    throw new ErpCallError(
      'Odoo needs the database name. Put it in "Your reference with us" on the connection.',
      'AUTH',
    );
  }

  const uid = await call<number | false>(context, {
    service: 'common',
    method: 'authenticate',
    args: [db, primary.username, primary.password, {}],
  });

  if (uid === false || typeof uid !== 'number') {
    throw new ErpCallError(
      'Odoo refused the login and API key. Check both, and check the database name.',
      'AUTH',
    );
  }

  return { db, uid, password: primary.password };
}

/** One `execute_kw` against a model. */
async function rpc<T>(
  context: ConnectorContext,
  session: Session,
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {},
): Promise<T> {
  return call<T>(context, {
    service: 'object',
    method: 'execute_kw',
    args: [session.db, session.uid, session.password, model, method, ...args, kwargs],
  });
}

interface RpcEnvelope {
  service: string;
  method: string;
  args: unknown[];
}

/**
 * POST one JSON-RPC document and unwrap it.
 *
 * The whole reason this wrapper exists: an Odoo fault arrives with HTTP 200 and
 * an `error` object, so the status code says nothing. `error.data.message` is a
 * one-line summary and is passed through; `error.data.debug` is a Python
 * traceback and is not - it is somebody else's source code, it is long, and it
 * belongs in their log rather than in a buyer's error message.
 */
async function call<T>(context: ConnectorContext, envelope: RpcEnvelope): Promise<T> {
  const endpoint = context.endpoints.get('PURCHASE_ORDER_CREATE');
  const url = resolveEndpointUrl(context.call.baseUrl, endpoint?.path ?? ODOO_RPC_PATH);

  const response = await callErp<Record<string, unknown>>(context.call, {
    url,
    method: 'POST',
    body: { jsonrpc: '2.0', method: 'call', params: envelope, id: Date.now() },
    // Odoo's own credential travels inside the body, so no Authorization
    // header is built for it - `buildHeaders` still runs and still applies the
    // buyer's non-secret headers.
    accessToken: null,
  });

  const error = readPath(response.data, 'error');

  if (error !== undefined && error !== null) {
    const message =
      asText(readPath(error, 'data.message')) ??
      asText(readPath(error, 'message')) ??
      'Odoo refused the request.';

    // An access-rights failure is a different remedy from a bad payload, and
    // Odoo says which in the exception name.
    const kind = /AccessError|AccessDenied|access rights/i.test(message) ? 'AUTH' : 'REJECTED';

    throw new ErpCallError(`Odoo: ${message.slice(0, 300)}`, kind, 200);
  }

  if (!('result' in (response.data ?? {}))) {
    throw new ErpCallError('Odoo answered without a result.', 'UNUSABLE', response.status);
  }

  return (response.data as { result: T }).result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toInventoryRecord(
  context: ConnectorContext,
  record: unknown,
): InboundInventoryRecord {
  const values = applyInbound(context.mappings, 'INVENTORY', record, {
    currencyExponent: context.currencyExponent,
  });

  return {
    erpMaterialNumber: asText(values['sku'] ?? readPath(record, 'default_code')),
    sku: asText(values['sku'] ?? readPath(record, 'default_code')),
    plant: asText(values['plant']),
    onHandQty: asNumber(values['onHandQty'] ?? readPath(record, 'qty_available')),
    onOrderQty: asNumber(values['onOrderQty']),
    incomingQty: asNumber(values['incomingQty']),
    // `uom_id` is Odoo's [id, name] pair, so the NAME is the second element.
    unitOfMeasure: asText(values['unitOfMeasure'] ?? readPath(record, 'uom_id.1')),
    raw: redactForLedger(record),
  };
}

/** Minor units to a decimal string. Never `Number(minor) / 100`. */
function minorToDecimal(minor: string, exponent: number): string {
  if (exponent === 0) return minor;

  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).replace(/\D/g, '') || '0';
  const padded = digits.padStart(exponent + 1, '0');

  return `${negative ? '-' : ''}${padded.slice(0, padded.length - exponent)}.${padded.slice(
    padded.length - exponent,
  )}`;
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
