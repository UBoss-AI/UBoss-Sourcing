/**
 * Identity and import, and marketing choices (checklist Master row 11).
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityPage } from './IdentityPage';
import { MarketingChoicesPanel } from './MarketingChoicesPanel';
import { jsonResponse, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();

function kyc(overrides: Record<string, unknown> = {}) {
  return {
    status: 'NOT_STARTED',
    editable: true,
    identity: {
      legalName: null,
      dateOfBirth: null,
      nationality: null,
      residenceCountry: null,
      idDocumentType: null,
      idDocumentNumberMasked: null,
      idDocumentExpiresOn: null,
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
    submittedAt: null,
    reviewedAt: null,
    reviewNote: null,
    documents: [],
    ...overrides,
  };
}

function calls(fragment: string, method: string): [string, RequestInit][] {
  return fetchMock.mock.calls.filter(
    ([url, init]) => String(url).includes(fragment) && ((init as RequestInit | undefined)?.method ?? 'GET') === method,
  ) as [string, RequestInit][];
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('IdentityPage', () => {
  it('saves identity details, sending the whole document number once and showing only the masked form', async () => {
    const saved = kyc({ identity: { ...kyc().identity, legalName: 'Dana Kowalska', idDocumentNumberMasked: '•••••4567' } });
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/account/kyc/identity')) return Promise.resolve(jsonResponse(saved));
      if ((init?.method ?? 'GET') === 'GET') return Promise.resolve(jsonResponse(kyc()));
      return Promise.resolve(jsonResponse({}));
    });
    renderWithProviders(<IdentityPage />);

    await userEvent.type(await screen.findByLabelText(/Full legal name/), 'Dana Kowalska');
    await userEvent.type(screen.getByLabelText(/Document number/), 'EA1234567');
    await userEvent.click(screen.getByRole('button', { name: 'Save identity details' }));

    await waitFor(() => {
      expect(calls('/account/kyc/identity', 'PUT')).toHaveLength(1);
    });
    const body = JSON.parse(calls('/account/kyc/identity', 'PUT')[0]?.[1].body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ legalName: 'Dana Kowalska', idDocumentNumber: 'EA1234567' });
    expect(await screen.findByText(/On file: •••••4567/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Document number/)).toHaveValue('');
  });

  it('locks identity details while with a reviewer, and hides identity kinds from the upload list', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          kyc({
            status: 'SUBMITTED',
            editable: false,
            submittedAt: '2026-09-29T10:00:00.000Z',
            documents: [
              { id: 'd1', kind: 'IDENTITY', status: 'PENDING', fileName: 'passport.pdf', mimeType: 'application/pdf', sizeBytes: 100, reviewNote: null, createdAt: '2026-09-29T09:00:00.000Z' },
            ],
          }),
        ),
      ),
    );
    renderWithProviders(<IdentityPage />);

    expect(await screen.findByText('With a reviewer')).toBeInTheDocument();
    expect(screen.getByLabelText(/Full legal name/)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save identity details' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send for review' })).not.toBeInTheDocument();
    // The identity document is with the reviewer: it cannot be withdrawn now.
    expect(screen.queryByRole('button', { name: 'Withdraw passport.pdf' })).not.toBeInTheDocument();
    const kinds = screen.getByLabelText('What it is');
    expect([...(kinds as HTMLSelectElement).options].map((option) => option.value)).toEqual(['IMPORT_LICENCE', 'TAX_REGISTRATION', 'OTHER']);
  });

  it('shows the reviewer’s reason, and says what is missing when submitting too early', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/account/kyc/submit')) {
        return Promise.resolve(
          jsonResponse({ error: { code: 'CUSTOMER_KYC_INCOMPLETE', message: 'x', details: [{ field: 'identityDocument', code: 'REQUIRED' }] } }, 400),
        );
      }
      return Promise.resolve(jsonResponse(kyc({ status: 'REJECTED', reviewNote: 'The photo is unreadable.' })));
    });
    renderWithProviders(<IdentityPage />);

    expect(await screen.findByText('Reason: The photo is unreadable.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send for review' }));
    expect(await screen.findByText(/upload a copy of your identity document before sending/)).toBeInTheDocument();
  });

  it('explains an expired check, and says the document lapsed rather than that a field is blank', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/account/kyc/submit')) {
        return Promise.resolve(
          jsonResponse({ error: { code: 'CUSTOMER_KYC_INCOMPLETE', message: 'x', details: [{ field: 'idDocumentExpiresOn', code: 'EXPIRED' }] } }, 400),
        );
      }
      return Promise.resolve(jsonResponse(kyc({ status: 'EXPIRED', editable: true })));
    });
    renderWithProviders(<IdentityPage />);

    expect(await screen.findByText(/Your verification has expired/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send for review' }));
    expect(await screen.findByText(/Your identity document has expired/)).toBeInTheDocument();
    expect(screen.queryByText(/Fill in every identity detail/)).not.toBeInTheDocument();
  });
});

describe('MarketingChoicesPanel', () => {
  it('starts all off, and saves only what changed', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        return Promise.resolve(jsonResponse({ marketingEmailOptIn: true, marketingSmsOptIn: false, productNewsOptIn: false, marketingUpdatedAt: '2026-09-29T10:00:00.000Z' }));
      }
      return Promise.resolve(jsonResponse({ marketingEmailOptIn: false, marketingSmsOptIn: false, productNewsOptIn: false, marketingUpdatedAt: null }));
    });
    renderWithProviders(<MarketingChoicesPanel />);

    const email = await screen.findByLabelText('Offers by email');
    expect(email).not.toBeChecked();
    expect(screen.getByText('You have not changed these yet.')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save choices' });
    expect(save).toBeDisabled();

    await userEvent.click(email);
    await userEvent.click(save);
    await waitFor(() => {
      expect(calls('/account/preferences/marketing', 'PUT')).toHaveLength(1);
    });
    const body = JSON.parse(calls('/account/preferences/marketing', 'PUT')[0]?.[1].body as string) as Record<string, unknown>;
    expect(body).toEqual({ marketingEmailOptIn: true, marketingSmsOptIn: false, productNewsOptIn: false });
    expect(await screen.findByText(/Last changed/)).toBeInTheDocument();
  });
});
