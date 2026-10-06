/**
 * Draft a compliance rule, or change a draft.
 *
 * Every field of the server's `requirementInput`, in four groups: what the
 * rule asks for, where it reaches, when it applies and how long it lasts, and
 * the official source it rests on. A draft decides nothing; saving here never
 * approves anything.
 */
import { useState } from 'react';
import { Button, Callout, CheckboxField, Field, FieldGroup, Input, MultiSelect, Select, Textarea } from '@/components/ui';
import { ChipInput, MutationError } from '@/components/console';
import { Modal } from '@/components/Modal';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { consoleKeys, draftRule, updateRule } from '@/lib/console-api';
import { RISK_CLASSES, SUPPLY_ROLES, type CoverageRow, type RuleView } from '@/lib/console-types';
import { enumLabel } from '@/lib/enum-labels';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import { emptyRuleForm, formToRuleInput, ruleFormProblems, ruleToForm, type RuleFormValues } from './standards-helpers';

export function RuleForm({
  isOpen,
  onClose,
  rule,
  categories,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** The draft being changed; absent for a new rule. */
  rule?: RuleView | undefined;
  categories: CoverageRow[];
  onSaved?: (id: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [values, setValues] = useState<RuleFormValues>(() => (rule === undefined ? emptyRuleForm() : ruleToForm(rule)));
  const [showProblems, setShowProblems] = useState(false);
  const problems = ruleFormProblems(values);
  const problemFor = (field: keyof RuleFormValues): string | undefined =>
    showProblems && problems[field] !== undefined ? t(`rules.form.problem.${problems[field]}` as TranslationKey) : undefined;

  const set = <K extends keyof RuleFormValues>(key: K, value: RuleFormValues[K]): void => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const save = useConsoleMutation<RuleFormValues>({
    mutationFn: (form, key) =>
      rule === undefined
        ? draftRule(formToRuleInput(form), key)
        : updateRule(rule.id, { ...formToRuleInput(form), lockVersion: rule.lockVersion }, key),
    invalidate: [consoleKeys.rulesAll(), consoleKeys.coverage(), ...(rule === undefined ? [] : [consoleKeys.rule(rule.id)])],
    successMessage: rule === undefined ? t('rules.form.created') : t('rules.form.updated'),
    onSuccess: (result) => {
      const created = result as { id?: unknown } | null;
      onSaved?.(rule?.id ?? (typeof created?.id === 'string' ? created.id : ''));
      onClose();
    },
  });

  const submit = (): void => {
    setShowProblems(true);
    if (Object.keys(problems).length > 0) return;
    save.mutate(values);
  };

  const toggle = (key: 'supplyRoles' | 'riskClasses', value: string, on: boolean): void => {
    setValues((current) => ({
      ...current,
      [key]: on ? [...current[key], value] : current[key].filter((entry) => entry !== value),
    }));
  };

  const upper = (value: string): string => value.trim().toUpperCase();

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      title={rule === undefined ? t('rules.form.newTitle') : t('rules.form.editTitle', { code: rule.code, version: rule.ruleVersion })}
      description={t('rules.form.description')}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" isLoading={save.isPending} onClick={submit}>
            {t('rules.form.saveDraft')}
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
        {showProblems && Object.keys(problems).length > 0 && (
          <Callout tone="danger" role="alert">
            {t('rules.form.fixProblems')}
          </Callout>
        )}
        {save.isError && <MutationError error={save.error} />}

        <FieldGroup legend={t('rules.form.groupWhat')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('rules.field.code')} hint={t('rules.form.codeHint')} required error={problemFor('code')}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={values.code}
                  disabled={rule !== undefined}
                  invalid={problemFor('code') !== undefined}
                  className="font-mono uppercase"
                  onChange={(event) => {
                    set('code', event.target.value.toUpperCase());
                  }}
                />
              )}
            </Field>
            <Field label={t('rules.field.name')} required error={problemFor('name')}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={values.name}
                  invalid={problemFor('name') !== undefined}
                  onChange={(event) => {
                    set('name', event.target.value);
                  }}
                />
              )}
            </Field>
          </div>
          <div className="mt-4 space-y-4">
            <Field label={t('rules.field.description')} required error={problemFor('description')}>
              {({ inputId, describedBy }) => (
                <Textarea
                  id={inputId}
                  aria-describedby={describedBy}
                  value={values.description}
                  invalid={problemFor('description') !== undefined}
                  onChange={(event) => {
                    set('description', event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label={t('rules.field.requiredEvidence')} hint={t('rules.form.evidenceHint')} required error={problemFor('requiredEvidence')}>
              {({ inputId, describedBy }) => (
                <Textarea
                  id={inputId}
                  aria-describedby={describedBy}
                  value={values.requiredEvidence}
                  invalid={problemFor('requiredEvidence') !== undefined}
                  onChange={(event) => {
                    set('requiredEvidence', event.target.value);
                  }}
                />
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('rules.field.obligation')} required>
                {({ inputId, describedBy }) => (
                  <Select
                    id={inputId}
                    aria-describedby={describedBy}
                    value={values.obligation}
                    onChange={(event) => {
                      set('obligation', event.target.value as RuleFormValues['obligation']);
                    }}
                  >
                    {(['LEGAL', 'CONTRACTUAL', 'OPTIONAL_QUALIFICATION'] as const).map((value) => (
                      <option key={value} value={value}>
                        {enumLabel(t, 'obligation', value)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('rules.field.level')} required>
                {({ inputId, describedBy }) => (
                  <Select
                    id={inputId}
                    aria-describedby={describedBy}
                    value={values.level}
                    onChange={(event) => {
                      set('level', event.target.value as RuleFormValues['level']);
                    }}
                  >
                    {(['SELLER_CATEGORY', 'PRODUCT'] as const).map((value) => (
                      <option key={value} value={value}>
                        {enumLabel(t, 'caseLevel', value)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
          </div>
        </FieldGroup>

        <FieldGroup legend={t('rules.form.groupWhere')} hint={t('rules.form.groupWhereHint')}>
          <div className="space-y-4">
            <Field label={t('rules.field.categories')} hint={t('rules.form.categoriesHint')} required error={problemFor('categoryIds')}>
              {({ inputId, describedBy }) => (
                <MultiSelect
                  id={inputId}
                  aria-describedby={describedBy}
                  value={values.categoryIds}
                  invalid={problemFor('categoryIds') !== undefined}
                  className="h-48"
                  onChange={(event) => {
                    set(
                      'categoryIds',
                      Array.from(event.target.selectedOptions).map((option) => option.value),
                    );
                  }}
                >
                  {categories.map((category) => (
                    <option key={category.categoryId} value={category.categoryId}>
                      {`${'  '.repeat(Math.max(0, category.depth))}${category.name}`}
                    </option>
                  ))}
                </MultiSelect>
              )}
            </Field>
            <CheckboxField
              label={t('rules.field.includeDescendants')}
              description={t('rules.form.includeDescendantsHint')}
              checked={values.includeDescendants}
              onChange={(event) => {
                set('includeDescendants', event.target.checked);
              }}
            />
            <fieldset>
              <legend className="text-sm font-medium text-ink">{t('rules.field.supplyRoles')}</legend>
              <p className="mt-0.5 text-xs text-ink-muted">{t('rules.form.emptyMeansAll')}</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {SUPPLY_ROLES.map((role) => (
                  <CheckboxField
                    key={role}
                    label={enumLabel(t, 'supplyRole', role)}
                    checked={values.supplyRoles.includes(role)}
                    onChange={(event) => {
                      toggle('supplyRoles', role, event.target.checked);
                    }}
                  />
                ))}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <ChipInput
                label={t('rules.field.originCountries')}
                hint={t('rules.form.countriesHint')}
                values={values.originCountries}
                normalise={upper}
                max={60}
                onChange={(next) => {
                  set('originCountries', next);
                }}
              />
              <ChipInput
                label={t('rules.field.destinationMarkets')}
                hint={t('rules.form.marketsHint')}
                values={values.destinationMarkets}
                normalise={upper}
                max={60}
                onChange={(next) => {
                  set('destinationMarkets', next);
                }}
              />
            </div>
            <fieldset>
              <legend className="text-sm font-medium text-ink">{t('rules.field.riskClasses')}</legend>
              <p className="mt-0.5 text-xs text-ink-muted">{t('rules.form.emptyMeansAll')}</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {RISK_CLASSES.map((risk) => (
                  <CheckboxField
                    key={risk}
                    label={enumLabel(t, 'riskClass', risk)}
                    checked={values.riskClasses.includes(risk)}
                    onChange={(event) => {
                      toggle('riskClasses', risk, event.target.checked);
                    }}
                  />
                ))}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('rules.field.productTypeNote')}>
                {({ inputId, describedBy }) => (
                  <Textarea
                    id={inputId}
                    aria-describedby={describedBy}
                    value={values.productTypeNote}
                    onChange={(event) => {
                      set('productTypeNote', event.target.value);
                    }}
                  />
                )}
              </Field>
              <Field label={t('rules.field.intendedUseNote')}>
                {({ inputId, describedBy }) => (
                  <Textarea
                    id={inputId}
                    aria-describedby={describedBy}
                    value={values.intendedUseNote}
                    onChange={(event) => {
                      set('intendedUseNote', event.target.value);
                    }}
                  />
                )}
              </Field>
            </div>
          </div>
        </FieldGroup>

        <FieldGroup legend={t('rules.form.groupWhen')}>
          <div className="space-y-4">
            <Field label={t('rules.field.applicability')} hint={t('rules.form.applicabilityHint')} required>
              {({ inputId, describedBy }) => (
                <Select
                  id={inputId}
                  aria-describedby={describedBy}
                  value={values.applicability}
                  onChange={(event) => {
                    set('applicability', event.target.value as RuleFormValues['applicability']);
                  }}
                >
                  {(['APPLIES', 'CONDITIONAL', 'UNRESOLVED'] as const).map((value) => (
                    <option key={value} value={value}>
                      {enumLabel(t, 'applicability', value)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('rules.field.applicabilityNote')}>
              {({ inputId, describedBy }) => (
                <Textarea
                  id={inputId}
                  aria-describedby={describedBy}
                  value={values.applicabilityNote}
                  onChange={(event) => {
                    set('applicabilityNote', event.target.value);
                  }}
                />
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t('rules.field.expiryKind')} required>
                {({ inputId, describedBy }) => (
                  <Select
                    id={inputId}
                    aria-describedby={describedBy}
                    value={values.expiryKind}
                    onChange={(event) => {
                      set('expiryKind', event.target.value as RuleFormValues['expiryKind']);
                    }}
                  >
                    {(['DOCUMENT_EXPIRY', 'NO_EXPIRY', 'PERIODIC_REVIEW'] as const).map((value) => (
                      <option key={value} value={value}>
                        {enumLabel(t, 'expiryKind', value)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {values.expiryKind === 'PERIODIC_REVIEW' && (
                <Field label={t('rules.field.reviewMonths')} required error={problemFor('reviewMonths')}>
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={240}
                      value={values.reviewMonths}
                      invalid={problemFor('reviewMonths') !== undefined}
                      onChange={(event) => {
                        set('reviewMonths', event.target.value);
                      }}
                    />
                  )}
                </Field>
              )}
              <Field label={t('rules.field.effectiveFrom')} hint={t('rules.form.effectiveFromHint')}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    type="date"
                    value={values.effectiveFrom}
                    onChange={(event) => {
                      set('effectiveFrom', event.target.value);
                    }}
                  />
                )}
              </Field>
            </div>
          </div>
        </FieldGroup>

        <FieldGroup legend={t('rules.form.groupSource')} hint={t('rules.form.groupSourceHint')}>
          <div className="space-y-4">
            <Field label={t('rules.field.sourceUrl')} hint={t('rules.form.sourceUrlHint')} required error={problemFor('sourceUrl')}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  type="url"
                  inputMode="url"
                  value={values.sourceUrl}
                  invalid={problemFor('sourceUrl') !== undefined}
                  onChange={(event) => {
                    set('sourceUrl', event.target.value);
                  }}
                />
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('rules.field.sourceTitle')} required error={problemFor('sourceTitle')}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    value={values.sourceTitle}
                    invalid={problemFor('sourceTitle') !== undefined}
                    onChange={(event) => {
                      set('sourceTitle', event.target.value);
                    }}
                  />
                )}
              </Field>
              <Field label={t('rules.field.sourcePublisher')} required error={problemFor('sourcePublisher')}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    value={values.sourcePublisher}
                    invalid={problemFor('sourcePublisher') !== undefined}
                    onChange={(event) => {
                      set('sourcePublisher', event.target.value);
                    }}
                  />
                )}
              </Field>
              <Field label={t('rules.field.lastReviewedOn')} required error={problemFor('lastReviewedOn')}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    type="date"
                    value={values.lastReviewedOn}
                    invalid={problemFor('lastReviewedOn') !== undefined}
                    onChange={(event) => {
                      set('lastReviewedOn', event.target.value);
                    }}
                  />
                )}
              </Field>
              <Field label={t('rules.field.confidence')} hint={t('rules.form.confidenceHint')}>
                {({ inputId, describedBy }) => (
                  <Select
                    id={inputId}
                    aria-describedby={describedBy}
                    value={values.confidence}
                    onChange={(event) => {
                      set('confidence', event.target.value as RuleFormValues['confidence']);
                    }}
                  >
                    <option value="">{t('common.notRecorded')}</option>
                    {(['HIGH', 'MEDIUM', 'LOW'] as const).map((value) => (
                      <option key={value} value={value}>
                        {enumLabel(t, 'confidence', value)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
          </div>
        </FieldGroup>
        {/* Enter in a field submits; the footer button does the same. */}
        <button type="submit" className="sr-only" tabIndex={-1}>
          {t('rules.form.saveDraft')}
        </button>
      </form>
    </Modal>
  );
}
