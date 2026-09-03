/**
 * Authentication routes.
 *
 * Registered twice - once under /admin/auth and once under /auth - from the
 * same factory. The surfaces share an identity service but never share a
 * credential: `kind` is baked in at registration, so a customer password can
 * never be presented to the admin endpoint.
 *
 * Response bodies never include the refresh token; it lives only in an httpOnly
 * cookie. The access token is returned as well as set, so a non-browser API
 * client can use the Bearer path.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, forbidden, unauthorized } from '../../domain/errors.js';
import {
  changePassword,
  login,
  type UserKind,
} from '../../modules/identity/auth.service.js';
import {
  revokeAllUserSessions,
  revokeSession,
  rotateSession,
} from '../../modules/identity/session.service.js';
import {
  acceptInvitation,
  buildTokenUrl,
  completePasswordReset,
  requestPasswordReset,
} from '../../modules/identity/token.service.js';
import { enqueueNotification } from '../../modules/notifications/notification.service.js';
import {
  cookieNamesFor,
  authCookieOptions,
  csrfCookieOptions,
  currentUser,
  requireAuthenticated,
} from '../plugins/auth.js';

// --- Schemas ---------------------------------------------------------------

/**
 * Password policy. Length is the dominant factor in real-world resistance, so
 * the floor is 12 rather than a shorter length padded with character-class
 * rules that mostly produce `Password1!`.
 */
const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters.')
  .max(128, 'Password must be at most 128 characters.');

const loginSchema = z.object({
  email: z.string().trim().min(1).max(320).email('Enter a valid email address.'),
  password: z.string().min(1).max(128),
});

const acceptInvitationSchema = z.object({
  token: z.string().min(16).max(512),
  password: passwordSchema,
  acceptedTerms: z.boolean(),
  consentVersion: z.string().min(1).max(32).default('v1'),
});

const forgotPasswordSchema = z.object({
  email: z.string().trim().min(1).max(320).email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(16).max(512),
  newPassword: passwordSchema,
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

// --- Cookie helpers --------------------------------------------------------

interface SessionCookies {
  accessToken: string;
  refreshToken: string;
}

function setSessionCookies(
  reply: FastifyReply,
  session: SessionCookies,
  kind: UserKind,
): string {
  // The CSRF token is readable by JS on purpose - the frontend copies it into
  // the X-CSRF-Token header. It authorises nothing by itself; it only proves
  // the caller could read a same-site cookie.
  const csrfToken = randomBytes(24).toString('base64url');
  const names = cookieNamesFor(kind);

  void reply
    .setCookie(names.access, session.accessToken, authCookieOptions(env.ACCESS_TOKEN_TTL_SECONDS))
    .setCookie(
      names.refresh,
      session.refreshToken,
      authCookieOptions(env.REFRESH_TOKEN_TTL_SECONDS),
    )
    .setCookie(names.csrf, csrfToken, csrfCookieOptions(env.REFRESH_TOKEN_TTL_SECONDS));

  return csrfToken;
}

function clearSessionCookies(reply: FastifyReply, kind: UserKind): void {
  const options = { path: '/', ...(env.COOKIE_DOMAIN.length > 0 ? { domain: env.COOKIE_DOMAIN } : {}) };
  const names = cookieNamesFor(kind);

  // Only this surface's cookies. Signing out of the admin panel must not sign
  // the person out of the storefront in the same browser.
  void reply
    .clearCookie(names.access, options)
    .clearCookie(names.refresh, options)
    .clearCookie(names.csrf, options);
}

function requestContext(request: FastifyRequest): {
  ipAddress: string;
  userAgent: string | null;
  correlationId: string;
} {
  const agent = request.headers['user-agent'];
  return {
    ipAddress: request.ip,
    userAgent: typeof agent === 'string' ? agent : null,
    correlationId: request.correlationId,
  };
}

// --- Route factory ---------------------------------------------------------

/**
 * Build the auth routes for one surface.
 *
 * @param kind ADMIN or CUSTOMER. Decides which users may sign in here and which
 *             public URL emailed links point at.
 */
export function authRoutes(kind: UserKind) {
  return function register(app: FastifyInstance): Promise<void> {
    /**
     * Per-route rate limit, tighter than the global one and keyed on IP.
     * The per-account lockout in auth.service.ts is the other half: this stops
     * one address spraying many accounts, that stops many addresses grinding
     * down one account.
     */
    const loginRateLimit = {
      rateLimit: {
        max: env.RATE_LIMIT_LOGIN_PER_15MIN,
        timeWindow: '15 minutes',
      },
    };

    app.post('/login', { config: loginRateLimit }, async (request, reply) => {
      const body = loginSchema.parse(request.body);
      const context = requestContext(request);

      const result = await login({
        email: body.email,
        password: body.password,
        kind,
        ...context,
      });

      const csrfToken = setSessionCookies(reply, result.session, kind);

      return reply.status(200).send({
        user: {
          id: result.user.id,
          email: result.user.email,
          type: result.user.type,
          roles: result.user.roles,
          permissions: result.user.permissions,
          customerProfileId: result.user.customerProfileId,
          mfaEnabled: result.user.mfaEnabled,
        },
        // Returned for non-browser clients. Browsers should rely on the cookie.
        accessToken: result.session.accessToken,
        accessTokenExpiresAt: result.session.accessTokenExpiresAt.toISOString(),
        csrfToken,
      });
    });

    app.post('/refresh', { config: loginRateLimit }, async (request, reply) => {
      const refreshToken = request.cookies[cookieNamesFor(kind).refresh];

      if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
        throw unauthorized(ErrorCode.SESSION_EXPIRED, 'No active session to refresh.');
      }

      let session;
      try {
        session = await rotateSession(refreshToken, requestContext(request));
      } catch (error) {
        // Rotation failed for any reason - reuse, expiry, deactivation. Clear
        // the cookies so the client stops retrying with a dead token.
        clearSessionCookies(reply, kind);
        throw error;
      }

      const csrfToken = setSessionCookies(reply, session, kind);

      return reply.status(200).send({
        accessToken: session.accessToken,
        accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
        csrfToken,
      });
    });

    app.post('/logout', { preHandler: requireAuthenticated(kind) }, async (request, reply) => {
      await revokeSession(currentUser(request).sessionId, 'logout');
      clearSessionCookies(reply, kind);
      return reply.status(204).send();
    });

    app.post('/logout-all', { preHandler: requireAuthenticated(kind) }, async (request, reply) => {
      const auth = currentUser(request);
      const revoked = await revokeAllUserSessions(auth.id, 'logout_all');
      clearSessionCookies(reply, kind);
      return reply.status(200).send({ sessionsRevoked: revoked });
    });

    app.get('/me', { preHandler: requireAuthenticated(kind) }, (request, reply) => {
      const auth = currentUser(request);
      return reply.status(200).send({
        id: auth.id,
        email: auth.email,
        type: auth.type,
        roles: auth.roles,
        permissions: auth.permissions,
        customerProfileId: auth.customerProfileId,
        mfaEnabled: auth.mfaEnabled,
      });
    });

    app.post(
      '/password/change',
      { preHandler: requireAuthenticated(kind) },
      async (request, reply) => {
        const body = changePasswordSchema.parse(request.body);
        const auth = currentUser(request);
        const context = requestContext(request);

        await changePassword({
          userId: auth.id,
          currentPassword: body.currentPassword,
          newPassword: body.newPassword,
          ipAddress: context.ipAddress,
          correlationId: context.correlationId,
        });

        // changePassword revokes every session, including this one.
        clearSessionCookies(reply, kind);
        return reply.status(200).send({ passwordChanged: true, signedOut: true });
      },
    );

    app.post(
      '/password/forgot',
      { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
      async (request, reply) => {
        const body = forgotPasswordSchema.parse(request.body);
        const context = requestContext(request);

        const issued = await requestPasswordReset(body.email, {
          ipAddress: context.ipAddress,
          correlationId: context.correlationId,
        });

        if (issued !== null) {
          await enqueueNotification({
            eventKey: 'user.password_reset',
            recipientEmail: issued.email,
            variables: {
              resetUrl: buildTokenUrl('PASSWORD_RESET', issued.token, kind),
              expiresAt: issued.expiresAt.toISOString(),
            },
            relatedType: 'user',
            relatedId: issued.userId,
            correlationId: context.correlationId,
          });
        }

        // Identical response whether or not the account exists. Disclosing the
        // difference would turn this endpoint into an account-enumeration
        // oracle, which is exactly what the uniform message prevents.
        return reply.status(202).send({
          message: 'If an account exists for that address, a reset link has been sent.',
        });
      },
    );

    app.post(
      '/password/reset',
      { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
      async (request, reply) => {
        const body = resetPasswordSchema.parse(request.body);
        const context = requestContext(request);

        await completePasswordReset({
          token: body.token,
          newPassword: body.newPassword,
          ipAddress: context.ipAddress,
          correlationId: context.correlationId,
        });

        clearSessionCookies(reply, kind);
        return reply.status(200).send({ passwordReset: true });
      },
    );

    // --- Invitation activation (customer surface only) ---------------------
    //
    // Admin staff are created and given credentials by a Business Owner through
    // the staff module, not through a public activation endpoint.
    if (kind === 'CUSTOMER') {
      app.post(
        '/invitations/accept',
        { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
        async (request, reply) => {
          const body = acceptInvitationSchema.parse(request.body);
          const context = requestContext(request);

          const consumed = await acceptInvitation({
            token: body.token,
            password: body.password,
            acceptedTerms: body.acceptedTerms,
            consentVersion: body.consentVersion,
            ipAddress: context.ipAddress,
            correlationId: context.correlationId,
          });

          return reply.status(200).send({
            activated: true,
            email: consumed.email,
            message: 'Your account is active. You can now sign in.',
          });
        },
      );

      app.post(
        '/register',
        { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
        (_request, _reply) => {
          // Self-registration is optional and OFF by default (SOP 7.2). The
          // route exists so the frontend gets a precise, actionable code rather
          // than a 404 it has to guess the meaning of.
          if (!env.FEATURE_CUSTOMER_SELF_REGISTRATION) {
            throw forbidden(
              ErrorCode.SELF_REGISTRATION_DISABLED,
              'Accounts are created by invitation. Please contact your account manager.',
            );
          }

          throw badRequest(
            ErrorCode.FEATURE_DISABLED,
            'Self-registration is enabled but not yet implemented.',
          );
        },
      );
    }

    return Promise.resolve();
  };
}
