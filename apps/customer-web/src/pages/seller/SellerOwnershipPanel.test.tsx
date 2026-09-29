/**
 * The ownership, registrations and exports section of the seller application.
 *
 * What a seller would notice: the percentages they type arrive as the right
 * whole number of basis points, a mistyped share is caught beside the field
 * before anything is sent, the server's refusal lands on the field it is
 * about, India's identifiers are asked for only in India, and a locked
 * application cannot be edited.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SellerOwnershipPanel } from './SellerOwnershipPanel';
import { basisPointsToPercent, percentToBasisPoints, type KybView } from '@/lib/seller-kyb';
import { errorResponse, jsonResponse, makeLocale, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function view(overrides: Partial<KybView> = {}): KybView {
  return {
    isEditable: true,
    isIndia: true,
    policy: { beneficialOwnersRequired: true },
    registrationNumberName: null,
    legalForm: 'SOLE_PROPRIETORSHIP',
    udyamNumber: null,
    iecNumber: null,
    exportCapable: false,
    exportMarkets: [],
    yearsExporting: null,
    intendedCategories: [],
    beneficialOwners: [
      {
        id: '01K6OWNER00000000000000001',
        fullName: 'Asha Rao',
        nationality: 'IN',
        ownershipBasisPoints: 10_000,
        role: 'Proprietor',
        isControllingPerson: true,
        isPoliticallyExposed: false,
      },
    ],
    ownershipTotalBasisPoints: 10_000,
    outstanding: [],
    ...overrides,
  };
}

function serve(current: KybView, onPut?: (body: Record<string, unknown>) => Response): void {
  fetchMock.mockImplementation((input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/seller/kyb')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Promise.resolve(onPut === undefined ? jsonResponse(current) : onPut(body));
      }
      return Promise.resolve(jsonResponse(current));
    }
    if (url.includes('/catalog/categories')) {
      return Promise.resolve(jsonResponse({ categories: [] }));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

function putBodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => String(input).includes('/seller/kyb') && (init as RequestInit | undefined)?.method === 'PUT')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

const locale = makeLocale({
  countries: [
    { code: 'IN', name: 'India', currencyCode: 'INR', phonePrefix: '+91' },
    { code: 'DE', name: 'Germany', currencyCode: 'EUR', phonePrefix: '+49' },
  ],
});

describe('percentages', () => {
  it('converts as text, never through a float', () => {
    expect(percentToBasisPoints('25')).toBe(2500);
    expect(percentToBasisPoints('33.33')).toBe(3333);
    expect(percentToBasisPoints('12,5')).toBe(1250);
    expect(percentToBasisPoints('100.01')).toBeNull();
    expect(percentToBasisPoints('abc')).toBeNull();
    expect(basisPointsToPercent(2550)).toBe('25.5');
    expect(basisPointsToPercent(3333)).toBe('33.33');
    expect(basisPointsToPercent(10_000)).toBe('100');
  });
});

describe('SellerOwnershipPanel', () => {
  it('says what it is loading, then shows what the server still needs', async () => {
    serve(view({ outstanding: [{ code: 'BENEFICIAL_OWNER_REQUIRED', label: 'x' }], beneficialOwners: [] }));
    renderWithProviders(<SellerOwnershipPanel />, { locale });

    expect(screen.getByRole('status')).toHaveTextContent('Loading ownership and registrations');
    expect(await screen.findByText('At least one person who owns or controls the business')).toBeInTheDocument();
    expect(screen.getByText('Nobody added yet.')).toBeInTheDocument();
  });

  it('offers a retry when the section cannot be loaded', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(errorResponse(500, 'INTERNAL_ERROR', 'boom')));
    renderWithProviders(<SellerOwnershipPanel />, { locale });

    expect(await screen.findByRole('button', { name: /try again|retry/i })).toBeInTheDocument();
  });

  it('sends ownership as basis points and keeps an existing owner’s id', async () => {
    const user = userEvent.setup();
    serve(view());
    renderWithProviders(<SellerOwnershipPanel />, { locale });

    await user.click(await screen.findByRole('button', { name: 'Add a person' }));
    const second = screen.getAllByRole('group', { name: /Person 2/ })[0];
    if (second === undefined) throw new Error('no second person');
    await user.type(within(second).getByLabelText(/Full name/), 'Vikram Shah');
    await user.type(within(second).getByLabelText(/Ownership/), '12.5');

    const first = screen.getAllByRole('group', { name: /Person 1/ })[0];
    if (first === undefined) throw new Error('no first person');
    const share = within(first).getByLabelText(/Ownership/);
    await user.clear(share);
    await user.type(share, '87.5');

    await user.type(screen.getByLabelText(/Udyam/), 'UDYAM-MH-01-0000001');
    await user.click(screen.getByRole('button', { name: 'Save ownership and registrations' }));

    await waitFor(() => {
      expect(putBodies()).toHaveLength(1);
    });
    const body = putBodies()[0] as { beneficialOwners: { id: string | null; ownershipBasisPoints: number; fullName: string }[]; udyamNumber: string };
    expect(body.udyamNumber).toBe('UDYAM-MH-01-0000001');
    expect(body.beneficialOwners).toEqual([
      expect.objectContaining({ id: '01K6OWNER00000000000000001', ownershipBasisPoints: 8750 }),
      expect.objectContaining({ id: null, fullName: 'Vikram Shah', ownershipBasisPoints: 1250 }),
    ]);
  });

  it('catches a mistyped share beside the field, and sends nothing', async () => {
    const user = userEvent.setup();
    serve(view());
    renderWithProviders(<SellerOwnershipPanel />, { locale });

    const first = (await screen.findAllByRole('group', { name: /Person 1/ }))[0];
    if (first === undefined) throw new Error('no first person');
    const share = within(first).getByLabelText(/Ownership/);
    await user.clear(share);
    await user.type(share, 'half');
    await user.click(screen.getByRole('button', { name: 'Save ownership and registrations' }));

    const message = await within(first).findByText('Enter a percentage from 0 to 100.');
    expect(share).toHaveAttribute('aria-invalid', 'true');
    expect(share.getAttribute('aria-describedby') ?? '').toContain(message.id);
    expect(putBodies()).toHaveLength(0);
  });

  it("puts the server's refusal on the field it is about", async () => {
    const user = userEvent.setup();
    serve(view(), () =>
      errorResponse(400, 'VALIDATION_FAILED', 'Some of these answers need correcting.', [
        { field: 'iecNumber', code: 'IEC_FORMAT' },
      ]),
    );
    renderWithProviders(<SellerOwnershipPanel />, { locale });

    await user.type(await screen.findByLabelText(/Importer-Exporter Code/), 'ABC');
    await user.click(screen.getByRole('button', { name: 'Save ownership and registrations' }));

    expect(await screen.findByText('An IEC is 10 letters and digits.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Importer-Exporter Code/)).toHaveAttribute('aria-invalid', 'true');
  });

  it("asks for India's registrations only in India", async () => {
    serve(view({ isIndia: false }));
    renderWithProviders(<SellerOwnershipPanel />, { locale });

    expect(await screen.findByText('Ownership, registrations and exports')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Udyam/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Importer-Exporter Code/)).not.toBeInTheDocument();
  });

  it('cannot be edited while the application is with a reviewer', async () => {
    serve(view({ isEditable: false }));
    renderWithProviders(<SellerOwnershipPanel />, { locale });

    expect(await screen.findByText(/cannot be changed until it comes back to you/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Legal form/)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save ownership and registrations' })).not.toBeInTheDocument();
  });
});
