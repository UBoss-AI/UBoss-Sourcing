/**
 * The seller team invitation email, in each of the eight languages.
 */
import { describe, expect, it } from 'vitest';
import { INVITATION_LANGUAGES } from '../../src/modules/buyer-companies/invitation-email.js';
import { renderSellerInvitationEmail } from '../../src/modules/seller/team-invitation-email.js';

const WORDS = {
  seller: 'Acme Supplies',
  inviter: 'Olive Owner',
  role: 'ORDER_MANAGER' as const,
  url: 'https://shop.example/account/join-seller?token=abc',
  expires: '2026-10-06',
};

describe('seller team invitation email', () => {
  it.each(INVITATION_LANGUAGES)('names the seller, the inviter, the link and the date in %s', (language) => {
    const message = renderSellerInvitationEmail(language, WORDS);
    expect(message.subject).toContain('Acme Supplies');
    for (const part of [WORDS.inviter, WORDS.url, WORDS.expires, 'Acme Supplies']) expect(message.body).toContain(part);
    // The role is named in words, never as the enum.
    expect(message.body).not.toContain('ORDER_MANAGER');
  });

  it('falls back to English for a language it does not know', () => {
    expect(renderSellerInvitationEmail('xx', WORDS).body).toContain('Order manager');
    expect(renderSellerInvitationEmail(null, WORDS).subject).toBe('Join the Acme Supplies team as Order manager');
  });
});
