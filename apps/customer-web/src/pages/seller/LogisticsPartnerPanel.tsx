/**
 * How this seller's goods get delivered.
 *
 * The Logistics Partner onboarding step, and the Seller Hub screen it becomes
 * once the application is approved. ONE component for both, because they are
 * the same question asked at two moments and a second "settings version" is
 * how the two end up disagreeing about what the seller has configured.
 *
 * WHAT THE CARDS HAVE TO SAY, AND WHY IT COMES FROM THE SERVER
 *
 * Every fact on a card - who stores the goods, who packs them, who delivers
 * them, whether a credential is needed, whether drivers are managed here,
 * whether tracking is automatic - is computed by the backend from
 * `domain/seller-fulfilment.ts` and sent down. Writing them into this file
 * would give the Seller Hub, the admin panel and the generated feature guide
 * three separate copies of the same claim, and within one release they would
 * be three different claims.
 *
 * THE ONE THAT MATTERS MOST is `hasVerifiedApi`. It is false for India Post,
 * and the card says "Official API access not verified" in those words rather
 * than offering a connect button that leads nowhere. There is no state in this
 * component that can render a green "Connected" badge for a provider that
 * answers false.
 *
 * `driversManagedHere` is the other one. It is false for every external
 * carrier, and no card that answers false ever shows anything about drivers -
 * DHL's couriers are DHL's staff, and a screen offering to assign one would be
 * inventing a person.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, ErrorState, LoadingState } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { FulfilmentSetupPanel } from './FulfilmentSetupPanel';
import {
  chooseFulfilmentMethod,
  fetchFulfilmentOptions,
  setFulfilmentMethodRole,
  setFulfilmentMethodStatus,
  type FulfilmentMethod,
  type FulfilmentMethodStatus,
  type FulfilmentOption,
} from '@/lib/seller';

/**
 * The tone each status is drawn in.
 *
 * A map rather than a chain of ternaries, so a status added to the enum turns
 * into a TypeScript error here instead of silently rendering grey.
 */
const STATUS_TONE: Record<
  FulfilmentMethodStatus,
  'neutral' | 'brand' | 'success' | 'warning' | 'danger'
> = {
  DRAFT: 'neutral',
  PENDING_SETUP: 'warning',
  PENDING_APPROVAL: 'brand',
  APPROVED: 'success',
  CHANGES_REQUESTED: 'warning',
  REJECTED: 'danger',
  PAUSED: 'neutral',
  DISCONNECTED: 'neutral',
};

export interface LogisticsPartnerPanelProps {
  /** False while the application is with a reviewer, or after a refusal. */
  isEditable: boolean;
}

export function LogisticsPartnerPanel({
  isEditable,
}: LogisticsPartnerPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const query = useQuery({
    queryKey: ['seller', 'fulfilment-options'],
    queryFn: fetchFulfilmentOptions,
  });

  /** The card whose confirmation dialog is open, if any. */
  const [confirming, setConfirming] = useState<FulfilmentMethod | null>(null);
  const [pauseReason, setPauseReason] = useState('');

  /**
   * Which method the seller is configuring, if any.
   *
   * Expanded in place rather than on a route of its own. Setting a delivery
   * method up is a handful of fields, and sending somebody to another screen
   * and back loses their place in a list they were comparing.
   */
  const [settingUp, setSettingUp] = useState<string | null>(null);

  function refresh(): void {
    void client.invalidateQueries({ queryKey: ['seller', 'fulfilment-options'] });
    // The step's own tick lives on the onboarding view, which is a different
    // query. Without this the card goes green and the checklist beside it does
    // not, which reads as the save having half worked.
    void client.invalidateQueries({ queryKey: ['seller', 'onboarding'] });
  }

  const choose = useMutation({
    mutationFn: chooseFulfilmentMethod,
    onSuccess: (result) => {
      toast.success(
        t('sellerFulfilment.chosen', { name: result.method.publicDisplayName }),
      );
      refresh();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerFulfilment.chooseFailed')));
    },
  });

  const setRole = useMutation({
    mutationFn: setFulfilmentMethodRole,
    onSuccess: () => {
      toast.success(t('sellerFulfilment.defaultChanged'));
      refresh();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerFulfilment.defaultFailed')));
    },
  });

  const setStatus = useMutation({
    mutationFn: setFulfilmentMethodStatus,
    onSuccess: () => {
      setConfirming(null);
      setPauseReason('');
      toast.success(t('sellerFulfilment.statusChanged'));
      refresh();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerFulfilment.statusFailed')));
    },
  });

  if (query.isPending) {
    return (
      <Card>
        <div className="px-6 py-5">
          <LoadingState label={t('sellerFulfilment.loading')} />
        </div>
      </Card>
    );
  }

  if (query.isError) {
    return (
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
    );
  }

  // Narrowed by the two guards above: past them, the query has resolved.
  const { options, methods } = query.data;
  const chosen = methods.filter((method) => method.status !== 'DISCONNECTED');

  return (
    <div className="space-y-5">
      {/* --- What the seller has already set up ----------------------------- */}
      {chosen.length > 0 && (
        <Card
          title={t('sellerFulfilment.yoursTitle')}
          description={t('sellerFulfilment.yoursBody')}
        >
          <ul className="divide-y divide-border-subtle">
            {chosen.map((method) => (
              <li key={method.id} className="px-6 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{method.publicDisplayName}</p>
                    <p className="mt-0.5 text-xxs text-ink-muted">
                      {t(`sellerFulfilment.mode.${method.mode}`)}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {method.role === 'PRIMARY' && (
                      <Badge tone="brand">{t('sellerFulfilment.role.primary')}</Badge>
                    )}
                    {method.role === 'FALLBACK' && (
                      <Badge tone="operational">{t('sellerFulfilment.role.fallback')}</Badge>
                    )}
                    <Badge tone={STATUS_TONE[method.status]}>
                      {t(`sellerFulfilment.status.${method.status}`)}
                    </Badge>
                  </div>
                </div>

                {method.statusReason !== null && (
                  <p className="mt-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-ink">
                    {method.statusReason}
                  </p>
                )}

                {/*
                  A carrier connection that has failed says so, with the safe
                  message the server stored. Never a header, never a token -
                  a failure message is the commonest place a credential leaks.
                */}
                {method.connection?.lastFailureMessage != null && (
                  <p className="mt-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-ink">
                    {method.connection.lastFailureMessage}
                  </p>
                )}

                {isEditable && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {/*
                      The one control that matters on a half-finished method.
                      Shown for the three statuses where the seller is the one
                      being waited on - not for PENDING_APPROVAL, where they
                      would press it and find nothing they can change.
                    */}
                    {(method.status === 'PENDING_SETUP' ||
                      method.status === 'DRAFT' ||
                      method.status === 'CHANGES_REQUESTED') && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => {
                          setSettingUp((previous) => (previous === method.id ? null : method.id));
                        }}
                      >
                        {settingUp === method.id
                          ? t('sellerFulfilment.hideSetup')
                          : t('sellerFulfilment.finishSetup')}
                      </Button>
                    )}

                    {method.status === 'APPROVED' && method.role !== 'PRIMARY' && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={setRole.isPending}
                        onClick={() => {
                          setRole.mutate({ methodId: method.id, role: 'PRIMARY' });
                        }}
                      >
                        {t('sellerFulfilment.makeDefault')}
                      </Button>
                    )}

                    {method.status === 'APPROVED' && method.role !== 'FALLBACK' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={setRole.isPending}
                        onClick={() => {
                          setRole.mutate({ methodId: method.id, role: 'FALLBACK' });
                        }}
                      >
                        {t('sellerFulfilment.makeFallback')}
                      </Button>
                    )}

                    {method.status === 'APPROVED' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setConfirming(method);
                          setPauseReason('');
                        }}
                      >
                        {t('sellerFulfilment.pause')}
                      </Button>
                    )}

                    {method.status === 'PAUSED' && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={setStatus.isPending}
                        onClick={() => {
                          setStatus.mutate({ methodId: method.id, status: 'APPROVED' });
                        }}
                      >
                        {t('sellerFulfilment.resume')}
                      </Button>
                    )}
                  </div>
                )}

                {settingUp === method.id && (
                  <div className="mt-4">
                    <FulfilmentSetupPanel method={method} isEditable={isEditable} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* --- The options --------------------------------------------------- */}
      <Card
        title={t('sellerFulfilment.optionsTitle')}
        description={t('sellerFulfilment.optionsBody')}
      >
        <div className="grid gap-4 px-6 py-5 sm:grid-cols-2 xl:grid-cols-3">
          {options.map((option) => (
            <OptionCard
              key={option.key}
              option={option}
              isEditable={isEditable}
              isSaving={choose.isPending}
              onChoose={() => {
                choose.mutate({ mode: option.mode, provider: option.provider });
              }}
            />
          ))}
        </div>
      </Card>

      {/*
        Pausing is a confirmation, not a button.

        It stops new consignments going this way. Parcels already on a van
        finish - which is what makes it recoverable and is why the dialog says
        so rather than leaving the seller to guess.
      */}
      {confirming !== null && (
        <PauseDialog
          method={confirming}
          reason={pauseReason}
          onReasonChange={setPauseReason}
          isSaving={setStatus.isPending}
          onCancel={() => {
            setConfirming(null);
          }}
          onConfirm={() => {
            setStatus.mutate({
              methodId: confirming.id,
              status: 'PAUSED',
              reason: pauseReason,
            });
          }}
        />
      )}
    </div>
  );
}

/**
 * One way of delivering, as a card.
 *
 * The definition list is the substance: a seller comparing "my own vans"
 * against "DHL" is comparing who does what, and a card that showed only a name
 * and a paragraph would make them guess.
 */
function OptionCard({
  option,
  isEditable,
  isSaving,
  onChoose,
}: {
  option: FulfilmentOption;
  isEditable: boolean;
  isSaving: boolean;
  onChoose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const existing = option.existing;

  return (
    <div
      className={cx(
        'flex flex-col rounded-xl border bg-surface p-4 transition-colors',
        existing === null ? 'border-border' : 'border-brand/40 bg-brand-soft/30',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{option.name}</h3>

        {existing !== null && (
          <Badge tone={STATUS_TONE[existing.status]}>
            {t(`sellerFulfilment.status.${existing.status}`)}
          </Badge>
        )}
      </div>

      <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">{option.description}</p>

      {/*
        The honesty line.

        Shown for any provider with no verified official API, and it is the
        reason there is no route in this component to a green "Connected"
        badge for one. India Post is the case it exists for.
      */}
      {option.mode === 'INTEGRATED_CARRIER' && !option.hasVerifiedApi && (
        <p className="mt-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xxs leading-relaxed text-ink">
          {t('sellerFulfilment.apiNotVerified')}
        </p>
      )}

      <dl className="mt-3 space-y-1.5 border-t border-border-subtle pt-3 text-xxs">
        <Fact label={t('sellerFulfilment.fact.stores')} value={t(`sellerFulfilment.party.${option.whoStores}`)} />
        <Fact label={t('sellerFulfilment.fact.packs')} value={t(`sellerFulfilment.party.${option.whoPacks}`)} />
        <Fact label={t('sellerFulfilment.fact.delivers')} value={option.whoDelivers} />
        <Fact
          label={t('sellerFulfilment.fact.credentials')}
          value={
            option.requiresApiCredentials
              ? t('sellerFulfilment.credentials.yours')
              : t('sellerFulfilment.credentials.none')
          }
        />
        {/*
          Only shown where it is TRUE. A row reading "Drivers managed here: No"
          against DHL invites the question "where then?", and the answer -
          "at DHL, and none of your business" - is not something a seller
          needs a row for.
        */}
        {option.driversManagedHere && (
          <Fact
            label={t('sellerFulfilment.fact.drivers')}
            value={t('sellerFulfilment.drivers.here')}
          />
        )}
        <Fact
          label={t('sellerFulfilment.fact.tracking')}
          value={t(`sellerFulfilment.tracking.${option.trackingMode}`)}
        />
        <Fact
          label={t('sellerFulfilment.fact.approval')}
          value={
            option.requiresMarketplaceApproval
              ? t('sellerFulfilment.approval.required')
              : t('sellerFulfilment.approval.none')
          }
        />
        {option.originRestriction !== null && (
          <Fact
            label={t('sellerFulfilment.fact.coverage')}
            value={t('sellerFulfilment.coverage.countryOnly', {
              country: option.originRestriction,
            })}
          />
        )}
      </dl>

      <div className="mt-4 flex items-center gap-2 pt-1">
        {existing === null ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={!isEditable || isSaving}
            onClick={onChoose}
          >
            {t('sellerFulfilment.choose')}
          </Button>
        ) : (
          <p className="text-xxs text-ink-subtle">
            {existing.role === 'PRIMARY'
              ? t('sellerFulfilment.isDefault')
              : t('sellerFulfilment.alreadySetUp')}
          </p>
        )}
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-ink-subtle">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-ink">{value}</dd>
    </div>
  );
}

/**
 * Confirming a pause.
 *
 * A native `<dialog>` would be the obvious choice and is deliberately not used
 * here: this app's `Modal` had to fix a `display:flex` that overrode the user
 * agent's `display:none`, and a second hand-rolled dialog would be a second
 * chance to make the same mistake. This is a plain overlay with the focus and
 * escape behaviour written out, which is what the rest of this page does.
 */
function PauseDialog({
  method,
  reason,
  onReasonChange,
  isSaving,
  onCancel,
  onConfirm,
}: {
  method: FulfilmentMethod;
  reason: string;
  onReasonChange: (value: string) => void;
  isSaving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4"
      role="presentation"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pause-method-title"
        className="w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-lg"
      >
        <h2 id="pause-method-title" className="text-title-sm text-ink">
          {t('sellerFulfilment.pauseTitle', { name: method.publicDisplayName })}
        </h2>

        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          {t('sellerFulfilment.pauseBody')}
        </p>

        <label htmlFor="pause-reason" className="mt-4 block text-xs font-medium text-ink">
          {t('sellerFulfilment.pauseReasonLabel')}
        </label>
        <textarea
          id="pause-reason"
          value={reason}
          rows={3}
          onChange={(event) => {
            onReasonChange(event.target.value);
          }}
          className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
        />

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            // The server demands a reason too. Disabling here means the seller
            // finds out before the round trip rather than after it.
            disabled={isSaving || reason.trim().length === 0}
            onClick={onConfirm}
          >
            {t('sellerFulfilment.pauseConfirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
