/**
 * One seller assessment: the eight gates, the evidence beside the checklist,
 * the score with its hard stops, the product x site x country x channel scope
 * matrix, CAPA, workpapers, the independent certification, release and the
 * full decision timeline.
 *
 * Every button is a courtesy: the server checks the capability, the gate's
 * prerequisites, independence and every precondition, and says why it refused.
 */
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DownloadButton, FilePreview, MutationError, QueryBoundary, Tabs } from '@/components/console';
import { Badge, Button, Callout, Card, DescriptionList, Field, Input, PageHeader, Select, Textarea } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { formatBytes, formatDate, formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import {
  EVIDENCE_CATEGORIES,
  GATE_TONE,
  HARD_STOPS,
  WORKPAPER_KINDS,
  approvalPdfPath,
  assessmentKeys,
  evidencePath,
  fetchAssessment,
  fetchGaps,
  post,
  put,
  uploadEvidence,
  type AssessmentDetail,
  type ChecklistItem,
  type Finding,
  type ScopeItem,
  type WorkpaperKind,
} from '@/lib/seller-assessment';
import { useConsoleMutation } from '@/lib/use-console-mutation';

type Tab = 'overview' | 'checklist' | 'score' | 'scope' | 'findings' | 'workpapers' | 'certification' | 'release' | 'timeline';
const TABS: Tab[] = ['overview', 'checklist', 'score', 'scope', 'findings', 'workpapers', 'certification', 'release', 'timeline'];

const tk = (key: string) => key as TranslationKey;

function useWrite(id: string) {
  return { invalidate: [assessmentKeys.one(id), assessmentKeys.gaps(id), assessmentKeys.all] as const };
}

export function SellerAssessmentDetailPage(): React.JSX.Element {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const query = useQuery({ queryKey: assessmentKeys.one(id), queryFn: () => fetchAssessment(id) });
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <QueryBoundary query={query}>
      {({ assessment: a }) => (
        <>
          <PageHeader
            title={`${a.number} · ${a.seller.displayName}`}
            description={t('sa.detail.description', { kind: t(tk(`sa.kind.${a.kind}`)), policy: a.policyVersion })}
            back={{ to: '/seller-assessments', label: t('sa.title') }}
            meta={<Badge tone={a.status === 'RELEASED' ? 'success' : a.status === 'DECLINED' ? 'danger' : 'action'}>{t(tk(`sa.status.${a.status}`))}</Badge>}
          />
          <Banners a={a} />
          <GateProgress a={a} />
          <Tabs label={t('sa.detail.sections')} tabs={TABS.map((key) => ({ key, label: t(tk(`sa.tab.${key}`)) }))} selected={tab} onSelect={setTab}>
            {tab === 'overview' && <Overview a={a} />}
            {tab === 'checklist' && <ChecklistTab a={a} />}
            {tab === 'score' && <ScoreTab a={a} />}
            {tab === 'scope' && <ScopeTab a={a} />}
            {tab === 'findings' && <FindingsTab a={a} />}
            {tab === 'workpapers' && <WorkpapersTab a={a} />}
            {tab === 'certification' && <CertificationTab a={a} />}
            {tab === 'release' && <ReleaseTab a={a} />}
            {tab === 'timeline' && <TimelineTab a={a} />}
          </Tabs>
        </>
      )}
    </QueryBoundary>
  );
}

function Banners({ a }: { a: AssessmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="mb-4 space-y-3">
      {a.policyInForce.status === 'DRAFT' && <Callout tone="warning">{t('sa.detail.policyDraft', { version: a.policyInForce.version })}</Callout>}
      {a.legacyNote !== null && <Callout tone="info">{a.legacyNote}</Callout>}
      {a.hardStops.length > 0 && (
        <Callout tone="danger" title={t('sa.detail.hardStops')}>
          <ul className="list-disc pl-5">
            {a.hardStops.map((h) => (
              <li key={h.stop}>
                <strong>{t(tk(`sa.hardStop.${h.stop}`))}</strong> — {h.reason}
              </li>
            ))}
          </ul>
        </Callout>
      )}
      <p className="text-xs text-ink-muted">{t('sa.detail.softwareNotAssessment')}</p>
    </div>
  );
}

function GateProgress({ a }: { a: AssessmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <ol aria-label={t('sa.detail.gates')} className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
      {a.gates.map((g) => (
        <li key={g.gate} className="rounded-md border border-border-subtle bg-surface px-3 py-2">
          <p className="text-xs text-ink-muted">{t('sa.gate.number', { gate: String(g.gate) })}</p>
          <p className="text-sm font-medium">{t(tk(`sa.gate.name.${String(g.gate)}`))}</p>
          <Badge tone={GATE_TONE[g.status] ?? 'neutral'} dot>
            {t(tk(`sa.gateStatus.${g.status}`))}
          </Badge>
          {g.assignedTo !== null && <p className="mt-1 text-xs text-ink-muted">{t('sa.gate.assignedTo', { name: g.assignedTo })}</p>}
        </li>
      ))}
    </ol>
  );
}

// --- Overview: application, file decisions, assignment, gate decisions, evidence ---

function Overview({ a }: { a: AssessmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const write = can(Permission.ASSESSMENT_WORK);
  const app = a.application ?? {};
  const entity = (app['entity'] ?? {}) as Record<string, string | undefined>;
  const fin = (app['financial'] ?? {}) as Record<string, string | undefined>;
  return (
    <div className="space-y-4">
      <Card title={t('sa.overview.application')} bodyClassName="px-5 py-4">
        <DescriptionList
          items={[
            { label: t('sa.overview.legalName'), value: entity['legalName'] ?? a.seller.legalName },
            { label: t('sa.overview.applicantType'), value: typeof app['applicantType'] === 'string' ? t(tk(`sa.applicantType.${app['applicantType']}`)) : '—' },
            { label: t('sa.overview.turnover'), value: typeof fin['revenueMinor'] === 'string' ? `${fin['currency'] ?? ''} ${(BigInt(fin['revenueMinor']) / 100n).toLocaleString()}` : '—' },
            { label: t('sa.overview.financialYear'), value: `${fin['financialYearStart'] ?? '—'} – ${fin['financialYearEnd'] ?? '—'}` },
            { label: t('sa.overview.submitted'), value: formatDateTime(a.submittedAt) },
            { label: t('sa.overview.reviewTarget'), value: a.reviewTargetAt === null ? '—' : `${formatDate(a.reviewTargetAt)} · ${t('sa.overview.serviceTarget')}` },
            { label: t('sa.overview.owner'), value: a.owner ?? '—' },
            { label: t('sa.overview.risk'), value: t(tk(`sa.risk.${a.riskLevel}`)) },
          ]}
        />
        {a.applicationProblems.length > 0 && (
          <Callout tone="warning" title={t('sa.overview.gaps')} className="mt-3">
            <ul className="list-disc pl-5 text-sm">
              {a.applicationProblems.map((p) => (
                <li key={p}>{t(tk(`sa.problem.${p}`))}</li>
              ))}
            </ul>
          </Callout>
        )}
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-ink-muted">{t('sa.overview.rawApplication')}</summary>
          <pre className="mt-2 max-h-96 overflow-auto rounded bg-surface-subtle p-3 text-xs">{JSON.stringify(a.application, null, 2)}</pre>
        </details>
      </Card>
      {write && <FileDecision a={a} />}
      {write && <GateDecision a={a} />}
      {write && <Assign a={a} />}
      <EvidenceCard a={a} />
    </div>
  );
}

function FileDecision({ a }: { a: AssessmentDetail }): React.JSX.Element | null {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  const opts = useWrite(a.id);
  const accept = useConsoleMutation({ mutationFn: (_v, key) => post(`/${a.id}/accept-file`, { reason: note, expectedVersion: a.version }, key), ...opts, successMessage: t('sa.saved') });
  const correction = useConsoleMutation({ mutationFn: (_v, key) => post(`/${a.id}/correction`, { note, expectedVersion: a.version }, key), ...opts, successMessage: t('sa.saved') });
  if (a.status !== 'SUBMITTED' && a.status !== 'IN_REVIEW') return null;
  return (
    <Card title={t('sa.gate1.title')} description={t('sa.gate1.description')} bodyClassName="space-y-3 px-5 py-4">
      <Field label={t('sa.reason')} required>
        {({ inputId }) => <Textarea id={inputId} value={note} onChange={(e) => { setNote(e.target.value); }} />}
      </Field>
      <div className="flex flex-wrap gap-2">
        {a.status === 'SUBMITTED' && (
          <Button variant="primary" disabled={note.trim().length < 5 || accept.isPending} onClick={() => { accept.mutate(); }}>
            {t('sa.gate1.accept')}
          </Button>
        )}
        <Button variant="secondary" disabled={note.trim().length < 5 || correction.isPending} onClick={() => { correction.mutate(); }}>
          {t('sa.gate1.correction')}
        </Button>
      </div>
      <MutationError error={accept.error ?? correction.error} />
    </Card>
  );
}

function GateDecision({ a }: { a: AssessmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  const [gate, setGate] = useState('2');
  const [status, setStatus] = useState('PASSED');
  const [reason, setReason] = useState('');
  const decide = useConsoleMutation({ mutationFn: (_v, key) => post(`/${a.id}/gates/${gate}`, { status, reason }, key), ...useWrite(a.id), successMessage: t('sa.saved') });
  return (
    <Card title={t('sa.gateDecision.title')} description={t('sa.gateDecision.description')} bodyClassName="grid gap-3 px-5 py-4 sm:grid-cols-3">
      <Field label={t('sa.gateDecision.gate')}>
        {({ inputId }) => (
          <Select id={inputId} value={gate} onChange={(e) => { setGate(e.target.value); }}>
            {[2, 3, 4, 5, 6, 7].map((g) => (
              <option key={g} value={String(g)}>{`${String(g)} · ${t(tk(`sa.gate.name.${String(g)}`))}`}</option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('sa.gateDecision.status')}>
        {({ inputId }) => (
          <Select id={inputId} value={status} onChange={(e) => { setStatus(e.target.value); }}>
            {['PASSED', 'IN_PROGRESS', 'CORRECTION_REQUESTED', 'FAILED'].map((s) => (
              <option key={s} value={s}>{t(tk(`sa.gateStatus.${s}`))}</option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('sa.reason')} required>
        {({ inputId }) => <Input id={inputId} value={reason} onChange={(e) => { setReason(e.target.value); }} />}
      </Field>
      <div className="sm:col-span-3">
        <Button variant="primary" disabled={reason.trim().length < 5 || decide.isPending} onClick={() => { decide.mutate(); }}>
          {t('sa.gateDecision.record')}
        </Button>
        <MutationError error={decide.error} />
      </div>
    </Card>
  );
}

function Assign({ a }: { a: AssessmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  const [owner, setOwner] = useState(a.ownerUserId ?? '');
  const [risk, setRisk] = useState(a.riskLevel);
  const save = useConsoleMutation({ mutationFn: (_v, key) => post(`/${a.id}/assign`, { ownerUserId: owner.trim() === '' ? null : owner.trim(), riskLevel: risk }, key), ...useWrite(a.id), successMessage: t('sa.saved') });
  return (
    <Card title={t('sa.assign.title')} description={t('sa.assign.description')} bodyClassName="grid gap-3 px-5 py-4 sm:grid-cols-3">
      <Field label={t('sa.assign.owner')} hint={t('sa.assign.ownerHint')}>
        {({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} value={owner} onChange={(e) => { setOwner(e.target.value); }} />}
      </Field>
      <Field label={t('sa.overview.risk')}>
        {({ inputId }) => (
          <Select id={inputId} value={risk} onChange={(e) => { setRisk(e.target.value); }}>
            {['LOW', 'MEDIUM', 'HIGH'].map((r) => (
              <option key={r} value={r}>{t(tk(`sa.risk.${r}`))}</option>
            ))}
          </Select>
        )}
      </Field>
      <div className="flex items-end">
        <Button variant="secondary" disabled={save.isPending} onClick={() => { save.mutate(); }}>
          {t('sa.assign.save')}
        </Button>
      </div>
      <div className="sm:col-span-3">
        <MutationError error={save.error} />
      </div>
    </Card>
  );
}

function EvidenceCard({ a }: { a: AssessmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState('OTHER');
  const [evidenceKey, setKey] = useState('');
  const upload = useConsoleMutation({ mutationFn: (_v, key) => uploadEvidence(a.id, { file: file as File, category, evidenceKey, label: file?.name ?? evidenceKey }, key), ...useWrite(a.id), successMessage: t('sa.saved') });
  return (
    <Card title={t('sa.evidence.title')} description={t('sa.evidence.description')} bodyClassName="divide-y divide-border-subtle">
      {a.evidence.length === 0 && <p className="px-5 py-4 text-sm text-ink-muted">{t('sa.evidence.empty')}</p>}
      {a.evidence.map((e) => (
        <div key={e.id} className="flex flex-wrap items-center gap-3 px-5 py-2 text-sm">
          <span className="font-mono text-xs">{e.evidenceKey}</span>
          <span>v{String(e.version)}</span>
          <Badge tone="neutral">{t(tk(`sa.evidenceCategory.${e.category}`))}</Badge>
          <span className="text-ink-muted">{e.fileName ?? t('sa.evidence.withheld')} · {formatBytes(e.byteSize)} · {e.uploadedByRole === 'SELLER' ? t('sa.evidence.bySeller') : t('sa.evidence.byAudit')}</span>
          {e.legalHold && <Badge tone="warning">{t('sa.evidence.legalHold')}</Badge>}
          {e.downloadable && e.fileName !== null && <DownloadButton path={evidencePath(a.id, e.id)} fileName={e.fileName} />}
        </div>
      ))}
      {can(Permission.ASSESSMENT_WORK) && (
        <div className="grid gap-3 px-5 py-4 sm:grid-cols-4">
          <Field label={t('sa.evidence.file')}>
            {({ inputId }) => <input id={inputId} type="file" accept="application/pdf,image/*" onChange={(e) => { setFile(e.target.files?.[0] ?? null); }} />}
          </Field>
          <Field label={t('sa.evidence.category')}>
            {({ inputId }) => (
              <Select id={inputId} value={category} onChange={(e) => { setCategory(e.target.value); }}>
                {EVIDENCE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{t(tk(`sa.evidenceCategory.${c}`))}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('sa.evidence.key')} hint={t('sa.evidence.keyHint')}>
            {({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} value={evidenceKey} onChange={(e) => { setKey(e.target.value); }} />}
          </Field>
          <div className="flex items-end">
            <Button variant="secondary" disabled={file === null || evidenceKey.trim() === '' || upload.isPending} onClick={() => { upload.mutate(); }}>
              {t('sa.evidence.upload')}
            </Button>
          </div>
          <div className="sm:col-span-4">
            <MutationError error={upload.error} />
          </div>
        </div>
      )}
    </Card>
  );
}

// --- Checklist with the evidence preview beside it ----------------------------

function ChecklistTab({ a }: { a: AssessmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string>(a.checklist[0]?.code ?? 'C01');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const item = a.checklist.find((c) => c.code === selected);
  const preview = a.evidence.find((e) => e.id === previewId) ?? null;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card title={t('sa.checklist.title')} description={t('sa.checklist.description')} bodyClassName="max-h-[70vh] divide-y divide-border-subtle overflow-auto relative">
        {a.checklist.map((c) => (
          <button key={c.code} type="button" aria-pressed={c.code === selected} onClick={() => { setSelected(c.code); }} className={`flex w-full items-start gap-3 px-4 py-2 text-left text-sm hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 ${c.code === selected ? 'bg-surface-subtle' : ''}`}>
            <span className="font-mono text-xs">{c.code}</span>
            <span className="flex-1">{c.text}</span>
            <Badge tone={c.outcome === 'PASS' ? 'success' : c.outcome === 'FAIL' ? 'danger' : c.outcome === 'NOT_APPLICABLE' ? (c.naApprovedBy === null ? 'warning' : 'neutral') : 'neutral'}>{t(tk(`sa.outcome.${c.outcome}`))}</Badge>
          </button>
        ))}
      </Card>
      <div className="space-y-4">
        {item !== undefined && <ChecklistReview a={a} item={item} />}
        <Card title={t('sa.checklist.preview')} bodyClassName="px-5 py-4 space-y-3">
          <Select aria-label={t('sa.checklist.preview')} value={previewId ?? ''} onChange={(e) => { setPreviewId(e.target.value === '' ? null : e.target.value); }}>
            <option value="">{t('sa.checklist.choosePreview')}</option>
            {a.evidence.filter((e) => e.downloadable && e.fileName !== null).map((e) => (
              <option key={e.id} value={e.id}>{`${e.evidenceKey} v${String(e.version)} · ${e.fileName ?? ''}`}</option>
            ))}
          </Select>
          {preview !== null && preview.fileName !== null && <FilePreview path={evidencePath(a.id, preview.id)} name={preview.fileName} />}
        </Card>
      </div>
    </div>
  );
}

function ChecklistReview({ a, item }: { a: AssessmentDetail; item: ChecklistItem }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [outcome, setOutcome] = useState(item.outcome === 'UNREVIEWED' ? 'PASS' : item.outcome);
  const [evidenceRef, setEvidenceRef] = useState(item.evidenceRef ?? '');
  const [expiresOn, setExpiresOn] = useState(item.expiresOn ?? '');
  const [comment, setComment] = useState(item.comment ?? '');
  const [naReason, setNaReason] = useState(item.naReason ?? '');
  const opts = useWrite(a.id);
  const save = useConsoleMutation({ mutationFn: (_v, key) => put(`/${a.id}/checklist/${item.code}`, { outcome, evidenceRef, comment: comment.trim() === '' ? null : comment, expiresOn: expiresOn === '' ? null : expiresOn, naReason: outcome === 'NOT_APPLICABLE' ? naReason : null }, key), ...opts, successMessage: t('sa.saved') });
  const approveNa = useConsoleMutation({ mutationFn: (_v, key) => post(`/${a.id}/checklist/${item.code}/approve-na`, { note: comment.trim() === '' ? 'N/A reviewed and approved.' : comment }, key), ...opts, successMessage: t('sa.saved') });
  return (
    <Card key={item.code} title={`${item.code} · ${t('sa.gate.number', { gate: String(item.gate ?? '') })}`} description={item.text} bodyClassName="space-y-3 px-5 py-4">
      <DescriptionList
        columns={2}
        items={[
          { label: t('sa.checklist.reviewer'), value: item.reviewer ?? '—' },
          { label: t('sa.checklist.reviewedAt'), value: formatDateTime(item.reviewedAt) },
          { label: t('sa.checklist.expiry'), value: item.expiresOn ?? '—' },
          { label: t('sa.checklist.naApproval'), value: item.outcome === 'NOT_APPLICABLE' ? (item.naApprovedBy ?? t('sa.checklist.naPending')) : '—' },
        ]}
      />
      {!item.naAllowed && <p className="text-xs text-ink-muted">{t('sa.checklist.mandatory')}</p>}
      {can(Permission.ASSESSMENT_WORK) && item.code !== 'C23' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('sa.checklist.outcome')}>
            {({ inputId }) => (
              <Select id={inputId} value={outcome} onChange={(e) => { setOutcome(e.target.value); }}>
                {['PASS', 'FAIL', ...(item.naAllowed ? ['NOT_APPLICABLE'] : [])].map((o) => (
                  <option key={o} value={o}>{t(tk(`sa.outcome.${o}`))}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('sa.checklist.evidenceRef')} required>
            {({ inputId }) => <Input id={inputId} value={evidenceRef} onChange={(e) => { setEvidenceRef(e.target.value); }} />}
          </Field>
          <Field label={t('sa.checklist.expiry')}>
            {({ inputId }) => <Input id={inputId} type="date" value={expiresOn} onChange={(e) => { setExpiresOn(e.target.value); }} />}
          </Field>
          {outcome === 'NOT_APPLICABLE' && (
            <Field label={t('sa.checklist.naReason')} required>
              {({ inputId }) => <Input id={inputId} value={naReason} onChange={(e) => { setNaReason(e.target.value); }} />}
            </Field>
          )}
          <div className="sm:col-span-2">
            <Field label={t('sa.checklist.comment')}>
              {({ inputId }) => <Textarea id={inputId} value={comment} onChange={(e) => { setComment(e.target.value); }} />}
            </Field>
          </div>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button variant="primary" disabled={evidenceRef.trim() === '' || save.isPending} onClick={() => { save.mutate(); }}>
              {t('sa.checklist.record')}
            </Button>
            {item.outcome === 'NOT_APPLICABLE' && item.naApprovedBy === null && (
              <Button variant="secondary" disabled={approveNa.isPending} onClick={() => { approveNa.mutate(); }}>
                {t('sa.checklist.approveNa')}
              </Button>
            )}
          </div>
          <div className="sm:col-span-2">
            <MutationError error={save.error ?? approveNa.error} />
          </div>
        </div>
      )}
    </Card>
  );
}

// --- Score ---------------------------------------------------------------------

function ScoreTab({ a }: { a: AssessmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  if (a.score === null) return <p>{t('sa.score.none')}</p>;
  return (
    <div className="space-y-4">
      <Card title={t('sa.score.total', { score: a.score.display })} description={t('sa.score.thresholds', { release: String(a.score.thresholds.release), remediation: String(a.score.thresholds.remediation), dimension: String(a.score.thresholds.dimension) })} bodyClassName="px-5 py-4">
        <Badge tone={a.score.band === 'RELEASE_ELIGIBLE' ? 'success' : a.score.band === 'DECLINED' ? 'danger' : 'warning'}>{t(tk(`sa.band.${a.score.band}`))}</Badge>
        {a.hardStops.length > 0 && <p className="mt-2 text-sm text-danger">{t('sa.score.hardStopsOverride')}</p>}
        <p className="mt-2 text-xs text-ink-muted">{t('sa.score.notCertification')}</p>
      </Card>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <caption className="sr-only">{t('sa.score.caption')}</caption>
          <thead>
            <tr className="text-left text-xs text-ink-muted">
              <th className="px-3 py-2">{t('sa.score.dimension')}</th>
              <th className="px-3 py-2">{t('sa.score.weight')}</th>
              <th className="px-3 py-2">{t('sa.score.rating')}</th>
              <th className="px-3 py-2">{t('sa.score.contribution')}</th>
              <th className="px-3 py-2">{t('sa.score.evidenceAndReasoning')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {a.score.dimensions.map((d) => (
              <ScoreRow key={d.code} a={a} d={d} editable={can(Permission.ASSESSMENT_WORK)} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ScoreRow({ a, d, editable }: { a: AssessmentDetail; d: NonNullable<AssessmentDetail['score']>['dimensions'][number]; editable: boolean }): React.JSX.Element {
  const { t } = useI18n();
  const [rating, setRating] = useState(d.rating === null ? '' : String(d.rating));
  const [evidenceRef, setEvidenceRef] = useState(d.evidenceRef ?? '');
  const [reasoning, setReasoning] = useState(d.reasoning ?? '');
  const save = useConsoleMutation({ mutationFn: (_v, key) => put(`/${a.id}/scores/${d.code}`, { rating: Number(rating), evidenceRef, reasoning }, key), ...useWrite(a.id), successMessage: t('sa.saved') });
  return (
    <tr className="align-top">
      <td className="px-3 py-2">
        <p className="font-medium">{t(tk(`sa.dimension.${d.code}`))}</p>
        <p className="text-xs text-ink-muted">{t(tk(`sa.dimensionEvidence.${d.code}`))}</p>
      </td>
      <td className="px-3 py-2">{d.weight}</td>
      <td className="px-3 py-2">
        {editable ? (
          <Select aria-label={t('sa.score.rating')} value={rating} onChange={(e) => { setRating(e.target.value); }}>
            <option value="">—</option>
            {[0, 1, 2, 3, 4, 5].map((r) => (
              <option key={r} value={String(r)}>{r}</option>
            ))}
          </Select>
        ) : (
          (d.rating ?? '—')
        )}
      </td>
      <td className="px-3 py-2">{d.contribution ?? '—'}</td>
      <td className="space-y-2 px-3 py-2">
        {editable ? (
          <>
            <Input aria-label={t('sa.checklist.evidenceRef')} placeholder={t('sa.checklist.evidenceRef')} value={evidenceRef} onChange={(e) => { setEvidenceRef(e.target.value); }} />
            <Textarea aria-label={t('sa.score.reasoning')} placeholder={t('sa.score.reasoning')} value={reasoning} onChange={(e) => { setReasoning(e.target.value); }} />
            <Button size="sm" variant="secondary" disabled={rating === '' || evidenceRef.trim() === '' || reasoning.trim().length < 5 || save.isPending} onClick={() => { save.mutate(); }}>
              {t('sa.score.save')}
            </Button>
            <MutationError error={save.error} />
          </>
        ) : (
          <p className="text-xs">{d.evidenceRef ?? '—'} · {d.reasoning ?? ''}</p>
        )}
        {d.ratedBy !== null && <p className="text-xs text-ink-muted">{d.ratedBy} · {formatDateTime(d.ratedAt)}</p>}
      </td>
    </tr>
  );
}

// --- Scope matrix ----------------------------------------------------------------

function ScopeTab({ a }: { a: AssessmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  const [editing, setEditing] = useState<ScopeItem | null>(null);
  return (
    <div className="space-y-4">
      <Callout tone="info">{t('sa.scope.noRegions')}</Callout>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <caption className="sr-only">{t('sa.scope.caption')}</caption>
          <thead>
            <tr className="text-left text-xs text-ink-muted">
              {['product', 'site', 'country', 'channel', 'classification', 'decision', ''].map((h) => (
                <th key={h} className="px-3 py-2">{h === '' ? <span className="sr-only">{t('sa.scope.actions')}</span> : t(tk(`sa.scope.${h}`))}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {a.scope.map((s) => (
              <tr key={s.id}>
                <td className="px-3 py-2">{s.productName} {s.productVersion}<span className="block font-mono text-xs text-ink-muted">{s.productKey}</span></td>
                <td className="px-3 py-2">{s.facilityRef}</td>
                <td className="px-3 py-2">{s.countryCode}</td>
                <td className="px-3 py-2">{s.channel}</td>
                <td className="px-3 py-2 text-xs">{s.regulatoryClass ?? '—'}{s.hsProposal ? ` · HS ${s.hsProposal}` : ''}</td>
                <td className="px-3 py-2"><Badge tone={s.decision === 'APPROVED' ? 'success' : s.decision === 'BLOCKED' ? 'danger' : 'neutral'}>{t(tk(`sa.decision.${s.decision}`))}</Badge></td>
                <td className="px-3 py-2"><Button size="sm" variant="ghost" onClick={() => { setEditing(s); }}>{t('sa.scope.classify')}</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing !== null && <ClassifyForm a={a} item={editing} onDone={() => { setEditing(null); }} />}
    </div>
  );
}

const CLASSIFY_FIELDS = ['catalogueCategory', 'hsProposal', 'regulatoryClass', 'requiredTests', 'authorisations', 'localResponsible', 'importerLicence', 'labelsLanguages', 'warnings', 'restrictions', 'recallObligations', 'shippingInsurance'] as const;

function ClassifyForm({ a, item, onDone }: { a: AssessmentDetail; item: ScopeItem; onDone: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const [form, setForm] = useState<Record<string, string>>(() => Object.fromEntries(CLASSIFY_FIELDS.map((f) => [f, (item[f]) ?? ''])));
  const [decision, setDecision] = useState(item.decision === 'BLOCKED' ? 'BLOCKED' : 'APPROVED');
  const [reason, setReason] = useState(item.decisionReason ?? '');
  const [authExpiry, setAuthExpiry] = useState(item.authorisationExpiresOn ?? '');
  const save = useConsoleMutation({
    mutationFn: (_v, key) => put(`/${a.id}/scope/${item.id}`, { ...form, authorisationExpiresOn: authExpiry === '' ? null : authExpiry, decision, decisionReason: reason, nextReviewAt: null }, key),
    ...useWrite(a.id),
    successMessage: t('sa.saved'),
    onSuccess: onDone,
  });
  return (
    <Card title={t('sa.scope.classifyTitle', { product: item.productName, country: item.countryCode, channel: item.channel })} description={t('sa.scope.classifyHint')} bodyClassName="grid gap-3 px-5 py-4 sm:grid-cols-2">
      {CLASSIFY_FIELDS.map((f) => (
        <Field key={f} label={t(tk(`sa.classify.${f}`))}>
          {({ inputId }) => <Input id={inputId} value={form[f] ?? ''} onChange={(e) => { setForm({ ...form, [f]: e.target.value }); }} />}
        </Field>
      ))}
      <Field label={t('sa.classify.authorisationExpiresOn')}>
        {({ inputId }) => <Input id={inputId} type="date" value={authExpiry} onChange={(e) => { setAuthExpiry(e.target.value); }} />}
      </Field>
      <Field label={t('sa.scope.decision')}>
        {({ inputId }) => (
          <Select id={inputId} value={decision} onChange={(e) => { setDecision(e.target.value); }}>
            <option value="APPROVED">{t('sa.decision.APPROVED')}</option>
            <option value="BLOCKED">{t('sa.decision.BLOCKED')}</option>
          </Select>
        )}
      </Field>
      <div className="sm:col-span-2">
        <Field label={t('sa.reason')} required>
          {({ inputId }) => <Textarea id={inputId} value={reason} onChange={(e) => { setReason(e.target.value); }} />}
        </Field>
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <Button variant="primary" disabled={reason.trim().length < 5 || save.isPending} onClick={() => { save.mutate(); }}>{t('sa.scope.saveClassification')}</Button>
        <Button variant="ghost" onClick={onDone}>{t('sa.cancel')}</Button>
      </div>
      <div className="sm:col-span-2"><MutationError error={save.error} /></div>
    </Card>
  );
}

// --- Findings / CAPA ------------------------------------------------------------

function FindingsTab({ a }: { a: AssessmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [form, setForm] = useState({ classification: 'MAJOR', requirement: '', evidence: '', ownerName: '' });
  const raise = useConsoleMutation({ mutationFn: (_v, key) => post(`/${a.id}/findings`, { ...form, ownerName: form.ownerName.trim() === '' ? null : form.ownerName }, key), ...useWrite(a.id), successMessage: t('sa.saved') });
  return (
    <div className="space-y-4">
      {a.findings.length === 0 && <p className="text-sm text-ink-muted">{t('sa.findings.empty')}</p>}
      {a.findings.map((f) => (
        <FindingCard key={f.id} a={a} f={f} />
      ))}
      {can(Permission.ASSESSMENT_WORK) && (
        <Card title={t('sa.findings.raise')} description={t('sa.findings.deadlines')} bodyClassName="grid gap-3 px-5 py-4 sm:grid-cols-2">
          <Field label={t('sa.findings.classification')}>
            {({ inputId }) => (
              <Select id={inputId} value={form.classification} onChange={(e) => { setForm({ ...form, classification: e.target.value }); }}>
                {['CRITICAL', 'MAJOR', 'MINOR'].map((c) => (
                  <option key={c} value={c}>{t(tk(`sa.class.${c}`))}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('sa.findings.owner')}>
            {({ inputId }) => <Input id={inputId} value={form.ownerName} onChange={(e) => { setForm({ ...form, ownerName: e.target.value }); }} />}
          </Field>
          <Field label={t('sa.findings.requirement')} required>
            {({ inputId }) => <Textarea id={inputId} value={form.requirement} onChange={(e) => { setForm({ ...form, requirement: e.target.value }); }} />}
          </Field>
          <Field label={t('sa.findings.evidence')} required>
            {({ inputId }) => <Textarea id={inputId} value={form.evidence} onChange={(e) => { setForm({ ...form, evidence: e.target.value }); }} />}
          </Field>
          <div className="sm:col-span-2">
            <Button variant="primary" disabled={form.requirement.trim().length < 5 || form.evidence.trim().length < 5 || raise.isPending} onClick={() => { raise.mutate(); }}>{t('sa.findings.raise')}</Button>
            <MutationError error={raise.error} />
          </div>
        </Card>
      )}
    </div>
  );
}

function FindingCard({ a, f }: { a: AssessmentDetail; f: Finding }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [verification, setVerification] = useState('');
  const close = useConsoleMutation<'CLOSE' | 'REOPEN'>({ mutationFn: (decision, key) => post(`/findings/${f.id}/close`, { effectivenessVerification: verification, decision, expectedVersion: f.version }, key), ...useWrite(a.id), successMessage: t('sa.saved') });
  return (
    <Card title={`${f.number} · ${t(tk(`sa.class.${f.classification}`))}`} actions={<Badge tone={f.status === 'VERIFIED_CLOSED' ? 'success' : f.overdue ? 'danger' : 'warning'}>{t(tk(`sa.findingStatus.${f.status}`))}{f.overdue ? ` · ${t('sa.findings.overdue')}` : ''}</Badge>} bodyClassName="space-y-3 px-5 py-4">
      <DescriptionList
        items={[
          { label: t('sa.findings.requirement'), value: f.requirement },
          { label: t('sa.findings.evidence'), value: f.evidence },
          { label: t('sa.findings.containment'), value: f.containment ?? '—' },
          { label: t('sa.findings.rootCause'), value: f.rootCause ?? '—' },
          { label: t('sa.findings.corrective'), value: f.correctiveAction ?? '—' },
          { label: t('sa.findings.preventive'), value: f.preventiveAction ?? '—' },
          { label: t('sa.findings.owner'), value: f.ownerName ?? '—' },
          { label: t('sa.findings.due'), value: `${f.planDueAt ? `${t('sa.findings.plan')} ${formatDate(f.planDueAt)} · ` : ''}${t('sa.findings.closure')} ${formatDate(f.closureDueAt)}` },
          { label: t('sa.findings.closureEvidence'), value: String(f.closureEvidenceIds.length) },
          { label: t('sa.findings.effectiveness'), value: f.effectivenessVerification ?? '—' },
        ]}
      />
      {f.classification !== 'MINOR' && f.status !== 'VERIFIED_CLOSED' && <p className="text-xs text-danger">{t('sa.findings.blocks')}</p>}
      {can(Permission.ASSESSMENT_WORK) && f.status !== 'VERIFIED_CLOSED' && (
        <div className="space-y-2">
          <Field label={t('sa.findings.effectiveness')} required>
            {({ inputId }) => <Textarea id={inputId} value={verification} onChange={(e) => { setVerification(e.target.value); }} />}
          </Field>
          <div className="flex gap-2">
            <Button variant="primary" disabled={verification.trim().length < 5 || close.isPending} onClick={() => { close.mutate('CLOSE'); }}>{t('sa.findings.close')}</Button>
            <Button variant="secondary" disabled={verification.trim().length < 5 || close.isPending} onClick={() => { close.mutate('REOPEN'); }}>{t('sa.findings.reopen')}</Button>
          </div>
          <MutationError error={close.error} />
        </div>
      )}
    </Card>
  );
}

// --- Workpapers -------------------------------------------------------------------

/** Field templates per kind. Nested lists are entered one row per line, `a | b | c`. */
const TEMPLATES: Record<WorkpaperKind, Record<string, string>> = {
  SITE_AUDIT: { facilityRef: '', visitDate: '', auditors: '', reportId: '', outsourcedProcessesCovered: '', notes: '' },
  SAMPLE_PLAN: { basis: 'RISK_BASED', justification: '', method: '', quantities: '', acceptanceCriteria: '', laboratory: '', testScope: '', selectedBy: '', sealNumbers: '', results: '', resultOutcome: 'PENDING' },
  LAB_COMPETENCE: { laboratory: '', iso17025Accreditation: '', legalRecognitionReference: '', verifiedAgainst: '', evidenceRef: '' },
  CONTRACT: { contractKind: 'SELLER_TERMS', executedOn: '', counterpartySignatory: '', evidenceRef: '' },
  MOCK_ORDER: { reference: '' },
  IDENTITY_CHECK: { subject: 'REGISTRATION', source: '', retrievedOn: '', outcome: 'MATCH', lawfulBasis: '', note: '' },
  BANK_VERIFICATION: { method: '', knownContact: '', outcome: 'CONFIRMED', note: '' },
  SANCTIONS_SCREENING: { lists: '', source: '', provider: 'MANUAL', subjects: '', outcome: 'NO_MATCH', note: '' },
  SPECIALIST_REVIEW: { area: 'REGULATORY', outcome: 'SATISFACTORY', note: '' },
  AI_OUTPUT: { task: 'EXTRACTION', tool: '', source: '', retrievedOn: '', confidence: 'MEDIUM', uncertainty: '', output: '', humanReviewNote: '' },
};
const AREAS = ['PRODUCTION', 'OUTSOURCED_PROCESSES', 'QUALITY_CONTROL', 'CALIBRATION', 'BATCH_TRACEABILITY', 'WORKER_SAFETY', 'STORAGE', 'COMPLAINTS', 'RECALL_CAPABILITY'];
const STEPS = ['ALLOCATION', 'INSPECTION', 'PACKOUT', 'SHIPMENT_DOCUMENTS', 'TRACKING', 'REFUND', 'RECALL_TRACE'];

function WorkpapersTab({ a }: { a: AssessmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [kind, setKind] = useState<WorkpaperKind>('SITE_AUDIT');
  const [fields, setFields] = useState<Record<string, string>>(TEMPLATES.SITE_AUDIT);
  const [areas, setAreas] = useState<Record<string, string>>(Object.fromEntries(AREAS.map((x) => [x, 'SATISFACTORY'])));
  const [steps, setSteps] = useState<Record<string, { mode: string; outcome: string }>>(Object.fromEntries(STEPS.map((s) => [s, { mode: 'SIMULATED', outcome: 'PASS' }])));
  const [custody, setCustody] = useState({ from: '', to: '', sealIntact: true });
  const payload = (): Record<string, unknown> => {
    const p: Record<string, unknown> = { ...fields };
    if (kind === 'SITE_AUDIT') p['areas'] = areas;
    if (kind === 'SAMPLE_PLAN') p['custody'] = [{ at: new Date().toISOString(), ...custody }];
    if (kind === 'MOCK_ORDER') p['steps'] = STEPS.map((step) => ({ step, mode: steps[step]?.mode, integration: steps[step]?.mode === 'PROVIDER_VERIFIED' ? 'PAYMENTS' : 'NONE', outcome: steps[step]?.outcome, note: '' }));
    if (kind === 'LAB_COMPETENCE') Object.assign(p, { iso17025Accreditation: fields['iso17025Accreditation'] || null, legalRecognitionReference: fields['legalRecognitionReference'] || null, accreditationScopeCoversTests: Boolean(fields['iso17025Accreditation']), legalRecognitionRequired: Boolean(fields['legalRecognitionReference']) });
    if (kind === 'BANK_VERIFICATION') p['beneficiaryMatchesEntity'] = fields['outcome'] === 'CONFIRMED';
    return p;
  };
  const save = useConsoleMutation({ mutationFn: (_v, key) => post(`/${a.id}/workpapers`, { kind, subjectRef: kind === 'SITE_AUDIT' ? (fields['facilityRef'] ?? null) : null, payload: payload() }, key), ...useWrite(a.id), successMessage: t('sa.saved') });
  return (
    <div className="space-y-4">
      <Card title={t('sa.workpapers.title')} description={t('sa.workpapers.description')} bodyClassName="divide-y divide-border-subtle">
        {a.workpapers.length === 0 && <p className="px-5 py-4 text-sm text-ink-muted">{t('sa.workpapers.empty')}</p>}
        {a.workpapers.map((w) => (
          <details key={w.id} className="px-5 py-2 text-sm">
            <summary className="cursor-pointer">
              {t(tk(`sa.workpaper.${w.kind}`))} {w.subjectRef ?? ''} · r{String(w.revision)} · {w.recordedBy ?? ''} · {formatDateTime(w.recordedAt)} <Badge tone={w.mode === 'SIMULATED' ? 'warning' : 'neutral'}>{t(tk(`sa.mode.${w.mode}`))}</Badge>
            </summary>
            <pre className="mt-2 max-h-72 overflow-auto rounded bg-surface-subtle p-3 text-xs">{w.payload === null ? t('sa.workpapers.withheld') : JSON.stringify(w.payload, null, 2)}</pre>
          </details>
        ))}
      </Card>
      {can(Permission.ASSESSMENT_WORK) && (
        <Card title={t('sa.workpapers.record')} description={t('sa.workpapers.honest')} bodyClassName="grid gap-3 px-5 py-4 sm:grid-cols-2">
          <Field label={t('sa.workpapers.kind')}>
            {({ inputId }) => (
              <Select id={inputId} value={kind} onChange={(e) => { const k = e.target.value as WorkpaperKind; setKind(k); setFields(TEMPLATES[k]); }}>
                {WORKPAPER_KINDS.map((k) => (
                  <option key={k} value={k}>{t(tk(`sa.workpaper.${k}`))}</option>
                ))}
              </Select>
            )}
          </Field>
          {Object.keys(TEMPLATES[kind]).map((f) => (
            <Field key={f} label={t(tk(`sa.wp.${f}`))}>
              {({ inputId }) => <Input id={inputId} type={/Date$|On$/.test(f) ? 'date' : 'text'} value={fields[f] ?? ''} onChange={(e) => { setFields({ ...fields, [f]: e.target.value }); }} />}
            </Field>
          ))}
          {kind === 'SITE_AUDIT' && AREAS.map((x) => (
            <Field key={x} label={t(tk(`sa.area.${x}`))}>
              {({ inputId }) => (
                <Select id={inputId} value={areas[x]} onChange={(e) => { setAreas({ ...areas, [x]: e.target.value }); }}>
                  {['SATISFACTORY', 'FINDING_RAISED', 'NOT_APPLICABLE'].map((o) => <option key={o} value={o}>{t(tk(`sa.areaOutcome.${o}`))}</option>)}
                </Select>
              )}
            </Field>
          ))}
          {kind === 'SAMPLE_PLAN' && (
            <>
              <Field label={t('sa.wp.custodyFrom')}>{({ inputId }) => <Input id={inputId} value={custody.from} onChange={(e) => { setCustody({ ...custody, from: e.target.value }); }} />}</Field>
              <Field label={t('sa.wp.custodyTo')}>{({ inputId }) => <Input id={inputId} value={custody.to} onChange={(e) => { setCustody({ ...custody, to: e.target.value }); }} />}</Field>
            </>
          )}
          {kind === 'MOCK_ORDER' && STEPS.map((s) => (
            <Field key={s} label={t(tk(`sa.step.${s}`))} hint={t('sa.workpapers.mockHint')}>
              {({ inputId, describedBy }) => (
                <div className="flex gap-2">
                  <Select id={inputId} aria-describedby={describedBy} value={steps[s]?.mode} onChange={(e) => { setSteps({ ...steps, [s]: { mode: e.target.value, outcome: steps[s]?.outcome ?? 'PASS' } }); }}>
                    <option value="SIMULATED">{t('sa.mode.SIMULATED')}</option>
                    <option value="PROVIDER_VERIFIED">{t('sa.mode.PROVIDER_VERIFIED')}</option>
                  </Select>
                  <Select aria-label={t('sa.workpapers.outcome')} value={steps[s]?.outcome} onChange={(e) => { setSteps({ ...steps, [s]: { mode: steps[s]?.mode ?? 'SIMULATED', outcome: e.target.value } }); }}>
                    <option value="PASS">{t('sa.outcome.PASS')}</option>
                    <option value="FAIL">{t('sa.outcome.FAIL')}</option>
                  </Select>
                </div>
              )}
            </Field>
          ))}
          {kind === 'AI_OUTPUT' && <Callout tone="warning" className="sm:col-span-2">{t('sa.workpapers.aiLimits')}</Callout>}
          <div className="sm:col-span-2">
            <Button variant="primary" disabled={save.isPending} onClick={() => { save.mutate(); }}>{t('sa.workpapers.save')}</Button>
            <MutationError error={save.error} />
          </div>
        </Card>
      )}
    </div>
  );
}

// --- Certification (Gate 5) -------------------------------------------------------

function CertificationTab({ a }: { a: AssessmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const write = can(Permission.ASSESSMENT_WORK);
  const opts = useWrite(a.id);
  const facilityRefs = [...new Set(a.scope.map((s) => s.facilityRef))];
  const productKeys = [...new Set(a.scope.map((s) => s.productKey))];
  const [appoint, setAppoint] = useState({ bodyName: '', scheme: '', procurementRef: '', paymentRef: '', accreditationBody: '', accreditationNumber: '', sectorScope: '', legalRecognition: '', conflictCheck: '', surveillanceConditions: '' });
  const appointM = useConsoleMutation({ mutationFn: (_v, key) => post(`/${a.id}/certifications`, { ...Object.fromEntries(Object.entries(appoint).map(([k, v]) => [k, v.trim() === '' && k !== 'bodyName' && k !== 'scheme' ? null : v])), facilityRefs, productKeys }, key), ...opts, successMessage: t('sa.saved') });
  return (
    <div className="space-y-4">
      <Callout tone="info">{t('sa.cert.independence')}</Callout>
      {a.certifications.map((c) => (
        <CertCard key={c.id} a={a} c={c} />
      ))}
      {write && (
        <Card title={t('sa.cert.appoint')} description={t('sa.cert.appointHint')} bodyClassName="grid gap-3 px-5 py-4 sm:grid-cols-2">
          {Object.keys(appoint).map((f) => (
            <Field key={f} label={t(tk(`sa.cert.${f}`))} required={f === 'bodyName' || f === 'scheme'}>
              {({ inputId }) => <Input id={inputId} value={appoint[f as keyof typeof appoint]} onChange={(e) => { setAppoint({ ...appoint, [f]: e.target.value }); }} />}
            </Field>
          ))}
          <p className="text-xs text-ink-muted sm:col-span-2">{t('sa.cert.covers', { facilities: facilityRefs.join(', '), products: String(productKeys.length) })}</p>
          <div className="sm:col-span-2">
            <Button variant="primary" disabled={appoint.bodyName.trim().length < 2 || appoint.scheme.trim().length < 2 || appointM.isPending} onClick={() => { appointM.mutate(); }}>{t('sa.cert.appoint')}</Button>
            <MutationError error={appointM.error} />
          </div>
        </Card>
      )}
    </div>
  );
}

function CertCard({ a, c }: { a: AssessmentDetail; c: AssessmentDetail['certifications'][number] }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [form, setForm] = useState({ certificateNumber: c.certificateNumber ?? '', issuer: c.issuer ?? c.bodyName, issuedOn: c.issuedOn ?? '', expiresOn: c.expiresOn ?? '', authenticityMethod: c.authenticityMethod ?? '', authenticityReference: c.authenticityReference ?? '' });
  const [accredited, setAccredited] = useState(c.accreditationVerified ?? false);
  const [independent, setIndependent] = useState(c.independenceVerified ?? false);
  const [withdrawReason, setWithdrawReason] = useState('');
  const opts = useWrite(a.id);
  const record = useConsoleMutation<'ISSUED_UNVERIFIED' | 'AUTHENTICATED'>({ mutationFn: (status, key) => put(`/certifications/${c.id}`, { ...form, accreditationVerified: accredited, independenceVerified: independent, status, expectedVersion: c.version ?? 0 }, key), ...opts, successMessage: t('sa.saved') });
  const withdraw = useConsoleMutation({ mutationFn: (_v, key) => post(`/certifications/${c.id}/withdraw`, { status: 'WITHDRAWN', reason: withdrawReason }, key), ...opts, successMessage: t('sa.saved') });
  return (
    <Card title={`${c.bodyName} · ${c.scheme}`} actions={<Badge tone={c.status === 'AUTHENTICATED' ? 'success' : ['WITHDRAWN', 'SUSPENDED', 'EXPIRED', 'REFUSED'].includes(c.status) ? 'danger' : 'warning'}>{t(tk(`sa.certStatus.${c.status}`))}</Badge>} bodyClassName="space-y-3 px-5 py-4">
      <DescriptionList
        items={[
          { label: t('sa.cert.certificateNumber'), value: c.certificateNumber ?? '—' },
          { label: t('sa.cert.validity'), value: `${c.issuedOn ?? '—'} – ${c.expiresOn ?? '—'}` },
          { label: t('sa.cert.accreditation'), value: `${c.accreditationBody ?? '—'} ${c.accreditationNumber ?? ''} · ${c.accreditationVerified ? t('sa.cert.verified') : t('sa.cert.notVerified')}` },
          { label: t('sa.cert.independenceCheck'), value: `${c.conflictCheck ?? '—'} · ${c.independenceVerified ? t('sa.cert.verified') : t('sa.cert.notVerified')}` },
          { label: t('sa.cert.authenticity'), value: `${c.authenticityMethod ?? '—'} · ${c.authenticityReference ?? ''}` },
          { label: t('sa.cert.scope'), value: `${(c.facilityRefs ?? []).join(', ')} · ${String((c.productKeys ?? []).length)}` },
          { label: t('sa.cert.procurementRef'), value: `${c.procurementRef ?? '—'} / ${c.paymentRef ?? '—'}` },
          { label: t('sa.cert.surveillanceConditions'), value: c.surveillanceConditions ?? '—' },
        ]}
      />
      {can(Permission.ASSESSMENT_WORK) && !['WITHDRAWN', 'REFUSED'].includes(c.status) && (
        <div className="grid gap-3 sm:grid-cols-3">
          {(Object.keys(form) as (keyof typeof form)[]).map((f) => (
            <Field key={f} label={t(tk(`sa.cert.${f}`))}>
              {({ inputId }) => <Input id={inputId} type={f === 'issuedOn' || f === 'expiresOn' ? 'date' : 'text'} value={form[f]} onChange={(e) => { setForm({ ...form, [f]: e.target.value }); }} />}
            </Field>
          ))}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={accredited} onChange={(e) => { setAccredited(e.target.checked); }} />{t('sa.cert.accreditationConfirmed')}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={independent} onChange={(e) => { setIndependent(e.target.checked); }} />{t('sa.cert.independenceConfirmed')}</label>
          <div className="flex flex-wrap gap-2 sm:col-span-3">
            <Button variant="secondary" disabled={record.isPending} onClick={() => { record.mutate('ISSUED_UNVERIFIED'); }}>{t('sa.cert.recordUnverified')}</Button>
            <Button variant="primary" disabled={record.isPending} onClick={() => { record.mutate('AUTHENTICATED'); }}>{t('sa.cert.recordAuthenticated')}</Button>
          </div>
          <Field label={t('sa.cert.withdrawReason')}>
            {({ inputId }) => <Input id={inputId} value={withdrawReason} onChange={(e) => { setWithdrawReason(e.target.value); }} />}
          </Field>
          <div className="flex items-end">
            <Button variant="secondary" disabled={withdrawReason.trim().length < 5 || withdraw.isPending} onClick={() => { withdraw.mutate(); }}>{t('sa.cert.withdraw')}</Button>
          </div>
          <div className="sm:col-span-3"><MutationError error={record.error ?? withdraw.error} /></div>
        </div>
      )}
    </Card>
  );
}

// --- Release (Gate 8), approvals, suspension, decline -------------------------------

function ReleaseTab({ a }: { a: AssessmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const gaps = useQuery({ queryKey: assessmentKeys.gaps(a.id), queryFn: () => fetchGaps(a.id) });
  const approvedScope = a.scope.filter((s) => s.decision === 'APPROVED');
  const [chosen, setChosen] = useState<string[]>(approvedScope.map((s) => s.id));
  const [reason, setReason] = useState('');
  const [hardStop, setHardStop] = useState<string>(HARD_STOPS[0]);
  const [decision, setDecision] = useState('REMEDIATION');
  const opts = useWrite(a.id);
  const release = useConsoleMutation({ mutationFn: (_v, key) => post(`/${a.id}/release`, { scopeItemIds: chosen, reason, nextReviewAt: null, expectedVersion: a.version }, key), ...opts, successMessage: t('sa.release.done') });
  const stop = useConsoleMutation({ mutationFn: (_v, key) => post(`/${a.id}/hard-stops`, { stop: hardStop, reason }, key), ...opts, successMessage: t('sa.saved') });
  const decide = useConsoleMutation({ mutationFn: (_v, key) => post(`/${a.id}/decision`, { decision, reason, expectedVersion: a.version }, key), ...opts, successMessage: t('sa.saved') });
  return (
    <div className="space-y-4">
      <Card title={t('sa.release.gaps')} bodyClassName="px-5 py-4">
        <QueryBoundary query={gaps}>
          {(g) =>
            g.gaps.length === 0 ? (
              <Callout tone="success">{t('sa.release.noGaps')}</Callout>
            ) : (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {g.gaps.map((x) => <li key={x} className="font-mono text-xs">{x}</li>)}
              </ul>
            )
          }
        </QueryBoundary>
        <p className="mt-3 text-xs text-ink-muted">{t('sa.release.independence')}</p>
      </Card>
      {can(Permission.ASSESSMENT_WORK) && a.status === 'IN_REVIEW' && (
        <Card title={t('sa.release.title')} description={t('sa.release.exactScope')} bodyClassName="space-y-3 px-5 py-4">
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">{t('sa.release.scope')}</legend>
            {approvedScope.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={chosen.includes(s.id)} onChange={(e) => { setChosen(e.target.checked ? [...chosen, s.id] : chosen.filter((x) => x !== s.id)); }} />
                {s.productName} {s.productVersion} · {s.facilityRef} · {s.countryCode} · {s.channel}
              </label>
            ))}
          </fieldset>
          <Field label={t('sa.reason')} required>
            {({ inputId }) => <Textarea id={inputId} value={reason} onChange={(e) => { setReason(e.target.value); }} />}
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={chosen.length === 0 || reason.trim().length < 5 || release.isPending} onClick={() => { release.mutate(); }}>{t('sa.release.release')}</Button>
            <Select aria-label={t('sa.release.decision')} value={decision} onChange={(e) => { setDecision(e.target.value); }}>
              {['REMEDIATION', 'DECLINED'].map((d) => <option key={d} value={d}>{t(tk(`sa.status.${d}`))}</option>)}
            </Select>
            <Button variant="secondary" disabled={reason.trim().length < 5 || decide.isPending} onClick={() => { decide.mutate(); }}>{t('sa.release.recordDecision')}</Button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t('sa.release.hardStop')}>
              {({ inputId }) => (
                <Select id={inputId} value={hardStop} onChange={(e) => { setHardStop(e.target.value); }}>
                  {HARD_STOPS.map((h) => <option key={h} value={h}>{t(tk(`sa.hardStop.${h}`))}</option>)}
                </Select>
              )}
            </Field>
            <Button variant="danger" disabled={reason.trim().length < 5 || stop.isPending} onClick={() => { stop.mutate(); }}>{t('sa.release.recordHardStop')}</Button>
          </div>
          <MutationError error={release.error ?? decide.error ?? stop.error} />
        </Card>
      )}
      {a.status === 'REMEDIATION' && can(Permission.ASSESSMENT_WORK) && <Reassess a={a} />}
      {a.approvals.map((ap) => <ApprovalCard key={ap.id} a={a} ap={ap} />)}
    </div>
  );
}

function Reassess({ a }: { a: AssessmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  const back = useConsoleMutation({ mutationFn: (_v, key) => post(`/${a.id}/decision`, { decision: 'REASSESS', reason: 'Remediation evidence received; reassessing.', expectedVersion: a.version }, key), ...useWrite(a.id), successMessage: t('sa.saved') });
  return (
    <Card title={t('sa.release.reassess')} bodyClassName="px-5 py-4">
      <Button variant="secondary" disabled={back.isPending} onClick={() => { back.mutate(); }}>{t('sa.release.reassess')}</Button>
      <MutationError error={back.error} />
    </Card>
  );
}

function ApprovalCard({ a, ap }: { a: AssessmentDetail; ap: AssessmentDetail['approvals'][number] }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [form, setForm] = useState({ reason: '', shareableEvidence: '', settlementTreatment: '', correctiveActions: '', reviewRoute: '', riskContainmentNote: '' });
  const [kind, setKind] = useState('SUSPENSION');
  const [hardStop, setHardStop] = useState<string>('');
  const [scopeIds, setScopeIds] = useState<string[]>([]);
  const suspend = useConsoleMutation({ mutationFn: (_v, key) => post(`/approvals/${ap.id}/suspend`, { kind, hardStop: hardStop === '' ? null : hardStop, scopeIds: scopeIds.length === 0 ? null : scopeIds, ...form, riskContainmentNote: form.riskContainmentNote.trim() === '' ? null : form.riskContainmentNote }, key), ...useWrite(a.id), successMessage: t('sa.saved') });
  return (
    <Card title={`${ap.number} · ${t('sa.approval.internal')}`} actions={<Badge tone={ap.status === 'ACTIVE' ? 'success' : 'danger'}>{t(tk(`sa.approvalStatus.${ap.status}`))}</Badge>} bodyClassName="space-y-3 px-5 py-4">
      <DescriptionList
        items={[
          { label: t('sa.approval.validity'), value: `${formatDate(ap.issuedAt)} – ${formatDate(ap.validUntil)}` },
          { label: t('sa.approval.nextReview'), value: formatDate(ap.nextReviewAt) },
          { label: t('sa.approval.policy'), value: `${ap.policyVersion} (${ap.policyStatusAtRelease})` },
          { label: t('sa.approval.score'), value: ap.score },
        ]}
      />
      <p className="text-xs text-ink-muted">{t('sa.approval.notExternal')}</p>
      {ap.auditDocumentId !== null && <DownloadButton path={approvalPdfPath(ap.id)} fileName={`${ap.number}.pdf`} label={t('sa.approval.pdf')} />}
      <ul className="divide-y divide-border-subtle text-sm">
        {ap.scopes.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2 py-1">
            {can(Permission.ASSESSMENT_WORK) && <input type="checkbox" aria-label={t('sa.approval.selectScope')} checked={scopeIds.includes(s.id)} onChange={(e) => { setScopeIds(e.target.checked ? [...scopeIds, s.id] : scopeIds.filter((x) => x !== s.id)); }} />}
            <span className="font-mono text-xs">{s.productKey}</span> {s.productVersion} · {s.facilityRef} · {s.countryCode} · {s.channel} · {formatDate(s.validUntil)}
            <Badge tone={s.status === 'ACTIVE' ? 'success' : 'danger'}>{t(tk(`sa.scopeStatus.${s.status}`))}</Badge>
          </li>
        ))}
      </ul>
      {can(Permission.ASSESSMENT_WORK) && ap.status === 'ACTIVE' && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">{t('sa.suspend.title')}</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label={t('sa.suspend.kind')}>
              {({ inputId }) => (
                <Select id={inputId} value={kind} onChange={(e) => { setKind(e.target.value); }}>
                  {['SUSPENSION', 'RESTRICTION', 'REVOCATION'].map((k) => <option key={k} value={k}>{t(tk(`sa.noticeKind.${k}`))}</option>)}
                </Select>
              )}
            </Field>
            <Field label={t('sa.release.hardStop')}>
              {({ inputId }) => (
                <Select id={inputId} value={hardStop} onChange={(e) => { setHardStop(e.target.value); }}>
                  <option value="">—</option>
                  {HARD_STOPS.map((h) => <option key={h} value={h}>{t(tk(`sa.hardStop.${h}`))}</option>)}
                </Select>
              )}
            </Field>
            {(Object.keys(form) as (keyof typeof form)[]).map((f) => (
              <Field key={f} label={t(tk(`sa.suspend.${f}`))} required={f !== 'riskContainmentNote'}>
                {({ inputId }) => <Textarea id={inputId} value={form[f]} onChange={(e) => { setForm({ ...form, [f]: e.target.value }); }} />}
              </Field>
            ))}
            <p className="text-xs text-ink-muted sm:col-span-2">{scopeIds.length === 0 ? t('sa.suspend.whole') : t('sa.suspend.partial', { rows: String(scopeIds.length) })}</p>
            <div className="sm:col-span-2">
              <Button variant="danger" disabled={suspend.isPending} onClick={() => { suspend.mutate(); }}>{t('sa.suspend.issue')}</Button>
              <MutationError error={suspend.error} />
            </div>
          </div>
        </details>
      )}
    </Card>
  );
}

function TimelineTab({ a }: { a: AssessmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Card title={t('sa.timeline.title')} description={t('sa.timeline.description')} bodyClassName="divide-y divide-border-subtle">
      {a.timeline.length === 0 && <p className="px-5 py-4 text-sm text-ink-muted">{t('sa.timeline.empty')}</p>}
      <ol>
        {a.timeline.map((e) => (
          <li key={e.id} className="px-5 py-2 text-sm">
            <p>
              <span className="font-medium">{e.kind}</span> · {e.actor ?? '—'}
              {e.capability !== null && <Badge tone="neutral">{e.capability}</Badge>} · {formatDateTime(e.at)}
              {e.policyVersion !== null && <span className="text-xs text-ink-muted"> · {t('sa.timeline.policy', { version: e.policyVersion })}</span>}
            </p>
            {e.reason !== null && <p className="text-xs text-ink-muted">{e.reason}</p>}
            {e.evidenceRefs.length > 0 && <p className="font-mono text-xs text-ink-muted">{e.evidenceRefs.join(', ')}</p>}
          </li>
        ))}
      </ol>
    </Card>
  );
}
