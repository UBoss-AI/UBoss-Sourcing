/**
 * Ownership, registrations, exports and screening, on the seller review page
 * (checklist Master row 12).
 *
 * The Audit Panel's copy of the Admin Panel's panel: the same view, plus the
 * screening form. Read with audit.seller.read; recording a screening needs
 * audit.seller.verify - the same people who decide the application. The Admin
 * Panel's copy is read-only.
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
import { useState } from 'react';
import { useSession } from '@/auth/session-context';
import { MutationError } from '@/components/console';
import { Badge, Button, Callout, Card, DescriptionList, Field, Select, Textarea } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import {
  recordScreening,
  verificationKeys,
  type ScreeningResult,
  type SellerKybReview,
  type SellerScreening,
} from '@/lib/seller-verification';
import { useConsoleMutation } from '@/lib/use-console-mutation';

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

export function KybReviewPanel({
  sellerAccountId,
  legalName,
  kyb,
}: {
  sellerAccountId: string;
  legalName: string;
  kyb: SellerKybReview;
}): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const canScreen = can(Permission.SELLER_VERIFY);

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
            canScreen={canScreen}
            sellerAccountId={sellerAccountId}
            subjectType="ENTITY"
            beneficialOwnerId={null}
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
              canScreen={canScreen}
              sellerAccountId={sellerAccountId}
              subjectType="BENEFICIAL_OWNER"
              beneficialOwnerId={owner.id}
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
  canScreen,
  sellerAccountId,
  subjectType,
  beneficialOwnerId,
}: {
  label: string;
  detail?: string;
  isPoliticallyExposed?: boolean;
  current: SellerScreening | null;
  canScreen: boolean;
  sellerAccountId: string;
  subjectType: 'ENTITY' | 'BENEFICIAL_OWNER';
  beneficialOwnerId: string | null;
}): React.JSX.Element {
  const { t } = useI18n();
  const [isOpen, setOpen] = useState(false);
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
      {canScreen && !isOpen && (
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => {
            setOpen(true);
          }}
        >
          {t('sellerReview.screening.record')}
        </Button>
      )}
      {canScreen && isOpen && (
        <ScreeningForm
          sellerAccountId={sellerAccountId}
          subjectType={subjectType}
          beneficialOwnerId={beneficialOwnerId}
          onDone={() => {
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function ScreeningForm({
  sellerAccountId,
  subjectType,
  beneficialOwnerId,
  onDone,
}: {
  sellerAccountId: string;
  subjectType: 'ENTITY' | 'BENEFICIAL_OWNER';
  beneficialOwnerId: string | null;
  onDone: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [result, setResult] = useState<ScreeningResult | ''>('');
  const [lists, setLists] = useState('');
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);

  const mutation = useConsoleMutation({
    mutationFn: (_: undefined, key) =>
      recordScreening(
        sellerAccountId,
        {
          subjectType,
          beneficialOwnerId,
          result: result as ScreeningResult,
          listsChecked: lists.trim(),
          note: note.trim().length === 0 ? null : note.trim(),
        },
        key,
      ),
    invalidate: [verificationKeys.detail(sellerAccountId)],
    successMessage: t('sellerReview.screening.recorded'),
    onSuccess: onDone,
  });

  const resultError = tried && result === '' ? t('sellerReview.screening.resultRequired') : undefined;
  const listsError = tried && lists.trim().length < 2 ? t('sellerReview.screening.listsRequired') : undefined;

  return (
    <form
      className="mt-3 space-y-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setTried(true);
        if (result === '' || lists.trim().length < 2) return;
        mutation.mutate(undefined);
      }}
    >
      <Field label={t('sellerReview.screening.result')} error={resultError} required>
        {({ inputId, describedBy }) => (
          <Select
            id={inputId}
            aria-describedby={describedBy}
            invalid={resultError !== undefined}
            value={result}
            onChange={(event) => {
              setResult(event.target.value as ScreeningResult | '');
            }}
          >
            <option value="">{t('sellerReview.screening.chooseResult')}</option>
            <option value="CLEAR">{t('sellerReview.result.CLEAR')}</option>
            <option value="POTENTIAL_MATCH">{t('sellerReview.result.POTENTIAL_MATCH')}</option>
            <option value="CONFIRMED_MATCH">{t('sellerReview.result.CONFIRMED_MATCH')}</option>
          </Select>
        )}
      </Field>
      <Field label={t('sellerReview.screening.lists')} hint={t('sellerReview.screening.listsHint')} error={listsError} required>
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            invalid={listsError !== undefined}
            maxLength={512}
            rows={2}
            value={lists}
            onChange={(event) => {
              setLists(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label={t('sellerReview.screening.note')}>
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            maxLength={4000}
            rows={2}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        )}
      </Field>
      {mutation.isError && <MutationError error={mutation.error} />}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" size="sm" isLoading={mutation.isPending}>
          {t('sellerReview.screening.save')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
