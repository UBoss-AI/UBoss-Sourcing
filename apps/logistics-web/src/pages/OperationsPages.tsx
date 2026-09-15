/**
 * The operations desk: collections, dispatch, exceptions.
 *
 * Three screens in one file because they are one working day and because they
 * share the same shape — a filtered list of work items, each with the one or
 * two actions a person standing at a loading bay actually takes. Splitting
 * them would mean three copies of the same empty state, the same error state
 * and the same "mark it done" mutation wiring.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
  Textarea,
} from '@/components/ui';
import { useToast } from '@/components/toast-context';
import { useI18n } from '@/i18n/i18n-context';
import { formatDateTime, formatRelative } from '@/lib/format';
import {
  completePickup,
  confirmPickupReady,
  exceptionsKey,
  failPickup,
  fetchExceptions,
  fetchManifests,
  fetchPickups,
  handOverManifest,
  manifestsKey,
  pickupsKey,
  updateException,
} from '@/lib/logistics';
import { Permission } from '@/lib/permissions';
import { useFocusOnMount } from '@/lib/use-focus-on-mount';
import { useSession } from '@/auth/session-context';
import { severityTone } from '@/lib/shipment-display';
import type { ExceptionSeverity, ExceptionState } from '@/lib/types';

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export function PickupsPage(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { canAny } = useSession();

  const [openOnly, setOpenOnly] = useState(true);

  const filters = openOnly
    ? { state: ['REQUESTED', 'SCHEDULED', 'CONFIRMED'] }
    : ({} as { state?: string[] });

  const pickups = useQuery({
    queryKey: pickupsKey(filters),
    queryFn: () => fetchPickups(filters),
  });

  function invalidate(): void {
    void queryClient.invalidateQueries({ queryKey: ['logistics', 'pickups'] });
  }

  const confirm = useMutation({
    mutationFn: (id: string) => confirmPickupReady(id),
    onSuccess: invalidate,
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const complete = useMutation({
    /*
     * A fresh key per press, so a retry of THIS press is one collection and a
     * second deliberate press is a second call the server can refuse on its
     * own state. The server is idempotent either way; this is what makes a
     * flaky connection safe rather than what makes it correct.
     */
    mutationFn: (id: string) => completePickup(id, undefined, crypto.randomUUID()),
    onSuccess: () => {
      toast.success(t('common.saved'));
      invalidate();
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const canWrite = canAny(Permission.PICKUP_WRITE);

  return (
    <>
      <PageHeader
        title={t('pickups.heading')}
        actions={
          <Button
            variant="ghost"
            onClick={() => {
              setOpenOnly((value) => !value);
            }}
          >
            {openOnly ? t('common.none') : t('exceptions.openOnly')}
          </Button>
        }
      />

      <Card>
        {pickups.isLoading ? (
          <LoadingState />
        ) : pickups.isError ? (
          <ErrorState
            error={pickups.error}
            onRetry={() => {
              void pickups.refetch();
            }}
          />
        ) : (pickups.data?.pickups.length ?? 0) === 0 ? (
          <EmptyState title={t('pickups.emptyTitle')} description={t('pickups.emptyBody')} />
        ) : (
          <ul className="divide-y divide-border">
            {pickups.data?.pickups.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                    {entry.warehouseName ?? '—'}
                    <Badge tone={entry.state === 'FAILED' ? 'danger' : 'neutral'}>
                      {entry.state}
                    </Badge>
                  </p>

                  <p className="mt-1 text-xs text-ink-muted">
                    <time dateTime={entry.windowStartAt}>
                      {formatDateTime(entry.windowStartAt)}
                    </time>
                    {' – '}
                    <time dateTime={entry.windowEndAt}>{formatDateTime(entry.windowEndAt)}</time>
                    {/*
                      The window's own timezone, beside it. "Collect between
                      14:00 and 16:00" means the clock on the wall of the
                      building the van drives to.
                    */}
                    {entry.timezone === null ? '' : ` · ${entry.timezone}`}
                  </p>

                  {entry.shipmentId === null ? null : (
                    <Link
                      to={`/shipments/${entry.shipmentId}`}
                      className="mt-1 inline-block text-xs text-brand hover:underline"
                    >
                      {entry.shipmentReference}
                    </Link>
                  )}

                  {entry.warehouseInstructions === null ? null : (
                    <p className="mt-2 rounded bg-surface-sunken px-2 py-1 text-xs text-ink-muted">
                      {entry.warehouseInstructions}
                    </p>
                  )}

                  {entry.failureReason === null ? null : (
                    <p className="mt-2 rounded bg-danger-soft px-2 py-1 text-xs text-danger">
                      {entry.failureReason}
                    </p>
                  )}
                </div>

                {canWrite && entry.state !== 'COMPLETED' && entry.state !== 'CANCELLED' ? (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {entry.readinessConfirmedAt === null ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={confirm.isPending}
                        onClick={() => {
                          confirm.mutate(entry.id);
                        }}
                      >
                        {t('pickups.confirmReady')}
                      </Button>
                    ) : null}

                    <Button
                      size="sm"
                      disabled={complete.isPending}
                      onClick={() => {
                        complete.mutate(entry.id);
                      }}
                    >
                      {t('pickups.complete')}
                    </Button>

                    <FailPickupButton pickupId={entry.id} onDone={invalidate} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/**
 * "Could not collect", with the reason it demands.
 *
 * The reason is mandatory on the server too. A failed collection with no
 * reason is one nobody can prevent happening again, and it counts against the
 * carrier's own record.
 */
function FailPickupButton({
  pickupId,
  onDone,
}: {
  pickupId: string;
  onDone: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const focusReason = useFocusOnMount();

  const fail = useMutation({
    mutationFn: () => failPickup(pickupId, reason),
    onSuccess: () => {
      setOpen(false);
      setReason('');
      onDone();
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setOpen(true);
        }}
      >
        {t('pickups.fail')}
      </Button>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <Field label={t('pickups.failReason')}>
        {({ inputId, describedBy }) => (
          <Input
            ref={focusReason}
            id={inputId}
            aria-describedby={describedBy}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        )}
      </Field>
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant="danger"
          disabled={reason.trim().length < 4 || fail.isPending}
          onClick={() => {
            fail.mutate();
          }}
        >
          {t('pickups.fail')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(false);
          }}
        >
          {t('modal.cancel')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function DispatchPage(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { canAny } = useSession();

  const manifests = useQuery({ queryKey: manifestsKey, queryFn: fetchManifests });
  const [signing, setSigning] = useState<string | null>(null);
  const [signedBy, setSignedBy] = useState('');
  const focusSignedBy = useFocusOnMount();

  const handover = useMutation({
    mutationFn: (id: string) => handOverManifest(id, signedBy),
    onSuccess: () => {
      toast.success(t('common.saved'));
      setSigning(null);
      setSignedBy('');
      void queryClient.invalidateQueries({ queryKey: manifestsKey });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  return (
    <>
      <PageHeader title={t('dispatch.heading')} />

      <Card>
        {manifests.isLoading ? (
          <LoadingState />
        ) : manifests.isError ? (
          <ErrorState
            error={manifests.error}
            onRetry={() => {
              void manifests.refetch();
            }}
          />
        ) : (manifests.data?.manifests.length ?? 0) === 0 ? (
          <EmptyState title={t('dispatch.emptyTitle')} description={t('dispatch.emptyBody')} />
        ) : (
          <ul className="divide-y divide-border">
            {manifests.data?.manifests.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="flex items-center gap-2 text-sm font-medium text-ink">
                    {entry.manifestNumber}
                    <Badge tone={entry.state === 'HANDED_OVER' ? 'success' : 'neutral'}>
                      {entry.state}
                    </Badge>
                  </p>
                  <p className="mt-1 text-xs text-ink-muted">
                    {entry.shipmentCount} · <span className="tabular">{entry.packageCount}</span>
                    {entry.driverName === null ? '' : ` · ${entry.driverName}`}
                    {entry.vehicleRegistration === null ? '' : ` · ${entry.vehicleRegistration}`}
                  </p>
                  {entry.plannedDepartureAt === null ? null : (
                    <p className="mt-0.5 text-xs text-ink-subtle">
                      {formatDateTime(entry.plannedDepartureAt)}
                    </p>
                  )}
                </div>

                {canAny(Permission.DISPATCH_WRITE) && entry.state !== 'HANDED_OVER' ? (
                  signing === entry.id ? (
                    <div className="w-full max-w-sm">
                      <Field label={t('dispatch.signedBy')}>
                        {({ inputId, describedBy }) => (
                          <Input
                            ref={focusSignedBy}
                            id={inputId}
                            aria-describedby={describedBy}
                            value={signedBy}
                            onChange={(event) => {
                              setSignedBy(event.target.value);
                            }}
                          />
                        )}
                      </Field>
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          disabled={signedBy.trim().length < 2 || handover.isPending}
                          onClick={() => {
                            handover.mutate(entry.id);
                          }}
                        >
                          {t('dispatch.handover')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setSigning(null);
                          }}
                        >
                          {t('modal.cancel')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setSigning(entry.id);
                      }}
                    >
                      {t('dispatch.handover')}
                    </Button>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

export function ExceptionsPage(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { canAny } = useSession();

  const [openOnly, setOpenOnly] = useState(true);
  const [severity, setSeverity] = useState<ExceptionSeverity | ''>('');

  const filters = {
    openOnly,
    ...(severity === '' ? {} : { severity: [severity] }),
  };

  const exceptions = useQuery({
    queryKey: exceptionsKey(filters),
    queryFn: () => fetchExceptions(filters),
  });

  const update = useMutation({
    mutationFn: ({
      id,
      changes,
    }: {
      id: string;
      changes: { state?: ExceptionState; resolutionNotes?: string };
    }) => updateException(id, changes),
    onSuccess: () => {
      toast.success(t('common.saved'));
      void queryClient.invalidateQueries({ queryKey: ['logistics', 'exceptions'] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  return (
    <>
      <PageHeader
        title={t('exceptions.heading')}
        actions={
          <>
            <Select
              value={severity}
              aria-label={t('exceptions.severity')}
              onChange={(event) => {
                setSeverity(event.target.value as ExceptionSeverity | '');
              }}
            >
              <option value="">{t('common.none')}</option>
              {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((entry) => (
                <option key={entry} value={entry}>
                  {t(`severity.${entry}` as never)}
                </option>
              ))}
            </Select>

            <Button
              variant="ghost"
              onClick={() => {
                setOpenOnly((value) => !value);
              }}
            >
              {openOnly ? t('common.none') : t('exceptions.openOnly')}
            </Button>
          </>
        }
      />

      <Card>
        {exceptions.isLoading ? (
          <LoadingState />
        ) : exceptions.isError ? (
          <ErrorState
            error={exceptions.error}
            onRetry={() => {
              void exceptions.refetch();
            }}
          />
        ) : (exceptions.data?.rows.length ?? 0) === 0 ? (
          <EmptyState title={t('exceptions.emptyTitle')} description={t('exceptions.emptyBody')} />
        ) : (
          <ul className="divide-y divide-border">
            {exceptions.data?.rows.map((entry) => (
              <li key={entry.id} className="py-4 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={severityTone(entry.severity)} dot>
                    {t(`severity.${entry.severity}` as never)}
                  </Badge>
                  <Badge tone="neutral">{t(`exceptionType.${entry.type}` as never)}</Badge>
                  <Link
                    to={`/shipments/${entry.shipmentId}`}
                    className="text-sm font-medium text-brand hover:underline"
                  >
                    {entry.shipmentReference}
                  </Link>
                  <span className="text-xs text-ink-subtle">{entry.receivingCompanyName}</span>
                </div>

                <p className="mt-2 text-sm text-ink">{entry.reason}</p>

                <p className="mt-1 text-xxs text-ink-subtle">
                  {formatRelative(entry.createdAt)}
                  {entry.resolutionDueAt === null
                    ? ''
                    : ` · ${t('exceptions.due')} ${formatDateTime(entry.resolutionDueAt)}`}
                  {entry.ownerName === null ? '' : ` · ${entry.ownerName}`}
                </p>

                {canAny(Permission.SHIPMENT_EXCEPTION_WRITE) && entry.closedAt === null ? (
                  <ResolveException
                    onResolve={(notes) => {
                      update.mutate({
                        id: entry.id,
                        changes: { state: 'RESOLVED', resolutionNotes: notes },
                      });
                    }}
                    pending={update.isPending}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/**
 * Closing one out, with the note the server demands.
 *
 * An exception closed with no explanation is one that gets raised again next
 * week by somebody who cannot see what was done about it.
 */
function ResolveException({
  onResolve,
  pending,
}: {
  onResolve: (notes: string) => void;
  pending: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const focusNotes = useFocusOnMount();

  if (!open) {
    return (
      <Button
        className="mt-3"
        size="sm"
        variant="secondary"
        onClick={() => {
          setOpen(true);
        }}
      >
        {t('exceptions.resolve')}
      </Button>
    );
  }

  return (
    <div className="mt-3 max-w-lg">
      <Field label={t('exceptions.resolutionNotes')}>
        {({ inputId, describedBy }) => (
          <Textarea
            ref={focusNotes}
            id={inputId}
            aria-describedby={describedBy}
            rows={2}
            value={notes}
            onChange={(event) => {
              setNotes(event.target.value);
            }}
          />
        )}
      </Field>

      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          disabled={notes.trim().length < 4 || pending}
          onClick={() => {
            onResolve(notes.trim());
            setOpen(false);
            setNotes('');
          }}
        >
          {t('exceptions.resolve')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(false);
          }}
        >
          {t('modal.cancel')}
        </Button>
      </div>
    </div>
  );
}
