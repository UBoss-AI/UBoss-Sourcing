/**
 * One shipment between L1 and L2: what it is, what the policy says, the
 * checklist, the evidence, the findings, the history and the documents - and
 * the one decision this person may take next.
 *
 * Every action is checked again on the server; a button that is shown is a
 * convenience, never the control.
 */
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DownloadButton, MutationError, QueryBoundary, Tabs } from '@/components/console';
import { Badge, Button, Callout, Card, CheckboxField, DescriptionList, Field, Input, PageHeader, Select, Textarea } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import {
  assessmentKeys,
  CHECK_OUTCOMES,
  decideQa,
  decideWaiver,
  documentPath,
  evidencePath,
  fetchAssessment,
  fetchWaiverHistory,
  holdShipment,
  openWaiverReview,
  recordChecks,
  recordQuantities,
  requireReassessment,
  resolveException,
  revokeDocument,
  startRound,
  submitRound,
  uploadEvidence,
  type AssessmentDetail,
  type CheckOutcome,
  type ChecklistItem,
  type QuantityInput,
} from '@/lib/shipment-assessment';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import { BadgeTierBadge, StatusBadge } from './status';
import { OUTCOME_TONE } from './tones';

type Tab = 'overview' | 'checklist' | 'evidence' | 'findings' | 'history' | 'documents';
const TABS: Tab[] = ['overview', 'checklist', 'evidence', 'findings', 'history', 'documents'];

export function ShipmentAssessmentDetailPage(): React.JSX.Element {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const query = useQuery({ queryKey: assessmentKeys.detail(id), queryFn: () => fetchAssessment(id) });
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <QueryBoundary query={query}>
      {({ assessment }) => (
        <>
          <PageHeader
            title={assessment.number}
            description={`${assessment.orderNumber} · ${assessment.sellerOrderNumber} · ${assessment.seller}`}
            back={{ to: '/shipment-assessment', label: t('shipmentAssessment.title') }}
            meta={
              <div className="flex flex-wrap gap-2">
                <StatusBadge status={assessment.status} />
                <BadgeTierBadge tier={assessment.badge} />
                {assessment.mandatoryInspection && <Badge tone="warning">{t('shipmentAssessment.mandatory')}</Badge>}
              </div>
            }
          />
          <Actions assessment={assessment} />
          <Tabs label={t('shipmentAssessment.sections')} tabs={TABS.map((key) => ({ key, label: t(`shipmentAssessment.tab.${key}` as TranslationKey) }))} selected={tab} onSelect={setTab}>
            {tab === 'overview' && <Overview assessment={assessment} />}
            {tab === 'checklist' && <Checklist assessment={assessment} />}
            {tab === 'evidence' && <Evidence assessment={assessment} />}
            {tab === 'findings' && <Findings assessment={assessment} />}
            {tab === 'history' && <History assessment={assessment} />}
            {tab === 'documents' && <Documents assessment={assessment} />}
          </Tabs>
        </>
      )}
    </QueryBoundary>
  );
}

function useInvalidate(id: string) {
  return [assessmentKeys.detail(id), assessmentKeys.all] as const;
}

// --- Overview -------------------------------------------------------------------------

function Overview({ assessment: a }: { assessment: AssessmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [note, setNote] = useState('');
  const resolve = useConsoleMutation<string>({
    mutationFn: (exceptionId, key) => resolveException(exceptionId, note, key),
    invalidate: useInvalidate(a.id),
    successMessage: t('shipmentAssessment.saved'),
  });
  return (
    <div className="space-y-4">
      {a.releaseRefusal !== null && a.status !== 'DISPATCHED' && a.status !== 'CANCELLED' && (
        <Callout tone={a.status === 'APPROVED_FOR_L2' ? 'warning' : 'info'}>{t(`shipmentAssessment.refusal.${a.releaseRefusal}` as TranslationKey)}</Callout>
      )}
      {a.existingAtRollout && <Callout tone="warning">{t('shipmentAssessment.rolloutHint')}</Callout>}
      <Card title={t('shipmentAssessment.overview')} bodyClassName="px-5 py-4">
        <DescriptionList
          items={[
            { label: t('shipmentAssessment.col.seller'), value: a.seller },
            { label: t('shipmentAssessment.col.requirement'), value: `${t(`shipmentAssessment.requirement.${a.requirement}` as TranslationKey)} — ${a.requirementReason}` },
            { label: t('shipmentAssessment.mandatory'), value: a.mandatoryInspection ? (a.mandatoryReason ?? t('common.yes')) : t('common.no') },
            { label: t('shipmentAssessment.policyVersion'), value: `v${String(a.policyVersion)}` },
            { label: t('shipmentAssessment.col.l1'), value: a.l1CompletedAt === null ? t('shipmentAssessment.l1Pending') : `${formatDateTime(a.l1CompletedAt)} · ${a.l1Location ?? '—'}` },
            { label: t('shipmentAssessment.col.plannedL2'), value: formatDateTime(a.plannedL2At) },
            { label: t('shipmentAssessment.col.people'), value: `${a.assessor ?? '—'} / ${a.qaReviewer ?? '—'}` },
            { label: t('shipmentAssessment.col.deadline'), value: formatDateTime(a.releaseDeadline) },
            { label: t('shipmentAssessment.loadingChecks'), value: a.loadingChecksCompletedAt === null ? t('shipmentAssessment.pending') : formatDateTime(a.loadingChecksCompletedAt) },
          ]}
        />
      </Card>
      <Card title={t('shipmentAssessment.col.goods')} bodyClassName="px-5 py-4">
        <ul className="space-y-1 text-sm">
          {a.lines.map((line) => (
            <li key={line.sku}>
              {line.name} · {line.sku} · {String(line.quantity)}
            </li>
          ))}
        </ul>
      </Card>
      {(a.readinessNote !== null || a.sellerResponse !== null) && (
        <Card title={t('shipmentAssessment.sellerSays')} bodyClassName="space-y-2 px-5 py-4 text-sm">
          {a.readinessNote !== null && <p>{a.readinessNote}</p>}
          {a.sellerResponse !== null && <p className="border-l-2 border-accent pl-3">{a.sellerResponse}</p>}
        </Card>
      )}
      {a.exceptions.length > 0 && (
        <Card title={t('shipmentAssessment.exceptions')} tone="danger" bodyClassName="space-y-3 px-5 py-4 text-sm">
          {a.exceptions.map((exception) => (
            <div key={exception.id} className="space-y-2">
              <p>
                {formatDateTime(exception.occurredAt)} — {exception.detail}
              </p>
              {exception.resolvedAt === null ? (
                can(Permission.SHIPMENT_ASSESS) && (
                  <div className="flex flex-wrap items-end gap-2">
                    <Input
                      aria-label={t('shipmentAssessment.resolution')}
                      value={note}
                      onChange={(event) => {
                        setNote(event.target.value);
                      }}
                    />
                    <Button
                      size="sm"
                      disabled={note.trim().length < 5 || resolve.isPending}
                      onClick={() => {
                        resolve.mutate(exception.id);
                      }}
                    >
                      {t('shipmentAssessment.resolve')}
                    </Button>
                  </div>
                )
              ) : (
                <p className="text-ink-muted">{exception.resolutionNote}</p>
              )}
            </div>
          ))}
          <MutationError error={resolve.error} />
        </Card>
      )}
    </div>
  );
}

// --- Actions --------------------------------------------------------------------------

function DeadlineFields({ value, onChange }: { value: { dispatchDeadline: string; deadlineJustification: string }; onChange: (next: { dispatchDeadline: string; deadlineJustification: string }) => void }) {
  const { t } = useI18n();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('shipmentAssessment.deadline')} hint={t('shipmentAssessment.deadlineHint')}>
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            type="datetime-local"
            value={value.dispatchDeadline}
            onChange={(event) => {
              onChange({ ...value, dispatchDeadline: event.target.value });
            }}
          />
        )}
      </Field>
      <Field label={t('shipmentAssessment.deadlineJustification')}>
        {({ inputId }) => (
          <Input
            id={inputId}
            value={value.deadlineJustification}
            onChange={(event) => {
              onChange({ ...value, deadlineJustification: event.target.value });
            }}
          />
        )}
      </Field>
    </div>
  );
}

const plain = (value: unknown): string => (typeof value === 'number' || typeof value === 'string' ? String(value) : '');
const iso = (local: string): string | null => (local === '' ? null : new Date(local).toISOString());

function Actions({ assessment: a }: { assessment: AssessmentDetail }): React.JSX.Element | null {
  const { t } = useI18n();
  const { can, session } = useSession();
  const invalidate = useInvalidate(a.id);
  const [reason, setReason] = useState('');
  const [deadline, setDeadline] = useState({ dispatchDeadline: '', deadlineJustification: '' });
  const [review, setReview] = useState('');
  const [qaNote, setQaNote] = useState('');
  const done = { invalidate, successMessage: t('shipmentAssessment.saved') };

  const start = useConsoleMutation({ mutationFn: (_vars, key) => startRound(a.id, a.version, key), ...done });
  const waiverReview = useConsoleMutation({ mutationFn: (_vars, key) => openWaiverReview(a.id, a.version, key), ...done });
  const waiver = useConsoleMutation<'APPROVED' | 'REJECTED'>({
    mutationFn: (decision, key) =>
      decideWaiver(a.id, { decision, reason, historyReviewNote: review.trim() === '' ? null : review, evidenceRefs: [], expectedVersion: a.version, dispatchDeadline: iso(deadline.dispatchDeadline), deadlineJustification: deadline.deadlineJustification || null }, key),
    ...done,
  });
  const qa = useConsoleMutation<'APPROVED' | 'RETURNED'>({
    mutationFn: (decision, key) => decideQa(a.id, { decision, note: qaNote || null, expectedVersion: a.version, dispatchDeadline: iso(deadline.dispatchDeadline), deadlineJustification: deadline.deadlineJustification || null }, key),
    ...done,
  });
  const hold = useConsoleMutation({ mutationFn: (_vars, key) => holdShipment(a.id, { reason, expectedVersion: a.version }, key), ...done });
  const reassess = useConsoleMutation({ mutationFn: (_vars, key) => requireReassessment(a.id, { reason, expectedVersion: a.version }, key), ...done });
  const history = useQuery({ queryKey: assessmentKeys.history(a.id), queryFn: () => fetchWaiverHistory(a.id), enabled: a.status === 'WAIVER_REVIEW' && can(Permission.SHIPMENT_WAIVE) });

  const open = a.status !== 'DISPATCHED' && a.status !== 'CANCELLED';
  if (!open) return null;
  const canAssess = can(Permission.SHIPMENT_ASSESS);
  const sameAssessor = a.assessorUserId !== null && a.assessorUserId === session?.user.id;

  return (
    <Card title={t('shipmentAssessment.nextStep')} className="mb-4" bodyClassName="space-y-4 px-5 py-4">
      {(a.status === 'READY_FOR_ASSESSMENT' || a.status === 'REASSESSMENT_REQUIRED') && canAssess && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={start.isPending || a.l1CompletedAt === null}
            onClick={() => {
              start.mutate();
            }}
          >
            {t('shipmentAssessment.startRound')}
          </Button>
          {a.requirement !== 'ASSESSMENT_REQUIRED' && can(Permission.SHIPMENT_WAIVE) && (
            <Button
              disabled={waiverReview.isPending}
              onClick={() => {
                waiverReview.mutate();
              }}
            >
              {t('shipmentAssessment.openWaiverReview')}
            </Button>
          )}
        </div>
      )}
      <MutationError error={start.error ?? waiverReview.error} />

      {a.status === 'WAIVER_REVIEW' && can(Permission.SHIPMENT_WAIVE) && (
        <div className="space-y-3">
          <Callout tone="info">{t('shipmentAssessment.waiverExplain')}</Callout>
          {history.data !== undefined && (
            <div className="grid gap-3 text-sm md:grid-cols-3">
              <div>
                <h3 className="font-semibold">{t('shipmentAssessment.history.inspections')}</h3>
                {history.data.inspections.length === 0 ? <p className="text-ink-muted">{t('shipmentAssessment.none')}</p> : history.data.inspections.map((row) => <p key={row.job}>{`${row.job}: ${row.result} (${formatDateTime(row.at)})`}</p>)}
              </div>
              <div>
                <h3 className="font-semibold">{t('shipmentAssessment.history.assessments')}</h3>
                {history.data.assessments.length === 0 ? <p className="text-ink-muted">{t('shipmentAssessment.none')}</p> : history.data.assessments.map((row) => <p key={`${row.number}-${String(row.round)}`}>{`${row.number} #${String(row.round)}: ${row.outcome}`}</p>)}
              </div>
              <div>
                <h3 className="font-semibold">{t('shipmentAssessment.history.complaints')}</h3>
                <p>{String(history.data.unresolvedComplaints.length)}</p>
              </div>
            </div>
          )}
          {history.data?.available === false && <Callout tone="warning">{t('shipmentAssessment.historyUnavailable')}</Callout>}
          {a.requirement === 'WAIVER_ELIGIBLE_WITH_REVIEW' && (
            <Field label={t('shipmentAssessment.historyReview')} hint={t('shipmentAssessment.historyReviewHint')} required>
              {({ inputId, describedBy }) => (
                <Textarea
                  id={inputId}
                  aria-describedby={describedBy}
                  value={review}
                  onChange={(event) => {
                    setReview(event.target.value);
                  }}
                />
              )}
            </Field>
          )}
          <Field label={t('shipmentAssessment.reason')} required>
            {({ inputId }) => (
              <Textarea
                id={inputId}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            )}
          </Field>
          <DeadlineFields value={deadline} onChange={setDeadline} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={waiver.isPending}
              onClick={() => {
                waiver.mutate('APPROVED');
              }}
            >
              {t('shipmentAssessment.approveWaiver')}
            </Button>
            <Button
              disabled={waiver.isPending}
              onClick={() => {
                waiver.mutate('REJECTED');
              }}
            >
              {t('shipmentAssessment.requireAssessment')}
            </Button>
          </div>
          <MutationError error={waiver.error} />
        </div>
      )}

      {a.status === 'AWAITING_QA' && can(Permission.SHIPMENT_QA) && (
        <div className="space-y-3">
          {sameAssessor && <Callout tone="warning">{t('shipmentAssessment.independence')}</Callout>}
          <Field label={t('shipmentAssessment.qaNote')}>
            {({ inputId }) => (
              <Textarea
                id={inputId}
                value={qaNote}
                onChange={(event) => {
                  setQaNote(event.target.value);
                }}
              />
            )}
          </Field>
          <DeadlineFields value={deadline} onChange={setDeadline} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={qa.isPending || sameAssessor}
              onClick={() => {
                qa.mutate('APPROVED');
              }}
            >
              {t('shipmentAssessment.qaApprove')}
            </Button>
            <Button
              disabled={qa.isPending || sameAssessor}
              onClick={() => {
                qa.mutate('RETURNED');
              }}
            >
              {t('shipmentAssessment.qaReturn')}
            </Button>
          </div>
          <MutationError error={qa.error} />
        </div>
      )}

      {canAssess && a.status !== 'AWAITING_L1' && (
        <details className="rounded-md border border-border-subtle p-3">
          <summary className="cursor-pointer text-sm font-medium">{t('shipmentAssessment.holdOrReassess')}</summary>
          <div className="mt-3 space-y-3">
            <Field label={t('shipmentAssessment.reason')}>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                  }}
                />
              )}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={hold.isPending || reason.trim().length < 5 || a.status === 'ON_HOLD'}
                onClick={() => {
                  hold.mutate();
                }}
              >
                {t('shipmentAssessment.hold')}
              </Button>
              <Button
                disabled={reassess.isPending || reason.trim().length < 5 || !['FAILED', 'ON_HOLD', 'APPROVED_FOR_L2'].includes(a.status)}
                onClick={() => {
                  reassess.mutate();
                }}
              >
                {t('shipmentAssessment.reassess')}
              </Button>
            </div>
            <MutationError error={hold.error ?? reassess.error} />
          </div>
        </details>
      )}
    </Card>
  );
}

// --- Checklist -------------------------------------------------------------------------

interface Draft {
  outcome: CheckOutcome | '';
  note: string;
  measuredValue: string;
  sampled: boolean;
}

function Checklist({ assessment: a }: { assessment: AssessmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const round = a.rounds.find((entry) => entry.round === a.currentRound) ?? null;
  const items: ChecklistItem[] = round?.checklist ?? [];
  const recorded = useMemo(() => new Map(a.checks.filter((check) => check.round === a.currentRound).map((check) => [check.itemCode, check])), [a.checks, a.currentRound]);
  const editable = can(Permission.SHIPMENT_ASSESS) && (a.status === 'IN_PROGRESS' || a.status === 'APPROVED_FOR_L2');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [summary, setSummary] = useState('');
  const [quantities, setQuantities] = useState<QuantityInput>({});
  const invalidate = useInvalidate(a.id);
  const save = useConsoleMutation({
    mutationFn: (_vars, key) =>
      recordChecks(
        a.id,
        Object.entries(drafts)
          .filter(([, draft]) => draft.outcome !== '')
          .map(([itemCode, draft]) => ({ itemCode, outcome: draft.outcome as CheckOutcome, note: draft.note || null, measuredValue: draft.measuredValue || null, sampled: draft.sampled })),
        key,
      ),
    invalidate,
    successMessage: t('shipmentAssessment.saved'),
    onSuccess: () => {
      setDrafts({});
    },
  });
  const saveQuantities = useConsoleMutation({ mutationFn: (_vars, key) => recordQuantities(a.id, quantities, key), invalidate, successMessage: t('shipmentAssessment.saved') });
  const submit = useConsoleMutation({ mutationFn: (_vars, key) => submitRound(a.id, { findingsSummary: summary, expectedVersion: a.version }, key), invalidate, successMessage: t('shipmentAssessment.saved') });

  if (round === null) return <Callout tone="info">{t('shipmentAssessment.noRound')}</Callout>;
  const phaseAllowed = (item: ChecklistItem) => a.status === 'IN_PROGRESS' || item.phase === 'LOADING';
  const draftOf = (code: string): Draft => {
    const check = recorded.get(code);
    return drafts[code] ?? { outcome: check?.outcome ?? '', note: check?.note ?? '', measuredValue: check?.measuredValue ?? '', sampled: check?.sampled ?? false };
  };
  const setDraft = (code: string, patch: Partial<Draft>) => {
    setDrafts((current) => ({ ...current, [code]: { ...draftOf(code), ...patch } }));
  };
  const sections = [...new Set(items.map((item) => item.section))];
  const q = round.quantities;
  const numberField = (key: keyof QuantityInput, label: string) => (
    <Field label={label}>
      {({ inputId }) => (
        <Input
          id={inputId}
          type="number"
          min={0}
          inputMode="numeric"
          disabled={a.status !== 'IN_PROGRESS'}
          defaultValue={plain((q as unknown as Record<string, unknown>)[key])}
          onChange={(event) => {
            setQuantities((current) => ({ ...current, [key]: event.target.value === '' ? null : Number(event.target.value) }));
          }}
        />
      )}
    </Field>
  );
  const textField = (key: keyof QuantityInput, label: string) => (
    <Field label={label}>
      {({ inputId }) => (
        <Input
          id={inputId}
          disabled={a.status !== 'IN_PROGRESS'}
          defaultValue={plain((q as unknown as Record<string, unknown>)[key])}
          onChange={(event) => {
            setQuantities((current) => ({ ...current, [key]: event.target.value }));
          }}
        />
      )}
    </Field>
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-muted">{t('shipmentAssessment.checklistIntro', { version: round.checklistVersion, round: String(round.round) })}</p>
      {sections.map((section) => (
        <Card key={section} title={t(`shipmentAssessment.section.${section}` as TranslationKey)} bodyClassName="divide-y divide-border-subtle">
          {items
            .filter((item) => item.section === section)
            .map((item) => {
              const draft = draftOf(item.code);
              const canEdit = editable && phaseAllowed(item);
              return (
                <div key={item.code} className="grid gap-2 px-4 py-3 md:grid-cols-[1fr_10rem_14rem]">
                  <div className="text-sm">
                    <span className="font-mono text-xs text-ink-muted">{item.code}</span> {item.label}
                    <div className="mt-1 flex flex-wrap gap-1">
                      {item.phase === 'LOADING' && <Badge tone="operational">{t('shipmentAssessment.loadingPhase')}</Badge>}
                      {item.evidenceRequired && <Badge tone="neutral">{t('shipmentAssessment.evidenceRequired')}</Badge>}
                      {recorded.get(item.code) !== undefined && <Badge tone={OUTCOME_TONE[recorded.get(item.code)?.outcome ?? 'HOLD']}>{t(`shipmentAssessment.outcome.${recorded.get(item.code)?.outcome ?? 'HOLD'}` as TranslationKey)}</Badge>}
                    </div>
                  </div>
                  <Select
                    aria-label={`${item.code} ${t('shipmentAssessment.result')}`}
                    disabled={!canEdit}
                    value={draft.outcome}
                    onChange={(event) => {
                      setDraft(item.code, { outcome: event.target.value as CheckOutcome });
                    }}
                  >
                    <option value="">{t('shipmentAssessment.notRecorded')}</option>
                    {CHECK_OUTCOMES.map((outcome) => (
                      <option key={outcome} value={outcome}>
                        {t(`shipmentAssessment.outcome.${outcome}` as TranslationKey)}
                      </option>
                    ))}
                  </Select>
                  <div className="space-y-1">
                    <Input
                      aria-label={`${item.code} ${t('shipmentAssessment.note')}`}
                      placeholder={draft.outcome === 'NOT_APPLICABLE' ? t('shipmentAssessment.naReason') : t('shipmentAssessment.note')}
                      disabled={!canEdit}
                      value={draft.note}
                      onChange={(event) => {
                        setDraft(item.code, { note: event.target.value });
                      }}
                    />
                    <CheckboxField
                      label={t('shipmentAssessment.sampled')}
                      disabled={!canEdit}
                      checked={draft.sampled}
                      onChange={(event) => {
                        setDraft(item.code, { sampled: event.target.checked });
                      }}
                    />
                  </div>
                </div>
              );
            })}
        </Card>
      ))}
      {editable && (
        <div className="sticky bottom-2 z-10 flex justify-end">
          <Button
            variant="primary"
            disabled={save.isPending || Object.keys(drafts).length === 0}
            onClick={() => {
              save.mutate();
            }}
          >
            {t('shipmentAssessment.saveChecks')}
          </Button>
        </div>
      )}
      <MutationError error={save.error} />

      {round.kind === 'ASSESSMENT' && (
        <Card title={t('shipmentAssessment.quantities')} description={t('shipmentAssessment.quantitiesHint')} bodyClassName="space-y-3 px-5 py-4">
          <p className="text-sm">{t('shipmentAssessment.ordered', { units: String(q.orderedQuantity ?? 0) })}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {numberField('declaredQuantity', t('shipmentAssessment.q.declared'))}
            {numberField('presentedQuantity', t('shipmentAssessment.q.presented'))}
            {numberField('countedQuantity', t('shipmentAssessment.q.counted'))}
            {numberField('sampledQuantity', t('shipmentAssessment.q.sampled'))}
            {numberField('approvedQuantity', t('shipmentAssessment.q.approved'))}
            {numberField('unitsPerPackage', t('shipmentAssessment.q.unitsPerPackage'))}
            {numberField('packagesDeclared', t('shipmentAssessment.q.packagesDeclared'))}
            {numberField('packagesCounted', t('shipmentAssessment.q.packagesCounted'))}
            {textField('sellingUnit', t('shipmentAssessment.q.sellingUnit'))}
            {textField('countingMethod', t('shipmentAssessment.q.countingMethod'))}
            {textField('samplingMethod', t('shipmentAssessment.q.samplingMethod'))}
            {textField('inspectionLocation', t('shipmentAssessment.q.location'))}
          </div>
          {a.status === 'IN_PROGRESS' && can(Permission.SHIPMENT_ASSESS) && (
            <Button
              disabled={saveQuantities.isPending}
              onClick={() => {
                saveQuantities.mutate();
              }}
            >
              {t('shipmentAssessment.saveQuantities')}
            </Button>
          )}
          <MutationError error={saveQuantities.error} />
        </Card>
      )}

      {a.status === 'IN_PROGRESS' && can(Permission.SHIPMENT_ASSESS) && (
        <Card title={t('shipmentAssessment.submit')} description={t('shipmentAssessment.submitHint')} bodyClassName="space-y-3 px-5 py-4">
          <Field label={t('shipmentAssessment.findingsSummary')} required>
            {({ inputId }) => (
              <Textarea
                id={inputId}
                value={summary}
                onChange={(event) => {
                  setSummary(event.target.value);
                }}
              />
            )}
          </Field>
          <Button
            variant="primary"
            disabled={submit.isPending || summary.trim().length < 3}
            onClick={() => {
              submit.mutate();
            }}
          >
            {t('shipmentAssessment.submit')}
          </Button>
          <MutationError error={submit.error} describeDetail={(detail) => `${detail.field}: ${t(`shipmentAssessment.detail.${detail.code}` as TranslationKey)}`} />
        </Card>
      )}
    </div>
  );
}

// --- Evidence ---------------------------------------------------------------------------

function Evidence({ assessment: a }: { assessment: AssessmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [file, setFile] = useState<File | null>(null);
  const [itemCode, setItemCode] = useState('');
  const [note, setNote] = useState('');
  const items = a.rounds.find((round) => round.round === a.currentRound)?.checklist ?? [];
  const upload = useConsoleMutation({
    mutationFn: (_vars, key) => uploadEvidence(a.id, { file: file as File, itemCode: itemCode || null, note: note || null }, key),
    invalidate: useInvalidate(a.id),
    successMessage: t('shipmentAssessment.saved'),
    onSuccess: () => {
      setFile(null);
      setNote('');
    },
  });
  return (
    <div className="space-y-4">
      {can(Permission.SHIPMENT_ASSESS) && a.status !== 'DISPATCHED' && a.status !== 'CANCELLED' && (
        <Card title={t('shipmentAssessment.addEvidence')} bodyClassName="grid gap-3 px-5 py-4 sm:grid-cols-3">
          <Field label={t('shipmentAssessment.file')}>
            {({ inputId }) => (
              <Input
                id={inputId}
                type="file"
                accept="image/*,application/pdf"
                capture="environment"
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                }}
              />
            )}
          </Field>
          <Field label={t('shipmentAssessment.item')}>
            {({ inputId }) => (
              <Select
                id={inputId}
                value={itemCode}
                onChange={(event) => {
                  setItemCode(event.target.value);
                }}
              >
                <option value="">{t('shipmentAssessment.wholeShipment')}</option>
                {items.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.code}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('shipmentAssessment.note')}>
            {({ inputId }) => (
              <Input
                id={inputId}
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                }}
              />
            )}
          </Field>
          <div className="sm:col-span-3">
            <Button
              variant="primary"
              disabled={file === null || upload.isPending}
              onClick={() => {
                upload.mutate();
              }}
            >
              {t('shipmentAssessment.upload')}
            </Button>
            <MutationError error={upload.error} />
          </div>
        </Card>
      )}
      <Card title={t('shipmentAssessment.tab.evidence')} bodyClassName="divide-y divide-border-subtle">
        {a.evidence.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-muted">{t('shipmentAssessment.none')}</p>
        ) : (
          a.evidence.map((item) => (
            <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
              <span>
                #{String(item.round)} · {item.itemCode ?? t('shipmentAssessment.wholeShipment')} · {item.fileName} · {t(`shipmentAssessment.role.${item.uploadedByRole}` as TranslationKey)} · {formatDateTime(item.createdAt)}
              </span>
              <DownloadButton path={evidencePath(a.id, item.id)} fileName={item.fileName} />
            </div>
          ))
        )}
      </Card>
    </div>
  );
}

// --- Findings ---------------------------------------------------------------------------

function Findings({ assessment: a }: { assessment: AssessmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  if (a.rounds.length === 0) return <Callout tone="info">{t('shipmentAssessment.noRound')}</Callout>;
  return (
    <div className="space-y-4">
      {a.holdReason !== null && <Callout tone="danger">{a.holdReason}</Callout>}
      {[...a.rounds].reverse().map((round) => {
        const issues = a.checks.filter((check) => check.round === round.round && (check.outcome === 'FAIL' || check.outcome === 'HOLD'));
        const sampled = round.quantities.sampledQuantity !== null && round.quantities.countedQuantity !== null && round.quantities.sampledQuantity < round.quantities.countedQuantity;
        return (
          <Card key={round.round} title={t('shipmentAssessment.roundTitle', { round: String(round.round) })} description={t(`shipmentAssessment.roundKind.${round.kind}` as TranslationKey)} bodyClassName="space-y-2 px-5 py-4 text-sm">
            <div className="flex flex-wrap gap-2">
              {round.outcome !== null && <Badge tone={round.outcome === 'PASSED' ? 'success' : 'danger'}>{t(`shipmentAssessment.roundOutcome.${round.outcome}` as TranslationKey)}</Badge>}
              {round.qaDecision !== null && <Badge tone="neutral">{t(`shipmentAssessment.qa.${round.qaDecision}` as TranslationKey)}</Badge>}
            </div>
            {sampled && <Callout tone="info">{t('shipmentAssessment.sampledNotice', { sampled: String(round.quantities.sampledQuantity), counted: String(round.quantities.countedQuantity) })}</Callout>}
            {round.findingsSummary !== null && <p>{round.findingsSummary}</p>}
            {issues.map((check) => (
              <p key={check.itemCode}>
                <Badge tone={OUTCOME_TONE[check.outcome]}>{t(`shipmentAssessment.outcome.${check.outcome}` as TranslationKey)}</Badge> {check.itemCode} — {check.note ?? ''}
              </p>
            ))}
            {round.qaNote !== null && <p className="text-ink-muted">{round.qaNote}</p>}
            {round.correctiveAction !== null && <p className="border-l-2 border-warning pl-3">{round.correctiveAction}</p>}
          </Card>
        );
      })}
      {a.waivers.map((waiver) => (
        <Card key={waiver.id} title={t(`shipmentAssessment.waiverDecision.${waiver.decision}` as TranslationKey)} bodyClassName="space-y-1 px-5 py-4 text-sm">
          <p>
            {waiver.decidedBy ?? '—'} · {formatDateTime(waiver.decidedAt)} · {t(`shipmentAssessment.badge.${waiver.badgeAtDecision ?? 'NONE'}` as TranslationKey)} · v{String(waiver.policyVersion)}
          </p>
          <p>{waiver.reason}</p>
          {waiver.historyReviewNote !== null && <p className="text-ink-muted">{waiver.historyReviewNote}</p>}
          {waiver.invalidatedAt !== null && <Callout tone="warning">{waiver.invalidationReason}</Callout>}
        </Card>
      ))}
    </div>
  );
}

// --- History ----------------------------------------------------------------------------

function History({ assessment: a }: { assessment: AssessmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Card title={t('shipmentAssessment.tab.history')} bodyClassName="px-5 py-4">
      <ol className="space-y-3 text-sm">
        {[...a.events].reverse().map((event) => (
          <li key={event.id} className="border-l-2 border-border-subtle pl-3">
            <p className="font-medium">
              {t(`shipmentAssessment.event.${event.kind}` as TranslationKey, { defaultValue: event.kind })}
              {event.toStatus !== null && ` → ${t(`shipmentAssessment.status.${event.toStatus}` as TranslationKey)}`}
            </p>
            <p className="text-xs text-ink-muted">
              {formatDateTime(event.occurredAt)} · {event.actor ?? t(`shipmentAssessment.role.${event.actorRole}` as TranslationKey)}
            </p>
            {event.note !== null && <p>{event.note}</p>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

// --- Documents --------------------------------------------------------------------------

function Documents({ assessment: a }: { assessment: AssessmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [reason, setReason] = useState('');
  const revoke = useConsoleMutation<string>({ mutationFn: (documentId, key) => revokeDocument(documentId, reason, key), invalidate: useInvalidate(a.id), successMessage: t('shipmentAssessment.saved') });
  return (
    <Card title={t('shipmentAssessment.tab.documents')} description={t('shipmentAssessment.documentsHint')} bodyClassName="divide-y divide-border-subtle">
      {a.documents.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-muted">{t('shipmentAssessment.none')}</p>
      ) : (
        a.documents.map((doc) => (
          <div key={doc.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
            <div>
              <p className="font-medium">
                {t(`shipmentAssessment.docKind.${doc.kind}` as TranslationKey)} · {doc.number} · v{String(doc.version)}
              </p>
              <p className="text-xs text-ink-muted">
                {t(`shipmentAssessment.docStatus.${doc.status}` as TranslationKey)} · {formatDateTime(doc.issuedAt)} · {doc.signedByName}
                {doc.dispatchBy !== null && ` · ${t('shipmentAssessment.dispatchBy', { date: formatDateTime(doc.dispatchBy) })}`}
              </p>
              {doc.revokedReason !== null && <p className="text-xs">{doc.revokedReason}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <DownloadButton path={documentPath(a.id, doc.id)} fileName={`${doc.number}.pdf`} />
              {doc.status === 'ACTIVE' && can(Permission.CERTIFICATE_ISSUE) && (
                <>
                  <Input
                    aria-label={t('shipmentAssessment.revokeReason')}
                    placeholder={t('shipmentAssessment.revokeReason')}
                    value={reason}
                    onChange={(event) => {
                      setReason(event.target.value);
                    }}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={reason.trim().length < 5 || revoke.isPending}
                    onClick={() => {
                      revoke.mutate(doc.id);
                    }}
                  >
                    {t('shipmentAssessment.revoke')}
                  </Button>
                </>
              )}
            </div>
          </div>
        ))
      )}
      <MutationError error={revoke.error} />
    </Card>
  );
}
