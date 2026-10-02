/**
 * Reported messages (checklist JOURNEY-055): the moderation queue.
 *
 * A buyer or a seller pressed "Report message" under something they were sent
 * in a preorder chat, an RFQ thread or an order thread. Each report shows
 * which kind of conversation, why it was reported, who reported it, their
 * note and the words themselves - read where they are, so a message removed
 * since shows as removed rather than as a stale copy.
 *
 * A report never hides anything by itself. Staff decide - actioned or
 * dismissed - with a note, which closes the bell alert and is audited. Any
 * action against the sender (redacting a chat message, suspending an account)
 * is taken through the existing controls; this screen links to the
 * conversation where there is a staff screen for it.
 *
 * Reading the queue needs `review.read`; deciding needs `review.moderate`,
 * the same content-moderation grants as product reviews.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  PageHeader,
  Select,
  Textarea,
  Toolbar,
  ToolbarField,
} from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';

export type MessageReportStatus = 'OPEN' | 'ACTIONED' | 'DISMISSED';

export interface MessageReport {
  id: string;
  threadKind: 'PREORDER_CHAT' | 'RFQ' | 'ORDER';
  messageId: string;
  threadId: string;
  reason: 'SPAM' | 'ABUSE' | 'FRAUD' | 'PERSONAL_DATA' | 'OFF_PLATFORM' | 'OTHER';
  note: string | null;
  status: MessageReportStatus;
  reporter: { email: string; party: string };
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  messageBody: string;
  linkPath: string | null;
}

const NOTE_MAX = 1000;

export function MessageReportsPage(): React.JSX.Element {
  const { t } = useI18n();
  const [status, setStatus] = useState<MessageReportStatus | ''>('OPEN');

  const query = useQuery({
    queryKey: ['admin', 'message-reports', status],
    queryFn: () =>
      api.get<{ reports: MessageReport[] }>(
        `/admin/message-reports${status === '' ? '' : `?status=${status}`}`,
      ),
  });

  return (
    <div className="space-y-5">
      <PageHeader title={t('messageReports.title')} description={t('messageReports.description')} />

      <Toolbar>
        <ToolbarField label={t('messageReports.filter.status')}>
          <Select
            value={status}
            onChange={(event) => {
              setStatus(event.currentTarget.value as MessageReportStatus | '');
            }}
          >
            <option value="OPEN">{t('messageReports.status.OPEN')}</option>
            <option value="ACTIONED">{t('messageReports.status.ACTIONED')}</option>
            <option value="DISMISSED">{t('messageReports.status.DISMISSED')}</option>
            <option value="">{t('messageReports.filter.all')}</option>
          </Select>
        </ToolbarField>
      </Toolbar>

      {query.isPending && <LoadingState label={t('messageReports.loading')} />}
      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}
      {query.isSuccess && query.data.reports.length === 0 && (
        <EmptyState title={t('messageReports.emptyTitle')} description={t('messageReports.emptyBody')} />
      )}
      {query.isSuccess && query.data.reports.length > 0 && (
        <ul className="space-y-4">
          {query.data.reports.map((report) => (
            <li key={report.id}>
              <ReportCard report={report} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReportCard({ report }: { report: MessageReport }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const client = useQueryClient();
  const [decision, setDecision] = useState<'ACTIONED' | 'DISMISSED'>('ACTIONED');
  const [note, setNote] = useState('');

  const mutation = useMutation({
    mutationFn: () => api.post(`/admin/message-reports/${report.id}/decision`, { decision, note: note.trim() }),
    onSuccess: async () => {
      toast.success(t('messageReports.saved'));
      setNote('');
      await client.invalidateQueries({ queryKey: ['admin', 'message-reports'] });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof ApiError ? error.message : t('messageReports.couldNotSave'));
    },
  });

  return (
    <Card
      title={t(`messageReports.kind.${report.threadKind}` as TranslationKey)}
      description={`${t(`messageReports.reason.${report.reason}` as TranslationKey)} · ${formatDate(report.createdAt)}`}
      actions={
        <Badge tone={report.status === 'OPEN' ? 'warning' : report.status === 'ACTIONED' ? 'success' : 'neutral'} dot>
          {t(`messageReports.status.${report.status}` as TranslationKey)}
        </Badge>
      }
      bodyClassName="px-5 py-4"
    >
      <div className="space-y-3 text-sm">
        <div>
          <p className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">{t('messageReports.message')}</p>
          {report.messageBody === '' ? (
            <p className="mt-1 italic text-ink-muted">{t('messageReports.removed')}</p>
          ) : (
            <blockquote className="mt-1 whitespace-pre-line rounded-md border-l-2 border-border-strong bg-surface-sunken px-3 py-2 text-ink [overflow-wrap:anywhere]">
              {report.messageBody}
            </blockquote>
          )}
        </div>
        <p className="text-ink-muted">
          {t('messageReports.reportedBy', {
            email: report.reporter.email,
            party: t(`messageReports.party.${report.reporter.party === 'SELLER' ? 'SELLER' : 'BUYER'}` as TranslationKey),
          })}
        </p>
        {report.note !== null && report.note !== '' && (
          <p className="text-ink">
            {t('messageReports.note')}: {report.note}
          </p>
        )}
        {report.linkPath !== null && (
          <Link to={report.linkPath} className="inline-block font-medium text-brand hover:underline">
            {t('messageReports.openConversation')}
          </Link>
        )}
        {report.reviewedAt !== null && (
          <p className="text-xs text-ink-muted">
            {t('messageReports.decidedBy', {
              person: report.reviewedBy ?? '—',
              date: formatDate(report.reviewedAt),
              note: report.reviewNote ?? '—',
            })}
          </p>
        )}

        {can(Permission.REVIEW_MODERATE) && (
          <form
            className="space-y-3 border-t border-border-subtle pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (note.trim().length > 0) mutation.mutate();
            }}
          >
            <Field label={t('messageReports.decision')}>
              {({ inputId }) => (
                <Select
                  id={inputId}
                  value={decision}
                  onChange={(event) => {
                    setDecision(event.currentTarget.value as 'ACTIONED' | 'DISMISSED');
                  }}
                >
                  <option value="ACTIONED">{t('messageReports.status.ACTIONED')}</option>
                  <option value="DISMISSED">{t('messageReports.status.DISMISSED')}</option>
                </Select>
              )}
            </Field>
            <Field label={t('messageReports.decisionNote')} hint={t('messageReports.decisionNoteHint')} required>
              {({ inputId, describedBy }) => (
                <Textarea
                  id={inputId}
                  aria-describedby={describedBy}
                  rows={2}
                  maxLength={NOTE_MAX}
                  value={note}
                  onChange={(event) => {
                    setNote(event.currentTarget.value);
                  }}
                />
              )}
            </Field>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" isLoading={mutation.isPending} disabled={note.trim().length === 0}>
                {t('messageReports.save')}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}
