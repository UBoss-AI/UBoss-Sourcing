/**
 * Support -> Tickets: the inbox, and one ticket.
 *
 * The inbox opens on what still needs work (OPEN, IN_PROGRESS and WAITING)
 * with the counts per status above it, and filters by status, priority,
 * topic, where it came from and who has it, plus a search over the reference,
 * subject, sender, company and order number.
 *
 * A ticket shows who raised it and for whom, the related order (a link only
 * for somebody who may read orders), and one timeline of everything that
 * happened. Internal notes, priority and assignment are marked as staff-only
 * on the timeline because that is exactly what they are: the sender never
 * sees them. Everything written is rendered as text.
 *
 * What each control needs:
 *   - reading: `support_ticket.view`;
 *   - replying, notes, status, priority, taking a ticket: `support_ticket.reply`;
 *   - giving it to a colleague or taking it off them: `support_ticket.assign`.
 * The server checks all of it again; this only avoids offering a refused move.
 */
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pager } from '@/components/DataTable';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Card,
  DescriptionList,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
  Textarea,
  Toolbar,
  ToolbarField,
  type BadgeTone,
} from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import {
  STAFF_TRANSITIONS,
  SUPPORT_CATEGORIES,
  SUPPORT_PRIORITIES,
  SUPPORT_RESOLUTION_CODES,
  SUPPORT_SOURCES,
  SUPPORT_STATUSES,
  addInternalNote,
  assignTicket,
  fetchAssignees,
  fetchTicket,
  fetchTickets,
  replyToTicket,
  updateTicket,
  type AdminTicket,
  type AdminTicketEvent,
  type SupportPriority,
  type SupportResolutionCode,
  type SupportSla,
  type SupportStatus,
} from '@/lib/support-tickets';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { TicketDocuments } from './TicketDocuments';

const PAGE_SIZE = 25;

const STATUS_TONE: Record<SupportStatus, BadgeTone> = {
  OPEN: 'brand',
  IN_PROGRESS: 'operational',
  WAITING_FOR_CUSTOMER: 'warning',
  RESOLVED: 'success',
  CLOSED: 'neutral',
};

const PRIORITY_TONE: Record<SupportPriority, BadgeTone> = {
  LOW: 'neutral',
  NORMAL: 'neutral',
  HIGH: 'warning',
  URGENT: 'danger',
};

function key(prefix: string, value: string): TranslationKey {
  return `${prefix}.${value}` as TranslationKey;
}

/**
 * Where a ticket stands against its two promises: a first reply and an
 * answer. Late is the server's word (`sla.*Breached`), not this screen's guess
 * from the clock. A promise already kept and not late says nothing.
 */
function SlaLines({ sla, status }: { sla: SupportSla | undefined; status: SupportStatus }): React.JSX.Element {
  const { t } = useI18n();
  if (sla === undefined) return <span className="text-xs text-ink-muted">—</span>;

  const finished = status === 'RESOLVED' || status === 'CLOSED';
  const waitingForReply = sla.firstRespondedAt === null && sla.firstResponseDueAt !== null;
  const waitingForAnswer = !finished && sla.resolutionDueAt !== null;

  if (!waitingForReply && !waitingForAnswer && !sla.firstResponseBreached && !sla.resolutionBreached) {
    return <span className="text-xs text-ink-muted">—</span>;
  }

  return (
    <div className="space-y-1 text-xs">
      {waitingForReply && sla.firstResponseDueAt !== null && (
        <p className="flex flex-wrap items-center gap-1 text-ink-muted">
          <span>
            {t('supportTickets.sla.firstReplyDue', { when: formatDateTime(sla.firstResponseDueAt) })}
          </span>
          {sla.firstResponseBreached && <Badge tone="danger">{t('supportTickets.sla.late')}</Badge>}
        </p>
      )}
      {waitingForAnswer && sla.resolutionDueAt !== null && (
        <p className="flex flex-wrap items-center gap-1 text-ink-muted">
          <span>
            {t('supportTickets.sla.resolutionDue', { when: formatDateTime(sla.resolutionDueAt) })}
          </span>
          {sla.resolutionBreached && <Badge tone="danger">{t('supportTickets.sla.late')}</Badge>}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------

export function SupportTicketsPage(): React.JSX.Element {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [searchDraft, setSearchDraft] = useState(params.get('search') ?? '');
  const page = Math.max(1, Number(params.get('page') ?? '1'));
  // Nothing chosen means "what still needs work", not everything ever raised.
  const status = params.get('status') ?? 'WORKING';

  const query = useQuery({
    queryKey: ['admin', 'support-tickets', params.toString()],
    queryFn: () => {
      const next = new URLSearchParams(params);
      next.set('page', String(page));
      next.set('limit', String(PAGE_SIZE));
      if (status === 'ALL') next.delete('status');
      else next.set('status', status);
      return fetchTickets(next);
    },
  });

  const update = (name: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value.length === 0) next.delete(name);
    else next.set(name, value);
    if (name !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const tickets = query.data?.tickets ?? [];
  const counts = query.data?.counts ?? {};

  return (
    <div className="space-y-5">
      <PageHeader title={t('supportTickets.title')} description={t('supportTickets.description')} />

      <ul className="flex flex-wrap gap-2" aria-label={t('supportTickets.countsLabel')}>
        {SUPPORT_STATUSES.map((value) => (
          <li key={value}>
            <button
              type="button"
              aria-pressed={status === value}
              onClick={() => {
                update('status', value);
              }}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-surface-hover aria-pressed:border-accent aria-pressed:bg-accent-soft"
            >
              {t(key('supportTickets.status', value))}
              <span className="rounded-full bg-surface-sunken px-1.5 text-ink-muted">
                {counts[value] ?? 0}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <Toolbar>
        <ToolbarField label={t('supportTickets.filter.search')} grow>
          <Input
            type="search"
            value={searchDraft}
            placeholder={t('supportTickets.filter.searchPlaceholder')}
            onChange={(event) => {
              setSearchDraft(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') update('search', searchDraft.trim());
            }}
            onBlur={() => {
              update('search', searchDraft.trim());
            }}
          />
        </ToolbarField>
        <ToolbarField label={t('supportTickets.filter.status')}>
          <Select
            value={status}
            onChange={(event) => {
              update('status', event.currentTarget.value);
            }}
          >
            <option value="WORKING">{t('supportTickets.filter.working')}</option>
            <option value="ALL">{t('supportTickets.filter.all')}</option>
            {SUPPORT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(key('supportTickets.status', value))}
              </option>
            ))}
          </Select>
        </ToolbarField>
        <ToolbarField label={t('supportTickets.filter.priority')}>
          <Select
            value={params.get('priority') ?? ''}
            onChange={(event) => {
              update('priority', event.currentTarget.value);
            }}
          >
            <option value="">{t('supportTickets.filter.any')}</option>
            {SUPPORT_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {t(key('supportTickets.priority', value))}
              </option>
            ))}
          </Select>
        </ToolbarField>
        <ToolbarField label={t('supportTickets.filter.category')}>
          <Select
            value={params.get('category') ?? ''}
            onChange={(event) => {
              update('category', event.currentTarget.value);
            }}
          >
            <option value="">{t('supportTickets.filter.any')}</option>
            {SUPPORT_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {t(key('supportTickets.category', value))}
              </option>
            ))}
          </Select>
        </ToolbarField>
        <ToolbarField label={t('supportTickets.filter.source')}>
          <Select
            value={params.get('source') ?? ''}
            onChange={(event) => {
              update('source', event.currentTarget.value);
            }}
          >
            <option value="">{t('supportTickets.filter.any')}</option>
            {SUPPORT_SOURCES.map((value) => (
              <option key={value} value={value}>
                {t(key('supportTickets.source', value))}
              </option>
            ))}
          </Select>
        </ToolbarField>
        <ToolbarField label={t('supportTickets.filter.sla')}>
          <Select
            value={params.get('breached') ?? ''}
            onChange={(event) => {
              update('breached', event.currentTarget.value);
            }}
          >
            <option value="">{t('supportTickets.filter.any')}</option>
            <option value="true">{t('supportTickets.filter.lateOnly')}</option>
          </Select>
        </ToolbarField>
        <ToolbarField label={t('supportTickets.filter.assignee')}>
          <Select
            value={params.get('assignee') ?? ''}
            onChange={(event) => {
              update('assignee', event.currentTarget.value);
            }}
          >
            <option value="">{t('supportTickets.filter.anyone')}</option>
            <option value="me">{t('supportTickets.filter.me')}</option>
            <option value="unassigned">{t('supportTickets.filter.unassigned')}</option>
          </Select>
        </ToolbarField>
      </Toolbar>

      {query.isPending && <LoadingState label={t('supportTickets.loading')} />}
      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}
      {query.isSuccess && tickets.length === 0 && (
        <EmptyState
          title={t('supportTickets.emptyTitle')}
          description={t('supportTickets.emptyBody')}
        />
      )}

      {tickets.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[46rem] text-left text-sm">
            <thead className="border-b border-border-subtle text-xs text-ink-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  {t('supportTickets.column.ticket')}
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  {t('supportTickets.column.from')}
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  {t('supportTickets.column.status')}
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  {t('supportTickets.column.due')}
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  {t('supportTickets.column.assignee')}
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  {t('supportTickets.column.updated')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {tickets.map((ticket) => (
                <tr key={ticket.id} className="align-top hover:bg-surface-hover">
                  <td className="px-4 py-3">
                    <Link
                      to={`/support/${ticket.id}`}
                      className="font-medium text-accent hover:underline"
                    >
                      {ticket.subject}
                    </Link>
                    <p className="text-xs text-ink-muted">
                      <span className="font-mono">{ticket.reference}</span> ·{' '}
                      {t(key('supportTickets.category', ticket.category))}
                      {ticket.relatedOrderNumber !== null && ` · ${ticket.relatedOrderNumber}`}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-ink">{ticket.requesterName}</p>
                    <p className="text-xs text-ink-muted">
                      {t(key('supportTickets.role', ticket.requesterRole))}
                      {ticket.companyName !== null && ` · ${ticket.companyName}`}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={STATUS_TONE[ticket.status]}>
                        {t(key('supportTickets.status', ticket.status))}
                      </Badge>
                      {ticket.priority !== 'NORMAL' && (
                        <Badge tone={PRIORITY_TONE[ticket.priority]}>
                          {t(key('supportTickets.priority', ticket.priority))}
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <SlaLines sla={ticket.sla} status={ticket.status} />
                  </td>
                  <td className="px-4 py-3 text-xs text-ink-muted">
                    {ticket.assignee?.email ?? t('supportTickets.unassigned')}
                  </td>
                  <td className="px-4 py-3 text-xs text-ink-muted">
                    {formatDateTime(ticket.lastActivityAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {query.data !== undefined && (
        <Pager
          page={query.data.pagination.page}
          limit={query.data.pagination.limit}
          total={query.data.pagination.total}
          totalPages={query.data.pagination.totalPages}
          onPageChange={(next) => {
            update('page', String(next));
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One ticket
// ---------------------------------------------------------------------------

function EventLine({ event }: { event: AdminTicketEvent }): React.JSX.Element {
  const { t } = useI18n();
  const who = event.actorIsRequester
    ? t('supportTickets.event.requester')
    : (event.actor?.email ?? t('supportTickets.event.formerStaff'));
  const when = formatDateTime(event.createdAt);
  const staffOnly = !event.visibleToRequester;

  if (event.body !== null) {
    const tone =
      event.kind === 'INTERNAL_NOTE'
        ? 'border-warning/40 bg-warning-soft'
        : event.kind === 'STAFF_REPLY'
          ? 'border-accent/30 bg-accent-soft'
          : 'border-border bg-surface';
    return (
      <li className={`rounded-lg border px-4 py-3 ${tone}`}>
        <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-ink-muted">
          <span>{t(key('supportTickets.eventKind', event.kind))}</span>
          <span>·</span>
          <span>{who}</span>
          <span>·</span>
          <span>{when}</span>
          {staffOnly && <Badge tone="warning">{t('supportTickets.staffOnly')}</Badge>}
        </p>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{event.body}</p>
      </li>
    );
  }

  const change =
    event.kind === 'STATUS_CHANGED'
      ? t('supportTickets.event.status', {
          to: t(key('supportTickets.status', event.toValue ?? 'OPEN')),
        })
      : event.kind === 'PRIORITY_CHANGED'
        ? t('supportTickets.event.priority', {
            to: t(key('supportTickets.priority', event.toValue ?? 'NORMAL')),
          })
        : event.kind === 'ASSIGNED'
          ? event.toValue === null
            ? t('supportTickets.event.unassigned')
            : t('supportTickets.event.assigned')
          : t('supportTickets.event.created');

  return (
    <li className="flex flex-wrap items-center gap-2 px-4 text-xs text-ink-muted">
      <span>{change}</span>
      <span>·</span>
      <span>{who}</span>
      <span>·</span>
      <span>{when}</span>
      {staffOnly && <Badge tone="neutral">{t('supportTickets.staffOnly')}</Badge>}
    </li>
  );
}

/** One promise on the ticket page: when it is due, when it was kept, whether it is late. */
function SlaLine({
  due,
  doneAt,
  late,
}: {
  due: string | null;
  doneAt: string | null;
  late: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  if (due === null) return <>{t('supportTickets.sla.none')}</>;

  return (
    <span className="flex flex-wrap items-center gap-1">
      <span>{t('supportTickets.sla.due', { when: formatDateTime(due) })}</span>
      {doneAt !== null && (
        <span className="text-xs text-ink-muted">
          {t('supportTickets.sla.doneAt', { when: formatDateTime(doneAt) })}
        </span>
      )}
      {late ? (
        <Badge tone="danger">{t('supportTickets.sla.late')}</Badge>
      ) : (
        <Badge tone="success">{t('supportTickets.sla.onTrack')}</Badge>
      )}
    </span>
  );
}

function Controls({ ticket }: { ticket: AdminTicket }): React.JSX.Element {
  const { t } = useI18n();
  const { can, user } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canReply = can(Permission.SUPPORT_TICKET_REPLY);
  const canAssign = can(Permission.SUPPORT_TICKET_ASSIGN);
  const closed = ticket.status === 'CLOSED';
  // Resolving or closing says how it ended, unless it already carries a code.
  const [code, setCode] = useState<SupportResolutionCode | ''>(ticket.resolutionCode ?? '');
  const [codeMissing, setCodeMissing] = useState(false);

  const assignees = useQuery({
    queryKey: ['admin', 'support-assignees'],
    queryFn: fetchAssignees,
    enabled: canAssign,
    staleTime: 60_000,
  });

  const refresh = (next: AdminTicket): void => {
    queryClient.setQueryData(['admin', 'support-ticket', ticket.id], { ticket: next });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'support-tickets'] });
  };
  const fail = (error: unknown): void => {
    toast.error(errorMessage(t, error, t('supportTickets.couldNotSave')));
  };

  const change = useMutation({
    mutationFn: (input: {
      status?: SupportStatus;
      priority?: SupportPriority;
      resolutionCode?: SupportResolutionCode;
    }) => updateTicket(ticket.id, input),
    onSuccess: (result) => {
      refresh(result.ticket);
      toast.success(t('supportTickets.saved'));
    },
    onError: fail,
  });
  const assign = useMutation({
    mutationFn: (assigneeUserId: string | null) => assignTicket(ticket.id, assigneeUserId),
    onSuccess: (result) => {
      refresh(result.ticket);
      toast.success(t('supportTickets.saved'));
    },
    onError: fail,
  });

  const moves = STAFF_TRANSITIONS[ticket.status];
  const mine = ticket.assignee?.id === user?.id;

  return (
    <Card title={t('supportTickets.detail.manage')} bodyClassName="px-5 py-4">
      <div className="space-y-4">
        {canReply && moves.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-ink-muted">
              {t('supportTickets.detail.moveTo')}
            </p>
            {moves.some((to) => to === 'RESOLVED' || to === 'CLOSED') && (
              <Field
                label={t('supportTickets.detail.resolutionCode')}
                hint={t('supportTickets.detail.resolutionCodeHint')}
                error={codeMissing ? t('supportTickets.detail.codeNeeded') : undefined}
              >
                {({ inputId, describedBy }) => (
                  <Select
                    id={inputId}
                    aria-describedby={describedBy}
                    value={code}
                    onChange={(event) => {
                      setCode(event.currentTarget.value as SupportResolutionCode | '');
                      setCodeMissing(false);
                    }}
                  >
                    <option value="">{t('supportTickets.detail.chooseCode')}</option>
                    {SUPPORT_RESOLUTION_CODES.map((value) => (
                      <option key={value} value={value}>
                        {t(key('supportTickets.resolutionCode', value))}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              {moves.map((to) => (
                <Button
                  key={to}
                  size="sm"
                  variant={to === 'CLOSED' ? 'secondary' : 'primary'}
                  disabled={change.isPending}
                  onClick={() => {
                    const ends = to === 'RESOLVED' || to === 'CLOSED';
                    if (ends && code === '' && ticket.resolutionCode == null) {
                      setCodeMissing(true);
                      return;
                    }
                    change.mutate({
                      status: to,
                      ...(ends && code !== '' ? { resolutionCode: code } : {}),
                    });
                  }}
                >
                  {t(key('supportTickets.status', to))}
                </Button>
              ))}
            </div>
          </div>
        )}

        <Field label={t('supportTickets.detail.priority')}>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={ticket.priority}
              disabled={!canReply || closed || change.isPending}
              onChange={(event) => {
                change.mutate({ priority: event.currentTarget.value as SupportPriority });
              }}
            >
              {SUPPORT_PRIORITIES.map((value) => (
                <option key={value} value={value}>
                  {t(key('supportTickets.priority', value))}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div>
          <p className="mb-2 text-xs font-medium text-ink-muted">
            {t('supportTickets.detail.assignee')}
          </p>
          <p className="mb-2 text-sm text-ink">
            {ticket.assignee?.email ?? t('supportTickets.unassigned')}
          </p>
          <div className="flex flex-wrap gap-2">
            {canReply && !mine && user !== null && (
              <Button
                size="sm"
                disabled={assign.isPending}
                onClick={() => {
                  assign.mutate(user.id);
                }}
              >
                {t('supportTickets.detail.takeIt')}
              </Button>
            )}
            {canReply && mine && (
              <Button
                size="sm"
                variant="ghost"
                disabled={assign.isPending}
                onClick={() => {
                  assign.mutate(null);
                }}
              >
                {t('supportTickets.detail.release')}
              </Button>
            )}
          </div>
          {canAssign && assignees.data !== undefined && (
            <Field label={t('supportTickets.detail.giveTo')}>
              {({ inputId }) => (
                <Select
                  id={inputId}
                  value={ticket.assignee?.id ?? ''}
                  disabled={assign.isPending}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    assign.mutate(value.length === 0 ? null : value);
                  }}
                >
                  <option value="">{t('supportTickets.unassigned')}</option>
                  {assignees.data.assignees.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.email}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>
      </div>
    </Card>
  );
}

function Composer({ ticket }: { ticket: AdminTicket }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [body, setBody] = useState('');
  const [nextStatus, setNextStatus] = useState<SupportStatus | ''>('');
  const [replyCode, setReplyCode] = useState<SupportResolutionCode | ''>('');
  const [problem, setProblem] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: () =>
      mode === 'reply'
        ? replyToTicket(ticket.id, {
            body,
            nextStatus: nextStatus === '' ? null : nextStatus,
            ...(nextStatus === 'RESOLVED' && replyCode !== '' ? { resolutionCode: replyCode } : {}),
          })
        : addInternalNote(ticket.id, body),
    onSuccess: (result) => {
      queryClient.setQueryData(['admin', 'support-ticket', ticket.id], { ticket: result.ticket });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'support-tickets'] });
      setBody('');
      setNextStatus('');
      setReplyCode('');
      setProblem(null);
      if (mode === 'note') toast.success(t('supportTickets.detail.noteSaved'));
      else
        toast.success(
          'emailQueued' in result && result.emailQueued
            ? t('supportTickets.detail.replySent')
            : t('supportTickets.detail.replySavedNoEmail'),
        );
    },
    onError: (error) => {
      // What was typed stays in the box.
      setProblem(errorMessage(t, error, t('supportTickets.couldNotSave')));
    },
  });

  return (
    <Card title={t('supportTickets.detail.write')} bodyClassName="px-5 py-4">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (body.trim().length === 0) {
            setProblem(t('supportTickets.detail.bodyRequired'));
            return;
          }
          if (mode === 'reply' && nextStatus === 'RESOLVED' && replyCode === '' && ticket.resolutionCode == null) {
            setProblem(t('supportTickets.detail.codeNeeded'));
            return;
          }
          if (!send.isPending) send.mutate();
        }}
      >
        <div role="radiogroup" aria-label={t('supportTickets.detail.write')} className="flex gap-2">
          {(['reply', 'note'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              onClick={() => {
                setMode(value);
              }}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-hover aria-checked:border-accent aria-checked:bg-accent-soft"
            >
              {value === 'reply'
                ? t('supportTickets.detail.replyMode')
                : t('supportTickets.detail.noteMode')}
            </button>
          ))}
        </div>
        <p className="text-xs text-ink-muted">
          {mode === 'reply'
            ? t('supportTickets.detail.replyHint')
            : t('supportTickets.detail.noteHint')}
        </p>
        <Field
          label={
            mode === 'reply'
              ? t('supportTickets.detail.replyLabel')
              : t('supportTickets.detail.noteLabel')
          }
          error={problem ?? undefined}
        >
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              rows={5}
              value={body}
              onChange={(event) => {
                setBody(event.currentTarget.value);
              }}
            />
          )}
        </Field>
        {mode === 'reply' && (
          <Field label={t('supportTickets.detail.thenMark')}>
            {({ inputId }) => (
              <Select
                id={inputId}
                value={nextStatus}
                onChange={(event) => {
                  setNextStatus(event.currentTarget.value as SupportStatus | '');
                }}
              >
                <option value="">{t('supportTickets.detail.leaveStatus')}</option>
                <option value="WAITING_FOR_CUSTOMER">
                  {t('supportTickets.status.WAITING_FOR_CUSTOMER')}
                </option>
                <option value="RESOLVED">{t('supportTickets.status.RESOLVED')}</option>
              </Select>
            )}
          </Field>
        )}
        {mode === 'reply' && nextStatus === 'RESOLVED' && ticket.resolutionCode == null && (
          <Field label={t('supportTickets.detail.resolutionCode')}>
            {({ inputId }) => (
              <Select
                id={inputId}
                value={replyCode}
                onChange={(event) => {
                  setReplyCode(event.currentTarget.value as SupportResolutionCode | '');
                }}
              >
                <option value="">{t('supportTickets.detail.chooseCode')}</option>
                {SUPPORT_RESOLUTION_CODES.map((value) => (
                  <option key={value} value={value}>
                    {t(key('supportTickets.resolutionCode', value))}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Button type="submit" variant="primary" isLoading={send.isPending}>
          {mode === 'reply'
            ? t('supportTickets.detail.sendReply')
            : t('supportTickets.detail.saveNote')}
        </Button>
      </form>
    </Card>
  );
}

export function SupportTicketDetailPage(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const { id = '' } = useParams();
  const query = useQuery({
    queryKey: ['admin', 'support-ticket', id],
    queryFn: () => fetchTicket(id),
  });
  const back = { to: '/support', label: t('supportTickets.detail.back') };

  if (query.isPending) return <LoadingState label={t('supportTickets.loading')} />;
  if (query.isError) {
    return (
      <div>
        <PageHeader title={t('supportTickets.title')} back={back} />
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      </div>
    );
  }

  const { ticket } = query.data;
  const r = ticket.requester;
  const actingFor =
    r.buyerCompany !== null ? (
      <Link to={`/buyer-companies/${r.buyerCompany.id}`} className="text-accent hover:underline">
        {r.buyerCompany.legalName ?? r.buyerCompany.applicationReference}
      </Link>
    ) : r.seller !== null ? (
      <Link to={`/sellers/${r.seller.id}`} className="text-accent hover:underline">
        {r.seller.displayName}
      </Link>
    ) : r.logisticsPartner !== null ? (
      <Link
        to={`/logistics/partners/${r.logisticsPartner.id}`}
        className="text-accent hover:underline"
      >
        {r.logisticsPartner.displayName}
      </Link>
    ) : (
      (r.companyName ?? t('supportTickets.detail.themselves'))
    );

  return (
    <div className="space-y-5">
      <PageHeader
        title={ticket.subject}
        description={`${ticket.reference} · ${t(key('supportTickets.category', ticket.category))}`}
        back={back}
        meta={
          <div className="flex flex-wrap gap-1">
            <Badge tone={STATUS_TONE[ticket.status]}>
              {t(key('supportTickets.status', ticket.status))}
            </Badge>
            <Badge tone={PRIORITY_TONE[ticket.priority]}>
              {t(key('supportTickets.priority', ticket.priority))}
            </Badge>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-5">
          <TicketDocuments ticket={ticket} />
          <Card title={t('supportTickets.detail.conversation')} bodyClassName="px-5 py-4">
            <ol className="space-y-3">
              <li className="rounded-lg border border-border bg-surface px-4 py-3">
                <p className="text-xs font-medium text-ink-muted">
                  {r.name} · {formatDateTime(ticket.createdAt)}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">
                  {ticket.message}
                </p>
              </li>
              {ticket.events
                .filter((event) => event.kind !== 'CREATED')
                .map((event) => (
                  <EventLine key={event.id} event={event} />
                ))}
            </ol>
          </Card>
          {ticket.status !== 'CLOSED' && can(Permission.SUPPORT_TICKET_REPLY) && (
            <Composer ticket={ticket} />
          )}
          {ticket.status === 'CLOSED' && (
            <p className="rounded-lg bg-surface-sunken px-4 py-3 text-sm text-ink-muted">
              {t('supportTickets.detail.closed')}
            </p>
          )}
        </div>

        <div className="space-y-5">
          <Card title={t('supportTickets.detail.requester')} bodyClassName="px-5 py-4">
            <DescriptionList
              columns={1}
              items={[
                { label: t('supportTickets.detail.name'), value: r.name },
                {
                  label: t('supportTickets.detail.email'),
                  value: (
                    <>
                      {r.email}
                      {r.currentEmail !== r.email && (
                        <span className="block text-xs text-ink-muted">
                          {t('supportTickets.detail.nowEmail', { email: r.currentEmail })}
                        </span>
                      )}
                    </>
                  ),
                },
                {
                  label: t('supportTickets.detail.role'),
                  value: t(key('supportTickets.role', r.role)),
                },
                { label: t('supportTickets.detail.actingFor'), value: actingFor },
                {
                  label: t('supportTickets.detail.source'),
                  value: t(key('supportTickets.source', ticket.source)),
                },
                {
                  label: t('supportTickets.detail.order'),
                  value:
                    ticket.relatedOrder === null ? (
                      '—'
                    ) : ticket.relatedOrder.id !== null ? (
                      <Link
                        to={`/orders/${ticket.relatedOrder.id}`}
                        className="text-accent hover:underline"
                      >
                        {ticket.relatedOrder.orderNumber}
                      </Link>
                    ) : (
                      ticket.relatedOrder.orderNumber
                    ),
                },
              ]}
            />
          </Card>
          <Card title={t('supportTickets.detail.sla')} bodyClassName="px-5 py-4">
            <DescriptionList
              columns={1}
              items={[
                {
                  label: t('supportTickets.sla.firstReply'),
                  value: (
                    <SlaLine
                      due={ticket.sla?.firstResponseDueAt ?? null}
                      doneAt={ticket.sla?.firstRespondedAt ?? null}
                      late={ticket.sla?.firstResponseBreached ?? false}
                    />
                  ),
                },
                {
                  label: t('supportTickets.sla.resolution'),
                  value: (
                    <SlaLine
                      due={ticket.sla?.resolutionDueAt ?? null}
                      doneAt={ticket.resolvedAt ?? ticket.closedAt}
                      late={ticket.sla?.resolutionBreached ?? false}
                    />
                  ),
                },
                {
                  label: t('supportTickets.detail.resolutionCode'),
                  value:
                    ticket.resolutionCode == null
                      ? '—'
                      : t(key('supportTickets.resolutionCode', ticket.resolutionCode)),
                },
              ]}
            />
          </Card>
          <Controls ticket={ticket} />
        </div>
      </div>
    </div>
  );
}
