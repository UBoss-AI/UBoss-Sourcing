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
  [`POST ${P}/rfqs/:id/purchase-order/order`]:
    'Turns an approved RFQ purchase order into an order; the conditional, unique link of the purchase order to its order replays the same order, including for concurrent requests.',
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
  // Doc 07 / Doc 08: anything that adds a record a repeat would duplicate.
  [`POST ${P}/admin/seller-orders/:id/custody-handovers`]: 'Records a custody handover; replay must not add a second handover.',
  [`POST ${P}/seller/orders/:id/custody-handovers`]: 'Records a custody handover; replay must not add a second handover.',
  [`POST ${P}/logistics/shipments/:id/custody`]: 'Records a carrier custody handover; replay must not add a second handover.',
  [`POST ${P}/admin/seller-orders/:id/partial-shipments`]: 'Approves a partial shipment and its billing; replay must not approve a second one.',
  [`POST ${P}/admin/disputes/:id/case-controls/evidence-requests`]: 'Sends an evidence request to a party; replay must not send it twice.',
  [`POST ${P}/admin/commercial/certification-programmes`]: 'Creates a certification-recovery programme; replay must not create a second ledger.',
  [`POST ${P}/admin/commercial/security`]: 'Proposes a seller security schedule; replay must not propose it twice.',
  [`POST ${P}/audit/product-evidence`]: 'Records product evidence; replay must not add a second record.',
  [`POST ${P}/audit/safety-cases`]: 'Opens a safety case; replay must not open a second one.',
  [`POST ${P}/audit/safety-cases/:id/actions`]: 'Records a reporting decision, notice or recall action; replay must not record it twice.',
  [`POST ${P}/audit/recall-rehearsals`]: 'Records a recall rehearsal; replay must not record it twice.',
  [`POST ${P}/audit/shipment-assessments/policy`]: 'Publishes a new badge-policy version; replay must not publish a second one.',
  [`POST ${P}/audit/shipment-assessments/:id/evidence`]: 'Stores private assessment evidence; replay must not duplicate the file.',
  [`POST ${P}/seller/shipment-assessments/:id/evidence`]: 'Stores private seller evidence for an assessment; replay must not duplicate the file.',
  // Seller Assessment: anything that creates a record or a file.
  [`POST ${P}/audit/seller-assessments/:id/evidence`]: 'Stores a private, versioned reviewer evidence file; replay must not add a second version.',
  [`POST ${P}/seller/assessment/:id/evidence`]: 'Stores a private, versioned seller evidence file; replay must not add a second version.',
  [`POST ${P}/audit/seller-assessments/:id/findings`]: 'Raises a numbered finding; replay must not raise it twice.',
  [`POST ${P}/audit/seller-assessments/:id/workpapers`]: 'Records a workpaper revision; replay must not add a second revision.',
  [`POST ${P}/audit/seller-assessments/:id/certifications`]: 'Appoints a certification body; replay must not appoint (and replace) twice.',
  [`POST ${P}/audit/seller-assessments/policies`]: 'Drafts a policy version; replay must not collide on the version.',
  [`POST ${P}/audit/seller-assessments/sellers/:id/undisclosed-changes`]: 'Records an undisclosed change; replay must not record it twice.',
  [`POST ${P}/audit/seller-assessments/legacy-reassessments`]: 'Opens legacy reassessments; replay must return the first result.',
  [`POST ${P}/seller/assessment`]: 'Starts an application; the service also returns the open one.',
  [`POST ${P}/seller/assessment/notices/:id/appeal`]: 'Submits an appeal; replay must not open a second.',
  [`POST ${P}/seller/assessment/changes`]: 'Notifies a change; replay must not notify twice.',
  [`POST ${P}/seller/assessment/incidents`]: 'Reports an incident with its timing; replay must not report twice.',
  [`POST ${P}/seller/assessment/bank-changes`]: 'Requests a bank change; replay must not open a second request.',
  [`POST ${P}/logistics/legs/:id/shipment-assessment/evidence`]: 'Stores private loading evidence; replay must not duplicate the file.',
  [`POST ${P}/audit/seller-verification/:id/certificates`]: 'Issues a seller verification certificate; replay must not issue a second version.',
  [`POST ${P}/audit/agency/jobs/:id/defects`]: 'Creates an NCR; replay must not count the same defect twice.',
  [`POST ${P}/audit/agency/jobs/:id/binding`]: 'Creates shipment binding and release records; replay must not release twice.',
  [`POST ${P}/audit/agency/defects/:id/reclassify`]: 'Records an evidenced severity decision; replay must not create another decision.',
  [`POST ${P}/audit/agency/jobs/:id/evidence`]: 'Stores private evidence; replay must not duplicate the file.',
  [`POST ${P}/seller/inspection/jobs/:id/evidence`]: 'Stores private seller evidence; replay must not duplicate the file.',
  [`POST ${P}/admin/inspection/requirements/:id/evidence`]: 'Stores private release evidence; replay must not duplicate the file.',
  [`POST ${P}/audit/agency/jobs/:id/lab-samples/:sampleId/custody`]: 'Appends a hand-over to a chain of custody; replay must not record the same hand-over twice.',
  [`POST ${P}/audit/jobs/:id/sublot-releases`]: 'Asks for a sub-lot release; replay returns the first request instead of asking twice.',
  [`POST ${P}/audit/checklists`]: 'Creates an inspection plan version; replay must not create a second plan.',
  [`POST ${P}/audit/seller-verification/:id/screening`]: 'Records a manual screening; replay must not add the same check to the history twice.',
  [`POST ${P}/admin/inspection/jobs`]: 'Books a job; replay returns the original booking.',
  [`POST ${P}/admin/inspection/agencies`]: 'Registers an agency; replay must not create a second agency.',
  [`POST ${P}/admin/inspection/rules`]: 'Creates an inspection rule; replay must not apply the rule twice.',
  [`POST ${P}/admin/inspection/plans`]: 'Creates an inspection plan; replay must not create a second plan.',
  [`POST ${P}/admin/orders/:id/payment-links`]: 'Creates a payment link for an amount.',
  [`POST ${P}/admin/orders/:id/invoice`]: 'Issues the tax invoice for an order.',
  [`POST ${P}/admin/invoices/:id/credit`]: 'Credits (cancels) an issued tax invoice.',
  [`POST ${P}/seller/invoices/:id/credit`]: 'Credits a seller invoice.',
  [`POST ${P}/seller/consignments/:id/invoice/issue`]: 'Issues a seller invoice for a consignment.',
  [`POST ${P}/seller/orders/:id/shipments`]: 'Creates a shipment for a seller order.',
  [`POST ${P}/seller/orders/:id/consignments`]: 'Splits a seller order into consignments.',
  [`POST ${P}/admin/orders/:id/shipments`]: 'Creates a shipment for an order.',
  [`POST ${P}/admin/orders/:id/returns`]: 'Books a return against an order.',
  [`POST ${P}/rfqs`]: 'Starts a draft request for quotation; a double press must not start two.',
  [`POST ${P}/rfqs/:id/samples`]: 'Asks a seller for a sample; a double press must not ask twice.',
  [`POST ${P}/seller/orders/:id/production/delays`]:
    'Raises a production exception and tells the buyer; a repeat must not record and announce the same delay twice.',
  [`POST ${P}/rfqs/:id/submit`]:
    'Sends a request for quotation to sellers, writing their invitations and telling each of them.',
  [`POST ${P}/admin/account-messages`]:
    'Emails a customer or seller a message from staff; replay returns the first result instead of sending a second email.',
};

// ---------------------------------------------------------------------------
// OPTIONAL - honoured when sent
// ---------------------------------------------------------------------------

const OPTIONAL: Record<string, string> = {
  [`POST ${P}/audit/shipment-assessments/:id/rounds`]: 'Starts an assessment round; the version read refuses a repeat, and the key makes it a replay.',
  [`POST ${P}/audit/seller-assessments/policies/:id/adopt`]: 'Records adoption of a draft; a repeat finds it adopted and is refused.',
  [`POST ${P}/audit/seller-assessments/policies/:id/disclose`]: 'Records disclosure; a repeat writes the same values.',
  [`POST ${P}/audit/seller-assessments/dispositions/:id`]: 'Records a disposition; a repeat writes the same decision.',
  [`POST ${P}/audit/seller-assessments/evidence/:id/legal-hold`]: 'Sets a legal hold; a repeat writes the same flag.',
  [`POST ${P}/audit/seller-assessments/incidents/:id/review`]: 'Records an incident review; a repeat writes the same status.',
  [`POST ${P}/audit/seller-assessments/bank-changes/:id`]: 'One bank-change step; the version read refuses a repeat.',
  [`POST ${P}/audit/seller-assessments/:id/correction`]: 'Returns the file; the status machine refuses a repeat.',
  [`POST ${P}/audit/seller-assessments/:id/accept-file`]: 'Accepts the file; the status machine refuses a repeat.',
  [`POST ${P}/audit/seller-assessments/:id/gates/:gate`]: 'Decides a gate; a repeat writes the same decision.',
  [`POST ${P}/audit/seller-assessments/:id/checklist/:code/approve-na`]: 'Approves an N/A; a repeat writes the same approval.',
  [`POST ${P}/audit/seller-assessments/:id/hard-stops`]: 'Records a hard stop keyed by its kind; a repeat replaces the same entry.',
  [`POST ${P}/audit/shipment-assessments/:id/checks`]: 'Records checklist results by item; a repeat writes the same results.',
  [`POST ${P}/audit/shipment-assessments/:id/qa`]: 'A QA decision; the version read refuses a repeat, and the key makes it a replay.',
  [`POST ${P}/audit/shipment-assessments/:id/waiver-review`]: 'Opens waiver review; the version read refuses a repeat.',
  [`POST ${P}/audit/shipment-assessments/:id/waiver`]: 'A waiver decision; the version read and the one-active-release index refuse a repeat.',
  [`POST ${P}/audit/shipment-assessments/:id/hold`]: 'Puts a shipment on hold; the version read refuses a repeat.',
  [`POST ${P}/audit/shipment-assessments/:id/reassessment`]: 'Requires reassessment; the version read refuses a repeat.',
  [`POST ${P}/seller/shipment-assessments/:id/response`]: 'Saves the seller readiness note or corrective response; a repeat saves the same text.',
  [`POST ${P}/logistics/legs/:id/shipment-assessment/checks`]: 'Records loading checks by item; a repeat writes the same results.',
  [`POST ${P}/admin/logistics/shipments/:id/status-events`]:
    'A dispatcher on a bad line may resend; the key makes the resend a replay.',
  [`POST ${P}/logistics/shipments/:id/status-events`]:
    'A carrier on a bad line may resend; the key makes the resend a replay.',
  [`POST ${P}/logistics/shipments/:id/proof-of-delivery`]:
    'A driver phone may resend a proof upload; the key makes it a replay.',
  [`POST ${P}/logistics/legs/:id/progress`]:
    'A driver phone may resend; the key makes it a replay.',
  [`POST ${P}/logistics/driver/location-pings`]: 'Positions are deduplicated by the key the phone sends.',
  [`POST ${P}/logistics/legs/:id/driver`]: 'A repeated assignment with the same key changes nothing.',
  [`POST ${P}/payments/links/:token/pay`]:
    'Opens a payment for a link; the provider confirms once by webhook, so a repeat cannot charge twice, but a key stops a second session being opened.',
  [`POST ${P}/payments/orders/:orderId/mock-capture`]: 'Development-only capture; a repeat is refused once the order is paid.',
  [`POST ${P}/admin/inventory/receipts`]:
    'Adds received stock; a key makes a resent form a replay instead of counting the delivery twice.',
  [`POST ${P}/admin/inventory/adjustments`]:
    'Changes a stock count; a key makes a resent form a replay instead of adjusting twice.',
  [`POST ${P}/seller/inventory/movements`]:
    'Moves stock; a key makes a resent form a replay instead of moving it twice.',
  [`POST ${P}/admin/returns/:id/receive`]: 'Books returned goods back into stock; the return state refuses a second receipt.',
  [`POST ${P}/seller/returns/:id/receive`]: 'Books returned goods back into stock; the return state refuses a second receipt.',
  [`POST ${P}/admin/returns/:id/replacement`]: 'Sends a replacement; the return state refuses a second one.',
  [`POST ${P}/disputes`]: 'Opens a dispute; a key makes a resent form a replay instead of a second dispute.',
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
  'receive', 'ship',
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
  // One quote per seller per request (uq_rfq_quote_seller) refuses a repeat.
  'quotes',
]);

/**
 * Routes checked one by one whose final word is not in a list above. Each group
 * says why a repeat is harmless; a route is added here on purpose, after
 * somebody has asked the question, never to silence the guard test.
 */
const LISTED_NOT_NEEDED_GROUPS: Array<{ reason: string; routes: string[] }> = [
  {
    reason: 'Doc 07 / Doc 08: records a fact once on a single row (provider confirmation, the decision clock, an appeal reviewer, a reasoned decision, a correction, a containment, an agreement); a repeat is refused or sets the same values.',
    routes: ['admin/commercial/schedules/:id/provider-confirmation', 'admin/commercial/schedules/:id/retire', 'admin/disputes/:id/case-controls/evidence-sufficient', 'admin/disputes/:id/case-controls/appeal-reviewer', 'audit/safety-cases/:id/contain', 'audit/safety-cases/:id/correction', 'admin/orders/:id/payment-plan/agreement', 'admin/commercial/launch/:countryCode/:key/review', 'admin/commercial/security-reviews/:id', 'admin/commercial/commission-adjustments/:id/apply'],
  },
  {
    reason: 'Doc 07 / Doc 08: a unique key refuses the repeat - one payment plan per order, one cost per third-party reference, one recovery per provider reference, one answer per evidence request.',
    routes: ['admin/orders/:id/payment-plan', 'admin/commercial/certification-programmes/:id/costs', 'admin/orders/:id/loss-recoveries', 'seller/disputes/:reference/case-controls/evidence-requests/:requestId', 'disputes/:reference/case-controls/evidence-requests/:requestId'],
  },
  {
    reason: 'Audit Console: saves the one quantity record, laboratory result or applicability determination for its job, sample or requirement code; repeating the body leaves the same values.',
    routes: ['audit/agency/jobs/:id/quantities', 'audit/agency/jobs/:id/lab-samples/:sampleId/result', 'audit/cases/:id/determinations'],
  },
  {
    reason: 'Audit Console: a unique key refuses the repeat - a sample code per job, a rule code, one case per seller scope (asking again returns the same case), a console account per email address.',
    routes: ['audit/agency/jobs/:id/lab-samples', 'audit/rules', 'audit/cases', 'seller/compliance/cases', 'admin/inspection/members/:id/move-to-console'],
  },
  {
    reason: 'Audit Console: moves one record through its state machine (a report correction claims the report it supersedes; a case or document asks for changes; a rule is revised or withdrawn; a seller answers or withdraws); a repeat finds it already moved and is refused.',
    routes: ['audit/agency/reports/:id/correct', 'audit/cases/:id/request-changes', 'audit/documents/:id/request-changes', 'audit/rules/:id/revise', 'audit/rules/:id/retire', 'seller/compliance/cases/:id/respond'],
  },
  {
    reason: 'Audit Console: replaces an activation link (the previous one stops working) or marks notifications read; a repeat leaves one live link and the same read state.',
    routes: ['audit/agency/team/members/:id/resend-invitation', 'admin/audit-console/people/:id/resend-invitation', 'audit/notifications/read-all'],
  },
  {
    reason: 'Loads the dated research as draft rules; a code already present is skipped, so a repeat creates nothing.',
    routes: ['audit/rules/import-research'],
  },
  {
    reason: 'Claims each seller balance under a row lock and sends it with a provider idempotency key derived from the payout; a repeat finds nothing available.',
    routes: ['admin/finance/payouts/run'],
  },
  {
    reason: 'Replaces the saved declaration, checklist answer, sampling record, readiness or corrective action for the same record; repeating the body leaves the same business values.',
    routes: ['audit/agency/jobs/:id/conflict', 'audit/agency/jobs/:id/checks', 'audit/agency/jobs/:id/sampling', 'seller/inspection/jobs/:id/readiness', 'seller/inspection/defects/:id/capa'],
  },
  {
    reason: 'Returns or signs a submitted report through the job state machine, or requests an inspection/release once; the service refuses a repeat after the state has moved.',
    routes: ['audit/agency/jobs/:id/report/return', 'audit/agency/jobs/:id/report/sign', 'inspection/buyer/orders/:id/request', 'inspection/buyer/orders/:id/book', 'admin/inspection/requirements/:id/conditional-release'],
  },
  {
    reason: 'Recomputes the requirement under the current rules and raises it only when needed; a repeat cannot lower the gate.',
    routes: ['admin/inspection/requirements/:id/reevaluate'],
  },
  {
    reason: 'Upserts the one override row of the seller order to cover the holds open now; repeating it with the same reason leaves the same override.',
    routes: ['admin/seller-orders/:id/compliance-override'],
  },
  {
    reason: 'Decides the turnover declaration named in the body; a repeat of the same decision changes nothing, and a declaration changed or decided since is refused. The Admin Panel route only refuses: the Audit Team verifies sellers.',
    routes: ['admin/sellers/:id/turnover/decision', 'audit/seller-verification/:id/turnover/decision'],
  },
  {
    reason: 'The unique agency/invoice-number constraint refuses a duplicate invoice.',
    routes: ['audit/agency/jobs/:id/invoice'],
  },
  {
    reason: 'Replays the immutable purchase order for the awarded RFQ; unique RFQ and quote constraints prevent a second contract, including concurrent requests.',
    routes: ['rfqs/:id/purchase-order'],
  },
  {
    reason: 'Returns the live order already made for the charged sample; a conditional link of the sample to its order refuses a second one, including concurrent requests.',
    routes: ['rfqs/:id/samples/:sampleId/checkout'],
  },
  {
    reason: 'Sets the expected date for one production stage (an upsert per stage); repeating the body leaves the same planned date.',
    routes: ['seller/orders/:id/production/plan'],
  },
  {
    reason: 'Records a production stage once or applies a checked bulk-update preview once; the service refuses a stage already recorded and a preview already applied.',
    routes: ['seller/orders/:id/production/milestones', 'seller/bulk-imports/:id/apply'],
  },
  {
    reason:
      'Moves one record through its state machine (review, hold, retire, receive, response, appeal); a repeat finds it already moved and is refused.',
    routes: [
      'admin/buyer-companies/:id/checks', 'admin/buyer-companies/:id/request-information',
      'admin/buyer-companies/:id/reverify', 'admin/buyer-companies/:id/start-review',
      'admin/disputes/:id/assignment', 'admin/disputes/:id/decision/refuse', 'admin/disputes/:id/review',
      'admin/platform-fee-rules/:id/retire', 'admin/platform-fees/:id/retire',
      'admin/platform-fees/:id/verify-tax', 'admin/product-reviews/:reviewId/moderation',
      'admin/product-reviews/:reviewId/response/moderation',
      'admin/returns/:id/instructions', 'admin/returns/:id/labels', 'admin/sellers/:id/screening',
      'admin/support-tickets/:id/assignment', 'admin/logistics/partners/:id/verification',
      'admin/logistics/managed-levels/rates/:rateId/publish-price', 'admin/preorder-chats/:id/preorder',
      'buyer-companies/:id/resubmit', 'disputes/:reference/appeal', 'seller/disputes/:reference/appeal',
      'seller/disputes/:reference/response', 'seller/returns/:id/instructions', 'seller/returns/:id/labels',
      'seller/returns/:id/response', 'seller/preorders/:id/availability-proposal',
      'logistics/dispatch-manifests/:id/handover', 'logistics/packages/:id/scan', 'logistics/pickups/:id/fail',
      'logistics/driver/trips/:id/end', 'seller/consignments/:id/pack', 'seller/consignments/:id/split',
      'seller/consignments/:id/purchase', 'seller/consignments/:id/carrier',
      'seller/consignments/:id/manual-booking', 'seller/consignments/:id/milestones',
      'seller/consignments/:id/packing-list/supersede', 'seller/consignments/:id/quotes/:quoteId/select',
      'seller/listings/:id/pause-for-edit', 'admin/logistics/orders/:id/shipments',
      'account/integrations/erp/approvals/:approvalId', 'account/integrations/erp/connections/:id/disconnect',
      'account/integrations/erp/connections/:id/reconnect', 'admin/erp/connections/:id/actions',
      'seller/erp/connections/:id/initial-sync', 'seller/erp/connections/:id/auto-create-masters',
      'recurring-schedules/:id/skip-next', 'recurring-schedules/occurrences/:occurrenceId/skip',
      'recurring-schedules/:id/occurrences/:occurrenceId/confirm-price',
      'recurring-schedules/:id/occurrences/:occurrenceId/decline-price',
      'admin/notifications/read-all', 'sellers/session/renew', 'admin/trade-documents/versions/:id/validation',
      'admin/seller-listings/:id/appeal-decision', 'seller/listing-drafts/:id/appeal', 'admin/content-blocks/:id/return',
    ],
  },
  {
    reason:
      'Computes and returns an answer (a quote, a preview, a draft title, a generated variant grid, a chat reply); it changes no business state, so a repeat is harmless.',
    routes: [
      'delivery/options', 'fulfilment/warehouse-options', 'fulfilment/warehouse-options/:quoteId/revalidate',
      'partner-invitations/describe', 'assistant/chat', 'admin/products/:id/variants/generate',
      'seller/listing-drafts/:id/preview-title', 'seller/listing-drafts/:id/variants/generate',
      'seller/consignments/:id/quotes', 'admin/settings/catalogue-translation/run',
      'account/integrations/erp/oauth/callback',
    ],
  },
  {
    reason:
      'Adds one record the person can see and remove themselves (a customer, a tax class, a connection, an invitation, a draft, an application); a unique constraint refuses a duplicate where it would matter.',
    routes: [
      'admin/customers', 'admin/settings/tax-classes', 'admin/settings/shipping-methods',
      'admin/economic-operators', 'admin/integrations', 'admin/platform-fee-rules', 'admin/platform-fees',
      'admin/logistics/partners', 'admin/logistics/partners/:id/capabilities', 'admin/erp/inventory/manual',
      'account/integrations/erp/connections/:id/product-codes', 'account/integrations/erp/organization/invites',
      'account/integrations/erp/organization/join', 'buyer-companies/:id/access-reviews',
      'buyer-companies/:id/email-code', 'buyer-companies/:id/invitations/:invitationId/resend',
      'seller/access-reviews', 'admin/staff/:id/access-reviews', 'seller/agreements', 'seller/brand-requests', 'seller/carriers',
      'seller/certifications', 'seller/document-links/:kind/:id', 'seller/document-links/batch',
      'seller/erp/connections/:id/company', 'seller/erp/connections/:id/pairing-codes', 'seller/factories',
      'seller/factories/:id/evidence', 'seller/fulfilment/methods',
      'seller/fulfilment/methods/:methodId/capabilities', 'seller/fulfilment/methods/:methodId/rate-cards',
      'seller/fulfilment/partners/request', 'seller/fulfilment/self-managed', 'seller/invitations/:invitationId/resend',
      'seller/listing-drafts', 'seller/listings/:id/duplicate', 'returns/:id/files', 'sellers/apply',
      'sellers/lock/open', 'recurring-schedules/from-cart', 'logistics/dispatch-manifests', 'seller/orders/:id/trade-documents',
      'seller/orders/:id/trade-documents/certificate-of-origin',
      'logistics/driver/location-consent', 'logistics/driver/trips', 'admin/vat-rates',
      'admin/master-data/:kind', 'admin/market-rules', 'admin/trade-rules', 'admin/content-blocks', 'account/saved-searches',
      'admin/listing-moderation/terms',
      'seller/bulk-imports',
      // A repeat withdraws the earlier pending request and leaves one pending, identical request.
      'seller/company-changes',
    ],
  },
  {
    reason:
      'Adds to an anonymous daily counter; a repeated batch is one more count of a page view, which the reconciliation against source transactions would show, and nothing else changes.',
    routes: ['analytics/events'],
  },
  {
    reason:
      'Adds to an anonymous daily counter; a repeated batch is one more count of a page view, which the reconciliation against source transactions would show, and nothing else changes.',
    routes: ['analytics/events'],
  },
  {
    reason:
      'Changes a login or a secret (a temporary password, a rotated integration secret); a repeat replaces the previous one and the earlier value stops working.',
    routes: ['admin/customers/:id/password-reset', 'admin/staff/:id/temporary-password', 'admin/logistics/integrations/:id/rotate-secret'],
  },
];

const LISTED_NOT_NEEDED = new Map<string, string>(
  LISTED_NOT_NEEDED_GROUPS.flatMap((group) => group.routes.map((route) => [`POST ${P}/${route}`, group.reason] as const)),
);

/** Listed routes, so the guard test can spot an entry left behind by a removed route. */
export function listedNotNeededRoutes(): string[] {
  return [...LISTED_NOT_NEEDED.keys()];
}

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

  const listed = LISTED_NOT_NEEDED.get(key);
  if (listed !== undefined) return { mode: 'NOT_NEEDED', source: 'LISTED_NOT_NEEDED', reason: listed };

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
    ...listedNotNeededRoutes(),
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
