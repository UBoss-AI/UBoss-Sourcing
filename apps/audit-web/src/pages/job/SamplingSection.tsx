/**
 * The sampling record: which lot, how many units were opened, how many were
 * accepted and rejected against the plan, and how many cartons.
 *
 * These are counts of SAMPLED units. They say nothing about how many units
 * of the lot were verified - that is the quantity reconciliation, kept apart.
 */
import { useState } from 'react';
import { MutationError } from '@/components/console';
import { Button, Callout, Card, Field, Input, SummaryTiles } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { consoleKeys, recordSampling } from '@/lib/console-api';
import { formatNumber } from '@/lib/format';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import type { SectionProps } from './types';
import { wholeNumber } from './workspace-mode';

export function SamplingSection({ detail, jobId, mode }: SectionProps): React.JSX.Element {
  const { t } = useI18n();
  const record = detail.job.samplingRecord;
  const recorded = record !== null && record.sampledQuantity !== null;

  const [lot, setLot] = useState(record?.lotReference ?? '');
  const [sampled, setSampled] = useState(record?.sampledQuantity === null || record === null ? '' : String(record.sampledQuantity));
  const [accepted, setAccepted] = useState(record?.acceptedQuantity === null || record === null ? '' : String(record.acceptedQuantity));
  const [rejected, setRejected] = useState(record?.rejectedQuantity === null || record === null ? '' : String(record.rejectedQuantity));
  const [cartons, setCartons] = useState(record?.cartonsOpened === null || record === null ? '' : String(record.cartonsOpened));

  const save = useConsoleMutation({
    mutationFn: (_vars, key) =>
      recordSampling(
        jobId,
        {
          lotReference: lot.trim(),
          sampledQuantity: wholeNumber(sampled) ?? 0,
          acceptedQuantity: wholeNumber(accepted) ?? 0,
          rejectedQuantity: wholeNumber(rejected) ?? 0,
          cartonsOpened: cartons.trim() === '' ? null : wholeNumber(cartons),
        },
        key,
      ),
    invalidate: [consoleKeys.job(jobId)],
    successMessage: t('job.sampling.saved'),
  });

  const sampledN = wholeNumber(sampled);
  const acceptedN = wholeNumber(accepted);
  const rejectedN = wholeNumber(rejected);
  const cartonsOk = cartons.trim() === '' || wholeNumber(cartons) !== null;
  const addsUp = sampledN !== null && acceptedN !== null && rejectedN !== null && acceptedN + rejectedN <= sampledN;
  const valid = lot.trim() !== '' && sampledN !== null && sampledN >= 1 && addsUp && cartonsOk;

  const numberField = (label: string, value: string, set: (value: string) => void, required: boolean): React.JSX.Element => (
    <Field label={label} required={required}>
      {({ inputId, describedBy }) => (
        <Input
          id={inputId}
          aria-describedby={describedBy}
          inputMode="numeric"
          pattern="[0-9]*"
          value={value}
          invalid={value.trim() !== '' && wholeNumber(value) === null}
          onChange={(event) => {
            set(event.target.value);
          }}
        />
      )}
    </Field>
  );

  return (
    <Card title={t('job.sampling.title')} description={t('job.sampling.description')} bodyClassName="px-5 py-4 space-y-4">
      {recorded ? (
        <>
          <p className="text-sm text-ink">{t('job.sampling.lot', { lot: record.lotReference ?? '—' })}</p>
          <SummaryTiles
            items={[
              { label: t('job.sampling.sampled'), value: formatNumber(record.sampledQuantity) },
              { label: t('job.sampling.accepted'), value: formatNumber(record.acceptedQuantity), tone: 'success' },
              {
                label: t('job.sampling.rejected'),
                value: formatNumber(record.rejectedQuantity),
                tone: (record.rejectedQuantity ?? 0) > 0 ? 'danger' : 'default',
              },
              { label: t('job.sampling.cartons'), value: formatNumber(record.cartonsOpened) },
            ]}
          />
          <p className="text-xs leading-relaxed text-ink-muted">{t('job.sampling.notVerifiedUnits')}</p>
        </>
      ) : (
        !mode.performing && <p className="text-sm text-ink-muted">{t('job.sampling.none')}</p>
      )}

      {mode.performing && (
        <form
          className="space-y-3 border-t border-border-subtle pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <Field label={t('job.sampling.lotReference')} required>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                value={lot}
                maxLength={120}
                onChange={(event) => {
                  setLot(event.target.value);
                }}
              />
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {numberField(t('job.sampling.sampled'), sampled, setSampled, true)}
            {numberField(t('job.sampling.accepted'), accepted, setAccepted, true)}
            {numberField(t('job.sampling.rejected'), rejected, setRejected, true)}
            {numberField(t('job.sampling.cartons'), cartons, setCartons, false)}
          </div>
          {sampledN !== null && acceptedN !== null && rejectedN !== null && !addsUp && (
            <Callout tone="warning" role="status">
              {t('job.sampling.doesNotAddUp')}
            </Callout>
          )}
          <MutationError error={save.error} />
          <Button type="submit" variant="primary" isLoading={save.isPending} disabled={!valid}>
            {recorded ? t('job.sampling.update') : t('job.sampling.save')}
          </Button>
        </form>
      )}
    </Card>
  );
}
