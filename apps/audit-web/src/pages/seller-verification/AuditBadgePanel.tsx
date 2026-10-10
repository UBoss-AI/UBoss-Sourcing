/**
 * The seller's Audit badge and Seller Verification Certificates, on the
 * Seller Verify page.
 *
 * The badge (Platinum, Gold, Silver, Bronze or none) decides only whether a
 * shipment may be OFFERED a waiver; an auditor still decides each one. Only a
 * supervisor sets it, with a reason. A certificate is issued after the final
 * verification approval, with an explicit scope; its review date follows the
 * platform policy and never passes the first expiry of the evidence.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DownloadButton, MutationError } from '@/components/console';
import { Badge, Button, Callout, Card, Field, Input, Select, Textarea } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { assessmentKeys, BADGE_TIERS, certificatePath, fetchBadge, fetchCertificates, issueCertificate, setBadge, type BadgeTier } from '@/lib/shipment-assessment';
import { useConsoleMutation } from '@/lib/use-console-mutation';

const list = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');

export function AuditBadgePanel({ sellerAccountId, approved }: { sellerAccountId: string; approved: boolean }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const badge = useQuery({ queryKey: assessmentKeys.badge(sellerAccountId), queryFn: () => fetchBadge(sellerAccountId) });
  const certificates = useQuery({ queryKey: assessmentKeys.certificates(sellerAccountId), queryFn: () => fetchCertificates(sellerAccountId) });
  const [tier, setTier] = useState<BadgeTier | ''>('');
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState({ categories: '', markets: '', scopeNote: '' });

  const change = useConsoleMutation({
    mutationFn: (_vars, key) => setBadge(sellerAccountId, { tier: tier === '' ? null : tier, reason, expectedVersion: badge.data?.version ?? 0 }, key),
    invalidate: [assessmentKeys.badge(sellerAccountId), assessmentKeys.all],
    successMessage: t('shipmentAssessment.saved'),
    onSuccess: () => {
      setReason('');
    },
  });
  const issue = useConsoleMutation({
    mutationFn: (_vars, key) => issueCertificate(sellerAccountId, { categories: list(scope.categories), markets: list(scope.markets), scopeNote: scope.scopeNote, siteLocationId: null }, key),
    invalidate: [assessmentKeys.certificates(sellerAccountId)],
    successMessage: t('shipmentAssessment.saved'),
  });

  return (
    <Card title={t('shipmentAssessment.badgePanel.title')} description={t('shipmentAssessment.badgePanel.description')} bodyClassName="space-y-4 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>{t('shipmentAssessment.badgePanel.current')}</span>
        <Badge tone="brand">{t(`shipmentAssessment.badge.${badge.data?.badge ?? 'NONE'}` as TranslationKey)}</Badge>
        {badge.data?.setAt != null && <span className="text-ink-muted">{formatDateTime(badge.data.setAt)}</span>}
      </div>
      {can(Permission.SELLER_BADGE) && (
        <div className="grid gap-3 sm:grid-cols-[12rem_1fr_auto] sm:items-end">
          <Field label={t('shipmentAssessment.badgePanel.newBadge')}>
            {({ inputId }) => (
              <Select
                id={inputId}
                value={tier}
                onChange={(event) => {
                  setTier(event.target.value as BadgeTier | '');
                }}
              >
                <option value="">{t('shipmentAssessment.badge.NONE')}</option>
                {BADGE_TIERS.map((value) => (
                  <option key={value} value={value}>
                    {t(`shipmentAssessment.badge.${value}` as TranslationKey)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('shipmentAssessment.reason')}>
            {({ inputId }) => (
              <Input
                id={inputId}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            )}
          </Field>
          <Button
            disabled={change.isPending || reason.trim().length < 10}
            onClick={() => {
              change.mutate();
            }}
          >
            {t('shipmentAssessment.badgePanel.save')}
          </Button>
        </div>
      )}
      <MutationError error={change.error} />
      {(badge.data?.history ?? []).length > 0 && (
        <ul className="space-y-1 text-xs text-ink-muted">
          {(badge.data?.history ?? []).map((row) => (
            <li key={row.at}>
              {formatDateTime(row.at)} · {t(`shipmentAssessment.badge.${row.fromTier ?? 'NONE'}` as TranslationKey)} → {t(`shipmentAssessment.badge.${row.toTier ?? 'NONE'}` as TranslationKey)} · {row.changedBy ?? '—'} · {row.reason}
            </li>
          ))}
        </ul>
      )}

      <h3 className="pt-2 text-sm font-semibold">{t('shipmentAssessment.certificates.title')}</h3>
      {(certificates.data?.certificates ?? []).map((doc) => (
        <div key={doc.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>
            {doc.number} · v{String(doc.version)} · {t(`shipmentAssessment.docStatus.${doc.status}` as TranslationKey)} · {t('shipmentAssessment.certificates.reviewDue', { date: formatDateTime(doc.validUntil) })}
          </span>
          <DownloadButton path={certificatePath(sellerAccountId, doc.id)} fileName={`${doc.number}.pdf`} />
        </div>
      ))}
      {!approved && <Callout tone="info">{t('shipmentAssessment.certificates.needsApproval')}</Callout>}
      {approved && can(Permission.CERTIFICATE_ISSUE) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('shipmentAssessment.certificates.categories')} hint={t('shipmentAssessment.certificates.commaHint')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                value={scope.categories}
                onChange={(event) => {
                  setScope({ ...scope, categories: event.target.value });
                }}
              />
            )}
          </Field>
          <Field label={t('shipmentAssessment.certificates.markets')} hint={t('shipmentAssessment.certificates.commaHint')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                value={scope.markets}
                onChange={(event) => {
                  setScope({ ...scope, markets: event.target.value });
                }}
              />
            )}
          </Field>
          <Field label={t('shipmentAssessment.certificates.scope')} required>
            {({ inputId }) => (
              <Textarea
                id={inputId}
                value={scope.scopeNote}
                onChange={(event) => {
                  setScope({ ...scope, scopeNote: event.target.value });
                }}
              />
            )}
          </Field>
          <div className="sm:col-span-2">
            <Button
              variant="primary"
              disabled={issue.isPending || list(scope.categories).length === 0 || list(scope.markets).length === 0 || scope.scopeNote.trim().length < 10}
              onClick={() => {
                issue.mutate();
              }}
            >
              {t('shipmentAssessment.certificates.issue')}
            </Button>
            <MutationError error={issue.error} />
          </div>
        </div>
      )}
    </Card>
  );
}
