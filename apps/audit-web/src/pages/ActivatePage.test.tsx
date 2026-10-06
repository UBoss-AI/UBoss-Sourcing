/**
 * Activating an audit account from an invitation.
 *
 * Pinned here: what is sent (the token from the link and the chosen password,
 * nothing else - there is no audit agreement to accept), that a short or
 * mismatched password never reaches the server, that the server's refusal is
 * shown in its own words, and that a link with no token says so instead of
 * offering a form that cannot work.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/app/ThemeProvider';
import { i18n } from '@/i18n/config';
import { ApiError } from '@/lib/api';
import { ActivatePage } from './ActivatePage';

vi.mock('@/lib/audit', () => ({ activateAccount: vi.fn() }));

const { activateAccount } = vi.mocked(await import('@/lib/audit'));

const TOKEN = 'a-token-long-enough-to-be-real';

function renderPage(entry = `/activate?token=${TOKEN}`): void {
  render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/activate" element={<ActivatePage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </I18nextProvider>,
  );
}

function fill(password: string, confirm = password): void {
  fireEvent.input(screen.getByLabelText('New password'), { target: { value: password } });
  fireEvent.input(screen.getByLabelText('Confirm password'), { target: { value: confirm } });
  fireEvent.click(screen.getByRole('button', { name: 'Activate my account' }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('activating an audit account', () => {
  it('sends the token and the password, and nothing about terms', async () => {
    activateAccount.mockResolvedValue({ activated: true, email: 'inspector@northgate.example' });
    renderPage();

    fill('AuditorPassword!2026');

    await waitFor(() => {
      expect(activateAccount).toHaveBeenCalledWith({ token: TOKEN, password: 'AuditorPassword!2026' });
    });
    expect(await screen.findByText(/your account is active/i)).toBeDefined();
  });

  it('does not send a password shorter than twelve characters', async () => {
    renderPage();

    fill('short');

    expect(await screen.findAllByRole('alert')).not.toHaveLength(0);
    expect(activateAccount).not.toHaveBeenCalled();
  });

  it('does not send two passwords that differ', async () => {
    renderPage();

    fill('AuditorPassword!2026', 'AuditorPassword!2027');

    expect(await screen.findByText('Those two passwords are not the same.')).toBeDefined();
    expect(activateAccount).not.toHaveBeenCalled();
  });

  it('shows the server’s refusal in its own words', async () => {
    activateAccount.mockRejectedValue(
      new ApiError(400, { code: 'TOKEN_EXPIRED', message: 'This invitation has expired.' }),
    );
    renderPage();

    fill('AuditorPassword!2026');

    expect(await screen.findByText('This invitation has expired.')).toBeDefined();
  });

  it('says the link is broken when it carries no token', () => {
    renderPage('/activate');

    expect(screen.getByText(/invitation link is not valid any more/i)).toBeDefined();
    expect(screen.queryByLabelText('New password')).toBeNull();
  });
});
