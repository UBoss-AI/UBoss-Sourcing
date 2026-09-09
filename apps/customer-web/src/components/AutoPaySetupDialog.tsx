/**
 * Switching automatic payment on, from wherever the customer decided to.
 *
 * The flow the cart offers as one button, run as the two agreements it
 * actually is:
 *
 *   card    — no usable card on file, so one is enrolled first. Skipped
 *             entirely when the account already has one.
 *   consent — authorising THIS STORE to charge that card for scheduled orders
 *             while the customer is not present.
 *
 * Those two are kept apart on purpose, and the separation is the whole reason
 * this is a two-step dialog rather than one form with one tick. Saving a card
 * is not agreeing to be charged with it: a customer can reasonably want the
 * first without the second, and a single tick covering both would be consent
 * to the larger thing obtained by asking about the smaller one. The auto-pay
 * page makes the same distinction, and this must not undo it just because it
 * is a shortcut.
 *
 * Limits are deliberately NOT asked for here. "Never charge more than" and
 * "ask me first above" are real instructions with real consequences, and a
 * customer setting them should be looking at the page that explains them —
 * this dialog links there instead of reproducing it badly. Enabling with no
 * limits is what the auto-pay page's own defaults do, so nothing is being
 * assumed on the customer's behalf that they would not have got anyway.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CardSetupDialog } from '@/components/CardSetupDialog';
import { Modal } from '@/components/Modal';
import { AlertIcon } from '@/components/icons';
import { Button, LoadingState } from '@/components/ui';
import { api } from '@/lib/api';
import { autoPayApi, autoPayKeys } from '@/lib/autopay';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/i18n/i18n-context';

/** Only the fields this dialog needs to pick a card and name it. */
interface SavedCard {
  id: string;
  brand: string | null;
  last4: string | null;
  status: string;
  isDefault: boolean;
}

function cardLabel(card: SavedCard, fallbackName: string): string {
  return `${card.brand ?? fallbackName} ···· ${card.last4 ?? '****'}`;
}

interface AutoPaySetupDialogProps {
  onClose: () => void;
  /** Called once the server reports auto-pay ACTIVE. */
  onEnabled?: () => void;
}

export function AutoPaySetupDialog({
  onClose,
  onEnabled,
}: AutoPaySetupDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const [consentAccepted, setConsentAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Whether the card step is showing.
   *
   * Only ever set by the customer pressing "Add a card", never derived from
   * the cards query — a dialog that opened straight into a card form because
   * a read came back empty would be a surprise, and a read that came back
   * empty because it FAILED would be a misleading one.
   */
  const [isAddingCard, setIsAddingCard] = useState(false);
  const [justSavedCardId, setJustSavedCardId] = useState<string | null>(null);

  const cardsQuery = useQuery({
    queryKey: autoPayKeys.paymentMethods,
    queryFn: () =>
      api
        .get<{ paymentMethods: SavedCard[] }>('/account/payment-methods')
        .then((response) => response.paymentMethods),
    retry: false,
  });

  const usableCards = (cardsQuery.data ?? []).filter((card) => card.status === 'ACTIVE');

  /**
   * The card that will be charged.
   *
   * A card just saved in this dialog wins over the account default: the
   * customer added it in order to be charged, and silently enabling against a
   * different one would be answering a question they did not ask.
   */
  const chosen =
    usableCards.find((card) => card.id === justSavedCardId) ??
    usableCards.find((card) => card.isDefault) ??
    usableCards[0] ??
    null;

  const enable = useMutation({
    mutationFn: (paymentMethodId: string) =>
      autoPayApi.enable({ paymentMethodId, consentAccepted: true }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: autoPayKeys.settings });
      onEnabled?.();
      onClose();
    },
    onError: (cause: unknown) => {
      setError(errorMessage(t, cause, t('autopay.couldNotBeSwitchedOn')));
    },
  });

  // --- The card step -------------------------------------------------------

  if (isAddingCard) {
    return (
      <CardSetupDialog
        makeDefault
        onSaved={(card) => {
          setJustSavedCardId(card.id);
          setIsAddingCard(false);
          // The list this dialog picks from is now out of date.
          void queryClient.invalidateQueries({ queryKey: autoPayKeys.paymentMethods });
        }}
        onCancel={() => {
          // Back out of the whole thing rather than to a consent step with no
          // card to consent about.
          onClose();
        }}
      />
    );
  }

  if (cardsQuery.isPending) {
    return (
      <Modal isOpen onClose={onClose} title={t('autopay.setUpTitle')}>
        <LoadingState label={t('common.loading')} />
      </Modal>
    );
  }

  /*
   * No card on file: say so and offer the card step, rather than opening it
   * unannounced.
   *
   * A dialog the customer opened expecting "turn this on" should not become a
   * card form without a sentence explaining why. This is also the branch a
   * failed cards read lands in — if the list could not be fetched, offering to
   * add one is the safe move, because the enrolment call would refuse anyway
   * if the surface is switched off.
   */
  if (chosen === null) {
    return (
      <Modal
        isOpen
        onClose={onClose}
        title={t('autopay.setUpTitle')}
        description={t('autopay.cardFirstDescription')}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="action"
              onClick={() => {
                setIsAddingCard(true);
              }}
            >
              {t('autopay.addACard')}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-ink-muted">{t('autopay.noCardDescription')}</p>
      </Modal>
    );
  }

  // --- The consent step ----------------------------------------------------

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('autopay.setUpTitle')}
      description={t('autopay.setUpDescription')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={enable.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="action"
            disabled={!consentAccepted || enable.isPending}
            isLoading={enable.isPending}
            onClick={() => {
              setError(null);
              enable.mutate(chosen.id);
            }}
          >
            {t('autopay.turnOn')}
          </Button>
        </>
      }
    >
      {error !== null && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-3 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm"
        >
          <AlertIcon className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
          <p className="text-ink">{error}</p>
        </div>
      )}

      {/* Which card. Named, not implied: "your card" is not an answer when the
          account has three. */}
      <div className="rounded-md bg-surface-sunken px-4 py-3">
        <p className="text-xs text-ink-muted">{t('autopay.cardToCharge')}</p>
        <p className="mt-0.5 text-sm font-medium text-ink">
          {cardLabel(chosen, t('cardSetup.card'))}
        </p>
      </div>

      {/* Never pre-ticked, and the button above stays disabled until it is.
          Consent is given by the person in front of the screen, now. */}
      <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm leading-relaxed text-ink">
        <input
          type="checkbox"
          checked={consentAccepted}
          onChange={(event) => {
            setConsentAccepted(event.target.checked);
          }}
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-border text-brand focus:ring-brand"
        />
        <span>{t('autopay.consentStatement')}</span>
      </label>

      <p className="mt-3 text-xs leading-relaxed text-ink-subtle">
        {t('autopay.consentFootnote')}
      </p>

      {/* Where the limits live. Offered rather than reproduced — see the header. */}
      <p className="mt-3 text-xs">
        <Link
          to="/account/autopay"
          className="font-semibold text-brand underline underline-offset-2 hover:no-underline"
        >
          {t('autopay.setLimitsInstead')}
        </Link>
      </p>
    </Modal>
  );
}
