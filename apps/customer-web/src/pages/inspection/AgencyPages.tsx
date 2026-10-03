/**
 * The inspection agency portal (checklist Master rows 45-54).
 *
 *   /inspection            dashboard: who you are, your jobs by status and SLA
 *   /inspection/jobs/:id   one job: scope, conflict check, inspector, checklist,
 *                          sampling, defects (NCR), evidence, report, sign-off,
 *                          and binding the passed goods to a container and seal
 *
 * The dashboard also carries the agency calendar (ENH-011): capacity per day,
 * each booked job's time and place, and whether the seller is ready.
 *
 * The server's `me.allowedTransitions`, `me.role` and `me.isNamedInspector`
 * decide which actions appear; every action is checked again on the server.
 */
import { Countdown } from '@/components/Countdown';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, EmptyState, ErrorState, Input, LoadingState, PageHeader, Select, Textarea } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatDate, formatDateTime, formatMoneyMinor } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { agencyAction, fetchAgencyCalendar, fetchAgencyDashboard, fetchAgencyJob, fetchAgencyMe, inspectionKeys, uploadAgencyEvidence, type InspectionPurchaseOrder, type InspectionReferenceSample } from '@/lib/inspection';
import { ReferenceSample } from '@/components/inspection/ReferenceSample';

/** Keys added with ENH-011/012; typed loosely until every locale carries them. */
const tk = (key: string): TranslationKey => key as TranslationKey;

interface JobDetail {
  job: { id: string; jobNumber: string; status: string; kind: string; scheduledFor: string | null; inspectionPoint: { label?: string; city?: string } | null; report: { status: string; result: string | null } | null; defects?: { id: string; ncrNumber: string; severity: string; description: string }[] };
  requirement: { orderNumber: string; sellerName: string; level: string; purchaseOrder?: InspectionPurchaseOrder | null; referenceSample?: InspectionReferenceSample | null };
  checklist: { code?: string; itemCode?: string; label?: string; text?: string }[];
  conflictCheck: { agencyProblems: string[] };
  me: { role: string; isNamedInspector: boolean; allowedTransitions: { to: string; requiresReason: boolean }[] };
  eligibleInspectors: { id: string; fullName: string; competent?: boolean; identityVerified?: boolean }[];
  consignments?: { id: string; shipmentReference: string; containerNumbers: string[]; sealNumbers: string[] }[];
  bindings?: { id: string; containerNumber: string | null; sealNumber: string | null; stuffedQuantity: number; stuffedAt: string | null; witnessName: string | null }[];
}

function isoDay(date: Date): string {
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** ENH-011: two weeks of capacity, booked jobs (time, port or place) and seller readiness. */
export function AgencyCalendarCard(): React.JSX.Element {
  const { t } = useI18n();
  const [from, setFrom] = useState(() => isoDay(new Date()));
  const calendar = useQuery({ queryKey: [...inspectionKeys.agency, 'calendar', from], queryFn: () => fetchAgencyCalendar(from) });
  const shift = (days: number): void => {
    const [year = 1970, month = 1, day = 1] = from.split('-').map(Number);
    setFrom(isoDay(new Date(year, month - 1, day + days)));
  };

  return (
    <Card title={t(tk('inspection.calendar.title'))} bodyClassName="space-y-3 px-5 py-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => { shift(-14); }}>{t(tk('inspection.calendar.previous'))}</Button>
        <Input type="date" aria-label={t(tk('inspection.calendar.from'))} value={from} onChange={(event) => { if (event.target.value !== '') setFrom(event.target.value); }} />
        <Button size="sm" variant="secondary" onClick={() => { shift(14); }}>{t(tk('inspection.calendar.next'))}</Button>
      </div>
      {calendar.isPending ? <LoadingState /> : calendar.isError ? <ErrorState error={calendar.error} onRetry={() => { void calendar.refetch(); }} /> : (
        <ul className="divide-y divide-border-subtle" aria-label={t(tk('inspection.calendar.title'))}>
          {calendar.data.days.map((day) => (
            <li key={day.date} className="space-y-1 py-2" data-testid={`calendar-day-${day.date}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{formatDate(`${day.date}T12:00:00`)}</span>
                <span className="text-ink-muted">{t(tk('inspection.calendar.capacity'), { booked: String(day.booked), capacity: String(day.capacity) })}</span>
                {day.full && <Badge tone="danger">{t(tk('inspection.calendar.full'))}</Badge>}
              </div>
              {day.jobs.map((job) => (
                <div key={job.id} className="flex flex-wrap items-center gap-2 pl-4">
                  <span className="tabular">{job.time}</span>
                  <Link to={`/inspection/jobs/${job.id}`} className="font-medium text-brand hover:underline">{job.jobNumber}</Link>
                  <Badge>{job.status}</Badge>
                  <span>{placeOf(job.inspectionPoint) ?? job.inspectionPointType}</span>
                  <Badge tone={job.readiness === 'READY' ? 'success' : 'warning'}>
                    {job.readiness === 'READY' ? t(tk('inspection.calendar.ready')) : t(tk('inspection.calendar.notReady'))}
                  </Badge>
                  {job.readyDate !== null && <span className="text-ink-muted">{t(tk('inspection.calendar.readyDate'))}: {formatDate(`${job.readyDate}T12:00:00`)}</span>}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function placeOf(point: { label?: string; city?: string; port?: string; country?: string } | null): string | null {
  if (point === null) return null;
  const parts = [point.port ?? point.label, point.city, point.country].filter((part): part is string => part !== undefined && part !== '');
  return parts.length === 0 ? null : parts.join(', ');
}

export function AgencyDashboardPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  useDocumentMeta({ title: t('inspection.agencyTitle'), noIndex: true }, business.displayName);
  const me = useQuery({ queryKey: [...inspectionKeys.agency, 'me'], queryFn: fetchAgencyMe, retry: false });
  const dashboard = useQuery({ queryKey: [...inspectionKeys.agency, 'dashboard'], queryFn: fetchAgencyDashboard, enabled: me.isSuccess });

  if (me.isPending) return <LoadingState />;
  if (me.isError) return <ErrorState error={me.error} onRetry={() => { void me.refetch(); }} />;
  if (dashboard.isPending) return <LoadingState />;
  if (dashboard.isError) return <ErrorState error={dashboard.error} onRetry={() => { void dashboard.refetch(); }} />;
  const d = dashboard.data;
  const overdue = d.jobs.filter((job) => job.slaState !== 'ON_TIME');
  const reports = d.reports ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-8">
      <PageHeader
        title={t('inspection.agencyTitle')}
        description={`${me.data.membership.agencyName} · ${me.data.membership.fullName} · ${me.data.membership.role}`}
      />
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(['offered', 'toAssign', 'assigned', 'inProgress', 'awaitingQa', 'completed', 'overdue'] as const).map((key) => <div key={key} className="rounded-lg border border-border-subtle p-3"><dt className="text-sm text-ink-muted">{t(`inspection.dashboard.${key}`)}</dt><dd className="text-xl font-semibold">{d.counts[key]}</dd></div>)}
      </dl>
      <AgencyCalendarCard />
      {overdue.length > 0 && (
        <Card title={t('inspection.dashboard.slaTitle')} bodyClassName="divide-y divide-border-subtle">
          {overdue.map((job) => (
            <div key={job.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              <Link to={`/inspection/jobs/${job.id}`} className="font-medium text-brand hover:underline">{job.jobNumber}</Link>
              <Badge tone="danger">{t(`inspection.dashboard.${job.slaState}`)}</Badge>
              <span>
                {job.slaState === 'ACCEPT_OVERDUE' ? t('inspection.dashboard.acceptDue') : t('inspection.dashboard.reportDue')}:{' '}
                {formatDateTime(job.slaState === 'ACCEPT_OVERDUE' ? job.acceptDueAt : job.reportDueAt)}
              </span>
            </div>
          ))}
        </Card>
      )}
      {d.jobs.length === 0 ? (
        <EmptyState title={t('inspection.noJobs')} />
      ) : (
        <Card bodyClassName="divide-y divide-border-subtle">
          {d.jobs.map((job) => (
            <div key={job.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
              <Link to={`/inspection/jobs/${job.id}`} className="font-medium text-brand hover:underline">{job.jobNumber}</Link>
              <span className="text-xs text-ink-muted">{formatDateTime(job.scheduledFor)}</span>
              <Badge>{job.status}</Badge>
              {job.kind === 'REINSPECTION' && <Badge tone="warning">{t('inspection.reinspection.badge')}</Badge>}
              <span>{t('inspection.dashboard.acceptDue')}: {formatDateTime(job.acceptDueAt)} <Countdown deadline={job.acceptDueAt} /></span>
              <span>{t('inspection.dashboard.reportDue')}: {formatDateTime(job.reportDueAt)} <Countdown deadline={job.reportDueAt} /></span>
              <Badge tone={job.slaState === 'ON_TIME' ? 'success' : 'danger'}>{t(`inspection.dashboard.${job.slaState}`)}</Badge>
              <span>{t('inspection.inspector')}: {d.inspectors.find((member) => member.id === job.inspectorMemberId)?.fullName ?? '—'}</span>
              <Link to={`/inspection/jobs/${job.id}`} className="text-brand hover:underline">{t('inspection.report')}</Link>
            </div>
          ))}
        </Card>
      )}
      {d.inspectors.length > 0 && <Card title={t('inspection.dashboard.inspectors')} bodyClassName="divide-y divide-border-subtle">
        {d.inspectors.map((member) => <div key={member.id} className="flex flex-wrap gap-3 px-5 py-3 text-sm"><span>{member.fullName}</span><Badge>{member.role}</Badge><Badge>{member.status}</Badge><span>{t('inspection.dashboard.identity')}: {formatDateTime(member.identityVerifiedAt)}</span><span>{t('inspection.dashboard.expires')}: {formatDateTime(member.credentialExpiresAt)}</span></div>)}
      </Card>}
      <Card title={t('inspection.dashboard.reports')} bodyClassName="divide-y divide-border-subtle">
        {reports.length === 0 ? <EmptyState title={t('inspection.dashboard.noReports')} /> : reports.map((report) => (
          <div key={report.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
            <Link to={`/inspection/jobs/${report.jobId}`} className="font-medium text-brand hover:underline">{report.jobNumber}</Link>
            <span>{t('inspection.dashboard.revision', { revision: String(report.revision) })}</span>
            <Badge>{report.status}</Badge>
            {report.result !== null && <Badge tone={report.result === 'PASS' ? 'success' : 'warning'}>{report.result}</Badge>}
            <span className="text-xs text-ink-muted">{formatDateTime(report.signedAt ?? report.submittedAt)}</span>
          </div>
        ))}
      </Card>
      {me.data.membership.permissions.includes('inspection.invoice.write') && <Card title={t('inspection.dashboard.invoices')} bodyClassName="divide-y divide-border-subtle">
        {d.invoices.length === 0 ? <EmptyState title={t('inspection.dashboard.noInvoices')} /> : d.invoices.map((invoice) => <div key={invoice.id} className="flex flex-wrap gap-3 px-5 py-3 text-sm"><span>{invoice.invoiceNumber}</span><span>{invoice.jobNumber}</span><span>{formatMoneyMinor(invoice.amountMinor, invoice.currency)}</span><Badge>{invoice.status}</Badge><span>{invoice.payer}</span></div>)}
      </Card>}
    </div>
  );
}

export function AgencyJobPage(): React.JSX.Element {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const { business } = useStorefront();
  const toast = useToast();
  const queryClient = useQueryClient();
  useDocumentMeta({ title: t('inspection.agencyTitle'), noIndex: true }, business.displayName);
  const query = useQuery({ queryKey: inspectionKeys.agencyJob(id), queryFn: async () => (await fetchAgencyJob(id)) as unknown as JobDetail });
  const [note, setNote] = useState('');
  const [inspector, setInspector] = useState('');
  const [sampling, setSampling] = useState({ lotReference: '', sampledQuantity: '', acceptedQuantity: '', rejectedQuantity: '' });
  const [defect, setDefect] = useState({ severity: 'MAJOR', requirementRef: '', description: '', defectQuantity: '1' });
  const [binding, setBinding] = useState({ logisticsShipmentId: '', containerNumber: '', sealNumber: '', stuffedQuantity: '', stuffedAt: '', witnessName: '' });

  const run = useMutation({
    mutationFn: (step: { action: string; body?: unknown }) => agencyAction(id, step.action, step.body),
    onSuccess: async () => {
      toast.success(t('inspection.saved'));
      setNote('');
      await queryClient.invalidateQueries({ queryKey: inspectionKeys.agencyJob(id) });
    },
    onError: (failure) => { toast.error(errorMessage(t, failure)); },
  });
  const upload = useMutation({
    mutationFn: (file: File) => uploadAgencyEvidence(id, file, { purpose: 'GENERAL', note }),
    onSuccess: () => { toast.success(t('inspection.saved')); },
    onError: (failure) => { toast.error(errorMessage(t, failure)); },
  });

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;
  const d = query.data;
  const can = (status: string): boolean => d.me.allowedTransitions.some((transition) => transition.to === status);
  const busy = run.isPending;
  const inProgress = d.job.status === 'IN_PROGRESS' && d.me.isNamedInspector;
  // ENH-012: only the named inspector binds, and only goods that passed.
  const canBind = d.me.isNamedInspector && d.job.report?.result === 'PASS';
  const bindings = d.bindings ?? [];
  const bindingReady =
    binding.logisticsShipmentId !== '' &&
    /^[1-9]\d{0,8}$/.test(binding.stuffedQuantity) &&
    binding.stuffedAt !== '' &&
    (binding.containerNumber.trim() !== '' || binding.sealNumber.trim() !== '');

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-8">
      <PageHeader
        title={d.job.jobNumber}
        description={`${d.requirement.orderNumber} · ${d.requirement.sellerName} · ${d.requirement.level}`}
        actions={<Link to="/inspection" className="text-sm font-medium text-brand hover:underline">{t('inspection.backToJobs')}</Link>}
      />
      <Card bodyClassName="space-y-2 px-5 py-4 text-sm">
        <Link to={`/inspection/jobs/${id}/packaging`} className="text-brand hover:underline">{t('inspection.packaging.title')}</Link>
        <p><Badge>{d.job.status}</Badge> {d.job.kind} · {formatDateTime(d.job.scheduledFor)} · {d.job.inspectionPoint?.label} {d.job.inspectionPoint?.city}</p>
        {d.conflictCheck.agencyProblems.length > 0 && <p className="text-danger">{t('inspection.conflicts')}: {d.conflictCheck.agencyProblems.join(', ')}</p>}
        {d.job.report !== null && <p>{t('inspection.report')}: <strong>{d.job.report.result ?? d.job.report.status}</strong></p>}
        <ReferenceSample purchaseOrder={d.requirement.purchaseOrder} referenceSample={d.requirement.referenceSample} />
      </Card>

      <Card title={t('inspection.actions')} bodyClassName="space-y-3 px-5 py-4 text-sm">
        <Textarea aria-label={t('inspection.noteOrReason')} placeholder={t('inspection.noteOrReason')} rows={2} value={note} onChange={(event) => { setNote(event.target.value); }} />
        <div className="flex flex-wrap gap-2">
          {can('ACCEPTED') && (
            <Button variant="primary" disabled={busy || note.trim() === ''} onClick={() => { run.mutate({ action: 'accept', body: { conflictStatement: note.trim(), confirmNoConflict: true } }); }}>{t('inspection.accept')}</Button>
          )}
          {can('DECLINED') && (
            <Button variant="secondary" disabled={busy || note.trim() === ''} onClick={() => { run.mutate({ action: 'decline', body: { reason: note.trim() } }); }}>{t('inspection.decline')}</Button>
          )}
          {d.me.isNamedInspector && d.job.status === 'INSPECTOR_ASSIGNED' && (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => { run.mutate({ action: 'conflict', body: { hasConflict: false, details: note.trim() || null } }); }}>{t('inspection.noConflict')}</Button>
              <Button variant="primary" disabled={busy} onClick={() => { run.mutate({ action: 'start' }); }}>{t('inspection.start')}</Button>
            </>
          )}
          {inProgress && (
            <Button variant="primary" disabled={busy} onClick={() => { run.mutate({ action: 'report/submit', body: { summary: note.trim() || null } }); }}>{t('inspection.submitReport')}</Button>
          )}
          {d.job.status === 'REPORT_SUBMITTED' && (
            <>
              <Button variant="primary" disabled={busy} onClick={() => { run.mutate({ action: 'report/sign' }); }}>{t('inspection.signReport')}</Button>
              <Button variant="secondary" disabled={busy || note.trim() === ''} onClick={() => { run.mutate({ action: 'report/return', body: { reason: note.trim() } }); }}>{t('inspection.returnReport')}</Button>
            </>
          )}
        </div>
        {can('INSPECTOR_ASSIGNED') && (
          <div className="flex flex-wrap gap-2">
            <Select aria-label={t('inspection.inspector')} value={inspector} onChange={(event) => { setInspector(event.target.value); }}>
              <option value="">{t('inspection.chooseInspector')}</option>
              {d.eligibleInspectors.map((member) => (
                <option key={member.id} value={member.id} disabled={member.competent === false}>{member.fullName}</option>
              ))}
            </Select>
            <Button variant="secondary" disabled={busy || inspector === ''} onClick={() => { run.mutate({ action: 'assign', body: { inspectorMemberId: inspector } }); }}>{t('inspection.assign')}</Button>
          </div>
        )}
      </Card>

      {inProgress && (
        <Card title={t('inspection.checklist')} bodyClassName="space-y-4 px-5 py-4 text-sm">
          <ul className="space-y-2">
            {d.checklist.map((item, index) => {
              const code = item.code ?? item.itemCode ?? String(index);
              return (
                <li key={code} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{item.label ?? item.text ?? code}</span>
                  <span className="flex gap-1">
                    {(['CONFORM', 'NONCONFORM', 'NOT_APPLICABLE'] as const).map((outcome) => (
                      <Button key={outcome} size="sm" variant="secondary" disabled={busy} onClick={() => { run.mutate({ action: 'checks', body: { itemCode: code, outcome } }); }}>{outcome}</Button>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="grid gap-2 sm:grid-cols-4">
            {(['lotReference', 'sampledQuantity', 'acceptedQuantity', 'rejectedQuantity'] as const).map((key) => (
              <Input key={key} aria-label={t(`inspection.sampling.${key}`)} placeholder={t(`inspection.sampling.${key}`)} value={sampling[key]} onChange={(event) => { setSampling({ ...sampling, [key]: event.target.value }); }} />
            ))}
          </div>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => {
            run.mutate({ action: 'sampling', body: { lotReference: sampling.lotReference, sampledQuantity: Number(sampling.sampledQuantity), acceptedQuantity: Number(sampling.acceptedQuantity), rejectedQuantity: Number(sampling.rejectedQuantity) } });
          }}>{t('inspection.saveSampling')}</Button>
          <div className="grid gap-2 sm:grid-cols-4">
            <Select aria-label={t('inspection.severity')} value={defect.severity} onChange={(event) => { setDefect({ ...defect, severity: event.target.value }); }}>
              {['CRITICAL', 'MAJOR', 'MINOR'].map((value) => <option key={value} value={value}>{value}</option>)}
            </Select>
            <Input aria-label={t('inspection.requirementRef')} placeholder={t('inspection.requirementRef')} value={defect.requirementRef} onChange={(event) => { setDefect({ ...defect, requirementRef: event.target.value }); }} />
            <Input aria-label={t('inspection.defectDescription')} placeholder={t('inspection.defectDescription')} value={defect.description} onChange={(event) => { setDefect({ ...defect, description: event.target.value }); }} />
            <Input aria-label={t('inspection.defectQuantity')} placeholder={t('inspection.defectQuantity')} value={defect.defectQuantity} onChange={(event) => { setDefect({ ...defect, defectQuantity: event.target.value }); }} />
          </div>
          <Button size="sm" variant="secondary" disabled={busy || defect.description === ''} onClick={() => {
            run.mutate({ action: 'defects', body: { ...defect, defectQuantity: Number(defect.defectQuantity) } });
          }}>{t('inspection.logDefect')}</Button>
          <label className="block">
            <span className="font-medium">{t('inspection.addEvidence')}</span>
            <input type="file" className="mt-1 block w-full" disabled={upload.isPending} onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) upload.mutate(file);
              event.target.value = '';
            }} />
          </label>
        </Card>
      )}

      {canBind || bindings.length > 0 ? (
        <Card title={t(tk('inspection.binding.title'))} bodyClassName="space-y-3 px-5 py-4 text-sm">
          {bindings.length > 0 && (
            <ul className="space-y-1">
              {bindings.map((row) => (
                <li key={row.id}>{row.containerNumber ?? '—'} · {row.sealNumber ?? '—'} · {row.stuffedQuantity} · {formatDateTime(row.stuffedAt)}{row.witnessName !== null ? ` · ${row.witnessName}` : ''}</li>
              ))}
            </ul>
          )}
          {canBind && (
            <>
              <div className="grid gap-2 sm:grid-cols-3">
                <Select aria-label={t(tk('inspection.binding.consignment'))} value={binding.logisticsShipmentId} onChange={(event) => { setBinding({ ...binding, logisticsShipmentId: event.target.value }); }}>
                  <option value="">{t(tk('inspection.binding.chooseConsignment'))}</option>
                  {(d.consignments ?? []).map((consignment) => (
                    <option key={consignment.id} value={consignment.id}>
                      {[consignment.shipmentReference, ...consignment.containerNumbers, ...consignment.sealNumbers].join(' · ')}
                    </option>
                  ))}
                </Select>
                <Input aria-label={t(tk('inspection.binding.containerNumber'))} placeholder={t(tk('inspection.binding.containerNumber'))} maxLength={32} value={binding.containerNumber} onChange={(event) => { setBinding({ ...binding, containerNumber: event.target.value }); }} />
                <Input aria-label={t(tk('inspection.binding.sealNumber'))} placeholder={t(tk('inspection.binding.sealNumber'))} maxLength={32} value={binding.sealNumber} onChange={(event) => { setBinding({ ...binding, sealNumber: event.target.value }); }} />
                <Input aria-label={t(tk('inspection.binding.stuffedQuantity'))} placeholder={t(tk('inspection.binding.stuffedQuantity'))} inputMode="numeric" value={binding.stuffedQuantity} onChange={(event) => { setBinding({ ...binding, stuffedQuantity: event.target.value }); }} />
                <Input type="datetime-local" aria-label={t(tk('inspection.binding.stuffedAt'))} value={binding.stuffedAt} onChange={(event) => { setBinding({ ...binding, stuffedAt: event.target.value }); }} />
                <Input aria-label={t(tk('inspection.binding.witness'))} placeholder={t(tk('inspection.binding.witness'))} maxLength={120} value={binding.witnessName} onChange={(event) => { setBinding({ ...binding, witnessName: event.target.value }); }} />
              </div>
              <Button size="sm" variant="primary" disabled={busy || !bindingReady} onClick={() => {
                run.mutate({ action: 'binding', body: {
                  logisticsShipmentId: binding.logisticsShipmentId,
                  containerNumber: binding.containerNumber.trim() || null,
                  sealNumber: binding.sealNumber.trim() || null,
                  stuffedQuantity: Number(binding.stuffedQuantity),
                  stuffedAt: new Date(binding.stuffedAt).toISOString(),
                  witnessName: binding.witnessName.trim() || null,
                } });
              }}>{t(tk('inspection.binding.save'))}</Button>
            </>
          )}
        </Card>
      ) : null}

      {(d.job.defects ?? []).length > 0 && (
        <Card title={t('inspection.defects')} bodyClassName="px-5 py-4 text-sm">
          <ul className="space-y-1">
            {(d.job.defects ?? []).map((item) => <li key={item.id}><Badge>{item.severity}</Badge> {item.ncrNumber} — {item.description}</li>)}
          </ul>
        </Card>
      )}
    </div>
  );
}
