/**
 * Every e-mail is signed with the deployment's own name and support address.
 *
 * `enqueueNotification` used to fill `{{businessName}}` with the product's
 * name and `{{supportEmail}}` with `support@uboss.example` whenever a caller
 * passed neither - which almost every caller did - so a buyer's customers were
 * told to write to the software vendor. Both now come from the business
 * profile, and a caller that passes its own still wins.
 *
 * Reads the profile and never changes it: it is global reference data other
 * files depend on. Every outbox row written here is removed in afterAll.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { enqueueNotification, NotificationEvent } from '../../src/modules/notifications/notification.service.js';

const written: string[] = [];

afterAll(async () => {
  await prisma.notificationOutbox.deleteMany({ where: { id: { in: written } } });
});

async function enqueue(variables?: Record<string, string>): Promise<Record<string, unknown>> {
  const id = await enqueueNotification({
    eventKey: NotificationEvent.CUSTOMER_INVITATION,
    recipientEmail: `branding-${newId()}@example.test`,
    recipientName: 'A Buyer',
    dedupeKey: `notification-branding:${newId()}`,
    ...(variables === undefined ? {} : { variables }),
  });
  expect(id).not.toBeNull();
  written.push(id ?? '');

  const row = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: id ?? '' } });
  return row.payloadJson as Record<string, unknown>;
}

describe('notification branding', () => {
  it('signs an e-mail with the business profile, not the vendor', async () => {
    const profile = await prisma.businessProfile.findFirst({
      select: { displayName: true, supportEmail: true },
    });

    const payload = await enqueue();

    expect(payload['businessName']).toBe(profile?.displayName.trim() || 'Glovia');
    expect(payload['supportEmail']).toBe(profile?.supportEmail ?? env.EMAIL_FROM_ADDRESS);
    expect(JSON.stringify(payload)).not.toContain('uboss.example');
  });

  it('lets a caller that names its own business win', async () => {
    const payload = await enqueue({ businessName: 'Northwind Supply', supportEmail: 'help@northwind.test' });

    expect(payload['businessName']).toBe('Northwind Supply');
    expect(payload['supportEmail']).toBe('help@northwind.test');
  });
});
