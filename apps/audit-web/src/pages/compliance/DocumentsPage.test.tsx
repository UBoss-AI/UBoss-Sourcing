/**
 * A document opened from a notification link shows what was checked in plain
 * words - never that it is "authentic" - and a reviewer approving it records
 * how it was checked.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { api } from '@/lib/api';
import type { ComplianceDocument, DocumentDetail, DocumentRow } from '@/lib/console-types';
import { Permission, holdsAll, holdsAny } from '@/lib/permissions';
import { sessionFor } from '@/test/session-fixture';
import { DocumentsPage } from '../DocumentsPage';

function documentOf(overrides: Partial<ComplianceDocument>): ComplianceDocument {
  return {
    id: 'doc-1',
    sellerAccountId: 'seller-1',
    documentType: 'CERTIFICATE',
    standard: 'ISO 13485',
    certificateNumber: 'Q5-123',
    issuer: 'Notified Body Ltd',
    issuingCountry: 'DE',
    legalEntityName: null,
    factoryId: null,
    categoryScopeIds: ['cat-1'],
    productScopeIds: [],
    modelScope: null,
    scope: null,
    requirementCodes: ['ISO-13485'],
    issuedOn: '2025-01-01',
    expiresOn: '2028-01-01',
    noExpiryReason: null,
    reviewStatus: 'APPROVED',
    badge: 'EVIDENCE_REVIEWED_REGISTER_UNAVAILABLE',
    verificationMethod: 'REGISTRY_LOOKUP',
    verificationOutcome: 'UNABLE_TO_VERIFY',
    verificationSource: 'Public register',
    verifiedAt: '2026-09-01T10:00:00.000Z',
    reviewMessage: null,
    internalNote: 'Register offline for maintenance.',
    reviewerLabel: 'Reviewer One',
    revision: 1,
    supersedesId: null,
    supersededAt: null,
    suspendedReason: null,
    hasFile: false,
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

function renderPage(entry: string, permissions: string[]): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = sessionFor({ role: 'COMPLIANCE_REVIEWER', permissions });
  const value: SessionState = {
    stage: 'READY',
    session,
    notice: null,
    signIn: vi.fn(),
    signOut: vi.fn(),
    refresh: vi.fn(),
    can: (...keys) => holdsAll(session.member.permissions, keys),
    canAny: (...keys) => holdsAny(session.member.permissions, keys),
  };
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SessionContext.Provider value={value}>
            <MemoryRouter initialEntries={[entry]}>
              <DocumentsPage />
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

function mockReads(document: ComplianceDocument): void {
  vi.spyOn(api, 'get').mockImplementation((path: string) => {
    if (path === '/audit/documents') {
      const row: DocumentRow = { ...document, sellerName: 'Northwind Medical' };
      return Promise.resolve({ documents: [row] });
    }
    const detail: DocumentDetail = { document, file: null, versions: [], history: [] };
    return Promise.resolve(detail);
  });
}

beforeAll(() => {
  window.scrollTo = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a compliance document', () => {
  it('opens from ?document= and says what was checked, never that it is authentic', async () => {
    mockReads(documentOf({}));

    renderPage('/documents?document=doc-1', [Permission.DOCUMENT_READ]);

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Evidence reviewed; the register could not be checked')).toBeDefined();
    expect(within(dialog).getByText('Could not be checked with an outside source')).toBeDefined();
    expect(dialog.textContent).not.toMatch(/authentic|fraud/i);
    // No review permission: no review form.
    expect(within(dialog).queryByRole('group', { name: 'Decision' })).toBeNull();
  });

  it('approves with the method, the outcome and the confirmed scope', async () => {
    mockReads(documentOf({ reviewStatus: 'UNDER_REVIEW', badge: null, verificationMethod: null, verificationOutcome: 'NOT_CHECKED' }));
    const post = vi.spyOn(api, 'post').mockResolvedValue({ ok: true });
    const user = userEvent.setup();

    renderPage('/documents?document=doc-1', [Permission.DOCUMENT_READ, Permission.CASE_REVIEW]);

    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('radio', { name: 'Approve' }));
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));

    expect(post).toHaveBeenCalledWith(
      '/audit/documents/doc-1/approve',
      expect.objectContaining({
        expectedStatus: 'UNDER_REVIEW',
        verificationMethod: 'MANUAL_EVIDENCE',
        verificationOutcome: 'NOT_CHECKED',
        categoryScopeIds: ['cat-1'],
        requirementCodes: ['ISO-13485'],
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String) as unknown }),
    );
  });
});
