/**
 * Back from Stripe Checkout.
 *
 * Stripe sends the customer here with `?session_id=cs_...`. That arrival
 * proves nothing - anybody can type the address - so this page does not say
 * "paid" because it was reached. It asks the backend what happened to that
 * session, and the backend answers from its own records, which only Stripe's
 * signed webhook (or Stripe's API, asked by the server) ever advances.
 *
 * The webhook usually lands before the customer does, and sometimes a few
 * seconds after. So the first state is honest - "Confirming payment…" - and
 * the page asks again every couple of seconds for a limited time. After that
 * it says the confirmation is delayed, that the payment has not been lost,
 * and offers "Check again", which has the server ask Stripe directly.
 *
 * Nothing on this page can start, repeat or change a payment. "Retry payment"
 * appears only once the backend says the attempt closed without money moving,
 * and it goes back to the payment page, which asks the server for a fresh
 * Stripe page for the same order.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { CheckoutSteps } from '@/components/CheckoutSteps';
import { AlertIcon, CheckIcon, ClockIcon } from '@/components/icons';
import { Button, ButtonLink, ErrorState, Spinner } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { paymentSteps } from '@/lib/checkout-steps';
import { cx } from '@/lib/cx';
import { formatDateTime, formatMoney } from '@/lib/format';
import { orderStatusLabel } from '@/lib/order-status';
import type { CheckoutConfirmation } from '@/lib/types';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { translateKey, useI18n, type TranslationKey } from '@/i18n/i18n-context';

/** How long to keep asking before saying the confirmation is delayed. */
const POLL_FOR_SECONDS = 60;
const POLL_INTERVAL_MS = 2000;

/** Stripe's session ids. Anything else is not worth a request. */
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{8,180}$/;

const STATE_COPY: Record<
  CheckoutConfirmation['state'] | 'DELAYED',
  { title: TranslationKey; body: TranslationKey; tone: 'brand' | 'success' | 'warning' | 'danger' }
> = {
  CONFIRMING: { title: 'paymentConfirmation.confirmingTitle', body: 'paymentConfirmation.confirmingBody', tone: 'brand' },
  SUCCEEDED: { title: 'paymentConfirmation.successTitle', body: 'paymentConfirmation.successBody', tone: 'success' },
  PROCESSING: { title: 'paymentConfirmation.processingTitle', body: 'paymentConfirmation.processingBody', tone: 'brand' },
  FAILED: { title: 'paymentConfirmation.failedTitle', body: 'paymentConfirmation.failedBody', tone: 'danger' },
  CANCELLED: { title: 'paymentConfirmation.cancelledTitle', body: 'paymentConfirmation.cancelledBody', tone: 'warning' },
  EXPIRED: { title: 'paymentConfirmation.expiredTitle', body: 'paymentConfirmation.expiredBody', tone: 'warning' },
  DELAYED: { title: 'paymentConfirmation.delayedTitle', body: 'paymentConfirmation.delayedBody', tone: 'warning' },
};

/** "visa" -> "Visa". Stripe's brand words, made readable; never translated. */
const BRAND_NAMES: Readonly<Record<string, string>> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  rupay: 'RuPay',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
  cartes_bancaires: 'Cartes Bancaires',
  eftpos_au: 'eftpos',
};

function brandName(brand: string | null): string | null {
  if (brand === null || brand.length === 0) return null;
  return BRAND_NAMES[brand.toLowerCase()] ?? brand.charAt(0).toUpperCase() + brand.slice(1);
}

export function PaymentConfirmationPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  const queryClient = useQueryClient();

  const { orderId } = useParams<{ orderId: string }>();
  const [params] = useSearchParams();
  const sessionId = params.get('session_id') ?? '';
  const validSession = SESSION_ID.test(sessionId);

  useDocumentMeta({ title: t('paymentConfirmation.pageTitle'), noIndex: true }, business.displayName);

  const startedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  const queryKey = ['checkout-confirmation', orderId, sessionId] as const;

  const confirmation = useQuery({
    queryKey,
    queryFn: () =>
      api.get<CheckoutConfirmation>(
        `/payments/orders/${String(orderId)}/checkout/${encodeURIComponent(sessionId)}`,
      ),
    enabled: orderId !== undefined && validSession,
    // Asked again only while the answer is still open, and only for a while.
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      const open = state === undefined || state === 'CONFIRMING' || state === 'PROCESSING';
      return open && elapsed < POLL_FOR_SECONDS ? POLL_INTERVAL_MS : false;
    },
    // A blip is retried; "not yours, or not a payment" is an answer, not a blip.
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });

  const state = confirmation.data?.state;
  const waiting = state === 'CONFIRMING' || state === 'PROCESSING';

  useEffect(() => {
    if (!waiting) return undefined;

    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [waiting]);

  /** "Check again": the server asks Stripe. Never starts a payment. */
  const refresh = useMutation({
    mutationFn: () =>
      api.post<CheckoutConfirmation>(
        `/payments/orders/${String(orderId)}/checkout/${encodeURIComponent(sessionId)}/refresh`,
        {},
      ),
    onSuccess: (view) => {
      queryClient.setQueryData(queryKey, view);
      // Another minute of patience after a manual check that is still open.
      startedAt.current = Date.now();
      setElapsed(0);
    },
  });

  // The heading moves focus when the outcome changes, so a screen reader user
  // hears the new state rather than the old spinner.
  const heading = useRef<HTMLHeadingElement | null>(null);
  const shownState = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (state === undefined || shownState.current === state) return;
    if (shownState.current !== undefined) heading.current?.focus();
    shownState.current = state;
  }, [state]);

  if (!validSession || orderId === undefined) {
    return (
      <div className="mx-auto max-w-2xl py-8">
        <Panel tone="warning" icon={<AlertIcon className="h-6 w-6" />} title={t('paymentConfirmation.notFoundTitle')}>
          <p>{t('paymentConfirmation.notFoundBody')}</p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <ButtonLink to="/account/orders" variant="primary">
              {t('payment.allYourOrders')}
            </ButtonLink>
          </div>
        </Panel>
      </div>
    );
  }

  if (confirmation.isError) {
    if (confirmation.error instanceof ApiError && confirmation.error.status === 404) {
      return (
        <div className="mx-auto max-w-2xl py-8">
          <Panel tone="warning" icon={<AlertIcon className="h-6 w-6" />} title={t('paymentConfirmation.notFoundTitle')}>
            <p>{t('paymentConfirmation.notFoundBody')}</p>
          </Panel>
        </div>
      );
    }

    return (
      <ErrorState
        error={confirmation.error}
        onRetry={() => {
          void confirmation.refetch();
        }}
      />
    );
  }

  const view = confirmation.data;
  const delayed = waiting && elapsed >= POLL_FOR_SECONDS;
  const copyKey = view === undefined ? 'CONFIRMING' : delayed ? 'DELAYED' : view.state;
  const copy = STATE_COPY[copyKey];
  const succeeded = view?.state === 'SUCCEEDED';

  const icon =
    copyKey === 'SUCCEEDED' ? (
      <CheckIcon className="h-6 w-6" />
    ) : copyKey === 'CONFIRMING' || copyKey === 'PROCESSING' ? (
      <Spinner className="h-6 w-6" />
    ) : copyKey === 'DELAYED' ? (
      <ClockIcon className="h-6 w-6" />
    ) : (
      <AlertIcon className="h-6 w-6" />
    );

  const brand = view?.card === null || view?.card === undefined ? null : brandName(view.card.brand);

  return (
    <div className="mx-auto max-w-2xl py-4">
      <CheckoutSteps states={paymentSteps(succeeded)} />

      <Panel
        tone={copy.tone}
        icon={icon}
        title={translateKey(t, copy.title)}
        headingRef={heading}
        // Every change of outcome is announced; a failure interrupts.
        live={copy.tone === 'danger' ? 'assertive' : 'polite'}
      >
        <p>
          {copyKey === 'SUCCEEDED' && view !== undefined
            ? t('paymentConfirmation.successBody', { order: view.orderNumber })
            : translateKey(t, copy.body)}
        </p>

        {view?.failureReason !== null && view?.failureReason !== undefined && !succeeded && (
          <p className="mt-2 font-medium">
            {translateKey(t, `paymentConfirmation.reason.${view.failureReason}` as TranslationKey)}
          </p>
        )}

        {view?.state === 'FAILED' && (
          <p className="mt-2 text-ink-muted">{t('paymentConfirmation.savedCardHint')}</p>
        )}

        {view !== undefined && (
          <dl className="mx-auto mt-6 max-w-sm space-y-2 rounded-md bg-surface px-4 py-3 text-left text-sm">
            <Detail label={t('paymentConfirmation.orderNumber')}>
              <span className="font-mono">{view.orderNumber}</span>
            </Detail>
            <Detail label={t('paymentConfirmation.amount')}>
              <span className="tabular">{formatMoney(view.amount)}</span>
            </Detail>
            {view.paidAt !== null && (
              <Detail label={t('paymentConfirmation.paidAt')}>{formatDateTime(view.paidAt)}</Detail>
            )}
            {view.card !== null && (
              <Detail label={t('paymentConfirmation.paymentMethod')}>
                {brand === null
                  ? t('paymentConfirmation.cardEndingNoBrand', { last4: view.card.last4 })
                  : t('paymentConfirmation.cardEnding', { brand, last4: view.card.last4 })}
              </Detail>
            )}
            <Detail label={t('paymentConfirmation.orderStatus')}>
              {orderStatusLabel(t, view.orderStatus)}
            </Detail>
          </dl>
        )}

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {view?.state === 'SUCCEEDED' && (
            <>
              <ButtonLink to={`/account/orders/${view.orderId}`} variant="primary" size="lg">
                {t('paymentConfirmation.viewOrder')}
              </ButtonLink>
              <ButtonLink to="/products" size="lg">
                {t('paymentConfirmation.continueShopping')}
              </ButtonLink>
            </>
          )}

          {(delayed || view?.state === 'PROCESSING') && (
            <Button
              size="lg"
              isLoading={refresh.isPending}
              disabled={refresh.isPending}
              onClick={() => {
                refresh.mutate();
              }}
            >
              {refresh.isPending ? t('paymentConfirmation.checking') : t('paymentConfirmation.checkAgain')}
            </Button>
          )}

          {view?.canRetry === true && (
            <ButtonLink to={`/checkout/payment/${view.orderId}`} variant="action" size="lg">
              {t('paymentConfirmation.retryPayment')}
            </ButtonLink>
          )}

          {!succeeded && view !== undefined && (
            <ButtonLink to={`/account/orders/${view.orderId}`} size="lg">
              {t('paymentConfirmation.viewOrder')}
            </ButtonLink>
          )}
        </div>

        {refresh.isError && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {t('paymentConfirmation.checkFailed')}
          </p>
        )}
      </Panel>

      <p className="mt-4 text-center text-xs text-ink-muted">
        <Link to="/account/orders" className="font-medium text-brand hover:underline">
          {t('payment.allYourOrders')}
        </Link>
      </p>
    </div>
  );
}

function Panel({
  tone,
  icon,
  title,
  children,
  headingRef,
  live = 'polite',
}: {
  tone: 'brand' | 'success' | 'warning' | 'danger';
  icon: React.JSX.Element;
  title: string;
  children: React.ReactNode;
  headingRef?: React.Ref<HTMLHeadingElement>;
  live?: 'polite' | 'assertive';
}): React.JSX.Element {
  const tones = {
    brand: 'border-brand/30 bg-brand-soft',
    success: 'border-success/30 bg-success-soft',
    warning: 'border-warning/30 bg-warning-soft',
    danger: 'border-danger/30 bg-danger-soft',
  } as const;

  const badge = {
    brand: 'bg-brand-fill',
    success: 'bg-success-fill',
    warning: 'bg-warning-fill',
    danger: 'bg-danger-fill',
  } as const;

  return (
    <div className={cx('rounded-lg border p-6 text-center shadow-card sm:p-8', tones[tone])}>
      <span
        aria-hidden="true"
        className={cx('mx-auto flex h-12 w-12 items-center justify-center rounded-full text-white', badge[tone])}
      >
        {icon}
      </span>
      <div role="status" aria-live={live} aria-atomic="true">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="mt-4 text-title-lg text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          {title}
        </h1>
      </div>
      <div className="mt-2 text-sm text-ink">{children}</div>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-right text-ink">{children}</dd>
    </div>
  );
}
