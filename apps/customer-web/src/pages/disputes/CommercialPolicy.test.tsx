import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaimRequestPage } from './DisputePages';
import { RefundStatusCard } from '@/components/RefundStatusCard';
import { SellerOrderTermsCard } from '@/pages/seller/SellerOrderTermsCard';
import type { SellerOrderDetail } from '@/lib/seller';
import { jsonResponse, renderWithProviders } from '@/test/harness';

const ORDER = 'O'.repeat(26);
const ITEM = 'I'.repeat(26);
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('claim case facts', () => {
  it('sends a case object when a kind of problem is chosen', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/disputes/context')) {
        return Promise.resolve(
          jsonResponse({
            reasons: ['DAMAGED'],
            remedies: ['REFUND_FULL'],
            claimWindowDays: 30,
            sellerResponseHours: 48,
            limits: { descriptionMin: 10, descriptionMax: 5000, messageMax: 5000 },
          }),
        );
      }
      if (url.includes(`/orders/${ORDER}`)) {
        return Promise.resolve(jsonResponse({ order: { id: ORDER, orderNumber: 'ORD-1', currency: 'EUR', items: [] } }));
      }
      if (init?.method === 'POST') return Promise.resolve(jsonResponse({ dispute: { reference: 'DSP-1' } }, 201));
      return Promise.resolve(jsonResponse({}));
    });
    renderWithProviders(
      <Routes>
        <Route path="/account/orders/:id/claim" element={<ClaimRequestPage />} />
        <Route path="/account/disputes/:reference" element={<p>claim page</p>} />
      </Routes>,
      { route: `/account/orders/${ORDER}/claim` },
    );

    const send = await screen.findByRole('button', { name: /send claim/i });
    await userEvent.selectOptions(screen.getByLabelText(/what went wrong/i), 'DAMAGED');
    await userEvent.type(screen.getByLabelText(/describe the problem/i), 'It overheats and smokes.');
    await userEvent.selectOptions(screen.getByLabelText(/what kind of problem is it/i), 'SAFETY');
    expect(screen.getByText(/stop using the product/i)).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/legal rights/i));
    await userEvent.type(screen.getByLabelText(/how many items are affected/i), '2');
    await userEvent.type(screen.getByLabelText(/lot or serial numbers/i), 'L1, L2');
    await userEvent.click(send);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
      expect(JSON.parse((post?.[1] as RequestInit).body as string)).toMatchObject({
        reasonCode: 'DAMAGED',
        desiredOutcome: 'REFUND_FULL',
        case: { category: 'SAFETY', urgency: 'NORMAL', statutoryBasis: true, affectedQuantity: 2, lotsOrSerials: ['L1', 'L2'] },
      });
    });
  });
});

describe('refund status card', () => {
  it('never shows a pending refund as confirmed', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          refunds: [
            { id: 'R1', amountMinor: '1250', currency: 'EUR', instructedAt: '2026-10-01T10:00:00.000Z', providerConfirmedAt: null, state: 'PENDING_PROVIDER', outcomeUnknown: true },
            { id: 'R2', amountMinor: '500', currency: 'EUR', instructedAt: '2026-10-02T10:00:00.000Z', providerConfirmedAt: null, state: 'SUBMITTED', outcomeUnknown: false },
          ],
        }),
      ),
    );
    renderWithProviders(<RefundStatusCard orderId={ORDER} />);

    expect(await screen.findByText('Pending at the payment provider')).toBeInTheDocument();
    expect(screen.getByText('Sent to the payment provider')).toBeInTheDocument();
    expect(screen.queryByText(/confirmed by the payment provider/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/refunded|completed/i)).not.toBeInTheDocument();
    expect(screen.getByText(/depends on the payment provider and your bank/i)).toBeInTheDocument();
  });
});

describe('seller agreed terms', () => {
  it('shows the commission rate as a percentage', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          status: 'NEW',
          editable: true,
          gateMode: 'report',
          lines: [
            {
              id: 'L'.repeat(26),
              orderItemId: ITEM,
              sellerAccountId: 'S'.repeat(26),
              manufacturerName: 'Acme',
              productVersion: 'v2',
              facilityRef: 'PLANT-1',
              sellerCountry: 'IN',
              destinationCountry: 'DE',
              channel: 'B2B',
              deliveryTerm: 'DAP',
              namedPlace: null,
              importerOfRecord: 'BUYER',
              currency: 'EUR',
              commissionBaseMinor: '100000',
              commissionBps: 1250,
              commissionMinor: '12500',
              commissionSource: 'CATEGORY_RULE',
              commissionRuleVersion: 'r3',
              rounding: 'HALF_UP',
              controlGapsJson: ['NAMED_PLACE'],
            },
          ],
        }),
      ),
    );
    const order = { id: ORDER, currency: 'EUR', status: 'NEW', lines: [{ id: 'G1', orderItemId: ITEM, productName: 'Pump' }] } as unknown as SellerOrderDetail;
    renderWithProviders(<SellerOrderTermsCard order={order} />);

    expect(await screen.findByText('12.50 %')).toBeInTheDocument();
    expect(screen.getByText('The named place of delivery is missing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /record missing terms/i })).toBeInTheDocument();
  });
});
