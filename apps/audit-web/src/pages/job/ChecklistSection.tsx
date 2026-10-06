/**
 * The checklist, grouped by section and then by kind of check.
 *
 * Each line is the plan's line with what was recorded against it. The named
 * inspector, on a job in progress, answers a line by tapping one of three
 * large outcome buttons; the fields that line needs then open beneath it.
 * A line that needs an instrument asks for it and its calibration date; a
 * line that needs a laboratory report asks for the file, from this job's own
 * evidence. Everybody else reads the recorded answers.
 */
import { useState } from 'react';
import { EnumBadge, MutationError } from '@/components/console';
import { Badge, Button, Card, Field, Input, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { consoleKeys, recordCheck, type CheckInput } from '@/lib/console-api';
import type { CheckOutcome, CheckResult, ChecklistItem, EvidenceItem } from '@/lib/console-types';
import { CHECKLIST_SECTIONS, CHECK_KINDS } from '@/lib/console-types';
import { cx } from '@/lib/cx';
import { enumLabel } from '@/lib/enum-labels';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import { EvidenceSelect } from './EvidenceSelect';
import type { SectionProps } from './types';

const OUTCOMES: CheckOutcome[] = ['CONFORM', 'NONCONFORM', 'NOT_APPLICABLE'];

interface Line {
  item: ChecklistItem;
  result: CheckResult | undefined;
}

function groupLines(plan: ChecklistItem[], checks: CheckResult[]): { section: string; kinds: { kind: string; lines: Line[] }[] }[] {
  const byCode = new Map(checks.map((check) => [check.itemCode.toUpperCase(), check]));
  const lines: Line[] = plan.map((item) => ({ item, result: byCode.get(item.code.toUpperCase()) }));
  const planned = new Set(plan.map((item) => item.code.toUpperCase()));
  for (const check of checks) {
    if (!planned.has(check.itemCode.toUpperCase())) {
      lines.push({
        item: { code: check.itemCode, section: check.section, label: check.label, requirement: check.requirement },
        result: check,
      });
    }
  }

  const sectionOrder = [...CHECKLIST_SECTIONS, ...new Set(lines.map((line) => line.item.section))];
  const kindOrder: string[] = [...CHECK_KINDS];
  const sections = [...new Set(sectionOrder)].filter((section) => lines.some((line) => line.item.section === section));

  return sections.map((section) => {
    const inSection = lines.filter((line) => line.item.section === section);
    const kinds = [...new Set(inSection.map((line) => line.item.kind ?? ''))].sort(
      (a, b) => (kindOrder.indexOf(a) === -1 ? 99 : kindOrder.indexOf(a)) - (kindOrder.indexOf(b) === -1 ? 99 : kindOrder.indexOf(b)),
    );
    return { section, kinds: kinds.map((kind) => ({ kind, lines: inSection.filter((line) => (line.item.kind ?? '') === kind) })) };
  });
}

export function ChecklistSection({ detail, jobId, mode }: SectionProps): React.JSX.Element {
  const { t } = useI18n();
  const groups = groupLines(detail.checklist, detail.job.checks);
  const total = groups.reduce((sum, group) => sum + group.kinds.reduce((inner, kind) => inner + kind.lines.length, 0), 0);
  const answered = detail.job.checks.length;

  return (
    <Card
      title={t('job.checklist.title')}
      description={mode.performing ? t('job.checklist.descriptionPerforming') : t('job.checklist.description')}
      actions={
        total > 0 ? (
          <Badge tone={answered >= total ? 'success' : 'neutral'}>
            {t('job.checklist.progress', { answered: String(answered), total: String(total) })}
          </Badge>
        ) : undefined
      }
      bodyClassName="px-5 py-4 space-y-6"
    >
      {groups.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('job.checklist.empty')}</p>
      ) : (
        groups.map((group) => (
          <section key={group.section} aria-labelledby={`check-section-${group.section}`}>
            <h3 id={`check-section-${group.section}`} className="text-title-xs text-ink">
              {enumLabel(t, 'checklistSection', group.section)}
            </h3>
            <div className="mt-2 space-y-4">
              {group.kinds.map((kind) => (
                <div key={kind.kind}>
                  {kind.kind !== '' && (
                    <p className="mb-1.5 text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                      {enumLabel(t, 'checkKind', kind.kind)}
                    </p>
                  )}
                  <ul className="divide-y divide-border-subtle rounded-md border border-border">
                    {kind.lines.map((line) => (
                      <li key={line.item.code} className="px-3 py-3">
                        <ChecklistLine line={line} jobId={jobId} editable={mode.performing} evidence={detail.job.evidence} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        ))
      )}
    </Card>
  );
}

function ChecklistLine({
  line,
  jobId,
  editable,
  evidence,
}: {
  line: Line;
  jobId: string;
  editable: boolean;
  evidence: EvidenceItem[];
}): React.JSX.Element {
  const { t } = useI18n();
  const { item, result } = line;
  const [outcome, setOutcome] = useState<CheckOutcome | null>(null);
  const [measured, setMeasured] = useState(result?.measuredValue ?? '');
  const [note, setNote] = useState(result?.note ?? '');
  const [equipment, setEquipment] = useState(result?.equipmentRef ?? '');
  const [calibrated, setCalibrated] = useState(result?.equipmentCalibratedUntil?.slice(0, 10) ?? '');
  const [labReport, setLabReport] = useState(result?.labReportEvidenceId ?? '');

  const save = useConsoleMutation<CheckInput>({
    mutationFn: (input, key) => recordCheck(jobId, input, key),
    invalidate: [consoleKeys.job(jobId)],
    successMessage: t('job.checklist.saved', { code: item.code }),
    onSuccess: () => {
      setOutcome(null);
    },
  });

  const needsEquipment = item.requiresEquipment === true;
  const needsLab = item.requiresLabReport === true;
  const missing =
    outcome === null ||
    (needsEquipment && outcome !== 'NOT_APPLICABLE' && (equipment.trim() === '' || calibrated === '')) ||
    (needsLab && outcome !== 'NOT_APPLICABLE' && labReport === '');
  const fieldId = `check-${item.code}`;

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{item.label}</p>
          <p className="mt-0.5 font-mono text-xxs text-ink-subtle">{item.code}</p>
          {(item.requirement ?? '') !== '' && <p className="mt-1 text-xs text-ink-muted">{item.requirement}</p>}
          {(item.tolerance ?? '') !== '' && (
            <p className="mt-0.5 text-xs text-ink-muted">{t('job.checklist.tolerance', { tolerance: item.tolerance ?? '' })}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {item.mandatory === true && <Badge tone="brand">{t('job.checklist.mandatory')}</Badge>}
          {needsEquipment && <Badge tone="neutral">{t('job.checklist.needsInstrument')}</Badge>}
          {needsLab && <Badge tone="neutral">{t('job.checklist.needsLab')}</Badge>}
        </div>
      </div>

      {result !== undefined ? (
        <div className="space-y-1 rounded-md bg-surface-sunken px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <EnumBadge family="checkOutcome" value={result.outcome} />
            <span className="text-ink-muted">{formatDateTime(result.recordedAt)}</span>
          </div>
          {result.measuredValue !== null && <p className="text-ink">{t('job.checklist.measuredShown', { value: result.measuredValue })}</p>}
          {result.equipmentRef !== null && (
            <p className="text-ink">
              {t('job.checklist.instrumentShown', {
                instrument: result.equipmentRef,
                date: formatCalendarDate(result.equipmentCalibratedUntil),
              })}
            </p>
          )}
          {result.labReportEvidenceId !== null && <p className="text-ink">{t('job.checklist.labAttached')}</p>}
          {result.note !== null && <p className="text-ink-muted">{result.note}</p>}
        </div>
      ) : (
        !editable && <p className="text-xs text-ink-subtle">{t('job.checklist.notAnswered')}</p>
      )}

      {editable && (
        <div className="space-y-3">
          <div role="group" aria-label={t('job.checklist.outcomeFor', { label: item.label })} className="grid grid-cols-3 gap-2">
            {OUTCOMES.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={outcome === value}
                onClick={() => {
                  setOutcome(value);
                }}
                className={cx(
                  'min-h-11 rounded-md border px-2 py-2 text-xs font-semibold transition-colors sm:text-sm',
                  outcome === value
                    ? value === 'CONFORM'
                      ? 'border-success bg-success-soft text-success'
                      : value === 'NONCONFORM'
                        ? 'border-danger bg-danger-soft text-danger'
                        : 'border-border-strong bg-surface-sunken text-ink'
                    : 'border-border-strong bg-surface text-ink hover:bg-surface-hover',
                )}
              >
                {enumLabel(t, 'checkOutcome', value)}
              </button>
            ))}
          </div>

          {outcome !== null && (
            <form
              className="animate-fade-in space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                save.mutate({
                  itemCode: item.code,
                  outcome,
                  measuredValue: measured.trim() === '' ? null : measured.trim(),
                  note: note.trim() === '' ? null : note.trim(),
                  equipmentRef: equipment.trim() === '' ? null : equipment.trim(),
                  equipmentCalibratedUntil: calibrated === '' ? null : calibrated,
                  labReportEvidenceId: labReport === '' ? null : labReport,
                });
              }}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('job.checklist.measured')} hint={t('job.checklist.measuredHint')}>
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      value={measured}
                      maxLength={255}
                      onChange={(event) => {
                        setMeasured(event.target.value);
                      }}
                    />
                  )}
                </Field>
                <Field label={t('job.checklist.instrument')} required={needsEquipment && outcome !== 'NOT_APPLICABLE'}>
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      value={equipment}
                      maxLength={120}
                      onChange={(event) => {
                        setEquipment(event.target.value);
                      }}
                    />
                  )}
                </Field>
                <Field label={t('job.checklist.calibratedUntil')} required={needsEquipment && outcome !== 'NOT_APPLICABLE'}>
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      type="date"
                      aria-describedby={describedBy}
                      value={calibrated}
                      onChange={(event) => {
                        setCalibrated(event.target.value);
                      }}
                    />
                  )}
                </Field>
                {(needsLab || labReport !== '') && (
                  <EvidenceSelect
                    label={t('job.checklist.labReport')}
                    evidence={evidence}
                    value={labReport}
                    onChange={setLabReport}
                    required={needsLab && outcome !== 'NOT_APPLICABLE'}
                  />
                )}
              </div>
              <Field label={t('job.checklist.note')}>
                {({ inputId, describedBy }) => (
                  <Textarea
                    id={inputId}
                    aria-describedby={describedBy}
                    value={note}
                    maxLength={1000}
                    className="min-h-16"
                    onChange={(event) => {
                      setNote(event.target.value);
                    }}
                  />
                )}
              </Field>
              {item.mandatory === true && outcome === 'NOT_APPLICABLE' && (
                <p className="text-xs text-warning">{t('job.checklist.mandatoryNotApplicable')}</p>
              )}
              <MutationError error={save.error} />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary" isLoading={save.isPending} disabled={missing} id={`${fieldId}-save`}>
                  {t('job.checklist.save')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setOutcome(null);
                  }}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
