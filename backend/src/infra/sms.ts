/**
 * Text messages through the operator's own SMS gateway (checklist JOURNEY-008).
 *
 * Provider-agnostic on purpose: a self-hosted marketplace picks its own
 * gateway, and most offer, or can be fronted by, a plain HTTPS endpoint. With
 * SMS_HTTP_URL set, a message is POSTed there as JSON
 * `{ "to": "+49...", "from": "<SMS_SENDER_ID>", "body": "..." }` with
 * `Authorization: Bearer <SMS_HTTP_TOKEN>`; any 2xx is "accepted by the
 * gateway", which is all this layer can know - delivery to the handset is the
 * gateway's report, not ours.
 *
 * Without SMS_HTTP_URL nothing is sent and callers fall back to email, saying
 * so. Nothing anywhere calls the gateway "connected" until a message it sent
 * was accepted.
 */
import { env } from '../config/env.js';
import { logger } from './logger.js';

export function smsConfigured(): boolean {
  return env.SMS_HTTP_URL !== undefined && env.SMS_HTTP_URL !== '';
}

export class SmsDeliveryError extends Error {}

/** Send one message. Throws SmsDeliveryError when the gateway refuses or cannot be reached. */
export async function sendSms(to: string, body: string): Promise<void> {
  if (!smsConfigured()) throw new SmsDeliveryError('No SMS gateway is configured.');
  let response: Response;
  try {
    response = await fetch(env.SMS_HTTP_URL as string, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.SMS_HTTP_TOKEN === undefined || env.SMS_HTTP_TOKEN === '' ? {} : { authorization: `Bearer ${env.SMS_HTTP_TOKEN}` }),
      },
      body: JSON.stringify({ to, from: env.SMS_SENDER_ID, body }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    // The number is personal data and the body may hold a sign-in link: neither is logged.
    logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'sms gateway unreachable');
    throw new SmsDeliveryError('The SMS gateway could not be reached.');
  }
  if (!response.ok) {
    logger.warn({ status: response.status }, 'sms gateway refused a message');
    throw new SmsDeliveryError(`The SMS gateway answered ${String(response.status)}.`);
  }
}
