/**
 * Account -> Automatic payment.
 *
 * The one part of the ERP/payments work that belongs to the CUSTOMER rather
 * than to the business, and it has to: nobody can consent on somebody else's
 * behalf to money leaving their account. That is not a preference about where a
 * screen lives, it is what makes an off-session charge lawful.
 *
 * Two different ERP surfaces exist and neither is this one. The OPERATOR's
 * warehouse system is configured under Settings -> ERP (`erp.admin.ts`). A
 * BUYER's own purchasing system is configured in their account
 * (`customer-erp.customer.ts`). This file is about money, not about either.
 *
 * Every handler derives the customer from the session. There is no
 * `?customerId=` anywhere, and no handler reads an owner from the request.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ErrorCode, forbidden } from '../../domain/errors.js';
import {
  type AutoPayActor,
  disableAutoPay,
  enableAutoPay,
  getAutoPaySettings,
  setAutoPayPaused,
  updateAutoPaySettings,
} from '../../modules/payments/autopay.service.js';
import { currentUser, requireCustomer } from '../plugins/auth.js';

function actorFor(request: FastifyRequest): AutoPayActor {
  const auth = currentUser(request);

  return {
    customerProfileId: auth.customerProfileId ?? '',
    userId: auth.id,
    email: auth.email,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    correlationId: request.correlationId,
  };
}

/**
 * An amount typed into a limit field, as MINOR units.
 *
 * Accepted as a string and converted with `BigInt`, never `Number`. A JS number
 * loses precision above 2^53, which for a currency with no minor units is a
 * real total rather than a theoretical one - see CLAUDE.md.
 */
const minorAmountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,18}$/, 'Enter a whole amount in minor units.')
  .nullable()
  .optional();

function toMinor(value: string | null | undefined): bigint | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return BigInt(value);
}

export function registerCustomerAutoPayRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCustomer);

  const requireFeature = async (): Promise<void> => {
    if (!env.FEATURE_CUSTOMER_AUTOPAY) {
      throw forbidden(
        ErrorCode.FEATURE_DISABLED,
        'Automatic payment is not enabled for this store.',
      );
    }
    await Promise.resolve();
  };

  /**
   * Ungated read.
   *
   * A customer whose store has switched the feature off should see that it is
   * off, rather than a 403 the screen has to guess the meaning of.
   */
  app.get('/', async (request, reply) => {
    const auth = currentUser(request);
    const settings = await getAutoPaySettings(auth.customerProfileId ?? '');

    return reply.status(200).send({
      autoPay: settings,
      available: env.FEATURE_CUSTOMER_AUTOPAY,
      consentVersion: env.AUTOPAY_CONSENT_VERSION,
    });
  });

  app.post(
    '/',
    {
      preHandler: requireFeature,
      config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const body = z
        .object({
          paymentMethodId: z.string().length(26),
          /**
           * Must be true, and the service refuses without it. A default of true
           * would be a system consenting on somebody's behalf.
           */
          consentAccepted: z.boolean(),
          maxTransactionMinor: minorAmountSchema,
          approvalThresholdMinor: minorAmountSchema,
          limitCurrency: z.string().trim().length(3).nullable().optional(),
          retryPreference: z.enum(['NONE', 'ONCE', 'STANDARD']).optional(),
          notifyOnCharge: z.boolean().optional(),
          notifyOnFailure: z.boolean().optional(),
        })
        .parse(request.body);

      const settings = await enableAutoPay(actorFor(request), {
        paymentMethodId: body.paymentMethodId,
        consentAccepted: body.consentAccepted,
        maxTransactionMinor: toMinor(body.maxTransactionMinor),
        approvalThresholdMinor: toMinor(body.approvalThresholdMinor),
        ...(body.limitCurrency === undefined ? {} : { limitCurrency: body.limitCurrency }),
        ...(body.retryPreference === undefined ? {} : { retryPreference: body.retryPreference }),
        ...(body.notifyOnCharge === undefined ? {} : { notifyOnCharge: body.notifyOnCharge }),
        ...(body.notifyOnFailure === undefined ? {} : { notifyOnFailure: body.notifyOnFailure }),
      });

      return reply.status(200).send({ autoPay: settings });
    },
  );

  app.patch('/', { preHandler: requireFeature }, async (request, reply) => {
    const body = z
      .object({
        paymentMethodId: z.string().length(26).optional(),
        maxTransactionMinor: minorAmountSchema,
        approvalThresholdMinor: minorAmountSchema,
        limitCurrency: z.string().trim().length(3).nullable().optional(),
        retryPreference: z.enum(['NONE', 'ONCE', 'STANDARD']).optional(),
        notifyOnCharge: z.boolean().optional(),
        notifyOnFailure: z.boolean().optional(),
      })
      .parse(request.body);

    const settings = await updateAutoPaySettings(actorFor(request), {
      ...(body.paymentMethodId === undefined ? {} : { paymentMethodId: body.paymentMethodId }),
      ...(body.maxTransactionMinor === undefined
        ? {}
        : { maxTransactionMinor: toMinor(body.maxTransactionMinor) }),
      ...(body.approvalThresholdMinor === undefined
        ? {}
        : { approvalThresholdMinor: toMinor(body.approvalThresholdMinor) }),
      ...(body.limitCurrency === undefined ? {} : { limitCurrency: body.limitCurrency }),
      ...(body.retryPreference === undefined ? {} : { retryPreference: body.retryPreference }),
      ...(body.notifyOnCharge === undefined ? {} : { notifyOnCharge: body.notifyOnCharge }),
      ...(body.notifyOnFailure === undefined ? {} : { notifyOnFailure: body.notifyOnFailure }),
    });

    return reply.status(200).send({ autoPay: settings });
  });

  app.post('/pause', { preHandler: requireFeature }, async (request, reply) => {
    const { paused } = z.object({ paused: z.boolean() }).parse(request.body);
    const settings = await setAutoPayPaused(actorFor(request), paused);

    return reply.status(200).send({ autoPay: settings });
  });

  /**
   * Withdraw consent.
   *
   * Deliberately NOT behind `requireFeature`. A customer must always be able to
   * switch off an authority they gave, including on a deployment that has since
   * turned the feature off - a right to withdraw that depends on a flag is not
   * a right.
   */
  app.delete('/', async (request, reply) => {
    const settings = await disableAutoPay(actorFor(request));

    return reply.status(200).send({ autoPay: settings });
  });

  return Promise.resolve();
}
