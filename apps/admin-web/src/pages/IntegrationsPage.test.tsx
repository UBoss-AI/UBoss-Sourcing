/**
 * Integrations - the integration monitor at the top (JOURNEY-065).
 *
 *   - one card per source the server sent, with its status and webhook counts;
 *   - inspection says it has no outside API and shows the portal's service level;
 *   - the carrier dead-letter retry is offered only with the logistics grant
 *     and only when something is dead-lettered, and sends one request;
 *   - the outage banner shows while a source is down, and not otherwise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { api } from '@/lib/api';
import type { IntegrationHealth } from '@/lib/integration-health';
import { OutageBanner } from '@/layout/OutageBanner';
import { IntegrationHealthPanel } from './integrations/IntegrationHealthPanel';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() } };
});

const get = vi.mocked(api.get);
const post = vi.mocked(api.post);

function health(overrides: Partial<IntegrationHealth> = {}): IntegrationHealth {
  return {
    generatedAt: '2026-10-02T09:00:00.000Z',
    sources: [
      {
        key: 'payments',
        status: 'ok',
        facts: { activeConnections: 1, unreconciledPayments: 0 },
        webhooks: { lastReceivedAt: '2026-10-02T08:55:00.000Z', accepted24h: 41, rejected24h: 0 },
        href: '/integrations',
      },
      {
        key: 'carriers',
        status: 'degraded',
        facts: { integrations: 2, degraded: 1, deadLetters: 3 },
        webhooks: { lastReceivedAt: null, accepted24h: 0, rejected24h: 5 },
        href: '/logistics/integrations',
      },
      {
        key: 'inspection',
        status: 'ok',
        facts: { activeAgencies: 1, acceptOverdue: 0, reportOverdue: 0 },
        webhooks: null,
        href: '/inspection',
      },
    ],
    outage: { active: false, sources: [] },
    ...overrides,
  };
}

function renderWith(node: React.ReactNode, permissions: string[]): void {
  const session = {
    user: { id: 'u1', email: 'owner@example.test' },
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
            <MemoryRouter>{node}</MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  get.mockReset();
  post.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('the integration monitor', () => {
  it('shows each source with its status and webhook counts', async () => {
    get.mockResolvedValue(health());
    renderWith(<IntegrationHealthPanel />, ['payment.read']);

    const payments = await screen.findByRole('listitem', { name: 'Payment gateway' });
    expect(within(payments).getByText('Working')).toBeTruthy();
    expect(within(payments).getByText(/41 accepted/)).toBeTruthy();

    const carriers = screen.getByRole('listitem', { name: 'Carriers' });
    expect(within(carriers).getByText('Degraded')).toBeTruthy();
    expect(within(carriers).getByText(/5 refused/)).toBeTruthy();
  });

  it('says inspection has no outside API', async () => {
    get.mockResolvedValue(health());
    renderWith(<IntegrationHealthPanel />, []);
    const inspection = await screen.findByRole('listitem', { name: 'Inspection agencies' });
    expect(within(inspection).getByText(/in-app agency portal/i)).toBeTruthy();
  });

  it('offers the dead-letter retry only with the logistics grant, and sends one request', async () => {
    get.mockResolvedValue(health());
    post.mockResolvedValue({ requeued: 3 });
    renderWith(<IntegrationHealthPanel />, ['logistics.integration.write']);

    const button = await screen.findByRole('button', { name: 'Retry dead-lettered webhooks' });
    fireEvent.click(button);
    await waitFor(() => {
      expect(post).toHaveBeenCalledTimes(1);
    });
    expect(post).toHaveBeenCalledWith('/admin/integrations/carrier-webhooks/requeue', {});
  });

  it('shows no retry to somebody without the grant', async () => {
    get.mockResolvedValue(health());
    renderWith(<IntegrationHealthPanel />, ['logistics.read']);
    await screen.findByRole('listitem', { name: 'Carriers' });
    expect(screen.queryByRole('button', { name: 'Retry dead-lettered webhooks' })).toBeNull();
  });
});

describe('the outage banner', () => {
  it('appears while a source is down, naming it', async () => {
    get.mockResolvedValue(health({ outage: { active: true, sources: ['payments'] } }));
    renderWith(<OutageBanner />, []);
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toMatch(/Payment gateway/);
  });

  it('stays away when nothing is down', async () => {
    get.mockResolvedValue(health());
    renderWith(<OutageBanner />, []);
    await waitFor(() => {
      expect(get).toHaveBeenCalled();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
