/**
 * monday.com.
 *
 * Not an ERP by pedigree, and used as one by a great many buyers: a board for
 * purchase orders, a group per status, a column for SKU, one for quantity, one
 * for the supplier's reference. That is a perfectly reasonable way for a
 * fifteen-person practice to run its purchasing, and refusing to support it on
 * the grounds that it is not SAP would be refusing to support the customers who
 * most need somebody else to do their data entry.
 *
 * ONE ENDPOINT, ONE METHOD
 *
 * Everything is a POST of a GraphQL document to `/v2`. That makes several
 * things in this file look odd next to the SAP connector and they are not:
 * there is no per-purpose endpoint path to configure, no pagination
 * parameters, and no CSRF dance. The endpoint rows still exist for monday
 * connections, because the pipeline asks "is there an endpoint for this" as its
 * way of asking "does the buyer want this sent" - but the path on every one of
 * them is `/v2`.
 *
 * COLUMN IDS, NOT COLUMN TITLES
 *
 * `erpPath` on a monday mapping is a COLUMN ID - `text_1`, `numbers`,
 * `status4` - and not the human title the buyer sees on their board. That is
 * not a preference: a title can be renamed by anybody with edit rights, at any
 * time, and a mapping keyed on titles breaks silently the first time somebody
 * tidies up a board. The wizard reads the board and offers the titles beside
 * their ids, so the buyer never has to find an id by hand.
 *
 * PERSONAL TOKENS
 *
 * Allowed on a SANDBOX connection and refused on a PRODUCTION one. A personal
 * token carries one person's entire account authority, cannot be scoped down,
 * and does not stop working when they leave the company - so it is a fine way
 * to try the integration out and a poor way to run a business on it. The
 * alternative is a proper OAuth authorisation, which is offered whenever the
 * operator has registered an app.
 */
import { env } from '../../../config/env.js';
import { ErrorCode, conflict } from '../../../domain/errors.js';
import {
  ErpCallError,
  callErp,
  redactForLedger,
  resolveEndpointUrl,
} from '../http.js';
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

/** monday's API is one address. The buyer does not get to type it wrongly. */
const MONDAY_API_PATH = '/v2';

/**
 * The API version we ask for.
 *
 * monday versions its API by date and deprecates on a published schedule.
 * Pinning means a change on their side is something to plan for rather than
 * something a buyer discovers on a Tuesday.
 */
const MONDAY_API_VERSION = '2024-10';

/**
 * monday's OAuth addresses.
 *
 * The same two for every installation of monday there is, which is why they are
 * constants here rather than something the buyer types on the connection step.
 * They are not on `api.monday.com` - authorisation lives on `auth.monday.com` -
 * so a buyer left to work them out from the base address gets them wrong.
 */
const MONDAY_AUTHORIZE_URL = 'https://auth.monday.com/oauth2/authorize';
const MONDAY_TOKEN_URL = 'https://auth.monday.com/oauth2/token';

export const mondayConnector: Connector = {
  system: 'MONDAY',

  defaults(environment): ConnectorDefaults {
    /*
     * Only methods that would actually be ACCEPTED, for this environment and
     * this deployment.
     *
     * Empty is a real answer and the screen has to be able to render it: a
     * production connection on a deployment with no registered app cannot be
     * made at all, and saying so on the first step is the whole point. Listing
     * the personal token here instead - the one thing `validateConfiguration`
     * refuses outright below - offered a choice that was never a choice, and
     * only admitted it after the buyer had filled in every other step.
     */
    const authMethods =
      env.MONDAY_OAUTH_CLIENT_ID.length > 0
        ? // OAuth first wherever the operator has registered an app, because it
          // is the one that survives somebody leaving.
          (environment === 'PRODUCTION'
            ? (['OAUTH2_AUTHORIZATION_CODE'] as const)
            : (['OAUTH2_AUTHORIZATION_CODE', 'MONDAY_PERSONAL_TOKEN'] as const))
        : // No registered app: only the personal-token path exists, and it is
          // sandbox-only, so a production connection cannot be made at all.
          (environment === 'PRODUCTION' ? ([] as const) : (['MONDAY_PERSONAL_TOKEN'] as const));

    return {
      apiStyle: 'GRAPHQL',
      authMethods: [...authMethods],
      endpoints: [
        { purpose: 'PURCHASE_ORDER_CREATE', path: MONDAY_API_PATH, method: 'POST' },
        { purpose: 'PURCHASE_ORDER_UPDATE', path: MONDAY_API_PATH, method: 'POST' },
        { purpose: 'SHIPMENT_STATUS', path: MONDAY_API_PATH, method: 'POST' },
        { purpose: 'GOODS_RECEIPT', path: MONDAY_API_PATH, method: 'POST' },
        { purpose: 'INVOICE', path: MONDAY_API_PATH, method: 'POST' },
        { purpose: 'PAYMENT_REFERENCE', path: MONDAY_API_PATH, method: 'POST' },
        { purpose: 'INVENTORY', path: MONDAY_API_PATH, method: 'POST' },
      ],
      // Column ids rather than titles - see this file's header. These are
      // monday's defaults for a fresh board, so a buyer who has not renamed
      // anything gets a working mapping and everybody else edits it in the
      // wizard, where the board's real columns are listed beside their ids.
      mappings: [
        { entity: 'ORDER', platformField: 'orderNumber', erpPath: 'name', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'ORDER', platformField: 'purchaseOrderNumber', erpPath: 'text', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'ORDER', platformField: 'currency', erpPath: 'text1', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
        { entity: 'ORDER', platformField: 'lineSku', erpPath: 'text2', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'ORDER', platformField: 'lineQuantity', erpPath: 'numbers', constantValue: null, erpValue: null, transform: null },
        { entity: 'ORDER', platformField: 'lineUnitOfMeasure', erpPath: 'text3', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
        { entity: 'ORDER', platformField: 'grossAmount', erpPath: 'numbers1', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
        { entity: 'ORDER', platformField: 'deliveryDate', erpPath: 'date', constantValue: null, erpValue: null, transform: 'DATE_ONLY' },
        { entity: 'ORDER', platformField: 'trackingNumber', erpPath: 'text4', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'INVOICE', platformField: 'invoiceNumber', erpPath: 'text5', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'INVOICE', platformField: 'grossAmount', erpPath: 'numbers2', constantValue: null, erpValue: null, transform: 'MINOR_TO_DECIMAL' },
        { entity: 'INVOICE', platformField: 'currency', erpPath: 'text6', constantValue: null, erpValue: null, transform: 'UPPERCASE' },
        { entity: 'INVOICE', platformField: 'dueDate', erpPath: 'date1', constantValue: null, erpValue: null, transform: 'DATE_ONLY' },
        { entity: 'PAYMENT', platformField: 'paymentReference', erpPath: 'text7', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'PAYMENT', platformField: 'paymentStatus', erpPath: 'status1', constantValue: null, erpValue: null, transform: null },
        { entity: 'INVENTORY', platformField: 'sku', erpPath: 'text2', constantValue: null, erpValue: null, transform: 'TRIM' },
        { entity: 'INVENTORY', platformField: 'onHandQty', erpPath: 'numbers3', constantValue: null, erpValue: null, transform: null },
        { entity: 'STATUS', platformField: 'CONFIRMED', erpPath: '', constantValue: null, erpValue: 'Ordered', transform: null },
        { entity: 'STATUS', platformField: 'SHIPPED', erpPath: '', constantValue: null, erpValue: 'Shipped', transform: null },
        { entity: 'STATUS', platformField: 'DELIVERED', erpPath: '', constantValue: null, erpValue: 'Received', transform: null },
        { entity: 'STATUS', platformField: 'CANCELLED', erpPath: '', constantValue: null, erpValue: 'Cancelled', transform: null },
      ],
      networkNotes:
        'monday.com is on the public internet, so there is nothing for your IT team to ' +
        'open up. Press Connect monday.com and sign in as somebody who can edit the board ' +
        'you want purchase orders created on. We ask only for the permissions listed on ' +
        'that screen.',
      supportsWebhooks: true,
      // monday serves one authorisation endpoint and one token endpoint for
      // every installation on earth, so asking a buyer to type them is asking
      // them to get one of two fixed strings wrong.
      oauthAuthorizationUrl: MONDAY_AUTHORIZE_URL,
      oauthTokenUrl: MONDAY_TOKEN_URL,
    };
  },

  validateConfiguration(input: ConnectorConfigurationCheck): void {
    if (input.baseUrl.toLowerCase().includes('monday.com') === false) {
      throw conflict(
        ErrorCode.CUSTOMER_ERP_CONFIGURATION_REFUSED,
        'A monday.com connection has to point at monday.com. Use https://api.monday.com ' +
          'as the address.',
      );
    }

    if (
      input.environment === 'PRODUCTION' &&
      input.authMethod === 'MONDAY_PERSONAL_TOKEN'
    ) {
      throw conflict(
        ErrorCode.CUSTOMER_ERP_CONFIGURATION_REFUSED,
        env.MONDAY_OAUTH_CLIENT_ID.length > 0
          ? 'A personal API token carries one person’s whole monday.com account and ' +
            'does not stop working when they leave, so it cannot be used on a production ' +
            'connection. Press Connect monday.com to authorise properly instead.'
          : 'A personal API token cannot be used on a production connection, and this ' +
            'store has not registered a monday.com application for the proper ' +
            'authorisation. Use a sandbox connection, or ask your supplier to register one.',
      );
    }

    if (
      input.authMethod !== 'MONDAY_PERSONAL_TOKEN' &&
      input.authMethod !== 'OAUTH2_AUTHORIZATION_CODE'
    ) {
      throw conflict(
        ErrorCode.CUSTOMER_ERP_CONFIGURATION_REFUSED,
        'monday.com accepts either an OAuth authorisation or a personal API token. ' +
          'Choose one of those.',
      );
    }

    if (input.monday.boardId === null) {
      throw conflict(
        ErrorCode.CUSTOMER_ERP_CONFIGURATION_REFUSED,
        'Choose the board purchase orders should be created on.',
      );
    }
  },

  /**
   * Prove the token works by asking who we are and reading the board.
   *
   * `me` costs monday almost nothing and answers the only question a test has
   * to answer. Reading the board's columns alongside it is what makes the
   * mapping step possible at all: the buyer picks from their real column titles
   * rather than typing ids from memory.
   */
  async test(context: ConnectorContext): Promise<ConnectorTestResult> {
    const response = await graphql(context, {
      query: `query Probe($boardIds: [ID!]) {
        me { id name email }
        boards(ids: $boardIds) {
          id
          name
          columns { id title type }
          groups { id title }
          items_page(limit: 1) { items { id name column_values { id text value } } }
        }
      }`,
      variables: { boardIds: context.monday.boardId === null ? [] : [context.monday.boardId] },
    });

    const board = readPath(response.data, 'data.boards.0');

    if (board === undefined) {
      throw new ErpCallError(
        'monday.com accepted the credentials but this account cannot see that board. ' +
          'Check the board id, and that whoever authorised has access to it.',
        'REJECTED',
        response.status,
      );
    }

    return {
      ok: true,
      httpStatus: response.status,
      durationMs: response.durationMs,
      message: `Connected to monday.com and read the board "${
        asText(readPath(board, 'name')) ?? context.monday.boardId ?? 'unnamed'
      }".`,
      /*
       * The sample serves two readers, and the shape has to suit the stricter
       * one.
       *
       * A person reads it to find out what their own board looks like, and the
       * mapping check reads it to decide whether `text2` finds anything. So the
       * item is FLATTENED to the top level - the same shape `readInventory`
       * builds and the same shape the mapping is written against - rather than
       * left as monday's `column_values` array, which no dotted path can reach
       * into and which therefore reported every mapped field as missing.
       *
       * The board's own reference data sits under underscored keys so a column
       * called `board` or `groups` cannot shadow it, and so a buyer reading the
       * sample can tell at a glance which half is theirs.
       */
      sample: redactForLedger({
        ...flattenItem(readPath(board, 'items_page.items.0')),
        _board: { id: readPath(board, 'id'), name: readPath(board, 'name') },
        // The columns are the useful half of this for the mapping step: each
        // one carries the id a mapping names beside the title the buyer sees.
        _columns: readPath(board, 'columns'),
        _groups: readPath(board, 'groups'),
      }),
    };
  },

  async send(context: ConnectorContext, outbound: OutboundPayload): Promise<OutboundResult> {
    switch (outbound.kind) {
      case 'PURCHASE_ORDER_CREATE':
        return createItem(context, outbound.payload.orderNumber, {
          ...columnValuesFor(context, 'ORDER', {
            purchaseOrderNumber: outbound.payload.orderNumber,
            currency: outbound.payload.currency,
            grossAmount: outbound.payload.grossAmountMinor,
            deliveryDate: outbound.payload.requestedDeliveryAt,
            lineSku: outbound.payload.lines.map((line) => line.sku).join(', '),
            lineQuantity: outbound.payload.lines.reduce((total, line) => total + line.quantity, 0),
            lineUnitOfMeasure: outbound.payload.lines[0]?.unitOfMeasure ?? null,
          }),
          ...statusColumn(context, 'CONFIRMED'),
        });

      case 'PURCHASE_ORDER_UPDATE':
        return updateItem(context, outbound.payload.orderNumber, statusColumn(context, outbound.payload.status));

      case 'SHIPMENT_STATUS':
        return updateItem(context, outbound.payload.orderNumber, {
          ...columnValuesFor(context, 'ORDER', {
            trackingNumber: outbound.payload.trackingNumber,
          }),
          ...statusColumn(context, outbound.payload.status),
        });

      case 'GOODS_RECEIPT':
        return updateItem(context, outbound.payload.orderNumber, statusColumn(context, 'DELIVERED'));

      case 'INVOICE_SYNC':
        return updateItem(
          context,
          outbound.payload.orderNumber ?? outbound.payload.invoiceNumber,
          columnValuesFor(context, 'INVOICE', {
            invoiceNumber: outbound.payload.invoiceNumber,
            grossAmount: outbound.payload.grossAmountMinor,
            currency: outbound.payload.currency,
            dueDate: outbound.payload.dueAt,
            documentUrl: outbound.payload.documentUrl,
          }),
        );

      case 'PAYMENT_REFERENCE':
        return updateItem(
          context,
          outbound.payload.orderNumber,
          columnValuesFor(context, 'PAYMENT', {
            paymentReference: outbound.payload.reference,
            paymentStatus: outbound.payload.status,
            paidAmount: outbound.payload.paidAmountMinor,
            currency: outbound.payload.currency,
          }),
        );
    }
  },

  async readInventory(context: ConnectorContext, cursor: string | null): Promise<InboundPage> {
    const response = await graphql(context, {
      query: `query Stock($boardIds: [ID!], $cursor: String, $limit: Int!) {
        boards(ids: $boardIds) {
          items_page(limit: $limit, cursor: $cursor) {
            cursor
            items { id name column_values { id text value } }
          }
        }
      }`,
      variables: {
        boardIds: context.monday.boardId === null ? [] : [context.monday.boardId],
        cursor,
        limit: Math.min(100, env.CUSTOMER_ERP_MAX_SYNC_RECORDS),
      },
    });

    const page = readPath(response.data, 'data.boards.0.items_page');
    const items = (readPath(page, 'items') ?? []) as unknown[];

    return {
      records: (Array.isArray(items) ? items : []).map((item) => toInventoryRecord(context, item)),
      // monday hands back a cursor that is null on the last page, which is
      // exactly the contract the pipeline wants and needs no translation.
      nextCursor: asText(readPath(page, 'cursor')),
      httpStatus: response.status,
      durationMs: response.durationMs,
    };
  },

  // `context` is unused here and the signature keeps it: every connector reads
  // its own mappings to interpret a payload, and monday's status changes arrive
  // already carrying the label the buyer chose. Renaming the parameter would
  // make the three connectors' signatures differ for no reason.
  interpretWebhook(_context: ConnectorContext, payload: unknown): InboundEvent[] {
    const event = readPath(payload, 'event') ?? payload;
    const type = (asText(readPath(event, 'type')) ?? '').toLowerCase();

    // A status column changed. The buyer's board is where their warehouse marks
    // a delivery received, so this is how a goods receipt reaches us from a
    // monday-run purchasing desk.
    if (type === 'update_column_value' || type === 'change_column_value') {
      const label = asText(
        readPath(event, 'value.label.text') ?? readPath(event, 'value.value'),
      );

      if (label === null) return [];

      const itemName = asText(readPath(event, 'pulseName'));

      return [
        {
          kind: 'ORDER_STATUS',
          erpPurchaseOrderId: asText(readPath(event, 'pulseId')) ?? itemName,
          erpStatus: label,
        },
      ];
    }

    if (type === 'create_pulse' || type === 'create_item') {
      // A row somebody created by hand. There is nothing here for this platform
      // to do about it, and pretending otherwise would mean inventing an order.
      return [];
    }

    return [];
  },
};

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

interface GraphqlDocument {
  query: string;
  variables?: Record<string, unknown>;
}

/**
 * POST one GraphQL document, and treat a GraphQL error as a failure.
 *
 * That last part is the whole reason this wrapper exists. GraphQL answers
 * almost everything with HTTP 200, including "that board does not exist" and
 * "your token has no permission for this" - so a connector that only looked at
 * the status code would report every failure as a success and write a null
 * reference into the ledger.
 */
async function graphql(
  context: ConnectorContext,
  document: GraphqlDocument,
): Promise<{ data: unknown; status: number; durationMs: number }> {
  const endpoint = context.endpoints.get('PURCHASE_ORDER_CREATE');
  const path = endpoint?.path ?? MONDAY_API_PATH;
  const url = resolveEndpointUrl(context.call.baseUrl, path);

  const response = await callErp<Record<string, unknown>>(context.call, {
    url,
    method: 'POST',
    body: document,
    accessToken: context.accessToken,
    extraHeaders: { 'API-Version': MONDAY_API_VERSION },
  });

  const errors = readPath(response.data, 'errors');

  if (Array.isArray(errors) && errors.length > 0) {
    const first = asText(readPath(errors[0], 'message')) ?? 'monday.com refused the request.';

    // monday reports a missing permission as an ordinary error, and the remedy
    // - reauthorise with wider scopes - is completely different from the remedy
    // for a bad mapping. Classified apart so the buyer is told the right one.
    const isPermission = /permission|unauthor|not allowed|scope/i.test(first);

    throw new ErpCallError(
      isPermission
        ? 'monday.com refused this because the authorisation does not cover it. Reconnect ' +
          'the account and accept the permissions listed.'
        : `monday.com rejected the request: ${first.slice(0, 200)}`,
      isPermission ? 'AUTH' : 'REJECTED',
      response.status,
    );
  }

  return { data: response.data, status: response.status, durationMs: response.durationMs };
}

/**
 * Create the item, or find the one already there.
 *
 * monday has no idempotency header, so the guard is a search by name before the
 * create. The item's name is the platform order number, which is unique here
 * and therefore unique on their board - so a retry that reaches this point
 * after a create that in fact succeeded finds the existing item and reports it
 * rather than making a second row.
 */
async function createItem(
  context: ConnectorContext,
  itemName: string,
  columnValues: Record<string, unknown>,
): Promise<OutboundResult> {
  const existing = await findItemByName(context, itemName);

  if (existing !== null) {
    return {
      erpReference: existing,
      httpStatus: 200,
      durationMs: 0,
      request: { itemName },
      response: { itemId: existing, note: 'already present' },
      alreadyPresent: true,
    };
  }

  const document: GraphqlDocument = {
    query: `mutation Create($boardId: ID!, $groupId: String, $itemName: String!, $columnValues: JSON) {
      create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues) {
        id
      }
    }`,
    variables: {
      boardId: context.monday.boardId,
      groupId: context.monday.groupId,
      itemName,
      // monday takes column values as a JSON STRING, not as an object. Sending
      // an object gets a "String cannot represent value" back, which reads like
      // a mapping problem and is not.
      columnValues: JSON.stringify(columnValues),
    },
  };

  const response = await graphql(context, document);

  return {
    erpReference: asText(readPath(response.data, 'data.create_item.id')),
    httpStatus: response.status,
    durationMs: response.durationMs,
    request: redactForLedger(document.variables),
    response: redactForLedger(response.data),
    alreadyPresent: false,
  };
}

/**
 * Change columns on the item this order already has.
 *
 * An item that is not there is NOT created here. This is only ever reached for
 * an order whose purchase order was raised earlier, so a missing item means
 * somebody deleted the row - and inventing a replacement would hide that from
 * the person who did it.
 */
async function updateItem(
  context: ConnectorContext,
  itemName: string,
  columnValues: Record<string, unknown>,
): Promise<OutboundResult> {
  if (Object.keys(columnValues).length === 0) {
    return {
      erpReference: null,
      httpStatus: null,
      durationMs: 0,
      request: null,
      response: null,
      alreadyPresent: true,
    };
  }

  const itemId = await findItemByName(context, itemName);

  if (itemId === null) {
    throw new ErpCallError(
      `There is no item called "${itemName}" on your board any more, so there was nothing ` +
        'to update. It may have been deleted or moved to another board.',
      'REJECTED',
    );
  }

  const document: GraphqlDocument = {
    query: `mutation Update($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) {
        id
      }
    }`,
    variables: {
      boardId: context.monday.boardId,
      itemId,
      columnValues: JSON.stringify(columnValues),
    },
  };

  const response = await graphql(context, document);

  return {
    erpReference: itemId,
    httpStatus: response.status,
    durationMs: response.durationMs,
    request: redactForLedger(document.variables),
    response: redactForLedger(response.data),
    alreadyPresent: false,
  };
}

async function findItemByName(
  context: ConnectorContext,
  itemName: string,
): Promise<string | null> {
  const response = await graphql(context, {
    query: `query Find($boardId: ID!, $name: CompareValue!) {
      boards(ids: [$boardId]) {
        items_page(limit: 2, query_params: { rules: [{ column_id: "name", compare_value: $name }] }) {
          items { id name }
        }
      }
    }`,
    variables: { boardId: context.monday.boardId, name: [itemName] },
  });

  const items = readPath(response.data, 'data.boards.0.items_page.items');
  if (!Array.isArray(items)) return null;

  // Annotated back to `unknown`: `Array.isArray` narrows to `any[]`, and an
  // `any` here would flow straight into the item id we then write purchase
  // order columns against.
  const match = (items as unknown[]).find(
    (item: unknown) => asText(readPath(item, 'name')) === itemName,
  );

  return match === undefined ? null : asText(readPath(match, 'id'));
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/**
 * Turn platform values into monday column values.
 *
 * The mapping's `erpPath` is a column id, so the result is `{columnId: value}`
 * - which is monday's shape and needs no nesting. Anything the mapping does not
 * name is not sent, which is what lets a buyer map three columns and ignore the
 * other twenty on a board they use for other things too.
 */
function columnValuesFor(
  context: ConnectorContext,
  entity: 'ORDER' | 'INVOICE' | 'PAYMENT' | 'INVENTORY',
  values: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const row of context.mappings) {
    if (row.entity !== entity) continue;

    const columnId = row.erpPath.trim();
    // `name` is the item's title, set by `create_item` rather than as a column
    // value - monday rejects it in `column_values`.
    if (columnId.length === 0 || columnId === 'name') continue;

    const constant = (row.constantValue ?? '').trim();
    const raw = constant.length > 0 ? constant : values[row.platformField];

    if (raw === undefined || raw === null || raw === '') continue;

    result[columnId] = formatColumnValue(columnId, raw, row.transform, context.currencyExponent);
  }

  return result;
}

/**
 * The value in the shape monday's column type wants.
 *
 * Inferred from the column id's prefix, which is monday's own convention
 * (`date`, `numbers`, `status`, `text`) and is what the wizard shows the buyer.
 * Getting this wrong does not fail loudly: monday accepts a string into a date
 * column and stores nothing, so a purchase order appears with an empty delivery
 * date and nobody notices for a month.
 */
function formatColumnValue(
  columnId: string,
  value: unknown,
  transform: string | null,
  currencyExponent: number,
): unknown {
  const text =
    transform === 'MINOR_TO_DECIMAL' && typeof value === 'string'
      ? minorToDecimalLocal(value, currencyExponent)
      : String(value);

  if (columnId.startsWith('date')) {
    // monday's date column takes `{date: "YYYY-MM-DD"}` and, optionally, a
    // time. A bare string is silently dropped.
    return { date: text.slice(0, 10) };
  }

  if (columnId.startsWith('numbers')) return text;

  if (columnId.startsWith('status')) {
    // By label rather than by index. An index is a position in a list somebody
    // can reorder; a label is what they actually chose.
    return { label: text };
  }

  if (columnId.startsWith('link')) return { url: text, text };

  return text;
}

/** Local, so this file does not import the money helpers for one call. */
function minorToDecimalLocal(minor: string, exponent: number): string {
  if (exponent === 0) return minor;
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).replace(/\D/g, '') || '0';
  const padded = digits.padStart(exponent + 1, '0');

  return `${negative ? '-' : ''}${padded.slice(0, padded.length - exponent)}.${padded.slice(
    padded.length - exponent,
  )}`;
}

/** The status column, where the buyer mapped one for this platform status. */
function statusColumn(context: ConnectorContext, platformStatus: string): Record<string, unknown> {
  const label = statusToErp(context.mappings, platformStatus);
  if (label === null) return {};

  const row = context.mappings.find(
    (entry) =>
      (entry.entity === 'ORDER' || entry.entity === 'PAYMENT') &&
      entry.erpPath.trim().startsWith('status'),
  );

  const columnId = row?.erpPath.trim() ?? 'status';
  return { [columnId]: { label } };
}

/**
 * One monday item, in the shape a mapping can actually address.
 *
 * monday returns columns as a list of `{id, text, value}`, which is not a shape
 * a dotted path can reach into: there is no `text2` to find, only an entry
 * somewhere in an array whose `id` happens to be `text2`. Flattening turns the
 * list into the object the buyer's mapping is written against, so `text2` means
 * the column called `text2`.
 *
 * Shared by the inventory read and by `test()` on purpose. The mapping check is
 * only worth anything if it is run against the SAME shape the real sync will
 * produce - checking a mapping against one shape and then syncing from another
 * reports a mapping as sound and then finds nothing, or the reverse, which is
 * what it did here: every monday mapping came back "not found", the required
 * SKU with it, so the check could never pass and the connection could never be
 * switched on.
 */
function flattenItem(item: unknown): Record<string, unknown> {
  const flattened: Record<string, unknown> = { name: readPath(item, 'name') };

  const columns = readPath(item, 'column_values');
  if (Array.isArray(columns)) {
    for (const column of columns) {
      const id = asText(readPath(column, 'id'));
      if (id === null) continue;
      flattened[id] = readPath(column, 'text');
    }
  }

  return flattened;
}

function toInventoryRecord(
  context: ConnectorContext,
  item: unknown,
): InboundInventoryRecord {
  const flattened = flattenItem(item);

  const values = applyInbound(context.mappings, 'INVENTORY', flattened, {
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
    raw: redactForLedger(flattened),
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
