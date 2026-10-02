/**
 * Reported messages (JOURNEY-055): the queue shows the words, who reported
 * them and why; a moderator decides with a required note; a reader cannot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { MessageReportsPage, type MessageReport } from './MessageReportsPage';

const fetchMock = vi.fn();

const REPORT: MessageReport = {
  id: '01JREPORT00000000000000001',
  threadKind: 'PREORDER_CHAT',
  messageId: '01JMESSAGE0000000000000001',
  threadId: '01JCONVERSATION00000000001',
  reason: 'OFF_PLATFORM',
  note: 'Asked me to pay by bank transfer.',
  status: 'OPEN',
  reporter: { email: 'buyer@example.test', party: 'BUYER' },
  reviewedBy: null,
  reviewedAt: null,
  reviewNote: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  messageBody: 'Pay me directly, it is cheaper.',
  linkPath: '/preorder-chats/01JCONVERSATION00000000001',
};

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderPage(permissions: string[]): void {
  const session = {
    user: { id: 'u1', email: 'moderator@example.test' },
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
              <MessageReportsPage />
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
  fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Promise.resolve(json(null, 204));
    return Promise.resolve(json({ reports: [REPORT] }));
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MessageReportsPage', () => {
  it('shows the reported words and records a decision with a note', async () => {
    renderPage(['review.read', 'review.moderate']);
    expect(await screen.findByText('Pay me directly, it is cheaper.')).toBeTruthy();
    expect(screen.getByText('Reported by buyer@example.test (buyer)')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the conversation' }).getAttribute('href')).toBe(REPORT.linkPath);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/admin/message-reports?status=OPEN');

    const save = screen.getByRole('button', { name: 'Save decision' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: 'Sender warned; chat message redacted.' } });
    fireEvent.change(screen.getByLabelText('Decision'), { target: { value: 'ACTIONED' } });
    fireEvent.click(save);

    await waitFor(() => {
      const post = (fetchMock.mock.calls as [string, RequestInit | undefined][]).find(([, init]) => init?.method === 'POST');
      expect(post?.[0]).toContain(`/admin/message-reports/${REPORT.id}/decision`);
      expect(JSON.parse(post?.[1]?.body as string)).toEqual({ decision: 'ACTIONED', note: 'Sender warned; chat message redacted.' });
    });
  });

  it('lets a reader see the queue but not decide', async () => {
    renderPage(['review.read']);
    expect(await screen.findByText('Pay me directly, it is cheaper.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save decision' })).toBeNull();
  });
});
