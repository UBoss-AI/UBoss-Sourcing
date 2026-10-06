/**
 * Add a version of an inspection plan for one category.
 *
 * A plan is the category's checklist and its sampling settings: inspection
 * level and an AQL per defect severity, read against MIL-STD-105E / ANSI/ASQ
 * Z1.4 single sampling. The category is required here on purpose - a plan
 * belongs to the category it was written for, and a generic one is never
 * presented as approved for any category.
 */
import { useState } from 'react';
import { Button, Callout, CheckboxField, Field, FieldGroup, Input, Select } from '@/components/ui';
import { MutationError } from '@/components/console';
import { Modal } from '@/components/Modal';
import { useI18n } from '@/i18n/i18n-context';
import { consoleKeys, createPlan } from '@/lib/console-api';
import { CHECKLIST_SECTIONS, CHECK_KINDS, type CoverageRow } from '@/lib/console-types';
import { enumLabel } from '@/lib/enum-labels';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import {
  CHECK_CODE_PATTERN,
  INSPECTION_LEVELS,
  SUPPORTED_AQL,
  emptyPlanLine,
  todayIso,
  type PlanLineValues,
} from './standards-helpers';

export function PlanForm({
  isOpen,
  onClose,
  categories,
}: {
  isOpen: boolean;
  onClose: () => void;
  categories: CoverageRow[];
}): React.JSX.Element {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [level, setLevel] = useState<string>('II');
  const [aqlCritical, setAqlCritical] = useState('0');
  const [aqlMajor, setAqlMajor] = useState('2.5');
  const [aqlMinor, setAqlMinor] = useState('4.0');
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [effectiveTo, setEffectiveTo] = useState('');
  const [language, setLanguage] = useState('en');
  const [isActive, setIsActive] = useState(true);
  const [lines, setLines] = useState<PlanLineValues[]>(() => [emptyPlanLine()]);
  const [showProblems, setShowProblems] = useState(false);

  const codes = lines.map((line) => line.code.trim().toUpperCase());
  const lineProblem = (line: PlanLineValues, index: number): string | undefined => {
    if (!CHECK_CODE_PATTERN.test(line.code.trim())) return t('checklists.form.problem.code');
    if (codes.indexOf(line.code.trim().toUpperCase()) !== index) return t('checklists.form.problem.duplicate');
    if (line.label.trim() === '') return t('checklists.form.problem.label');
    return undefined;
  };
  const problems = {
    name: name.trim().length < 2 ? t('checklists.form.problem.name') : undefined,
    category: categoryId === '' ? t('checklists.form.problem.category') : undefined,
    effectiveTo:
      effectiveTo !== '' && effectiveTo <= effectiveFrom ? t('checklists.form.problem.endBeforeStart') : undefined,
    language: /^[a-z]{2,8}$/i.test(language.trim()) ? undefined : t('checklists.form.problem.language'),
  };
  const anyProblem = Object.values(problems).some((value) => value !== undefined) || lines.some((line, index) => lineProblem(line, index) !== undefined);
  const show = (message: string | undefined): string | undefined => (showProblems ? message : undefined);

  const save = useConsoleMutation({
    mutationFn: (_variables, key) =>
      createPlan(
        {
          name: name.trim(),
          categoryId,
          isActive,
          effectiveFrom,
          effectiveTo: effectiveTo === '' ? null : effectiveTo,
          inspectionLevel: level,
          aqlCritical,
          aqlMajor,
          aqlMinor,
          language: language.trim().toLowerCase(),
          checklist: lines.map((line) => ({
            code: line.code.trim(),
            section: line.section,
            label: line.label.trim(),
            requirement: line.requirement.trim() === '' ? null : line.requirement.trim(),
            tolerance: line.tolerance.trim() === '' ? null : line.tolerance.trim(),
            ...(line.kind === '' ? {} : { kind: line.kind }),
            mandatory: line.mandatory,
            requiresLabReport: line.requiresLabReport,
            requiresEquipment: line.requiresEquipment,
          })),
        },
        key,
      ),
    invalidate: [consoleKeys.checklists()],
    successMessage: t('checklists.form.saved'),
    onSuccess: () => {
      onClose();
    },
  });

  const update = (key: string, patch: Partial<PlanLineValues>): void => {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };

  const submit = (): void => {
    setShowProblems(true);
    if (anyProblem) return;
    save.mutate();
  };

  const aqlSelect = (label: string, value: string, onChange: (value: string) => void): React.JSX.Element => (
    <Field label={label} required>
      {({ inputId, describedBy }) => (
        <Select
          id={inputId}
          aria-describedby={describedBy}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          {SUPPORTED_AQL.map((aql) => (
            <option key={aql} value={aql}>
              {aql === '0' ? t('checklists.form.aqlZero') : aql}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="xl"
      title={t('checklists.form.title')}
      description={t('checklists.form.description')}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" isLoading={save.isPending} onClick={submit}>
            {t('checklists.form.save')}
          </Button>
        </>
      }
    >
      <form
        className="space-y-7"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Callout tone="info">{t('checklists.form.perCategory')}</Callout>
        {showProblems && anyProblem && (
          <Callout tone="danger" role="alert">
            {t('checklists.form.fixProblems')}
          </Callout>
        )}
        {save.isError && <MutationError error={save.error} />}

        <FieldGroup legend={t('checklists.form.groupPlan')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('checklists.field.name')} required error={show(problems.name)}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={name}
                  invalid={show(problems.name) !== undefined}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label={t('checklists.field.category')} required error={show(problems.category)} {...(categories.length === 0 ? { hint: t('checklists.form.noCategories') } : {})}>
              {({ inputId, describedBy }) => (
                <Select
                  id={inputId}
                  aria-describedby={describedBy}
                  value={categoryId}
                  invalid={show(problems.category) !== undefined}
                  onChange={(event) => {
                    setCategoryId(event.target.value);
                  }}
                >
                  <option value="">{t('checklists.form.chooseCategory')}</option>
                  {categories.map((category) => (
                    <option key={category.categoryId} value={category.categoryId}>
                      {`${'  '.repeat(Math.max(0, category.depth))}${category.name}`}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('checklists.field.effectiveFrom')} required>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  type="date"
                  value={effectiveFrom}
                  onChange={(event) => {
                    setEffectiveFrom(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label={t('checklists.field.effectiveTo')} hint={t('checklists.form.effectiveToHint')} error={show(problems.effectiveTo)}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  type="date"
                  value={effectiveTo}
                  invalid={show(problems.effectiveTo) !== undefined}
                  onChange={(event) => {
                    setEffectiveTo(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label={t('checklists.field.language')} hint={t('checklists.form.languageHint')} required error={show(problems.language)}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={language}
                  maxLength={8}
                  invalid={show(problems.language) !== undefined}
                  onChange={(event) => {
                    setLanguage(event.target.value);
                  }}
                />
              )}
            </Field>
            <div className="flex items-end">
              <CheckboxField
                label={t('checklists.field.active')}
                description={t('checklists.form.activeHint')}
                checked={isActive}
                onChange={(event) => {
                  setIsActive(event.target.checked);
                }}
              />
            </div>
          </div>
        </FieldGroup>

        <FieldGroup legend={t('checklists.form.groupSampling')} hint={t('checklists.samplingExplain')}>
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label={t('checklists.field.level')} required>
              {({ inputId, describedBy }) => (
                <Select
                  id={inputId}
                  aria-describedby={describedBy}
                  value={level}
                  onChange={(event) => {
                    setLevel(event.target.value);
                  }}
                >
                  {INSPECTION_LEVELS.map((value) => (
                    <option key={value} value={value}>
                      {t('checklists.levelOption', { level: value })}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {aqlSelect(t('checklists.field.aqlCritical'), aqlCritical, setAqlCritical)}
            {aqlSelect(t('checklists.field.aqlMajor'), aqlMajor, setAqlMajor)}
            {aqlSelect(t('checklists.field.aqlMinor'), aqlMinor, setAqlMinor)}
          </div>
        </FieldGroup>

        <FieldGroup legend={t('checklists.form.groupLines')} hint={t('checklists.form.linesHint')}>
          <ol className="space-y-4">
            {lines.map((line, index) => {
              const problem = show(lineProblem(line, index));
              return (
                <li key={line.key} className="rounded-md border border-border bg-surface-sunken/60 p-4">
                  <fieldset>
                    <legend className="flex w-full items-center justify-between text-sm font-semibold text-ink">
                      {t('checklists.form.lineNumber', { number: index + 1 })}
                    </legend>
                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <Field label={t('checklists.field.code')} required error={problem}>
                        {({ inputId, describedBy }) => (
                          <Input
                            id={inputId}
                            aria-describedby={describedBy}
                            value={line.code}
                            className="font-mono uppercase"
                            invalid={problem !== undefined}
                            onChange={(event) => {
                              update(line.key, { code: event.target.value.toUpperCase() });
                            }}
                          />
                        )}
                      </Field>
                      <Field label={t('checklists.field.section')} required>
                        {({ inputId, describedBy }) => (
                          <Select
                            id={inputId}
                            aria-describedby={describedBy}
                            value={line.section}
                            onChange={(event) => {
                              update(line.key, { section: event.target.value });
                            }}
                          >
                            {CHECKLIST_SECTIONS.map((section) => (
                              <option key={section} value={section}>
                                {enumLabel(t, 'checklistSection', section)}
                              </option>
                            ))}
                          </Select>
                        )}
                      </Field>
                      <Field label={t('checklists.field.kind')}>
                        {({ inputId, describedBy }) => (
                          <Select
                            id={inputId}
                            aria-describedby={describedBy}
                            value={line.kind}
                            onChange={(event) => {
                              update(line.key, { kind: event.target.value });
                            }}
                          >
                            <option value="">{t('common.notRecorded')}</option>
                            {CHECK_KINDS.map((kind) => (
                              <option key={kind} value={kind}>
                                {enumLabel(t, 'checkKind', kind)}
                              </option>
                            ))}
                          </Select>
                        )}
                      </Field>
                      <div className="sm:col-span-3">
                        <Field label={t('checklists.field.label')} required>
                          {({ inputId, describedBy }) => (
                            <Input
                              id={inputId}
                              aria-describedby={describedBy}
                              value={line.label}
                              maxLength={255}
                              onChange={(event) => {
                                update(line.key, { label: event.target.value });
                              }}
                            />
                          )}
                        </Field>
                      </div>
                      <div className="sm:col-span-2">
                        <Field label={t('checklists.field.requirement')}>
                          {({ inputId, describedBy }) => (
                            <Input
                              id={inputId}
                              aria-describedby={describedBy}
                              value={line.requirement}
                              maxLength={512}
                              onChange={(event) => {
                                update(line.key, { requirement: event.target.value });
                              }}
                            />
                          )}
                        </Field>
                      </div>
                      <Field label={t('checklists.field.tolerance')}>
                        {({ inputId, describedBy }) => (
                          <Input
                            id={inputId}
                            aria-describedby={describedBy}
                            value={line.tolerance}
                            maxLength={128}
                            onChange={(event) => {
                              update(line.key, { tolerance: event.target.value });
                            }}
                          />
                        )}
                      </Field>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
                      <CheckboxField
                        label={t('checklists.field.mandatory')}
                        checked={line.mandatory}
                        onChange={(event) => {
                          update(line.key, { mandatory: event.target.checked });
                        }}
                      />
                      <CheckboxField
                        label={t('checklists.field.requiresLabReport')}
                        checked={line.requiresLabReport}
                        onChange={(event) => {
                          update(line.key, { requiresLabReport: event.target.checked });
                        }}
                      />
                      <CheckboxField
                        label={t('checklists.field.requiresEquipment')}
                        checked={line.requiresEquipment}
                        onChange={(event) => {
                          update(line.key, { requiresEquipment: event.target.checked });
                        }}
                      />
                      {lines.length > 1 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-auto"
                          onClick={() => {
                            setLines((current) => current.filter((entry) => entry.key !== line.key));
                          }}
                        >
                          {t('checklists.form.removeLine', { number: index + 1 })}
                        </Button>
                      )}
                    </div>
                  </fieldset>
                </li>
              );
            })}
          </ol>
          <Button
            className="mt-4"
            disabled={lines.length >= 120}
            onClick={() => {
              setLines((current) => [...current, emptyPlanLine()]);
            }}
          >
            {t('checklists.form.addLine')}
          </Button>
        </FieldGroup>
        <button type="submit" className="sr-only" tabIndex={-1}>
          {t('checklists.form.save')}
        </button>
      </form>
    </Modal>
  );
}
