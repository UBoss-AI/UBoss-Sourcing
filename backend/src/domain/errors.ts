/**
 * Error envelope and stable error codes.
 *
 * Both frontends map these codes to precise, field-level messages, so the codes
 * are a published contract: rename one and the Admin Panel or Customer Website
 * silently degrades to a generic toast. Add new codes rather than repurposing
 * existing ones.
 *
 * Wire shape (identical for every failure, including 500s):
 *   {
 *     "error": {
 *       "code": "CART_QUANTITY_BELOW_MINIMUM",
 *       "message": "Minimum order quantity for this product is 10.",
 *       "details": [{ "field": "items.0.quantity", "code": "...", "meta": {...} }],
 *       "correlationId": "01J..."
 *     }
 *   }
 */

export const ErrorCode = {
  // --- Generic ---
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  FEATURE_DISABLED: 'FEATURE_DISABLED',

  // --- Authentication / authorization ---
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_DEACTIVATED: 'ACCOUNT_DEACTIVATED',
  ACCOUNT_NOT_ACTIVATED: 'ACCOUNT_NOT_ACTIVATED',
  /// Self-registered, email confirmed, and waiting for a member of staff to
  /// let them in. Distinct from ACCOUNT_NOT_ACTIVATED because there is nothing
  /// the person can do about it - no link to open, no password to choose - and
  /// telling them to check their email would send them hunting for nothing.
  ACCOUNT_PENDING_APPROVAL: 'ACCOUNT_PENDING_APPROVAL',
  /// Self-registered and the confirmation link has not been opened yet. The fix
  /// is sitting in their inbox, so the storefront offers to send another.
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',
  MFA_REQUIRED: 'MFA_REQUIRED',
  MFA_INVALID: 'MFA_INVALID',
  FORBIDDEN: 'FORBIDDEN',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /// Authenticated, but the resource belongs to somebody else. Returned instead
  /// of NOT_FOUND only where existence is already known to the caller.
  RESOURCE_OWNERSHIP_DENIED: 'RESOURCE_OWNERSHIP_DENIED',

  // --- Invitations and tokens ---
  TOKEN_INVALID: 'TOKEN_INVALID',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_ALREADY_USED: 'TOKEN_ALREADY_USED',
  INVITATION_ALREADY_ACCEPTED: 'INVITATION_ALREADY_ACCEPTED',
  SELF_REGISTRATION_DISABLED: 'SELF_REGISTRATION_DISABLED',
  /// The emailed temporary password has lapsed. Distinct from bad credentials
  /// because the fix is different: somebody has to issue a new one.
  TEMPORARY_PASSWORD_EXPIRED: 'TEMPORARY_PASSWORD_EXPIRED',
  /// Signed in on a temporary password, so the only thing this session may do
  /// is set a real one. The Admin Panel turns this into the change screen.
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  /// Signed in, but the session has not yet said where it is. Every admin route
  /// answers this until the browser's position is posted; the Admin Panel turns
  /// it into the screen that asks for location access.
  LOCATION_REQUIRED: 'LOCATION_REQUIRED',

  // --- Catalog ---
  SKU_ALREADY_EXISTS: 'SKU_ALREADY_EXISTS',
  SLUG_ALREADY_EXISTS: 'SLUG_ALREADY_EXISTS',
  CATEGORY_CYCLE_DETECTED: 'CATEGORY_CYCLE_DETECTED',
  CATEGORY_HAS_PRODUCTS: 'CATEGORY_HAS_PRODUCTS',
  PRODUCT_NOT_PUBLISHED: 'PRODUCT_NOT_PUBLISHED',
  PRODUCT_INCOMPLETE_FOR_PUBLISH: 'PRODUCT_INCOMPLETE_FOR_PUBLISH',
  VARIANT_MISMATCH: 'VARIANT_MISMATCH',
  MEDIA_TYPE_NOT_ALLOWED: 'MEDIA_TYPE_NOT_ALLOWED',
  MEDIA_TOO_LARGE: 'MEDIA_TOO_LARGE',

  // --- Inventory ---
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  STOCK_NOT_TRACKED: 'STOCK_NOT_TRACKED',
  RESERVATION_EXPIRED: 'RESERVATION_EXPIRED',
  ADJUSTMENT_REASON_REQUIRED: 'ADJUSTMENT_REASON_REQUIRED',
  INVENTORY_BALANCE_NOT_EDITABLE: 'INVENTORY_BALANCE_NOT_EDITABLE',
  /// Two warehouses cannot share a code. The code is stamped on every movement
  /// ever recorded against the place, so a duplicate would make the ledger
  /// ambiguous about where stock went.
  LOCATION_CODE_EXISTS: 'LOCATION_CODE_EXISTS',
  /// Retiring this warehouse would leave stock somewhere the console no longer
  /// offers, or leave the deployment with no default for the next receipt to
  /// land in. The message names which of the two it is and the count behind it.
  LOCATION_STILL_IN_USE: 'LOCATION_STILL_IN_USE',
  /// The warehouse row itself cannot go, because history points at it: a stock
  /// movement, a balance, a reservation or a scheduled order. A separate code
  /// from the one above because the answer is a different one - that refusal
  /// says "clear the stock, then retire it", this one says "retiring is the
  /// only thing left". The message names what is in the way and how much of
  /// it there is.
  LOCATION_HAS_HISTORY: 'LOCATION_HAS_HISTORY',

  // --- Cart and purchasing limits ---
  CART_EMPTY: 'CART_EMPTY',
  CART_ITEM_UNAVAILABLE: 'CART_ITEM_UNAVAILABLE',
  CART_PRICE_CHANGED: 'CART_PRICE_CHANGED',
  CART_CURRENCY_MISMATCH: 'CART_CURRENCY_MISMATCH',
  QUANTITY_BELOW_MINIMUM: 'QUANTITY_BELOW_MINIMUM',
  QUANTITY_ABOVE_MAXIMUM: 'QUANTITY_ABOVE_MAXIMUM',
  QUANTITY_INCREMENT_INVALID: 'QUANTITY_INCREMENT_INVALID',
  ORDER_BELOW_MINIMUM_VALUE: 'ORDER_BELOW_MINIMUM_VALUE',
  ORDER_ABOVE_MAXIMUM_VALUE: 'ORDER_ABOVE_MAXIMUM_VALUE',
  CUSTOMER_SPEND_CAP_EXCEEDED: 'CUSTOMER_SPEND_CAP_EXCEEDED',

  // --- Orders ---
  ORDER_TRANSITION_NOT_ALLOWED: 'ORDER_TRANSITION_NOT_ALLOWED',
  ORDER_ALREADY_PAID: 'ORDER_ALREADY_PAID',
  ORDER_NOT_CANCELLABLE: 'ORDER_NOT_CANCELLABLE',
  ORDER_APPROVAL_REQUIRED: 'ORDER_APPROVAL_REQUIRED',
  ORDER_APPROVAL_ALREADY_DECIDED: 'ORDER_APPROVAL_ALREADY_DECIDED',
  ADDRESS_REQUIRED: 'ADDRESS_REQUIRED',
  SHIPPING_METHOD_UNAVAILABLE: 'SHIPPING_METHOD_UNAVAILABLE',

  // --- Idempotency ---
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  /// Same key, different body. Never silently returns the earlier response.
  IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY',
  IDEMPOTENT_REQUEST_IN_PROGRESS: 'IDEMPOTENT_REQUEST_IN_PROGRESS',

  // --- Payments ---
  PAYMENT_PROVIDER_NOT_CONFIGURED: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
  PAYMENT_PROVIDER_ERROR: 'PAYMENT_PROVIDER_ERROR',
  PAYMENT_AMOUNT_MISMATCH: 'PAYMENT_AMOUNT_MISMATCH',
  PAYMENT_CURRENCY_MISMATCH: 'PAYMENT_CURRENCY_MISMATCH',
  PAYMENT_ALREADY_CAPTURED: 'PAYMENT_ALREADY_CAPTURED',
  PAYMENT_NOT_CAPTURED: 'PAYMENT_NOT_CAPTURED',
  WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK_SIGNATURE_INVALID',
  WEBHOOK_PAYLOAD_INVALID: 'WEBHOOK_PAYLOAD_INVALID',
  PAYMENT_LINK_INVALID: 'PAYMENT_LINK_INVALID',
  PAYMENT_LINK_EXPIRED: 'PAYMENT_LINK_EXPIRED',
  PAYMENT_LINK_ALREADY_USED: 'PAYMENT_LINK_ALREADY_USED',
  PAYMENT_LINK_REVOKED: 'PAYMENT_LINK_REVOKED',
  REFUND_EXCEEDS_CAPTURED: 'REFUND_EXCEEDS_CAPTURED',
  REFUND_NOT_PERMITTED: 'REFUND_NOT_PERMITTED',

  // --- Recurring ---
  SCHEDULE_PRODUCT_NOT_ELIGIBLE: 'SCHEDULE_PRODUCT_NOT_ELIGIBLE',
  SCHEDULE_CONSENT_REQUIRED: 'SCHEDULE_CONSENT_REQUIRED',
  SCHEDULE_NOT_ACTIVE: 'SCHEDULE_NOT_ACTIVE',
  SCHEDULE_ALREADY_CANCELLED: 'SCHEDULE_ALREADY_CANCELLED',
  SCHEDULE_MANDATE_MISSING: 'SCHEDULE_MANDATE_MISSING',
  SCHEDULE_MANDATE_INVALID: 'SCHEDULE_MANDATE_INVALID',
  OCCURRENCE_ALREADY_EXISTS: 'OCCURRENCE_ALREADY_EXISTS',
  RECURRENCE_RULE_INVALID: 'RECURRENCE_RULE_INVALID',
  /// A plan status change the state machine does not define. Distinct from
  /// SCHEDULE_NOT_ACTIVE, which is the specific case of acting on a plan that
  /// is merely not running right now.
  SCHEDULE_TRANSITION_NOT_ALLOWED: 'SCHEDULE_TRANSITION_NOT_ALLOWED',
  OCCURRENCE_TRANSITION_NOT_ALLOWED: 'OCCURRENCE_TRANSITION_NOT_ALLOWED',
  /// The plan is still a DRAFT: it has been configured but nobody has
  /// confirmed the review screen, so it has no authority to charge anyone.
  SCHEDULE_NOT_ACTIVATED: 'SCHEDULE_NOT_ACTIVATED',
  /// Activation was attempted on a plan that is already running.
  SCHEDULE_ALREADY_ACTIVATED: 'SCHEDULE_ALREADY_ACTIVATED',
  /// The edit window closed. The message names the next date the customer can
  /// change this plan, because "too late" without a date is not an answer.
  SCHEDULE_EDIT_CUTOFF_PASSED: 'SCHEDULE_EDIT_CUTOFF_PASSED',
  /// A date in the past, or a time that has already gone today.
  SCHEDULE_DATE_IN_PAST: 'SCHEDULE_DATE_IN_PAST',
  /// A frequency this deployment does not offer, or one whose parameters do
  /// not fit it (WEEKLY without a weekday, a custom interval out of range).
  SCHEDULE_FREQUENCY_NOT_SUPPORTED: 'SCHEDULE_FREQUENCY_NOT_SUPPORTED',
  /// The total moved further than the approved tolerance since the customer
  /// was quoted. Nothing is charged; the occurrence waits for them.
  SCHEDULE_PRICE_CHANGED: 'SCHEDULE_PRICE_CHANGED',
  /// Auto-pay was asked for with no reusable payment method chosen.
  SCHEDULE_PAYMENT_METHOD_REQUIRED: 'SCHEDULE_PAYMENT_METHOD_REQUIRED',
  /// The stored instrument is gone, detached at the provider, or expired.
  SCHEDULE_PAYMENT_METHOD_INVALID: 'SCHEDULE_PAYMENT_METHOD_INVALID',
  /// The bank wants the cardholder present - 3-D Secure, or a re-authorised
  /// mandate. Nothing retries on its own; only the customer can clear it.
  SCHEDULE_PAYMENT_AUTHENTICATION_REQUIRED: 'SCHEDULE_PAYMENT_AUTHENTICATION_REQUIRED',
  /// This cycle has already been touched by the engine, so it can no longer be
  /// skipped, edited or cancelled.
  OCCURRENCE_NOT_MODIFIABLE: 'OCCURRENCE_NOT_MODIFIABLE',
  /// A product is unavailable and the customer has saved no substitute for it,
  /// so the occurrence is held rather than filled with something they did not
  /// choose.
  SUBSTITUTION_NOT_PERMITTED: 'SUBSTITUTION_NOT_PERMITTED',
  /// Removing an instrument that live plans still depend on. The detail names
  /// them, so the customer can decide rather than be refused blankly.
  PAYMENT_METHOD_IN_USE: 'PAYMENT_METHOD_IN_USE',
  /// The SetupIntent has not reached a state that yields a reusable
  /// instrument, so there is nothing to store yet.
  PAYMENT_SETUP_INCOMPLETE: 'PAYMENT_SETUP_INCOMPLETE',
  /// Saving a payment method without the off-session consent that makes it
  /// chargeable. Stripe's rules require the record, and so does the law.
  PAYMENT_SETUP_CONSENT_REQUIRED: 'PAYMENT_SETUP_CONSENT_REQUIRED',

  // --- Localisation & currency ---
  CURRENCY_NOT_SUPPORTED: 'CURRENCY_NOT_SUPPORTED',
  COUNTRY_NOT_SUPPORTED: 'COUNTRY_NOT_SUPPORTED',
  /// The catalogue has no price for this SKU in the requested currency, so it
  /// cannot be sold in it. Never fall back to another currency's number.
  PRICE_UNAVAILABLE_IN_CURRENCY: 'PRICE_UNAVAILABLE_IN_CURRENCY',

  // --- Coupons ---
  COUPON_NOT_FOUND: 'COUPON_NOT_FOUND',
  COUPON_NOT_ACTIVE: 'COUPON_NOT_ACTIVE',
  COUPON_EXPIRED: 'COUPON_EXPIRED',
  COUPON_NOT_YET_VALID: 'COUPON_NOT_YET_VALID',
  COUPON_MINIMUM_NOT_MET: 'COUPON_MINIMUM_NOT_MET',
  /// Nothing in the cart falls inside the coupon's categories.
  COUPON_NOT_APPLICABLE: 'COUPON_NOT_APPLICABLE',
  COUPON_USAGE_LIMIT_REACHED: 'COUPON_USAGE_LIMIT_REACHED',
  COUPON_CODE_ALREADY_EXISTS: 'COUPON_CODE_ALREADY_EXISTS',

  // --- Integrations ---
  CONNECTOR_TEST_FAILED: 'CONNECTOR_TEST_FAILED',
  CONNECTOR_CIRCUIT_OPEN: 'CONNECTOR_CIRCUIT_OPEN',
  /// No ERP connection is configured for order push, or the one configured is
  /// switched off. Checked BEFORE a card is charged, never after.
  ERP_NOT_CONFIGURED: 'ERP_NOT_CONFIGURED',
  /// The ERP refused the order, or could not be reached. When this happens
  /// after a successful charge the occurrence holds at PAID_ERP_PENDING and
  /// retries under the same idempotency key - it never re-charges.
  ERP_ORDER_PUSH_FAILED: 'ERP_ORDER_PUSH_FAILED',
  /// A line has no identifier in the ERP, so the ERP could not accept the
  /// order even if it were sent. Caught during revalidation, before payment.
  ERP_SKU_NOT_MAPPED: 'ERP_SKU_NOT_MAPPED',
  /// The warehouse the order would ship from is not mapped to the ERP.
  ERP_WAREHOUSE_NOT_MAPPED: 'ERP_WAREHOUSE_NOT_MAPPED',
  IMPORT_FILE_INVALID: 'IMPORT_FILE_INVALID',
  IMPORT_DRY_RUN_REQUIRED: 'IMPORT_DRY_RUN_REQUIRED',
  EXPORT_NOT_READY: 'EXPORT_NOT_READY',

  // --- A configurable ERP connection ---
  //
  // Distinct from the ERP_* codes above, which are about the connector wired
  // through environment variables. These are returned to an administrator
  // working in Settings -> ERP, so each one has to name something they can
  // actually go and fix.
  /// The address is not one this server will call: not http(s), missing a host,
  /// carrying credentials, or resolving to a private or reserved network. The
  /// detail says which.
  ERP_URL_NOT_ALLOWED: 'ERP_URL_NOT_ALLOWED',
  /// An endpoint path pointed at a different origin from the base URL. Refused
  /// because an "endpoint" free to leave the authorised host is an SSRF
  /// primitive with a form field in front of it.
  ERP_ENDPOINT_OFF_ORIGIN: 'ERP_ENDPOINT_OFF_ORIGIN',
  /// The connection is not in a state that allows what was asked - activating
  /// one that has never passed a test, resuming one that was never paused. The
  /// message names the current status.
  ERP_CONNECTION_STATE_INVALID: 'ERP_CONNECTION_STATE_INVALID',
  /// Activation was refused because the connection has no passing test behind
  /// it. Separate from the code above because it names the remedy: press Test.
  ERP_CONNECTION_UNTESTED: 'ERP_CONNECTION_UNTESTED',
  /// The field mapping is missing something required, maps a field twice, or
  /// points at a path that is not present in the sample response.
  ERP_MAPPING_INVALID: 'ERP_MAPPING_INVALID',
  /// Activation was refused because the mapping has never been checked against
  /// a real response. A structurally valid mapping is still a guess about
  /// somebody else's JSON.
  ERP_MAPPING_UNVERIFIED: 'ERP_MAPPING_UNVERIFIED',
  /// The ERP answered, but not with anything this connection can use: not
  /// JSON, or JSON with no array of records where the mapping says one is.
  ERP_RESPONSE_UNUSABLE: 'ERP_RESPONSE_UNUSABLE',
  /// The customer's ERP refused our credentials. Its own 401 or 403, reported
  /// as itself rather than as a generic failure, because the remedy is
  /// entirely different from a network fault.
  ERP_AUTHENTICATION_FAILED: 'ERP_AUTHENTICATION_FAILED',
  /// The OAuth token endpoint refused the client-credentials grant.
  ERP_OAUTH_TOKEN_FAILED: 'ERP_OAUTH_TOKEN_FAILED',
  /// The ERP asked us to slow down. Carries the retry-after it gave, where it
  /// gave one.
  ERP_RATE_LIMITED: 'ERP_RATE_LIMITED',
  /// Repeated failures took the connection out of service. It will not be
  /// called again until a test passes.
  ERP_CONNECTION_SUSPENDED: 'ERP_CONNECTION_SUSPENDED',
  /// A webhook arrived for a connection whose signature did not verify, or
  /// which has no signing secret configured. Never says which: an endpoint that
  /// distinguishes "wrong signature" from "no secret" is an oracle.
  ERP_WEBHOOK_REJECTED: 'ERP_WEBHOOK_REJECTED',
  /// A sync was asked for while one is already running on this connection.
  ERP_SYNC_ALREADY_RUNNING: 'ERP_SYNC_ALREADY_RUNNING',

  // --- Auto-pay ---
  /// Enabling was refused because there is no usable saved card. The customer
  /// is sent to add one rather than told "not eligible".
  AUTOPAY_PAYMENT_METHOD_REQUIRED: 'AUTOPAY_PAYMENT_METHOD_REQUIRED',
  /// Enabling was refused because the explicit consent box was not ticked.
  /// Charging without it is not something a flag may turn on.
  AUTOPAY_CONSENT_REQUIRED: 'AUTOPAY_CONSENT_REQUIRED',
  /// Auto-pay is off or paused, and something asked for an off-session charge.
  AUTOPAY_NOT_ENABLED: 'AUTOPAY_NOT_ENABLED',
  /// The amount is above the ceiling the customer set. Refused, not deferred.
  AUTOPAY_LIMIT_EXCEEDED: 'AUTOPAY_LIMIT_EXCEEDED',
  /// The amount is above the threshold at which the customer asked to be
  /// consulted. Nothing is charged and they are asked - which is why this is
  /// not the same code as the one above.
  AUTOPAY_APPROVAL_REQUIRED: 'AUTOPAY_APPROVAL_REQUIRED',
  /// The charge and the customer's limits are in different currencies, so the
  /// limit cannot be applied. Refused rather than guessed at: converting a cap
  /// the customer typed is not something to do silently.
  AUTOPAY_CURRENCY_MISMATCH: 'AUTOPAY_CURRENCY_MISMATCH',

  // --- Data protection ---
  /// One open request of this kind already exists. Art. 12(3) runs from the
  /// first one, so a second does not restart the clock and is not a new
  /// request - the storefront is told to wait for the one already in flight.
  DATA_REQUEST_ALREADY_OPEN: 'DATA_REQUEST_ALREADY_OPEN',
  /// The bundle is still building, or its download window has closed.
  DATA_REQUEST_NOT_READY: 'DATA_REQUEST_NOT_READY',
  /// A decision was attempted on a request that is no longer pending.
  DATA_REQUEST_ALREADY_DECIDED: 'DATA_REQUEST_ALREADY_DECIDED',
  /// Art. 17(3)(b)/(e): erasure refused because something else legally
  /// requires the data - unpaid orders, an open return, a live schedule. The
  /// detail names what, so the answer to the subject can too.
  ERASURE_BLOCKED_BY_OBLIGATION: 'ERASURE_BLOCKED_BY_OBLIGATION',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorDetail {
  /** Dotted path into the request body, e.g. `items.0.quantity`. */
  field?: string;
  code?: string;
  message?: string;
  /** Machine-readable context the UI can interpolate, e.g. { minimum: 10 }. */
  meta?: Record<string, string | number | boolean | null>;
}

/**
 * The only error type the HTTP layer knows how to render. Anything else that
 * reaches the error handler becomes an INTERNAL_ERROR with a safe message and
 * no stack trace on the wire.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCodeValue;
  readonly details: ErrorDetail[];
  /** Attached to the log entry only; never serialised to the client. */
  readonly internalContext?: Record<string, unknown>;
  readonly expose: boolean;

  constructor(params: {
    statusCode: number;
    code: ErrorCodeValue;
    message: string;
    details?: ErrorDetail[];
    internalContext?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(params.message, params.cause === undefined ? undefined : { cause: params.cause });
    this.name = 'AppError';
    this.statusCode = params.statusCode;
    this.code = params.code;
    this.details = params.details ?? [];
    if (params.internalContext !== undefined) this.internalContext = params.internalContext;
    this.expose = params.statusCode < 500;
  }
}

// --- Constructors for the shapes used everywhere ---------------------------

export const badRequest = (
  code: ErrorCodeValue,
  message: string,
  details?: ErrorDetail[],
): AppError => new AppError({ statusCode: 400, code, message, ...(details ? { details } : {}) });

export const unauthorized = (
  code: ErrorCodeValue = ErrorCode.UNAUTHENTICATED,
  message = 'Authentication is required.',
): AppError => new AppError({ statusCode: 401, code, message });

export const forbidden = (
  code: ErrorCodeValue = ErrorCode.FORBIDDEN,
  message = 'You do not have permission to perform this action.',
): AppError => new AppError({ statusCode: 403, code, message });

export const notFound = (resource: string): AppError =>
  new AppError({
    statusCode: 404,
    code: ErrorCode.NOT_FOUND,
    message: `${resource} was not found.`,
  });

export const conflict = (
  code: ErrorCodeValue,
  message: string,
  details?: ErrorDetail[],
): AppError => new AppError({ statusCode: 409, code, message, ...(details ? { details } : {}) });

export const unprocessable = (
  code: ErrorCodeValue,
  message: string,
  details?: ErrorDetail[],
): AppError => new AppError({ statusCode: 422, code, message, ...(details ? { details } : {}) });

export const tooManyRequests = (message = 'Too many requests. Please retry later.'): AppError =>
  new AppError({ statusCode: 429, code: ErrorCode.RATE_LIMITED, message });

export const internal = (message = 'An unexpected error occurred.', cause?: unknown): AppError =>
  new AppError({ statusCode: 500, code: ErrorCode.INTERNAL_ERROR, message, cause });

export const serviceUnavailable = (message: string, cause?: unknown): AppError =>
  new AppError({ statusCode: 503, code: ErrorCode.SERVICE_UNAVAILABLE, message, cause });

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
