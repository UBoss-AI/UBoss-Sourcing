/**
 * "Preorder" — the third way to buy, beside Add to Cart and Schedule Cart.
 *
 * It is on EVERY product page, and what it does is decided by the server, not
 * by this component:
 *
 *   - Open for preorder: pressing it opens the request form.
 *   - Not open (no seller terms, switched off, an operator product, a seller
 *     not trading): it stays visible and disabled, and says why underneath. A
 *     button that disappears teaches nobody the feature exists; a button that
 *     opens a form which then refuses is worse.
 *   - A guest: it is live, and pressing it goes to sign-in and comes back to
 *     this page with the form open, the variant still chosen.
 *   - A signed-in account with no company: disabled, with a link to add one.
 *     Preorders are a negotiation with a business.
 *
 * It is not Schedule Cart. A scheduled order buys what is on the shelf later;
 * a preorder asks a seller whether they can MAKE a quantity by a date, and
 * nothing is charged until the seller has answered and the buyer agreed.
 */
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { eligibilityQueryKey, fetchEligibility } from '@/lib/preorders';
import { PreorderDialog } from './PreorderDialog';

/** The query parameter that carries "open the preorder form" across sign-in. */
export const PREORDER_INTENT_PARAM = 'preorder';

export interface PreorderButtonProps {
  productId: string;
  productName: string;
  imageUrl: string | null;
  /** The one option chosen, or null for a product without options. */
  variantId: string | null;
  variantName: string | null;
  /**
   * False while a product with options has not had exactly one chosen. The
   * terms are per variant, so there is nothing to ask about yet.
   */
  isReady: boolean;
  /** The pieces typed on the product page; the form opens on this quantity. */
  pieces?: number | undefined;
  className?: string;
}

export function PreorderButton({
  productId,
  productName,
  imageUrl,
  variantId,
  variantName,
  isReady,
  pieces,
  className,
}: PreorderButtonProps): React.JSX.Element {
  const { t } = useI18n();
  const { isCustomer } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [isOpen, setIsOpen] = useState(false);

  const eligibility = useQuery({
    queryKey: [...eligibilityQueryKey(productId, variantId), isCustomer],
    queryFn: () => fetchEligibility(productId, variantId),
    enabled: isReady,
    staleTime: 60_000,
  });

  const answer = eligibility.data?.eligibility;
  const viewer = eligibility.data?.viewer;
  const available = answer?.available === true;
  const needsBusiness = available && viewer?.signedIn === true && !viewer.isBusinessBuyer;

  /*
   * Back from sign-in with the intent in the URL: open the form once, and take
   * the parameter off so a reload or a Back does not reopen it.
   */
  const intent = searchParams.get(PREORDER_INTENT_PARAM) === '1';
  useEffect(() => {
    if (!intent || !isCustomer || !available || needsBusiness) return;
    setIsOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete(PREORDER_INTENT_PARAM);
    setSearchParams(next, { replace: true });
  }, [intent, isCustomer, available, needsBusiness, searchParams, setSearchParams]);

  const disabled = !isReady || eligibility.isPending || !available || needsBusiness;

  let reason: React.ReactNode = null;
  if (!isReady) reason = t('preorder.chooseOptionFirst');
  else if (eligibility.isError) reason = t('preorder.couldNotCheck');
  else if (answer !== undefined && !answer.available) {
    reason = t(`preorder.unavailable.${answer.reason}` as TranslationKey);
  } else if (needsBusiness) {
    reason = (
      <>
        {t('preorder.needsBusinessAccount')}{' '}
        <Link to="/account/profile" className="font-medium text-brand underline underline-offset-2">
          {t('preorder.addCompany')}
        </Link>
      </>
    );
  }

  const reasonId = `preorder-reason-${productId}`;

  return (
    <div className={className}>
      <Button
        size="lg"
        variant="secondary"
        fullWidth
        disabled={disabled}
        isLoading={isReady && eligibility.isPending}
        aria-describedby={reason === null ? undefined : reasonId}
        onClick={() => {
          if (!isCustomer) {
            // Sign in, then come back to exactly this page - its query string
            // carries the variant - with the intent to preorder.
            const params = new URLSearchParams(location.search);
            params.set(PREORDER_INTENT_PARAM, '1');
            void navigate(`/login?next=${encodeURIComponent(`${location.pathname}?${params.toString()}`)}`);
            return;
          }
          setIsOpen(true);
        }}
      >
        <BoxesIcon />
        {t('preorder.button')}
      </Button>

      {reason !== null && (
        <p id={reasonId} className="mt-1.5 text-xs text-ink-muted">
          {reason}
        </p>
      )}

      {isOpen && answer?.available === true && (
        <PreorderDialog
          productId={productId}
          productName={productName}
          imageUrl={imageUrl}
          variantId={variantId}
          variantName={variantName}
          eligibility={answer}
          defaultAddressId={viewer?.addressId ?? null}
          initialPieces={pieces}
          onClose={() => {
            setIsOpen(false);
          }}
        />
      )}
    </div>
  );
}

function BoxesIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M3 8.5 7.5 6 12 8.5 7.5 11 3 8.5Z" strokeLinejoin="round" />
      <path d="M12 8.5 16.5 6 21 8.5 16.5 11 12 8.5Z" strokeLinejoin="round" />
      <path d="M3 8.5V14l4.5 2.5V11M12 8.5V14l-4.5 2.5M12 8.5V14l4.5 2.5V11M21 8.5V14l-4.5 2.5" strokeLinejoin="round" />
    </svg>
  );
}
