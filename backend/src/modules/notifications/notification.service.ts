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
  INVENTORY_LOW_STOCK: 'inventory.low_stock',
  /// The Art. 15 copy is built and waiting. Says when the link stops working,
  /// because the window is short on purpose.
  DATA_REQUEST_READY: 'data_request.ready',
  /// The Art. 17 erasure is done, and what survived it. Sent to the address
  /// that asked, moments before that address stops existing.
  DATA_REQUEST_ERASED: 'data_request.erased',
  /// A refusal, carrying the reason. Art. 12(4) requires both this and the
  /// reminder that the subject may complain to a supervisory authority.
  DATA_REQUEST_REJECTED: 'data_request.rejected',
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
    [NotificationEvent.SCHEDULE_REMINDER]: {
      subject: 'Upcoming recurring order on {{dueDate}}',
      body:
        'Hello {{recipientName}},\n\n' +
        'Your recurring order "{{scheduleName}}" is due on {{dueDate}}.\n' +
        'Estimated amount: {{estimatedTotal}}.\n\n' +
        'The final amount is recalculated against current prices, tax, stock and ' +
        'your purchasing limits at the time the order is created.\n\n' +
        'Manage this schedule:\n{{scheduleUrl}}\n',
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
