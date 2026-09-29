/**
 * "Was this you?" - an email when a storefront account signs in from somewhere
 * new.
 *
 * WHAT COUNTS AS NEW
 *
 * A sign-in whose DEVICE and NETWORK together match none of this account's
 * other sign-ins in the last LOGIN_ALERT_LOOKBACK_DAYS. Both, because either
 * one alone is the interesting case: the same laptop on a network it has never
 * used (somebody travelling - or a stolen session replayed from elsewhere), or
 * a device never seen before on the home network.
 *
 *   - The device is the browser family and operating system read from the
 *     User-Agent, never the version. A browser updates itself every few weeks
 *     and an alert on every update would teach people to ignore the alert.
 *   - The network is the /24 of an IPv4 address or the /48 of an IPv6 one. A
 *     home connection's address moves inside its block; it rarely leaves it.
 *
 * The history is `sessions`, the rows this system already keeps - there is no
 * second table of devices to fall out of step with them, and nothing new to
 * disclose in a data export. A storefront session carries no geolocation (only
 * the console asks the browser where it is), so the alert names the address
 * and the device, and a place only if one was recorded.
 *
 * An account's very first sign-in sends nothing: there is nothing to compare
 * it with, and "welcome, somebody signed in" is noise on the day they sign up.
 * The email says what to do if it was not them - change the password, which
 * ends every session - and never carries a link that signs anybody in.
 */
import { env } from '../../config/env.js';
import { prisma } from '../../infra/prisma.js';
import { logger } from '../../infra/logger.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { enqueueNotification } from '../notifications/notification.service.js';

/** Browser family and operating system, e.g. "Firefox on Windows". */
export function describeDevice(userAgent: string | null | undefined): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Another browser';
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'an unknown system';
  return `${browser} on ${os}`;
}

/** The block an address sits in: /24 for IPv4, /48 for IPv6. */
export function networkKey(ipAddress: string | null | undefined): string {
  const ip = (ipAddress ?? '').trim().toLowerCase();
  if (ip.length === 0) return 'unknown';

  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  const v4 = mapped?.[1] ?? (/^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null);
  if (v4 !== null) return `${v4.split('.').slice(0, 3).join('.')}.0/24`;

  // Expand "::" enough to take the first three groups.
  const [head = ''] = ip.split('::');
  const groups = head.split(':').filter((group) => group.length > 0);
  while (groups.length < 3) groups.push('0');
  return `${groups.slice(0, 3).join(':')}::/48`;
}

/**
 * Compare this sign-in with the account's recent ones and, when it is new,
 * queue the alert. Never throws: a failed alert must not fail a sign-in that
 * has already succeeded.
 */
export async function maybeSendNewSignInAlert(params: {
  userId: string;
  email: string;
  sessionId: string;
  ipAddress: string | null;
  userAgent: string | null;
  correlationId?: string | null;
}): Promise<{ alerted: boolean }> {
  if (!env.FEATURE_LOGIN_ALERTS) return { alerted: false };

  try {
    const since = new Date(Date.now() - env.LOGIN_ALERT_LOOKBACK_DAYS * 86_400_000);
    const previous = await prisma.session.findMany({
      where: { userId: params.userId, id: { not: params.sessionId }, createdAt: { gte: since } },
      select: { userAgent: true, ipAddress: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    // The first sign-in on record: nothing to compare against.
    if (previous.length === 0) return { alerted: false };

    const device = describeDevice(params.userAgent);
    const network = networkKey(params.ipAddress);
    const seen = previous.some(
      (row) => describeDevice(row.userAgent) === device && networkKey(row.ipAddress) === network,
    );
    if (seen) return { alerted: false };

    const at = new Date();
    await enqueueNotification({
      eventKey: 'user.new_sign_in',
      recipientEmail: params.email,
      variables: {
        device,
        ipAddress: params.ipAddress ?? 'unknown',
        signedInAt: at.toISOString(),
        // The reset page rather than a signed-in one: somebody who is locked
        // out can still use it, and changing the password ends every session.
        passwordUrl: `${env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/$/, '')}/forgot-password`,
      },
      dedupeKey: `new-sign-in:${params.sessionId}`,
      relatedType: 'user',
      relatedId: params.userId,
      correlationId: params.correlationId ?? null,
    });

    await recordAudit({
      action: AuditAction.USER_NEW_DEVICE_SIGN_IN,
      resourceType: 'user',
      resourceId: params.userId,
      actorType: 'SYSTEM',
      actorEmail: params.email,
      after: { device, network, sessionId: params.sessionId },
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      correlationId: params.correlationId ?? null,
    });

    return { alerted: true };
  } catch (error) {
    logger.warn({ err: error, userId: params.userId }, 'new sign-in alert could not be queued');
    return { alerted: false };
  }
}
