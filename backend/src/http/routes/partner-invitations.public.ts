/**
 * A delivery company answering a seller's invitation.
 *
 * PUBLIC, because the company being invited has no account here yet - that is
 * the entire point of the flow. A seller describes a courier they already work
 * with; the courier arrives holding a single-use token and decides for itself
 * whether to join.
 *
 * THE TOKEN GOES IN THE BODY, NEVER IN THE PATH
 *
 * Same as `/invitations/accept`, and for the same reason: a path is written to
 * every access log, every proxy log and every referrer header on the way out
 * of the page. A body is not. The link a company clicks lands on a page in the
 * logistics portal, which reads the token out of the fragment and posts it
 * here.
 *
 * WHAT A HOLDER OF A BAD TOKEN LEARNS: that it did not work. Unknown, spent,
 * withdrawn and expired share one refusal, because telling them apart tells
 * somebody probing which addresses have been invited.
 *
 * Rate-limited like the other credential-adjacent endpoints. A token is 32
 * random bytes and is not guessable, but an endpoint that answers unlimited
 * questions about which tokens exist is one worth not having.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  acceptPartnerInvitation,
  describePartnerInvitation,
} from '../../modules/seller/logistics-organisation.service.js';

const tokenSchema = z.object({ token: z.string().min(16).max(256) });

export function registerPartnerInvitationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * What is this, and who is asking?
   *
   * Deliberately thin. It names the seller, what they called the company and
   * what they want it to do - enough to recognise the request - and nothing
   * about the seller's business beyond their trading name. The holder of this
   * link has agreed to nothing yet and may be the wrong person entirely.
   */
  app.post(
    '/describe',
    { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = tokenSchema.parse(request.body);
      const invitation = await describePartnerInvitation(body.token);

      return reply.header('cache-control', 'no-store').status(200).send({ invitation });
    },
  );

  /**
   * Yes.
   *
   * Creates the company, links it to the seller in REQUESTED - the
   * marketplace is the third party and has still to agree - and emails the
   * named contact a SEPARATE invitation to set a password. No password is
   * chosen here and none is emailed: this endpoint establishes an
   * organisation, and the existing `/logistics/auth/invitations/accept` is the
   * only place a credential is ever established.
   */
  app.post(
    '/accept',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = tokenSchema
        .extend({
          // The company's own names, where it corrects the seller's guess. A
          // seller mistyping a legal name must not rename a company that had
          // no say in it.
          displayName: z.string().trim().min(1).max(160).nullable().optional(),
          legalName: z.string().trim().min(1).max(255).nullable().optional(),
          contactName: z.string().trim().min(1).max(160),
          contactEmail: z.string().trim().email().max(320),
          contactPhone: z.string().trim().max(32).nullable().optional(),
        })
        .parse(request.body);

      const organisation = await acceptPartnerInvitation({
        rawToken: body.token,
        displayName: body.displayName ?? null,
        legalName: body.legalName ?? null,
        contactName: body.contactName,
        contactEmail: body.contactEmail,
        contactPhone: body.contactPhone ?? null,
        correlationId: request.correlationId,
      });

      return reply.header('cache-control', 'no-store').status(201).send({
        partnerCode: organisation.partnerCode,
        displayName: organisation.displayName,
        // Where the sign-in invitation went, so the page can say "check that
        // inbox" rather than leaving somebody waiting for nothing.
        invitedEmail: organisation.invitedEmail,
      });
    },
  );

  return Promise.resolve();
}
