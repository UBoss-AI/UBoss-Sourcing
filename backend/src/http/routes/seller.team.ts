/**
 * A seller's team: invitations and the access review (checklist Master row 14).
 *
 * Two registrations. `registerSellerTeamRoutes` sits under `/seller` with the
 * Seller Hub guard, so the seller account id comes from the session and an
 * invitation id from another seller reads as not found. The member list, role
 * change and removal routes are in `seller.account.ts`.
 *
 * `registerSellerInvitationRoutes` sits under `/sellers`, reachable by any
 * signed-in customer, because the person accepting an invitation does not
 * belong to a seller yet. What protects it is the token and the rule that the
 * signed-in account's verified email is the one invited.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { assertRecentStepUp } from '../../modules/identity/customer-mfa.service.js';
import {
  SELLER_INVITABLE_ROLES,
  acceptSellerInvitation,
  inviteSellerMember,
  previewSellerInvitation,
  readSellerTeam,
  recordSellerAccessReview,
  resendSellerInvitation,
  revokeSellerInvitation,
  type SellerTeamActor,
} from '../../modules/seller/team.service.js';
import { currentUser, requireCustomer } from '../plugins/auth.js';
import { currentSeller, requireSeller } from '../plugins/seller.js';

const inviteSchema = z.object({ email: z.string().trim().email().max(320), role: z.enum(SELLER_INVITABLE_ROLES) });
const invitationParam = z.object({ invitationId: z.string().length(26) });
const tokenSchema = z.object({ token: z.string().trim().min(20).max(100) });

function actorOf(request: FastifyRequest): SellerTeamActor {
  const auth = currentUser(request);
  return {
    membership: currentSeller(request),
    userId: auth.id,
    email: auth.email,
    ipAddress: request.ip,
    correlationId: request.correlationId,
  };
}

export function registerSellerTeamRoutes(app: FastifyInstance): Promise<void> {
  /** The team with each member's role, who invited them and when they last signed in; live invitations; recent access reviews. */
  app.get('/team', { preHandler: requireSeller(SellerPermission.MEMBER_READ) }, async (request, reply) => {
    return reply.header('cache-control', 'no-store').send(await readSellerTeam({ membership: currentSeller(request) }));
  });

  /** Invite somebody by email in one role. Never Owner, and never a role carrying more than your own. */
  app.post(
    '/invitations',
    {
      preHandler: requireSeller(SellerPermission.MEMBER_WRITE),
      config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const body = inviteSchema.parse(request.body);
      // Letting somebody in is a sensitive act: confirm it is still the member at the keyboard.
      assertRecentStepUp(currentUser(request));
      return reply.status(201).send(await inviteSellerMember(actorOf(request), body));
    },
  );

  /** Send an invitation again with a new link and a new expiry; the old link stops working. */
  app.post(
    '/invitations/:invitationId/resend',
    {
      preHandler: requireSeller(SellerPermission.MEMBER_WRITE),
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const { invitationId } = invitationParam.parse(request.params);
      return reply.send(await resendSellerInvitation(actorOf(request), invitationId));
    },
  );

  /** Withdraw an invitation nobody has accepted yet. */
  app.delete(
    '/invitations/:invitationId',
    { preHandler: requireSeller(SellerPermission.MEMBER_WRITE) },
    async (request, reply) => {
      const { invitationId } = invitationParam.parse(request.params);
      return reply.send(await revokeSellerInvitation(actorOf(request), invitationId));
    },
  );

  /** Record that you have reviewed who has access to the team. Audited. */
  app.post(
    '/access-reviews',
    {
      preHandler: requireSeller(SellerPermission.MEMBER_WRITE),
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      return reply.status(201).send(await recordSellerAccessReview(actorOf(request)));
    },
  );

  return Promise.resolve();
}

export function registerSellerInvitationRoutes(app: FastifyInstance): Promise<void> {
  /** What a seller team invitation asks you to join. Only for the signed-in account it was sent to. */
  app.post(
    '/invitations/preview',
    { preHandler: requireCustomer, config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const { token } = tokenSchema.parse(request.body);
      return reply.header('cache-control', 'no-store').send(await previewSellerInvitation(currentUser(request).id, token));
    },
  );

  /** Accept a seller team invitation. Your verified email must be the one it was sent to. */
  app.post(
    '/invitations/accept',
    { preHandler: requireCustomer, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const { token } = tokenSchema.parse(request.body);
      const auth = currentUser(request);
      return reply.send(
        await acceptSellerInvitation(
          { userId: auth.id, email: auth.email, ipAddress: request.ip, correlationId: request.correlationId },
          token,
        ),
      );
    },
  );

  return Promise.resolve();
}
