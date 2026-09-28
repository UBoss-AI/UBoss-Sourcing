/**
 * Settings → Legal documents.
 *
 *   - the list marks the version in force, and says loudly when no buyer
 *     Terms are, because then nobody can sign up;
 *   - the preview shows what was typed as text - HTML in the body stays
 *     characters on the screen, never markup;
 *   - publishing asks first, and says the words can never change;
 *   - a published document has no way to edit, delete or publish it again;
 *   - somebody who may only read gets no write controls at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import type { LegalDocument } from '@/lib/legal-documents';
import { LegalDocumentEditorPage, LegalDocumentsPage } from './LegalDocumentsPage';

vi.mock('@/lib/legal-documents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/legal-documents')>();
  return {
    ...actual,
    legalDocumentsApi: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      publish: vi.fn(),
    },
  };
});

const { legalDocumentsApi } = await import('@/lib/legal-documents');
const list = vi.mocked(legalDocumentsApi.list);
const get = vi.mocked(legalDocumentsApi.get);
const publish = vi.mocked(legalDocumentsApi.publish);

// jsdom has no <dialog> methods; the Modal only needs `open` toggled.
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

const DRAFT_ID = '01LEGALDRAFT00000000000000';
const PUBLISHED_ID = '01LEGALPUBLISHED0000000000';

function doc(overrides: Partial<LegalDocument> = {}): LegalDocument {
  return {
    id: PUBLISHED_ID,
    kind: 'PLATFORM_TERMS',
    version: '2026-10-01',
    locale: 'en',
    title: 'Terms and Conditions',
    body: '## Using the marketplace\nText written by the operator.',
    changeSummary: null,
    effectiveAt: '2026-10-01T00:00:00.000Z',
    status: 'PUBLISHED',
    publishedAt: '2026-09-30T00:00:00.000Z',
    contentSha256: 'c'.repeat(64),
    supersedesId: null,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    acceptanceCount: 12,
    isCurrentVersion: true,
    ...overrides,
  };
}

const ALL = ['legal_document.read', 'legal_document.write', 'legal_document.publish'];

function renderAt(path: string, permissions: string[] = ALL): void {
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
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path="/settings/legal-documents" element={<LegalDocumentsPage />} />
                <Route path="/settings/legal-documents/new" element={<LegalDocumentEditorPage />} />
                <Route path="/settings/legal-documents/:id" element={<LegalDocumentEditorPage />} />
              </Routes>
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the list of legal documents', () => {
  it('marks the version in force and counts acceptances', async () => {
    list.mockResolvedValue([
      doc(),
      doc({ id: 'c2', kind: 'LOGISTICS_PARTNER_TERMS', version: 'carrier-1', acceptanceCount: 3 }),
    ]);
    renderAt('/settings/legal-documents');

    expect(await screen.findByRole('link', { name: '2026-10-01' })).toBeTruthy();
    expect(screen.getAllByText('In force')).toHaveLength(2);
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.queryByText('No buyer Terms and Conditions are in force')).toBeNull();
    // The operator is told the wording is theirs.
    expect(screen.getByText('The wording is yours to supply')).toBeTruthy();
  });

  it('warns, as an alert, when no buyer Terms are in force', async () => {
    list.mockResolvedValue([doc({ status: 'DRAFT', isCurrentVersion: false, publishedAt: null, contentSha256: null })]);
    renderAt('/settings/legal-documents');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('No buyer Terms and Conditions are in force');
    expect(screen.getByText('No logistics partner terms are in force')).toBeTruthy();
  });

  it('offers no New version to somebody who may only read', async () => {
    list.mockResolvedValue([doc()]);
    renderAt('/settings/legal-documents', ['legal_document.read']);

    expect(await screen.findByRole('link', { name: '2026-10-01' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'New version' })).toBeNull();
  });
});

describe('a draft', () => {
  const draft = doc({
    id: DRAFT_ID,
    status: 'DRAFT',
    version: 'next',
    publishedAt: null,
    contentSha256: null,
    isCurrentVersion: false,
    acceptanceCount: 0,
  });

  it('previews the text as text: headings, bullets, and HTML left as characters', async () => {
    get.mockResolvedValue(draft);
    renderAt(`/settings/legal-documents/${DRAFT_ID}`);

    const body = await screen.findByLabelText(/^Text/);
    fireEvent.change(body, {
      target: { value: '## First clause\n- one\n- two\n\n<b>bold</b><script>alert(1)</script>' },
    });

    const preview = screen.getByTestId('legal-preview');
    expect(within(preview).getByRole('heading', { name: 'First clause' })).toBeTruthy();
    expect(within(preview).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['one', 'two']);
    expect(within(preview).getByText('<b>bold</b><script>alert(1)</script>')).toBeTruthy();
    expect(preview.querySelector('b')).toBeNull();
    expect(preview.querySelector('script')).toBeNull();
  });

  it('asks before publishing, says the words never change, then publishes', async () => {
    get.mockResolvedValue(draft);
    publish.mockResolvedValue(doc({ id: DRAFT_ID, version: 'next' }));
    renderAt(`/settings/legal-documents/${DRAFT_ID}`);

    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
    expect(publish).not.toHaveBeenCalled();
    expect(screen.getByText(/the words can never be changed or deleted/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Publish permanently' }));
    await waitFor(() => {
      expect(publish).toHaveBeenCalledWith(DRAFT_ID);
    });
  });

  it('cannot be published with unsaved changes', async () => {
    get.mockResolvedValue(draft);
    renderAt(`/settings/legal-documents/${DRAFT_ID}`);

    fireEvent.change(await screen.findByLabelText(/^Title/), { target: { value: 'Changed' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Publish' }).disabled).toBe(true);
  });

  it('is read-only, with no save, delete or publish, for somebody who may only read', async () => {
    get.mockResolvedValue(draft);
    renderAt(`/settings/legal-documents/${DRAFT_ID}`, ['legal_document.read']);

    expect(await screen.findByTestId('legal-preview')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    // Disabled by its fieldset, which the property does not reflect.
    expect(screen.getByLabelText(/^Title/).matches(':disabled')).toBe(true);
  });
});

describe('a published document', () => {
  it('has no edit controls, and shows its hash and PDF', async () => {
    get.mockResolvedValue(doc());
    renderAt(`/settings/legal-documents/${PUBLISHED_ID}`);

    expect(await screen.findByText('c'.repeat(64))).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('link', { name: 'Download PDF' }).getAttribute('href')).toContain(
      `/legal/documents/${PUBLISHED_ID}/pdf`,
    );
  });
});
