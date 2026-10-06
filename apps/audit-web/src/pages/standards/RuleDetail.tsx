/**
 * One rule version: every field, its other versions, its approval history and
 * the actions its status allows.
 *
 * Maker-checker is the server's rule, and this screen says it: the person who
 * drafted a version can never approve it. The approve button is hidden from
 * the drafter, and the server refuses it anyway.
 */
import { useState } from 'react';
import { Button, Callout, DescriptionList, Field, Textarea } from '@/components/ui';
import { EnumBadge, HistoryList, MutationError, QueryBoundary, SectionHeading } from '@/components/console';
import { Modal } from '@/components/Modal';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import {
  approveRule,
  consoleKeys,
  fetchRule,
  rejectRule,
  retireRule,
  reviseRule,
  submitRule,
} from '@/lib/console-api';
import type { CoverageRow, RuleDetail as RuleDetailData } from '@/lib/console-types';
import { enumLabel } from '@/lib/enum-labels';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import { RuleForm } from './RuleForm';
import { categoryNames } from './standards-helpers';

type NoteAction = 'approve' | 'reject' | 'retire';

export function RuleDetail({
  ruleId,
  onClose,
  onOpenRule,
  categories,
}: {
  ruleId: string;
  onClose: () => void;
  onOpenRule: (id: string) => void;
  categories: CoverageRow[];
}): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: consoleKeys.rule(ruleId), queryFn: () => fetchRule(ruleId) });

  return (
    <Modal isOpen onClose={onClose} size="xl" title={query.data === undefined ? t('rules.detail.title') : `${query.data.rule.code} · v${String(query.data.rule.ruleVersion)}`}>
      <QueryBoundary query={query}>
        {(data) => <RuleDetailBody data={data} onOpenRule={onOpenRule} categories={categories} />}
      </QueryBoundary>
    </Modal>
  );
}

function RuleDetailBody({
  data,
  onOpenRule,
  categories,
}: {
  data: RuleDetailData;
  onOpenRule: (id: string) => void;
  categories: CoverageRow[];
}): React.JSX.Element {
  const { t } = useI18n();
  const { session, can } = useSession();
  const { rule } = data;
  const names = categoryNames(categories);
  const [editing, setEditing] = useState(false);
  const [noteAction, setNoteAction] = useState<NoteAction | null>(null);
  const [note, setNote] = useState('');

  const invalidate = [consoleKeys.rulesAll(), consoleKeys.rule(rule.id), consoleKeys.coverage()];
  const submit = useConsoleMutation({
    mutationFn: (_variables, key) => submitRule(rule.id, key),
    invalidate,
    successMessage: t('rules.detail.submitted'),
  });
  const revise = useConsoleMutation({
    mutationFn: (_variables, key) => reviseRule(rule.id, key),
    invalidate,
    successMessage: t('rules.detail.revised'),
    onSuccess: (created) => {
      onOpenRule(created.id);
    },
  });
  const decide = useConsoleMutation<{ action: NoteAction; text: string }>({
    mutationFn: ({ action, text }, key) =>
      action === 'approve' ? approveRule(rule.id, text, key) : action === 'reject' ? rejectRule(rule.id, text, key) : retireRule(rule.id, text, key),
    invalidate,
    successMessage: (_result, { action }) => t(`rules.detail.done.${action}`),
    onSuccess: () => {
      setNoteAction(null);
      setNote('');
    },
  });

  const mayDraft = can(Permission.RULE_DRAFT);
  const mayApprove = can(Permission.RULE_APPROVE);
  const isDrafter = session !== null && rule.draftedByUserId === session.user.id;
  const status = rule.status;

  const list = (values: string[], render: (value: string) => string = (value) => value): string =>
    values.length === 0 ? t('rules.detail.anyValue') : values.map(render).join(', ');

  const actionError = submit.error ?? revise.error ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <EnumBadge family="ruleStatus" value={status} />
        <EnumBadge family="obligation" value={rule.obligation} dot={false} />
        <EnumBadge family="applicability" value={rule.applicability} dot={false} />
        {rule.confidence !== null && (
          <span className="text-xs text-ink-muted">
            {t('rules.field.confidence')}: {enumLabel(t, 'confidence', rule.confidence)}
          </span>
        )}
      </div>

      {(status === 'DRAFT' || status === 'IN_REVIEW') && (
        <Callout tone="warning" title={t('rules.detail.notInForceTitle')}>
          {t('rules.detail.notInForceBody')}
        </Callout>
      )}

      <div className="flex flex-wrap gap-2">
        {status === 'DRAFT' && mayDraft && (
          <>
            <Button
              onClick={() => {
                setEditing(true);
              }}
            >
              {t('common.edit')}
            </Button>
            <Button
              variant="primary"
              isLoading={submit.isPending}
              onClick={() => {
                submit.mutate();
              }}
            >
              {t('rules.detail.submit')}
            </Button>
          </>
        )}
        {status === 'IN_REVIEW' && mayApprove && !isDrafter && (
          <Button
            variant="primary"
            onClick={() => {
              setNoteAction('approve');
            }}
          >
            {t('rules.detail.approve')}
          </Button>
        )}
        {status === 'IN_REVIEW' && mayApprove && (
          <Button
            variant="danger"
            onClick={() => {
              setNoteAction('reject');
            }}
          >
            {t('rules.detail.reject')}
          </Button>
        )}
        {(status === 'APPROVED' || status === 'REJECTED') && mayDraft && (
          <Button
            isLoading={revise.isPending}
            onClick={() => {
              revise.mutate();
            }}
          >
            {t('rules.detail.revise')}
          </Button>
        )}
        {(status === 'DRAFT' || status === 'APPROVED' || status === 'REJECTED') && mayApprove && (
          <Button
            variant="ghost"
            onClick={() => {
              setNoteAction('retire');
            }}
          >
            {t('rules.detail.retire')}
          </Button>
        )}
      </div>
      {status === 'IN_REVIEW' && mayApprove && isDrafter && (
        <Callout tone="info">{t('rules.detail.ownDraft')}</Callout>
      )}
      {actionError !== null && <MutationError error={actionError} />}

      {noteAction !== null && (
        <form
          className="space-y-3 rounded-md border border-border bg-surface-sunken p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (note.trim().length < 10) return;
            decide.mutate({ action: noteAction, text: note.trim() });
          }}
        >
          <Field
            label={t(`rules.detail.noteLabel.${noteAction}`)}
            hint={t('common.reasonHint')}
            required
            error={note.length > 0 && note.trim().length < 10 ? t('rules.form.problem.tooShort') : undefined}
          >
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                }}
              />
            )}
          </Field>
          {decide.isError && <MutationError error={decide.error} />}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              onClick={() => {
                setNoteAction(null);
                setNote('');
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              variant={noteAction === 'approve' ? 'primary' : 'danger'}
              isLoading={decide.isPending}
              disabled={note.trim().length < 10}
            >
              {t(`rules.detail.confirm.${noteAction}`)}
            </Button>
          </div>
        </form>
      )}

      <section>
        <SectionHeading title={rule.name} />
        <p className="whitespace-pre-line text-sm leading-relaxed text-ink">{rule.description}</p>
      </section>

      <DescriptionList
        items={[
          { label: t('rules.field.requiredEvidence'), value: <span className="whitespace-pre-line">{rule.requiredEvidence}</span> },
          { label: t('rules.field.level'), value: enumLabel(t, 'caseLevel', rule.level) },
          {
            label: t('rules.field.categories'),
            value: rule.categoryIds.map((id) => names.get(id) ?? id).join(', '),
          },
          { label: t('rules.field.includeDescendants'), value: rule.includeDescendants ? t('common.yes') : t('common.no') },
          { label: t('rules.field.supplyRoles'), value: list(rule.supplyRoles, (value) => enumLabel(t, 'supplyRole', value)) },
          { label: t('rules.field.riskClasses'), value: list(rule.riskClasses, (value) => enumLabel(t, 'riskClass', value)) },
          { label: t('rules.field.originCountries'), value: list(rule.originCountries) },
          { label: t('rules.field.destinationMarkets'), value: list(rule.destinationMarkets) },
          { label: t('rules.field.productTypeNote'), value: rule.productTypeNote ?? '—' },
          { label: t('rules.field.intendedUseNote'), value: rule.intendedUseNote ?? '—' },
          { label: t('rules.field.applicabilityNote'), value: rule.applicabilityNote ?? '—' },
          {
            label: t('rules.field.expiryKind'),
            value:
              rule.expiryKind === 'PERIODIC_REVIEW' && rule.reviewMonths !== null
                ? t('rules.detail.everyMonths', { months: rule.reviewMonths })
                : enumLabel(t, 'expiryKind', rule.expiryKind),
          },
          {
            label: t('rules.field.source'),
            value: (
              <a href={rule.sourceUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline-offset-2 hover:underline">
                {rule.sourceTitle} — {rule.sourcePublisher}
                <span className="sr-only"> {t('rules.opensInNewTab')}</span>
              </a>
            ),
          },
          { label: t('rules.field.lastReviewedOn'), value: formatCalendarDate(rule.lastReviewedOn) },
          { label: t('rules.field.effectiveFrom'), value: formatDateTime(rule.effectiveFrom) },
          { label: t('rules.detail.effectiveTo'), value: formatDateTime(rule.effectiveTo) },
          { label: t('rules.detail.draftedBy'), value: rule.draftedByLabel ?? '—' },
          { label: t('rules.detail.submittedAt'), value: formatDateTime(rule.submittedAt) },
          {
            label: t('rules.detail.decidedBy'),
            value: rule.decidedByLabel === null ? '—' : `${rule.decidedByLabel} · ${formatDateTime(rule.decidedAt)}`,
          },
          { label: t('rules.detail.decisionNote'), value: rule.decisionNote ?? '—' },
          { label: t('rules.detail.importedFrom'), value: rule.importedFrom ?? '—' },
        ]}
      />

      <section>
        <SectionHeading title={t('rules.detail.versions')} />
        <ul className="divide-y divide-border-subtle rounded-md border border-border">
          {data.versions.map((version) => (
            <li key={version.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="flex items-center gap-2">
                <span className="font-mono text-ink">v{version.ruleVersion}</span>
                <EnumBadge family="ruleStatus" value={version.status} />
                {version.decidedByLabel !== null && (
                  <span className="text-xs text-ink-muted">
                    {version.decidedByLabel} · {formatDateTime(version.decidedAt)}
                  </span>
                )}
              </span>
              {version.id === rule.id ? (
                <span className="text-xs font-medium text-ink-muted">{t('rules.detail.thisVersion')}</span>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onOpenRule(version.id);
                  }}
                >
                  {t('common.open')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <SectionHeading title={t('rules.detail.approvalHistory')} />
        <HistoryList entries={data.history} />
      </section>

      {editing && (
        <RuleForm
          isOpen
          rule={rule}
          categories={categories}
          onClose={() => {
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}
