/**
 * The console's sign-in, and the tick it asks for.
 *
 *   - With staff terms published, the box opens them: signing in needs "I
 *     agree" in the dialog, and the tick still never reaches the server -
 *     `login` is called with the email and the password and nothing else.
 *   - With none published, or the terms unreachable, the plain tick box
 *     stands in. A missing document must never lock staff out of the console
 *     that publishes it.
 *
 * Plain assertions throughout: this app's test setup has no jest-dom matchers.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { i18n } from '@/i18n/config';
import { ApiError, NetworkError } from '@/lib/api';
import type { CurrentLegalDocument } from '@/lib/legal-documents';
import { LoginPage } from './LoginPage';

// The turning earth is decoration and needs WebGL; the frame alone will do.
vi.mock('@/components/ui/auth-split', () => ({
  AuthSplit: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/lib/legal-documents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/legal-documents')>();
  return { ...actual, fetchCurrentTerms: vi.fn() };
});

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn() } };
});

const { fetchCurrentTerms } = await import('@/lib/legal-documents');
const { api } = await import('@/lib/api');
const fetchTerms = vi.mocked(fetchCurrentTerms);
const apiGet = vi.mocked(api.get);

// jsdom implements no scrolling; the Modal's scroll lock restores a position.
window.scrollTo = () => undefined;

// jsdom has no <dialog> methods; the Modal only needs `open` toggled.
const dialogProto = HTMLDialogElement.prototype as HTMLDialogElement & {
  showModal?: () => void;
  close?: () => void;
};
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

const STAFF_TERMS: CurrentLegalDocument = {
  document: {
    id: '01JSTAFFTERMS0000000000001',
    kind: 'STAFF_TERMS',
    version: 'staff-2026-10',
    locale: 'en',
    title: 'Staff Terms of Use',
    body: '## Confidentiality\nWhat you see in this console stays here.',
    changeSummary: null,
    effectiveAt: '2026-10-01T00:00:00.000Z',
    publishedAt: '2026-09-30T00:00:00.000Z',
    contentSha256: 'd'.repeat(64),
  },
  requestedLocale: 'en',
  isFallback: false,
};

let login: ReturnType<typeof vi.fn>;

function renderLogin(): void {
  login = vi.fn(() => Promise.resolve());
  const session = {
    user: null,
    isLoading: false,
    login,
    logout: vi.fn(),
    refreshUser: vi.fn(),
    can: () => false,
    canAny: () => false,
  } as unknown as SessionState;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <SessionContext.Provider value={session}>
          <MemoryRouter initialEntries={['/login']}>
            <LoginPage />
          </MemoryRouter>
        </SessionContext.Provider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

function fillCredentials(): void {
  fireEvent.input(screen.getByLabelText(/email address/i), { target: { value: 'staff@example.test' } });
  fireEvent.input(screen.getByLabelText(/^password/i), { target: { value: 'correct horse battery' } });
}

async function submit(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await Promise.resolve();
  });
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  apiGet.mockResolvedValue({ business: { policyLinks: null } });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('LoginPage with staff terms published', () => {
  beforeEach(() => {
    fetchTerms.mockResolvedValue(STAFF_TERMS);
  });

  it('asks for the staff terms of the screen language, before anybody is signed in', async () => {
    renderLogin();
    await screen.findByRole('checkbox', { name: /staff terms/i });
    expect(fetchTerms).toHaveBeenCalledWith('STAFF_TERMS', 'en');
  });

  it('opens the terms instead of ticking the box, and refuses to sign in until I agree', async () => {
    renderLogin();
    const box = await screen.findByRole<HTMLInputElement>('checkbox', { name: /staff terms/i });
    await waitFor(() => {
      expect(box.disabled).toBe(false);
    });
    fillCredentials();

    fireEvent.click(box);
    const dialog = screen.getByRole('dialog', { name: 'Staff Terms of Use' });
    expect(box.checked).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await submit();
    expect(login).not.toHaveBeenCalled();
    expect(screen.getByText('You need to accept the terms to sign in.')).toBeTruthy();
  });

  it('signs in after I agree, sending the email and password and nothing else', async () => {
    renderLogin();
    const box = await screen.findByRole<HTMLInputElement>('checkbox', { name: /staff terms/i });
    await waitFor(() => {
      expect(box.disabled).toBe(false);
    });
    fillCredentials();

    fireEvent.click(box);
    const agree = within(screen.getByRole('dialog', { name: 'Staff Terms of Use' })).getByRole<HTMLButtonElement>(
      'button',
      { name: 'I agree' },
    );
    // jsdom lays nothing out, so the whole text "fits" and I agree enables.
    await waitFor(() => {
      expect(agree.disabled).toBe(false);
    });
    fireEvent.click(agree);
    expect(box.checked).toBe(true);

    await submit();
    await waitFor(() => {
      expect(login).toHaveBeenCalledTimes(1);
    });
    expect(login.mock.calls[0]).toEqual(['staff@example.test', 'correct horse battery']);
  });
});

describe('LoginPage without staff terms', () => {
  it.each([
    ['none are published', () => new ApiError(503, { code: 'TERMS_DOCUMENT_UNAVAILABLE', message: 'none' })],
    ['the request fails', () => new NetworkError('offline')],
  ])('shows the plain tick box when %s, and signs in with it', async (_name, failure) => {
    fetchTerms.mockRejectedValue(failure());
    renderLogin();

    const box = await screen.findByRole<HTMLInputElement>('checkbox', { name: 'I accept the terms of use' });
    expect(screen.queryByRole('checkbox', { name: /staff terms/i })).toBeNull();
    fillCredentials();

    await submit();
    expect(login).not.toHaveBeenCalled();

    fireEvent.click(box);
    expect(box.checked).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();

    await submit();
    await waitFor(() => {
      expect(login).toHaveBeenCalledTimes(1);
    });
    expect(login.mock.calls[0]).toEqual(['staff@example.test', 'correct horse battery']);
  });
});
