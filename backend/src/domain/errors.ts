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
 *       "code": "CART_ITEM_UNAVAILABLE",
 *       "message": "Some items need attention before you can check out.",
 *       "details": [{ "code": "QUANTITY_BELOW_MINIMUM", "message": "...", "meta": {...} }],
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
  MALWARE_DETECTED: 'MALWARE_DETECTED',
  MALWARE_SCANNER_UNAVAILABLE: 'MALWARE_SCANNER_UNAVAILABLE',
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
  /// Storefront and Seller Hub. The account has two-step sign-in switched on
  /// and THIS session has not passed its code yet. 403. The storefront shows
  /// the code box; only /auth/me, /auth/mfa/challenge and /auth/logout answer.
  MFA_CHALLENGE_REQUIRED: 'MFA_CHALLENGE_REQUIRED',
  /// Storefront and Seller Hub. This person's role (a seller owner, or anybody
  /// holding payout or finance permissions), or the act itself (switching on
  /// AutoPay), needs two-step sign-in and the account has none. 403. The
  /// storefront answers with the setup screen - a prompt, never a dead end.
  MFA_SETUP_REQUIRED: 'MFA_SETUP_REQUIRED',
  /// Asked to switch two-step sign-in off while holding a role that requires
  /// it. 409. Changing the role first is the way out.
  MFA_REQUIRED_BY_ROLE: 'MFA_REQUIRED_BY_ROLE',
  /// A sensitive act - changing the email or password, connecting payouts,
  /// changing team roles, switching on AutoPay, changing two-step sign-in -
  /// needs the person to confirm it is them again, and this session has not
  /// done so within STEP_UP_WINDOW_SECONDS. 403. `details[0].meta.method` is
  /// `TOTP` or `PASSWORD`: which proof the storefront should ask for.
  STEP_UP_REQUIRED: 'STEP_UP_REQUIRED',
  /// The deployment has a bot check switched on (CAPTCHA_PROVIDER) and the
  /// form was sent without its answer. 400.
  CAPTCHA_REQUIRED: 'CAPTCHA_REQUIRED',
  /// The bot check's answer was refused by the provider, or the provider
  /// could not be asked. 400. Fails closed: the form is not accepted.
  CAPTCHA_FAILED: 'CAPTCHA_FAILED',
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

  /**
   * Another variant of this product already sells this exact combination.
   *
   * Distinct from SKU_ALREADY_EXISTS, and the distinction is what the author
   * has to do next. A duplicate SKU means "choose a different code for this
   * thing"; a duplicate combination means "this thing is already listed" -
   * the fix is to edit the existing row, not to rename this one.
   *
   * Raised before the write, from the option signature, so the message can
   * name the SKU that already holds the combination.
   */
  VARIANT_COMBINATION_EXISTS: 'VARIANT_COMBINATION_EXISTS',

  /**
   * A generated variant matrix nobody could check before saving.
   *
   * Four axes of six values each is 1,296 rows. The limit is not a database
   * one - it is the point past which a seller clicks Save on a table they have
   * not read, and a catalogue gains a thousand SKUs with a placeholder price.
   */
  VARIANT_MATRIX_TOO_LARGE: 'VARIANT_MATRIX_TOO_LARGE',

  /**
   * An axis this product's category does not offer.
   *
   * The 112 subcategory templates in `domain/variants/` decide which
   * dimensions a shelf sells along. A request naming one that is not on the
   * list is either a stale client or a category that has been re-parented, and
   * both want to be told which key was not recognised rather than to have it
   * quietly dropped.
   */
  VARIANT_AXIS_NOT_IN_TEMPLATE: 'VARIANT_AXIS_NOT_IN_TEMPLATE',

  /**
   * Listed, readable, and not for sale - two different reasons, two codes.
   *
   * They are separate because the customer has to do two different things. A
   * price on request is an invitation: get in touch and we will quote you. An
   * unavailable product is a wait: it exists, it is not being sold this week,
   * come back. One code covering both would force every client to guess which
   * sentence to show, and the guess would be wrong half the time.
   *
   * Both are also a 409 rather than a 404: the product is genuinely there, and
   * pretending it is not would send somebody looking for a broken link.
   */
  PRODUCT_PRICE_ON_REQUEST: 'PRODUCT_PRICE_ON_REQUEST',
  PRODUCT_NOT_ORDERABLE: 'PRODUCT_NOT_ORDERABLE',

  /**
   * A pack was asked for where the catalogue does not know what a pack holds.
   *
   * Refused rather than quietly treated as one piece. A buyer who asked for two
   * cartons and received two syringes has been failed far worse than one who
   * was told the carton quantity is not on file.
   */
  PACK_SIZE_UNKNOWN: 'PACK_SIZE_UNKNOWN',
  MEDIA_TYPE_NOT_ALLOWED: 'MEDIA_TYPE_NOT_ALLOWED',
  MEDIA_TOO_LARGE: 'MEDIA_TOO_LARGE',

  // --- Image search ---
  //
  // Two codes and not one, because the two failures need different words in
  // front of a customer and different actions from whoever runs the
  // deployment. BUSY is the provider being over quota or overloaded, and the
  // answer is to wait; UNREADABLE is a reply that came back and could not be
  // used, and the answer is to try a clearer photograph or type the name.
  //
  // Deliberately NOT reusing SERVICE_UNAVAILABLE, which the storefront reads
  // as "the whole store is down" and puts a site-wide maintenance banner
  // behind. One camera button failing is not an outage.
  //
  // BUSY also covers a provider that did not answer in time or could not be
  // reached: the customer's move is the same - wait a moment and try again -
  // and the detail code (`busy`, `quota`, `timeout`, `network`) tells the
  // operator which it was. UNAVAILABLE is the one a retry cannot fix: the
  // deployment's key was refused or its model does not exist.
  IMAGE_SEARCH_BUSY: 'IMAGE_SEARCH_BUSY',
  IMAGE_SEARCH_UNREADABLE: 'IMAGE_SEARCH_UNREADABLE',
  IMAGE_SEARCH_UNAVAILABLE: 'IMAGE_SEARCH_UNAVAILABLE',

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
  /// The warehouse is real but has nowhere on the map, so anything measured
  /// from its position cannot be measured at all - today that is the delivery
  /// coverage radius. A separate code from VALIDATION_FAILED because nothing
  /// the caller sent is wrong: the request was well formed and the answer is
  /// that this warehouse has no coordinates, or has coordinates that cannot be
  /// plotted. The message says which of the two, because the fixes differ -
  /// one is "look them up from the address", the other is "correct the numbers
  /// somebody stored". Admin-only, so no storefront screen can receive it.
  LOCATION_NOT_PLACED: 'LOCATION_NOT_PLACED',

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

  // --- Fulfilment options ---
  //
  // Six codes rather than one, because every one of them has a different next
  // step for the buyer and a checkout that collapsed them into "something went
  // wrong" would leave a person re-clicking Pay at a problem only somebody
  // else can fix.

  /// No warehouse published a lane to this destination for this basket.
  /// Not an outage and not a rejection of the request - it is the honest
  /// answer, and the storefront says so and offers the configured shipping
  /// method instead where there is one.
  FULFILMENT_NO_ELIGIBLE_WAREHOUSE: 'FULFILMENT_NO_ELIGIBLE_WAREHOUSE',
  /// The quote lapsed. Nothing is wrong with it except its age; the
  /// storefront re-asks and shows the options again. Never repriced silently:
  /// a total the customer never saw is the one thing a checkout may not
  /// charge.
  FULFILMENT_QUOTE_EXPIRED: 'FULFILMENT_QUOTE_EXPIRED',
  /// The quote does not belong to this customer, does not exist, or was taken
  /// against a country rather than an address. Deliberately one code for all
  /// three: distinguishing "not yours" from "not there" would make this an
  /// oracle for other people's quote ids.
  FULFILMENT_QUOTE_INVALID: 'FULFILMENT_QUOTE_INVALID',
  /// The basket changed after the quote was taken - a line added in another
  /// tab, a quantity edited, a coupon applied. The offer was for a different
  /// basket, so it is refused rather than stretched to cover this one.
  FULFILMENT_QUOTE_STALE: 'FULFILMENT_QUOTE_STALE',
  /// The warehouse went into maintenance, was retired, or had its lane to
  /// this destination closed between the quote and the payment. The customer
  /// picks again; nothing is switched under them.
  FULFILMENT_WAREHOUSE_UNAVAILABLE: 'FULFILMENT_WAREHOUSE_UNAVAILABLE',
  /// Somebody else bought it first. The detail names the lines that are short
  /// and by how much, because "out of stock" with no line named is not
  /// something a buyer can act on - and no substitution is made and no other
  /// warehouse is chosen for them.
  FULFILMENT_STOCK_CHANGED: 'FULFILMENT_STOCK_CHANGED',

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
  /// A receipt was asked for a payment that was never captured, or a refund
  /// the provider has not confirmed. A receipt says money moved; until it
  /// has, there is nothing to acknowledge.
  RECEIPT_NOT_AVAILABLE: 'RECEIPT_NOT_AVAILABLE',

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
  /// The date is in the future but inside the notice period - see
  /// SCHEDULE_MIN_NOTICE_DAYS, and the warehouse's own earliest delivery where
  /// that is later still.
  ///
  /// A separate code from SCHEDULE_DATE_IN_PAST because the two need
  /// different words in front of a person: "that day has gone" and "we need a
  /// week" are different problems with different fixes. The detail carries
  /// `earliest` as a YYYY-MM-DD calendar date, so the storefront can move the
  /// picker to it rather than leaving somebody guessing how far forward to
  /// click.
  SCHEDULE_DATE_TOO_SOON: 'SCHEDULE_DATE_TOO_SOON',
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
  /// The customer asked to pay with an instrument this deployment cannot
  /// offer for this cart - UPI where no gateway serves it, or a card in a
  /// currency no connected gateway settles.
  ///
  /// Distinct from PAYMENT_PROVIDER_NOT_CONFIGURED, which says the operator
  /// has connected nothing at all. This one says something is connected and it
  /// cannot do the specific thing that was asked for, which is a different
  /// sentence to a customer and a different job for an administrator.
  PAYMENT_INSTRUMENT_UNAVAILABLE: 'PAYMENT_INSTRUMENT_UNAVAILABLE',
  /// A stored card was named for a charge its owner never agreed to.
  ///
  /// Raised when a card saved at a checkout - "keep this so I need not type it
  /// again" - is put forward for an off-session charge, which is a different
  /// agreement the customer has not given. Also covers a card whose provider
  /// is no longer connected.
  PAYMENT_METHOD_NOT_CHARGEABLE: 'PAYMENT_METHOD_NOT_CHARGEABLE',
  /// Another payment for this order is already open, or is already being
  /// processed by the bank, and starting a second one could charge twice.
  ///
  /// Raised by Stripe Checkout while a second tab or a second click is still
  /// being answered, and while a payment the customer already submitted is
  /// settling. It is a "wait", not a "no": the first attempt either finishes
  /// or closes, and the order can then be paid.
  PAYMENT_ATTEMPT_IN_PROGRESS: 'PAYMENT_ATTEMPT_IN_PROGRESS',
  /// The order's total cannot be taken by card online in its currency - it is
  /// above the gateway's per-payment ceiling, or it is not a whole number of
  /// the units the gateway settles in (Stripe charges HUF in whole forint).
  ///
  /// Never "fixed" by rounding: rounding a payment changes what the customer
  /// is charged. The order can still be paid by a payment link or by the
  /// operator's offline route.
  PAYMENT_AMOUNT_NOT_SUPPORTED: 'PAYMENT_AMOUNT_NOT_SUPPORTED',

  // --- Localisation & currency ---
  CURRENCY_NOT_SUPPORTED: 'CURRENCY_NOT_SUPPORTED',
  COUNTRY_NOT_SUPPORTED: 'COUNTRY_NOT_SUPPORTED',
  /// The catalogue has no price for this SKU in the requested currency, so it
  /// cannot be sold in it. Never fall back to another currency's number.
  PRICE_UNAVAILABLE_IN_CURRENCY: 'PRICE_UNAVAILABLE_IN_CURRENCY',
  /// The same outcome as above, from a completely different cause: this
  /// deployment DOES sell the SKU in this currency, by converting its base
  /// price, but there is no exchange rate fresh enough to do it with right
  /// now. A separate code rather than a reuse of the one above because the two
  /// need opposite advice - "this is not sold here, choose something else"
  /// against "try again shortly, or switch currency" - and because an operator
  /// seeing the first will go hunting for a missing price row that was never
  /// the problem. Temporary by nature: the next successful rate refresh clears
  /// it without anybody touching the catalogue.
  PRICE_RATE_UNAVAILABLE: 'PRICE_RATE_UNAVAILABLE',

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
  /// The end date the customer gave their standing authority has passed.
  /// Nothing is charged; the customer sets a new date to carry on.
  AUTOPAY_AUTHORITY_EXPIRED: 'AUTOPAY_AUTHORITY_EXPIRED',
  /// The start date the customer gave their standing authority has not come
  /// yet. Nothing is charged.
  AUTOPAY_AUTHORITY_NOT_STARTED: 'AUTOPAY_AUTHORITY_NOT_STARTED',
  /// This charge would take the customer's automatic payments for the
  /// current period above the cap they set. Not charged; the order waits for
  /// them to pay it themselves, which is their explicit approval.
  AUTOPAY_PERIOD_CAP_REACHED: 'AUTOPAY_PERIOD_CAP_REACHED',
  /// The order is from a supplier or in a category the customer's standing
  /// authority does not cover. Not charged; it waits for them.
  AUTOPAY_OUTSIDE_SCOPE: 'AUTOPAY_OUTSIDE_SCOPE',
  /// A scheduled delivery is not waiting for a price confirmation (it was
  /// already confirmed, declined, or its deadline passed).
  SCHEDULE_CONFIRMATION_NOT_PENDING: 'SCHEDULE_CONFIRMATION_NOT_PENDING',
  /// The total the customer confirmed is no longer the total: the price moved
  /// again. Nothing is charged; the new total is shown to confirm afresh.
  SCHEDULE_CONFIRMED_TOTAL_STALE: 'SCHEDULE_CONFIRMED_TOTAL_STALE',
  /// The buyer company's own sign-off rule: the order waits for an approver
  /// or finance before it can be paid.
  BUYER_COMPANY_APPROVAL_PENDING: 'BUYER_COMPANY_APPROVAL_PENDING',
  /// Nobody may sign off an order they placed, and the finance stage may not
  /// be signed off by whoever approved the first.
  BUYER_COMPANY_SELF_APPROVAL: 'BUYER_COMPANY_SELF_APPROVAL',
  /// This stage has already been decided, or the order is no longer waiting.
  BUYER_COMPANY_APPROVAL_NOT_PENDING: 'BUYER_COMPANY_APPROVAL_NOT_PENDING',

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

  /// Somebody asked to move their account to an address another account
  /// already uses, or is already moving to.
  ///
  /// Deliberately the same answer in both cases and deliberately vague about
  /// which: a distinct message for "that address is registered" turns this
  /// endpoint into an oracle for whether a given company buys here, which is
  /// a question a competitor would like answered and the account holder does
  /// not need answered.
  EMAIL_ALREADY_IN_USE: 'EMAIL_ALREADY_IN_USE',
  /// A pending email or telephone change was confirmed, or resent, when there
  /// is no change in flight to confirm.
  CONTACT_CHANGE_NOT_PENDING: 'CONTACT_CHANGE_NOT_PENDING',

  // --- A buyer's own ERP, and the organisation that owns it ---
  //
  // Distinct from every ERP_* code above, which is about the SELLER's ERP and
  // is read by a member of staff in Settings -> ERP. These are read by a
  // BUYER, in their own account, about their own SAP or monday.com. The two
  // sets stay apart because the audiences are different and so are the
  // remedies: a buyer cannot fix the operator's connection and has no business
  // being told about it.

  /// The account is not in a buyer organisation yet, and something that needs
  /// one was attempted. Ordinarily impossible - one is provisioned on first
  /// use - so this means an account with no customer profile, or an
  /// organisation that has since been archived.
  ORGANIZATION_REQUIRED: 'ORGANIZATION_REQUIRED',
  /// The member's role does not permit this. Configuring credentials and
  /// mappings is OWNER and INTEGRATION_MANAGER only; a MEMBER may look.
  ORGANIZATION_ROLE_INSUFFICIENT: 'ORGANIZATION_ROLE_INSUFFICIENT',
  /// Removing or demoting the last owner was refused. An organisation with no
  /// owner has nobody who can grant anybody else access to it, which is not a
  /// state anything can recover from without support.
  ORGANIZATION_LAST_OWNER: 'ORGANIZATION_LAST_OWNER',
  /// The invitation does not exist, has expired, was withdrawn, was already
  /// used, or is addressed to a different email address than the one signed
  /// in. Deliberately one code for all five: an endpoint that distinguishes
  /// them is an oracle for who has been invited where.
  ORGANIZATION_INVITE_INVALID: 'ORGANIZATION_INVITE_INVALID',
  /// The account already belongs to an organisation. A profile belongs to at
  /// most one - see `BuyerOrganizationMember` - so joining a second means
  /// leaving the first, which is a decision rather than a side effect.
  ORGANIZATION_ALREADY_MEMBER: 'ORGANIZATION_ALREADY_MEMBER',

  /// The address is not one this server will call: not https, missing a host,
  /// carrying credentials in the URL, resolving to a private, loopback or
  /// link-local network, or outside the host policy this deployment allows.
  /// The detail says which.
  CUSTOMER_ERP_URL_NOT_ALLOWED: 'CUSTOMER_ERP_URL_NOT_ALLOWED',
  /// An endpoint path pointed at a different origin from the base URL.
  /// Refused, because an "endpoint" free to leave the authorised host is a
  /// server-side request forgery primitive with a form field in front of it.
  CUSTOMER_ERP_ENDPOINT_OFF_ORIGIN: 'CUSTOMER_ERP_ENDPOINT_OFF_ORIGIN',
  /// Something is being sent that has no endpoint configured for it. Names
  /// what, because the remedy is either to add the endpoint or to switch that
  /// event off in the sync rules.
  CUSTOMER_ERP_ENDPOINT_MISSING: 'CUSTOMER_ERP_ENDPOINT_MISSING',
  /// The connection is not in a state that allows what was asked - activating
  /// a draft that has not been tested, resuming one that was never paused.
  /// The message names the current state.
  CUSTOMER_ERP_STATE_INVALID: 'CUSTOMER_ERP_STATE_INVALID',
  /// Activation was refused because no test has passed since the configuration
  /// last changed. Separate from the code above because it names the remedy.
  CUSTOMER_ERP_UNTESTED: 'CUSTOMER_ERP_UNTESTED',
  /// The field mapping is missing something required, maps one field twice, or
  /// points at a path that is not present in the sample response.
  CUSTOMER_ERP_MAPPING_INVALID: 'CUSTOMER_ERP_MAPPING_INVALID',
  /// Activation was refused because the mapping has never been checked against
  /// a real response from this connection.
  CUSTOMER_ERP_MAPPING_UNVERIFIED: 'CUSTOMER_ERP_MAPPING_UNVERIFIED',
  /// The ERP answered, but not with anything this connection can use: not
  /// JSON, or JSON with no array of records where the mapping says one is.
  CUSTOMER_ERP_RESPONSE_UNUSABLE: 'CUSTOMER_ERP_RESPONSE_UNUSABLE',
  /// The buyer's ERP refused our credentials - its own 401 or 403, reported as
  /// itself rather than as a generic failure, because the remedy is entirely
  /// different from a network fault.
  CUSTOMER_ERP_AUTH_FAILED: 'CUSTOMER_ERP_AUTH_FAILED',
  /// An OAuth access token has expired and could not be refreshed. The buyer
  /// has to authorise again; the connection sits in ACTION_REQUIRED until they
  /// do, rather than retrying a grant that will keep being refused.
  CUSTOMER_ERP_TOKEN_EXPIRED: 'CUSTOMER_ERP_TOKEN_EXPIRED',
  /// The OAuth authorisation or token exchange failed: a refused grant, a
  /// mismatched redirect URI, a state that does not belong to this flow.
  CUSTOMER_ERP_OAUTH_FAILED: 'CUSTOMER_ERP_OAUTH_FAILED',
  /// The buyer's ERP asked us to slow down. Carries its `Retry-After` where it
  /// gave one.
  CUSTOMER_ERP_RATE_LIMITED: 'CUSTOMER_ERP_RATE_LIMITED',
  /// Repeated failures took the connection out of service. It will not be
  /// called again until a test passes.
  CUSTOMER_ERP_SUSPENDED: 'CUSTOMER_ERP_SUSPENDED',
  /// A webhook arrived whose signature did not verify, whose timestamp was
  /// outside the replay window, or for a connection with no signing secret.
  /// Never says which: an endpoint that distinguishes those is an oracle.
  CUSTOMER_ERP_WEBHOOK_REJECTED: 'CUSTOMER_ERP_WEBHOOK_REJECTED',
  /// A sync was asked for while one is already running on this connection.
  CUSTOMER_ERP_SYNC_ALREADY_RUNNING: 'CUSTOMER_ERP_SYNC_ALREADY_RUNNING',
  /// An event was asked to move somewhere its lifecycle does not allow - most
  /// often retrying one that has already succeeded, which would mean a second
  /// purchase order.
  CUSTOMER_ERP_EVENT_STATE_INVALID: 'CUSTOMER_ERP_EVENT_STATE_INVALID',
  /// The write is over the organisation's approval threshold, or the policy
  /// requires a person for this kind of write. An approval has been raised and
  /// the event is holding; nothing has been sent.
  CUSTOMER_ERP_APPROVAL_REQUIRED: 'CUSTOMER_ERP_APPROVAL_REQUIRED',
  /// The organisation already holds as many connections as this deployment
  /// permits.
  CUSTOMER_ERP_LIMIT_REACHED: 'CUSTOMER_ERP_LIMIT_REACHED',
  /// The chosen combination is refused on purpose: a monday personal token on
  /// a production connection, an automatic inventory write from a sandbox, a
  /// credential type the selected system does not accept. The message names
  /// which, because every one of them has a legitimate alternative.
  CUSTOMER_ERP_CONFIGURATION_REFUSED: 'CUSTOMER_ERP_CONFIGURATION_REFUSED',
  /// The uploaded OpenAPI document could not be read, or described nothing
  /// this connector could use.
  CUSTOMER_ERP_SPEC_UNUSABLE: 'CUSTOMER_ERP_SPEC_UNUSABLE',
  /// A product-code mapping could not be made: the code is already mapped to a
  /// different product on this connection, the product does not exist, or an
  /// uploaded mapping file could not be read. The message names which, and for
  /// a file it names the line.
  ///
  /// A NEW code rather than a reuse of `CUSTOMER_ERP_MAPPING_INVALID`, which
  /// both frontends already map to a message about FIELD mapping - "which part
  /// of your ERP's response holds the SKU". A buyer told that, after uploading
  /// a file of product codes, would go and look at the wrong screen.
  CUSTOMER_ERP_PRODUCT_CODE_INVALID: 'CUSTOMER_ERP_PRODUCT_CODE_INVALID',

  // --- Seller Hub ---
  //
  // New codes throughout. Nothing here reuses an existing one, because both
  // frontends map every code to a sentence in eight languages and repurposing
  // one silently changes what a buyer is told somewhere else.

  /// The signed-in account has no seller organisation. Distinct from
  /// SELLER_NOT_APPROVED: this one means "you have not applied", and the
  /// action is to start an application rather than to wait.
  SELLER_ACCOUNT_REQUIRED: 'SELLER_ACCOUNT_REQUIRED',
  /// There is an application, and it has not been approved. The message names
  /// the state, because "submitted" and "action required" need opposite
  /// responses from the seller.
  SELLER_NOT_APPROVED: 'SELLER_NOT_APPROVED',
  /// The account was approved and has since been stopped. Kept apart from
  /// SELLER_NOT_APPROVED so a suspended seller is never told to finish an
  /// application they already finished.
  SELLER_SUSPENDED: 'SELLER_SUSPENDED',
  /// The member holds a seller role that does not carry this action - a
  /// Finance Viewer editing a listing, a Support Member issuing a payout.
  SELLER_ROLE_DENIED: 'SELLER_ROLE_DENIED',
  /// The row exists and belongs to a different seller. Returned as 404 by the
  /// route layer for the same reason `assertOwnership` does: confirming that
  /// somebody else's listing exists is itself a leak.
  SELLER_RESOURCE_DENIED: 'SELLER_RESOURCE_DENIED',

  /// This person has not chosen a Seller Hub password yet.
  ///
  /// Selling shares the account somebody buys with and puts a second password
  /// in front of the Hub. Three codes rather than one, because the three want
  /// three different screens and a single "locked" would leave the frontend
  /// guessing which: this one offers a "choose it" form, LOCKED offers an
  /// "enter it" form, and INVALID is what the second form shows when the answer
  /// was wrong.
  SELLER_LOCK_NOT_SET: 'SELLER_LOCK_NOT_SET',
  /// The lock exists and this session has not opened it.
  SELLER_LOCK_REQUIRED: 'SELLER_LOCK_REQUIRED',
  /// The seller password given was wrong.
  SELLER_LOCK_INVALID: 'SELLER_LOCK_INVALID',
  /// The Hub was open and has re-locked itself after
  /// SELLER_HUB_IDLE_TIMEOUT_SECONDS without deliberate activity. Its own code
  /// rather than LOCK_REQUIRED, so the lock screen can say why it is back: "your
  /// session expired due to inactivity", not "enter your password" out of
  /// nowhere. The remedy is the same - enter the Seller Hub password.
  SELLER_SESSION_EXPIRED: 'SELLER_SESSION_EXPIRED',

  /// The public display name is taken.
  SELLER_DISPLAY_NAME_TAKEN: 'SELLER_DISPLAY_NAME_TAKEN',
  /// The application cannot move the way it was asked to. Same shape as
  /// ORDER_TRANSITION_NOT_ALLOWED and separate from it, because the states and
  /// the remedies are different.
  SELLER_APPLICATION_TRANSITION_NOT_ALLOWED: 'SELLER_APPLICATION_TRANSITION_NOT_ALLOWED',
  /// Submission was refused because required onboarding steps are unfinished.
  /// `details` carries one entry per missing step, keyed to the step so the
  /// interface can link straight to it.
  SELLER_ONBOARDING_INCOMPLETE: 'SELLER_ONBOARDING_INCOMPLETE',
  /// A rejected application whose operator closed resubmission.
  SELLER_RESUBMISSION_NOT_ALLOWED: 'SELLER_RESUBMISSION_NOT_ALLOWED',
  /// Approval refused: the evidence a reviewer needs is not all there yet. A
  /// required onboarding step is unfinished, a required document is not
  /// accepted or has expired, or (with SELLER_REQUIRE_SCREENING) the business
  /// or one of its owners has no current CLEAR screening. `details` carries
  /// one entry per missing item: `STEP_INCOMPLETE` (field = step key),
  /// `DOCUMENT_NOT_APPROVED` / `DOCUMENT_EXPIRED` (field = requirement key),
  /// `SCREENING_REQUIRED` / `SCREENING_NOT_CLEAR` (field = `entity` or the
  /// owner id).
  SELLER_APPROVAL_EVIDENCE_MISSING: 'SELLER_APPROVAL_EVIDENCE_MISSING',
  /// Somebody else saved this application, listing or offer since it was
  /// loaded. The client reloads and shows what changed rather than
  /// overwriting it.
  SELLER_STALE_VERSION: 'SELLER_STALE_VERSION',

  /// The last owner cannot be removed or demoted. An organisation with no
  /// owner has nobody who can invite one.
  SELLER_LAST_OWNER: 'SELLER_LAST_OWNER',
  /// The invitation is expired, already accepted, revoked, or addressed to a
  /// different email than the one signed in.
  SELLER_INVITATION_INVALID: 'SELLER_INVITATION_INVALID',
  /// This account already belongs to a seller organisation. One profile, one
  /// seller - see `SellerMember`.
  SELLER_MEMBERSHIP_EXISTS: 'SELLER_MEMBERSHIP_EXISTS',
  /// That address already has an invitation to this seller's team that can
  /// still be accepted. Resend it rather than sending a second one.
  SELLER_INVITATION_EXISTS: 'SELLER_INVITATION_EXISTS',
  /// That person is already an active member of this seller's team. Change
  /// their role instead.
  SELLER_ALREADY_MEMBER: 'SELLER_ALREADY_MEMBER',
  /// That member cannot be changed or removed by the caller.
  /// `details[0].code` is SELF (nobody changes or removes themselves) or
  /// ROLE_ABOVE_YOURS (their role carries a permission the caller does not
  /// hold - an admin cannot touch an owner).
  SELLER_MEMBER_PROTECTED: 'SELLER_MEMBER_PROTECTED',
  /// One invitation has been emailed as many times as it may be. Withdraw it
  /// and invite again. `details[0].meta.max` is the cap.
  SELLER_INVITATION_SEND_LIMIT: 'SELLER_INVITATION_SEND_LIMIT',

  /// A listing draft cannot move the way it was asked to.
  LISTING_TRANSITION_NOT_ALLOWED: 'LISTING_TRANSITION_NOT_ALLOWED',
  /// Submission refused: required sections do not pass. `details` carries one
  /// entry per blocking issue, each naming its section and attribute, so the
  /// interface puts every refusal beside the field that caused it rather than
  /// showing one sentence at the top.
  LISTING_NOT_SUBMITTABLE: 'LISTING_NOT_SUBMITTABLE',
  /// A value failed its category attribute definition - wrong type, outside
  /// bounds, not an allowed option, failed the pattern.
  LISTING_ATTRIBUTE_INVALID: 'LISTING_ATTRIBUTE_INVALID',
  /// A required image slot is empty, or an uploaded image failed a check.
  LISTING_IMAGE_REQUIRED: 'LISTING_IMAGE_REQUIRED',
  /// The title cannot be generated yet because a title-component attribute is
  /// missing or invalid. This is what keeps "Preview title" from producing a
  /// half-title that a seller then believes.
  LISTING_TITLE_NOT_READY: 'LISTING_TITLE_NOT_READY',
  /// Policy does not let this seller edit a generated title.
  LISTING_TITLE_NOT_EDITABLE: 'LISTING_TITLE_NOT_EDITABLE',
  /// This seller already uses that SKU on another offer or draft.
  SELLER_SKU_ALREADY_EXISTS: 'SELLER_SKU_ALREADY_EXISTS',
  /// This seller already has an offer on this product and variant. A second
  /// one would put the same seller against themselves on the buyer's page.
  SELLER_OFFER_ALREADY_EXISTS: 'SELLER_OFFER_ALREADY_EXISTS',
  /// The pack hierarchy does not multiply out - units per pack times packs per
  /// box does not give the stated units per box, or a figure is zero.
  LISTING_PACK_CONVERSION_INVALID: 'LISTING_PACK_CONVERSION_INVALID',
  /// Volume price bands overlap, or a band is not cheaper than the one below.
  SELLER_PRICE_TIER_INVALID: 'SELLER_PRICE_TIER_INVALID',
  /// The offer is stored in an ordering unit a seller may not sell in.
  ///
  /// A third-party seller sells by the PIECE. The carton belongs to the
  /// operator, and an offer carrying it — written before the two were told
  /// apart, or brought in by an import — cannot be priced without guessing
  /// whether the seller meant their figure per piece or per five hundred of
  /// them. Guessing is what this code exists to refuse: the offer is held for
  /// the seller to restate rather than multiplied by a number nobody agreed to.
  SELLER_OFFER_UNIT_UNSUPPORTED: 'SELLER_OFFER_UNIT_UNSUPPORTED',
  /// The request named an ordering unit this offer is not sold in.
  ///
  /// A client asking for a seller's piece offer "by the carton" is either out
  /// of date or probing. Either way the honest answer is a refusal, not a
  /// quantity five hundred times the one the shopper was shown.
  SELLER_OFFER_UNIT_MISMATCH: 'SELLER_OFFER_UNIT_MISMATCH',

  /// The brand is not approved for use on a published listing.
  BRAND_NOT_APPROVED: 'BRAND_NOT_APPROVED',
  /// A brand by that name already exists, or a request for it is already
  /// pending. The message names which and links to it - a seller refused
  /// without being told where the existing one is will simply ask again.
  BRAND_ALREADY_EXISTS: 'BRAND_ALREADY_EXISTS',

  /// The seller has no location that can hold or dispatch this.
  SELLER_LOCATION_REQUIRED: 'SELLER_LOCATION_REQUIRED',
  /// The location code is already used by this seller.
  SELLER_LOCATION_CODE_EXISTS: 'SELLER_LOCATION_CODE_EXISTS',
  /// Stock would go negative, or the conditional update lost a race. The
  /// caller retries; it is not a validation failure.
  SELLER_INVENTORY_CONFLICT: 'SELLER_INVENTORY_CONFLICT',

  /// The seller's part of an order cannot move the way it was asked to.
  SELLER_ORDER_TRANSITION_NOT_ALLOWED: 'SELLER_ORDER_TRANSITION_NOT_ALLOWED',
  /// More units were claimed as dispatched or returned than the line holds.
  SELLER_FULFILMENT_QUANTITY_INVALID: 'SELLER_FULFILMENT_QUANTITY_INVALID',

  /// The deployment has no payout provider configured, so payout onboarding
  /// cannot start.
  ///
  /// The single most important code in this block. It exists so that "we
  /// cannot verify a bank account here" can never be rendered as "verified":
  /// the screen shows a configuration-required state naming the environment
  /// variable, and no verification row is written.
  SELLER_PAYOUT_PROVIDER_UNCONFIGURED: 'SELLER_PAYOUT_PROVIDER_UNCONFIGURED',
  /// The payout account exists but the provider will not pay it yet, or the
  /// operator is holding it. The message says which and what is outstanding.
  SELLER_PAYOUT_NOT_ELIGIBLE: 'SELLER_PAYOUT_NOT_ELIGIBLE',
  /// A settlement that is not closed, already paid, or on hold.
  SELLER_SETTLEMENT_NOT_PAYABLE: 'SELLER_SETTLEMENT_NOT_PAYABLE',

  /// A document was refused: wrong type, too large, failed its scan, or the
  /// scanner is unavailable and the deployment refuses unscanned uploads.
  SELLER_DOCUMENT_REJECTED: 'SELLER_DOCUMENT_REJECTED',
  /// A required agreement has not been accepted at its current version.
  SELLER_AGREEMENT_REQUIRED: 'SELLER_AGREEMENT_REQUIRED',

  // --- Logistics partner portal -------------------------------------------
  //
  // A third tenant with a third vocabulary. None of the seller codes above is
  // reused, for the same reason the permission catalogues are separate: a
  // route that accepted either would eventually be reached by both.

  /// The signed-in account is not a member of any logistics organisation. The
  /// portal turns this into "this account has no carrier attached to it",
  /// which is a support conversation rather than a screen with a button.
  LOGISTICS_PARTNER_REQUIRED: 'LOGISTICS_PARTNER_REQUIRED',
  /// The organisation exists but the marketplace has suspended or deactivated
  /// it. Distinct from the code above because the remedy is different: there
  /// is an account, and somebody has to reinstate it.
  LOGISTICS_PARTNER_NOT_ACTIVE: 'LOGISTICS_PARTNER_NOT_ACTIVE',
  /// The member's own access was disabled while the organisation stayed
  /// active. Their colleagues can still sign in; they cannot.
  LOGISTICS_MEMBER_DISABLED: 'LOGISTICS_MEMBER_DISABLED',
  /// Signed in, but this session has not passed its TOTP challenge and the
  /// caller's role requires one. The portal turns it into the challenge
  /// screen. Deliberately NOT `MFA_REQUIRED`, which the other two surfaces
  /// use to mean "supply a code with your password" at the login step.
  LOGISTICS_MFA_SETUP_REQUIRED: 'LOGISTICS_MFA_SETUP_REQUIRED',
  LOGISTICS_MFA_CHALLENGE_REQUIRED: 'LOGISTICS_MFA_CHALLENGE_REQUIRED',

  /// The shipment cannot move the way it was asked to. Carries `from` and
  /// `to` in the detail meta so the portal can say which move was refused.
  SHIPMENT_TRANSITION_NOT_ALLOWED: 'SHIPMENT_TRANSITION_NOT_ALLOWED',
  /// Delivered was asked for and the deployment's Proof of Delivery policy is
  /// not satisfied. Its own code because the remedy is a form, not a retry.
  SHIPMENT_POD_REQUIRED: 'SHIPMENT_POD_REQUIRED',
  /// An operator status correction was refused - wrong actor, no reason, or
  /// nothing to correct.
  SHIPMENT_CORRECTION_NOT_ALLOWED: 'SHIPMENT_CORRECTION_NOT_ALLOWED',
  /// The shipment is not assigned to the caller's organisation, or the
  /// assignment has been withdrawn. Returned only where the caller already
  /// knows the shipment exists - a bare lookup answers NOT_FOUND, on the same
  /// reasoning as `assertOwnership`.
  SHIPMENT_NOT_ASSIGNED: 'SHIPMENT_NOT_ASSIGNED',
  /// The assignment has already been accepted or rejected. A second answer to
  /// a question that was already answered.
  SHIPMENT_ASSIGNMENT_SETTLED: 'SHIPMENT_ASSIGNMENT_SETTLED',
  /// A delivery OTP did not match, or has expired.
  ///
  /// `details[0]` names the `otp` field, and its `code` says which: `MISSING`,
  /// `INVALID`, `EXPIRED`, `NOT_SENT` (no live code - send one) or
  /// `TOO_MANY_ATTEMPTS` (this code is dead - send a new one).
  SHIPMENT_OTP_INVALID: 'SHIPMENT_OTP_INVALID',
  /// A delivery code cannot be sent for this consignment at all.
  ///
  /// `details[0].code` says why: `NOT_REQUIRED` (its policy asks for no code),
  /// `NOT_OUT_FOR_DELIVERY` (codes are sent only while it is on the van) or
  /// `NO_RECIPIENT` (no buyer account to send it to - the operator has to
  /// change the delivery's service level). Waiting fixes none of them.
  SHIPMENT_OTP_UNAVAILABLE: 'SHIPMENT_OTP_UNAVAILABLE',
  /// A new delivery code was asked for too soon after the last one, or the
  /// consignment has had as many codes as it may have today. HTTP 429.
  /// `details[0].code` is `TOO_SOON` (with `meta.retryAt`) or
  /// `DAILY_LIMIT_REACHED`.
  SHIPMENT_OTP_RESEND_LIMITED: 'SHIPMENT_OTP_RESEND_LIMITED',

  /// A pickup cannot be scheduled or completed in its current state.
  /// A SELLER asked to hand a consignment to a carrier they are not entitled
  /// to use: no arrangement, one that is not approved, one that is suspended
  /// or out of its dates, or one that does not cover this route or this
  /// handling.
  ///
  /// Distinct from `LOGISTICS_PARTNER_NOT_ACTIVE`, which is about the carrier
  /// itself and applies to everybody, and from `LOGISTICS_DRIVER_NOT_ELIGIBLE`,
  /// which is the carrier's own half of the same split. The remedy differs for
  /// each: reinstate the carrier, request the arrangement, or pick another
  /// driver. The message carries the specific reason.
  ///
  /// Deliberately also returned for a carrier that does not exist at all, so
  /// this endpoint cannot be used to enumerate the marketplace's carriers.
  LOGISTICS_PARTNER_NOT_ELIGIBLE: 'LOGISTICS_PARTNER_NOT_ELIGIBLE',

  /// The consignment has finished - delivered, cancelled, returned, lost or
  /// destroyed - and cannot be assigned, reassigned or moved on.
  LOGISTICS_SHIPMENT_TERMINAL: 'LOGISTICS_SHIPMENT_TERMINAL',

  LOGISTICS_PICKUP_NOT_ACTIONABLE: 'LOGISTICS_PICKUP_NOT_ACTIONABLE',
  /// A manifest cannot take this shipment - wrong partner, wrong status, or
  /// the manifest is already closed.
  LOGISTICS_MANIFEST_NOT_ACTIONABLE: 'LOGISTICS_MANIFEST_NOT_ACTIONABLE',
  /// The driver is not this organisation's, is not active, or lacks the
  /// approval the shipment's handling requirements demand.
  LOGISTICS_DRIVER_NOT_ELIGIBLE: 'LOGISTICS_DRIVER_NOT_ELIGIBLE',

  /// A location ping was refused. One code with a detail rather than five
  /// codes, because the caller is a phone in a van and its only sensible
  /// response to any of them is to drop the ping and carry on: impossible
  /// coordinates, a timestamp too far in the past or future, a speed no
  /// vehicle achieves, a sequence number already seen, or no active trip.
  LOGISTICS_LOCATION_PING_REJECTED: 'LOGISTICS_LOCATION_PING_REJECTED',
  /// The caller asked for a driver's position and holds no authority to read
  /// one, or the trip is not running. Separate from PERMISSION_DENIED because
  /// the portal must not offer a retry: there is nothing to retry.
  LOGISTICS_LOCATION_NOT_AVAILABLE: 'LOGISTICS_LOCATION_NOT_AVAILABLE',

  /**
   * The carrier this operation needs has no credentials configured.
   *
   * The most important code in this block, and the counterpart of
   * `SELLER_PAYOUT_PROVIDER_UNCONFIGURED`. It exists so that "we cannot reach
   * DHL from this installation" can never be rendered as "booked with DHL":
   * the screen shows a configuration-required state naming the environment
   * variables, and no shipment, label or pickup is recorded as created.
   */
  CARRIER_PROVIDER_UNCONFIGURED: 'CARRIER_PROVIDER_UNCONFIGURED',
  /// The carrier answered, and answered with a refusal. The message carries
  /// their own words where they are safe to repeat. Also raised when the
  /// carrier did not answer in time or could not be reached - either way
  /// nothing was booked - with detail code CARRIER_TIMEOUT (HTTP 504) or
  /// CARRIER_UNREACHABLE (502) in place of CARRIER_REFUSED.
  CARRIER_REQUEST_FAILED: 'CARRIER_REQUEST_FAILED',
  /// A webhook's signature did not verify, its timestamp was outside the
  /// accepted window, or its event id had already been processed. One code:
  /// the sender is a machine, the response is a 4xx it will log, and telling
  /// it which of the three would help an attacker tune the next attempt.
  CARRIER_WEBHOOK_REJECTED: 'CARRIER_WEBHOOK_REJECTED',

  // --- How a seller's own goods get delivered -------------------------------

  /**
   * The provider genuinely cannot do this, and no credential would change it.
   *
   * Distinct from CARRIER_PROVIDER_UNCONFIGURED, and the distinction is the
   * whole reason this code exists. That one means "this installation has not
   * finished setting DHL up"; this one means "India Post does not offer a
   * rate API to anybody". The first is somebody's task, the second is a fact
   * about the world, and a seller shown one when the other is true either
   * chases a key that does not exist or gives up on a key they could get.
   *
   * `details[0].meta` carries `provider` and `operation`.
   */
  CARRIER_OPERATION_NOT_SUPPORTED: 'CARRIER_OPERATION_NOT_SUPPORTED',

  /// The seller has no fulfilment method that can carry this consignment.
  ///
  /// Raised after the whole hierarchy has been walked and nothing eligible
  /// remains. `details` carries one entry per method that was considered and
  /// the reason it was passed over, because "no carrier available" with
  /// nothing else in it is a support ticket.
  SELLER_FULFILMENT_NO_ELIGIBLE_METHOD: 'SELLER_FULFILMENT_NO_ELIGIBLE_METHOD',

  /// The method exists and is not usable yet - draft, in setup, awaiting the
  /// marketplace, paused, rejected or disconnected. The message says which.
  SELLER_FULFILMENT_METHOD_NOT_APPROVED: 'SELLER_FULFILMENT_METHOD_NOT_APPROVED',

  /// A status move the fulfilment-method state machine does not allow.
  ///
  /// The same shape as ORDER_TRANSITION_INVALID and for the same reason: a
  /// status that can be set to anything from anywhere is a status that
  /// eventually is.
  SELLER_FULFILMENT_TRANSITION_INVALID: 'SELLER_FULFILMENT_TRANSITION_INVALID',

  /// A seller tried to make a second method primary, or a second fallback.
  ///
  /// Mapped from the database's own refusal rather than checked first: two
  /// browser tabs saving at once is exactly the race a pre-check loses.
  SELLER_FULFILMENT_ROLE_TAKEN: 'SELLER_FULFILMENT_ROLE_TAKEN',

  /// A rule naming something that is not the seller's, or a scope whose match
  /// column is missing. The database refuses it too; this is what the seller
  /// is told.
  SELLER_FULFILMENT_RULE_INVALID: 'SELLER_FULFILMENT_RULE_INVALID',

  /// A carrier connection cannot go live yet.
  ///
  /// Both gates are named in the message: a test that genuinely reached the
  /// carrier, and a person at the seller confirming they want real parcels
  /// shipped with it. A saved form is not a working integration and this is
  /// the code that says so.
  SELLER_CARRIER_CONNECTION_NOT_READY: 'SELLER_CARRIER_CONNECTION_NOT_READY',

  /// The credential this connection needs is absent, or will not decrypt.
  ///
  /// One code for both, deliberately. Which of the two it is tells an attacker
  /// whether a credential exists for a given seller and carrier, and tells the
  /// seller nothing they can act on differently - the fix is the same: enter
  /// it again.
  SELLER_CARRIER_CREDENTIAL_UNAVAILABLE: 'SELLER_CARRIER_CREDENTIAL_UNAVAILABLE',

  /// A seller tried to reach a delivery company that is not theirs.
  ///
  /// Covers a self-managed organisation owned by another seller and a
  /// dedicated partner with no active relationship. Deliberately does not say
  /// which: a seller learning that a given company exists, and that somebody
  /// else uses it, is a disclosure nobody authorised.
  SELLER_LOGISTICS_PARTNER_NOT_YOURS: 'SELLER_LOGISTICS_PARTNER_NOT_YOURS',

  /// An invitation token that is unknown, spent, withdrawn or out of date.
  ///
  /// One code for all four, on the same reasoning as the webhook code above:
  /// the holder of a bad token learns only that it did not work.
  SELLER_PARTNER_INVITATION_INVALID: 'SELLER_PARTNER_INVITATION_INVALID',

  /// This consignment has already been bought at the provider.
  ///
  /// Carries the original purchase's tracking number in
  /// `details[0].meta.trackingNumber`, because the caller that hit this is
  /// almost always a retry that wants the first answer rather than an error.
  SHIPMENT_ALREADY_PURCHASED: 'SHIPMENT_ALREADY_PURCHASED',

  /// The quote being accepted has expired, been superseded, or belongs to
  /// another consignment. Never silently re-priced: the shipment asks again.
  CARRIER_QUOTE_NOT_USABLE: 'CARRIER_QUOTE_NOT_USABLE',

  /// A collection was asked to move somewhere it cannot go from where it is.
  ///
  /// Carries `details[0].meta.from` and `.to`. A 409 rather than a 400: the
  /// request was well formed and the answer depends on what has happened
  /// since - a driver's phone retrying "collected" against a collection that
  /// was cancelled an hour ago is told the truth rather than silently winning.
  PICKUP_TRANSITION_INVALID: 'PICKUP_TRANSITION_INVALID',

  /// This consignment already has a collection booked that has not happened.
  ///
  /// Refused rather than booked, because two vans is expensive in a way one
  /// missed van is not: the second booking is chargeable, and it is the one
  /// nobody remembers to cancel. `details[0].meta.pickupId` names the existing
  /// one so the screen can offer to show or cancel it.
  PICKUP_ALREADY_BOOKED: 'PICKUP_ALREADY_BOOKED',

  /// The consignment has no way of being collected yet.
  ///
  /// Either no delivery method has been chosen for it, or the method chosen
  /// arranges its own collection and there is nothing for a seller to book.
  PICKUP_NOT_AVAILABLE: 'PICKUP_NOT_AVAILABLE',

  // --- Console notifications ----------------------------------------------

  /// Somebody pressed "resolve" on an alert that only the underlying domain
  /// event may close.
  ///
  /// The refusal is the feature. An alert about a temperature excursion, a
  /// failed payment or an ERP reconciliation is closed by fixing the thing,
  /// not by tidying the bell - otherwise the quickest way to make a compliance
  /// problem disappear is to click past it. The message names the screen where
  /// the real decision is made, and `details[0].meta.entity` carries the
  /// entity so the panel can link straight to it.
  NOTIFICATION_NOT_MANUALLY_RESOLVABLE: 'NOTIFICATION_NOT_MANUALLY_RESOLVABLE',

  /// A resolve or dismiss was aimed at a row that is not an alert.
  ///
  /// "A customer placed an order" has no problem to resolve; the only thing a
  /// reader can do with it is read it. Separate from the code above because
  /// the fix is different: that one says "use the other screen", this one says
  /// "there is nothing here to close".
  NOTIFICATION_NOT_AN_ALERT: 'NOTIFICATION_NOT_AN_ALERT',

  // --- The assistant --------------------------------------------------------

  /**
   * A visitor with no account has used up the free questions.
   *
   * Its own code rather than a 401 or a rate-limit, because it is neither and
   * the storefront has to tell them apart to answer correctly:
   *
   *   - `UNAUTHENTICATED` means the assistant is not open to guests at all on
   *     this deployment. There is nothing to do but sign in, and no preview of
   *     anything.
   *   - `RATE_LIMITED` means "too fast, try in a minute". Waiting fixes it.
   *   - This one means "you have had the free questions, and waiting will not
   *     give you more". The only way on is an account.
   *
   * The storefront answers it with a sign-in prompt rather than an error
   * banner, and the transcript stays on screen behind it — what they already
   * got is theirs to read, and taking it away at the moment of asking for an
   * account is the worst possible trade.
   *
   * `details[0].meta` carries `limit` and `used`, so the wording can be
   * specific about a figure the operator sets rather than one hard-coded into
   * eight translations.
   */
  ASSISTANT_GUEST_LIMIT_REACHED: 'ASSISTANT_GUEST_LIMIT_REACHED',

  // --- Bulk ordering: carton, pallet, container -----------------------------

  /// The buyer asked for a package this seller does not offer on this variant.
  ///
  /// `details[0].meta.packageType` names what was asked for and `.available`
  /// is a comma-separated list of what actually is offered - a string rather
  /// than an array because `meta` is a flat map of scalars and widening it
  /// would change the shape of every error this API has ever returned. The
  /// storefront splits it, so it can say "US pallet ordering is not configured
  /// for this variant" and then show the options that are, rather than a bare
  /// failure.
  PACKAGING_OPTION_NOT_AVAILABLE: 'PACKAGING_OPTION_NOT_AVAILABLE',

  /// The seller has switched the package on and not finished describing it.
  ///
  /// Deliberately separate from NOT_AVAILABLE. That one means "this seller
  /// does not sell pallets"; this means "they do, and the configuration is
  /// half-written, so nobody can be told what a pallet holds". The first is a
  /// dead end for the buyer, the second is something the seller can fix today
  /// - and the seller's own listing screen shows exactly which field.
  PACKAGING_OPTION_INCOMPLETE: 'PACKAGING_OPTION_INCOMPLETE',

  /// The unit named on the request is not the packaging the line is sold in.
  ///
  /// Refused rather than reinterpreted, in both directions. Reading "2
  /// cartons" on a pallet line as a piece count and rounding up would buy a
  /// whole pallet; reading "2 pallets" on a carton line the same way would
  /// buy two cartons. There is no generous reading that is not a mistake, so
  /// there is no generous reading. `details[0].meta` carries `expected` and
  /// `received`.
  PACKAGING_UNIT_MISMATCH: 'PACKAGING_UNIT_MISMATCH',

  /// The seller re-specified the packaging while it sat in somebody's basket.
  ///
  /// The basket holds an immutable snapshot, so nothing changed under the
  /// shopper - which is exactly why this has to be SAID rather than silently
  /// applied. `details[0].meta` carries `snapshotUnitsPerPackage` and
  /// `currentUnitsPerPackage` so the line can show both and offer to re-add at
  /// the new figure.
  PACKAGING_SNAPSHOT_STALE: 'PACKAGING_SNAPSHOT_STALE',

  /// There is not enough stock for a WHOLE number of these packages.
  ///
  /// `details[0].meta.wholePackagesAvailable` is the honest answer, and it is
  /// what the storefront shows: "Only 1 complete UK pallet is currently
  /// available". Part of a pallet is not something a warehouse can pick.
  PACKAGING_INSUFFICIENT_FOR_PACKAGE: 'PACKAGING_INSUFFICIENT_FOR_PACKAGE',

  /// The order is past a weight or capacity the seller configured.
  PACKAGING_CAPACITY_EXCEEDED: 'PACKAGING_CAPACITY_EXCEEDED',

  /// This load cannot be priced instantly and needs a freight quotation.
  ///
  /// NOT a failure of anything. It is the honest answer for a container, and
  /// for a pallet where no carrier on this seller's account can carry one. The
  /// checkout offers to raise the request rather than showing an error, and
  /// `details[0].meta.loadType` says what kind of freight it is.
  FREIGHT_QUOTE_REQUIRED: 'FREIGHT_QUOTE_REQUIRED',

  /// The carrier chosen cannot express a booking for this kind of load.
  ///
  /// `details[0].meta` carries `provider`, `loadType` and `supported`. The
  /// seller's screen says "DHL does not carry pallet freight through this
  /// integration" rather than letting an API answer with a price for a
  /// movement nobody will make.
  FREIGHT_CARRIER_CANNOT_CARRY: 'FREIGHT_CARRIER_CANNOT_CARRY',

  /// A quote request was acted on in a state that does not allow it.
  FREIGHT_QUOTE_NOT_ACTIONABLE: 'FREIGHT_QUOTE_NOT_ACTIONABLE',

  // --- A seller's own accounting system (TallyPrime) ------------------------

  /// The seller has not set up an ERP connection, or it is switched off.
  SELLER_ERP_NOT_CONFIGURED: 'SELLER_ERP_NOT_CONFIGURED',

  /// The action needs a live bridge and there is not one.
  ///
  /// `details[0].meta.state` carries the connection's own state, because
  /// "install the bridge", "the machine is off" and "Tally is closed" are
  /// three different things for the seller to do and one message for all
  /// three sends people to reinstall software that was working.
  SELLER_ERP_BRIDGE_UNAVAILABLE: 'SELLER_ERP_BRIDGE_UNAVAILABLE',

  /// The pairing code is wrong, expired, already used, or has been guessed at
  /// too many times. One code for all four on purpose: telling the holder of a
  /// bad code WHICH of those it is hands them a way to enumerate good ones.
  SELLER_ERP_PAIRING_INVALID: 'SELLER_ERP_PAIRING_INVALID',

  /// The bridge presented a token that is unknown, revoked or expired.
  SELLER_ERP_BRIDGE_UNAUTHORISED: 'SELLER_ERP_BRIDGE_UNAUTHORISED',

  /// A sync was asked for and a mapping it would need is missing or
  /// unconfirmed. `details` lists each one, so the screen can link to it.
  SELLER_ERP_MAPPING_INCOMPLETE: 'SELLER_ERP_MAPPING_INCOMPLETE',

  /// Tally answered, and what it said was a refusal.
  ///
  /// Raised where an HTTP 200 carried a non-zero ERROR or EXCEPTION count, or
  /// per-line failures. This code exists because treating a 200 as success is
  /// the single most common way an ERP integration silently loses a month of
  /// vouchers. `details` carries the parsed line errors, redacted.
  SELLER_ERP_TALLY_REJECTED: 'SELLER_ERP_TALLY_REJECTED',

  /// The seller has not confirmed this order yet, so nobody may be asked to
  /// carry it. A carrier offered work on an order the seller may still refuse
  /// has been handed an obligation nobody agreed to.
  SELLER_ORDER_NOT_CONFIRMED: 'SELLER_ORDER_NOT_CONFIRMED',

  /// The carrier has the goods, so the seller cannot move the consignment to
  /// somebody else. Chain of custody: only the carrier holding it and the
  /// marketplace can arrange that. `details[0].meta.status` is where it is.
  CONSIGNMENT_REASSIGNMENT_LOCKED: 'CONSIGNMENT_REASSIGNMENT_LOCKED',

  /// A hand-made carrier booking has no tracking number yet, and the step
  /// asked for needs one: nothing about a parcel's journey is recorded until
  /// the carrier's own number for it exists.
  CARRIER_TRACKING_NUMBER_REQUIRED: 'CARRIER_TRACKING_NUMBER_REQUIRED',

  /// The company this connection posts into is not open in Tally.
  SELLER_ERP_COMPANY_NOT_LOADED: 'SELLER_ERP_COMPANY_NOT_LOADED',

  /// The response was not well-formed XML, was too large, or contained a
  /// document-type or entity declaration. All four are refused identically and
  /// nothing is parsed out of the payload - see `tally/xml.ts`.
  SELLER_ERP_RESPONSE_INVALID: 'SELLER_ERP_RESPONSE_INVALID',

  /// The job cannot be retried or cancelled from the state it is in.
  SELLER_ERP_JOB_NOT_ACTIONABLE: 'SELLER_ERP_JOB_NOT_ACTIONABLE',

  /// A direct-mode address was rejected by the outbound guard, or direct mode
  /// is not permitted on this deployment at all.
  SELLER_ERP_DIRECT_MODE_REFUSED: 'SELLER_ERP_DIRECT_MODE_REFUSED',

  // --- The four delivery levels (L1-L4) --------------------------------------

  /// Somebody tried to give L1 to UBOSS. L1 - plant to port of loading - is
  /// the seller's in every mode.
  LOGISTICS_L1_OWNER_FIXED: 'LOGISTICS_L1_OWNER_FIXED',

  /// Self + UBOSS with the seller on all three of L2, L3 and L4. That is the
  /// Self mode; at least one of them must stay UBOSS-managed.
  LOGISTICS_HYBRID_ALL_SELLER: 'LOGISTICS_HYBRID_ALL_SELLER',

  /// Owners the chosen mode does not allow - Self with a UBOSS level, or
  /// UBOSS with a seller level. Only reachable by a hand-made request.
  LOGISTICS_MODE_OWNERS_MISMATCH: 'LOGISTICS_MODE_OWNERS_MISMATCH',

  /// The change moves a level to a different owner, or changes the mode, of a
  /// policy that is already published, and the request did not confirm it.
  LOGISTICS_CHANGE_NOT_CONFIRMED: 'LOGISTICS_CHANGE_NOT_CONFIRMED',

  /// The policy changed since it was read. Reload and try again.
  LOGISTICS_POLICY_VERSION_CONFLICT: 'LOGISTICS_POLICY_VERSION_CONFLICT',

  /// A seller tried to price or assign a level UBOSS controls.
  LOGISTICS_LEVEL_NOT_SELLER_CONTROLLED: 'LOGISTICS_LEVEL_NOT_SELLER_CONTROLLED',

  /// Marketplace staff tried to price or assign a level the seller controls.
  LOGISTICS_LEVEL_NOT_UBOSS_CONTROLLED: 'LOGISTICS_LEVEL_NOT_UBOSS_CONTROLLED',

  /// The price is not a whole number of minor units, is negative, or is zero
  /// without being marked free. `details[0].code` says which. An EMPTY price
  /// is never this error - it is simply not priced yet.
  LOGISTICS_PRICE_INVALID: 'LOGISTICS_PRICE_INVALID',

  /// A level was marked free without the explicit confirmation free needs.
  LOGISTICS_FREE_NOT_CONFIRMED: 'LOGISTICS_FREE_NOT_CONFIRMED',

  /// The carrier is not switched on under Seller Hub -> Logistics.
  LOGISTICS_PROVIDER_NOT_ENABLED: 'LOGISTICS_PROVIDER_NOT_ENABLED',

  /// That carrier cannot move goods that way on that level - DHL by sea, a
  /// pallet by India Post. `details[0].code` names the reason.
  LOGISTICS_CARRIER_UNSUITABLE: 'LOGISTICS_CARRIER_UNSUITABLE',

  /// A price cannot be published without an amount (or a confirmed free) and
  /// a carrier.
  LOGISTICS_RATE_INCOMPLETE: 'LOGISTICS_RATE_INCOMPLETE',

  /// A published price is never edited. Change it by saving a new version.
  LOGISTICS_RATE_NOT_EDITABLE: 'LOGISTICS_RATE_NOT_EDITABLE',

  /// No approved price exists for this route on at least one level, so it
  /// cannot be bought yet. `details` names the seller and the levels.
  LOGISTICS_QUOTE_REQUIRED: 'LOGISTICS_QUOTE_REQUIRED',

  /// The delivery charges changed since the buyer was shown them, or the
  /// quote the checkout carried was not the one this server issued.
  LOGISTICS_PRICE_CHANGED: 'LOGISTICS_PRICE_CHANGED',

  /// The leg is past the point where a carrier can be named or changed.
  LOGISTICS_LEG_NOT_ASSIGNABLE: 'LOGISTICS_LEG_NOT_ASSIGNABLE',

  /// The leg cannot move to that status from where it is, or not by you -
  /// including starting a leg before the one ahead of it was handed over.
  LOGISTICS_LEG_TRANSITION_INVALID: 'LOGISTICS_LEG_TRANSITION_INVALID',

  /// A carrier booked by hand needs its real tracking reference before the
  /// leg can start. Never generated here.
  LOGISTICS_LEG_TRACKING_REQUIRED: 'LOGISTICS_LEG_TRACKING_REQUIRED',

  // --- Platform fee ----------------------------------------------------------

  /// A platform-fee policy is inconsistent - a PERCENT fee with no rate, a
  /// minimum above the maximum, a scope with nothing to apply to.
  PLATFORM_FEE_POLICY_INVALID: 'PLATFORM_FEE_POLICY_INVALID',

  /// A published or retired fee policy is never edited; draft a new version.
  PLATFORM_FEE_POLICY_NOT_EDITABLE: 'PLATFORM_FEE_POLICY_NOT_EDITABLE',

  /// A fee policy or fee rule must be approved by a different member of
  /// finance staff from the one who created, last edited or submitted it.
  PLATFORM_FEE_SELF_APPROVAL_FORBIDDEN: 'PLATFORM_FEE_SELF_APPROVAL_FORBIDDEN',

  /// Only a draft can be submitted, and only a submitted one can be approved
  /// or rejected. details[0].meta.status is where it is now.
  PLATFORM_FEE_NOT_PENDING_APPROVAL: 'PLATFORM_FEE_NOT_PENDING_APPROVAL',

  /// A fee rule is inconsistent - a value band with no lower bound, a volume
  /// tier with no window, a promotion with no end date. details[0].field.
  PLATFORM_FEE_RULE_INVALID: 'PLATFORM_FEE_RULE_INVALID',

  // --- Bulk preorders ----------------------------------------------------------
  //
  // Each of these is a specific reason with its figures in `details[0].meta`,
  // so the storefront can say "Minimum preorder quantity is 1,000 pieces"
  // rather than "something went wrong".

  /// The seller has not configured preorders for this product, has switched
  /// them off, or left a figure a preorder cannot be taken without.
  PREORDER_NOT_AVAILABLE: 'PREORDER_NOT_AVAILABLE',

  /// Preorders are for business accounts, and this account has no company.
  PREORDER_BUYER_NOT_ELIGIBLE: 'PREORDER_BUYER_NOT_ELIGIBLE',

  /// The requested quantity is below the seller's minimum. meta.minimumBaseUnits.
  PREORDER_BELOW_MINIMUM: 'PREORDER_BELOW_MINIMUM',

  /// The requested quantity is not a whole multiple of the increment.
  /// meta.incrementBaseUnits.
  PREORDER_INCREMENT_MISMATCH: 'PREORDER_INCREMENT_MISMATCH',

  /// The requested quantity is above the seller's preorder maximum.
  PREORDER_ABOVE_MAXIMUM: 'PREORDER_ABOVE_MAXIMUM',

  /// The unit asked for (a pallet, a container) is not one this seller takes
  /// preorders in for this product.
  PREORDER_UNIT_NOT_AVAILABLE: 'PREORDER_UNIT_NOT_AVAILABLE',

  /// The requested delivery date is earlier than the lead time allows.
  /// meta.earliest is a YYYY-MM-DD calendar day.
  PREORDER_DATE_TOO_EARLY: 'PREORDER_DATE_TOO_EARLY',

  /// The requested delivery date is beyond the seller's advance-booking
  /// window. meta.latest.
  PREORDER_DATE_TOO_FAR: 'PREORDER_DATE_TOO_FAR',

  /// The seller does not deliver preorders of this product to that country.
  PREORDER_DESTINATION_NOT_SERVED: 'PREORDER_DESTINATION_NOT_SERVED',

  /// The preorder cannot move that way from where it is, or not by you.
  PREORDER_TRANSITION_NOT_ALLOWED: 'PREORDER_TRANSITION_NOT_ALLOWED',

  /// The terms being confirmed are not the seller's current terms - a newer
  /// revision exists, or the page was open while they changed.
  PREORDER_TERMS_CHANGED: 'PREORDER_TERMS_CHANGED',

  /// Confirming this would promise more than the seller can make in that
  /// period. meta.availableBaseUnits.
  PREORDER_CAPACITY_EXCEEDED: 'PREORDER_CAPACITY_EXCEEDED',

  /// The window to answer has passed.
  PREORDER_EXPIRED: 'PREORDER_EXPIRED',

  /// A preorder policy a seller tried to save does not hold together - an
  /// increment larger than the maximum, a band below the minimum.
  PREORDER_POLICY_INVALID: 'PREORDER_POLICY_INVALID',

  /// The buyer has not acknowledged the current version of the bulk preorder
  /// information (minimum quantity, seller confirmation, nothing charged yet).
  /// The storefront shows the note again. meta.policyVersion.
  PREORDER_ACKNOWLEDGEMENT_REQUIRED: 'PREORDER_ACKNOWLEDGEMENT_REQUIRED',

  /// The acknowledgement named a version of the information that is not the
  /// current one - the page was open while the operator changed it. Reload
  /// and read it again. meta.policyVersion is the current version.
  PREORDER_INFO_OUTDATED: 'PREORDER_INFO_OUTDATED',

  /// A 20-ft or 40-ft container was asked for, and the seller has not
  /// configured and verified how many pieces of this product fit in one.
  /// Pieces are still available. meta.unit.
  PREORDER_CONTAINER_NOT_CONFIGURED: 'PREORDER_CONTAINER_NOT_CONFIGURED',

  /// A revised-date or split-delivery proposal does not hold together - the
  /// shipments do not add up, a date is not later than the one before, the
  /// first shipment is more than is available now. `details` lists each
  /// problem with its field and code.
  PREORDER_PROPOSAL_INVALID: 'PREORDER_PROPOSAL_INVALID',

  /// The buyer accepted, and the stock the seller's proposal was built on is
  /// no longer there. Nothing was reserved or charged; the proposal is
  /// withdrawn and the seller has been asked for a new one.
  /// meta.availableToPromise, meta.required.
  PREORDER_STOCK_CHANGED: 'PREORDER_STOCK_CHANGED',

  /// A seller's container loading is impossible or unsafe - heavier than the
  /// container's configured payload, larger than its volume, or missing a
  /// figure. `details` lists each problem with its field and code.
  CONTAINER_LOADING_INVALID: 'CONTAINER_LOADING_INVALID',

  // --- Preorder chat ---------------------------------------------------------------

  /// This conversation is closed. Its history stays readable; a new question
  /// starts a new conversation from the product page.
  PREORDER_CHAT_CLOSED: 'PREORDER_CHAT_CLOSED',

  /// The operator's team has stopped this account sending chat messages. The
  /// customer can still reach the business by its published contact details.
  PREORDER_CHAT_BLOCKED: 'PREORDER_CHAT_BLOCKED',

  /// The message is longer than this installation accepts. meta.maxChars.
  PREORDER_CHAT_MESSAGE_TOO_LONG: 'PREORDER_CHAT_MESSAGE_TOO_LONG',

  /// A retry carried a `clientMessageId` this sender already used for a
  /// DIFFERENT message or conversation. A genuine retry repeats the same
  /// message and is answered with the original instead of this.
  PREORDER_CHAT_MESSAGE_ID_REUSED: 'PREORDER_CHAT_MESSAGE_ID_REUSED',

  /// The conversation cannot move to that status from where it is, or not by
  /// you. meta.from, meta.to.
  PREORDER_CHAT_TRANSITION_NOT_ALLOWED: 'PREORDER_CHAT_TRANSITION_NOT_ALLOWED',

  /// Linking would give this customer two open conversations about the same
  /// product, option and preorder. meta.conversationId is the other one.
  PREORDER_CHAT_DUPLICATE_CONVERSATION: 'PREORDER_CHAT_DUPLICATE_CONVERSATION',

  /// The staff member named cannot answer preorder chats - deactivated, or
  /// without the reply permission.
  PREORDER_CHAT_ASSIGNEE_NOT_ELIGIBLE: 'PREORDER_CHAT_ASSIGNEE_NOT_ELIGIBLE',

  /// The preorder named belongs to a different customer or a different
  /// product, so it cannot be linked to this conversation.
  PREORDER_CHAT_PREORDER_MISMATCH: 'PREORDER_CHAT_PREORDER_MISMATCH',

  /// That proposal is no longer open - replaced by a newer one, withdrawn,
  /// declined, already used for a preorder, or past its expiry.
  PREORDER_CHAT_PROPOSAL_NOT_OPEN: 'PREORDER_CHAT_PROPOSAL_NOT_OPEN',

  /// Attachments are switched off here, or no malware scanner is configured
  /// to look at them. Text messages still work.
  PREORDER_CHAT_ATTACHMENTS_UNAVAILABLE: 'PREORDER_CHAT_ATTACHMENTS_UNAVAILABLE',

  // --- Support tickets -------------------------------------------------------------

  /// This person has sent as many support requests today as one account may.
  /// Their open requests still take replies. meta.limit, meta.windowHours.
  SUPPORT_TICKET_LIMIT_REACHED: 'SUPPORT_TICKET_LIMIT_REACHED',

  /// The order number given is not one this person may see - a typo, or
  /// somebody else's order. Deliberately the same answer for both.
  SUPPORT_ORDER_NOT_FOUND: 'SUPPORT_ORDER_NOT_FOUND',

  /// The request is closed. It can be read but nobody can write on it; a new
  /// problem is a new request.
  SUPPORT_TICKET_CLOSED: 'SUPPORT_TICKET_CLOSED',

  /// The request cannot move to that status from where it is. meta.from,
  /// meta.to.
  SUPPORT_TICKET_TRANSITION_NOT_ALLOWED: 'SUPPORT_TICKET_TRANSITION_NOT_ALLOWED',

  /// The staff member named cannot work support requests - deactivated, or
  /// without the support permission.
  SUPPORT_ASSIGNEE_NOT_ELIGIBLE: 'SUPPORT_ASSIGNEE_NOT_ELIGIBLE',

  /// Files cannot be attached here: switched off, or no malware scanner is
  /// configured. The ticket itself still goes. details[0].code is DISABLED or
  /// NO_SCANNER.
  SUPPORT_ATTACHMENTS_UNAVAILABLE: 'SUPPORT_ATTACHMENTS_UNAVAILABLE',

  /// This ticket already carries as many files as one ticket may. meta.limit.
  SUPPORT_ATTACHMENT_LIMIT_REACHED: 'SUPPORT_ATTACHMENT_LIMIT_REACHED',

  /// Resolving or closing a request needs a resolution code saying how it
  /// ended. details[0].field is `resolutionCode`.
  SUPPORT_RESOLUTION_CODE_REQUIRED: 'SUPPORT_RESOLUTION_CODE_REQUIRED',

  // --- Disputes, claims and chargebacks ---------------------------------------------

  /// The dispute cannot move to that status from where it is - it is closed,
  /// already decided, or waiting for somebody else. meta.from, meta.to.
  DISPUTE_TRANSITION_NOT_ALLOWED: 'DISPUTE_TRANSITION_NOT_ALLOWED',

  /// This order (or line) cannot have a claim raised on it: not paid, not
  /// yours, or the line is not on the order. details[0].code says which.
  DISPUTE_NOT_ELIGIBLE: 'DISPUTE_NOT_ELIGIBLE',

  /// There is already an open claim on this order line. Write on that one.
  /// meta.reference.
  DISPUTE_ALREADY_OPEN: 'DISPUTE_ALREADY_OPEN',

  /// The time allowed for raising a claim on this order has passed.
  /// meta.windowDays.
  DISPUTE_WINDOW_CLOSED: 'DISPUTE_WINDOW_CLOSED',

  /// A decision must be approved by a different member of staff from the one
  /// who proposed it.
  DISPUTE_SELF_APPROVAL_FORBIDDEN: 'DISPUTE_SELF_APPROVAL_FORBIDDEN',

  /// This decision cannot be appealed: the window has passed, or it has been
  /// appealed once already. details[0].code is WINDOW_CLOSED or ALREADY_APPEALED.
  DISPUTE_APPEAL_NOT_ALLOWED: 'DISPUTE_APPEAL_NOT_ALLOWED',

  /// The payment on this order is under a chargeback. Refunding it as well
  /// could pay the buyer twice; the chargeback decides the money.
  DISPUTE_CHARGEBACK_OPEN: 'DISPUTE_CHARGEBACK_OPEN',

  /// The amount is not valid for this dispute - not whole minor units, zero,
  /// or more than was paid. meta.maxMinor.
  DISPUTE_AMOUNT_INVALID: 'DISPUTE_AMOUNT_INVALID',

  /// Somebody saved the dispute settings a moment ago. Reload and try again.
  DISPUTE_SETTINGS_CONFLICT: 'DISPUTE_SETTINGS_CONFLICT',

  // --- Seller invoices and packing lists -----------------------------------------

  /// This consignment cannot have that document yet - the order is not paid,
  /// the seller has not accepted it, or the consignment was cancelled.
  SELLER_DOCUMENT_NOT_ELIGIBLE: 'SELLER_DOCUMENT_NOT_ELIGIBLE',

  /// The document cannot be issued until the listed fields are fixed.
  /// `details` lists each one - a missing GSTIN, a line with no HSN code.
  SELLER_DOCUMENT_VALIDATION_FAILED: 'SELLER_DOCUMENT_VALIDATION_FAILED',

  /// An issued document is never edited. Void it with a credit note, or
  /// supersede the packing list with a new version.
  SELLER_DOCUMENT_IMMUTABLE: 'SELLER_DOCUMENT_IMMUTABLE',

  /// The packages cannot change: one has been scanned, a carrier label was
  /// bought, or the packing list is issued.
  SHIPMENT_PACKAGES_LOCKED: 'SHIPMENT_PACKAGES_LOCKED',

  /// What the packages hold does not add up to what the consignment carries.
  SHIPMENT_CONTENTS_MISMATCH: 'SHIPMENT_CONTENTS_MISMATCH',

  /// A split asked for more than the consignment carries, or would leave it
  /// empty.
  SHIPMENT_SPLIT_INVALID: 'SHIPMENT_SPLIT_INVALID',

  /// The PDF could not be produced. Nothing was issued and nothing was marked
  /// packed; try again.
  DOCUMENT_RENDER_FAILED: 'DOCUMENT_RENDER_FAILED',

  // --- Seller commission invoices -----------------------------------------------

  /// This seller order cannot have a commission invoice yet. `details` names
  /// each reason by code: the buyer's payment is not captured, the order or
  /// the seller's part of it is cancelled, the commission is zero, or the
  /// order has not reached the stage the settings require.
  COMMISSION_INVOICE_NOT_ELIGIBLE: 'COMMISSION_INVOICE_NOT_ELIGIBLE',

  /// The invoice cannot be issued until the listed details are fixed.
  /// `details` lists each one as `{ field, code, message }` - a missing
  /// seller GSTIN, an unverified tax rule, an unset issuer address.
  COMMISSION_INVOICE_VALIDATION_FAILED: 'COMMISSION_INVOICE_VALIDATION_FAILED',

  /// An issued commission invoice never changes. Correct it with a credit note.
  COMMISSION_INVOICE_IMMUTABLE: 'COMMISSION_INVOICE_IMMUTABLE',

  /// The invoice's status does not allow that action. meta.status, meta.move.
  COMMISSION_INVOICE_INVALID_TRANSITION: 'COMMISSION_INVOICE_INVALID_TRANSITION',

  /// Voiding an issued commission invoice is switched off in the invoice
  /// settings. The correction is a credit note.
  COMMISSION_INVOICE_VOID_NOT_PERMITTED: 'COMMISSION_INVOICE_VOID_NOT_PERMITTED',

  /// The commission invoice settings were refused. `details` names each field.
  COMMISSION_INVOICE_SETTINGS_INVALID: 'COMMISSION_INVOICE_SETTINGS_INVALID',

  /// The credit note was refused: nothing left to credit, an amount above
  /// what remains, or a proportional credit on an order with no refund.
  COMMISSION_CREDIT_INVALID: 'COMMISSION_CREDIT_INVALID',

  /// The settings were changed by someone else since they were loaded.
  /// meta.currentVersion.
  COMMISSION_INVOICE_SETTINGS_CONFLICT: 'COMMISSION_INVOICE_SETTINGS_CONFLICT',

  // --- Terms and Conditions ------------------------------------------------------

  /// The account cannot be created or activated until the Terms and Conditions
  /// in force have been read and agreed to. Sent when `acceptedTerms` is not
  /// true or no `termsDocumentId` came with it.
  TERMS_ACCEPTANCE_REQUIRED: 'TERMS_ACCEPTANCE_REQUIRED',

  /// The Terms agreed to are not the version in force: a newer version was
  /// published, or the document named was never a published one.
  /// meta.currentVersion. Show the current Terms and ask again.
  TERMS_VERSION_OUTDATED: 'TERMS_VERSION_OUTDATED',

  /// No Terms and Conditions are published for this kind of account, so no
  /// account can be created or activated. The operator must publish them in
  /// the admin console. 503.
  TERMS_DOCUMENT_UNAVAILABLE: 'TERMS_DOCUMENT_UNAVAILABLE',

  /// A published legal document never changes. Publish a new version instead.
  LEGAL_DOCUMENT_IMMUTABLE: 'LEGAL_DOCUMENT_IMMUTABLE',

  /// A document with this kind, version and language already exists.
  LEGAL_DOCUMENT_VERSION_EXISTS: 'LEGAL_DOCUMENT_VERSION_EXISTS',

  // --- Quantity price bands -------------------------------------------------

  /// The seller's quantity bands contradict themselves or the list price. The
  /// details name each band by index and what is wrong (`domain/quantity-tier.ts`).
  QUANTITY_TIERS_INVALID: 'QUANTITY_TIERS_INVALID',

  /// The store-wide quantity discounts contradict themselves: a start below two
  /// pieces, a discount outside 0.01%-90%, a repeated start, or a larger quantity
  /// taking off less. The details name each rule by index and what is wrong.
  STORE_QUANTITY_DISCOUNTS_INVALID: 'STORE_QUANTITY_DISCOUNTS_INVALID',

  // --- Buyer companies --------------------------------------------------------

  /// The buyer-companies feature is switched off on this deployment
  /// (FEATURE_BUYER_COMPANIES=false).
  BUYER_COMPANIES_DISABLED: 'BUYER_COMPANIES_DISABLED',
  /// The session asked to act for a company it has no active membership in -
  /// removed, suspended, or never a member. The storefront drops back to the
  /// individual context and asks again. Never names the company.
  BUYER_CONTEXT_INVALID: 'BUYER_CONTEXT_INVALID',
  /// The company exists and the caller belongs to it, but it is not approved
  /// (or no longer is), so nothing may be bought in its name yet. `details[0]
  /// .meta.status` carries the company status so the storefront can say why
  /// and link to the verification page instead of showing a generic refusal.
  BUYER_COMPANY_NOT_APPROVED: 'BUYER_COMPANY_NOT_APPROVED',
  /// The caller's role inside the company does not allow this - a VIEWER
  /// trying to check out, a BUYER trying to edit the application.
  BUYER_COMPANY_ROLE_FORBIDDEN: 'BUYER_COMPANY_ROLE_FORBIDDEN',
  /// That status change is not one `domain/buyer-company-state.ts` allows,
  /// for that actor, from the status the company is in now. `details[0].code`
  /// is SAME_STATUS, TRANSITION_UNDEFINED, ACTOR_NOT_PERMITTED or
  /// REASON_REQUIRED.
  BUYER_COMPANY_TRANSITION_NOT_ALLOWED: 'BUYER_COMPANY_TRANSITION_NOT_ALLOWED',
  /// The application cannot be edited in its current status - it is with a
  /// reviewer, approved or closed.
  BUYER_COMPANY_NOT_EDITABLE: 'BUYER_COMPANY_NOT_EDITABLE',
  /// Submission refused: something required is missing or malformed. One
  /// detail per problem, each with the `field` it belongs to.
  BUYER_COMPANY_INCOMPLETE: 'BUYER_COMPANY_INCOMPLETE',
  /// Somebody else changed this application since it was loaded. Reload and
  /// decide again. Returned to the second of two reviewers acting at once.
  BUYER_COMPANY_VERSION_CONFLICT: 'BUYER_COMPANY_VERSION_CONFLICT',
  /// An approval would give a registration number or tax identifier to a
  /// second approved company. Resolve the duplicate first.
  BUYER_COMPANY_ALREADY_CLAIMED: 'BUYER_COMPANY_ALREADY_CLAIMED',
  /// The business email code was wrong, expired or used up.
  BUYER_COMPANY_EMAIL_CODE_INVALID: 'BUYER_COMPANY_EMAIL_CODE_INVALID',
  /// The approval needs a second reviewer, and the caller gave the first one.
  BUYER_COMPANY_SECOND_REVIEW_REQUIRED: 'BUYER_COMPANY_SECOND_REVIEW_REQUIRED',
  /// The uploaded file is not one we accept for company documents - wrong
  /// type by its own bytes, too large, too many pages, or not readable.
  BUYER_COMPANY_DOCUMENT_REJECTED: 'BUYER_COMPANY_DOCUMENT_REJECTED',
  /// The person already has as many company applications in progress as a
  /// deployment allows.
  BUYER_COMPANY_LIMIT_REACHED: 'BUYER_COMPANY_LIMIT_REACHED',
  /// That address already has an invitation to this company that can still be
  /// accepted. Resend it rather than sending a second one.
  BUYER_COMPANY_INVITATION_EXISTS: 'BUYER_COMPANY_INVITATION_EXISTS',
  /// The invitation cannot be used: unknown, expired, revoked, already used,
  /// or addressed to another email. One answer for all five, on purpose.
  BUYER_COMPANY_INVITATION_INVALID: 'BUYER_COMPANY_INVITATION_INVALID',
  /// That person is already an active member of the company.
  BUYER_COMPANY_ALREADY_MEMBER: 'BUYER_COMPANY_ALREADY_MEMBER',
  /// That member cannot be changed by the caller: the owner, the caller
  /// themselves, or an administrator when the caller is not the owner.
  /// `details[0].code` is OWNER, SELF or ADMIN_NEEDS_OWNER.
  BUYER_COMPANY_MEMBER_PROTECTED: 'BUYER_COMPANY_MEMBER_PROTECTED',
  /// This feature works for the person's own account only, not while buying
  /// for a company - recurring orders are the one today. The storefront offers
  /// to switch to the individual context.
  BUYER_CONTEXT_UNSUPPORTED: 'BUYER_CONTEXT_UNSUPPORTED',

  // --- Product reviews ---
  /// Only a buyer with a delivered order containing the product may review
  /// it. The storefront hides the form in that case, so this is what a stale
  /// page or a direct call sees.
  REVIEW_NOT_ELIGIBLE: 'REVIEW_NOT_ELIGIBLE',

  // --- B2C maximum order quantity ---
  /// A buyer who is not an approved company asked for more of one product
  /// than its seller allows an individual to buy in one order - every variant
  /// and every basket line of it counted together. 409. `details[0].meta`
  /// carries `productId`, `allowedQuantity`, `requestedQuantity`,
  /// `currentCartQuantity` and `requiresApprovedCompanyAccount`, so the
  /// storefront can offer "Reduce to N" or switching to a company. Also a
  /// basket line issue while an existing basket is over. See
  /// `domain/b2c-order-limit.ts`. Not QUANTITY_ABOVE_MAXIMUM, which is the
  /// per-line maximum that binds every buyer.
  B2C_MAX_ORDER_QUANTITY_EXCEEDED: 'B2C_MAX_ORDER_QUANTITY_EXCEEDED',

  // --- Pre-shipment inspection and the dispatch gate ---
  /// The order must be inspected before it leaves and the gate is shut. 409.
  /// `details[0].code` says why: NOT_BOOKED, IN_PROGRESS, FAILED,
  /// BLOCKING_NCR_OPEN, RELEASE_PENDING_APPROVAL, SCOPE_CHANGED or
  /// BUYER_REVIEW_PERIOD; `meta.requirementId` names the inspection. See
  /// `domain/inspection-gate.ts`.
  INSPECTION_GATE_CLOSED: 'INSPECTION_GATE_CLOSED',
  /// A guarded move reached a state machine without the gate being checked.
  /// A programming error on the server, refused rather than let through. 409.
  INSPECTION_GATE_NOT_EVALUATED: 'INSPECTION_GATE_NOT_EVALUATED',
  /// That inspection job cannot move that way, for that role. `details[0]
  /// .code` is SAME_STATUS, TRANSITION_UNDEFINED, ACTOR_NOT_PERMITTED or
  /// REASON_REQUIRED.
  INSPECTION_JOB_TRANSITION_NOT_ALLOWED: 'INSPECTION_JOB_TRANSITION_NOT_ALLOWED',
  /// The signed-in account is not an active member of an inspection agency,
  /// or its role does not carry this action. 403.
  INSPECTION_AGENCY_MEMBER_REQUIRED: 'INSPECTION_AGENCY_MEMBER_REQUIRED',
  /// The agency cannot take this job: suspended, not serving the category or
  /// country, affiliated with the seller, or full on that day. `details[0]
  /// .code` says which.
  INSPECTION_AGENCY_NOT_ELIGIBLE: 'INSPECTION_AGENCY_NOT_ELIGIBLE',
  /// The person or agency has a conflict of interest with this order - a
  /// member of the seller, the buyer, or a declared conflict. 409.
  INSPECTION_CONFLICT_OF_INTEREST: 'INSPECTION_CONFLICT_OF_INTEREST',
  /// The inspector is not authorised for this category, has no verified
  /// identity, or their credentials have expired. `details[0].code` says which.
  INSPECTOR_NOT_QUALIFIED: 'INSPECTOR_NOT_QUALIFIED',
  /// The report cannot be submitted or signed yet. `details` lists each
  /// missing item: an unanswered checklist line, the sampling record, evidence.
  INSPECTION_REPORT_INCOMPLETE: 'INSPECTION_REPORT_INCOMPLETE',
  /// A signed report, and its evidence, never change. 409.
  INSPECTION_REPORT_LOCKED: 'INSPECTION_REPORT_LOCKED',
  /// The person who requested a conditional release cannot also approve it. 409.
  INSPECTION_SELF_APPROVAL_FORBIDDEN: 'INSPECTION_SELF_APPROVAL_FORBIDDEN',
  /// A conditional release cannot be recorded: the rule does not allow one,
  /// the reason is too short, evidence is missing, or one is already pending.
  /// `details[0].code` says which.
  INSPECTION_RELEASE_NOT_ALLOWED: 'INSPECTION_RELEASE_NOT_ALLOWED',
  /// A re-inspection needs corrective action recorded on every open
  /// non-conformance first. `details` names each NCR still open.
  INSPECTION_CAPA_REQUIRED: 'INSPECTION_CAPA_REQUIRED',
  /// A defect's severity can be changed only by the agency's QA reviewer, who
  /// is not the inspector who recorded it, with a reason and evidence.
  INSPECTION_RECLASSIFICATION_NOT_ALLOWED: 'INSPECTION_RECLASSIFICATION_NOT_ALLOWED',
  /// The container or seal recorded at loading does not match the packages on
  /// the consignment. 409.
  INSPECTION_BINDING_MISMATCH: 'INSPECTION_BINDING_MISMATCH',
  /// The seller cannot present the lot yet. `details` lists each missing item,
  /// such as PACKING_LIST_MISSING or DECLARATION_REQUIRED.
  INSPECTION_READINESS_INCOMPLETE: 'INSPECTION_READINESS_INCOMPLETE',
  /// An inspection rule, plan or policy contradicts itself. `details` names
  /// each field.
  INSPECTION_POLICY_INVALID: 'INSPECTION_POLICY_INVALID',
  /// An inspection cannot be booked for this order now: none is required and
  /// the buyer did not ask, one is already open, or the order is past dispatch.
  INSPECTION_BOOKING_NOT_ALLOWED: 'INSPECTION_BOOKING_NOT_ALLOWED',

  // --- Returns ---
  /// This order cannot be returned from the storefront. 409. `details[0].code`
  /// says why: NOT_DELIVERED, WINDOW_CLOSED (meta.windowDays, meta.closedAt),
  /// RETURNS_OFF (the operator's window is 0), MIXED_SELLERS (the lines chosen
  /// belong to more than one seller - send one return per seller) or
  /// REASON_NOT_OFFERED.
  RETURN_NOT_ELIGIBLE: 'RETURN_NOT_ELIGIBLE',
  /// More of a line was asked for than is left to return. 409. One detail per
  /// line: `field` is `items.N.quantity`, meta.returnable is how many may still
  /// go back.
  RETURN_QUANTITY_EXCEEDED: 'RETURN_QUANTITY_EXCEEDED',
  /// The reason chosen needs at least one photograph or video of the problem,
  /// and none was attached. 400.
  RETURN_EVIDENCE_REQUIRED: 'RETURN_EVIDENCE_REQUIRED',
  /// The return cannot move that way from where it is, or the move needs a
  /// reason that was not given. 409. meta.from, meta.to.
  RETURN_TRANSITION_NOT_ALLOWED: 'RETURN_TRANSITION_NOT_ALLOWED',
  /// Files cannot be added to returns here: no malware scanner is configured
  /// and unscanned files are not accepted. 409. The return itself still works.
  RETURN_FILES_UNAVAILABLE: 'RETURN_FILES_UNAVAILABLE',

  // --- The buyer experience: cart, checkout, account, alerts, reviews ---
  /// That saved-for-later line is not one of this buyer's. 404.
  SAVED_ITEM_NOT_FOUND: 'SAVED_ITEM_NOT_FOUND',
  /// The operator's buyer settings or a duty rate contradict themselves.
  /// `details` names each field. 400.
  BUYER_COMMERCE_SETTINGS_INVALID: 'BUYER_COMMERCE_SETTINGS_INVALID',
  /// Somebody else saved the buyer settings since they were loaded. Reload. 409.
  BUYER_COMMERCE_SETTINGS_CONFLICT: 'BUYER_COMMERCE_SETTINGS_CONFLICT',
  /// The identity details cannot be changed while they are being reviewed or
  /// once verified - ask support to reopen them. 409.
  KYC_NOT_EDITABLE: 'KYC_NOT_EDITABLE',
  /// The identity details are not complete enough to submit. `details` lists
  /// each missing field. 400.
  KYC_INCOMPLETE: 'KYC_INCOMPLETE',
  /// The uploaded identity or import document is not accepted: wrong type by
  /// its own bytes, too large, empty, or it failed the malware scan. 400.
  KYC_DOCUMENT_REJECTED: 'KYC_DOCUMENT_REJECTED',
  /// The buyer already has as many saved searches as the installation allows. 409.
  SAVED_SEARCH_LIMIT_REACHED: 'SAVED_SEARCH_LIMIT_REACHED',
  /// Nothing on that past order can be bought today. `details` lists each
  /// line and why (UNPUBLISHED, OUT_OF_STOCK, OFFER_WITHDRAWN). 409.
  REORDER_NOTHING_AVAILABLE: 'REORDER_NOTHING_AVAILABLE',
  /// The reorder changed since the buyer reviewed it - a price or stock moved.
  /// `details[0].meta.previewToken` is the new preview to review. 409.
  REORDER_PREVIEW_STALE: 'REORDER_PREVIEW_STALE',
  /// Security and account notices cannot be switched off. 400.
  NOTIFICATION_PREFERENCE_LOCKED: 'NOTIFICATION_PREFERENCE_LOCKED',
  /// Only the seller whose goods were reviewed may answer a review, once, and
  /// only a published one. 409 (403 for somebody else's review).
  REVIEW_RESPONSE_NOT_ALLOWED: 'REVIEW_RESPONSE_NOT_ALLOWED',
  /// No translation provider is configured, or it failed. The original text is
  /// still shown. 503.
  TRANSLATION_UNAVAILABLE: 'TRANSLATION_UNAVAILABLE',
  /// An inbound ERP purchase order could not become an order. `details` names
  /// each problem: a missing field, an unknown product code (UNKNOWN_PRODUCT),
  /// or a line that cannot be bought. 422.
  CUSTOMER_ERP_PURCHASE_ORDER_REJECTED: 'CUSTOMER_ERP_PURCHASE_ORDER_REJECTED',
  /// A production milestone or delay cannot be recorded: the order is not
  /// accepted (NOT_ACCEPTED), has left (CLOSED), the stage is already done
  /// (ALREADY_COMPLETED) or an earlier one is open (OUT_OF_ORDER). 409.
  PRODUCTION_MILESTONE_NOT_ALLOWED: 'PRODUCTION_MILESTONE_NOT_ALLOWED',
  /// The marketplace has blocked this listing. Only staff can lift it; the
  /// seller cannot resume, edit it live or archive it. 409.
  LISTING_BLOCKED: 'LISTING_BLOCKED',
  /// The seller does not sell this listing to the delivery country.
  /// `details[0].meta.country` is the country. 409.
  OFFER_NOT_AVAILABLE_IN_MARKET: 'OFFER_NOT_AVAILABLE_IN_MARKET',
  /// A bulk-import file cannot be read: empty, not CSV/XLSX by its bytes,
  /// too large, too many rows, or missing a required column. 400.
  BULK_IMPORT_FILE_INVALID: 'BULK_IMPORT_FILE_INVALID',
  /// A bulk import cannot be applied: it is not a finished dry run, it has
  /// row errors, or it was already applied. 409.
  BULK_IMPORT_NOT_APPLICABLE: 'BULK_IMPORT_NOT_APPLICABLE',
  /// A trade document is incomplete or not acceptable here - unknown kind,
  /// missing issuer, expiry before issue, no file and no reference. 400.
  TRADE_DOCUMENT_INVALID: 'TRADE_DOCUMENT_INVALID',
  /// The consignment is on an exception hold: a document the destination or
  /// category requires is missing or not valid, the HS code is unverified or
  /// rejected, or the goods are prohibited there. `details` lists each hold
  /// with its code and the party who must act. 409.
  DESTINATION_DOCUMENTS_NOT_READY: 'DESTINATION_DOCUMENTS_NOT_READY',
  /// A cross-border consignment must state its Incoterm, mode and ports
  /// before it can be booked. 409.
  BOOKING_TERMS_REQUIRED: 'BOOKING_TERMS_REQUIRED',
  /// Booking terms are not acceptable: unknown Incoterm, a port that is not a
  /// UN/LOCODE, an insured value above what the settings allow. 400.
  BOOKING_TERMS_INVALID: 'BOOKING_TERMS_INVALID',
  /// Cargo insurance is not offered on this installation. 409.
  SHIPMENT_INSURANCE_NOT_OFFERED: 'SHIPMENT_INSURANCE_NOT_OFFERED',
  /// A lane rate card is not acceptable: overlapping weight bands, transit
  /// days out of order, validity ending before it starts. 400.
  LOGISTICS_LANE_INVALID: 'LOGISTICS_LANE_INVALID',
  /// An individual buyer's identity details cannot be changed now: they are
  /// with a reviewer or already verified. 409. (Master row 11)
  CUSTOMER_KYC_NOT_EDITABLE: 'CUSTOMER_KYC_NOT_EDITABLE',
  /// An identity check cannot be sent yet: a required detail or the identity
  /// document is missing. `details` names what. 400.
  CUSTOMER_KYC_INCOMPLETE: 'CUSTOMER_KYC_INCOMPLETE',
  /// The identity check cannot move that way from where it is. 409.
  CUSTOMER_KYC_TRANSITION_INVALID: 'CUSTOMER_KYC_TRANSITION_INVALID',
  /// A factory cannot be changed now: it is with a reviewer. 409. (Master row 13)
  FACTORY_NOT_EDITABLE: 'FACTORY_NOT_EDITABLE',
  /// A factory cannot be sent for review, or verified, yet: it has no
  /// evidence attached. `details` names what is missing. 400 for the seller,
  /// 409 for a reviewer.
  FACTORY_INCOMPLETE: 'FACTORY_INCOMPLETE',
  /// The factory's verification cannot move that way from where it is -
  /// including a reviewer deciding a check a colleague already decided
  /// (`details[0].code` is `STALE`). 409.
  FACTORY_TRANSITION_INVALID: 'FACTORY_TRANSITION_INVALID',
  /// A certificate cannot be changed now: it is with a reviewer. 409.
  CERTIFICATION_NOT_EDITABLE: 'CERTIFICATION_NOT_EDITABLE',
  /// The certificate's verification cannot move that way from where it is,
  /// including a stale reviewer screen (`STALE`). 409.
  CERTIFICATION_TRANSITION_INVALID: 'CERTIFICATION_TRANSITION_INVALID',
  /// That document cannot be used as evidence: it was replaced, withdrawn or
  /// failed its security scan. 409.
  TRUST_EVIDENCE_UNUSABLE: 'TRUST_EVIDENCE_UNUSABLE',
  /// That document is evidence for a factory or a certificate and cannot be
  /// withdrawn until it is detached. 409.
  TRUST_EVIDENCE_IN_USE: 'TRUST_EVIDENCE_IN_USE',
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
