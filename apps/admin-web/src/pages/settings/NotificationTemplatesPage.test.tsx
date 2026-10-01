/**
 * The notification templates page (checklist Master row 76): lists built-in
 * and customised events together, and saves a template with its channels -
 * email, in-app, WhatsApp and SMS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { mergeEvents } from '@/lib/notification-templates';
import { NotificationTemplatesPage } from './NotificationTemplatesPage';

const fetchMock = vi.fn();

const DATA = {
  notifications: [
    {
      eventKey: 'order.confirmed',
      name: 'Order confirmed',
      emailEnabled: true,
      smsEnabled: false,
      whatsappEnabled: false,
      inAppEnabled: true,
      whatsappTemplate: null,
      subjectTemplate: 'Order {{orderNumber}} confirmed',
      bodyTemplate: 'Thanks.',
      isActive: true,
    },
  ],
  catalogue: [
    { eventKey: 'order.confirmed', subject: 'Built-in subject', body: 'Built-in body' },
    { eventKey: 'user.password_reset', subject: 'Reset your password', body: 'Use the link.' },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderPage(permissions: string[]): void {
  const session = {
    user: { id: 'u1', email: 'owner@example.test' },
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
    can: (permission: string) => permissions.includes(permission),
    canAny: (...wanted: string[]) => wanted.some((permission) => permissions.includes(permission)),
  } as unknown as SessionState;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SessionContext.Provider value={session}>
            <MemoryRouter>
              <NotificationTemplatesPage />
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
    Promise.resolve(init?.method === 'PUT' ? json({ id: 'x' }) : json(DATA)),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('mergeEvents', () => {
  it('keeps the customised copy and fills built-in events with their defaults', () => {
    const merged = mergeEvents(DATA.notifications, DATA.catalogue);
    expect(merged.map((row) => [row.eventKey, row.customised])).toEqual([
      ['order.confirmed', true],
      ['user.password_reset', false],
    ]);
    expect(merged[1]).toMatchObject({ emailEnabled: true, inAppEnabled: true, whatsappEnabled: false, subjectTemplate: 'Reset your password' });
  });
});

describe('NotificationTemplatesPage', () => {
  it('saves a built-in event with WhatsApp switched on and email off', async () => {
    renderPage(['settings.read', 'settings.write']);
    expect(await screen.findByText('user.password_reset')).toBeTruthy();
    expect(screen.getByText('Order {{orderNumber}} confirmed')).toBeTruthy();

    const editButtons = screen.getAllByRole('button', { name: i18n.t('notificationTemplates.edit') });
    fireEvent.click(editButtons[1] as HTMLElement);

    fireEvent.click(await screen.findByRole('checkbox', { name: (name) => name.startsWith(i18n.t('notificationTemplates.channel.whatsappEnabled')) }));
    fireEvent.click(screen.getByRole('checkbox', { name: (name) => name.startsWith(i18n.t('notificationTemplates.channel.emailEnabled')) }));
    fireEvent.click(screen.getByRole('button', { name: i18n.t('notificationTemplates.save') }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(true);
    });
    const [url, init] = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'PUT') as [string, RequestInit];
    expect(url).toContain('/admin/settings/notifications');
    expect(JSON.parse(init.body as string)).toMatchObject({
      eventKey: 'user.password_reset',
      subjectTemplate: 'Reset your password',
      emailEnabled: false,
      inAppEnabled: true,
      whatsappEnabled: true,
      whatsappTemplate: null,
    });
  });

  it('is read-only without settings.write', async () => {
    renderPage(['settings.read']);
    await screen.findByText('user.password_reset');
    expect(screen.queryByRole('button', { name: i18n.t('notificationTemplates.edit') })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: i18n.t('notificationTemplates.view') })[0] as HTMLElement);
    expect(screen.queryByRole('button', { name: i18n.t('notificationTemplates.save') })).toBeNull();
  });
});
