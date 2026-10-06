/**
 * Laboratory samples taken on this job: the seal, the chain of custody from
 * the site to the laboratory, and the laboratory's result.
 *
 * A laboratory result is a statement about the sample tested - it is never
 * presented as a count of verified units. The named inspector adds samples,
 * hand-overs and results while the job is in progress; everyone else reads.
 */
import { useState, type SyntheticEvent } from 'react';
import { Button, Card, DescriptionList, Field, Input, Select, Textarea } from '@/components/ui';
import { Modal } from '@/components/Modal';
import { DownloadButton, MutationError } from '@/components/console';
import { useI18n } from '@/i18n/i18n-context';
import { ApiError } from '@/lib/api';
import {
  addCustodyEvent,
  addLabSample,
  consoleKeys,
  evidencePath,
  recordLabResult,
  type LabSampleInput,
} from '@/lib/console-api';
import { QUANTITY_UNITS, type LabSample } from '@/lib/console-types';
import { enumLabel } from '@/lib/enum-labels';
import { formatDateTime, formatQuantity } from '@/lib/format';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import { EvidenceSelect } from './EvidenceSelect';
import { custodyOf, localInputToIso } from './lab-custody';
import { DECIMAL_PATTERN } from './quantity-math';
import type { SectionProps } from './types';

type Dialog = { kind: 'custody'; sample: LabSample } | { kind: 'result'; sample: LabSample } | null;

export function LabSamplesSection({ detail, jobId, mode }: SectionProps): React.JSX.Element {
  const { t } = useI18n();
  const samples = detail.extras.labSamples;
  const [adding, setAdding] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const evidenceName = new Map(detail.job.evidence.map((item) => [item.id, item.fileName]));

  return (
    <div id="lab-samples" className="scroll-mt-24">
      <Card
        title={t('job.lab.title')}
        description={t('job.lab.description')}
        actions={
          mode.performing && !adding ? (
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setAdding(true);
              }}
            >
              {t('job.lab.add')}
            </Button>
          ) : undefined
        }
        bodyClassName="space-y-5 px-5 py-4"
      >
        {adding && mode.performing && (
          <SampleForm
            jobId={jobId}
            onDone={() => {
              setAdding(false);
            }}
          />
        )}

        {samples.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('job.lab.none')}</p>
        ) : (
          <ul className="space-y-4">
            {samples.map((sample) => {
              const custody = custodyOf(sample.custody);
              return (
                <li key={sample.id} className="rounded-md border border-border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-semibold text-ink">{sample.sampleCode}</p>
                      <p className="mt-0.5 whitespace-pre-line break-words text-sm text-ink">{sample.description}</p>
                    </div>
                    {mode.performing && (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          onClick={() => {
                            setDialog({ kind: 'custody', sample });
                          }}
                        >
                          {t('job.lab.addHandOver')}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => {
                            setDialog({ kind: 'result', sample });
                          }}
                        >
                          {t('job.lab.recordResult')}
                        </Button>
                      </div>
                    )}
                  </div>

                  <DescriptionList
                    className="mt-3"
                    columns={3}
                    items={[
                      {
                        label: t('job.lab.quantity'),
                        value:
                          sample.quantity === null
                            ? t('common.notRecorded')
                            : `${formatQuantity(sample.quantity)} ${sample.unit === null ? '' : enumLabel(t, 'unit', sample.unit)}`,
                      },
                      { label: t('job.lab.seal'), value: sample.sealNumber ?? t('common.notRecorded') },
                      { label: t('job.lab.takenAt'), value: formatDateTime(sample.takenAt) },
                      {
                        label: t('job.lab.laboratory'),
                        value:
                          sample.laboratoryName === null ? (
                            t('common.notRecorded')
                          ) : (
                            <>
                              {sample.laboratoryName}
                              {sample.laboratoryAccreditation !== null && (
                                <span className="block text-xs text-ink-muted">
                                  {t('job.lab.accreditationValue', { accreditation: sample.laboratoryAccreditation })}
                                </span>
                              )}
                            </>
                          ),
                      },
                    ]}
                  />

                  <div className="mt-4">
                    <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{t('job.lab.custody')}</p>
                    {custody.length === 0 ? (
                      <p className="mt-1 text-sm text-ink-muted">{t('job.lab.noCustody')}</p>
                    ) : (
                      <ol className="mt-2 space-y-2 border-l border-border-subtle pl-4">
                        {custody.map((event, index) => (
                          <li key={`${event.at}-${String(index)}`} className="text-sm">
                            <p className="text-ink">{t('job.lab.handOver', { from: event.from, to: event.to })}</p>
                            <p className="text-xs text-ink-muted">
                              <time dateTime={event.at}>{formatDateTime(event.at)}</time>
                              {event.note !== null && event.note !== '' && <> · {event.note}</>}
                            </p>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>

                  <div className="mt-4">
                    <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{t('job.lab.result')}</p>
                    {sample.resultSummary === null ? (
                      <p className="mt-1 text-sm text-ink-muted">{t('job.lab.noResult')}</p>
                    ) : (
                      <>
                        <p className="mt-1 whitespace-pre-line text-sm text-ink">{sample.resultSummary}</p>
                        <p className="mt-1 text-xs text-ink-muted">{t('job.lab.resultNote')}</p>
                      </>
                    )}
                    {sample.labReportEvidenceId !== null && (
                      <div className="mt-2">
                        <DownloadButton
                          path={evidencePath(sample.labReportEvidenceId)}
                          fileName={evidenceName.get(sample.labReportEvidenceId) ?? `${sample.sampleCode}-lab-report`}
                          label={t('job.lab.downloadReport')}
                        />
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {dialog?.kind === 'custody' && (
        <CustodyDialog
          jobId={jobId}
          sample={dialog.sample}
          onClose={() => {
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === 'result' && (
        <ResultDialog
          detail={detail}
          jobId={jobId}
          sample={dialog.sample}
          onClose={() => {
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

function SampleForm({ jobId, onDone }: { jobId: string; onDone: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const [form, setForm] = useState({
    sampleCode: '',
    description: '',
    quantity: '',
    unit: '',
    sealNumber: '',
    takenAt: '',
    laboratoryName: '',
    laboratoryAccreditation: '',
  });
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});

  const save = useConsoleMutation<LabSampleInput>({
    mutationFn: (input, key) => addLabSample(jobId, input, key),
    invalidate: [consoleKeys.job(jobId), consoleKeys.jobsAll()],
    successMessage: t('job.lab.saved'),
    onSuccess: onDone,
  });
  const serverErrors = save.error instanceof ApiError ? save.error.fieldErrors() : {};
  const errorFor = (field: string): string | undefined => clientErrors[field] ?? serverErrors[field];

  const set = (field: keyof typeof form) => (value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const onSubmit = (event: SyntheticEvent): void => {
    event.preventDefault();
    const errors: Record<string, string> = {};
    if (form.sampleCode.trim() === '') errors['sampleCode'] = t('job.lab.errorRequired');
    if (form.description.trim() === '') errors['description'] = t('job.lab.errorRequired');
    if (form.quantity.trim() !== '' && !DECIMAL_PATTERN.test(form.quantity.trim())) errors['quantity'] = t('job.lab.errorQuantity');
    const takenAt = localInputToIso(form.takenAt);
    if (takenAt === null) errors['takenAt'] = t('job.lab.errorRequired');
    setClientErrors(errors);
    if (Object.keys(errors).length > 0 || takenAt === null) return;
    const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());
    save.mutate({
      sampleCode: form.sampleCode.trim(),
      description: form.description.trim(),
      quantity: orNull(form.quantity),
      unit: orNull(form.unit),
      sealNumber: orNull(form.sealNumber),
      takenAt,
      laboratoryName: orNull(form.laboratoryName),
      laboratoryAccreditation: orNull(form.laboratoryAccreditation),
    });
  };

  const text = (field: keyof typeof form, label: string, options: { required?: boolean; max: number; hint?: string; inputMode?: 'decimal' }): React.JSX.Element => (
    <Field label={label} required={options.required === true} error={errorFor(field)} {...(options.hint === undefined ? {} : { hint: options.hint })}>
      {({ inputId, describedBy }) => (
        <Input
          id={inputId}
          aria-describedby={describedBy}
          maxLength={options.max}
          {...(options.inputMode === undefined ? {} : { inputMode: options.inputMode })}
          value={form[field]}
          invalid={errorFor(field) !== undefined}
          onChange={(event) => {
            set(field)(event.target.value);
          }}
        />
      )}
    </Field>
  );

  return (
    <form onSubmit={onSubmit} noValidate aria-label={t('job.lab.formTitle')} className="space-y-4 rounded-md border border-border bg-surface-sunken/50 p-4">
      <p className="text-title-xs text-ink">{t('job.lab.formTitle')}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {text('sampleCode', t('job.lab.code'), { required: true, max: 64 })}
        {text('sealNumber', t('job.lab.seal'), { max: 64 })}
        <Field label={t('job.lab.takenAt')} required error={errorFor('takenAt')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              type="datetime-local"
              value={form.takenAt}
              invalid={errorFor('takenAt') !== undefined}
              onChange={(event) => {
                set('takenAt')(event.target.value);
              }}
            />
          )}
        </Field>
        {text('quantity', t('job.lab.quantity'), { max: 20, inputMode: 'decimal' })}
        <Field label={t('job.lab.unit')}>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={form.unit}
              onChange={(event) => {
                set('unit')(event.target.value);
              }}
            >
              <option value="">{t('common.notRecorded')}</option>
              {QUANTITY_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {enumLabel(t, 'unit', unit)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {text('laboratoryName', t('job.lab.laboratory'), { max: 255 })}
        {text('laboratoryAccreditation', t('job.lab.accreditation'), { max: 255 })}
      </div>
      <Field label={t('job.lab.descriptionLabel')} required error={errorFor('description')}>
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            maxLength={1024}
            value={form.description}
            invalid={errorFor('description') !== undefined}
            onChange={(event) => {
              set('description')(event.target.value);
            }}
          />
        )}
      </Field>
      {save.isError && <MutationError error={save.error} />}
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onDone} disabled={save.isPending}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" variant="primary" isLoading={save.isPending}>
          {t('job.lab.save')}
        </Button>
      </div>
    </form>
  );
}

function CustodyDialog({ jobId, sample, onClose }: { jobId: string; sample: LabSample; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const [at, setAt] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useConsoleMutation<{ at: string; from: string; to: string; note: string | null }>({
    mutationFn: (input, key) => addCustodyEvent(jobId, sample.id, input, key),
    invalidate: [consoleKeys.job(jobId)],
    successMessage: t('job.lab.handOverSaved'),
    onSuccess: onClose,
  });

  const submit = (): void => {
    const next: Record<string, string> = {};
    const iso = localInputToIso(at);
    if (iso === null) next['at'] = t('job.lab.errorRequired');
    if (from.trim() === '') next['from'] = t('job.lab.errorRequired');
    if (to.trim() === '') next['to'] = t('job.lab.errorRequired');
    setErrors(next);
    if (Object.keys(next).length > 0 || iso === null) return;
    save.mutate({ at: iso, from: from.trim(), to: to.trim(), note: note.trim() === '' ? null : note.trim() });
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('job.lab.handOverTitle', { code: sample.sampleCode })}
      description={t('job.lab.handOverHint')}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" isLoading={save.isPending} onClick={submit}>
            {t('job.lab.handOverSave')}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('job.lab.handOverAt')} required error={errors['at']}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              type="datetime-local"
              value={at}
              onChange={(event) => {
                setAt(event.target.value);
              }}
            />
          )}
        </Field>
        <div className="hidden sm:block" />
        <Field label={t('job.lab.handOverFrom')} required error={errors['from']}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              maxLength={160}
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label={t('job.lab.handOverTo')} required error={errors['to']}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              maxLength={160}
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
              }}
            />
          )}
        </Field>
        <div className="sm:col-span-2">
          <Field label={t('job.lab.handOverNote')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                maxLength={500}
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                }}
              />
            )}
          </Field>
        </div>
        {save.isError && (
          <div className="sm:col-span-2">
            <MutationError error={save.error} />
          </div>
        )}
      </div>
    </Modal>
  );
}

function ResultDialog({
  detail,
  jobId,
  sample,
  onClose,
}: {
  detail: SectionProps['detail'];
  jobId: string;
  sample: LabSample;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [evidenceId, setEvidenceId] = useState(sample.labReportEvidenceId ?? '');
  const [summary, setSummary] = useState(sample.resultSummary ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useConsoleMutation<{ labReportEvidenceId: string; resultSummary: string }>({
    mutationFn: (input, key) => recordLabResult(jobId, sample.id, input, key),
    invalidate: [consoleKeys.job(jobId)],
    successMessage: t('job.lab.resultSaved'),
    onSuccess: onClose,
  });

  const submit = (): void => {
    const next: Record<string, string> = {};
    if (evidenceId === '') next['evidence'] = t('job.lab.errorEvidence');
    if (summary.trim() === '') next['summary'] = t('job.lab.errorRequired');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    save.mutate({ labReportEvidenceId: evidenceId, resultSummary: summary.trim() });
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('job.lab.resultTitle', { code: sample.sampleCode })}
      description={t('job.lab.resultHint')}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" isLoading={save.isPending} onClick={submit}>
            {t('job.lab.resultSave')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <EvidenceSelect
          label={t('job.lab.reportFile')}
          evidence={detail.job.evidence}
          value={evidenceId}
          onChange={setEvidenceId}
          required
          error={errors['evidence']}
        />
        <Field label={t('job.lab.resultSummary')} required hint={t('job.lab.resultNote')} error={errors['summary']}>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              maxLength={4000}
              value={summary}
              onChange={(event) => {
                setSummary(event.target.value);
              }}
            />
          )}
        </Field>
        {save.isError && <MutationError error={save.error} />}
      </div>
    </Modal>
  );
}
