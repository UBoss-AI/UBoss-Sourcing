/**
 * Notifications - transactional outbox.
 *
 * Business code never calls the email provider. It writes a row to
 * `notification_outbox`, ideally inside the same transaction as the change that
 * caused it, and the worker delivers from there.
 *
 * That indirection buys three things a direct send cannot:
 *   - A committed order cannot lose its confirmation email (the row committed
 *     with it).
 *   - A rolled-back transaction cannot send a phantom email (the row rolled
 *     back too).
 *   - A provider outage becomes a retry queue rather than a failed checkout.
 */
import { internal } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { JobType, queue } from '../../infra/queue/index.js';
import { env } from '../../config/env.js';
import { marketplaceNameFrom } from '../settings/marketplace-name.js';

/** Notification events. Each maps to a `notification_settings.eventKey` row. */
export const NotificationEvent = {
  CUSTOMER_INVITATION: 'customer.invitation',
  /// Confirm the address somebody typed into the storefront's own sign-up form.
  /// Not the invitation above: nobody vouched for this address, so the link is
  /// what turns a typed string into a mailbox we know answers.
  CUSTOMER_EMAIL_VERIFICATION: 'customer.email_verification',
  /// Sent when a sign-up names an address that already has an account. It goes
  /// to the address itself and never back to whoever filled the form in, so the
  /// form cannot be used to find out who is registered here.
  CUSTOMER_REGISTRATION_DUPLICATE: 'customer.registration_duplicate',
  /// The confirmed account is now waiting on a member of staff.
  CUSTOMER_REGISTRATION_PENDING: 'customer.registration_pending',
  /// Staff let them in; the account can sign in from now on.
  CUSTOMER_REGISTRATION_APPROVED: 'customer.registration_approved',
  /// Buyer-company verification. Each is written in the recipient's own
  /// language by `buyer-companies/notifications.ts` and arrives here already
  /// worded, as {{subjectLine}} and {{bodyText}} - the template itself only
  /// frames it, and an operator may still replace the frame.
  BUYER_COMPANY_EMAIL_CODE: 'buyer_company.email_code',
  BUYER_COMPANY_SUBMITTED: 'buyer_company.submitted',
  BUYER_COMPANY_REVIEW_STARTED: 'buyer_company.review_started',
  BUYER_COMPANY_INFO_REQUESTED: 'buyer_company.info_requested',
  BUYER_COMPANY_APPROVED: 'buyer_company.approved',
  BUYER_COMPANY_REJECTED: 'buyer_company.rejected',
  BUYER_COMPANY_SUSPENDED: 'buyer_company.suspended',
  BUYER_COMPANY_REVERIFICATION: 'buyer_company.reverification',
  BUYER_COMPANY_RESTORED: 'buyer_company.restored',
  /// Somebody was asked to join a buyer company in a role. Worded in the
  /// inviter's language, because the invitee may have no account yet.
  BUYER_COMPANY_INVITATION: 'buyer_company.invitation',
  /// Somebody was asked to join a seller's team in a role (Master row 14).
  /// Worded in the inviter's language, like the buyer-company invitation.
  SELLER_TEAM_INVITATION: 'seller.team_invitation',
  /// A new staff account and the temporary password that opens it once.
  STAFF_TEMPORARY_PASSWORD: 'staff.temporary_password',
  USER_PASSWORD_RESET: 'user.password_reset',
  /// Confirm an address somebody has asked to move their account TO. Sent to
  /// the new address and nowhere else, because owning that mailbox is the only
  /// thing this link proves.
  USER_EMAIL_CHANGE_CONFIRM: 'user.email_change_confirm',
  /// Tell the address the account currently uses that a move was requested.
  ///
  /// Sent to the OLD address, carries no link, and is the whole reason a
  /// contact change is worth two emails: if somebody else has got into the
  /// account, this is the message that reaches the real holder while their
  /// address still works. It says how to stop it.
  USER_EMAIL_CHANGE_REQUESTED: 'user.email_change_requested',
  /// Confirm a new telephone number.
  ///
  /// Goes to the account's email address, not to the number. This deployment
  /// has no SMS driver — see the note on `users.pendingPhone`. So the link
  /// proves control of the account, which is what stops somebody else changing
  /// the number; it does not prove control of the number itself.
  USER_PHONE_CHANGE_CONFIRM: 'user.phone_change_confirm',
  /// The account was closed by its own holder. Sent as it happens, because a
  /// deactivation somebody did not ask for is something they need to hear
  /// about while they can still get it reversed.
  USER_ACCOUNT_DEACTIVATED: 'user.account_deactivated',
  /// "Was this you?" A storefront sign-in from a device and network this
  /// account has not used recently. Says what to do if it was not them, and
  /// carries no link that signs anybody in. See `identity/login-alert.service.ts`.
  USER_NEW_SIGN_IN: 'user.new_sign_in',
  /// Two-step sign-in was switched off on this account.
  USER_MFA_DISABLED: 'user.mfa_disabled',
  ORDER_SUBMITTED: 'order.submitted',
  ORDER_CONFIRMED: 'order.confirmed',
  ORDER_CANCELLED: 'order.cancelled',
  ORDER_SHIPPED: 'order.shipped',
  /// A seller recorded a production milestone or a delay on the buyer's order.
  /// Only the structured, buyer-safe update is in it - never the seller's notes.
  ORDER_PRODUCTION_UPDATE: 'order.production_update',
  /// A consignment's milestones, told to the BUYER. One email per consignment
  /// per milestone, however many carrier scans report it. PICKED_UP is sent
  /// only where the order has more than one consignment - with one, the
  /// order's own "shipped" email already says it.
  SHIPMENT_PICKED_UP: 'shipment.picked_up',
  SHIPMENT_IN_TRANSIT: 'shipment.in_transit',
  SHIPMENT_OUT_FOR_DELIVERY: 'shipment.out_for_delivery',
  SHIPMENT_DELIVERED: 'shipment.delivered',
  /// Something went wrong with a consignment, told to the BUYER: held at
  /// customs or the port, delayed, an address problem, a missed or failed
  /// delivery, damage, loss, a temperature excursion. One email per trouble
  /// event, in a sentence written for the buyer - never the carrier's notes.
  SHIPMENT_EXCEPTION: 'shipment.exception',
  /// The six-digit code the BUYER reads out to the driver, for a delivery whose
  /// policy requires one. Worded in the buyer's own language by
  /// `logistics/delivery-code-email.ts` and framed here like the buyer-company
  /// emails. Never sent to anybody at the carrier.
  SHIPMENT_DELIVERY_CODE: 'shipment.delivery_code',
  PAYMENT_LINK: 'payment.link',
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_FAILED: 'payment.failed',
  REFUND_PROCESSED: 'refund.processed',
  SCHEDULE_REMINDER: 'schedule.reminder',
  SCHEDULE_FAILED: 'schedule.failed',
  SCHEDULE_PAUSED: 'schedule.paused',
  /// The plan is live and the first delivery is dated. Sent once, at the
  /// moment consent takes effect, because that is when the customer has taken
  /// on a commitment and is owed a record of it.
  SCHEDULE_ACTIVATED: 'schedule.activated',
  SCHEDULE_RESUMED: 'schedule.resumed',
  SCHEDULE_CANCELLED: 'schedule.cancelled',
  SCHEDULE_COMPLETED: 'schedule.completed',
  /// The total moved beyond the approved tolerance. Nothing has been charged,
  /// and the message says so first: a customer reading about a price change
  /// assumes they have already paid it unless told otherwise.
  SCHEDULE_PRICE_CHANGED: 'schedule.price_changed',
  /// Something on the order cannot be supplied, so this delivery is on hold.
  /// Never sent alongside a substitution - if a substitute was authorised and
  /// used, the order simply went out.
  SCHEDULE_STOCK_UNAVAILABLE: 'schedule.stock_unavailable',
  /// The bank wants the cardholder. The one notification in this list that
  /// asks the customer to do something within a deadline.
  SCHEDULE_PAYMENT_ACTION_REQUIRED: 'schedule.payment_action_required',
  /// This cycle was skipped. Two senders and two different sentences - see
  /// `skippedByUser` on the occurrence.
  SCHEDULE_OCCURRENCE_SKIPPED: 'schedule.occurrence_skipped',
  /// Paid and ordered, but the warehouse system has not taken it yet. Sent
  /// only once the delay is long enough to be worth mentioning, and it never
  /// suggests the customer do anything: it is ours to fix.
  SCHEDULE_ERP_DELAYED: 'schedule.erp_delayed',
  INVENTORY_LOW_STOCK: 'inventory.low_stock',
  /// The ERP connection stopped working and was taken out of service. Sent to
  /// staff, because it is the business's own system and only they can fix it -
  /// and until they do, no order is reaching the warehouse system.
  ERP_CONNECTION_SUSPENDED: 'erp.connection_suspended',
  /// A stock synchronisation finished with records it could not apply. Sent
  /// only when something actually failed; a clean nightly sync is not news.
  ERP_SYNC_FAILED: 'erp.sync_failed',
  /// Paid, and the ERP has not taken the order yet. Sent to staff once the
  /// delay is long enough to be worth acting on. The customer is told nothing:
  /// their order is confirmed and their money is safe, and a warehouse system
  /// being slow is not their problem to carry.
  ERP_ORDER_DELAYED: 'erp.order_delayed',
  /// Retries are exhausted. The order is paid, real, and not in the warehouse
  /// system, and somebody has to go and look at the ERP.
  ERP_ORDER_ABANDONED: 'erp.order_abandoned',
  /// An automatic payment was taken. Sent when the customer asked to be told,
  /// and it says what was charged before it says anything else.
  AUTOPAY_CHARGED: 'autopay.charged',
  /// An automatic payment did not go through.
  AUTOPAY_FAILED: 'autopay.failed',
  /// Nothing was charged because the amount was above the level the customer
  /// asked to be consulted about. The delivery is waiting for their answer.
  AUTOPAY_APPROVAL_NEEDED: 'autopay.approval_needed',
  /// The Art. 15 copy is built and waiting. Says when the link stops working,
  /// because the window is short on purpose.
  DATA_REQUEST_READY: 'data_request.ready',
  /// The Art. 17 erasure is done, and what survived it. Sent to the address
  /// that asked, moments before that address stops existing.
  DATA_REQUEST_ERASED: 'data_request.erased',
  /// A refusal, carrying the reason. Art. 12(4) requires both this and the
  /// reminder that the subject may complain to a supervisory authority.
  DATA_REQUEST_REJECTED: 'data_request.rejected',

  // --- A buyer's own organisation and its own ERP ---
  //
  // These go to the BUYER, which is what separates them from the ERP_* events
  // above. Those tell staff that the business's own warehouse system is
  // struggling; these tell a customer that the SAP system they run themselves
  // needs something from them. A customer cannot act on the first and staff
  // cannot act on the second.
  /// Somebody has been asked to join a buyer organisation. Sent to an address
  /// that may have no account here at all, so it says what the organisation is
  /// and who asked.
  ORGANIZATION_INVITATION: 'organization.invitation',
  /// The buyer's ERP connection needs a person: an expired authorisation, a
  /// mapping their ERP has started refusing.
  CUSTOMER_ERP_ACTION_REQUIRED: 'customer_erp.action_required',
  /// Repeated failures took the buyer's connection out of service.
  CUSTOMER_ERP_SUSPENDED: 'customer_erp.suspended',
  /// A purchase order or a stock write is over the organisation's threshold
  /// and is waiting for somebody to decide. Nothing has been sent.
  CUSTOMER_ERP_APPROVAL_NEEDED: 'customer_erp.approval_needed',
  /// One event has run out of retries and needs a person. Deliberately not
  /// sent per failed attempt - only when the retries are finished, because a
  /// message per attempt is a message nobody reads by the third one.
  CUSTOMER_ERP_EVENT_FAILED: 'customer_erp.event_failed',
  /// Bulk preorders, told to the BUYER. Each is deduplicated per request per
  /// event (and per revision where a seller can answer more than once), so a
  /// retried answer sends one email.
  PREORDER_SUBMITTED: 'preorder.submitted',
  PREORDER_SELLER_ACCEPTED: 'preorder.seller_accepted',
  PREORDER_SELLER_COUNTERED: 'preorder.seller_countered',
  PREORDER_REJECTED: 'preorder.rejected',
  /// Both parties agreed and the order is waiting to be paid. Nothing has
  /// been charged, and the message says so first.
  PREORDER_PAYMENT_REQUIRED: 'preorder.payment_required',
  PREORDER_CONFIRMED: 'preorder.confirmed',
  PREORDER_PRODUCTION_STARTED: 'preorder.production_started',
  PREORDER_READY: 'preorder.ready_for_fulfilment',
  PREORDER_EXPIRED: 'preorder.expired',
  PREORDER_CANCELLED: 'preorder.cancelled',
  PREORDER_DELIVERY_RISK: 'preorder.delivery_risk',
  PREORDER_AVAILABILITY_PROPOSED: 'preorder.availability_proposed',
  PREORDER_STOCK_CHANGED: 'preorder.stock_changed',
  /// A seller issued the tax invoice for a consignment of the buyer's order.
  SELLER_INVOICE_ISSUED: 'seller_invoice.issued',
  /// Preorder chat, told to the BUYER - only once a reply has sat unread for
  /// PREORDER_CHAT_EMAIL_DELAY_MINUTES, so a customer with the page open is
  /// not emailed about a message they are reading. Never carries the message.
  PREORDER_CHAT_REPLY: 'preorder_chat.reply',
  PREORDER_CHAT_PROPOSAL: 'preorder_chat.proposal',
  PREORDER_CHAT_RESPONSE_REQUESTED: 'preorder_chat.response_requested',
  PREORDER_CHAT_RESOLVED: 'preorder_chat.resolved',
  /// Told to a member of STAFF: a colleague handed them a conversation.
  PREORDER_CHAT_ASSIGNED: 'preorder_chat.assigned',
  /// Support requests. Told to the SENDER when it arrives and when staff
  /// answer, and to the operator's support inbox when a new one comes in.
  /// None carries what anybody wrote - the link opens it after sign-in.
  SUPPORT_TICKET_RECEIVED: 'support_ticket.received',
  SUPPORT_TICKET_REPLY: 'support_ticket.reply',
  SUPPORT_TICKET_NEW_FOR_TEAM: 'support_ticket.new_for_team',
  /// Told to a member of STAFF: a colleague handed them a request.
  SUPPORT_TICKET_ASSIGNED: 'support_ticket.assigned',
  /// Disputes, told to the BUYER: the claim arrived, something happened on it,
  /// it was decided. The reference, the outcome and a link - never what the
  /// seller or the team wrote.
  DISPUTE_RECEIVED: 'dispute.received',
  DISPUTE_UPDATE: 'dispute.update',
  DISPUTE_DECIDED: 'dispute.decided',
  /// Returns. Told to the BUYER at each step of their return, and to the
  /// SELLER's owners when a return of their goods arrives and as it moves.
  /// The refund itself is told by `refund.processed`, as every refund is.
  RETURN_REQUESTED: 'return.requested',
  RETURN_APPROVED: 'return.approved',
  RETURN_REJECTED: 'return.rejected',
  RETURN_INSTRUCTIONS: 'return.instructions',
  RETURN_RECEIVED: 'return.received',
  RETURN_INSPECTED: 'return.inspected',
  RETURN_COMPLETED: 'return.completed',
  RETURN_NEW_FOR_SELLER: 'return.new_for_seller',
  RETURN_UPDATE_FOR_SELLER: 'return.update_for_seller',
  /// Requests for quotation. Told to the SELLER's owners and order managers
  /// when they are asked to quote and when the request changes; told to the
  /// BUYER when a seller answers. The reference, what moved and a link - the
  /// details open after sign-in.
  RFQ_INVITATION: 'rfq.invitation',
  RFQ_UPDATE_FOR_SELLER: 'rfq.update_for_seller',
  RFQ_UPDATE_FOR_BUYER: 'rfq.update_for_buyer',
  /// Saved searches. Told to the BUYER: products matching a search they saved
  /// were published or repriced since the last alert. A count, up to three
  /// product names and a link back to the search - nothing about any seller.
  SAVED_SEARCH_MATCHES: 'saved_search.matches',
} as const;

export type NotificationEventKey = (typeof NotificationEvent)[keyof typeof NotificationEvent];

/**
 * Template variables. Values are primitives only - passing a whole entity would
 * risk personal data or a provider secret ending up in the rendered body and
 * the stored payload.
 */
export type TemplateVariables = Record<string, string | number | boolean | null>;

export interface EnqueueNotificationInput {
  /**
   * A NotificationEvent key. Typed as `string` because settings rows may define
   * additional business-specific events beyond the built-in catalogue.
   */
  eventKey: string;
  recipientEmail: string;
  recipientName?: string | null;
  variables?: TemplateVariables;
  /**
   * Idempotency for notifications. A retried business operation with the same
   * dedupe key sends once, not twice - which matters most for payment links,
   * where a duplicate email is a duplicate payment invitation.
   */
  dedupeKey?: string;
  relatedType?: string;
  relatedId?: string;
  correlationId?: string | null;
  /** Delay delivery, e.g. a schedule reminder ahead of its run. */
  sendAt?: Date;
}

/**
 * `{{name}}` substitution.
 *
 * Values are inserted verbatim into a plain-text body. Templates are authored
 * by administrators, not customers, and the output is never rendered as HTML by
 * this path - so there is nothing here for a customer-supplied value to escape
 * into. If an HTML template is added later, it must escape on render.
 */
function renderTemplate(template: string, variables: TemplateVariables): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
    const value = variables[key];
    return value === undefined || value === null ? match : String(value);
  });
}

/**
 * The frame for a message worded before it reaches the outbox.
 *
 * Buyer-company emails are written in the recipient's language, and this
 * service has no language of its own - its templates are one set of English
 * strings. So the words arrive as variables and the template only places
 * them. Single-pass substitution means a value cannot smuggle in another
 * placeholder.
 */
const LOCALISED_FRAME = Object.freeze({
  subject: '{{subjectLine}}',
  body: '{{bodyText}}\n\n{{businessName}} · {{supportEmail}}\n',
});

/** Built-in fallbacks, used when no notification_settings row exists yet. */
const DEFAULT_TEMPLATES: Readonly<Record<string, { subject: string; body: string }>> =
  Object.freeze({
    [NotificationEvent.ORDER_PRODUCTION_UPDATE]: {
      subject: 'Production update on order {{orderNumber}}',
      body:
        'Hello {{recipientName}},\n\n' +
        '{{sellerName}} has an update on your order {{orderNumber}}: {{updateLine}}\n\n' +
        '{{messageLine}}Follow the order here:\n{{orderUrl}}\n',
    },
    [NotificationEvent.SHIPMENT_PICKED_UP]: {
      subject: 'Part of order {{orderNumber}} has been collected',
      body:
        'Hello {{recipientName}},\n\n' +
        '{{carrier}} has collected consignment {{shipmentReference}} from order {{orderNumber}}.\n\n' +
        '{{trackingLine}}Follow the order here:\n{{orderUrl}}\n',
    },
    [NotificationEvent.SHIPMENT_IN_TRANSIT]: {
      subject: 'Order {{orderNumber}} is on its way',
      body:
        'Hello {{recipientName}},\n\n' +
        'Consignment {{shipmentReference}} from order {{orderNumber}} is on its way with {{carrier}}.\n\n' +
        '{{trackingLine}}Follow the order here:\n{{orderUrl}}\n',
    },
    [NotificationEvent.SHIPMENT_OUT_FOR_DELIVERY]: {
      subject: 'Order {{orderNumber}} is out for delivery',
      body:
        'Hello {{recipientName}},\n\n' +
        'Consignment {{shipmentReference}} from order {{orderNumber}} is out for delivery with {{carrier}} today.\n\n' +
        '{{trackingLine}}Follow the order here:\n{{orderUrl}}\n',
    },
    [NotificationEvent.SHIPMENT_DELIVERED]: {
      subject: 'Order {{orderNumber}}: consignment delivered',
      body:
        'Hello {{recipientName}},\n\n' +
        'Consignment {{shipmentReference}} from order {{orderNumber}} has been delivered by {{carrier}}.\n\n' +
        'If anything is wrong with it, tell us from the order:\n{{orderUrl}}\n',
    },
    [NotificationEvent.SHIPMENT_EXCEPTION]: {
      subject: 'Order {{orderNumber}}: an update on your delivery',
      body:
        'Hello {{recipientName}},\n\n' +
        'Consignment {{shipmentReference}} from order {{orderNumber}}, with {{carrier}}: {{troubleLine}}\n\n' +
        '{{trackingLine}}The latest news and the expected delivery date are on the order:\n{{orderUrl}}\n',
    },
    [NotificationEvent.CUSTOMER_INVITATION]: {
      subject: 'Your {{businessName}} account is ready to activate',
      body:
        'Hello {{recipientName}},\n\n' +
        'An account has been created for you on {{businessName}}.\n\n' +
        'Activate it here (the link expires on {{expiresAt}}):\n{{activationUrl}}\n\n' +
        'If you were not expecting this, please contact {{supportEmail}}.\n',
    },
    [NotificationEvent.CUSTOMER_EMAIL_VERIFICATION]: {
      subject: 'Confirm your email address for {{businessName}}',
      body:
        'Hello {{recipientName}},\n\n' +
        'Someone - we hope you - created a {{businessName}} account with this address.\n\n' +
        'Confirm it here (the link expires on {{expiresAt}}):\n{{verificationUrl}}\n\n' +
        'Until the address is confirmed the account cannot be used, so if this was not\n' +
        'you there is nothing to do: ignore this email and the account stays shut.\n\n' +
        'Questions? Write to {{supportEmail}}.\n',
    },
    [NotificationEvent.CUSTOMER_REGISTRATION_DUPLICATE]: {
      subject: 'You already have a {{businessName}} account',
      body:
        'Hello,\n\n' +
        'Somebody just tried to create a {{businessName}} account with this address, and\n' +
        'one already exists. No second account was made and nothing has changed.\n\n' +
        'If that was you, sign in here instead:\n{{signInUrl}}\n\n' +
        'If you cannot remember the password, reset it here:\n{{resetUrl}}\n\n' +
        'If it was not you, ignore this email. Whoever filled the form in was not told\n' +
        'that this address is registered, and they have no access to the account.\n',
    },
    [NotificationEvent.CUSTOMER_REGISTRATION_PENDING]: {
      subject: 'Your {{businessName}} account is being reviewed',
      body:
        'Hello {{recipientName}},\n\n' +
        'Thank you - your email address is confirmed.\n\n' +
        'Because we price and set terms per customer, a colleague reviews every new\n' +
        'account before it can order. You will get an email as soon as yours is open,\n' +
        'and there is nothing else for you to do in the meantime.\n\n' +
        'Questions? Write to {{supportEmail}}.\n',
    },
    [NotificationEvent.CUSTOMER_REGISTRATION_APPROVED]: {
      subject: 'Your {{businessName}} account is open',
      body:
        'Hello {{recipientName}},\n\n' +
        'Your account is approved. Sign in with the password you chose when you\n' +
        'registered:\n{{signInUrl}}\n\n' +
        'Questions? Write to {{supportEmail}}.\n',
    },
    [NotificationEvent.BUYER_COMPANY_EMAIL_CODE]: LOCALISED_FRAME,
    [NotificationEvent.BUYER_COMPANY_INVITATION]: LOCALISED_FRAME,
    [NotificationEvent.SELLER_TEAM_INVITATION]: LOCALISED_FRAME,
    [NotificationEvent.SHIPMENT_DELIVERY_CODE]: LOCALISED_FRAME,
    [NotificationEvent.BUYER_COMPANY_SUBMITTED]: LOCALISED_FRAME,
    [NotificationEvent.BUYER_COMPANY_REVIEW_STARTED]: LOCALISED_FRAME,
    [NotificationEvent.BUYER_COMPANY_INFO_REQUESTED]: LOCALISED_FRAME,
    [NotificationEvent.BUYER_COMPANY_APPROVED]: LOCALISED_FRAME,
    [NotificationEvent.BUYER_COMPANY_REJECTED]: LOCALISED_FRAME,
    [NotificationEvent.BUYER_COMPANY_SUSPENDED]: LOCALISED_FRAME,
    [NotificationEvent.BUYER_COMPANY_REVERIFICATION]: LOCALISED_FRAME,
    [NotificationEvent.BUYER_COMPANY_RESTORED]: LOCALISED_FRAME,
    [NotificationEvent.STAFF_TEMPORARY_PASSWORD]: {
      subject: 'Your {{businessName}} staff account',
      body:
        'Hello {{recipientName}},\n\n' +
        'A staff account has been created for you on {{businessName}}.\n\n' +
        'Sign in here:\n{{signInUrl}}\n\n' +
        '  Email:              {{email}}\n' +
        '  Temporary password: {{temporaryPassword}}\n\n' +
        'This password works once, to let you in. As soon as you sign in you will be asked to\n' +
        'choose your own password, and from then on that is the one you use. Until you do,\n' +
        'the account can do nothing else.\n\n' +
        'The temporary password stops working on {{expiresAt}}. If it lapses, ask whoever set\n' +
        'the account up to issue a new one.\n\n' +
        'If you were not expecting this, please contact {{supportEmail}}.\n',
    },
    [NotificationEvent.USER_PASSWORD_RESET]: {
      subject: 'Reset your {{businessName}} password',
      body:
        'A password reset was requested for your account.\n\n' +
        'Reset it here (the link expires on {{expiresAt}}):\n{{resetUrl}}\n\n' +
        'If you did not request this, you can ignore this email; your password is unchanged.\n',
    },
    [NotificationEvent.USER_EMAIL_CHANGE_CONFIRM]: {
      subject: 'Confirm your new email address for {{businessName}}',
      body:
        'Hello {{recipientName}},\n\n' +
        'You asked to move your {{businessName}} account to this address.\n\n' +
        'Confirm it here (the link expires on {{expiresAt}}):\n{{confirmUrl}}\n\n' +
        'Nothing has changed yet. Until you confirm, the account carries on using\n' +
        '{{currentEmail}} and every order confirmation still goes there.\n\n' +
        'If you did not ask for this, ignore this email and no change will be made.\n',
    },
    [NotificationEvent.USER_EMAIL_CHANGE_REQUESTED]: {
      subject: 'Someone asked to change the email address on your {{businessName}} account',
      body:
        'Hello {{recipientName}},\n\n' +
        'A request was made to move your {{businessName}} account to {{pendingEmail}}.\n\n' +
        'Nothing has changed yet. A confirmation link was sent to that address, and the\n' +
        'account keeps using this one until the link is followed.\n\n' +
        'If that was you, there is nothing to do here.\n\n' +
        'If it was not you, change your password now and the pending request stops\n' +
        'being usable: {{passwordUrl}}\n\n' +
        'Either way, please tell {{supportEmail}} if you were not expecting this.\n',
    },
    [NotificationEvent.USER_PHONE_CHANGE_CONFIRM]: {
      subject: 'Confirm the new telephone number on your {{businessName}} account',
      body:
        'Hello {{recipientName}},\n\n' +
        'You asked to change the telephone number on your {{businessName}} account to\n' +
        '{{pendingPhone}}.\n\n' +
        'Confirm it here (the link expires on {{expiresAt}}):\n{{confirmUrl}}\n\n' +
        'This link is sent to your email address rather than to the number itself, so\n' +
        'confirming it proves the change came from you.\n\n' +
        'If you did not ask for this, ignore this email and the number is unchanged.\n',
    },
    [NotificationEvent.USER_ACCOUNT_DEACTIVATED]: {
      subject: 'Your {{businessName}} account has been closed',
      body:
        'Hello {{recipientName}},\n\n' +
        'Your {{businessName}} account was closed at your request and can no longer be\n' +
        'signed in to.\n\n' +
        'What was done with it: {{summary}}\n\n' +
        'Your order history and invoices are kept, because tax law requires them to be.\n' +
        'Nothing else has been deleted — if you want the account reopened, or you want\n' +
        'your data erased, write to {{supportEmail}}.\n\n' +
        'If you did not ask for this, contact {{supportEmail}} immediately.\n',
    },
    [NotificationEvent.USER_NEW_SIGN_IN]: {
      subject: 'New sign-in to your {{businessName}} account',
      body:
        'Hello {{recipientName}},\n\n' +
        'Your {{businessName}} account was just signed in to from a device or network it\n' +
        'has not used recently.\n\n' +
        '  Device:   {{device}}\n' +
        '  Address:  {{ipAddress}}\n' +
        '  When:     {{signedInAt}}\n\n' +
        'If that was you, there is nothing to do.\n\n' +
        'If it was not you, change your password now - that signs the account out\n' +
        'everywhere - and switch on two-step sign-in in your account settings:\n' +
        '{{passwordUrl}}\n\n' +
        'Questions? Write to {{supportEmail}}.\n',
    },
    [NotificationEvent.USER_MFA_DISABLED]: {
      subject: 'Two-step sign-in was switched off on your {{businessName}} account',
      body:
        'Hello {{recipientName}},\n\n' +
        'Two-step sign-in was switched off on your {{businessName}} account at {{changedAt}}.\n' +
        'From now on, your password alone signs you in.\n\n' +
        'If you did not do this, change your password now and contact {{supportEmail}}.\n',
    },
    [NotificationEvent.ORDER_SUBMITTED]: {
      subject: 'Order {{orderNumber}} received',
      body:
        'Hello {{recipientName}},\n\n' +
        'We have received order {{orderNumber}} for {{orderTotal}}.\n' +
        'Current status: {{orderStatus}}.\n\n' +
        'You can track it here:\n{{orderUrl}}\n',
    },
    [NotificationEvent.ORDER_CONFIRMED]: {
      subject: 'Order {{orderNumber}} confirmed',
      body:
        'Hello {{recipientName}},\n\n' +
        'Payment for order {{orderNumber}} ({{orderTotal}}) has been confirmed.\n\n' +
        'Details:\n{{orderUrl}}\n',
    },
    [NotificationEvent.PAYMENT_LINK]: {
      subject: 'Payment requested for order {{orderNumber}}',
      body:
        'Hello {{recipientName}},\n\n' +
        'A payment of {{amount}} is requested for order {{orderNumber}}.\n\n' +
        'Pay securely here (this link is single-use and expires on {{expiresAt}}):\n' +
        '{{paymentUrl}}\n\n' +
        'Do not forward this email; the link authorises a payment.\n',
    },
    [NotificationEvent.DATA_REQUEST_READY]: {
      subject: 'Your copy of the data we hold about you is ready',
      body:
        'Hello {{recipientName}},\n\n' +
        'You asked for a copy of the personal data {{businessName}} holds about you. It is ' +
        'ready to download from your account:\n\n' +
        '{{accountUrl}}\n\n' +
        'The link stops working {{hours}} hours from now ({{expiresAt}}). It is kept short ' +
        'because the file contains everything we hold about you; ask again at any time and a ' +
        'fresh copy will be prepared.\n\n' +
        'If you did not ask for this, tell us at {{supportEmail}} straight away.\n',
    },
    [NotificationEvent.DATA_REQUEST_ERASED]: {
      subject: 'Your data has been erased',
      body:
        'Hello,\n\n' +
        'You asked {{businessName}} to erase the personal data we hold about you. That is ' +
        'now done.\n\n' +
        '{{summary}}\n\n' +
        'This is the last message we will send to this address; it is no longer linked to ' +
        'any account here.\n',
    },
    [NotificationEvent.DATA_REQUEST_REJECTED]: {
      subject: 'About your data request',
      body:
        'Hello {{recipientName}},\n\n' +
        'We have reviewed your {{requestType}} request and are not able to action it. The ' +
        'reason is:\n\n' +
        '{{reason}}\n\n' +
        'If you disagree, reply to {{supportEmail}} and we will look at it again. You also ' +
        'have the right to complain to your national data protection authority, and to seek ' +
        'a judicial remedy.\n',
    },
    [NotificationEvent.INVENTORY_LOW_STOCK]: {
      subject: 'Low stock: {{sku}}',
      body:
        '{{productName}} ({{sku}}) is at {{availableQty}} units, ' +
        'at or below its reorder threshold of {{threshold}}.\n',
    },

    // --- The ERP connection --------------------------------------------
    //
    // These go to STAFF, not to the customer. The ERP is the business's own
    // system, and a customer who has paid for an order does not need to hear
    // that a warehouse system somewhere has not acknowledged it yet - their
    // order is confirmed and their money is accounted for either way. Every one
    // of them names what somebody has to go and do.
    [NotificationEvent.ERP_CONNECTION_SUSPENDED]: {
      subject: 'ERP connection "{{connectionName}}" has stopped',
      body:
        'Hello {{recipientName}},\n\n' +
        'The ERP connection "{{connectionName}}" has been switched off after repeated ' +
        'failures.\n\n' +
        'What happened: {{reason}}\n\n' +
        'Nothing has been lost. Orders are being taken and recorded as usual, and each one ' +
        'will be sent to the ERP once the connection is working again.\n\n' +
        'To restart it, open Settings > ERP, check the settings, and run a connection ' +
        'test:\n{{connectionUrl}}\n',
    },
    [NotificationEvent.ERP_SYNC_FAILED]: {
      subject: 'Stock synchronisation finished with {{failedCount}} problems',
      body:
        'Hello {{recipientName}},\n\n' +
        'The stock synchronisation for "{{connectionName}}" read {{processedCount}} records ' +
        'and could not apply {{failedCount}} of them.\n\n' +
        'The records that did apply have been updated. The ones that did not are listed with ' +
        'their reasons here:\n{{connectionUrl}}\n\n' +
        'The most common cause is a field in the ERP that has been renamed since the mapping ' +
        'was set up.\n',
    },
    [NotificationEvent.ERP_ORDER_DELAYED]: {
      subject: 'Order {{orderNumber}} is paid - not yet in the ERP',
      body:
        'Hello {{recipientName}},\n\n' +
        'Order {{orderNumber}} has been paid for and is confirmed. The ERP has not accepted ' +
        'it yet.\n\n' +
        'Retries are running on their own, and the order is sent under a single reference the ' +
        'ERP will accept only once - so no attempt can produce a second copy or a second ' +
        'charge. The customer has not been told anything, because from where they stand the ' +
        'order is confirmed.\n\n' +
        'You can follow it here:\n{{orderUrl}}\n',
    },
    [NotificationEvent.ERP_ORDER_ABANDONED]: {
      subject: 'Order {{orderNumber}} could not reach the ERP',
      body:
        'Hello {{recipientName}},\n\n' +
        'Order {{orderNumber}} is paid and confirmed, but after several attempts the ERP has ' +
        'not accepted it. Automatic retries have stopped.\n\n' +
        'What the ERP reported: {{reason}}\n\n' +
        'The payment stands and the order is real - it is simply not in the ERP, so the ' +
        'warehouse cannot see it. Somebody needs to look at that.\n\n' +
        'Once it is fixed, send it again from the order page. It is sent under the original ' +
        'reference, so nobody is charged twice and the ERP cannot end up with two ' +
        'copies:\n{{orderUrl}}\n',
    },

    // --- The buyer's own organisation and ERP ---------------------------
    //
    // Written for somebody who does not work here. No internal vocabulary, no
    // status enum names, and every one of them names the screen to open and
    // the thing to do on it - because the person reading these is the only
    // person who can fix any of them.
    [NotificationEvent.ORGANIZATION_INVITATION]: {
      subject: 'Join {{organizationName}} on {{businessName}}',
      body:
        'Hello,\n\n' +
        '{{inviterName}} has invited you to join {{organizationName}} on {{businessName}} ' +
        'as {{roleLabel}}.\n\n' +
        'That gives you access to the ERP integration your organisation has set up here - ' +
        'the connection between your own purchasing system and your account with us.\n\n' +
        'Accept the invitation:\n{{acceptUrl}}\n\n' +
        'The link stops working on {{expiresAt}}. If you were not expecting this, ignore ' +
        'it - nothing happens until somebody follows the link.\n',
    },
    [NotificationEvent.CUSTOMER_ERP_ACTION_REQUIRED]: {
      subject: 'Your {{connectionName}} connection needs attention',
      body:
        'Hello {{recipientName}},\n\n' +
        'The connection between your {{systemLabel}} and your {{businessName}} account has ' +
        'stopped and is waiting for somebody at your end.\n\n' +
        'What is needed: {{reason}}\n\n' +
        'Nothing has been lost. Orders are being taken and recorded as usual, and each one ' +
        'that could not be sent is held and will go through under its original reference ' +
        'once the connection is working - so no order can end up in your system twice.\n\n' +
        'Open the connection here:\n{{connectionUrl}}\n',
    },
    [NotificationEvent.CUSTOMER_ERP_SUSPENDED]: {
      subject: 'Your {{connectionName}} connection has stopped',
      body:
        'Hello {{recipientName}},\n\n' +
        'We have stopped calling your {{systemLabel}} after repeated failures.\n\n' +
        'What we saw: {{reason}}\n\n' +
        'This is usually a credential that has expired or a system that is not reachable ' +
        'from the internet. Your orders here are unaffected.\n\n' +
        'Run Test connection when it is ready, and we will start again from where we left ' +
        'off:\n{{connectionUrl}}\n',
    },
    [NotificationEvent.CUSTOMER_ERP_APPROVAL_NEEDED]: {
      subject: 'Approval needed before {{summary}}',
      body:
        'Hello {{recipientName}},\n\n' +
        'Something is waiting for a decision before it is sent to your {{systemLabel}}:\n\n' +
        '{{summary}}\n\n' +
        'Nothing has been sent. It will wait until {{expiresAt}}, and after that it is ' +
        'cancelled rather than sent late.\n\n' +
        'Approve or decline it here:\n{{connectionUrl}}\n',
    },
    [NotificationEvent.CUSTOMER_ERP_EVENT_FAILED]: {
      subject: '{{summary}} could not be sent to your {{systemLabel}}',
      body:
        'Hello {{recipientName}},\n\n' +
        '{{summary}} could not be sent to your {{systemLabel}}, and the automatic retries ' +
        'have finished.\n\n' +
        'What your system reported: {{reason}}\n\n' +
        'The order itself is fine - it is placed, paid where payment was due, and it will ' +
        'be delivered. What has not happened is the copy of it in your own system.\n\n' +
        'When the cause is fixed, press Retry on this item. It is sent under its original ' +
        'reference, so retrying cannot produce a second purchase order:\n{{connectionUrl}}\n',
    },

    // --- Auto-pay ------------------------------------------------------
    [NotificationEvent.AUTOPAY_CHARGED]: {
      subject: '{{amount}} paid automatically for order {{orderNumber}}',
      body:
        'Hello {{recipientName}},\n\n' +
        '{{amount}} has been charged to your saved {{cardLabel}} for order {{orderNumber}}.\n\n' +
        'This was an automatic payment, taken under the authorisation you gave on ' +
        '{{consentDate}}.\n\n' +
        'You can change your limits or switch automatic payment off at any time:\n' +
        '{{settingsUrl}}\n',
    },
    [NotificationEvent.AUTOPAY_FAILED]: {
      subject: 'Automatic payment for order {{orderNumber}} did not go through',
      body:
        'Hello {{recipientName}},\n\n' +
        'We could not take {{amount}} from your saved {{cardLabel}} for order ' +
        '{{orderNumber}}.\n\n' +
        'Reason: {{reason}}\n\n' +
        'Nothing has been charged. You can pay for this order directly, or update your saved ' +
        'card and we will try again:\n{{orderUrl}}\n',
    },
    [NotificationEvent.AUTOPAY_APPROVAL_NEEDED]: {
      subject: 'Order {{orderNumber}} needs your approval before it is paid',
      body:
        'Hello {{recipientName}},\n\n' +
        'Order {{orderNumber}} comes to {{amount}}, which is above the {{threshold}} you asked ' +
        'to be consulted about.\n\n' +
        'Nothing has been charged and nothing will be until you say so.\n\n' +
        'Review and approve it here:\n{{orderUrl}}\n',
    },
    [NotificationEvent.SCHEDULE_REMINDER]: {
      subject: 'Upcoming recurring order on {{dueDate}}',
      body:
        'Hello {{recipientName}},\n\n' +
        'Your recurring order "{{scheduleName}}" is due on {{dueDate}}.\n' +
        'Estimated amount: {{estimatedTotal}}.\n' +
        '{{paymentLine}}\n\n' +
        'The final amount is recalculated against current prices, tax, stock and ' +
        'your purchasing limits at the time the order is created.\n\n' +
        'You can change, skip or cancel this delivery until {{editableUntil}}.\n\n' +
        'Manage this schedule:\n{{scheduleUrl}}\n',
    },

    [NotificationEvent.SCHEDULE_ACTIVATED]: {
      subject: 'Your scheduled order "{{scheduleName}}" is set up',
      body:
        'Hello {{recipientName}},\n\n' +
        'Your scheduled order "{{scheduleName}}" is now active.\n\n' +
        'Schedule: {{summary}}\n' +
        'First delivery: {{nextDate}}\n' +
        'Estimated amount each time: {{estimatedTotal}}\n' +
        'Paying with: {{paymentDescription}}\n\n' +
        'We will email you before each order is placed, and you can change, skip ' +
        'or cancel it at any time up to {{cutoffDescription}} beforehand.\n\n' +
        'Manage this schedule:\n{{scheduleUrl}}\n',
    },

    [NotificationEvent.SCHEDULE_RESUMED]: {
      subject: 'Your scheduled order "{{scheduleName}}" has resumed',
      body:
        'Hello {{recipientName}},\n\n' +
        'Your scheduled order "{{scheduleName}}" has been resumed.\n' +
        'Next delivery: {{nextDate}}\n\n' +
        'Manage this schedule:\n{{scheduleUrl}}\n',
    },

    [NotificationEvent.SCHEDULE_CANCELLED]: {
      subject: 'Your scheduled order "{{scheduleName}}" has been cancelled',
      body:
        'Hello {{recipientName}},\n\n' +
        'Your scheduled order "{{scheduleName}}" has been cancelled and nothing ' +
        'further will be charged for it.\n\n' +
        '{{reason}}\n',
    },

    [NotificationEvent.SCHEDULE_COMPLETED]: {
      subject: 'Your scheduled order "{{scheduleName}}" has finished',
      body:
        'Hello {{recipientName}},\n\n' +
        'Your scheduled order "{{scheduleName}}" has run for the last time and is ' +
        'now complete. Nothing further will be charged.\n\n' +
        'Deliveries made: {{occurrenceCount}}\n',
    },

    // The order of the sentences here is deliberate. "We have not charged you"
    // comes before the numbers, because a customer who reads "the price has
    // changed" assumes they have already paid the new one.
    [NotificationEvent.SCHEDULE_PRICE_CHANGED]: {
      subject: 'Action needed: the price of your scheduled order has changed',
      body:
        'Hello {{recipientName}},\n\n' +
        'We have NOT charged you, and this delivery is on hold.\n\n' +
        'The amount for your scheduled order "{{scheduleName}}" has changed by ' +
        'more than the {{allowedChange}} you approved:\n\n' +
        '  Previously quoted: {{quotedTotal}}\n' +
        '  Now:               {{estimatedTotal}}\n\n' +
        'Please review and confirm the new amount to let this delivery go ahead:\n' +
        '{{scheduleUrl}}\n',
    },

    [NotificationEvent.SCHEDULE_STOCK_UNAVAILABLE]: {
      subject: 'Your scheduled order for {{dueDate}} is on hold',
      body:
        'Hello {{recipientName}},\n\n' +
        'We have NOT charged you.\n\n' +
        'Your scheduled order "{{scheduleName}}", due on {{dueDate}}, cannot be ' +
        'supplied in full at the moment:\n\n' +
        '{{reason}}\n\n' +
        'We have not substituted anything, because your schedule does not ' +
        'authorise it. Your subscription is still active and the next delivery ' +
        'will go ahead as normal.\n\n' +
        'To change the items, or to save a replacement product for next time:\n' +
        '{{scheduleUrl}}\n',
    },

    [NotificationEvent.SCHEDULE_PAYMENT_ACTION_REQUIRED]: {
      subject: 'Action needed: confirm the payment for your scheduled order',
      body:
        'Hello {{recipientName}},\n\n' +
        'Your bank has asked you to confirm the payment for your scheduled order ' +
        '"{{scheduleName}}" ({{estimatedTotal}}).\n\n' +
        'Until you do, this delivery is on hold. Nothing has been charged.\n\n' +
        'Confirm the payment here:\n{{paymentUrl}}\n\n' +
        'If it is not confirmed by {{expiresAt}}, this delivery will be skipped ' +
        'and the next one will go ahead as normal.\n',
    },

    [NotificationEvent.SCHEDULE_OCCURRENCE_SKIPPED]: {
      subject: 'Your delivery on {{dueDate}} was skipped',
      body:
        'Hello {{recipientName}},\n\n' +
        '{{reason}}\n\n' +
        'Your scheduled order "{{scheduleName}}" is still active. The next ' +
        'delivery is due on {{nextDate}}.\n\n' +
        'Manage this schedule:\n{{scheduleUrl}}\n',
    },

    // Says nothing about the customer needing to act, because they do not.
    [NotificationEvent.SCHEDULE_ERP_DELAYED]: {
      subject: 'Your order {{orderNumber}} is confirmed - dispatch is delayed',
      body:
        'Hello {{recipientName}},\n\n' +
        'Your order {{orderNumber}} is paid and confirmed.\n\n' +
        'Passing it to our warehouse system is taking longer than usual, so ' +
        'dispatch may be later than normal. We are on it and there is nothing ' +
        'you need to do.\n\n' +
        'You can follow the order here:\n{{orderUrl}}\n',
    },
    [NotificationEvent.PREORDER_SUBMITTED]: {
      subject: 'Preorder {{requestNumber}} sent to {{sellerName}}',
      body:
        'Hello {{recipientName}},\n\n' +
        'Your preorder request {{requestNumber}} for {{quantity}} of {{productName}} has been ' +
        'sent to {{sellerName}}, with delivery requested for {{requestedDate}}.\n\n' +
        'Nothing has been charged. {{sellerName}} will confirm what they can supply, at what ' +
        'price and by when, and you will then be asked to confirm.\n\n' +
        'Follow it here:\n{{preorderUrl}}\n',
    },
    [NotificationEvent.PREORDER_SELLER_ACCEPTED]: {
      subject: 'Preorder {{requestNumber}}: {{sellerName}} accepted - please confirm',
      body:
        'Hello {{recipientName}},\n\n' +
        '{{sellerName}} can supply {{quantity}} of {{productName}} by {{committedDate}}, at ' +
        '{{unitPrice}} per piece ({{total}} in total).\n\n' +
        'Nothing has been charged. The preorder goes ahead only when you confirm, before ' +
        '{{expiresAt}}:\n{{preorderUrl}}\n',
    },
    [NotificationEvent.PREORDER_SELLER_COUNTERED]: {
      subject: 'Preorder {{requestNumber}}: {{sellerName}} proposed different terms',
      body:
        'Hello {{recipientName}},\n\n' +
        '{{sellerName}} has proposed {{quantity}} of {{productName}} by {{committedDate}}, at ' +
        '{{unitPrice}} per piece ({{total}} in total).\n\n' +
        'Nothing has been charged. Review and confirm or decline before {{expiresAt}}:\n' +
        '{{preorderUrl}}\n',
    },
    [NotificationEvent.PREORDER_AVAILABILITY_PROPOSED]: {
      subject: 'Preorder {{requestNumber}}: {{sellerName}} proposed a delivery schedule',
      body:
        'Hello {{recipientName}},\n\n' +
        'The complete quantity you asked for ({{quantity}} of {{productName}}) is not ' +
        'available right now. {{sellerName}} has proposed this instead:\n\n' +
        '{{schedule}}\n\n' +
        'Price per piece: {{unitPrice}}. Total before tax: {{total}}.\n\n' +
        'Nothing has been charged and nothing is confirmed until you accept. Review it and ' +
        'accept, reject or ask for a change before {{expiresAt}}:\n{{preorderUrl}}\n',
    },
    [NotificationEvent.PREORDER_STOCK_CHANGED]: {
      subject: 'Preorder {{requestNumber}}: the stock changed - a new offer is coming',
      body:
        'Hello {{recipientName}},\n\n' +
        'You accepted the offer on preorder {{requestNumber}} for {{productName}}, but the ' +
        'stock it was based on is no longer available.\n\n' +
        'Nothing has been reserved or charged. {{sellerName}} has been asked to send you a ' +
        'revised offer, and you will be told as soon as they do:\n{{preorderUrl}}\n',
    },
    [NotificationEvent.PREORDER_REJECTED]: {
      subject: 'Preorder {{requestNumber}} was declined',
      body:
        'Hello {{recipientName}},\n\n' +
        '{{sellerName}} cannot supply your preorder {{requestNumber}} for {{productName}}.\n\n' +
        'Their reason: {{reason}}\n\nNothing was charged.\n',
    },
    [NotificationEvent.PREORDER_PAYMENT_REQUIRED]: {
      subject: 'Preorder {{requestNumber}} agreed - order {{orderNumber}} is ready to pay',
      body:
        'Hello {{recipientName}},\n\n' +
        "Nothing has been charged yet. You confirmed {{sellerName}}'s terms, and order " +
        '{{orderNumber}} for {{total}} is waiting for payment.\n\n' +
        'Pay for it here before {{expiresAt}}, or the capacity held for you is released:\n' +
        '{{orderUrl}}\n',
    },
    [NotificationEvent.PREORDER_CONFIRMED]: {
      subject: 'Preorder {{requestNumber}} is confirmed',
      body:
        'Hello {{recipientName}},\n\n' +
        'Payment for order {{orderNumber}} was received and your preorder {{requestNumber}} ' +
        'is confirmed, for delivery by {{committedDate}}.\n\n{{preorderUrl}}\n',
    },
    [NotificationEvent.PREORDER_PRODUCTION_STARTED]: {
      subject: 'Preorder {{requestNumber}}: production has started',
      body:
        'Hello {{recipientName}},\n\n' +
        '{{sellerName}} has started production of your preorder {{requestNumber}}, due by ' +
        '{{committedDate}}.\n\n{{preorderUrl}}\n',
    },
    [NotificationEvent.PREORDER_READY]: {
      subject: 'Preorder {{requestNumber}} is ready for dispatch',
      body:
        'Hello {{recipientName}},\n\n' +
        'Your preorder {{requestNumber}} is made and ready for dispatch. You can follow its ' +
        'delivery on order {{orderNumber}}:\n{{orderUrl}}\n',
    },
    [NotificationEvent.PREORDER_EXPIRED]: {
      subject: 'Preorder {{requestNumber}} has expired',
      body:
        'Hello {{recipientName}},\n\n' +
        'Preorder {{requestNumber}} for {{productName}} expired because {{reason}}. ' +
        'Nothing was charged, and you can send a new request from the product page.\n',
    },
    [NotificationEvent.PREORDER_CANCELLED]: {
      subject: 'Preorder {{requestNumber}} was cancelled',
      body:
        'Hello {{recipientName}},\n\n' +
        'Preorder {{requestNumber}} for {{productName}} was cancelled: {{reason}}\n',
    },
    [NotificationEvent.SELLER_INVOICE_ISSUED]: {
      subject: 'Invoice {{invoiceNumber}} from {{sellerName}} for order {{orderNumber}}',
      body:
        'Hello {{recipientName}},\n\n' +
        '{{sellerName}} has issued invoice {{invoiceNumber}} for {{total}}, for the goods in ' +
        'consignment {{shipmentReference}} of your order {{orderNumber}}.\n\n' +
        'Download it from the order:\n{{orderUrl}}\n',
    },
    [NotificationEvent.PREORDER_DELIVERY_RISK]: {
      subject: 'Preorder {{requestNumber}} may miss {{committedDate}}',
      body:
        'Hello {{recipientName}},\n\n' +
        'Your preorder {{requestNumber}} is due by {{committedDate}} and is not yet ready for ' +
        'dispatch. {{sellerName}} has been asked to update you.\n\n{{preorderUrl}}\n',
    },
    // --- Preorder chat. Each says a message is WAITING and links to it; none
    // carries the message itself. A reply may name a price, and an inbox that
    // is forwarded, previewed on a lock screen or read by a colleague is not
    // where it belongs. The link opens the conversation after sign-in.
    [NotificationEvent.PREORDER_CHAT_REPLY]: {
      subject: '{{businessName}} replied about {{productName}}',
      body:
        'Hello {{recipientName}},\n\n' +
        'The {{businessName}} preorder team has replied to your question about {{productName}}.\n\n' +
        'Read the reply and answer here:\n{{chatUrl}}\n',
    },
    [NotificationEvent.PREORDER_CHAT_PROPOSAL]: {
      subject: '{{businessName}} sent you a preorder proposal for {{productName}}',
      body:
        'Hello {{recipientName}},\n\n' +
        'The {{businessName}} preorder team has prepared a preorder proposal for {{productName}}. ' +
        'Nothing has been ordered or charged: review it, and send it as a preorder request if it ' +
        'suits you.\n\n{{chatUrl}}\n',
    },
    [NotificationEvent.PREORDER_CHAT_RESPONSE_REQUESTED]: {
      subject: '{{businessName}} is waiting for your answer about {{productName}}',
      body:
        'Hello {{recipientName}},\n\n' +
        'The {{businessName}} preorder team needs a little more information about {{productName}} ' +
        'before they can go further.\n\n{{chatUrl}}\n',
    },
    [NotificationEvent.PREORDER_CHAT_RESOLVED]: {
      subject: 'Your question about {{productName}} has been answered',
      body:
        'Hello {{recipientName}},\n\n' +
        'The {{businessName}} preorder team has marked your conversation about {{productName}} as ' +
        'resolved. Write in it again at any time and it reopens.\n\n{{chatUrl}}\n',
    },
    [NotificationEvent.PREORDER_CHAT_ASSIGNED]: {
      subject: 'A preorder chat has been assigned to you',
      body:
        'Hello,\n\n' +
        'A preorder chat about {{productName}} has been assigned to you by {{assignedBy}}.\n\n' +
        'Open it in the console:\n{{consoleUrl}}\n',
    },
    // --- Support requests. The reference and a link; never the message.
    [NotificationEvent.SUPPORT_TICKET_RECEIVED]: {
      subject: 'We have your support request {{reference}}',
      body:
        'Hello {{recipientName}},\n\n' +
        'Thank you for contacting {{businessName}} support. Your request {{reference}} has ' +
        'reached our team, and we will reply as soon as we can.\n\n' +
        'You can read it and add to it here:\n{{ticketUrl}}\n',
    },
    [NotificationEvent.SUPPORT_TICKET_REPLY]: {
      subject: '{{businessName}} support replied to {{reference}}',
      body:
        'Hello {{recipientName}},\n\n' +
        'The {{businessName}} support team has replied to your request {{reference}}.\n\n' +
        'Read the reply and answer here:\n{{ticketUrl}}\n',
    },
    [NotificationEvent.SUPPORT_TICKET_NEW_FOR_TEAM]: {
      subject: 'New support request {{reference}}',
      body:
        'Hello,\n\n' +
        'A new support request {{reference}} ({{category}}) has arrived.\n\n' +
        'Open it in the console:\n{{consoleUrl}}\n',
    },
    // --- Disputes. The reference, the outcome and a link; never the messages.
    [NotificationEvent.DISPUTE_RECEIVED]: {
      subject: 'We have your claim {{reference}}',
      body:
        'Hello {{recipientName}},\n\n' +
        'Your claim {{reference}} about order {{orderNumber}} has reached {{businessName}}. ' +
        'We will decide it by {{decisionDueAt}} at the latest.\n\n' +
        'Follow it and add evidence here:\n{{disputeUrl}}\n',
    },
    [NotificationEvent.DISPUTE_UPDATE]: {
      subject: 'There is news on your claim {{reference}}',
      body:
        'Hello {{recipientName}},\n\n' +
        'Something has happened on your claim {{reference}} about order {{orderNumber}}.\n\n' +
        'Read it here:\n{{disputeUrl}}\n',
    },
    [NotificationEvent.DISPUTE_DECIDED]: {
      subject: 'Your claim {{reference}} has been decided',
      body:
        'Hello {{recipientName}},\n\n' +
        '{{businessName}} has decided your claim {{reference}} about order {{orderNumber}}: ' +
        '{{outcome}}.\n\n' +
        'The reasons, and how to appeal if you disagree, are here:\n{{disputeUrl}}\n',
    },
    [NotificationEvent.SUPPORT_TICKET_ASSIGNED]: {
      subject: 'Support request {{reference}} has been assigned to you',
      body:
        'Hello,\n\n' +
        'Support request {{reference}} has been assigned to you by {{assignedBy}}.\n\n' +
        'Open it in the console:\n{{consoleUrl}}\n',
    },
    [NotificationEvent.RETURN_REQUESTED]: {
      subject: 'We have your return request {{returnReference}} for order {{orderNumber}}',
      body:
        'Hello {{recipientName}},\n\n' +
        'Your request to return items from order {{orderNumber}} has reached us.\n\n' +
        'We will tell you as soon as it has been reviewed. Follow it here:\n{{returnUrl}}\n',
    },
    [NotificationEvent.RETURN_APPROVED]: {
      subject: 'Your return {{returnReference}} is approved',
      body:
        'Hello {{recipientName}},\n\n' +
        'Your return of items from order {{orderNumber}} has been approved.\n\n' +
        'How to send them back:\n{{instructions}}\n\n' +
        'Details, and any return label:\n{{returnUrl}}\n',
    },
    [NotificationEvent.RETURN_REJECTED]: {
      subject: 'Your return {{returnReference}} could not be accepted',
      body:
        'Hello {{recipientName}},\n\n' +
        'We are sorry: your return of items from order {{orderNumber}} could not be accepted.\n\n' +
        'The reason given: {{decisionReason}}\n\n' +
        'If you think this is wrong, contact us from the order page:\n{{returnUrl}}\n',
    },
    [NotificationEvent.RETURN_INSTRUCTIONS]: {
      subject: 'Return instructions for {{returnReference}}',
      body:
        'Hello {{recipientName}},\n\n' +
        'The instructions for sending back items from order {{orderNumber}} have been updated.\n\n' +
        '{{instructions}}\n\n' +
        'Details, and any return label:\n{{returnUrl}}\n',
    },
    [NotificationEvent.RETURN_RECEIVED]: {
      subject: 'Your return {{returnReference}} has arrived',
      body:
        'Hello {{recipientName}},\n\n' +
        'The items you sent back from order {{orderNumber}} have arrived. They will be inspected next.\n\n' +
        'Follow it here:\n{{returnUrl}}\n',
    },
    [NotificationEvent.RETURN_INSPECTED]: {
      subject: 'Your return {{returnReference}} has been inspected',
      body:
        'Hello {{recipientName}},\n\n' +
        'The items you sent back from order {{orderNumber}} have been inspected. {{nextStep}}\n\n' +
        'Follow it here:\n{{returnUrl}}\n',
    },
    [NotificationEvent.RETURN_COMPLETED]: {
      subject: 'Your return {{returnReference}} is complete',
      body:
        'Hello {{recipientName}},\n\n' +
        'Your return of items from order {{orderNumber}} is complete. {{outcome}}\n\n' +
        'Details:\n{{returnUrl}}\n',
    },
    [NotificationEvent.RETURN_NEW_FOR_SELLER]: {
      subject: 'Return requested on your order {{sellerOrderNumber}}',
      body:
        'Hello,\n\n' +
        'A buyer has asked to return items from your order {{sellerOrderNumber}}.\n\n' +
        'Reason: {{reasonCode}}\n\n' +
        'Tell the marketplace whether you accept it, and how the goods should come back, in Seller Hub:\n{{sellerUrl}}\n',
    },
    [NotificationEvent.RETURN_UPDATE_FOR_SELLER]: {
      subject: 'Return {{returnReference}} on order {{sellerOrderNumber}}: {{step}}',
      body:
        'Hello,\n\n' +
        'The return {{returnReference}} on your order {{sellerOrderNumber}} has moved on: {{step}}.\n\n' +
        '{{detail}}\n\n' +
        'Open it in Seller Hub:\n{{sellerUrl}}\n',
    },
    [NotificationEvent.RFQ_INVITATION]: {
      subject: 'Request for quotation {{rfqReference}}: {{title}}',
      body:
        'Hello,\n\n' +
        'A buyer on {{businessName}} has asked you to quote on {{rfqReference}}: {{title}}.\n\n' +
        'Quantity: {{quantity}}\n' +
        'Destination: {{destination}}\n' +
        'Quotes are accepted until {{deadline}}.\n\n' +
        'Read the requirement, ask a question, quote or decline in Seller Hub:\n{{sellerUrl}}\n',
    },
    [NotificationEvent.RFQ_UPDATE_FOR_SELLER]: {
      subject: 'Request for quotation {{rfqReference}}: {{step}}',
      body:
        'Hello,\n\n' +
        'The request for quotation {{rfqReference}} ({{title}}) has moved on: {{step}}.\n\n' +
        'Open it in Seller Hub:\n{{sellerUrl}}\n',
    },
    [NotificationEvent.RFQ_UPDATE_FOR_BUYER]: {
      subject: 'Your request {{rfqReference}}: {{step}}',
      body:
        'Hello {{recipientName}},\n\n' +
        'Your request for quotation {{rfqReference}} ({{title}}) has moved on: {{step}}.\n\n' +
        'Open it here:\n{{rfqUrl}}\n',
    },
    [NotificationEvent.SAVED_SEARCH_MATCHES]: {
      subject: 'New matches for your saved search "{{searchName}}"',
      body:
        'Hello {{recipientName}},\n\n' +
        '{{matchCount}} new or repriced products match your saved search "{{searchName}}", including: {{examples}}.\n\n' +
        'See them here:\n{{searchUrl}}\n\n' +
        'You can turn these alerts off on your saved searches page:\n{{manageUrl}}\n',
    },
  });

const FALLBACK_TEMPLATE = {
  subject: '{{businessName}} notification',
  body: 'You have a new notification from {{businessName}}.\n',
};

/** Recorded on every WhatsApp row: this product ships no WhatsApp provider. */
export const WHATSAPP_NO_PROVIDER = 'No WhatsApp provider is configured; nothing was sent.';

/**
 * Every built-in event with the wording it uses when nobody has customised
 * it. The admin template screen lists these beside the customised rows.
 */
export function notificationCatalogue(): { eventKey: string; subject: string; body: string }[] {
  return [...new Set(Object.values(NotificationEvent))].sort().map((eventKey) => {
    const template = DEFAULT_TEMPLATES[eventKey] ?? FALLBACK_TEMPLATE;
    return { eventKey, subject: template.subject, body: template.body };
  });
}

/**
 * Queue a notification.
 *
 * Pass `tx` to make it part of the caller's transaction. Where a transaction is
 * used, the delivery job is dispatched by the outbox drain rather than here -
 * enqueuing a job for an uncommitted row would let the worker read it before it
 * exists.
 */
export async function enqueueNotification(
  input: EnqueueNotificationInput,
  tx?: unknown,
): Promise<string | null> {
  const client =
    (tx as
      | Pick<typeof prisma, 'notificationOutbox' | 'notificationSetting' | 'businessProfile'>
      | undefined) ?? prisma;

  const setting = await client.notificationSetting.findUnique({
    where: { eventKey: input.eventKey },
  });

  if (setting !== null && !setting.isActive) {
    logger.debug({ eventKey: input.eventKey }, 'notification suppressed by settings');
    return null;
  }

  const template =
    setting !== null
      ? { subject: setting.subjectTemplate, body: setting.bodyTemplate }
      : (DEFAULT_TEMPLATES[input.eventKey] ?? FALLBACK_TEMPLATE);

  /*
   * Who the e-mail is from and where to write back, from the operator's own
   * business profile - every buyer of this software runs their own
   * deployment, so neither may be a literal. A caller may still pass its own
   * in `input.variables` (a seller's shop, say), which wins below. With no
   * profile row at all the name is the product's, because there is no shop's
   * name to be had, and the address is the one this deployment sends from.
   */
  const needsProfile =
    input.variables?.['businessName'] === undefined ||
    input.variables['supportEmail'] === undefined;
  const profile = needsProfile
    ? await client.businessProfile.findFirst({ select: { displayName: true, supportEmail: true } })
    : null;

  const variables: TemplateVariables = {
    recipientName: input.recipientName ?? 'there',
    businessName: marketplaceNameFrom(profile?.displayName),
    supportEmail: profile?.supportEmail ?? env.EMAIL_FROM_ADDRESS,
    ...input.variables,
  };

  const id = newId();

  /*
   * Channels (Master row 76). With no settings row every event goes by email
   * and is listed in the notification centre, as before. With email switched
   * off, an event the operator still wants in-app is recorded as an IN_APP row
   * that is SENT on arrival - nothing is delivered, and no delivery job is
   * queued for it - so the customer's notification centre can still list it.
   */
  const emailOn = setting === null || setting.emailEnabled;
  const inAppOnly = !emailOn && setting?.inAppEnabled === true;
  if (!emailOn && !inAppOnly) {
    logger.debug({ eventKey: input.eventKey }, 'notification has no enabled channel');
    return null;
  }

  const row = {
    id,
    eventKey: input.eventKey,
    channel: inAppOnly ? ('IN_APP' as const) : ('EMAIL' as const),
    recipientEmail: input.recipientEmail,
    recipientName: input.recipientName ?? null,
    subject: renderTemplate(template.subject, variables).slice(0, 255),
    body: renderTemplate(template.body, variables),
    payloadJson: variables,
    status: inAppOnly ? ('SENT' as const) : ('PENDING' as const),
    nextAttemptAt: input.sendAt ?? new Date(),
    ...(inAppOnly ? { sentAt: input.sendAt ?? new Date() } : {}),
    ...(input.dedupeKey !== undefined ? { dedupeKey: input.dedupeKey } : {}),
    ...(input.relatedType !== undefined ? { relatedType: input.relatedType } : {}),
    ...(input.relatedId !== undefined ? { relatedId: input.relatedId } : {}),
  };

  /*
   * WhatsApp has no provider in this product. Switching it on records, per
   * notification, that it was not sent and why - SUPPRESSED, so it is never
   * retried and never handed to the email worker - rather than pretending.
   */
  const whatsappRow =
    setting?.whatsappEnabled === true
      ? {
          ...row,
          id: newId(),
          channel: 'WHATSAPP' as const,
          body: renderTemplate(setting.whatsappTemplate ?? template.body, variables),
          status: 'SUPPRESSED' as const,
          sentAt: null,
          lastError: WHATSAPP_NO_PROVIDER,
          ...(input.dedupeKey !== undefined
            ? { dedupeKey: `${input.dedupeKey}:whatsapp`.slice(0, 191) }
            : {}),
        }
      : null;

  if (input.dedupeKey !== undefined) {
    // skipDuplicates rather than a caught unique violation: inside a caller's
    // transaction a raised constraint error would abort the whole transaction.
    const result = await client.notificationOutbox.createMany({
      data: [row],
      skipDuplicates: true,
    });

    if (result.count === 0) {
      logger.debug({ dedupeKey: input.dedupeKey }, 'notification already queued; skipped');
      return null;
    }
  } else {
    await client.notificationOutbox.create({ data: row });
  }

  if (whatsappRow !== null) {
    await client.notificationOutbox.createMany({ data: [whatsappRow], skipDuplicates: true });
    logger.warn({ eventKey: input.eventKey }, 'WhatsApp is enabled for this event but no provider is configured');
  }

  // Standalone call: dispatch the delivery job immediately. Inside a
  // transaction, leave it to `dispatchPendingNotifications` after commit.
  // An in-app-only row is already SENT and has nothing to deliver.
  if (tx === undefined && !inAppOnly) {
    await queue.enqueue(
      JobType.NOTIFICATION_SEND,
      { outboxId: id },
      {
        dedupeKey: `notification:${id}`,
        ...(input.sendAt !== undefined ? { runAt: input.sendAt } : {}),
        ...(input.correlationId !== null && input.correlationId !== undefined
          ? { correlationId: input.correlationId }
          : {}),
      },
    );
  }

  return id;
}

/**
 * Dispatch delivery jobs for committed outbox rows that have none.
 *
 * Called after a transaction commits, and periodically by the worker as a
 * safety net - so a crash between commit and dispatch delays a notification
 * rather than losing it.
 */
export async function dispatchPendingNotifications(limit = 100): Promise<number> {
  const pending = await prisma.notificationOutbox.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
    select: { id: true },
    take: limit,
  });

  let dispatched = 0;
  for (const row of pending) {
    const jobId = await queue.enqueue(
      JobType.NOTIFICATION_SEND,
      { outboxId: row.id },
      { dedupeKey: `notification:${row.id}` },
    );
    if (jobId !== null) dispatched += 1;
  }

  return dispatched;
}

/** Load one outbox row for the worker. */
export async function loadOutboxRow(outboxId: string): Promise<{
  id: string;
  eventKey: string;
  recipientEmail: string | null;
  recipientName: string | null;
  subject: string;
  body: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
} | null> {
  return prisma.notificationOutbox.findUnique({
    where: { id: outboxId },
    select: {
      id: true,
      eventKey: true,
      recipientEmail: true,
      recipientName: true,
      subject: true,
      body: true,
      status: true,
      attemptCount: true,
      maxAttempts: true,
    },
  });
}

export async function markNotificationSent(
  outboxId: string,
  delivery: { provider: string; providerMessageId: string | null; durationMs: number },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.notificationOutbox.update({
      where: { id: outboxId },
      data: { status: 'SENT', sentAt: new Date(), lastError: null },
    });

    await tx.notificationDelivery.create({
      data: {
        id: newId(),
        outboxId,
        provider: delivery.provider,
        providerMessageId: delivery.providerMessageId,
        status: 'SENT',
        durationMs: delivery.durationMs,
      },
    });
  });
}

export async function markNotificationFailed(
  outboxId: string,
  error: string,
  provider: string,
): Promise<void> {
  const row = await prisma.notificationOutbox.findUnique({
    where: { id: outboxId },
    select: { attemptCount: true, maxAttempts: true },
  });

  if (row === null) throw internal(`Outbox row ${outboxId} disappeared`);

  const attempts = row.attemptCount + 1;
  const exhausted = attempts >= row.maxAttempts;

  await prisma.$transaction(async (tx) => {
    await tx.notificationOutbox.update({
      where: { id: outboxId },
      data: {
        // DEAD, not deleted: an undelivered invitation is an operational
        // problem somebody has to see and act on.
        status: exhausted ? 'DEAD' : 'PENDING',
        attemptCount: attempts,
        lastError: error.slice(0, 1000),
        nextAttemptAt: new Date(Date.now() + Math.min(300, 15 * 2 ** attempts) * 1000),
      },
    });

    await tx.notificationDelivery.create({
      data: {
        id: newId(),
        outboxId,
        provider,
        status: 'FAILED',
        errorMessage: error.slice(0, 1000),
      },
    });
  });

  if (exhausted) {
    logger.error({ outboxId, attempts }, 'notification exhausted its retries');
  }
}
