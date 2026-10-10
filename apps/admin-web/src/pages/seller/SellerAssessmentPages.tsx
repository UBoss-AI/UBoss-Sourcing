/**
 * Seller assessments in the Admin Panel: read-only.
 *
 * The Audit Console owns every assessment decision. The server gives this
 * panel no write route at all, and withholds identity, ownership and banking
 * files and the reviewers' internal notes. What is shown here is for oversight.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Callout, Card, EmptyState, ErrorState, Input, LoadingState, PageHeader } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { api, downloadFile } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';

const tk = (key: string) => key as TranslationKey;
const enc = encodeURIComponent;

interface Row { id: string; number: string; kind: string; status: string; seller: string; legalName: string; stage: number; gatesPassed: number; riskLevel: string; overdue: boolean; reviewTargetAt: string | null; hardStops: number; openFindings: { critical: number; major: number; minor: number } }
interface Detail {
  id: string; number: string; kind: string; status: string; policyVersion: string; policyInForce: { version: string; status: string };
  seller: { legalName: string; displayName: string }; legacyNote: string | null; hardStops: { stop: string; reason: string }[];
  gates: { gate: number; status: string; decidedBy: string | null; decidedAt: string | null }[];
  checklist: { code: string; text: string; outcome: string; reviewer: string | null; reviewedAt: string | null; expiresOn: string | null }[];
  score: { display: string; band: string; dimensions: { code: string; weight: number; rating: number | null; contribution: string | null }[] } | null;
  evidence: { id: string; evidenceKey: string; version: number; category: string; fileName: string | null; downloadable: boolean }[];
  scope: { id: string; productName: string; productVersion: string; facilityRef: string; countryCode: string; channel: string; decision: string }[];
  findings: { id: string; number: string; classification: string; status: string; requirement: string; closureDueAt: string; overdue: boolean }[];
  certifications: { id: string; bodyName: string; scheme: string; status: string; certificateNumber: string | null; expiresOn: string | null }[];
  approvals: { id: string; number: string; status: string; validUntil: string; scopes: { id: string; productKey: string; countryCode: string; channel: string; status: string }[] }[];
  timeline: { id: string; kind: string; actor: string | null; capability: string | null; at: string }[];
}

export function SellerAssessmentListPage(): React.JSX.Element {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const query = useQuery({ queryKey: ['admin', 'seller-assessments', search], queryFn: () => api.get<{ rows: Row[]; total: number }>(`/admin/seller-assessments?pageSize=50${search.trim() === '' ? '' : `&search=${enc(search.trim())}`}`) });
  const impact = useQuery({ queryKey: ['admin', 'seller-assessments-impact'], queryFn: () => api.get<{ gateMode: string; activeOffers: number; offersThatWouldBlock: number; policy: { version: string; status: string } }>('/admin/seller-assessments-impact') });
  return (
    <>
      <PageHeader title={t('sa.title')} description={t('sa.admin.description')} />
      <Callout tone="info">{t('sa.admin.readOnly')}</Callout>
      {impact.data !== undefined && <p className="my-3 text-sm">{t('sa.admin.impact', { mode: impact.data.gateMode, version: impact.data.policy.version, policyStatus: t(tk(`sa.policyStatus.${impact.data.policy.status}`)), blocked: String(impact.data.offersThatWouldBlock), offers: String(impact.data.activeOffers) })}</p>}
      <Input aria-label={t('sa.admin.search')} placeholder={t('sa.admin.search')} value={search} onChange={(e) => { setSearch(e.target.value); }} className="mb-3 max-w-sm" />
      {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} /> : query.data.rows.length === 0 ? <EmptyState title={t('sa.admin.empty')} /> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <caption className="sr-only">{t('sa.title')}</caption>
            <thead><tr className="text-left text-xs text-ink-muted">{['assessment', 'seller', 'status', 'stage', 'risk', 'findings'].map((h) => <th key={h} className="px-3 py-2">{t(tk(`sa.admin.col.${h}`))}</th>)}</tr></thead>
            <tbody className="divide-y divide-border-subtle">
              {query.data.rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2"><Link className="font-medium hover:underline" to={`/seller-assessments/${r.id}`}>{r.number}</Link></td>
                  <td className="px-3 py-2">{r.seller}<span className="block text-xs text-ink-muted">{r.legalName}</span></td>
                  <td className="px-3 py-2"><Badge>{t(tk(`sa.status.${r.status}`))}</Badge></td>
                  <td className="px-3 py-2">{t('sa.admin.stage', { gate: String(r.stage), passed: String(r.gatesPassed) })}{r.overdue ? ` · ${t('sa.admin.overdue')}` : ''}</td>
                  <td className="px-3 py-2">{t(tk(`sa.risk.${r.riskLevel}`))}</td>
                  <td className="px-3 py-2">{`${String(r.openFindings.critical)} / ${String(r.openFindings.major)} / ${String(r.openFindings.minor)}`}{r.hardStops > 0 ? ` · ${t('sa.admin.hardStops', { stops: String(r.hardStops) })}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function SellerAssessmentViewPage(): React.JSX.Element {
  const { t } = useI18n();
  const { id = '' } = useParams();
  const query = useQuery({ queryKey: ['admin', 'seller-assessment', id], queryFn: () => api.get<{ assessment: Detail }>(`/admin/seller-assessments/${enc(id)}`) });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} />;
  const a = query.data.assessment;
  return (
    <>
      <PageHeader title={`${a.number} · ${a.seller.displayName}`} description={t('sa.admin.detail', { kind: t(tk(`sa.kind.${a.kind}`)), status: t(tk(`sa.status.${a.status}`)), policy: a.policyVersion })} />
      <div className="space-y-4">
        <Callout tone="info">{t('sa.admin.readOnly')}</Callout>
        {a.policyInForce.status === 'DRAFT' && <Callout tone="warning">{t('sa.admin.draftPolicy', { version: a.policyInForce.version })}</Callout>}
        {a.legacyNote !== null && <Callout tone="info">{a.legacyNote}</Callout>}
        {a.hardStops.length > 0 && <Callout tone="danger">{a.hardStops.map((h) => t(tk(`sa.hardStop.${h.stop}`))).join(' · ')}</Callout>}
        <Card title={t('sa.admin.gates')} bodyClassName="grid gap-2 px-5 py-4 sm:grid-cols-4">
          {a.gates.map((g) => <p key={g.gate} className="text-sm">{String(g.gate)}. {t(tk(`sa.gate.name.${String(g.gate)}`))} <Badge tone={g.status === 'PASSED' ? 'success' : g.status === 'FAILED' ? 'danger' : 'neutral'}>{t(tk(`sa.gateStatus.${g.status}`))}</Badge></p>)}
        </Card>
        {a.score !== null && (
          <Card title={t('sa.admin.score', { score: a.score.display })} description={t(tk(`sa.band.${a.score.band}`))} bodyClassName="grid gap-1 px-5 py-4 text-sm sm:grid-cols-2">
            {a.score.dimensions.map((d) => <p key={d.code}>{t(tk(`sa.dimension.${d.code}`))} ({String(d.weight)}): {d.rating ?? '—'} → {d.contribution ?? '—'}</p>)}
          </Card>
        )}
        <Card title={t('sa.admin.checklist')} bodyClassName="divide-y divide-border-subtle text-sm">
          {a.checklist.map((c) => <p key={c.code} className="px-5 py-1"><span className="font-mono text-xs">{c.code}</span> {c.text} · <Badge tone={c.outcome === 'PASS' ? 'success' : c.outcome === 'FAIL' ? 'danger' : 'neutral'}>{t(tk(`sa.outcome.${c.outcome}`))}</Badge> {c.reviewer ?? ''} {formatDate(c.reviewedAt)}</p>)}
        </Card>
        <Card title={t('sa.admin.scope')} bodyClassName="divide-y divide-border-subtle text-sm">
          {a.scope.map((s) => <p key={s.id} className="px-5 py-1">{s.productName} {s.productVersion} · {s.facilityRef} · {s.countryCode} · {s.channel} · {t(tk(`sa.decision.${s.decision}`))}</p>)}
        </Card>
        <Card title={t('sa.admin.findings')} bodyClassName="divide-y divide-border-subtle text-sm">
          {a.findings.length === 0 && <p className="px-5 py-2 text-ink-muted">—</p>}
          {a.findings.map((f) => <p key={f.id} className="px-5 py-1">{f.number} · {t(tk(`sa.class.${f.classification}`))} · {t(tk(`sa.findingStatus.${f.status}`))} · {formatDate(f.closureDueAt)}{f.overdue ? ` · ${t('sa.admin.overdue')}` : ''} · {f.requirement}</p>)}
        </Card>
        <Card title={t('sa.admin.certification')} bodyClassName="divide-y divide-border-subtle text-sm">
          {a.certifications.map((c) => <p key={c.id} className="px-5 py-1">{c.bodyName} · {c.scheme} · {t(tk(`sa.certStatus.${c.status}`))} · {c.certificateNumber ?? '—'} · {c.expiresOn ?? '—'}</p>)}
        </Card>
        <Card title={t('sa.admin.approvals')} bodyClassName="divide-y divide-border-subtle text-sm">
          {a.approvals.map((ap) => <div key={ap.id} className="px-5 py-2"><p className="font-medium">{ap.number} · {t(tk(`sa.approvalStatus.${ap.status}`))} · {formatDate(ap.validUntil)}</p>{ap.scopes.map((s) => <p key={s.id} className="text-xs">{s.productKey} · {s.countryCode} · {s.channel} · {t(tk(`sa.scopeStatus.${s.status}`))}</p>)}</div>)}
        </Card>
        <Card title={t('sa.admin.evidence')} description={t('sa.admin.evidenceWithheld')} bodyClassName="divide-y divide-border-subtle text-sm">
          {a.evidence.map((e) => (
            <p key={e.id} className="flex flex-wrap items-center gap-2 px-5 py-1">
              <span className="font-mono text-xs">{e.evidenceKey}</span> v{String(e.version)} · {t(tk(`sa.evidenceCategory.${e.category}`))}
              {e.downloadable && e.fileName !== null ? <Button size="sm" variant="ghost" onClick={() => { void downloadFile(`/admin/seller-assessments/${enc(a.id)}/evidence/${enc(e.id)}`, e.fileName ?? 'evidence'); }}>{t('sa.admin.download')}</Button> : <span className="text-xs text-ink-muted">{t('sa.admin.withheld')}</span>}
            </p>
          ))}
        </Card>
        <Card title={t('sa.admin.timeline')} bodyClassName="divide-y divide-border-subtle text-sm">
          {a.timeline.map((e) => <p key={e.id} className="px-5 py-1">{e.kind} · {e.actor ?? '—'}{e.capability !== null ? ` (${e.capability})` : ''} · {formatDateTime(e.at)}</p>)}
        </Card>
      </div>
    </>
  );
}
