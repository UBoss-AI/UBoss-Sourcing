/**
 * Operations → dead background jobs and undeliverable emails.
 *
 *   - each queue lists what the server sent, and only that - the masked
 *     recipient, never an address the page made up;
 *   - retrying asks first, then sends exactly one request;
 *   - a message to an erased person offers no retry at all;
 *   - somebody who may only read settings gets no retry controls;
 *   - a 409 (somebody else got there first) says so in words.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { ApiError } from '@/lib/api';
import type { DeadJob, FailedNotification } from '@/lib/dead-letter';
import { DeadJobsPage, FailedNotificationsPage } from './DeadLetterPage';

vi.mock('@/lib/dead-letter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dead-letter')>();
  return {
    ...actual,
    deadLetterApi: {
      deadJobs: vi.fn(),
      failedNotifications: vi.fn(),
      retryJob: vi.fn(),
      retryNotification: vi.fn(),
    },
  };
});

const { deadLetterApi } = await import('@/lib/dead-letter');
const deadJobs = vi.mocked(deadLetterApi.deadJobs);
const failedNotifications = vi.mocked(deadLetterApi.failedNotifications);
const retryJob = vi.mocked(deadLetterApi.retryJob);
const retryNotification = vi.mocked(deadLetterApi.retryNotification);

// jsdom has no <dialog> methods; the Modal only needs `open` toggled.
const dialogProto = HTMLDialogElement.prototype as HTMLDialogElement & {
  showModal?: () => void;
  close?: () => void;
};
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

const JOB: DeadJob = {
  id: '01DEADJOB00000000000000000',
  jobType: 'export.generate',
  queue: 'default',
  attemptCount: 5,
  maxAttempts: 5,
  lastError: 'connect ETIMEDOUT',
  createdAt: '2026-09-28T10:00:00.000Z',
  failedAt: '2026-09-28T11:00:00.000Z',
};

function email(overrides: Partial<FailedNotification> = {}): FailedNotification {
  return {
    id: '01DEADMAIL0000000000000000',
    eventKey: 'payment.link',
    channel: 'EMAIL',
    recipient: 'j•••••@hospital.example',
    attemptCount: 5,
    maxAttempts: 5,
    lastError: '550 mailbox unavailable',
    relatedType: 'order',
    relatedId: null,
    createdAt: '2026-09-28T10:00:00.000Z',
    lastAttemptAt: '2026-09-28T11:00:00.000Z',
    retryable: true,
    ...overrides,
  };
}

const WRITE = ['settings.read', 'settings.write'];

function renderAt(path: string, permissions: string[] = WRITE): void {
  const session = {
    user: { id: 'u1', email: 'owner@example.test' },
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
    can: (permission: string) => permissions.includes(permission),
    canAny: (...wanted: string[]) => wanted.some((permission) => permissions.includes(permission)),
  } as unknown as SessionState;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SessionContext.Provider value={session}>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path="/operations/dead-jobs" element={<DeadJobsPage />} />
                <Route path="/operations/failed-notifications" element={<FailedNotificationsPage />} />
              </Routes>
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('dead background jobs', () => {
  it('lists a dead job with its attempts and last error', async () => {
    deadJobs.mockResolvedValue({ jobs: [JOB], total: 1 });
    renderAt('/operations/dead-jobs');

    expect(await screen.findByText('export.generate')).toBeTruthy();
    expect(screen.getByText('5 of 5')).toBeTruthy();
    expect(screen.getByText('connect ETIMEDOUT')).toBeTruthy();
  });

  it('asks before retrying, then sends one request', async () => {
    deadJobs.mockResolvedValue({ jobs: [JOB], total: 1 });
    retryJob.mockResolvedValue({ retried: true });
    renderAt('/operations/dead-jobs');

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/attempts already made are kept/)).toBeTruthy();
    expect(retryJob).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(retryJob).toHaveBeenCalledTimes(1);
    });
    expect(retryJob).toHaveBeenCalledWith(JOB.id);
  });

  it('says so in words when somebody else already retried it', async () => {
    deadJobs.mockResolvedValue({ jobs: [JOB], total: 1 });
    retryJob.mockRejectedValue(new ApiError(409, { code: 'CONFLICT', message: 'This job is no longer waiting to be retried.' }));
    renderAt('/operations/dead-jobs');

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText(/can no longer be retried/)).toBeTruthy();
  });

  it('offers no retry to somebody who may only read settings', async () => {
    deadJobs.mockResolvedValue({ jobs: [JOB], total: 1 });
    renderAt('/operations/dead-jobs', ['settings.read']);

    expect(await screen.findByText('export.generate')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('says the queue is empty rather than showing an empty table', async () => {
    deadJobs.mockResolvedValue({ jobs: [], total: 0 });
    renderAt('/operations/dead-jobs');

    expect(await screen.findByText('No dead background jobs')).toBeTruthy();
  });
});

describe('undeliverable emails', () => {
  it('shows the recipient masked, as the server sent it', async () => {
    failedNotifications.mockResolvedValue({ notifications: [email()], total: 1 });
    renderAt('/operations/failed-notifications');

    expect(await screen.findByText('payment.link')).toBeTruthy();
    expect(screen.getByText('j•••••@hospital.example')).toBeTruthy();
  });

  it('retries one email after asking', async () => {
    failedNotifications.mockResolvedValue({ notifications: [email()], total: 1 });
    retryNotification.mockResolvedValue({ retried: true });
    renderAt('/operations/failed-notifications');

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(retryNotification).toHaveBeenCalledTimes(1);
    });
  });

  it('offers no retry for a message to an erased person', async () => {
    failedNotifications.mockResolvedValue({
      notifications: [email({ recipient: 'e•••••@erased.invalid', retryable: false })],
      total: 1,
    });
    renderAt('/operations/failed-notifications');

    expect(await screen.findByText(/Recipient erased/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
