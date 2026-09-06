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
import { ErrorCode, unauthorized } from '../../domain/errors.js';
import { changePassword, login, type UserKind } from '../../modules/identity/auth.service.js';
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
import {
  registerCustomer,
  resendVerificationEmail,
  verifyRegistrationEmail,
} from '../../modules/customers/registration.service.js';
import {
  SUPPORTED_LANGUAGES,
  getUserLanguage,
  setUserLanguage,
} from '../../modules/identity/language.service.js';
import {
  formatCoordinates,
  recordSessionLocation,
} from '../../modules/identity/session-location.service.js';
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

/**
 * The storefront's own sign-up form.
 *
 * Four fields are asked for and all four are required: name, email, mobile
 * number and country. The country is not decoration - this catalogue holds a
 * real price per market rather than converting one, so it decides what every
 * price the new account sees is quoted in. The mobile number is how a sourcing
 * order actually gets chased when something is short or late.
 *
 * `organization` is optional and deliberately last: a buyer registering on
 * behalf of a company usually types it, a sole trader has nothing to type, and
 * making it required would only teach people to write "n/a".
 */
const registerSchema = z.object({
  fullName: z.string().trim().min(1, 'Enter your name.').max(255),
  email: z.string().trim().min(1).max(320).email('Enter a valid email address.'),
  /**
   * Loose on purpose. The shape of a valid mobile number differs by country and
   * changes without notice, so this bounds the field and the service strips it
   * to digits; a real check is somebody ringing it.
   */
  phone: z.string().trim().min(6, 'Enter your mobile number.').max(32),
  country: z.string().trim().length(2, 'Choose a country.').toUpperCase(),
  password: passwordSchema,
  organization: z.string().trim().max(255).nullable().optional(),
  acceptedTerms: z.boolean(),
  consentVersion: z.string().min(1).max(32).default('v1'),
  /** What the storefront is being read in, so the first email matches it. */
  language: z.enum(SUPPORTED_LANGUAGES).nullable().optional(),
});

const verifyEmailSchema = z.object({
  token: z.string().min(16).max(512),
});

const resendVerificationSchema = z.object({
  email: z.string().trim().min(1).max(320).email(),
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

/**
 * A position from the browser's Geolocation API.
 *
 * Bounded to the real coordinate ranges, and the accuracy radius to something a
 * device could plausibly claim. None of this makes the numbers trustworthy - a
 * client can send whatever it likes - but the values are read by people and
 * written into a fixed-precision column, so nonsense is refused at the edge
 * rather than stored and puzzled over later.
 */
const sessionLocationSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  /** Metres. Nullable because not every device reports one. */
  accuracyM: z.number().finite().min(0).max(20_000_000).nullable().default(null),
});

/**
 * The interface language.
 *
 * An enum, not a free string. The value is written into `<html lang>` by both
 * frontends and selects which catalogue they load, so leaving it unconstrained
 * would turn an account preference into a place to park arbitrary text and
 * have it rendered back into a page attribute.
 */
const languageSchema = z.object({
  language: z.enum(SUPPORTED_LANGUAGES),
});

// --- Cookie helpers --------------------------------------------------------

interface SessionCookies {
  accessToken: string;
  refreshToken: string;
}

function setSessionCookies(reply: FastifyReply, session: SessionCookies, kind: UserKind): string {
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
  const options = {
    path: '/',
    ...(env.COOKIE_DOMAIN.length > 0 ? { domain: env.COOKIE_DOMAIN } : {}),
  };
  const names = cookieNamesFor(kind);

  // Only this surface's cookies. Signing out of the admin panel must not sign
  // the person out of the storefront in the same browser.
  void reply
    .clearCookie(names.access, options)
    .clearCookie(names.refresh, options)
    .clearCookie(names.csrf, options);
}

/**
 * Whether this surface asks a signer-in where they are.
 *
 * The admin console does, when the deployment has it on; the storefront never
 * does. Returned on the user object rather than inferred by the frontend so the
 * panel and the API agree about it - a panel that decided for itself would show
 * the location screen to a deployment that had switched the feature off.
 */
function locationRequiredFor(kind: UserKind): boolean {
  return kind === 'ADMIN' && env.FEATURE_ADMIN_LOGIN_LOCATION;
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
          // The Admin Panel reads this to send a first-time signer-in straight
          // to the change-password screen instead of the dashboard.
          mustChangePassword: result.user.mustChangePassword,
          // A fresh session has no position yet by definition, so this pair
          // sends the panel to the location screen before anything else. Both
          // are false on the customer surface and in a deployment that has the
          // feature switched off.
          locationRequired: locationRequiredFor(kind),
          locationGranted: false,
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
        mustChangePassword: auth.mustChangePassword,
        locationRequired: locationRequiredFor(kind),
        locationGranted: auth.sessionHasLocation,
      });
    });

    // --- Sign-in location (admin surface only) -----------------------------
    //
    // The storefront asks nothing of a shopper's device. This exists because a
    // console shared by several staff accounts needs its sign-ins to be
    // visible to the people running it, which is not a thing to impose on
    // customers.
    if (kind === 'ADMIN') {
      app.post(
        '/session/location',
        {
          preHandler: requireAuthenticated(kind),
          // Every accepted post can trigger one outbound geocode lookup, so the
          // route is capped well below what a person clicking "Allow" could
          // ever need. A browser retrying a denied prompt does not reach here.
          config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
        },
        async (request, reply) => {
          const body = sessionLocationSchema.parse(request.body);
          const auth = currentUser(request);
          const context = requestContext(request);

          const recorded = await recordSessionLocation({
            sessionId: auth.sessionId,
            userId: auth.id,
            userEmail: auth.email,
            latitude: body.latitude,
            longitude: body.longitude,
            accuracyM: body.accuracyM,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            correlationId: context.correlationId,
          });

          return reply.status(200).send({
            locationGranted: true,
            // Echoed back so the panel can confirm what was recorded without a
            // second round trip. `place` is the geocoded name when there was
            // one and the coordinates when there was not.
            place: recorded.label ?? formatCoordinates(recorded.latitude, recorded.longitude),
            recordedAt: recorded.capturedAt.toISOString(),
          });
        },
      );
    }

    /**
     * The interface language for this account.
     *
     * Lives on the auth routes because this factory is registered for both
     * surfaces, so staff and customers get the endpoint from one
     * implementation. The alternative was the same handler written twice, once
     * per account route file, drifting apart the first time either changed.
     *
     * `requireAuthenticated` rather than `requireCustomer` or `requireAdmin`
     * is deliberate and is the reason it sits beside `/password/change`: both
     * have to work for a session that is otherwise refused everywhere. An
     * admin on a temporary password, or a customer part-way through
     * activation, is exactly the person who may need to get out of a language
     * they cannot read.
     *
     * A null reply means never chosen, which is not the same as English - the
     * frontend then falls back to what the browser asks for.
     */
    app.get('/language', { preHandler: requireAuthenticated(kind) }, async (request, reply) => {
      const auth = currentUser(request);
      const language = await getUserLanguage(auth.id);
      return reply.status(200).send({ language });
    });

    app.put('/language', { preHandler: requireAuthenticated(kind) }, async (request, reply) => {
      const auth = currentUser(request);
      const body = languageSchema.parse(request.body);

      const language = await setUserLanguage(auth.id, body.language);

      return reply.status(200).send({ language });
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

      /**
       * Open an account from the storefront.
       *
       * Optional and OFF by default (SOP 7.2); the service refuses outright
       * when the flag is down, so the frontend gets a precise code rather than
       * a 404 it has to guess the meaning of.
       *
       * 202, not 201, and the body carries no account in it. The endpoint
       * answers identically whether an account was created or the address was
       * already registered - see the note at the top of registration.service.ts
       * for why a sign-up form that says "that email is taken" is an
       * enumeration oracle. Nothing is signed in here either: the whole point
       * of the confirmation link is that the address is not trusted yet.
       */
      app.post(
        '/register',
        { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
        async (request, reply) => {
          const body = registerSchema.parse(request.body);
          const context = requestContext(request);

          const outcome = await registerCustomer({
            fullName: body.fullName,
            email: body.email,
            phone: body.phone,
            country: body.country,
            password: body.password,
            organization: body.organization ?? null,
            acceptedTerms: body.acceptedTerms,
            consentVersion: body.consentVersion,
            language: body.language ?? null,
            ipAddress: context.ipAddress,
            correlationId: context.correlationId,
          });

          return reply.status(202).send({
            registered: true,
            requiresApproval: outcome.requiresApproval,
            message:
              'Check your email. If this address can have an account here, a confirmation link is on its way.',
          });
        },
      );

      app.post(
        '/verify-email',
        { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
        async (request, reply) => {
          const body = verifyEmailSchema.parse(request.body);
          const context = requestContext(request);

          const result = await verifyRegistrationEmail({
            token: body.token,
            ipAddress: context.ipAddress,
            correlationId: context.correlationId,
          });

          return reply.status(200).send({
            verified: true,
            email: result.email,
            // ACTIVE means the storefront can sign them in with the password
            // they chose at sign-up; PENDING_APPROVAL means it must not try.
            status: result.status,
          });
        },
      );

      app.post(
        '/verify-email/resend',
        { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
        async (request, reply) => {
          const body = resendVerificationSchema.parse(request.body);
          const context = requestContext(request);

          await resendVerificationEmail(body.email, {
            correlationId: context.correlationId,
          });

          // Uniform, like /password/forgot next door and for the same reason.
          return reply.status(202).send({
            message: 'If that address is waiting on a confirmation link, a new one has been sent.',
          });
        },
      );
    }

    return Promise.resolve();
  };
}
