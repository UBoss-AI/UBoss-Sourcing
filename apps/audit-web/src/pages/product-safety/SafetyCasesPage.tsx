/**
 * Product safety cases and the annual recall rehearsal (Doc 07).
 *
 *   GET  /api/v1/audit/safety-cases        cases + rehearsal status
 *   POST /api/v1/audit/safety-cases        open a case
 *   POST /api/v1/audit/recall-rehearsals   record a rehearsal
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CardField, QueryBoundary, ResponsiveTable } from '@/components/console';
import type { Column } from '@/components/DataTable';
import { Badge, Button, Callout, Card, Field, Input, PageHeader, Select } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { formatDate, formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import {
  dateToIso,
  fetchSafetyCases,
  openSafetyCase,
  productSafetyKeys,
  recordRehearsal,
  REHEARSAL_OUTCOMES,
  SCOPE_KINDS,
  SEVERITIES,
  SOURCE_TYPES,
  type RehearsalOutcome,
  type SafetyCaseList,
  type SafetyCaseRow,
  type ScopeInput,
  type ScopeKind,
  type Severity,
  type SourceType,
} from '@/lib/product-safety';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import { FormGrid, SafetyMutationError, SeverityBadge, TextField } from './shared';

export function SafetyCasesPage(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [opening, setOpening] = useState(false);
  const query = useQuery({ queryKey: productSafetyKeys.cases(), queryFn: fetchSafetyCases });

  const open = (row: SafetyCaseRow): React.JSX.Element => (
    <Link className="font-medium text-accent hover:underline" to={`/safety-cases/${row.id}`}>
      {row.reference}
    </Link>
  );

  const columns: Column<SafetyCaseRow>[] = [
    { key: 'ref', header: t('productSafety.cases.col.reference'), nowrap: true, render: open },
    { key: 'title', header: t('productSafety.cases.col.title'), render: (row) => row.title },
    { key: 'severity', header: t('productSafety.cases.col.severity'), render: (row) => <SeverityBadge severity={row.severity} /> },
    { key: 'status', header: t('productSafety.cases.col.status'), render: (row) => <Badge tone={row.status === 'RELEASED' ? 'success' : 'warning'}>{t(`productSafety.caseStatus.${row.status}` as TranslationKey)}</Badge> },
    { key: 'opened', header: t('productSafety.cases.col.opened'), secondary: true, nowrap: true, render: (row) => formatDateTime(row.createdAt) },
  ];

  return (
    <>
      <PageHeader
        title={t('productSafety.cases.title')}
        description={t('productSafety.cases.description')}
        actions={
          can(Permission.ASSESSMENT_WORK) ? (
            <Button
              onClick={() => {
                setOpening((value) => !value);
              }}
            >
              {t('productSafety.cases.open')}
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-4">
        <QueryBoundary query={query}>
          {(data) => (
            <>
              <RehearsalPanel rehearsal={data.rehearsal} />
              {opening && (
                <OpenCaseForm
                  onDone={() => {
                    setOpening(false);
                  }}
                />
              )}
              <Card>
                <ResponsiveTable
                  caption={t('productSafety.cases.title')}
                  columns={columns}
                  rows={data.cases}
                  rowKey={(row) => row.id}
                  minWidth="48rem"
                  isRefreshing={query.isFetching}
                  emptyTitle={t('productSafety.cases.empty')}
                  card={(row) => (
                    <div className="space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        {open(row)}
                        <SeverityBadge severity={row.severity} />
                      </div>
                      <CardField label={t('productSafety.cases.col.title')}>{row.title}</CardField>
                      <CardField label={t('productSafety.cases.col.status')}>{t(`productSafety.caseStatus.${row.status}` as TranslationKey)}</CardField>
                    </div>
                  )}
                />
              </Card>
            </>
          )}
        </QueryBoundary>
      </div>
    </>
  );
}

function RehearsalPanel({ rehearsal }: { rehearsal: SafetyCaseList['rehearsal'] }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [recording, setRecording] = useState(false);
  const [scenario, setScenario] = useState('');
  const [scopeTraced, setScopeTraced] = useState('');
  const [minutes, setMinutes] = useState('');
  const [findings, setFindings] = useState('');
  const [outcome, setOutcome] = useState<RehearsalOutcome>('PASSED');
  const [performedAt, setPerformedAt] = useState('');
  const save = useConsoleMutation({
    mutationFn: (_vars, key) =>
      recordRehearsal({ scenario: scenario.trim(), scopeTraced: scopeTraced.trim(), minutesToTrace: minutes === '' ? null : Number(minutes), findings: findings.trim() === '' ? null : findings.trim(), outcome, performedAt: dateToIso(performedAt) ?? new Date().toISOString() }, key),
    invalidate: [productSafetyKeys.cases()],
    successMessage: t('productSafety.rehearsal.recorded'),
    onSuccess: () => {
      setRecording(false);
    },
  });
  const last = rehearsal.last;
  return (
    <Callout tone={rehearsal.due ? 'warning' : 'success'} title={t('productSafety.rehearsal.title')}>
      <p>{last === null ? t('productSafety.rehearsal.none') : t('productSafety.rehearsal.last', { date: formatDate(last.performedAt), outcome: t(`productSafety.rehearsalOutcome.${last.outcome}` as TranslationKey) })}</p>
      {rehearsal.due && <p className="mt-1 font-medium">{t('productSafety.rehearsal.due')}</p>}
      {can(Permission.ASSESSMENT_WORK) && !recording && (
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => {
            setRecording(true);
          }}
        >
          {t('productSafety.rehearsal.record')}
        </Button>
      )}
      {recording && (
        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <TextField label={t('productSafety.rehearsal.scenario')} value={scenario} onChange={setScenario} required multiline />
          <TextField label={t('productSafety.rehearsal.scopeTraced')} value={scopeTraced} onChange={setScopeTraced} required multiline />
          <FormGrid>
            <TextField label={t('productSafety.rehearsal.minutes')} type="number" value={minutes} onChange={setMinutes} />
            <TextField label={t('productSafety.rehearsal.performedAt')} type="date" value={performedAt} onChange={setPerformedAt} required />
            <Field label={t('productSafety.rehearsal.outcome')} required>
              {({ inputId }) => (
                <Select
                  id={inputId}
                  value={outcome}
                  onChange={(event) => {
                    setOutcome(event.target.value as RehearsalOutcome);
                  }}
                >
                  {REHEARSAL_OUTCOMES.map((value) => (
                    <option key={value} value={value}>
                      {t(`productSafety.rehearsalOutcome.${value}` as TranslationKey)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </FormGrid>
          <TextField label={t('productSafety.rehearsal.findings')} value={findings} onChange={setFindings} multiline />
          <SafetyMutationError error={save.error} />
          <div className="flex gap-2">
            <Button type="submit" isLoading={save.isPending}>
              {t('productSafety.save')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setRecording(false);
              }}
            >
              {t('productSafety.cancel')}
            </Button>
          </div>
        </form>
      )}
    </Callout>
  );
}

/** Rows of scope: what the case covers. Shared with the contain form. */
export function ScopeRowsEditor({ rows, onChange }: { rows: ScopeInput[]; onChange: (rows: ScopeInput[]) => void }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-ink">{t('productSafety.scope.title')}</legend>
      {rows.map((row, index) => (
        <div key={index} className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
          <Select
            aria-label={t('productSafety.scope.kind')}
            value={row.kind}
            onChange={(event) => {
              onChange(rows.map((r, i) => (i === index ? { ...r, kind: event.target.value as ScopeKind } : r)));
            }}
          >
            {SCOPE_KINDS.map((value) => (
              <option key={value} value={value}>
                {t(`productSafety.scopeKind.${value}` as TranslationKey)}
              </option>
            ))}
          </Select>
          <Input
            aria-label={t('productSafety.scope.ref')}
            value={row.ref}
            onChange={(event) => {
              onChange(rows.map((r, i) => (i === index ? { ...r, ref: event.target.value } : r)));
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange(rows.filter((_, i) => i !== index));
            }}
          >
            {t('productSafety.scope.remove')}
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => {
          onChange([...rows, { kind: 'OFFER', ref: '' }]);
        }}
      >
        {t('productSafety.scope.add')}
      </Button>
    </fieldset>
  );
}

function OpenCaseForm({ onDone }: { onDone: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<Severity>('HIGH');
  const [sourceType, setSourceType] = useState<SourceType>('INCIDENT');
  const [seller, setSeller] = useState('');
  const [scope, setScope] = useState<ScopeInput[]>([{ kind: 'OFFER', ref: '' }]);
  const save = useConsoleMutation({
    mutationFn: (_vars, key) =>
      openSafetyCase({ title: title.trim(), description: description.trim(), severity, sourceType, sellerAccountId: seller.trim() === '' ? null : seller.trim(), scope: scope.filter((row) => row.ref.trim() !== '').map((row) => ({ kind: row.kind, ref: row.ref.trim() })) }, key),
    invalidate: [productSafetyKeys.cases()],
    successMessage: t('productSafety.cases.opened'),
    onSuccess: (result) => {
      onDone();
      void navigate(`/safety-cases/${result.id}`);
    },
  });
  return (
    <Card title={t('productSafety.cases.open')}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <TextField label={t('productSafety.cases.col.title')} value={title} onChange={setTitle} required />
        <TextField label={t('productSafety.cases.descriptionField')} value={description} onChange={setDescription} required multiline />
        <FormGrid>
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
          <Field label={t('productSafety.cases.source')} required>
            {({ inputId }) => (
              <Select
                id={inputId}
                value={sourceType}
                onChange={(event) => {
                  setSourceType(event.target.value as SourceType);
                }}
              >
                {SOURCE_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {t(`productSafety.sourceType.${value}` as TranslationKey)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <TextField label={t('productSafety.evidence.f.seller')} value={seller} onChange={setSeller} />
        </FormGrid>
        <ScopeRowsEditor rows={scope} onChange={setScope} />
        <SafetyMutationError error={save.error} />
        <div className="flex gap-2">
          <Button type="submit" isLoading={save.isPending}>
            {t('productSafety.cases.open')}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            {t('productSafety.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
