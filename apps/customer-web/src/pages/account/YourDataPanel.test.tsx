/**
 * Your data (checklist SEC-007): the correction request (Art. 16) says what is
 * wrong before it can be sent, sends the person's own words, and shows up in
 * the history with its due date.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { YourDataPanel } from './YourDataPanel';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const OPEN = {
  id: '01JDATAREQUEST00000000001',
  type: 'RECTIFICATION',
  status: 'PENDING',
  requestedAt: '2026-10-01T10:00:00.000Z',
  dueAt: '2026-10-31T10:00:00.000Z',
  completedAt: null,
  decisionNote: null,
  downloadToken: null,
  downloadExpiresAt: null,
};

describe('YourDataPanel correction request', () => {
  it('needs a description, sends it, and lists the open request', async () => {
    let requests: unknown[] = [];
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        requests = [OPEN];
        return Promise.resolve(jsonResponse(OPEN, 202));
      }
      return Promise.resolve(jsonResponse({ requests }));
    });
    renderWithProviders(<YourDataPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ask for a correction' }));
    const send = await screen.findByRole('button', { name: 'Send the correction request' });
    expect(send).toBeDisabled();

    fireEvent.change(screen.getByLabelText('What is wrong, and what should it say?'), {
      target: { value: 'My company name should read Acme Traders.' },
    });
    expect(send).toBeEnabled();
    fireEvent.click(send);

    await waitFor(() => {
      const post = (fetchMock.mock.calls as [string, RequestInit | undefined][]).find(([, init]) => init?.method === 'POST');
      expect(post).toBeDefined();
      expect(JSON.parse(post?.[1]?.body as string)).toEqual({
        type: 'RECTIFICATION',
        note: 'My company name should read Acme Traders.',
      });
    });
    expect(await screen.findByRole('button', { name: 'Correction being reviewed' })).toBeDisabled();
    expect(screen.getByText('Correction')).toBeInTheDocument();
  });
});
