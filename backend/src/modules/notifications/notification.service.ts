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
  ORDER_SUBMITTED: 'order.submitted',
  ORDER_CONFIRMED: 'order.confirmed',
  ORDER_CANCELLED: 'order.cancelled',
  ORDER_SHIPPED: 'order.shipped',
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

/** Built-in fallbacks, used when no notification_settings row exists yet. */
const DEFAULT_TEMPLATES: Readonly<Record<string, { subject: string; body: string }>> = Object.freeze(
  {
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
        'Estimated amount: {{estimatedTotal}}.\n\n' +
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
  },
);

const FALLBACK_TEMPLATE = {
  subject: '{{businessName}} notification',
  body: 'You have a new notification from {{businessName}}.\n',
};

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
  const client = (tx as Pick<typeof prisma, 'notificationOutbox' | 'notificationSetting'> | undefined) ?? prisma;

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

  const variables: TemplateVariables = {
    recipientName: input.recipientName ?? 'there',
    businessName: 'UBOSS Sourcing',
    supportEmail: 'support@uboss.example',
    ...input.variables,
  };

  const id = newId();

  const row = {
    id,
    eventKey: input.eventKey,
    channel: 'EMAIL' as const,
    recipientEmail: input.recipientEmail,
    recipientName: input.recipientName ?? null,
    subject: renderTemplate(template.subject, variables).slice(0, 255),
    body: renderTemplate(template.body, variables),
    payloadJson: variables,
    status: 'PENDING' as const,
    nextAttemptAt: input.sendAt ?? new Date(),
    ...(input.dedupeKey !== undefined ? { dedupeKey: input.dedupeKey } : {}),
    ...(input.relatedType !== undefined ? { relatedType: input.relatedType } : {}),
    ...(input.relatedId !== undefined ? { relatedId: input.relatedId } : {}),
  };

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

  // Standalone call: dispatch the delivery job immediately. Inside a
  // transaction, leave it to `dispatchPendingNotifications` after commit.
  if (tx === undefined) {
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
