/**
 * Audit trail.
 *
 * Every privileged, catalog-publication, inventory, order, payment, refund,
 * connector and schedule change writes a row here. Two rules make the trail
 * worth having:
 *
 *   1. It is written INSIDE the caller's transaction. An action that rolls back
 *      leaves no audit row claiming it happened, and an action that commits can
 *      never lack one.
 *   2. Values are redacted before they are written. The trail must record that
 *      a gateway credential changed, never what it changed to.
 */
import { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { currentRequestContext } from '../../infra/request-context.js';

export const AuditAction = {
  // Identity
  USER_LOGIN: 'user.login',
  USER_LOGIN_FAILED: 'user.login_failed',
  USER_LOGOUT: 'user.logout',
  USER_PASSWORD_RESET_REQUESTED: 'user.password_reset_requested',
  USER_PASSWORD_CHANGED: 'user.password_changed',
  USER_SESSIONS_REVOKED: 'user.sessions_revoked',
  USER_MFA_ENABLED: 'user.mfa_enabled',
  USER_MFA_RECOVERY_USED: 'user.mfa_recovery_used',
  /// Two-step sign-in switched off by its holder, after a fresh step-up.
  USER_MFA_DISABLED: 'user.mfa_disabled',
  /// A fresh set of recovery codes replaced the old one.
  USER_MFA_RECOVERY_REGENERATED: 'user.mfa_recovery_regenerated',
  /// Too many wrong codes in a row: the account was locked and signed out.
  USER_MFA_LOCKED: 'user.mfa_locked',
  /// The person confirmed it was them again before a sensitive act.
  USER_STEP_UP: 'user.step_up',
  /// A sign-in from a device or network not seen recently; an alert was sent.
  USER_NEW_DEVICE_SIGN_IN: 'user.new_device_sign_in',
  /// Where an admin session said it was opened from. Recorded separately from
  /// `user.login` because it arrives on a later request - the position is only
  /// asked for once the password has been accepted.
  USER_SESSION_LOCATION: 'user.session_location',
  /// Presenting a refresh token that was already rotated away. Either a stolen
  /// token or a broken client, and both are worth an alert.
  USER_REFRESH_REUSE_DETECTED: 'user.refresh_reuse_detected',
  ROLE_ASSIGNED: 'role.assigned',
  ROLE_REVOKED: 'role.revoked',

  // Customers
  CUSTOMER_CREATED: 'customer.created',
  CUSTOMER_UPDATED: 'customer.updated',
  CUSTOMER_INVITED: 'customer.invited',
  CUSTOMER_ACTIVATED: 'customer.activated',
  /// Somebody created their own account from the storefront. Kept apart from
  /// `customer.created`, which is a member of staff opening one for them - the
  /// two answer different questions when the trail is read back.
  CUSTOMER_REGISTERED: 'customer.registered',
  CUSTOMER_EMAIL_VERIFIED: 'customer.email_verified',
  /// A member of staff let a self-registered account in.
  CUSTOMER_APPROVED: 'customer.approved',
  CUSTOMER_STATUS_CHANGED: 'customer.status_changed',
  CUSTOMER_LIMITS_CHANGED: 'customer.limits_changed',

  // Catalog
  CATEGORY_CREATED: 'category.created',
  CATEGORY_UPDATED: 'category.updated',
  CATEGORY_ARCHIVED: 'category.archived',
  PRODUCT_CREATED: 'product.created',
  PRODUCT_UPDATED: 'product.updated',
  PRODUCT_PUBLISHED: 'product.published',
  PRODUCT_UNPUBLISHED: 'product.unpublished',
  PRODUCT_PRICE_CHANGED: 'product.price_changed',
  PRODUCT_PRICES_BULK_SET: 'product.prices_bulk_set',
  PRODUCT_ARCHIVED: 'product.archived',

  // Coupons
  COUPON_CREATED: 'coupon.created',
  COUPON_UPDATED: 'coupon.updated',
  COUPON_ARCHIVED: 'coupon.archived',
  /// The store-wide quantity discounts were replaced as a set.
  STORE_QUANTITY_DISCOUNTS_SAVED: 'store_quantity_discounts.saved',

  // Inventory
  INVENTORY_RECEIVED: 'inventory.received',
  INVENTORY_ADJUSTED: 'inventory.adjusted',
  /// A warehouse was opened, or its details changed. Separate from the two
  /// above because it is master data, not stock: the trail has to be able to
  /// answer "when did this place move, and who moved it" without that
  /// question being buried under every receipt booked against it.
  INVENTORY_LOCATION_CREATED: 'inventory_location.created',
  INVENTORY_LOCATION_UPDATED: 'inventory_location.updated',
  /// A warehouse row was deleted outright. Only possible while nothing had
  /// ever been booked against it, which is exactly why this entry matters: it
  /// is the only remaining trace that the place existed, so it carries the
  /// whole record in `before` rather than an id somebody can no longer look
  /// up.
  INVENTORY_LOCATION_DELETED: 'inventory_location.deleted',
  /// A connector reported where a warehouse stands with the ERP. Its own
  /// action rather than an `updated`, because these rows are written by
  /// machinery on a schedule and would otherwise bury the handful of entries
  /// where a person actually changed something about the place.
  INVENTORY_LOCATION_ERP_SYNCED: 'inventory_location.erp_synced',

  // Orders
  ORDER_CREATED: 'order.created',
  ORDER_STATUS_CHANGED: 'order.status_changed',
  ORDER_APPROVED: 'order.approved',
  ORDER_REJECTED: 'order.rejected',
  ORDER_CANCELLED: 'order.cancelled',

  // Payments
  PAYMENT_CREATED: 'payment.created',
  PAYMENT_CAPTURED: 'payment.captured',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_LINK_CREATED: 'payment_link.created',
  PAYMENT_LINK_REVOKED: 'payment_link.revoked',
  PAYMENT_GATEWAY_CONFIGURED: 'payment_gateway.configured',
  PAYMENT_GATEWAY_ACTIVATED: 'payment_gateway.activated',
  WEBHOOK_REJECTED: 'webhook.rejected',
  /// A Stripe Checkout attempt closed without money moving: the customer
  /// cancelled, the session expired, or it could not be opened.
  PAYMENT_CHECKOUT_CLOSED: 'payment.checkout_closed',
  /// A chargeback was opened against a captured payment.
  PAYMENT_DISPUTED: 'payment.disputed',
  REFUND_CREATED: 'refund.created',
  REFUND_COMPLETED: 'refund.completed',

  // Stored payment instruments
  //
  // Auditing enrolment and removal, never the references themselves. An audit
  // log is read by more people than the payment-method table is, and a
  // chargeable token does not belong in one.
  PAYMENT_METHOD_SETUP_STARTED: 'payment_method.setup_started',
  PAYMENT_METHOD_SAVED: 'payment_method.saved',
  PAYMENT_METHOD_UPDATED: 'payment_method.updated',
  PAYMENT_METHOD_REMOVED: 'payment_method.removed',
  /// An off-session charge against a stored instrument. Recorded separately
  /// from PAYMENT_CREATED because nobody was present to authorise it, which is
  /// the first thing anyone investigating a disputed charge needs to know.
  PAYMENT_OFF_SESSION_CHARGED: 'payment.off_session_charged',
  PAYMENT_ACTION_REQUIRED: 'payment.action_required',

  // Recurring
  SCHEDULE_CREATED: 'schedule.created',
  SCHEDULE_UPDATED: 'schedule.updated',
  SCHEDULE_PAUSED: 'schedule.paused',
  SCHEDULE_RESUMED: 'schedule.resumed',
  SCHEDULE_CANCELLED: 'schedule.cancelled',
  /// A draft became a live authority to charge. The moment consent took
  /// effect, and the one a dispute is measured from.
  SCHEDULE_ACTIVATED: 'schedule.activated',
  SCHEDULE_COMPLETED: 'schedule.completed',
  /// A finished plan cleared off the customer's own list.
  ///
  /// Recorded, and not because hiding a row is a dangerous act - it is the
  /// least dangerous act in this module. It is recorded because the row stops
  /// appearing in the customer's reads at that moment, and somebody asking
  /// later why a plan they remember is not on their screen deserves an answer
  /// better than "it must have been you".
  SCHEDULE_HIDDEN: 'schedule.hidden',
  /// One cycle, and what became of it.
  OCCURRENCE_SKIPPED: 'occurrence.skipped',
  OCCURRENCE_CANCELLED: 'occurrence.cancelled',
  OCCURRENCE_HELD: 'occurrence.held',
  OCCURRENCE_PRICE_CONFIRMED: 'occurrence.price_confirmed',
  OCCURRENCE_PRICE_DECLINED: 'occurrence.price_declined',
  BUYER_COMPANY_APPROVAL_POLICY_UPDATED: 'buyer_company.approval_policy_updated',
  BUYER_COMPANY_ORDER_APPROVED: 'buyer_company.order_approved',
  BUYER_COMPANY_ORDER_REJECTED: 'buyer_company.order_rejected',
  OCCURRENCE_COMPLETED: 'occurrence.completed',

  // ERP hand-off
  //
  // ERP_ORDER_PUSH_DEFERRED is the audit trail for the state where money has
  // moved and the ERP has not taken the order. It is recorded every time, not
  // only on the final failure, because the sequence of attempts is what
  // reconstructs the incident afterwards.
  ERP_ORDER_PUSHED: 'erp_order.pushed',
  ERP_ORDER_PUSH_DEFERRED: 'erp_order.push_deferred',
  ERP_ORDER_PUSH_ABANDONED: 'erp_order.push_abandoned',

  // Product safety
  //
  // An economic operator is a legal identity printed on a public listing and
  // written to by a market surveillance authority. Who changed one, and when,
  // is the kind of thing that gets asked after a recall.
  ECONOMIC_OPERATOR_CREATED: 'economic_operator.created',
  ECONOMIC_OPERATOR_UPDATED: 'economic_operator.updated',
  ECONOMIC_OPERATOR_ARCHIVED: 'economic_operator.archived',
  /// A product's medical-device record. On the trail because a class or a
  /// notified body number changing is the kind of edit somebody asks about
  /// after a recall.
  DEVICE_INFO_UPDATED: 'device_info.updated',

  // Invoicing
  //
  // An invoice sequence with an unexplained gap is a problem at a VAT audit,
  // so both the issue and the credit note that reverses one are on the record.
  INVOICE_ISSUED: 'invoice.issued',
  INVOICE_CREDITED: 'invoice.credited',
  /// A VAT number was checked against VIES. Recorded because the answer is
  /// what justifies zero-rating a supply, and "we checked" needs to be a fact
  /// somebody can point at rather than a claim.
  VAT_NUMBER_CHECKED: 'vat_number.checked',
  VAT_RATE_UPDATED: 'vat_rate.updated',

  // Configuration
  SETTINGS_UPDATED: 'settings.updated',
  FEATURE_FLAG_CHANGED: 'feature_flag.changed',
  CONNECTOR_CREATED: 'connector.created',
  CONNECTOR_UPDATED: 'connector.updated',
  DATA_EXPORTED: 'data.exported',
  /// A member of staff downloaded a copy of the audit trail itself. `after`
  /// carries the filter, how many entries the file held and whether the row
  /// cap cut it short - so "who took a copy of the evidence, and of what" is
  /// answered from the trail like every other privileged act.
  AUDIT_EXPORTED: 'audit.exported',

  // The ERP connection under Settings -> ERP
  //
  // Written with actorType ADMIN and the staff user's own id: this is a change
  // to how the installation runs, and it belongs on the staff trail beside the
  // tax classes and the payment gateways. The trail matters here for a specific
  // reason: these rows record somebody pointing this server at an outbound
  // address and giving it a credential, and "who set that up, and when" is the
  // first question asked if the address turns out to be wrong.
  ERP_CONNECTION_CREATED: 'erp_connection.created',
  ERP_CONNECTION_UPDATED: 'erp_connection.updated',
  /// Credentials replaced. Its own action rather than an `updated`, because a
  /// rotated secret is the change most worth being able to find. The secret
  /// itself never reaches the row - see REDACTED_FIELDS.
  ERP_CREDENTIALS_ROTATED: 'erp_connection.credentials_rotated',
  ERP_CONNECTION_TESTED: 'erp_connection.tested',
  /// The moment a connection started carrying real orders.
  ERP_CONNECTION_ACTIVATED: 'erp_connection.activated',
  ERP_CONNECTION_PAUSED: 'erp_connection.paused',
  ERP_CONNECTION_RESUMED: 'erp_connection.resumed',
  /// Taken out of service by the machinery after repeated failures. Written by
  /// SYSTEM, and the only status change in this group that nobody chose.
  ERP_CONNECTION_SUSPENDED: 'erp_connection.suspended',
  ERP_CONNECTION_DELETED: 'erp_connection.deleted',
  /// A field mapping was saved or verified against a real response.
  ERP_MAPPING_UPDATED: 'erp_connection.mapping_updated',
  /// A synchronisation ran. Recorded for manual and scheduled runs alike, so
  /// "who changed my stock figures" has an answer that does not depend on
  /// reading application logs.
  ERP_INVENTORY_SYNCED: 'erp_connection.inventory_synced',
  /// An inbound webhook was refused: bad signature, no secret, or a connection
  /// that is not accepting them. Worth a row of its own - a run of these is
  /// either a misconfigured ERP or somebody probing the endpoint.
  ERP_WEBHOOK_REJECTED: 'erp_connection.webhook_rejected',

  // A BUYER's own ERP
  //
  // Coarser than the buyer's own trail in `customer_erp_audit_logs`, and kept
  // apart from the ERP_CONNECTION_* actions above, which are about the
  // OPERATOR's ERP. These exist because a tenant pointing this server at a new
  // outbound address, and this server then holding a credential for it, is
  // something whoever runs the installation is entitled to see - without being
  // able to see the credential, or the buyer's mappings, or their purchase
  // orders. The rows carry a host and an organisation id and nothing else.
  CUSTOMER_ERP_CONNECTION_CREATED: 'customer_erp.connection_created',
  CUSTOMER_ERP_CONNECTION_ACTIVATED: 'customer_erp.connection_activated',
  CUSTOMER_ERP_CONNECTION_DISCONNECTED: 'customer_erp.connection_disconnected',
  /// An inbound delivery was refused. A run of these against one connection is
  /// either a misconfigured ERP or somebody probing the endpoint, and the
  /// operator is the only one positioned to notice the second across tenants.
  CUSTOMER_ERP_WEBHOOK_REJECTED: 'customer_erp.webhook_rejected',

  // Auto-pay
  //
  // Consent to charge, and its withdrawal. These are the rows that answer "did
  // this customer agree to this" when a charge is disputed, which is why they
  // record the version of the wording agreed to and are written even when the
  // change is a customer switching their own setting off.
  AUTOPAY_ENABLED: 'autopay.enabled',
  AUTOPAY_DISABLED: 'autopay.disabled',
  AUTOPAY_PAUSED: 'autopay.paused',
  AUTOPAY_RESUMED: 'autopay.resumed',
  AUTOPAY_SETTINGS_UPDATED: 'autopay.settings_updated',
  /// A charge was NOT made because it exceeded a limit the customer set, or
  /// crossed the threshold at which they asked to be consulted. On the trail
  /// because a delivery that did not happen needs an explanation as much as one
  /// that did.
  AUTOPAY_CHARGE_WITHHELD: 'autopay.charge_withheld',

  // The Seller Hub's own password
  //
  // Recorded because it is a credential, and the questions asked after an
  // incident are the same three asked about any credential: when was it
  // chosen, when was it changed, and was anybody trying to guess it. The
  // password itself is never in any of these rows — `REDACTED_FIELDS` below
  // covers the values, and nothing here puts one in a field anyway.
  SELLER_LOCK_SET: 'seller.lock.set',
  SELLER_LOCK_CHANGED: 'seller.lock.changed',
  /// A wrong Seller Hub password. One is a typo; a run of them is not.
  SELLER_LOCK_REFUSED: 'seller.lock.refused',
  /// The Hub opened, closed by the person, kept open from the warning, or
  /// re-locked by the server after SELLER_HUB_IDLE_TIMEOUT_SECONDS idle.
  SELLER_LOCK_OPENED: 'seller.lock.opened',
  SELLER_LOCK_CLOSED: 'seller.lock.closed',
  SELLER_SESSION_RENEWED: 'seller.session.renewed',
  SELLER_SESSION_EXPIRED: 'seller.session.expired',

  // A seller's evidence, and what the marketplace decided about it
  //
  // Recorded on the operator's trail as well as the seller's own, because
  // "who accepted this CE certificate, and when" is a question asked from
  // outside — by an auditor, or by a regulator after a recall. The seller's
  // audit log answers it for the seller; this answers it for the business
  // running the marketplace, and that one outlives the seller account.
  SELLER_DOCUMENT_APPROVED: 'seller_document.approved',
  SELLER_DOCUMENT_REJECTED: 'seller_document.rejected',
  /// A member of staff opened one. Recorded because some of these are a
  /// director's passport, and "who looked at it" is the question asked after a
  /// complaint about how it was handled.
  SELLER_DOCUMENT_VIEWED: 'seller_document.viewed',
  /// A member of staff recorded a restricted-party / sanctions screening of a
  /// seller or one of its owners. Manual: the row says `automated = false`.
  /// On the operator's trail only - telling the seller would be tipping off.
  SELLER_SCREENING_RECORDED: 'seller_screening.recorded',
  /// The worker sent an approved seller back to ACTION_REQUIRED because a
  /// required document expired.
  SELLER_APPLICATION_LAPSED: 'seller_application.lapsed',

  /// Which carriers a seller may hand a parcel to.
  ///
  /// On the OPERATOR's trail as well as the seller's, and for the same reason
  /// the document decisions above are: approving an arrangement is what lets
  /// one business create an obligation on another, and "who allowed this
  /// seller to book that carrier, and when" is asked from outside - by the
  /// carrier, after an invoice they did not expect.
  SELLER_CARRIER_DECIDED: 'seller_carrier.decided',

  // Data protection
  //
  // These rows are the Art. 5(2) accountability record. "We honour erasure
  // requests" is a claim; this is what makes it a demonstrable fact, which is
  // why the trail keeps them even after the account they refer to is gone.
  DATA_REQUEST_CREATED: 'data_request.created',
  DATA_REQUEST_FULFILLED: 'data_request.fulfilled',
  DATA_REQUEST_REJECTED: 'data_request.rejected',
  DATA_REQUEST_DOWNLOADED: 'data_request.downloaded',
  /// The erasure itself, recorded separately from the request that asked for
  /// it: one is a decision, the other is the thing that actually rewrote rows.
  DATA_ERASURE_EXECUTED: 'data_erasure.executed',
  /// A retention sweep that deleted something. Not written when a sweep finds
  /// nothing - an empty pass is not an event.
  RETENTION_PURGED: 'retention.purged',

  // Console notifications
  //
  /// A member of staff closed a console alert by hand.
  ///
  /// Audited where reading and dismissing are not, and the difference is who
  /// is affected: reading a row is a fact about one person's bell, closing one
  /// is a claim that a problem is over and it changes what every colleague
  /// sees. Anything that can make a problem stop being visible has to leave a
  /// record of who made it stop and what they said about it.
  NOTIFICATION_RESOLVED: 'notification.resolved',

  /// A member of staff sent a dead background job, or an undeliverable email,
  /// round again from the dead-letter screens. One more attempt, never a reset
  /// counter; audited because it makes something happen that had stopped.
  JOB_RETRIED: 'job.retried',
  NOTIFICATION_RETRIED: 'notification.retried',

  // The four delivery levels (L1-L4)
  //
  // Every change of mode, owner, carrier and price, with before and after.
  // A buyer disputing a delivery charge and a seller disputing who controlled
  // a level are both answered from these rows.
  LOGISTICS_POLICY_SAVED: 'logistics_policy.saved',
  LOGISTICS_POLICY_PUBLISHED: 'logistics_policy.published',
  LOGISTICS_PROVIDER_CHANGED: 'logistics_provider.changed',
  LOGISTICS_LEVEL_RATE_SAVED: 'logistics_level_rate.saved',
  LOGISTICS_LEVEL_RATE_PUBLISHED: 'logistics_level_rate.published',
  LOGISTICS_LEVEL_RATE_DEACTIVATED: 'logistics_level_rate.deactivated',
  LOGISTICS_LEG_ASSIGNED: 'logistics_leg.assigned',
  LOGISTICS_LEG_STATUS_CHANGED: 'logistics_leg.status_changed',
  LOGISTICS_PRESENTATION_CHANGED: 'logistics_presentation.changed',

  // Platform fee and the tax on it
  PLATFORM_FEE_POLICY_SAVED: 'platform_fee_policy.saved',
  PLATFORM_FEE_POLICY_PUBLISHED: 'platform_fee_policy.published',
  PLATFORM_FEE_POLICY_RETIRED: 'platform_fee_policy.retired',
  PLATFORM_FEE_TAX_VERIFIED: 'platform_fee_policy.tax_verified',
  PLATFORM_FEE_POLICY_SUBMITTED: 'platform_fee_policy.submitted',
  PLATFORM_FEE_POLICY_REJECTED: 'platform_fee_policy.rejected',
  PLATFORM_FEE_RULE_SAVED: 'platform_fee_rule.saved',
  PLATFORM_FEE_RULE_SUBMITTED: 'platform_fee_rule.submitted',
  PLATFORM_FEE_RULE_PUBLISHED: 'platform_fee_rule.published',
  PLATFORM_FEE_RULE_REJECTED: 'platform_fee_rule.rejected',
  PLATFORM_FEE_RULE_RETIRED: 'platform_fee_rule.retired',
  SELLER_FEE_TIER_CHANGED: 'seller.fee_tier_changed',
  /// Bulk preorders. One action per decision, with the terms hash in `after`
  /// wherever terms were proposed or confirmed, so the trail names exactly
  /// what each party agreed to.
  PREORDER_SUBMITTED: 'preorder.submitted',
  PREORDER_SELLER_ACCEPTED: 'preorder.seller_accepted',
  PREORDER_SELLER_COUNTERED: 'preorder.seller_countered',
  PREORDER_REJECTED: 'preorder.rejected',
  PREORDER_BUYER_DECLINED: 'preorder.buyer_declined',
  PREORDER_BUYER_CONFIRMED: 'preorder.buyer_confirmed',
  PREORDER_CONFIRMED: 'preorder.confirmed',
  PREORDER_STATUS_CHANGED: 'preorder.status_changed',
  PREORDER_CANCELLED: 'preorder.cancelled',
  PREORDER_EXPIRED: 'preorder.expired',
  PREORDER_POLICY_SAVED: 'preorder.policy_saved',
  /// The seller answered a request for more than is available with a revised
  /// date or a split delivery. The schedule and its stock allocation are in
  /// `after`, with the terms hash.
  PREORDER_AVAILABILITY_PROPOSED: 'preorder.availability_proposed',
  /// The buyer accepted, and the stock the proposal was built on had gone.
  /// Nothing was reserved or charged; the proposal was invalidated.
  PREORDER_STOCK_INVALIDATED: 'preorder.stock_invalidated',
  /// A buyer acknowledged the bulk preorder information, at a version. Only
  /// the version is recorded - never the product they were looking at.
  PREORDER_INFO_ACKNOWLEDGED: 'preorder.info_acknowledged',
  /// A seller's invoices and packing lists. Every preview, issue, download,
  /// credit and supersession is recorded, with the document number and the
  /// SHA-256 of the PDF where one exists.
  SELLER_INVOICE_PREVIEWED: 'seller_invoice.previewed',
  SELLER_INVOICE_ISSUED: 'seller_invoice.issued',
  SELLER_INVOICE_CREDITED: 'seller_invoice.credited',
  SELLER_INVOICE_FLAGGED: 'seller_invoice.credit_note_required',
  PACKING_LIST_PREVIEWED: 'packing_list.previewed',
  PACKING_LIST_ISSUED: 'packing_list.issued',
  PACKING_LIST_SUPERSEDED: 'packing_list.superseded',
  CONSIGNMENT_PACKED: 'consignment.packed',
  SELLER_DOCUMENT_DOWNLOADED: 'seller_document.downloaded',
  /// A buyer downloaded the signature or photograph captured as proof of
  /// delivery of their own consignment. Which image and which consignment -
  /// never the recipient's name.
  PROOF_OF_DELIVERY_DOWNLOADED: 'proof_of_delivery.downloaded',
  /// The operator's commission invoices to sellers, and their credit notes.
  /// Numbers, amounts, hashes and statuses - never a free-text body.
  COMMISSION_INVOICE_GENERATED: 'commission_invoice.generated',
  COMMISSION_INVOICE_REGENERATED: 'commission_invoice.regenerated',
  COMMISSION_INVOICE_PREVIEWED: 'commission_invoice.previewed',
  COMMISSION_INVOICE_ISSUED: 'commission_invoice.issued',
  COMMISSION_INVOICE_DOWNLOADED: 'commission_invoice.downloaded',
  COMMISSION_INVOICE_VOIDED: 'commission_invoice.voided',
  COMMISSION_INVOICE_COLLECTION_RECORDED: 'commission_invoice.collection_recorded',
  COMMISSION_CREDIT_NOTE_ISSUED: 'commission_credit_note.issued',
  COMMISSION_INVOICE_SETTINGS_SAVED: 'commission_invoice_settings.saved',
  /// A buyer's payment or refund receipt: its number issued the first time it
  /// was asked for. Number, kind, order and amount - nothing about the card.
  PAYMENT_RECEIPT_ISSUED: 'payment_receipt.issued',
  /// Terms and Conditions and the other legal documents. Kind, version,
  /// language, dates and the content hash - never the body, which is kept on
  /// the document itself and never changes once published.
  LEGAL_DOCUMENT_DRAFTED: 'legal_document.drafted',
  LEGAL_DOCUMENT_DRAFT_UPDATED: 'legal_document.draft_updated',
  LEGAL_DOCUMENT_DRAFT_DELETED: 'legal_document.draft_deleted',
  LEGAL_DOCUMENT_PUBLISHED: 'legal_document.published',
  /// Preorder chat. What was decided about a conversation and who decided it -
  /// never what anybody wrote in it. A message body is not an audit value: the
  /// conversation itself is the record of what was said, and copying it here
  /// would put a private negotiation in front of everybody who may read the
  /// trail.
  /// Support requests. Same rule as preorder chat: who did what to which
  /// request, never what anybody wrote in it - the request itself is the
  /// record of what was said.
  SUPPORT_TICKET_CREATED: 'support_ticket.created',
  SUPPORT_TICKET_STATUS_CHANGED: 'support_ticket.status_changed',
  SUPPORT_TICKET_PRIORITY_CHANGED: 'support_ticket.priority_changed',
  SUPPORT_TICKET_ASSIGNED: 'support_ticket.assigned',
  SUPPORT_TICKET_REPLIED: 'support_ticket.replied',
  SUPPORT_TICKET_NOTE_ADDED: 'support_ticket.note_added',
  /// A file put on a ticket, and one taken out - its id, type and size, never
  /// its name or contents.
  SUPPORT_TICKET_ATTACHMENT_UPLOADED: 'support_ticket.attachment_uploaded',
  SUPPORT_TICKET_ATTACHMENT_DOWNLOADED: 'support_ticket.attachment_downloaded',
  SUPPORT_TICKET_SLA_POLICY_SAVED: 'support_ticket.sla_policy_saved',
  /// Disputes: claims and chargebacks. Who did what to which dispute - never
  /// what anybody wrote in it, and a file by id, type and size only.
  DISPUTE_CREATED: 'dispute.created',
  DISPUTE_MESSAGE_ADDED: 'dispute.message_added',
  DISPUTE_NOTE_ADDED: 'dispute.note_added',
  DISPUTE_EVIDENCE_UPLOADED: 'dispute.evidence_uploaded',
  DISPUTE_EVIDENCE_DOWNLOADED: 'dispute.evidence_downloaded',
  DISPUTE_SELLER_RESPONDED: 'dispute.seller_responded',
  DISPUTE_ESCALATED: 'dispute.escalated',
  DISPUTE_WITHDRAWN: 'dispute.withdrawn',
  DISPUTE_ASSIGNED: 'dispute.assigned',
  DISPUTE_DECISION_PROPOSED: 'dispute.decision_proposed',
  DISPUTE_DECISION_APPROVED: 'dispute.decision_approved',
  DISPUTE_DECISION_REFUSED: 'dispute.decision_refused',
  DISPUTE_DECIDED: 'dispute.decided',
  DISPUTE_APPEALED: 'dispute.appealed',
  DISPUTE_CHARGEBACK_UPDATED: 'dispute.chargeback_updated',
  DISPUTE_CHARGEBACK_LOST_SETTLED: 'dispute.chargeback_lost_settled',
  DISPUTE_SETTINGS_SAVED: 'dispute.settings_saved',
  PREORDER_CHAT_STARTED: 'preorder_chat.started',
  PREORDER_CHAT_VIEWED: 'preorder_chat.viewed',
  PREORDER_CHAT_ASSIGNED: 'preorder_chat.assigned',
  PREORDER_CHAT_STATUS_CHANGED: 'preorder_chat.status_changed',
  /// The customer asked the preorder assistant for a person. `after` carries
  /// the question they were on and how many answers they had read.
  PREORDER_CHAT_HANDOFF_REQUESTED: 'preorder_chat.handoff_requested',
  PREORDER_CHAT_PRIORITY_CHANGED: 'preorder_chat.priority_changed',
  PREORDER_CHAT_TAGS_CHANGED: 'preorder_chat.tags_changed',
  PREORDER_CHAT_NOTE_ADDED: 'preorder_chat.note_added',
  PREORDER_CHAT_PREORDER_LINKED: 'preorder_chat.preorder_linked',
  PREORDER_CHAT_PROPOSAL_CREATED: 'preorder_chat.proposal_created',
  PREORDER_CHAT_PROPOSAL_WITHDRAWN: 'preorder_chat.proposal_withdrawn',
  PREORDER_CHAT_PROPOSAL_ANSWERED: 'preorder_chat.proposal_answered',
  PREORDER_CHAT_CUSTOMER_BLOCKED: 'preorder_chat.customer_blocked',
  PREORDER_CHAT_CUSTOMER_UNBLOCKED: 'preorder_chat.customer_unblocked',
  /// The words of one message were removed. `after` carries the reason, the
  /// length and a SHA-256 of what was removed - enough to prove later what
  /// was redacted without keeping the card number somebody pasted.
  PREORDER_CHAT_MESSAGE_REDACTED: 'preorder_chat.message_redacted',
  PREORDER_CHAT_EXPORTED: 'preorder_chat.exported',
  PREORDER_CHAT_ATTACHMENT_UPLOADED: 'preorder_chat.attachment_uploaded',
  PREORDER_CHAT_ATTACHMENT_DOWNLOADED: 'preorder_chat.attachment_downloaded',

  // Pre-shipment inspection. Written with resourceType `order` and the buyer
  // order's id, so an order's audit trail carries every inspection decision:
  // what was required and why, bookings, the signed report, releases and who
  // approved them. The inspection's own timeline (`inspection_events`) holds
  // the detail.
  INSPECTION_REQUIREMENT_DECIDED: 'inspection.requirement_decided',
  INSPECTION_BOOKED: 'inspection.booked',
  INSPECTION_JOB_STATUS_CHANGED: 'inspection.job_status_changed',
  INSPECTION_REPORT_SIGNED: 'inspection.report_signed',
  INSPECTION_DEFECT_RECLASSIFIED: 'inspection.defect_reclassified',
  INSPECTION_CAPA_SUBMITTED: 'inspection.capa_submitted',
  INSPECTION_RELEASE_REQUESTED: 'inspection.release_requested',
  INSPECTION_RELEASE_APPROVED: 'inspection.release_approved',
  INSPECTION_RELEASE_REJECTED: 'inspection.release_rejected',
  INSPECTION_RELEASE_RECORDED: 'inspection.release_recorded',
  INSPECTION_SCOPE_CHANGED: 'inspection.scope_changed',
  INSPECTION_LOAD_RELEASED: 'inspection.load_released',
  INSPECTION_POLICY_CHANGED: 'inspection.policy_changed',
  INSPECTION_AGENCY_CHANGED: 'inspection.agency_changed',
  INSPECTION_INVOICE_CHANGED: 'inspection.invoice_changed',

  // Buyer companies. The company's own timeline (`buyer_company_review_events`)
  // carries the detail a reviewer reads; these rows are the platform-wide
  // trail that the audit screen and an Art. 15 export draw on.
  /// A storefront session moved between acting for the person and for a company.
  BUYER_CONTEXT_SWITCHED: 'buyer_context.switched',
  BUYER_COMPANY_CREATED: 'buyer_company.created',
  BUYER_COMPANY_UPDATED: 'buyer_company.updated',
  BUYER_COMPANY_STATUS_CHANGED: 'buyer_company.status_changed',
  BUYER_COMPANY_ASSIGNED: 'buyer_company.assigned',
  BUYER_COMPANY_NOTE_ADDED: 'buyer_company.note_added',
  BUYER_COMPANY_INFO_REQUESTED: 'buyer_company.info_requested',
  BUYER_COMPANY_INFO_ANSWERED: 'buyer_company.info_answered',
  BUYER_COMPANY_EMAIL_VERIFIED: 'buyer_company.email_verified',
  BUYER_COMPANY_CONSENT_RECORDED: 'buyer_company.consent_recorded',
  BUYER_COMPANY_CHECKS_RUN: 'buyer_company.checks_run',
  BUYER_COMPANY_DOCUMENT_UPLOADED: 'buyer_company.document_uploaded',
  // Who belongs to a buyer company, and as what (Master rows 11 and 14).
  BUYER_COMPANY_MEMBER_INVITED: 'buyer_company.member_invited',
  BUYER_COMPANY_INVITATION_RESENT: 'buyer_company.invitation_resent',
  BUYER_COMPANY_INVITATION_REVOKED: 'buyer_company.invitation_revoked',
  BUYER_COMPANY_INVITATION_ACCEPTED: 'buyer_company.invitation_accepted',
  BUYER_COMPANY_MEMBER_ROLE_CHANGED: 'buyer_company.member_role_changed',
  BUYER_COMPANY_MEMBER_REMOVED: 'buyer_company.member_removed',
  BUYER_COMPANY_ACCESS_REVIEWED: 'buyer_company.access_reviewed',
  // Who belongs to a seller's team, and as what (Master row 14). Also written
  // to the seller's own log (`seller_audit_logs`) in words for the seller.
  SELLER_MEMBER_INVITED: 'seller.member.invited',
  SELLER_INVITATION_RESENT: 'seller.invitation.resent',
  SELLER_INVITATION_REVOKED: 'seller.invitation.revoked',
  SELLER_INVITATION_ACCEPTED: 'seller.invitation.accepted',
  SELLER_MEMBER_ROLE_CHANGED: 'seller.member.role_changed',
  SELLER_MEMBER_REMOVED: 'seller.member.removed',
  SELLER_ACCESS_REVIEWED: 'seller.access.reviewed',
  // An individual buyer's identity check and marketing choices (Master row 11).
  CUSTOMER_KYC_UPDATED: 'customer_kyc.updated',
  CUSTOMER_KYC_SUBMITTED: 'customer_kyc.submitted',
  CUSTOMER_KYC_DECIDED: 'customer_kyc.decided',
  /// A verified check whose identity document passed its expiry date. Written by the system.
  CUSTOMER_KYC_EXPIRED: 'customer_kyc.expired',
  CUSTOMER_KYC_DOCUMENT_UPLOADED: 'customer_kyc.document_uploaded',
  CUSTOMER_KYC_DOCUMENT_WITHDRAWN: 'customer_kyc.document_withdrawn',
  CUSTOMER_KYC_DOCUMENT_DECIDED: 'customer_kyc.document_decided',
  /// A member of staff opened a buyer's identity document. Every download is one row.
  CUSTOMER_KYC_DOCUMENT_VIEWED: 'customer_kyc.document_viewed',
  CUSTOMER_MARKETING_PREFERENCES_UPDATED: 'customer.marketing_preferences_updated',
  // A supplier's factories and certificates, and the operator's checks of
  // them (Master row 13). Document metadata only - never a file's contents.
  SELLER_FACTORY_DECIDED: 'seller_factory.decided',
  /// A verified factory whose verification passed its valid-until date. Written by the system.
  SELLER_FACTORY_EXPIRED: 'seller_factory.expired',
  SELLER_CERTIFICATION_DECIDED: 'seller_certification.decided',
  /// A verified certificate past its expiry date. Written by the system.
  SELLER_CERTIFICATION_EXPIRED: 'seller_certification.expired',
  /// A member of staff opened a company document. Every download is one row.
  BUYER_COMPANY_DOCUMENT_VIEWED: 'buyer_company.document_viewed',
  BUYER_COMPANY_DOCUMENT_DECIDED: 'buyer_company.document_decided',
  BUYER_COMPANY_DOCUMENT_WITHDRAWN: 'buyer_company.document_withdrawn',

  // Product reviews. Writing one is not audited - it is the buyer's own
  // record and carries its own timestamps. Staff hiding or restoring one is,
  // because it changes what every other buyer is shown.
  PRODUCT_REVIEW_HIDDEN: 'product_review.hidden',
  PRODUCT_REVIEW_PUBLISHED: 'product_review.published',

  // Returns. Every step of one, by whoever took it: the buyer asking, the
  // seller answering, staff deciding, receiving, inspecting and refunding. A
  // file by id, type and size only - never its name.
  RETURN_REQUESTED: 'return.requested',
  RETURN_SELLER_RESPONDED: 'return.seller_responded',
  RETURN_APPROVED: 'return.approved',
  RETURN_REJECTED: 'return.rejected',
  RETURN_INSTRUCTIONS_SET: 'return.instructions_set',
  RETURN_RECEIVED: 'return.received',
  RETURN_INSPECTED: 'return.inspected',
  RETURN_REFUNDED: 'return.refunded',
  RETURN_REPLACED: 'return.replaced',
  RETURN_FILE_UPLOADED: 'return.file_uploaded',
  RETURN_FILE_DOWNLOADED: 'return.file_downloaded',
  RETURN_SETTINGS_CHANGED: 'return.settings_changed',

  // Requests for quotation (Master rows 16-19). Every step, by whoever took
  // it: the buyer raising, sending, changing and closing a request, sellers
  // being asked. A file by id, type and size only - never its name.
  RFQ_CREATED: 'rfq.created',
  RFQ_DRAFT_UPDATED: 'rfq.draft_updated',
  RFQ_DRAFT_DELETED: 'rfq.draft_deleted',
  RFQ_SUBMITTED: 'rfq.submitted',
  RFQ_SUPPLIER_INVITED: 'rfq.supplier_invited',
  RFQ_CANCELLED: 'rfq.cancelled',
  RFQ_CLOSED: 'rfq.closed',
  RFQ_ATTACHMENT_UPLOADED: 'rfq.attachment_uploaded',
  RFQ_ATTACHMENT_REMOVED: 'rfq.attachment_removed',
  RFQ_ATTACHMENT_DOWNLOADED: 'rfq.attachment_downloaded',
  RFQ_AMENDED: 'rfq.amended',
  RFQ_INVITATION_DECLINED: 'rfq.invitation_declined',
} as const;

export type AuditActionKey = (typeof AuditAction)[keyof typeof AuditAction];

/**
 * Which side acted.
 *
 * Mirrors the `ActorType` enum in the schema. LOGISTICS is a third-party
 * carrier's own staff acting inside the logistics portal, and it is a member
 * of its own rather than being folded into SYSTEM: "the system moved this
 * shipment" and "a named dispatcher at a named carrier moved it" are the two
 * answers an operator most needs to tell apart after a bad delivery.
 */
export type AuditActorType = 'SYSTEM' | 'ADMIN' | 'CUSTOMER' | 'PROVIDER' | 'LOGISTICS';

export interface AuditEntry {
  action: AuditActionKey;
  resourceType: string;
  resourceId?: string | null;
  actorType: AuditActorType;
  actorUserId?: string | null;
  actorEmail?: string | null;
  /**
   * The actor's role keys at the moment of the act. Leave it out and
   * `recordAudit` looks them up for `actorUserId` itself, through the same
   * client, so the entry records what the person held THEN - see
   * `actorRolesAtWrite`.
   */
  actorRoles?: readonly string[] | null;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

/**
 * Field names whose VALUES never reach the audit trail.
 *
 * The key is still recorded, so "the webhook secret was rotated" remains
 * visible; only the secret itself is replaced.
 */
const REDACTED_FIELDS = new Set([
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'token',
  'tokenHash',
  'refreshTokenHash',
  'mfaSecret',
  'mfaSecretEnc',
  'credentialsEnc',
  'webhookSecretEnc',
  'keySecret',
  'apiSecret',
  'webhookSecret',
  'signature',
  'rawPayload',
  'cardNumber',
  'cvv',
  // ERP credentials, in every spelling the connection service and its API
  // schema use for them. The key survives, so "the API key was
  // rotated" stays visible on the trail; only the value is replaced.
  'apiKey',
  'clientSecret',
  'credentials',
  'extraSecretHeaders',
  'oauthTokenEnc',
  'accessToken',
]);

const MAX_AUDIT_VALUE_BYTES = 16_384;

/**
 * Recursively strip secret values and normalise types JSON cannot carry.
 * BigInt is the important one: every money column is a BigInt, and
 * JSON.stringify throws on it rather than degrading gracefully.
 */
function redact(value: unknown, depth = 0): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) return null;
  if (depth > 8) return '[TRUNCATED_DEPTH]';

  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 200).map((entry) => redact(entry, depth + 1) ?? null);
  }

  if (typeof value === 'object') {
    const result: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      result[key] = REDACTED_FIELDS.has(key) ? '[REDACTED]' : redact(entryValue, depth + 1);
    }
    return result;
  }

  // Anything left is a type JSON cannot carry (function, symbol). Record the
  // type rather than String()-ing it into a useless "[object Object]".
  return `[UNSERIALISABLE:${typeof value}]`;
}

/** Guard against a huge payload bloating the table. */
function bounded(value: Prisma.InputJsonValue | null): Prisma.InputJsonValue | null {
  if (value === null) return null;
  const serialised = JSON.stringify(value);
  if (serialised !== undefined && serialised.length > MAX_AUDIT_VALUE_BYTES) {
    return { truncated: true, bytes: serialised.length };
  }
  return value;
}

type AuditClient = Pick<typeof prisma, 'auditLog'> & Partial<Pick<typeof prisma, 'userRole'>>;

/** `audit_logs.actorRoles` is VARCHAR(255). */
const MAX_ACTOR_ROLES_LENGTH = 255;

function joinRoles(keys: readonly string[]): string | null {
  const joined = [...new Set(keys)].sort().join(',');
  if (joined === '') return null;
  // Six role keys fit many times over; a truncated list would still say
  // something true, but cut on a comma so no key is half-written.
  if (joined.length <= MAX_ACTOR_ROLES_LENGTH) return joined;
  return joined.slice(0, MAX_ACTOR_ROLES_LENGTH).replace(/,[^,]*$/, '');
}

/**
 * The role keys `actorUserId` holds right now - which, at write time, is the
 * role they acted in.
 *
 * Read through the caller's transaction when there is one, so a role granted
 * or revoked earlier in the same transaction is what the entry records. A
 * failed lookup records no role rather than failing the action: the role is
 * context for the reader, and an order must not be refused because of it.
 * On MariaDB a failed SELECT does not abort the surrounding transaction.
 */
async function actorRolesAtWrite(
  client: AuditClient,
  entry: AuditEntry,
): Promise<string | null> {
  if (entry.actorRoles !== undefined) {
    return entry.actorRoles === null ? null : joinRoles(entry.actorRoles);
  }

  const userId = entry.actorUserId ?? null;
  if (userId === null) return null;

  const reader = client.userRole ?? prisma.userRole;

  try {
    const rows = await reader.findMany({
      where: { userId },
      select: { role: { select: { key: true } } },
    });
    return joinRoles(rows.map((row) => row.role.key));
  } catch (error) {
    logger.warn({ err: error, action: entry.action }, 'could not read the actor role for an audit entry');
    return null;
  }
}

/**
 * Write an audit row.
 *
 * Pass `tx` whenever the audited change is itself transactional - which is
 * nearly always. Without it the audit row commits independently and can survive
 * a rolled-back action, recording something that never happened.
 */
export async function recordAudit(entry: AuditEntry, tx?: unknown): Promise<void> {
  const client = (tx as AuditClient | undefined) ?? prisma;
  const requestContext = currentRequestContext();

  const data: Prisma.AuditLogUncheckedCreateInput = {
    id: newId(),
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? null,
    actorType: entry.actorType,
    actorUserId: entry.actorUserId ?? null,
    actorEmail: entry.actorEmail ?? null,
    actorRoles: await actorRolesAtWrite(client, entry),
    beforeJson: bounded(redact(entry.before)) ?? Prisma.JsonNull,
    afterJson: bounded(redact(entry.after)) ?? Prisma.JsonNull,
    // A caller's own value wins. Without one, the address and browser of the
    // HTTP request this runs inside (infra/request-context.ts), so an edit
    // made through any route is traceable to a device without every service
    // passing it. A worker or script has no request, and records none.
    ipAddress: entry.ipAddress ?? requestContext?.ipAddress ?? null,
    userAgent: (entry.userAgent ?? requestContext?.userAgent)?.slice(0, 512) ?? null,
    correlationId: entry.correlationId ?? null,
  };

  if (tx !== undefined) {
    // Inside a caller's transaction: let a failure abort the whole operation.
    // An action that cannot be audited must not be allowed to commit.
    await client.auditLog.create({ data });
    return;
  }

  // Standalone (login attempts, webhook rejections). Here the audit write is
  // best-effort: failing to log a rejected webhook must not turn into a 500
  // that makes the provider retry a request we already refused.
  try {
    await client.auditLog.create({ data });
  } catch (error) {
    logger.error(
      { err: error, action: entry.action, resourceType: entry.resourceType },
      'failed to write audit log',
    );
  }
}
