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
  IMPORT_FILE_INVALID: 'IMPORT_FILE_INVALID',
  IMPORT_DRY_RUN_REQUIRED: 'IMPORT_DRY_RUN_REQUIRED',
  EXPORT_NOT_READY: 'EXPORT_NOT_READY',
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
