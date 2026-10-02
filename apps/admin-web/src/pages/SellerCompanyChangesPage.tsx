/**
 * Sellers' change requests for verified company details (JOURNEY-027).
 *
 * After approval a seller cannot type over their legal name, registration or
 * tax numbers or registered address. They propose a change; it lands here.
 * Staff approve it (it is applied, and a material change re-opens the
 * business-registration or tax verification) or reject it with a reason the
 * seller is shown. Every decision is audited.
 *
 * Reading needs `customer.read`; deciding needs `customer.status.write`, the
 * same split as deciding a seller application or a factory.
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

export type CompanyChangeStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';

export interface CompanyChangeEntry {
  id: string;
  status: CompanyChangeStatus;
  proposed: Record<string, string | null>;
  previous: Record<string, string | null>;
  material: boolean;
  reverifies: string[];
  note: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  createdAt: string;
  seller: { id: string; displayName: string; legalName: string };
}

export function SellerCompanyChangesPage(): React.JSX.Element {
  const { t } = useI18n();
  const [status, setStatus] = useState<CompanyChangeStatus>('PENDING');

  const query = useQuery({
    queryKey: ['admin', 'seller-company-changes', status],
    queryFn: () => api.get<{ changes: CompanyChangeEntry[] }>(`/admin/seller-company-changes?status=${status}`),
  });

  return (
    <div className="space-y-5">
      <PageHeader title={t('companyChanges.title')} description={t('companyChanges.description')} />

      <Toolbar>
        <ToolbarField label={t('companyChanges.filter.status')}>
          <Select
            value={status}
            onChange={(event) => {
              setStatus(event.currentTarget.value as CompanyChangeStatus);
            }}
          >
            {(['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const).map((value) => (
              <option key={value} value={value}>
                {t(`companyChanges.status.${value}` as TranslationKey)}
              </option>
            ))}
          </Select>
        </ToolbarField>
      </Toolbar>

      {query.isPending && <LoadingState label={t('companyChanges.loading')} />}
      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}
      {query.isSuccess && query.data.changes.length === 0 && (
        <EmptyState title={t('companyChanges.emptyTitle')} description={t('companyChanges.emptyBody')} />
      )}
      {query.isSuccess && query.data.changes.length > 0 && (
        <ul className="space-y-4">
          {query.data.changes.map((change) => (
            <li key={change.id}>
              <ChangeCard change={change} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ChangeCard({ change }: { change: CompanyChangeEntry }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const client = useQueryClient();
  const [decision, setDecision] = useState<'APPROVED' | 'REJECTED'>('APPROVED');
  const [reason, setReason] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/admin/seller-company-changes/${change.id}/decision`, {
        decision,
        ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
      }),
    onSuccess: async () => {
      toast.success(t('companyChanges.saved'));
      await client.invalidateQueries({ queryKey: ['admin', 'seller-company-changes'] });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof ApiError ? error.message : t('companyChanges.couldNotSave'));
    },
  });

  const needsReason = decision === 'REJECTED' && reason.trim().length < 3;

  return (
    <Card
      title={change.seller.displayName}
      description={`${change.seller.legalName} · ${formatDate(change.createdAt)}`}
      actions={
        <div className="flex flex-wrap gap-2">
          {change.material && <Badge tone="danger">{t('companyChanges.material')}</Badge>}
          <Badge tone={change.status === 'PENDING' ? 'warning' : change.status === 'APPROVED' ? 'success' : 'neutral'} dot>
            {t(`companyChanges.status.${change.status}` as TranslationKey)}
          </Badge>
        </div>
      }
      bodyClassName="px-5 py-4"
    >
      <div className="space-y-3 text-sm">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xxs uppercase tracking-wider text-ink-subtle">
              <th className="py-1 pr-3 font-medium">{t('companyChanges.field')}</th>
              <th className="py-1 pr-3 font-medium">{t('companyChanges.onFile')}</th>
              <th className="py-1 font-medium">{t('companyChanges.proposed')}</th>
            </tr>
          </thead>
          <tbody>
            {Object.keys(change.proposed).map((field) => (
              <tr key={field} className="border-t border-border-subtle">
                <td className="py-1.5 pr-3 font-medium text-ink">{t(`companyChanges.fieldName.${field}` as TranslationKey)}</td>
                <td className="py-1.5 pr-3 text-ink-muted [overflow-wrap:anywhere]">{change.previous[field] ?? '—'}</td>
                <td className="py-1.5 text-ink [overflow-wrap:anywhere]">{change.proposed[field] ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {change.material && (
          <p className="text-xs text-ink-muted">
            {t('companyChanges.reverifies', { checks: change.reverifies.join(', ') })}
          </p>
        )}
        {change.note !== null && (
          <p className="text-ink">
            {t('companyChanges.sellerNote')}: {change.note}
          </p>
        )}
        <Link to={`/sellers/${change.seller.id}`} className="inline-block font-medium text-brand hover:underline">
          {t('companyChanges.openSeller')}
        </Link>
        {change.decidedAt !== null && (
          <p className="text-xs text-ink-muted">
            {t('companyChanges.decidedOn', { date: formatDate(change.decidedAt), reason: change.decisionReason ?? '—' })}
          </p>
        )}

        {change.status === 'PENDING' && can(Permission.CUSTOMER_STATUS_WRITE) && (
          <form
            className="space-y-3 border-t border-border-subtle pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!needsReason) mutation.mutate();
            }}
          >
            <Field label={t('companyChanges.decision')}>
              {({ inputId }) => (
                <Select
                  id={inputId}
                  value={decision}
                  onChange={(event) => {
                    setDecision(event.currentTarget.value as 'APPROVED' | 'REJECTED');
                  }}
                >
                  <option value="APPROVED">{t('companyChanges.approve')}</option>
                  <option value="REJECTED">{t('companyChanges.reject')}</option>
                </Select>
              )}
            </Field>
            <Field label={t('companyChanges.reason')} hint={t('companyChanges.reasonHint')}>
              {({ inputId, describedBy }) => (
                <Textarea
                  id={inputId}
                  aria-describedby={describedBy}
                  rows={2}
                  maxLength={1000}
                  value={reason}
                  onChange={(event) => {
                    setReason(event.currentTarget.value);
                  }}
                />
              )}
            </Field>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" isLoading={mutation.isPending} disabled={needsReason}>
                {t('companyChanges.save')}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}
