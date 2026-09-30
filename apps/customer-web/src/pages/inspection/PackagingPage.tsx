import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, EmptyState, ErrorState, Input, LoadingState, PageHeader, Select, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { useStorefront } from '@/app/storefront-context';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { agencyAction, fetchAgencyJob, inspectionKeys, uploadAgencyEvidence } from '@/lib/inspection';
import { errorMessage } from '@/lib/errors';
import { useToast } from '@/components/toast-context';

interface CheckItem { code: string; section: string; label: string; requirement?: string | null; tolerance?: string | null }
type Outcome = 'CONFORM' | 'NONCONFORM' | 'NOT_APPLICABLE';
interface CheckResult { itemCode: string; outcome: Outcome; measuredValue: string | null; note: string | null; recordedAt: string }
interface PackagingDetail {
  job: { jobNumber: string; status: string; checks: CheckResult[]; evidence: { id: string; checkItemCode: string | null; fileName: string; purpose: string }[] };
  checklist: CheckItem[];
  me: { isNamedInspector: boolean };
}

function PackagingCheck({ id, item, result, evidence, editable }: {
  id: string; item: CheckItem; result: CheckResult | undefined; evidence: PackagingDetail['job']['evidence']; editable: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const cache = useQueryClient();
  const [outcome, setOutcome] = useState(result?.outcome ?? '');
  const [measuredValue, setMeasuredValue] = useState(result?.measuredValue ?? '');
  const [note, setNote] = useState(result?.note ?? '');
  const refresh = async (): Promise<void> => { await cache.invalidateQueries({ queryKey: inspectionKeys.agencyJob(id) }); };
  const save = useMutation({
    mutationFn: () => agencyAction(id, 'checks', { itemCode: item.code, outcome, measuredValue: measuredValue.trim() || null, note: note.trim() || null }),
    onSuccess: async () => { toast.success(t('inspection.saved')); await refresh(); },
  });
  const upload = useMutation({
    mutationFn: (file: File) => uploadAgencyEvidence(id, file, { purpose: 'PACKAGING', checkItemCode: item.code, note: note.trim() }),
    onSuccess: async () => { toast.success(t('inspection.saved')); await refresh(); },
  });
  const busy = save.isPending || upload.isPending;
  return <Card title={item.label} bodyClassName="space-y-3 px-5 py-4 text-sm">
    <p>{item.code} · <Badge>{result === undefined ? t('inspection.packaging.unanswered') : t(`inspection.packaging.${result.outcome}`)}</Badge></p>
    {item.requirement && <p>{item.requirement}</p>}
    {item.tolerance && <p>{item.tolerance}</p>}
    {editable ? <>
      <label className="block"><span>{t('inspection.packaging.outcome')}</span><Select aria-label={t('inspection.packaging.outcome')} value={outcome} disabled={busy} onChange={(e) => { setOutcome(e.target.value); }}>
        <option value="">{t('inspection.packaging.choose')}</option>
        {(['CONFORM', 'NONCONFORM', 'NOT_APPLICABLE'] as const).map((value) => <option key={value} value={value}>{t(`inspection.packaging.${value}`)}</option>)}
      </Select></label>
      <label className="block"><span>{t('inspection.packaging.measured')}</span><Input value={measuredValue} maxLength={128} disabled={busy} onChange={(e) => { setMeasuredValue(e.target.value); }} /></label>
      <label className="block"><span>{t('inspection.packaging.note')}</span><Textarea value={note} maxLength={1000} disabled={busy} onChange={(e) => { setNote(e.target.value); }} /></label>
      <Button variant="primary" disabled={busy || outcome === '' || (outcome === 'NONCONFORM' && note.trim() === '')} onClick={() => { save.mutate(); }}>{t('inspection.packaging.save')}</Button>
      <label className="block"><span>{t('inspection.addEvidence')}</span><input type="file" className="mt-1 block w-full" disabled={busy} onChange={(e) => {
        const file = e.target.files?.[0];
        if (file !== undefined) upload.mutate(file);
        e.target.value = '';
      }} /></label>
    </> : <><p>{result?.measuredValue}</p><p>{result?.note}</p></>}
    {save.isError && <p role="alert" className="text-danger">{errorMessage(t, save.error)}</p>}
    {upload.isError && <p role="alert" className="text-danger">{errorMessage(t, upload.error)}</p>}
    {evidence.length > 0 && <ul aria-label={t('inspection.addEvidence')}>{evidence.map((file) => <li key={file.id}>{file.fileName}</li>)}</ul>}
  </Card>;
}

export function PackagingPage(): React.JSX.Element {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const { business } = useStorefront();
  useDocumentMeta({ title: t('inspection.packaging.title'), noIndex: true }, business.displayName);
  const query = useQuery({ queryKey: inspectionKeys.agencyJob(id), queryFn: async () => (await fetchAgencyJob(id)) as unknown as PackagingDetail });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;
  const d = query.data;
  const items = d.checklist.filter((item) => item.section === 'PACKAGING' || item.section === 'LABELLING');
  const editable = d.job.status === 'IN_PROGRESS' && d.me.isNamedInspector;
  return <div className="mx-auto max-w-5xl space-y-4 px-4 py-8">
    <PageHeader title={t('inspection.packaging.title')} description={d.job.jobNumber} actions={<Link to={`/inspection/jobs/${id}`} className="text-sm font-medium text-brand hover:underline">{t('inspection.packaging.back')}</Link>} />
    {!editable && <p>{t('inspection.packaging.readOnly')}</p>}
    {items.length === 0 && <EmptyState title={t('inspection.packaging.empty')} />}
    {items.map((item) => {
      const result = d.job.checks.find((check) => check.itemCode === item.code);
      return <PackagingCheck key={`${item.code}:${result?.recordedAt ?? ''}`} id={id} item={item} result={result} evidence={d.job.evidence.filter((file) => file.checkItemCode === item.code && file.purpose === 'PACKAGING')} editable={editable} />;
    })}
  </div>;
}
