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
  'POST /api/v1/auth/invitations/accept': {
    summary: 'Activate an invited account',
    description: 'Single use. Sets the password and records consent in one transaction.',
    tags: ['Auth (Customer)'],
    auth: 'token',
    requestBody: ref('AcceptInvitationRequest'),
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
      'so pagination is stable.',
    tags: ['Catalog (Public)'],
    auth: 'none',
    responses: { '200': ok(ref('ProductListResponse')) },
  },
  'GET /api/v1/catalog/products/:slug': {
    summary: 'Product detail',
    description: 'An unpublished product returns 404, indistinguishable from a missing one.',
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
    description: 'Returns the provider checkout payload. Contains no secret.',
    tags: ['Payments'],
    auth: 'customer',
    idempotent: true,
    responses: { '201': ok(ref('PaymentSessionResponse')) },
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
    },
  },

  ProductDetailResponse: {
    type: 'object',
    properties: { product: ref('PublicProduct') },
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
        ? { requestBody: { required: true, ...(json(doc.requestBody) as object) } }
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
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'uboss_at' },
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
    paths,
    'x-undocumented-operations': undocumented,
    'x-api-prefix': API_PREFIX,
  };
}

export { OPERATIONS };
