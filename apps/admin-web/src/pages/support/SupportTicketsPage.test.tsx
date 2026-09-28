/**
 * Support -> Tickets, one ticket.
 *
 *   - an internal note is on the timeline, marked staff only;
 *   - the related order is a link only when the server sent its id (which it
 *     does only for somebody who may read orders);
 *   - somebody who may only read gets no reply box and no status moves;
 *   - a closed ticket offers no way to write on it;
 *   - a reply posts the text and the chosen next status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import type { AdminTicket } from '@/lib/support-tickets';
import { SupportTicketDetailPage } from './SupportTicketsPage';

vi.mock('@/lib/support-tickets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/support-tickets')>();
  return {
    ...actual,
    fetchTicket: vi.fn(),
    fetchAssignees: vi.fn(),
    replyToTicket: vi.fn(),
    fetchTicketAttachment: vi.fn(),
    saveBlob: vi.fn(),
  };
});

const api = await import('@/lib/support-tickets');
const fetchTicket = vi.mocked(api.fetchTicket);
const fetchAssignees = vi.mocked(api.fetchAssignees);
const replyToTicket = vi.mocked(api.replyToTicket);
const fetchTicketAttachment = vi.mocked(api.fetchTicketAttachment);
const saveBlob = vi.mocked(api.saveBlob);

// jsdom has no <dialog> methods. The smallest stand-in: toggle `open`, which
// is all the Modal observes - the same shim the other dialog tests here use.
const dialogProto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal?: () => void; close?: () => void };
if (typeof dialogProto.showModal !== 'function') {
  dialogProto.showModal = function showModal(this: HTMLDialogElement): void {
    this.open = true;
  };
}
if (typeof dialogProto.close !== 'function') {
  dialogProto.close = function close(this: HTMLDialogElement): void {
    this.open = false;
  };
}

const ID = '01TICKET000000000000000000';

function ticket(overrides: Partial<AdminTicket> = {}): AdminTicket {
  return {
    id: ID,
    reference: 'SR-7K2M-QX9D',
    category: 'ORDERS',
    subject: 'Where is my delivery?',
    message: 'The tracking has not moved.',
    status: 'OPEN',
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
    relatedOrder: { orderNumber: 'UB-2026-000123', id: '01ORDER0000000000000000000' },
    assignee: null,
    attachments: [
      {
        id: '01FILE0000000000000000000A',
        fileName: 'damage.jpg',
        contentType: 'image/jpeg',
        kind: 'IMAGE',
        byteSize: 204800,
        createdAt: '2026-09-28T10:01:00.000Z',
      },
    ],
    lastActivityAt: '2026-09-28T10:00:00.000Z',
    resolvedAt: null,
    closedAt: null,
    createdAt: '2026-09-28T10:00:00.000Z',
    events: [
      {
        id: 'e1',
        kind: 'CREATED',
        visibleToRequester: true,
        actorIsRequester: true,
        actor: null,
        body: null,
        fromValue: null,
        toValue: null,
        createdAt: '2026-09-28T10:00:00.000Z',
      },
      {
        id: 'e2',
        kind: 'INTERNAL_NOTE',
        visibleToRequester: false,
        actorIsRequester: false,
        actor: { id: 'u1', email: 'owner@example.test' },
        body: 'Customer is on the VIP list',
        fromValue: null,
        toValue: null,
        createdAt: '2026-09-28T10:05:00.000Z',
      },
    ],
    ...overrides,
  };
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
            <MemoryRouter initialEntries={[`/support/${ID}`]}>
              <Routes>
                <Route path="/support/:id" element={<SupportTicketDetailPage />} />
              </Routes>
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

const ALL = ['support_ticket.view', 'support_ticket.reply', 'support_ticket.assign', 'order.read'];

afterEach(() => {
  vi.clearAllMocks();
});

describe('one support ticket in the console', () => {
  it('marks an internal note as staff only and links the order', async () => {
    fetchTicket.mockResolvedValue({ ticket: ticket() });
    fetchAssignees.mockResolvedValue({ assignees: [{ id: 'u1', email: 'owner@example.test' }] });
    renderPage(ALL);

    expect(await screen.findByText('Customer is on the VIP list')).toBeTruthy();
    expect(screen.getAllByText('Staff only').length).toBeGreaterThan(0);
    // The customer's file, with a preview and a download - nothing fetched yet.
    expect(screen.getByText('damage.jpg')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Preview damage.jpg' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download damage.jpg' })).toBeTruthy();
    expect(fetchTicketAttachment).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'UB-2026-000123' }).getAttribute('href')).toBe(
      '/orders/01ORDER0000000000000000000',
    );
  });

  it('shows the order number without a link when the server withheld its id', async () => {
    fetchTicket.mockResolvedValue({
      ticket: ticket({ relatedOrder: { orderNumber: 'UB-2026-000123', id: null } }),
    });
    renderPage(['support_ticket.view']);
    expect(await screen.findByText('UB-2026-000123')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'UB-2026-000123' })).toBeNull();
    // Read-only: nothing to write with and no status to move.
    expect(screen.queryByRole('button', { name: 'Send reply' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resolved' })).toBeNull();
  });

  it('offers no way to write on a closed ticket', async () => {
    fetchTicket.mockResolvedValue({ ticket: ticket({ status: 'CLOSED' }) });
    fetchAssignees.mockResolvedValue({ assignees: [] });
    renderPage(ALL);
    expect(
      await screen.findByText('This ticket is closed. Nobody can write on it any more.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send reply' })).toBeNull();
  });

  it('sends a reply with the status it should move to', async () => {
    fetchTicket.mockResolvedValue({ ticket: ticket() });
    fetchAssignees.mockResolvedValue({ assignees: [] });
    replyToTicket.mockResolvedValue({
      ticket: ticket({ status: 'WAITING_FOR_CUSTOMER' }),
      emailQueued: true,
    });
    renderPage(ALL);

    fireEvent.change(await screen.findByLabelText('Reply'), {
      target: { value: 'Which address?' },
    });
    fireEvent.change(screen.getByLabelText('After sending, mark the ticket as'), {
      target: { value: 'WAITING_FOR_CUSTOMER' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));

    await waitFor(() => {
      expect(replyToTicket).toHaveBeenCalledWith(ID, {
        body: 'Which address?',
        nextStatus: 'WAITING_FOR_CUSTOMER',
      });
    });
  });
});

describe('the documents a customer sent', () => {
  const PDF = {
    id: '01FILE0000000000000000000B',
    fileName: 'invoice.pdf',
    contentType: 'application/pdf',
    kind: 'DOCUMENT' as const,
    byteSize: 512000,
    createdAt: '2026-09-28T10:02:00.000Z',
  };

  beforeEach(() => {
    // jsdom has no object URLs; the page only needs a string back.
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() }));
  });

  it('previews an image in the page, without leaving it', async () => {
    fetchTicket.mockResolvedValue({ ticket: ticket() });
    fetchAssignees.mockResolvedValue({ assignees: [] });
    fetchTicketAttachment.mockResolvedValue(new Blob(['x'], { type: 'image/jpeg' }));
    renderPage(ALL);

    fireEvent.click(await screen.findByRole('button', { name: 'Preview damage.jpg' }));

    const image = await screen.findByRole('img', { name: 'Image sent by the customer: damage.jpg' });
    expect(image.getAttribute('src')).toBe('blob:preview');
    expect(fetchTicketAttachment).toHaveBeenCalledWith(ID, '01FILE0000000000000000000A');
  });

  it('downloads a PDF instead of framing it, and fetches it once however often it is saved', async () => {
    fetchTicket.mockResolvedValue({ ticket: ticket({ attachments: [PDF] }) });
    fetchAssignees.mockResolvedValue({ assignees: [] });
    const blob = new Blob(['%PDF'], { type: 'application/pdf' });
    fetchTicketAttachment.mockResolvedValue(blob);
    renderPage(ALL);

    const download = await screen.findByRole('button', { name: 'Download invoice.pdf' });
    expect(screen.queryByRole('button', { name: 'Preview invoice.pdf' })).toBeNull();

    fireEvent.click(download);
    await waitFor(() => {
      expect(saveBlob).toHaveBeenCalledWith(blob, 'invoice.pdf');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Download invoice.pdf' }));
    await waitFor(() => {
      expect(saveBlob).toHaveBeenCalledTimes(2);
    });
    // Opening a file is audited on the server; a second save is not a second look.
    expect(fetchTicketAttachment).toHaveBeenCalledTimes(1);
  });

  it('says so, and offers another try, when a file cannot be fetched', async () => {
    fetchTicket.mockResolvedValue({ ticket: ticket() });
    fetchAssignees.mockResolvedValue({ assignees: [] });
    fetchTicketAttachment.mockRejectedValueOnce(new Error('boom'));
    fetchTicketAttachment.mockResolvedValueOnce(new Blob(['x'], { type: 'image/jpeg' }));
    renderPage(ALL);

    fireEvent.click(await screen.findByRole('button', { name: 'Preview damage.jpg' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Try again');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('img', { name: /damage.jpg/ })).toBeTruthy();
  });
});
