/**
 * Support -> Tickets: service levels and resolution codes
 * (checklist SCREEN-063 and JOURNEY-057).
 *
 *   - the inbox shows when a first reply and an answer are due, and marks a
 *     ticket the server calls late;
 *   - "Late only" asks the server for breached tickets;
 *   - a ticket page shows both deadlines, whether each is late, and how it ended;
 *   - resolving or closing needs a resolution code: without one nothing is
 *     sent, with one it goes to the server with the status;
 *   - a reply that resolves needs the code too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import type { AdminTicket, AdminTicketRow, SupportSla } from '@/lib/support-tickets';
import { SupportTicketDetailPage, SupportTicketsPage } from './SupportTicketsPage';

vi.mock('@/lib/support-tickets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/support-tickets')>();
  return {
    ...actual,
    fetchTickets: vi.fn(),
    fetchTicket: vi.fn(),
    fetchAssignees: vi.fn(),
    updateTicket: vi.fn(),
    replyToTicket: vi.fn(),
  };
});

const api = await import('@/lib/support-tickets');
const fetchTickets = vi.mocked(api.fetchTickets);
const fetchTicket = vi.mocked(api.fetchTicket);
const fetchAssignees = vi.mocked(api.fetchAssignees);
const updateTicket = vi.mocked(api.updateTicket);
const replyToTicket = vi.mocked(api.replyToTicket);

const ID = '01TICKET000000000000000000';

const LATE: SupportSla = {
  firstResponseDueAt: '2026-09-28T18:00:00.000Z',
  resolutionDueAt: '2026-09-30T10:00:00.000Z',
  firstRespondedAt: null,
  firstResponseBreached: true,
  resolutionBreached: false,
};
const ON_TIME: SupportSla = {
  firstResponseDueAt: '2026-09-28T18:00:00.000Z',
  resolutionDueAt: '2026-09-30T10:00:00.000Z',
  firstRespondedAt: '2026-09-28T12:00:00.000Z',
  firstResponseBreached: false,
  resolutionBreached: false,
};

function row(overrides: Partial<AdminTicketRow> = {}): AdminTicketRow {
  return {
    id: ID,
    reference: 'SR-7K2M-QX9D',
    category: 'ORDERS',
    subject: 'Where is my delivery?',
    status: 'OPEN',
    priority: 'NORMAL',
    source: 'STOREFRONT',
    requesterRole: 'BUYER',
    requesterName: 'Asha Rao',
    requesterEmail: 'asha@buyer.example',
    companyName: null,
    relatedOrderNumber: null,
    assignee: null,
    resolutionCode: null,
    sla: LATE,
    lastActivityAt: '2026-09-28T10:00:00.000Z',
    createdAt: '2026-09-28T10:00:00.000Z',
    ...overrides,
  };
}

function ticket(overrides: Partial<AdminTicket> = {}): AdminTicket {
  return {
    id: ID,
    reference: 'SR-7K2M-QX9D',
    category: 'ORDERS',
    subject: 'Where is my delivery?',
    message: 'The tracking has not moved.',
    status: 'IN_PROGRESS',
    priority: 'NORMAL',
    source: 'STOREFRONT',
    language: 'en',
    requester: {
      userId: 'u-buyer',
      role: 'BUYER',
      name: 'Asha Rao',
      email: 'asha@buyer.example',
      currentEmail: 'asha@buyer.example',
      accountStatus: 'ACTIVE',
      companyName: null,
      customerProfileId: 'p1',
      buyerCompany: null,
      seller: null,
      logisticsPartner: null,
    },
    relatedOrder: null,
    assignee: null,
    attachments: [],
    resolutionCode: null,
    sla: ON_TIME,
    lastActivityAt: '2026-09-28T10:00:00.000Z',
    resolvedAt: null,
    closedAt: null,
    createdAt: '2026-09-28T10:00:00.000Z',
    events: [],
    ...overrides,
  };
}

function shell(permissions: string[], initial: string): void {
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
            <MemoryRouter initialEntries={[initial]}>
              <Routes>
                <Route path="/support" element={<SupportTicketsPage />} />
                <Route path="/support/:id" element={<SupportTicketDetailPage />} />
              </Routes>
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

const PAGE = { page: 1, limit: 25, total: 1, totalPages: 1 };

beforeEach(async () => {
  await i18n.changeLanguage('en');
  fetchTickets.mockReset();
  fetchTicket.mockReset();
  fetchAssignees.mockReset().mockResolvedValue({ assignees: [] });
  updateTicket.mockReset();
  replyToTicket.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('the inbox and service levels', () => {
  it('shows when a reply is due and marks the ticket the server calls late', async () => {
    fetchTickets.mockResolvedValue({ tickets: [row()], counts: { OPEN: 1 }, pagination: PAGE });
    shell(['support_ticket.view'], '/support');

    expect(await screen.findByText('Where is my delivery?')).toBeTruthy();
    expect(screen.getByText(/First reply due/)).toBeTruthy();
    expect(screen.getByText(/Answer due/)).toBeTruthy();
    expect(screen.getByText('Late')).toBeTruthy();
  });

  it('marks nothing late for a ticket that is on time', async () => {
    fetchTickets.mockResolvedValue({
      tickets: [row({ sla: ON_TIME })],
      counts: { OPEN: 1 },
      pagination: PAGE,
    });
    shell(['support_ticket.view'], '/support');

    expect(await screen.findByText('Where is my delivery?')).toBeTruthy();
    // The first reply has been sent, so only the answer is still owed.
    expect(screen.queryByText(/First reply due/)).toBeNull();
    expect(screen.getByText(/Answer due/)).toBeTruthy();
    expect(screen.queryByText('Late')).toBeNull();
  });

  it('asks the server for late tickets only', async () => {
    fetchTickets.mockResolvedValue({ tickets: [row()], counts: { OPEN: 1 }, pagination: PAGE });
    shell(['support_ticket.view'], '/support');
    await screen.findByText('Where is my delivery?');

    fireEvent.change(screen.getByLabelText('Service level'), { target: { value: 'true' } });

    await waitFor(() => {
      const last = fetchTickets.mock.calls.at(-1)?.[0];
      expect(last?.get('breached')).toBe('true');
    });
  });
});

describe('one ticket: service level and how it ended', () => {
  it('shows both deadlines, whether they are late, and no outcome yet', async () => {
    fetchTicket.mockResolvedValue({ ticket: ticket({ sla: LATE }) });
    shell(['support_ticket.view', 'support_ticket.reply'], `/support/${ID}`);

    expect((await screen.findAllByText('Service level')).length).toBeGreaterThan(0);
    expect(await screen.findByText('First reply')).toBeTruthy();
    expect(screen.getByText('Resolution')).toBeTruthy();
    expect(screen.getAllByText('Late').length).toBe(1);
    expect(screen.getByText('On time')).toBeTruthy();
  });

  it('shows how a resolved ticket ended', async () => {
    fetchTicket.mockResolvedValue({
      ticket: ticket({
        status: 'RESOLVED',
        resolutionCode: 'REFUNDED',
        resolvedAt: '2026-09-29T09:00:00.000Z',
      }),
    });
    shell(['support_ticket.view'], `/support/${ID}`);

    expect(await screen.findByText('Refunded')).toBeTruthy();
  });

  it('will not resolve without saying how it ended', async () => {
    fetchTicket.mockResolvedValue({ ticket: ticket() });
    shell(['support_ticket.view', 'support_ticket.reply'], `/support/${ID}`);

    await screen.findByText('Manage');
    fireEvent.click(screen.getByRole('button', { name: 'Resolved' }));

    expect(await screen.findByText(/Choose how it ended before resolving or closing/)).toBeTruthy();
    expect(updateTicket).not.toHaveBeenCalled();
  });

  it('sends the resolution code with the status', async () => {
    fetchTicket.mockResolvedValue({ ticket: ticket() });
    updateTicket.mockResolvedValue({
      ticket: ticket({ status: 'RESOLVED', resolutionCode: 'FIXED' }),
    });
    shell(['support_ticket.view', 'support_ticket.reply'], `/support/${ID}`);

    await screen.findByText('Manage');
    fireEvent.change(screen.getByLabelText('How it ended'), { target: { value: 'FIXED' } });
    fireEvent.click(screen.getByRole('button', { name: 'Resolved' }));

    await waitFor(() => {
      expect(updateTicket).toHaveBeenCalledWith(ID, { status: 'RESOLVED', resolutionCode: 'FIXED' });
    });
  });

  it('asks for the code when a reply resolves the ticket', async () => {
    fetchTicket.mockResolvedValue({ ticket: ticket() });
    replyToTicket.mockResolvedValue({
      ticket: ticket({ status: 'RESOLVED', resolutionCode: 'ANSWERED' }),
      emailQueued: true,
    });
    shell(['support_ticket.view', 'support_ticket.reply'], `/support/${ID}`);

    fireEvent.change(await screen.findByLabelText('Reply'), {
      target: { value: 'It shipped this morning.' },
    });
    fireEvent.change(screen.getByLabelText(/After sending, mark the ticket as/), { target: { value: 'RESOLVED' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    expect(await screen.findByText(/Choose how it ended before resolving or closing/)).toBeTruthy();
    expect(replyToTicket).not.toHaveBeenCalled();

    const codes = screen.getAllByLabelText('How it ended');
    fireEvent.change(codes[0] as HTMLElement, { target: { value: 'ANSWERED' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));

    await waitFor(() => {
      expect(replyToTicket).toHaveBeenCalledWith(ID, {
        body: 'It shipped this morning.',
        nextStatus: 'RESOLVED',
        resolutionCode: 'ANSWERED',
      });
    });
  });
});
