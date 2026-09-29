/**
 * The identity check on the customer page (checklist Master row 11).
 *
 *   - a customer reader sees the details but no decision buttons;
 *   - a reviewer cannot verify before the identity document is accepted,
 *     and accepting it sends the decision for that document;
 *   - verifying sends the decision for the whole check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { CustomerKycPanel, type CustomerKyc } from './CustomerKycPanel';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() }, downloadFile: vi.fn() };
});

const { api, downloadFile, ApiError } = await import('@/lib/api');
const get = vi.mocked(api.get);
const post = vi.mocked(api.post);

function kyc(overrides: Partial<CustomerKyc> = {}): CustomerKyc {
  return {
    status: 'SUBMITTED',
    identity: {
      legalName: 'Dana Kowalska',
      dateOfBirth: '1988-04-02',
      nationality: 'PL',
      residenceCountry: 'DE',
      idDocumentType: 'PASSPORT',
      idDocumentNumberMasked: '•••••4567',
      idDocumentExpiresOn: '2031-01-31',
    },
    importer: {
      isImporter: false,
      importerName: null,
      eoriNumber: null,
      importerTaxId: null,
      importLicenceNumber: null,
      customsBrokerName: null,
      customsBrokerEmail: null,
      preferredIncoterm: null,
    },
    submittedAt: '2026-09-29T10:00:00.000Z',
    reviewedAt: null,
    reviewNote: null,
    documents: [
      { id: 'doc1', kind: 'IDENTITY', status: 'PENDING', fileName: 'passport.pdf', sizeBytes: 100, reviewNote: null, createdAt: '2026-09-29T09:00:00.000Z' },
    ],
    ...overrides,
  };
}

const ACCEPTED_DOCUMENT: CustomerKyc['documents'][number] = {
  id: 'doc1',
  kind: 'IDENTITY',
  status: 'ACCEPTED',
  fileName: 'passport.pdf',
  sizeBytes: 100,
  reviewNote: null,
  createdAt: '2026-09-29T09:00:00.000Z',
};

function renderPanel(permissions: string[]): void {
  const session = {
    user: { id: 'u1', email: 'finance@example.test' },
    isLoading: false,
    can: (permission: string) => permissions.includes(permission),
    canAny: (...wanted: string[]) => wanted.some((permission) => permissions.includes(permission)),
  } as unknown as SessionState;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SessionContext.Provider value={session}>
            <CustomerKycPanel customerId="01CUSTOMER0000000000000001" />
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  get.mockReset();
  post.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('CustomerKycPanel', () => {
  it('shows a customer reader the details, masked, with no decision buttons', async () => {
    get.mockResolvedValue(kyc());
    renderPanel(['customer.read']);

    expect(await screen.findByText('Dana Kowalska')).toBeTruthy();
    expect(screen.getByText('PASSPORT · •••••4567')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Verify identity' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open passport.pdf' })).toBeNull();
  });

  it('will not verify before the identity document is accepted, and accepts it', async () => {
    get.mockResolvedValue(kyc());
    post.mockResolvedValue(kyc({ documents: [ACCEPTED_DOCUMENT] }));
    renderPanel(['customer.read', 'buyer_company.review']);

    const verify = await screen.findByRole('button', { name: 'Verify identity' });
    expect(verify).toHaveProperty('disabled', true);
    expect(screen.getByText('Accept the identity document before verifying the check.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => {
      expect(post).toHaveBeenCalledWith('/admin/customers/01CUSTOMER0000000000000001/kyc/documents/doc1/decision', { decision: 'ACCEPTED', note: null });
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Verify identity' })).toHaveProperty('disabled', false);
    });

    post.mockResolvedValue(kyc({ status: 'VERIFIED', documents: [ACCEPTED_DOCUMENT] }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify identity' }));
    await waitFor(() => {
      expect(post).toHaveBeenLastCalledWith('/admin/customers/01CUSTOMER0000000000000001/kyc/decision', { decision: 'VERIFIED', expectedStatus: 'SUBMITTED', note: null });
    });
    expect(await screen.findByRole('button', { name: 'Withdraw verification' })).toBeTruthy();
  });

  it('says a colleague decided first, and reloads the check instead of overturning it', async () => {
    get.mockResolvedValue(kyc({ documents: [ACCEPTED_DOCUMENT] }));
    post.mockRejectedValue(
      new ApiError(409, {
        code: 'CUSTOMER_KYC_TRANSITION_INVALID',
        message: 'x',
        details: [{ code: 'STALE', meta: { expected: 'SUBMITTED', actual: 'VERIFIED' } }],
      }),
    );
    renderPanel(['customer.read', 'buyer_company.review']);

    fireEvent.click(await screen.findByRole('button', { name: 'Verify identity' }));
    expect(await screen.findByText(/Someone else decided this identity check/)).toBeTruthy();
    await waitFor(() => {
      expect(get).toHaveBeenCalledTimes(2);
    });
  });

  it('opens a file through the audited download', async () => {
    get.mockResolvedValue(kyc());
    renderPanel(['customer.read', 'buyer_company.review']);

    fireEvent.click(await screen.findByRole('button', { name: 'Open passport.pdf' }));
    await waitFor(() => {
      expect(vi.mocked(downloadFile)).toHaveBeenCalledWith('/admin/customers/01CUSTOMER0000000000000001/kyc/documents/doc1/file', 'passport.pdf');
    });
  });
});
