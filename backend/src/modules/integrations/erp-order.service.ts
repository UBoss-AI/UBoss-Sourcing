/**
 * Pushing an order to the ERP, and getting it there eventually.
 *
 * This module exists to handle one situation well: **the customer's money has
 * been taken and the ERP has not accepted the order.** Everything else here is
 * in service of that.
 *
 * It is the worst state in the whole feature. The charge is real and
 * irreversible from the customer's side, the platform order exists, and the
 * warehouse cannot see it. The wrong responses are all tempting:
 *
 *   - Failing the occurrence tells the customer their order did not happen,
 *     which is false, and invites them to order again - now paying twice.
 *   - Refunding immediately throws away an order the ERP would probably have
 *     taken thirty seconds later, and refunds are slow, visible and alarming.
 *   - Retrying without a stable key risks two ERP orders, which means two
 *     deliveries and two stock movements for one payment.
 *
 * So the occurrence holds at PAID_ERP_PENDING and this retries under the SAME
 * idempotency key until the ERP takes it or a person is asked to look. The key
 * is derived from the occurrence, not generated per attempt - see
 * `derivedIdempotencyKey`. Two guards make a duplicate structurally
 * impossible rather than merely unlikely:
 *
 *   1. `unique(erp_order_pushes.orderId)` - one push row per order, ever. A
 *      second attempt finds the existing row instead of creating one.
 *   2. The same `idempotencyKey` in the header on every attempt, so an ERP
 *      that honours it de-duplicates on its own side too.
 *
 * The ERP itself is not a named vendor here, and that is deliberate. This
 * software is bought and run by companies who already have an ERP, and it is
 * never the same one twice. So the connection is an `IntegrationConnection`
 * row an administrator creates - base URL, auth, encrypted credentials - and
 * the request shape is configuration rather than code. With nothing configured
 * the whole path is inert: orders are created, paid and fulfilled exactly as
 * they were before this module existed.
 */
import { env } from '../../config/env.js';
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import { decryptSecret } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { logger, loggerFor } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';

/** AAD binds a credential ciphertext to the row it belongs to. */
function credentialAad(connectionId: string): string {
  return `integration_connection:${connectionId}`;
}

/** Hard ceiling on an ERP response body. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Retry backoff for a paid-but-unpushed order, in minutes.
 *
 * Front-loaded then widening. The first two retries are quick because most ERP
 * failures are a restart or a brief network fault and the warehouse wants the
 * order now; the later ones stretch out because an ERP that has refused four
 * times needs a person, not more traffic.
 */
const RETRY_BACKOFF_MINUTES = [1, 5, 15, 60, 180, 360, 720] as const;

function retryDelayMinutes(attemptCount: number): number {
  return RETRY_BACKOFF_MINUTES[Math.min(attemptCount, RETRY_BACKOFF_MINUTES.length) - 1] ?? 720;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ErpConnection {
  id: string;
  name: string;
  baseUrl: string;
  authType: string;
  credentials: Record<string, string> | null;
  timeoutMs: number;
  circuitState: string;
  circuitOpenedAt: Date | null;
  consecutiveFailures: number;
}

/**
 * The connection orders are pushed to, or null when none is configured.
 *
 * Null is a supported, ordinary state and every caller has to handle it. A
 * deployment with no ERP is not a broken deployment.
 */
export async function loadErpConnection(): Promise<ErpConnection | null> {
  const name = env.ERP_ORDER_CONNECTION_NAME.trim();
  if (name.length === 0) return null;

  const row = await prisma.integrationConnection.findFirst({
    where: { name, isActive: true },
  });

  if (row === null) {
    // Configured but absent or switched off. Logged loudly: the deployment
    // asked for ERP integration and is not getting it, and silence here would
    // mean nobody finding out until a warehouse asked where the orders were.
    logger.error(
      { connectionName: name },
      'ERP_ORDER_CONNECTION_NAME names a connection that is missing or inactive; orders will not reach the ERP',
    );
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    authType: row.authType,
    credentials:
      row.credentialsEnc === null
        ? null
        : (JSON.parse(decryptSecret(row.credentialsEnc, credentialAad(row.id))) as Record<
            string,
            string
          >),
    timeoutMs: row.timeoutMs,
    circuitState: row.circuitState,
    circuitOpenedAt: row.circuitOpenedAt,
    consecutiveFailures: row.consecutiveFailures,
  };
}

export function isErpConfigured(): boolean {
  return env.ERP_ORDER_CONNECTION_NAME.trim().length > 0;
}

function authHeaders(connection: ErpConnection): Record<string, string> {
  const credentials = connection.credentials;
  if (credentials === null) return {};

  switch (connection.authType) {
    case 'API_KEY_HEADER':
      return { [credentials['headerName'] ?? 'X-API-Key']: credentials['token'] ?? '' };
    case 'BEARER_TOKEN':
      return { Authorization: `Bearer ${credentials['token'] ?? ''}` };
    case 'BASIC':
      return {
        Authorization: `Basic ${Buffer.from(
          `${credentials['username'] ?? ''}:${credentials['password'] ?? ''}`,
          'utf8',
        ).toString('base64')}`,
      };
    default:
      return {};
  }
}

/** Follow a dotted path through a JSON response, e.g. `data.order.id`. */
function readPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, source);
}

// ---------------------------------------------------------------------------
// Stock verification, before any money moves
// ---------------------------------------------------------------------------

export interface ErpStockLine {
  sku: string;
  quantity: number;
}

export interface ErpStockResult {
  /** True when every line is available, or when no ERP is configured. */
  ok: boolean;
  /** Lines the ERP could not supply. Empty when ok. */
  shortages: { sku: string; requested: number; available: number | null }[];
  /** True when the ERP could not be asked at all. */
  unavailable: boolean;
  message: string | null;
}

/**
 * Ask the ERP whether it can supply these lines, BEFORE charging.
 *
 * The order of operations that makes this worth doing: verify stock, then
 * charge, then push. Charging first and discovering the shortage afterwards
 * leaves a refund to explain, and refunds for something the customer never
 * received are the complaints that damage a supplier relationship.
 *
 * A deployment with no ERP gets `ok: true` and moves on to the platform's own
 * inventory check, which is unchanged.
 *
 * Being unable to REACH the ERP is reported separately from being told "no
 * stock", because they call for different behaviour: a shortage is a real
 * answer and the occurrence should hold and tell the customer, while an
 * unreachable ERP is our problem and the occurrence should retry quietly
 * rather than telling a customer their product is out of stock when nobody
 * actually knows.
 */
export async function verifyErpStock(
  lines: ErpStockLine[],
  correlationId?: string,
): Promise<ErpStockResult> {
  const noop: ErpStockResult = { ok: true, shortages: [], unavailable: false, message: null };

  if (!env.ERP_VERIFY_STOCK_BEFORE_CHARGE) return noop;

  const connection = await loadErpConnection();
  if (connection === null) return noop;

  const stockPath = env.ERP_STOCK_PATH.trim();
  if (stockPath.length === 0) return noop;

  const log = loggerFor(correlationId ?? newId(), { connectionId: connection.id });

  try {
    const response = await erpRequest<{
      lines?: { sku?: string; available?: number }[];
      data?: { sku?: string; available?: number }[];
    }>(connection, stockPath, 'POST', {
      lines: lines.map((line) => ({ sku: line.sku, quantity: line.quantity })),
    });

    const reported = response.lines ?? response.data ?? null;

    if (reported === null) {
      // A 200 with a body this code cannot read is not a stock confirmation.
      // Treated as unreachable rather than as "in stock": assuming supply
      // because the response was unparseable is how somebody gets charged for
      // a product that is not there.
      log.warn('the ERP stock response could not be interpreted; treating it as unavailable');
      return {
        ok: false,
        shortages: [],
        unavailable: true,
        message: 'The ERP returned a stock response this system could not read.',
      };
    }

    const availableBySku = new Map<string, number>();
    for (const entry of reported) {
      if (typeof entry.sku === 'string' && typeof entry.available === 'number') {
        availableBySku.set(entry.sku, entry.available);
      }
    }

    const shortages = lines
      .map((line) => ({
        sku: line.sku,
        requested: line.quantity,
        available: availableBySku.get(line.sku) ?? null,
      }))
      // A SKU the ERP did not mention is a shortage, not a pass. Silence is
      // not confirmation.
      .filter((line) => line.available === null || line.available < line.requested);

    if (shortages.length > 0) {
      return {
        ok: false,
        shortages,
        unavailable: false,
        message: `The ERP cannot supply ${String(shortages.length)} of the items on this order.`,
      };
    }

    return noop;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    log.error({ err: error }, 'could not verify stock with the ERP');

    return {
      ok: false,
      shortages: [],
      unavailable: true,
      message: `The ERP could not be reached to confirm stock: ${message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// The push
// ---------------------------------------------------------------------------

/** One HTTP call to the ERP, with a bounded timeout and a size ceiling. */
async function erpRequest<T>(
  connection: ErpConnection,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), connection.timeoutMs);

  // A base URL with a trailing slash and a path with a leading one would
  // otherwise produce a double slash, which some gateways 404 on.
  const url = `${connection.baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...authHeaders(connection),
        ...(idempotencyKey !== undefined
          ? { [env.ERP_IDEMPOTENCY_HEADER]: idempotencyKey }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });

    const text = await response.text();

    if (text.length > MAX_RESPONSE_BYTES) {
      throw new Error(`ERP response exceeded ${String(MAX_RESPONSE_BYTES)} bytes`);
    }

    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      // 409 is treated as success by the caller, not here: an ERP that honours
      // the idempotency header answers a replay with 409 and the reference of
      // the order it already made. The status is carried on the error so the
      // caller can tell that case apart.
      const error = new ErpRequestError(
        `The ERP returned HTTP ${String(response.status)}`,
        response.status,
        parsed,
      );
      throw error;
    }

    return parsed as T;
  } catch (error) {
    if (error instanceof ErpRequestError) throw error;

    const isAbort = error instanceof Error && error.name === 'AbortError';
    throw new ErpRequestError(
      isAbort
        ? 'The ERP did not respond in time.'
        : `Could not reach the ERP: ${error instanceof Error ? error.message : 'unknown error'}`,
      null,
      null,
    );
  } finally {
    clearTimeout(timer);
  }
}

export class ErpRequestError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ErpRequestError';
  }

  /**
   * Is retrying worth doing?
   *
   * A 4xx other than 409 or 429 means the ERP understood the request and
   * refused it; sending it again unchanged gets the same answer. A 5xx, a
   * timeout or a 429 is worth another go.
   */
  get retryable(): boolean {
    if (this.httpStatus === null) return true;
    if (this.httpStatus === 429) return true;
    return this.httpStatus >= 500;
  }
}

export interface PushOrderResult {
  status: 'SUCCEEDED' | 'DEFERRED' | 'ABANDONED' | 'SKIPPED';
  erpOrderReference: string | null;
  /** Set when the push did not succeed. */
  message: string | null;
  /** True when the row already carried a reference before this call. */
  alreadyPushed: boolean;
}

/**
 * Build the payload the ERP is sent.
 *
 * Deliberately flat and boring. Every field is something an ERP is likely to
 * want, and the shape is documented in PROJECT-GUIDE.md so a deployment can
 * put a small translating proxy in front of its own ERP rather than needing
 * this file changed. That is the trade: one shape here, adapted per
 * installation there, instead of a field-mapping language in this repository
 * that would still not fit the next ERP.
 */
async function buildPayload(orderId: string): Promise<Record<string, unknown>> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      customerProfile: {
        select: {
          id: true,
          fullName: true,
          organization: true,
          customerCode: true,
          user: { select: { email: true } },
        },
      },
      occurrence: { select: { id: true, scheduleId: true, plannedRunAt: true } },
    },
  });

  if (order === null) throw notFound('Order');

  return {
    // Our reference, so the ERP can be reconciled against this system.
    external_order_id: order.id,
    order_number: order.orderNumber,
    placed_at: order.placedAt?.toISOString() ?? order.createdAt.toISOString(),
    source: order.source,
    currency: order.currency,

    // Money as strings, never numbers. A JSON number is a double, and putting
    // a total through one is how a rounding error reaches an invoice. The same
    // rule the HTTP API follows.
    totals: {
      subtotal_minor: order.subtotalMinor.toString(),
      discount_minor: order.discountMinor.toString(),
      tax_minor: order.taxMinor.toString(),
      shipping_minor: order.shippingMinor.toString(),
      grand_total_minor: order.grandTotalMinor.toString(),
    },

    customer: {
      external_customer_id: order.customerProfile.id,
      // The ERP's own code for this customer, when somebody has recorded one.
      // Most ERPs match on this rather than on a name.
      erp_customer_code: order.customerProfile.customerCode,
      name: order.customerProfile.fullName,
      company: order.customerProfile.organization,
      email: order.customerProfile.user.email,
    },

    shipping_address: order.shippingAddressJson,
    billing_address: order.billingAddressJson,
    shipping_method: order.shippingMethodCode,

    lines: order.items.map((item) => ({
      sku: item.skuSnapshot,
      name: item.nameSnapshot,
      variant: item.variantNameSnapshot,
      quantity: item.quantity,
      unit_price_minor: item.unitPriceMinor.toString(),
      tax_amount_minor: item.taxAmountMinor.toString(),
      line_total_minor: item.lineTotalMinor.toString(),
    })),

    // Present only on a scheduled order, so an ERP can group a subscription's
    // deliveries if it wants to.
    schedule:
      order.occurrence === null
        ? null
        : {
            schedule_id: order.occurrence.scheduleId,
            occurrence_id: order.occurrence.id,
            due_at: order.occurrence.plannedRunAt.toISOString(),
          },
  };
}

/**
 * Push an order to the ERP, or record why it could not go.
 *
 * Safe to call repeatedly. The first call creates the ledger row; every later
 * one finds it, and a row that already has a reference returns immediately
 * without touching the network.
 *
 * Never throws for an ERP failure - it returns a status. The caller is usually
 * a worker holding a paid occurrence, and an exception there would be caught
 * and turned into "this occurrence failed", which is exactly the wrong thing
 * to tell a customer whose money has gone.
 *
 * **Two connectors can be on the other end of this, and the configured one
 * comes first.** An installation with an active connection under Settings ->
 * ERP sends every order there; one without falls through to the connector wired
 * through `ERP_ORDER_*` environment variables, exactly as before this feature
 * existed. The configured connection wins because it is the one somebody set up
 * deliberately, on a screen, having tested it - while the environment connector
 * is whatever the deployment was started with.
 *
 * Never both. `erp_order_pushes.orderId` is unique, so whichever path claims
 * the row owns the hand-off; the other would find it already there.
 */
export async function pushOrderToErp(input: {
  orderId: string;
  occurrenceId?: string | null;
  idempotencyKey: string;
  correlationId?: string | null;
}): Promise<PushOrderResult> {
  const log = loggerFor(input.correlationId ?? newId(), {
    orderId: input.orderId,
    occurrenceId: input.occurrenceId ?? undefined,
  });

  // --- The connection configured under Settings -> ERP -------------------
  //
  // Imported lazily to keep the module graph acyclic: the push service reads
  // connection state from a module that imports this one.
  {
    const { pushOrderToErpConnection, resolveErpConnection } = await import(
      './erp-push.service.js'
    );

    if ((await resolveErpConnection()) !== null) {
      const result = await pushOrderToErpConnection({
        orderId: input.orderId,
        occurrenceId: input.occurrenceId ?? null,
        // The SAME key the caller derived from the order. Not regenerated here,
        // because a retry has to send the value the first attempt sent.
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId ?? null,
      });

      // SKIPPED means the connection turned out not to be usable for orders
      // after all - order sending switched off, or no creation endpoint. Fall
      // through to the legacy connector rather than silently dropping the order.
      if (result.status !== 'SKIPPED') return result;
    }
  }

  const connection = await loadErpConnection();

  if (connection === null) {
    // No ERP in this deployment. Not a failure, and no ledger row: recording a
    // push that was never meant to happen would leave every order looking
    // half-finished for ever.
    return { status: 'SKIPPED', erpOrderReference: null, message: null, alreadyPushed: false };
  }

  // --- The ledger row. Unique on orderId, which is the duplicate guard. ---
  const pushId = newId();

  await prisma.erpOrderPush.createMany({
    data: [
      {
        id: pushId,
        orderId: input.orderId,
        occurrenceId: input.occurrenceId ?? null,
        connectionId: connection.id,
        idempotencyKey: input.idempotencyKey,
        status: 'PENDING',
      },
    ],
    skipDuplicates: true,
  });

  const push = await prisma.erpOrderPush.findUnique({ where: { orderId: input.orderId } });

  if (push === null) {
    // Cannot happen: the insert above either created it or collided with an
    // existing one. Reported rather than assumed away.
    log.error('the ERP push ledger row vanished immediately after being written');
    return {
      status: 'DEFERRED',
      erpOrderReference: null,
      message: 'The ERP push record could not be read back.',
      alreadyPushed: false,
    };
  }

  // Already done. The single most important early return in this file: it is
  // what makes a redelivered webhook or a re-run job harmless.
  if (push.status === 'SUCCEEDED') {
    log.info({ erpOrderReference: push.erpOrderReference }, 'order already reached the ERP');
    return {
      status: 'SUCCEEDED',
      erpOrderReference: push.erpOrderReference,
      message: null,
      alreadyPushed: true,
    };
  }

  if (push.status === 'ABANDONED') {
    return {
      status: 'ABANDONED',
      erpOrderReference: null,
      message: push.lastErrorMessage,
      alreadyPushed: false,
    };
  }

  // --- Circuit breaker ---------------------------------------------------
  //
  // Read but not enforced as an exception here. A paid order must still be
  // *recorded* as awaiting the ERP even while the breaker is open; it simply
  // is not sent yet.
  if (connection.circuitState === 'OPEN') {
    const openedAt = connection.circuitOpenedAt?.getTime() ?? 0;
    if (Date.now() - openedAt < 300_000) {
      return deferPush(push.id, push.attemptCount, 'The ERP connector is temporarily disabled after repeated failures.', log);
    }
  }

  const payload = await buildPayload(input.orderId);

  const attemptNumber = push.attemptCount + 1;

  try {
    const response = await erpRequest<Record<string, unknown>>(
      connection,
      env.ERP_ORDER_PATH,
      'POST',
      payload,
      // The same key on every attempt. This is the point.
      input.idempotencyKey,
    );

    const reference = readPath(response, env.ERP_ORDER_REFERENCE_PATH);
    const erpOrderReference =
      typeof reference === 'string'
        ? reference
        : typeof reference === 'number'
          ? String(reference)
          : null;

    await prisma.$transaction(async (tx) => {
      await tx.erpOrderPush.update({
        where: { id: push.id },
        data: {
          status: 'SUCCEEDED',
          erpOrderReference,
          attemptCount: attemptNumber,
          lastAttemptAt: new Date(),
          nextRetryAt: null,
          succeededAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
          requestJson: payload as never,
          responseJson: response as never,
        },
      });

      if (input.occurrenceId !== null && input.occurrenceId !== undefined) {
        await tx.scheduleOccurrence.update({
          where: { id: input.occurrenceId },
          data: { erpOrderReference, erpPushStatus: 'SUCCEEDED' },
        });
      }

      await recordAudit(
        {
          action: AuditAction.ERP_ORDER_PUSHED,
          resourceType: 'order',
          resourceId: input.orderId,
          actorType: 'SYSTEM',
          after: { erpOrderReference, attempt: attemptNumber, connection: connection.name },
          correlationId: input.correlationId ?? null,
        },
        tx,
      );
    });

    await prisma.integrationConnection.update({
      where: { id: connection.id },
      data: {
        circuitState: 'CLOSED',
        consecutiveFailures: 0,
        circuitOpenedAt: null,
        lastSuccessAt: new Date(),
      },
    });

    log.info({ erpOrderReference, attempt: attemptNumber }, 'order pushed to the ERP');

    return { status: 'SUCCEEDED', erpOrderReference, message: null, alreadyPushed: false };
  } catch (error) {
    const isErpError = error instanceof ErpRequestError;
    const status = isErpError ? error.httpStatus : null;

    // A 409 from an ERP that honours the idempotency header means "I already
    // have this order". That is success, not a conflict - and treating it as a
    // failure would retry for hours against an ERP that took the order on the
    // first attempt.
    if (isErpError && status === 409) {
      const reference = readPath(error.body, env.ERP_ORDER_REFERENCE_PATH);
      const erpOrderReference = typeof reference === 'string' ? reference : null;

      log.info(
        { erpOrderReference },
        'the ERP reports it already has this order; treating the push as complete',
      );

      await prisma.$transaction(async (tx) => {
        await tx.erpOrderPush.update({
          where: { id: push.id },
          data: {
            status: 'SUCCEEDED',
            erpOrderReference,
            attemptCount: attemptNumber,
            lastAttemptAt: new Date(),
            nextRetryAt: null,
            succeededAt: new Date(),
            responseJson: (error.body ?? null) as never,
          },
        });

        if (input.occurrenceId !== null && input.occurrenceId !== undefined) {
          await tx.scheduleOccurrence.update({
            where: { id: input.occurrenceId },
            data: { erpOrderReference, erpPushStatus: 'SUCCEEDED' },
          });
        }
      });

      return { status: 'SUCCEEDED', erpOrderReference, message: null, alreadyPushed: true };
    }

    const message = error instanceof Error ? error.message : 'unknown ERP error';

    await prisma.integrationConnection
      .update({
        where: { id: connection.id },
        data: {
          consecutiveFailures: connection.consecutiveFailures + 1,
          ...(connection.consecutiveFailures + 1 >= 5
            ? { circuitState: 'OPEN', circuitOpenedAt: new Date() }
            : {}),
        },
      })
      .catch(() => undefined);

    const permanent = isErpError && !error.retryable;
    const exhausted = attemptNumber >= env.ERP_ORDER_MAX_ATTEMPTS;

    if (permanent || exhausted) {
      // Out of attempts, or refused for a reason that will not change. A
      // person has to look. The order is still paid and still real.
      await prisma.$transaction(async (tx) => {
        await tx.erpOrderPush.update({
          where: { id: push.id },
          data: {
            status: 'ABANDONED',
            attemptCount: attemptNumber,
            lastAttemptAt: new Date(),
            nextRetryAt: null,
            lastErrorCode: status === null ? 'UNREACHABLE' : `HTTP_${String(status)}`,
            lastErrorMessage: message.slice(0, 1000),
            requestJson: payload as never,
            responseJson: (isErpError ? error.body : null) as never,
          },
        });

        if (input.occurrenceId !== null && input.occurrenceId !== undefined) {
          await tx.scheduleOccurrence.update({
            where: { id: input.occurrenceId },
            data: { erpPushStatus: 'ABANDONED' },
          });
        }

        await recordAudit(
          {
            action: AuditAction.ERP_ORDER_PUSH_ABANDONED,
            resourceType: 'order',
            resourceId: input.orderId,
            actorType: 'SYSTEM',
            after: {
              attempts: attemptNumber,
              reason: permanent ? 'refused' : 'attempts exhausted',
              message: message.slice(0, 500),
            },
            correlationId: input.correlationId ?? null,
          },
          tx,
        );
      });

      log.error(
        { attempt: attemptNumber, permanent, httpStatus: status },
        'giving up on the ERP push; this order needs a person',
      );

      return { status: 'ABANDONED', erpOrderReference: null, message, alreadyPushed: false };
    }

    return deferPush(push.id, push.attemptCount, message, log, {
      orderId: input.orderId,
      occurrenceId: input.occurrenceId ?? null,
      errorCode: status === null ? 'UNREACHABLE' : `HTTP_${String(status)}`,
      correlationId: input.correlationId ?? null,
      payload,
    });
  }
}

/** Record a failed attempt and schedule the next one. */
async function deferPush(
  pushId: string,
  previousAttempts: number,
  message: string,
  log: ReturnType<typeof loggerFor>,
  context?: {
    orderId: string;
    occurrenceId: string | null;
    errorCode: string;
    correlationId: string | null;
    payload: Record<string, unknown>;
  },
): Promise<PushOrderResult> {
  const attemptNumber = previousAttempts + 1;
  const delayMinutes = retryDelayMinutes(attemptNumber);
  const nextRetryAt = new Date(Date.now() + delayMinutes * 60_000);

  await prisma.erpOrderPush.update({
    where: { id: pushId },
    data: {
      status: 'FAILED',
      attemptCount: attemptNumber,
      lastAttemptAt: new Date(),
      nextRetryAt,
      lastErrorCode: context?.errorCode ?? 'CIRCUIT_OPEN',
      lastErrorMessage: message.slice(0, 1000),
      ...(context === undefined ? {} : { requestJson: context.payload as never }),
    },
  });

  if (context !== undefined) {
    if (context.occurrenceId !== null) {
      await prisma.scheduleOccurrence.update({
        where: { id: context.occurrenceId },
        data: { erpPushStatus: 'FAILED' },
      });
    }

    await recordAudit({
      action: AuditAction.ERP_ORDER_PUSH_DEFERRED,
      resourceType: 'order',
      resourceId: context.orderId,
      actorType: 'SYSTEM',
      after: {
        attempt: attemptNumber,
        nextRetryAt: nextRetryAt.toISOString(),
        message: message.slice(0, 500),
      },
      correlationId: context.correlationId,
    });
  }

  log.warn(
    { attempt: attemptNumber, nextRetryAt: nextRetryAt.toISOString() },
    'ERP push deferred; the order is paid and will be retried',
  );

  return { status: 'DEFERRED', erpOrderReference: null, message, alreadyPushed: false };
}

// ---------------------------------------------------------------------------
// Inventory reconciliation after a successful push
// ---------------------------------------------------------------------------

/**
 * Record that the ERP now owns this order's stock movement.
 *
 * Only ever called after a SUCCEEDED push, and keyed so it cannot post twice.
 * The `dedupeKey` on `inventory_movements` is what makes that structural: a
 * retried reconciliation collides on the unique index rather than posting a
 * second delta, which would silently corrupt on-hand in a ledger that has no
 * reversal.
 *
 * This does NOT decrement stock. The platform's own reservation commit has
 * already done that at order creation; this writes the SYNC_CORRECTION rows
 * that record the ERP agreeing, so the two ledgers can be reconciled later.
 */
export async function reconcileErpInventory(input: {
  orderId: string;
  idempotencyKey: string;
}): Promise<{ recorded: number }> {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: { items: { select: { productId: true, variantId: true, quantity: true } } },
  });

  if (order === null) return { recorded: 0 };

  const reservations = await prisma.stockReservation.findMany({
    where: { orderId: input.orderId, status: 'COMMITTED' },
    select: { productId: true, variantId: true, variantKey: true, locationId: true, quantity: true },
  });

  if (reservations.length === 0) return { recorded: 0 };

  let recorded = 0;

  for (const reservation of reservations) {
    const balance = await prisma.inventoryBalance.findFirst({
      where: {
        productId: reservation.productId,
        variantKey: reservation.variantKey,
        locationId: reservation.locationId,
      },
      select: { onHandQty: true },
    });

    // Keyed per line, so a partial failure re-posts only what is missing.
    const dedupeKey = `${input.idempotencyKey}:${reservation.productId}:${reservation.variantKey}:${reservation.locationId}`;

    const written = await prisma.inventoryMovement.createMany({
      data: [
        {
          id: newId(),
          productId: reservation.productId,
          variantId: reservation.variantId,
          variantKey: reservation.variantKey,
          locationId: reservation.locationId,
          type: 'SYNC_CORRECTION',
          // Zero is not allowed by the column's own contract, and there is
          // nothing to correct: the commit already moved the stock. This row
          // exists to record the ERP's acknowledgement, so the delta is the
          // quantity restated rather than a change.
          quantityDelta: reservation.quantity,
          resultingOnHand: balance?.onHandQty ?? 0,
          reason: 'ERP acknowledged the order',
          referenceType: 'erp_order_push',
          referenceId: input.orderId,
          dedupeKey,
          actorType: 'SYSTEM',
        },
      ],
      skipDuplicates: true,
    });

    recorded += written.count;
  }

  return { recorded };
}

// ---------------------------------------------------------------------------
// The retry sweep
// ---------------------------------------------------------------------------

/**
 * Retry every ERP push that is due.
 *
 * Run from the worker's maintenance beat. Each row carries its own
 * `nextRetryAt`, so this is one indexed query when nothing is waiting.
 */
export async function retryDueErpPushes(limit = 25): Promise<{
  attempted: number;
  succeeded: number;
}> {
  if (!isErpConfigured()) return { attempted: 0, succeeded: 0 };

  const due = await prisma.erpOrderPush.findMany({
    where: { status: { in: ['PENDING', 'FAILED'] }, nextRetryAt: { lte: new Date() } },
    orderBy: { nextRetryAt: 'asc' },
    take: limit,
    select: { id: true, orderId: true, occurrenceId: true, idempotencyKey: true },
  });

  let succeeded = 0;

  for (const row of due) {
    const result = await pushOrderToErp({
      orderId: row.orderId,
      occurrenceId: row.occurrenceId,
      idempotencyKey: row.idempotencyKey,
    });

    if (result.status === 'SUCCEEDED') {
      succeeded += 1;

      // The occurrence has been waiting on exactly this. Completing it here
      // rather than leaving it to the next sweep is what turns a
      // PAID_ERP_PENDING back into a finished order for the customer.
      if (row.occurrenceId !== null) {
        const { completeOccurrenceAfterErp } = await import(
          '../recurring/occurrence.service.js'
        );
        await completeOccurrenceAfterErp(row.occurrenceId, result.erpOrderReference);
      }
    }
  }

  return { attempted: due.length, succeeded };
}

/** Orders whose ERP push has been abandoned, for the console to show. */
export async function listAbandonedErpPushes(limit = 50): Promise<
  {
    orderId: string;
    orderNumber: string;
    occurrenceId: string | null;
    attemptCount: number;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    lastAttemptAt: string | null;
  }[]
> {
  const rows = await prisma.erpOrderPush.findMany({
    where: { status: 'ABANDONED' },
    orderBy: { lastAttemptAt: 'desc' },
    take: limit,
    include: { order: { select: { orderNumber: true } } },
  });

  return rows.map((row) => ({
    orderId: row.orderId,
    orderNumber: row.order.orderNumber,
    occurrenceId: row.occurrenceId,
    attemptCount: row.attemptCount,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
  }));
}

/**
 * Push an order again by hand, after somebody has fixed whatever was wrong.
 *
 * The only way out of ABANDONED, and deliberately manual: an ERP that has
 * refused the same payload eight times will refuse the ninth, so resuming
 * should follow a change rather than a timer.
 */
export async function retryAbandonedErpPush(
  orderId: string,
  actor: { userId: string; email: string },
): Promise<PushOrderResult> {
  const push = await prisma.erpOrderPush.findUnique({ where: { orderId } });
  if (push === null) throw notFound('ERP push');

  if (push.status === 'SUCCEEDED') {
    throw conflict(
      ErrorCode.CONFLICT,
      'This order has already reached the ERP.',
      [{ code: 'ALREADY_PUSHED', meta: { erpOrderReference: push.erpOrderReference } }],
    );
  }

  // Attempts are reset, but the idempotency key is NOT regenerated. A manual
  // retry must still be the same request as the automatic ones, or the ERP
  // could accept it as a second order.
  await prisma.erpOrderPush.update({
    where: { id: push.id },
    data: { status: 'PENDING', attemptCount: 0, nextRetryAt: null },
  });

  await recordAudit({
    action: AuditAction.ERP_ORDER_PUSH_DEFERRED,
    resourceType: 'order',
    resourceId: orderId,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    after: { manualRetry: true, previousAttempts: push.attemptCount },
  });

  return pushOrderToErp({
    orderId,
    occurrenceId: push.occurrenceId,
    idempotencyKey: push.idempotencyKey,
  });
}
