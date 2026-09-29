/**
 * Finance -> Fee rules (checklist SCREEN-068).
 *
 *   - the rules are listed with what each one does and where it stands;
 *   - staff who may only read see no buttons;
 *   - the maker-checker: the person who submitted a rule cannot approve it (the
 *     button is disabled and says why), a different person can;
 *   - a draft is submitted, a submitted rule can be sent back only with a reason;
 *   - a published rule is replaced, never edited: Replace drafts a rule that
 *     supersedes it;
 *   - creating a rule sends money as whole minor units.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import type { FeeRuleView } from '@/lib/fee-rules';
import { FeeRulesPage } from './FeeRulesPage';

vi.mock('@/lib/fee-rules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fee-rules')>();
  return {
    ...actual,
    fetchFeeRules: vi.fn(),
    createFeeRule: vi.fn(),
    updateFeeRule: vi.fn(),
    submitFeeRule: vi.fn(),
    approveFeeRule: vi.fn(),
    rejectFeeRule: vi.fn(),
    retireFeeRule: vi.fn(),
    fetchFeeRuleOrders: vi.fn(),
  };
});

const api = await import('@/lib/fee-rules');
const fetchFeeRules = vi.mocked(api.fetchFeeRules);
const createFeeRule = vi.mocked(api.createFeeRule);
const submitFeeRule = vi.mocked(api.submitFeeRule);
const approveFeeRule = vi.mocked(api.approveFeeRule);
const rejectFeeRule = vi.mocked(api.rejectFeeRule);

// jsdom has no <dialog> methods. The smallest stand-in: toggle `open`.
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

const MAKER = 'user-maker';
const CHECKER = 'user-checker';

function money(minor: string): { minor: string; formatted: string; currency: string } {
  return { minor, formatted: (Number(minor) / 100).toFixed(2), currency: 'INR' };
}

function rule(overrides: Partial<FeeRuleView> = {}): FeeRuleView {
  return {
    id: '01RULE00000000000000000001',
    kind: 'VALUE_BAND',
    scope: 'GLOBAL',
    scopeKey: 'GLOBAL',
    sellerAccountId: null,
    categoryId: null,
    marketCountry: null,
    status: 'DRAFT',
    name: 'Large orders',
    currency: 'INR',
    minValue: money('10000000'),
    maxValue: null,
    volumeThreshold: null,
    volumeWindowDays: null,
    sellerTier: null,
    percentRate: '4',
    discountPercent: null,
    effectiveFrom: '2026-10-01T00:00:00.000Z',
    effectiveTo: null,
    notes: null,
    supersedesRuleId: null,
    createdByUserId: MAKER,
    lastEditedByUserId: MAKER,
    submittedByUserId: null,
    submittedAt: null,
    publishedByUserId: null,
    publishedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    retiredAt: null,
    createdAt: '2026-09-29T00:00:00.000Z',
    settlementCount: 0,
    ...overrides,
  };
}

function renderPage(userId: string, permissions: string[]): void {
  const session = {
    user: { id: userId, email: `${userId}@example.test` },
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
              <FeeRulesPage />
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

const READ = ['finance.policy.read'];
const WRITE = ['finance.policy.read', 'finance.policy.write'];

beforeEach(async () => {
  await i18n.changeLanguage('en');
  fetchFeeRules.mockReset();
  createFeeRule.mockReset();
  submitFeeRule.mockReset();
  approveFeeRule.mockReset();
  rejectFeeRule.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('FeeRulesPage', () => {
  it('lists each rule with what it does and where it stands', async () => {
    fetchFeeRules.mockResolvedValue({
      rules: [
        rule(),
        rule({ id: '01RULE00000000000000000002', kind: 'PROMOTION', name: 'Launch offer', status: 'PUBLISHED', percentRate: null, discountPercent: '25', currency: null, minValue: null, effectiveTo: '2026-12-31T00:00:00.000Z' }),
      ],
    });
    renderPage(CHECKER, READ);

    expect(await screen.findByText('Large orders')).toBeTruthy();
    expect(screen.getByText(/fee 4%/)).toBeTruthy();
    expect(screen.getByText('Launch offer')).toBeTruthy();
    expect(screen.getByText('25% off the fee')).toBeTruthy();
    expect(screen.getAllByText('Draft').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Live').length).toBeGreaterThan(0);
  });

  it('shows staff who may only read no buttons', async () => {
    fetchFeeRules.mockResolvedValue({
      rules: [rule({ status: 'PENDING_APPROVAL', submittedByUserId: MAKER }), rule({ id: 'b'.padEnd(26, '0'), status: 'PUBLISHED', name: 'Live one' })],
    });
    renderPage(CHECKER, READ);

    await screen.findByText('Large orders');
    expect(screen.queryByRole('button', { name: 'New fee rule' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve and publish' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retire' })).toBeNull();
  });

  it('will not let the person who made a rule approve it, and says why', async () => {
    fetchFeeRules.mockResolvedValue({
      rules: [rule({ status: 'PENDING_APPROVAL', submittedByUserId: MAKER })],
    });
    renderPage(MAKER, WRITE);

    const approve = await screen.findByRole('button', { name: 'Approve and publish' });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/A different member of finance staff must approve this/).length).toBeGreaterThan(0);
    fireEvent.click(approve);
    expect(approveFeeRule).not.toHaveBeenCalled();
  });

  it('lets a different person approve it, after confirming', async () => {
    fetchFeeRules.mockResolvedValue({
      rules: [rule({ status: 'PENDING_APPROVAL', submittedByUserId: MAKER })],
    });
    approveFeeRule.mockResolvedValue({ rule: rule({ status: 'PUBLISHED' }) });
    renderPage(CHECKER, WRITE);

    fireEvent.click(await screen.findByRole('button', { name: 'Approve and publish' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and publish' }));

    await waitFor(() => {
      expect(approveFeeRule).toHaveBeenCalledWith('01RULE00000000000000000001');
    });
  });

  it('submits a draft for approval', async () => {
    fetchFeeRules.mockResolvedValue({ rules: [rule()] });
    submitFeeRule.mockResolvedValue({ rule: rule({ status: 'PENDING_APPROVAL' }) });
    renderPage(MAKER, WRITE);

    fireEvent.click(await screen.findByRole('button', { name: 'Submit for approval' }));
    await waitFor(() => {
      expect(submitFeeRule).toHaveBeenCalledWith('01RULE00000000000000000001');
    });
  });

  it('sends a submitted rule back only with a reason of ten characters', async () => {
    fetchFeeRules.mockResolvedValue({
      rules: [rule({ status: 'PENDING_APPROVAL', submittedByUserId: MAKER })],
    });
    rejectFeeRule.mockResolvedValue({ rule: rule() });
    renderPage(CHECKER, WRITE);

    fireEvent.click(await screen.findByRole('button', { name: 'Send back' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Send back' });
    expect(confirm.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'too short' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'The band overlaps the existing one.' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(rejectFeeRule).toHaveBeenCalledWith('01RULE00000000000000000001', 'The band overlaps the existing one.');
    });
  });

  it('drafts a replacement for a published rule instead of editing it', async () => {
    fetchFeeRules.mockResolvedValue({ rules: [rule({ status: 'PUBLISHED' })] });
    createFeeRule.mockResolvedValue({ rule: rule() });
    renderPage(CHECKER, WRITE);

    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Replace' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));

    await waitFor(() => {
      expect(createFeeRule).toHaveBeenCalled();
    });
    expect(createFeeRule.mock.calls[0]?.[0]).toMatchObject({
      kind: 'VALUE_BAND',
      scope: 'GLOBAL',
      supersedesRuleId: '01RULE00000000000000000001',
    });
  });

  it('creates a rule with money as whole minor units', async () => {
    fetchFeeRules.mockResolvedValue({ rules: [] });
    createFeeRule.mockResolvedValue({ rule: rule() });
    renderPage(MAKER, WRITE);

    fireEvent.click(await screen.findByRole('button', { name: 'New fee rule' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Big orders' } });
    fireEvent.change(within(dialog).getByLabelText('Order value from'), { target: { value: '1000' } });
    fireEvent.change(within(dialog).getByLabelText('Fee (%)'), { target: { value: '3.5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));

    await waitFor(() => {
      expect(createFeeRule).toHaveBeenCalled();
    });
    expect(createFeeRule.mock.calls[0]?.[0]).toMatchObject({
      kind: 'VALUE_BAND',
      scope: 'GLOBAL',
      name: 'Big orders',
      currency: 'INR',
      minValueMinor: '100000',
      maxValueMinor: null,
      percentRate: '3.5',
    });
  });

  it('refuses an amount with too many decimals before sending anything', async () => {
    fetchFeeRules.mockResolvedValue({ rules: [] });
    renderPage(MAKER, WRITE);

    fireEvent.click(await screen.findByRole('button', { name: 'New fee rule' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Big orders' } });
    fireEvent.change(within(dialog).getByLabelText('Order value from'), { target: { value: '10.005' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));

    expect(await screen.findByText(/An amount is not valid for this currency/)).toBeTruthy();
    expect(createFeeRule).not.toHaveBeenCalled();
  });
});
