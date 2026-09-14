/**
 * Settings → Marketplace: what this business keeps when a seller makes a sale.
 *
 * The rate existed in the database and in the settlement arithmetic from the
 * day the marketplace did, and until this panel there was no way to set it: a
 * deployment could approve sellers, take their orders and settle them at
 * whatever the column happened to hold — zero, unless somebody wrote SQL.
 *
 * Four things it is careful to say on screen, because each one is a question
 * an operator would otherwise have to ask support:
 *
 *   - **It is the standard rate, not everybody's rate.** A seller can be put
 *     on their own, from their page under Sellers, and that one wins.
 *   - **Nothing already sold moves.** The rate in force is copied onto each
 *     seller's share of an order when the order is confirmed, so changing this
 *     changes what is charged from now on and cannot rewrite a statement.
 *   - **It is taken from the goods only** — not from tax, which is money on
 *     its way to a tax authority, and not from delivery, which is recovery of
 *     a cost.
 *   - **Zero is a real answer.** A marketplace that has not decided what it
 *     charges should charge nothing rather than something nobody chose.
 *
 * Percent on screen, basis points on the wire. The contract a seller signs says
 * "2.5%", and the column stores 250 — a rate held as 0.025 comes back as
 * 0.024999999 often enough to stop a settlement reconciling.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import {
  Button,
  Callout,
  Card,
  ErrorState,
  Field,
  Input,
  LoadingState,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';

/**
 * The part of the business profile this panel reads.
 *
 * Narrow, against the same query key the business and policy panels use, so
 * the profile is fetched once for the whole screen.
 */
interface BusinessCommissionResponse {
  business: {
    sellerCommissionBasisPoints: number;
  };
}

/** "2.5" from 250. Trailing zeros trimmed, because 2.50 is not what anyone types. */
function percentFromBasisPoints(basisPoints: number): string {
  return String(Number((basisPoints / 100).toFixed(2)));
}

/**
 * "2.5" back to 250, or null when it is not a rate.
 *
 * Rounded rather than truncated, and only to whole basis points: a rate of
 * 2.505% is not something a contract can express, and silently keeping the
 * extra digit would produce a figure the seller's paperwork does not contain.
 */
function basisPointsFromPercent(value: string): number | null {
  const trimmed = value.trim().replace('%', '');
  if (trimmed.length === 0) return null;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;

  return Math.round(parsed * 100);
}

export function MarketplacePanel(): React.JSX.Element {
  const { t } = useI18n();

  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useSession();

  const [percent, setPercent] = useState('');
  const [error, setError] = useState<string | null>(null);

  /**
   * Whether what is in the box is somebody's unsaved work.
   *
   * The same guard `PolicyLinksPanel` keeps, for the same reason: this query
   * key is shared with the business profile above, and saving that invalidates
   * it. Without this, pressing Save up there discards a rate typed down here.
   */
  const [isEdited, setIsEdited] = useState(false);

  const query = useQuery({
    queryKey: ['business-profile'],
    queryFn: () => api.get<BusinessCommissionResponse>('/admin/settings/business'),
  });

  const current = query.data?.business.sellerCommissionBasisPoints;

  useEffect(() => {
    if (current === undefined || isEdited) return;
    setPercent(percentFromBasisPoints(current));
  }, [current, isEdited]);

  const save = useMutation({
    mutationFn: (basisPoints: number) =>
      api.patch('/admin/settings/business', { sellerCommissionBasisPoints: basisPoints }),
    onSuccess: async () => {
      setError(null);
      setIsEdited(false);
      toast.success(t('marketplace.commissionSaved'));
      await queryClient.invalidateQueries({ queryKey: ['business-profile'] });
    },
    onError: (failure: unknown) => {
      setError(
        failure instanceof ApiError ? failure.message : t('marketplace.commissionSaveFailed'),
      );
    },
  });

  const canWrite = can(Permission.SETTINGS_WRITE);

  if (query.isPending) {
    return (
      <Card title={t('marketplace.heading')}>
        <LoadingState label={t('marketplace.loading')} />
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card title={t('marketplace.heading')}>
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      </Card>
    );
  }

  const parsed = basisPointsFromPercent(percent);
  const isDirty = parsed !== null && parsed !== current;

  return (
    <Card title={t('marketplace.heading')} description={t('marketplace.panelDescription')}>
      <form
        className="space-y-4 px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault();

          const basisPoints = basisPointsFromPercent(percent);

          if (basisPoints === null) {
            setError(t('marketplace.commissionOutOfRange'));
            return;
          }

          void save.mutateAsync(basisPoints);
        }}
      >
        {error !== null && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}

        {!canWrite && <Callout tone="neutral">{t('settings.youCanReadTheseSettings')}</Callout>}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[14rem_minmax(0,1fr)] sm:items-start">
          <Field
            label={t('marketplace.standardCommission')}
            hint={t('marketplace.standardCommissionHint')}
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                inputMode="decimal"
                value={percent}
                disabled={!canWrite}
                onChange={(event) => {
                  setIsEdited(true);
                  setError(null);
                  setPercent(event.currentTarget.value);
                }}
              />
            )}
          </Field>

          <p className="max-w-prose text-xs leading-relaxed text-ink-muted sm:pt-7">
            {t('marketplace.commissionExplainer')}
          </p>
        </div>

        <Callout tone="neutral">{t('marketplace.commissionNotRetroactive')}</Callout>

        {canWrite && (
          <div className="flex justify-end">
            <Button type="submit" variant="primary" isLoading={save.isPending} disabled={!isDirty}>
              {t('common.save')}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}
