/**
 * Privileged-access review of the marketplace's own staff (LIVE-015).
 *
 * Shown on the Staff page to Business Owners only - the API refuses everybody
 * else. Each staff account is listed with its roles, whether two-factor is
 * on, its last sign-in and a dormant flag, and the owner records a decision
 * for it: keep, reduce or revoke, with a note. The decision is a record, not
 * an action: reducing or revoking is then done with the Roles and Deactivate
 * buttons in the table above, which keep their own checks.
 *
 * An owner's own row carries no button. The server refuses a self-review, and
 * offering one would only lead to that refusal.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DataTable, type Column } from '@/components/DataTable';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, Field, Select, SummaryTiles, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { ApiError, api } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/format';
import { roleLabel } from '@/lib/permissions';

type Decision = 'KEEP' | 'REDUCE' | 'REVOKE';

export interface StaffAccessAccount {
  id: string;
  email: string;
  status: string;
  deactivated: boolean;
  roles: { key: string; name: string }[];
  mfaEnabled: boolean;
  lastSignInAt: string | null;
  createdAt: string;
  dormant: boolean;
  isSelf: boolean;
  latestDecision: { decision: Decision; note: string | null; reviewedAt: string; reviewerEmail: string | null } | null;
}

export interface StaffAccessReviewData {
  dormantAfterDays: number;
  generatedAt: string;
  accounts: StaffAccessAccount[];
  summary: { accounts: number; withoutMfa: number; dormant: number; neverReviewed: number };
}

const QUERY_KEY = ['staff', 'access-review'] as const;

function DecisionDialog({ account, onClose }: { account: StaffAccessAccount; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [decision, setDecision] = useState<Decision>('KEEP');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const noteRequired = decision !== 'KEEP';

  const save = useMutation({
    mutationFn: () =>
      api.post(`/admin/staff/${account.id}/access-reviews`, {
        decision,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      }),
    onSuccess: async () => {
      toast.success(t('staffReview.recorded'));
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      onClose();
    },
    onError: (apiError) => {
      setError(apiError instanceof ApiError ? apiError.message : t('staffReview.couldNotRecord'));
    },
  });

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('staffReview.dialogTitle', { email: account.email })}
      description={t('staffReview.dialogDescription')}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            {t('staff.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={noteRequired && note.trim() === ''}
            isLoading={save.isPending}
            onClick={() => {
              save.mutate();
            }}
          >
            {t('staffReview.record')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error !== null && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}
        <Field label={t('staffReview.decision')} required>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={decision}
              onChange={(event) => {
                setDecision(event.target.value as Decision);
              }}
            >
              <option value="KEEP">{t('staffReview.decisionKEEP')}</option>
              <option value="REDUCE">{t('staffReview.decisionREDUCE')}</option>
              <option value="REVOKE">{t('staffReview.decisionREVOKE')}</option>
            </Select>
          )}
        </Field>
        <Field
          label={t('staffReview.note')}
          hint={noteRequired ? t('staffReview.noteRequiredHint') : t('staffReview.noteOptionalHint')}
          required={noteRequired}
        >
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              maxLength={1000}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}

export function StaffAccessReviewPanel(): React.JSX.Element {
  const { t } = useI18n();
  const [reviewing, setReviewing] = useState<StaffAccessAccount | null>(null);
  const review = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.get<StaffAccessReviewData>('/admin/staff/access-review'),
    retry: false,
  });

  const decisionTone = (decision: Decision): 'success' | 'warning' | 'danger' =>
    decision === 'KEEP' ? 'success' : decision === 'REDUCE' ? 'warning' : 'danger';

  const columns: Column<StaffAccessAccount>[] = [
    {
      key: 'account',
      header: t('staffReview.account'),
      render: (row) => (
        <div className="min-w-48">
          <span className="block font-medium text-ink">{row.email}</span>
          <span className="mt-1 flex flex-wrap gap-1">
            {row.roles.map((role) => (
              <Badge key={role.key}>{roleLabel(role.key)}</Badge>
            ))}
            {row.deactivated && <Badge tone="danger">{t('staff.deactivated')}</Badge>}
          </span>
        </div>
      ),
    },
    {
      key: 'mfa',
      header: t('label.twoFactor'),
      render: (row) =>
        row.mfaEnabled ? (
          <Badge tone="success">{t('staffReview.mfaOn')}</Badge>
        ) : (
          <Badge tone="warning">{t('staffReview.mfaOff')}</Badge>
        ),
    },
    {
      key: 'lastSignIn',
      header: t('label.lastSignIn'),
      nowrap: true,
      render: (row) => (
        <div>
          <span className="block text-ink-muted">
            {row.lastSignInAt === null ? t('staff.never') : formatDateTime(row.lastSignInAt)}
          </span>
          {row.dormant && <Badge tone="warning">{t('staffReview.dormant')}</Badge>}
        </div>
      ),
    },
    {
      key: 'decision',
      header: t('staffReview.latestDecision'),
      render: (row) =>
        row.latestDecision === null ? (
          <span className="text-ink-subtle">{t('staffReview.notReviewed')}</span>
        ) : (
          <div className="max-w-xs">
            <Badge tone={decisionTone(row.latestDecision.decision)}>
              {t(`staffReview.decision${row.latestDecision.decision}`)}
            </Badge>
            <span className="mt-1 block text-xs text-ink-muted">
              {t('staffReview.decidedBy', {
                date: formatDateTime(row.latestDecision.reviewedAt),
                email: row.latestDecision.reviewerEmail ?? '—',
              })}
            </span>
            {row.latestDecision.note !== null && (
              <span className="mt-1 block text-xs text-ink">{row.latestDecision.note}</span>
            )}
          </div>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">{t('staff.actions')}</span>,
      align: 'right',
      render: (row) =>
        row.isSelf ? (
          <span className="text-xs text-ink-subtle">{t('staffReview.selfNote')}</span>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setReviewing(row);
            }}
          >
            {t('staffReview.recordDecision')}
            <span className="sr-only"> {row.email}</span>
          </Button>
        ),
    },
  ];

  return (
    <Card title={t('staffReview.title')} description={t('staffReview.description')}>
      <div className="space-y-4 px-5 py-4">
        {review.data !== undefined && (
          <>
            <SummaryTiles
              items={[
                { label: t('staffReview.summaryAccounts'), value: formatNumber(review.data.summary.accounts) },
                {
                  label: t('staffReview.summaryWithoutMfa'),
                  value: formatNumber(review.data.summary.withoutMfa),
                  tone: review.data.summary.withoutMfa > 0 ? 'warning' : 'success',
                },
                {
                  label: t('staffReview.summaryDormant'),
                  value: formatNumber(review.data.summary.dormant),
                  tone: review.data.summary.dormant > 0 ? 'warning' : 'success',
                },
                {
                  label: t('staffReview.summaryNeverReviewed'),
                  value: formatNumber(review.data.summary.neverReviewed),
                  tone: review.data.summary.neverReviewed > 0 ? 'warning' : 'success',
                },
              ]}
            />
            <p className="text-xs text-ink-muted">
              {review.data.dormantAfterDays === 0
                ? t('staffReview.dormantOff')
                : t('staffReview.dormantRule', { days: formatNumber(review.data.dormantAfterDays) })}
            </p>
          </>
        )}
        <DataTable
          caption={t('staffReview.caption')}
          columns={columns}
          rows={review.data?.accounts}
          rowKey={(row) => row.id}
          isLoading={review.isPending}
          error={review.isError ? review.error : undefined}
          onRetry={() => {
            void review.refetch();
          }}
          loadingLabel={t('staffReview.loading')}
          emptyTitle={t('staff.noStaffAccounts')}
          minWidth="56rem"
          rowClassName={(row) => (row.dormant || !row.mfaEnabled ? 'bg-warning-soft/40' : undefined)}
        />
      </div>
      {reviewing !== null && (
        <DecisionDialog
          account={reviewing}
          onClose={() => {
            setReviewing(null);
          }}
        />
      )}
    </Card>
  );
}
