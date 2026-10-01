/**
 * Risk review (checklist SEC-008): the queue shows each signal with its rule
 * and severity, a reviewer decides one with a reason, placeholder thresholds
 * are called out, and only a rule writer sees the edit buttons.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { RiskReviewPage, type RiskRule, type RiskSignal } from './RiskReviewPage';

const fetchMock = vi.fn();

// jsdom has no <dialog> modal API; the Modal component needs one.
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

const SIGNAL: RiskSignal = {
  id: '01JRISKSIGNAL0000000000001',
  ruleCode: 'DUPLICATE_SELLER_IDENTIFIER',
  severity: 'HIGH',
  subjectType: 'SELLER_IDENTIFIER',
  subjectId: 'abcdef0123456789',
  observed: 2,
  threshold: 2,
  facts: { identifier: 'TAX_REGISTRATION', value: '****F1Z5' },
  status: 'OPEN',
  reviewReason: null,
  reviewedAt: null,
  detectedAt: '2026-10-01T10:00:00.000Z',
};

const RULE: RiskRule = {
  code: 'LOGIN_FAILURES', enabled: true, severity: 'MEDIUM', threshold: 5, windowMinutes: 15,
  thresholdMinor: null, currency: null, approvedForProduction: false, version: 1,
};

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderPage(permissions: string[]): void {
  const session = {
    user: { id: 'u1', email: 'reviewer@example.test' },
    isLoading: false,
    can: (permission: string) => permissions.includes(permission),
    canAny: (...wanted: string[]) => wanted.some((permission) => permissions.includes(permission)),
  } as unknown as SessionState;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SessionContext.Provider value={session}>
            <MemoryRouter>
              <RiskReviewPage />
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Promise.resolve(json(null, 204));
    return Promise.resolve(json(url.includes('/rules') ? { rules: [RULE] } : { signals: [SIGNAL] }));
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RiskReviewPage', () => {
  it('lists signals, flags placeholder thresholds and records a decision with a reason', async () => {
    renderPage(['risk.read', 'risk.review']);
    expect((await screen.findAllByText('Sellers sharing a tax or company number')).length).toBeGreaterThan(0);
    expect(screen.getByText('Thresholds not yet approved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Decide' }));
    const save = await screen.findByRole('button', { name: 'Save decision' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason (required, at least 5 characters)'), {
      target: { value: 'Same group company, registry checked.' },
    });
    fireEvent.change(screen.getByLabelText('Decision'), { target: { value: 'FALSE_POSITIVE' } });
    fireEvent.click(save);
    await waitFor(() => {
      const post = (fetchMock.mock.calls as [string, RequestInit | undefined][]).find(([, init]) => init?.method === 'POST');
      expect(post?.[0]).toContain(`/admin/risk/signals/${SIGNAL.id}/decision`);
      expect(JSON.parse(post?.[1]?.body as string)).toEqual({ decision: 'FALSE_POSITIVE', reason: 'Same group company, registry checked.' });
    });
  });

  it('offers rule editing only to a rule writer, and hides decisions from a reader', async () => {
    renderPage(['risk.read', 'risk.rule.write']);
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Decide' })).toBeNull();
  });
});
