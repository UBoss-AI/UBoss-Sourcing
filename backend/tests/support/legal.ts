/**
 * The Terms a test should agree to.
 *
 * `tests/global-setup.ts` installs a published document for each kind, but a
 * test that publishes a newer one leaves that one in force for every file
 * after it. So a test never hard-codes an id: it asks which document is
 * current, the same question the storefront asks.
 */
import type { LegalDocumentKindName } from '../../src/domain/legal-document.js';
import { findCurrentDocument } from '../../src/modules/legal/legal-document.service.js';

export async function currentTerms(
  kind: LegalDocumentKindName = 'PLATFORM_TERMS',
): Promise<{ id: string; version: string; contentSha256: string }> {
  const current = await findCurrentDocument(kind, 'en');
  if (current === null) {
    throw new Error(`No ${kind} are published in the test database. See tests/global-setup.ts.`);
  }
  const { id, version, contentSha256 } = current.document;
  return { id, version, contentSha256 };
}

export async function currentTermsId(kind: LegalDocumentKindName = 'PLATFORM_TERMS'): Promise<string> {
  return (await currentTerms(kind)).id;
}
