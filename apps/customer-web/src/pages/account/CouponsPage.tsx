/**
 * Coupons — what this customer could use, and what they have used.
 *
 * The available list is read from the same definition the cart reads, so a
 * code offered here is a code the cart will accept: one answer to "live,
 * publicly listed, priced in this currency", not two.
 *
 * What the page deliberately does not say is whether a coupon is *eligible*.
 * Eligibility depends on what is in the basket — the categories, the line
 * subtotals, whether this customer has redeemed it before — and the cart is
 * where that is evaluated, against a real basket. A page that printed
 * "eligible" against an empty cart would be promising something it cannot
 * know, and the promise would break at the one moment it mattered. The minimum
 * order value is stated instead, which is the fact somebody can act on.
 *
 * The codes are selectable and copyable, because the next thing anybody does
 * with a coupon code is paste it into the cart.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import { CopyIcon, TicketIcon } from '@/components/icons';
import { api } from '@/lib/api';
import { formatDate, formatMoneyMinor } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';
import type { AccountCouponOffer, AccountCouponUse } from '@/lib/types';
import { AccountPanel } from './AccountPanel';

interface CouponsResponse {
  currency: string;
  available: AccountCouponOffer[];
  used: AccountCouponUse[];
}

/** Copy a code, and say so. Falls back silently where the API is unavailable. */
function useCopyCode(): { copied: string | null; copy: (code: string) => void } {
  const { t } = useI18n();
  const toast = useToast();
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (code: string): void => {
    // `navigator.clipboard` is absent over plain HTTP and in jsdom. A coupon
    // code is four visible characters on the screen either way, so a failure
    // here is a convenience lost rather than a feature broken.
    if (typeof navigator.clipboard === 'undefined') return;

    void navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(code);
        toast.success(t('coupons.codeCopied'));
      })
      .catch(() => {
        // Denied by the browser. Nothing to say; the code is on screen.
      });
  };

  return { copied, copy };
}

export function CouponsPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  const { isCustomer } = useSession();
  const { copied, copy } = useCopyCode();

  useDocumentMeta({ title: t('account.nav.coupons'), noIndex: true }, business.displayName);

  const query = useQuery({
    queryKey: ['account-coupons'],
    queryFn: () => api.get<CouponsResponse>('/account/coupons'),
    enabled: isCustomer,
  });

  if (query.isPending) return <LoadingState label={t('coupons.loading')} />;

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

  const { available, used, currency } = query.data;

  return (
    <>
      <PageHeader title={t('account.nav.coupons')} description={t('coupons.description')} />

      <div className="space-y-6">
        <AccountPanel title={t('coupons.availableHeading')}>
          {available.length === 0 ? (
            <EmptyState
              title={t('coupons.noneAvailableTitle')}
              description={t('coupons.noneAvailableBody')}
            />
          ) : (
            <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {available.map((offer) => (
                <li
                  key={offer.code}
                  className="flex items-start gap-3 rounded-lg border border-border bg-surface-sunken p-4"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand ring-1 ring-inset ring-brand/15"
                  >
                    <TicketIcon className="h-[1.15rem] w-[1.15rem]" />
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      {/* A code, so it is monospaced and selectable. */}
                      <code className="rounded border border-border-strong bg-surface px-2 py-0.5 text-sm font-semibold tracking-wide text-ink">
                        {offer.code}
                      </code>
                      <Badge tone="success">
                        {t('coupons.percentOff', { percent: offer.discountPercent })}
                      </Badge>
                    </p>

                    <p className="mt-1.5 text-sm font-medium text-ink">{offer.name}</p>
                    {offer.description !== null && (
                      <p className="mt-0.5 text-sm leading-relaxed text-ink-muted">
                        {offer.description}
                      </p>
                    )}

                    <p className="mt-2 space-x-3 text-xs text-ink-muted">
                      {offer.minOrderMinor !== null && (
                        <span className="tabular">
                          {t('coupons.minimumOrder', {
                            amount: formatMoneyMinor(offer.minOrderMinor, currency),
                          })}
                        </span>
                      )}
                      {offer.validUntil !== null && (
                        <span>
                          {t('coupons.validUntil', { date: formatDate(offer.validUntil) })}
                        </span>
                      )}
                    </p>

                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2"
                      onClick={() => {
                        copy(offer.code);
                      }}
                    >
                      <CopyIcon aria-hidden="true" className="h-4 w-4" />
                      {copied === offer.code ? t('coupons.copied') : t('coupons.copyCode')}
                      <span className="sr-only"> {offer.code}</span>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Where a code is actually used. The page above is a list; the cart
              is the only place a coupon does anything. */}
          <p className="mt-5 border-t border-border-subtle pt-4 text-sm text-ink-muted">
            {t('coupons.applyAtCheckout')}{' '}
            <Link to="/cart" className="font-medium text-brand hover:underline">
              {t('coupons.goToBasket')}
            </Link>
          </p>
        </AccountPanel>

        <AccountPanel title={t('coupons.usedHeading')}>
          {used.length === 0 ? (
            <p className="text-sm text-ink-muted">{t('coupons.noneUsed')}</p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {used.map((entry) => (
                <li
                  key={`${entry.code}-${entry.usedAt}`}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink">
                      {/* The code as it was at redemption. A coupon can be
                          renamed or repercentaged afterwards, and what this
                          order actually received must not move. */}
                      {entry.code}
                    </span>
                    <span className="block text-xs text-ink-muted">
                      {entry.name} · {formatDate(entry.usedAt)}
                    </span>
                  </span>

                  <span className="shrink-0 text-right">
                    <span className="block text-sm font-medium tabular text-operational">
                      −{formatMoneyMinor(entry.discountMinor, entry.currency)}
                    </span>
                    <Link
                      to="/account/orders"
                      className="text-xs text-brand hover:underline"
                    >
                      {entry.orderNumber}
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </AccountPanel>
      </div>
    </>
  );
}
