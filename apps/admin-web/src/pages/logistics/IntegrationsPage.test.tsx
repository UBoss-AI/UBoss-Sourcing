/**
 * Logistics → carrier integrations (JOURNEY-065).
 *
 * The page carries the carriers' line of the integration monitor, and only
 * that line: payments and ERP belong to the main Integrations screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { api } from '@/lib/api';
import { LogisticsIntegrationsPage } from './IntegrationsPage';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() } };
});

vi.mock('@/lib/logistics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logistics')>();
  return { ...actual, fetchIntegrations: vi.fn().mockResolvedValue({ integrations: [], providers: [] }) };
});

const get = vi.mocked(api.get);

function renderPage(permissions: string[]): void {
  const session = {
    user: { id: 'u1', email: 'ops@example.test' },
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
            <MemoryRouter>
              <LogisticsIntegrationsPage />
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  get.mockReset();
  get.mockResolvedValue({
    generatedAt: '2026-10-02T09:00:00.000Z',
    sources: [
      { key: 'payments', status: 'down', facts: {}, webhooks: null, href: '/integrations' },
      {
        key: 'carriers',
        status: 'ok',
        facts: { integrations: 1, degraded: 0, deadLetters: 0 },
        webhooks: { lastReceivedAt: null, accepted24h: 7, rejected24h: 0 },
        href: '/logistics/integrations',
      },
    ],
    outage: { active: true, sources: ['payments'] },
  });
});

afterEach(() => {
  cleanup();
});

describe('LogisticsIntegrationsPage', () => {
  it('shows the carriers health line and not the other sources', async () => {
    renderPage(['logistics.read']);
    expect(await screen.findByRole('listitem', { name: 'Carriers' })).toBeTruthy();
    expect(screen.queryByRole('listitem', { name: 'Payment gateway' })).toBeNull();
  });
});
