/**
 * One inspection, for the buyer or the seller (checklist Master rows 23, 95).
 *
 * The timeline (booked, inspector assigned, started, report, NCR, release),
 * the report and its result, NCRs, and whether the goods may ship. Everything
 * shown is the server's view for this audience; the seller additionally gets
 * the readiness and CAPA forms the server accepts from them.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, Input, Select, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { submitCapa, submitReadiness, uploadCorrectiveEvidence, type InspectionDefect, type InspectionJobView, type InspectionView } from '@/lib/inspection';

function ReadinessForm({ job, onDone }: { job: InspectionJobView; onDone: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const [form, setForm] = useState({ lotReference: '', readyDate: '', locationLabel: '', contactName: '', contactPhone: '', packedStatus: 'PACKED', declaration: false });
  const send = useMutation({
    mutationFn: () => submitReadiness(job.id, { ...form, readyDate: form.readyDate === '' ? null : form.readyDate, declaration: true }),
    onSuccess: () => { toast.success(t('inspection.readinessSent')); onDone(); },
    onError: (failure) => { toast.error(errorMessage(t, failure)); },
  });
  const field = (key: 'lotReference' | 'locationLabel' | 'contactName' | 'contactPhone', label: string): React.JSX.Element => (
    <Input aria-label={label} placeholder={label} value={form[key]} onChange={(event) => { setForm({ ...form, [key]: event.target.value }); }} />
  );
  const ready = form.declaration && form.lotReference !== '' && form.locationLabel !== '' && form.contactName !== '' && form.contactPhone !== '';
  return (
    <div className="mt-3 space-y-2 rounded-md border border-border-subtle p-3">
      <p className="text-sm font-medium">{t('inspection.readinessTitle')}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {field('lotReference', t('inspection.lotReference'))}
        {field('locationLabel', t('inspection.location'))}
        {field('contactName', t('inspection.contactName'))}
        {field('contactPhone', t('inspection.contactPhone'))}
        <Input type="date" aria-label={t('inspection.readyDate')} value={form.readyDate} onChange={(event) => { setForm({ ...form, readyDate: event.target.value }); }} />
        <Select aria-label={t('inspection.packedStatus')} value={form.packedStatus} onChange={(event) => { setForm({ ...form, packedStatus: event.target.value }); }}>
          {['NOT_PACKED', 'PARTIALLY_PACKED', 'PACKED', 'SEALED'].map((value) => <option key={value} value={value}>{value}</option>)}
        </Select>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={form.declaration} onChange={(event) => { setForm({ ...form, declaration: event.target.checked }); }} />
        {t('inspection.readinessDeclaration')}
      </label>
      <Button variant="primary" size="sm" disabled={!ready || send.isPending} onClick={() => { send.mutate(); }}>{t('inspection.sendReadiness')}</Button>
    </div>
  );
}

function CapaForm({ job, defect, onDone }: { job: InspectionJobView; defect: InspectionDefect; onDone: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const [response, setResponse] = useState('');
  const [action, setAction] = useState('');
  const evidence = (job.evidence ?? []).filter((file) => file.purpose === 'CAPA' && file.defectId === defect.id);
  const [uploaded, setUploaded] = useState(false);
  const upload = useMutation({
    mutationFn: (file: File) => uploadCorrectiveEvidence(job.id, defect.id, file),
    onSuccess: () => { setUploaded(true); toast.success(t('inspection.saved')); onDone(); },
    onError: (failure) => { toast.error(errorMessage(t, failure)); },
  });
  const send = useMutation({
    mutationFn: () => submitCapa(defect.id, { sellerResponse: response.trim(), correctiveAction: action.trim() }),
    onSuccess: () => { toast.success(t('inspection.capaSent')); onDone(); },
    onError: (failure) => { toast.error(errorMessage(t, failure)); },
  });
  return (
    <div className="mt-2 space-y-2">
      <label className="block"><span>{t('inspection.reinspection.evidence')}</span><input type="file" className="mt-1 block w-full" disabled={upload.isPending || send.isPending} onChange={(event) => {
        const file = event.target.files?.[0];
        if (file !== undefined) upload.mutate(file);
        event.target.value = '';
      }} /></label>
      {evidence.map((file) => <p key={file.id}>{file.fileName}</p>)}
      {!uploaded && evidence.length === 0 && <p className="text-ink-muted">{t('inspection.reinspection.attachFirst')}</p>}
      <Textarea aria-label={t('inspection.capaResponse')} placeholder={t('inspection.capaResponse')} rows={2} value={response} onChange={(event) => { setResponse(event.target.value); }} />
      <Textarea aria-label={t('inspection.capaAction')} placeholder={t('inspection.capaAction')} rows={2} value={action} onChange={(event) => { setAction(event.target.value); }} />
      <Button size="sm" variant="secondary" disabled={response.trim() === '' || action.trim().length < 10 || (!uploaded && evidence.length === 0) || send.isPending || upload.isPending} onClick={() => { send.mutate(); }}>{t('inspection.sendCapa')}</Button>
    </div>
  );
}

export function InspectionPanel({ view, audience, queryKey }: { view: InspectionView; audience: 'BUYER' | 'SELLER'; queryKey: readonly unknown[] }): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const refresh = (): void => { void queryClient.invalidateQueries({ queryKey }); };
  const { requirement } = view;

  return (
    <Card title={t('inspection.title')} bodyClassName="space-y-4 px-5 py-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{requirement.level}</Badge>
        <Badge tone={requirement.gate.allowed === true ? 'success' : 'action'}>{requirement.status}</Badge>
        <span className="text-ink-muted">{requirement.gate.sentence}</span>
      </div>
      {view.jobs.map((job) => (
        <section key={job.id} aria-label={job.jobNumber} className="rounded-md border border-border-subtle p-3">
          <p className="font-medium">
            {job.jobNumber} · {job.kind} · <Badge>{job.status}</Badge>
          </p>
          {job.reinspectionOfJobId != null && <p>{t('inspection.reinspection.original')}: {view.jobs.find((original) => original.id === job.reinspectionOfJobId)?.jobNumber ?? job.reinspectionOfJobId}</p>}
          <p className="text-xs text-ink-muted">
            {[job.agency?.name, job.inspector?.fullName, formatDateTime(job.scheduledFor), job.inspectionPoint?.label, job.payer].filter(Boolean).join(' · ')}
          </p>
          {job.report !== null && (
            <p className="mt-2">
              {t('inspection.report')}: <strong>{job.report.result ?? job.report.status}</strong>
              {job.report.signedAt !== null && ` · ${t('inspection.signedBy', { name: job.report.signedByName ?? '—' })} ${formatDateTime(job.report.signedAt)}`}
              {job.report.summary !== null && <span className="block text-ink-muted">{job.report.summary}</span>}
            </p>
          )}
          {job.samplingRecord != null && (
            <p className="mt-1 text-xs text-ink-muted">
              {t('inspection.samplingLine', {
                lot: job.samplingRecord.lotReference ?? '—',
                sampled: String(job.samplingRecord.sampledQuantity ?? 0),
                accepted: String(job.samplingRecord.acceptedQuantity ?? 0),
                rejected: String(job.samplingRecord.rejectedQuantity ?? 0),
              })}
            </p>
          )}
          {(job.defects ?? []).length > 0 && (
            <ul className="mt-2 space-y-2">
              {(job.defects ?? []).map((defect) => (
                <li key={defect.id} className="rounded bg-surface-sunken px-2 py-1.5">
                  <Badge tone={defect.severity === 'MINOR' ? 'neutral' : 'action'}>{defect.severity}</Badge> {defect.ncrNumber} — {defect.description} ({defect.status})
                  {defect.correctiveAction && <p>{defect.correctiveAction}</p>}
                  {audience === 'SELLER' && defect.correctiveAction != null && (job.evidence ?? []).filter((file) => file.purpose === 'CAPA' && file.defectId === defect.id).map((file) => <p key={file.id}>{file.fileName}</p>)}
                  {audience === 'SELLER' && job.status === 'COMPLETED' && defect.status !== 'VERIFIED_CLOSED' && defect.correctiveAction == null && <CapaForm job={job} defect={defect} onDone={refresh} />}
                </li>
              ))}
            </ul>
          )}
          {audience === 'SELLER' && job.readinessSubmittedAt === null && ['REQUESTED', 'ACCEPTED', 'INSPECTOR_ASSIGNED'].includes(job.status) && (
            <ReadinessForm job={job} onDone={refresh} />
          )}
        </section>
      ))}
      {view.releases.length > 0 && (
        <p>
          {t('inspection.releases')}: {view.releases.map((release) => `${release.kind} (${release.state})`).join(', ')}
        </p>
      )}
      <div>
        <p className="font-medium">{t('inspection.timeline')}</p>
        <ol className="mt-1 space-y-1">
          {view.timeline.map((event) => (
            <li key={event.id} className="flex flex-wrap justify-between gap-2 text-xs">
              <span>{event.summary}{event.actorLabel !== null && <span className="text-ink-muted"> — {event.actorLabel}</span>}</span>
              <span className="text-ink-muted">{formatDateTime(event.createdAt)}</span>
            </li>
          ))}
        </ol>
      </div>
    </Card>
  );
}
