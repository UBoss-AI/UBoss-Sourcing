/**
 * The Support page and the ways into it.
 *
 * What it proves:
 *   - a guest sees the operator's published contacts and a sign-in that comes
 *     back here, and never a placeholder address;
 *   - a signed-in reader gets a form prefilled from the SERVER's context, with
 *     the email shown and not editable;
 *   - empty and short fields are refused before anything is sent;
 *   - a send posts once, with an Idempotency-Key, and shows the reference;
 *   - a double-click still posts once; a failure keeps everything typed and a
 *     retry reuses the same key;
 *   - the globe failing to load changes nothing about the form;
 *   - the header, account menu, footer and order page all lead to /support;
 *   - the FAQ sits after the heading and before the contact details and the
 *     form, exactly once, only here, with no sample content, links only the
 *     reader can follow, and a failure that takes nothing else with it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { Footer } from '@/layout/Footer';
import { Header } from '@/layout/Header';
import { errorResponse, jsonResponse, makeSession, renderWithProviders } from '@/test/harness';
import type { StorefrontConfig } from '@/lib/types';
import { SellerSupportPage, SupportPage } from './SupportPage';

/** Lets one test make the FAQ's content throw, to prove the form survives it. */
const faq = vi.hoisted(() => ({ fails: false }));
vi.mock('@/lib/support-faq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/support-faq')>();
  return {
    ...actual,
    visibleSupportFaq: (context: Parameters<typeof actual.visibleSupportFaq>[0]) => {
      if (faq.fails) throw new Error('FAQ content failed');
      return actual.visibleSupportFaq(context);
    },
  };
});

const CONFIG: StorefrontConfig = {
  ...FALLBACK_CONFIG,
  business: {
    ...FALLBACK_CONFIG.business,
    supportEmail: 'help@shop.example',
    supportPhone: '+91 22 1234 5678',
  },
  features: { ...FALLBACK_CONFIG.features, supportTickets: true },
};

const CONTEXT = {
  enabled: true,
  contacts: { email: 'help@shop.example', phone: '+91 22 1234 5678' },
  requester: {
    name: 'Asha Rao',
    email: 'asha@buyer.example',
    emailVerified: true,
    role: 'BUYER',
    companyName: null,
    companyNameEditable: true,
    canReferenceOrder: true,
  },
  attachments: {
    available: true,
    reason: null,
    maxBytes: 1_048_576,
    maxFiles: 10,
    types: ['image/png', 'image/jpeg', 'video/mp4', 'application/pdf'],
  },
  limits: {
    nameMax: 120,
    companyNameMax: 255,
    subjectMin: 3,
    subjectMax: 160,
    messageMin: 10,
    messageMax: 5000,
    orderNumberMax: 32,
    perDay: 10,
  },
};

const TICKET = {
  reference: 'SR-7K2M-QX9D',
  category: 'ORDERS',
  subject: 'Where is my delivery?',
  status: 'OPEN',
  relatedOrderNumber: null,
  lastActivityAt: '2026-09-28T10:00:00.000Z',
  createdAt: '2026-09-28T10:00:00.000Z',
  message: 'The tracking has not moved.',
  companyName: null,
  attachments: [],
  canReply: true,
  thread: [],
};

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown>;
  idempotencyKey: string | null;
}

function stubApi(options: { failCreates?: number; createDelayMs?: number } = {}): Call[] {
  const calls: Call[] = [];
  let failures = options.failCreates ?? 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      const headers = new Headers(init?.headers);
      calls.push({ url, method, body, idempotencyKey: headers.get('idempotency-key') });

      // The globe's map. Refused on purpose: the form must not care.
      if (url.includes('countries-110m'))
        return Promise.resolve(new Response('nope', { status: 500 }));
      if (url.endsWith('/support/context')) return Promise.resolve(jsonResponse(CONTEXT));
      if (url.endsWith('/support/tickets') && method === 'POST') {
        if (failures > 0) {
          failures -= 1;
          return Promise.resolve(errorResponse(503, 'SERVICE_UNAVAILABLE', 'down'));
        }
        const answer = jsonResponse({ ticket: TICKET, acknowledgementQueued: true }, 201);
        return options.createDelayMs === undefined
          ? Promise.resolve(answer)
          : new Promise((resolve) =>
              setTimeout(() => {
                resolve(answer);
              }, options.createDelayMs),
            );
      }
      if (url.endsWith('/attachments') && method === 'POST') {
        const file = init?.body instanceof FormData ? init.body.get('file') : null;
        const name = file instanceof File ? file.name : 'file';
        return Promise.resolve(
          jsonResponse(
            {
              attachment: {
                id: '01FILE0000000000000000000A',
                fileName: name,
                contentType: 'image/png',
                kind: 'IMAGE',
                byteSize: 10,
                createdAt: '2026-09-28T10:00:00.000Z',
              },
            },
            201,
          ),
        );
      }
      return Promise.resolve(jsonResponse({}));
    }),
  );
  return calls;
}

function creates(calls: Call[]): Call[] {
  return calls.filter((call) => call.method === 'POST' && call.url.endsWith('/support/tickets'));
}

function renderPage(signedIn = true, route = '/support'): void {
  renderWithProviders(
    <Routes>
      <Route path="/support" element={<SupportPage />} />
      <Route path="/login" element={<p>Login page</p>} />
    </Routes>,
    {
      config: CONFIG,
      route,
      session: signedIn ? makeSession() : makeSession({ user: null, isCustomer: false }),
    },
  );
}

async function fillValidForm(): Promise<void> {
  await screen.findByLabelText(/Subject/);
  fireEvent.change(screen.getByLabelText(/What is it about/), { target: { value: 'ORDERS' } });
  fireEvent.change(screen.getByLabelText(/Subject/), {
    target: { value: 'Where is my delivery?' },
  });
  fireEvent.change(screen.getByLabelText(/Describe the issue/), {
    target: { value: 'The tracking has not moved since Monday.' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Support page', () => {
  it('shows a guest the published contacts and a sign-in, with no placeholder anywhere', async () => {
    stubApi();
    renderPage(false);

    expect(screen.getByRole('heading', { level: 1, name: 'How can we help?' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /help@shop\.example/ })).toHaveAttribute(
      'href',
      'mailto:help@shop.example',
    );
    expect(screen.getByRole('link', { name: /\+91 22 1234 5678/ })).toHaveAttribute(
      'href',
      'tel:+912212345678',
    );
    expect(screen.getByRole('link', { name: 'Sign in to continue' })).toHaveAttribute(
      'href',
      '/login',
    );
    expect(screen.queryByLabelText(/Subject/)).not.toBeInTheDocument();

    const text = document.body.textContent;
    for (const placeholder of ['yoursaas', 'scrollx', 'XX21', 'Ahdeetai', 'ScrollX']) {
      expect(text.toLowerCase()).not.toContain(placeholder.toLowerCase());
    }
    await waitFor(() => {
      expect(screen.getByTestId('support-globe')).toBeInTheDocument();
    });
  });

  it('says so honestly when no contact details are published', () => {
    stubApi();
    renderWithProviders(<SupportPage />, {
      config: {
        ...CONFIG,
        business: { ...CONFIG.business, supportEmail: null, supportPhone: null },
      },
      session: makeSession({ user: null, isCustomer: false }),
    });
    expect(
      screen.getByText(/No support email or phone number has been published yet/),
    ).toBeInTheDocument();
  });

  it('asks only about the issue: no name, email or company fields', async () => {
    stubApi();
    renderPage();

    await screen.findByLabelText(/Subject/);
    expect(screen.queryByLabelText(/Full name/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Email address/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Company/)).not.toBeInTheDocument();
    // Whose name it goes in is said once, from the account.
    expect(screen.getByText('Raised as Asha Rao. Replies go to asha@buyer.example.')).toBeInTheDocument();
  });

  it('prefills the order number a page sent it with', async () => {
    stubApi();
    renderPage(true, '/support?order=UB-2026-000123&category=ORDERS');
    expect(await screen.findByLabelText(/Order number/)).toHaveValue('UB-2026-000123');
    expect(screen.getByLabelText(/What is it about/)).toHaveValue('ORDERS');
  });

  it('refuses empty and short fields before anything is sent', async () => {
    const calls = stubApi();
    renderPage();
    await screen.findByLabelText(/Subject/);
    fireEvent.change(screen.getByLabelText(/Describe the issue/), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Raise ticket' }));

    const summary = await screen.findByRole('heading', { name: 'Please check these fields' });
    expect(summary).toBeInTheDocument();
    expect(screen.getAllByText('Choose what your request is about.').length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Describe the problem in at least 10 characters/).length,
    ).toBeGreaterThan(0);
    expect(creates(calls)).toHaveLength(0);
  });

  it('sends once, with an Idempotency-Key, and shows the reference', async () => {
    const calls = stubApi();
    renderPage();
    await fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Raise ticket' }));

    expect(await screen.findByText('SR-7K2M-QX9D')).toBeInTheDocument();
    expect(
      screen.getByText(/We are sending a confirmation to asha@buyer\.example/),
    ).toBeInTheDocument();
    const posted = creates(calls);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.idempotencyKey).toMatch(/[0-9a-f-]{36}/);
    expect(posted[0]?.body).toMatchObject({
      category: 'ORDERS',
      subject: 'Where is my delivery?',
    });
    // Nothing about who is asking: the server takes it from the session.
    expect(posted[0]?.body).not.toHaveProperty('name');
    // The form never claims an email address; the server uses the account's.
    expect(posted[0]?.body).not.toHaveProperty('email');
    expect(screen.getByRole('link', { name: 'View your ticket' })).toHaveAttribute(
      'href',
      '/account/support/SR-7K2M-QX9D',
    );
  });

  it('posts once for a double-click', async () => {
    const calls = stubApi({ createDelayMs: 50 });
    renderPage();
    await fillValidForm();
    const button = screen.getByRole('button', { name: 'Raise ticket' });
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByText('SR-7K2M-QX9D');
    expect(creates(calls)).toHaveLength(1);
  });

  it('keeps everything typed when sending fails, and retries with the same key', async () => {
    const calls = stubApi({ failCreates: 1 });
    renderPage();
    await fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Raise ticket' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText(/Subject/)).toHaveValue('Where is my delivery?');
    expect(screen.getByLabelText(/Describe the issue/)).toHaveValue(
      'The tracking has not moved since Monday.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Raise ticket' }));
    await screen.findByText('SR-7K2M-QX9D');
    const posted = creates(calls);
    expect(posted).toHaveLength(2);
    expect(posted[1]?.idempotencyKey).toBe(posted[0]?.idempotencyKey);
  });

  it('puts a server refusal on the field it names', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith('/support/context')) return Promise.resolve(jsonResponse(CONTEXT));
        if (url.endsWith('/support/tickets') && init?.method === 'POST') {
          return Promise.resolve(
            errorResponse(422, 'SUPPORT_ORDER_NOT_FOUND', 'Not yours', [
              { field: 'orderNumber', code: 'NOT_FOUND' },
            ]),
          );
        }
        return Promise.resolve(new Response('', { status: 500 }));
      }),
    );
    renderPage();
    await fillValidForm();
    fireEvent.change(screen.getByLabelText(/Order number/), { target: { value: 'UB-NOT-MINE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Raise ticket' }));
    expect(
      (
        await screen.findAllByText(
          'This is not one of your orders. Check the number, or leave it empty.',
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it('shows only contact details when the operator has switched requests off', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(
          (input instanceof Request ? input.url : String(input)).endsWith('/support/context')
            ? jsonResponse({ ...CONTEXT, enabled: false })
            : new Response('', { status: 500 }),
        ),
      ),
    );
    renderPage();
    expect(
      await screen.findByText(/Tickets cannot be raised online here/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Raise ticket' })).not.toBeInTheDocument();
  });
});

describe('files on a new ticket', () => {
  it('attaches the chosen files after the ticket exists, and says so', async () => {
    const calls = stubApi();
    renderPage();
    await fillValidForm();
    const photo = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'damage.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Photos, videos or documents'), { target: { files: [photo] } });
    expect(screen.getByText('damage.png')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Raise ticket' }));
    expect(await screen.findByText('Attached: damage.png')).toBeInTheDocument();

    const order = calls
      .filter((call) => call.method === 'POST')
      .map((call) => (call.url.endsWith('/attachments') ? 'file' : 'ticket'));
    expect(order).toEqual(['ticket', 'file']);
    expect(calls.some((call) => call.url.includes('/support/tickets/SR-7K2M-QX9D/attachments'))).toBe(true);
  });

  it('refuses a file of the wrong kind before anything is sent', async () => {
    stubApi();
    renderPage();
    await screen.findByLabelText(/Subject/);
    const script = new File(['echo hi'], 'run.sh', { type: 'text/x-sh' });
    fireEvent.change(screen.getByLabelText('Photos, videos or documents'), { target: { files: [script] } });
    expect(await screen.findByText(/run\.sh cannot be attached/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove run.sh' })).not.toBeInTheDocument();
  });

  it('says honestly when files cannot be attached here', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        return Promise.resolve(
          url.endsWith('/support/context')
            ? jsonResponse({ ...CONTEXT, attachments: { ...CONTEXT.attachments, available: false, reason: 'NO_SCANNER' } })
            : new Response('', { status: 500 }),
        );
      }),
    );
    renderPage();
    expect(await screen.findByText(/Files cannot be attached here/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Photos, videos or documents')).not.toBeInTheDocument();
  });
});

describe('the ways into Support', () => {
  it('is in the header and the footer', () => {
    stubApi();
    renderWithProviders(
      <>
        <Header />
        <Footer />
      </>,
      { config: CONFIG },
    );
    const links = screen.getAllByRole('link', { name: 'Support' });
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const link of links) expect(link).toHaveAttribute('href', '/support');
  });

  it('is in the account menu', async () => {
    stubApi();
    renderWithProviders(<Header />, { config: CONFIG });
    fireEvent.click(screen.getByRole('button', { name: /Your account|Account for/ }));
    const menu = await screen.findByRole('navigation', { name: /Your account/ });
    expect(within(menu).getByRole('link', { name: 'Support' })).toHaveAttribute('href', '/support');
  });
});

describe('the frequently asked questions', () => {
  it('sits after the heading and before the contact details and the form, once', async () => {
    stubApi();
    renderPage();
    const heading = screen.getByRole('heading', { level: 1, name: 'How can we help?' });
    const faq = screen.getByRole('region', { name: 'Frequently asked questions' });
    const contact = screen.getByRole('heading', { name: 'Get in touch' });
    const form = await screen.findByLabelText(/Subject/);

    const follows = (a: Node, b: Node): boolean =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(heading, faq)).toBe(true);
    expect(follows(faq, contact)).toBe(true);
    expect(follows(faq, form)).toBe(true);
    expect(faq).toHaveAttribute('id', 'support-faq');
    expect(faq.contains(form)).toBe(false);

    expect(screen.getAllByRole('region', { name: 'Frequently asked questions' })).toHaveLength(1);
    expect(screen.getAllByRole('tablist')).toHaveLength(1);
  });

  it('carries none of the reference component\'s sample content', async () => {
    stubApi();
    renderPage(false);
    const faq = screen.getByRole('region', { name: 'Frequently asked questions' });
    for (const tab of within(faq).getAllByRole('tab')) {
      fireEvent.click(tab);
      await waitFor(() => {
        expect(tab).toHaveAttribute('aria-selected', 'true');
      });
    }
    const text = faq.textContent.toLowerCase();
    for (const sample of ['smoothui', 'shadcn', 'npx', 'next.js', 'tailwind', 'mit license', 'typescript']) {
      expect(text).not.toContain(sample);
    }
  });

  it('shows a guest no link that ends at a sign-in wall', () => {
    stubApi();
    renderPage(false);
    fireEvent.click(screen.getByRole('tab', { name: 'Orders and payments' }));
    expect(screen.queryByRole('link', { name: 'View your orders' })).not.toBeInTheDocument();
  });

  it('gives a signed-in buyer the link to their orders', async () => {
    stubApi();
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Orders and payments' }));
    const question = await screen.findByRole('button', { name: 'Where can I view my orders?' });
    fireEvent.click(question);
    // The invoice answer carries the same link, so look inside this answer.
    const answer = document.getElementById(question.getAttribute('aria-controls') ?? '');
    if (answer === null) throw new Error('no answer panel');
    expect(within(answer).getByRole('link', { name: 'View your orders' })).toHaveAttribute(
      'href',
      '/account/orders',
    );
  });

  it('leaves out company questions where companies are switched off', () => {
    stubApi();
    renderWithProviders(<SupportPage />, {
      config: { ...CONFIG, features: { ...CONFIG.features, buyerCompanies: false } },
      session: makeSession({ user: null, isCustomer: false }),
    });
    expect(
      screen.queryByRole('button', { name: 'How do I create a company account?' }),
    ).not.toBeInTheDocument();
  });

  it('never offers a sign-up link where sign-up is by invitation', () => {
    stubApi();
    renderWithProviders(<SupportPage />, {
      config: { ...CONFIG, features: { ...CONFIG.features, selfRegistration: false } },
      session: makeSession({ user: null, isCustomer: false }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'How do I create an account for myself?' }));
    expect(screen.getByText(/Accounts here are created by invitation/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create an account' })).not.toBeInTheDocument();
  });

  it('leaves what is typed in the form alone, and sends nothing', async () => {
    const calls = stubApi();
    renderPage();
    await fillValidForm();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;

    fireEvent.click(screen.getByRole('tab', { name: 'ERP and technical help' }));
    fireEvent.click(await screen.findByRole('button', { name: 'How can I reach a person in support?' }));
    fireEvent.click(screen.getByRole('button', { name: 'Contact support' }));

    expect(scroll).toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Raise a ticket' })).toHaveFocus();
    expect(screen.getByLabelText(/Subject/)).toHaveValue('Where is my delivery?');
    expect(screen.getByLabelText(/Describe the issue/)).toHaveValue(
      'The tracking has not moved since Monday.',
    );
    expect(creates(calls)).toHaveLength(0);
  });

  it('takes nothing with it when it fails', async () => {
    stubApi();
    faq.fails = true;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      renderPage();
      expect(screen.queryByRole('region', { name: 'Frequently asked questions' })).not.toBeInTheDocument();
      expect(await screen.findByLabelText(/Subject/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Raise ticket' })).toBeInTheDocument();
    } finally {
      faq.fails = false;
      quiet.mockRestore();
    }
  });

  it('is where a link to #support-faq lands', async () => {
    stubApi();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderPage(false, '/support#support-faq');
    await waitFor(() => {
      expect(scroll).toHaveBeenCalled();
    });
    expect(scroll.mock.contexts[0]).toHaveAttribute('id', 'support-faq');
  });

  it('is not on Seller Hub\'s Support page', async () => {
    stubApi();
    renderWithProviders(<SellerSupportPage />, { config: CONFIG });
    expect(await screen.findByLabelText(/Subject/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Frequently asked questions' })).not.toBeInTheDocument();
  });

  it('is rendered by the Support page and by nothing else', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files = (readdirSync(src, { recursive: true }) as string[])
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .map((file) => file.split(String.fromCharCode(92)).join('/'));
    const users = files.filter((file) =>
      /from '@\/components\/support\/(SupportFaq|FaqCategorized)'|from '\.\/(SupportFaq|FaqCategorized)'/.test(
        readFileSync(join(src, file), 'utf8'),
      ),
    );
    expect(users.sort()).toEqual(['components/support/SupportFaq.tsx', 'pages/SupportPage.tsx']);
  });
});
