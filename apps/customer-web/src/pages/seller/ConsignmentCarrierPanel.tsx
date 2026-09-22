/**
 * Choosing who carries one consignment.
 *
 * The seller's half of the fulfilment split, at the moment it is actually
 * used: a paid order is on screen, a consignment has been raised for it, and
 * somebody has to decide who collects it.
 *
 * WHY THE INELIGIBLE CARRIERS ARE LISTED TOO
 *
 * A seller staring at an empty dropdown cannot tell whether they have no
 * carriers at all, their one carrier is paused, or it does not reach the
 * destination — and those are three different next actions. So every carrier
 * the seller has an arrangement with is listed, the ones that cannot take
 * this consignment are disabled, and each disabled one says why in its own
 * words. This is the same list the server will accept: it is built by the
 * same function, so a choice shown as available cannot be refused, and a
 * choice shown as unavailable cannot be smuggled through by editing the page.
 *
 * WHAT IS NOT HERE
 *
 * Drivers. A seller does not pick one, cannot see the carrier's fleet, and
 * has no route that would let them. Once the carrier accepts, the driver is
 * their decision and appears here only as a name on the consignment.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Field, Input, Select } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { assignSellerCarrier, fetchCarrierOptions } from '@/lib/seller';

export interface SellerConsignment {
  id: string;
  reference: string;
  status: string;
  trackingNumber: string | null;
  carrierId: string | null;
  carrierName: string | null;
}

/** States past which a consignment is finished and cannot be reassigned. */
const TERMINAL = new Set(['DELIVERED', 'CANCELLED', 'RETURNED', 'LOST', 'DESTROYED']);

export function ConsignmentCarrierPanel({
  consignment,
}: {
  consignment: SellerConsignment;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const [chosen, setChosen] = useState('');
  const [reason, setReason] = useState('');

  const isFinished = TERMINAL.has(consignment.status);

  const options = useQuery({
    queryKey: ['seller', 'carrier-options', consignment.id],
    queryFn: () => fetchCarrierOptions(consignment.id),
    // Nothing to choose once it is finished, and asking would be a request per
    // consignment on a page that may show several.
    enabled: !isFinished,
  });

  const assign = useMutation({
    mutationFn: () =>
      assignSellerCarrier({
        shipmentId: consignment.id,
        logisticsPartnerId: chosen,
        reason: reason.trim() === '' ? null : reason.trim(),
      }),
    onSuccess: async () => {
      setChosen('');
      setReason('');
      toast.success(t('sellerConsignment.carrierSent'));
      await client.invalidateQueries({ queryKey: ['seller', 'orders'] });
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerConsignment.carrierFailed')));
    },
  });

  const available = (options.data ?? []).filter((option) => option.isEligible);
  const blocked = (options.data ?? []).filter((option) => !option.isEligible);

  // A carrier already holds it, and the seller is choosing a different one.
  // The server demands a reason for exactly this case, so the field appears
  // for exactly this case.
  const isReassigning = consignment.carrierId !== null && chosen !== consignment.carrierId;

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium text-ink">{consignment.reference}</p>
        <Badge tone="neutral">{consignment.status}</Badge>
      </div>

      {consignment.carrierName !== null && (
        <p className="mt-1 text-sm text-ink-muted">
          {t('sellerConsignment.carrierAssigned', { carrier: consignment.carrierName })}
        </p>
      )}

      {isFinished ? null : (
        <div className="mt-4 space-y-3">
          {options.isPending && (
            <p className="text-xs text-ink-muted">{t('sellerConsignment.carrierLoading')}</p>
          )}

          {options.isSuccess && available.length === 0 && (
            <p className="text-sm text-ink-muted">
              {t('sellerConsignment.carrierNone')}{' '}
              <Link to="/seller/carriers" className="underline">
                {t('sellerCarriers.title')}
              </Link>
            </p>
          )}

          {available.length > 0 && (
            <>
              <Field label={t('sellerConsignment.carrierChoose')}>
                {({ inputId, describedBy }) => (
                  <Select
                    id={inputId}
                    aria-describedby={describedBy}
                    value={chosen}
                    disabled={assign.isPending}
                    onChange={(event) => {
                      setChosen(event.target.value);
                    }}
                  >
                    <option value="">{t('sellerConsignment.carrierChoose')}</option>
                    {available.map((option) => (
                      <option key={option.logisticsPartnerId} value={option.logisticsPartnerId}>
                        {option.displayName}
                      </option>
                    ))}
                    {/* Listed and disabled rather than hidden, each with the
                        reason it cannot take this one. */}
                    {blocked.map((option) => (
                      <option key={option.logisticsPartnerId} value="" disabled>
                        {option.displayName} — {option.reason ?? ''}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              {isReassigning && chosen !== '' && (
                <Field
                  label={t('sellerConsignment.carrierReasonLabel')}
                  hint={t('sellerConsignment.carrierReasonHint')}
                >
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      value={reason}
                      disabled={assign.isPending}
                      onChange={(event) => {
                        setReason(event.target.value);
                      }}
                    />
                  )}
                </Field>
              )}

              <Button
                variant="primary"
                disabled={
                  assign.isPending ||
                  chosen === '' ||
                  (isReassigning && reason.trim().length === 0)
                }
                onClick={() => {
                  assign.mutate();
                }}
              >
                {assign.isPending
                  ? t('sellerConsignment.carrierSending')
                  : t('sellerConsignment.carrierSend')}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
