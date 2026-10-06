/**
 * Defects (non-conformance reports) found on this job.
 *
 * Two counts that are easy to confuse are shown side by side and named:
 * defect OCCURRENCES (one unit can carry several) and defective UNITS
 * identified (each unit counted once, at its worst severity). The seller's
 * response is shown as the seller's own words, never edited.
 *
 * The named inspector records defects while the job is in progress; a
 * quality reviewer may reclassify one, with a reason and evidence.
 */
import { useState, type SyntheticEvent } from 'react';
import { Badge, Button, Card, Field, Input, Select, SummaryTiles, Textarea } from '@/components/ui';
import { Modal } from '@/components/Modal';
import { ChipInput, EnumBadge, MutationError, SectionHeading } from '@/components/console';
import { useI18n } from '@/i18n/i18n-context';
import { ApiError } from '@/lib/api';
import { consoleKeys, reclassifyDefect, recordDefect } from '@/lib/console-api';
import { DEFECT_SEVERITIES, type DefectSeverity, type JobDefect } from '@/lib/console-types';
import { enumLabel } from '@/lib/enum-labels';
import { formatDateTime, formatNumber } from '@/lib/format';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import { EvidenceSelect } from './EvidenceSelect';
import type { SectionProps } from './types';

export function DefectsSection({ detail, jobId, mode }: SectionProps): React.JSX.Element {
  const { t } = useI18n();
  const defects = detail.job.defects;
  const units = detail.extras.defectUnits;
  const [adding, setAdding] = useState(false);
  const [reclassifying, setReclassifying] = useState<JobDefect | null>(null);

  return (
    <div id="defects" className="scroll-mt-24">
    <Card
      title={t('job.defects.title')}
      description={t('job.defects.description')}
      actions={
        mode.performing && !adding ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setAdding(true);
            }}
          >
            {t('job.defects.add')}
          </Button>
        ) : undefined
      }
      bodyClassName="space-y-6 px-5 py-4"
    >
      <div className="space-y-6">
        <section aria-label={t('job.defects.unitsTitle')}>
          <SectionHeading title={t('job.defects.unitsTitle')} description={t('job.defects.unitsHint')} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <p className="mb-1.5 text-xs font-semibold text-ink">{t('job.defects.occurrences')}</p>
              <SummaryTiles
                items={[
                  { label: enumLabel(t, 'severity', 'CRITICAL'), value: formatNumber(units.occurrences.critical), tone: units.occurrences.critical > 0 ? 'danger' : 'default' },
                  { label: enumLabel(t, 'severity', 'MAJOR'), value: formatNumber(units.occurrences.major), tone: units.occurrences.major > 0 ? 'warning' : 'default' },
                  { label: enumLabel(t, 'severity', 'MINOR'), value: formatNumber(units.occurrences.minor) },
                  { label: t('job.defects.total'), value: formatNumber(units.occurrences.total) },
                ]}
              />
            </div>
            <div>
              <p className="mb-1.5 text-xs font-semibold text-ink">{t('job.defects.unitsIdentified')}</p>
              <SummaryTiles
                items={[
                  { label: enumLabel(t, 'severity', 'CRITICAL'), value: formatNumber(units.defectiveUnitsByWorstSeverity.critical), tone: units.defectiveUnitsByWorstSeverity.critical > 0 ? 'danger' : 'default' },
                  { label: enumLabel(t, 'severity', 'MAJOR'), value: formatNumber(units.defectiveUnitsByWorstSeverity.major), tone: units.defectiveUnitsByWorstSeverity.major > 0 ? 'warning' : 'default' },
                  { label: enumLabel(t, 'severity', 'MINOR'), value: formatNumber(units.defectiveUnitsByWorstSeverity.minor) },
                  { label: t('job.defects.total'), value: formatNumber(units.defectiveUnitsIdentified) },
                ]}
              />
            </div>
          </div>
          <p className="mt-2 text-xs text-ink-muted">
            {t('job.defects.withoutUnit', { occurrences: formatNumber(units.occurrencesWithoutUnit) })}
          </p>
        </section>

        {adding && mode.performing && (
          <DefectForm
            detail={detail}
            jobId={jobId}
            onDone={() => {
              setAdding(false);
            }}
          />
        )}

        <section aria-label={t('job.defects.listTitle')}>
          <SectionHeading title={t('job.defects.listTitle')} />
          {defects.length === 0 ? (
            <p className="text-sm text-ink-muted">{t('job.defects.none')}</p>
          ) : (
            <ul className="space-y-3">
              {defects.map((defect) => (
                <DefectCard
                  key={defect.id}
                  defect={defect}
                  canReclassify={mode.qa}
                  onReclassify={() => {
                    setReclassifying(defect);
                  }}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      {reclassifying !== null && (
        <ReclassifyDialog
          defect={reclassifying}
          detail={detail}
          jobId={jobId}
          onClose={() => {
            setReclassifying(null);
          }}
        />
      )}
    </Card>
    </div>
  );
}

function DefectCard({
  defect,
  canReclassify,
  onReclassify,
}: {
  defect: JobDefect;
  canReclassify: boolean;
  onReclassify: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const reclassified = defect.originalSeverity !== null && defect.originalSeverity !== defect.severity;

  return (
    <li className="rounded-md border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold text-ink">{defect.ncrNumber}</span>
          <EnumBadge family="severity" value={defect.severity} />
          <EnumBadge family="ncrStatus" value={defect.status} dot={false} />
          {reclassified && (
            <Badge tone="neutral">
              {t('job.defects.originally', { severity: enumLabel(t, 'severity', defect.originalSeverity) })}
            </Badge>
          )}
        </div>
        {canReclassify && (
          <Button size="sm" variant="ghost" onClick={onReclassify}>
            {t('job.defects.reclassify')}
          </Button>
        )}
      </div>
      <p className="mt-2 whitespace-pre-line break-words text-sm text-ink">{defect.description}</p>
      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <div className="flex gap-1.5">
          <dt className="text-ink-subtle">{t('job.defects.requirementRef')}:</dt>
          <dd className="min-w-0 break-words text-ink">{defect.requirementRef}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-ink-subtle">{t('job.defects.occurrencesLabel')}:</dt>
          <dd className="tabular text-ink">{formatNumber(defect.defectQuantity)}</dd>
        </div>
      </dl>
      {reclassified && defect.reclassificationReason !== null && (
        <p className="mt-2 text-xs text-ink-muted">
          {t('job.defects.reclassifiedBecause', {
            reason: defect.reclassificationReason,
            at: formatDateTime(defect.reclassifiedAt),
          })}
        </p>
      )}
      {defect.correctiveAction !== null && defect.correctiveAction !== '' && (
        <div className="mt-3">
          <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{t('job.defects.correctiveAction')}</p>
          <p className="mt-0.5 whitespace-pre-line text-sm text-ink">{defect.correctiveAction}</p>
        </div>
      )}
      {defect.sellerResponse !== null && defect.sellerResponse !== '' && (
        <figure className="mt-3">
          <figcaption className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
            {t('job.defects.sellerResponse')}
            {defect.capaSubmittedAt !== null && <> · {formatDateTime(defect.capaSubmittedAt)}</>}
          </figcaption>
          <blockquote className="mt-1 whitespace-pre-line border-l-2 border-border-strong bg-surface-sunken px-3 py-2 text-sm italic text-ink">
            {defect.sellerResponse}
          </blockquote>
        </figure>
      )}
    </li>
  );
}

function DefectForm({
  detail,
  jobId,
  onDone,
}: {
  detail: SectionProps['detail'];
  jobId: string;
  onDone: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [severity, setSeverity] = useState<DefectSeverity>('MAJOR');
  const [requirementRef, setRequirementRef] = useState('');
  const [description, setDescription] = useState('');
  const [occurrences, setOccurrences] = useState('1');
  const [unitRefs, setUnitRefs] = useState<string[]>([]);
  const [checkItemCode, setCheckItemCode] = useState('');
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});

  const save = useConsoleMutation<Parameters<typeof recordDefect>[1]>({
    mutationFn: (input, key) => recordDefect(jobId, input, key),
    invalidate: [consoleKeys.job(jobId), consoleKeys.jobsAll()],
    successMessage: t('job.defects.saved'),
    onSuccess: onDone,
  });
  const serverErrors = save.error instanceof ApiError ? save.error.fieldErrors() : {};
  const errorFor = (field: string): string | undefined => clientErrors[field] ?? serverErrors[field];

  const onSubmit = (event: SyntheticEvent): void => {
    event.preventDefault();
    const errors: Record<string, string> = {};
    if (requirementRef.trim() === '') errors['requirementRef'] = t('job.defects.errorRequired');
    if (description.trim() === '') errors['description'] = t('job.defects.errorRequired');
    if (!/^\d{1,9}$/.test(occurrences.trim())) errors['defectQuantity'] = t('job.defects.errorWhole');
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    save.mutate({
      severity,
      requirementRef: requirementRef.trim(),
      description: description.trim(),
      defectQuantity: Number.parseInt(occurrences.trim(), 10),
      unitRefs: unitRefs.length === 0 ? null : unitRefs,
      checkItemCode: checkItemCode === '' ? null : checkItemCode,
    });
  };

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-label={t('job.defects.formTitle')}
      className="space-y-4 rounded-md border border-border bg-surface-sunken/50 p-4"
    >
      <p className="text-title-xs text-ink">{t('job.defects.formTitle')}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label={t('job.defects.severity')} required>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={severity}
              onChange={(event) => {
                setSeverity(event.target.value as DefectSeverity);
              }}
            >
              {DEFECT_SEVERITIES.map((entry) => (
                <option key={entry} value={entry}>
                  {enumLabel(t, 'severity', entry)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('job.defects.requirementRef')} required hint={t('job.defects.requirementRefHint')} error={errorFor('requirementRef')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              maxLength={255}
              value={requirementRef}
              invalid={errorFor('requirementRef') !== undefined}
              onChange={(event) => {
                setRequirementRef(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label={t('job.defects.occurrencesLabel')} required hint={t('job.defects.occurrencesHint')} error={errorFor('defectQuantity')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              inputMode="numeric"
              value={occurrences}
              invalid={errorFor('defectQuantity') !== undefined}
              onChange={(event) => {
                setOccurrences(event.target.value);
              }}
            />
          )}
        </Field>
      </div>
      <Field label={t('job.defects.descriptionLabel')} required error={errorFor('description')}>
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            maxLength={4000}
            value={description}
            invalid={errorFor('description') !== undefined}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        )}
      </Field>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChipInput
          label={t('job.defects.unitRefs')}
          values={unitRefs}
          onChange={setUnitRefs}
          hint={t('job.defects.unitRefsHint')}
          normalise={(value) => value.trim().toUpperCase().slice(0, 32)}
          max={500}
          error={errorFor('unitRefs')}
        />
        {detail.checklist.length > 0 && (
          <Field label={t('job.defects.checkItem')}>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={checkItemCode}
                onChange={(event) => {
                  setCheckItemCode(event.target.value);
                }}
              >
                <option value="">{t('common.none')}</option>
                {detail.checklist.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.code} · {item.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>

      {save.isError && <MutationError error={save.error} />}

      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onDone} disabled={save.isPending}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" variant="primary" isLoading={save.isPending}>
          {t('job.defects.save')}
        </Button>
      </div>
    </form>
  );
}

function ReclassifyDialog({
  defect,
  detail,
  jobId,
  onClose,
}: {
  defect: JobDefect;
  detail: SectionProps['detail'];
  jobId: string;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [severity, setSeverity] = useState<DefectSeverity>(defect.severity);
  const [reason, setReason] = useState('');
  const [evidenceId, setEvidenceId] = useState('');
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});

  const save = useConsoleMutation<{ severity: DefectSeverity; reason: string; evidenceId: string }>({
    mutationFn: (input, key) => reclassifyDefect(defect.id, input, key),
    invalidate: [consoleKeys.job(jobId), consoleKeys.jobsAll()],
    successMessage: t('job.defects.reclassified'),
    onSuccess: onClose,
  });
  const serverErrors = save.error instanceof ApiError ? save.error.fieldErrors() : {};
  const errorFor = (field: string): string | undefined => clientErrors[field] ?? serverErrors[field];

  const submit = (): void => {
    const errors: Record<string, string> = {};
    if (reason.trim().length < 10) errors['reason'] = t('common.reasonHint');
    if (evidenceId === '') errors['evidenceId'] = t('job.defects.errorEvidence');
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    save.mutate({ severity, reason: reason.trim(), evidenceId });
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('job.defects.reclassifyTitle', { ncr: defect.ncrNumber })}
      description={t('job.defects.reclassifyHint')}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" isLoading={save.isPending} onClick={submit}>
            {t('job.defects.reclassifySave')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">
          {t('job.defects.currentSeverity', { severity: enumLabel(t, 'severity', defect.severity) })}
        </p>
        <Field label={t('job.defects.newSeverity')} required>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={severity}
              onChange={(event) => {
                setSeverity(event.target.value as DefectSeverity);
              }}
            >
              {DEFECT_SEVERITIES.map((entry) => (
                <option key={entry} value={entry}>
                  {enumLabel(t, 'severity', entry)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('job.defects.reason')} required hint={t('common.reasonHint')} error={errorFor('reason')}>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              maxLength={2000}
              value={reason}
              invalid={errorFor('reason') !== undefined}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          )}
        </Field>
        <EvidenceSelect
          label={t('job.defects.evidence')}
          evidence={detail.job.evidence}
          value={evidenceId}
          onChange={setEvidenceId}
          required
          error={errorFor('evidenceId')}
        />
        {save.isError && <MutationError error={save.error} />}
      </div>
    </Modal>
  );
}
