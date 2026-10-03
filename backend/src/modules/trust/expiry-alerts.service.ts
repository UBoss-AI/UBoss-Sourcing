/**
 * Telling a supplier BEFORE a verified certificate or factory lapses
 * (JOURNEY-027, "certificates expiry alerts").
 *
 * A lapsed certificate takes its listings off sale and a lapsed factory drops
 * off the public supplier page, so the seller hears about it three times:
 * thirty days out, seven days out, and on the day it lapses. Each notice is
 * keyed on the subject, its end date and the stage, so a worker beat that
 * runs every few minutes says each one once - and a renewal with a new end
 * date starts the count again rather than being silenced by the old notices.
 *
 * Read-only on the trust records: the lapse itself is recorded by the sweeps
 * in `certification.service.ts` and `factory.service.ts`, which call
 * `notifyCertificationLapsed` / `notifyFactoryLapsed` once they have moved
 * the record.
 */
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { notifySeller } from '../seller/notification.service.js';

const DAY = 86_400_000;

/** The two warnings before a lapse, in days. */
export const EXPIRY_WARNING_DAYS = [30, 7] as const;

export type ExpiryStage = 'T30' | 'T7';

/**
 * Which warning is due for an end date, or null when none is. Seven days or
 * fewer is T7; more than seven and up to thirty is T30. A date already past
 * is the lapse, which the sweeps announce.
 */
export function expiryStage(endsAt: Date, now: Date): ExpiryStage | null {
  const left = endsAt.getTime() - now.getTime();
  if (left < 0) return null;
  if (left <= 7 * DAY) return 'T7';
  if (left <= 30 * DAY) return 'T30';
  return null;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The dedupe key for one notice: subject, end date and stage. */
export function expiryDedupeKey(kind: 'cert' | 'factory', id: string, endsAt: Date, stage: ExpiryStage | 'LAPSED'): string {
  return `trust-expiry:${kind}:${id}:${dateOnly(endsAt)}:${stage}`;
}

/** Warn about every verified certificate and factory inside the window. Returns how many notices were attempted. */
export async function sendTrustExpiryAlerts(now: Date = new Date(), limit = 500): Promise<number> {
  const horizon = new Date(now.getTime() + 30 * DAY);
  let sent = 0;
  const policy = await prisma.trustSettings.findUnique({ where: { id: 'default' }, select: { certificateExpiryPolicy: true } });

  const certificates = await prisma.sellerCertification.findMany({
    where: { state: 'VERIFIED', archivedAt: null, expiresOn: { gte: new Date(`${dateOnly(now)}T00:00:00.000Z`), lte: horizon } },
    select: { id: true, sellerAccountId: true, standard: true, expiresOn: true },
    take: limit,
  });
  for (const row of certificates) {
    if (row.expiresOn === null) continue;
    // A date-only column: the certificate is good to the end of that day.
    const endsAt = new Date(`${dateOnly(row.expiresOn)}T23:59:59.999Z`);
    const stage = expiryStage(endsAt, now);
    if (stage === null) continue;
    try {
      await notifySeller({
        sellerAccountId: row.sellerAccountId,
        kind: 'DOCUMENT_EXPIRING',
        title: `Your ${row.standard} certificate expires on ${dateOnly(row.expiresOn)}`,
        body:
          stage === 'T7'
            ? policy?.certificateExpiryPolicy === 'HOLD_LISTINGS'
              ? 'It expires within a week. Upload the renewed certificate and send it for review now, or the listings it covers go off sale when it lapses.'
              : 'It expires within a week. Upload the renewed certificate and send it for review now; it will stop showing as verified when it lapses.'
            : 'It expires within thirty days. Upload the renewed certificate and send it for review before then.',
        linkPath: '/seller/factories',
        severity: stage === 'T7' ? 'WARNING' : 'INFO',
        subjectType: 'seller_certification',
        subjectId: row.id,
        dedupeKey: expiryDedupeKey('cert', row.id, row.expiresOn, stage),
      });
      sent += 1;
    } catch (error) {
      logger.error({ err: error, certificationId: row.id }, 'certificate expiry warning failed');
    }
  }

  const checks = await prisma.sellerTrustCheck.findMany({
    where: { kind: 'FACTORY', isCurrent: true, state: 'VERIFIED', validUntil: { gt: now, lte: horizon } },
    select: { sellerAccountId: true, subjectId: true, validUntil: true },
    take: limit,
  });
  const names = new Map(
    (
      await prisma.sellerFactory.findMany({
        where: { id: { in: checks.map((check) => check.subjectId) } },
        select: { id: true, name: true },
      })
    ).map((factory) => [factory.id, factory.name]),
  );
  for (const check of checks) {
    if (check.validUntil === null) continue;
    const stage = expiryStage(check.validUntil, now);
    if (stage === null) continue;
    const name = names.get(check.subjectId) ?? 'A factory';
    try {
      await notifySeller({
        sellerAccountId: check.sellerAccountId,
        kind: 'DOCUMENT_EXPIRING',
        title: `${name}: verification ends on ${dateOnly(check.validUntil)}`,
        body:
          stage === 'T7'
            ? 'The verification ends within a week. Send the factory for review again now, or it leaves your public supplier profile when it lapses.'
            : 'The verification ends within thirty days. Send the factory for review again before then.',
        linkPath: '/seller/factories',
        severity: stage === 'T7' ? 'WARNING' : 'INFO',
        subjectType: 'seller_factory',
        subjectId: check.subjectId,
        dedupeKey: expiryDedupeKey('factory', check.subjectId, check.validUntil, stage),
      });
      sent += 1;
    } catch (error) {
      logger.error({ err: error, factoryId: check.subjectId }, 'factory expiry warning failed');
    }
  }

  return sent;
}

/** Said once, after the sweep has recorded the certificate as EXPIRED. */
export async function notifyCertificationLapsed(row: {
  id: string;
  sellerAccountId: string;
  standard: string;
  expiresOn: Date | null;
}): Promise<void> {
  const endsAt = row.expiresOn ?? new Date();
  await notifySeller({
    sellerAccountId: row.sellerAccountId,
    kind: 'DOCUMENT_EXPIRING',
    title: `Your ${row.standard} certificate has expired`,
    body: 'It passed its expiry date, so it no longer counts as verified. Upload the renewed certificate and send it for review.',
    linkPath: '/seller/factories',
    severity: 'WARNING',
    subjectType: 'seller_certification',
    subjectId: row.id,
    dedupeKey: expiryDedupeKey('cert', row.id, endsAt, 'LAPSED'),
  });
}

/** Said once, after the sweep has recorded the factory verification as EXPIRED. */
export async function notifyFactoryLapsed(input: {
  sellerAccountId: string;
  factoryId: string;
  validUntil: Date;
}): Promise<void> {
  const factory = await prisma.sellerFactory.findUnique({ where: { id: input.factoryId }, select: { name: true } });
  await notifySeller({
    sellerAccountId: input.sellerAccountId,
    kind: 'DOCUMENT_EXPIRING',
    title: `${factory?.name ?? 'A factory'}: verification has ended`,
    body: 'Its verification reached its end date, so it no longer shows on your public supplier profile. Send it for review again.',
    linkPath: '/seller/factories',
    severity: 'WARNING',
    subjectType: 'seller_factory',
    subjectId: input.factoryId,
    dedupeKey: expiryDedupeKey('factory', input.factoryId, input.validUntil, 'LAPSED'),
  });
}
