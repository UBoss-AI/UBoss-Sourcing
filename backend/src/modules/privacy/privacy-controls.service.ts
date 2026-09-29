/**
 * The privacy controls an operator is answerable for, read back from what the
 * deployment is actually configured to do.
 *
 * DOD-031. A retention schedule written in a policy document and a list of
 * processors kept in a spreadsheet are both wrong within a quarter, and the
 * operator - the controller, in GDPR terms - is the one who has to answer for
 * them. So instead of asking anyone to keep a copy in step, the console shows:
 *
 *   1. RETENTION SCHEDULE. Every `RETENTION_*` window (and the two windows
 *      named otherwise) with its current value, what it removes, and whether
 *      it is switched off. Read from `env` at request time, so what the screen
 *      says is exactly what the sweeps in `retention.service.ts` and
 *      `infra/housekeeping.ts` will do tonight.
 *
 *   2. PROCESSING REGISTER. Every outside party this installation can send
 *      personal data to, whether it is switched on in THIS deployment, the
 *      host it goes to, and which categories of data travel. The raw material
 *      for the operator's record of processing activities (Art. 30) and their
 *      sub-processor list - not the record itself, which names purposes,
 *      lawful bases and transfer safeguards that are the operator's legal
 *      decisions, not this software's.
 *
 * Nothing here returns a credential, a key or a full URL with a query string:
 * the host name is enough to say where data goes.
 *
 * The English wording of each row lives in the admin console's translations,
 * keyed by `id`, so the screen reads in all eight languages. The API returns
 * ids and numbers only.
 */
import { env } from '../../config/env.js';
import { prisma } from '../../infra/prisma.js';
import { activeProvider } from '../assistant/assistant.service.js';

export type RetentionCategory = 'PERSONAL_DATA' | 'OPERATIONAL';

export interface RetentionRule {
  /** The setting that controls it, e.g. RETENTION_AUDIT_LOG_DAYS. */
  setting: string;
  /** Current value from the environment. */
  value: number;
  unit: 'DAYS' | 'HOURS';
  category: RetentionCategory;
  /**
   * False when the value switches the sweep off - `0` for every window that
   * allows it - which keeps the data for ever. The screen says so rather than
   * showing "0 days", which reads as "deleted immediately".
   */
  enforced: boolean;
  /** Whether 0 is a permitted value for this setting at all. */
  zeroDisables: boolean;
}

/**
 * Every retention window, in the order the screen lists them.
 *
 * A new `RETENTION_*` setting that is not listed here fails
 * `tests/unit/privacy-controls.test.ts`, which reads env.ts - a window the
 * operator cannot see is one they cannot answer for.
 */
export function retentionSchedule(): RetentionRule[] {
  const rule = (
    setting: string,
    value: number,
    category: RetentionCategory,
    options: { unit?: 'DAYS' | 'HOURS'; zeroDisables?: boolean } = {},
  ): RetentionRule => {
    const zeroDisables = options.zeroDisables ?? true;
    return {
      setting,
      value,
      unit: options.unit ?? 'DAYS',
      category,
      enforced: !(zeroDisables && value === 0),
      zeroDisables,
    };
  };

  return [
    rule('RETENTION_ABANDONED_CART_DAYS', env.RETENTION_ABANDONED_CART_DAYS, 'PERSONAL_DATA'),
    rule(
      'RETENTION_ASSISTANT_CONVERSATION_DAYS',
      env.RETENTION_ASSISTANT_CONVERSATION_DAYS,
      'PERSONAL_DATA',
    ),
    rule('RETENTION_AUDIT_LOG_DAYS', env.RETENTION_AUDIT_LOG_DAYS, 'PERSONAL_DATA'),
    rule('RETENTION_SENT_NOTIFICATION_DAYS', env.RETENTION_SENT_NOTIFICATION_DAYS, 'PERSONAL_DATA'),
    rule('RETENTION_SESSION_LOCATION_DAYS', env.RETENTION_SESSION_LOCATION_DAYS, 'PERSONAL_DATA'),
    rule(
      'RETENTION_LOGISTICS_LOCATION_PING_DAYS',
      env.RETENTION_LOGISTICS_LOCATION_PING_DAYS,
      'PERSONAL_DATA',
    ),
    rule('PREORDER_CHAT_RETENTION_DAYS', env.PREORDER_CHAT_RETENTION_DAYS, 'PERSONAL_DATA'),
    rule('DATA_REQUEST_DOWNLOAD_TTL_HOURS', env.DATA_REQUEST_DOWNLOAD_TTL_HOURS, 'PERSONAL_DATA', {
      unit: 'HOURS',
      zeroDisables: false,
    }),
    rule('RETENTION_PAYMENT_EVENT_DAYS', env.RETENTION_PAYMENT_EVENT_DAYS, 'OPERATIONAL'),
    rule('RETENTION_EXPIRED_SESSION_DAYS', env.RETENTION_EXPIRED_SESSION_DAYS, 'OPERATIONAL'),
    rule('RETENTION_JOB_HISTORY_DAYS', env.RETENTION_JOB_HISTORY_DAYS, 'OPERATIONAL'),
    rule('FX_SNAPSHOT_RETENTION_DAYS', env.FX_SNAPSHOT_RETENTION_DAYS, 'OPERATIONAL', {
      zeroDisables: false,
    }),
  ];
}

/** The categories of personal data a processor can receive. */
export type DataCategory =
  | 'CONTACT_DETAILS'
  | 'ORDER_DETAILS'
  | 'PAYMENT_DETAILS'
  | 'UPLOADED_FILES'
  | 'CHAT_MESSAGES'
  | 'LOCATION'
  | 'BUSINESS_IDENTIFIERS'
  | 'IP_ADDRESS';

export interface ProcessorEntry {
  /** Stable id; the console translates its name and purpose from it. */
  id: string;
  /** Switched on in this deployment right now. */
  active: boolean;
  /**
   * Where the data goes: a host name only, never a path, query string or
   * credential. Null when the processor is not configured, or where the host
   * is chosen per seller (carriers) rather than by the operator.
   */
  host: string | null;
  dataCategories: DataCategory[];
  /** Who configures it: the operator in the environment/console, or each seller. */
  configuredBy: 'OPERATOR' | 'SELLER';
}

/** The host of a configured URL, or null for an empty or unreadable one. */
export function hostOf(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  try {
    // Templates such as `{lat}` are valid in a path but not in a host; the
    // host part of every shipped template is literal.
    return new URL(trimmed.replace(/\{[^}]*\}/g, 'x')).hostname || null;
  } catch {
    // A bare host name, as SMTP_HOST is.
    return /^[A-Za-z0-9.-]+$/.test(trimmed) ? trimmed : null;
  }
}

export async function processingRegister(): Promise<ProcessorEntry[]> {
  const gateways = await prisma.paymentProviderConnection.findMany({
    where: { isActive: true },
    select: { provider: true },
  });
  const activeGateways = new Set(gateways.map((gateway) => String(gateway.provider)));

  // The same decision the assistant itself makes, so the register cannot say
  // "off" while chat messages are in fact leaving for a provider.
  const assistant = activeProvider();
  const assistantHost =
    assistant === null
      ? null
      : assistant.name === 'gemini'
        ? 'generativelanguage.googleapis.com'
        : 'api.anthropic.com';

  const s3Host =
    env.STORAGE_DRIVER === 's3'
      ? (hostOf(env.S3_ENDPOINT) ??
        (env.S3_REGION === '' ? 's3.amazonaws.com' : `s3.${env.S3_REGION}.amazonaws.com`))
      : null;

  return [
    {
      id: 'STRIPE',
      active: activeGateways.has('STRIPE'),
      host: activeGateways.has('STRIPE') ? 'api.stripe.com' : null,
      dataCategories: ['CONTACT_DETAILS', 'ORDER_DETAILS', 'PAYMENT_DETAILS', 'IP_ADDRESS'],
      configuredBy: 'OPERATOR',
    },
    {
      id: 'RAZORPAY',
      active: activeGateways.has('RAZORPAY'),
      host: activeGateways.has('RAZORPAY') ? 'api.razorpay.com' : null,
      dataCategories: ['CONTACT_DETAILS', 'ORDER_DETAILS', 'PAYMENT_DETAILS'],
      configuredBy: 'OPERATOR',
    },
    {
      id: 'EMAIL_SMTP',
      active: env.EMAIL_DRIVER === 'smtp',
      host: env.EMAIL_DRIVER === 'smtp' ? hostOf(env.SMTP_HOST) : null,
      dataCategories: ['CONTACT_DETAILS', 'ORDER_DETAILS'],
      configuredBy: 'OPERATOR',
    },
    {
      id: 'OBJECT_STORAGE',
      active: env.STORAGE_DRIVER === 's3',
      host: s3Host,
      dataCategories: ['UPLOADED_FILES', 'BUSINESS_IDENTIFIERS'],
      configuredBy: 'OPERATOR',
    },
    {
      id: 'AI_ASSISTANT',
      active: assistantHost !== null,
      host: assistantHost,
      dataCategories: ['CHAT_MESSAGES', 'UPLOADED_FILES'],
      configuredBy: 'OPERATOR',
    },
    {
      id: 'MALWARE_SCANNER',
      active: env.MALWARE_SCANNER_DRIVER === 'clamav',
      host: env.MALWARE_SCANNER_DRIVER === 'clamav' ? hostOf(env.MALWARE_SCANNER_HOST) : null,
      dataCategories: ['UPLOADED_FILES'],
      configuredBy: 'OPERATOR',
    },
    {
      id: 'GEOCODER',
      active: env.GEOCODE_REVERSE_URL.trim() !== '' || env.GEOCODE_FORWARD_URL.trim() !== '',
      host: hostOf(env.GEOCODE_REVERSE_URL) ?? hostOf(env.GEOCODE_FORWARD_URL),
      dataCategories: ['LOCATION'],
      configuredBy: 'OPERATOR',
    },
    {
      id: 'VAT_CHECK',
      active: env.VIES_CHECK_URL.trim() !== '',
      host: hostOf(env.VIES_CHECK_URL),
      dataCategories: ['BUSINESS_IDENTIFIERS'],
      configuredBy: 'OPERATOR',
    },
    {
      id: 'CARRIERS',
      // Whether any is used is each seller's decision; the operator cannot
      // switch it off here, only see that it exists.
      active: true,
      host: null,
      dataCategories: ['CONTACT_DETAILS', 'ORDER_DETAILS'],
      configuredBy: 'SELLER',
    },
  ];
}
