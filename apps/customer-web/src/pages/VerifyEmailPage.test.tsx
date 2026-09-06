/**
 * The confirmation link.
 *
 * The page redeems a single-use token on arrival, so the two things worth
 * asserting are that it redeems it exactly once and that it says the right
 * thing about each of the three answers the server can give.
 *
 * The double-redeem case is rendered under `StrictMode` deliberately: that is
 * the mode the real app runs in during development, it mounts every effect
 * twice, and without the ref guard inside the page the second mount spends a
 * token the first one already used - so the first thing any developer sees
 * when testing this flow is "this link has already been used".
 */
import { StrictMode } from 'react';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VerifyEmailPage } from './VerifyEmailPage';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const LINK = '/verify-email?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('VerifyEmailPage', () => {
  it('signs the shopper on where the account is open immediately', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ verified: true, email: 'asha@example.test', status: 'ACTIVE' }),
    );

    renderWithProviders(<VerifyEmailPage />, { route: LINK });

    expect(await screen.findByText('Your email is confirmed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login');
  });

  it('says the account is with staff where the deployment reviews sign-ups', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ verified: true, email: 'asha@example.test', status: 'PENDING_APPROVAL' }),
    );

    renderWithProviders(<VerifyEmailPage />, { route: LINK });

    expect(await screen.findByText(/thank you - your email is confirmed/i)).toBeInTheDocument();
    // No sign-in button: it would fail, and offering it is how a support call
    // starts. The catalogue is public, so that is the useful way on.
    expect(screen.queryByRole('link', { name: /^sign in$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /browse products/i })).toBeInTheDocument();
  });

  it('redeems the token once, even mounted twice by StrictMode', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ verified: true, email: 'asha@example.test', status: 'ACTIVE' }),
    );

    renderWithProviders(
      <StrictMode>
        <VerifyEmailPage />
      </StrictMode>,
      { route: LINK },
    );

    await screen.findByText('Your email is confirmed');
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('offers a fresh link when the old one has expired', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(400, 'TOKEN_EXPIRED', 'This link has expired. Request a new one to continue.'),
    );

    renderWithProviders(<VerifyEmailPage />, { route: LINK });

    expect(await screen.findByText('This confirmation link has expired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send a new link/i })).toBeInTheDocument();
  });

  it('does not offer a fresh link for a token that was never valid', async () => {
    fetchMock.mockResolvedValue(errorResponse(400, 'TOKEN_INVALID', 'This link is not valid.'));

    renderWithProviders(<VerifyEmailPage />, { route: LINK });

    expect(await screen.findByText('This confirmation link is not valid')).toBeInTheDocument();
    // Another link would land in the same inbox and fail the same way; the way
    // out is the email itself, or support.
    expect(screen.queryByRole('button', { name: /send a new link/i })).not.toBeInTheDocument();
  });

  it('never calls the server for a link with no token in it', async () => {
    renderWithProviders(<VerifyEmailPage />, { route: '/verify-email' });

    expect(await screen.findByText('This confirmation link is not valid')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
