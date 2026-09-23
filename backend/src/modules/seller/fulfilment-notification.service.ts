/**
 * Telling a seller what happened to the way they deliver.
 *
 * Four moments, each one something that happens to a seller's delivery setup
 * while they are looking at a different screen or at nothing at all - which is
 * the whole reason a notification exists rather than a status somewhere.
 *
 * TWO OF THE FOUR ARE ALERTS, AND THE DISTINCTION IS THE POINT
 *
 * News is cleared by being read, per person. An ALERT is cleared by the problem
 * going away, for the whole business. "Your carrier account stopped answering"
 * and "this paid order has nothing to carry it" are both still true however
 * many people glance at them, so neither can be dismissed by reading - and both
 * close by themselves the moment the underlying thing is fixed.
 *
 * That is what `resolutionKey` is for, and why it names the PROBLEM rather than
 * the event: a consignment that has lost two methods in a row has two
 * notifications and one key, and giving it a method closes both.
 *
 * EVERY CALL IS DEDUPLICATED BY A DATABASE CONSTRAINT, not by a query.
 * `uq_seller_notification_dedupe` is what makes a webhook retry or a second
 * worker write at most one row; a look-then-insert loses that race, which is
 * exactly the race two workers arriving in the same second create.
 */
import type { SellerFulfilmentMethodStatus } from '../../generated/prisma/enums.js';
import { describeMethodStatus } from '../../domain/seller-fulfilment.js';
import { notifySeller, resolveSellerNotifications } from './notification.service.js';

/**
 * The marketplace decided about a way of delivering.
 *
 * News rather than an alert: there is nothing for the seller to resolve. They
 * read it, and either start using the method or fix what was wrong.
 *
 * The dedupe key names the METHOD AND THE DECISION, so two different decisions
 * about the same method are two notifications - a refusal in March and an
 * approval in April are two things a seller has to read - while a retry of one
 * decision writes once.
 */
export async function notifyMethodDecision(input: {
  sellerAccountId: string;
  fulfilmentMethodId: string;
  methodName: string;
  status: SellerFulfilmentMethodStatus;
  reason: string | null;
}): Promise<void> {
  const approved = input.status === 'APPROVED';

  await notifySeller({
    sellerAccountId: input.sellerAccountId,
    kind: 'FULFILMENT_METHOD_DECISION',
    title: approved
      ? `${input.methodName} is ready to use`
      : `${input.methodName} is ${describeMethodStatus(input.status)}`,
    body: approved
      ? 'You can start sending orders this way. Make it your default on the Delivery screen if you want it used first.'
      : input.reason ??
        'Open the Delivery screen to see what needs changing before this can be used.',
    linkPath: '/seller/fulfilment',
    severity: approved ? 'SUCCESS' : 'WARNING',
    subjectType: 'SellerFulfilmentMethod',
    subjectId: input.fulfilmentMethodId,
    dedupeKey: `method:${input.fulfilmentMethodId}:${input.status}`,
  });
}

/**
 * The seller's own carrier account stopped answering.
 *
 * An ALERT. Every order routed that way is now going nowhere, and that stays
 * true however many people read about it.
 *
 * The dedupe key is the CONNECTION, not the failure - so a carrier that has
 * been down for an hour produces one notification rather than forty, and the
 * seller sees a problem rather than a stream.
 */
export async function notifyConnectionFailed(input: {
  sellerAccountId: string;
  connectionId: string;
  provider: string;
  /** Already sanitised by `safeCarrierMessage` before it reached here. */
  message: string;
  /**
   * Which OUTAGE this failure belongs to.
   *
   * The connection's last SUCCESS, as an instant - or `never`. It is stable
   * for as long as the carrier stays down, and changes the moment it works
   * again, which is exactly the boundary wanted.
   *
   * Deliberately NOT the time of this failure. A timestamp of now makes every
   * retry unique, so a carrier down for an hour writes forty notifications -
   * the thing the dedupe key exists to prevent. And deliberately not the
   * connection alone, which was the first attempt and was worse: once the
   * alert had been resolved, a SECOND outage weeks later collided with the
   * closed row and the seller was never told again.
   */
  episode: string;
}): Promise<void> {
  await notifySeller({
    sellerAccountId: input.sellerAccountId,
    kind: 'CARRIER_CONNECTION_FAILED',
    title: `${input.provider} is not answering`,
    body: `${input.message} Orders set to go this way cannot be booked until it works again.`,
    linkPath: '/seller/fulfilment',
    severity: 'CRITICAL',
    subjectType: 'SellerCarrierConnection',
    subjectId: input.connectionId,
    class: 'ALERT',
    // One row per outage: every failure inside one outage shares this.
    dedupeKey: `connection:${input.connectionId}:${input.episode}`,
    // One key for the CONNECTION, so the carrier answering again closes every
    // outage's alert rather than only the newest.
    resolutionKey: `connection:${input.connectionId}`,
  });
}

/**
 * It is working again.
 *
 * Closes the alert above and removes it from the count, keeping the row and
 * recording what closed it. A notification that vanished when the problem was
 * fixed would delete the record of the problem, which is the thing somebody
 * asks about a week later.
 */
export async function resolveConnectionAlert(connectionId: string): Promise<void> {
  await resolveSellerNotifications({
    resolutionKey: `connection:${connectionId}`,
    source: 'DOMAIN_EVENT',
    note: 'The carrier answered again.',
  });
}

/** A delivery company the seller invited answered. */
export async function notifyInvitationResult(input: {
  sellerAccountId: string;
  invitationId: string;
  companyName: string;
  accepted: boolean;
  reason?: string | null;
}): Promise<void> {
  await notifySeller({
    sellerAccountId: input.sellerAccountId,
    kind: 'PARTNER_INVITATION_RESULT',
    title: input.accepted
      ? `${input.companyName} accepted your invitation`
      : `${input.companyName} did not accept`,
    body: input.accepted
      ? 'We are reviewing the arrangement now. You will hear from us before they can carry anything.'
      : (input.reason ?? 'They declined, or the invitation expired before they answered.'),
    linkPath: '/seller/fulfilment',
    severity: input.accepted ? 'SUCCESS' : 'WARNING',
    subjectType: 'SellerLogisticsPartnerInvitation',
    subjectId: input.invitationId,
    dedupeKey: `invitation:${input.invitationId}:${input.accepted ? 'accepted' : 'declined'}`,
  });
}

/**
 * A paid order has nothing that can carry it.
 *
 * The most urgent of the four, and the second ALERT: somebody has been charged
 * for goods this system currently cannot despatch. It is deliberately NOT
 * suppressed when it happens repeatedly - but it IS deduplicated per
 * consignment, so a seller with forty stuck orders sees forty parcels rather
 * than four hundred lines.
 */
export async function notifyConsignmentNeedsMethod(input: {
  sellerAccountId: string;
  shipmentId: string;
  shipmentReference: string;
  /** Why nothing was eligible, already written for a seller to read. */
  reason: string;
}): Promise<void> {
  await notifySeller({
    sellerAccountId: input.sellerAccountId,
    kind: 'CONSIGNMENT_AWAITING_METHOD',
    title: `${input.shipmentReference} has no way of being delivered`,
    body: input.reason,
    linkPath: '/seller/orders',
    severity: 'CRITICAL',
    subjectType: 'LogisticsShipment',
    subjectId: input.shipmentId,
    class: 'ALERT',
    dedupeKey: `consignment-method:${input.shipmentId}`,
    resolutionKey: `consignment-method:${input.shipmentId}`,
  });
}

/** A method was chosen for it after all. */
export async function resolveConsignmentMethodAlert(shipmentId: string): Promise<void> {
  await resolveSellerNotifications({
    resolutionKey: `consignment-method:${shipmentId}`,
    source: 'DOMAIN_EVENT',
    note: 'A way of delivering it was chosen.',
  });
}
