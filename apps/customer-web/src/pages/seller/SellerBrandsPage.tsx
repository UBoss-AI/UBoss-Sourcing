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

const STATUS_LABELS: Record<BrandRequestRow['status'], string> = {
  PENDING: 'Being reviewed',
  INFORMATION_REQUESTED: 'We need more from you',
  APPROVED: 'Approved',
  REJECTED: 'Refused',
  WITHDRAWN: 'Withdrawn',
};

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
  const query = useQuery({ queryKey: ['seller', 'brand-requests'], queryFn: fetchBrandRequests });
  const [withdrawing, setWithdrawing] = useState<BrandRequestRow | null>(null);

  const requests = query.data?.requests ?? [];
  const open = requests.filter(
    (row) => row.status === 'PENDING' || row.status === 'INFORMATION_REQUESTED',
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Brands you have asked for"
        description={
          open.length === 0
            ? 'Every name you have asked to list under, and what was decided.'
            : `${String(open.length)} still waiting on us.`
        }
        actions={<ButtonLink to="/seller/listings/new">Start a listing</ButtonLink>}
      />

      {query.isPending && <LoadingState label="Loading your brand requests" />}

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
          title="You have not asked for any"
          description="If you cannot find your brand while making a listing, ask for it there and it will appear here."
        />
      )}

      {requests.length > 0 && (
        <Card title="Your requests">
          <ul className="divide-y divide-border-subtle">
            {requests.map((row) => (
              <li key={row.id} className="px-6 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{row.requestedName}</p>
                    <p className="mt-0.5 text-xxs text-ink-subtle">
                      Asked on {new Date(row.createdAt).toLocaleDateString()}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={STATUS_TONES[row.status]}>{STATUS_LABELS[row.status]}</Badge>

                    {(row.status === 'PENDING' || row.status === 'INFORMATION_REQUESTED') && (
                      <Button
                        onClick={() => {
                          setWithdrawing(row);
                        }}
                      >
                        Withdraw
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
                    You can choose it in the listing wizard now.
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
      toast.success(`Your request for ${request.requestedName} was withdrawn.`);
      onClose();
    },
    onError: (error: unknown) => {
      // A request somebody has just decided cannot be withdrawn, and the server
      // says so. Its sentence is better than ours.
      toast.error(errorMessage(t, error, 'That request could not be withdrawn.'));
    },
  });

  return (
    <Modal isOpen title="Withdraw this request?" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">
          We will stop reviewing <strong className="text-ink">{request.requestedName}</strong>. Any
          listing you attached it to keeps the name but still cannot go on sale, so you will need to
          choose a different brand or ask for this one again.
        </p>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Keep it</Button>
          <Button
            variant="danger"
            isLoading={mutation.isPending}
            onClick={() => {
              mutation.mutate();
            }}
          >
            Withdraw
          </Button>
        </div>
      </div>
    </Modal>
  );
}
