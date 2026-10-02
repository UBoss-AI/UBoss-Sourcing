import { fireEvent, screen, waitFor } from '@testing-library/react';
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

const row = (id: string, eventKey: string, subject: string, extra: Record<string, unknown> = {}) => ({
  id,
  eventKey,
  subject,
  channel: 'EMAIL',
  status: 'SENT',
  sentAt: '2026-09-30T10:00:00.000Z',
  createdAt: '2026-09-30T10:00:00.000Z',
  ...extra,
});

const PREFERENCES = {
  families: [
    { key: 'orders', mandatory: true, channels: { EMAIL: true, SMS: true, IN_APP: true } },
    { key: 'shipments', mandatory: false, channels: { EMAIL: true, SMS: false, IN_APP: true } },
  ],
};

function bodyOf(call: unknown[]): unknown {
  const init = call[1] as RequestInit | undefined;
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}

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

  it('marks unread rows, flags important ones, follows the deep link and marks it read', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/account/notifications/read') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ updated: 1 }));
      }
      if (url.includes('/account/notifications')) {
        return Promise.resolve(
          jsonResponse({
            unreadCount: 1,
            notifications: [
              row('01ABCDEFGHJKMNPQRSTVWXYZ01', 'payment.failed', 'Your payment did not go through', {
                readAt: null,
                priority: 'HIGH',
                link: '/account/orders/01ORDER0000000000000000000',
              }),
              row('01ABCDEFGHJKMNPQRSTVWXYZ02', 'shipment.delivered', 'Delivered', {
                readAt: '2026-09-30T11:00:00.000Z',
                priority: 'NORMAL',
                link: null,
              }),
            ],
          }),
        );
      }
      return Promise.resolve(jsonResponse(PREFERENCES));
    });
    renderWithProviders(<NotificationsPage />, { route: '/account/notifications' });

    const link = await screen.findByRole('link', { name: /Your payment did not go through/ });
    expect(link).toHaveAttribute('href', '/account/orders/01ORDER0000000000000000000');
    expect(screen.getByText('Important')).toBeInTheDocument();
    expect(screen.getByText('Unread: 1')).toBeInTheDocument();

    fireEvent.click(link);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((entry) => String(entry[0]).includes('/account/notifications/read'));
      expect(call).toBeDefined();
      expect(bodyOf(call as unknown[])).toEqual({ ids: ['01ABCDEFGHJKMNPQRSTVWXYZ01'] });
    });
  });

  it('keeps mandatory families on and saves a muted channel', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/account/notification-preferences')) {
        return Promise.resolve(jsonResponse(init?.method === 'PUT' ? PREFERENCES : PREFERENCES));
      }
      return Promise.resolve(jsonResponse({ notifications: [], unreadCount: 0 }));
    });
    renderWithProviders(<NotificationsPage />, { route: '/account/notifications' });

    const ordersEmail = await screen.findByRole('checkbox', { name: 'Orders by Email' });
    expect(ordersEmail).toBeDisabled();
    expect(ordersEmail).toBeChecked();

    const shipmentsSms = screen.getByRole('checkbox', { name: 'Shipments by Text message' });
    expect(shipmentsSms).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Shipments by Email' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save choices' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (entry) => String(entry[0]).includes('/account/notification-preferences') && (entry[1] as RequestInit | undefined)?.method === 'PUT',
      );
      expect(call).toBeDefined();
      const sent = bodyOf(call as unknown[]) as { muted: { family: string; channel: string }[] };
      expect(sent.muted).toEqual(
        expect.arrayContaining([
          { family: 'shipments', channel: 'SMS' },
          { family: 'shipments', channel: 'EMAIL' },
        ]),
      );
      expect(sent.muted.some((entry) => entry.family === 'orders')).toBe(false);
    });
  });
});
