/**
 * The seller's "who carries this" panel says what is true and offers only
 * what the server will accept.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConsignmentLogisticsState, LogisticsOptions } from '@/lib/consignment-logistics';
import { renderWithProviders } from '@/test/harness';
import { ConsignmentLogisticsPanel } from './ConsignmentLogisticsPanel';

const fetchLogisticsOptions = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const createManualBooking = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const assignPartner = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('@/lib/consignment-logistics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/consignment-logistics')>();
  return {
    ...actual,
    fetchLogisticsOptions: (...args: unknown[]) => fetchLogisticsOptions(...args),
    createManualBooking: (...args: unknown[]) => createManualBooking(...args),
    assignPartner: (...args: unknown[]) => assignPartner(...args),
  };
});

function state(over: Partial<ConsignmentLogisticsState> = {}): ConsignmentLogisticsState {
  return {
    id: 'ship-1',
    reference: 'LS-2026-000100',
    status: 'CREATED',
    stage: 'AWAITING_LOGISTICS_ASSIGNMENT',
    mode: 'NONE',
    canAssign: true,
    assignBlock: null,
    partner: null,
    manualBooking: null,
    driver: { isAssigned: false, maskedName: null },
    carrierTrackingNumber: null,
    trackingPageUrl: null,
    history: [],
    ...over,
  };
}

const OPTIONS: LogisticsOptions = {
  consignment: {
    id: 'ship-1',
    reference: 'LS-2026-000100',
    sellerOrderNumber: 'SO-1',
    origin: { city: 'Warsaw', countryCode: 'PL', contactName: null },
    destination: { city: 'Krakow', postalCode: '30-001', countryCode: 'PL' },
    loadType: 'PALLET',
    packageCount: 1,
    totalWeightGrams: 120_000,
    packages: [],
    pickupBy: null,
    deliverBy: null,
    handling: { coldChain: false, temperatureControlled: false, sterile: false, dangerousGoods: false, fragile: false, notes: null },
  },
  state: state(),
  partners: [
    {
      logisticsPartnerId: 'p-ok',
      displayName: 'Vistula Vans',
      partnerCode: 'VV',
      relationshipType: 'DIRECT_CONTRACT',
      isEligible: true,
      refusal: null,
      serviceability: [],
      reason: null,
    },
    {
      logisticsPartnerId: 'p-pallet',
      displayName: 'Small Parcels Ltd',
      partnerCode: 'SP',
      relationshipType: 'DIRECT_CONTRACT',
      isEligible: false,
      refusal: null,
      serviceability: ['MISSING_CAPABILITY:PALLET'],
      reason: 'x',
    },
    {
      logisticsPartnerId: 'p-pending',
      displayName: 'New Couriers',
      partnerCode: 'NC',
      relationshipType: 'DIRECT_CONTRACT',
      isEligible: false,
      refusal: 'LINK_NOT_APPROVED',
      serviceability: [],
      reason: 'x',
    },
  ],
  carriers: [
    { provider: 'DHL', name: 'DHL', isAvailable: true, notes: ['API_CREDENTIALS_REQUIRED', 'FREIGHT_SERVICE_REQUIRED', 'MANUAL_BOOKING_AVAILABLE'], setupStatus: 'NOT_CONFIGURED', automaticBookingAvailable: false },
    { provider: 'FEDEX', name: 'FedEx', isAvailable: true, notes: ['API_CREDENTIALS_REQUIRED', 'MANUAL_BOOKING_AVAILABLE'], setupStatus: 'CREDENTIALS_REQUIRED', automaticBookingAvailable: false },
    { provider: 'INDIA_POST', name: 'India Post', isAvailable: false, notes: ['NO_OFFICIAL_API', 'ORIGIN_NOT_SERVED', 'PALLETS_NOT_CARRIED'], setupStatus: 'MANUAL_MODE_AVAILABLE', automaticBookingAvailable: false },
  ],
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('before the seller confirms', () => {
  it('offers nothing and says why', () => {
    renderWithProviders(
      <ConsignmentLogisticsPanel
        sellerOrderId="g-1"
        state={state({ canAssign: false, assignBlock: 'SELLER_ORDER_NOT_CONFIRMED' })}
      />,
    );
    expect(screen.getByText(/Confirm this order first/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Assign Logistics Partner' })).toBeNull();
  });
});

describe('after pickup', () => {
  it('cannot be moved, and says who can', () => {
    renderWithProviders(
      <ConsignmentLogisticsPanel
        sellerOrderId="g-1"
        state={state({ canAssign: false, assignBlock: 'COLLECTED', stage: 'PICKED_UP', mode: 'PARTNER' })}
      />,
    );
    expect(screen.getByText(/already has this parcel/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Change who carries it|Take it back/ })).toBeNull();
  });
});

describe('the assign dialog', () => {
  it('lists every partner with its reason and every outside carrier with what it involves', async () => {
    fetchLogisticsOptions.mockResolvedValue(OPTIONS);
    renderWithProviders(<ConsignmentLogisticsPanel sellerOrderId="g-1" state={state()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Assign Logistics Partner' }));

    expect(await screen.findByText('Does not support pallets.')).toBeTruthy();
    expect(screen.getByText('Not approved yet.')).toBeTruthy();
    expect(screen.getAllByText('API credentials required for automatic booking.')).toHaveLength(2);
    expect(screen.getByText('Book a freight service for this load, not a parcel service.')).toBeTruthy();
    expect(screen.getByText('Collects only from India.')).toBeTruthy();

    // Unavailable choices cannot be picked.
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /Small Parcels Ltd/ }).disabled).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /India Post/ }).disabled).toBe(true);
    // Nothing claims a live connection.
    expect(screen.queryByText(/^Connected$/)).toBeNull();
  });

  it('choosing DHL records a manual booking, and warns that nothing is booked with DHL', async () => {
    fetchLogisticsOptions.mockResolvedValue(OPTIONS);
    createManualBooking.mockResolvedValue({ booking: {}, idempotent: false });
    renderWithProviders(<ConsignmentLogisticsPanel sellerOrderId="g-1" state={state()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Assign Logistics Partner' }));
    fireEvent.click(await screen.findByRole('radio', { name: /^DHL/ }));
    expect(screen.getByText(/Nothing is booked with DHL for you/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Choose this carrier' }));
    await waitFor(() => {
      expect(createManualBooking).toHaveBeenCalledWith({ shipmentId: 'ship-1', provider: 'DHL', reason: null });
    });
    expect(assignPartner).not.toHaveBeenCalled();
  });

  it('choosing a partner sends an offer; replacing one demands a reason', async () => {
    fetchLogisticsOptions.mockResolvedValue(OPTIONS);
    assignPartner.mockResolvedValue({ assignmentId: 'a-1' });
    renderWithProviders(
      <ConsignmentLogisticsPanel
        sellerOrderId="g-1"
        state={state({
          mode: 'MANUAL_CARRIER',
          stage: 'CARRIER_BOOKING_PENDING',
          manualBooking: {
            id: 'b-1',
            provider: 'FEDEX',
            carrierName: 'FedEx',
            status: 'BOOKING_REQUIRED',
            serviceName: null,
            pickupReference: null,
            carrierTrackingNumber: null,
            trackingPageUrl: null,
            expectedPickupAt: null,
            expectedDeliveryAt: null,
            shippingCostMinor: null,
            currency: null,
            createdAt: new Date().toISOString(),
            bookedAt: null,
          },
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Change who carries it' }));
    fireEvent.click(await screen.findByRole('radio', { name: /Vistula Vans/ }));

    const submit = screen.getByRole('button', { name: 'Send to this partner' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Buyer wants a van' } });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(assignPartner).toHaveBeenCalledWith({
        shipmentId: 'ship-1',
        logisticsPartnerId: 'p-ok',
        reason: 'Buyer wants a van',
      });
    });
  });
});

describe('a hand-made booking', () => {
  it('is badged as manual, with its tracking number pending, and offers no progress yet', () => {
    renderWithProviders(
      <ConsignmentLogisticsPanel
        sellerOrderId="g-1"
        state={state({
          mode: 'MANUAL_CARRIER',
          status: 'ASSIGNED',
          stage: 'CARRIER_BOOKING_PENDING',
          manualBooking: {
            id: 'b-1',
            provider: 'DHL',
            carrierName: 'DHL',
            status: 'BOOKING_REQUIRED',
            serviceName: null,
            pickupReference: null,
            carrierTrackingNumber: null,
            trackingPageUrl: null,
            expectedPickupAt: null,
            expectedDeliveryAt: null,
            shippingCostMinor: null,
            currency: null,
            createdAt: new Date().toISOString(),
            bookedAt: null,
          },
        })}
      />,
    );
    expect(screen.getByText('Manual booking')).toBeTruthy();
    expect(screen.getByText('Tracking number pending')).toBeTruthy();
    expect(screen.getByText(/Not booked yet\. Book this consignment with DHL yourself/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Picked up' })).toBeNull();
  });

  it('a delivery company\'s driver is shown masked, and never as something to choose', () => {
    renderWithProviders(
      <ConsignmentLogisticsPanel
        sellerOrderId="g-1"
        state={state({
          mode: 'PARTNER',
          status: 'ACCEPTED',
          stage: 'DRIVER_ASSIGNED',
          partner: { id: 'p-ok', displayName: 'Vistula Vans', assignmentState: 'ACCEPTED', respondBy: null },
          driver: { isAssigned: true, maskedName: 'Marek N.' },
        })}
      />,
    );
    expect(screen.getByText('Assigned: Marek N.')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
