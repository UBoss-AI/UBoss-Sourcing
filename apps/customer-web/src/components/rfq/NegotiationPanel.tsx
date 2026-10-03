/**
 * Negotiating one quote (Master row 19), for either side.
 *
 * Shows the whole chain of offers, and what this reader may do with the one
 * on the table: accept or reject it when the OTHER side wrote it (and it has
 * not expired), send a counter-offer while the quote is open, and - for the
 * seller - withdraw. Accepting names the terms hash the reader was shown, so
 * terms that changed in between cannot be accepted by accident.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ConfirmDialog } from '@/components/Modal';
import { OfferHistory } from '@/components/rfq/OfferHistory';
import { FinalTermSheet } from '@/components/rfq/FinalTermSheet';
import { useToast } from '@/components/toast-context';
import { Button, Card, Field, Input, Select, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { currencyExponent, formatMoney, majorToMinor, minorToMajor } from '@/lib/format';
import { fromDeadlineInput } from '@/lib/rfq';
import { formatUtc } from '@/lib/rfq-format';
import type { OfferVersion, Quote } from '@/lib/rfq-quote';

const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];

export function NegotiationPanel({
  quote,
  party,
  basePath,
  queryKey,
}: {
  quote: Quote;
  party: 'BUYER' | 'SUPPLIER';
  /** `/rfqs/:id/quotes/:quoteId` for the buyer, `/seller/rfqs/:id/quote` for the seller. */
  basePath: string;
  queryKey: readonly unknown[];
}): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const current = quote.current;
  const open = quote.status === 'OPEN';
  const theirs = current !== null && current.author !== party && current.state === 'PROPOSED';
  const canAnswer = open && theirs && !current.isExpired;
  const exponent = currencyExponent(quote.currency);

  const [confirming, setConfirming] = useState<'accept' | 'reject' | 'withdraw' | null>(null);
  const [acceptSnapshot, setAcceptSnapshot] = useState<{ current: OfferVersion; previous: OfferVersion | null } | null>(null);
  const [note, setNote] = useState('');
  const [values, setValues] = useState<Record<string, string>>(() => ({
    unitPrice: current === null ? '' : minorToMajor(current.terms.unitPriceMinor, exponent),
    quantity: current?.terms.quantity ?? '',
    moq: current?.terms.moq ?? '',
    leadTimeDays: current?.terms.leadTimeDays === null || current === null ? '' : String(current.terms.leadTimeDays),
    incoterm: current?.terms.incoterm ?? '',
    incotermPlace: current?.terms.incotermPlace ?? '',
    paymentTerms: current?.terms.paymentTerms ?? '',
    inspectionTerms: current?.terms.inspectionTerms ?? '',
    comment: '',
    expiresAt: '',
  }));
  const [problem, setProblem] = useState<string | null>(null);

  const done = (message: string): void => {
    toast.success(message);
    setConfirming(null);
    void queryClient.invalidateQueries({ queryKey });
  };
  const failed = (error: unknown): void => {
    toast.error(errorMessage(t, error));
    void queryClient.invalidateQueries({ queryKey });
  };

  const accept = useMutation({
    mutationFn: (shown: OfferVersion) => api.post(`${basePath}/accept`, { versionId: shown.id, termsHash: shown.termsHash }),
    onSuccess: () => {
      done(t('rfq.offer.accepted'));
    },
    onError: failed,
  });
  const reject = useMutation({
    mutationFn: () => api.post(`${basePath}/reject`, { versionId: current?.id, note: note.trim().length === 0 ? null : note.trim() }),
    onSuccess: () => {
      done(t('rfq.offer.rejected'));
    },
    onError: failed,
  });
  const withdraw = useMutation({
    mutationFn: () => api.post(`${basePath}/withdraw`),
    onSuccess: () => {
      done(t('rfq.offer.withdrawn'));
    },
    onError: failed,
  });
  const counter = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(`${basePath}/offers`, body),
    onSuccess: () => {
      done(t('rfq.offer.countered'));
    },
    onError: failed,
  });

  const set = (field: string, value: string): void => {
    setValues((currentValues) => ({ ...currentValues, [field]: value }));
  };
  const orNull = (value: string | undefined): string | null => (value === undefined || value.trim().length === 0 ? null : value.trim());

  const sendCounter = (): void => {
    const unitPriceMinor = majorToMinor(values['unitPrice'] ?? '', exponent);
    const expiresAt = fromDeadlineInput(values['expiresAt'] ?? '');
    if (unitPriceMinor === null || unitPriceMinor === '0') {
      setProblem(t('rfq.fieldError.PRICE'));
      return;
    }
    if (expiresAt === null || new Date(expiresAt).getTime() <= Date.now()) {
      setProblem(t('rfq.offer.expiryNeeded'));
      return;
    }
    setProblem(null);
    const leadTime = orNull(values['leadTimeDays']);
    counter.mutate({
      expectedVersionNumber: quote.currentVersionNumber,
      unitPriceMinor,
      quantity: values['quantity'] ?? '',
      moq: orNull(values['moq']),
      leadTimeDays: leadTime === null ? null : Number.parseInt(leadTime, 10),
      incoterm: orNull(values['incoterm']),
      incotermPlace: orNull(values['incotermPlace']),
      paymentTerms: orNull(values['paymentTerms']),
      inspectionTerms: orNull(values['inspectionTerms']),
      comment: orNull(values['comment']),
      expiresAt,
    });
  };

  const input = (field: string, label: string, type?: string): React.JSX.Element => (
    <Field label={label}>
      {({ inputId }) => (
        <Input
          id={inputId}
          {...(type === undefined ? {} : { type })}
          value={values[field] ?? ''}
          onChange={(event) => {
            set(field, event.target.value);
          }}
        />
      )}
    </Field>
  );

  return (
    <div className="space-y-4">
      {quote.status === 'ACCEPTED' && quote.acceptedTermsHash !== null && (
        <Card title={t('rfq.offer.agreedTitle')} bodyClassName="space-y-1 px-6 py-4 text-sm">
          <p className="text-ink">{t('rfq.offer.agreedBody', { date: formatUtc(quote.acceptedAt, intlLocale) })}</p>
          <p className="break-all font-mono text-xs text-ink-muted">{t('rfq.offer.hash', { hash: quote.acceptedTermsHash })}</p>
          <p className="text-xs text-ink-muted">{t('rfq.offer.poNotBuilt')}</p>
        </Card>
      )}

      {current !== null && (
        <Card title={t('rfq.offer.onTable')} bodyClassName="space-y-3 px-6 py-4">
          <p className="text-sm text-ink">
            {t('rfq.offer.tableSummary', {
              version: String(current.versionNumber),
              price: formatMoney(current.unitPrice),
              quantity: current.terms.quantity,
              expires: formatUtc(current.terms.expiresAt, intlLocale),
            })}
          </p>
          {current.isExpired && <p className="text-sm text-danger">{t('rfq.offer.expiredNote')}</p>}
          {open && !theirs && current.state === 'PROPOSED' && <p className="text-sm text-ink-muted">{t('rfq.offer.waiting')}</p>}
          <div className="flex flex-wrap gap-2">
            {canAnswer && (
              <>
                <Button
                  variant="primary"
                  onClick={() => {
                    const previous = quote.versions.filter(version => version.versionNumber < current.versionNumber).sort((a, b) => b.versionNumber - a.versionNumber)[0] ?? null;
                    setAcceptSnapshot({ current, previous });
                    setConfirming('accept');
                  }}
                >
                  {t('rfq.offer.accept')}
                </Button>
                <Button
                  onClick={() => {
                    setConfirming('reject');
                  }}
                >
                  {t('rfq.offer.reject')}
                </Button>
              </>
            )}
            {open && party === 'SUPPLIER' && (
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirming('withdraw');
                }}
              >
                {t('rfq.offer.withdraw')}
              </Button>
            )}
          </div>
        </Card>
      )}

      {open && (
        <Card title={t('rfq.offer.counterTitle')} description={t('rfq.offer.counterHint')} bodyClassName="space-y-4 px-6 py-4">
          {problem !== null && (
            <p role="alert" className="text-sm text-danger">
              {problem}
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            {input('unitPrice', `${t('rfq.quote.unitPrice')} (${quote.currency})`)}
            {input('quantity', t('rfq.field.quantity'))}
            {input('moq', t('rfq.compare.row.moq'))}
            {input('leadTimeDays', t('rfq.quote.leadTimeDays'))}
            <Field label={t('rfq.field.incoterm')}>
              {({ inputId }) => (
                <Select
                  id={inputId}
                  value={values['incoterm']}
                  onChange={(event) => {
                    set('incoterm', event.target.value);
                  }}
                >
                  <option value="">—</option>
                  {INCOTERMS.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {input('incotermPlace', t('rfq.quote.incotermPlace'))}
            {input('expiresAt', t('rfq.quote.validUntil'), 'datetime-local')}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {input('paymentTerms', t('rfq.compare.row.payment'))}
            {input('inspectionTerms', t('rfq.compare.row.inspection'))}
          </div>
          <Field label={t('rfq.quote.comment')}>
            {({ inputId }) => (
              <Textarea
                id={inputId}
                rows={2}
                maxLength={2000}
                value={values['comment'] ?? ''}
                onChange={(event) => {
                  set('comment', event.target.value);
                }}
              />
            )}
          </Field>
          <Button variant="primary" isLoading={counter.isPending} onClick={sendCounter}>
            {t('rfq.offer.sendCounter')}
          </Button>
        </Card>
      )}

      <Card title={t('rfq.offer.historyTitle')} bodyClassName="px-6 py-4">
        <OfferHistory versions={quote.versions} reader={party} />
      </Card>

      <ConfirmDialog
        isOpen={confirming !== null}
        onClose={() => {
          setConfirming(null);
        }}
        onConfirm={() => {
          if (confirming === 'accept' && acceptSnapshot !== null) {
            if (!canAnswer || current.id !== acceptSnapshot.current.id || current.termsHash !== acceptSnapshot.current.termsHash) {
              toast.error(t('rfq.offer.summaryStale'));
              setConfirming(null);
              void queryClient.invalidateQueries({ queryKey });
              return;
            }
            accept.mutate(acceptSnapshot.current);
          }
          if (confirming === 'reject') reject.mutate();
          if (confirming === 'withdraw') withdraw.mutate();
        }}
        title={
          confirming === 'accept'
            ? t('rfq.offer.acceptTitle')
            : confirming === 'reject'
              ? t('rfq.offer.rejectTitle')
              : t('rfq.offer.withdrawTitle')
        }
        body={
          confirming === 'reject' ? (
            <label className="block text-sm font-medium text-ink">
              {t('rfq.offer.rejectNote')}
              <Textarea
                className="mt-1"
                rows={2}
                maxLength={1000}
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                }}
              />
            </label>
          ) : confirming === 'accept' ? (
            <div className="space-y-4">
              {acceptSnapshot !== null && <FinalTermSheet current={acceptSnapshot.current} previous={acceptSnapshot.previous} />}
              <p>{t('rfq.offer.acceptBody')}</p>
            </div>
          ) : (
            t('rfq.offer.withdrawBody')
          )
        }
        confirmLabel={
          confirming === 'accept' ? t('rfq.offer.accept') : confirming === 'reject' ? t('rfq.offer.reject') : t('rfq.offer.withdraw')
        }
        isDangerous={confirming !== 'accept'}
        isWorking={accept.isPending || reject.isPending || withdraw.isPending}
      />
    </div>
  );
}
