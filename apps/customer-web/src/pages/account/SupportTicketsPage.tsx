/**
 * Your support requests, and one of them with its thread.
 *
 * The sender's side only: their first message, the team's replies, the status
 * moves, and a box to write again while the request is open. Staff are "the
 * team" here, never a name - the server never sends one, and this page would
 * have nowhere to put it anyway. Everything is rendered as text: a message
 * that contains markup shows the characters somebody typed.
 *
 * Shared by the account (`/account/support`) and Seller Hub
 * (`/seller/support/requests`); the surface decides which requests are listed.
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  PageHeader,
  Textarea,
  type BadgeTone,
} from '@/components/ui';
import { ArrowLeftIcon, DocumentIcon, PaperclipIcon } from '@/components/icons';
import { SupportFilePicker, type PickedFile } from '@/components/support/SupportFilePicker';
import { newIdempotencyKey } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import {
  SUPPORT_TICKETS_PATH,
  addSupportMessage,
  fetchSupportContext,
  formatBytes,
  openSupportAttachment,
  uploadSupportAttachment,
  fetchSupportTicket,
  fetchSupportTickets,
  type SupportStatus,
  type SupportSurface,
  type SupportTicket,
} from '@/lib/support';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';

const STATUS_TONE: Record<SupportStatus, BadgeTone> = {
  OPEN: 'brand',
  IN_PROGRESS: 'operational',
  WAITING_FOR_CUSTOMER: 'warning',
  RESOLVED: 'success',
  CLOSED: 'neutral',
};

const NEW_REQUEST_PATH: Record<SupportSurface, string> = {
  storefront: '/support',
  seller: '/seller/support',
};

export function SupportStatusBadge({ status }: { status: SupportStatus }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Badge tone={STATUS_TONE[status]}>{t(`support.status.${status}` as TranslationKey)}</Badge>
  );
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export function SupportTicketsView({ surface }: { surface: SupportSurface }): React.JSX.Element {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['support-tickets', surface, page],
    queryFn: () => fetchSupportTickets(surface, page),
  });

  const newRequest = (
    <ButtonLink variant="primary" to={NEW_REQUEST_PATH[surface]}>
      {t('support.list.new')}
    </ButtonLink>
  );

  return (
    <div>
      <PageHeader
        title={t('support.list.title')}
        description={t('support.list.description')}
        actions={newRequest}
      />
      {list.isPending ? (
        <LoadingState label={t('support.loading')} />
      ) : list.isError ? (
        <ErrorState
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      ) : list.data.tickets.length === 0 ? (
        <EmptyState
          title={t('support.list.emptyTitle')}
          description={t('support.list.emptyBody')}
        />
      ) : (
        <>
          <ul className="divide-y divide-border-subtle overflow-hidden rounded-lg border border-border bg-surface">
            {list.data.tickets.map((ticket) => (
              <li key={ticket.reference}>
                <Link
                  to={`${SUPPORT_TICKETS_PATH[surface]}/${ticket.reference}`}
                  className="flex flex-col gap-1 px-4 py-3 hover:bg-surface-hover sm:flex-row sm:items-center sm:gap-4"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-ink">{ticket.subject}</span>
                    <span className="block text-xs text-ink-muted">
                      <span className="font-mono">{ticket.reference}</span>
                      {' · '}
                      {t(`support.category.${ticket.category}` as TranslationKey)}
                      {' · '}
                      {t('support.list.updated', { when: formatDateTime(ticket.lastActivityAt) })}
                    </span>
                  </span>
                  <SupportStatusBadge status={ticket.status} />
                </Link>
              </li>
            ))}
          </ul>
          {list.data.pagination.totalPages > 1 && (
            <nav
              aria-label={t('support.list.pages')}
              className="mt-4 flex items-center justify-between"
            >
              <Button
                size="sm"
                disabled={page <= 1}
                onClick={() => {
                  setPage((current) => current - 1);
                }}
              >
                {t('support.list.previous')}
              </Button>
              <span className="text-xs text-ink-muted">
                {t('support.list.pageOf', {
                  page: String(page),
                  pages: String(list.data.pagination.totalPages),
                })}
              </span>
              <Button
                size="sm"
                disabled={page >= list.data.pagination.totalPages}
                onClick={() => {
                  setPage((current) => current + 1);
                }}
              >
                {t('support.list.next')}
              </Button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------

function Reply({
  surface,
  ticket,
}: {
  surface: SupportSurface;
  ticket: SupportTicket;
}): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey());

  const send = useMutation({
    mutationFn: () => addSupportMessage(surface, ticket.reference, body, key.current),
    onMutate: () => {
      setProblem(null);
    },
    onSuccess: (result) => {
      key.current = newIdempotencyKey();
      setBody('');
      queryClient.setQueryData(['support-ticket', surface, ticket.reference], result);
      void queryClient.invalidateQueries({ queryKey: ['support-tickets', surface] });
    },
    onError: (error) => {
      // What was typed stays in the box; the same key is reused on retry.
      setProblem(errorMessage(t, error, t('support.form.error.generic')));
    },
  });

  return (
    <form
      className="mt-6 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (body.trim().length === 0) {
          setProblem(t('support.detail.replyRequired'));
          return;
        }
        send.mutate();
      }}
    >
      <Field label={t('support.detail.replyLabel')} error={problem ?? undefined}>
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            invalid={problem !== null}
            name="reply"
            rows={4}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
            }}
          />
        )}
      </Field>
      <div>
        <Button
          type="submit"
          variant="primary"
          isLoading={send.isPending}
          className="min-w-[10rem]"
        >
          {send.isPending ? t('support.form.sending') : t('support.detail.send')}
        </Button>
      </div>
    </form>
  );
}

function Files({
  surface,
  ticket,
}: {
  surface: SupportSurface;
  ticket: SupportTicket;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const context = useQuery({
    queryKey: ['support-context', surface],
    queryFn: () => fetchSupportContext(surface),
    staleTime: 60_000,
  });
  const rules = context.data?.attachments;

  const upload = useMutation({
    mutationFn: async () => {
      const failed: string[] = [];
      for (const item of picked) {
        try {
          await uploadSupportAttachment(surface, ticket.reference, item.file);
        } catch (error) {
          failed.push(
            t('support.files.notAttached', {
              name: item.file.name,
              reason: errorMessage(t, error, t('support.files.failed')),
            }),
          );
        }
      }
      return failed;
    },
    onSuccess: (failed) => {
      setPicked([]);
      setProblem(failed.length === 0 ? null : failed.join(' '));
      void queryClient.invalidateQueries({
        queryKey: ['support-ticket', surface, ticket.reference],
      });
    },
  });

  const open = useMutation({
    mutationFn: (attachmentId: string) =>
      openSupportAttachment(surface, ticket.reference, attachmentId),
    onError: (error) => {
      setProblem(errorMessage(t, error, t('support.files.failed')));
    },
  });

  const canAdd = ticket.canReply && rules?.available === true;
  if (ticket.attachments.length === 0 && !canAdd) return null;

  return (
    <section className="mt-6 space-y-3" aria-labelledby="support-files-heading">
      <h2
        id="support-files-heading"
        className="flex items-center gap-2 text-sm font-semibold text-ink"
      >
        <PaperclipIcon className="h-4 w-4" />
        {t('support.files.heading')}
      </h2>
      {ticket.attachments.length > 0 && (
        <ul className="divide-y divide-border-subtle rounded-lg border border-border bg-surface">
          {ticket.attachments.map((file) => (
            <li key={file.id} className="flex items-center gap-3 px-4 py-2 text-sm">
              <DocumentIcon className="h-4 w-4 shrink-0 text-ink-subtle" />
              <span className="min-w-0 flex-1 truncate text-ink">{file.fileName}</span>
              <span className="shrink-0 text-xs text-ink-muted">
                {t(`support.files.kind.${file.kind}` as TranslationKey)} ·{' '}
                {formatBytes(file.byteSize)}
              </span>
              <Button
                size="sm"
                disabled={open.isPending}
                onClick={() => {
                  open.mutate(file.id);
                }}
              >
                {t('support.files.open')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {canAdd && (
        <div className="space-y-2">
          <SupportFilePicker
            files={picked}
            onChange={setPicked}
            rules={rules}
            alreadyAttached={ticket.attachments.length}
            disabled={upload.isPending}
          />
          {picked.length > 0 && (
            <Button
              variant="primary"
              isLoading={upload.isPending}
              onClick={() => {
                upload.mutate();
              }}
            >
              {t('support.files.upload')}
            </Button>
          )}
        </div>
      )}
      {problem !== null && (
        <p role="alert" className="text-sm text-danger">
          {problem}
        </p>
      )}
    </section>
  );
}

export function SupportTicketDetailView({
  surface,
}: {
  surface: SupportSurface;
}): React.JSX.Element {
  const { t } = useI18n();
  const { reference = '' } = useParams();
  const query = useQuery({
    queryKey: ['support-ticket', surface, reference],
    queryFn: () => fetchSupportTicket(surface, reference),
  });

  const back = (
    <Link
      to={SUPPORT_TICKETS_PATH[surface]}
      className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:underline"
    >
      <ArrowLeftIcon className="h-4 w-4" />
      {t('support.detail.back')}
    </Link>
  );

  if (query.isPending) return <LoadingState label={t('support.loading')} />;
  if (query.isError) {
    return (
      <div>
        {back}
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

  return (
    <div>
      {back}
      <PageHeader
        title={ticket.subject}
        description={`${ticket.reference} · ${t(`support.category.${ticket.category}` as TranslationKey)}`}
        actions={<SupportStatusBadge status={ticket.status} />}
      />

      {ticket.relatedOrderNumber !== null && (
        <p className="mb-4 text-sm text-ink-muted">
          {t('support.detail.order', { order: ticket.relatedOrderNumber })}
        </p>
      )}

      <ol className="flex flex-col gap-3" aria-label={t('support.detail.thread')}>
        <li className="rounded-lg border border-border bg-surface px-4 py-3">
          <p className="text-xs font-medium text-ink-muted">
            {t('support.detail.you')} · {formatDateTime(ticket.createdAt)}
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{ticket.message}</p>
        </li>
        {ticket.thread.map((entry) =>
          entry.kind === 'STATUS_CHANGED' ? (
            <li key={entry.id} className="px-4 text-xs text-ink-muted">
              {t('support.detail.statusChanged', {
                status: t(`support.status.${entry.status ?? 'OPEN'}` as TranslationKey),
                when: formatDateTime(entry.createdAt),
              })}
            </li>
          ) : (
            <li
              key={entry.id}
              className={
                entry.author === 'TEAM'
                  ? 'rounded-lg border border-brand/30 bg-brand-soft px-4 py-3'
                  : 'rounded-lg border border-border bg-surface px-4 py-3'
              }
            >
              <p className="text-xs font-medium text-ink-muted">
                {entry.author === 'TEAM' ? t('support.detail.team') : t('support.detail.you')} ·{' '}
                {formatDateTime(entry.createdAt)}
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{entry.body}</p>
            </li>
          ),
        )}
      </ol>

      <Files surface={surface} ticket={ticket} />

      {ticket.canReply ? (
        <Reply surface={surface} ticket={ticket} />
      ) : (
        <p className="mt-6 rounded-lg bg-surface-sunken px-4 py-3 text-sm text-ink-muted">
          {t('support.detail.closed')}
        </p>
      )}
    </div>
  );
}

export function SupportTicketsPage(): React.JSX.Element {
  return <SupportTicketsView surface="storefront" />;
}

export function SupportTicketDetailPage(): React.JSX.Element {
  return <SupportTicketDetailView surface="storefront" />;
}

export function SellerSupportTicketsPage(): React.JSX.Element {
  return <SupportTicketsView surface="seller" />;
}

export function SellerSupportTicketDetailPage(): React.JSX.Element {
  return <SupportTicketDetailView surface="seller" />;
}
