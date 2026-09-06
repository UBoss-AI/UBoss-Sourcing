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
 * caller and for nobody else.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MAX_FEED_SIZE,
  listAdminNotifications,
  markAdminNotificationsRead,
  markAllAdminNotificationsRead,
  type NotificationViewer,
} from '../../modules/notifications/admin-notification.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const feedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_FEED_SIZE).optional(),
});

const markReadBody = z.object({
  /** Bounded because the panel only ever holds one page of ids at a time. */
  notificationIds: z.array(z.string().length(26)).min(1).max(MAX_FEED_SIZE),
});

export function registerAdminNotificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/notifications', { preHandler: requireAdmin() }, async (request, reply) => {
    const query = feedQuery.parse(request.query);
    const auth = currentUser(request);
    const viewer: NotificationViewer = { userId: auth.id, permissions: auth.permissions };

    const feed = await listAdminNotifications(
      viewer,
      query.limit === undefined ? {} : { limit: query.limit },
    );

    return reply.status(200).send(feed);
  });

  app.post('/notifications/read', { preHandler: requireAdmin() }, async (request, reply) => {
    const body = markReadBody.parse(request.body);
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

  return Promise.resolve();
}
