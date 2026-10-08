/**
 * Ownership, registrations, exports and screening, on the seller review page
 * (checklist Master row 12).
 *
 * Read with customer.read, like the rest of the page, and read-only: recording
 * a screening is seller verification, which the Audit Team does in the Audit
 * Console (it has its own copy of this panel, with the form).
 *
 * What it is careful about:
 *
 *   - **A screening here is a person's check.** Every row is recorded as
 *     "manual" and the panel says so, above the form and on every result. No
 *     automated screening provider exists in this product, and nothing on this
 *     screen may read as though a machine checked a sanctions list.
 *   - **Approval is gated on evidence**, and the panel lists exactly what the
 *     gate is still waiting for, in the same order the server checks it.
 *   - **Owners are third parties.** Shown to reviewers only; nothing here is
 *     sent to the seller, including the screening results.
 */
import { Badge, Callout, Card, DescriptionList } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { formatDateTime } from '@/lib/format';
import { type SellerKybReview, type SellerScreening } from '@/lib/sellers';

const RESULT_TONE: Record<SellerScreening['state'], BadgeTone> = {
  CLEAR: 'success',
  POTENTIAL_MATCH: 'warning',
  CONFIRMED_MATCH: 'danger',
  PENDING_REVIEW: 'neutral',
};

function percent(points: number): string {
  const whole = Math.floor(points / 100);
  const fraction = points % 100;
  return fraction === 0 ? `${String(whole)}%` : `${String(whole)}.${String(fraction).padStart(2, '0')}%`;
}

export function SellerKybReviewPanel({
  legalName,
  kyb,
}: {
  legalName: string;
  kyb: SellerKybReview;
}): React.JSX.Element {
  const { t } = useI18n();

  const none = t('sellerReview.notGiven');
  const legalForm =
    kyb.legalForm === null ? none : t(`sellerReview.legalForm.${kyb.legalForm}` as TranslationKey, { defaultValue: kyb.legalForm });

  return (
    <div className="space-y-5">
      {/* --- What approval is waiting for -------------------------------- */}
      <Card title={t('sellerReview.readiness.title')}>
        <div className="px-5 py-4">
          {kyb.readiness.ready ? (
            <Callout tone="success" title={t('sellerReview.readiness.ready')}>
              <p className="text-sm">{t('sellerReview.readiness.readyBody')}</p>
            </Callout>
          ) : (
            <>
              <p className="text-sm text-ink">{t('sellerReview.readiness.blocked')}</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink">
                {kyb.readiness.missing.map((item, index) => (
                  <li key={`${item.code}-${item.field ?? ''}-${String(index)}`}>
                    {t(`sellerReview.readiness.${item.code}` as TranslationKey, {
                      name: item.meta?.name ?? (item.field === 'entity' ? legalName : (item.field ?? '')),
                      defaultValue: item.message ?? item.code,
                    })}
                    {(item.code === 'STEP_INCOMPLETE' || item.code.startsWith('DOCUMENT')) && item.message !== undefined && (
                      <span className="text-ink-muted"> — {item.message}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </Card>

      {/* --- Ownership, registrations and exports ------------------------- */}
      <Card title={t('sellerReview.kyb.title')} description={t('sellerReview.kyb.description')}>
        <div className="space-y-4 px-5 py-4">
          <DescriptionList
            items={[
              { label: t('sellerReview.kyb.legalForm'), value: legalForm },
              ...(kyb.registrationNumberName === null
                ? []
                : [{ label: t('sellerReview.kyb.registerNeeded'), value: kyb.registrationNumberName }]),
              ...(kyb.isIndia
                ? [
                    { label: t('sellerReview.kyb.udyam'), value: kyb.udyamNumber ?? none },
                    { label: t('sellerReview.kyb.iec'), value: kyb.iecNumber ?? none },
                  ]
                : []),
              {
                label: t('sellerReview.kyb.exports'),
                value: kyb.exportCapable
                  ? t('sellerReview.kyb.exportsTo', {
                      markets: kyb.exportMarkets.length === 0 ? none : kyb.exportMarkets.join(', '),
                      years: kyb.yearsExporting === null ? none : String(kyb.yearsExporting),
                    })
                  : t('sellerReview.kyb.noExports'),
              },
            ]}
          />

          {kyb.outstanding.length > 0 && (
            <Callout tone="warning" title={t('sellerReview.kyb.outstanding')}>
              <ul className="list-disc pl-5 text-sm">
                {kyb.outstanding.map((gap) => (
                  <li key={gap.code}>{gap.label}</li>
                ))}
              </ul>
            </Callout>
          )}

          {kyb.signals.length > 0 && (
            <Callout tone="warning" title={t('sellerReview.kyb.signals')}>
              <ul className="list-disc pl-5 text-sm">
                {kyb.signals.map((signal) => (
                  <li key={signal}>{t(`sellerReview.signal.${signal}` as TranslationKey, { defaultValue: signal })}</li>
                ))}
              </ul>
            </Callout>
          )}

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">
              {t('sellerReview.kyb.categories')}
            </h3>
            {kyb.intendedCategories.length === 0 ? (
              <p className="mt-1 text-sm text-ink-muted">{t('sellerReview.kyb.noCategories')}</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {kyb.intendedCategories.map((category) => (
                  <li key={category.id} className="min-w-0 text-sm text-ink">
                    <span className="break-words">{category.name}</span>
                    {category.blockedIn.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {category.blockedIn.map((rule) => (
                          <li key={`${category.id}-${rule.countryCode}`} className="text-xs text-warning">
                            {t('sellerReview.kyb.blockedIn', { country: rule.countryCode, reason: rule.reason })}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xxs text-ink-subtle">{t('sellerReview.kyb.categoriesNote')}</p>
          </div>
        </div>
      </Card>

      {/* --- Owners and screening ------------------------------------------ */}
      <Card title={t('sellerReview.screening.title')} description={t('sellerReview.screening.description')}>
        <div className="space-y-4 px-5 py-4">
          <Callout tone="info" title={t('sellerReview.screening.manualTitle')}>
            <p className="text-sm">{t('sellerReview.screening.manualBody')}</p>
            {!kyb.screening.required && <p className="mt-1 text-sm">{t('sellerReview.screening.notRequired')}</p>}
          </Callout>

          <ScreeningSubject
            label={t('sellerReview.screening.entity', { name: legalName })}
            current={kyb.screening.entity}
            subjectType="ENTITY"
          />

          {kyb.beneficialOwners.length === 0 ? (
            <p className="text-sm text-ink-muted">{t('sellerReview.screening.noOwners')}</p>
          ) : (
            <p className="text-sm text-ink-muted">
              {t('sellerReview.screening.ownershipTotal', { percent: percent(kyb.ownershipTotalBasisPoints) })}
            </p>
          )}

          {kyb.beneficialOwners.map((owner) => (
            <ScreeningSubject
              key={owner.id}
              label={owner.fullName}
              detail={[
                percent(owner.ownershipBasisPoints),
                owner.nationality ?? none,
                owner.role ?? null,
                owner.isControllingPerson ? t('sellerReview.screening.controlling') : null,
              ]
                .filter((part): part is string => part !== null)
                .join(' · ')}
              isPoliticallyExposed={owner.isPoliticallyExposed}
              current={owner.screening}
              subjectType="BENEFICIAL_OWNER"
            />
          ))}

          {kyb.screening.history.length > 0 && (
            <details className="rounded-lg border border-border-subtle px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium text-ink">
                {t('sellerReview.screening.history')}
              </summary>
              <ol className="mt-2 space-y-2">
                {kyb.screening.history.map((row) => (
                  <li key={row.id} className="text-xs text-ink-muted">
                    <span className="text-ink">{row.subjectName}</span> —{' '}
                    {t(`sellerReview.result.${row.state}` as TranslationKey)} ·{' '}
                    {t('sellerReview.screening.byManual', {
                      who: row.reviewedBy ?? none,
                      when: formatDateTime(row.reviewedAt),
                    })}
                    {!row.isCurrent && ` · ${t('sellerReview.screening.superseded')}`}
                    {row.listsChecked !== null && <span className="block">{row.listsChecked}</span>}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      </Card>
    </div>
  );
}

function ScreeningSubject({
  label,
  detail,
  isPoliticallyExposed = false,
  current,
  subjectType,
}: {
  label: string;
  detail?: string;
  isPoliticallyExposed?: boolean;
  current: SellerScreening | null;
  subjectType: 'ENTITY' | 'BENEFICIAL_OWNER';
}): React.JSX.Element {
  const { t } = useI18n();
  const stale = current !== null && current.subjectName !== label && subjectType === 'BENEFICIAL_OWNER';

  return (
    <div className="min-w-0 rounded-lg border border-border px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium text-ink">{label}</p>
          {detail !== undefined && <p className="text-xs text-ink-muted">{detail}</p>}
          {isPoliticallyExposed && (
            <p className="mt-1 text-xs font-medium text-warning">{t('sellerReview.screening.pepDeclared')}</p>
          )}
        </div>
        {current === null || stale ? (
          <Badge tone="neutral">{t('sellerReview.screening.notScreened')}</Badge>
        ) : (
          <Badge tone={RESULT_TONE[current.state]}>
            {t(`sellerReview.result.${current.state}` as TranslationKey)}
          </Badge>
        )}
      </div>
      {current !== null && !stale && (
        <p className="mt-1 text-xs text-ink-muted">
          {t('sellerReview.screening.byManual', { who: current.reviewedBy ?? '—', when: formatDateTime(current.reviewedAt) })}
          {current.listsChecked !== null && ` · ${current.listsChecked}`}
        </p>
      )}
    </div>
  );
}

