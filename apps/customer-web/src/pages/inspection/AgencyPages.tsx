/**
 * The inspection agency portal (checklist Master rows 45-54).
 *
 *   /inspection            dashboard: who you are, your jobs by status and SLA
 *   /inspection/jobs/:id   one job: scope, conflict check, inspector, checklist,
 *                          sampling, defects (NCR), evidence, report, sign-off
 *
 * The server's `me.allowedTransitions`, `me.role` and `me.isNamedInspector`
 * decide which actions appear; every action is checked again on the server.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, EmptyState, ErrorState, Input, LoadingState, PageHeader, Select, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatMoneyMinor } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { agencyAction, fetchAgencyDashboard, fetchAgencyJob, fetchAgencyMe, inspectionKeys, uploadAgencyEvidence } from '@/lib/inspection';

interface JobDetail {
  job: { id: string; jobNumber: string; status: string; kind: string; scheduledFor: string | null; inspectionPoint: { label?: string; city?: string } | null; report: { status: string; result: string | null } | null; defects?: { id: string; ncrNumber: string; severity: string; description: string }[] };
  requirement: { orderNumber: string; sellerName: string; level: string };
  checklist: { code?: string; itemCode?: string; label?: string; text?: string }[];
  conflictCheck: { agencyProblems: string[] };
  me: { role: string; isNamedInspector: boolean; allowedTransitions: string[] };
  eligibleInspectors: { id: string; fullName: string; competent?: boolean; identityVerified?: boolean }[];
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

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-8">
      <PageHeader
        title={t('inspection.agencyTitle')}
        description={`${me.data.membership.agencyName} · ${me.data.membership.fullName} · ${me.data.membership.role}`}
      />
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(['offered', 'toAssign', 'assigned', 'inProgress', 'awaitingQa', 'completed', 'overdue'] as const).map((key) => <div key={key} className="rounded-lg border border-border-subtle p-3"><dt className="text-sm text-ink-muted">{t(`inspection.dashboard.${key}`)}</dt><dd className="text-xl font-semibold">{d.counts[key]}</dd></div>)}
      </dl>
      {d.jobs.length === 0 ? (
        <EmptyState title={t('inspection.noJobs')} />
      ) : (
        <Card bodyClassName="divide-y divide-border-subtle">
          {d.jobs.map((job) => (
            <div key={job.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
              <Link to={`/inspection/jobs/${job.id}`} className="font-medium text-brand hover:underline">{job.jobNumber}</Link>
              <span className="text-xs text-ink-muted">{formatDateTime(job.scheduledFor)}</span>
              <Badge>{job.status}</Badge>
              <span>{t('inspection.dashboard.acceptDue')}: {formatDateTime(job.acceptDueAt)}</span>
              <span>{t('inspection.dashboard.reportDue')}: {formatDateTime(job.reportDueAt)}</span>
              <Badge>{t(`inspection.dashboard.${job.slaState}`)}</Badge>
              <span>{t('inspection.inspector')}: {d.inspectors.find((member) => member.id === job.inspectorMemberId)?.fullName ?? '—'}</span>
              <Link to={`/inspection/jobs/${job.id}`} className="text-brand hover:underline">{t('inspection.report')}</Link>
            </div>
          ))}
        </Card>
      )}
      {d.inspectors.length > 0 && <Card title={t('inspection.dashboard.inspectors')} bodyClassName="divide-y divide-border-subtle">
        {d.inspectors.map((member) => <div key={member.id} className="flex flex-wrap gap-3 px-5 py-3 text-sm"><span>{member.fullName}</span><Badge>{member.role}</Badge><Badge>{member.status}</Badge><span>{t('inspection.dashboard.identity')}: {formatDateTime(member.identityVerifiedAt)}</span><span>{t('inspection.dashboard.expires')}: {formatDateTime(member.credentialExpiresAt)}</span></div>)}
      </Card>}
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
  const can = (status: string): boolean => d.me.allowedTransitions.includes(status);
  const busy = run.isPending;
  const inProgress = d.job.status === 'IN_PROGRESS' && d.me.isNamedInspector;

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
