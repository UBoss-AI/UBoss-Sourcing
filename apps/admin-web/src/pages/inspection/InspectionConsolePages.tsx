/**
 * The inspection console (checklist Master rows 55, 70, 94).
 *
 *   /inspection                  every requirement, by status
 *   /inspection/:id              one requirement: jobs, report, NCRs, release; book an
 *                                inspection, reevaluate, ask for / approve a conditional release
 *   /inspection-setup            agencies and members, rules, plans and the policy
 *
 * Every rule is the server's; the rules and plans editors send JSON that the
 * server validates with the same schema it uses everywhere else.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, EmptyState, ErrorState, Input, LoadingState, PageHeader, Select, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';

interface QueueRow { id: string; orderNumber?: string; sellerName?: string; level: string; status: string; evaluatedAt?: string | null }
interface Detail {
  requirement: { id: string; orderNumber: string; sellerName: string; sellerOrderGroupId: string; level: string; status: string; reason: string | null; ruleName: string | null; gate: { sentence: string } };
  jobs: { id: string; jobNumber: string; status: string; agency: { name?: string } | null; scheduledFor: string | null; report: { result: string | null; status: string } | null }[];
  releases: { id: string; kind: string; state: string; reason?: string | null }[];
  timeline: { id: string; summary: string; actorLabel: string | null; createdAt: string | null }[];
}

function useRun(invalidate: readonly unknown[]): ReturnType<typeof useMutation<unknown, unknown, { method: 'post' | 'put'; path: string; body?: unknown }>> {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (step: { method: 'post' | 'put'; path: string; body?: unknown }) => api[step.method](`/admin/inspection/${step.path}`, step.body),
    onSuccess: async () => {
      toast.success(t('inspection.saved'));
      await queryClient.invalidateQueries({ queryKey: invalidate });
    },
    onError: (failure) => { toast.error(errorMessage(t, failure)); },
  });
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
      <Input className="mb-4 max-w-xs" aria-label={t('inspection.statusFilter')} placeholder={t('inspection.statusFilter')} value={status} onChange={(event) => { setStatus(event.target.value.toUpperCase()); }} />
      {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} /> : rows.length === 0 ? <EmptyState title={t('inspection.queueEmpty')} /> : (
        <Card bodyClassName="divide-y divide-border-subtle">
          {rows.map((row) => (
            <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
              <Link to={`/inspection/${row.id}`} className="font-medium text-brand hover:underline">{row.orderNumber ?? row.id}</Link>
              <span className="text-xs text-ink-muted">{row.sellerName}</span>
              <span className="flex gap-2"><Badge>{row.level}</Badge><Badge>{row.status}</Badge></span>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}

export function InspectionRequirementPage(): React.JSX.Element {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const key = ['admin', 'inspection', 'requirement', id];
  const query = useQuery({ queryKey: key, queryFn: () => api.get<{ inspection: Detail }>(`/admin/inspection/requirements/${id}`) });
  const agencies = useQuery({ queryKey: ['admin', 'inspection', 'agencies'], queryFn: () => api.get<{ agencies: { id: string; name: string }[] }>('/admin/inspection/agencies') });
  const run = useRun(key);
  const [reason, setReason] = useState('');
  const [booking, setBooking] = useState({ agencyId: '', scheduledFor: '', label: '', addressLine: '', city: '', country: '', payer: 'BUYER', pointType: 'SELLER_PREMISES' });

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;
  const d = query.data.inspection;
  const busy = run.isPending;
  const set = (field: keyof typeof booking) => (event: { target: { value: string } }): void => { setBooking({ ...booking, [field]: event.target.value }); };

  return (
    <>
      <PageHeader
        title={d.requirement.orderNumber}
        description={`${d.requirement.sellerName} · ${d.requirement.level} · ${d.requirement.status}`}
        back={{ to: '/inspection', label: t('inspection.queueTitle') }}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('inspection.requirementTitle')} bodyClassName="space-y-2 px-5 py-4 text-sm">
          <p>{d.requirement.gate.sentence}</p>
          {d.requirement.ruleName !== null && <p className="text-ink-muted">{t('inspection.rule')}: {d.requirement.ruleName} · {d.requirement.reason}</p>}
          {d.jobs.map((job) => (
            <p key={job.id}><Badge>{job.status}</Badge> {job.jobNumber} · {job.agency?.name} · {formatDateTime(job.scheduledFor)} {job.report !== null && `· ${job.report.result ?? job.report.status}`}</p>
          ))}
          {d.releases.map((release) => (
            <div key={release.id} className="flex flex-wrap items-center gap-2">
              <span>{release.kind} · {release.state}</span>
              {release.state === 'REQUESTED' && (
                <>
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => { run.mutate({ method: 'post', path: `releases/${release.id}/approve` }); }}>{t('inspection.approveRelease')}</Button>
                  <Button size="sm" variant="secondary" disabled={busy || reason.trim().length < 10} onClick={() => { run.mutate({ method: 'post', path: `releases/${release.id}/reject`, body: { reason: reason.trim() } }); }}>{t('inspection.rejectRelease')}</Button>
                </>
              )}
            </div>
          ))}
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => { run.mutate({ method: 'post', path: `requirements/${id}/reevaluate` }); }}>{t('inspection.reevaluate')}</Button>
        </Card>

        <Card title={t('inspection.bookTitle')} bodyClassName="space-y-2 px-5 py-4 text-sm">
          <Select aria-label={t('inspection.agency')} value={booking.agencyId} onChange={set('agencyId')}>
            <option value="">{t('inspection.anyEligibleAgency')}</option>
            {(agencies.data?.agencies ?? []).map((agency) => <option key={agency.id} value={agency.id}>{agency.name}</option>)}
          </Select>
          <Input type="datetime-local" aria-label={t('inspection.scheduledFor')} value={booking.scheduledFor} onChange={set('scheduledFor')} />
          <Select aria-label={t('inspection.pointType')} value={booking.pointType} onChange={set('pointType')}>
            {['SELLER_PREMISES', 'WAREHOUSE', 'PORT', 'OTHER'].map((value) => <option key={value}>{value}</option>)}
          </Select>
          {(['label', 'addressLine', 'city', 'country'] as const).map((field) => (
            <Input key={field} aria-label={t(`inspection.point.${field}`)} placeholder={t(`inspection.point.${field}`)} value={booking[field]} onChange={set(field)} />
          ))}
          <Select aria-label={t('inspection.payer')} value={booking.payer} onChange={set('payer')}>
            {['BUYER', 'SELLER', 'PLATFORM'].map((value) => <option key={value}>{value}</option>)}
          </Select>
          <Button variant="primary" disabled={busy || booking.scheduledFor === '' || booking.city === '' || booking.country.length !== 2} onClick={() => {
            run.mutate({ method: 'post', path: 'jobs', body: {
              sellerOrderGroupId: d.requirement.sellerOrderGroupId, agencyId: booking.agencyId === '' ? null : booking.agencyId,
              scheduledFor: new Date(booking.scheduledFor).toISOString(), inspectionPointType: booking.pointType,
              inspectionPoint: { label: booking.label || booking.city, addressLine: booking.addressLine || booking.city, city: booking.city, country: booking.country.toUpperCase() },
              payer: booking.payer,
            } });
          }}>{t('inspection.book')}</Button>
          <Textarea aria-label={t('inspection.overrideReason')} placeholder={t('inspection.overrideReason')} rows={3} value={reason} onChange={(event) => { setReason(event.target.value); }} />
          <Button variant="secondary" disabled={busy || reason.trim().length < 10} onClick={() => { run.mutate({ method: 'post', path: `requirements/${id}/conditional-release`, body: { reason: reason.trim(), evidenceIds: [] } }); }}>{t('inspection.requestConditional')}</Button>
        </Card>
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

export function InspectionSetupPage(): React.JSX.Element {
  const { t } = useI18n();
  const key = ['admin', 'inspection', 'agencies'];
  const agencies = useQuery({ queryKey: key, queryFn: () => api.get<{ agencies: { id: string; name: string; country: string; status: string }[] }>('/admin/inspection/agencies') });
  const run = useRun(key);
  const [agency, setAgency] = useState({ name: '', legalName: '', country: '', contactEmail: '' });
  const [member, setMember] = useState({ agencyId: '', email: '', fullName: '', role: 'INSPECTOR' });
  return (
    <>
      <PageHeader title={t('inspection.setupTitle')} back={{ to: '/inspection', label: t('inspection.queueTitle') }} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('inspection.agencies')} bodyClassName="space-y-2 px-5 py-4 text-sm">
          <ul>{(agencies.data?.agencies ?? []).map((row) => <li key={row.id}>{row.name} · {row.country} · <Badge>{row.status}</Badge></li>)}</ul>
          {(['name', 'legalName', 'country', 'contactEmail'] as const).map((field) => (
            <Input key={field} aria-label={t(`inspection.agencyField.${field}`)} placeholder={t(`inspection.agencyField.${field}`)} value={agency[field]} onChange={(event) => { setAgency({ ...agency, [field]: event.target.value }); }} />
          ))}
          <Button size="sm" variant="primary" disabled={run.isPending || agency.name === '' || agency.country.length !== 2} onClick={() => { run.mutate({ method: 'post', path: 'agencies', body: { ...agency, country: agency.country.toUpperCase() } }); }}>{t('inspection.addAgency')}</Button>
          <Select aria-label={t('inspection.agency')} value={member.agencyId} onChange={(event) => { setMember({ ...member, agencyId: event.target.value }); }}>
            <option value="">{t('inspection.agency')}</option>
            {(agencies.data?.agencies ?? []).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
          </Select>
          <Input aria-label={t('inspection.memberEmail')} placeholder={t('inspection.memberEmail')} value={member.email} onChange={(event) => { setMember({ ...member, email: event.target.value }); }} />
          <Input aria-label={t('inspection.memberName')} placeholder={t('inspection.memberName')} value={member.fullName} onChange={(event) => { setMember({ ...member, fullName: event.target.value }); }} />
          <Select aria-label={t('inspection.memberRole')} value={member.role} onChange={(event) => { setMember({ ...member, role: event.target.value }); }}>
            {['AGENCY_ADMIN', 'COORDINATOR', 'INSPECTOR', 'QA_REVIEWER'].map((value) => <option key={value}>{value}</option>)}
          </Select>
          <Button size="sm" variant="secondary" disabled={run.isPending || member.agencyId === '' || member.email === ''} onClick={() => { run.mutate({ method: 'post', path: `agencies/${member.agencyId}/members`, body: { email: member.email, fullName: member.fullName, role: member.role } }); }}>{t('inspection.addMember')}</Button>
        </Card>
        <JsonEditor title={t('inspection.rules')} path="rules" listKey="rules" method="post" />
        <JsonEditor title={t('inspection.plans')} path="plans" listKey="plans" method="post" />
        <JsonEditor title={t('inspection.policy')} path="policy" listKey="policy" method="put" />
      </div>
    </>
  );
}
