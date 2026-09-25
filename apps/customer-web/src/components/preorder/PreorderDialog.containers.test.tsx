/**
 * The "Order in" choice: Pieces, 20-ft and 40-ft containers, each container
 * size with the seller's verified capacity for this exact option - or shown
 * disabled with the reason, never as zero pieces.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonResponse, makeSession, renderWithProviders } from '@/test/harness';
import type { Eligibility } from '@/lib/preorders';
import { PreorderDialog } from './PreorderDialog';

type Available = Extract<Eligibility, { available: true }>;

const BASE: Available = {
  available: true,
  offerId: '01OFFER0000000000000000000',
  sellerName: 'Epsilon Gloves',
  currency: 'INR',
  listUnitPriceMinor: '10000',
  instantStockBaseUnits: 15_000,
  units: [
    { unit: 'PIECE', baseUnits: 1 },
    { unit: 'CONTAINER_20_FT', baseUnits: 12_000 },
    { unit: 'CONTAINER_40_FT', baseUnits: 25_000 },
  ],
  containerOptions: [
    {
      unit: 'CONTAINER_20_FT',
      available: true,
      piecesPerContainer: 12_000,
      cartonsPerContainer: 120,
      piecesPerCarton: 100,
      reason: null,
    },
    {
      unit: 'CONTAINER_40_FT',
      available: true,
      piecesPerContainer: 25_000,
      cartonsPerContainer: 250,
      piecesPerCarton: 100,
      reason: null,
    },
  ],
  moq: {
    unit: 'PIECE',
    quantity: 10_000,
    incrementQuantity: 100,
    maxQuantity: null,
    minimumBaseUnits: 10_000,
    incrementBaseUnits: 100,
    maximumBaseUnits: null,
  },
  pricingMode: 'FIXED',
  tiers: [{ minBaseUnits: 10_000, unitPriceMinor: '9000' }],
  window: {
    today: '2026-09-24',
    earliest: '2026-10-04',
    latest: null,
    decidedBy: 'PRODUCTION',
    timezone: 'Asia/Kolkata',
    hasPublishedTransit: false,
  },
  deliveryCountries: [],
  allowPartialFulfilment: false,
  allowSplitDelivery: true,
  cancellationTerms: null,
  specialInstructions: null,
};

const NO_FORTY: Available = {
  ...BASE,
  units: BASE.units.filter((entry) => entry.unit !== 'CONTAINER_40_FT'),
  containerOptions: [
    BASE.containerOptions?.[0] as NonNullable<Available['containerOptions']>[number],
    {
      unit: 'CONTAINER_40_FT',
      available: false,
      piecesPerContainer: null,
      cartonsPerContainer: null,
      piecesPerCarton: null,
      reason: 'NOT_CONFIGURED',
    },
  ],
};

const NO_CONTAINERS: Available = {
  ...BASE,
  units: [{ unit: 'PIECE', baseUnits: 1 }],
  containerOptions: (['CONTAINER_20_FT', 'CONTAINER_40_FT'] as const).map((unit) => ({
    unit,
    available: false,
    piecesPerContainer: null,
    cartonsPerContainer: null,
    piecesPerCarton: null,
    reason: 'NOT_CONFIGURED' as const,
  })),
};

const ADDRESS = {
  id: '01ADDRESS00000000000000000',
  label: 'Dock',
  line1: '4 Industrial Estate',
  city: 'Pune',
  country: 'IN',
  kind: 'SHIPPING',
  archivedAt: null,
  isDefaultShipping: true,
};

function preview(body: Record<string, unknown>, available: number) {
  const perUnit = body['orderingUnit'] === 'CONTAINER_20_FT' ? 12_000 : body['orderingUnit'] === 'CONTAINER_40_FT' ? 25_000 : 1;
  const pieces = Number(body['unitQuantity']) * perUnit;
  const money = (minor: number) => ({ minor: String(minor), currency: 'INR', formatted: `₹${String(minor / 100)}` });
  return {
    preview: {
      offerId: BASE.offerId,
      sellerName: BASE.sellerName,
      baseUnits: pieces,
      unitsPerPackage: perUnit,
      minimumBaseUnits: 10_000,
      incrementBaseUnits: 100,
      maximumBaseUnits: null,
      pricingMode: 'FIXED',
      currency: 'INR',
      unitPrice: money(9000),
      goodsTotal: money(9000 * pieces),
      appliedTierMinBaseUnits: 10_000,
      listUnitPrice: money(10_000),
      savingPerPiece: money(1000),
      approximate: null,
      window: { earliest: '2026-10-04', latest: null, decidedBy: 'PRODUCTION', timezone: 'Asia/Kolkata', hasPublishedTransit: false },
      instantStockBaseUnits: available,
      container:
        perUnit === 1
          ? null
          : {
              unit: body['orderingUnit'],
              containers: body['unitQuantity'],
              piecesPerContainer: perUnit,
              cartonsPerContainer: 120,
              piecesPerCarton: 100,
              totalPieces: pieces,
            },
      availability: {
        sufficient: pieces <= available,
        requested: pieces,
        availableNow: Math.min(pieces, available),
        remaining: Math.max(0, pieces - available),
      },
      logistics: { status: 'TO_BE_CONFIRMED' },
    },
  };
}

function stub(eligibility: Available, available = 15_000) {
  const previews: Record<string, unknown>[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes('/account/addresses')) return Promise.resolve(jsonResponse({ addresses: [ADDRESS] }));
    if (url.includes('/preorders/eligibility')) {
      return Promise.resolve(jsonResponse({ eligibility, viewer: { signedIn: true, isBusinessBuyer: true, addressId: ADDRESS.id, preorderInfo: { policyVersion: 'PREORDER_INFO_V1', acknowledged: true } } }));
    }
    if (url.includes('/preorders/preview')) {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      previews.push(body);
      return Promise.resolve(jsonResponse(preview(body, available)));
    }
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal('fetch', fetchMock);
  return previews;
}

function open(eligibility: Available) {
  return renderWithProviders(
    <PreorderDialog
      productId="01PRODUCT00000000000000000"
      productName="Nitrile gloves"
      imageUrl={null}
      variantId="01VARIANT00000000000000000"
      variantName="Box of 100"
      eligibility={eligibility}
      defaultAddressId={ADDRESS.id}
      onClose={vi.fn()}
    />,
    { session: makeSession() },
  );
}

const orderIn = (): HTMLSelectElement => screen.getByLabelText('Order in');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Order in dropdown', () => {
  it('offers Pieces, 20-ft Container and 40-ft Container', () => {
    stub(BASE);
    open(BASE);
    const labels = within(orderIn()).getAllByRole('option').map((option) => option.textContent);
    expect(labels).toEqual(['Pieces', '20-ft Container', '40-ft Container']);
  });

  it('keeps pieces working as before', () => {
    stub(BASE);
    open(BASE);
    expect(orderIn().value).toBe('PIECE');
    expect(screen.getByLabelText('How many')).toHaveValue('10000');
  });

  it('shows the 20-ft capacity, and the total for several containers', async () => {
    const user = userEvent.setup();
    stub(BASE);
    open(BASE);

    await user.selectOptions(orderIn(), 'CONTAINER_20_FT');
    const count = screen.getByLabelText('Number of containers');
    expect(count).toHaveValue('1');
    expect(screen.getByText('1 × 20-ft Container = 12,000 pieces')).toBeInTheDocument();

    await user.clear(count);
    await user.type(count, '2');
    expect(screen.getByText('2 × 20-ft Container = 24,000 pieces in total')).toBeInTheDocument();
  });

  it('shows the 40-ft capacity', async () => {
    const user = userEvent.setup();
    stub(BASE);
    open(BASE);
    await user.selectOptions(orderIn(), 'CONTAINER_40_FT');
    expect(screen.getByText('1 × 40-ft Container = 25,000 pieces')).toBeInTheDocument();
  });

  it('accepts whole containers only', async () => {
    const user = userEvent.setup();
    stub(BASE);
    open(BASE);
    await user.selectOptions(orderIn(), 'CONTAINER_20_FT');
    const count = screen.getByLabelText('Number of containers');
    await user.clear(count);
    await user.type(count, '1.5');
    expect(count).toHaveValue('15');
  });

  it('disables a size the seller has not configured, with no figure', () => {
    stub(NO_FORTY);
    open(NO_FORTY);
    const forty = within(orderIn()).getByRole('option', { name: '40-ft Container (not available)' });
    expect(forty).toBeDisabled();
    expect(screen.queryByText(/(^|[^\d,])0 pieces/)).toBeNull();
  });

  it('says why when no container can be ordered, and keeps Pieces', () => {
    stub(NO_CONTAINERS);
    open(NO_CONTAINERS);
    expect(
      screen.getByText(
        'Container ordering is not available because the seller has not configured the packing capacity for this product.',
      ),
    ).toBeInTheDocument();
    expect(within(orderIn()).getByRole('option', { name: 'Pieces' })).not.toBeDisabled();
    for (const name of ['20-ft Container (not available)', '40-ft Container (not available)']) {
      expect(within(orderIn()).getByRole('option', { name })).toBeDisabled();
    }
  });
});

describe('the summary', () => {
  async function chooseDate(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByRole('button', { name: /Delivery wanted by/i }));
    const cell = screen.getByRole('dialog', { name: /Delivery wanted by/i }).querySelector<HTMLElement>('[data-iso="2026-10-20"]');
    if (cell === null) throw new Error('no day');
    await user.click(cell);
  }

  it('sends the unit and the count - never a capacity - and shows the container breakdown', async () => {
    const user = userEvent.setup();
    const previews = stub(BASE);
    open(BASE);
    await user.selectOptions(orderIn(), 'CONTAINER_20_FT');
    await chooseDate(user);

    await waitFor(() => {
      expect(screen.getByText('Pieces per container')).toBeInTheDocument();
    });
    const last = previews.at(-1) ?? {};
    expect(last).toMatchObject({ orderingUnit: 'CONTAINER_20_FT', unitQuantity: 1 });
    expect(last).not.toHaveProperty('unitsPerPackage');
    expect(screen.getByText('Estimated logistics charges')).toBeInTheDocument();
    expect(screen.getByText('To be confirmed')).toBeInTheDocument();
  });

  it('says honestly when more is asked for than is available now', async () => {
    const user = userEvent.setup();
    stub(BASE, 15_000);
    open(BASE);
    await user.selectOptions(orderIn(), 'CONTAINER_20_FT');
    const count = screen.getByLabelText('Number of containers');
    await user.clear(count);
    await user.type(count, '2');
    await chooseDate(user);

    await waitFor(() => {
      expect(screen.getByText('The complete requested quantity is not currently available.')).toBeInTheDocument();
    });
    expect(screen.getByText('24,000 pieces')).toBeInTheDocument();
    expect(screen.getByText('15,000 pieces')).toBeInTheDocument();
    expect(screen.getByText('9,000 pieces')).toBeInTheDocument();
  });
});
