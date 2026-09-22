/**
 * Which sellers may hand parcels to which carriers.
 *
 * The approvals queue for the seller half of the fulfilment split. A seller
 * may ASK to use a carrier; only this screen may say yes.
 *
 * WHY APPROVING ONE IS A REAL DECISION
 *
 * It lets one business create an obligation on another. Once an arrangement
 * exists, that seller can offer work to that carrier without anybody here
 * looking at it again — which is the point, and which is why the decision
 * itself is audited with who made it and on what grounds.
 *
 * EVERY ADVERSE DECISION NEEDS A REASON, AND THE SERVER ENFORCES IT
 *
 * A refusal, a pause or an ending with no reason is one the seller cannot act
 * on; they simply ask again, and the queue fills with duplicates of a decision
 * somebody already made. The field is required here so nobody discovers that
 * at the point of saving.
 *
 * Note what this screen does NOT do: it never touches a driver. Who drives for
 * a carrier is the carrier's own business, and nothing here reaches into it.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
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
} from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';

type ArrangementStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'SUSPENDED' | 'ENDED';

/** What this screen may decide. Never REQUESTED - that is the seller asking. */
type Decision = Exclude<ArrangementStatus, 'REQUESTED'>;

interface Arrangement {
  linkId: string;
  status: ArrangementStatus;
  relationshipType: string;
  seller: { id: string; displayName: string; legalName: string };
  carrier: { id: string; displayName: string; partnerCode: string; status: string };
  serviceCountries: unknown;
  approvedCapabilities: unknown;
  sellerReference: string | null;
  statusReason: string | null;
  requestedAt: string;
  decidedAt: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

const STATUS_TONES: Record<ArrangementStatus, BadgeTone> = {
  REQUESTED: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  SUSPENDED: 'warning',
  ENDED: 'neutral',
};

/**
 * Which decisions are reachable from where. Mirrors the server's machine.
 *
 * The values are narrowed to `Decision`, not `ArrangementStatus`, because this
 * screen can never move an arrangement back to REQUESTED - only a seller
 * asking again does that, from their own page. Saying so in the type is what
 * keeps the button labels exhaustive.
 */
const NEXT: Record<ArrangementStatus, Decision[]> = {
  REQUESTED: ['APPROVED', 'REJECTED'],
  APPROVED: ['SUSPENDED', 'ENDED'],
  REJECTED: [],
  SUSPENDED: ['APPROVED', 'ENDED'],
  ENDED: [],
};

/** Decisions the seller has to be able to act on, so a reason is required. */
const NEEDS_REASON = new Set<Decision>(['REJECTED', 'SUSPENDED', 'ENDED']);

export function SellerCarriersPage(): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<'' | ArrangementStatus>('REQUESTED');

  const query = useQuery({
    queryKey: ['admin', 'seller-carriers', status],
    queryFn: () =>
      api.get<{ arrangements: Arrangement[] }>(
        `/admin/seller-carriers${status === '' ? '' : `?status=${status}`}`,
      ),
  });

  const canDecide = can(Permission.CUSTOMER_STATUS_WRITE);
  const arrangements = query.data?.arrangements ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('adminSellerCarriers.title')}
        description={t('adminSellerCarriers.description')}
      />

      <Card>
        <p className="text-sm leading-relaxed text-ink-muted">{t('adminSellerCarriers.split')}</p>
      </Card>

      <Card>
        <Field label={t('adminSellerCarriers.filterLabel')}>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as '' | ArrangementStatus);
              }}
            >
              <option value="REQUESTED">{t('adminSellerCarriers.status.REQUESTED')}</option>
              <option value="APPROVED">{t('adminSellerCarriers.status.APPROVED')}</option>
              <option value="SUSPENDED">{t('adminSellerCarriers.status.SUSPENDED')}</option>
              <option value="REJECTED">{t('adminSellerCarriers.status.REJECTED')}</option>
              <option value="ENDED">{t('adminSellerCarriers.status.ENDED')}</option>
              <option value="">{t('adminSellerCarriers.filterAll')}</option>
            </Select>
          )}
        </Field>
      </Card>

      {query.isPending && <LoadingState label={t('adminSellerCarriers.loading')} />}

      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}

      {query.isSuccess && arrangements.length === 0 && (
        <EmptyState
          title={t('adminSellerCarriers.emptyTitle')}
          description={t('adminSellerCarriers.emptyBody')}
        />
      )}

      {arrangements.length > 0 && (
        <Card>
          <ul className="divide-y divide-border-subtle">
            {arrangements.map((arrangement) => (
              <li key={arrangement.linkId} className="px-6 py-5">
                <ArrangementRow
                  arrangement={arrangement}
                  canDecide={canDecide}
                  locale={intlLocale}
                  onDecided={() => {
                    void queryClient.invalidateQueries({ queryKey: ['admin', 'seller-carriers'] });
                  }}
                  onError={(message) => {
                    toast.error(message);
                  }}
                  onSuccess={(message) => {
                    toast.success(message);
                  }}
                />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function ArrangementRow({
  arrangement,
  canDecide,
  locale,
  onDecided,
  onError,
  onSuccess,
}: {
  arrangement: Arrangement;
  canDecide: boolean;
  locale: string;
  onDecided: () => void;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [reason, setReason] = useState('');

  const decide = useMutation({
    mutationFn: (to: Decision) =>
      api.patch(`/admin/seller-carriers/${arrangement.linkId}`, {
        status: to,
        reason: reason.trim() === '' ? null : reason.trim(),
      }),
    onSuccess: () => {
      setReason('');
      onSuccess(t('adminSellerCarriers.decided'));
      onDecided();
    },
    onError: (error) => {
      onError(error instanceof ApiError ? error.message : t('adminSellerCarriers.decideFailed'));
    },
  });

  const options = NEXT[arrangement.status];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{arrangement.seller.displayName}</span>
            <span className="text-ink-subtle">→</span>
            <span className="font-medium text-ink">{arrangement.carrier.displayName}</span>
            <Badge tone={STATUS_TONES[arrangement.status]}>
              {t(`adminSellerCarriers.status.${arrangement.status}`)}
            </Badge>
          </p>

          <p className="mt-1 text-xs text-ink-muted">
            {t('adminSellerCarriers.carrierCode', { code: arrangement.carrier.partnerCode })}
            {' · '}
            {arrangement.decidedAt === null
              ? t('adminSellerCarriers.askedOn', {
                  date: new Date(arrangement.requestedAt).toLocaleDateString(locale),
                })
              : t('adminSellerCarriers.decidedOn', {
                  date: new Date(arrangement.decidedAt).toLocaleDateString(locale),
                })}
          </p>

          {arrangement.statusReason !== null && (
            <p className="mt-1 max-w-prose text-xs text-ink">{arrangement.statusReason}</p>
          )}

          {/* The carrier's own state overrides any arrangement. Said here
              because approving a seller onto a suspended carrier would look
              like it worked and would then refuse every offer. */}
          {arrangement.carrier.status !== 'ACTIVE' && (
            <p className="mt-1 text-xs text-warning">
              {t('adminSellerCarriers.carrierNotActive', {
                status: arrangement.carrier.status,
              })}
            </p>
          )}
        </div>
      </div>

      {canDecide && options.length > 0 && (
        <div className="space-y-2">
          {/* Required for every adverse decision, and the server refuses
              without it. Shown always rather than conditionally, so nobody
              types a decision and then discovers a second field. */}
          <Field
            label={t('adminSellerCarriers.reasonLabel')}
            hint={t('adminSellerCarriers.reasonHint')}
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                value={reason}
                disabled={decide.isPending}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            )}
          </Field>

          <div className="flex flex-wrap gap-2">
            {options.map((option) => (
              <Button
                key={option}
                variant={option === 'APPROVED' ? 'primary' : 'secondary'}
                disabled={
                  decide.isPending || (NEEDS_REASON.has(option) && reason.trim().length === 0)
                }
                onClick={() => {
                  decide.mutate(option);
                }}
              >
                {t(`adminSellerCarriers.action.${option}`)}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
