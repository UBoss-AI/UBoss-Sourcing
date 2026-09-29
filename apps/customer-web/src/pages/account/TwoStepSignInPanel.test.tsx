/**
 * Two-step sign-in on the profile page (checklist Master row 10).
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwoStepSignInPanel } from './TwoStepSignInPanel';
import { jsonResponse, makeSession, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();

function mfa(overrides: Record<string, unknown> = {}) {
  return {
    mfa: {
      available: true,
      enabled: false,
      required: false,
      requiredReason: null,
      sessionVerified: true,
      challengePending: false,
      recoveryCodesRemaining: 0,
      stepUpMethod: 'PASSWORD',
      stepUpValidUntil: null,
      ...overrides,
    },
  };
}

function serve(state: ReturnType<typeof mfa>): void {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/auth/mfa/recovery-codes')) {
      return Promise.resolve(jsonResponse({ recoveryCodes: ['aaaa-1111', 'bbbb-2222'] }));
    }
    if (url.includes('/auth/mfa/disable')) return Promise.resolve(jsonResponse({ enabled: false }));
    if (url.includes('/auth/mfa/setup')) {
      return Promise.resolve(jsonResponse({ secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP', recoveryCodes: ['cccc-3333'] }));
    }
    if (url.includes('/auth/mfa') && (init?.method ?? 'GET') === 'GET') return Promise.resolve(jsonResponse(state));
    return Promise.resolve(jsonResponse({}));
  });
}

function render(): void {
  renderWithProviders(<TwoStepSignInPanel />, { session: makeSession({ refreshUser: vi.fn(() => Promise.resolve()) }) });
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TwoStepSignInPanel', () => {
  it('offers to turn it on, and starts the enrolment flow', async () => {
    serve(mfa());
    render();

    expect(await screen.findByText(/protected by your password only/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Turn on two-step sign-in' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/auth/mfa/setup'))).toBe(true);
    });
  });

  it('shows new recovery codes once, and can switch it off', async () => {
    serve(mfa({ enabled: true, recoveryCodesRemaining: 7 }));
    render();

    expect(await screen.findByText('7 recovery codes left.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Replace recovery codes' }));
    expect(await screen.findByText('aaaa-1111')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Turn off two-step sign-in' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/auth/mfa/disable') && (init as RequestInit).method === 'POST')).toBe(true);
    });
  });

  it('explains, and offers no switch-off, while a seller role requires it', async () => {
    serve(mfa({ enabled: true, required: true, requiredReason: 'SELLER_OWNER', recoveryCodesRemaining: 10 }));
    render();

    expect(await screen.findByText(/while you own a seller account/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn off two-step sign-in' })).not.toBeInTheDocument();
  });

  it('shows nothing where the deployment does not offer it', async () => {
    serve(mfa({ available: false }));
    render();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText('Two-step sign-in')).not.toBeInTheDocument();
  });
});
