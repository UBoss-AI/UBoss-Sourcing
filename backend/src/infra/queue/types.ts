/**
 * Job queue contract.
 *
 * The interface exists so the deployment is not forced to run Redis. XAMPP
 * ships no Redis, and at this system's volume a MariaDB-backed queue is a
 * legitimate production choice, not a stub - it inherits the same transactional
 * guarantees as the business data it reacts to.
 *
 * Switching to `QUEUE_DRIVER=redis` swaps the implementation with no change to
 * any caller.
 */

/** Every job type the system enqueues. A closed union, so a typo fails to compile. */
export const JobType = {
  NOTIFICATION_SEND: 'notification.send',
  SCHEDULE_RUN: 'schedule.run',
  SCHEDULE_REMINDER: 'schedule.reminder',
  PAYMENT_RECONCILE: 'payment.reconcile',
  PAYMENT_LINK_EXPIRE: 'payment_link.expire',
  REFUND_POLL: 'refund.poll',
  IMPORT_PROCESS: 'import.process',
  EXPORT_GENERATE: 'export.generate',
  INTEGRATION_SYNC: 'integration.sync',
  RESERVATION_SWEEP: 'reservation.sweep',
  LOW_STOCK_CHECK: 'low_stock.check',
} as const;

export type JobTypeValue = (typeof JobType)[keyof typeof JobType];

export interface EnqueueOptions {
  /** Delay before the job becomes eligible. Default: immediately. */
  runAt?: Date;
  /** Higher runs first among due jobs. Default 0. */
  priority?: number;
  maxAttempts?: number;
  /**
   * Application-level dedupe. A second enqueue with the same key is dropped,
   * which is how "reconcile this order" stays one job however many times the
   * webhook is retried.
   */
  dedupeKey?: string;
  queue?: string;
  /** Carried into the job's logger so a whole causal chain shares one id. */
  correlationId?: string;
}

export interface ClaimedJob {
  id: string;
  jobType: string;
  queue: string;
  payload: unknown;
  attemptCount: number;
  maxAttempts: number;
  correlationId: string | null;
}

export interface QueueHealth {
  ok: boolean;
  latencyMs: number;
  error?: string;
  /** Pending job count, when the driver can report it cheaply. */
  depth?: number;
}

export interface JobQueueDriver {
  readonly name: string;

  /**
   * Enqueue a job.
   *
   * `tx` is significant: notification and side-effect jobs are enqueued inside
   * the same transaction as the business write that caused them (transactional
   * outbox). That is what stops a committed order from losing its confirmation
   * email, and stops a rolled-back transaction from sending one anyway.
   */
  enqueue(
    jobType: JobTypeValue,
    payload: unknown,
    options?: EnqueueOptions,
    tx?: unknown,
  ): Promise<string | null>;

  /** Claim up to `limit` due jobs for exclusive processing for `leaseSeconds`. */
  claim(limit: number, leaseSeconds: number, owner: string): Promise<ClaimedJob[]>;

  complete(jobId: string): Promise<void>;

  /**
   * Record a failure. The driver decides whether to schedule a retry or mark
   * the job dead, based on attemptCount against maxAttempts.
   */
  fail(jobId: string, error: string, retryDelaySeconds?: number): Promise<void>;

  /** Return jobs whose lease expired (a worker crashed mid-job) to PENDING. */
  reapExpiredLeases(): Promise<number>;

  health(): Promise<QueueHealth>;

  shutdown(): Promise<void>;
}
