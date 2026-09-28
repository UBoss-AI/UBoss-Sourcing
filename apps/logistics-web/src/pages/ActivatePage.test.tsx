/**
 * Activating a carrier account from an invitation.
 *
 * Two things are pinned here. What is sent: the document agreed to, never a
 * version string the browser made up. And what a refusal about the terms
 * means: the link was not spent, so the page clears the agreement, fetches
 * the current terms and lets the person agree again - it does not tell them
 * their link is broken.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/app/ThemeProvider';
import { i18n } from '@/i18n/config';
import { ApiError } from '@/lib/api';
import type { CurrentLegalDocument } from '@/lib/legal';
import { ActivatePage } from './ActivatePage';

vi.mock('@/lib/logistics', () => ({ activateAccount: vi.fn() }));
vi.mock('@/lib/legal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/legal')>()),
  fetchCurrentTerms: vi.fn(),
}));

const { activateAccount } = vi.mocked(await import('@/lib/logistics'));
const { fetchCurrentTerms } = vi.mocked(await import('@/lib/legal'));

const DOCUMENT_ID = '01JDOC00000000000000000001';

function current(id = DOCUMENT_ID): CurrentLegalDocument {
  return {
    document: {
      id,
      kind: 'LOGISTICS_PARTNER_TERMS',
      version: '2026-10-01',
      locale: 'en',
      title: 'Logistics Partner Terms',
      body: 'Short.',
      changeSummary: null,
      effectiveAt: '2026-10-01T00:00:00.000Z',
      publishedAt: '2026-09-30T00:00:00.000Z',
      contentSha256: 'c'.repeat(64),
    },
    requestedLocale: 'en',
    isFallback: false,
  };
}

function renderPage(): void {
  render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <MemoryRouter initialEntries={['/activate?token=a-token-long-enough-to-be-real']}>
          <Routes>
            <Route path="/activate" element={<ActivatePage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </I18nextProvider>,
  );
}

async function fillAndAgree(): Promise<void> {
  fireEvent.input(screen.getByLabelText('New password'), {
    target: { value: 'CarrierPassword!2026' },
  });
  fireEvent.input(screen.getByLabelText('Confirm password'), {
    target: { value: 'CarrierPassword!2026' },
  });
  const box = await screen.findByRole('checkbox', { name: /logistics partner terms/i });
  await waitFor(() => {
    expect((box as HTMLInputElement).disabled).toBe(false);
  });
  fireEvent.click(box);
  const dialog = screen.getByRole('dialog', { name: 'Logistics Partner Terms' });
  const agree = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'I agree' });
  await waitFor(() => {
    expect(agree.disabled).toBe(false);
  });
  fireEvent.click(agree);
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  activateAccount.mockReset();
  fetchCurrentTerms.mockReset();
  fetchCurrentTerms.mockResolvedValue(current());
});

describe('ActivatePage', () => {
  it('asks for the carrier terms, not the buyer terms', async () => {
    renderPage();
    await waitFor(() => {
      expect(fetchCurrentTerms).toHaveBeenCalledWith('LOGISTICS_PARTNER_TERMS', 'en');
    });
  });

  it('will not activate until the terms are agreed to', async () => {
    renderPage();
    fireEvent.input(screen.getByLabelText('New password'), {
      target: { value: 'CarrierPassword!2026' },
    });
    fireEvent.input(screen.getByLabelText('Confirm password'), {
      target: { value: 'CarrierPassword!2026' },
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Activate my account' }));
    });

    expect(
      await screen.findByText('Read the terms and agree to them before you continue.'),
    ).toBeTruthy();
    expect(activateAccount).not.toHaveBeenCalled();
  });

  it('sends the document agreed to, and no version string of its own', async () => {
    activateAccount.mockResolvedValue({ activated: true, email: 'driver@example.test' });
    renderPage();
    await fillAndAgree();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Activate my account' }));
    });

    await waitFor(() => {
      expect(activateAccount).toHaveBeenCalledTimes(1);
    });
    const sent = activateAccount.mock.calls[0]?.[0];
    expect(sent).toEqual({
      token: 'a-token-long-enough-to-be-real',
      password: 'CarrierPassword!2026',
      acceptedTerms: true,
      termsDocumentId: DOCUMENT_ID,
    });
    expect(sent).not.toHaveProperty('consentVersion');
  });

  it('clears the agreement and fetches the current terms when they changed, keeping the link', async () => {
    activateAccount.mockRejectedValue(
      new ApiError(409, { code: 'TERMS_VERSION_OUTDATED', message: 'The terms changed.' }),
    );
    renderPage();
    await fillAndAgree();
    fetchCurrentTerms.mockResolvedValue(current('01JDOC00000000000000000002'));
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Activate my account' }));
    });

    expect(await screen.findByText(/the terms have changed\. open them/i)).toBeTruthy();
    const box = screen.getByRole<HTMLInputElement>('checkbox', {
      name: /logistics partner terms/i,
    });
    expect(box.checked).toBe(false);
    // The refetch is started by the same refusal that shows the message, and
    // lands a tick later - waited for, not assumed. Under a loaded runner the
    // synchronous form lost the race.
    await waitFor(() => {
      expect(fetchCurrentTerms).toHaveBeenCalledTimes(2);
    });
    // Not the "this link is not valid any more" dead end.
    expect(screen.queryByText(/not valid any more/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Activate my account' })).toBeTruthy();
  });
});
