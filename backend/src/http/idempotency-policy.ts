/**
 * Which state-changing routes need an Idempotency-Key - declared once, here.
 *
 * Every POST, PUT, PATCH and DELETE the API registers resolves to exactly one
 * declaration below. `tests/unit/idempotency-policy.test.ts` walks the real
 * route table and fails when a route resolves to none, so a new route cannot
 * ship without somebody deciding - in this file - whether a repeat of it would
 * do harm.
 *
 * THREE ANSWERS
 *
 *   REQUIRED  A repeat would move money, issue a document or create a second
 *             order, shipment or claim. The key is enforced by the central
 *             hook in `route-table.ts` (missing -> 400 IDEMPOTENCY_KEY_REQUIRED)
 *             before the handler runs. Replay is either done by the route's own
 *             service (`handledBy: 'service'`, through `runIdempotent`) or by
 *             the central hook itself (`handledBy: 'central'`), which stores the
 *             first successful response and plays it back for the same key.
 *
 *   OPTIONAL  The key is honoured when sent - a driver's phone on a bad line -
 *             and the route is safe without it.
 *
 *   NOT_NEEDED  A repeat cannot do harm, and the rule that matched says why:
 *             the HTTP method's own semantics, a state machine that refuses the
 *             second transition, a computation that changes nothing, a signed
 *             webhook deduplicated by the provider's event id, or a session
 *             operation. Residual creates are listed one by one.
 *
 * Paths are written exactly as Fastify registers them, `/api/v1` included.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, badRequest } from '../domain/errors.js';
import {
  centralScopeFor,
  claimCentralIdempotency,
  completeCentralIdempotency,
  releaseCentralIdempotency,
} from '../modules/orders/central-idempotency.service.js';

export type IdempotencyMode = 'REQUIRED' | 'OPTIONAL' | 'NOT_NEEDED';

export interface IdempotencyDeclaration {
  mode: IdempotencyMode;
  /** Which rule or list entry decided it - shown when a test fails. */
  source: string;
  /** Plain-language reason a repeat is or is not harmful. */
  reason: string;
  /** REQUIRED only: who replays the first response. */
  handledBy?: 'service' | 'central';
}

const P = '/api/v1';

// ---------------------------------------------------------------------------
// REQUIRED - the critical routes
// ---------------------------------------------------------------------------

/**
 * Routes whose service already runs `runIdempotent` (or an equivalent unique
 * key) and replays the first response itself. The central hook only insists
 * the header is present.
 */
const REQUIRED_SERVICE: Record<string, string> = {
  [`POST ${P}/cart/checkout`]: 'Places the order and reserves stock.',
  [`POST ${P}/payments/orders/:orderId/session`]: 'Opens a payment with the provider.',
  [`POST ${P}/admin/orders/:id/refunds`]: 'Sends money back to the buyer.',
  [`POST ${P}/admin/seller-orders/:id/commission-invoice`]: 'Drafts a commission invoice.',
  [`POST ${P}/admin/commission-invoices/:id/credit-notes`]: 'Issues a credit note.',
  [`POST ${P}/preorders`]: 'Sends a preorder request.',
  [`POST ${P}/preorders/:id/confirm`]: 'Confirms preorder terms, which creates the order.',
  [`POST ${P}/support/tickets`]: 'Opens a support request (storefront).',
  [`POST ${P}/support/tickets/:reference/messages`]: 'Writes on a support request (storefront).',
  [`POST ${P}/seller/support/tickets`]: 'Opens a support request (Seller Hub).',
  [`POST ${P}/seller/support/tickets/:reference/messages`]: 'Writes on a support request (Seller Hub).',
  [`POST ${P}/logistics/support/tickets`]: 'Opens a support request (logistics portal).',
  [`POST ${P}/logistics/support/tickets/:reference/messages`]:
    'Writes on a support request (logistics portal).',
  [`POST ${P}/orders/:id/returns`]: 'Raises a return request.',
  [`POST ${P}/admin/returns/:id/refund`]: 'Refunds a return.',
};

/**
 * Critical routes with no replay of their own. The central hook stores the
 * first successful response under (route, key) and plays it back.
 */
const REQUIRED_CENTRAL: Record<string, string> = {
  [`POST ${P}/admin/orders/:id/payment-links`]: 'Creates a payment link for an amount.',
  [`POST ${P}/admin/orders/:id/invoice`]: 'Issues the tax invoice for an order.',
  [`POST ${P}/admin/invoices/:id/credit`]: 'Credits (cancels) an issued tax invoice.',
  [`POST ${P}/seller/invoices/:id/credit`]: 'Credits a seller invoice.',
  [`POST ${P}/seller/consignments/:id/invoice/issue`]: 'Issues a seller invoice for a consignment.',
  [`POST ${P}/seller/orders/:id/shipments`]: 'Creates a shipment for a seller order.',
  [`POST ${P}/seller/orders/:id/consignments`]: 'Splits a seller order into consignments.',
  [`POST ${P}/admin/orders/:id/shipments`]: 'Creates a shipment for an order.',
  [`POST ${P}/admin/orders/:id/returns`]: 'Books a return against an order.',
};

// ---------------------------------------------------------------------------
// OPTIONAL - honoured when sent
// ---------------------------------------------------------------------------

const OPTIONAL: Record<string, string> = {
  [`POST ${P}/admin/logistics/shipments/:id/status-events`]:
    'A dispatcher on a bad line may resend; the key makes the resend a replay.',
  [`POST ${P}/logistics/shipments/:id/status-events`]:
    'A carrier on a bad line may resend; the key makes the resend a replay.',
  [`POST ${P}/logistics/shipments/:id/proof-of-delivery`]:
    'A driver phone may resend a proof upload; the key makes it a replay.',
  [`POST ${P}/logistics/operations/shipments/:id/events`]:
    'A driver phone may resend; the key makes it a replay.',
  [`POST ${P}/logistics/driver/location`]: 'Positions are deduplicated by the key the phone sends.',
  [`POST ${P}/admin/logistics-levels/legs/:legId/move`]: 'A repeated move with the same key changes nothing.',
  [`POST ${P}/admin/erp/connections`]: 'The key is the ERP header name to send, not a request key.',
};

// ---------------------------------------------------------------------------
// NOT_NEEDED - by rule
// ---------------------------------------------------------------------------

/** Final path segments that move a record between states. */
const TRANSITION_VERBS = new Set([
  'accept', 'acknowledge', 'activate', 'approval', 'approve', 'archive', 'assign',
  'assign-driver', 'block', 'cancel', 'close', 'complete', 'confirm', 'correct-status',
  'counter', 'deactivate', 'decide', 'decision', 'decline', 'default', 'disable',
  'discard', 'dismiss', 'enable', 'enabled', 'escalate', 'hide', 'inspect', 'issue',
  'lock', 'mark-paid', 'pause', 'priority', 'publish', 'read', 'ready', 'reactivate',
  'redact', 'reinstate', 'reject', 'release', 'reopen', 'request-change', 'resolve',
  'restore', 'resume', 'retry', 'requeue', 'revoke', 'start', 'start-production',
  'status', 'submit', 'submitted', 'suspend', 'transition', 'unarchive', 'unassign',
  'unassign-driver', 'unblock', 'unhide', 'unlock', 'unpublish', 'verify', 'void',
  'withdraw', 'regenerate', 'reset', 'sync', 'refresh', 'reconcile', 'collection',
  'link', 'unlink', 'handoff', 'moderate', 'feature', 'unfeature', 'answer', 'close-out',
]);

/** Final path segments that compute an answer without changing business state. */
const COMPUTATION_VERBS = new Set([
  'preview', 'test', 'test-connection', 'validate', 'dry-run', 'suggest', 'geocode',
  'quote', 'estimate', 'insights', 'stream', 'search', 'check', 'lookup', 'simulate',
  'calculate', 'freight-quote', 'eligibility', 'probe', 'translate', 'assistant',
  'image-search', 'context', 'resolve-address', 'verify-token', 'render',
]);

const WEBHOOK_PREFIXES = [
  `${P}/integrations/`,
  `${P}/payments/webhooks/`,
  `${P}/erp-inbound/`,
];

/** The last segment that is not a `:param`. */
function lastWordOf(url: string): string {
  const parts = url.split('/').filter((part) => part !== '' && !part.startsWith(':'));
  return parts.at(-1) ?? '';
}

interface Rule {
  id: string;
  reason: string;
  matches: (method: string, url: string) => boolean;
}

const RULES: Rule[] = [
  {
    id: 'signed-webhook',
    reason:
      "Called by another system that cannot send our header; the handler deduplicates on the provider's own event id.",
    matches: (_m, url) => WEBHOOK_PREFIXES.some((prefix) => url.startsWith(prefix)),
  },
  {
    id: 'session',
    reason:
      'Signs in or out, or changes the caller’s own credentials; a repeat leaves the same session state or is refused (one-time codes, rate limits).',
    matches: (_m, url) => url.includes('/auth/') || url.endsWith('/auth'),
  },
  {
    id: 'replace-or-remove',
    reason: 'PUT replaces and DELETE removes: doing either twice leaves the same state as doing it once.',
    matches: (method) => method === 'PUT' || method === 'DELETE',
  },
  {
    id: 'partial-update',
    reason: 'PATCH sets the named fields to the values sent: the same body twice leaves the same row.',
    matches: (method) => method === 'PATCH',
  },
  {
    id: 'state-transition',
    reason:
      'Moves one record between states through its state machine; a repeat finds it already moved and is refused, so the effect cannot happen twice.',
    matches: (method, url) => method === 'POST' && TRANSITION_VERBS.has(lastWordOf(url)),
  },
  {
    id: 'computation',
    reason: 'Computes and returns an answer; it changes no business state, so a repeat is harmless.',
    matches: (method, url) => method === 'POST' && COMPUTATION_VERBS.has(lastWordOf(url)),
  },
];

/**
 * Residual creates: a POST that adds one record the person can see and
 * remove themselves - a category, an address, a note, a chat message. A
 * duplicate is visible, harmless and removable, and a unique constraint
 * refuses it where a duplicate would matter. Matched by the final word, so a
 * new collection needs adding here deliberately.
 */
const HARMLESS_CREATE_WORDS = new Set([
  'addresses', 'attachments', 'brands', 'categories', 'connections', 'coupons',
  'departments', 'documents', 'drivers', 'exceptions', 'fields', 'images',
  'import', 'invitations', 'invite', 'items', 'lines', 'listings', 'locations',
  'logo', 'media', 'members', 'messages', 'notes', 'offers', 'packaging',
  'pickups', 'products', 'proposals', 'rates', 'replies', 'reviews', 'roles',
  'staff', 'tiers', 'values', 'variants', 'vehicles', 'warehouses', 'wishlist',
  'zones', 'bulk', 'photos', 'templates', 'contacts', 'devices', 'tokens',
  'webhooks', 'mappings', 'sla-policies', 'axes', 'cart', 'coupon', 'reply',
  'uploads', 'upload', 'exports', 'export', 'reports', 'data-requests',
  'product-instructions', 'questions', 'favourites', 'lanes', 'levels', 'legs',
  'status-events', 'delivery-code', 'schedules', 'recurring-schedules', 'occurrences',
  'payment-methods', 'setup-intent', 'onboarding', 'autopay', 'acknowledgement',
  'conversations', 'language', 'locale', 'email-change', 'phone-change', 'closure',
  'gpsr', 'translations', 'legal-documents', 'versions', 'sellers', 'companies',
  'buyer-companies', 'applications', 'registrations', 'entities', 'profile',
]);

const HARMLESS_CREATE: Rule = {
  id: 'harmless-create',
  reason:
    'Adds one record the person can see and remove themselves; a duplicate is visible and harmless, and a unique constraint refuses one where it would matter.',
  matches: (method, url) => method === 'POST' && HARMLESS_CREATE_WORDS.has(lastWordOf(url)),
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export function declarationFor(method: string, url: string): IdempotencyDeclaration | null {
  const upper = method.toUpperCase();
  const key = `${upper} ${url}`;

  const service = REQUIRED_SERVICE[key];
  if (service !== undefined) {
    return { mode: 'REQUIRED', source: 'REQUIRED_SERVICE', reason: service, handledBy: 'service' };
  }
  const central = REQUIRED_CENTRAL[key];
  if (central !== undefined) {
    return { mode: 'REQUIRED', source: 'REQUIRED_CENTRAL', reason: central, handledBy: 'central' };
  }
  const optional = OPTIONAL[key];
  if (optional !== undefined) return { mode: 'OPTIONAL', source: 'OPTIONAL', reason: optional };

  for (const rule of [...RULES, HARMLESS_CREATE]) {
    if (rule.matches(upper, url)) return { mode: 'NOT_NEEDED', source: rule.id, reason: rule.reason };
  }
  return null;
}

/** Every route this file names explicitly, so a test can spot entries left behind by a removed route. */
export function explicitlyDeclaredRoutes(): string[] {
  return [
    ...Object.keys(REQUIRED_SERVICE),
    ...Object.keys(REQUIRED_CENTRAL),
    ...Object.keys(OPTIONAL),
  ];
}

// ---------------------------------------------------------------------------
// The central hook
// ---------------------------------------------------------------------------

/** Longest key accepted. A UUID is 36; the column is 128. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

const REPLAYED_HEADER = 'idempotent-replayed';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the central hook when this request holds a central claim. */
    centralIdempotency?: { scope: string; key: string };
  }
}

function readKey(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (key.length === 0) {
    throw badRequest(ErrorCode.IDEMPOTENCY_KEY_REQUIRED, 'Send an Idempotency-Key header with this request.', [
      { field: 'Idempotency-Key', code: 'REQUIRED' },
    ]);
  }
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The Idempotency-Key header is too long.', [
      { field: 'Idempotency-Key', code: 'TOO_LONG' },
    ]);
  }
  return key;
}

export interface IdempotencyHooks {
  preHandler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  onSend: (request: FastifyRequest, reply: FastifyReply, payload: unknown) => Promise<unknown>;
  onError: (request: FastifyRequest, reply: FastifyReply, error: Error) => Promise<void>;
}

/** The hooks for one route, or null when it declares no required key. */
export function idempotencyHooksFor(method: string, url: string): IdempotencyHooks | null {
  const declaration = declarationFor(method, url);
  if (declaration?.mode !== 'REQUIRED') return null;

  const scope = centralScopeFor(method, url);
  const central = declaration.handledBy === 'central';

  return {
    async preHandler(request, reply) {
      const key = readKey(request);
      if (!central) return;

      const ownerId = request.auth?.id ?? null;
      const claim = await claimCentralIdempotency({
        scope,
        key,
        ownerId,
        body: {
          params: request.params ?? null,
          query: request.query ?? null,
          body: request.body ?? null,
        },
      });

      if (claim.kind === 'replay') {
        await reply
          .header(REPLAYED_HEADER, 'true')
          .status(claim.httpStatus)
          .send(claim.response);
        return;
      }
      request.centralIdempotency = { scope, key };
    },

    async onSend(request, reply, payload) {
      const held = request.centralIdempotency;
      if (held === undefined) return payload;
      request.centralIdempotency = undefined;

      if (reply.statusCode >= 200 && reply.statusCode < 300) {
        let response: unknown = null;
        if (typeof payload === 'string' && payload.length > 0) {
          try {
            response = JSON.parse(payload) as unknown;
          } catch {
            response = null;
          }
        }
        await completeCentralIdempotency({ ...held, response, httpStatus: reply.statusCode });
      } else {
        // A refused or failed attempt must not poison the key: the caller
        // fixes the problem and retries with the same one.
        await releaseCentralIdempotency(held);
      }
      return payload;
    },

    async onError(request) {
      const held = request.centralIdempotency;
      if (held === undefined) return;
      request.centralIdempotency = undefined;
      await releaseCentralIdempotency(held);
    },
  };
}
