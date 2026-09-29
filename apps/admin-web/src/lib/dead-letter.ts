/**
 * The dead-letter queues: background jobs and emails that stopped after their
 * last attempt. Read with settings.read, retried with settings.write.
 *
 * The API never sends a job payload or an email body, and masks the
 * recipient; these types say only what it does send.
 */
import { api } from './api';

const BASE = '/admin/operations';

export type DeadLetterKind = 'jobs' | 'notifications';

export interface DeadJob {
  id: string;
  jobType: string;
  queue: string;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  failedAt: string | null;
}

export interface FailedNotification {
  id: string;
  eventKey: string;
  channel: string;
  /** Masked: first letter and domain only. */
  recipient: string | null;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  relatedType: string | null;
  relatedId: string | null;
  createdAt: string;
  lastAttemptAt: string;
  /** False for a message to an erased person, which can never be delivered. */
  retryable: boolean;
}

export const deadLetterKeys = {
  all: ['dead-letter'] as const,
  list: (kind: DeadLetterKind) => ['dead-letter', kind] as const,
};

export const deadLetterApi = {
  deadJobs: () => api.get<{ jobs: DeadJob[]; total: number }>(`${BASE}/dead-jobs`, { query: { pageSize: 100 } }),
  failedNotifications: () =>
    api.get<{ notifications: FailedNotification[]; total: number }>(`${BASE}/failed-notifications`, {
      query: { pageSize: 100 },
    }),
  retryJob: (id: string) => api.post<{ retried: true }>(`${BASE}/dead-jobs/${id}/retry`),
  retryNotification: (id: string) =>
    api.post<{ retried: true }>(`${BASE}/failed-notifications/${id}/retry`),
};
