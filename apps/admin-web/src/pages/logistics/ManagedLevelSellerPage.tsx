/**
 * One seller's four delivery levels, from the marketplace's side.
 *
 * Every level is shown. The levels the seller controls are read-only here -
 * their carrier and price are the seller's - and the levels UBOSS controls are
 * where the desk chooses the carrier, enters the price and publishes it. The
 * server refuses a UBOSS price on a seller-controlled level whatever this page
 * shows, so a read-only level also says why it is read-only.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, CheckboxField, ErrorState, Field, Input, LoadingState, PageHeader, Select } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { currencyExponent, formatDateTime, formatMoney, majorToMinor, minorToMajor } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import {
  LEVEL_MODES,
  createUbossRate,
  deactivateUbossRate,
  fetchManagedSeller,
  publishUbossRate,
  updateUbossRate,
  type LevelView,
  type LogisticsLevel,
  type PolicyView,
  type RateView,
  type TransportMode,
  type UbossRateInput,
} from '@/lib/logistics-levels';

export function ManagedLevelSellerPage(): React.JSX.Element {
  const { t } = useI18n();
  const { sellerAccountId = '' } = useParams();
  const query = useQuery({ queryKey: ['admin', 'managed-levels', 'seller', sellerAccountId], queryFn: () => fetchManagedSeller(sellerAccountId) });
  const [editing, setEditing] = useState<{ level: LogisticsLevel; rate: RateView | null } | null>(null);

  if (query.isPending) return <LoadingState label={t('levels.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const { policy, history, marketplaceCarriers } = query.data;

  return (
    <div className="space-y-5">
      <PageHeader
        title={policy.sellerName}
        description={t('levels.sellerIntro')}
        back={{ to: '/logistics/managed-levels', label: t('levels.heading') }}
        meta={
          policy.active === null ? (
            <Badge tone="neutral">{t('levels.notPublished')}</Badge>
          ) : (
            <Badge tone="brand">
              {t(`levels.mode.${policy.active.mode}`)} · v{policy.active.versionNumber}
            </Badge>
          )
        }
      />

      {!policy.routesCanBeOffered && policy.active !== null && (
        <Callout tone="warning" role="status">
          {t('levels.cannotOffer')}
        </Callout>
      )}

      <ol className="space-y-4">
        {policy.levels.map((level) => (
          <li key={level.level}>
            <LevelPanel
              level={level}
              policy={policy}
              onAdd={() => {
                setEditing({ level: level.level, rate: null });
              }}
              onEdit={(rate) => {
                setEditing({ level: level.level, rate });
              }}
            />
          </li>
        ))}
      </ol>

      <Card title={t('levels.historyTitle')}>
        <ul className="divide-y divide-border-subtle">
          {history.events.length === 0 && <li className="px-5 py-4 text-sm text-ink-muted">{t('levels.historyEmpty')}</li>}
          {history.events.map((event) => (
            <li key={event.id} className="px-5 py-3 text-sm">
              <p className="text-ink">{event.summary ?? event.action}</p>
              <p className="text-xxs text-ink-subtle">
                {formatDateTime(event.createdAt)} · {event.actorLabel ?? event.actorType}
              </p>
            </li>
          ))}
        </ul>
      </Card>

      {editing !== null && (
        <UbossRateDialog
          sellerAccountId={sellerAccountId}
          level={editing.level}
          rate={editing.rate}
          currency={policy.settlementCurrency}
          carriers={marketplaceCarriers}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function LevelPanel({
  level,
  policy,
  onAdd,
  onEdit,
}: {
  level: LevelView;
  policy: PolicyView;
  onAdd: () => void;
  onEdit: (rate: RateView) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const { can } = useSession();
  const inForce = policy.active?.owners[level.level] ?? level.owner;
  const ubossControls = level.level !== 'L1' && (level.owner === 'UBOSS' || inForce === 'UBOSS');
  const mayPrice = ubossControls && can(Permission.LOGISTICS_WRITE);

  const action = useMutation({
    mutationFn: (input: { rateId: string; kind: 'publish' | 'deactivate' }) =>
      input.kind === 'publish' ? publishUbossRate(input.rateId) : deactivateUbossRate(input.rateId),
    onSuccess: () => {
      toast.success(t('levels.rateUpdated'));
      void client.invalidateQueries({ queryKey: ['admin', 'managed-levels'] });
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  return (
    <Card
      title={`${level.level} · ${t(`levels.level.${level.level}`)}`}
      description={t(`levels.route.${level.level}`)}
      actions={
        <div className="flex flex-wrap gap-2">
          <Badge tone={inForce === 'UBOSS' ? 'brand' : 'success'}>{inForce === 'UBOSS' ? t('levels.ubossManaged') : t('levels.sellerManaged')}</Badge>
          {level.owner !== inForce && <Badge tone="warning">{t('levels.ownerChangePending')}</Badge>}
        </div>
      }
    >
      <div className="space-y-3 px-5 pb-5">
        {level.rates.length === 0 ? (
          <p className="text-sm text-ink-muted">{ubossControls ? t('levels.noUbossPrice') : t('levels.noSellerPrice')}</p>
        ) : (
          <ul className="divide-y divide-border-subtle rounded-md border border-border-subtle">
            {level.rates.map((rate) => (
              <li key={rate.id} className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm">
                  <p className="font-medium text-ink">
                    {[rate.originPortCode, rate.destinationPortCode, rate.destinationHubName ?? rate.destinationHubCode, rate.destinationCountry]
                      .filter((part): part is string => part !== null && part !== '')
                      .join(' → ') || '—'}
                  </p>
                  <p className="text-xxs text-ink-subtle">
                    {t(`levels.transport.${rate.transportMode}`)} · {rate.providerLabel ?? rate.logisticsPartnerName ?? rate.provider ?? '—'} ·{' '}
                    {rate.owner === 'UBOSS' ? 'UBOSS' : t('levels.seller')} · {formatDateTime(rate.updatedAt)}
                    {rate.updatedBy.label !== null && ` · ${rate.updatedBy.label}`}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-ink">
                    {rate.isFree ? t('levels.free') : rate.price === null ? t('levels.notPriced') : formatMoney(rate.price)}
                  </span>
                  <Badge tone={rate.status === 'PUBLISHED' ? 'success' : 'neutral'}>{t(`levels.rateStatus.${rate.status}`)}</Badge>
                  {mayPrice && rate.owner === 'UBOSS' && rate.status !== 'INACTIVE' && rate.status !== 'SUPERSEDED' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        onEdit(rate);
                      }}
                    >
                      {t('common.edit')}
                    </Button>
                  )}
                  {mayPrice && rate.owner === 'UBOSS' && rate.status === 'DRAFT' && (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!rate.isComplete || action.isPending}
                      onClick={() => {
                        action.mutate({ rateId: rate.id, kind: 'publish' });
                      }}
                    >
                      {t('levels.publishPrice')}
                    </Button>
                  )}
                  {mayPrice && rate.owner === 'UBOSS' && rate.status === 'PUBLISHED' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={action.isPending}
                      onClick={() => {
                        action.mutate({ rateId: rate.id, kind: 'deactivate' });
                      }}
                    >
                      {t('levels.switchOff')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {ubossControls ? (
          mayPrice ? (
            <Button size="sm" variant="secondary" onClick={onAdd}>
              {t('levels.addUbossPrice')}
            </Button>
          ) : (
            <p className="text-xxs text-ink-subtle">{t('levels.needsWrite')}</p>
          )
        ) : (
          <p className="text-xxs text-ink-subtle">{t('levels.sellerReadOnly')}</p>
        )}
      </div>
    </Card>
  );
}

function UbossRateDialog({
  sellerAccountId,
  level,
  rate,
  currency,
  carriers,
  onClose,
}: {
  sellerAccountId: string;
  level: LogisticsLevel;
  rate: RateView | null;
  currency: string;
  carriers: { id: string; displayName: string }[];
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const rateCurrency = rate?.currency ?? currency;
  const [transportMode, setTransportMode] = useState<TransportMode>(rate?.transportMode ?? LEVEL_MODES[level][0] ?? 'ROAD');
  const [carrier, setCarrier] = useState(rate?.logisticsPartnerId !== null && rate?.logisticsPartnerId !== undefined ? `partner:${rate.logisticsPartnerId}` : (rate?.provider ?? ''));
  const [providerLabel, setProviderLabel] = useState(rate?.providerLabel ?? '');
  const [originPort, setOriginPort] = useState(rate?.originPortCode ?? '');
  const [destinationPort, setDestinationPort] = useState(rate?.destinationPortCode ?? '');
  const [hub, setHub] = useState(rate?.destinationHubCode ?? '');
  const [hubName, setHubName] = useState(rate?.destinationHubName ?? '');
  const [country, setCountry] = useState(rate?.destinationCountry ?? '');
  const [price, setPrice] = useState(rate?.price === null || rate?.price === undefined || rate.isFree ? '' : minorToMajor(rate.price.minor, currencyExponent(rateCurrency)));
  const [isFree, setIsFree] = useState(rate?.isFree ?? false);
  const [confirmFree, setConfirmFree] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const save = useMutation({
    mutationFn: (input: UbossRateInput) => (rate === null ? createUbossRate(sellerAccountId, input) : updateUbossRate(rate.id, input)),
    onSuccess: () => {
      toast.success(t('levels.rateSaved'));
      void client.invalidateQueries({ queryKey: ['admin', 'managed-levels'] });
      onClose();
    },
    onError: (failure: unknown) => {
      toast.error(errorMessage(t, failure));
    },
  });

  function submit(): void {
    setError(undefined);
    let amountMinor: string | null = null;
    if (!isFree && price.trim() !== '') {
      amountMinor = majorToMinor(price, currencyExponent(rateCurrency));
      if (amountMinor === null) {
        setError(t('levels.priceInvalid'));
        return;
      }
    }
    const partnerId = carrier.startsWith('partner:') ? carrier.slice('partner:'.length) : null;
    const provider = partnerId === null && carrier !== '' ? (carrier as 'DHL' | 'FEDEX' | 'INDIA_POST' | 'MANUAL') : null;
    save.mutate({
      level,
      transportMode,
      provider,
      logisticsPartnerId: partnerId,
      providerLabel: provider === 'MANUAL' && providerLabel.trim() !== '' ? providerLabel.trim() : null,
      originPortCode: level === 'L2' && originPort.trim() !== '' ? originPort.trim() : null,
      destinationPortCode: (level === 'L2' || level === 'L3') && destinationPort.trim() !== '' ? destinationPort.trim() : null,
      destinationHubCode: (level === 'L3' || level === 'L4') && hub.trim() !== '' ? hub.trim() : null,
      destinationHubName: level === 'L3' && hubName.trim() !== '' ? hubName.trim() : null,
      destinationCountry: country.trim() === '' ? null : country.trim().toUpperCase(),
      amountMinor,
      currency: rateCurrency,
      isFree,
      confirmFree: isFree && confirmFree,
    });
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('levels.ubossPriceTitle', { level })}
      description={t(`levels.route.${level}`)}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" isLoading={save.isPending} onClick={submit}>
            {t('levels.saveDraft')}
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {level === 'L2' && (
          <Field label={t('levels.field.loadingPort')}>
            {({ inputId }) => <Input id={inputId} value={originPort} maxLength={5} onChange={(event) => { setOriginPort(event.currentTarget.value.toUpperCase()); }} />}
          </Field>
        )}
        {(level === 'L2' || level === 'L3') && (
          <Field label={t('levels.field.destinationPort')}>
            {({ inputId }) => <Input id={inputId} value={destinationPort} maxLength={5} onChange={(event) => { setDestinationPort(event.currentTarget.value.toUpperCase()); }} />}
          </Field>
        )}
        {(level === 'L3' || level === 'L4') && (
          <Field label={t('levels.field.destinationHub')}>
            {({ inputId }) => <Input id={inputId} value={hub} maxLength={64} onChange={(event) => { setHub(event.currentTarget.value.toUpperCase()); }} />}
          </Field>
        )}
        {level === 'L3' && (
          <Field label={t('levels.field.destinationHubName')}>
            {({ inputId }) => <Input id={inputId} value={hubName} maxLength={160} onChange={(event) => { setHubName(event.currentTarget.value); }} />}
          </Field>
        )}
        <Field label={t('levels.field.destinationCountry')}>
          {({ inputId }) => <Input id={inputId} value={country} maxLength={2} onChange={(event) => { setCountry(event.currentTarget.value.toUpperCase()); }} />}
        </Field>
        <Field label={t('levels.field.transportMode')}>
          {({ inputId }) => (
            <Select id={inputId} value={transportMode} onChange={(event) => { setTransportMode(event.currentTarget.value as TransportMode); }}>
              {LEVEL_MODES[level].map((mode) => (
                <option key={mode} value={mode}>
                  {t(`levels.transport.${mode}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('levels.field.carrier')}>
          {({ inputId }) => (
            <Select id={inputId} value={carrier} onChange={(event) => { setCarrier(event.currentTarget.value); }}>
              <option value="">—</option>
              <option value="DHL">DHL</option>
              <option value="FEDEX">FedEx</option>
              <option value="INDIA_POST">India Post</option>
              <option value="MANUAL">{t('levels.forwarder')}</option>
              {carriers.map((partner) => (
                <option key={partner.id} value={`partner:${partner.id}`}>
                  {partner.displayName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {carrier === 'MANUAL' && (
          <Field label={t('levels.field.forwarderName')}>
            {({ inputId }) => <Input id={inputId} value={providerLabel} maxLength={160} onChange={(event) => { setProviderLabel(event.currentTarget.value); }} />}
          </Field>
        )}
        <Field label={t('levels.field.price', { currency: rateCurrency })} error={error}>
          {({ inputId, describedBy }) => (
            <Input id={inputId} aria-describedby={describedBy} inputMode="decimal" value={price} disabled={isFree} onChange={(event) => { setPrice(event.currentTarget.value); }} />
          )}
        </Field>
        <div className="space-y-2 sm:col-span-2">
          <CheckboxField label={t('levels.field.free')} checked={isFree} onChange={(event) => { setIsFree(event.currentTarget.checked); setConfirmFree(false); }} />
          {isFree && (
            <CheckboxField tone="warning" boxed label={t('levels.field.confirmFree')} checked={confirmFree} onChange={(event) => { setConfirmFree(event.currentTarget.checked); }} />
          )}
          <p className="text-xxs text-ink-subtle">{t('levels.emptyNotZero')}</p>
        </div>
      </div>
    </Modal>
  );
}
