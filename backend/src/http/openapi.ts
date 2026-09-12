/**
 * OpenAPI document.
 *
 * Paths, methods and parameters are read from Fastify's LIVE route table, not
 * hand-listed. A hand-listed document drifts the moment somebody adds a route
 * and forgets to document it, and a frontend generated from a stale document
 * fails at runtime rather than at build time.
 *
 * Request and response schemas are authored here because the routes validate
 * with Zod inside their handlers rather than through Fastify's schema hook.
 * That is a known trade-off: the shapes below are maintained by hand, and the
 * contract test in tests/integration/openapi.test.ts fails if a route exists
 * with no documented operation.
 */
import { API_PREFIX } from './app.js';

interface OperationDoc {
  summary: string;
  description?: string;
  tags: string[];
  /** Auth requirement, rendered as a security requirement and in the summary. */
  auth: 'none' | 'admin' | 'customer' | 'token';
  permission?: string;
  idempotent?: boolean;
  requestBody?: unknown;
  /**
   * True where the endpoint accepts the body but does not need it.
   *
   * Documented rather than assumed: a generated client that believes a body is
   * required will send `{}` where sending nothing was the intended call, and
   * for the payment session those are not the same request — one accepts the
   * gateway recorded on the order, the other is a client that has opinions.
   */
  optionalBody?: boolean;
  responses?: Record<string, unknown>;
}

const ref = (name: string): { $ref: string } => ({ $ref: `#/components/schemas/${name}` });

const json = (schema: unknown): unknown => ({ content: { 'application/json': { schema } } });

const ok = (schema: unknown, description = 'Success'): unknown => ({
  description,
  ...(json(schema) as object),
});

/**
 * Documented operations, keyed `METHOD path`.
 *
 * A route missing from here still appears in the document (derived from the
 * route table) but carries a "not yet documented" summary, and the contract
 * test reports it.
 */
const OPERATIONS: Readonly<Record<string, OperationDoc>> = Object.freeze({
  // --- Health ---
  'GET /health/live': {
    summary: 'Liveness probe',
    description: 'Never touches a dependency. A database outage must not restart the process.',
    tags: ['Health'],
    auth: 'none',
  },
  'GET /health/ready': {
    summary: 'Readiness probe',
    description: 'Checks database and queue. Returns 503 so a load balancer drains this instance.',
    tags: ['Health'],
    auth: 'none',
  },
  'GET /metrics': {
    summary: 'Prometheus metrics',
    tags: ['Health'],
    auth: 'none',
  },

  // --- Auth (both surfaces share these shapes) ---
  'POST /api/v1/admin/auth/login': {
    summary: 'Sign in to the Admin Panel',
    description:
      'A customer credential is rejected here with the same generic message as an unknown ' +
      'account, so neither surface can enumerate the other.',
    tags: ['Auth (Admin)'],
    auth: 'none',
    requestBody: ref('LoginRequest'),
    responses: { '200': ok(ref('LoginResponse')), '401': ok(ref('ErrorEnvelope'), 'Rejected') },
  },
  'POST /api/v1/auth/login': {
    summary: 'Sign in to the Customer Website',
    tags: ['Auth (Customer)'],
    auth: 'none',
    requestBody: ref('LoginRequest'),
    responses: { '200': ok(ref('LoginResponse')), '401': ok(ref('ErrorEnvelope'), 'Rejected') },
  },
  'POST /api/v1/admin/auth/refresh': {
    summary: 'Rotate the session',
    description:
      'Presenting an already-rotated token revokes the whole session family. Both the attacker ' +
      'and the legitimate client are signed out.',
    tags: ['Auth (Admin)'],
    auth: 'none',
    responses: { '200': ok(ref('RefreshResponse')) },
  },
  'POST /api/v1/auth/refresh': {
    summary: 'Rotate the session',
    tags: ['Auth (Customer)'],
    auth: 'none',
    responses: { '200': ok(ref('RefreshResponse')) },
  },
  'GET /api/v1/admin/auth/me': {
    summary: 'Current administrator, with their permission set',
    tags: ['Auth (Admin)'],
    auth: 'admin',
    responses: { '200': ok(ref('AuthenticatedUser')) },
  },
  'GET /api/v1/auth/me': {
    summary: 'Current customer',
    tags: ['Auth (Customer)'],
    auth: 'customer',
    responses: { '200': ok(ref('AuthenticatedUser')) },
  },
  'POST /api/v1/admin/auth/session/location': {
    summary: 'Record where this admin session was opened from',
    description:
      "The position the browser's Geolocation API reported, posted once immediately after a " +
      'sign-in. Until it arrives, every admin route answers 403 LOCATION_REQUIRED - only /me, ' +
      '/logout, /language, /password/change and this route are reachable, so a session that ' +
      'refuses is a session that can do nothing. The coordinates are evidence for a person to ' +
      'read and never an authorisation input: nothing decides access from where they point, ' +
      'only from whether they were given. Recording one rings the console bell for staff ' +
      'holding staff.read, naming the place and the account. A deployment served over plain ' +
      'HTTP has no Geolocation API to satisfy this with and must set ' +
      'FEATURE_ADMIN_LOGIN_LOCATION=false, which turns the requirement off everywhere.',
    tags: ['Auth (Admin)'],
    auth: 'admin',
    requestBody: ref('SessionLocationRequest'),
    responses: { '200': ok(ref('SessionLocationResponse')) },
  },
  'POST /api/v1/auth/invitations/accept': {
    summary: 'Activate an invited account',
    description: 'Single use. Sets the password and records consent in one transaction.',
    tags: ['Auth (Customer)'],
    auth: 'token',
    requestBody: ref('AcceptInvitationRequest'),
  },
  'POST /api/v1/auth/register': {
    summary: 'Open an account from the storefront',
    description:
      'Available only where FEATURE_CUSTOMER_SELF_REGISTRATION is on; otherwise 403 ' +
      'SELF_REGISTRATION_DISABLED. Answers 202 with an identical body whether an account was ' +
      'created or the address was already registered - a sign-up form that says "that email is ' +
      'taken" is an account-enumeration oracle, and for a B2B supplier the enumerated set is a ' +
      'customer list. A duplicate is told in the mailbox instead: the address itself receives a ' +
      '"you already have an account" mail with a reset link. No session is issued; the account ' +
      'cannot sign in until the emailed confirmation link is opened, and where ' +
      'CUSTOMER_SELF_REGISTRATION_REQUIRES_APPROVAL is on (the default) not until a member of ' +
      'staff approves it either. `requiresApproval` in the response is that deployment-level ' +
      'flag, never a fact about the account.',
    tags: ['Auth (Customer)'],
    auth: 'none',
    requestBody: ref('RegisterRequest'),
    responses: {
      '202': ok(ref('RegisterResponse')),
      '403': ok(ref('ErrorEnvelope'), 'Self-registration is off for this deployment'),
    },
  },
  'POST /api/v1/auth/verify-email': {
    summary: 'Confirm a self-registered email address',
    description:
      'Single use, 48-hour link. `status` is ACTIVE when the account can sign in immediately, ' +
      'or PENDING_APPROVAL when it now waits for a member of staff - the storefront signs the ' +
      'shopper in on the first and must not attempt it on the second.',
    tags: ['Auth (Customer)'],
    auth: 'token',
    requestBody: ref('VerifyEmailRequest'),
    responses: { '200': ok(ref('VerifyEmailResponse')) },
  },
  'POST /api/v1/auth/verify-email/resend': {
    summary: 'Send the confirmation link again',
    description:
      'Uniform 202 whether or not the address exists or is already confirmed, for the same ' +
      'reason /auth/password/forgot is. A new link supersedes the outstanding one.',
    tags: ['Auth (Customer)'],
    auth: 'none',
    requestBody: ref('ResendVerificationRequest'),
  },

  'POST /api/v1/admin/staff': {
    summary: 'Create a staff account',
    description:
      'The system generates a temporary password and emails it; there is no password field on ' +
      'this request, so no administrator ever chooses or learns another person\'s. The account ' +
      'is created ACTIVE but can do nothing except set a real password, and the temporary one ' +
      'lapses after 72 hours.',
    tags: ['Auth (Admin)'],
    auth: 'admin',
    permission: 'staff.write + role.assign',
    requestBody: ref('CreateStaffRequest'),
    responses: { '201': ok(ref('CreateStaffResponse')) },
  },
  'POST /api/v1/admin/staff/:id/temporary-password': {
    summary: 'Email a fresh temporary password',
    description:
      'For an account that never signed in - the mail went astray, or the 72 hours lapsed. ' +
      'Supersedes the previous password and revokes any session opened with it. Refused with ' +
      '409 once the holder has chosen their own; from then on the route back in is the reset ' +
      'they start themselves.',
    tags: ['Auth (Admin)'],
    auth: 'admin',
    permission: 'staff.write + role.assign',
    responses: {
      '200': ok(ref('CreateStaffResponse')),
      '409': ok(ref('ErrorEnvelope'), 'The account already has a password of its own'),
    },
  },

  // --- Public catalog ---
  'GET /api/v1/catalog/products': {
    summary: 'List published products',
    description:
      'Only Active + Published products in an active category. Sorting always ends with `id`, ' +
      'so pagination is stable.\n\n' +
      '`?currency=` chooses the price list and `?country=` (ISO-3166 alpha-2) chooses the tax ' +
      'position: the same euro row is quoted differently in Germany, the Netherlands and ' +
      'Ireland, and zero-rated to a destination outside the EU. `minPrice`/`maxPrice` are read ' +
      'in the same terms the prices come back in. An unreadable country is ignored rather than ' +
      'rejected; where the deployment has no EU VAT configured, prices are the listed figures.',
    tags: ['Catalog (Public)'],
    auth: 'none',
    responses: { '200': ok(ref('ProductListResponse')) },
  },
  'GET /api/v1/catalog/products/:slug': {
    summary: 'Product detail',
    description:
      'An unpublished product returns 404, indistinguishable from a missing one.\n\n' +
      'Takes the same `?currency=` and `?country=` as the listing, and prices identically — ' +
      'a shopper clicking a card must not watch the price change. `taxNote` states which ' +
      "country's VAT was applied and on what basis.",
    tags: ['Catalog (Public)'],
    auth: 'none',
    responses: { '200': ok(ref('ProductDetailResponse')), '404': ok(ref('ErrorEnvelope')) },
  },
  'GET /api/v1/catalog/categories': {
    summary: 'Category tree',
    tags: ['Catalog (Public)'],
    auth: 'none',
  },
  'POST /api/v1/catalog/image-search': {
    summary: 'Find products from a photograph (multipart)',
    description:
      'The only authenticated route under `/catalog`. Every other read here costs a database ' +
      'query; this one spends the operator\'s AI provider budget per call, so it sits behind ' +
      'the customer session for the same reason `/assistant/*` does. Rate limited to 12 in ' +
      'five minutes.\n\n' +
      'The image type is sniffed from magic bytes and the client `Content-Type` is ignored; ' +
      'SVG is refused. The bytes are sent to the provider and never stored.\n\n' +
      'This matches on what the model recognises the item to BE, against the published ' +
      'catalogue index — it is not a perceptual-similarity search over product photographs, ' +
      'and `description` is returned so the shopper can see how their picture was read. ' +
      'Products come back in the same shape and the same prices as the listing. ' +
      '503 `IMAGE_SEARCH_BUSY` is the provider over quota or overloaded; 502 ' +
      '`IMAGE_SEARCH_UNREADABLE` is a reply that could not be used. Neither is an outage.',
    tags: ['Catalog (Public)'],
    auth: 'customer',
    responses: {
      '200': ok(ref('ProductListResponse'), 'Plus `description` and `terms`; no pagination'),
      '404': ok(ref('ErrorEnvelope'), 'No AI provider is configured on this deployment'),
      '502': ok(ref('ErrorEnvelope'), 'IMAGE_SEARCH_UNREADABLE'),
      '503': ok(ref('ErrorEnvelope'), 'IMAGE_SEARCH_BUSY'),
    },
  },

  // --- Delivery (Public) ---

  'POST /api/v1/delivery/options': {
    summary: 'Which warehouses can deliver this basket to a country',
    description:
      'Reads the geofence from the other end: the destination is fixed and the answer is who ' +
      'can serve it, when, and for how much. Public, because a buyer asks it before they have ' +
      'an account.\n\n' +
      'A warehouse is offered only when all four hold: it is active, it can ship today ' +
      '(`OPERATIONAL` or `LIMITED` — never `MAINTENANCE` or `SUSPENDED`), its own delivery ' +
      'radius reaches the destination country measured against real country boundaries, and ' +
      'the operator has not closed that country on it. One that is in range but short of ' +
      'stock comes back under `partial` rather than being dropped, so a buyer who can split ' +
      'an order still sees it.\n\n' +
      '`leadTimeDays` and `fee` are null where the warehouse has not published them, and ' +
      'nothing is substituted — a delivery promise this software invented is a promise ' +
      'nobody agreed to. `isFastest` and `isCheapest` flag the extremes among the options ' +
      'that can fill the basket; `isCheapest` is false on all of them when two options quote ' +
      'in different currencies, because comparing those would need an exchange rate.\n\n' +
      '`items` may be omitted, which asks "who could ever deliver here". An empty `options` ' +
      'is a 200 and a real answer, not an error. `closedByOperator` is a count and never a ' +
      'list: a buyer has no business reading why a warehouse will not serve their country.\n\n' +
      'A POST because the basket does not belong in a query string or an access log, and ' +
      'there is no caching to lose — the answer depends on live stock.',
    tags: ['Delivery (Public)'],
    auth: 'none',
    responses: {
      '200': ok(undefined, 'Options, partials, and the destination as named by this deployment'),
      '400': ok(ref('ErrorEnvelope'), 'VALIDATION_FAILED — `countryCode` is not an ISO code'),
    },
  },

  // --- Assistant (AI Mode) ---
  //
  // The customer's own conversation history. Every one of these is scoped to
  // the caller's `customerProfileId`, taken from the session guard: a
  // conversation belonging to somebody else answers 404, never 403, so an id
  // reveals nothing about whose it is.
  'GET /api/v1/assistant/conversations': {
    summary: "The signed-in customer's AI Mode history",
    description: 'Most recently active first. Conversations with no messages are omitted.',
    tags: ['Assistant'],
    auth: 'customer',
  },
  'GET /api/v1/assistant/conversations/:id': {
    summary: 'One conversation in full',
    tags: ['Assistant'],
    auth: 'customer',
    responses: { '404': ok(ref('ErrorEnvelope'), 'Missing, not yours, or deleted') },
  },
  'PATCH /api/v1/assistant/conversations/:id': {
    summary: 'Rename a conversation',
    description: 'An empty `title` clears the name and restores the opening-question fallback.',
    tags: ['Assistant'],
    auth: 'customer',
  },
  'DELETE /api/v1/assistant/conversations/:id': {
    summary: "Remove a conversation from the customer's history",
    description:
      'A soft delete. It leaves every customer-facing read and cannot be continued, but the ' +
      'transcript survives for staff and for the retention sweep — what the AI told a buyer ' +
      'about a medical device is a record the deployment has to be able to produce. Erasure ' +
      'under Art. 17 is a different act with its own route, and that one deletes the rows.',
    tags: ['Assistant'],
    auth: 'customer',
  },

  // --- Admin catalog ---
  'POST /api/v1/admin/products': {
    summary: 'Create a product',
    description: 'Always created as an unpublished DRAFT. Publication is a separate action.',
    tags: ['Catalog (Admin)'],
    auth: 'admin',
    permission: 'product.write',
    requestBody: ref('CreateProductRequest'),
  },
  'PATCH /api/v1/admin/products/:id/publication': {
    summary: 'Publish or unpublish a product',
    description:
      'Publishing runs a completeness check and returns EVERY blocker at once in `details`, ' +
      'so the UI can render a checklist.',
    tags: ['Catalog (Admin)'],
    auth: 'admin',
    permission: 'product.publish',
    responses: {
      '200': ok(ref('PublicationResponse')),
      '422': ok(ref('ErrorEnvelope'), 'PRODUCT_INCOMPLETE_FOR_PUBLISH, with per-field blockers'),
    },
  },
  'POST /api/v1/admin/products/:id/media': {
    summary: 'Upload a product image (multipart)',
    description:
      'The type is sniffed from magic bytes; the client Content-Type is ignored. SVG is refused.',
    tags: ['Catalog (Admin)'],
    auth: 'admin',
    permission: 'media.upload',
  },

  // --- Cart and checkout ---
  'GET /api/v1/cart': {
    summary: 'Current cart, repriced',
    description:
      'The cart stores no prices. Every read reprices from the catalog and revalidates stock, ' +
      'publication and purchasing limits, returning per-line `issues`.',
    tags: ['Cart'],
    auth: 'customer',
    responses: { '200': ok(ref('CartResponse')) },
  },
  'POST /api/v1/cart/items': {
    summary: 'Add an item',
    tags: ['Cart'],
    auth: 'customer',
    requestBody: ref('AddCartItemRequest'),
    responses: { '201': ok(ref('CartResponse')) },
  },
  'POST /api/v1/cart/items/bulk': {
    summary: 'Add several options in one request',
    description:
      'For a customer buying more than one option of the same product - 3 ml and 5 ml of one ' +
      'syringe. Each option becomes its own cart line, and all of them are written in one ' +
      'transaction: either every line lands or none does. The same option twice in one request ' +
      'is added up rather than refused. At most 50 items.',
    tags: ['Cart'],
    auth: 'customer',
    requestBody: ref('AddCartItemsRequest'),
    responses: { '201': ok(ref('CartResponse')) },
  },
  'PATCH /api/v1/cart/items/:itemId': {
    summary: 'Change quantity (0 removes the line)',
    tags: ['Cart'],
    auth: 'customer',
    responses: { '200': ok(ref('CartResponse')) },
  },
  'POST /api/v1/cart/checkout': {
    summary: 'Submit the checkout',
    description:
      'Requires an `Idempotency-Key` header. The same key with the same body replays the first ' +
      'response; the same key with a DIFFERENT body is rejected.',
    tags: ['Cart'],
    auth: 'customer',
    idempotent: true,
    requestBody: ref('CheckoutRequest'),
    responses: {
      '201': ok(ref('CheckoutResponse')),
      '409': ok(ref('ErrorEnvelope'), 'Idempotency conflict, or a cart line needs attention'),
    },
  },

  // --- Orders ---
  'GET /api/v1/orders': {
    summary: 'The signed-in customer orders',
    description: 'Scoped by session. There is no endpoint that takes a customer id.',
    tags: ['Orders (Customer)'],
    auth: 'customer',
  },
  'GET /api/v1/orders/:id': {
    summary: 'Order detail with timeline',
    tags: ['Orders (Customer)'],
    auth: 'customer',
    responses: { '200': ok(ref('OrderDetail')), '404': ok(ref('ErrorEnvelope')) },
  },
  'GET /api/v1/admin/orders': {
    summary: 'All orders',
    tags: ['Orders (Admin)'],
    auth: 'admin',
    permission: 'order.read',
  },
  'GET /api/v1/admin/orders/:id': {
    summary: 'Order detail, including `availableTransitions`',
    description:
      'Render `availableTransitions` as the action buttons: what it offers is exactly what the ' +
      'API will accept for this actor.',
    tags: ['Orders (Admin)'],
    auth: 'admin',
    permission: 'order.read',
  },
  'POST /api/v1/admin/orders/:id/transition': {
    summary: 'Apply a status transition',
    description:
      'Guarded by the state machine. No admin can reach CONFIRMED - only a verified payment ' +
      'event does that.',
    tags: ['Orders (Admin)'],
    auth: 'admin',
    permission: 'per-transition; see availableTransitions',
    requestBody: ref('TransitionRequest'),
  },

  // --- Payments ---
  'POST /api/v1/payments/orders/:orderId/session': {
    summary: 'Start a payment for an order',
    description:
      'Returns the provider checkout payload. Contains no secret. The body is optional: with ' +
      'no gateway named, the one the customer chose at checkout is read from the order, and ' +
      'the configured default is used if they chose none. The amount is always the order’s.',
    tags: ['Payments'],
    auth: 'customer',
    idempotent: true,
    requestBody: ref('PaymentSessionRequest'),
    optionalBody: true,
    responses: { '201': ok(ref('PaymentSessionResponse')) },
  },
  'GET /api/v1/payments/gateways': {
    summary: 'Gateways the storefront may offer, and which to preselect',
    description:
      'Derived from what the operator has connected, so a gateway with no credentials never ' +
      'appears. `currencies` is the restriction to filter on — a gateway offered for money it ' +
      'cannot settle declines only after the customer has chosen it. Carries no secret.',
    tags: ['Payments'],
    auth: 'customer',
    responses: { '200': ok(ref('PaymentGatewaysResponse')) },
  },
  'GET /api/v1/payments/instruments': {
    summary: 'How a customer may pay for a cart in this currency',
    description:
      'What the storefront asks a customer, in the words they are shown: Credit Card, Debit ' +
      'Card, UPI. Deliberately names no gateway — which acquirer settles a payment is the ' +
      'operator’s business and is resolved from the instrument on the server. Reads the same ' +
      'connected-gateway state as /payments/gateways, so the two cannot disagree. ' +
      '`canSaveCard` says whether the card may be kept for next time; ' +
      '`savedCardsChargeableHere` is false on Razorpay, whose saved cards are picked inside ' +
      'its own sheet. The currency comes from the cart and is required.',
    tags: ['Payments'],
    auth: 'customer',
  },
  'GET /api/v1/payments/orders/:orderId/status': {
    summary: 'Poll payment status after returning from the provider',
    description:
      'Show "Processing" until this reports the order confirmed. A client redirect is never ' +
      'proof of payment - the webhook is.',
    tags: ['Payments'],
    auth: 'customer',
  },
  'POST /api/v1/payments/webhooks/:provider': {
    summary: 'Provider webhook',
    description:
      'Unauthenticated by design; the signature over the RAW body is the authority. Always ' +
      'answers 200, including for a rejected event, so the provider stops retrying.',
    tags: ['Payments'],
    auth: 'none',
  },
  'GET /api/v1/payments/links/:token': {
    summary: 'Open a payment link',
    description: 'The token is the authorisation. Single use, expiring, amount-bound.',
    tags: ['Payments'],
    auth: 'token',
  },
  'POST /api/v1/admin/orders/:id/refunds': {
    summary: 'Create a refund',
    description: 'Capped at captured minus already refunded, in the service, the database and the provider.',
    tags: ['Payments'],
    auth: 'admin',
    permission: 'refund.create',
    idempotent: true,
  },

  // --- Catalog (public) ---
  'GET /api/v1/catalog/product-cards': {
    summary: 'Resolve product references into verified cards',
    description:
      'Takes `?refs=` - comma-separated slugs or product codes, at most twelve - and answers ' +
      'with the same public product shape the listing uses, plus availability. What AI Mode ' +
      'renders under an answer: the assistant returns references and nothing else, so no name, ' +
      'price or image URL from generated text ever reaches a card. Unresolved references are ' +
      'named rather than dropped.',
    tags: ['Catalog (Public)'],
    auth: 'none',
  },

  // --- Recurring ---
  'POST /api/v1/recurring-schedules': {
    summary: 'Create a repeat-purchase schedule',
    description:
      'Requires explicit consent and recurring-eligible products. Times are wall-clock in the ' +
      'schedule timezone.',
    tags: ['Recurring'],
    auth: 'customer',
    requestBody: ref('CreateScheduleRequest'),
  },
  'GET /api/v1/recurring-schedules': {
    summary: 'The signed-in customer schedules',
    tags: ['Recurring'],
    auth: 'customer',
  },
  'PATCH /api/v1/recurring-schedules/:id': {
    summary: 'Change future runs of a schedule',
    description:
      'Items, quantities, frequency, start date, time of day, timezone, address and payment ' +
      'method. Absolute, not incremental - `items` replaces the basket - so a retried request ' +
      'lands on the same state rather than adding the change twice. Refused inside the edit ' +
      'cutoff and while a delivery is being processed; never touches an occurrence that has ' +
      'already produced an order.',
    tags: ['Recurring'],
    auth: 'customer',
  },
  'GET /api/v1/recurring-schedules/:id/estimate': {
    summary: 'What a schedule would cost if it ran now',
    description:
      'Priced by the same `quoteSchedule` the worker uses weeks later, so the figure on the ' +
      'screen and the figure on the card statement have one implementation. Stock and price ' +
      'problems come back in the body rather than as an error - they are what the customer ' +
      'needs told. An estimate, never a locked price.',
    tags: ['Recurring'],
    auth: 'customer',
  },
  'POST /api/v1/recurring-schedules/:id/hide': {
    summary: 'Take a finished schedule off my list',
    description:
      'A soft delete, not a delete: the row, its consent record, its occurrences and its orders ' +
      'all stay, staff still read them, and the GDPR export still discloses them. Only a ' +
      'CANCELLED or COMPLETED plan may be hidden - hiding a live one would mean money leaving ' +
      'an account for an arrangement the customer cannot see. Idempotent.',
    tags: ['Recurring'],
    auth: 'customer',
  },
  'POST /api/v1/recurring-schedules/:id/pause': {
    summary: 'Pause future runs',
    tags: ['Recurring'],
    auth: 'customer',
  },
  'DELETE /api/v1/recurring-schedules/:id': {
    summary: 'Cancel future runs',
    description: 'Completed orders are untouched.',
    tags: ['Recurring'],
    auth: 'customer',
  },

  'GET /api/v1/recurring-schedules/delivery-window': {
    summary: 'The earliest day a first delivery may be booked',
    description:
      'What the delivery-date picker greys out, and it is not something a browser can work ' +
      'out. Two inputs it does not have: the floor is counted on the delivery address’s own ' +
      'IANA zone where it has one, and a plan pinned to a warehouse cannot arrive sooner than ' +
      'that warehouse’s lane allows.\n\n' +
      'The answer is `max(today + SCHEDULE_MIN_NOTICE_DAYS, warehouse earliest)` as `earliest`, ' +
      'with both halves beside it so a message can name whichever one bound. ' +
      '`warehouseEarliest` is null on an `AUTO` plan, which has no warehouse yet — inventing ' +
      'one from the slowest lane in the business would hold every AUTO plan to a decision ' +
      'nobody has made.\n\n' +
      'Counted in calendar days on a wall clock, never in `7 * 86_400_000` milliseconds, so it ' +
      'does not shift a day twice a year in every zone that observes DST.\n\n' +
      'A GET, because it writes nothing and the screen re-asks it every time the address or ' +
      'the warehouse changes. It answers a date; it does not enforce one — `POST` and ' +
      '`PATCH` refuse a date inside the window with `SCHEDULE_DATE_TOO_SOON` whatever the ' +
      'browser did with this, which is what makes bypassing the picker pointless rather than ' +
      'profitable. Never cached: the floor moves at midnight in the customer’s own zone.',
    tags: ['Recurring'],
    auth: 'customer',
    responses: {
      '200': ok(undefined, '`earliest`, `noticeFloor`, `warehouseEarliest`, `timezone`, `noticeDays`'),
      '400': ok(ref('ErrorEnvelope'), 'VALIDATION_FAILED — no `shippingAddressId`'),
    },
  },

  // --- Fulfilment ---

  'POST /api/v1/fulfilment/warehouse-options': {
    summary: 'Which warehouses can fulfil this basket, and on what terms',
    description:
      'The buying half of `POST /delivery/options`. That one answers a browsing question from a ' +
      'country code and needs no account; this prices the signed-in customer’s own cart to ' +
      'one of their own addresses, and every option carries a `quoteId` that checkout will ' +
      'take.\n\n' +
      '**Every answer writes rows.** A quote is a stored offer with an expiry ' +
      '(`FULFILMENT_QUOTE_TTL_MINUTES`), which is what makes the total on the card the total on ' +
      'the order: the alternative is repricing at payment from ids the browser hands back, and ' +
      'two runs against a moving stock ledger produce two answers. That is why this is a POST ' +
      'with effects and why it is rate-limited.\n\n' +
      'A warehouse is offered only when all of these hold: active, able to ship today ' +
      '(`OPERATIONAL` or `LIMITED`), holding an active delivery zone that covers the ' +
      'destination country and postcode, not excluded from that country by the operator, ' +
      'holding enough of **every** line, satisfying the goods’ own cold-chain and weight ' +
      'restrictions, and quoting the cart’s currency. The map’s 100 km circle is a ' +
      'drawing, not a rule — eligibility comes from the configured zones.\n\n' +
      '**One warehouse per option, always.** A warehouse holding part of the basket is not an ' +
      'offer and never appears in `options`; it comes back under `ineligible` with the lines it ' +
      'is short of, because there is no approved split-fulfilment flow to send it to.\n\n' +
      '`isEstimate` marks an answer priced from `countryCode` because no address was given. It ' +
      'is a conversation, not an offer: `assertQuoteUsable` refuses such a quote at checkout ' +
      'with `FULFILMENT_QUOTE_INVALID`.\n\n' +
      '`isFastest`, `isCheapest` and `isRecommended` are decided here so no client has to ' +
      'invent a second opinion about which option is best. An empty `options` is a 200 and a ' +
      'real answer — with `ineligible` beside it saying why each warehouse the buyer might ' +
      'have expected is missing — not an error. Never cached.',
    tags: ['Fulfilment'],
    auth: 'customer',
    responses: {
      '200': ok(undefined, 'Options, the ones refused and why, and what the destination itself refuses'),
      '400': ok(ref('ErrorEnvelope'), 'CART_EMPTY, or neither an address nor a country'),
      '404': ok(ref('ErrorEnvelope'), 'ADDRESS_NOT_FOUND — not this customer’s address'),
      '409': ok(ref('ErrorEnvelope'), 'FULFILMENT_QUOTE_STALE — the basket sent is not the basket held'),
    },
  },
  'POST /api/v1/fulfilment/warehouse-options/:quoteId/revalidate': {
    summary: 'Is the option I chose still an offer?',
    description:
      'Asked by the checkout page immediately before Pay, so a page left open over lunch finds ' +
      'out where the customer can do something about it rather than at the moment money would ' +
      'move.\n\n' +
      'Answers 200 with `ok: false` and a code rather than throwing. A screen that has to catch ' +
      'an exception in order to render "this expired" is a screen that renders a stack trace ' +
      'one day, and re-asking for options is a normal flow rather than a fault. The codes are ' +
      'the ones checkout itself would raise: `FULFILMENT_QUOTE_EXPIRED`, `_QUOTE_INVALID`, ' +
      '`_QUOTE_STALE`, `_WAREHOUSE_UNAVAILABLE`, `_STOCK_CHANGED`.\n\n' +
      'It does not re-check the price. That is left to `submitCheckout`, which is where the ' +
      'basket is repriced — and a total that moved is refused there with the old and the new ' +
      'figure in the detail, never absorbed.',
    tags: ['Fulfilment'],
    auth: 'customer',
    responses: {
      '200': ok(undefined, '`ok`, and a code and message when it is false'),
      '400': ok(ref('ErrorEnvelope'), 'VALIDATION_FAILED — no `deliveryAddressId`'),
    },
  },

  // --- Customers ---
  'POST /api/v1/admin/customers': {
    summary: 'Create and invite a customer',
    description: 'The administrator never sets or sees a password.',
    tags: ['Customers (Admin)'],
    auth: 'admin',
    permission: 'customer.write + customer.invite',
    requestBody: ref('CreateCustomerRequest'),
  },
  'PATCH /api/v1/admin/customers/:id/limits': {
    summary: 'Change purchasing limits',
    tags: ['Customers (Admin)'],
    auth: 'admin',
    permission: 'customer.limits.write',
  },
  'POST /api/v1/admin/customers/:id/approve': {
    summary: 'Let a self-registered account in',
    description:
      'Moves a PENDING_APPROVAL account to ACTIVE and emails the holder that they can sign in. ' +
      'Refused with 409 EMAIL_NOT_VERIFIED while the confirmation link is unopened: approving ' +
      'then would hand a live account to whoever typed the address rather than to whoever owns ' +
      'it, which is the one thing the link exists to prevent. Distinct from PATCH /status, ' +
      'which suspends and restores an account already agreed to.',
    tags: ['Customers (Admin)'],
    auth: 'admin',
    permission: 'customer.status.write',
    responses: {
      '200': ok(ref('ApproveCustomerResponse')),
      '409': ok(ref('ErrorEnvelope'), 'Already active, never self-registered, or unconfirmed'),
    },
  },
  'GET /api/v1/account/profile': {
    summary: 'The signed-in customer profile and spend summary',
    description:
      'Also carries whatever contact change is waiting to be confirmed — `pendingEmail` and ' +
      '`pendingPhone` — because the profile screen has to render the pending value beside the ' +
      'live one, and two reads for one panel is two chances for them to disagree on screen.',
    tags: ['Account'],
    auth: 'customer',
  },

  // --- Changing the two things that identify the account ---
  //
  // Neither endpoint takes effect on its own. The requested value is parked in
  // `users.pendingEmail` / `users.pendingPhone`, a single-use link is minted,
  // and only consuming that link promotes it. `users.email` is what the
  // account signs in with and where every order confirmation, payment link and
  // invoice is sent, so one typo written straight into it locks somebody out
  // of their own purchasing account with no way back in.
  'POST /api/v1/account/email-change': {
    summary: 'Ask to move the account to a new email address',
    description:
      'Answers 202 — accepted, not done. Two emails are sent: the confirmation link to the new ' +
      'address, and a warning with no link to the address the account still uses, which is what ' +
      'reaches the real holder if somebody else has got into the account. Refuses with ' +
      'EMAIL_ALREADY_IN_USE when another account signs in with, or is already moving to, that ' +
      'address — deliberately the same answer in both cases, so this is not an oracle for ' +
      'whether a given company buys here.',
    tags: ['Account'],
    auth: 'customer',
  },
  'POST /api/v1/account/email-change/confirm': {
    summary: 'Confirm a new email address',
    description:
      'Promotes the pending address, marks it verified and revokes EVERY session including the ' +
      'caller’s: the address is the sign-in identity, so a token minted against the old one is ' +
      'a credential for an account that no longer exists under that name. Uniqueness is checked ' +
      'again here, because minutes have passed since the request.',
    tags: ['Account'],
    auth: 'customer',
  },
  'DELETE /api/v1/account/email-change': {
    summary: 'Abandon a pending email change',
    tags: ['Account'],
    auth: 'customer',
  },
  'POST /api/v1/account/phone-change': {
    summary: 'Ask to change the telephone number on the account',
    description:
      'The confirmation link is sent to the account’s EMAIL address, not to the number: this ' +
      'installation has no SMS driver. Following it proves control of the account, which is what ' +
      'stops somebody else altering the number; it does not prove control of the number itself.',
    tags: ['Account'],
    auth: 'customer',
  },
  'POST /api/v1/account/phone-change/confirm': {
    summary: 'Confirm a new telephone number',
    description:
      'Moves both copies — `users.phone` on the identity and `customer_profiles.phone` on the ' +
      'delivery contact — and leaves the sessions alone, because a number is not the sign-in ' +
      'identity.',
    tags: ['Account'],
    auth: 'customer',
  },
  'DELETE /api/v1/account/phone-change': {
    summary: 'Abandon a pending telephone change',
    tags: ['Account'],
    auth: 'customer',
  },

  // --- Closing the account ---
  'GET /api/v1/account/closure': {
    summary: 'What closing this account would do',
    description:
      'The customer’s own live arrangements: how many scheduled orders would be paused, whether ' +
      'a charging authority would be withdrawn, and how many orders are still owed. Read by the ' +
      'confirmation dialog so the warning names real numbers rather than describing the feature.',
    tags: ['Account'],
    auth: 'customer',
  },
  'POST /api/v1/account/deactivate': {
    summary: 'Close the account, from the holder’s own side',
    description:
      'Requires the current password. Pauses every ACTIVE scheduled order through the schedule ' +
      'state machine, withdraws auto-pay, sets the user DEACTIVATED and revokes every session — ' +
      'in that order, because a deactivated account with a live mandate and a live schedule is a ' +
      'worker charging somebody weeks after they closed their account. Nothing is deleted. ' +
      'Erasure is a different act with its own route: POST /account/data-requests with ERASURE.',
    tags: ['Account'],
    auth: 'customer',
  },

  // --- Coupons, notifications and saved lines ---
  'GET /api/v1/account/coupons': {
    summary: 'Coupons this customer can use, and the ones they have used',
    description:
      'The available list is the same `listPublicCoupons` the cart reads, so a code offered here ' +
      'is a code the cart will accept. It deliberately does not say whether a coupon is ' +
      'eligible: eligibility depends on what is in the basket, and only the cart can evaluate ' +
      'that. The minimum order value is stated instead.',
    tags: ['Account'],
    auth: 'customer',
  },
  'GET /api/v1/account/notifications': {
    summary: 'What this deployment has sent to this customer',
    description:
      'Outbox rows matched on the recipient address, and only those actually SENT — a queued ' +
      'message has not arrived and a failed one never will. The message BODY is never returned: ' +
      'these are rendered emails and several carry a single-use link, so a list endpoint that ' +
      'handed them back would turn one borrowed session into every live link the account has ' +
      'ever been sent.',
    tags: ['Account'],
    auth: 'customer',
  },
  'GET /api/v1/account/wishlist': {
    summary: 'Lines saved without buying them',
    description:
      'Priced through the same shelf-pricing path as the catalogue, so a saved line carries the ' +
      'destination’s tax like every other figure on the storefront. A line whose product has ' +
      'been unpublished, or is not priced in the currency asked for, is returned with ' +
      '`isAvailable` false and a null price rather than being hidden.',
    tags: ['Account'],
    auth: 'customer',
  },
  'POST /api/v1/account/wishlist': {
    summary: 'Save a line for later',
    description:
      'Idempotent: saving something already saved answers 200 with the same id, because pressing ' +
      'a heart that is already filled in is the customer getting what they wanted. Refuses a ' +
      'product that is not publicly visible, so this is not a way to probe for product ids in a ' +
      'catalogue the caller cannot browse.',
    tags: ['Account'],
    auth: 'customer',
  },
  'DELETE /api/v1/account/wishlist/:itemId': {
    summary: 'Remove a saved line',
    description: 'Scoped to the caller’s own profile; another customer’s line is not found.',
    tags: ['Account'],
    auth: 'customer',
  },

  // --- Reports ---
  'GET /api/v1/admin/dashboard': {
    summary: 'Dashboard aggregates',
    description: 'Every figure is a database aggregate. Never sum a paginated page.',
    tags: ['Reports'],
    auth: 'admin',
    permission: 'report.read',
  },
  // --- Console notifications ---
  'GET /api/v1/admin/notifications': {
    summary: 'The console bell feed',
    description:
      'Personal to the caller: rows carry the permission needed to see them, and read state is ' +
      'per member of staff. No permission is declared on the route for that reason - two people ' +
      'calling it get different rows.',
    tags: ['Reports'],
    auth: 'admin',
    responses: { '200': ok(ref('AdminNotificationFeed')) },
  },
  'POST /api/v1/admin/notifications/read': {
    summary: 'Mark notifications read',
    description: 'Idempotent, and only for the caller. Ids the caller cannot see are ignored.',
    tags: ['Reports'],
    auth: 'admin',
    requestBody: ref('MarkNotificationsReadRequest'),
  },
  'POST /api/v1/admin/notifications/read-all': {
    summary: 'Mark the whole visible feed read',
    tags: ['Reports'],
    auth: 'admin',
  },

  'POST /api/v1/admin/exports': {
    summary: 'Request an asynchronous export',
    description: 'Returns a job id. Poll `/admin/exports/:id` for the download token.',
    tags: ['Reports'],
    auth: 'admin',
    permission: 'export.create',
  },
  'GET /api/v1/exports/download/:token': {
    summary: 'Download an export',
    description: 'Hashed, expiring, requester-scoped token. Works without a session.',
    tags: ['Reports'],
    auth: 'token',
  },

  // --- EU VAT and invoicing ---
  'GET /api/v1/admin/vat-rates': {
    summary: 'VAT rate periods, with the member states flagged',
    description:
      'Each row carries the date it starts, and `inForce` says which one a sale today would ' +
      'use. `seller.euVatActive` is false until the business profile names a `vatCountry`, ' +
      'and while it is false every order is taxed at its tax class’s own flat rate.',
    tags: ['VAT'],
    auth: 'admin',
    permission: 'settings.read',
  },
  'POST /api/v1/admin/vat-rates': {
    summary: 'Add a VAT rate period',
    description:
      'Rates are added, never edited. A member state that changes its rate gets a new period ' +
      'with a later start date, so every invoice already raised keeps the rate it was raised ' +
      'at. Re-using a start date for the same country and band is a conflict, not an update.',
    tags: ['VAT'],
    auth: 'admin',
    permission: 'settings.write',
    requestBody: json({
      type: 'object',
      required: ['countryCode', 'category', 'ratePercent'],
      properties: {
        countryCode: { type: 'string', minLength: 2, maxLength: 2, example: 'DE' },
        category: {
          type: 'string',
          enum: ['STANDARD', 'REDUCED', 'SUPER_REDUCED', 'ZERO', 'EXEMPT'],
        },
        // A string all the way to the Decimal column: a tax rate must never
        // pass through binary floating point.
        ratePercent: { type: 'string', example: '19' },
        label: { type: 'string', maxLength: 128, nullable: true },
        validFrom: { type: 'string', format: 'date' },
        validTo: { type: 'string', format: 'date', nullable: true },
      },
    }),
  },
  'PATCH /api/v1/admin/vat-rates/:id': {
    summary: 'Close a VAT rate period',
    description:
      'Sets the date a rate stopped applying. The percentage itself cannot be changed - every ' +
      'invoice raised while it was in force states it.',
    tags: ['VAT'],
    auth: 'admin',
    permission: 'settings.write',
    requestBody: json({
      type: 'object',
      required: ['validTo'],
      properties: { validTo: { type: 'string', format: 'date', nullable: true } },
    }),
  },
  'POST /api/v1/admin/customers/:id/vat-number/check': {
    summary: 'Check this customer’s VAT number against VIES',
    description:
      'Skips the cache. Three outcomes, not two: `isValid` true, false, or null with an ' +
      '`unavailableReason` when the member state could not be reached - a timeout is not a ' +
      '"no". Only a confirmed number zero-rates a cross-border supply; unverified is taxed. ' +
      'The `consultationNumber` is the Art. 31 Reg. 904/2010 evidence that the seller relied ' +
      'on an official answer.',
    tags: ['VAT'],
    auth: 'admin',
    permission: 'customer.write',
  },
  'GET /api/v1/admin/orders/:id/invoice': {
    summary: 'The invoice for an order',
    description: 'Null when none has been raised.',
    tags: ['Invoicing'],
    auth: 'admin',
    permission: 'invoice.read',
  },
  'POST /api/v1/admin/orders/:id/invoice': {
    summary: 'Raise the invoice for an order',
    description:
      'Idempotent by order: asking twice returns the invoice that exists. Two numbers against ' +
      'one supply is a real problem to unpick once both are in a VAT return. Refused for an ' +
      'order that was never supplied - a draft or a cancellation has nothing to invoice.',
    tags: ['Invoicing'],
    auth: 'admin',
    permission: 'invoice.issue',
  },
  'GET /api/v1/admin/invoices/:id': {
    summary: 'One invoice or credit note',
    tags: ['Invoicing'],
    auth: 'admin',
    permission: 'invoice.read',
  },
  'POST /api/v1/admin/invoices/:id/credit': {
    summary: 'Reverse an invoice with a credit note',
    description:
      'The only correction an invoice sequence permits. There is no edit and no delete: a gap ' +
      'in the numbering reads to a tax inspector as a destroyed document, so the original ' +
      'stands and a second document of equal and opposite value is issued against it.',
    tags: ['Invoicing'],
    auth: 'admin',
    permission: 'invoice.issue',
  },
  'GET /api/v1/admin/invoices/:id/ubl': {
    summary: 'The invoice as EN 16931 UBL',
    description:
      'Peppol BIS Billing 3.0 syntax - the bytes an access point, the Italian SdI or Chorus ' +
      'Pro expects to be handed. Served as an attachment because it is a document to file or ' +
      'forward. Transporting it is a separate step this software does not perform.',
    tags: ['Invoicing'],
    auth: 'admin',
    permission: 'invoice.read',
  },
  'GET /api/v1/admin/invoices/:id/en16931-check': {
    summary: 'What a receiver’s validator would object to',
    description:
      'The EN 16931 business rules that can be checked from our own data, named by rule so ' +
      'the answer can be looked up. Run before sending rather than after being rejected: ' +
      'every issue it reports is a missing value somebody can go and fill in.',
    tags: ['Invoicing'],
    auth: 'admin',
    permission: 'invoice.read',
  },
  'GET /api/v1/orders/:id/invoice': {
    summary: 'The customer’s own invoice',
    description: 'Scoped to the signed-in customer’s orders. Null when none has been raised.',
    tags: ['Orders (Customer)'],
    auth: 'customer',
  },

  // --- Product safety (GPSR) ---
  'GET /api/v1/admin/economic-operators': {
    summary: 'Manufacturers, importers and EU responsible persons',
    description:
      'The companies named on listings under Regulation (EU) 2023/988. Kept apart from the ' +
      'catalogue because one manufacturer supplies dozens of lines and its registered address ' +
      'changes as a company detail, not as a catalogue edit.',
    tags: ['Product safety'],
    auth: 'admin',
    permission: 'product.read',
  },
  'POST /api/v1/admin/economic-operators': {
    summary: 'Add an economic operator',
    tags: ['Product safety'],
    auth: 'admin',
    permission: 'product.write',
    requestBody: json({
      type: 'object',
      required: ['role', 'legalName', 'address', 'countryCode', 'email'],
      properties: {
        role: { type: 'string', enum: ['MANUFACTURER', 'EU_RESPONSIBLE_PERSON', 'IMPORTER'] },
        legalName: { type: 'string', maxLength: 255 },
        tradeName: { type: 'string', maxLength: 255, nullable: true },
        address: { type: 'object' },
        countryCode: { type: 'string', minLength: 2, maxLength: 2 },
        // Art. 19(a) calls this the "electronic address" and does not make it
        // optional: a manufacturer a buyer cannot write to has not been named.
        email: { type: 'string', format: 'email' },
        phone: { type: 'string', maxLength: 32, nullable: true },
        website: { type: 'string', format: 'uri', nullable: true },
        isActive: { type: 'boolean' },
      },
    }),
  },
  'PATCH /api/v1/admin/economic-operators/:id': {
    summary: 'Update an economic operator',
    tags: ['Product safety'],
    auth: 'admin',
    permission: 'product.write',
  },
  'DELETE /api/v1/admin/economic-operators/:id': {
    summary: 'Retire an economic operator',
    description:
      'Refused while any product still names it, with the count. A listing whose manufacturer ' +
      'row vanished would be offering a product with nobody named, which is the exact state ' +
      'GPSR Art. 19 forbids.',
    tags: ['Product safety'],
    auth: 'admin',
    permission: 'product.write',
  },
  'GET /api/v1/admin/products/:id/safety': {
    summary: 'The GPSR Art. 19 checklist for one product',
    description:
      'The same assessment publication runs, returned whether or not enforcement is on. ' +
      'The "enforced" flag says whether these gaps currently block anything, which is what ' +
      'lets an operator cost the work before switching enforcement on. Missing warning ' +
      'translations never block: a warning in the base language still publishes.',
    tags: ['Product safety'],
    auth: 'admin',
    permission: 'product.read',
  },
  'GET /api/v1/admin/products/:id/device': {
    summary: 'The MDR checklist for one product, and its device record',
    description:
      'Regulation (EU) 2017/745, for the part of it a catalogue holds: the class, the ' +
      'identifiers, the intended purpose and the declaration a buyer can open. Most of a ' +
      'catalogue is not a device, and the answer then is "notADevice" rather than a pass - ' +
      'a product this regulation never reaches has not satisfied anything.',
    tags: ['Product safety'],
    auth: 'admin',
    permission: 'product.read',
  },
  'PUT /api/v1/admin/products/:id/device': {
    summary: 'Mark a product as a medical device, or update its record',
    description:
      'An upsert: whether a device row already exists is not something a caller should have ' +
      'to know before it can save. The class decides whether a notified body number is ' +
      'required, so a sterile or measuring device declared as plain Class I is refused.',
    tags: ['Product safety'],
    auth: 'admin',
    permission: 'product.write',
  },
  'DELETE /api/v1/admin/products/:id/device': {
    summary: 'Stop treating a product as a medical device',
    description:
      'Deletes the record: class, identifiers and intended purpose go with it, and the ' +
      'storefront stops showing them. Not an archive, because a device record that is no ' +
      'longer true is not history worth keeping on a listing.',
    tags: ['Product safety'],
    auth: 'admin',
    permission: 'product.write',
  },
  'GET /api/v1/admin/settings/processors': {
    summary: 'Who this deployment actually shares data with',
    description:
      'Derived from the environment, not from a maintained list. GDPR Art. 30(1)(d) asks for ' +
      'the categories of recipient and Arts. 44-49 for a transfer mechanism for anyone outside ' +
      'the EEA; a register kept in a document cannot notice that somebody set an AI key last ' +
      'Tuesday. Inactive recipients are reported too, so the output can be diffed against the ' +
      'register. It knows only about integrations this codebase makes itself — a logging ' +
      'proxy, a managed database or a backup target are recipients it cannot see.',
    tags: ['Settings'],
    auth: 'admin',
    permission: 'settings.read',
  },

  // --- Data protection ---
  //
  // The subject side needs no permission: the session already proves the
  // person asking is the person being asked about, which is the identity check
  // Art. 12(6) is concerned with.
  'GET /api/v1/account/data-requests': {
    summary: 'The signed-in customer’s data subject requests',
    description:
      'Includes a live download token for a completed export, so a page reload does not lose ' +
      'the link. Null once the window has closed.',
    tags: ['Account'],
    auth: 'customer',
  },
  'POST /api/v1/account/data-requests': {
    summary: 'Exercise a data subject right',
    description:
      'EXPORT (GDPR Art. 15 and 20) is fulfilled automatically and answers 202. ERASURE ' +
      '(Art. 17) is queued for a decision by staff, because Art. 17(3) has exemptions that ' +
      'need a person to weigh. One open request of each type at a time - a second does not ' +
      'restart the one-month clock in Art. 12(3).',
    tags: ['Account'],
    auth: 'customer',
    requestBody: json({
      type: 'object',
      required: ['type'],
      properties: {
        type: { type: 'string', enum: ['EXPORT', 'ERASURE'] },
        note: { type: 'string', maxLength: 1024, nullable: true },
      },
    }),
  },
  'GET /api/v1/my-data/download/:token': {
    summary: 'Download a personal data bundle',
    description:
      'Hashed, expiring, subject-scoped token, so the link in the email works without a ' +
      'session. Served as an attachment: the file is every personal fact held about one ' +
      'person, and must never render inline in the API’s own origin.',
    tags: ['Account'],
    auth: 'token',
  },
  'GET /api/v1/admin/data-requests': {
    summary: 'The data subject request queue',
    description: 'Ordered by deadline, not arrival - the queue exists to stop Art. 12(3) breaches.',
    tags: ['Data protection'],
    auth: 'admin',
    permission: 'data_request.read',
  },
  'GET /api/v1/admin/data-requests/:requestId': {
    summary: 'One data subject request, with its erasure blockers',
    description:
      'Recomputes what stands in the way of a pending erasure - unpaid orders, open returns - ' +
      'so the decision is made against the position now rather than when the row was written.',
    tags: ['Data protection'],
    auth: 'admin',
    permission: 'data_request.read',
  },
  'POST /api/v1/admin/data-requests/:requestId/approve': {
    summary: 'Approve a data subject request',
    description:
      'Answers 202: the work is queued, because an erasure rewrites rows across a dozen ' +
      'tables and must not depend on the browser staying connected.',
    tags: ['Data protection'],
    auth: 'admin',
    permission: 'data_request.action',
    requestBody: json({
      type: 'object',
      properties: { note: { type: 'string', maxLength: 1024, nullable: true } },
    }),
  },
  'POST /api/v1/admin/data-requests/:requestId/reject': {
    summary: 'Refuse a data subject request',
    description:
      'The reason is required. Art. 12(4) obliges the controller to tell the subject why and ' +
      'that they may complain to a supervisory authority, so a refusal with an empty reason ' +
      'is one that cannot lawfully be sent.',
    tags: ['Data protection'],
    auth: 'admin',
    permission: 'data_request.action',
    requestBody: json({
      type: 'object',
      required: ['note'],
      properties: { note: { type: 'string', minLength: 1, maxLength: 1024 } },
    }),
  },

  // --- A buyer's own ERP -------------------------------------------------
  //
  // Everything under /account/integrations/erp is scoped to the CALLER'S OWN
  // buyer organisation, which the server derives from the session. There is no
  // organisation id in any path or body on this surface, and a generated client
  // should not expect to be able to supply one: an id belonging to another
  // tenant is answered with 404, not 403, because confirming that a connection
  // exists but belongs to somebody else still leaks its existence.
  //
  // No response on this surface ever carries a credential. What comes back is
  // `credentials`, a list of hints - `X-API-Key: sk_live...9f2a` - which is
  // enough to recognise which key is configured and never enough to use it.
  'GET /api/v1/account/integrations/erp/options': {
    summary: 'What can be connected, and how',
    description:
      'The catalogue of named ERPs (`presets`) ordered for the market named in `region`, ' +
      'the four connectors underneath them with their authentication methods, default ' +
      'endpoints and mappings, the mappable platform fields, and the OAuth redirect ' +
      'address to register with your own ERP. A preset is a BRAND and a connector is a ' +
      'PROTOCOL: several brands share one, so `preset.connector` is what a created ' +
      'connection sends as `system`, and `preset.id` is what it sends as `vendorPreset`. ' +
      'Also reports whether the store offers the feature at all, so a screen can say so ' +
      'rather than guessing at a 403.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'GET /api/v1/account/integrations/erp/warehouses': {
    summary: 'Warehouses available to map against your plants',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'GET /api/v1/account/integrations/erp/organization': {
    summary: 'Your buyer organisation, its members and its open invitations',
    description:
      'Provisioned on first use, with the caller as its owner. `invites` is null rather ' +
      'than empty for anybody who may not see them, so a screen does not render "none ' +
      'pending" to somebody who simply cannot look.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'PATCH /api/v1/account/integrations/erp/organization': {
    summary: 'Rename your organisation',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'POST /api/v1/account/integrations/erp/organization/invites': {
    summary: 'Invite somebody into your organisation',
    description:
      'Sends a single-use link that expires. The token is stored only as a SHA-256, and is ' +
      'refused unless redeemed by an account signed in as the address it was sent to. The ' +
      'answer is the same whether or not that address already has an account here.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'DELETE /api/v1/account/integrations/erp/organization/invites/:inviteId': {
    summary: 'Withdraw an invitation',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'POST /api/v1/account/integrations/erp/organization/join': {
    summary: 'Accept an invitation',
    description:
      'Five ways this fails - no such token, expired, withdrawn, already used, addressed to ' +
      'somebody else - and one answer for all five. Distinguishing them would turn this into ' +
      'a way to test whether a given address has been invited to a given organisation.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'PATCH /api/v1/account/integrations/erp/organization/members/:memberId': {
    summary: 'Change what a member may do',
    description:
      'Owner only. Demoting the last owner is refused: an organisation with no owner has ' +
      'nobody who can grant anybody access to it.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'DELETE /api/v1/account/integrations/erp/organization/members/:memberId': {
    summary: 'Remove somebody from your organisation',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'GET /api/v1/account/integrations/erp/connections': {
    summary: 'Your connections and their health',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'POST /api/v1/account/integrations/erp/connections': {
    summary: 'Create a connection',
    description:
      'Created as a DRAFT: no traffic, no jobs, not selectable by anything. Secrets go in ' +
      '`secrets` and are never returned. The address is refused unless it is HTTPS and ' +
      'resolves to a publicly routable host - see `outbound-http.ts`.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'GET /api/v1/account/integrations/erp/connections/:id': {
    summary: 'One connection',
    description:
      'The shape depends on your role. A member receives health and history; an owner or ' +
      'integration manager also receives configuration. A member is sent a NARROWER shape ' +
      'rather than the full one with fields blanked.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'PATCH /api/v1/account/integrations/erp/connections/:id': {
    summary: 'Change a connection',
    description:
      'Returns it to DRAFT and clears its passing test and checked mapping: whatever the ' +
      'last test proved, it proved about settings that have just been replaced. A secret ' +
      'field that is ABSENT keeps the stored secret; an empty string clears it.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'DELETE /api/v1/account/integrations/erp/connections/:id': {
    summary: 'Remove a connection',
    description:
      'Soft delete. Credentials are destroyed; the row and its event history survive, so ' +
      'what became of an order can still be answered.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'PUT /api/v1/account/integrations/erp/connections/:id/endpoints': {
    summary: 'Set which address does what',
    description:
      'Each path must resolve to the same origin as the connection. An endpoint free to ' +
      'name a different host is a server-side request forgery primitive with a form field ' +
      'in front of it.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'PUT /api/v1/account/integrations/erp/connections/:id/mappings': {
    summary: 'Set the field mapping',
    description:
      'Platform field names come from a published closed list. Transforms are named and ' +
      'closed too: a mapping that could run an expression would be a code execution ' +
      'primitive somebody types into a form.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'PUT /api/v1/account/integrations/erp/connections/:id/warehouses': {
    summary: 'Map warehouses to plants',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'PUT /api/v1/account/integrations/erp/connections/:id/policy': {
    summary: 'Set the sync rules',
    description:
      'Direction, source of truth, conflict policy, which events to send, and whether a ' +
      'stock write needs a person. `approvalThresholdMinor` is minor units as a STRING. A ' +
      'sandbox connection cannot be set to write stock automatically.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'POST /api/v1/account/integrations/erp/connections/:id/test': {
    summary: 'Call your system and report what happened',
    description:
      'Always a READ - a test that created a purchase order to prove it could is a test ' +
      'nobody dares press twice. Returns one real record so the field mapping can be ' +
      'checked against your own data.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'POST /api/v1/account/integrations/erp/connections/:id/dry-run': {
    summary: 'Rehearse a sync without writing anything',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'POST /api/v1/account/integrations/erp/connections/:id/activate': {
    summary: 'Switch the connection on',
    description:
      'Refused unless a test has passed, the mapping has been checked against a real ' +
      'response, and an endpoint exists for everything the rules say will be sent.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'POST /api/v1/account/integrations/erp/connections/:id/pause': {
    summary: 'Pause the connection',
    description:
      'Automatic writes stop immediately. Queued events are HELD, not dropped, and are ' +
      'sent when it resumes. Inbound deliveries are refused while it lasts.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'POST /api/v1/account/integrations/erp/connections/:id/resume': {
    summary: 'Resume a paused connection',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'POST /api/v1/account/integrations/erp/connections/:id/reconnect': {
    summary: 'Bring a failed or disconnected connection back',
    description: 'Lands in DRAFT: coming back goes through the same door as arriving.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'POST /api/v1/account/integrations/erp/connections/:id/disconnect': {
    summary: 'Disconnect and destroy the stored credentials',
    description:
      'Tokens are revoked where your system offers an endpoint, and every credential row is ' +
      'deleted either way. The history stays.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'POST /api/v1/account/integrations/erp/connections/:id/sync': {
    summary: 'Read your system now',
    description: 'Accepted with 202. One pass at a time per connection.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'POST /api/v1/account/integrations/erp/connections/:id/oauth/start': {
    summary: 'Begin an OAuth authorisation',
    description:
      'Returns the URL rather than redirecting: a 302 in an XHR response is followed by the ' +
      'fetch, so the person would never see their own consent screen. Uses PKCE even ' +
      'though this is a confidential client, because the code travels through their browser.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'POST /api/v1/account/integrations/erp/oauth/callback': {
    summary: 'Finish an OAuth authorisation',
    description:
      'Posted by the storefront callback page, which is where the ERP redirects the browser. ' +
      '`connectionId` is optional and normally omitted: the ERP returns only `code` and ' +
      '`state`, so the connection is recovered from the state this server issued. The state ' +
      'must be unused, unexpired, belong to that connection, and belong to the member who ' +
      'started the flow - without that last check a leaked authorisation URL would let ' +
      'somebody bind their own ERP account to this buyer\'s connection.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'POST /api/v1/account/integrations/erp/connections/:id/reconcile': {
    summary: 'Compare the buyer’s catalogue against ours',
    description:
      'Three sets: products in both, codes only in their system, and products only here. A ' +
      'POST because it walks their paged feed through the connector the sync uses, and a GET ' +
      'would be re-run by every refresh and prefetch. Matching is on SKU exactly - a ' +
      'reconciliation that guessed would attach a stock figure to the wrong product and be ' +
      'believed. Counts are complete; the rows are a sample.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'POST /api/v1/account/integrations/erp/openapi/import': {
    summary: 'Suggest endpoints from an OpenAPI document',
    description:
      'Suggestions only. Nothing is saved: an importer that configured a connection from a ' +
      'file would be trusting a document to decide which addresses this server calls.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'GET /api/v1/account/integrations/erp/events': {
    summary: 'The activity log',
    description:
      'Keyset pagination on `createdAt` - pass `before` from `nextBefore`. Searchable by ' +
      'correlation ID, ERP reference, order id and idempotency key, which are the four ' +
      'things somebody actually has in front of them.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'POST /api/v1/account/integrations/erp/events/:eventId/retry': {
    summary: 'Send a failed or skipped item again',
    description:
      'Reuses the SAME row and the SAME idempotency key, so retrying cannot produce a ' +
      'second purchase order. An item that already succeeded cannot be retried at all.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'GET /api/v1/account/integrations/erp/jobs': {
    summary: 'Sync history',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'GET /api/v1/account/integrations/erp/webhook-events': {
    summary: 'Deliveries from your system, accepted and refused',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'GET /api/v1/account/integrations/erp/approvals': {
    summary: 'Things waiting for somebody to decide',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'POST /api/v1/account/integrations/erp/approvals/:approvalId': {
    summary: 'Approve or decline',
    description:
      'Approving re-queues the same event under the same idempotency key. Declining is ' +
      'final for that event. Money is minor units as a STRING.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'GET /api/v1/account/integrations/erp/audit': {
    summary: 'Your organisation’s own audit trail',
    description:
      'Who changed what, and when. Secret VALUES are never recorded; the key is, so "the ' +
      'client secret was rotated" stays visible.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },
  'GET /api/v1/account/integrations/erp/connections/:id/links': {
    summary: 'Orders and invoices this connection has linked',
    description:
      '`onOrderQty` and `receivedQty` are separate on purpose: confirming an order moves ' +
      'the first, and only a goods receipt moves the second.',
    tags: ['Customer ERP'],
    auth: 'customer',
  },

  // Inbound, from a buyer's ERP. Unauthenticated in the session sense because
  // the caller is a machine with no session; authenticated in substance by an
  // HMAC over the raw bytes, a signed timestamp inside a replay window, and an
  // unguessable per-connection path.
  'POST /api/v1/erp-inbound/:slug': {
    summary: 'Receive a delivery from a buyer’s ERP',
    description:
      'Signature over the RAW bytes, verified in constant time. There is no unsigned mode. ' +
      'Every failure answers the same way, with no indication of which check failed. A ' +
      'redelivery is a 200, because an ERP that gets a 4xx for one retries harder.',
    tags: ['Customer ERP'],
    auth: 'token',
  },

  // Support monitoring. Read-only, and returns no credential, no hint, no
  // endpoint path and no request or response body - see that route file.
  'GET /api/v1/admin/customer-erp/connections': {
    summary: 'Every customer’s ERP connection, with its health',
    tags: ['Customer ERP (Support)'],
    auth: 'admin',
    permission: 'integration.read',
  },
  'GET /api/v1/admin/customer-erp/connections/:id/events': {
    summary: 'One customer connection’s recent events',
    description:
      'Error codes, safe messages, statuses and timings. Deliberately NOT the request or ' +
      'response bodies, which hold the customer’s own SKUs, quantities and prices.',
    tags: ['Customer ERP (Support)'],
    auth: 'admin',
    permission: 'integration.read',
  },
  'GET /api/v1/admin/customer-erp/connections/:id/deliveries': {
    summary: 'Inbound deliveries on one customer connection',
    tags: ['Customer ERP (Support)'],
    auth: 'admin',
    permission: 'integration.read',
  },
  'GET /api/v1/admin/customer-erp/summary': {
    summary: 'How many customer connections, in what state',
    tags: ['Customer ERP (Support)'],
    auth: 'admin',
    permission: 'integration.read',
  },
});

/** Shared component schemas. */
const SCHEMAS: Readonly<Record<string, unknown>> = Object.freeze({
  /**
   * Every failure in the API has this shape, including 500s.
   * `code` is a stable contract - map it to a message in the UI.
   */
  ErrorEnvelope: {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message', 'details', 'correlationId'],
        properties: {
          code: { type: 'string', example: 'QUANTITY_BELOW_MINIMUM' },
          message: { type: 'string' },
          details: { type: 'array', items: ref('ErrorDetail') },
          correlationId: { type: 'string', description: 'Quote this when reporting a problem.' },
        },
      },
    },
  },

  ErrorDetail: {
    type: 'object',
    properties: {
      field: { type: 'string', description: 'Dotted path, e.g. `items.0.quantity`.' },
      code: { type: 'string' },
      message: { type: 'string' },
      meta: { type: 'object', additionalProperties: true },
    },
  },

  /**
   * Money NEVER crosses this API as a number. `minor` is an integer count of
   * the currency's minor unit as a string; do arithmetic on it with BigInt.
   */
  Money: {
    type: 'object',
    required: ['minor', 'formatted', 'currency'],
    properties: {
      minor: { type: 'string', example: '149950', description: 'Integer minor units, as a string.' },
      formatted: { type: 'string', example: '1499.50' },
      currency: { type: 'string', example: 'INR' },
    },
  },

  Pagination: {
    type: 'object',
    required: ['page', 'limit', 'total', 'totalPages'],
    properties: {
      page: { type: 'integer' },
      limit: { type: 'integer' },
      total: { type: 'integer' },
      totalPages: { type: 'integer' },
    },
  },

  LoginRequest: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 1 },
    },
  },

  LoginResponse: {
    type: 'object',
    properties: {
      user: ref('AuthenticatedUser'),
      accessToken: { type: 'string', description: 'Also set as an httpOnly cookie.' },
      accessTokenExpiresAt: { type: 'string', format: 'date-time' },
      csrfToken: {
        type: 'string',
        description: 'Send back in the X-CSRF-Token header on every cookie-authenticated write.',
      },
    },
  },

  RefreshResponse: {
    type: 'object',
    properties: {
      accessToken: { type: 'string' },
      accessTokenExpiresAt: { type: 'string', format: 'date-time' },
      csrfToken: { type: 'string' },
    },
  },

  AuthenticatedUser: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      email: { type: 'string' },
      type: { type: 'string', enum: ['ADMIN', 'CUSTOMER'] },
      roles: { type: 'array', items: { type: 'string' } },
      permissions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Gate admin UI on these. Always empty for a customer.',
      },
      customerProfileId: { type: 'string', nullable: true },
      mfaEnabled: { type: 'boolean' },
      mustChangePassword: {
        type: 'boolean',
        description:
          'Signed in on the temporary password emailed when the account was created. While ' +
          'true every admin route answers 403 PASSWORD_CHANGE_REQUIRED; only /me, ' +
          '/password/change and /logout are reachable.',
      },
      locationRequired: {
        type: 'boolean',
        description:
          'This surface asks a signer-in where they are. True for the Admin Panel unless the ' +
          'deployment sets FEATURE_ADMIN_LOGIN_LOCATION=false; always false for a customer.',
      },
      locationGranted: {
        type: 'boolean',
        description:
          'The browser has told this session where it is. False on every fresh sign-in, and ' +
          'while it is false alongside locationRequired every admin route answers 403 ' +
          'LOCATION_REQUIRED. Carried forward across a token refresh, so it is asked once per ' +
          'sign-in and not once per hour.',
      },
      locationCountry: {
        type: 'string',
        nullable: true,
        description:
          'ISO-3166-1 alpha-2 country the sign-in resolved to. The market the console prices ' +
          'its catalogue for; null leaves it quoting the seller\'s own country.',
      },
      locationPlace: {
        type: 'string',
        nullable: true,
        description:
          'The same sign-in as a person reads it - the geocoded place, or the coordinates ' +
          'where no geocoder answered. Shown in the panel top bar. Null when the browser has ' +
          'said nothing, and on the customer surface, which never asks.',
      },
      locationLanguage: {
        type: 'string',
        nullable: true,
        description:
          'The interface language that country works in, from countries.languageCode. The ' +
          'panel adopts it once per sign-in country, so staff signing in from Berlin read a ' +
          'German console without touching the picker. Null means leave the reader\'s own ' +
          'choice alone - it is never a fallback to English.',
      },
      locationCurrency: {
        type: 'string',
        nullable: true,
        description:
          'The currency customers in that country are quoted in, from countries.currencyCode - ' +
          'the same row the storefront prices a shopper from. Every customer-facing figure in ' +
          'the console comes from that currency\'s own price list, never from converting ' +
          'another. Null for a country this deployment does not sell in, and the catalogue ' +
          'then quotes the base currency and names it.',
      },
    },
  },

  SessionLocationRequest: {
    type: 'object',
    required: ['latitude', 'longitude'],
    properties: {
      latitude: { type: 'number', format: 'double', minimum: -90, maximum: 90 },
      longitude: { type: 'number', format: 'double', minimum: -180, maximum: 180 },
      accuracyM: {
        type: 'number',
        nullable: true,
        description:
          'The radius the device claimed, in metres. Recorded and shown beside the place so a ' +
          'coarse wifi fix is not read as a precise one.',
      },
    },
  },

  SessionLocationResponse: {
    type: 'object',
    properties: {
      locationGranted: { type: 'boolean' },
      place: {
        type: 'string',
        description:
          'The reverse-geocoded place, or the coordinates when no geocoder answered. The lookup ' +
          'is best-effort - a firewalled or disabled geocoder never blocks a sign-in.',
      },
      recordedAt: { type: 'string', format: 'date-time' },
    },
  },

  AdminNotificationFeed: {
    type: 'object',
    description:
      'The bell. `unreadCount` counts the whole visible feed, not the page returned, so a ' +
      'badge never promises more rows than the panel can show.',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            kind: {
              type: 'string',
              description:
                'Dotted event kind, e.g. order.placed. The panel maps this to a phrase in ' +
                "the reader's own language - no prose is stored on the row.",
            },
            variables: {
              type: 'object',
              additionalProperties: true,
              description: 'The values that fill the phrase. Primitives only.',
            },
            linkPath: { type: 'string', nullable: true },
            isRead: { type: 'boolean', description: 'For the caller, not for everyone.' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
      },
      unreadCount: { type: 'integer' },
    },
  },

  MarkNotificationsReadRequest: {
    type: 'object',
    required: ['notificationIds'],
    properties: {
      notificationIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 },
    },
  },

  CreateStaffRequest: {
    type: 'object',
    required: ['email', 'roleKeys'],
    description: 'No password field, deliberately. See the operation description.',
    properties: {
      email: { type: 'string', format: 'email' },
      roleKeys: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6 },
    },
  },

  CreateStaffResponse: {
    type: 'object',
    properties: {
      userId: { type: 'string' },
      temporaryPasswordSent: { type: 'boolean', const: true },
      temporaryPasswordExpiresAt: { type: 'string', format: 'date-time' },
    },
  },

  AcceptInvitationRequest: {
    type: 'object',
    required: ['token', 'password', 'acceptedTerms'],
    properties: {
      token: { type: 'string' },
      password: { type: 'string', minLength: 12 },
      acceptedTerms: { type: 'boolean' },
      consentVersion: { type: 'string', default: 'v1' },
    },
  },

  RegisterRequest: {
    type: 'object',
    required: ['fullName', 'email', 'phone', 'country', 'password', 'acceptedTerms'],
    properties: {
      fullName: { type: 'string', maxLength: 255 },
      email: { type: 'string', format: 'email', maxLength: 320 },
      phone: {
        type: 'string',
        maxLength: 32,
        description:
          'Mobile number as typed. Punctuation is stripped before storage; a leading + is kept.',
      },
      country: {
        type: 'string',
        minLength: 2,
        maxLength: 2,
        description:
          'ISO-3166-1 alpha-2, and it must be a country this deployment has active. It decides ' +
          'which market price list the account is quoted from, so it is not merely an address ' +
          'field.',
      },
      password: { type: 'string', minLength: 12, maxLength: 128 },
      organization: { type: 'string', maxLength: 255, nullable: true },
      acceptedTerms: { type: 'boolean' },
      consentVersion: { type: 'string', default: 'v1' },
      language: { type: 'string', nullable: true, description: 'BCP-47 primary subtag.' },
    },
  },
  RegisterResponse: {
    type: 'object',
    properties: {
      registered: { type: 'boolean' },
      requiresApproval: {
        type: 'boolean',
        description:
          'Whether confirmed accounts on this deployment wait for staff. A property of the ' +
          'deployment, not of this request - it is identical for a duplicate address.',
      },
      message: { type: 'string' },
    },
  },
  VerifyEmailRequest: {
    type: 'object',
    required: ['token'],
    properties: { token: { type: 'string' } },
  },
  VerifyEmailResponse: {
    type: 'object',
    properties: {
      verified: { type: 'boolean' },
      email: { type: 'string', format: 'email' },
      status: { type: 'string', enum: ['ACTIVE', 'PENDING_APPROVAL'] },
    },
  },
  ResendVerificationRequest: {
    type: 'object',
    required: ['email'],
    properties: { email: { type: 'string', format: 'email' } },
  },
  ApproveCustomerResponse: {
    type: 'object',
    properties: {
      approved: { type: 'boolean' },
      email: { type: 'string', format: 'email' },
    },
  },

  PublicProduct: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      slug: { type: 'string' },
      sku: { type: 'string' },
      shortDescription: { type: 'string', nullable: true },
      descriptionHtml: {
        type: 'string',
        nullable: true,
        description: 'Sanitised server-side against an allowlist. Safe to render.',
      },
      price: ref('Money'),
      compareAtPrice: { ...ref('Money'), nullable: true },
      tax: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          ratePercent: { type: 'string' },
          inclusive: { type: 'boolean' },
        },
      },
      purchaseRules: {
        type: 'object',
        properties: {
          minOrderQty: { type: 'integer' },
          maxOrderQty: { type: 'integer', nullable: true },
          qtyIncrement: {
            type: 'integer',
            description: 'Counted FROM minOrderQty, not from zero.',
          },
          isRecurringEligible: { type: 'boolean' },
        },
      },
      primaryImage: { type: 'object', nullable: true },
      images: { type: 'array', items: { type: 'object' } },
      variants: { type: 'array', items: { type: 'object' } },
    },
  },

  ProductListResponse: {
    type: 'object',
    properties: {
      products: { type: 'array', items: ref('PublicProduct') },
      pagination: ref('Pagination'),
      currency: { type: 'string', example: 'EUR' },
      /** The destination every price in the response was quoted for. */
      country: { type: 'string', nullable: true, example: 'DE' },
    },
  },

  ProductDetailResponse: {
    type: 'object',
    properties: {
      product: ref('PublicProduct'),
      currency: { type: 'string', example: 'EUR' },
      country: { type: 'string', nullable: true, example: 'DE' },
      taxNote: {
        type: 'string',
        description: "Which country's VAT applies to this price, and why.",
      },
    },
  },

  CreateProductRequest: {
    type: 'object',
    required: ['name', 'sku', 'categoryId', 'basePriceMinor'],
    properties: {
      name: { type: 'string' },
      sku: { type: 'string' },
      categoryId: { type: 'string' },
      basePriceMinor: { type: 'string', pattern: '^\\d+$', example: '149950' },
      shortDescription: { type: 'string', nullable: true },
      descriptionHtml: { type: 'string', nullable: true },
      minOrderQty: { type: 'integer', default: 1 },
      maxOrderQty: { type: 'integer', nullable: true },
      qtyIncrement: { type: 'integer', default: 1 },
      isRecurringEligible: { type: 'boolean', default: false },
    },
  },

  PublicationResponse: {
    type: 'object',
    properties: {
      isPublished: { type: 'boolean' },
      publishedAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  CartLine: {
    type: 'object',
    properties: {
      itemId: { type: 'string' },
      productId: { type: 'string' },
      name: { type: 'string' },
      variantName: {
        type: 'string',
        nullable: true,
        description:
          "The chosen option's own name, or null where the product has no options. Two lines " +
          'of one product share a name and differ only here and in the SKU.',
      },
      quantity: { type: 'integer' },
      unitPrice: ref('Money'),
      lineTotal: ref('Money'),
      availableQty: { type: 'integer', nullable: true },
      issues: {
        type: 'array',
        items: ref('ErrorDetail'),
        description: 'Non-empty means this line blocks checkout. Show inline.',
      },
    },
  },

  CartResponse: {
    type: 'object',
    properties: {
      cart: {
        type: 'object',
        properties: {
          cartId: { type: 'string' },
          currency: { type: 'string' },
          lines: { type: 'array', items: ref('CartLine') },
          totals: {
            type: 'object',
            properties: {
              subtotal: ref('Money'),
              discount: ref('Money'),
              tax: ref('Money'),
              shipping: ref('Money'),
              grandTotal: ref('Money'),
            },
          },
          checkoutReady: { type: 'boolean' },
          blockingIssues: { type: 'array', items: ref('ErrorDetail') },
          requiresApproval: { type: 'boolean' },
          itemCount: { type: 'integer' },
        },
      },
    },
  },

  AddCartItemsRequest: {
    type: 'object',
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: ref('AddCartItemRequest'),
      },
    },
  },

  AddCartItemRequest: {
    type: 'object',
    required: ['productId', 'quantity'],
    properties: {
      productId: { type: 'string' },
      variantId: { type: 'string', nullable: true },
      quantity: { type: 'integer', minimum: 1 },
    },
  },

  CheckoutRequest: {
    type: 'object',
    required: ['shippingAddressId'],
    properties: {
      shippingAddressId: { type: 'string' },
      billingAddressId: { type: 'string' },
      shippingMethodCode: { type: 'string', nullable: true },
      paymentMode: { type: 'string', enum: ['ONLINE', 'PAYMENT_LINK'], default: 'ONLINE' },
      preferredPaymentProvider: {
        type: 'string',
        enum: ['RAZORPAY', 'STRIPE'],
        description:
          'The gateway the customer chose, where the storefront offered a choice. Recorded on ' +
          'the order so the payment page can be reloaded without losing it. A preference, not a ' +
          'routing instruction: the gateway that actually takes the payment is resolved from ' +
          'what the operator has connected. Omit to accept the configured default.',
      },
      preferredPaymentMethod: {
        type: 'string',
        enum: ['ANY', 'UPI'],
        description:
          'Which instruments to open the gateway sheet on. Honoured by Razorpay and ignored by ' +
          'gateways that have no such instrument; the sheet still offers everything the gateway ' +
          'supports.',
      },
      preferredPaymentInstrument: {
        type: 'string',
        enum: ['CREDIT_CARD', 'DEBIT_CARD', 'UPI'],
        description:
          'What the customer chose to pay with, in the words the storefront showed them. ' +
          'Supersedes preferredPaymentProvider, which exists only for clients written before ' +
          'instruments did: the gateway is resolved from this on the server, and no gateway is ' +
          'ever named to a customer. Refused rather than substituted if no connected gateway ' +
          'can serve it — see PAYMENT_INSTRUMENT_UNAVAILABLE.',
      },
      preferredPaymentMethodId: {
        type: 'string',
        description:
          'One of the customer’s own saved cards, chosen at checkout. A preference like the ' +
          'fields above, re-checked against the customer when the payment actually starts — ' +
          'naming another customer’s card is refused, never charged.',
      },
      customerNote: { type: 'string', nullable: true },
    },
  },

  CheckoutResponse: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      orderNumber: { type: 'string', example: 'UB-2026-000001' },
      status: { type: 'string' },
      totals: { type: 'object' },
      requiresApproval: { type: 'boolean' },
      replayed: {
        type: 'boolean',
        description: 'True when this replays an earlier request with the same Idempotency-Key.',
      },
    },
  },

  OrderDetail: {
    type: 'object',
    properties: {
      order: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          orderNumber: { type: 'string' },
          status: { type: 'string' },
          totals: { type: 'object' },
          items: {
            type: 'array',
            items: { type: 'object' },
            description: 'Immutable snapshots. Later catalog edits never change these.',
          },
          timeline: { type: 'array', items: { type: 'object' } },
        },
      },
    },
  },

  TransitionRequest: {
    type: 'object',
    required: ['to'],
    properties: {
      to: { type: 'string' },
      reason: { type: 'string', description: 'Required for cancellations and rejections.' },
    },
  },

  PaymentSessionRequest: {
    type: 'object',
    description:
      'Optional. Overrides the gateway recorded on the order — for offering a different one ' +
      'after a decline. Naming a gateway the operator has not connected is not an error: the ' +
      'payment falls back to one that is, and the response says which.',
    properties: {
      provider: { type: 'string', enum: ['RAZORPAY', 'STRIPE'] },
      method: { type: 'string', enum: ['ANY', 'UPI'] },
    },
  },

  PaymentGatewaysResponse: {
    type: 'object',
    properties: {
      gateways: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            provider: { type: 'string', enum: ['RAZORPAY', 'STRIPE'] },
            label: { type: 'string' },
            methods: {
              type: 'array',
              items: { type: 'string', enum: ['ANY', 'UPI'] },
              description: 'Instruments worth naming separately. `ANY` is the gateway’s own set.',
            },
            currencies: {
              type: 'array',
              nullable: true,
              items: { type: 'string' },
              description:
                'ISO-4217 codes this gateway may be offered for. Null means no restriction.',
            },
          },
        },
      },
      defaultProvider: {
        type: 'string',
        enum: ['RAZORPAY', 'STRIPE'],
        nullable: true,
        description: 'Preselect this. Null when nothing is connected.',
      },
    },
  },

  PaymentSessionResponse: {
    type: 'object',
    properties: {
      paymentTransactionId: { type: 'string' },
      provider: { type: 'string' },
      mode: { type: 'string', enum: ['TEST', 'LIVE'] },
      providerOrderId: { type: 'string' },
      amount: ref('Money'),
      checkoutPayload: {
        type: 'object',
        description: 'Pass to the provider SDK. Contains the publishable key only.',
      },
    },
  },

  CreateScheduleRequest: {
    type: 'object',
    required: [
      'name',
      'frequency',
      'startDate',
      'paymentMode',
      'shippingAddressId',
      'items',
      'consentAccepted',
    ],
    properties: {
      name: { type: 'string' },
      frequency: {
        type: 'string',
        enum: ['EVERY_N_DAYS', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'EVERY_N_MONTHS', 'ONE_TIME'],
      },
      intervalDays: { type: 'integer', nullable: true, description: 'Required for EVERY_N_DAYS.' },
      weekday: {
        type: 'integer',
        nullable: true,
        description: '1=Mon..7=Sun. Required for WEEKLY and BIWEEKLY.',
      },
      monthDay: { type: 'integer', nullable: true, description: 'Required for MONTHLY.' },
      intervalMonths: {
        type: 'integer',
        minimum: 2,
        maximum: 24,
        nullable: true,
        description:
          'Required for EVERY_N_MONTHS. 2, 3, 6 and 12 are what the storefront offers. ' +
          'The day of the month comes from startDate, not from monthDay.',
      },
      timezone: { type: 'string', example: 'Asia/Kolkata' },
      runAtMinute: { type: 'integer', default: 360, description: 'Local minutes since midnight.' },
      startDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      paymentMode: { type: 'string', enum: ['AUTO_PAY', 'PAYMENT_LINK'] },
      shippingAddressId: { type: 'string' },
      items: { type: 'array', items: ref('AddCartItemRequest') },
      consentAccepted: { type: 'boolean', description: 'Must be true.' },
    },
  },

  CreateCustomerRequest: {
    type: 'object',
    required: ['email', 'fullName'],
    properties: {
      email: { type: 'string', format: 'email' },
      fullName: { type: 'string' },
      organization: { type: 'string', nullable: true },
      limits: { type: 'object' },
      addresses: { type: 'array', items: { type: 'object' } },
      sendInvitation: { type: 'boolean', default: true },
    },
  },
});

interface RouteRecord {
  method: string;
  url: string;
}

/**
 * Derive a usable summary, tag and auth requirement from the route shape.
 *
 * The 40 hand-authored operations above carry the nuances that matter - the
 * idempotency rules, why a 404 is returned instead of a 403, what
 * `availableTransitions` is for. This fills in the rest so no operation reads
 * "GET /api/v1/admin/products" in a generated client, and so tags and auth are
 * right everywhere rather than only where somebody remembered.
 */
function deriveDoc(method: string, url: string): OperationDoc {
  const path = url.replace(/^\/api\/v1/, '');
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const isAdmin = segments[0] === 'admin';

  // The resource is the first non-parameter segment after any surface prefix.
  const meaningful = segments.filter((segment) => !segment.startsWith(':'));
  const resource = (isAdmin ? meaningful[1] : meaningful[0]) ?? 'resource';
  const action = meaningful[meaningful.length - 1] ?? '';

  const hasId = /:[A-Za-z0-9_]+/.test(url);
  const readable = resource.replace(/[-_]/g, ' ');

  const verb =
    method === 'GET'
      ? hasId && action === resource
        ? `Get a ${singular(readable)}`
        : `List ${readable}`
      : method === 'POST'
        ? action !== resource && !action.startsWith(':')
          ? `${capitalise(action.replace(/[-_]/g, ' '))} ${hasId ? 'for this ' + singular(readable) : readable}`
          : `Create a ${singular(readable)}`
        : method === 'PATCH'
          ? action !== resource && !action.startsWith(':')
            ? `Update ${action.replace(/[-_]/g, ' ')} on a ${singular(readable)}`
            : `Update a ${singular(readable)}`
          : method === 'DELETE'
            ? `Delete or archive a ${singular(readable)}`
            : `${method} ${readable}`;

  const tag = TAG_BY_RESOURCE[resource] ?? (isAdmin ? 'Admin' : 'Customer');

  return {
    summary: verb,
    tags: [tag],
    auth: isAdmin ? 'admin' : segments[0] === 'catalog' || segments[0] === 'payments' ? 'none' : 'customer',
  };
}

function singular(word: string): string {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ses')) return word.slice(0, -2);
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

const TAG_BY_RESOURCE: Readonly<Record<string, string>> = Object.freeze({
  auth: 'Auth',
  products: 'Catalog (Admin)',
  categories: 'Catalog (Admin)',
  catalog: 'Catalog (Public)',
  cart: 'Cart',
  orders: 'Orders',
  payments: 'Payments',
  'payment-links': 'Payments',
  'recurring-schedules': 'Recurring',
  fulfilment: 'Fulfilment',
  schedules: 'Recurring',
  customers: 'Customers (Admin)',
  account: 'Account',
  reports: 'Reports',
  dashboard: 'Reports',
  exports: 'Reports',
  integrations: 'Reports',
  'audit-logs': 'Reports',
});

/**
 * Build the document from the live route table.
 *
 * The records come from `parsePrintedRoutes` in `openapi-export.ts`, which
 * reads Fastify's own printed tree - so a path that does not exist cannot be
 * documented, and one that does cannot be missed.
 */
export function buildOpenApiDocument(routes: RouteRecord[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const undocumented: string[] = [];

  for (const route of routes) {
    // HEAD is generated automatically for every GET; OPTIONS is CORS.
    if (route.method === 'HEAD' || route.method === 'OPTIONS') continue;

    const key = `${route.method} ${route.url}`;
    const authored = OPERATIONS[key];
    const doc = authored ?? deriveDoc(route.method, route.url);

    // `/orders/:id` -> `/orders/{id}`
    const openApiPath = route.url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const parameters = [...route.url.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => ({
      name: match[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));

    // Tracked so the contract test can report coverage; a derived summary is
    // usable but carries none of the behavioural nuance.
    if (authored === undefined) undocumented.push(key);

    const security =
      doc.auth === 'none' || doc.auth === 'token' ? [] : [{ cookieAuth: [] }, { bearerAuth: [] }];

    const operation: Record<string, unknown> = {
      summary: doc.summary,
      ...(doc.description !== undefined ? { description: doc.description } : {}),
      tags: doc.tags,
      operationId: `${route.method.toLowerCase()}${openApiPath
        .replace(/[^A-Za-z0-9]+(.)/g, (_m, c: string) => c.toUpperCase())
        .replace(/[^A-Za-z0-9]/g, '')}`,
      security,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(doc.requestBody !== undefined
        ? {
            requestBody: {
              required: doc.optionalBody !== true,
              ...(json(doc.requestBody) as object),
            },
          }
        : {}),
      responses: {
        ...(doc.responses ?? { '200': { description: 'Success' } }),
        // Every endpoint can return these. Documenting them once here beats
        // repeating them on 90 operations.
        '400': ok(ref('ErrorEnvelope'), 'Validation failed'),
        '401': ok(ref('ErrorEnvelope'), 'Not authenticated'),
        '403': ok(ref('ErrorEnvelope'), 'Permission denied or CSRF failure'),
        '429': ok(ref('ErrorEnvelope'), 'Rate limited'),
        '500': ok(ref('ErrorEnvelope'), 'Internal error; quote the correlationId'),
      },
    };

    if (doc.permission !== undefined) {
      operation['x-required-permission'] = doc.permission;
    }
    if (doc.idempotent === true) {
      operation['x-idempotency-key'] = 'required';
      const params = (operation['parameters'] as unknown[] | undefined) ?? [];
      operation['parameters'] = [
        ...params,
        {
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          schema: { type: 'string' },
          description: 'Same key + same body replays. Same key + different body is rejected.',
        },
      ];
    }

    paths[openApiPath] ??= {};
    paths[openApiPath][route.method.toLowerCase()] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'UBOSS Sourcing API',
      version: '1.0.0',
      description: [
        'Backend for the UBOSS Sourcing Admin Panel and Customer Website.',
        '',
        '## Money',
        'Money is never a JSON number. Every amount is an object with `minor` -',
        'an integer count of the currency minor unit, as a string. Use BigInt in',
        'the client; a JS number loses precision above 2^53.',
        '',
        '## Errors',
        'Every failure returns the same envelope. `code` is a stable contract:',
        'map it to a message in the UI rather than showing `message` raw.',
        '`details[].field` is a dotted path for attaching errors to inputs.',
        '',
        '## Authentication',
        'httpOnly cookies. On login, copy `csrfToken` from the response into the',
        '`X-CSRF-Token` header on every subsequent write. A Bearer token is also',
        'accepted for non-browser clients and skips the CSRF check.',
        '',
        'Admin and customer sessions are separate. An admin credential presented',
        'at a customer endpoint is rejected, and vice versa.',
        '',
        '## Idempotency',
        'Operations marked `x-idempotency-key: required` need an `Idempotency-Key`',
        'header. The same key with the same body replays the first response; the',
        'same key with a different body is rejected rather than silently replayed.',
      ].join('\n'),
    },
    servers: [{ url: 'http://localhost:4000', description: 'Local development' }],
    tags: [
      { name: 'Health' },
      { name: 'Auth (Admin)' },
      { name: 'Auth (Customer)' },
      { name: 'Catalog (Public)' },
      { name: 'Delivery (Public)' },
      { name: 'Fulfilment' },
      { name: 'Catalog (Admin)' },
      { name: 'Cart' },
      { name: 'Orders (Customer)' },
      { name: 'Orders (Admin)' },
      { name: 'Payments' },
      { name: 'Recurring' },
      { name: 'Customers (Admin)' },
      { name: 'Account' },
      { name: 'Reports' },
    ],
    components: {
      schemas: SCHEMAS,
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'uboss_shop_at' },
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
    paths,
    'x-undocumented-operations': undocumented,
    'x-api-prefix': API_PREFIX,
  };
}

export { OPERATIONS };
