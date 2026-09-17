/**
 * Console notifications - the bell in the Admin Panel's top bar.
 *
 * No permission is declared on these routes, and that is deliberate: the feed
 * is personal, and every row already carries the grant needed to see it. A
 * Catalog Manager and a Business Owner call the same endpoint and get
 * different rows out of it. Declaring `order.read` here instead would hide the
 * bell entirely from staff who will, in time, have notifications of their own.
 *
 * Read state is per person throughout - marking one read clears it for the
 * caller and for nobody else. So is dismissing. **Resolving is not**: it is a
 * statement about the world rather than about the reader, so it changes the
 * row for everybody who can see it, and every route that can make that
 * statement is audited.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MAX_FEED_SIZE,
  dismissAdminNotifications,
  listAdminNotifications,
  markAdminNotificationsRead,
  markAllAdminNotificationsRead,
  readAdminNotification,
  resolveAdminNotificationById,
  type NotificationViewer,
} from '../../modules/notifications/admin-notification.service.js';
import { readAttention } from '../../modules/notifications/attention.service.js';
import { AuditAction, recordAudit } from '../../modules/audit/audit.service.js';
import { notFound } from '../../domain/errors.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const feedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_FEED_SIZE).optional(),
  /**
   * Which half of the feed.
   *
   * `active` is the bell. `resolved` is the history screen - alerts that are
   * over, who closed them and why. Defaulted in the service rather than here,
   * so a caller that omits it can never be shown closed problems as though
   * they were open.
   */
  view: z.enum(['active', 'resolved', 'all']).optional(),
});

const idsBody = z.object({
  /** Bounded because the panel only ever holds one page of ids at a time. */
  notificationIds: z.array(z.string().length(26)).min(1).max(MAX_FEED_SIZE),
});

const resolveBody = z.object({
  /**
   * Why it is being closed. Required, and stored.
   *
   * Not optional, because a manual resolution with no explanation is the exact
   * thing that makes an alert log worthless six months later: somebody closed
   * it, nobody knows what they did, and the next person has to work out from
   * scratch whether the problem is still there.
   */
  reason: z.string().trim().min(4).max(512),
});

export function registerAdminNotificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/notifications', { preHandler: requireAdmin() }, async (request, reply) => {
    const query = feedQuery.parse(request.query);
    const auth = currentUser(request);
    const viewer: NotificationViewer = { userId: auth.id, permissions: auth.permissions };

    const feed = await listAdminNotifications(viewer, {
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.view === undefined ? {} : { view: query.view }),
    });

    // `no-store` for the same reason `/attention` carries it: a badge cached
    // for thirty seconds is a badge that still shows a problem somebody has
    // just fixed.
    return reply.header('cache-control', 'no-store').status(200).send(feed);
  });

  /**
   * What is still waiting, counted per queue.
   *
   * No permission on the route, for the same reason the feed has none: the
   * grant rides on each count, so a Catalog Manager and a Business Owner call
   * this and get different keys back. `no-store` because a badge cached for
   * thirty seconds is a badge that says a listing is still waiting after
   * somebody has just approved it.
   */
  app.get('/attention', { preHandler: requireAdmin() }, async (request, reply) => {
    const auth = currentUser(request);
    const view = await readAttention({ permissions: auth.permissions });

    return reply.header('cache-control', 'no-store').status(200).send(view);
  });

  app.post('/notifications/read', { preHandler: requireAdmin() }, async (request, reply) => {
    const body = idsBody.parse(request.body);
    const auth = currentUser(request);

    const marked = await markAdminNotificationsRead(
      { userId: auth.id, permissions: auth.permissions },
      body.notificationIds,
    );

    return reply.status(200).send({ marked });
  });

  app.post('/notifications/read-all', { preHandler: requireAdmin() }, async (request, reply) => {
    const auth = currentUser(request);

    const marked = await markAllAdminNotificationsRead({
      userId: auth.id,
      permissions: auth.permissions,
    });

    return reply.status(200).send({ marked });
  });

  /**
   * Take rows out of this caller's own bell.
   *
   * Not a resolution, and the API says so by being a different endpoint with a
   * different verb rather than a flag on the one below. The notification's
   * status is untouched, every other recipient still sees it, and the problem
   * is exactly as unsolved as it was. No audit row: hiding something from your
   * own view is not an act on the business.
   */
  app.post('/notifications/dismiss', { preHandler: requireAdmin() }, async (request, reply) => {
    const body = idsBody.parse(request.body);
    const auth = currentUser(request);

    const dismissed = await dismissAdminNotifications(
      { userId: auth.id, permissions: auth.permissions },
      body.notificationIds,
    );

    return reply.status(200).send({ dismissed });
  });

  /**
   * One row, with its resolution if it has one.
   *
   * What the history screen opens. Separate from the feed because a resolved
   * alert is usually looked up by somebody following a link months later,
   * rather than scrolled to.
   */
  app.get('/notifications/:id', { preHandler: requireAdmin() }, async (request, reply) => {
    const params = z.object({ id: z.string().length(26) }).parse(request.params);
    const auth = currentUser(request);

    const row = await readAdminNotification(
      { userId: auth.id, permissions: auth.permissions },
      params.id,
    );

    if (row === null) throw notFound('Notification');

    return reply.header('cache-control', 'no-store').status(200).send(row);
  });

  /**
   * Close an alert by hand.
   *
   * Refused for every kind whose truth lives in another table - see
   * `KIND_POLICY` in the service. The refusal carries the reason and the
   * screen where the real decision is made, because "no" with no route
   * forward is how people learn to work round a control.
   *
   * Audited, always. A resolution changes what everybody sees, so unlike
   * reading and dismissing it leaves a row saying who did it and why.
   */
  app.post('/notifications/:id/resolve', { preHandler: requireAdmin() }, async (request, reply) => {
    const params = z.object({ id: z.string().length(26) }).parse(request.params);
    const body = resolveBody.parse(request.body);
    const auth = currentUser(request);

    const resolved = await resolveAdminNotificationById(
      { userId: auth.id, permissions: auth.permissions },
      params.id,
      body.reason,
    );

    await recordAudit({
      action: AuditAction.NOTIFICATION_RESOLVED,
      resourceType: 'admin_notification',
      resourceId: resolved.id,
      actorType: 'ADMIN',
      actorUserId: auth.id,
      actorEmail: auth.email,
      after: { kind: resolved.kind, reason: body.reason },
      correlationId: request.correlationId,
    });

    return reply.status(200).send(resolved);
  });

  return Promise.resolve();
}
