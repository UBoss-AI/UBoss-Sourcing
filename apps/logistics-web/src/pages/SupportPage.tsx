/**
 * Support, in the logistics portal.
 *
 * The same approved design as the storefront's Support page - the shared
 * `ContactWithGlobe` frame - as a Raise a Ticket form: the member describes the
 * issue and nothing else. The ticket goes in the company's name and the
 * member's own name (the session decides both), replies go to their sign-in
 * email, and there is no order number, because a
 * carrier's consignments are not orders it may look up by number. Your own
 * requests are listed underneath; `/support/:reference` opens one, which is
 * where the acknowledgement and reply emails link.
 *
 * The contacts are the marketplace's published ones and are simply absent when
 * none are set. Messages are rendered as text, never as HTML.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { z } from 'zod';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
  Textarea,
  type BadgeTone,
} from '@/components/ui';
import { ContactWithGlobe, type ContactChannel } from '@/components/support/ContactWithGlobe';
import { ApiError, NetworkError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import {
  SUPPORT_CATEGORIES,
  addSupportMessage,
  checkSupportFile,
  createSupportTicket,
  fetchSupportContext,
  fetchSupportTicket,
  fetchSupportTickets,
  formatBytes,
  openSupportAttachment,
  uploadSupportAttachment,
  type SupportContext,
  type SupportStatus,
  type SupportTicket,
} from '@/lib/support';
import { useI18n } from '@/i18n/i18n-context';

type T = ReturnType<typeof useI18n>['t'];

const SUPPORT_CODES = new Set([
  'SUPPORT_TICKET_LIMIT_REACHED',
  'SUPPORT_TICKET_CLOSED',
  'SUPPORT_TICKET_TRANSITION_NOT_ALLOWED',
]);

/** A refusal in the reader's language; otherwise the server's own sentence. */
function supportError(t: T, error: unknown): string {
  if (error instanceof ApiError && SUPPORT_CODES.has(error.code)) {
    return t(`errors.support.${error.code}` as never);
  }
  if (error instanceof NetworkError) return t('common.couldNotReachServer');
  return error instanceof Error && error.message.length > 0
    ? error.message
    : t('support.form.error.generic');
}

function newKey(): string {
  return crypto.randomUUID();
}

const STATUS_TONE: Record<SupportStatus, BadgeTone> = {
  OPEN: 'brand',
  IN_PROGRESS: 'operational',
  WAITING_FOR_CUSTOMER: 'warning',
  RESOLVED: 'success',
  CLOSED: 'neutral',
};

function StatusBadge({ status }: { status: SupportStatus }): React.JSX.Element {
  const { t } = useI18n();
  return <Badge tone={STATUS_TONE[status]}>{t(`support.status.${status}` as never)}</Badge>;
}

function MailGlyph({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.6 6.6 8.4 5.9 8.4-5.9" />
    </svg>
  );
}

function PhoneGlyph({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      className={className}
      aria-hidden="true"
    >
      <path d="M6.6 3h2.7l1.5 3.9-2 1.5a10.4 10.4 0 0 0 4.8 4.8l1.5-2L19 12.7v2.7a2 2 0 0 1-2.2 2A14.8 14.8 0 0 1 4.6 5.2 2 2 0 0 1 6.6 3z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

/**
 * Choose photos, videos or PDFs. A real file input behind a real label; type
 * and size are checked here only so nobody waits on an upload that was always
 * going to be refused - the server decides the type again from the bytes.
 */
function FilePicker({
  files,
  onChange,
  rules,
  alreadyAttached = 0,
  disabled = false,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  rules: SupportContext['attachments'];
  alreadyAttached?: number;
  disabled?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const [problems, setProblems] = useState<string[]>([]);
  const room = Math.max(0, rules.maxFiles - alreadyAttached - files.length);

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-ink">
        {t('support.files.label')}
        <span className="mt-1 block text-xs font-normal text-ink-muted">
          {t('support.files.hint', {
            max: formatBytes(rules.maxBytes),
            files: String(rules.maxFiles),
          })}
        </span>
        <input
          type="file"
          multiple
          accept={rules.types.join(',')}
          disabled={disabled || room === 0}
          className="mt-2 block w-full text-sm text-ink-muted file:mr-3 file:rounded-md file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink"
          onChange={(event) => {
            const accepted: File[] = [];
            const refused: string[] = [];
            for (const file of Array.from(event.currentTarget.files ?? [])) {
              const problem = checkSupportFile(file, rules);
              if (accepted.length >= room) {
                refused.push(
                  t('support.files.tooMany', { name: file.name, max: String(rules.maxFiles) }),
                );
              } else if (problem === 'TYPE')
                refused.push(t('support.files.wrongType', { name: file.name }));
              else if (problem === 'SIZE') {
                refused.push(
                  t('support.files.tooLarge', {
                    name: file.name,
                    max: formatBytes(rules.maxBytes),
                  }),
                );
              } else accepted.push(file);
            }
            setProblems(refused);
            onChange([...files, ...accepted]);
            event.currentTarget.value = '';
          }}
        />
      </label>
      {problems.length > 0 && (
        <ul role="alert" className="space-y-1 text-xs font-medium text-danger">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <ul
          className="divide-y divide-border-subtle rounded-md border border-border"
          aria-label={t('support.files.chosen')}
        >
          {files.map((file, index) => (
            <li
              key={`${file.name}-${String(index)}`}
              className="flex items-center gap-3 px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 truncate text-ink">{file.name}</span>
              <span className="shrink-0 text-xs text-ink-muted">{formatBytes(file.size)}</span>
              <button
                type="button"
                disabled={disabled}
                className="rounded px-2 py-1 text-xs font-medium text-ink-muted hover:bg-surface-hover hover:text-ink"
                aria-label={t('support.files.remove', { name: file.name })}
                onClick={() => {
                  setProblems([]);
                  onChange(files.filter((_, other) => other !== index));
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface SentResult {
  ticket: SupportTicket;
  acknowledgementQueued: boolean;
  /** Files that could not be attached, each with why. */
  failed: string[];
  attached: string[];
}

function RequestForm({
  context,
  onSent,
}: {
  context: SupportContext;
  onSent: (result: SentResult) => void;
}): React.JSX.Element {
  const { t, language } = useI18n();
  const { requester, limits } = context;
  const key = useRef(newKey());
  const inFlight = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState<{ index: number; total: number } | null>(null);

  const schema = useMemo(
    () =>
      z.object({
        category: z.enum(SUPPORT_CATEGORIES, { message: t('support.form.error.categoryRequired') }),
        subject: z
          .string()
          .trim()
          .min(limits.subjectMin, t('support.form.error.subjectRequired'))
          .max(limits.subjectMax),
        message: z
          .string()
          .trim()
          .min(
            limits.messageMin,
            t('support.form.error.messageTooShort', { min: String(limits.messageMin) }),
          )
          .max(
            limits.messageMax,
            t('support.form.error.tooLong', { max: String(limits.messageMax) }),
          ),
      }),
    [t, limits],
  );

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<z.input<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { category: '' as never, subject: '', message: '' },
  });

  const send = useMutation({
    mutationFn: (values: z.output<typeof schema>) =>
      createSupportTicket({ ...values, language }, key.current),
    onMutate: () => {
      setProblem(null);
    },
    onSuccess: async (result) => {
      key.current = newKey();
      // The ticket exists; its files follow one at a time.
      const failed: string[] = [];
      const attached: string[] = [];
      for (const [index, file] of files.entries()) {
        setUploading({ index: index + 1, total: files.length });
        try {
          await uploadSupportAttachment(result.ticket.reference, file);
          attached.push(file.name);
        } catch (error) {
          failed.push(
            t('support.files.notAttached', { name: file.name, reason: supportError(t, error) }),
          );
        }
      }
      setUploading(null);
      onSent({ ...result, failed, attached });
    },
    onError: (error) => {
      // Everything typed stays; a retry repeats the same key.
      setProblem(supportError(t, error));
    },
  });

  const busyLabel =
    uploading === null
      ? t('support.form.sending')
      : t('support.files.uploading', {
          index: String(uploading.index),
          total: String(uploading.total),
        });

  return (
    <form
      noValidate
      name="support-request"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (inFlight.current) return;
        inFlight.current = true;
        void handleSubmit((values) => send.mutateAsync(values).catch(() => undefined))(
          event,
        ).finally(() => {
          inFlight.current = false;
        });
      }}
    >
      {/* Whose name the ticket goes in, read from the account - not a field. */}
      <p className="rounded-md bg-surface-sunken px-3 py-2 text-xs text-ink-muted">
        {t('support.form.raisingAsFor', {
          name: requester.name || requester.email,
          email: requester.email,
          company: requester.companyName ?? '',
        })}
      </p>

      <Field label={t('support.form.category')} required error={errors.category?.message}>
        {({ inputId, describedBy }) => (
          <Select id={inputId} aria-describedby={describedBy} required {...register('category')}>
            <option value="" disabled>
              {t('support.form.categoryPlaceholder')}
            </option>
            {SUPPORT_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(`support.category.${category}` as never)}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field label={t('support.form.subject')} required error={errors.subject?.message}>
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            autoComplete="off"
            maxLength={limits.subjectMax}
            required
            {...register('subject')}
          />
        )}
      </Field>

      <Field
        label={t('support.form.message')}
        required
        hint={t('support.portal.messageHint')}
        error={errors.message?.message}
      >
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            rows={5}
            required
            {...register('message')}
          />
        )}
      </Field>

      {context.attachments.available ? (
        <FilePicker
          files={files}
          onChange={setFiles}
          rules={context.attachments}
          disabled={send.isPending}
        />
      ) : (
        <p className="text-xs text-ink-muted">{t('support.files.unavailable')}</p>
      )}

      {problem !== null && (
        <p
          role="alert"
          className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-ink"
        >
          {problem}
        </p>
      )}

      <div>
        <Button
          type="submit"
          variant="primary"
          isLoading={send.isPending}
          className="min-w-[12rem]"
        >
          {send.isPending ? busyLabel : t('support.form.submit')}
        </Button>
      </div>
      <p aria-live="polite" className="sr-only">
        {send.isPending ? busyLabel : ''}
      </p>
    </form>
  );
}

function Sent({
  ticket,
  acknowledgementQueued,
  attached,
  failed,
  email,
  onAnother,
}: {
  ticket: SupportTicket;
  acknowledgementQueued: boolean;
  attached: string[];
  failed: string[];
  email: string;
  onAnother: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <div className="flex flex-col gap-4" data-testid="support-sent">
      <div className="rounded-lg border border-success/30 bg-success-soft px-4 py-3">
        <h3 ref={heading} tabIndex={-1} className="font-semibold text-ink focus:outline-none">
          {t('support.sent.title')}
        </h3>
        <p className="mt-1 text-sm text-ink-muted">{t('support.sent.reference')}</p>
        <p className="mt-1 font-mono text-lg font-semibold tracking-wide text-ink">
          {ticket.reference}
        </p>
      </div>
      <p className="text-sm text-ink-muted">
        {acknowledgementQueued
          ? t('support.sent.emailQueued', { email })
          : t('support.sent.noEmail')}
      </p>
      {(attached.length > 0 || failed.length > 0) && (
        <ul className="space-y-1 text-sm" aria-label={t('support.files.chosen')}>
          {attached.map((name) => (
            <li key={`ok-${name}`} className="text-ink-muted">
              {t('support.files.attached', { name })}
            </li>
          ))}
          {failed.map((line) => (
            <li key={`no-${line}`} className="text-danger">
              {line}
            </li>
          ))}
          {failed.length > 0 && (
            <li className="text-xs text-ink-muted">{t('support.files.retryOnTicket')}</li>
          )}
        </ul>
      )}
      <div className="flex flex-wrap gap-3">
        <Link
          to={`/support/${ticket.reference}`}
          className="inline-flex h-10 items-center rounded-md bg-brand-fill px-4 text-sm font-medium text-white hover:bg-brand-fill-hover"
        >
          {t('support.sent.view')}
        </Link>
        <Button variant="ghost" onClick={onAnother}>
          {t('support.sent.another')}
        </Button>
      </div>
    </div>
  );
}

function YourRequests(): React.JSX.Element {
  const { t } = useI18n();
  const list = useQuery({ queryKey: ['support-tickets'], queryFn: fetchSupportTickets });

  return (
    <section
      className="mx-auto max-w-5xl px-4 pb-16 sm:px-6"
      aria-labelledby="your-support-requests"
    >
      <h2 id="your-support-requests" className="mb-3 text-lg font-semibold text-ink">
        {t('support.list.title')}
      </h2>
      {list.isPending ? (
        <LoadingState />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.tickets.length === 0 ? (
        <EmptyState
          title={t('support.list.emptyTitle')}
          description={t('support.list.emptyBody')}
        />
      ) : (
        <ul className="divide-y divide-border-subtle overflow-hidden rounded-lg border border-border bg-surface">
          {list.data.tickets.map((ticket) => (
            <li key={ticket.reference}>
              <Link
                to={`/support/${ticket.reference}`}
                className="flex flex-col gap-1 px-4 py-3 hover:bg-surface-hover sm:flex-row sm:items-center sm:gap-4"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{ticket.subject}</span>
                  <span className="block text-xs text-ink-muted">
                    <span className="font-mono">{ticket.reference}</span> ·{' '}
                    {t('support.list.updated', { when: formatDateTime(ticket.lastActivityAt) })}
                  </span>
                </span>
                <StatusBadge status={ticket.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SupportPage(): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [sent, setSent] = useState<SentResult | null>(null);
  const [round, setRound] = useState(0);
  const context = useQuery({
    queryKey: ['support-context'],
    queryFn: fetchSupportContext,
    staleTime: 60_000,
  });

  // The portal has no layout-level focus move, so the page does it: a screen
  // reader hears "How can we help?" rather than nothing.
  useEffect(() => {
    document.querySelector<HTMLElement>('[data-route-focus]')?.focus({ preventScroll: true });
  }, []);

  const contacts = context.data?.contacts ?? { email: null, phone: null };
  const channels: ContactChannel[] = [];
  if (contacts.email !== null) {
    channels.push({
      icon: MailGlyph,
      kind: t('support.channel.email'),
      label: contacts.email,
      href: `mailto:${contacts.email}`,
    });
  }
  if (contacts.phone !== null) {
    channels.push({
      icon: PhoneGlyph,
      kind: t('support.channel.phone'),
      label: contacts.phone,
      href: `tel:${contacts.phone.replace(/[^\d+]/g, '')}`,
    });
  }

  let card: React.JSX.Element;
  if (context.isPending) card = <LoadingState />;
  else if (context.isError)
    card = <ErrorState error={context.error} onRetry={() => void context.refetch()} />;
  else if (!context.data.enabled)
    card = <p className="text-sm text-ink-muted">{t('support.disabled')}</p>;
  else if (sent !== null) {
    card = (
      <Sent
        ticket={sent.ticket}
        acknowledgementQueued={sent.acknowledgementQueued}
        attached={sent.attached}
        failed={sent.failed}
        email={context.data.requester.email}
        onAnother={() => {
          setSent(null);
          setRound((value) => value + 1);
        }}
      />
    );
  } else {
    card = (
      <RequestForm
        key={round}
        context={context.data}
        onSent={(result) => {
          setSent(result);
          void queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
        }}
      />
    );
  }

  return (
    <>
      <ContactWithGlobe
        titleAs="h1"
        subtitle={t('support.eyebrow')}
        title={t('support.title')}
        description={t('support.description')}
        getInTouchTitle={t('support.getInTouch.title')}
        getInTouchBody={t('support.getInTouch.body')}
        channels={channels}
        noChannelsMessage={t('support.noChannels')}
        formTitle={t('support.form.title')}
        formDescription={t('support.form.description')}
      >
        {card}
      </ContactWithGlobe>
      <YourRequests />
    </>
  );
}

// ---------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------

function TicketFiles({ ticket }: { ticket: SupportTicket }): React.JSX.Element | null {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<File[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const context = useQuery({
    queryKey: ['support-context'],
    queryFn: fetchSupportContext,
    staleTime: 60_000,
  });
  const rules = context.data?.attachments;

  const upload = useMutation({
    mutationFn: async () => {
      const failed: string[] = [];
      for (const file of picked) {
        try {
          await uploadSupportAttachment(ticket.reference, file);
        } catch (error) {
          failed.push(
            t('support.files.notAttached', { name: file.name, reason: supportError(t, error) }),
          );
        }
      }
      return failed;
    },
    onSuccess: (failed) => {
      setPicked([]);
      setProblem(failed.length === 0 ? null : failed.join(' '));
      void queryClient.invalidateQueries({ queryKey: ['support-ticket', ticket.reference] });
    },
  });
  const open = useMutation({
    mutationFn: (attachmentId: string) => openSupportAttachment(ticket.reference, attachmentId),
    onError: (error) => {
      setProblem(supportError(t, error));
    },
  });

  const canAdd = ticket.canReply && rules?.available === true;
  if (ticket.attachments.length === 0 && !canAdd) return null;

  return (
    <section className="mt-6 space-y-3" aria-labelledby="support-files-heading">
      <h2 id="support-files-heading" className="text-sm font-semibold text-ink">
        {t('support.files.heading')}
      </h2>
      {ticket.attachments.length > 0 && (
        <ul className="divide-y divide-border-subtle rounded-lg border border-border bg-surface">
          {ticket.attachments.map((file) => (
            <li key={file.id} className="flex items-center gap-3 px-4 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-ink">{file.fileName}</span>
              <span className="shrink-0 text-xs text-ink-muted">
                {t(`support.files.kind.${file.kind}` as never)} · {formatBytes(file.byteSize)}
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
          <FilePicker
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

export function SupportTicketPage(): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { reference = '' } = useParams();
  const query = useQuery({
    queryKey: ['support-ticket', reference],
    queryFn: () => fetchSupportTicket(reference),
  });
  const [body, setBody] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const key = useRef(newKey());

  const reply = useMutation({
    mutationFn: () => addSupportMessage(reference, body, key.current),
    onSuccess: (result) => {
      key.current = newKey();
      setBody('');
      setProblem(null);
      queryClient.setQueryData(['support-ticket', reference], result);
      void queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
    },
    onError: (error) => {
      setProblem(supportError(t, error));
    },
  });

  const back = (
    <Link
      to="/support"
      className="mb-4 inline-block text-sm font-medium text-brand hover:underline"
    >
      ← {t('support.detail.back')}
    </Link>
  );

  if (query.isPending) return <LoadingState />;
  if (query.isError) {
    return (
      <div>
        {back}
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }
  const { ticket } = query.data;

  return (
    <div className="mx-auto max-w-3xl">
      {back}
      <PageHeader
        title={ticket.subject}
        description={ticket.reference}
        actions={<StatusBadge status={ticket.status} />}
      />
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
                status: t(`support.status.${entry.status ?? 'OPEN'}` as never),
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

      <TicketFiles ticket={ticket} />

      {ticket.canReply ? (
        <form
          className="mt-6 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (body.trim().length === 0) {
              setProblem(t('support.detail.replyRequired'));
              return;
            }
            if (!reply.isPending) reply.mutate();
          }}
        >
          <Field label={t('support.detail.replyLabel')} error={problem ?? undefined}>
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
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
              isLoading={reply.isPending}
              className="min-w-[10rem]"
            >
              {reply.isPending ? t('support.form.sending') : t('support.detail.send')}
            </Button>
          </div>
        </form>
      ) : (
        <p className="mt-6 rounded-lg bg-surface-sunken px-4 py-3 text-sm text-ink-muted">
          {t('support.detail.closed')}
        </p>
      )}
    </div>
  );
}
