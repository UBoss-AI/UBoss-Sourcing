/**
 * Storefront account security: two-step sign-in and step-up confirmation.
 *
 * Every route here uses `requireAuthenticated('CUSTOMER')` rather than
 * `requireCustomer`, and that is the point: a session that still owes its
 * two-step code is refused by `requireCustomer` everywhere else, so the routes
 * that let it finish signing in must sit outside that guard. None of them does
 * anything a half-signed-in session should not: the challenge needs the code,
 * and every change needs a fresh step-up, which on an account with a factor is
 * the code again.
 *
 * Codes and secrets are never logged, and every response that carries one is
 * `cache-control: no-store`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ErrorCode, forbidden } from '../../domain/errors.js';
import {
  beginCustomerMfaEnrolment,
  challengePending,
  confirmCustomerMfaEnrolment,
  disableCustomerMfa,
  readCustomerMfaState,
  regenerateCustomerRecoveryCodes,
  stepUp,
  verifyCustomerMfaChallenge,
  type CustomerSecurityAuth,
} from '../../modules/identity/customer-mfa.service.js';
import { currentUser, requireAuthenticated } from '../plugins/auth.js';

const codeSchema = z.object({ code: z.string().trim().min(6).max(16) });

/** Wrong codes are also counted per account; this caps one address. */
const codeRateLimit = { rateLimit: { max: 10, timeWindow: '15 minutes' } };

function securityAuth(request: FastifyRequest): CustomerSecurityAuth {
  const auth = currentUser(request);
  return {
    id: auth.id,
    email: auth.email,
    customerProfileId: auth.customerProfileId,
    mfaEnabled: auth.mfaEnabled,
    sessionId: auth.sessionId,
    sessionMfaVerifiedAt: auth.sessionMfaVerifiedAt,
    sessionReauthenticatedAt: auth.sessionReauthenticatedAt,
  };
}

function context(request: FastifyRequest): { ipAddress: string; correlationId: string } {
  return { ipAddress: request.ip, correlationId: request.correlationId };
}

/** Everything but the challenge itself needs the challenge passed first. */
function assertNotPending(auth: CustomerSecurityAuth): void {
  if (challengePending(auth)) {
    throw forbidden(
      ErrorCode.MFA_CHALLENGE_REQUIRED,
      'Enter the code from your authenticator app to finish signing in.',
    );
  }
}

export function registerCustomerSecurityRoutes(app: FastifyInstance): Promise<void> {
  const guard = requireAuthenticated('CUSTOMER');

  /**
   * Where this account's two-step sign-in stands: switched on or not, whether
   * the person's seller role requires it, whether this session has passed its
   * code, how many recovery codes are left, and what a step-up will ask for.
   */
  app.get('/mfa', { preHandler: guard }, async (request, reply) => {
    const state = await readCustomerMfaState(securityAuth(request));
    return reply.header('cache-control', 'no-store').status(200).send({ mfa: state });
  });

  /**
   * Start setting up two-step sign-in: returns a new authenticator secret, the
   * address to draw as a QR code, and ten recovery codes shown only this once.
   * Needs a recent step-up. Nothing is switched on until the code is confirmed.
   */
  app.post('/mfa/setup', { preHandler: guard, config: codeRateLimit }, async (request, reply) => {
    const enrolment = await beginCustomerMfaEnrolment(securityAuth(request));
    return reply.header('cache-control', 'no-store').status(200).send(enrolment);
  });

  /**
   * Confirm setup with the first code from the authenticator. Switches two-step
   * sign-in on, marks this session verified, and writes an audit entry.
   */
  app.post('/mfa/confirm', { preHandler: guard, config: codeRateLimit }, async (request, reply) => {
    const body = codeSchema.parse(request.body);
    const auth = securityAuth(request);
    assertNotPending(auth);
    await confirmCustomerMfaEnrolment(auth, body.code, context(request));
    return reply.header('cache-control', 'no-store').status(200).send({ enabled: true });
  });

  /**
   * Finish signing in with a code from the authenticator or a one-time
   * recovery code. Wrong codes are counted; too many in a row lock the account
   * and end every session.
   */
  app.post('/mfa/challenge', { preHandler: guard, config: codeRateLimit }, async (request, reply) => {
    const body = codeSchema.parse(request.body);
    const result = await verifyCustomerMfaChallenge(securityAuth(request), body.code, context(request));
    return reply.header('cache-control', 'no-store').status(200).send({ verified: true, ...result });
  });

  /**
   * Replace the recovery codes with ten new ones, shown only this once. The old
   * codes stop working. Needs a recent step-up.
   */
  app.post(
    '/mfa/recovery-codes',
    { preHandler: guard, config: codeRateLimit },
    async (request, reply) => {
      const auth = securityAuth(request);
      assertNotPending(auth);
      const recoveryCodes = await regenerateCustomerRecoveryCodes(auth, context(request));
      return reply.header('cache-control', 'no-store').status(200).send({ recoveryCodes });
    },
  );

  /**
   * Switch two-step sign-in off. Needs a recent step-up, is refused while the
   * person's seller role requires it, and emails the account holder.
   */
  app.post('/mfa/disable', { preHandler: guard, config: codeRateLimit }, async (request, reply) => {
    const auth = securityAuth(request);
    assertNotPending(auth);
    await disableCustomerMfa(auth, context(request));
    return reply.status(200).send({ enabled: false });
  });

  /**
   * Confirm it is you before a sensitive change: a code from the authenticator
   * when two-step sign-in is on, otherwise the password. Counts for
   * STEP_UP_WINDOW_SECONDS. Wrong answers count towards the lockout.
   */
  app.post('/step-up', { preHandler: guard, config: codeRateLimit }, async (request, reply) => {
    const body = z
      .object({
        password: z.string().max(128).nullable().optional(),
        code: z.string().trim().max(16).nullable().optional(),
      })
      .parse(request.body);
    const auth = securityAuth(request);
    assertNotPending(auth);
    const agent = request.headers['user-agent'];
    const result = await stepUp(
      auth,
      { password: body.password ?? null, code: body.code ?? null },
      { ...context(request), userAgent: typeof agent === 'string' ? agent : null },
    );
    return reply.header('cache-control', 'no-store').status(200).send(result);
  });

  return Promise.resolve();
}
