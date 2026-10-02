/**
 * Report and Translate under a message (JOURNEY-055).
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { MessageActions } from './MessageActions';

const fetchMock = vi.fn();
const MESSAGE_ID = '01MSG00000000000000000000A';

const bodyOf = (init: unknown): unknown => {
  const body = (init as RequestInit | undefined)?.body;
  return JSON.parse(typeof body === 'string' ? body : '{}');
};

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MessageActions', () => {
  it('reports a message with the reason and note chosen, to the buyer route', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ report: { id: 'r1', status: 'OPEN', createdAt: '2026-10-02T00:00:00.000Z' } }, 201)),
    );
    renderWithProviders(<MessageActions threadKind="RFQ" messageId={MESSAGE_ID} audience="buyer" />);

    await userEvent.click(screen.getByRole('button', { name: 'Report' }));
    await userEvent.selectOptions(screen.getByLabelText('What is wrong with it?'), 'FRAUD');
    await userEvent.type(screen.getByLabelText(/Anything we should know/), 'Asked me to pay by wire');
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/account/messages/reports'));
      expect(bodyOf(call?.[1])).toEqual({
        threadKind: 'RFQ',
        messageId: MESSAGE_ID,
        reason: 'FRAUD',
        note: 'Asked me to pay by wire',
      });
    });
    expect(await screen.findByText(/Our moderators will review it/)).toBeInTheDocument();
  });

  it('sends a seller report to the seller route', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ report: { id: 'r1', status: 'OPEN', createdAt: '2026-10-02T00:00:00.000Z' } }, 201)),
    );
    renderWithProviders(<MessageActions threadKind="ORDER" messageId={MESSAGE_ID} audience="seller" />);
    await userEvent.click(screen.getByRole('button', { name: 'Report' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/seller/messages/reports'))).toBe(true);
    });
  });

  it('offers no Translate while message translation is switched off', () => {
    renderWithProviders(<MessageActions threadKind="ORDER" messageId={MESSAGE_ID} audience="buyer" />);
    expect(screen.queryByRole('button', { name: 'Translate' })).not.toBeInTheDocument();
  });

  it('translates into the reader’s language and goes back to the original', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ text: 'We can ship in October.', detectedLanguage: 'de', language: 'en' })),
    );
    renderWithProviders(<MessageActions threadKind="ORDER" messageId={MESSAGE_ID} audience="buyer" />, {
      config: { ...FALLBACK_CONFIG, features: { ...FALLBACK_CONFIG.features, messageTranslation: true } },
    });

    await userEvent.click(screen.getByRole('button', { name: 'Translate' }));
    expect(await screen.findByText('We can ship in October.')).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/account/messages/translate'));
    expect(bodyOf(call?.[1])).toEqual({ threadKind: 'ORDER', messageId: MESSAGE_ID, language: 'en' });

    await userEvent.click(screen.getByRole('button', { name: 'Show original' }));
    expect(screen.queryByText('We can ship in October.')).not.toBeInTheDocument();
  });
});
