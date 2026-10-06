/**
 * The inspection console (checklist Master rows 55, 70, 94).
 *
 *   /inspection                  every requirement, by status; sub-lot releases waiting for a decision
 *   /inspection/:id              one requirement: jobs, reports, evidence, NCRs, release; book an
 *                                inspection, reevaluate, ask for / approve a conditional release
 *   /inspection-setup            agencies and their people, rules, plans and the policy
 *
 * Agencies themselves now work in the Audit Console - a separate application
 * with its own sign-in. This console is the marketplace's side: booking,
 * releases and oversight.
 *
 * Every rule is the server's; the rules and plans editors send JSON that the
 * server validates with the same schema it uses everywhere else. Every write
 * carries its own Idempotency-Key.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, Checkbox, EmptyState, ErrorState, Input, LoadingState, PageHeader, Select, Textarea } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { api, downloadFile } from '@/lib/api';
import { refusalCode } from '@/lib/audit-console';
import { newIdempotencyKey } from '@/lib/forms';
import { useSession } from '@/auth/session-context';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';

/** Every status an inspection requirement can be in, in the order an order moves through them. */
const REQUIREMENT_STATUSES = [
  'NOT_REQUIRED',
  'AWAITING_BOOKING',
  'BOOKED',
  'IN_PROGRESS',
  'REPORT_IN_REVIEW',
  'FAILED',
  'ON_HOLD',
  'BLOCKED_BY_NCR',
  'RELEASE_PENDING_APPROVAL',
  'RELEASED',
  'RELEASED_CONDITIONALLY',
  'REEVALUATION_REQUIRED',
  'DISPATCHED',
] as const;
const RESULTS = ['PASS', 'FAIL', 'INCONCLUSIVE'] as const;
const STAGES = ['RAW_MATERIAL', 'DURING_PRODUCTION', 'PRE_SHIPMENT', 'RECEIVING'] as const;
const SCOPE_METHODS = ['FULL', 'SAMPLE'] as const;

type Translate = ReturnType<typeof useI18n>['t'];

function statusLabel(t: Translate, status: string): string {
  return (REQUIREMENT_STATUSES as readonly string[]).includes(status) ? t(`inspection.requirementStatus.${status}` as TranslationKey) : status;
}
function resultLabel(t: Translate, result: string): string {
  return (RESULTS as readonly string[]).includes(result) ? t(`inspection.result.${result}` as TranslationKey) : result;
}
function statusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'RELEASED' || status === 'RELEASED_CONDITIONALLY' || status === 'DISPATCHED') return 'success';
  if (status === 'FAILED' || status === 'BLOCKED_BY_NCR') return 'danger';
  if (status === 'ON_HOLD' || status === 'RELEASE_PENDING_APPROVAL' || status === 'REEVALUATION_REQUIRED') return 'warning';
  return 'neutral';
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

interface QueueRow { id: string; orderNumber?: string; sellerName?: string; level: string; status: string; evaluatedAt?: string | null }
interface Evidence { id: string; fileName: string; purpose: string; releaseId?: string | null; receivedAt?: string | null }
interface Report { id: string; revision: number; status: string; result: string | null }
interface Detail {
  requirement: { id: string; orderNumber: string; sellerName: string; sellerOrderGroupId: string; level: string; status: string; reason: string | null; ruleName: string | null; gate: { sentence: string } };
  jobs: {
    id: string; jobNumber: string; kind?: string; status: string; reinspectionOfJobId: string | null; defects: { status: string }[]; agency: { name?: string } | null;
    scheduledFor: string | null; report: { result: string | null; status: string } | null; reports?: Report[]; evidence?: Evidence[];
  }[];
  releases: { id: string; kind: string; state: string; reason?: string | null; requestedByLabel?: string | null }[];
  releaseEvidence?: Evidence[];
  timeline: { id: string; summary: string; actorLabel: string | null; createdAt: string | null }[];
}
interface SubLotRelease {
  id: string; subLotCode: string; lotReference: string | null; quantity: string; unit: string; lines: unknown; reason: string; state: string;
  requestedByLabel: string | null; requestedAt: string; sellerOrderNumber: string; sellerName: string;
}

function useRun(invalidate: readonly unknown[]): ReturnType<typeof useMutation<unknown, unknown, { method: 'post' | 'put'; path: string; body?: unknown }>> {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (step: { method: 'post' | 'put'; path: string; body?: unknown }) => api[step.method](`/admin/inspection/${step.path}`, step.body, { idempotencyKey: newIdempotencyKey() }),
    onSuccess: async () => {
      toast.success(t('inspection.saved'));
      await queryClient.invalidateQueries({ queryKey: invalidate });
    },
    onError: (failure) => { toast.error(errorMessage(t, failure)); },
  });
}

function useDownload(): (path: string, name: string) => void {
  const { t } = useI18n();
  const toast = useToast();
  return (path, name) => {
    downloadFile(path, name).catch((failure: unknown) => { toast.error(errorMessage(t, failure)); });
  };
}

/** Agencies no longer sign in here or to the storefront: they have the Audit Console. */
function AuditConsoleNote(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  return (
    <Callout tone="info" className="mb-4">
      {t('inspection.consoleNote')}{' '}
      {can('audit_console.manage') && <Link to="/audit-console" className="font-medium text-accent hover:underline">{t('inspection.consoleNoteLink')}</Link>}
    </Callout>
  );
}

export function InspectionQueuePage(): React.JSX.Element {
  const { t } = useI18n();
  const [status, setStatus] = useState('');
  const query = useQuery({
    queryKey: ['admin', 'inspection', status],
    queryFn: () => api.get<{ rows: QueueRow[] }>('/admin/inspection/queue', { query: status === '' ? {} : { status } }),
  });
  const rows = query.data?.rows ?? [];
  return (
    <>
      <PageHeader title={t('inspection.queueTitle')} description={t('inspection.queueDescription')} actions={<Link to="/inspection-setup" className="text-sm font-medium text-brand hover:underline">{t('inspection.setupTitle')}</Link>} />
      <AuditConsoleNote />
      <SubLotReleasesPanel />
      <Select className="mb-4 mt-4 max-w-xs" aria-label={t('inspection.statusFilter')} value={status} onChange={(event) => { setStatus(event.target.value); }}>
        <option value="">{t('inspection.allStatuses')}</option>
        {REQUIREMENT_STATUSES.map((value) => <option key={value} value={value}>{statusLabel(t, value)}</option>)}
      </Select>
      {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} /> : rows.length === 0 ? <EmptyState title={t('inspection.queueEmpty')} /> : (
        <Card bodyClassName="divide-y divide-border-subtle">
          {rows.map((row) => (
            <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
              <Link to={`/inspection/${row.id}`} className="font-medium text-brand hover:underline">{row.orderNumber ?? row.id}</Link>
              <span className="text-xs text-ink-muted">{row.sellerName}</span>
              <span className="flex gap-2"><Badge>{row.level}</Badge><Badge tone={statusTone(row.status)}>{statusLabel(t, row.status)}</Badge></span>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}

/**
 * Sub-lot releases waiting for a second person.
 *
 * A sub-lot release lets exactly the listed quantities of a held lot leave,
 * once. It is asked for in the Audit Console and decided here, and the person
 * who asked can never decide it - the server refuses, and this says why.
 */
export function SubLotReleasesPanel(): React.JSX.Element {
  const { t } = useI18n();
  const key = ['admin', 'inspection', 'sublot-releases', 'PENDING_APPROVAL'];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ releases: SubLotRelease[] }>('/admin/inspection/sublot-releases', { query: { state: 'PENDING_APPROVAL' } }),
  });
  const rows = query.data?.releases ?? [];
  return (
    <Card title={t('inspection.sublot.title')} description={t('inspection.sublot.description')} bodyClassName="divide-y divide-border-subtle">
      {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} /> : rows.length === 0 ? (
        <EmptyState title={t('inspection.sublot.empty')} />
      ) : rows.map((row) => <SubLotDecision key={row.id} release={row} invalidate={key} />)}
    </Card>
  );
}

function linesOf(value: unknown): { orderItemId: string; quantity: number }[] {
  if (!Array.isArray(value)) return [];
  return value.filter((line): line is { orderItemId: string; quantity: number } =>
    typeof line === 'object' && line !== null && typeof (line as { orderItemId?: unknown }).orderItemId === 'string' && typeof (line as { quantity?: unknown }).quantity === 'number');
}

function SubLotDecision({ release, invalidate }: { release: SubLotRelease; invalidate: readonly unknown[] }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') =>
      api.post(`/admin/inspection/sublot-releases/${release.id}/decision`, { decision, note: note.trim() === '' ? null : note.trim() }, { idempotencyKey: newIdempotencyKey() }),
    onSuccess: async () => {
      toast.success(t('inspection.saved'));
      await queryClient.invalidateQueries({ queryKey: invalidate });
    },
    onError: (failure) => {
      setRefusal(refusalCode(failure) === 'SAME_PERSON' ? t('inspection.sublot.samePerson') : errorMessage(t, failure));
    },
  });
  const lines = linesOf(release.lines);
  return (
    <div className="space-y-2 px-5 py-4 text-sm">
      <p className="font-medium text-ink">
        {release.subLotCode} · {release.sellerOrderNumber} · {release.sellerName}
      </p>
      <p>{t('inspection.sublot.quantity', { quantity: release.quantity, unit: release.unit.toLowerCase() })}</p>
      {lines.length > 0 && (
        <ul className="list-inside list-disc text-xs text-ink-muted">
          {lines.map((line) => <li key={line.orderItemId}>{t('inspection.sublot.line', { quantity: String(line.quantity), line: line.orderItemId.slice(-6) })}</li>)}
        </ul>
      )}
      <p className="text-ink-muted">{release.reason}</p>
      <p className="text-xs text-ink-muted">{t('inspection.sublot.requestedBy', { name: release.requestedByLabel ?? '-', when: formatDateTime(release.requestedAt) })}</p>
      {can('inspection.release') && (
        <>
          <Textarea
            rows={2}
            aria-label={t('inspection.sublot.note', { code: release.subLotCode })}
            placeholder={t('inspection.sublot.notePlaceholder')}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
              setRefusal(null);
            }}
          />
          {refusal !== null && <p role="alert" className="text-xs font-medium text-danger">{refusal}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" disabled={decide.isPending} onClick={() => { decide.mutate('APPROVE'); }}>{t('inspection.sublot.approve')}</Button>
            <Button size="sm" variant="secondary" disabled={decide.isPending || note.trim() === ''} onClick={() => { decide.mutate('REJECT'); }}>{t('inspection.sublot.reject')}</Button>
          </div>
        </>
      )}
    </div>
  );
}

export function InspectionRequirementPage(): React.JSX.Element {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const download = useDownload();
  const key = ['admin', 'inspection', 'requirement', id];
  const query = useQuery({ queryKey: key, queryFn: () => api.get<{ inspection: Detail }>(`/admin/inspection/requirements/${id}`) });
  const agencies = useQuery({ queryKey: ['admin', 'inspection', 'agencies'], queryFn: () => api.get<{ agencies: { id: string; name: string }[] }>('/admin/inspection/agencies') });
  const run = useRun(key);
  const [reason, setReason] = useState('');
  const [booking, setBooking] = useState({
    agencyId: '', scheduledFor: '', label: '', addressLine: '', city: '', country: '', payer: 'BUYER', pointType: 'SELLER_PREMISES', reinspectionOfJobId: '',
    stage: 'PRE_SHIPMENT', scopeMethod: 'SAMPLE', timezone: browserTimeZone(),
  });
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [evidenceNote, setEvidenceNote] = useState('');
  const [chosenEvidence, setChosenEvidence] = useState<string[]>([]);
  const upload = useMutation({
    mutationFn: (file: File) => {
      // The fields go before the file: the server reads the ones that precede it.
      const form = new FormData();
      form.append('purpose', 'RELEASE');
      if (evidenceNote.trim() !== '') form.append('note', evidenceNote.trim());
      form.append('file', file);
      return api.upload<{ id: string }>(`/admin/inspection/requirements/${id}/evidence`, form, { idempotencyKey: newIdempotencyKey() });
    },
    onSuccess: async (stored) => {
      setChosenEvidence((current) => (current.includes(stored.id) ? current : [...current, stored.id]));
      setEvidenceFile(null);
      setEvidenceNote('');
      toast.success(t('inspection.evidence.uploaded'));
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (failure) => { toast.error(errorMessage(t, failure)); },
  });

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;
  const d = query.data.inspection;
  const busy = run.isPending;
  // A finished job whose goods failed, were inconclusive or still carry findings can be inspected again once each finding has its corrective action.
  const repeatable = d.jobs.filter(
    (job) => job.status === 'COMPLETED' && (job.report?.result === 'FAIL' || job.report?.result === 'INCONCLUSIVE' || job.defects.length > 0) && !d.jobs.some((later) => later.reinspectionOfJobId === job.id && later.status !== 'CANCELLED' && later.status !== 'DECLINED'),
  );
  const openJob = d.jobs.some((job) => ['REQUESTED', 'ACCEPTED', 'INSPECTOR_ASSIGNED', 'IN_PROGRESS', 'REPORT_SUBMITTED'].includes(job.status));
  const needsCapa = d.jobs.some((job) => job.status === 'COMPLETED' && job.defects.some((defect) => defect.status === 'OPEN'));
  const set = (field: keyof typeof booking) => (event: { target: { value: string } }): void => { setBooking({ ...booking, [field]: event.target.value }); };
  // Release evidence not yet tied to a release: what a new conditional release may rest on.
  const freeEvidence = (d.releaseEvidence ?? []).filter((item) => (item.releaseId ?? null) === null);
  const evidenceIds = chosenEvidence.filter((evidenceId) => freeEvidence.some((item) => item.id === evidenceId));

  return (
    <>
      <PageHeader
        title={d.requirement.orderNumber}
        description={`${d.requirement.sellerName} · ${d.requirement.level} · ${statusLabel(t, d.requirement.status)}`}
        back={{ to: '/inspection', label: t('inspection.queueTitle') }}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('inspection.requirementTitle')} bodyClassName="space-y-2 px-5 py-4 text-sm">
          <p>{d.requirement.gate.sentence}</p>
          {d.requirement.ruleName !== null && <p className="text-ink-muted">{t('inspection.rule')}: {d.requirement.ruleName} · {d.requirement.reason}</p>}
          {d.jobs.map((job) => (
            <div key={job.id} className="space-y-1">
              <p><Badge>{job.status}</Badge> {job.kind === 'REINSPECTION' && <Badge tone="warning">{t('inspection.reinspection.badge')}</Badge>} {job.jobNumber} · {job.agency?.name} · {formatDateTime(job.scheduledFor)} {job.report !== null && `· ${job.report.result !== null ? resultLabel(t, job.report.result) : job.report.status}`} {job.reinspectionOfJobId !== null && `· ${t('inspection.reinspection.original')}: ${d.jobs.find((original) => original.id === job.reinspectionOfJobId)?.jobNumber ?? job.reinspectionOfJobId}`} {d.jobs.filter((later) => later.reinspectionOfJobId === job.id).map((later) => `· ${t('inspection.reinspection.repeatedBy')}: ${later.jobNumber} (${later.status})`).join(' ')}</p>
              <div className="flex flex-wrap gap-2">
                {(job.reports ?? []).filter((report) => report.status === 'SIGNED').map((report) => (
                  <Button key={report.id} size="sm" variant="secondary" onClick={() => { download(`/admin/inspection/reports/${report.id}/pdf`, `${job.jobNumber}-r${String(report.revision)}.pdf`); }}>
                    {t('inspection.reportPdf', { job: job.jobNumber, revision: String(report.revision) })}
                  </Button>
                ))}
              </div>
              {(job.evidence ?? []).length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-ink-muted">{t('inspection.evidence.jobFiles', { job: job.jobNumber })}</summary>
                  <ul className="mt-1 space-y-1">
                    {(job.evidence ?? []).map((item) => (
                      <li key={item.id}>
                        <button type="button" className="text-accent hover:underline" onClick={() => { download(`/admin/inspection/evidence/${item.id}`, item.fileName); }}>
                          {item.fileName}
                        </button>{' '}
                        <span className="text-ink-muted">· {item.purpose}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          ))}
          {d.releases.map((release) => (
            <div key={release.id} className="flex flex-wrap items-center gap-2">
              <span>{release.kind} · {release.state === 'PENDING_APPROVAL' ? t('inspection.releasePending') : release.state}{release.requestedByLabel != null && ` · ${release.requestedByLabel}`}</span>
              {release.state === 'PENDING_APPROVAL' && can('inspection.release') && (
                <>
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => { run.mutate({ method: 'post', path: `releases/${release.id}/approve` }); }}>{t('inspection.approveRelease')}</Button>
                  <Button size="sm" variant="secondary" disabled={busy || reason.trim().length < 10} onClick={() => { run.mutate({ method: 'post', path: `releases/${release.id}/reject`, body: { reason: reason.trim() } }); }}>{t('inspection.rejectRelease')}</Button>
                </>
              )}
            </div>
          ))}
          {(d.releaseEvidence ?? []).length > 0 && (
            <div className="text-xs">
              <p className="font-medium text-ink">{t('inspection.evidence.releaseFiles')}</p>
              <ul className="space-y-1">
                {(d.releaseEvidence ?? []).map((item) => (
                  <li key={item.id}>
                    <button type="button" className="text-accent hover:underline" onClick={() => { download(`/admin/inspection/evidence/${item.id}`, item.fileName); }}>{item.fileName}</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => { run.mutate({ method: 'post', path: `requirements/${id}/reevaluate` }); }}>{t('inspection.reevaluate')}</Button>
        </Card>

        {can('inspection.manage') && <Card title={t('inspection.bookTitle')} bodyClassName="space-y-2 px-5 py-4 text-sm">
          {repeatable.length > 0 && <>
            <Select aria-label={t('inspection.reinspection.original')} value={booking.reinspectionOfJobId} onChange={set('reinspectionOfJobId')}>
              <option value="">{t('inspection.reinspection.choose')}</option>
              {repeatable.map((job) => <option key={job.id} value={job.id}>{job.jobNumber}</option>)}
            </Select>
            {needsCapa && <p>{t('inspection.reinspection.capaFirst')}</p>}
          </>}
          <Select aria-label={t('inspection.agency')} value={booking.agencyId} onChange={set('agencyId')}>
            <option value="">{t('inspection.anyEligibleAgency')}</option>
            {(agencies.data?.agencies ?? []).map((agency) => <option key={agency.id} value={agency.id}>{agency.name}</option>)}
          </Select>
          <Select aria-label={t('inspection.stage')} value={booking.stage} onChange={set('stage')}>
            {STAGES.map((value) => <option key={value} value={value}>{t(`inspection.stageOption.${value}`)}</option>)}
          </Select>
          <Select aria-label={t('inspection.scopeMethod')} value={booking.scopeMethod} onChange={set('scopeMethod')}>
            {SCOPE_METHODS.map((value) => <option key={value} value={value}>{t(`inspection.scopeOption.${value}`)}</option>)}
          </Select>
          <Input type="datetime-local" aria-label={t('inspection.scheduledFor')} value={booking.scheduledFor} onChange={set('scheduledFor')} />
          <Input aria-label={t('inspection.timezone')} placeholder={t('inspection.timezone')} value={booking.timezone} onChange={set('timezone')} />
          <p className="text-xs text-ink-muted">{t('inspection.timezoneHint')}</p>
          <Select aria-label={t('inspection.pointType')} value={booking.pointType} onChange={set('pointType')}>
            {['SELLER_PREMISES', 'WAREHOUSE', 'PORT', 'OTHER'].map((value) => <option key={value}>{value}</option>)}
          </Select>
          {(['label', 'addressLine', 'city', 'country'] as const).map((field) => (
            <Input key={field} aria-label={t(`inspection.point.${field}`)} placeholder={t(`inspection.point.${field}`)} value={booking[field]} onChange={set(field)} />
          ))}
          <Select aria-label={t('inspection.payer')} value={booking.payer} onChange={set('payer')}>
            {['BUYER', 'SELLER', 'PLATFORM'].map((value) => <option key={value}>{value}</option>)}
          </Select>
          <Button variant="primary" disabled={busy || openJob || (repeatable.length > 0 && (booking.reinspectionOfJobId === '' || needsCapa)) || booking.scheduledFor === '' || booking.city === '' || booking.country.length !== 2} onClick={() => {
            run.mutate({ method: 'post', path: 'jobs', body: {
              sellerOrderGroupId: d.requirement.sellerOrderGroupId, agencyId: booking.agencyId === '' ? null : booking.agencyId,
              scheduledFor: new Date(booking.scheduledFor).toISOString(), inspectionPointType: booking.pointType,
              inspectionPoint: { label: booking.label || booking.city, addressLine: booking.addressLine || booking.city, city: booking.city, country: booking.country.toUpperCase() },
              payer: booking.payer,
              reinspectionOfJobId: booking.reinspectionOfJobId || null,
              stage: booking.stage,
              scopeMethod: booking.scopeMethod,
              timezone: booking.timezone.trim() === '' ? null : booking.timezone.trim(),
            } });
          }}>{t('inspection.book')}</Button>
        </Card>}

        {can('inspection.release') && <Card title={t('inspection.conditionalTitle')} description={t('inspection.conditionalDescription')} bodyClassName="space-y-2 px-5 py-4 text-sm">
          <Textarea aria-label={t('inspection.overrideReason')} placeholder={t('inspection.overrideReason')} rows={3} value={reason} onChange={(event) => { setReason(event.target.value); }} />
          <Input type="file" aria-label={t('inspection.evidence.file')} onChange={(event) => { setEvidenceFile(event.target.files?.[0] ?? null); }} />
          <Input aria-label={t('inspection.evidence.note')} placeholder={t('inspection.evidence.note')} value={evidenceNote} onChange={(event) => { setEvidenceNote(event.target.value); }} />
          <Button size="sm" variant="secondary" disabled={evidenceFile === null || upload.isPending} onClick={() => { if (evidenceFile !== null) upload.mutate(evidenceFile); }}>{t('inspection.evidence.upload')}</Button>
          {freeEvidence.length > 0 && (
            <fieldset className="space-y-1">
              <legend className="text-xs font-medium text-ink">{t('inspection.evidence.choose')}</legend>
              {freeEvidence.map((item) => (
                <label key={item.id} className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={chosenEvidence.includes(item.id)}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setChosenEvidence((current) => (checked ? [...current, item.id] : current.filter((other) => other !== item.id)));
                    }}
                  />
                  {item.fileName}
                </label>
              ))}
            </fieldset>
          )}
          {evidenceIds.length === 0 && <p className="text-xs text-ink-muted">{t('inspection.evidence.required')}</p>}
          <Button variant="secondary" disabled={busy || reason.trim().length < 10 || evidenceIds.length === 0} onClick={() => { run.mutate({ method: 'post', path: `requirements/${id}/conditional-release`, body: { reason: reason.trim(), evidenceIds } }); }}>{t('inspection.requestConditional')}</Button>
        </Card>}
      </div>
      <Card title={t('inspection.timeline')} className="mt-4" bodyClassName="px-5 py-4 text-sm">
        <ol className="space-y-1">
          {d.timeline.map((event) => <li key={event.id} className="flex justify-between gap-2"><span>{event.summary} <span className="text-ink-muted">{event.actorLabel}</span></span><span className="text-xs text-ink-muted">{formatDateTime(event.createdAt)}</span></li>)}
        </ol>
      </Card>
    </>
  );
}

function JsonEditor({ title, path, listKey, method }: { title: string; path: string; listKey: string; method: 'post' | 'put' }): React.JSX.Element {
  const { t } = useI18n();
  const key = ['admin', 'inspection', path];
  const query = useQuery({ queryKey: key, queryFn: () => api.get<Record<string, unknown>>(`/admin/inspection/${path}`) });
  const run = useRun(key);
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  return (
    <Card title={title} bodyClassName="space-y-2 px-5 py-4 text-sm">
      <pre className="max-h-64 overflow-auto rounded bg-surface-sunken p-2 text-xs">{JSON.stringify(query.data?.[listKey] ?? null, null, 2)}</pre>
      <Textarea aria-label={title} rows={5} placeholder={t('inspection.jsonHint')} value={text} onChange={(event) => { setText(event.target.value); setInvalid(false); }} />
      {invalid && <p role="alert" className="text-danger">{t('inspection.jsonInvalid')}</p>}
      <Button size="sm" variant="primary" disabled={run.isPending || text.trim() === ''} onClick={() => {
        try {
          run.mutate({ method, path, body: JSON.parse(text) as unknown });
        } catch {
          setInvalid(true);
        }
      }}>{t('inspection.saveJson')}</Button>
    </Card>
  );
}

interface AgencyPerson { memberId: string; fullName: string; email: string; role: string; status: string; accountType: string; activated: boolean; mfaEnrolled: boolean }

function AgencyPeople({ agencyId }: { agencyId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ['admin', 'inspection', 'agency-members', agencyId],
    queryFn: () => api.get<{ people: AgencyPerson[] }>(`/admin/inspection/agencies/${agencyId}/members`),
    enabled: agencyId !== '',
  });
  if (agencyId === '') return null;
  const people = query.data?.people ?? [];
  if (query.isPending) return <LoadingState />;
  if (people.length === 0) return <p className="text-xs text-ink-muted">{t('inspection.members.empty')}</p>;
  return (
    <ul className="space-y-1 text-xs">
      {people.map((person) => (
        <li key={person.memberId}>
          <span className="font-medium text-ink">{person.fullName}</span> · {person.email} · {t(`auditConsole.role.${person.role}` as TranslationKey)} ·{' '}
          {person.accountType === 'CUSTOMER' ? t('auditConsole.account.CUSTOMER') : person.activated ? t('auditConsole.signIn.activated') : t('auditConsole.signIn.notActivated')}
        </li>
      ))}
    </ul>
  );
}

export function InspectionSetupPage(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = ['admin', 'inspection', 'agencies'];
  const agencies = useQuery({ queryKey: key, queryFn: () => api.get<{ agencies: { id: string; name: string; country: string; status: string }[] }>('/admin/inspection/agencies') });
  const run = useRun(key);
  const [agency, setAgency] = useState({ name: '', legalName: '', country: '', contactEmail: '' });
  const [member, setMember] = useState({ agencyId: '', email: '', fullName: '', role: 'INSPECTOR' });
  const [emailInUse, setEmailInUse] = useState(false);
  const invite = useMutation({
    mutationFn: () =>
      api.post<{ id: string; userId: string; expiresAt: string }>(
        `/admin/inspection/agencies/${member.agencyId}/members`,
        { email: member.email.trim(), fullName: member.fullName.trim(), role: member.role },
        { idempotencyKey: newIdempotencyKey() },
      ),
    onSuccess: async (result) => {
      toast.success(t('inspection.members.invited', { email: member.email.trim(), until: formatDateTime(result.expiresAt) }));
      setMember({ ...member, email: '', fullName: '' });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'inspection', 'agency-members', member.agencyId] });
    },
    onError: (failure) => {
      if (refusalCode(failure) === 'EMAIL_IN_USE') {
        setEmailInUse(true);
        return;
      }
      toast.error(errorMessage(t, failure));
    },
  });
  return (
    <>
      <PageHeader title={t('inspection.setupTitle')} back={{ to: '/inspection', label: t('inspection.queueTitle') }} />
      <AuditConsoleNote />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('inspection.agencies')} bodyClassName="space-y-2 px-5 py-4 text-sm">
          <ul>{(agencies.data?.agencies ?? []).map((row) => <li key={row.id}>{row.name} · {row.country} · <Badge>{row.status}</Badge></li>)}</ul>
          {(['name', 'legalName', 'country', 'contactEmail'] as const).map((field) => (
            <Input key={field} aria-label={t(`inspection.agencyField.${field}`)} placeholder={t(`inspection.agencyField.${field}`)} value={agency[field]} onChange={(event) => { setAgency({ ...agency, [field]: event.target.value }); }} />
          ))}
          <Button size="sm" variant="primary" disabled={run.isPending || agency.name === '' || agency.country.length !== 2} onClick={() => { run.mutate({ method: 'post', path: 'agencies', body: { ...agency, country: agency.country.toUpperCase() } }); }}>{t('inspection.addAgency')}</Button>
          <p className="pt-2 text-xs text-ink-muted">{t('inspection.members.explain')}</p>
          <Select aria-label={t('inspection.agency')} value={member.agencyId} onChange={(event) => { setMember({ ...member, agencyId: event.target.value }); }}>
            <option value="">{t('inspection.agency')}</option>
            {(agencies.data?.agencies ?? []).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
          </Select>
          <AgencyPeople agencyId={member.agencyId} />
          <Input type="email" aria-label={t('inspection.memberEmail')} placeholder={t('inspection.memberEmail')} aria-invalid={emailInUse} value={member.email} onChange={(event) => { setMember({ ...member, email: event.target.value }); setEmailInUse(false); }} />
          {emailInUse && <p role="alert" className="text-xs font-medium text-danger">{t('auditConsole.invite.emailInUse')}</p>}
          <Input aria-label={t('inspection.memberName')} placeholder={t('inspection.memberName')} value={member.fullName} onChange={(event) => { setMember({ ...member, fullName: event.target.value }); }} />
          <Select aria-label={t('inspection.memberRole')} value={member.role} onChange={(event) => { setMember({ ...member, role: event.target.value }); }}>
            {['AGENCY_ADMIN', 'COORDINATOR', 'INSPECTOR', 'QA_REVIEWER'].map((value) => <option key={value} value={value}>{t(`auditConsole.role.${value}` as TranslationKey)}</option>)}
          </Select>
          <Button size="sm" variant="secondary" disabled={invite.isPending || member.agencyId === '' || !member.email.includes('@') || member.fullName.trim() === ''} onClick={() => { invite.mutate(); }}>{t('inspection.addMember')}</Button>
        </Card>
        <JsonEditor title={t('inspection.rules')} path="rules" listKey="rules" method="post" />
        <JsonEditor title={t('inspection.plans')} path="plans" listKey="plans" method="post" />
        <JsonEditor title={t('inspection.policy')} path="policy" listKey="policy" method="put" />
      </div>
    </>
  );
}
