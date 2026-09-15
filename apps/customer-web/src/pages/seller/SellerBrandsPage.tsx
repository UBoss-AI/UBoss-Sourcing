/**
 * The brands you have asked for, and what happened to them.
 *
 * Requesting a brand is the one thing in the wizard a seller does and then
 * cannot see again. The request is made at step two, the brand attaches to the
 * draft straight away, and from then on the only signal that anything happened
 * is the listing refusing to go on sale. That is a dead end: the seller cannot
 * tell whether somebody is looking at it, whether they were asked a question,
 * or whether it was refused three days ago.
 *
 * So this screen exists to answer one question — "what is happening with the
 * names I asked for" — and to let a seller take back a request they made by
 * mistake before anybody spends time on it.
 *
 * Withdrawing is only offered while it is still undecided. A decided request
 * stays on the list with its reason, because "we refused it, and here is why"
 * is information the seller needs to keep, not a row to tidy away.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/ui';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import {
  fetchBrandRequests,
  withdrawBrandRequest,
  type BrandRequestRow,
} from '@/lib/seller';

type BrandStatusKey = `seller.brands.status.${BrandRequestRow['status']}`;

/** What each decision is called, as a key rather than a word. */
function statusKey(status: BrandRequestRow['status']): BrandStatusKey {
  return `seller.brands.status.${status}`;
}

const STATUS_TONES: Record<
  BrandRequestRow['status'],
  'neutral' | 'brand' | 'success' | 'warning' | 'danger'
> = {
  PENDING: 'brand',
  INFORMATION_REQUESTED: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  WITHDRAWN: 'neutral',
};

export function SellerBrandsPage(): React.JSX.Element {
  const { t } = useI18n();

  const query = useQuery({ queryKey: ['seller', 'brand-requests'], queryFn: fetchBrandRequests });
  const [withdrawing, setWithdrawing] = useState<BrandRequestRow | null>(null);

  const requests = query.data?.requests ?? [];
  const open = requests.filter(
    (row) => row.status === 'PENDING' || row.status === 'INFORMATION_REQUESTED',
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('seller.brands.title')}
        description={
          open.length === 0
            ? t('seller.brands.intro')
            : t('seller.brands.waiting', { count: open.length })
        }
        actions={
          <ButtonLink to="/seller/listings/new">{t('seller.brands.startListing')}</ButtonLink>
        }
      />

      {query.isPending && <LoadingState label={t('seller.brands.loading')} />}

      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}

      {query.isSuccess && requests.length === 0 && (
        <EmptyState
          title={t('seller.brands.emptyTitle')}
          description={t('seller.brands.emptyBody')}
        />
      )}

      {requests.length > 0 && (
        <Card title={t('seller.brands.card')}>
          <ul className="divide-y divide-border-subtle">
            {requests.map((row) => (
              <li key={row.id} className="px-6 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{row.requestedName}</p>
                    <p className="mt-0.5 text-xxs text-ink-subtle">
                      {t('seller.brands.askedOn', {
                        date: new Date(row.createdAt).toLocaleDateString(),
                      })}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={STATUS_TONES[row.status]}>{t(statusKey(row.status))}</Badge>

                    {(row.status === 'PENDING' || row.status === 'INFORMATION_REQUESTED') && (
                      <Button
                        onClick={() => {
                          setWithdrawing(row);
                        }}
                      >
                        {t('seller.brands.withdraw')}
                      </Button>
                    )}
                  </div>
                </div>

                {/*
                  The reason, whatever the decision. On a refusal it is why; on
                  "we need more" it is the question. Both are written for the
                  seller and both are the only thing on this screen they can act
                  on, so neither is hidden behind a click.
                */}
                {row.decisionReason !== null && row.decisionReason.length > 0 && (
                  <p
                    className={`mt-2 whitespace-pre-wrap rounded-lg px-3 py-2 text-xs leading-relaxed ${
                      row.status === 'REJECTED'
                        ? 'bg-danger-soft text-ink'
                        : 'bg-surface-sunken text-ink-muted'
                    }`}
                  >
                    {row.decisionReason}
                  </p>
                )}

                {row.status === 'APPROVED' && (
                  <p className="mt-2 text-xs text-ink-muted">
                    {t('seller.brands.approvedNote')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {withdrawing !== null && (
        <WithdrawDialog
          request={withdrawing}
          onClose={() => {
            setWithdrawing(null);
          }}
        />
      )}
    </div>
  );
}

function WithdrawDialog({
  request,
  onClose,
}: {
  request: BrandRequestRow;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => withdrawBrandRequest(request.id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['seller', 'brand-requests'] });
      toast.success(t('seller.brands.withdrawn', { name: request.requestedName }));
      onClose();
    },
    onError: (error: unknown) => {
      // A request somebody has just decided cannot be withdrawn, and the server
      // says so. Its sentence is better than ours.
      toast.error(errorMessage(t, error, t('seller.brands.withdrawFailed')));
    },
  });

  return (
    <Modal isOpen title={t('seller.brands.withdrawTitle')} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">
          {t('seller.brands.withdrawBody', { name: request.requestedName })}
        </p>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('seller.brands.keepIt')}</Button>
          <Button
            variant="danger"
            isLoading={mutation.isPending}
            onClick={() => {
              mutation.mutate();
            }}
          >
            {t('seller.brands.withdraw')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
