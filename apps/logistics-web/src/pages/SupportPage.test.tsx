/**
 * Support in the logistics portal, as Raise a Ticket: the member describes the
 * issue and nothing else, the ticket goes in their name and the company's, no
 * order can be named, a send happens once with an Idempotency-Key, and a
 * refusal keeps what was typed.
 *
 * Plain assertions throughout: this app's test setup has no jest-dom matchers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { i18n } from '@/i18n/config';
import { ApiError } from '@/lib/api';
import { SupportPage } from './SupportPage';

vi.mock('@/lib/support', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/support')>();
  return {
    ...actual,
    fetchSupportContext: vi.fn(),
    fetchSupportTickets: vi.fn(),
    createSupportTicket: vi.fn(),
  };
});

const supportApi = await import('@/lib/support');
const fetchContext = vi.mocked(supportApi.fetchSupportContext);
const fetchTickets = vi.mocked(supportApi.fetchSupportTickets);
const createTicket = vi.mocked(supportApi.createSupportTicket);

const CONTEXT = {
  enabled: true,
  contacts: { email: 'help@marketplace.example', phone: null },
  requester: {
    name: 'Dana Dispatcher',
    email: 'dana@freight.example',
    emailVerified: true,
    role: 'LOGISTICS_PARTNER',
    companyName: 'Alpha Freight',
    companyNameEditable: false,
    canReferenceOrder: false,
  },
  attachments: {
    available: true,
    reason: null,
    maxBytes: 1_048_576,
    maxFiles: 10,
    types: ['image/png', 'video/mp4', 'application/pdf'],
  },
  limits: { nameMax: 120, subjectMin: 3, subjectMax: 160, messageMin: 10, messageMax: 5000 },
};

const TICKET = {
  reference: 'SR-AB12-CD34',
  category: 'LOGISTICS',
  subject: 'Label will not print',
  status: 'OPEN' as const,
  lastActivityAt: '2026-09-28T10:00:00.000Z',
  createdAt: '2026-09-28T10:00:00.000Z',
  message: 'The carrier label fails for consignment 42.',
  companyName: 'Alpha Freight',
  attachments: [],
  canReply: true,
  thread: [],
};

function renderPage(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SupportPage />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

async function fill(): Promise<void> {
  await screen.findByLabelText(/Subject/);
  fireEvent.change(screen.getByLabelText(/What is it about/), { target: { value: 'LOGISTICS' } });
  fireEvent.change(screen.getByLabelText(/Subject/), { target: { value: 'Label will not print' } });
  fireEvent.change(screen.getByLabelText(/Describe the issue/), {
    target: { value: 'The carrier label fails for consignment 42.' },
  });
}

beforeEach(() => {
  // jsdom has neither; motion's entrances and the globe construct them.
  class NoopObserver {
    observe(): void {
      /* no viewport */
    }
    unobserve(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
    takeRecords(): [] {
      return [];
    }
  }
  vi.stubGlobal('IntersectionObserver', NoopObserver);
  vi.stubGlobal('ResizeObserver', NoopObserver);
  // The globe's map fails to load here; the form must not care.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('', { status: 500 }))),
  );
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  fetchContext.mockResolvedValue(CONTEXT);
  fetchTickets.mockResolvedValue({ tickets: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('portal Support page', () => {
  it('asks only about the issue, in the company’s name, with no order field', async () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'How can we help?' })).toBeTruthy();
    await screen.findByLabelText(/Subject/);
    expect(screen.queryByLabelText(/Full name/)).toBeNull();
    expect(screen.queryByLabelText(/Email address/)).toBeNull();
    expect(screen.queryByLabelText(/Order number/)).toBeNull();
    expect(
      screen.getByText(
        'Raised as Dana Dispatcher for Alpha Freight. Replies go to dana@freight.example.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: /help@marketplace\.example/ }).getAttribute('href'),
    ).toBe('mailto:help@marketplace.example');
  });

  it('sends once with an Idempotency-Key and shows the ticket number', async () => {
    createTicket.mockResolvedValue({ ticket: TICKET, acknowledgementQueued: true });
    renderPage();
    await fill();
    const button = screen.getByRole('button', { name: 'Raise ticket' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByText('SR-AB12-CD34')).toBeTruthy();
    expect(createTicket).toHaveBeenCalledTimes(1);
    expect(createTicket.mock.calls[0]?.[0]).not.toHaveProperty('name');
    expect(createTicket.mock.calls[0]?.[1]).toMatch(/[0-9a-f-]{36}/);
  });

  it('keeps what was typed when the daily limit refuses it, and says why', async () => {
    createTicket.mockRejectedValue(
      new ApiError(429, { code: 'SUPPORT_TICKET_LIMIT_REACHED', message: 'limit' }),
    );
    renderPage();
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Raise ticket' }));
    expect(
      await screen.findByText(/You have raised the most tickets allowed for one day/),
    ).toBeTruthy();
    expect(screen.getByDisplayValue('Label will not print')).toBeTruthy();
  });
});
