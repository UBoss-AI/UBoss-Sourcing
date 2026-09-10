/**
 * Automatic payment: the customer's own controls.
 *
 * The screen's job is to make one distinction impossible to miss: saving a card
 * is not the same as agreeing to be charged with it. So the consent tick has
 * its own paragraph, it is never pre-ticked, the button stays disabled until it
 * is ticked, and the wording says plainly what is being agreed to — that money
 * will be taken when the customer is not present.
 *
 * The two limits are presented as what they are, which is two different
 * instructions rather than a big one and a small one:
 *
 *   "Never charge more than"  — above it, nothing happens and nothing is asked.
 *   "Ask me first above"      — above it, nothing is charged and the customer
 *                               is asked.
 *
 * Amounts are typed in major units and converted by string arithmetic. There is
 * no `value * 100` anywhere on this path: `12.34 * 100` is 1233.9999999999998,
 * and a ceiling one unit under what somebody typed will eventually refuse a
 * charge they meant to allow.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { useStorefront } from '@/app/storefront-context';
import { CardSetupDialog } from '@/components/CardSetupDialog';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
} from '@/components/ui';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { autoPayApi, autoPayKeys, inputToMinor, minorToInput } from '@/lib/autopay';
import type { AutoPayRetryPreference, AutoPaySettings } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

interface SavedCard {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  status: string;
  isDefault: boolean;
}

/** What the form holds. Amounts are major-unit strings, as typed. */
interface FormState {
  paymentMethodId: string;
  maxTransaction: string;
  approvalThreshold: string;
  limitCurrency: string;
  retryPreference: AutoPayRetryPreference;
  notifyOnCharge: boolean;
  notifyOnFailure: boolean;
  consentAccepted: boolean;
}

function initialForm(settings: AutoPaySettings, cards: SavedCard[]): FormState {
  return {
    paymentMethodId:
      settings.paymentMethodId ?? cards.find((card) => card.isDefault)?.id ?? cards[0]?.id ?? '',
    maxTransaction: minorToInput(settings.maxTransactionMinor),
    approvalThreshold: minorToInput(settings.approvalThresholdMinor),
    limitCurrency: settings.limitCurrency ?? '',
    retryPreference: settings.retryPreference,
    notifyOnCharge: settings.notifyOnCharge,
    notifyOnFailure: settings.notifyOnFailure,
    // Never carried over from a previous session, and never defaulted true.
    // Consent is given by the person in front of the screen, now.
    consentAccepted: false,
  };
}

function cardLabel(card: SavedCard): string {
  const brand = card.brand ?? 'Card';
  const last4 = card.last4 ?? '****';
  const expiry =
    card.expMonth === null || card.expYear === null
      ? ''
      : ` — ${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}`;

  return `${brand} ···· ${last4}${expiry}`;
}

/**
 * The page shell every branch renders inside.
 *
 * Loading, error, unavailable and the form itself are all one card on one
 * page, so the container and heading live here rather than being repeated -
 * and the page does not jump between states.
 */
function AutoPayShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();

  useDocumentMeta({ title: t('autopay.heading'), noIndex: true }, business.displayName);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <PageHeader title={t('autopay.heading')} description={t('autopay.description')} />
      {children}
    </div>
  );
}

export function AutoPayPage(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [form, setForm] = useState<FormState | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isAddingCard, setIsAddingCard] = useState(false);

  const settingsQuery = useQuery({
    queryKey: autoPayKeys.settings,
    queryFn: () => autoPayApi.get(),
  });

  const cardsQuery = useQuery({
    queryKey: autoPayKeys.paymentMethods,
    queryFn: () =>
      api
        .get<{ paymentMethods: SavedCard[] }>('/account/payment-methods')
        .then((response) => response.paymentMethods),
    // The saved-cards surface is behind its own flag and answers 403 when it is
    // off. Only asked for once auto-pay says it is available.
    enabled: settingsQuery.data?.available === true,
  });

  const settings = settingsQuery.data?.autoPay;
  const cards = useMemo(() => cardsQuery.data ?? [], [cardsQuery.data]);

  useEffect(() => {
    if (settings === undefined) return;
    setForm((current) => current ?? initialForm(settings, cards));
  }, [settings, cards]);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: autoPayKeys.settings });
  };

  const enable = useMutation({
    mutationFn: (body: Parameters<typeof autoPayApi.enable>[0]) => autoPayApi.enable(body),
    onSuccess: (updated) => {
      toast.success(t('autopay.enabled'));
      setFieldErrors({});
      setForm(initialForm(updated, cards));
      invalidate();
    },
    onError: (error: unknown) => {
      setFieldErrors(
        typeof error === 'object' && error !== null && 'fieldErrors' in error
          ? (error as { fieldErrors: () => Record<string, string> }).fieldErrors()
          : {},
      );
      toast.error(errorMessage(t, error));
    },
  });

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => autoPayApi.update(body),
    onSuccess: () => {
      toast.success(t('autopay.saved'));
      setFieldErrors({});
      invalidate();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  const pause = useMutation({
    mutationFn: (paused: boolean) => autoPayApi.setPaused(paused),
    onSuccess: (updated) => {
      toast.success(updated.status === 'PAUSED' ? t('autopay.paused') : t('autopay.resumed'));
      invalidate();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  const disable = useMutation({
    mutationFn: () => autoPayApi.disable(),
    onSuccess: () => {
      toast.success(t('autopay.disabled'));
      setForm(null);
      invalidate();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  if (settingsQuery.isPending) {
    return (
      <AutoPayShell>
        <Card>
          <LoadingState label={t('common.loading')} />
        </Card>
      </AutoPayShell>
    );
  }

  if (settingsQuery.isError) {
    return (
      <AutoPayShell>
        <Card>
          <ErrorState
            error={settingsQuery.error}
            onRetry={() => {
              void settingsQuery.refetch();
            }}
          />
        </Card>
      </AutoPayShell>
    );
  }

  // The store has not enabled it. Said plainly rather than by hiding the panel,
  // so a customer who has been told the feature exists is not left hunting.
  if (!settingsQuery.data.available) {
    return (
      <AutoPayShell>
        <Card>
          <p className="px-6 py-5 text-sm text-ink-muted">{t('autopay.notAvailable')}</p>
        </Card>
      </AutoPayShell>
    );
  }

  if (settings === undefined || form === null) {
    return (
      <AutoPayShell>
        <Card>
          <LoadingState label={t('common.loading')} />
        </Card>
      </AutoPayShell>
    );
  }

  const usableCards = cards.filter((card) => card.status === 'ACTIVE');
  const hasUsableCard = usableCards.length > 0;

  /** Convert what was typed, or record which field could not be. */
  function readLimits(current: FormState): { max: string | null; threshold: string | null } | null {
    const errors: Record<string, string> = {};

    const max = current.maxTransaction.trim() === '' ? null : inputToMinor(current.maxTransaction);
    if (current.maxTransaction.trim() !== '' && max === null) {
      errors['maxTransactionMinor'] = t('autopay.enterAnAmount');
    }

    const threshold =
      current.approvalThreshold.trim() === '' ? null : inputToMinor(current.approvalThreshold);
    if (current.approvalThreshold.trim() !== '' && threshold === null) {
      errors['approvalThresholdMinor'] = t('autopay.enterAnAmount');
    }

    if ((max !== null || threshold !== null) && current.limitCurrency.trim() === '') {
      // An amount with no currency is not a limit. Refused here as well as on
      // the server, because a round trip to learn it is a poor experience.
      errors['limitCurrency'] = t('autopay.chooseACurrency');
    }

    setFieldErrors(errors);

    return Object.keys(errors).length === 0 ? { max, threshold } : null;
  }

  const submitEnable = (): void => {
    const limits = readLimits(form);
    if (limits === null) return;

    enable.mutate({
      paymentMethodId: form.paymentMethodId,
      consentAccepted: form.consentAccepted,
      maxTransactionMinor: limits.max,
      approvalThresholdMinor: limits.threshold,
      limitCurrency: form.limitCurrency.trim() === '' ? null : form.limitCurrency.trim(),
      retryPreference: form.retryPreference,
      notifyOnCharge: form.notifyOnCharge,
      notifyOnFailure: form.notifyOnFailure,
    });
  };

  const submitUpdate = (): void => {
    const limits = readLimits(form);
    if (limits === null) return;

    update.mutate({
      paymentMethodId: form.paymentMethodId,
      maxTransactionMinor: limits.max,
      approvalThresholdMinor: limits.threshold,
      limitCurrency: form.limitCurrency.trim() === '' ? null : form.limitCurrency.trim(),
      retryPreference: form.retryPreference,
      notifyOnCharge: form.notifyOnCharge,
      notifyOnFailure: form.notifyOnFailure,
    });
  };

  const busy = enable.isPending || update.isPending || pause.isPending || disable.isPending;

  return (
    <AutoPayShell>
      <Card
        actions={
          <Badge
            tone={
              settings.status === 'ACTIVE'
                ? 'success'
                : settings.status === 'PAUSED'
                  ? 'warning'
                  : 'neutral'
            }
          >
            {t(`autopay.state.${settings.status}` as 'autopay.state.ACTIVE')}
          </Badge>
        }
      >
        <div className="space-y-6 px-6 py-5">
          {/* --- The card ------------------------------------------------- */}
          {!hasUsableCard ? (
            <div className="rounded-md bg-surface-sunken px-4 py-4">
              <p className="text-sm text-ink">{t('autopay.noCardTitle')}</p>
              <p className="mt-1 text-sm text-ink-muted">{t('autopay.noCardDescription')}</p>
              {/*
               * Enrolment happens here, not on another page.
               *
               * This used to link to `/account/profile`, which has no card
               * section — the button was a dead end, and the one screen that
               * needs a card was the screen that could not produce one.
               */}
              <Button
                size="sm"
                variant="primary"
                className="mt-3"
                onClick={() => {
                  setIsAddingCard(true);
                }}
              >
                {t('autopay.addACard')}
              </Button>
            </div>
          ) : (
            <Field label={t('autopay.cardToCharge')} error={fieldErrors['paymentMethodId']}>
              {({ inputId, describedBy }) => (
                <Select
                  id={inputId}
                  aria-describedby={describedBy}
                  value={form.paymentMethodId}
                  disabled={busy}
                  onChange={(event) => {
                    setForm({ ...form, paymentMethodId: event.target.value });
                  }}
                >
                  {usableCards.map((card) => (
                    <option key={card.id} value={card.id}>
                      {cardLabel(card)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}

          {/* --- The two limits ------------------------------------------- */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field
              label={t('autopay.neverChargeMoreThan')}
              hint={t('autopay.neverChargeMoreThanHint')}
              error={fieldErrors['maxTransactionMinor']}
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  inputMode="decimal"
                  placeholder={t('autopay.noLimit')}
                  value={form.maxTransaction}
                  disabled={busy}
                  invalid={fieldErrors['maxTransactionMinor'] !== undefined}
                  onChange={(event) => {
                    setForm({ ...form, maxTransaction: event.target.value });
                  }}
                />
              )}
            </Field>

            <Field
              label={t('autopay.askMeFirstAbove')}
              hint={t('autopay.askMeFirstAboveHint')}
              error={fieldErrors['approvalThresholdMinor']}
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  inputMode="decimal"
                  placeholder={t('autopay.neverAsk')}
                  value={form.approvalThreshold}
                  disabled={busy}
                  invalid={fieldErrors['approvalThresholdMinor'] !== undefined}
                  onChange={(event) => {
                    setForm({ ...form, approvalThreshold: event.target.value });
                  }}
                />
              )}
            </Field>

            <Field label={t('autopay.limitCurrency')} error={fieldErrors['limitCurrency']}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  maxLength={3}
                  placeholder="EUR"
                  value={form.limitCurrency}
                  disabled={busy}
                  invalid={fieldErrors['limitCurrency'] !== undefined}
                  onChange={(event) => {
                    setForm({ ...form, limitCurrency: event.target.value.toUpperCase() });
                  }}
                />
              )}
            </Field>
          </div>

          {/* --- Preferences ---------------------------------------------- */}
          <Field label={t('autopay.ifAPaymentFails')} hint={t('autopay.ifAPaymentFailsHint')}>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={form.retryPreference}
                disabled={busy}
                onChange={(event) => {
                  setForm({
                    ...form,
                    retryPreference: event.target.value as AutoPayRetryPreference,
                  });
                }}
              >
                <option value="NONE">{t('autopay.retry.NONE')}</option>
                <option value="ONCE">{t('autopay.retry.ONCE')}</option>
                <option value="STANDARD">{t('autopay.retry.STANDARD')}</option>
              </Select>
            )}
          </Field>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink">{t('autopay.tellMeWhen')}</legend>

            <label className="flex items-start gap-2 text-sm text-ink-muted">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={form.notifyOnCharge}
                disabled={busy}
                onChange={(event) => {
                  setForm({ ...form, notifyOnCharge: event.target.checked });
                }}
              />
              {t('autopay.notifyOnCharge')}
            </label>

            <label className="flex items-start gap-2 text-sm text-ink-muted">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={form.notifyOnFailure}
                disabled={busy}
                onChange={(event) => {
                  setForm({ ...form, notifyOnFailure: event.target.checked });
                }}
              />
              {t('autopay.notifyOnFailure')}
            </label>
          </fieldset>

          {/* --- Consent, and the actions --------------------------------- */}
          {settings.status === 'DISABLED' ? (
            <div className="space-y-3 rounded-md border border-border bg-surface-sunken px-4 py-4">
              {/* Its own box, its own paragraph, never pre-ticked. This is the
                moment a customer takes on a commitment, and it should look
                like one. */}
              <label className="flex items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={form.consentAccepted}
                  disabled={busy || !hasUsableCard}
                  onChange={(event) => {
                    setForm({ ...form, consentAccepted: event.target.checked });
                  }}
                />
                <span>{t('autopay.consentStatement')}</span>
              </label>

              <p className="text-xs text-ink-muted">{t('autopay.consentFootnote')}</p>

              <Button
                variant="primary"
                disabled={!form.consentAccepted || !hasUsableCard}
                isLoading={enable.isPending}
                onClick={submitEnable}
              >
                {t('autopay.turnOn')}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-4">
              <Button variant="primary" isLoading={update.isPending} onClick={submitUpdate}>
                {t('common.save')}
              </Button>

              <Button
                isLoading={pause.isPending}
                onClick={() => {
                  pause.mutate(settings.status !== 'PAUSED');
                }}
              >
                {settings.status === 'PAUSED' ? t('autopay.resume') : t('autopay.pause')}
              </Button>

              <Button
                variant="danger"
                isLoading={disable.isPending}
                onClick={() => {
                  disable.mutate();
                }}
              >
                {t('autopay.turnOff')}
              </Button>

              {settings.consentAcceptedAt !== null && (
                <p className="ml-auto text-xs text-ink-muted">
                  {t('autopay.authorisedOn', {
                    date: formatDateTime(settings.consentAcceptedAt),
                    version: settings.consentVersion ?? '',
                  })}
                </p>
              )}
            </div>
          )}
        </div>
      </Card>

      {isAddingCard && (
        <CardSetupDialog
          // The first card on an account that is about to authorise charges
          // has nothing to compete with, so it becomes the default.
          makeDefault={usableCards.length === 0}
          onSaved={(card) => {
            setIsAddingCard(false);
            toast.success(t('cardSetup.saved'));
            // Select the card just added rather than leaving the form on
            // whatever the previous default was — it was added in order to be
            // used, and the consent tick below refers to "the card above".
            setForm((current) =>
              current === null ? current : { ...current, paymentMethodId: card.id },
            );
            void queryClient.invalidateQueries({ queryKey: autoPayKeys.paymentMethods });
          }}
          onCancel={() => {
            setIsAddingCard(false);
          }}
        />
      )}
    </AutoPayShell>
  );
}
