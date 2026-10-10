/**
 * One product safety case: scope, containment, trace, actions, correction and
 * release (Doc 07).
 *
 *   GET  /api/v1/audit/safety-cases/:id
 *   GET  /api/v1/audit/safety-cases/:id/trace
 *   POST /api/v1/audit/safety-cases/:id/contain | actions | correction | release
 *
 * A reporting decision is a qualified person's: it names the authority, the
 * decision and the deciding person's role, and there is no AI option. Release
 * needs everything on file and a different person from the one who opened the
 * case; the server enforces both and this screen shows its refusal.
 */
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { QueryBoundary } from '@/components/console';
import { Badge, Button, Callout, Card, CheckboxField, DescriptionList, Field, PageHeader, Select } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import {
  ACTION_KINDS,
  containSafetyCase,
  dateToIso,
  fetchSafetyCase,
  fetchTrace,
  productSafetyKeys,
  recordCorrection,
  recordSafetyAction,
  releaseSafetyCase,
  REPORTING_DECISIONS,
  SEVERITIES,
  type ActionKind,
  type ReportingDecision,
  type SafetyCaseDetail,
  type ScopeInput,
  type Severity,
} from '@/lib/product-safety';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import { ScopeRowsEditor } from './SafetyCasesPage';
import { FormGrid, SafetyMutationError, SeverityBadge, TextField } from './shared';

export function SafetyCaseDetailPage(): React.JSX.Element {
  const { t } = useI18n();
  const { id = '' } = useParams();
  const query = useQuery({ queryKey: productSafetyKeys.case(id), queryFn: () => fetchSafetyCase(id) });
  return (
    <QueryBoundary query={query}>
      {(c) => (
        <>
          <PageHeader
            title={`${c.reference} · ${c.title}`}
            description={c.description}
            back={{ to: '/safety-cases', label: t('productSafety.cases.back') }}
            meta={
              <>
                <SeverityBadge severity={c.severity} />
                <Badge tone={c.status === 'RELEASED' ? 'success' : 'warning'}>{t(`productSafety.caseStatus.${c.status}` as TranslationKey)}</Badge>
              </>
            }
          />
          <div className="space-y-4">
            {c.status !== 'RELEASED' && <Callout tone="info">{t('productSafety.detail.ordersStillManaged')}</Callout>}
            <ScopePanel c={c} />
            <ContainForm c={c} />
            <TracePanel id={c.id} />
            <ActionsPanel c={c} />
            <CorrectionForm c={c} />
            <ReleasePanel c={c} />
          </div>
        </>
      )}
    </QueryBoundary>
  );
}

function ScopePanel({ c }: { c: SafetyCaseDetail }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Card title={t('productSafety.scope.title')}>
      {c.scope.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('productSafety.scope.empty')}</p>
      ) : (
        <ul className="divide-y divide-border-subtle text-sm">
          {c.scope.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-2 py-2">
              <Badge tone="neutral">{t(`productSafety.scopeKind.${row.kind}` as TranslationKey)}</Badge>
              <span className="font-mono text-xs">{row.ref}</span>
              {row.label !== null && <span>{row.label}</span>}
              <Badge tone={row.contained ? 'danger' : 'neutral'}>{row.contained ? t('productSafety.scope.contained') : t('productSafety.scope.notContained')}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ContainForm({ c }: { c: SafetyCaseDetail }): React.JSX.Element | null {
  const { t } = useI18n();
  const { can } = useSession();
  const [severity, setSeverity] = useState<Severity>(c.severity);
  const [stopListings, setStopListings] = useState(true);
  const [stopShipments, setStopShipments] = useState(true);
  const [stopRecurring, setStopRecurring] = useState(true);
  const [note, setNote] = useState('');
  const [addScope, setAddScope] = useState<ScopeInput[]>([]);
  const save = useConsoleMutation({
    mutationFn: (_vars, key) => containSafetyCase(c.id, { severity, stopListings, stopShipments, stopRecurring, note: note.trim(), addScope: addScope.filter((row) => row.ref.trim() !== '').map((row) => ({ kind: row.kind, ref: row.ref.trim() })) }, key),
    invalidate: [productSafetyKeys.case(c.id), productSafetyKeys.cases()],
    successMessage: t('productSafety.detail.contained'),
    onSuccess: () => {
      setNote('');
      setAddScope([]);
    },
  });
  if (!can(Permission.ASSESSMENT_WORK) || c.status === 'RELEASED') return null;
  return (
    <Card title={t('productSafety.detail.containTitle')} description={t('productSafety.detail.containHint')}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Field label={t('productSafety.cases.col.severity')} required>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={severity}
              onChange={(event) => {
                setSeverity(event.target.value as Severity);
              }}
            >
              {SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {t(`productSafety.severity.${value}` as TranslationKey)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <CheckboxField
          label={t('productSafety.detail.stopListings')}
          checked={stopListings}
          onChange={(event) => {
            setStopListings(event.target.checked);
          }}
        />
        <CheckboxField
          label={t('productSafety.detail.stopShipments')}
          checked={stopShipments}
          onChange={(event) => {
            setStopShipments(event.target.checked);
          }}
        />
        <CheckboxField
          label={t('productSafety.detail.stopRecurring')}
          checked={stopRecurring}
          onChange={(event) => {
            setStopRecurring(event.target.checked);
          }}
        />
        <TextField label={t('productSafety.detail.note')} value={note} onChange={setNote} required multiline />
        <ScopeRowsEditor rows={addScope} onChange={setAddScope} />
        <SafetyMutationError error={save.error} />
        <Button type="submit" isLoading={save.isPending}>
          {t('productSafety.detail.contain')}
        </Button>
      </form>
    </Card>
  );
}

function TracePanel({ id }: { id: string }): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: productSafetyKeys.trace(id), queryFn: () => fetchTrace(id) });
  return (
    <Card title={t('productSafety.trace.title')} description={t('productSafety.trace.hint')}>
      <QueryBoundary query={query}>
        {(trace) => (
          <DescriptionList
            columns={3}
            items={[
              { label: t('productSafety.trace.orders'), value: String(trace.orders.length) },
              { label: t('productSafety.trace.unitsSold'), value: String(trace.unitsSold ?? 0) },
              { label: t('productSafety.trace.customers'), value: String(trace.customers) },
              { label: t('productSafety.trace.countries'), value: trace.countries.length === 0 ? '—' : trace.countries.join(', ') },
              { label: t('productSafety.trace.unshipped'), value: trace.unshipped.length === 0 ? '0' : trace.unshipped.map((g) => g.sellerOrderNumber).join(', ') },
              { label: t('productSafety.trace.recurring'), value: String(trace.recurring) },
              { label: t('productSafety.trace.stock'), value: String(trace.stockUnits) },
            ]}
          />
        )}
      </QueryBoundary>
    </Card>
  );
}

export function ActionsPanel({ c }: { c: SafetyCaseDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [kind, setKind] = useState<ActionKind>('REPORTING_DECISION');
  const [detail, setDetail] = useState('');
  const [authority, setAuthority] = useState('');
  const [decision, setDecision] = useState<ReportingDecision | ''>('');
  const [deadline, setDeadline] = useState('');
  const [role, setRole] = useState('');
  const [quantity, setQuantity] = useState('');
  const [effectiveness, setEffectiveness] = useState('');
  const reporting = kind === 'REPORTING_DECISION';
  const save = useConsoleMutation({
    mutationFn: (_vars, key) =>
      recordSafetyAction(
        c.id,
        {
          kind,
          detail: detail.trim(),
          authority: authority.trim() === '' ? null : authority.trim(),
          decision: decision === '' ? null : decision,
          deadlineAt: dateToIso(deadline),
          qualifiedRole: role.trim() === '' ? null : role.trim(),
          quantity: quantity === '' ? null : Number(quantity),
          effectivenessPercentBp: effectiveness === '' ? null : Math.round(Number(effectiveness) * 100),
        },
        key,
      ),
    invalidate: [productSafetyKeys.case(c.id), productSafetyKeys.cases()],
    successMessage: t('productSafety.actions.recorded'),
    onSuccess: () => {
      setDetail('');
      setAuthority('');
      setDecision('');
      setDeadline('');
      setRole('');
      setQuantity('');
      setEffectiveness('');
    },
  });
  return (
    <Card title={t('productSafety.actions.title')}>
      {c.actions.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('productSafety.actions.empty')}</p>
      ) : (
        <ol className="space-y-2 text-sm">
          {c.actions.map((a) => (
            <li key={a.id} className="rounded-md border border-border-subtle px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral">{t(`productSafety.actionKind.${a.kind}` as TranslationKey)}</Badge>
                {a.decision !== null && <Badge tone="action">{t(`productSafety.decision.${a.decision}` as TranslationKey)}</Badge>}
                <span className="text-xs text-ink-muted">{formatDateTime(a.createdAt)}</span>
              </div>
              <p className="mt-1">{a.detail}</p>
              {(a.authority !== null || a.qualifiedRole !== null) && <p className="text-xs text-ink-muted">{[a.authority, a.qualifiedRole].filter((v) => v !== null).join(' · ')}</p>}
              {a.quantity !== null && <p className="text-xs text-ink-muted">{t('productSafety.actions.quantityValue', { quantity: String(a.quantity) })}</p>}
              {a.effectivenessPercentBp !== null && <p className="text-xs text-ink-muted">{t('productSafety.actions.effectivenessValue', { percent: (a.effectivenessPercentBp / 100).toFixed(2) })}</p>}
            </li>
          ))}
        </ol>
      )}
      {can(Permission.ASSESSMENT_WORK) && c.status !== 'RELEASED' && (
        <form
          className="mt-4 space-y-3 border-t border-border-subtle pt-4"
          aria-label={t('productSafety.actions.form')}
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <Field label={t('productSafety.actions.kind')} required>
            {({ inputId }) => (
              <Select
                id={inputId}
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as ActionKind);
                }}
              >
                {ACTION_KINDS.map((value) => (
                  <option key={value} value={value}>
                    {t(`productSafety.actionKind.${value}` as TranslationKey)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {reporting && (
            <>
              <Callout tone="info">{t('productSafety.actions.reportingHint')}</Callout>
              <FormGrid>
                <TextField label={t('productSafety.actions.authority')} value={authority} onChange={setAuthority} required />
                <Field label={t('productSafety.actions.decision')} required>
                  {({ inputId }) => (
                    <Select
                      id={inputId}
                      required
                      value={decision}
                      onChange={(event) => {
                        setDecision(event.target.value as ReportingDecision | '');
                      }}
                    >
                      <option value="">{t('productSafety.actions.choose')}</option>
                      {REPORTING_DECISIONS.map((value) => (
                        <option key={value} value={value}>
                          {t(`productSafety.decision.${value}` as TranslationKey)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <TextField label={t('productSafety.actions.qualifiedRole')} value={role} onChange={setRole} required hint={t('productSafety.actions.qualifiedRoleHint')} />
                <TextField label={t('productSafety.actions.deadline')} type="date" value={deadline} onChange={setDeadline} />
              </FormGrid>
            </>
          )}
          {!reporting && kind !== 'NOTE' && (
            <FormGrid>
              <TextField label={t('productSafety.actions.quantity')} type="number" value={quantity} onChange={setQuantity} />
              {kind === 'EFFECTIVENESS_CHECK' && <TextField label={t('productSafety.actions.effectiveness')} type="number" value={effectiveness} onChange={setEffectiveness} />}
            </FormGrid>
          )}
          <TextField label={t('productSafety.actions.detail')} value={detail} onChange={setDetail} required multiline />
          <SafetyMutationError error={save.error} />
          <Button type="submit" isLoading={save.isPending}>
            {t('productSafety.actions.record')}
          </Button>
        </form>
      )}
    </Card>
  );
}

function CorrectionForm({ c }: { c: SafetyCaseDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [rootCause, setRootCause] = useState(c.rootCause ?? '');
  const [correctionEvidence, setCorrectionEvidence] = useState(c.correctionEvidence ?? '');
  const [verificationTests, setVerificationTests] = useState(c.verificationTests ?? '');
  const [currentCertificates, setCurrentCertificates] = useState(c.currentCertificates ?? '');
  const editable = can(Permission.ASSESSMENT_WORK) && c.status !== 'RELEASED';
  const save = useConsoleMutation({
    mutationFn: (_vars, key) => recordCorrection(c.id, { rootCause: rootCause.trim(), correctionEvidence: correctionEvidence.trim(), verificationTests: verificationTests.trim(), currentCertificates: currentCertificates.trim() }, key),
    invalidate: [productSafetyKeys.case(c.id), productSafetyKeys.cases()],
    successMessage: t('productSafety.correction.recorded'),
  });
  if (!editable) {
    return (
      <Card title={t('productSafety.correction.title')}>
        <DescriptionList
          columns={2}
          items={[
            { label: t('productSafety.correction.rootCause'), value: c.rootCause ?? '—' },
            { label: t('productSafety.correction.evidence'), value: c.correctionEvidence ?? '—' },
            { label: t('productSafety.correction.tests'), value: c.verificationTests ?? '—' },
            { label: t('productSafety.correction.certificates'), value: c.currentCertificates ?? '—' },
          ]}
        />
      </Card>
    );
  }
  return (
    <Card title={t('productSafety.correction.title')}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <TextField label={t('productSafety.correction.rootCause')} value={rootCause} onChange={setRootCause} required multiline />
        <TextField label={t('productSafety.correction.evidence')} value={correctionEvidence} onChange={setCorrectionEvidence} required multiline />
        <TextField label={t('productSafety.correction.tests')} value={verificationTests} onChange={setVerificationTests} required multiline />
        <TextField label={t('productSafety.correction.certificates')} value={currentCertificates} onChange={setCurrentCertificates} required multiline />
        <SafetyMutationError error={save.error} />
        <Button type="submit" isLoading={save.isPending}>
          {t('productSafety.save')}
        </Button>
      </form>
    </Card>
  );
}

export function ReleasePanel({ c }: { c: SafetyCaseDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [note, setNote] = useState('');
  const save = useConsoleMutation({
    mutationFn: (_vars, key) => releaseSafetyCase(c.id, note.trim(), key),
    invalidate: [productSafetyKeys.case(c.id), productSafetyKeys.cases()],
    successMessage: t('productSafety.release.done'),
  });
  if (c.status === 'RELEASED') {
    return <Callout tone="success">{t('productSafety.release.released', { date: formatDateTime(c.releasedAt) })}</Callout>;
  }
  return (
    <Card title={t('productSafety.release.title')}>
      <p className="mb-3 text-sm text-ink-muted">{t('productSafety.release.explain')}</p>
      {can(Permission.RELEASE_REQUEST) ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <TextField label={t('productSafety.release.note')} value={note} onChange={setNote} required multiline />
          <SafetyMutationError error={save.error} />
          <Button type="submit" isLoading={save.isPending}>
            {t('productSafety.release.button')}
          </Button>
        </form>
      ) : (
        <p className="text-sm">{t('productSafety.release.noPermission')}</p>
      )}
    </Card>
  );
}
