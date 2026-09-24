# Error codes: every code the API can return

> **Generated file - do not edit by hand.** It is rebuilt from
> `backend/src/domain/errors.ts` by `scripts/build-reference-docs.mjs`.
> After changing that code, run `cd scripts; npm run docs` and commit the result.
> `npm run docs:check` fails when this file has fallen behind the code.

**341 codes.** Every failure from the API has the same shape, and `code` is one of the values below. The codes are a **published contract**: both storefront and admin panel turn each one into a message in eight languages. A new situation gets a new code; an existing code is never renamed or given a new meaning.

```json
{
  "error": {
    "code": "CART_ITEM_UNAVAILABLE",
    "message": "Some items need attention before you can check out.",
    "details": [{ "code": "QUANTITY_BELOW_MINIMUM", "message": "...", "meta": { "minimum": 10 } }],
    "correlationId": "01J..."
  }
}
```

`message` is English and meant for logs and developers; show the user the translated text for `code`.
Quote `correlationId` when reporting a problem - it finds the request in the server log.
How codes map to HTTP statuses is explained in [`../API.md`](../API.md).

| Group | Codes |
|---|---|
| [Generic](#generic) | 10 |
| [Authentication / authorization](#authentication-authorization) | 14 |
| [Invitations and tokens](#invitations-and-tokens) | 8 |
| [Catalog](#catalog) | 15 |
| [Image search](#image-search) | 2 |
| [Inventory](#inventory) | 9 |
| [Cart and purchasing limits](#cart-and-purchasing-limits) | 10 |
| [Orders](#orders) | 7 |
| [Fulfilment options](#fulfilment-options) | 6 |
| [Idempotency](#idempotency) | 3 |
| [Payments](#payments) | 14 |
| [Recurring](#recurring) | 27 |
| [Localisation & currency](#localisation-currency) | 4 |
| [Coupons](#coupons) | 8 |
| [Integrations](#integrations) | 9 |
| [A configurable ERP connection](#a-configurable-erp-connection) | 13 |
| [Auto-pay](#auto-pay) | 6 |
| [Data protection](#data-protection) | 6 |
| [A buyer's own ERP, and the organisation that owns it](#a-buyer-s-own-erp-and-the-organisation-that-owns-it) | 26 |
| [Seller Hub](#seller-hub) | 40 |
| [Logistics partner portal](#logistics-partner-portal) | 21 |
| [How a seller's own goods get delivered](#how-a-seller-s-own-goods-get-delivered) | 15 |
| [Console notifications](#console-notifications) | 2 |
| [The assistant](#the-assistant) | 1 |
| [Bulk ordering: carton, pallet, container](#bulk-ordering-carton-pallet-container) | 9 |
| [A seller's own accounting system (TallyPrime)](#a-seller-s-own-accounting-system-tallyprime) | 13 |
| [The four delivery levels (L1-L4)](#the-four-delivery-levels-l1-l4) | 18 |
| [Platform fee](#platform-fee) | 2 |
| [Bulk preorders](#bulk-preorders) | 14 |
| [Seller invoices and packing lists](#seller-invoices-and-packing-lists) | 7 |
| [Quantity price bands](#quantity-price-bands) | 2 |

## Generic

| Code | Meaning |
|---|---|
| `VALIDATION_FAILED` |  |
| `NOT_FOUND` |  |
| `CONFLICT` |  |
| `INTERNAL_ERROR` |  |
| `SERVICE_UNAVAILABLE` |  |
| `RATE_LIMITED` |  |
| `PAYLOAD_TOO_LARGE` |  |
| `MALWARE_DETECTED` |  |
| `MALWARE_SCANNER_UNAVAILABLE` |  |
| `FEATURE_DISABLED` |  |

## Authentication / authorization

| Code | Meaning |
|---|---|
| `UNAUTHENTICATED` |  |
| `INVALID_CREDENTIALS` |  |
| `ACCOUNT_LOCKED` |  |
| `ACCOUNT_DEACTIVATED` |  |
| `ACCOUNT_NOT_ACTIVATED` |  |
| `ACCOUNT_PENDING_APPROVAL` | Self-registered, email confirmed, and waiting for a member of staff to let them in. Distinct from ACCOUNT_NOT_ACTIVATED because there is nothing the person can do about it - no link to open, no password to choose - and telling them to check their email would send them hunting for nothing. |
| `EMAIL_NOT_VERIFIED` | Self-registered and the confirmation link has not been opened yet. The fix is sitting in their inbox, so the storefront offers to send another. |
| `SESSION_EXPIRED` |  |
| `REFRESH_TOKEN_REUSED` |  |
| `MFA_REQUIRED` |  |
| `MFA_INVALID` |  |
| `FORBIDDEN` |  |
| `PERMISSION_DENIED` |  |
| `RESOURCE_OWNERSHIP_DENIED` | Authenticated, but the resource belongs to somebody else. Returned instead of NOT_FOUND only where existence is already known to the caller. |

## Invitations and tokens

| Code | Meaning |
|---|---|
| `TOKEN_INVALID` |  |
| `TOKEN_EXPIRED` |  |
| `TOKEN_ALREADY_USED` |  |
| `INVITATION_ALREADY_ACCEPTED` |  |
| `SELF_REGISTRATION_DISABLED` |  |
| `TEMPORARY_PASSWORD_EXPIRED` | The emailed temporary password has lapsed. Distinct from bad credentials because the fix is different: somebody has to issue a new one. |
| `PASSWORD_CHANGE_REQUIRED` | Signed in on a temporary password, so the only thing this session may do is set a real one. The Admin Panel turns this into the change screen. |
| `LOCATION_REQUIRED` | Signed in, but the session has not yet said where it is. Every admin route answers this until the browser's position is posted; the Admin Panel turns it into the screen that asks for location access. |

## Catalog

| Code | Meaning |
|---|---|
| `SKU_ALREADY_EXISTS` |  |
| `SLUG_ALREADY_EXISTS` |  |
| `CATEGORY_CYCLE_DETECTED` |  |
| `CATEGORY_HAS_PRODUCTS` |  |
| `PRODUCT_NOT_PUBLISHED` |  |
| `PRODUCT_INCOMPLETE_FOR_PUBLISH` |  |
| `VARIANT_MISMATCH` |  |
| `VARIANT_COMBINATION_EXISTS` |  |
| `VARIANT_MATRIX_TOO_LARGE` |  |
| `VARIANT_AXIS_NOT_IN_TEMPLATE` |  |
| `PRODUCT_PRICE_ON_REQUEST` |  |
| `PRODUCT_NOT_ORDERABLE` |  |
| `PACK_SIZE_UNKNOWN` |  |
| `MEDIA_TYPE_NOT_ALLOWED` |  |
| `MEDIA_TOO_LARGE` |  |

## Image search

| Code | Meaning |
|---|---|
| `IMAGE_SEARCH_BUSY` | Two codes and not one, because the two failures need different words in front of a customer and different actions from whoever runs the deployment. BUSY is the provider being over quota or overloaded, and the answer is to wait; UNREADABLE is a reply that came back and could not be used, and the answer is to try a clearer photograph or type the name. |
| `IMAGE_SEARCH_UNREADABLE` |  |

## Inventory

| Code | Meaning |
|---|---|
| `INSUFFICIENT_STOCK` |  |
| `STOCK_NOT_TRACKED` |  |
| `RESERVATION_EXPIRED` |  |
| `ADJUSTMENT_REASON_REQUIRED` |  |
| `INVENTORY_BALANCE_NOT_EDITABLE` |  |
| `LOCATION_CODE_EXISTS` | Two warehouses cannot share a code. The code is stamped on every movement ever recorded against the place, so a duplicate would make the ledger ambiguous about where stock went. |
| `LOCATION_STILL_IN_USE` | Retiring this warehouse would leave stock somewhere the console no longer offers, or leave the deployment with no default for the next receipt to land in. The message names which of the two it is and the count behind it. |
| `LOCATION_HAS_HISTORY` | The warehouse row itself cannot go, because history points at it: a stock movement, a balance, a reservation or a scheduled order. A separate code from the one above because the answer is a different one - that refusal says "clear the stock, then retire it", this one says "retiring is the only thing left". The message names what is in the way and how much of it there is. |
| `LOCATION_NOT_PLACED` | The warehouse is real but has nowhere on the map, so anything measured from its position cannot be measured at all - today that is the delivery coverage radius. A separate code from VALIDATION_FAILED because nothing the caller sent is wrong: the request was well formed and the answer is that this warehouse has no coordinates, or has coordinates that cannot be plotted. The message says which of the two, because the fixes differ - one is "look them up from the address", the other is "correct the… |

## Cart and purchasing limits

| Code | Meaning |
|---|---|
| `CART_EMPTY` |  |
| `CART_ITEM_UNAVAILABLE` |  |
| `CART_PRICE_CHANGED` |  |
| `CART_CURRENCY_MISMATCH` |  |
| `QUANTITY_BELOW_MINIMUM` |  |
| `QUANTITY_ABOVE_MAXIMUM` |  |
| `QUANTITY_INCREMENT_INVALID` |  |
| `ORDER_BELOW_MINIMUM_VALUE` |  |
| `ORDER_ABOVE_MAXIMUM_VALUE` |  |
| `CUSTOMER_SPEND_CAP_EXCEEDED` |  |

## Orders

| Code | Meaning |
|---|---|
| `ORDER_TRANSITION_NOT_ALLOWED` |  |
| `ORDER_ALREADY_PAID` |  |
| `ORDER_NOT_CANCELLABLE` |  |
| `ORDER_APPROVAL_REQUIRED` |  |
| `ORDER_APPROVAL_ALREADY_DECIDED` |  |
| `ADDRESS_REQUIRED` |  |
| `SHIPPING_METHOD_UNAVAILABLE` |  |

## Fulfilment options

| Code | Meaning |
|---|---|
| `FULFILMENT_NO_ELIGIBLE_WAREHOUSE` | No warehouse published a lane to this destination for this basket. Not an outage and not a rejection of the request - it is the honest answer, and the storefront says so and offers the configured shipping method instead where there is one. |
| `FULFILMENT_QUOTE_EXPIRED` | The quote lapsed. Nothing is wrong with it except its age; the storefront re-asks and shows the options again. Never repriced silently: a total the customer never saw is the one thing a checkout may not charge. |
| `FULFILMENT_QUOTE_INVALID` | The quote does not belong to this customer, does not exist, or was taken against a country rather than an address. Deliberately one code for all three: distinguishing "not yours" from "not there" would make this an oracle for other people's quote ids. |
| `FULFILMENT_QUOTE_STALE` | The basket changed after the quote was taken - a line added in another tab, a quantity edited, a coupon applied. The offer was for a different basket, so it is refused rather than stretched to cover this one. |
| `FULFILMENT_WAREHOUSE_UNAVAILABLE` | The warehouse went into maintenance, was retired, or had its lane to this destination closed between the quote and the payment. The customer picks again; nothing is switched under them. |
| `FULFILMENT_STOCK_CHANGED` | Somebody else bought it first. The detail names the lines that are short and by how much, because "out of stock" with no line named is not something a buyer can act on - and no substitution is made and no other warehouse is chosen for them. |

## Idempotency

| Code | Meaning |
|---|---|
| `IDEMPOTENCY_KEY_REQUIRED` |  |
| `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY` | Same key, different body. Never silently returns the earlier response. |
| `IDEMPOTENT_REQUEST_IN_PROGRESS` |  |

## Payments

| Code | Meaning |
|---|---|
| `PAYMENT_PROVIDER_NOT_CONFIGURED` |  |
| `PAYMENT_PROVIDER_ERROR` |  |
| `PAYMENT_AMOUNT_MISMATCH` |  |
| `PAYMENT_CURRENCY_MISMATCH` |  |
| `PAYMENT_ALREADY_CAPTURED` |  |
| `PAYMENT_NOT_CAPTURED` |  |
| `WEBHOOK_SIGNATURE_INVALID` |  |
| `WEBHOOK_PAYLOAD_INVALID` |  |
| `PAYMENT_LINK_INVALID` |  |
| `PAYMENT_LINK_EXPIRED` |  |
| `PAYMENT_LINK_ALREADY_USED` |  |
| `PAYMENT_LINK_REVOKED` |  |
| `REFUND_EXCEEDS_CAPTURED` |  |
| `REFUND_NOT_PERMITTED` |  |

## Recurring

| Code | Meaning |
|---|---|
| `SCHEDULE_PRODUCT_NOT_ELIGIBLE` |  |
| `SCHEDULE_CONSENT_REQUIRED` |  |
| `SCHEDULE_NOT_ACTIVE` |  |
| `SCHEDULE_ALREADY_CANCELLED` |  |
| `SCHEDULE_MANDATE_MISSING` |  |
| `SCHEDULE_MANDATE_INVALID` |  |
| `OCCURRENCE_ALREADY_EXISTS` |  |
| `RECURRENCE_RULE_INVALID` |  |
| `SCHEDULE_TRANSITION_NOT_ALLOWED` | A plan status change the state machine does not define. Distinct from SCHEDULE_NOT_ACTIVE, which is the specific case of acting on a plan that is merely not running right now. |
| `OCCURRENCE_TRANSITION_NOT_ALLOWED` |  |
| `SCHEDULE_NOT_ACTIVATED` | The plan is still a DRAFT: it has been configured but nobody has confirmed the review screen, so it has no authority to charge anyone. |
| `SCHEDULE_ALREADY_ACTIVATED` | Activation was attempted on a plan that is already running. |
| `SCHEDULE_EDIT_CUTOFF_PASSED` | The edit window closed. The message names the next date the customer can change this plan, because "too late" without a date is not an answer. |
| `SCHEDULE_DATE_IN_PAST` | A date in the past, or a time that has already gone today. |
| `SCHEDULE_DATE_TOO_SOON` | The date is in the future but inside the notice period - see SCHEDULE_MIN_NOTICE_DAYS, and the warehouse's own earliest delivery where that is later still. |
| `SCHEDULE_FREQUENCY_NOT_SUPPORTED` | A frequency this deployment does not offer, or one whose parameters do not fit it (WEEKLY without a weekday, a custom interval out of range). |
| `SCHEDULE_PRICE_CHANGED` | The total moved further than the approved tolerance since the customer was quoted. Nothing is charged; the occurrence waits for them. |
| `SCHEDULE_PAYMENT_METHOD_REQUIRED` | Auto-pay was asked for with no reusable payment method chosen. |
| `SCHEDULE_PAYMENT_METHOD_INVALID` | The stored instrument is gone, detached at the provider, or expired. |
| `SCHEDULE_PAYMENT_AUTHENTICATION_REQUIRED` | The bank wants the cardholder present - 3-D Secure, or a re-authorised mandate. Nothing retries on its own; only the customer can clear it. |
| `OCCURRENCE_NOT_MODIFIABLE` | This cycle has already been touched by the engine, so it can no longer be skipped, edited or cancelled. |
| `SUBSTITUTION_NOT_PERMITTED` | A product is unavailable and the customer has saved no substitute for it, so the occurrence is held rather than filled with something they did not choose. |
| `PAYMENT_METHOD_IN_USE` | Removing an instrument that live plans still depend on. The detail names them, so the customer can decide rather than be refused blankly. |
| `PAYMENT_SETUP_INCOMPLETE` | The SetupIntent has not reached a state that yields a reusable instrument, so there is nothing to store yet. |
| `PAYMENT_SETUP_CONSENT_REQUIRED` | Saving a payment method without the off-session consent that makes it chargeable. Stripe's rules require the record, and so does the law. |
| `PAYMENT_INSTRUMENT_UNAVAILABLE` | The customer asked to pay with an instrument this deployment cannot offer for this cart - UPI where no gateway serves it, or a card in a currency no connected gateway settles. |
| `PAYMENT_METHOD_NOT_CHARGEABLE` | A stored card was named for a charge its owner never agreed to. |

## Localisation & currency

| Code | Meaning |
|---|---|
| `CURRENCY_NOT_SUPPORTED` |  |
| `COUNTRY_NOT_SUPPORTED` |  |
| `PRICE_UNAVAILABLE_IN_CURRENCY` | The catalogue has no price for this SKU in the requested currency, so it cannot be sold in it. Never fall back to another currency's number. |
| `PRICE_RATE_UNAVAILABLE` | The same outcome as above, from a completely different cause: this deployment DOES sell the SKU in this currency, by converting its base price, but there is no exchange rate fresh enough to do it with right now. A separate code rather than a reuse of the one above because the two need opposite advice - "this is not sold here, choose something else" against "try again shortly, or switch currency" - and because an operator seeing the first will go hunting for a missing price row that was never… |

## Coupons

| Code | Meaning |
|---|---|
| `COUPON_NOT_FOUND` |  |
| `COUPON_NOT_ACTIVE` |  |
| `COUPON_EXPIRED` |  |
| `COUPON_NOT_YET_VALID` |  |
| `COUPON_MINIMUM_NOT_MET` |  |
| `COUPON_NOT_APPLICABLE` | Nothing in the cart falls inside the coupon's categories. |
| `COUPON_USAGE_LIMIT_REACHED` |  |
| `COUPON_CODE_ALREADY_EXISTS` |  |

## Integrations

| Code | Meaning |
|---|---|
| `CONNECTOR_TEST_FAILED` |  |
| `CONNECTOR_CIRCUIT_OPEN` |  |
| `ERP_NOT_CONFIGURED` | No ERP connection is configured for order push, or the one configured is switched off. Checked BEFORE a card is charged, never after. |
| `ERP_ORDER_PUSH_FAILED` | The ERP refused the order, or could not be reached. When this happens after a successful charge the occurrence holds at PAID_ERP_PENDING and retries under the same idempotency key - it never re-charges. |
| `ERP_SKU_NOT_MAPPED` | A line has no identifier in the ERP, so the ERP could not accept the order even if it were sent. Caught during revalidation, before payment. |
| `ERP_WAREHOUSE_NOT_MAPPED` | The warehouse the order would ship from is not mapped to the ERP. |
| `IMPORT_FILE_INVALID` |  |
| `IMPORT_DRY_RUN_REQUIRED` |  |
| `EXPORT_NOT_READY` |  |

## A configurable ERP connection

| Code | Meaning |
|---|---|
| `ERP_URL_NOT_ALLOWED` | Distinct from the ERP_* codes above, which are about the connector wired through environment variables. These are returned to an administrator working in Settings -&gt; ERP, so each one has to name something they can actually go and fix. The address is not one this server will call: not http(s), missing a host, carrying credentials, or resolving to a private or reserved network. The detail says which. |
| `ERP_ENDPOINT_OFF_ORIGIN` | An endpoint path pointed at a different origin from the base URL. Refused because an "endpoint" free to leave the authorised host is an SSRF primitive with a form field in front of it. |
| `ERP_CONNECTION_STATE_INVALID` | The connection is not in a state that allows what was asked - activating one that has never passed a test, resuming one that was never paused. The message names the current status. |
| `ERP_CONNECTION_UNTESTED` | Activation was refused because the connection has no passing test behind it. Separate from the code above because it names the remedy: press Test. |
| `ERP_MAPPING_INVALID` | The field mapping is missing something required, maps a field twice, or points at a path that is not present in the sample response. |
| `ERP_MAPPING_UNVERIFIED` | Activation was refused because the mapping has never been checked against a real response. A structurally valid mapping is still a guess about somebody else's JSON. |
| `ERP_RESPONSE_UNUSABLE` | The ERP answered, but not with anything this connection can use: not JSON, or JSON with no array of records where the mapping says one is. |
| `ERP_AUTHENTICATION_FAILED` | The customer's ERP refused our credentials. Its own 401 or 403, reported as itself rather than as a generic failure, because the remedy is entirely different from a network fault. |
| `ERP_OAUTH_TOKEN_FAILED` | The OAuth token endpoint refused the client-credentials grant. |
| `ERP_RATE_LIMITED` | The ERP asked us to slow down. Carries the retry-after it gave, where it gave one. |
| `ERP_CONNECTION_SUSPENDED` | Repeated failures took the connection out of service. It will not be called again until a test passes. |
| `ERP_WEBHOOK_REJECTED` | A webhook arrived for a connection whose signature did not verify, or which has no signing secret configured. Never says which: an endpoint that distinguishes "wrong signature" from "no secret" is an oracle. |
| `ERP_SYNC_ALREADY_RUNNING` | A sync was asked for while one is already running on this connection. |

## Auto-pay

| Code | Meaning |
|---|---|
| `AUTOPAY_PAYMENT_METHOD_REQUIRED` | Enabling was refused because there is no usable saved card. The customer is sent to add one rather than told "not eligible". |
| `AUTOPAY_CONSENT_REQUIRED` | Enabling was refused because the explicit consent box was not ticked. Charging without it is not something a flag may turn on. |
| `AUTOPAY_NOT_ENABLED` | Auto-pay is off or paused, and something asked for an off-session charge. |
| `AUTOPAY_LIMIT_EXCEEDED` | The amount is above the ceiling the customer set. Refused, not deferred. |
| `AUTOPAY_APPROVAL_REQUIRED` | The amount is above the threshold at which the customer asked to be consulted. Nothing is charged and they are asked - which is why this is not the same code as the one above. |
| `AUTOPAY_CURRENCY_MISMATCH` | The charge and the customer's limits are in different currencies, so the limit cannot be applied. Refused rather than guessed at: converting a cap the customer typed is not something to do silently. |

## Data protection

| Code | Meaning |
|---|---|
| `DATA_REQUEST_ALREADY_OPEN` | One open request of this kind already exists. Art. 12(3) runs from the first one, so a second does not restart the clock and is not a new request - the storefront is told to wait for the one already in flight. |
| `DATA_REQUEST_NOT_READY` | The bundle is still building, or its download window has closed. |
| `DATA_REQUEST_ALREADY_DECIDED` | A decision was attempted on a request that is no longer pending. |
| `ERASURE_BLOCKED_BY_OBLIGATION` | Art. 17(3)(b)/(e): erasure refused because something else legally requires the data - unpaid orders, an open return, a live schedule. The detail names what, so the answer to the subject can too. |
| `EMAIL_ALREADY_IN_USE` | Somebody asked to move their account to an address another account already uses, or is already moving to. |
| `CONTACT_CHANGE_NOT_PENDING` | A pending email or telephone change was confirmed, or resent, when there is no change in flight to confirm. |

## A buyer's own ERP, and the organisation that owns it

| Code | Meaning |
|---|---|
| `ORGANIZATION_REQUIRED` | The account is not in a buyer organisation yet, and something that needs one was attempted. Ordinarily impossible - one is provisioned on first use - so this means an account with no customer profile, or an organisation that has since been archived. |
| `ORGANIZATION_ROLE_INSUFFICIENT` | The member's role does not permit this. Configuring credentials and mappings is OWNER and INTEGRATION_MANAGER only; a MEMBER may look. |
| `ORGANIZATION_LAST_OWNER` | Removing or demoting the last owner was refused. An organisation with no owner has nobody who can grant anybody else access to it, which is not a state anything can recover from without support. |
| `ORGANIZATION_INVITE_INVALID` | The invitation does not exist, has expired, was withdrawn, was already used, or is addressed to a different email address than the one signed in. Deliberately one code for all five: an endpoint that distinguishes them is an oracle for who has been invited where. |
| `ORGANIZATION_ALREADY_MEMBER` | The account already belongs to an organisation. A profile belongs to at most one - see `BuyerOrganizationMember` - so joining a second means leaving the first, which is a decision rather than a side effect. |
| `CUSTOMER_ERP_URL_NOT_ALLOWED` | The address is not one this server will call: not https, missing a host, carrying credentials in the URL, resolving to a private, loopback or link-local network, or outside the host policy this deployment allows. The detail says which. |
| `CUSTOMER_ERP_ENDPOINT_OFF_ORIGIN` | An endpoint path pointed at a different origin from the base URL. Refused, because an "endpoint" free to leave the authorised host is a server-side request forgery primitive with a form field in front of it. |
| `CUSTOMER_ERP_ENDPOINT_MISSING` | Something is being sent that has no endpoint configured for it. Names what, because the remedy is either to add the endpoint or to switch that event off in the sync rules. |
| `CUSTOMER_ERP_STATE_INVALID` | The connection is not in a state that allows what was asked - activating a draft that has not been tested, resuming one that was never paused. The message names the current state. |
| `CUSTOMER_ERP_UNTESTED` | Activation was refused because no test has passed since the configuration last changed. Separate from the code above because it names the remedy. |
| `CUSTOMER_ERP_MAPPING_INVALID` | The field mapping is missing something required, maps one field twice, or points at a path that is not present in the sample response. |
| `CUSTOMER_ERP_MAPPING_UNVERIFIED` | Activation was refused because the mapping has never been checked against a real response from this connection. |
| `CUSTOMER_ERP_RESPONSE_UNUSABLE` | The ERP answered, but not with anything this connection can use: not JSON, or JSON with no array of records where the mapping says one is. |
| `CUSTOMER_ERP_AUTH_FAILED` | The buyer's ERP refused our credentials - its own 401 or 403, reported as itself rather than as a generic failure, because the remedy is entirely different from a network fault. |
| `CUSTOMER_ERP_TOKEN_EXPIRED` | An OAuth access token has expired and could not be refreshed. The buyer has to authorise again; the connection sits in ACTION_REQUIRED until they do, rather than retrying a grant that will keep being refused. |
| `CUSTOMER_ERP_OAUTH_FAILED` | The OAuth authorisation or token exchange failed: a refused grant, a mismatched redirect URI, a state that does not belong to this flow. |
| `CUSTOMER_ERP_RATE_LIMITED` | The buyer's ERP asked us to slow down. Carries its `Retry-After` where it gave one. |
| `CUSTOMER_ERP_SUSPENDED` | Repeated failures took the connection out of service. It will not be called again until a test passes. |
| `CUSTOMER_ERP_WEBHOOK_REJECTED` | A webhook arrived whose signature did not verify, whose timestamp was outside the replay window, or for a connection with no signing secret. Never says which: an endpoint that distinguishes those is an oracle. |
| `CUSTOMER_ERP_SYNC_ALREADY_RUNNING` | A sync was asked for while one is already running on this connection. |
| `CUSTOMER_ERP_EVENT_STATE_INVALID` | An event was asked to move somewhere its lifecycle does not allow - most often retrying one that has already succeeded, which would mean a second purchase order. |
| `CUSTOMER_ERP_APPROVAL_REQUIRED` | The write is over the organisation's approval threshold, or the policy requires a person for this kind of write. An approval has been raised and the event is holding; nothing has been sent. |
| `CUSTOMER_ERP_LIMIT_REACHED` | The organisation already holds as many connections as this deployment permits. |
| `CUSTOMER_ERP_CONFIGURATION_REFUSED` | The chosen combination is refused on purpose: a monday personal token on a production connection, an automatic inventory write from a sandbox, a credential type the selected system does not accept. The message names which, because every one of them has a legitimate alternative. |
| `CUSTOMER_ERP_SPEC_UNUSABLE` | The uploaded OpenAPI document could not be read, or described nothing this connector could use. |
| `CUSTOMER_ERP_PRODUCT_CODE_INVALID` | A product-code mapping could not be made: the code is already mapped to a different product on this connection, the product does not exist, or an uploaded mapping file could not be read. The message names which, and for a file it names the line. |

## Seller Hub

| Code | Meaning |
|---|---|
| `SELLER_ACCOUNT_REQUIRED` | The signed-in account has no seller organisation. Distinct from SELLER_NOT_APPROVED: this one means "you have not applied", and the action is to start an application rather than to wait. |
| `SELLER_NOT_APPROVED` | There is an application, and it has not been approved. The message names the state, because "submitted" and "action required" need opposite responses from the seller. |
| `SELLER_SUSPENDED` | The account was approved and has since been stopped. Kept apart from SELLER_NOT_APPROVED so a suspended seller is never told to finish an application they already finished. |
| `SELLER_ROLE_DENIED` | The member holds a seller role that does not carry this action - a Finance Viewer editing a listing, a Support Member issuing a payout. |
| `SELLER_RESOURCE_DENIED` | The row exists and belongs to a different seller. Returned as 404 by the route layer for the same reason `assertOwnership` does: confirming that somebody else's listing exists is itself a leak. |
| `SELLER_LOCK_NOT_SET` | This person has not chosen a Seller Hub password yet. |
| `SELLER_LOCK_REQUIRED` | The lock exists and this session has not opened it. |
| `SELLER_LOCK_INVALID` | The seller password given was wrong. |
| `SELLER_DISPLAY_NAME_TAKEN` | The public display name is taken. |
| `SELLER_APPLICATION_TRANSITION_NOT_ALLOWED` | The application cannot move the way it was asked to. Same shape as ORDER_TRANSITION_NOT_ALLOWED and separate from it, because the states and the remedies are different. |
| `SELLER_ONBOARDING_INCOMPLETE` | Submission was refused because required onboarding steps are unfinished. `details` carries one entry per missing step, keyed to the step so the interface can link straight to it. |
| `SELLER_RESUBMISSION_NOT_ALLOWED` | A rejected application whose operator closed resubmission. |
| `SELLER_STALE_VERSION` | Somebody else saved this application, listing or offer since it was loaded. The client reloads and shows what changed rather than overwriting it. |
| `SELLER_LAST_OWNER` | The last owner cannot be removed or demoted. An organisation with no owner has nobody who can invite one. |
| `SELLER_INVITATION_INVALID` | The invitation is expired, already accepted, revoked, or addressed to a different email than the one signed in. |
| `SELLER_MEMBERSHIP_EXISTS` | This account already belongs to a seller organisation. One profile, one seller - see `SellerMember`. |
| `LISTING_TRANSITION_NOT_ALLOWED` | A listing draft cannot move the way it was asked to. |
| `LISTING_NOT_SUBMITTABLE` | Submission refused: required sections do not pass. `details` carries one entry per blocking issue, each naming its section and attribute, so the interface puts every refusal beside the field that caused it rather than showing one sentence at the top. |
| `LISTING_ATTRIBUTE_INVALID` | A value failed its category attribute definition - wrong type, outside bounds, not an allowed option, failed the pattern. |
| `LISTING_IMAGE_REQUIRED` | A required image slot is empty, or an uploaded image failed a check. |
| `LISTING_TITLE_NOT_READY` | The title cannot be generated yet because a title-component attribute is missing or invalid. This is what keeps "Preview title" from producing a half-title that a seller then believes. |
| `LISTING_TITLE_NOT_EDITABLE` | Policy does not let this seller edit a generated title. |
| `SELLER_SKU_ALREADY_EXISTS` | This seller already uses that SKU on another offer or draft. |
| `SELLER_OFFER_ALREADY_EXISTS` | This seller already has an offer on this product and variant. A second one would put the same seller against themselves on the buyer's page. |
| `LISTING_PACK_CONVERSION_INVALID` | The pack hierarchy does not multiply out - units per pack times packs per box does not give the stated units per box, or a figure is zero. |
| `SELLER_PRICE_TIER_INVALID` | Volume price bands overlap, or a band is not cheaper than the one below. |
| `SELLER_OFFER_UNIT_UNSUPPORTED` | The offer is stored in an ordering unit a seller may not sell in. |
| `SELLER_OFFER_UNIT_MISMATCH` | The request named an ordering unit this offer is not sold in. |
| `BRAND_NOT_APPROVED` | The brand is not approved for use on a published listing. |
| `BRAND_ALREADY_EXISTS` | A brand by that name already exists, or a request for it is already pending. The message names which and links to it - a seller refused without being told where the existing one is will simply ask again. |
| `SELLER_LOCATION_REQUIRED` | The seller has no location that can hold or dispatch this. |
| `SELLER_LOCATION_CODE_EXISTS` | The location code is already used by this seller. |
| `SELLER_INVENTORY_CONFLICT` | Stock would go negative, or the conditional update lost a race. The caller retries; it is not a validation failure. |
| `SELLER_ORDER_TRANSITION_NOT_ALLOWED` | The seller's part of an order cannot move the way it was asked to. |
| `SELLER_FULFILMENT_QUANTITY_INVALID` | More units were claimed as dispatched or returned than the line holds. |
| `SELLER_PAYOUT_PROVIDER_UNCONFIGURED` | The deployment has no payout provider configured, so payout onboarding cannot start. |
| `SELLER_PAYOUT_NOT_ELIGIBLE` | The payout account exists but the provider will not pay it yet, or the operator is holding it. The message says which and what is outstanding. |
| `SELLER_SETTLEMENT_NOT_PAYABLE` | A settlement that is not closed, already paid, or on hold. |
| `SELLER_DOCUMENT_REJECTED` | A document was refused: wrong type, too large, failed its scan, or the scanner is unavailable and the deployment refuses unscanned uploads. |
| `SELLER_AGREEMENT_REQUIRED` | A required agreement has not been accepted at its current version. |

## Logistics partner portal

| Code | Meaning |
|---|---|
| `LOGISTICS_PARTNER_REQUIRED` | The signed-in account is not a member of any logistics organisation. The portal turns this into "this account has no carrier attached to it", which is a support conversation rather than a screen with a button. |
| `LOGISTICS_PARTNER_NOT_ACTIVE` | The organisation exists but the marketplace has suspended or deactivated it. Distinct from the code above because the remedy is different: there is an account, and somebody has to reinstate it. |
| `LOGISTICS_MEMBER_DISABLED` | The member's own access was disabled while the organisation stayed active. Their colleagues can still sign in; they cannot. |
| `LOGISTICS_MFA_SETUP_REQUIRED` | Signed in, but this session has not passed its TOTP challenge and the caller's role requires one. The portal turns it into the challenge screen. Deliberately NOT `MFA_REQUIRED`, which the other two surfaces use to mean "supply a code with your password" at the login step. |
| `LOGISTICS_MFA_CHALLENGE_REQUIRED` |  |
| `SHIPMENT_TRANSITION_NOT_ALLOWED` | The shipment cannot move the way it was asked to. Carries `from` and `to` in the detail meta so the portal can say which move was refused. |
| `SHIPMENT_POD_REQUIRED` | Delivered was asked for and the deployment's Proof of Delivery policy is not satisfied. Its own code because the remedy is a form, not a retry. |
| `SHIPMENT_CORRECTION_NOT_ALLOWED` | An operator status correction was refused - wrong actor, no reason, or nothing to correct. |
| `SHIPMENT_NOT_ASSIGNED` | The shipment is not assigned to the caller's organisation, or the assignment has been withdrawn. Returned only where the caller already knows the shipment exists - a bare lookup answers NOT_FOUND, on the same reasoning as `assertOwnership`. |
| `SHIPMENT_ASSIGNMENT_SETTLED` | The assignment has already been accepted or rejected. A second answer to a question that was already answered. |
| `SHIPMENT_OTP_INVALID` | A delivery OTP did not match, or has expired. |
| `LOGISTICS_PARTNER_NOT_ELIGIBLE` | A pickup cannot be scheduled or completed in its current state. A SELLER asked to hand a consignment to a carrier they are not entitled to use: no arrangement, one that is not approved, one that is suspended or out of its dates, or one that does not cover this route or this handling. |
| `LOGISTICS_SHIPMENT_TERMINAL` | The consignment has finished - delivered, cancelled, returned, lost or destroyed - and cannot be assigned, reassigned or moved on. |
| `LOGISTICS_PICKUP_NOT_ACTIONABLE` |  |
| `LOGISTICS_MANIFEST_NOT_ACTIONABLE` | A manifest cannot take this shipment - wrong partner, wrong status, or the manifest is already closed. |
| `LOGISTICS_DRIVER_NOT_ELIGIBLE` | The driver is not this organisation's, is not active, or lacks the approval the shipment's handling requirements demand. |
| `LOGISTICS_LOCATION_PING_REJECTED` | A location ping was refused. One code with a detail rather than five codes, because the caller is a phone in a van and its only sensible response to any of them is to drop the ping and carry on: impossible coordinates, a timestamp too far in the past or future, a speed no vehicle achieves, a sequence number already seen, or no active trip. |
| `LOGISTICS_LOCATION_NOT_AVAILABLE` | The caller asked for a driver's position and holds no authority to read one, or the trip is not running. Separate from PERMISSION_DENIED because the portal must not offer a retry: there is nothing to retry. |
| `CARRIER_PROVIDER_UNCONFIGURED` |  |
| `CARRIER_REQUEST_FAILED` | The carrier answered, and answered with a refusal. The message carries their own words where they are safe to repeat. |
| `CARRIER_WEBHOOK_REJECTED` | A webhook's signature did not verify, its timestamp was outside the accepted window, or its event id had already been processed. One code: the sender is a machine, the response is a 4xx it will log, and telling it which of the three would help an attacker tune the next attempt. |

## How a seller's own goods get delivered

| Code | Meaning |
|---|---|
| `CARRIER_OPERATION_NOT_SUPPORTED` |  |
| `SELLER_FULFILMENT_NO_ELIGIBLE_METHOD` | The seller has no fulfilment method that can carry this consignment. |
| `SELLER_FULFILMENT_METHOD_NOT_APPROVED` | The method exists and is not usable yet - draft, in setup, awaiting the marketplace, paused, rejected or disconnected. The message says which. |
| `SELLER_FULFILMENT_TRANSITION_INVALID` | A status move the fulfilment-method state machine does not allow. |
| `SELLER_FULFILMENT_ROLE_TAKEN` | A seller tried to make a second method primary, or a second fallback. |
| `SELLER_FULFILMENT_RULE_INVALID` | A rule naming something that is not the seller's, or a scope whose match column is missing. The database refuses it too; this is what the seller is told. |
| `SELLER_CARRIER_CONNECTION_NOT_READY` | A carrier connection cannot go live yet. |
| `SELLER_CARRIER_CREDENTIAL_UNAVAILABLE` | The credential this connection needs is absent, or will not decrypt. |
| `SELLER_LOGISTICS_PARTNER_NOT_YOURS` | A seller tried to reach a delivery company that is not theirs. |
| `SELLER_PARTNER_INVITATION_INVALID` | An invitation token that is unknown, spent, withdrawn or out of date. |
| `SHIPMENT_ALREADY_PURCHASED` | This consignment has already been bought at the provider. |
| `CARRIER_QUOTE_NOT_USABLE` | The quote being accepted has expired, been superseded, or belongs to another consignment. Never silently re-priced: the shipment asks again. |
| `PICKUP_TRANSITION_INVALID` | A collection was asked to move somewhere it cannot go from where it is. |
| `PICKUP_ALREADY_BOOKED` | This consignment already has a collection booked that has not happened. |
| `PICKUP_NOT_AVAILABLE` | The consignment has no way of being collected yet. |

## Console notifications

| Code | Meaning |
|---|---|
| `NOTIFICATION_NOT_MANUALLY_RESOLVABLE` | Somebody pressed "resolve" on an alert that only the underlying domain event may close. |
| `NOTIFICATION_NOT_AN_ALERT` | A resolve or dismiss was aimed at a row that is not an alert. |

## The assistant

| Code | Meaning |
|---|---|
| `ASSISTANT_GUEST_LIMIT_REACHED` |  |

## Bulk ordering: carton, pallet, container

| Code | Meaning |
|---|---|
| `PACKAGING_OPTION_NOT_AVAILABLE` | The buyer asked for a package this seller does not offer on this variant. |
| `PACKAGING_OPTION_INCOMPLETE` | The seller has switched the package on and not finished describing it. |
| `PACKAGING_UNIT_MISMATCH` | The unit named on the request is not the packaging the line is sold in. |
| `PACKAGING_SNAPSHOT_STALE` | The seller re-specified the packaging while it sat in somebody's basket. |
| `PACKAGING_INSUFFICIENT_FOR_PACKAGE` | There is not enough stock for a WHOLE number of these packages. |
| `PACKAGING_CAPACITY_EXCEEDED` | The order is past a weight or capacity the seller configured. |
| `FREIGHT_QUOTE_REQUIRED` | This load cannot be priced instantly and needs a freight quotation. |
| `FREIGHT_CARRIER_CANNOT_CARRY` | The carrier chosen cannot express a booking for this kind of load. |
| `FREIGHT_QUOTE_NOT_ACTIONABLE` | A quote request was acted on in a state that does not allow it. |

## A seller's own accounting system (TallyPrime)

| Code | Meaning |
|---|---|
| `SELLER_ERP_NOT_CONFIGURED` | The seller has not set up an ERP connection, or it is switched off. |
| `SELLER_ERP_BRIDGE_UNAVAILABLE` | The action needs a live bridge and there is not one. |
| `SELLER_ERP_PAIRING_INVALID` | The pairing code is wrong, expired, already used, or has been guessed at too many times. One code for all four on purpose: telling the holder of a bad code WHICH of those it is hands them a way to enumerate good ones. |
| `SELLER_ERP_BRIDGE_UNAUTHORISED` | The bridge presented a token that is unknown, revoked or expired. |
| `SELLER_ERP_MAPPING_INCOMPLETE` | A sync was asked for and a mapping it would need is missing or unconfirmed. `details` lists each one, so the screen can link to it. |
| `SELLER_ERP_TALLY_REJECTED` | Tally answered, and what it said was a refusal. |
| `SELLER_ORDER_NOT_CONFIRMED` | The seller has not confirmed this order yet, so nobody may be asked to carry it. A carrier offered work on an order the seller may still refuse has been handed an obligation nobody agreed to. |
| `CONSIGNMENT_REASSIGNMENT_LOCKED` | The carrier has the goods, so the seller cannot move the consignment to somebody else. Chain of custody: only the carrier holding it and the marketplace can arrange that. `details[0].meta.status` is where it is. |
| `CARRIER_TRACKING_NUMBER_REQUIRED` | A hand-made carrier booking has no tracking number yet, and the step asked for needs one: nothing about a parcel's journey is recorded until the carrier's own number for it exists. |
| `SELLER_ERP_COMPANY_NOT_LOADED` | The company this connection posts into is not open in Tally. |
| `SELLER_ERP_RESPONSE_INVALID` | The response was not well-formed XML, was too large, or contained a document-type or entity declaration. All four are refused identically and nothing is parsed out of the payload - see `tally/xml.ts`. |
| `SELLER_ERP_JOB_NOT_ACTIONABLE` | The job cannot be retried or cancelled from the state it is in. |
| `SELLER_ERP_DIRECT_MODE_REFUSED` | A direct-mode address was rejected by the outbound guard, or direct mode is not permitted on this deployment at all. |

## The four delivery levels (L1-L4)

| Code | Meaning |
|---|---|
| `LOGISTICS_L1_OWNER_FIXED` | Somebody tried to give L1 to UBOSS. L1 - plant to port of loading - is the seller's in every mode. |
| `LOGISTICS_HYBRID_ALL_SELLER` | Self + UBOSS with the seller on all three of L2, L3 and L4. That is the Self mode; at least one of them must stay UBOSS-managed. |
| `LOGISTICS_MODE_OWNERS_MISMATCH` | Owners the chosen mode does not allow - Self with a UBOSS level, or UBOSS with a seller level. Only reachable by a hand-made request. |
| `LOGISTICS_CHANGE_NOT_CONFIRMED` | The change moves a level to a different owner, or changes the mode, of a policy that is already published, and the request did not confirm it. |
| `LOGISTICS_POLICY_VERSION_CONFLICT` | The policy changed since it was read. Reload and try again. |
| `LOGISTICS_LEVEL_NOT_SELLER_CONTROLLED` | A seller tried to price or assign a level UBOSS controls. |
| `LOGISTICS_LEVEL_NOT_UBOSS_CONTROLLED` | Marketplace staff tried to price or assign a level the seller controls. |
| `LOGISTICS_PRICE_INVALID` | The price is not a whole number of minor units, is negative, or is zero without being marked free. `details[0].code` says which. An EMPTY price is never this error - it is simply not priced yet. |
| `LOGISTICS_FREE_NOT_CONFIRMED` | A level was marked free without the explicit confirmation free needs. |
| `LOGISTICS_PROVIDER_NOT_ENABLED` | The carrier is not switched on under Seller Hub -&gt; Logistics. |
| `LOGISTICS_CARRIER_UNSUITABLE` | That carrier cannot move goods that way on that level - DHL by sea, a pallet by India Post. `details[0].code` names the reason. |
| `LOGISTICS_RATE_INCOMPLETE` | A price cannot be published without an amount (or a confirmed free) and a carrier. |
| `LOGISTICS_RATE_NOT_EDITABLE` | A published price is never edited. Change it by saving a new version. |
| `LOGISTICS_QUOTE_REQUIRED` | No approved price exists for this route on at least one level, so it cannot be bought yet. `details` names the seller and the levels. |
| `LOGISTICS_PRICE_CHANGED` | The delivery charges changed since the buyer was shown them, or the quote the checkout carried was not the one this server issued. |
| `LOGISTICS_LEG_NOT_ASSIGNABLE` | The leg is past the point where a carrier can be named or changed. |
| `LOGISTICS_LEG_TRANSITION_INVALID` | The leg cannot move to that status from where it is, or not by you - including starting a leg before the one ahead of it was handed over. |
| `LOGISTICS_LEG_TRACKING_REQUIRED` | A carrier booked by hand needs its real tracking reference before the leg can start. Never generated here. |

## Platform fee

| Code | Meaning |
|---|---|
| `PLATFORM_FEE_POLICY_INVALID` | A platform-fee policy is inconsistent - a PERCENT fee with no rate, a minimum above the maximum, a scope with nothing to apply to. |
| `PLATFORM_FEE_POLICY_NOT_EDITABLE` | A published or retired fee policy is never edited; draft a new version. |

## Bulk preorders

| Code | Meaning |
|---|---|
| `PREORDER_NOT_AVAILABLE` | The seller has not configured preorders for this product, has switched them off, or left a figure a preorder cannot be taken without. |
| `PREORDER_BUYER_NOT_ELIGIBLE` | Preorders are for business accounts, and this account has no company. |
| `PREORDER_BELOW_MINIMUM` | The requested quantity is below the seller's minimum. meta.minimumBaseUnits. |
| `PREORDER_INCREMENT_MISMATCH` | The requested quantity is not a whole multiple of the increment. meta.incrementBaseUnits. |
| `PREORDER_ABOVE_MAXIMUM` | The requested quantity is above the seller's preorder maximum. |
| `PREORDER_UNIT_NOT_AVAILABLE` | The unit asked for (a pallet, a container) is not one this seller takes preorders in for this product. |
| `PREORDER_DATE_TOO_EARLY` | The requested delivery date is earlier than the lead time allows. meta.earliest is a YYYY-MM-DD calendar day. |
| `PREORDER_DATE_TOO_FAR` | The requested delivery date is beyond the seller's advance-booking window. meta.latest. |
| `PREORDER_DESTINATION_NOT_SERVED` | The seller does not deliver preorders of this product to that country. |
| `PREORDER_TRANSITION_NOT_ALLOWED` | The preorder cannot move that way from where it is, or not by you. |
| `PREORDER_TERMS_CHANGED` | The terms being confirmed are not the seller's current terms - a newer revision exists, or the page was open while they changed. |
| `PREORDER_CAPACITY_EXCEEDED` | Confirming this would promise more than the seller can make in that period. meta.availableBaseUnits. |
| `PREORDER_EXPIRED` | The window to answer has passed. |
| `PREORDER_POLICY_INVALID` | A preorder policy a seller tried to save does not hold together - an increment larger than the maximum, a band below the minimum. |

## Seller invoices and packing lists

| Code | Meaning |
|---|---|
| `SELLER_DOCUMENT_NOT_ELIGIBLE` | This consignment cannot have that document yet - the order is not paid, the seller has not accepted it, or the consignment was cancelled. |
| `SELLER_DOCUMENT_VALIDATION_FAILED` | The document cannot be issued until the listed fields are fixed. `details` lists each one - a missing GSTIN, a line with no HSN code. |
| `SELLER_DOCUMENT_IMMUTABLE` | An issued document is never edited. Void it with a credit note, or supersede the packing list with a new version. |
| `SHIPMENT_PACKAGES_LOCKED` | The packages cannot change: one has been scanned, a carrier label was bought, or the packing list is issued. |
| `SHIPMENT_CONTENTS_MISMATCH` | What the packages hold does not add up to what the consignment carries. |
| `SHIPMENT_SPLIT_INVALID` | A split asked for more than the consignment carries, or would leave it empty. |
| `DOCUMENT_RENDER_FAILED` | The PDF could not be produced. Nothing was issued and nothing was marked packed; try again. |

## Quantity price bands

| Code | Meaning |
|---|---|
| `QUANTITY_TIERS_INVALID` | The seller's quantity bands contradict themselves or the list price. The details name each band by index and what is wrong (`domain/quantity-tier.ts`). |
| `STORE_QUANTITY_DISCOUNTS_INVALID` | The store-wide quantity discounts contradict themselves: a start below two pieces, a discount outside 0.01%-90%, a repeated start, or a larger quantity taking off less. The details name each rule by index and what is wrong. |

