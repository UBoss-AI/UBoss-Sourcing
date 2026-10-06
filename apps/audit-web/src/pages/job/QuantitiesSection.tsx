/**
 * Quantities: what was counted, what was tested, and - kept apart - what the
 * lot's disposition is.
 *
 * Three things an inspector's numbers are easily confused with, kept in three
 * separately labelled parts:
 *
 *   - the COUNT reconciliation: ordered, declared, physically verified;
 *   - the FUNCTIONAL tests on the units that were sampled, with the server's
 *     own sentence about them shown word for word - a sample result is never
 *     presented as a number of verified units;
 *   - the LOT DISPOSITION, which comes from the report's AQL decision on the
 *     defects found, not from either of the above.
 *
 * Every quantity is an exact decimal string from the server; nothing here
 * turns one into a float.
 */
import { useId, useState, type SyntheticEvent } from 'react';
import { Button, Callout, Card, Field, Input, Select, SummaryTiles, Textarea } from '@/components/ui';
import { EnumBadge, MutationError, SectionHeading } from '@/components/console';
import { useI18n, type Translate } from '@/i18n/i18n-context';
import { ApiError } from '@/lib/api';
import { consoleKeys, recordQuantities, type QuantitiesInput } from '@/lib/console-api';
import { COUNTING_METHODS, QUANTITY_UNITS, type QuantitySummary } from '@/lib/console-types';
import { enumLabel } from '@/lib/enum-labels';
import { formatQuantity } from '@/lib/format';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import { quantityProblem, resultsDoNotAddUp } from './quantity-math';
import type { SectionProps } from './types';

export function QuantitiesSection({ detail, jobId, mode }: SectionProps): React.JSX.Element {
  const { t } = useI18n();
  const quantities = detail.extras.quantities;
  const [editing, setEditing] = useState(false);

  return (
    <div id="quantities" className="scroll-mt-24 space-y-4">
      <Card
        title={t('job.quantities.title')}
        description={t('job.quantities.description')}
        actions={
          mode.performing && !editing ? (
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setEditing(true);
              }}
            >
              {quantities === null ? t('job.quantities.record') : t('job.quantities.update')}
            </Button>
          ) : undefined
        }
        bodyClassName="space-y-6 px-5 py-4"
      >
        {editing && mode.performing ? (
          <QuantitiesForm
            jobId={jobId}
            quantities={quantities}
            onDone={() => {
              setEditing(false);
            }}
          />
        ) : null}

        {quantities === null ? (
          <p className="text-sm text-ink-muted">{t('job.quantities.none')}</p>
        ) : (
          <QuantitySummaryView quantities={quantities} />
        )}
      </Card>

      <Disposition detail={detail} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The read-only summary
// ---------------------------------------------------------------------------

function unitWords(t: Translate, unit: string): string {
  return enumLabel(t, 'unit', unit);
}

function QuantitySummaryView({ quantities }: { quantities: QuantitySummary }): React.JSX.Element {
  const { t } = useI18n();
  const reconciliationId = useId();
  const functionalId = useId();
  const statementId = useId();
  const r = quantities.reconciliation;
  const f = quantities.functional;
  const bp = f.observedNonconformingBasisPoints;

  return (
    <>
      <section aria-labelledby={reconciliationId} data-testid="quantities-reconciliation">
        <SectionHeading
          id={reconciliationId}
          title={t('job.quantities.reconciliationTitle')}
          description={t('job.quantities.reconciliationHint', { unit: unitWords(t, quantities.unit) })}
          actions={<EnumBadge family="reconciliation" value={r.status} />}
        />
        <SummaryTiles
          items={[
            { label: t('job.quantities.ordered'), value: formatQuantity(r.ordered) },
            { label: t('job.quantities.declared'), value: formatQuantity(r.declared) },
            { label: t('job.quantities.verified'), value: formatQuantity(r.verified) },
            {
              label: t('job.quantities.difference'),
              value: formatQuantity(r.difference),
              tone: r.status === 'SHORT' ? 'danger' : r.status === 'EXCESS' ? 'warning' : 'default',
            },
          ]}
        />
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{t('job.quantities.countingMethod')}</dt>
            <dd className="mt-0.5 text-ink">
              {quantities.countingMethod === null ? t('common.notRecorded') : enumLabel(t, 'countingMethod', quantities.countingMethod)}
              {quantities.countingNote !== null && quantities.countingNote !== '' && (
                <span className="mt-0.5 block text-xs text-ink-muted">{quantities.countingNote}</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{t('job.quantities.packaging')}</dt>
            <dd className="mt-0.5 text-ink">
              {quantities.packaging === null || quantities.packaging.length === 0 ? (
                t('common.none')
              ) : (
                <ul className="space-y-0.5">
                  {quantities.packaging.map((conversion, index) => (
                    <li key={`${conversion.unit}-${conversion.of}-${String(index)}`}>
                      {t('job.quantities.conversion', {
                        unit: unitWords(t, conversion.unit),
                        contains: formatQuantity(conversion.contains),
                        of: unitWords(t, conversion.of),
                      })}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby={functionalId} data-testid="quantities-functional">
        <SectionHeading
          id={functionalId}
          title={t('job.quantities.functionalTitle')}
          description={t('job.quantities.functionalHint')}
        />
        <SummaryTiles
          items={[
            { label: t('job.quantities.tested'), value: formatQuantity(f.tested) },
            { label: t('job.quantities.conforming'), value: formatQuantity(f.conforming), tone: 'success' },
            {
              label: t('job.quantities.nonconforming'),
              value: formatQuantity(f.nonconforming),
              tone: f.nonconforming !== null && f.nonconforming !== '0' ? 'danger' : 'default',
            },
            { label: t('job.quantities.untested'), value: formatQuantity(f.untested) },
          ]}
        />
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{t('job.quantities.observedRate')}</dt>
            <dd className="mt-0.5 text-ink tabular">
              {bp === null
                ? t('common.notRecorded')
                : t('job.quantities.observedRateValue', {
                    rate: `${formatQuantity(`${String(Math.trunc(bp / 100))}.${String(Math.abs(bp % 100)).padStart(2, '0')}`)} %`,
                  })}
            </dd>
          </div>
          <div>
            <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{t('job.quantities.damaged')}</dt>
            <dd className="mt-0.5 text-ink tabular">{formatQuantity(quantities.damaged)}</dd>
          </div>
        </dl>
        <section aria-labelledby={statementId} className="mt-3" data-testid="quantities-statement">
          <Callout tone="info" title={<span id={statementId}>{t('job.quantities.statementTitle')}</span>}>
            <p>{quantities.statement}</p>
            <p className="mt-1 text-xs text-ink-muted">{t('job.quantities.statementNote')}</p>
          </Callout>
        </section>
      </section>

      <section aria-label={t('job.quantities.observationsTitle')}>
        <SectionHeading title={t('job.quantities.observationsTitle')} />
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm lg:grid-cols-3">
          {(
            [
              ['packaging', quantities.observations.packaging, 'job.quantities.observationPackaging'],
              ['labelling', quantities.observations.labelling, 'job.quantities.observationLabelling'],
              ['damage', quantities.observations.damage, 'job.quantities.observationDamage'],
            ] as const
          ).map(([key, value, label]) => (
            <div key={key} className="min-w-0">
              <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{t(label)}</dt>
              <dd className="mt-0.5 whitespace-pre-line break-words text-ink">
                {value === null || value === '' ? <span className="text-ink-muted">{t('common.notRecorded')}</span> : value}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// The lot disposition - kept apart
// ---------------------------------------------------------------------------

function Disposition({ detail }: { detail: SectionProps['detail'] }): React.JSX.Element {
  const { t } = useI18n();
  const report = detail.job.report;
  const latestExtras = [...detail.extras.reports].filter((entry) => entry.supersededAt === null).at(-1) ?? null;
  const result = report?.result ?? latestExtras?.result ?? null;
  const status = report?.status ?? latestExtras?.status ?? null;

  return (
    <Card title={t('job.quantities.dispositionTitle')} description={t('job.quantities.dispositionHint')} bodyClassName="px-5 py-4">
      <section aria-label={t('job.quantities.dispositionTitle')} data-testid="quantities-disposition">
        {result === null ? (
          <p className="text-sm text-ink-muted">{t('job.quantities.noReport')}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-ink">{t('job.quantities.dispositionResult')}</span>
            <EnumBadge family="reportResult" value={result} />
            {status !== null && <EnumBadge family="reportStatus" value={status} dot={false} />}
          </div>
        )}
      </section>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

const QUANTITY_FIELDS = [
  'orderedQuantity',
  'declaredQuantity',
  'verifiedQuantity',
  'sampledQuantity',
  'functionallyTestedQuantity',
  'testedConformingQuantity',
  'testedNonconformingQuantity',
  'damagedQuantity',
] as const;
type QuantityField = (typeof QUANTITY_FIELDS)[number];

const FIELD_LABEL: Record<QuantityField, 'job.quantities.ordered' | 'job.quantities.declared' | 'job.quantities.verified' | 'job.quantities.sampled' | 'job.quantities.tested' | 'job.quantities.conforming' | 'job.quantities.nonconforming' | 'job.quantities.damaged'> = {
  orderedQuantity: 'job.quantities.ordered',
  declaredQuantity: 'job.quantities.declared',
  verifiedQuantity: 'job.quantities.verified',
  sampledQuantity: 'job.quantities.sampled',
  functionallyTestedQuantity: 'job.quantities.tested',
  testedConformingQuantity: 'job.quantities.conforming',
  testedNonconformingQuantity: 'job.quantities.nonconforming',
  damagedQuantity: 'job.quantities.damaged',
};

interface Conversion {
  unit: string;
  contains: string;
  of: string;
}

function QuantitiesForm({
  jobId,
  quantities,
  onDone,
}: {
  jobId: string;
  quantities: QuantitySummary | null;
  onDone: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const raw = quantities?.raw;
  const [unit, setUnit] = useState<string>(raw?.unit ?? 'PIECE');
  const [values, setValues] = useState<Record<QuantityField, string>>({
    orderedQuantity: raw?.orderedQuantity ?? '',
    declaredQuantity: raw?.declaredQuantity ?? '',
    verifiedQuantity: raw?.verifiedQuantity ?? '',
    sampledQuantity: raw?.sampledQuantity ?? '',
    functionallyTestedQuantity: raw?.functionallyTestedQuantity ?? '',
    testedConformingQuantity: raw?.testedConformingQuantity ?? '',
    testedNonconformingQuantity: raw?.testedNonconformingQuantity ?? '',
    damagedQuantity: raw?.damagedQuantity ?? '',
  });
  const [countingMethod, setCountingMethod] = useState<string>(quantities?.countingMethod ?? '');
  const [countingNote, setCountingNote] = useState(quantities?.countingNote ?? '');
  const [packaging, setPackaging] = useState<Conversion[]>(
    (quantities?.packaging ?? []).map((entry) => ({ unit: entry.unit, contains: entry.contains, of: entry.of })),
  );
  const [observations, setObservations] = useState({
    packaging: quantities?.observations.packaging ?? '',
    labelling: quantities?.observations.labelling ?? '',
    damage: quantities?.observations.damage ?? '',
  });
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});

  const save = useConsoleMutation<QuantitiesInput>({
    mutationFn: (input, key) => recordQuantities(jobId, input, key),
    invalidate: [consoleKeys.job(jobId), consoleKeys.jobsAll()],
    successMessage: t('job.quantities.saved'),
    onSuccess: onDone,
  });

  const serverErrors = save.error instanceof ApiError ? save.error.fieldErrors() : {};
  const errorFor = (field: string): string | undefined => clientErrors[field] ?? serverErrors[field];

  const validate = (): Record<string, string> => {
    const errors: Record<string, string> = {};
    for (const field of QUANTITY_FIELDS) {
      const problem = quantityProblem(values[field], unit);
      if (problem === 'NOT_A_QUANTITY') errors[field] = t('job.quantities.errorNotQuantity');
      if (problem === 'NOT_WHOLE') errors[field] = t('job.quantities.errorNotWhole', { unit: enumLabel(t, 'unit', unit) });
    }
    if (
      errors['testedConformingQuantity'] === undefined &&
      errors['testedNonconformingQuantity'] === undefined &&
      errors['functionallyTestedQuantity'] === undefined &&
      resultsDoNotAddUp(values.functionallyTestedQuantity, values.testedConformingQuantity, values.testedNonconformingQuantity)
    ) {
      errors['testedConformingQuantity'] = t('job.quantities.errorDoesNotAddUp');
    }
    packaging.forEach((conversion, index) => {
      if (quantityProblem(conversion.contains, 'KILOGRAM') !== null || conversion.contains.trim() === '') {
        errors[`packaging[${String(index)}]`] = t('job.quantities.errorNotQuantity');
      } else if (conversion.unit === conversion.of) {
        errors[`packaging[${String(index)}]`] = t('job.quantities.errorConversionSame');
      }
    });
    return errors;
  };

  const onSubmit = (event: SyntheticEvent): void => {
    event.preventDefault();
    const errors = validate();
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());
    save.mutate({
      unit,
      orderedQuantity: orNull(values.orderedQuantity),
      declaredQuantity: orNull(values.declaredQuantity),
      verifiedQuantity: orNull(values.verifiedQuantity),
      countingMethod: countingMethod === '' ? null : countingMethod,
      countingNote: orNull(countingNote),
      packaging: packaging.length === 0 ? null : packaging.map((entry) => ({ ...entry, contains: entry.contains.trim() })),
      sampledQuantity: orNull(values.sampledQuantity),
      functionallyTestedQuantity: orNull(values.functionallyTestedQuantity),
      testedConformingQuantity: orNull(values.testedConformingQuantity),
      testedNonconformingQuantity: orNull(values.testedNonconformingQuantity),
      damagedQuantity: orNull(values.damagedQuantity),
      packagingObservations: orNull(observations.packaging),
      labelingObservations: orNull(observations.labelling),
      damageObservations: orNull(observations.damage),
    });
  };

  const quantityInput = (field: QuantityField, hint?: string): React.JSX.Element => (
    <Field key={field} label={t(FIELD_LABEL[field])} error={errorFor(field)} {...(hint === undefined ? {} : { hint })}>
      {({ inputId, describedBy }) => (
        <Input
          id={inputId}
          aria-describedby={describedBy}
          inputMode="decimal"
          autoComplete="off"
          value={values[field]}
          invalid={errorFor(field) !== undefined}
          onChange={(event) => {
            const next = event.target.value;
            setValues((current) => ({ ...current, [field]: next }));
          }}
        />
      )}
    </Field>
  );

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-label={t('job.quantities.formTitle')}
      className="space-y-6 rounded-md border border-border bg-surface-sunken/50 p-4"
    >
      <fieldset className="space-y-4">
        <legend className="text-title-xs text-ink">{t('job.quantities.countLegend')}</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t('job.quantities.unit')} required>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={unit}
                onChange={(event) => {
                  setUnit(event.target.value);
                }}
              >
                {QUANTITY_UNITS.map((entry) => (
                  <option key={entry} value={entry}>
                    {enumLabel(t, 'unit', entry)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {quantityInput('orderedQuantity')}
          {quantityInput('declaredQuantity')}
          {quantityInput('verifiedQuantity', t('job.quantities.verifiedHint'))}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('job.quantities.countingMethod')}>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={countingMethod}
                onChange={(event) => {
                  setCountingMethod(event.target.value);
                }}
              >
                <option value="">{t('common.notRecorded')}</option>
                {COUNTING_METHODS.map((entry) => (
                  <option key={entry} value={entry}>
                    {enumLabel(t, 'countingMethod', entry)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('job.quantities.countingNote')} error={errorFor('countingNote')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                maxLength={1024}
                value={countingNote}
                onChange={(event) => {
                  setCountingNote(event.target.value);
                }}
              />
            )}
          </Field>
        </div>
      </fieldset>

      <PackagingRows rows={packaging} onChange={setPackaging} errorFor={errorFor} />

      <fieldset className="space-y-4">
        <legend className="text-title-xs text-ink">{t('job.quantities.testsLegend')}</legend>
        <p className="max-w-prose text-xs leading-relaxed text-ink-muted">{t('job.quantities.testsHint')}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {quantityInput('sampledQuantity')}
          {quantityInput('functionallyTestedQuantity')}
          {quantityInput('testedConformingQuantity')}
          {quantityInput('testedNonconformingQuantity')}
          {quantityInput('damagedQuantity')}
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-title-xs text-ink">{t('job.quantities.observationsTitle')}</legend>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {(
            [
              ['packaging', 'job.quantities.observationPackaging', 'packagingObservations'],
              ['labelling', 'job.quantities.observationLabelling', 'labelingObservations'],
              ['damage', 'job.quantities.observationDamage', 'damageObservations'],
            ] as const
          ).map(([key, label, serverField]) => (
            <Field key={key} label={t(label)} error={errorFor(serverField)}>
              {({ inputId, describedBy }) => (
                <Textarea
                  id={inputId}
                  aria-describedby={describedBy}
                  maxLength={4000}
                  value={observations[key]}
                  onChange={(event) => {
                    const next = event.target.value;
                    setObservations((current) => ({ ...current, [key]: next }));
                  }}
                />
              )}
            </Field>
          ))}
        </div>
      </fieldset>

      {save.isError && <MutationError error={save.error} />}

      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onDone} disabled={save.isPending}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" variant="primary" isLoading={save.isPending}>
          {t('job.quantities.save')}
        </Button>
      </div>
    </form>
  );
}

function PackagingRows({
  rows,
  onChange,
  errorFor,
}: {
  rows: Conversion[];
  onChange: (rows: Conversion[]) => void;
  errorFor: (field: string) => string | undefined;
}): React.JSX.Element {
  const { t } = useI18n();
  const update = (index: number, patch: Partial<Conversion>): void => {
    onChange(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  };

  return (
    <fieldset className="space-y-3">
      <legend className="text-title-xs text-ink">{t('job.quantities.packaging')}</legend>
      <p className="max-w-prose text-xs leading-relaxed text-ink-muted">{t('job.quantities.packagingHint')}</p>
      {rows.length > 0 && (
        <ul className="space-y-3">
          {rows.map((row, index) => {
            const error = errorFor(`packaging[${String(index)}]`) ?? errorFor(`packaging[${String(index)}].contains`);
            const position = String(index + 1);
            return (
              <li key={index} className="rounded-md border border-border bg-surface p-3">
                <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_8rem_1fr_auto]">
                  <Field label={t('job.quantities.conversionUnit', { position })}>
                    {({ inputId }) => (
                      <Select
                        id={inputId}
                        value={row.unit}
                        onChange={(event) => {
                          update(index, { unit: event.target.value });
                        }}
                      >
                        {QUANTITY_UNITS.map((entry) => (
                          <option key={entry} value={entry}>
                            {enumLabel(t, 'unit', entry)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={t('job.quantities.conversionContains')}>
                    {({ inputId }) => (
                      <Input
                        id={inputId}
                        inputMode="decimal"
                        value={row.contains}
                        invalid={error !== undefined}
                        onChange={(event) => {
                          update(index, { contains: event.target.value });
                        }}
                      />
                    )}
                  </Field>
                  <Field label={t('job.quantities.conversionOf')}>
                    {({ inputId }) => (
                      <Select
                        id={inputId}
                        value={row.of}
                        onChange={(event) => {
                          update(index, { of: event.target.value });
                        }}
                      >
                        {QUANTITY_UNITS.map((entry) => (
                          <option key={entry} value={entry}>
                            {enumLabel(t, 'unit', entry)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Button
                    variant="ghost"
                    aria-label={t('job.quantities.removeConversion', { position })}
                    onClick={() => {
                      onChange(rows.filter((_row, position) => position !== index));
                    }}
                  >
                    {t('job.quantities.remove')}
                  </Button>
                </div>
                {error !== undefined && (
                  <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
                    {error}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {rows.length < 6 && (
        <Button
          size="sm"
          onClick={() => {
            onChange([...rows, { unit: 'CARTON', contains: '', of: 'PIECE' }]);
          }}
        >
          {t('job.quantities.addConversion')}
        </Button>
      )}
    </fieldset>
  );
}
