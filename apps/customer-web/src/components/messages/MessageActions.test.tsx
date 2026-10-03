/**
 * Report and Translate under a message (JOURNEY-055).
 */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { MessageActions } from './MessageActions';
import { i18n } from '@/i18n/config';

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

afterEach(async () => {
  await i18n.changeLanguage('en');
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

describe('translation preservation and recovery', () => {
  const config = { ...FALLBACK_CONFIG, features: { ...FALLBACK_CONFIG.features, messageTranslation: true } };
  it('keeps original words during a refused translation and recovers by explicit retry', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'MESSAGE_TRANSLATION_UNAVAILABLE', message: 'Unavailable' } }, 409)).mockResolvedValueOnce(jsonResponse({ text: 'Translated reply', detectedLanguage: 'de', language: 'en' }));
    renderWithProviders(<><p>Original private words</p><MessageActions threadKind="ORDER" messageId={MESSAGE_ID} audience="buyer" /></>, { config }); await userEvent.click(screen.getByRole('button', { name: 'Translate' })); expect(await screen.findByRole('alert')).toBeInTheDocument(); expect(screen.getByText('Original private words')).toBeInTheDocument(); await userEvent.click(screen.getByRole('button', { name: 'Translate' })); expect(await screen.findByText('Translated reply')).toBeInTheDocument(); expect(screen.getByText('Original private words')).toBeInTheDocument(); await userEvent.click(screen.getByRole('button', { name: 'Show original' })); expect(screen.queryByText('Translated reply')).not.toBeInTheDocument(); expect(screen.getByText('Original private words')).toBeInTheDocument();
  });
  it('requests a fresh translation when the reader switches language instead of reusing the old one', async () => {
    fetchMock.mockImplementation((_url, init) => { const body = bodyOf(init) as { language: string }; return Promise.resolve(jsonResponse({ text: body.language === 'en' ? 'English reply' : 'Polish reply', detectedLanguage: 'de', language: body.language })); });
    renderWithProviders(<MessageActions threadKind="RFQ" messageId={MESSAGE_ID} audience="seller" />, { config }); await userEvent.click(screen.getByRole('button', { name: 'Translate' })); expect(await screen.findByText('English reply')).toBeInTheDocument(); await act(async () => { await i18n.changeLanguage('pl'); }); expect(screen.queryByText('English reply')).not.toBeInTheDocument(); await userEvent.click(screen.getByRole('button', { name: i18n.t('messages.translate.action') })); expect(await screen.findByText('Polish reply')).toBeInTheDocument(); expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toMatchObject({ language: 'pl' }); expect(fetchMock.mock.calls.every(([url]) => String(url).includes('/seller/messages/translate'))).toBe(true);
  });
});
