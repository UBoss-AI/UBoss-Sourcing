/**
 * Seller Hub -> Logistics.
 *
 * The one place a seller sets up how their goods travel, in two parts:
 *
 *   1. Carriers - DHL, FedEx, India Post and a forwarder booked by hand,
 *      switched on for the seller's own levels. With no API account a carrier
 *      is MANUAL_ONLY: booked on its own site, tracking number typed in here.
 *      Nothing on this page can show "Connected" unless the carrier setup
 *      itself says so.
 *   2. Who manages each of the four levels - Self, UBOSS, or Self + UBOSS - and
 *      what each level costs, drawn as one journey from plant to buyer.
 *
 * WHAT THE PAGE DECIDES, AND WHAT IT DOES NOT
 *
 * Which inputs are enabled is a courtesy. Who may price a level is decided by
 * the server on every save: a seller who edits the page's HTML to price a
 * UBOSS-managed level is refused there. So every read-only state here is also
 * explained in words, because the lock is real and a disabled field with no
 * reason reads as a broken page.
 *
 * NOTHING HERE ADDS MONEY UP. The page shows prices as the server returned
 * them, and the settlement preview is calculated by the server too.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useOutletContext } from 'react-router-dom';
import { ConfirmDialog } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { formatDate, formatMoney } from '@/lib/format';
import {
  MANAGED_PROVIDERS,
  SWITCHABLE_LEVELS,
  disableProvider,
  enableProvider,
  fetchPolicy,
  policyKey,
  publishPolicy,
  publishRate,
  deactivateRate,
  savePolicy,
  type ControlMode,
  type ControlOwner,
  type LevelOwners,
  type LevelPricingStatus,
  type LevelView,
  type LogisticsLevel,
  type ManagedProvider,
  type PolicyView,
  type ProviderConnectionState,
  type ProviderView,
  type RateView,
} from '@/lib/seller-logistics';
import { LogisticsRateDialog } from './LogisticsRateDialog';
import { SettlementPreviewCard } from './SettlementPreviewCard';
import type { SellerOutletContext } from './SellerLayout';

const MODES: readonly ControlMode[] = ['SELF', 'UBOSS', 'HYBRID'];

const CONNECTION_TONE: Record<ProviderConnectionState, BadgeTone> = {
  NOT_CONFIGURED: 'neutral',
  CREDENTIALS_REQUIRED: 'warning',
  MANUAL_ONLY: 'brand',
  PENDING_VERIFICATION: 'warning',
  CONNECTED: 'success',
  CONNECTION_FAILED: 'danger',
};

const PRICING_TONE: Record<LevelPricingStatus, BadgeTone> = {
  DRAFT: 'neutral',
  PRICE_REQUIRED: 'warning',
  QUOTE_REQUIRED: 'warning',
  PENDING_UBOSS_PRICE: 'warning',
  READY: 'brand',
  PUBLISHED: 'success',
  INACTIVE: 'neutral',
};

/** The owners each mode means, before the seller chooses anything in HYBRID. */
function ownersFor(mode: ControlMode, hybrid: LevelOwners): LevelOwners {
  if (mode === 'SELF') return { L1: 'SELLER', L2: 'SELLER', L3: 'SELLER', L4: 'SELLER' };
  if (mode === 'UBOSS') return { L1: 'SELLER', L2: 'UBOSS', L3: 'UBOSS', L4: 'UBOSS' };
  return { ...hybrid, L1: 'SELLER' };
}

function sameOwners(a: LevelOwners, b: LevelOwners): boolean {
  return SWITCHABLE_LEVELS.every((level) => a[level] === b[level]);
}

export function SellerLogisticsPage(): React.JSX.Element {
  const { t } = useI18n();
  const seller = useOutletContext<SellerOutletContext>();
  const query = useQuery({ queryKey: policyKey, queryFn: fetchPolicy });

  const isEditable = seller.status !== 'SUSPENDED' && seller.status !== 'REJECTED';

  return (
    <div className="space-y-6">
      <PageHeader title={t('sellerLogistics.pageTitle')} description={t('sellerLogistics.pageDescription')} />

      {query.isPending && (
        <Card>
          <div className="px-6 py-5">
            <LoadingState label={t('sellerLogistics.loading')} />
          </div>
        </Card>
      )}

      {query.isError && (
        <Card>
          <div className="px-6 py-5">
            <ErrorState
              error={query.error}
              onRetry={() => {
                void query.refetch();
              }}
            />
          </div>
        </Card>
      )}

      {query.data !== undefined && <PolicyEditor policy={query.data.policy} isEditable={isEditable} />}
    </div>
  );
}

function PolicyEditor({ policy, isEditable }: { policy: PolicyView; isEditable: boolean }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  /*
   * The tab being looked at and the Self + UBOSS choices, held locally until
   * saved. Seeded from the DRAFT, which is what the server will publish.
   */
  const [mode, setMode] = useState<ControlMode>(policy.draft.mode);
  const [hybridOwners, setHybridOwners] = useState<LevelOwners>(
    policy.draft.mode === 'HYBRID' ? policy.draft.owners : { L1: 'SELLER', L2: 'SELLER', L3: 'UBOSS', L4: 'SELLER' },
  );
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [editing, setEditing] = useState<{ level: LogisticsLevel; rate: RateView | null } | null>(null);

  const owners = ownersFor(mode, hybridOwners);
  const draftChanged = mode !== policy.draft.mode || !sameOwners(owners, policy.draft.owners);
  const changesPublished =
    policy.active !== null && (mode !== policy.active.mode || !sameOwners(owners, policy.active.owners));

  function refresh(next?: PolicyView): void {
    if (next !== undefined) client.setQueryData(policyKey, { policy: next });
    void client.invalidateQueries({ queryKey: policyKey });
  }

  const save = useMutation({
    mutationFn: (confirmOwnershipChange: boolean) =>
      savePolicy({
        mode,
        ...(mode === 'HYBRID' ? { l2Owner: owners.L2, l3Owner: owners.L3, l4Owner: owners.L4 } : {}),
        expectedVersion: policy.draft.version,
        confirmOwnershipChange,
      }),
    onSuccess: (result) => {
      setConfirmSave(false);
      toast.success(t('sellerLogistics.saved'));
      refresh(result.policy);
    },
    onError: (error: unknown) => {
      setConfirmSave(false);
      toast.error(errorMessage(t, error, t('sellerLogistics.saveFailed')));
    },
  });

  const publish = useMutation({
    mutationFn: () => publishPolicy({ confirmOwnershipChange: true }),
    onSuccess: (result) => {
      setConfirmPublish(false);
      toast.success(t('sellerLogistics.published', { version: String(result.policy.active?.versionNumber ?? '') }));
      refresh(result.policy);
    },
    onError: (error: unknown) => {
      setConfirmPublish(false);
      toast.error(errorMessage(t, error, t('sellerLogistics.publishFailed')));
    },
  });

  const rateAction = useMutation({
    mutationFn: (input: { rateId: string; action: 'publish' | 'deactivate' }) =>
      input.action === 'publish' ? publishRate(input.rateId) : deactivateRate(input.rateId),
    onSuccess: (_result, input) => {
      toast.success(t(input.action === 'publish' ? 'sellerLogistics.ratePublished' : 'sellerLogistics.rateDeactivated'));
      refresh();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerLogistics.rateFailed')));
    },
  });

  function requestSave(): void {
    if (changesPublished) setConfirmSave(true);
    else save.mutate(false);
  }

  const hybridSellerCount = SWITCHABLE_LEVELS.filter((level) => hybridOwners[level] === 'SELLER').length;
  const levelsByKey = new Map(policy.levels.map((level) => [level.level, level]));

  return (
    <>
      <ProvidersCard providers={policy.providers} isEditable={isEditable} onChanged={() => { refresh(); }} />

      <Card title={t('sellerLogistics.controlTitle')} description={t('sellerLogistics.controlBody')}>
        <div className="space-y-5 px-6 pb-6">
          <PublishedSummary policy={policy} />

          {/* --- The three tabs ------------------------------------------ */}
          <div role="tablist" aria-label={t('sellerLogistics.controlTitle')} className="flex flex-wrap gap-2">
            {MODES.map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="tab"
                id={`logistics-mode-${candidate}`}
                aria-selected={mode === candidate}
                aria-controls="logistics-mode-panel"
                disabled={!isEditable}
                onClick={() => {
                  setMode(candidate);
                }}
                className={cx(
                  'rounded-md border px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                  mode === candidate
                    ? 'border-brand bg-brand-soft text-brand'
                    : 'border-border bg-surface text-ink hover:border-border-strong',
                  !isEditable && 'cursor-not-allowed opacity-60',
                )}
              >
                {t(`sellerLogistics.mode.${candidate}`)}
                {policy.active?.mode === candidate && (
                  <span className="ml-2 text-xs font-normal text-ink-muted">{t('sellerLogistics.inForce')}</span>
                )}
              </button>
            ))}
          </div>

          <div id="logistics-mode-panel" role="tabpanel" aria-labelledby={`logistics-mode-${mode}`} className="space-y-4">
            <p className="text-sm leading-relaxed text-ink-muted">{t(`sellerLogistics.modeBody.${mode}`)}</p>

            {/* --- The journey ------------------------------------------- */}
            <ol className="relative space-y-4" aria-label={t('sellerLogistics.journeyLabel')}>
              {(['L1', 'L2', 'L3', 'L4'] as const).map((level, index) => {
                const view = levelsByKey.get(level);
                if (view === undefined) return null;
                const owner: ControlOwner = owners[level];
                const lastSellerLevel =
                  mode === 'HYBRID' && level !== 'L1' && owner === 'UBOSS' && hybridSellerCount >= 2;
                return (
                  <li key={level} className="relative">
                    {index < 3 && (
                      <span aria-hidden="true" className="absolute left-5 top-full h-4 w-px bg-border-strong" />
                    )}
                    <LevelCard
                      view={view}
                      owner={owner}
                      mode={mode}
                      isEditable={isEditable}
                      savedOwner={policy.draft.owners[level]}
                      hybridLocked={lastSellerLevel}
                      onToggleManage={(manage) => {
                        setHybridOwners((current) => ({ ...current, [level]: manage ? 'SELLER' : 'UBOSS' }));
                      }}
                      onAddPrice={() => {
                        setEditing({ level, rate: null });
                      }}
                      onEditPrice={(rate) => {
                        setEditing({ level, rate });
                      }}
                      onRateAction={(rateId, action) => {
                        rateAction.mutate({ rateId, action });
                      }}
                      isWorking={rateAction.isPending}
                    />
                  </li>
                );
              })}
            </ol>

            {!policy.routesCanBeOffered && (
              <p role="status" className="rounded-md border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning">
                {t('sellerLogistics.completePricing')}
              </p>
            )}
          </div>

          {/* --- Save and publish ----------------------------------------- */}
          <div className="flex flex-col gap-3 border-t border-border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-ink-muted" aria-live="polite">
              {draftChanged
                ? t('sellerLogistics.unsavedChanges')
                : policy.hasUnpublishedChanges
                  ? t('sellerLogistics.draftNotPublished')
                  : t('sellerLogistics.upToDate')}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={!isEditable || !draftChanged} isLoading={save.isPending} onClick={requestSave}>
                {t('sellerLogistics.saveDraft')}
              </Button>
              <Button
                variant="primary"
                disabled={!isEditable || draftChanged || !policy.hasUnpublishedChanges}
                isLoading={publish.isPending}
                onClick={() => {
                  if (policy.active === null) publish.mutate();
                  else setConfirmPublish(true);
                }}
              >
                {t('sellerLogistics.publish')}
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <SettlementPreviewCard currency={policy.settlementCurrency} />

      <ConfirmDialog
        isOpen={confirmSave}
        onClose={() => {
          setConfirmSave(false);
        }}
        onConfirm={() => {
          save.mutate(true);
        }}
        title={t('sellerLogistics.confirmChangeTitle')}
        body={t('sellerLogistics.confirmChangeBody')}
        confirmLabel={t('sellerLogistics.confirmChange')}
        isWorking={save.isPending}
      />

      <ConfirmDialog
        isOpen={confirmPublish}
        onClose={() => {
          setConfirmPublish(false);
        }}
        onConfirm={() => {
          publish.mutate();
        }}
        title={t('sellerLogistics.confirmPublishTitle')}
        body={t('sellerLogistics.confirmPublishBody')}
        confirmLabel={t('sellerLogistics.publish')}
        isWorking={publish.isPending}
      />

      {editing !== null && (
        <LogisticsRateDialog
          level={editing.level}
          rate={editing.rate}
          policy={policy}
          onClose={() => {
            setEditing(null);
          }}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </>
  );
}

function PublishedSummary({ policy }: { policy: PolicyView }): React.JSX.Element {
  const { t } = useI18n();
  if (policy.active === null) {
    return <p className="text-sm text-ink-muted">{t('sellerLogistics.notPublishedYet')}</p>;
  }
  return (
    <p className="text-sm text-ink-muted">
      {t('sellerLogistics.activeSummary', {
        mode: t(`sellerLogistics.mode.${policy.active.mode}`),
        version: String(policy.active.versionNumber),
      })}
    </p>
  );
}

// --- Carriers -----------------------------------------------------------------

function ProvidersCard({
  providers,
  isEditable,
  onChanged,
}: {
  providers: ProviderView[];
  isEditable: boolean;
  onChanged: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();

  const toggle = useMutation({
    mutationFn: (input: { provider: ManagedProvider; enable: boolean }) =>
      input.enable ? enableProvider(input.provider, 'MANUAL_ONLY') : disableProvider(input.provider),
    onSuccess: () => {
      toast.success(t('sellerLogistics.providerChanged'));
      onChanged();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerLogistics.providerFailed')));
    },
  });

  return (
    <Card title={t('sellerLogistics.providersTitle')} description={t('sellerLogistics.providersBody')}>
      <ul className="grid gap-3 px-6 pb-6 sm:grid-cols-2">
        {MANAGED_PROVIDERS.map((key) => {
          const provider = providers.find((row) => row.provider === key);
          if (provider === undefined) return null;
          return (
            <li key={key} className="rounded-lg border border-border-subtle bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">{t(`sellerLogistics.provider.${key}.name`)}</p>
                  <p className="mt-1 text-xs leading-relaxed text-ink-muted">{t(`sellerLogistics.provider.${key}.body`)}</p>
                </div>
                <Badge tone={CONNECTION_TONE[provider.connectionState]}>
                  {t(`sellerLogistics.connection.${provider.connectionState}`)}
                </Badge>
              </div>
              <p className="mt-2 text-xs text-ink-muted">
                {t('sellerLogistics.providerModes', {
                  modes: provider.transportModes.map((mode) => t(`sellerLogistics.transport.${mode}`)).join(', '),
                })}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant={provider.enabled ? 'secondary' : 'primary'}
                  disabled={!isEditable}
                  isLoading={toggle.isPending && toggle.variables.provider === key}
                  onClick={() => {
                    toggle.mutate({ provider: key, enable: !provider.enabled });
                  }}
                >
                  {provider.enabled ? t('sellerLogistics.switchOff') : t('sellerLogistics.useManually')}
                </Button>
                {provider.hasVerifiedApi && (
                  <Link to="/seller/fulfilment" className="text-xs font-medium text-brand underline-offset-2 hover:underline">
                    {t('sellerLogistics.connectApi')}
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="px-6 pb-6 text-xs leading-relaxed text-ink-muted">{t('sellerLogistics.providersHonesty')}</p>
    </Card>
  );
}

// --- One level ----------------------------------------------------------------

function LevelCard({
  view,
  owner,
  mode,
  isEditable,
  savedOwner,
  hybridLocked,
  onToggleManage,
  onAddPrice,
  onEditPrice,
  onRateAction,
  isWorking,
}: {
  view: LevelView;
  owner: ControlOwner;
  mode: ControlMode;
  isEditable: boolean;
  savedOwner: ControlOwner;
  hybridLocked: boolean;
  onToggleManage: (manage: boolean) => void;
  onAddPrice: () => void;
  onEditPrice: (rate: RateView) => void;
  onRateAction: (rateId: string, action: 'publish' | 'deactivate') => void;
  isWorking: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const level = view.level;
  // Prices can be edited for the owner the SERVER holds in the draft - an
  // unsaved tick does not give the seller the level yet.
  const sellerMayPrice = isEditable && savedOwner === 'SELLER';
  const rates = useMemo(() => view.rates.filter((rate) => rate.owner === owner || rate.status === 'PUBLISHED'), [view.rates, owner]);
  const checkboxId = `manage-${level}`;

  return (
    <article
      aria-labelledby={`level-${level}-title`}
      className={cx(
        'rounded-lg border p-5 shadow-sm',
        owner === 'SELLER' ? 'border-border bg-surface' : 'border-dashed border-border-strong bg-surface-sunken',
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden="true"
            className={cx(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold',
              owner === 'SELLER' ? 'bg-brand text-ink-inverse' : 'bg-ink-muted text-ink-inverse',
            )}
          >
            {level}
          </span>
          <div className="min-w-0">
            <h3 id={`level-${level}-title`} className="text-base font-semibold text-ink">
              {t(`sellerLogistics.level.${level}.name`)}
            </h3>
            <p className="mt-0.5 text-sm text-ink-muted">{t(`sellerLogistics.level.${level}.route`)}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone={owner === 'SELLER' ? 'brand' : 'operational'}>
            {owner === 'SELLER' ? t('sellerLogistics.sellerManaged') : t('sellerLogistics.ubossManaged')}
          </Badge>
          <Badge tone={PRICING_TONE[owner === savedOwner ? view.pricingStatus : owner === 'UBOSS' ? 'PENDING_UBOSS_PRICE' : 'PRICE_REQUIRED']}>
            {t(`sellerLogistics.pricing.${owner === savedOwner ? view.pricingStatus : owner === 'UBOSS' ? 'PENDING_UBOSS_PRICE' : 'PRICE_REQUIRED'}`)}
          </Badge>
        </div>
      </header>

      {/* L1 is the seller's in every mode, and says so. */}
      {level === 'L1' && <p className="mt-3 text-xs text-ink-muted">{t('sellerLogistics.l1Fixed')}</p>}

      {mode === 'HYBRID' && level !== 'L1' && (
        <div className="mt-3 rounded-md bg-surface-sunken px-3 py-2">
          <div className="flex items-center gap-2">
            <input
              id={checkboxId}
              type="checkbox"
              className="h-4 w-4 rounded border-border-strong text-brand focus-visible:ring-2 focus-visible:ring-brand"
              checked={owner === 'SELLER'}
              disabled={!isEditable || hybridLocked}
              aria-describedby={`${checkboxId}-hint`}
              onChange={(event) => {
                onToggleManage(event.target.checked);
              }}
            />
            <label htmlFor={checkboxId} className="text-sm font-medium text-ink">
              {t('sellerLogistics.manageThisLevel')}
            </label>
          </div>
          <p id={`${checkboxId}-hint`} className="mt-1 text-xs text-ink-muted">
            {hybridLocked
              ? t('sellerLogistics.hybridNotAll')
              : owner === 'SELLER'
                ? t('sellerLogistics.checkedMeans')
                : t('sellerLogistics.uncheckedMeans')}
          </p>
        </div>
      )}

      {view.warnings.length > 0 && owner === savedOwner && (
        <ul className="mt-3 space-y-1">
          {view.warnings.map((warning) => (
            <li key={warning} className="text-xs text-warning">
              {t(`sellerLogistics.warning.${warning}` as TranslationKey)}
            </li>
          ))}
        </ul>
      )}

      {/* --- Prices --------------------------------------------------------- */}
      <div className="mt-4 space-y-2">
        {rates.length === 0 ? (
          <p className="text-sm text-ink-muted">
            {owner === 'UBOSS' ? t('sellerLogistics.noUbossPrice') : t('sellerLogistics.noPriceYet')}
          </p>
        ) : (
          <ul className="divide-y divide-border-subtle rounded-md border border-border-subtle">
            {rates.map((rate) => (
              <RateRow
                key={rate.id}
                rate={rate}
                canEdit={sellerMayPrice && rate.owner === 'SELLER'}
                onEdit={() => {
                  onEditPrice(rate);
                }}
                onAction={(action) => {
                  onRateAction(rate.id, action);
                }}
                isWorking={isWorking}
              />
            ))}
          </ul>
        )}

        {owner === 'SELLER' ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="sm" variant="secondary" disabled={!sellerMayPrice} onClick={onAddPrice}>
              {t('sellerLogistics.addPrice')}
            </Button>
            {!sellerMayPrice && isEditable && (
              <span className="text-xs text-ink-muted">{t('sellerLogistics.saveToPrice')}</span>
            )}
          </div>
        ) : (
          <p className="text-xs text-ink-muted">{t('sellerLogistics.ubossReadOnly')}</p>
        )}
      </div>
    </article>
  );
}

function RateRow({
  rate,
  canEdit,
  onEdit,
  onAction,
  isWorking,
}: {
  rate: RateView;
  canEdit: boolean;
  onEdit: () => void;
  onAction: (action: 'publish' | 'deactivate') => void;
  isWorking: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const route = describeRoute(rate);
  const carrier = rate.providerLabel ?? rate.logisticsPartnerName ?? (rate.provider === null ? null : t(`sellerLogistics.provider.${rate.provider}.name`));

  return (
    <li className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium text-ink">{route}</p>
        <p className="text-xs text-ink-muted">
          {[
            t(`sellerLogistics.transport.${rate.transportMode}`),
            carrier,
            rate.transitDaysMin !== null && rate.transitDaysMax !== null
              ? t('sellerLogistics.transitDays', { min: String(rate.transitDaysMin), max: String(rate.transitDaysMax) })
              : null,
          ]
            .filter((part): part is string => part !== null && part !== '')
            .join(' · ')}
        </p>
        <p className="text-xs text-ink-muted">
          {t('sellerLogistics.priceMeta', {
            source: t(`sellerLogistics.priceSource.${rate.priceSource}` as TranslationKey),
            from: formatDate(rate.effectiveFrom),
            who: rate.updatedBy.role === 'UBOSS' ? 'UBOSS' : (rate.updatedBy.label ?? t('sellerLogistics.you')),
            when: formatDate(rate.updatedAt),
          })}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-ink">
          {rate.isFree ? t('sellerLogistics.free') : rate.price === null ? t('sellerLogistics.notPriced') : formatMoney(rate.price)}
          {rate.price !== null && !rate.isFree && (
            <span className="ml-1 text-xs font-normal text-ink-muted">
              {rate.taxInclusive ? t('sellerLogistics.taxInclusive') : t('sellerLogistics.taxExclusive')}
            </span>
          )}
        </span>
        <Badge tone={rate.status === 'PUBLISHED' ? 'success' : rate.status === 'DRAFT' ? 'neutral' : 'neutral'}>
          {t(`sellerLogistics.rateStatus.${rate.status}`)}
        </Badge>
        {canEdit && rate.status !== 'INACTIVE' && (
          <Button size="sm" variant="ghost" onClick={onEdit}>
            {rate.status === 'PUBLISHED' ? t('sellerLogistics.changePrice') : t('common.edit')}
          </Button>
        )}
        {canEdit && rate.status === 'DRAFT' && (
          <Button
            size="sm"
            variant="primary"
            disabled={!rate.isComplete || isWorking}
            title={rate.isComplete ? undefined : t('sellerLogistics.rateIncomplete')}
            onClick={() => {
              onAction('publish');
            }}
          >
            {t('sellerLogistics.publishPrice')}
          </Button>
        )}
        {canEdit && rate.status === 'PUBLISHED' && (
          <Button
            size="sm"
            variant="ghost"
            disabled={isWorking}
            onClick={() => {
              onAction('deactivate');
            }}
          >
            {t('sellerLogistics.switchOff')}
          </Button>
        )}
      </div>
    </li>
  );
}

/** "Mumbai plant -> INNSA", "INNSA -> NLRTM (NL)", ... from the fields a level uses. */
function describeRoute(rate: RateView): string {
  const arrow = ' → ';
  const destination =
    rate.destinationCountry === null
      ? rate.isWorldwideFlat
        ? '🌐'
        : '—'
      : `${rate.destinationCountry}${rate.destinationPostalPrefix === '' ? '' : ` ${rate.destinationPostalPrefix}*`}`;
  switch (rate.level) {
    case 'L1':
      return `${rate.originLocationName ?? '*'}${arrow}${rate.originPortCode ?? '*'}`;
    case 'L2':
      return `${rate.originPortCode ?? '*'}${arrow}${rate.destinationPortCode ?? '*'} (${destination})`;
    case 'L3':
      return `${rate.destinationPortCode ?? '*'}${arrow}${rate.destinationHubName ?? rate.destinationHubCode ?? '*'} (${destination})`;
    case 'L4':
      return `${rate.destinationHubName ?? rate.destinationHubCode ?? '*'}${arrow}${destination}`;
  }
}
