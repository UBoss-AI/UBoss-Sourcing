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
 * The Audit Panel's copy of the Admin Panel's panel, with the decision form:
 * verifying turnover is part of seller verification, which the Audit Team
 * owns. The review comes with the application rather than from a second
 * request, so the two can never disagree about which declaration is current.
 *
 * The figure is shown exactly: minor units formatted from a decimal string,
 * never through a float, so the reviewer compares the number the seller typed
 * with the number in the evidence.
 */
import { useState } from 'react';
import { useSession } from '@/auth/session-context';
import { DownloadButton, MutationError } from '@/components/console';
import { Badge, Button, Callout, Card, DescriptionList, Field, Select, Textarea } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import {
  decideTurnover,
  documentFilePath,
  verificationKeys,
  type SellerTurnoverDeclaration,
  type SellerTurnoverReview,
  type TurnoverVerificationState,
} from '@/lib/seller-verification';
import { useConsoleMutation } from '@/lib/use-console-mutation';

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

export function TurnoverPanel({
  sellerAccountId,
  review,
}: {
  sellerAccountId: string;
  review: SellerTurnoverReview;
}): React.JSX.Element {
  return <Loaded sellerAccountId={sellerAccountId} review={review} />;
}

function Loaded({ sellerAccountId, review }: { sellerAccountId: string; review: SellerTurnoverReview }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const canDecide = can(Permission.SELLER_VERIFY);
  const { policy, current } = review;

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
                    <DownloadButton
                      path={documentFilePath(document.id)}
                      fileName={document.originalFileName}
                      label={t('sellerReview.turnover.open')}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {canDecide && current !== null && (
          <DecisionForm sellerAccountId={sellerAccountId} declarationId={current.id} seenState={current.verificationState} />
        )}

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

function DecisionForm({
  sellerAccountId,
  declarationId,
  seenState,
}: {
  sellerAccountId: string;
  declarationId: string;
  /** The state on screen. A declaration decided by somebody else meanwhile is refused. */
  seenState: TurnoverVerificationState;
}): React.JSX.Element {
  const { t } = useI18n();
  const [decision, setDecision] = useState<'VERIFIED' | 'FAILED' | ''>('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);

  const mutation = useConsoleMutation({
    mutationFn: (_: undefined, key) =>
      decideTurnover(
        sellerAccountId,
        {
          declarationId,
          decision: decision as 'VERIFIED' | 'FAILED',
          reason: reason.trim(),
          internalNote: note.trim().length === 0 ? null : note.trim(),
          expectedVerificationState: seenState,
        },
        key,
      ),
    // The approval checklist reads the same verification.
    invalidate: [verificationKeys.detail(sellerAccountId), verificationKeys.all],
    successMessage: t('sellerReview.turnover.decided'),
    onSuccess: () => {
      setDecision('');
      setReason('');
      setNote('');
      setTried(false);
    },
  });

  const decisionError = tried && decision === '' ? t('sellerReview.turnover.decisionRequired') : undefined;
  const reasonError = tried && reason.trim().length < 3 ? t('sellerReview.turnover.reasonRequired') : undefined;

  return (
    <form
      className="space-y-3 rounded-lg border border-border px-3 py-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setTried(true);
        if (decision === '' || reason.trim().length < 3) return;
        mutation.mutate(undefined);
      }}
    >
      <p className="text-sm font-medium text-ink">{t('sellerReview.turnover.decide')}</p>
      <p className="text-xs text-ink-muted">{t('sellerReview.turnover.decideNote')}</p>
      <Field label={t('sellerReview.turnover.decision')} error={decisionError} required>
        {({ inputId, describedBy }) => (
          <Select
            id={inputId}
            aria-describedby={describedBy}
            value={decision}
            onChange={(event) => {
              setDecision(event.currentTarget.value as 'VERIFIED' | 'FAILED' | '');
            }}
          >
            <option value="">{t('sellerReview.turnover.chooseDecision')}</option>
            <option value="VERIFIED">{t('sellerReview.turnover.verify')}</option>
            <option value="FAILED">{t('sellerReview.turnover.refuse')}</option>
          </Select>
        )}
      </Field>
      <Field label={t('sellerReview.turnover.reasonLabel')} hint={t('sellerReview.turnover.reasonHint')} error={reasonError} required>
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            value={reason}
            maxLength={4000}
            onChange={(event) => {
              setReason(event.currentTarget.value);
            }}
          />
        )}
      </Field>
      <Field label={t('sellerReview.turnover.noteLabel')} hint={t('sellerReview.turnover.noteHint')}>
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            value={note}
            maxLength={4000}
            onChange={(event) => {
              setNote(event.currentTarget.value);
            }}
          />
        )}
      </Field>
      {mutation.isError && <MutationError error={mutation.error} />}
      <Button type="submit" size="sm" isLoading={mutation.isPending}>
        {t('sellerReview.turnover.record')}
      </Button>
    </form>
  );
}
