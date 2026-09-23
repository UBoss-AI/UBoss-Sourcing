/**
 * The carrier setup panel names ONE carrier, the one it is for.
 *
 * The bug this guards: a FedEx method with no connection yet had no provider
 * the panel could read, so it fell back to DHL - "Your DHL account" on the
 * FedEx card, DHL's credential fields, and a DHL connection created when the
 * button was pressed. Every test here renders a carrier's panel and reads the
 * WHOLE of what is on screen for another carrier's name.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n/config';
import { CARRIERS } from '@/lib/carrier-providers';
import type { FulfilmentMethod } from '@/lib/seller';
import { renderWithProviders } from '@/test/harness';
import { FulfilmentSetupPanel } from './FulfilmentSetupPanel';

const fetchCarrierConnections = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const fetchCredentialFields = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const createCarrierConnection = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('@/lib/seller', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/seller')>();
  return {
    ...actual,
    fetchCarrierConnections: (...args: unknown[]) => fetchCarrierConnections(...args),
    fetchCredentialFields: (...args: unknown[]) => fetchCredentialFields(...args),
    createCarrierConnection: (...args: unknown[]) => createCarrierConnection(...args),
  };
});

function method(provider: 'DHL' | 'FEDEX' | 'INDIA_POST', over: Partial<FulfilmentMethod> = {}): FulfilmentMethod {
  return {
    id: `method-${provider}`,
    mode: 'INTEGRATED_CARRIER',
    status: 'PENDING_SETUP',
    statusLabel: 'waiting for you to finish setting it up',
    role: 'ADDITIONAL',
    publicDisplayName: CARRIERS[provider].displayName,
    allowsInternational: false,
    statusReason: null,
    submittedAt: null,
    decidedAt: null,
    provider,
    environment: 'SANDBOX',
    carrierSetupStatus: provider === 'INDIA_POST' ? 'MANUAL_MODE_AVAILABLE' : 'NOT_CONFIGURED',
    manualBookingAvailable: true,
    connection: null,
    partner: null,
    ruleCount: 0,
    ...over,
  };
}

const OTHERS: Record<string, RegExp> = {
  DHL: /FedEx|India Post/i,
  FEDEX: /DHL|India Post/i,
  INDIA_POST: /DHL|FedEx/i,
};

beforeEach(() => {
  // The seller has a DHL connection already - the case that made the FedEx
  // panel show DHL's state.
  fetchCarrierConnections.mockResolvedValue({
    connections: [
      {
        id: 'conn-dhl',
        provider: 'DHL',
        environment: 'SANDBOX',
        state: 'CREDENTIALS_SET',
        trackingMode: 'AUTOMATIC_API',
        accountNumberHint: '…1234',
        credentialHint: null,
        hasCredential: true,
        lastTestAt: null,
        lastTestPassedAt: null,
        lastTestMessage: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureMessage: null,
        consecutiveFailures: 0,
        productionConfirmedAt: null,
        hasVerifiedApi: true,
      },
    ],
  });
  fetchCredentialFields.mockImplementation((provider: unknown) =>
    Promise.resolve({ fields: provider === 'DHL' ? ['apiKey', 'apiSecret'] : ['clientId', 'clientSecret'] }),
  );
  createCarrierConnection.mockResolvedValue({ connection: {} });
});

afterEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('en');
});

describe.each(['en', 'de', 'pl'])('in %s', (language) => {
  beforeEach(async () => {
    await i18n.changeLanguage(language);
  });

  it.each(['DHL', 'FEDEX', 'INDIA_POST'] as const)('the %s panel never names another carrier', async (provider) => {
    const { container } = renderWithProviders(<FulfilmentSetupPanel method={method(provider)} isEditable />);

    await waitFor(() => {
      expect(container.querySelector(`[data-carrier="${provider}"]`)).not.toBeNull();
    });

    expect(container.textContent).not.toMatch(OTHERS[provider] as RegExp);
    expect(container.textContent).toContain(CARRIERS[provider].displayName);
    // Nothing is connected from a saved form.
    expect(container.textContent).not.toMatch(/\bConnected\b/);
  });
});

describe('the fields each carrier asks for', () => {
  it('FedEx asks for a FedEx account number and never DHL\'s fields', async () => {
    renderWithProviders(<FulfilmentSetupPanel method={method('FEDEX')} isEditable />);
    expect(await screen.findByText('Your FedEx account')).toBeTruthy();
    expect(screen.getByLabelText('FedEx account number')).toBeTruthy();
    expect(screen.queryByText(/Your DHL account/)).toBeNull();
    // It is NOT shown DHL's connection state just because DHL exists.
    expect(screen.queryByText(/…1234/)).toBeNull();
  });

  it('pressing the FedEx button creates a FedEx connection, not a DHL one', async () => {
    renderWithProviders(<FulfilmentSetupPanel method={method('FEDEX')} isEditable />);
    const input = await screen.findByLabelText('FedEx account number');
    fireEvent.change(input, { target: { value: '123456789' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the FedEx account number' }));

    await waitFor(() => {
      expect(createCarrierConnection).toHaveBeenCalled();
    });
    expect(createCarrierConnection.mock.calls[0]?.[0]).toMatchObject({ provider: 'FEDEX' });
  });

  it('India Post asks for nothing: no account number, no key, no connect button', async () => {
    renderWithProviders(<FulfilmentSetupPanel method={method('INDIA_POST')} isEditable />);
    expect(await screen.findByText('Your India Post business account')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(/no official API to connect to/)).toBeTruthy();
    expect(fetchCredentialFields).not.toHaveBeenCalled();
  });

  it('a carrier with no API connection says manual booking still works', async () => {
    renderWithProviders(<FulfilmentSetupPanel method={method('DHL')} isEditable />);
    expect(await screen.findByText(/API account not connected\. You can still assign this carrier/)).toBeTruthy();
    expect(screen.getByText('Carrier API not connected')).toBeTruthy();
  });

  it('can be closed without finishing', async () => {
    const onClose = vi.fn();
    renderWithProviders(<FulfilmentSetupPanel method={method('FEDEX')} isEditable onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close and finish later' }));
    expect(onClose).toHaveBeenCalled();
  });
});

/** Switches the panel between carriers the way the method list does. */
function Switcher(): React.JSX.Element {
  const [provider, setProvider] = useState<'DHL' | 'FEDEX' | 'INDIA_POST'>('FEDEX');
  return (
    <div>
      {(['DHL', 'FEDEX', 'INDIA_POST'] as const).map((entry) => (
        <button key={entry} type="button" onClick={() => { setProvider(entry); }}>
          {`show-${entry}`}
        </button>
      ))}
      <div data-testid="panel">
        <FulfilmentSetupPanel method={method(provider)} isEditable />
      </div>
    </div>
  );
}

describe('switching between carriers', () => {
  it('keeps nothing from the last one - no label, no typed value', async () => {
    renderWithProviders(<Switcher />);
    const panel = (): string => screen.getByTestId('panel').textContent;
    fireEvent.change(await screen.findByLabelText('FedEx account number'), { target: { value: '999888777' } });

    for (let round = 0; round < 3; round += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'show-DHL' }));
      // DHL is the carrier this seller already has an account with, so it
      // shows THAT account - and FedEx, a moment ago, did not.
      expect(await screen.findByText(/…1234/)).toBeTruthy();
      for (const input of screen.getByTestId('panel').querySelectorAll('input')) {
        expect((input).value).toBe('');
      }
      expect(panel()).not.toMatch(/FedEx/);

      fireEvent.click(screen.getByRole('button', { name: 'show-INDIA_POST' }));
      await screen.findByText('Your India Post business account');
      expect(panel()).not.toMatch(/DHL|FedEx/);

      fireEvent.click(screen.getByRole('button', { name: 'show-FEDEX' }));
      const fedex = await screen.findByLabelText('FedEx account number');
      expect((fedex as HTMLInputElement).value).toBe('');
      expect(panel()).not.toMatch(/DHL/);
    }
  });
});

describe('the carrier definitions', () => {
  it('ask for exactly the fields the server asks for', () => {
    // Held together with CREDENTIAL_FIELDS in the backend's
    // carrier-credential.service.ts, which has the mirror of this test.
    expect(CARRIERS.DHL.credentialFields.map((field) => field.name)).toEqual(['apiKey', 'apiSecret']);
    expect(CARRIERS.FEDEX.credentialFields.map((field) => field.name)).toEqual(['clientId', 'clientSecret']);
    expect(CARRIERS.INDIA_POST.credentialFields).toEqual([]);
    expect(CARRIERS.INDIA_POST.accountNumber).toBeNull();
  });

  it('never share a translation key between carriers', () => {
    const keysOf = (provider: keyof typeof CARRIERS): string[] => {
      const carrier = CARRIERS[provider];
      return [
        carrier.titleKey,
        carrier.descriptionKey,
        ...(carrier.accountNumber === null ? [] : [carrier.accountNumber.labelKey, carrier.accountNumber.hintKey]),
        ...carrier.credentialFields.map((field) => field.labelKey),
        ...carrier.setupStepKeys,
      ];
    };
    for (const provider of ['DHL', 'FEDEX', 'INDIA_POST'] as const) {
      for (const key of keysOf(provider)) expect(key.startsWith(`carrier.${provider}.`)).toBe(true);
    }
  });
});
