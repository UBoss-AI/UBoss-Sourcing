/**
 * Phone-number change (JOURNEY-008): the screen says where the confirmation
 * link went - a text to the new number when the marketplace has an SMS
 * gateway - and a gateway failure is explained in the shopper's language.
 */
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { ProfileInformationPage } from './ProfileInformationPage';

const fetchMock = vi.fn();

const ACCOUNT = {
  profile: {
    id: 'p1', email: 'asha@example.test', emailVerifiedAt: '2026-01-01T00:00:00.000Z', fullName: 'Asha Rao', firstName: 'Asha', lastName: 'Rao',
    organization: null, department: null, jobTitle: null, phone: null, accountPhone: null, accountPhoneVerifiedAt: null,
    pendingEmail: null, pendingPhone: null, preferredCountry: 'DE', preferredCurrency: 'EUR', preferredLanguage: 'en',
    gstin: null, vatNumber: null, vatNumberValid: null, activatedAt: '2026-01-01T00:00:00.000Z', orderCount: 0,
  },
  purchasingLimits: { perOrderMinMinor: null, perOrderMaxMinor: null, requiresOrderApproval: false, currency: 'EUR' },
  spend: { monthToDateMinor: '0', capMinor: null, remainingMinor: null, currency: 'EUR' },
};

function serve(phoneChange: Response): void {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/account/phone-change') && init?.method === 'POST') return Promise.resolve(phoneChange);
    return Promise.resolve(jsonResponse(ACCOUNT));
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function requestChange(): Promise<void> {
  renderWithProviders(<ProfileInformationPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Mobile number' }));
  fireEvent.change(await screen.findByLabelText(/New mobile number/), { target: { value: '+4915112345678' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send confirmation link' }));
}

describe('ProfileInformationPage phone change', () => {
  it('says the link went to the new number by text message', async () => {
    serve(jsonResponse({ pendingPhone: '+4915112345678', expiresAt: '2026-10-02T00:00:00.000Z', channel: 'SMS' }, 202));
    await requestChange();
    expect(await screen.findByText('We sent a text message with a confirmation link to the new number.')).toBeTruthy();
  });

  it('explains a gateway failure in the shopper’s language', async () => {
    serve(jsonResponse({ error: { code: 'SMS_DELIVERY_FAILED', message: 'The text message could not be sent.', details: [] } }, 502));
    await requestChange();
    expect(await screen.findByText('The text message could not be sent. Nothing was changed; please try again later.')).toBeTruthy();
  });
});
