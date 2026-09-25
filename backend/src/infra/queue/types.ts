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
  /// Retry occurrences whose earlier attempt failed BEFORE any money moved.
  ///
  /// Separate from SCHEDULE_RUN because the two ask different questions:
  /// SCHEDULE_RUN looks for plans that are due, this looks for cycles that
  /// were due, tried, and did not get there. A plan can be perfectly
  /// up-to-date and still have a failed cycle waiting for another go.
  SCHEDULE_OCCURRENCE_RETRY: 'schedule.occurrence_retry',
  /// Close out occurrences whose 3-D Secure window has passed.
  ///
  /// Without it an ACTION_REQUIRED cycle would wait for ever, and eventually
  /// charge for a delivery the customer had stopped expecting at a price
  /// quoted weeks earlier.
  SCHEDULE_ACTION_EXPIRE: 'schedule.action_expire',
  /// Build the SCHEDULED rows customers skip and re-date.
  ///
  /// The engine does this as it advances each plan, so this is the safety net
  /// for plans that were paused across the horizon, or whose materialisation
  /// failed. A pass with nothing to do costs one indexed query.
  SCHEDULE_MATERIALISE: 'schedule.materialise',
  /// Retry an order the ERP has not accepted yet.
  ///
  /// The exit from PAID-ERP-PENDING, and the most important retry in the
  /// system: every row it touches is an order the customer has already paid
  /// for. Runs under the occurrence's original idempotency key, so it can
  /// never produce a second ERP order or a second charge.
  ERP_ORDER_RETRY: 'erp_order.retry',
  /// Ask the configured ERP for stock, where it has no outbound webhooks -
  /// which is most of them.
  ///
  /// Each connection carries its own `nextPollAt`, so a pass with nothing due
  /// costs one indexed query. Separate from INTEGRATION_SYNC, which is the
  /// catalogue connector: the two read different tables and must not share a
  /// retry budget.
  ERP_INVENTORY_POLL: 'erp.inventory_poll',
  /// Retry an order the ERP has not accepted yet.
  ///
  /// The exit from Paid - ERP Pending, and the most important retry in this
  /// feature: every row it touches is an order somebody has already paid for.
  /// Runs under the original idempotency key, so it can never produce a second
  /// ERP order or a second charge.
  ERP_PUSH_RETRY: 'erp.push_retry',
  /// Retry any other integration operation whose failure looked transient.
  ///
  /// Reads `integration_events` rather than a specific business table, so a
  /// new kind of operation is retried without a new job type.
  INTEGRATION_EVENT_RETRY: 'integration_event.retry',
  PAYMENT_RECONCILE: 'payment.reconcile',
  PAYMENT_LINK_EXPIRE: 'payment_link.expire',
  /// Bulk preorders whose waiting party ran out of time, and paid preorders
  /// close to their committed date that are not ready.
  PREORDER_EXPIRE: 'preorder.expire',
  PREORDER_RISK_SWEEP: 'preorder.risk_sweep',
  /// The preorder chat's minute: email customers about replies they have not
  /// read, raise the SLA alert for customers left waiting, expire proposals,
  /// and apply the operator's retention period to closed conversations.
  PREORDER_CHAT_SWEEP: 'preorder_chat.sweep',
  REFUND_POLL: 'refund.poll',
  IMPORT_PROCESS: 'import.process',
  EXPORT_GENERATE: 'export.generate',
  INTEGRATION_SYNC: 'integration.sync',
  RESERVATION_SWEEP: 'reservation.sweep',
  /// Clear out delivery offers nobody accepted. On the same maintenance beat
  /// as the reservation sweep, and for a related reason: a quote holds a
  /// stock figure and a price, and a lapsed one is dead weight that can never
  /// be accepted. One attached to an order is kept for ever.
  FULFILMENT_QUOTE_SWEEP: 'fulfilment_quote.sweep',
  LOW_STOCK_CHECK: 'low_stock.check',
  FX_RATE_REFRESH: 'fx_rate.refresh',
  /// Build an Art. 15/20 export bundle, or carry out an approved Art. 17
  /// erasure. A job rather than a request handler because both read or rewrite
  /// most of the database for one person.
  DATA_REQUEST_FULFIL: 'data_request.fulfil',
  /// Delete personal data that has outlived its retention window. Runs on the
  /// maintenance beat, like the reservation sweep.
  RETENTION_SWEEP: 'retention.sweep',
  /// Delete operational rows that have outlived their usefulness - finished
  /// jobs, spent rate-limit counters, expired sessions and idempotency claims,
  /// old provider webhooks.
  ///
  /// Deliberately NOT part of RETENTION_SWEEP, which answers to a regulator.
  /// This one answers to a disk: nothing it removes is somebody's personal
  /// data held under a lawful basis, and mixing the two would make each
  /// harder to reason about. See `infra/housekeeping.ts`.
  HOUSEKEEPING_SWEEP: 'housekeeping.sweep',
  /// Send what is queued for BUYERS' own ERPs.
  ///
  /// The outbox sweep for `customer_erp_sync_events`. Kept apart from every
  /// ERP_* job above, which serve the operator's own warehouse system: these
  /// call systems that customers run, several of them rate-limited, and the
  /// two must not share a retry budget or a failure. Each event carries its
  /// own `nextRetryAt`, so a pass with nothing due is one indexed query.
  CUSTOMER_ERP_DISPATCH: 'customer_erp.dispatch',
  /// Ask a buyer's ERP for stock, where it has no webhooks - which is most of
  /// them. Each connection holds its own interval and next-due time.
  CUSTOMER_ERP_POLL: 'customer_erp.poll',
  /// Housekeeping: release events whose worker died, expire approvals nobody
  /// decided, and sweep abandoned OAuth flows. One job rather than three,
  /// because all three are cheap indexed deletes on the same beat.
  CUSTOMER_ERP_MAINTENANCE: 'customer_erp.maintenance',

  /// The logistics portal's heartbeat.
  ///
  /// Four cheap indexed passes on one beat, because all four are about a
  /// consignment that has stopped moving and none of them is worth its own
  /// tick:
  ///
  ///   - Assignment offers nobody answered. Without this an unanswered offer
  ///     sits ACCEPTANCE_PENDING for ever and the consignment is in nobody's
  ///     queue - which looks assigned on the operator's screen and appears in
  ///     no carrier's work.
  ///   - The SLA column every dashboard counter reads. The list and the detail
  ///     page recompute live; this is what lets a COUNT not be a table scan.
  ///   - Trips a driver started and never ended, and position pings past the
  ///     retention window. A trip that stays ACTIVE is a device that keeps
  ///     being allowed to report where somebody is.
  ///   - Carrier webhook events that could not be applied, retried with
  ///     backoff and dead-lettered at the ceiling.
  ///
  /// A pass with nothing to do is four indexed queries that match no rows.
  LOGISTICS_MAINTENANCE: 'logistics.maintenance',

  /// Keep every SELLER's own accounting connection honest.
  ///
  /// A THIRD ERP beat, and it shares nothing with the two above. `ERP_*` is
  /// the operator's warehouse system and `CUSTOMER_ERP_*` is a buyer's
  /// purchasing system; this is a seller's TallyPrime, which runs on a PC in
  /// their office that is switched off at six o'clock. A seller's machine
  /// being asleep must not slow the operator's warehouse sync or a buyer's
  /// order feed, which is why it has its own job and its own retry budget.
  ///
  /// Three cheap indexed passes on one beat, because all three are about a
  /// bridge that has stopped answering and none is worth its own tick:
  ///
  ///   - Tasks whose bridge died mid-post. Without this they sit IN_FLIGHT for
  ///     ever and the seller's books silently stop being updated.
  ///   - Connections whose heartbeat has stopped. Nothing writes a row when a
  ///     heartbeat fails to ARRIVE, so a connection would otherwise keep
  ///     reading "Connected" over a machine somebody switched off an hour ago.
  ///   - Pairing codes nobody used. A code is a credential for its whole life,
  ///     and one left outstanding is one somebody can still redeem.
  ///
  /// A pass with nothing to do is three indexed queries that match no rows.
  SELLER_ERP_MAINTENANCE: 'seller_erp.maintenance',

  /// Build the payloads for events queued without one, and tell a seller when
  /// their accounting connection has gone quiet.
  ///
  /// Separate from the maintenance beat because it does real work: a backfill
  /// enqueues five hundred order events with only a reference in them, and the
  /// payload for each has to be assembled from the order. Doing that inside
  /// the request that started the backfill would hold a connection open for a
  /// minute.
  SELLER_ERP_DISPATCH: 'seller_erp.dispatch',

  /// Compare what we think posted against what Tally says it holds.
  ///
  /// The safety net behind the three duplicate guards, and the thing that
  /// finds the one failure they cannot: a voucher Tally committed and whose
  /// acknowledgement never reached us. Runs rarely, reads rather than writes,
  /// and raises a notification rather than silently correcting anything - a
  /// reconciliation that repaired accounts on its own would be a second thing
  /// writing to somebody's books without being asked.
  SELLER_ERP_RECONCILE: 'seller_erp.reconcile',
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
