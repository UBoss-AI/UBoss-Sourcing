/**
 * Seller Hub -> Factories and certificates (checklist Master row 13).
 *
 *   - loading, empty and failed-with-retry states;
 *   - a refused factory shows the reviewer's reason and offers "Send again";
 *   - a factory with a reviewer cannot be edited;
 *   - nothing on the page can set a status - the only move is sending for review;
 *   - the factory form checks coordinates and whole numbers before sending;
 *   - an expired certificate says so and offers to send it again.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import type { Certification, Factory } from '@/lib/factories';
import { SellerFactoriesPage } from './SellerFactoriesPage';

vi.mock('@/lib/factories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/factories')>();
  return {
    ...actual,
    fetchFactories: vi.fn(),
    fetchCertifications: vi.fn(),
    submitFactory: vi.fn(),
    createFactory: vi.fn(),
    submitCertification: vi.fn(),
  };
});
vi.mock('@/lib/seller', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/seller')>();
  return { ...actual, fetchSellerDocuments: vi.fn(() => Promise.resolve({ documents: [] })) };
});

const api = await import('@/lib/factories');
const fetchFactories = vi.mocked(api.fetchFactories);
const fetchCertifications = vi.mocked(api.fetchCertifications);
const submitFactory = vi.mocked(api.submitFactory);
const createFactory = vi.mocked(api.createFactory);

function factory(overrides: Partial<Factory> & { status?: Factory['verification']['status']; reason?: string | null } = {}): Factory {
  const { status = 'NOT_SUBMITTED', reason = null, ...rest } = overrides;
  return {
    id: '01FACTORY00000000000000001',
    name: 'Pune plant',
    addressLine1: '12 MIDC Industrial Area',
    addressLine2: null,
    city: 'Pune',
    region: 'Maharashtra',
    postcode: '411019',
    countryCode: 'IN',
    latitude: null,
    longitude: null,
    establishedYear: 2008,
    floorAreaSqm: 4200,
    workforceCount: 140,
    qcStaffCount: 12,
    monthlyCapacity: 50000,
    capacityUnit: 'pieces',
    productsMade: 'Valves',
    qcProcess: null,
    machines: [{ id: '01MACHINE00000000000000001', name: 'CNC lathe', quantity: 6, capacityNote: null }],
    evidence: [
      {
        id: '01EVIDENCE0000000000000001',
        documentId: '01DOCUMENT0000000000000001',
        caption: 'Front gate',
        capturedLatitude: null,
        capturedLongitude: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        document: {
          originalFileName: 'plant-photo.pdf',
          kind: 'OTHER',
          contentType: 'application/pdf',
          byteSize: 1000,
          scanState: 'CLEAN',
          status: 'PENDING',
          isReplaced: false,
        },
      },
    ],
    verification: {
      status,
      checkId: status === 'NOT_SUBMITTED' ? null : '01CHECK0000000000000000001',
      reason,
      submittedAt: status === 'NOT_SUBMITTED' ? null : '2026-09-10T00:00:00.000Z',
      decidedAt: status === 'REJECTED' ? '2026-09-12T00:00:00.000Z' : null,
      validUntil: null,
      isEditable: status !== 'PENDING',
    },
    history: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...rest,
  };
}

const EXPIRED_CERTIFICATE: Certification = {
  id: '01CERT00000000000000000001',
  factoryId: null,
  factoryName: null,
  standard: 'ISO 9001',
  certificateNumber: 'Q-1',
  issuer: 'TÜV SÜD',
  scope: null,
  issuedOn: '2023-01-01',
  expiresOn: '2026-01-01',
  documentId: '01DOCUMENT0000000000000002',
  document: null,
  state: 'EXPIRED',
  verifiedAt: '2023-02-01T00:00:00.000Z',
  lastCheckedAt: null,
  rejectionReason: null,
  expiresSoon: false,
  isEditable: true,
  updatedAt: '2026-01-02T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchCertifications.mockResolvedValue({ certifications: [] });
});

function render(): void {
  renderWithProviders(<SellerFactoriesPage />, { route: '/seller/factories' });
}

describe('the factories page', () => {
  it('says there are none yet', async () => {
    fetchFactories.mockResolvedValue({ factories: [] });
    render();
    expect(await screen.findByText('No factories yet')).toBeInTheDocument();
    expect(await screen.findByText('No certificates yet')).toBeInTheDocument();
  });

  it('offers a retry when the list cannot be loaded', async () => {
    fetchFactories.mockRejectedValueOnce(new Error('Network down'));
    fetchFactories.mockResolvedValueOnce({ factories: [] });
    render();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No factories yet')).toBeInTheDocument();
    expect(fetchFactories).toHaveBeenCalledTimes(2);
  });

  it('shows a refusal with its reason, and offers to send it again', async () => {
    fetchFactories.mockResolvedValue({ factories: [factory({ status: 'REJECTED', reason: 'The photograph shows no signage.' })] });
    submitFactory.mockResolvedValue({ factory: factory({ status: 'PENDING' }) });
    render();
    expect(await screen.findByText('Not verified')).toBeInTheDocument();
    expect(screen.getByText('The photograph shows no signage.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send again' }));
    await waitFor(() => {
      expect(submitFactory).toHaveBeenCalledWith('01FACTORY00000000000000001');
    });
  });

  it('locks a factory that is with a reviewer, and never offers to set a status', async () => {
    fetchFactories.mockResolvedValue({ factories: [factory({ status: 'PENDING' })] });
    render();
    expect(await screen.findByText('With a reviewer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add evidence' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Send for review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /verif/i })).not.toBeInTheDocument();
    expect(screen.getByText(/cannot be changed until they decide/)).toBeInTheDocument();
  });

  it('will not send a new factory for review until it has evidence', async () => {
    fetchFactories.mockResolvedValue({ factories: [factory({ evidence: [] })] });
    render();
    expect(await screen.findByRole('button', { name: 'Send for review' })).toBeDisabled();
    expect(screen.getByText(/Attach at least one piece of evidence/)).toBeInTheDocument();
  });

  it('checks coordinates and figures in the form before sending', async () => {
    fetchFactories.mockResolvedValue({ factories: [] });
    render();
    fireEvent.click(await screen.findByRole('button', { name: 'Add a factory' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Latitude'), { target: { value: '95' } });
    fireEvent.change(within(dialog).getByLabelText('Workforce'), { target: { value: '-4' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Latitude is a number from -90 to 90.')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter a whole number of zero or more.')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Fill this in.').length).toBeGreaterThan(0);
    expect(createFactory).not.toHaveBeenCalled();
  });

  it('says an expired certificate is no longer shown, and offers to send it again', async () => {
    fetchFactories.mockResolvedValue({ factories: [] });
    fetchCertifications.mockResolvedValue({ certifications: [EXPIRED_CERTIFICATE] });
    render();
    expect(await screen.findByText('ISO 9001')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.getByText(/buyers no longer see it/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send again' })).toBeInTheDocument();
  });
});
