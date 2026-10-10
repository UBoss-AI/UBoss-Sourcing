/**
 * Seller assessment and onboarding in the Seller Hub.
 *
 * Who is eligible and why, the application (saved section by section, so it
 * can be resumed), the evidence each answer needs, progress through the eight
 * gates, corrections and findings to answer, the approved and blocked scope
 * with its validity, notices and appeals, change notifications, incident
 * reports and bank-account changes.
 *
 * Saving never submits, and submitting never approves: the Audit Team decides
 * every gate, and only an independent release makes a product purchasable.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, PageHeader, Select, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast-context';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { BASE_URL } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import {
  appeal,
  approvalPdfUrl,
  fetchSellerAssessment,
  notifyChange,
  paiseToRupees,
  reportIncident,
  requestBankChange,
  respondToFinding,
  rupeesToPaise,
  saveApplication,
  sellerAssessmentKey,
  startAssessment,
  submitAssessment,
  uploadEvidence,
  type Overview,
  type SellerAssessmentView,
} from '@/lib/seller-assessment';

const tk = (key: string) => key as TranslationKey;
type Row = Record<string, unknown>;
type FieldDef = { name: string; kind?: 'text' | 'date' | 'select' | 'bool' | 'list' | 'evidence'; options?: string[] };

const CHANGE_KINDS = ['FACILITY', 'LEGAL_ENTITY', 'BENEFICIAL_OWNERSHIP', 'BRAND_RIGHTS', 'SUBCONTRACTOR', 'MATERIALS', 'FORMULATION', 'DESIGN', 'MANUFACTURING_PROCESS', 'INTENDED_USE', 'SAFETY_SOFTWARE', 'LABELS', 'COUNTRY', 'NEW_PRODUCT'];

function useRefresh() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: sellerAssessmentKey });
}

export function SellerAssessmentPage(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: sellerAssessmentKey, queryFn: fetchSellerAssessment });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;
  const { overview, current } = query.data;
  return (
    <>
      <PageHeader title={t('sah.title')} description={t('sah.description')} />
      <Eligibility />
      {current === null ? <Start /> : <Current a={current} />}
      <Approvals o={overview} />
      <Notices o={overview} />
      <Changes o={overview} />
      <Incidents o={overview} />
      <BankChange o={overview} />
    </>
  );
}

function Notice({ tone, children }: { tone: 'info' | 'warning' | 'danger' | 'success'; children: React.ReactNode }): React.JSX.Element {
  const cls = { info: 'border-border-subtle bg-surface-subtle', warning: 'border-warning/40 bg-warning/10', danger: 'border-danger/40 bg-danger/10', success: 'border-success/40 bg-success/10' }[tone];
  return <div role={tone === 'danger' ? 'alert' : 'status'} className={`mb-4 rounded-md border px-4 py-3 text-sm ${cls}`}>{children}</div>;
}

function Eligibility(): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Card title={t('sah.eligibility.title')} className="mb-4" bodyClassName="space-y-2 px-5 py-4 text-sm">
      <p>{t('sah.eligibility.who')}</p>
      <p>{t('sah.eligibility.turnover')}</p>
      <p>{t('sah.eligibility.excluded')}</p>
      <p>{t('sah.eligibility.process')}</p>
    </Card>
  );
}

function Start(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const refresh = useRefresh();
  const start = useMutation({ mutationFn: () => startAssessment('INITIAL'), onSuccess: () => { void refresh(); }, onError: (e) => { toast.error(errorMessage(t, e)); } });
  return (
    <Card className="mb-4" bodyClassName="px-5 py-6">
      <EmptyState title={t('sah.start.title')} description={t('sah.start.description')} action={<Button variant="primary" disabled={start.isPending} onClick={() => { start.mutate(); }}>{t('sah.start.button')}</Button>} />
    </Card>
  );
}

const SECTIONS: { key: string; single?: FieldDef[]; list?: FieldDef[] }[] = [
  { key: 'applicantType', single: [{ name: 'applicantType', kind: 'select', options: ['MANUFACTURER', 'BRAND_OWNER', 'TRADER', 'UNAUTHORISED_DISTRIBUTOR', 'RESELLER', 'INDIVIDUAL', 'DROPSHIPPER'] }] },
  { key: 'entity', single: [{ name: 'legalName' }, { name: 'registrationNumber' }, { name: 'entityType' }, { name: 'incorporatedOn', kind: 'date' }, { name: 'country', kind: 'select', options: ['IN'] }] },
  { key: 'registeredAddress', single: [{ name: 'line1' }, { name: 'line2' }, { name: 'city' }, { name: 'state' }, { name: 'postcode' }, { name: 'country', kind: 'select', options: ['IN'] }] },
  { key: 'operatingAddresses', list: [{ name: 'line1' }, { name: 'city' }, { name: 'state' }, { name: 'postcode' }, { name: 'country' }] },
  { key: 'directors', list: [{ name: 'name' }, { name: 'din' }, { name: 'designation' }] },
  { key: 'beneficialOwners', list: [{ name: 'name' }, { name: 'nationality' }, { name: 'ownershipPercent' }, { name: 'controlling', kind: 'bool' }] },
  { key: 'signatory', single: [{ name: 'name' }, { name: 'designation' }, { name: 'isDirector', kind: 'bool' }, { name: 'delegationEvidenceKey', kind: 'evidence' }] },
  { key: 'financial', single: [{ name: 'financialYearStart', kind: 'date' }, { name: 'financialYearEnd', kind: 'date' }, { name: 'revenueRupees' }, { name: 'currency', kind: 'select', options: ['INR'] }, { name: 'measure', kind: 'select', options: ['ENTITY_REVENUE_FROM_OPERATIONS_EX_GST', 'GROUP', 'FORECAST', 'UNAUDITED_GTV'] }, { name: 'basis', kind: 'select', options: ['AUDITED_LATEST', 'PRECEDING_AUDIT_PLUS_CA_CERTIFIED'] }, { name: 'auditedStatementsKey', kind: 'evidence' }, { name: 'caConfirmationKey', kind: 'evidence' }, { name: 'precedingAuditKey', kind: 'evidence' }, { name: 'solvencyNote' }, { name: 'creditReferences' }] },
  { key: 'taxIds', single: [{ name: 'pan' }, { name: 'gstin' }, { name: 'iec' }] },
  { key: 'licences', list: [{ name: 'kind' }, { name: 'number' }, { name: 'issuer' }, { name: 'expiresOn', kind: 'date' }, { name: 'evidenceKey', kind: 'evidence' }] },
  { key: 'bank', single: [{ name: 'beneficiaryName' }, { name: 'accountLast4' }, { name: 'bankCode' }, { name: 'evidenceKey', kind: 'evidence' }] },
  { key: 'brands', list: [{ name: 'ref' }, { name: 'name' }, { name: 'trademarkNumber' }, { name: 'rightsBasis', kind: 'select', options: ['OWNED', 'LICENSED'] }, { name: 'evidenceKey', kind: 'evidence' }] },
  { key: 'facilities', list: [{ name: 'ref' }, { name: 'name' }, { name: 'countryCode' }, { name: 'ownedByApplicant', kind: 'bool' }, { name: 'processes' }, { name: 'agreementEvidenceKey', kind: 'evidence' }, { name: 'qualityAgreementEvidenceKey', kind: 'evidence' }] },
  { key: 'outsourced', list: [{ name: 'process' }, { name: 'provider' }, { name: 'countryCode' }, { name: 'critical', kind: 'bool' }] },
  { key: 'products', list: [{ name: 'key' }, { name: 'name' }, { name: 'version' }, { name: 'sku' }, { name: 'offerId' }, { name: 'intendedUse' }, { name: 'brandRef' }, { name: 'facilityRef' }, { name: 'madeInCountry' }, { name: 'countries', kind: 'list' }, { name: 'channels', kind: 'list' }] },
  { key: 'fulfilment', single: [{ name: 'model', kind: 'select', options: ['SELLER_FULFILLED', 'MARKETPLACE_FULFILLED', 'MIXED'] }, { name: 'monthlyCapacity' }, { name: 'afterSales' }] },
  { key: 'insurance', list: [{ name: 'kind', kind: 'select', options: ['PRODUCT_LIABILITY', 'RECALL', 'CARGO', 'OPERATIONAL'] }, { name: 'insurer' }, { name: 'policyNumber' }, { name: 'limitRupees' }, { name: 'territories' }, { name: 'expiresOn', kind: 'date' }, { name: 'evidenceKey', kind: 'evidence' }] },
  { key: 'consent', single: [{ name: 'personalDataChecks', kind: 'bool' }, { name: 'auditAccess', kind: 'bool' }] },
];

/** Read a section out of the stored application (with display conversions). */
function readSection(app: Row, key: string): Row | Row[] {
  const entity = (app['entity'] ?? {}) as Row;
  switch (key) {
    case 'applicantType': return { applicantType: app['applicantType'] ?? '' };
    case 'entity': return entity;
    case 'registeredAddress': return (entity['registeredAddress'] ?? {}) as Row;
    case 'operatingAddresses': return (entity['operatingAddresses'] ?? []) as Row[];
    case 'financial': { const f = (app['financial'] ?? {}) as Row; return { ...f, revenueRupees: typeof f['revenueMinor'] === 'string' ? paiseToRupees(f['revenueMinor']) : '' }; }
    case 'taxIds': return (app['taxIds'] ?? {}) as Row;
    case 'licences': return (((app['taxIds'] ?? {}) as Row)['licences'] ?? []) as Row[];
    case 'fulfilment': return (app['fulfilment'] ?? {}) as Row;
    case 'insurance': return ((((app['fulfilment'] ?? {}) as Row)['insurance'] ?? []) as Row[]).map((i) => ({ ...i, limitRupees: typeof i['limitMinor'] === 'string' ? paiseToRupees(i['limitMinor']) : '' }));
    default: return (app[key] ?? (SECTIONS.find((s) => s.key === key)?.list ? [] : {})) as Row | Row[];
  }
}

const blankToNull = (v: unknown) => (v === '' ? null : v);

/** Turn a section's form value into the application patch the server expects. */
function patchFor(app: Row, key: string, value: Row | Row[]): Row | null {
  const entity = (app['entity'] ?? {}) as Row;
  const fin = (app['financial'] ?? {}) as Row;
  const ful = (app['fulfilment'] ?? {}) as Row;
  const tax = (app['taxIds'] ?? {}) as Row;
  const clean = (r: Row) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, blankToNull(v)]));
  switch (key) {
    case 'applicantType': return { applicantType: blankToNull((value as Row)['applicantType']) };
    case 'entity': return { entity: { ...entity, ...clean(value as Row), operatingAddresses: entity['operatingAddresses'] ?? [], registeredAddress: entity['registeredAddress'] ?? {} } };
    case 'registeredAddress': return { entity: { ...entity, registeredAddress: clean(value as Row), operatingAddresses: entity['operatingAddresses'] ?? [] } };
    case 'operatingAddresses': return { entity: { ...entity, registeredAddress: entity['registeredAddress'] ?? {}, operatingAddresses: (value as Row[]).map(clean) } };
    case 'financial': {
      const v = value as Row;
      const minor = typeof v['revenueRupees'] === 'string' && v['revenueRupees'] !== '' ? rupeesToPaise(v['revenueRupees']) : null;
      if (typeof v['revenueRupees'] === 'string' && v['revenueRupees'] !== '' && minor === null) return null;
      const rest = Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'revenueRupees'));
      return { financial: { ...fin, ...clean(rest), revenueMinor: minor } };
    }
    case 'taxIds': return { taxIds: { ...tax, ...clean(value as Row), licences: tax['licences'] ?? [] } };
    case 'licences': return { taxIds: { ...tax, licences: (value as Row[]).map(clean) } };
    case 'fulfilment': return { fulfilment: { ...ful, ...clean(value as Row), insurance: ful['insurance'] ?? [] } };
    case 'insurance': {
      const rows = (value as Row[]).map((r) => { const { limitRupees, ...rest } = r; return { ...clean(rest), currency: 'INR', limitMinor: rupeesToPaise(typeof limitRupees === 'string' ? limitRupees : '0') ?? '0' }; });
      return { fulfilment: { ...ful, insurance: rows } };
    }
    case 'products': return { products: (value as Row[]).map((r) => ({ ...clean(r), countries: Array.isArray(r['countries']) ? r['countries'] : [], channels: Array.isArray(r['channels']) ? r['channels'] : [] })) };
    default: return { [key]: Array.isArray(value) ? value.map(clean) : clean(value) };
  }
}

function Current({ a }: { a: SellerAssessmentView }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const refresh = useRefresh();
  const editable = a.status === 'DRAFT' || a.status === 'CORRECTION_REQUESTED';
  const submit = useMutation({ mutationFn: () => submitAssessment(a.id), onSuccess: () => { toast.success(t('sah.submitted')); void refresh(); }, onError: (e) => { toast.error(errorMessage(t, e)); } });
  return (
    <div className="mb-4 space-y-4">
      <Card title={`${a.number} · ${t(tk(`sa.status.${a.status}`))}`} description={t('sah.current.policy', { version: a.policyVersion })} bodyClassName="space-y-3 px-5 py-4">
        {a.policyInForce.status === 'DRAFT' && <Notice tone="info">{t('sah.current.draftPolicy')}</Notice>}
        {a.status === 'CORRECTION_REQUESTED' && a.correctionNote !== null && <Notice tone="warning"><strong>{t('sah.current.corrections')}</strong> {a.correctionNote}</Notice>}
        {a.reviewTargetAt !== null && <p className="text-sm">{t('sah.current.target', { date: formatDate(a.reviewTargetAt) })}</p>}
        <ol aria-label={t('sah.current.gates')} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {a.gates.map((g) => (
            <li key={g.gate} className="rounded-md border border-border-subtle px-3 py-2 text-sm">
              <p className="text-xs text-ink-muted">{t('sah.gate', { gate: String(g.gate) })}</p>
              <p className="font-medium">{t(tk(`sa.gate.name.${String(g.gate)}`))}</p>
              <Badge tone={g.status === 'PASSED' ? 'success' : g.status === 'FAILED' ? 'danger' : g.status === 'CORRECTION_REQUESTED' ? 'warning' : 'neutral'}>{t(tk(`sa.gateStatus.${g.status}`))}</Badge>
              {g.reason !== null && <p className="mt-1 text-xs">{g.reason}</p>}
            </li>
          ))}
        </ol>
        {a.applicationProblems.length > 0 && (
          <div>
            <p className="text-sm font-medium">{t('sah.current.stillNeeded')}</p>
            <ul className="list-disc pl-5 text-sm">
              {a.applicationProblems.map((p) => <li key={p}>{t(tk(`sa.problem.${p}`))}</li>)}
            </ul>
          </div>
        )}
        {editable && (
          <Button variant="primary" disabled={submit.isPending} onClick={() => { submit.mutate(); }}>{t('sah.submit')}</Button>
        )}
      </Card>
      {editable && SECTIONS.map((s) => <Section key={s.key} a={a} def={s} />)}
      <EvidenceList a={a} editable={editable || a.status === 'IN_REVIEW' || a.status === 'SUBMITTED' || a.status === 'REMEDIATION'} />
      {a.scope.length > 0 && (
        <Card title={t('sah.scope.title')} description={t('sah.scope.description')} bodyClassName="divide-y divide-border-subtle text-sm">
          {a.scope.map((s) => (
            <p key={s.id} className="px-5 py-2">{s.productName} {s.productVersion} · {s.facilityRef} · {s.countryCode} · {s.channel} <Badge tone={s.decision === 'APPROVED' ? 'success' : s.decision === 'BLOCKED' ? 'danger' : 'neutral'}>{t(tk(`sa.decision.${s.decision}`))}</Badge></p>
          ))}
        </Card>
      )}
      {a.findings.map((f) => <FindingResponse key={f.id} a={a} f={f} />)}
    </div>
  );
}

function Section({ a, def }: { a: SellerAssessmentView; def: (typeof SECTIONS)[number] }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const refresh = useRefresh();
  const app = (a.application ?? {}) as Row;
  const [value, setValue] = useState<Row | Row[]>(() => readSection(app, def.key));
  const save = useMutation({
    mutationFn: () => {
      const patch = patchFor(app, def.key, value);
      if (patch === null) throw new Error(t('sah.amountInvalid'));
      return saveApplication(a.id, patch, a.applicationRevision);
    },
    onSuccess: () => { toast.success(t('sah.saved')); void refresh(); },
    onError: (e) => { toast.error(errorMessage(t, e)); },
  });
  const fields = def.single ?? def.list ?? [];
  const rows = Array.isArray(value) ? value : null;
  return (
    <Card title={t(tk(`sah.section.${def.key}`))} description={t(tk(`sah.sectionHint.${def.key}`))} bodyClassName="space-y-3 px-5 py-4">
      {rows === null ? (
        <div className="grid gap-3 sm:grid-cols-2"><Fields fields={fields} row={value as Row} onChange={(r) => { setValue(r); }} /></div>
      ) : (
        <>
          {rows.map((row, i) => (
            <fieldset key={i} className="grid gap-3 rounded-md border border-border-subtle p-3 sm:grid-cols-2">
              <legend className="px-1 text-xs text-ink-muted">{t('sah.row', { row: String(i + 1) })}</legend>
              <Fields fields={fields} row={row} onChange={(r) => { setValue(rows.map((x, j) => (j === i ? r : x))); }} />
              <div className="sm:col-span-2"><Button size="sm" variant="ghost" onClick={() => { setValue(rows.filter((_, j) => j !== i)); }}>{t('sah.removeRow')}</Button></div>
            </fieldset>
          ))}
          <Button size="sm" variant="secondary" onClick={() => { setValue([...rows, {}]); }}>{t('sah.addRow')}</Button>
        </>
      )}
      <div><Button variant="primary" disabled={save.isPending} onClick={() => { save.mutate(); }}>{t('sah.saveSection')}</Button></div>
    </Card>
  );
}

function Fields({ fields, row, onChange }: { fields: FieldDef[]; row: Row; onChange: (r: Row) => void }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <>
      {fields.map((f) => {
        const label = t(tk(`sah.field.${f.name}`));
        const v = row[f.name];
        if (f.kind === 'bool') {
          return (
            <label key={f.name} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={v === true} onChange={(e) => { onChange({ ...row, [f.name]: e.target.checked }); }} />
              {label}
            </label>
          );
        }
        return (
          <Field key={f.name} label={label} {...(f.kind === 'evidence' ? { hint: t('sah.evidenceHint') } : f.kind === 'list' ? { hint: t('sah.listHint') } : {})}>
            {({ inputId, describedBy }) =>
              f.kind === 'select' ? (
                <Select id={inputId} value={typeof v === 'string' ? v : ''} onChange={(e) => { onChange({ ...row, [f.name]: e.target.value }); }}>
                  <option value="">—</option>
                  {(f.options ?? []).map((o) => <option key={o} value={o}>{t(tk(`sah.option.${o}`))}</option>)}
                </Select>
              ) : f.kind === 'list' ? (
                <Input id={inputId} aria-describedby={describedBy} value={Array.isArray(v) ? v.join(', ') : ''} onChange={(e) => { onChange({ ...row, [f.name]: e.target.value.split(',').map((x) => x.trim().toUpperCase()).filter((x) => x !== '') }); }} />
              ) : (
                <Input id={inputId} aria-describedby={describedBy} type={f.kind === 'date' ? 'date' : 'text'} value={typeof v === 'string' ? v : ''} onChange={(e) => { onChange({ ...row, [f.name]: e.target.value }); }} />
              )
            }
          </Field>
        );
      })}
    </>
  );
}

function EvidenceList({ a, editable }: { a: SellerAssessmentView; editable: boolean }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const refresh = useRefresh();
  const [file, setFile] = useState<File | null>(null);
  const [key, setKey] = useState('');
  const [category, setCategory] = useState('FINANCIAL');
  const upload = useMutation({ mutationFn: () => uploadEvidence(a.id, file as File, key.trim(), category), onSuccess: () => { toast.success(t('sah.uploaded')); setFile(null); void refresh(); }, onError: (e) => { toast.error(errorMessage(t, e)); } });
  return (
    <Card title={t('sah.evidence.title')} description={t('sah.evidence.description')} bodyClassName="space-y-3 px-5 py-4">
      {a.evidence.length === 0 ? <p className="text-sm text-ink-muted">{t('sah.evidence.none')}</p> : (
        <ul className="divide-y divide-border-subtle text-sm">
          {a.evidence.map((e) => <li key={e.id} className="py-1"><span className="font-mono text-xs">{e.evidenceKey}</span> v{String(e.version)} · {e.fileName ?? ''} · {formatDate(e.createdAt)}</li>)}
        </ul>
      )}
      {editable && (
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label={t('sah.evidence.file')}>{({ inputId }) => <input id={inputId} type="file" accept="application/pdf,image/*" onChange={(e) => { setFile(e.target.files?.[0] ?? null); }} />}</Field>
          <Field label={t('sah.evidence.key')} hint={t('sah.evidence.keyHint')}>{({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} value={key} onChange={(e) => { setKey(e.target.value); }} />}</Field>
          <Field label={t('sah.evidence.category')}>
            {({ inputId }) => (
              <Select id={inputId} value={category} onChange={(e) => { setCategory(e.target.value); }}>
                {['FINANCIAL', 'IDENTITY', 'OWNERSHIP', 'BANKING', 'BRAND', 'AGREEMENT', 'MANUFACTURING', 'PRODUCT', 'INSURANCE', 'CAPA', 'OTHER'].map((c) => <option key={c} value={c}>{t(tk(`sa.evidenceCategory.${c}`))}</option>)}
              </Select>
            )}
          </Field>
          <div className="flex items-end"><Button variant="secondary" disabled={file === null || key.trim() === '' || upload.isPending} onClick={() => { upload.mutate(); }}>{t('sah.evidence.upload')}</Button></div>
        </div>
      )}
    </Card>
  );
}

function FindingResponse({ a, f }: { a: SellerAssessmentView; f: SellerAssessmentView['findings'][number] }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const refresh = useRefresh();
  const [form, setForm] = useState({ containment: f.containment ?? '', rootCause: f.rootCause ?? '', correctiveAction: f.correctiveAction ?? '', preventiveAction: f.preventiveAction ?? '', ownerName: f.ownerName ?? '' });
  const [evidence, setEvidence] = useState<string[]>(f.closureEvidenceIds);
  const save = useMutation({ mutationFn: () => respondToFinding(f.id, { ...Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim() === '' ? null : v])), closureEvidenceIds: evidence, expectedVersion: f.version }), onSuccess: () => { toast.success(t('sah.saved')); void refresh(); }, onError: (e) => { toast.error(errorMessage(t, e)); } });
  const closed = f.status === 'VERIFIED_CLOSED';
  return (
    <Card title={`${f.number} · ${t(tk(`sa.class.${f.classification}`))}`} description={f.requirement} actions={<Badge tone={closed ? 'success' : f.overdue ? 'danger' : 'warning'}>{t(tk(`sa.findingStatus.${f.status}`))}</Badge>} bodyClassName="space-y-3 px-5 py-4">
      <p className="text-sm">{f.evidence}</p>
      <p className="text-xs text-ink-muted">{t('sah.finding.due', { plan: f.planDueAt === null ? '—' : formatDate(f.planDueAt), closure: formatDate(f.closureDueAt) })}</p>
      {f.classification === 'CRITICAL' && !closed && <Notice tone="danger">{t('sah.finding.critical')}</Notice>}
      {!closed && (
        <div className="grid gap-3 sm:grid-cols-2">
          {(Object.keys(form) as (keyof typeof form)[]).map((k) => (
            <Field key={k} label={t(tk(`sah.finding.${k}`))}>{({ inputId }) => <Textarea id={inputId} value={form[k]} onChange={(e) => { setForm({ ...form, [k]: e.target.value }); }} />}</Field>
          ))}
          <fieldset className="sm:col-span-2">
            <legend className="text-sm font-medium">{t('sah.finding.evidence')}</legend>
            {a.evidence.map((e) => (
              <label key={e.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={evidence.includes(e.id)} onChange={(ev) => { setEvidence(ev.target.checked ? [...evidence, e.id] : evidence.filter((x) => x !== e.id)); }} />{e.evidenceKey} v{String(e.version)}</label>
            ))}
          </fieldset>
          <div className="sm:col-span-2"><Button variant="primary" disabled={save.isPending} onClick={() => { save.mutate(); }}>{t('sah.finding.send')}</Button></div>
          <p className="text-xs text-ink-muted sm:col-span-2">{t('sah.finding.auditorCloses')}</p>
        </div>
      )}
    </Card>
  );
}

function Approvals({ o }: { o: Overview }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const refresh = useRefresh();
  const renew = useMutation({ mutationFn: (kind: string) => startAssessment(kind), onSuccess: () => { void refresh(); }, onError: (e) => { toast.error(errorMessage(t, e)); } });
  return (
    <Card title={t('sah.approvals.title')} description={t('sah.approvals.description')} className="mb-4" bodyClassName="space-y-3 px-5 py-4">
      {o.gateMode !== 'enforce' && <p className="text-xs text-ink-muted">{t('sah.approvals.notEnforced')}</p>}
      {o.approvals.length === 0 && <p className="text-sm text-ink-muted">{t('sah.approvals.none')}</p>}
      {o.approvals.map((ap) => (
        <div key={ap.id} className="space-y-2 rounded-md border border-border-subtle p-3">
          <p className="font-medium">{ap.number} · <Badge tone={ap.status === 'ACTIVE' ? 'success' : 'danger'}>{t(tk(`sa.approvalStatus.${ap.status}`))}</Badge></p>
          <p className="text-sm">{t('sah.approvals.validity', { from: formatDate(ap.issuedAt), to: formatDate(ap.validUntil), review: formatDate(ap.nextReviewAt) })}</p>
          {ap.renewalDue && ap.status === 'ACTIVE' && <Notice tone="warning">{t('sah.approvals.renewalDue')}</Notice>}
          <ul className="divide-y divide-border-subtle text-sm">
            {ap.scopes.map((s) => (
              <li key={s.id} className="py-1">{s.productKey} {s.productVersion} · {s.facilityRef} · {s.countryCode} · {s.channel} · {formatDate(s.validUntil)} <Badge tone={s.status === 'ACTIVE' ? 'success' : 'danger'}>{t(tk(`sa.scopeStatus.${s.status}`))}</Badge>{s.blockedReason !== null ? ` ${s.blockedReason}` : ''}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            {ap.auditDocumentId !== null && <a className="text-sm underline" href={`${BASE_URL}${approvalPdfUrl(ap.id)}`}>{t('sah.approvals.pdf')}</a>}
            <Button size="sm" variant="secondary" disabled={renew.isPending} onClick={() => { renew.mutate('RENEWAL'); }}>{t('sah.approvals.renew')}</Button>
            <Button size="sm" variant="ghost" disabled={renew.isPending} onClick={() => { renew.mutate('EXTENSION'); }}>{t('sah.approvals.extend')}</Button>
          </div>
        </div>
      ))}
      <p className="text-xs text-ink-muted">{t('sah.approvals.notExternal')}</p>
    </Card>
  );
}

function Notices({ o }: { o: Overview }): React.JSX.Element | null {
  const { t } = useI18n();
  if (o.notices.length === 0) return null;
  return (
    <Card title={t('sah.notices.title')} className="mb-4" bodyClassName="space-y-3 px-5 py-4">
      {o.notices.map((n) => <NoticeCard key={n.id} n={n} />)}
    </Card>
  );
}

function NoticeCard({ n }: { n: Overview['notices'][number] }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const refresh = useRefresh();
  const [grounds, setGrounds] = useState('');
  const send = useMutation({ mutationFn: () => appeal(n.id, grounds), onSuccess: () => { toast.success(t('sah.saved')); void refresh(); }, onError: (e) => { toast.error(errorMessage(t, e)); } });
  return (
    <div className="space-y-2 rounded-md border border-danger/40 p-3 text-sm">
      <p className="font-medium">{n.number} · {t(tk(`sa.noticeKind.${n.kind}`))} · {formatDate(n.issuedAt)}</p>
      <dl className="grid gap-1 sm:grid-cols-2">
        {(['reason', 'shareableEvidence', 'settlementTreatment', 'correctiveActions', 'reviewRoute'] as const).map((k) => (
          <div key={k}><dt className="text-xs text-ink-muted">{t(tk(`sa.suspend.${k}`))}</dt><dd>{n[k]}</dd></div>
        ))}
        <div><dt className="text-xs text-ink-muted">{t('sah.notices.orders')}</dt><dd>{n.affectedOrders.join(', ') || '—'}</dd></div>
      </dl>
      {n.appeals.map((ap) => <p key={ap.id}>{t('sah.notices.appeal', { status: t(tk(`sa.appealStatus.${ap.status}`)), target: formatDate(ap.targetBy) })} {ap.outcomeReason ?? ''}</p>)}
      {n.appealOpen && n.appeals.length === 0 && (
        <div className="space-y-2">
          <Field label={t('sah.notices.grounds')} hint={t('sah.notices.deadline', { date: formatDate(n.appealDeadline) })}>{({ inputId, describedBy }) => <Textarea id={inputId} aria-describedby={describedBy} value={grounds} onChange={(e) => { setGrounds(e.target.value); }} />}</Field>
          <Button variant="primary" disabled={grounds.trim().length < 5 || send.isPending} onClick={() => { send.mutate(); }}>{t('sah.notices.send')}</Button>
          <p className="text-xs text-ink-muted">{t('sah.notices.noRestore')}</p>
        </div>
      )}
    </div>
  );
}

function Changes({ o }: { o: Overview }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const refresh = useRefresh();
  const [kind, setKind] = useState('FACILITY');
  const [description, setDescription] = useState('');
  const [plannedFrom, setPlannedFrom] = useState('');
  const send = useMutation({ mutationFn: () => notifyChange({ kind, description, plannedFrom: plannedFrom === '' ? null : plannedFrom }), onSuccess: () => { toast.success(t('sah.saved')); setDescription(''); void refresh(); }, onError: (e) => { toast.error(errorMessage(t, e)); } });
  return (
    <Card title={t('sah.changes.title')} description={t('sah.changes.description')} className="mb-4" bodyClassName="space-y-3 px-5 py-4">
      {o.changes.map((c) => <p key={c.id} className="text-sm">{t(tk(`sa.change.${c.kind}`))} · {t(tk(`sa.changeStatus.${c.status}`))} · {c.description}</p>)}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('sah.changes.kind')}>{({ inputId }) => <Select id={inputId} value={kind} onChange={(e) => { setKind(e.target.value); }}>{CHANGE_KINDS.map((k) => <option key={k} value={k}>{t(tk(`sa.change.${k}`))}</option>)}</Select>}</Field>
        <Field label={t('sah.changes.plannedFrom')}>{({ inputId }) => <Input id={inputId} type="date" value={plannedFrom} onChange={(e) => { setPlannedFrom(e.target.value); }} />}</Field>
        <Field label={t('sah.changes.what')}>{({ inputId }) => <Textarea id={inputId} value={description} onChange={(e) => { setDescription(e.target.value); }} />}</Field>
      </div>
      <Button variant="secondary" disabled={description.trim().length < 5 || send.isPending} onClick={() => { send.mutate(); }}>{t('sah.changes.send')}</Button>
    </Card>
  );
}

function Incidents({ o }: { o: Overview }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const refresh = useRefresh();
  const [form, setForm] = useState({ severity: 'HIGH', description: '', affectedProducts: '', awareAt: '', statutoryDeadlineHours: '' });
  const send = useMutation({
    mutationFn: () => reportIncident({ severity: form.severity, description: form.description, affectedProducts: form.affectedProducts === '' ? null : form.affectedProducts, awareAt: new Date(form.awareAt).toISOString(), statutoryDeadlineHours: form.statutoryDeadlineHours === '' ? null : Number(form.statutoryDeadlineHours) }),
    onSuccess: (r) => { toast.success(r.late ? t('sah.incidents.late', { hours: String(r.deadlineHours) }) : t('sah.saved')); void refresh(); },
    onError: (e) => { toast.error(errorMessage(t, e)); },
  });
  return (
    <Card title={t('sah.incidents.title')} description={t('sah.incidents.description')} className="mb-4" bodyClassName="space-y-3 px-5 py-4">
      {o.incidents.map((i) => <p key={i.id} className="text-sm">{t(tk(`sa.severity.${i.severity}`))} · {formatDate(i.reportedAt)} · {i.late ? t('sah.incidents.wasLate') : t('sah.incidents.onTime')} · {i.description}</p>)}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('sah.incidents.severity')}>{({ inputId }) => <Select id={inputId} value={form.severity} onChange={(e) => { setForm({ ...form, severity: e.target.value }); }}>{['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((s) => <option key={s} value={s}>{t(tk(`sa.severity.${s}`))}</option>)}</Select>}</Field>
        <Field label={t('sah.incidents.awareAt')}>{({ inputId }) => <Input id={inputId} type="datetime-local" value={form.awareAt} onChange={(e) => { setForm({ ...form, awareAt: e.target.value }); }} />}</Field>
        <Field label={t('sah.incidents.what')}>{({ inputId }) => <Textarea id={inputId} value={form.description} onChange={(e) => { setForm({ ...form, description: e.target.value }); }} />}</Field>
        <Field label={t('sah.incidents.products')}>{({ inputId }) => <Input id={inputId} value={form.affectedProducts} onChange={(e) => { setForm({ ...form, affectedProducts: e.target.value }); }} />}</Field>
        <Field label={t('sah.incidents.statutory')} hint={t('sah.incidents.statutoryHint')}>{({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} inputMode="numeric" value={form.statutoryDeadlineHours} onChange={(e) => { setForm({ ...form, statutoryDeadlineHours: e.target.value.replace(/\D/g, '') }); }} />}</Field>
      </div>
      <Button variant="secondary" disabled={form.description.trim().length < 5 || form.awareAt === '' || send.isPending} onClick={() => { send.mutate(); }}>{t('sah.incidents.send')}</Button>
    </Card>
  );
}

function BankChange({ o }: { o: Overview }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const refresh = useRefresh();
  const [form, setForm] = useState({ beneficiaryName: '', accountLast4: '', bankCode: '' });
  const send = useMutation({ mutationFn: () => requestBankChange({ ...form, evidenceRef: null }), onSuccess: () => { toast.success(t('sah.saved')); void refresh(); }, onError: (e) => { toast.error(errorMessage(t, e)); } });
  return (
    <Card title={t('sah.bank.title')} description={t('sah.bank.description')} className="mb-4" bodyClassName="space-y-3 px-5 py-4">
      {o.bankChanges.map((b) => <p key={b.id} className="text-sm">{b.beneficiaryName} · ••••{b.accountLast4} · {t(tk(`sa.bankStatus.${b.status}`))}</p>)}
      <div className="grid gap-3 sm:grid-cols-3">
        {(Object.keys(form) as (keyof typeof form)[]).map((k) => (
          <Field key={k} label={t(tk(`sah.bank.${k}`))}>{({ inputId }) => <Input id={inputId} value={form[k]} onChange={(e) => { setForm({ ...form, [k]: e.target.value }); }} />}</Field>
        ))}
      </div>
      <Button variant="secondary" disabled={form.beneficiaryName.trim().length < 2 || !/^\d{4}$/.test(form.accountLast4) || form.bankCode.trim().length < 4 || send.isPending} onClick={() => { send.mutate(); }}>{t('sah.bank.send')}</Button>
    </Card>
  );
}
