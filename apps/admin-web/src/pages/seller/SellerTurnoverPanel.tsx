/**
 * The seller's declared annual turnover, for the person reviewing the
 * application (the turnover eligibility policy, `SELLER_TURNOVER_*`).
 *
 * Three facts, kept visibly apart: what the seller DECLARED (amount, year,
 * when, under which policy version), whether a member of staff has VERIFIED
 * it, and - elsewhere on this page - whether the seller is APPROVED. Recording
 * "verified" here never approves anybody; it only clears one item on the
 * approval checklist.
 *
 * Read-only here: verifying turnover is seller verification, which the Audit
 * Team does in the Audit Console (its copy of this panel has the form).
 *
 * The figure is shown exactly: minor units formatted from a decimal string,
 * never through a float, so the reviewer compares the number the seller typed
 * with the number in the evidence.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, DescriptionList } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import {
  createSellerDocumentLink,
  fetchSellerTurnover,
  type SellerTurnoverDeclaration,
  type SellerTurnoverReview,
} from '@/lib/sellers';

const STATE_TONE: Record<SellerTurnoverDeclaration['verificationState'], BadgeTone> = {
  NOT_STARTED: 'neutral',
  AWAITING_INPUT: 'warning',
  IN_PROGRESS: 'brand',
  VERIFIED: 'success',
  FAILED: 'danger',
  PROVIDER_UNCONFIGURED: 'neutral',
  EXPIRED: 'warning',
};

/** Exact: "₹3,00,00,00,000.01" from "30000000001" paise. */
function exactAmount(minor: string, currency: string, exponent: number): string {
  const digits = minor.padStart(exponent + 1, '0');
  const major = exponent === 0 ? digits : `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: exponent,
  }).format(major as unknown as number);
}

/** "30.000000001" crore, exactly, for INR. */
function croreOf(minor: string, exponent: number): string {
  const scale = 7 + exponent;
  const digits = minor.padStart(scale + 1, '0');
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  const whole = digits.slice(0, -scale);
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

function period(start: string, end: string): string {
  const format = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `${format.format(new Date(`${start}T00:00:00Z`))} – ${format.format(new Date(`${end}T00:00:00Z`))}`;
}

export function SellerTurnoverPanel({ sellerAccountId }: { sellerAccountId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ['admin', 'seller', sellerAccountId, 'turnover'],
    queryFn: () => fetchSellerTurnover(sellerAccountId),
  });

  if (query.isPending) return null;
  if (query.isError) {
    return (
      <Card title={t('sellerReview.turnover.title')}>
        <div className="px-5 py-4">
          <Callout tone="danger" title={t('sellerReview.turnover.loadFailed')}>
            <p className="text-sm">{errorMessage(t, query.error, t('sellerReview.turnover.loadFailed'))}</p>
          </Callout>
        </div>
      </Card>
    );
  }
  return <Loaded review={query.data} />;
}

function Loaded({ review }: { review: SellerTurnoverReview }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const { policy, current } = review;

  const open = useMutation({
    mutationFn: createSellerDocumentLink,
    onSuccess: (link) => {
      window.open(link.url, '_blank', 'noopener,noreferrer');
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerReview.turnover.openFailed')));
    },
  });

  const minimum = exactAmount(policy.minimumMinor, policy.currency, policy.currencyExponent);

  return (
    <Card
      title={t('sellerReview.turnover.title')}
      description={t('sellerReview.turnover.description', { minimum, version: policy.policyVersion })}
    >
      <div className="space-y-4 px-5 py-4">
        {!review.applies && (
          <Callout tone="info" title={t('sellerReview.turnover.notApplicableTitle')}>
            <p className="text-sm">
              {review.grandfathered ? t('sellerReview.turnover.grandfathered') : t('sellerReview.turnover.policyOff')}
            </p>
          </Callout>
        )}

        {current === null ? (
          <p className="text-sm text-ink-muted">{t('sellerReview.turnover.none')}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={current.exceedsMinimum ? 'success' : 'danger'}>
                {current.exceedsMinimum ? t('sellerReview.turnover.exceeds') : t('sellerReview.turnover.doesNotExceed')}
              </Badge>
              <Badge tone={STATE_TONE[current.verificationState]}>
                {t(`sellerReview.turnover.state.${current.verificationState}` as TranslationKey)}
              </Badge>
              {review.standing === 'OUT_OF_DATE' && (
                <Badge tone="warning">{t('sellerReview.turnover.outOfDate')}</Badge>
              )}
            </div>

            <DescriptionList
              items={[
                {
                  label: t('sellerReview.turnover.amount'),
                  value:
                    current.currency === 'INR'
                      ? t('sellerReview.turnover.amountWithCrore', {
                          amount: exactAmount(current.amountMinor, current.currency, policy.currencyExponent),
                          crore: croreOf(current.amountMinor, policy.currencyExponent),
                        })
                      : exactAmount(current.amountMinor, current.currency, policy.currencyExponent),
                },
                { label: t('sellerReview.turnover.year'), value: period(current.financialYearStart, current.financialYearEnd) },
                {
                  label: t('sellerReview.turnover.minimumAtDeclaration'),
                  value: exactAmount(current.minimumMinor, current.currency, policy.currencyExponent),
                },
                { label: t('sellerReview.turnover.policyVersion'), value: current.policyVersion },
                { label: t('sellerReview.turnover.declaredAt'), value: formatDateTime(current.declaredAt) },
                ...(current.reviewedAt === null
                  ? []
                  : [
                      {
                        label: t('sellerReview.turnover.reviewed'),
                        value: t('sellerReview.turnover.reviewedBy', {
                          who: current.reviewedBy ?? '—',
                          when: formatDateTime(current.reviewedAt),
                        }),
                      },
                    ]),
                ...(current.decisionReason === null
                  ? []
                  : [{ label: t('sellerReview.turnover.reason'), value: current.decisionReason }]),
                ...(current.internalNote === null
                  ? []
                  : [{ label: t('sellerReview.turnover.internalNote'), value: current.internalNote }]),
              ]}
            />
          </>
        )}

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">
            {t('sellerReview.turnover.evidence')}
          </h3>
          {review.evidence.length === 0 ? (
            <p className="mt-1 text-sm text-ink-muted">{t('sellerReview.turnover.noEvidence')}</p>
          ) : (
            <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
              {review.evidence.map((document) => (
                <li key={document.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1 break-words text-sm text-ink">{document.originalFileName}</span>
                  {!document.isCurrent && <Badge tone="neutral">{t('sellerReview.turnover.replaced')}</Badge>}
                  <span className="text-xs text-ink-muted">{formatDateTime(document.uploadedAt)}</span>
                  {document.isCurrent && (
                    <Button
                      size="sm"
                      variant="secondary"
                      isLoading={open.isPending && open.variables === document.id}
                      onClick={() => {
                        open.mutate(document.id);
                      }}
                    >
                      {t('sellerReview.turnover.open')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>


        {review.history.length > 0 && (
          <details className="rounded-lg border border-border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium text-ink">
              {t('sellerReview.turnover.history', { total: String(review.history.length) })}
            </summary>
            <ul className="mt-2 space-y-2">
              {review.history.map((row) => (
                <li key={row.id} className="text-xs text-ink-muted">
                  <span className="font-medium text-ink">
                    {exactAmount(row.amountMinor, row.currency, policy.currencyExponent)}
                  </span>{' '}
                  · {period(row.financialYearStart, row.financialYearEnd)} ·{' '}
                  {t(`sellerReview.turnover.state.${row.verificationState}` as TranslationKey)}
                  {row.reviewedBy !== null && ` · ${row.reviewedBy}`}
                  {row.supersededReason !== null &&
                    ` · ${t(`sellerReview.turnover.superseded.${row.supersededReason}` as TranslationKey, { defaultValue: row.supersededReason })}`}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Card>
  );
}

