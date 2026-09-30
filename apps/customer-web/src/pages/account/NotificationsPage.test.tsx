import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationsPage } from './NotificationsPage';
import { jsonResponse, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const row = (id: string, eventKey: string, subject: string) => ({
  id,
  eventKey,
  subject,
  channel: 'EMAIL',
  status: 'SENT',
  sentAt: '2026-09-30T10:00:00.000Z',
  createdAt: '2026-09-30T10:00:00.000Z',
});

describe('the notification centre', () => {
  it('leads each alert to where its next action is', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/account/notifications')
          ? jsonResponse({
              notifications: [
                row('1', 'rfq.update_for_buyer', 'A new quote arrived'),
                row('2', 'dispute.message_added', 'The seller answered your claim'),
                row('3', 'shipment.delivered', 'Your order was delivered'),
              ],
            })
          : jsonResponse({}),
      ),
    );
    renderWithProviders(<NotificationsPage />, { route: '/account/notifications' });

    expect(await screen.findByRole('link', { name: 'A new quote arrived' })).toHaveAttribute('href', '/account/rfqs');
    expect(screen.getByRole('link', { name: 'The seller answered your claim' })).toHaveAttribute('href', '/account/disputes');
    expect(screen.getByRole('link', { name: 'Your order was delivered' })).toHaveAttribute('href', '/account/orders');
  });
});
