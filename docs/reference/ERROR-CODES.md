# Error codes: every code the API can return

> **Generated file - do not edit by hand.** It is rebuilt from
> `backend/src/domain/errors.ts` by `scripts/build-reference-docs.mjs`.
> After changing that code, run `cd scripts; npm run docs` and commit the result.
> `npm run docs:check` fails when this file has fallen behind the code.

**546 codes.** Every failure from the API has the same shape, and `code` is one of the values below. The codes are a **published contract**: both storefront and admin panel turn each one into a message in eight languages. A new situation gets a new code; an existing code is never renamed or given a new meaning.

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
| [Generic](#generic) | 11 |
| [Authentication / authorization](#authentication-authorization) | 20 |
| [Invitations and tokens](#invitations-and-tokens) | 8 |
| [Catalog](#catalog) | 15 |
| [Image search](#image-search) | 3 |
| [Inventory](#inventory) | 9 |
| [Cart and purchasing limits](#cart-and-purchasing-limits) | 10 |
| [Orders](#orders) | 7 |
| [Fulfilment options](#fulfilment-options) | 6 |
| [Idempotency](#idempotency) | 3 |
| [Payments](#payments) | 15 |
| [Recurring](#recurring) | 29 |
| [Localisation & currency](#localisation-currency) | 4 |
| [Coupons](#coupons) | 8 |
| [Integrations](#integrations) | 9 |
| [A configurable ERP connection](#a-configurable-erp-connection) | 13 |
| [Auto-pay](#auto-pay) | 15 |
| [Data protection](#data-protection) | 6 |
| [A buyer's own ERP, and the organisation that owns it](#a-buyer-s-own-erp-and-the-organisation-that-owns-it) | 26 |
| [Seller Hub](#seller-hub) | 46 |
| [Logistics partner portal](#logistics-partner-portal) | 23 |
| [How a seller's own goods get delivered](#how-a-seller-s-own-goods-get-delivered) | 15 |
| [Console notifications](#console-notifications) | 2 |
| [The assistant](#the-assistant) | 1 |
| [Bulk ordering: carton, pallet, container](#bulk-ordering-carton-pallet-container) | 9 |
| [A seller's own accounting system (TallyPrime)](#a-seller-s-own-accounting-system-tallyprime) | 13 |
| [The four delivery levels (L1-L4)](#the-four-delivery-levels-l1-l4) | 18 |
| [Platform fee](#platform-fee) | 5 |
| [Bulk preorders](#bulk-preorders) | 20 |
| [Preorder chat](#preorder-chat) | 10 |
| [Support tickets](#support-tickets) | 8 |
| [Disputes, claims and chargebacks](#disputes-claims-and-chargebacks) | 9 |
| [Seller invoices and packing lists](#seller-invoices-and-packing-lists) | 7 |
| [Seller commission invoices](#seller-commission-invoices) | 8 |
| [Terms and Conditions](#terms-and-conditions) | 5 |
| [Quantity price bands](#quantity-price-bands) | 2 |
| [Buyer companies](#buyer-companies) | 18 |
| [Product reviews](#product-reviews) | 3 |
| [Message centre (JOURNEY-055)](#message-centre-journey-055) | 2 |
| [Notification centre (JOURNEY-056)](#notification-centre-journey-056) | 1 |
| [B2C maximum order quantity](#b2c-maximum-order-quantity) | 1 |
| [Pre-shipment inspection and the dispatch gate](#pre-shipment-inspection-and-the-dispatch-gate) | 17 |
| [Returns](#returns) | 5 |
| [The buyer experience: cart, checkout, account, alerts, reviews](#the-buyer-experience-cart-checkout-account-alerts-reviews) | 27 |
| [Requests for quotation (Master rows 16-19)](#requests-for-quotation-master-rows-16-19) | 26 |
| [Country rules, rate cards and storefront content (Master rows 69, 71, 72)](#country-rules-rate-cards-and-storefront-content-master-rows-69-71-72) | 3 |
| [Held funds, the transaction ledger and seller payouts (Master rows 58-61, 43)](#held-funds-the-transaction-ledger-and-seller-payouts-master-rows-58-61-43) | 4 |
| [Admin governance: maker-checker, moderation, CMS approval (JOURNEY-061, 062, 067)](#admin-governance-maker-checker-moderation-cms-approval-journey-061-062-067) | 8 |
| [Change control for a seller's verified company details (JOURNEY-027)](#change-control-for-a-seller-s-verified-company-details-journey-027) | 3 |
| [Audit Console](#audit-console) | 10 |

## Generic

| Code | Meaning |
|---|---|
| `VALIDATION_FAILED` |  |
| `NOT_FOUND` |  |
| `CONFLICT` |  |
| `INTERNAL_ERROR` |  |
| `SERVICE_UNAVAILABLE` |  |
| `SMS_DELIVERY_FAILED` |  |
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
| `MFA_CHALLENGE_REQUIRED` | Storefront and Seller Hub. The account has two-step sign-in switched on and THIS session has not passed its code yet. 403. The storefront shows the code box; only /auth/me, /auth/mfa/challenge and /auth/logout answer. |
| `MFA_SETUP_REQUIRED` | Storefront and Seller Hub. This person's role (a seller owner, or anybody holding payout or finance permissions), or the act itself (switching on AutoPay), needs two-step sign-in and the account has none. 403. The storefront answers with the setup screen - a prompt, never a dead end. |
| `MFA_REQUIRED_BY_ROLE` | Asked to switch two-step sign-in off while holding a role that requires it. 409. Changing the role first is the way out. |
| `STEP_UP_REQUIRED` | A sensitive act - changing the email or password, connecting payouts, changing team roles, switching on AutoPay, changing two-step sign-in - needs the person to confirm it is them again, and this session has not done so within STEP_UP_WINDOW_SECONDS. 403. `details[0].meta.method` is `TOTP` or `PASSWORD`: which proof the storefront should ask for. |
| `CAPTCHA_REQUIRED` | The deployment has a bot check switched on (CAPTCHA_PROVIDER) and the form was sent without its answer. 400. |
| `CAPTCHA_FAILED` | The bot check's answer was refused by the provider, or the provider could not be asked. 400. Fails closed: the form is not accepted. |
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
| `IMAGE_SEARCH_UNAVAILABLE` |  |

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
| `RECEIPT_NOT_AVAILABLE` | A receipt was asked for a payment that was never captured, or a refund the provider has not confirmed. A receipt says money moved; until it has, there is nothing to acknowledge. |

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
| `PAYMENT_ATTEMPT_IN_PROGRESS` | Another payment for this order is already open, or is already being processed by the bank, and starting a second one could charge twice. |
| `PAYMENT_AMOUNT_NOT_SUPPORTED` | The order's total cannot be taken by card online in its currency - it is above the gateway's per-payment ceiling, or it is not a whole number of the units the gateway settles in (Stripe charges HUF in whole forint). |

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
| `AUTOPAY_AUTHORITY_EXPIRED` | The end date the customer gave their standing authority has passed. Nothing is charged; the customer sets a new date to carry on. |
| `AUTOPAY_AUTHORITY_NOT_STARTED` | The start date the customer gave their standing authority has not come yet. Nothing is charged. |
| `AUTOPAY_PERIOD_CAP_REACHED` | This charge would take the customer's automatic payments for the current period above the cap they set. Not charged; the order waits for them to pay it themselves, which is their explicit approval. |
| `AUTOPAY_OUTSIDE_SCOPE` | The order is from a supplier or in a category the customer's standing authority does not cover. Not charged; it waits for them. |
| `SCHEDULE_CONFIRMATION_NOT_PENDING` | A scheduled delivery is not waiting for a price confirmation (it was already confirmed, declined, or its deadline passed). |
| `SCHEDULE_CONFIRMED_TOTAL_STALE` | The total the customer confirmed is no longer the total: the price moved again. Nothing is charged; the new total is shown to confirm afresh. |
| `BUYER_COMPANY_APPROVAL_PENDING` | The buyer company's own sign-off rule: the order waits for an approver or finance before it can be paid. |
| `BUYER_COMPANY_SELF_APPROVAL` | Nobody may sign off an order they placed, and the finance stage may not be signed off by whoever approved the first. |
| `BUYER_COMPANY_APPROVAL_NOT_PENDING` | This stage has already been decided, or the order is no longer waiting. |

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
| `SELLER_SESSION_EXPIRED` | The Hub was open and has re-locked itself after SELLER_HUB_IDLE_TIMEOUT_SECONDS without deliberate activity. Its own code rather than LOCK_REQUIRED, so the lock screen can say why it is back: "your session expired due to inactivity", not "enter your password" out of nowhere. The remedy is the same - enter the Seller Hub password. |
| `SELLER_DISPLAY_NAME_TAKEN` | The public display name is taken. |
| `SELLER_APPLICATION_TRANSITION_NOT_ALLOWED` | The application cannot move the way it was asked to. Same shape as ORDER_TRANSITION_NOT_ALLOWED and separate from it, because the states and the remedies are different. |
| `SELLER_ONBOARDING_INCOMPLETE` | Submission was refused because required onboarding steps are unfinished. `details` carries one entry per missing step, keyed to the step so the interface can link straight to it. |
| `SELLER_RESUBMISSION_NOT_ALLOWED` | A rejected application whose operator closed resubmission. |
| `SELLER_APPROVAL_EVIDENCE_MISSING` | Approval refused: the evidence a reviewer needs is not all there yet. A required onboarding step is unfinished, a required document is not accepted or has expired, or (with SELLER_REQUIRE_SCREENING) the business or one of its owners has no current CLEAR screening. `details` carries one entry per missing item: `STEP_INCOMPLETE` (field = step key), `DOCUMENT_NOT_APPROVED` / `DOCUMENT_EXPIRED` (field = requirement key), `SCREENING_REQUIRED` / `SCREENING_NOT_CLEAR` (field = `entity` or the owner… |
| `SELLER_STALE_VERSION` | Somebody else saved this application, listing or offer since it was loaded. The client reloads and shows what changed rather than overwriting it. |
| `SELLER_LAST_OWNER` | The last owner cannot be removed or demoted. An organisation with no owner has nobody who can invite one. |
| `SELLER_INVITATION_INVALID` | The invitation is expired, already accepted, revoked, or addressed to a different email than the one signed in. |
| `SELLER_MEMBERSHIP_EXISTS` | This account already belongs to a seller organisation. One profile, one seller - see `SellerMember`. |
| `SELLER_INVITATION_EXISTS` | That address already has an invitation to this seller's team that can still be accepted. Resend it rather than sending a second one. |
| `SELLER_ALREADY_MEMBER` | That person is already an active member of this seller's team. Change their role instead. |
| `SELLER_MEMBER_PROTECTED` | That member cannot be changed or removed by the caller. `details[0].code` is SELF (nobody changes or removes themselves) or ROLE_ABOVE_YOURS (their role carries a permission the caller does not hold - an admin cannot touch an owner). |
| `SELLER_INVITATION_SEND_LIMIT` | One invitation has been emailed as many times as it may be. Withdraw it and invite again. `details[0].meta.max` is the cap. |
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
| `SHIPMENT_OTP_UNAVAILABLE` | A delivery code cannot be sent for this consignment at all. |
| `SHIPMENT_OTP_RESEND_LIMITED` | A new delivery code was asked for too soon after the last one, or the consignment has had as many codes as it may have today. HTTP 429. `details[0].code` is `TOO_SOON` (with `meta.retryAt`) or `DAILY_LIMIT_REACHED`. |
| `LOGISTICS_PARTNER_NOT_ELIGIBLE` | A pickup cannot be scheduled or completed in its current state. A SELLER asked to hand a consignment to a carrier they are not entitled to use: no arrangement, one that is not approved, one that is suspended or out of its dates, or one that does not cover this route or this handling. |
| `LOGISTICS_SHIPMENT_TERMINAL` | The consignment has finished - delivered, cancelled, returned, lost or destroyed - and cannot be assigned, reassigned or moved on. |
| `LOGISTICS_PICKUP_NOT_ACTIONABLE` |  |
| `LOGISTICS_MANIFEST_NOT_ACTIONABLE` | A manifest cannot take this shipment - wrong partner, wrong status, or the manifest is already closed. |
| `LOGISTICS_DRIVER_NOT_ELIGIBLE` | The driver is not this organisation's, is not active, or lacks the approval the shipment's handling requirements demand. |
| `LOGISTICS_LOCATION_PING_REJECTED` | A location ping was refused. One code with a detail rather than five codes, because the caller is a phone in a van and its only sensible response to any of them is to drop the ping and carry on: impossible coordinates, a timestamp too far in the past or future, a speed no vehicle achieves, a sequence number already seen, or no active trip. |
| `LOGISTICS_LOCATION_NOT_AVAILABLE` | The caller asked for a driver's position and holds no authority to read one, or the trip is not running. Separate from PERMISSION_DENIED because the portal must not offer a retry: there is nothing to retry. |
| `CARRIER_PROVIDER_UNCONFIGURED` |  |
| `CARRIER_REQUEST_FAILED` | The carrier answered, and answered with a refusal. The message carries their own words where they are safe to repeat. Also raised when the carrier did not answer in time or could not be reached - either way nothing was booked - with detail code CARRIER_TIMEOUT (HTTP 504) or CARRIER_UNREACHABLE (502) in place of CARRIER_REFUSED. |
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
| `PLATFORM_FEE_SELF_APPROVAL_FORBIDDEN` | A fee policy or fee rule must be approved by a different member of finance staff from the one who created, last edited or submitted it. |
| `PLATFORM_FEE_NOT_PENDING_APPROVAL` | Only a draft can be submitted, and only a submitted one can be approved or rejected. details[0].meta.status is where it is now. |
| `PLATFORM_FEE_RULE_INVALID` | A fee rule is inconsistent - a value band with no lower bound, a volume tier with no window, a promotion with no end date. details[0].field. |

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
| `PREORDER_ACKNOWLEDGEMENT_REQUIRED` | The buyer has not acknowledged the current version of the bulk preorder information (minimum quantity, seller confirmation, nothing charged yet). The storefront shows the note again. meta.policyVersion. |
| `PREORDER_INFO_OUTDATED` | The acknowledgement named a version of the information that is not the current one - the page was open while the operator changed it. Reload and read it again. meta.policyVersion is the current version. |
| `PREORDER_CONTAINER_NOT_CONFIGURED` | A 20-ft or 40-ft container was asked for, and the seller has not configured and verified how many pieces of this product fit in one. Pieces are still available. meta.unit. |
| `PREORDER_PROPOSAL_INVALID` | A revised-date or split-delivery proposal does not hold together - the shipments do not add up, a date is not later than the one before, the first shipment is more than is available now. `details` lists each problem with its field and code. |
| `PREORDER_STOCK_CHANGED` | The buyer accepted, and the stock the seller's proposal was built on is no longer there. Nothing was reserved or charged; the proposal is withdrawn and the seller has been asked for a new one. meta.availableToPromise, meta.required. |
| `CONTAINER_LOADING_INVALID` | A seller's container loading is impossible or unsafe - heavier than the container's configured payload, larger than its volume, or missing a figure. `details` lists each problem with its field and code. |

## Preorder chat

| Code | Meaning |
|---|---|
| `PREORDER_CHAT_CLOSED` | This conversation is closed. Its history stays readable; a new question starts a new conversation from the product page. |
| `PREORDER_CHAT_BLOCKED` | The operator's team has stopped this account sending chat messages. The customer can still reach the business by its published contact details. |
| `PREORDER_CHAT_MESSAGE_TOO_LONG` | The message is longer than this installation accepts. meta.maxChars. |
| `PREORDER_CHAT_MESSAGE_ID_REUSED` | A retry carried a `clientMessageId` this sender already used for a DIFFERENT message or conversation. A genuine retry repeats the same message and is answered with the original instead of this. |
| `PREORDER_CHAT_TRANSITION_NOT_ALLOWED` | The conversation cannot move to that status from where it is, or not by you. meta.from, meta.to. |
| `PREORDER_CHAT_DUPLICATE_CONVERSATION` | Linking would give this customer two open conversations about the same product, option and preorder. meta.conversationId is the other one. |
| `PREORDER_CHAT_ASSIGNEE_NOT_ELIGIBLE` | The staff member named cannot answer preorder chats - deactivated, or without the reply permission. |
| `PREORDER_CHAT_PREORDER_MISMATCH` | The preorder named belongs to a different customer or a different product, so it cannot be linked to this conversation. |
| `PREORDER_CHAT_PROPOSAL_NOT_OPEN` | That proposal is no longer open - replaced by a newer one, withdrawn, declined, already used for a preorder, or past its expiry. |
| `PREORDER_CHAT_ATTACHMENTS_UNAVAILABLE` | Attachments are switched off here, or no malware scanner is configured to look at them. Text messages still work. |

## Support tickets

| Code | Meaning |
|---|---|
| `SUPPORT_TICKET_LIMIT_REACHED` | This person has sent as many support requests today as one account may. Their open requests still take replies. meta.limit, meta.windowHours. |
| `SUPPORT_ORDER_NOT_FOUND` | The order number given is not one this person may see - a typo, or somebody else's order. Deliberately the same answer for both. |
| `SUPPORT_TICKET_CLOSED` | The request is closed. It can be read but nobody can write on it; a new problem is a new request. |
| `SUPPORT_TICKET_TRANSITION_NOT_ALLOWED` | The request cannot move to that status from where it is. meta.from, meta.to. |
| `SUPPORT_ASSIGNEE_NOT_ELIGIBLE` | The staff member named cannot work support requests - deactivated, or without the support permission. |
| `SUPPORT_ATTACHMENTS_UNAVAILABLE` | Files cannot be attached here: switched off, or no malware scanner is configured. The ticket itself still goes. details[0].code is DISABLED or NO_SCANNER. |
| `SUPPORT_ATTACHMENT_LIMIT_REACHED` | This ticket already carries as many files as one ticket may. meta.limit. |
| `SUPPORT_RESOLUTION_CODE_REQUIRED` | Resolving or closing a request needs a resolution code saying how it ended. details[0].field is `resolutionCode`. |

## Disputes, claims and chargebacks

| Code | Meaning |
|---|---|
| `DISPUTE_TRANSITION_NOT_ALLOWED` | The dispute cannot move to that status from where it is - it is closed, already decided, or waiting for somebody else. meta.from, meta.to. |
| `DISPUTE_NOT_ELIGIBLE` | This order (or line) cannot have a claim raised on it: not paid, not yours, or the line is not on the order. details[0].code says which. |
| `DISPUTE_ALREADY_OPEN` | There is already an open claim on this order line. Write on that one. meta.reference. |
| `DISPUTE_WINDOW_CLOSED` | The time allowed for raising a claim on this order has passed. meta.windowDays. |
| `DISPUTE_SELF_APPROVAL_FORBIDDEN` | A decision must be approved by a different member of staff from the one who proposed it. |
| `DISPUTE_APPEAL_NOT_ALLOWED` | This decision cannot be appealed: the window has passed, or it has been appealed once already. details[0].code is WINDOW_CLOSED or ALREADY_APPEALED. |
| `DISPUTE_CHARGEBACK_OPEN` | The payment on this order is under a chargeback. Refunding it as well could pay the buyer twice; the chargeback decides the money. |
| `DISPUTE_AMOUNT_INVALID` | The amount is not valid for this dispute - not whole minor units, zero, or more than was paid. meta.maxMinor. |
| `DISPUTE_SETTINGS_CONFLICT` | Somebody saved the dispute settings a moment ago. Reload and try again. |

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

## Seller commission invoices

| Code | Meaning |
|---|---|
| `COMMISSION_INVOICE_NOT_ELIGIBLE` | This seller order cannot have a commission invoice yet. `details` names each reason by code: the buyer's payment is not captured, the order or the seller's part of it is cancelled, the commission is zero, or the order has not reached the stage the settings require. |
| `COMMISSION_INVOICE_VALIDATION_FAILED` | The invoice cannot be issued until the listed details are fixed. `details` lists each one as `{ field, code, message }` - a missing seller GSTIN, an unverified tax rule, an unset issuer address. |
| `COMMISSION_INVOICE_IMMUTABLE` | An issued commission invoice never changes. Correct it with a credit note. |
| `COMMISSION_INVOICE_INVALID_TRANSITION` | The invoice's status does not allow that action. meta.status, meta.move. |
| `COMMISSION_INVOICE_VOID_NOT_PERMITTED` | Voiding an issued commission invoice is switched off in the invoice settings. The correction is a credit note. |
| `COMMISSION_INVOICE_SETTINGS_INVALID` | The commission invoice settings were refused. `details` names each field. |
| `COMMISSION_CREDIT_INVALID` | The credit note was refused: nothing left to credit, an amount above what remains, or a proportional credit on an order with no refund. |
| `COMMISSION_INVOICE_SETTINGS_CONFLICT` | The settings were changed by someone else since they were loaded. meta.currentVersion. |

## Terms and Conditions

| Code | Meaning |
|---|---|
| `TERMS_ACCEPTANCE_REQUIRED` | The account cannot be created or activated until the Terms and Conditions in force have been read and agreed to. Sent when `acceptedTerms` is not true or no `termsDocumentId` came with it. |
| `TERMS_VERSION_OUTDATED` | The Terms agreed to are not the version in force: a newer version was published, or the document named was never a published one. meta.currentVersion. Show the current Terms and ask again. |
| `TERMS_DOCUMENT_UNAVAILABLE` | No Terms and Conditions are published for this kind of account, so no account can be created or activated. The operator must publish them in the admin console. 503. |
| `LEGAL_DOCUMENT_IMMUTABLE` | A published legal document never changes. Publish a new version instead. |
| `LEGAL_DOCUMENT_VERSION_EXISTS` | A document with this kind, version and language already exists. |

## Quantity price bands

| Code | Meaning |
|---|---|
| `QUANTITY_TIERS_INVALID` | The seller's quantity bands contradict themselves or the list price. The details name each band by index and what is wrong (`domain/quantity-tier.ts`). |
| `STORE_QUANTITY_DISCOUNTS_INVALID` | The store-wide quantity discounts contradict themselves: a start below two pieces, a discount outside 0.01%-90%, a repeated start, or a larger quantity taking off less. The details name each rule by index and what is wrong. |

## Buyer companies

| Code | Meaning |
|---|---|
| `BUYER_COMPANIES_DISABLED` | The buyer-companies feature is switched off on this deployment (FEATURE_BUYER_COMPANIES=false). |
| `BUYER_CONTEXT_INVALID` | The session asked to act for a company it has no active membership in - removed, suspended, or never a member. The storefront drops back to the individual context and asks again. Never names the company. |
| `BUYER_COMPANY_NOT_APPROVED` | The company exists and the caller belongs to it, but it is not approved (or no longer is), so nothing may be bought in its name yet. `details[0] .meta.status` carries the company status so the storefront can say why and link to the verification page instead of showing a generic refusal. |
| `BUYER_COMPANY_ROLE_FORBIDDEN` | The caller's role inside the company does not allow this - a VIEWER trying to check out, a BUYER trying to edit the application. |
| `BUYER_COMPANY_TRANSITION_NOT_ALLOWED` | That status change is not one `domain/buyer-company-state.ts` allows, for that actor, from the status the company is in now. `details[0].code` is SAME_STATUS, TRANSITION_UNDEFINED, ACTOR_NOT_PERMITTED or REASON_REQUIRED. |
| `BUYER_COMPANY_NOT_EDITABLE` | The application cannot be edited in its current status - it is with a reviewer, approved or closed. |
| `BUYER_COMPANY_INCOMPLETE` | Submission refused: something required is missing or malformed. One detail per problem, each with the `field` it belongs to. |
| `BUYER_COMPANY_VERSION_CONFLICT` | Somebody else changed this application since it was loaded. Reload and decide again. Returned to the second of two reviewers acting at once. |
| `BUYER_COMPANY_ALREADY_CLAIMED` | An approval would give a registration number or tax identifier to a second approved company. Resolve the duplicate first. |
| `BUYER_COMPANY_EMAIL_CODE_INVALID` | The business email code was wrong, expired or used up. |
| `BUYER_COMPANY_SECOND_REVIEW_REQUIRED` | The approval needs a second reviewer, and the caller gave the first one. |
| `BUYER_COMPANY_DOCUMENT_REJECTED` | The uploaded file is not one we accept for company documents - wrong type by its own bytes, too large, too many pages, or not readable. |
| `BUYER_COMPANY_LIMIT_REACHED` | The person already has as many company applications in progress as a deployment allows. |
| `BUYER_COMPANY_INVITATION_EXISTS` | That address already has an invitation to this company that can still be accepted. Resend it rather than sending a second one. |
| `BUYER_COMPANY_INVITATION_INVALID` | The invitation cannot be used: unknown, expired, revoked, already used, or addressed to another email. One answer for all five, on purpose. |
| `BUYER_COMPANY_ALREADY_MEMBER` | That person is already an active member of the company. |
| `BUYER_COMPANY_MEMBER_PROTECTED` | That member cannot be changed by the caller: the owner, the caller themselves, or an administrator when the caller is not the owner. `details[0].code` is OWNER, SELF or ADMIN_NEEDS_OWNER. |
| `BUYER_CONTEXT_UNSUPPORTED` | This feature works for the person's own account only, not while buying for a company - recurring orders are the one today. The storefront offers to switch to the individual context. |

## Product reviews

| Code | Meaning |
|---|---|
| `REVIEW_NOT_ELIGIBLE` | Only a buyer with a delivered order containing the product may review it. The storefront hides the form in that case, so this is what a stale page or a direct call sees. |
| `REVIEW_SELF_DEALING` | The reviewer is a member of the seller whose goods the qualifying order line was. A seller cannot rate its own sale, whoever placed the order. 403. Also raises a REVIEW_SELF_DEALING risk signal for staff. |
| `REVIEW_RATE_LIMITED` | This buyer has written REVIEW_MAX_PER_DAY reviews in the last 24 hours. 429. Editing a review already written is not counted. |

## Message centre (JOURNEY-055)

| Code | Meaning |
|---|---|
| `MESSAGE_TRANSLATION_UNAVAILABLE` | "Translate" was pressed but message translation is switched off (FEATURE_MESSAGE_TRANSLATION) or no translation key is stored. 409. |
| `MESSAGE_REPORT_OWN_MESSAGE` | A person tried to report a message they wrote themselves. 409. |

## Notification centre (JOURNEY-056)

| Code | Meaning |
|---|---|
| `NOTIFICATION_PREFERENCE_MANDATORY` | A security, order, payment or data-rights notification cannot be switched off. 400. `details[].field` names the family. |

## B2C maximum order quantity

| Code | Meaning |
|---|---|
| `B2C_MAX_ORDER_QUANTITY_EXCEEDED` | A buyer who is not an approved company asked for more of one product than its seller allows an individual to buy in one order - every variant and every basket line of it counted together. 409. `details[0].meta` carries `productId`, `allowedQuantity`, `requestedQuantity`, `currentCartQuantity` and `requiresApprovedCompanyAccount`, so the storefront can offer "Reduce to N" or switching to a company. Also a basket line issue while an existing basket is over. See `domain/b2c-order-limit.ts`. Not… |

## Pre-shipment inspection and the dispatch gate

| Code | Meaning |
|---|---|
| `INSPECTION_GATE_CLOSED` | The order must be inspected before it leaves and the gate is shut. 409. `details[0].code` says why: NOT_BOOKED, IN_PROGRESS, FAILED, BLOCKING_NCR_OPEN, RELEASE_PENDING_APPROVAL, SCOPE_CHANGED or BUYER_REVIEW_PERIOD; `meta.requirementId` names the inspection. See `domain/inspection-gate.ts`. |
| `INSPECTION_GATE_NOT_EVALUATED` | A guarded move reached a state machine without the gate being checked. A programming error on the server, refused rather than let through. 409. |
| `INSPECTION_JOB_TRANSITION_NOT_ALLOWED` | That inspection job cannot move that way, for that role. `details[0] .code` is SAME_STATUS, TRANSITION_UNDEFINED, ACTOR_NOT_PERMITTED or REASON_REQUIRED. |
| `INSPECTION_AGENCY_MEMBER_REQUIRED` | The signed-in account is not an active member of an inspection agency, or its role does not carry this action. 403. |
| `INSPECTION_AGENCY_NOT_ELIGIBLE` | The agency cannot take this job: suspended, not serving the category or country, affiliated with the seller, or full on that day. `details[0] .code` says which. |
| `INSPECTION_CONFLICT_OF_INTEREST` | The person or agency has a conflict of interest with this order - a member of the seller, the buyer, or a declared conflict. 409. |
| `INSPECTOR_NOT_QUALIFIED` | The inspector is not authorised for this category, has no verified identity, or their credentials have expired. `details[0].code` says which. |
| `INSPECTION_REPORT_INCOMPLETE` | The report cannot be submitted or signed yet. `details` lists each missing item: an unanswered checklist line, the sampling record, evidence. |
| `INSPECTION_REPORT_LOCKED` | A signed report, and its evidence, never change. 409. |
| `INSPECTION_SELF_APPROVAL_FORBIDDEN` | The person who requested a conditional release cannot also approve it. 409. |
| `INSPECTION_RELEASE_NOT_ALLOWED` | A conditional release cannot be recorded: the rule does not allow one, the reason is too short, evidence is missing, or one is already pending. `details[0].code` says which. |
| `INSPECTION_CAPA_REQUIRED` | A re-inspection needs corrective action recorded on every open non-conformance first. `details` names each NCR still open. |
| `INSPECTION_RECLASSIFICATION_NOT_ALLOWED` | A defect's severity can be changed only by the agency's QA reviewer, who is not the inspector who recorded it, with a reason and evidence. |
| `INSPECTION_BINDING_MISMATCH` | The container or seal recorded at loading does not match the packages on the consignment. 409. |
| `INSPECTION_READINESS_INCOMPLETE` | The seller cannot present the lot yet. `details` lists each missing item, such as PACKING_LIST_MISSING or DECLARATION_REQUIRED. |
| `INSPECTION_POLICY_INVALID` | An inspection rule, plan or policy contradicts itself. `details` names each field. |
| `INSPECTION_BOOKING_NOT_ALLOWED` | An inspection cannot be booked for this order now: none is required and the buyer did not ask, one is already open, or the order is past dispatch. |

## Returns

| Code | Meaning |
|---|---|
| `RETURN_NOT_ELIGIBLE` | This order cannot be returned from the storefront. 409. `details[0].code` says why: NOT_DELIVERED, WINDOW_CLOSED (meta.windowDays, meta.closedAt), RETURNS_OFF (the operator's window is 0), MIXED_SELLERS (the lines chosen belong to more than one seller - send one return per seller) or REASON_NOT_OFFERED. |
| `RETURN_QUANTITY_EXCEEDED` | More of a line was asked for than is left to return. 409. One detail per line: `field` is `items.N.quantity`, meta.returnable is how many may still go back. |
| `RETURN_EVIDENCE_REQUIRED` | The reason chosen needs at least one photograph or video of the problem, and none was attached. 400. |
| `RETURN_TRANSITION_NOT_ALLOWED` | The return cannot move that way from where it is, or the move needs a reason that was not given. 409. meta.from, meta.to. |
| `RETURN_FILES_UNAVAILABLE` | Files cannot be added to returns here: no malware scanner is configured and unscanned files are not accepted. 409. The return itself still works. |

## The buyer experience: cart, checkout, account, alerts, reviews

| Code | Meaning |
|---|---|
| `SAVED_ITEM_NOT_FOUND` | That saved-for-later line is not one of this buyer's. 404. |
| `BUYER_COMMERCE_SETTINGS_INVALID` | The operator's buyer settings or a duty rate contradict themselves. `details` names each field. 400. |
| `BUYER_COMMERCE_SETTINGS_CONFLICT` | Somebody else saved the buyer settings since they were loaded. Reload. 409. |
| `KYC_NOT_EDITABLE` | The identity details cannot be changed while they are being reviewed or once verified - ask support to reopen them. 409. |
| `KYC_INCOMPLETE` | The identity details are not complete enough to submit. `details` lists each missing field. 400. |
| `KYC_DOCUMENT_REJECTED` | The uploaded identity or import document is not accepted: wrong type by its own bytes, too large, empty, or it failed the malware scan. 400. |
| `SAVED_SEARCH_LIMIT_REACHED` | The buyer already has as many saved searches as the installation allows. 409. |
| `REORDER_NOTHING_AVAILABLE` | Nothing on that past order can be bought today. `details` lists each line and why (UNPUBLISHED, OUT_OF_STOCK, OFFER_WITHDRAWN). 409. |
| `REORDER_PREVIEW_STALE` | The reorder changed since the buyer reviewed it - a price or stock moved. `details[0].meta.previewToken` is the new preview to review. 409. |
| `NOTIFICATION_PREFERENCE_LOCKED` | Security and account notices cannot be switched off. 400. |
| `REVIEW_RESPONSE_NOT_ALLOWED` | Only the seller whose goods were reviewed may answer a review, once, and only a published one. 409 (403 for somebody else's review). |
| `TRANSLATION_UNAVAILABLE` | No translation provider is configured, or it failed. The original text is still shown. 503. |
| `CUSTOMER_ERP_PURCHASE_ORDER_REJECTED` | An inbound ERP purchase order could not become an order. `details` names each problem: a missing field, an unknown product code (UNKNOWN_PRODUCT), or a line that cannot be bought. 422. |
| `PRODUCTION_MILESTONE_NOT_ALLOWED` | A production milestone or delay cannot be recorded: the order is not accepted (NOT_ACCEPTED), has left (CLOSED), the stage is already done (ALREADY_COMPLETED) or an earlier one is open (OUT_OF_ORDER). 409. |
| `LISTING_BLOCKED` | The marketplace has blocked this listing. Only staff can lift it; the seller cannot resume, edit it live or archive it. 409. |
| `OFFER_NOT_AVAILABLE_IN_MARKET` | The seller does not sell this listing to the delivery country. `details[0].meta.country` is the country. 409. |
| `BULK_IMPORT_FILE_INVALID` | A bulk-import file cannot be read: empty, not CSV/XLSX by its bytes, too large, too many rows, or missing a required column. 400. |
| `BULK_IMPORT_NOT_APPLICABLE` | A bulk import cannot be applied: it is not a finished dry run, it has row errors, or it was already applied. 409. |
| `TRADE_DOCUMENT_INVALID` | A trade document is incomplete or not acceptable here - unknown kind, missing issuer, expiry before issue, no file and no reference. 400. |
| `DESTINATION_DOCUMENTS_NOT_READY` | The consignment is on an exception hold: a document the destination or category requires is missing or not valid, the HS code is unverified or rejected, or the goods are prohibited there. `details` lists each hold with its code and the party who must act. 409. |
| `BOOKING_TERMS_REQUIRED` | A cross-border consignment must state its Incoterm, mode and ports before it can be booked. 409. |
| `BOOKING_TERMS_INVALID` | Booking terms are not acceptable: unknown Incoterm, a port that is not a UN/LOCODE, an insured value above what the settings allow. 400. |
| `SHIPMENT_INSURANCE_NOT_OFFERED` | Cargo insurance is not offered on this installation. 409. |
| `LOGISTICS_LANE_INVALID` | A lane rate card is not acceptable: overlapping weight bands, transit days out of order, validity ending before it starts. 400. |
| `CUSTOMER_KYC_NOT_EDITABLE` | An individual buyer's identity details cannot be changed now: they are with a reviewer or already verified. 409. (Master row 11) |
| `CUSTOMER_KYC_INCOMPLETE` | An identity check cannot be sent yet: a required detail or the identity document is missing. `details` names what. 400. |
| `CUSTOMER_KYC_TRANSITION_INVALID` | The identity check cannot move that way from where it is. 409. |

## Requests for quotation (Master rows 16-19)

| Code | Meaning |
|---|---|
| `RFQ_TRANSITION_NOT_ALLOWED` | The request cannot move that way from where it is - or it changed while the screen was open (`details[0].code` STALE). 409. |
| `RFQ_NOT_EDITABLE` | Only a draft can be edited in place or deleted. A submitted request changes through a new requirement version. 409. |
| `RFQ_INCOMPLETE` | The request cannot be submitted yet. `details` names every field that is missing or wrong (`REQUIRED`, `IN_PAST`, `TOO_FAR`, `DESTINATION_NEEDED`, `BEFORE_DEADLINE`, `UNKNOWN`). 400. |
| `RFQ_DESTINATION_BLOCKED` | The marketplace does not sell this category into the destination country (a market rule blocks it), so no seller may be asked to. 409. |
| `RFQ_SUPPLIER_NOT_ELIGIBLE` | That seller cannot be invited: not approved to trade, the buyer's own business, or unknown. 409. |
| `RFQ_INVITATION_LIMIT_REACHED` | The request is already sent to as many sellers as this marketplace allows (RFQ_MAX_INVITED_SUPPLIERS). 409. |
| `RFQ_ATTACHMENTS_UNAVAILABLE` | Files cannot be attached on this installation: no malware scanner and unscanned files not accepted. 409. |
| `RFQ_ATTACHMENT_LIMIT_REACHED` | The request already carries as many files as it may (RFQ_ATTACHMENTS_PER_RFQ). 409. |
| `RFQ_RESPONSE_CLOSED` | The seller can no longer answer this request: they declined or withdrew, the deadline passed, or the request closed. `details[0].code` says which. 409. |
| `RFQ_NO_CHANGE` | A new requirement version was asked for with nothing different from the current one. 409. |
| `RFQ_QUOTE_EXISTS` | This seller has already quoted on the request. A changed price is a counter-offer on that quote, never a second quote. 409. |
| `RFQ_QUOTE_INVALID` | Some terms of an offer are not valid - an unknown currency, an expiry already past, tiers that do not climb, a file that cannot be sent. `details` names each. 400. |
| `RFQ_OFFER_NOT_OPEN` | That quote or offer version cannot be answered: it is no longer the one on the table, it is your own, or the quote is no longer open. `details[0].code` says which. 409. |
| `RFQ_OFFER_EXPIRED` | The offer's validity passed. It can be countered, never accepted. 409. |
| `RFQ_ALREADY_AWARDED` | Another quote on this request was accepted first. 409. |
| `RFQ_SAMPLE_TRANSITION_NOT_ALLOWED` | A sample request cannot move that way from where it is, by that side - or it changed while the screen was open (`STALE`). 409. (Master row 20) |
| `RFQ_PURCHASE_ORDER_INVALID` | A purchase order cannot be raised because accepted terms are missing, changed, or the buyer did not e-accept the exact contract shown. 409. |
| `RFQ_PURCHASE_ORDER_APPROVAL_INVALID` | A purchase-order approval is stale, out of sequence, or would let its requestor approve their own order. 409. (Master row 21) |
| `RFQ_PURCHASE_ORDER_NOT_CONVERTIBLE` | An RFQ purchase order cannot become an order: it is not approved (`NOT_APPROVED`), its quantity is not a whole number of units (`FRACTIONAL_QUANTITY`) or is too large (`QUANTITY_TOO_LARGE`), the supplier can no longer trade (`SELLER_UNAVAILABLE`), tax for the destination cannot be worked out (`TAX_UNAVAILABLE`), or the sealed contract and its totals disagree (`CONTRACT_MISMATCH`). `details[0].code` says which. 409. (LIVE-004) |
| `FACTORY_NOT_EDITABLE` | A factory cannot be changed now: it is with a reviewer. 409. (Master row 13) |
| `FACTORY_INCOMPLETE` | A factory cannot be sent for review, or verified, yet: it has no evidence attached. `details` names what is missing. 400 for the seller, 409 for a reviewer. |
| `FACTORY_TRANSITION_INVALID` | The factory's verification cannot move that way from where it is - including a reviewer deciding a check a colleague already decided (`details[0].code` is `STALE`). 409. |
| `CERTIFICATION_NOT_EDITABLE` | A certificate cannot be changed now: it is with a reviewer. 409. |
| `CERTIFICATION_TRANSITION_INVALID` | The certificate's verification cannot move that way from where it is, including a stale reviewer screen (`STALE`). 409. |
| `TRUST_EVIDENCE_UNUSABLE` | That document cannot be used as evidence: it was replaced, withdrawn or failed its security scan. 409. |
| `TRUST_EVIDENCE_IN_USE` | That document is evidence for a factory or a certificate and cannot be withdrawn until it is detached. 409. |

## Country rules, rate cards and storefront content (Master rows 69, 71, 72)

| Code | Meaning |
|---|---|
| `MARKET_DESTINATION_RESTRICTED` | Something in the basket may not be sent to the delivery country: a country rule blocks its product or category (possibly only above an order value). `details` has one entry per line, `meta.productId` and `meta.reason`. 409. |
| `MARKET_RULE_INVALID` | A country rule is not acceptable: no product or category for its scope, a threshold without a currency, an end before its start. 400. |
| `CONTENT_BLOCK_INVALID` | A banner or content block is not acceptable: a category block with no category, an unknown coupon, a link that is not https or root-relative, an end before its start. 400. |

## Held funds, the transaction ledger and seller payouts (Master rows 58-61, 43)

| Code | Meaning |
|---|---|
| `ESCROW_LEDGER_DISABLED` | Held funds and the ledger are switched off on this deployment (FEATURE_ESCROW_LEDGER). 409. |
| `FUND_HOLD_STATE_CONFLICT` | The held funds are not in a state that allows this: placing a hold on money already released, lifting a hold that is not placed. 409. |
| `FUND_RELEASE_ALREADY_PENDING` | An early release is already waiting for a decision on these funds. 409. |
| `FUND_RELEASE_SAME_APPROVER` | The person who asked for an early release cannot also approve it. 403. |

## Admin governance: maker-checker, moderation, CMS approval (JOURNEY-061, 062, 067)

| Code | Meaning |
|---|---|
| `PENDING_ACTION_ALREADY_OPEN` | A request for this action on this record is already waiting for a second member of staff. `details[0].meta.pendingActionId` names it. 409. |
| `PENDING_ACTION_SAME_APPROVER` | The member of staff who asked for a critical action cannot also approve it; a different person must. 403. |
| `PENDING_ACTION_NOT_OPEN` | The request was already approved, rejected or cancelled. 409. |
| `LISTING_APPEAL_SAME_MODERATOR` | The moderator who refused a listing cannot also decide its appeal. 403. |
| `LISTING_PROHIBITED_TERM_EXISTS` | That prohibited term is already on the list. 409. |
| `CONTENT_BLOCK_NOT_PENDING` | A content block cannot move that way: approving one that is not waiting for approval, or submitting one already waiting or published. 409. |
| `CONTENT_BLOCK_SAME_APPROVER` | The member of staff who submitted a content block cannot also approve it. 403. |
| `CONTENT_BLOCK_CONFLICT` | The block cannot be published as it is: its coupon ends before the block starts, or another check in `details` refuses it. Each entry has `code` (for example COUPON_ENDS_BEFORE_START). 409. |

## Change control for a seller's verified company details (JOURNEY-027)

| Code | Meaning |
|---|---|
| `COMPANY_CHANGE_NOT_ALLOWED` | The seller application is still editable, so company details are changed in the application itself, not through a change request. 409. |
| `COMPANY_CHANGE_EMPTY` | The change request proposes nothing different from what is on file. 400. |
| `COMPANY_CHANGE_NOT_PENDING` | The change request is no longer waiting: it was decided or withdrawn, possibly by a colleague while the screen was open. 409. |

## Audit Console

| Code | Meaning |
|---|---|
| `AUDIT_MEMBER_REQUIRED` | The signed-in AUDIT account has no active audit-staff or agency membership, or its role does not carry this action. 403. |
| `AUDIT_MFA_SETUP_REQUIRED` | The Audit Console session must set up two-step sign-in first. 403. |
| `AUDIT_MFA_CHALLENGE_REQUIRED` | The Audit Console session must pass its two-step challenge first. 403. |
| `COMPLIANCE_RULE_TRANSITION_NOT_ALLOWED` | A compliance rule cannot move that way: wrong status, or the person who drafted it tried to approve it. `details[0].code` says which. 409. |
| `COMPLIANCE_CASE_NOT_READY` | A qualification or product case cannot move that way, or cannot be approved yet: a requirement is unsatisfied or its applicability is still unresolved. `details` lists each blocking requirement. 409. |
| `COMPLIANCE_DOCUMENT_TRANSITION_NOT_ALLOWED` | A compliance document cannot move that way. 409. |
| `COMPLIANCE_QUALIFICATION_REQUIRED` | The seller is not qualified for this category (in this supply role and market) under an approved rule, and the deployment enforces it. 409. |
| `INSPECTION_QUANTITY_INVALID` | A quantity is not a valid exact decimal for its unit, or the counts do not reconcile (tested more than sampled, conforming plus nonconforming more than tested). `details` names the field. 400. |
| `INSPECTION_SUBLOT_NOT_ALLOWED` | A sub-lot release cannot be requested, approved or used: the code is taken, the quantities exceed the lot, it was already used, or the requester tried to approve it. `details[0].code` says which. 409. |
| `INSPECTION_CORRECTION_NOT_ALLOWED` | A report correction is not allowed: the report is not signed, is already superseded, or the corrector is the inspector. 409. |

