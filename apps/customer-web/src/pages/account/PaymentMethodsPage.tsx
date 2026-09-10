/**
 * Saved cards.
 *
 * **No card number ever reaches this application, and none is ever stored in
 * its database.** The card is entered into a Stripe Elements iframe served
 * from Stripe's own origin — see `components/CardSetupDialog.tsx` — and what
 * comes back here is a mandate reference plus the brand and last four digits
 * Stripe chooses to tell us. That is the whole of what `customer_payment_methods`
 * holds. Anything that made this page able to display or re-submit a card
 * number would move this deployment inside PCI DSS scope, which is a
 * compliance obligation the operator has not signed up for by installing a
 * purchasing system.
 *
 * Removing a card is refused by the server while auto-pay depends on it, and
 * that refusal is the right behaviour rather than an inconvenience: a
 * scheduled order due next week against a detached mandate is a failed charge
 * and an undelivered consumable. The message says which arrangement is holding
 * it, and the page links there.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { CardSetupDialog } from '@/components/CardSetupDialog';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/ui';
import { CardIcon, CheckIcon, ChevronRightIcon, ShieldIcon, TrashIcon } from '@/components/icons';
import { cardExpiry, useCardLabel } from '@/lib/cards';
import type { SavedCard } from '@/lib/types';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';
import { AccountPanel } from './AccountPanel';

/**
 * Shared with the checkout, which reads the same list to offer the customer
 * their own cards. One key, so saving a card at a payment and coming back here
 * shows it without a reload.
 */
const PAYMENT_METHODS_KEY = ['payment-methods'];

export function PaymentMethodsPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business, features } = useStorefront();
  const { isCustomer } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const cardLabel = useCardLabel();

  useDocumentMeta(
    { title: t('account.nav.savedPaymentMethods'), noIndex: true },
    business.displayName,
  );

  const [isAdding, setIsAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const cards = useQuery({
    queryKey: PAYMENT_METHODS_KEY,
    queryFn: () =>
      api
        .get<{ paymentMethods: SavedCard[] }>('/account/payment-methods')
        .then((response) => response.paymentMethods),
    enabled: isCustomer,
  });

  const makeDefault = useMutation({
    mutationFn: (id: string) => api.post(`/account/payment-methods/${id}/default`, {}),
    onSuccess: async () => {
      setActionError(null);
      toast.success(t('paymentMethods.defaultChanged'));
      await queryClient.invalidateQueries({ queryKey: PAYMENT_METHODS_KEY });
    },
    onError: (error) => {
      setActionError(errorMessage(t, error, t('paymentMethods.couldNotChangeDefault')));
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/account/payment-methods/${id}`),
    onSuccess: async () => {
      setActionError(null);
      toast.success(t('paymentMethods.cardRemoved'));
      await queryClient.invalidateQueries({ queryKey: PAYMENT_METHODS_KEY });
    },
    onError: (error) => {
      // The server's own sentence, which names the arrangement still using the
      // card. A generic "could not remove" would leave the customer with no
      // idea what to do about it.
      setActionError(errorMessage(t, error, t('paymentMethods.couldNotRemoveCard')));
    },
  });

  if (cards.isPending) return <LoadingState label={t('paymentMethods.loading')} />;

  if (cards.isError) {
    return (
      <ErrorState
        error={cards.error}
        onRetry={() => {
          void cards.refetch();
        }}
      />
    );
  }

  const saved = cards.data;

  return (
    <>
      <PageHeader
        title={t('account.nav.savedPaymentMethods')}
        description={t('paymentMethods.description')}
      />

      <div className="space-y-6">
        <AccountPanel title={t('paymentMethods.yourCards')}>
          {actionError !== null && (
            <div
              role="alert"
              className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
            >
              {actionError}
            </div>
          )}

          {saved.length === 0 ? (
            <EmptyState
              title={t('paymentMethods.noCardsTitle')}
              description={t('paymentMethods.noCardsBody')}
            />
          ) : (
            <ul className="divide-y divide-border-subtle">
              {saved.map((card) => {
                const label = cardLabel(card);
                const expires = cardExpiry(card);
                const isUsable = card.status === 'ACTIVE';

                return (
                  <li
                    key={card.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0"
                  >
                    <span
                      aria-hidden="true"
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand ring-1 ring-inset ring-brand/15"
                    >
                      <CardIcon className="h-[1.15rem] w-[1.15rem]" />
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-ink">{label}</span>
                        {card.isDefault && (
                          <Badge tone="success">{t('paymentMethods.defaultCard')}</Badge>
                        )}
                        {!isUsable && (
                          <Badge tone="warning">{t('paymentMethods.notUsable')}</Badge>
                        )}
                        {/*
                          Which of the two headings this card sits under at a
                          checkout. Absent where the gateway would not say -
                          a prepaid card - and it is offered under both there,
                          so a label here would be a claim nothing supports.
                        */}
                        {card.instrument !== null && (
                          <Badge tone="neutral">
                            {card.instrument === 'CREDIT_CARD'
                              ? t('paymentMethods.creditCard')
                              : t('paymentMethods.debitCard')}
                          </Badge>
                        )}
                        {/*
                          What this card is allowed to do, which is the fact a
                          customer looking at a list of identical-looking cards
                          most needs and cannot otherwise see.

                          Only the narrower scope is labelled. A card that can
                          be charged unattended is the assumption this screen
                          was built around, and badging every one of those
                          would make the exception invisible among them.
                        */}
                        {isUsable && card.consentScope === 'CHECKOUT' && (
                          <Badge tone="neutral">{t('paymentMethods.checkoutOnly')}</Badge>
                        )}
                      </span>
                      {expires !== null && (
                        <span className="mt-0.5 block text-xs tabular text-ink-muted">
                          {t('paymentMethods.expires', { date: expires })}
                        </span>
                      )}
                    </span>

                    <span className="flex shrink-0 items-center gap-1.5">
                      {!card.isDefault && isUsable && (
                        <Button
                          variant="ghost"
                          size="sm"
                          isLoading={makeDefault.isPending && makeDefault.variables === card.id}
                          onClick={() => {
                            makeDefault.mutate(card.id);
                          }}
                        >
                          <CheckIcon aria-hidden="true" className="h-4 w-4" />
                          {t('paymentMethods.makeDefault')}
                        </Button>
                      )}

                      <Button
                        variant="ghost"
                        size="sm"
                        isLoading={remove.isPending && remove.variables === card.id}
                        onClick={() => {
                          remove.mutate(card.id);
                        }}
                      >
                        <TrashIcon aria-hidden="true" className="h-4 w-4" />
                        {t('common.delete')}
                        <span className="sr-only"> {label}</span>
                      </Button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-5 border-t border-border-subtle pt-4">
            <Button
              variant="primary"
              onClick={() => {
                setActionError(null);
                setIsAdding(true);
              }}
            >
              {t('paymentMethods.addACard')}
            </Button>

            {/* Where the card actually goes. Stated on the page rather than
                only inside the dialog: somebody deciding whether to trust this
                screen with a card is deciding before they open it. */}
            <p className="mt-3 flex max-w-prose items-start gap-2 text-xs leading-relaxed text-ink-muted">
              <ShieldIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle" />
              {t('paymentMethods.pciNote')}
            </p>
          </div>
        </AccountPanel>

        {/* Where a saved card is used unattended, which is the one thing a
            customer needs to know about a card that sits here. Absent on a
            deployment with recurring orders switched off, where there is
            nothing for a stored card to be charged by. */}
        {features.recurringOrders && (
          <AccountPanel title={t('paymentMethods.autoPayHeading')}>
            <p className="max-w-prose text-sm leading-relaxed text-ink-muted">
              {t('paymentMethods.autoPayBody')}
            </p>
            <p className="mt-3">
              <Link
                to="/account/autopay"
                className="inline-flex items-center gap-1 rounded text-sm font-medium text-brand hover:underline"
              >
                {t('account.nav.autoPaySettings')}
                <ChevronRightIcon aria-hidden="true" className="h-4 w-4" />
              </Link>
            </p>
          </AccountPanel>
        )}
      </div>

      {/* Mounted only while open: a closed `<dialog>` in this design system is
          still `display: flex`, so it would otherwise sit visible under the
          page. Every other Modal in the storefront is mounted the same way. */}
      {isAdding && (
        <CardSetupDialog
          onSaved={() => {
            setIsAdding(false);
            toast.success(t('paymentMethods.cardSaved'));
            void queryClient.invalidateQueries({ queryKey: PAYMENT_METHODS_KEY });
          }}
          onCancel={() => {
            setIsAdding(false);
          }}
        />
      )}
    </>
  );
}
