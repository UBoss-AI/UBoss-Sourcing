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
      frequency: { type: 'string', enum: ['EVERY_N_DAYS', 'WEEKLY', 'MONTHLY'] },
      intervalDays: { type: 'integer', nullable: true, description: 'Required for EVERY_N_DAYS.' },
      weekday: { type: 'integer', nullable: true, description: '1=Mon..7=Sun. Required for WEEKLY.' },
      monthDay: { type: 'integer', nullable: true, description: 'Required for MONTHLY.' },
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
