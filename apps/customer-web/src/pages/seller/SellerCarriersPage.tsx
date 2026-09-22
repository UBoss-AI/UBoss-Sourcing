/**
 * The haulage companies this seller may hand a parcel to.
 *
 * THE SPLIT THIS PAGE IS ONE HALF OF
 *
 *   A seller chooses a CARRIER for their own paid consignment.
 *   A carrier chooses a DRIVER for the consignments it has accepted.
 *
 * So there is nothing about drivers on this page, and there is no route that
 * would let one be added. Who drives for a haulage company is that company's
 * own business - their staff, their rota, their problem when somebody calls in
 * sick - and a seller who could put a name on a van could strand one.
 *
 * WHY REFUSED AND ENDED ARRANGEMENTS ARE STILL LISTED
 *
 * A seller who cannot see that their request was refused three weeks ago
 * simply asks again, and the marketplace's approvals queue fills with
 * duplicates of a decision somebody already made. The reason is shown with it,
 * because "no" without "why" is a support ticket.
 *
 * A seller cannot approve their own request. Asking puts it in front of the
 * marketplace and nothing more; the page says so rather than leaving somebody
 * refreshing.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
} from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import {
  fetchSellerCarriers,
  requestSellerCarrier,
  type SellerCarrier,
  type SellerCarrierStatus,
} from '@/lib/seller';

const STATUS_TONES: Record<SellerCarrierStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  REQUESTED: 'neutral',
  APPROVED: 'success',
  SUSPENDED: 'warning',
  REJECTED: 'danger',
  ENDED: 'neutral',
};

export function SellerCarriersPage(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const [partnerId, setPartnerId] = useState('');
  const [reference, setReference] = useState('');

  const query = useQuery({
    queryKey: ['seller', 'carriers'],
    queryFn: fetchSellerCarriers,
  });

  const request = useMutation({
    mutationFn: () =>
      requestSellerCarrier({
        logisticsPartnerId: partnerId.trim(),
        sellerReference: reference.trim() === '' ? null : reference.trim(),
      }),
    onSuccess: async () => {
      setPartnerId('');
      setReference('');
      toast.success(t('sellerCarriers.requested'));
      await client.invalidateQueries({ queryKey: ['seller', 'carriers'] });
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerCarriers.requestFailed')));
    },
  });

  const carriers = query.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('sellerCarriers.title')}
        description={t('sellerCarriers.description')}
      />

      <Card>
        <p className="text-sm leading-relaxed text-ink-muted">{t('sellerCarriers.split')}</p>
      </Card>

      {query.isPending && <LoadingState label={t('sellerCarriers.loading')} />}

      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}

      {query.isSuccess && carriers.length === 0 && (
        <EmptyState
          title={t('sellerCarriers.emptyTitle')}
          description={t('sellerCarriers.emptyBody')}
        />
      )}

      {carriers.length > 0 && (
        <Card title={t('sellerCarriers.listHeading')}>
          <ul className="divide-y divide-border-subtle">
            {carriers.map((carrier) => (
              <li key={carrier.linkId} className="py-4 first:pt-0 last:pb-0">
                <CarrierRow carrier={carrier} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/*
       * Asking for a new one.
       *
       * A code rather than a picker, deliberately. The marketplace's full
       * carrier list is not a seller's to browse - a dropdown of every haulage
       * company the business works with would disclose its commercial
       * relationships to every seller on the platform - so a seller asks for
       * the one they have been given a reference for, and the server answers a
       * carrier that does not exist exactly as it answers one they are simply
       * not linked to.
       */}
      <Card title={t('sellerCarriers.addHeading')} description={t('sellerCarriers.addHint')}>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (partnerId.trim().length === 0) return;
            request.mutate();
          }}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label={t('sellerCarriers.partnerIdLabel')}
              hint={t('sellerCarriers.partnerIdHint')}
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={partnerId}
                  disabled={request.isPending}
                  onChange={(event) => {
                    setPartnerId(event.target.value);
                  }}
                />
              )}
            </Field>

            <Field
              label={t('sellerCarriers.referenceLabel')}
              hint={t('sellerCarriers.referenceHint')}
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={reference}
                  disabled={request.isPending}
                  onChange={(event) => {
                    setReference(event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          <Button
            type="submit"
            variant="primary"
            disabled={request.isPending || partnerId.trim().length === 0}
          >
            {request.isPending ? t('sellerCarriers.requesting') : t('sellerCarriers.request')}
          </Button>
        </form>
      </Card>
    </div>
  );
}

function CarrierRow({ carrier }: { carrier: SellerCarrier }): React.JSX.Element {
  // Its own hook call rather than a `t` prop: passing a translator down means
  // typing it, and the honest type for a function that takes a template-built
  // key is one that defeats the key checking this project relies on.
  const { t, intlLocale } = useI18n();

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-ink">{carrier.displayName}</span>
          <Badge tone={STATUS_TONES[carrier.status]}>
            {t(`sellerCarriers.status.${carrier.status}`)}
          </Badge>
        </p>

        <p className="mt-1 text-xs text-ink-muted">
          {t('sellerCarriers.code', { code: carrier.partnerCode })}
          {carrier.sellerReference !== null && (
            <>
              {' · '}
              {t('sellerCarriers.yourReference', { reference: carrier.sellerReference })}
            </>
          )}
        </p>

        {/* What the arrangement narrows to, where it narrows anything. Absent
            means "wherever the carrier itself goes", which is the common case
            and does not need saying. */}
        {carrier.serviceCountries !== null && carrier.serviceCountries.length > 0 && (
          <p className="mt-1 text-xs text-ink-muted">
            {t('sellerCarriers.countries', {
              countries: carrier.serviceCountries.join(', '),
            })}
          </p>
        )}

        {carrier.statusReason !== null && (
          <p className="mt-1 max-w-prose text-xs text-ink">{carrier.statusReason}</p>
        )}
      </div>

      <p className="shrink-0 text-xs text-ink-subtle">
        {carrier.decidedAt === null
          ? t('sellerCarriers.requestedOn', {
              date: new Date(carrier.requestedAt).toLocaleDateString(intlLocale),
            })
          : t('sellerCarriers.decidedOn', {
              date: new Date(carrier.decidedAt).toLocaleDateString(intlLocale),
            })}
      </p>
    </div>
  );
}
