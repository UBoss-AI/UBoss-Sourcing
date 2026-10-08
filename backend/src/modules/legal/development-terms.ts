/**
 * Placeholder Terms for a developer's machine, so the sign-up form can be used
 * before anybody has written real ones.
 *
 * Called by the development seed only, which refuses to run in production.
 * The text says on its face that it is not an agreement: it is the generic
 * sample supplied with the dialog design, and publishing it for real customers
 * would bind them to words nobody approved. A real deployment publishes its own
 * Terms from Administration → Legal documents, written by its own counsel.
 */
import { legalContentHash, type AgreementDocumentKind } from '../../domain/legal-document.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';

export const DEVELOPMENT_TERMS_VERSION = 'dev-placeholder';

const NOTICE =
  'DEVELOPMENT PLACEHOLDER - NOT A LEGAL AGREEMENT. This text was installed by the development seed so ' +
  'the sign-up form can be tried out. Before going live, publish Terms and Conditions approved by your ' +
  'own legal counsel from Administration > Legal documents.';

const SAMPLE_BODY = `${NOTICE}

## Acceptance of Terms
By accessing and using this website, users agree to comply with and be bound by these Terms of Service. Users who do not agree with these terms should discontinue use of the website immediately.

## User Account Responsibilities
Users are responsible for maintaining the confidentiality of their account credentials. Any activities occurring under a user's account are the sole responsibility of the account holder. Users must notify the website administrators immediately of any unauthorized account access.

## Content Usage and Restrictions
The website and its original content are protected by intellectual property laws. Users may not reproduce, distribute, modify, create derivative works, or commercially exploit any content without explicit written permission from the website owners.

## Limitation of Liability
The website provides content "as is" without any warranties. The website owners shall not be liable for direct, indirect, incidental, consequential, or punitive damages arising from user interactions with the platform.

## User Conduct Guidelines
- Not upload harmful or malicious content
- Respect the rights of other users
- Avoid activities that could disrupt website functionality
- Comply with applicable local and international laws

## Modifications to Terms
The website reserves the right to modify these terms at any time. Continued use of the website after changes constitutes acceptance of the new terms.

## Termination Clause
The website may terminate or suspend user access without prior notice for violations of these terms or for any other reason deemed appropriate by the administration.

## Governing Law
These terms are governed by the laws of the jurisdiction where the website is primarily operated, without regard to conflict of law principles.`;

/**
 * Every document the agreement screen can ask for, so each surface's screen
 * can be tried out. The Privacy Policy placeholder reuses the sample text: it
 * describes nothing, which its notice says.
 */
const TITLES: Record<AgreementDocumentKind, string> = {
  PLATFORM_TERMS: 'Terms and Conditions (development placeholder)',
  LOGISTICS_PARTNER_TERMS: 'Logistics Partner Terms (development placeholder)',
  SELLER_TERMS: 'Seller Addendum (development placeholder)',
  STAFF_TERMS: 'Staff Terms (development placeholder)',
  AUDIT_CONSOLE_TERMS: 'Audit Console Terms (development placeholder)',
  PRIVACY_POLICY: 'Privacy Policy (development placeholder)',
};

/** Publish the placeholder for each kind that has nothing published yet. Idempotent. */
export async function seedDevelopmentTerms(): Promise<number> {
  let published = 0;
  for (const kind of Object.keys(TITLES) as AgreementDocumentKind[]) {
    const existing = await prisma.legalDocument.count({ where: { kind, status: 'PUBLISHED' } });
    if (existing > 0) continue;

    const content = { kind, version: DEVELOPMENT_TERMS_VERSION, locale: 'en', title: TITLES[kind], body: SAMPLE_BODY };
    const now = new Date();
    await prisma.legalDocument.create({
      data: {
        id: newId(),
        ...content,
        status: 'PUBLISHED',
        effectiveAt: now,
        publishedAt: now,
        contentSha256: legalContentHash(content),
      },
    });
    published += 1;
  }
  return published;
}
