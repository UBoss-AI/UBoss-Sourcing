/**
 * Custody and dispatch evidence, rendered: the carrier sees what dispatch
 * still needs and the documents' review status, and records a handover with
 * an idempotency key. It cannot clear a gap itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { CustodyPanel } from './CustodyPanel';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() } };
});

const { api } = await import('@/lib/api');
const get = vi.mocked(api.get);
const post = vi.mocked(api.post);

function session(canWrite: boolean): SessionState {
  return {
    stage: 'READY',
    session: {
      user: { id: 'u1', email: 'd@alpha.test', fullName: 'Dee Dispatcher', role: 'LOGISTICS_DISPATCHER', permissions: [], isDriver: false },
      partner: { id: 'p1', code: 'LP-1', displayName: 'Alpha Freight', status: 'ACTIVE', canAcceptNewWork: true },
      mfa: { required: true, enrolled: true, sessionVerified: true, recoveryCodesRemaining: 8 },
    },
    notice: null,
    signIn: vi.fn(),
    signOut: vi.fn(),
    refresh: vi.fn(),
    can: () => true,
    canAny: (...keys: string[]) => canWrite || !keys.includes('logistics.shipment.status.write'),
  } as unknown as SessionState;
}

function renderPanel(canWrite = true): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <SessionContext.Provider value={session(canWrite)}>
          <ToastProvider>
            <CustodyPanel shipmentId="01HSHIPMENT000000000000001" />
          </ToastProvider>
        </SessionContext.Provider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

const VIEW = {
  gaps: ['SEALS', 'CUSTODY_HANDOVER'],
  documents: [{ kind: 'COMMERCIAL_INVOICE', status: 'VALID', requiredBeforeDispatch: true }, { kind: 'CUSTOMS_RELEASE', status: 'MISSING', requiredBeforeDispatch: false }],
  requirements: ['LITHIUM_BATTERY'],
  custody: [],
};

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Custody panel', () => {
  it('lists what dispatch still needs and each document’s status', async () => {
    get.mockResolvedValue(VIEW);
    renderPanel();
    expect(await screen.findByText('Seals')).toBeTruthy();
    expect(screen.getByText('A custody handover')).toBeTruthy();
    expect(screen.getByText('Commercial invoice')).toBeTruthy();
    expect(screen.getByText('Missing')).toBeTruthy();
    expect(screen.getByText('Lithium batteries')).toBeTruthy();
  });

  it('records a handover with an idempotency key', async () => {
    get.mockResolvedValue(VIEW);
    post.mockResolvedValue({ id: 'h1' });
    renderPanel();
    await screen.findByText('Seals');
    fireEvent.change(screen.getByLabelText('Handed over by'), { target: { value: 'Seller A' } });
    fireEvent.change(screen.getByLabelText('Received by'), { target: { value: 'Alpha Freight' } });
    fireEvent.change(screen.getByLabelText('Place'), { target: { value: 'Pune dock' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record handover' }));
    await waitFor(() => {
      expect(post).toHaveBeenCalledTimes(1);
    });
    const [url, body, options] = post.mock.calls[0] as [string, { fromParty: string; sealsIntact: boolean }, { idempotencyKey: string }];
    expect(url).toBe('/logistics/shipments/01HSHIPMENT000000000000001/custody');
    expect(body.fromParty).toBe('Seller A');
    expect(body.sealsIntact).toBe(true);
    expect(options.idempotencyKey.length).toBeGreaterThan(8);
  });

  it('shows no form to a role that cannot write', async () => {
    get.mockResolvedValue(VIEW);
    renderPanel(false);
    await screen.findByText('Seals');
    expect(screen.queryByRole('button', { name: 'Record handover' })).toBeNull();
  });
});
