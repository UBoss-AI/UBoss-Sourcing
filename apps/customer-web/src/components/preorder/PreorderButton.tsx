/**
 * "Preorder" — the third way to buy, beside Add to Cart and Schedule Cart.
 *
 * It is on EVERY product page, and what it does is decided by the server, not
 * by this component:
 *
 *   - Open for preorder: pressing it opens the request form (after the note
 *     below, the first time).
 *   - Not open (no seller terms, switched off, an operator product, a seller
 *     not trading): it stays visible and disabled, and says why underneath. A
 *     button that disappears teaches nobody the feature exists; a button that
 *     opens a form which then refuses is worse.
 *   - A guest: it is live, and pressing it goes to sign-in and comes back to
 *     this page with the form open, the variant still chosen.
 *   - A signed-in account with no company: disabled, with a link to add one.
 *     Preorders are a negotiation with a business.
 *
 * THREE WAYS IN, ONE WAY THROUGH
 *
 * The circular i inside its right end, the "Ordering in bulk?" suggestion when the
 * quantity reaches the minimum, and pressing Preorder itself all call
 * `startPreorder`. It asks the buyer to read how bulk preorders work the first
 * time (per version of that note, recorded by the server), and then opens the
 * same request form with the product, the option and the quantity on the page
 * carried into it. Every one of them states the same minimum, because every
 * one reads it from the same eligibility answer.
 *
 * It is not Schedule Cart. A scheduled order buys what is on the shelf later;
 * a preorder asks a seller whether they can MAKE a quantity by a date, and
 * nothing is charged until the seller has answered and the buyer agreed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { eligibilityQueryKey, fetchEligibility } from '@/lib/preorders';
import {
  BULK_PROMPT_SETTLE_MS,
  acknowledgePreorderInfo,
  crossedBulkThreshold,
  emitPreorderEvent,
  hasGuestAcknowledgement,
  isBulkPromptDismissed,
  rememberBulkPromptDismissed,
  rememberGuestAcknowledgement,
  takeGuestAcknowledgement,
} from '@/lib/preorder-info';
import {
  CONVERSATION_PARAM,
  PROPOSAL_PARAM,
  fetchProposal,
  markProposalSubmitted,
} from '@/lib/preorder-chat';
import type { PreorderUnit } from '@/lib/preorders';
import { ChatWithUbossButton } from '@/components/preorder-chat/ChatWithUbossButton';
import { BulkPreorderPrompt } from './BulkPreorderPrompt';
import { PreorderDialog } from './PreorderDialog';
import { PreorderInfoDialog } from './PreorderInfoDialog';

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
  /**
   * Whether Add to Cart takes the quantity on the page, for the bulk
   * suggestion's "Continue with regular order". Null where it is not the
   * question - a guest, who signs in to buy either way.
   */
  regularOrderAllowed?: boolean | null;
  /**
   * The page's quantity decision asked for the stock prompt: the buyer settled
   * on more than can be promised from stock. Drawn here because this component
   * owns the preorder terms and the form. Null when not asked.
   */
  stockPrompt?: { requested: number; stock: number } | null;
  /** The stock prompt closed: 'preorder' went on to the form, 'change' wants the quantity box. */
  onStockPromptClose?: (outcome: 'preorder' | 'change' | 'dismiss') => void;
  /**
   * Another dialog of the page's own is open. The minimum-order suggestion
   * then waits, so the page never shows two dialogs at once.
   */
  blocked?: boolean;
  /** Told whenever one of this component's dialogs opens or closes. */
  onDialogChange?: (open: boolean) => void;
  className?: string;
}

/** Which dialog is up, if any. The request form is separate state. */
type Panel = null | 'info' | 'prompt';

export function PreorderButton({
  productId,
  productName,
  imageUrl,
  variantId,
  variantName,
  isReady,
  pieces,
  regularOrderAllowed = null,
  stockPrompt = null,
  onStockPromptClose,
  blocked = false,
  onDialogChange,
  className,
}: PreorderButtonProps): React.JSX.Element {
  const { t } = useI18n();
  const { isCustomer } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [isOpen, setIsOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  /** The pieces the form opens on: those on the page when the buyer started. */
  const [formPieces, setFormPieces] = useState<number | undefined>(undefined);
  /** Recorded in this page view, before the eligibility answer is refetched. */
  const [acknowledgedHere, setAcknowledgedHere] = useState<string | null>(null);

  const preorderButtonRef = useRef<HTMLButtonElement | null>(null);

  /**
   * A UBOSS proposal from the chat, being turned into a real preorder request.
   * It only fills the form in; the buyer still reviews it, accepts the terms
   * and sends it, and the supplier's answer is what binds anybody.
   */
  const [proposal, setProposal] = useState<{
    conversationId: string;
    proposalId: string;
    prefill: { orderingUnit: PreorderUnit; unitQuantity: number; requestedDeliveryDate: string };
  } | null>(null);
  const [proposalNotice, setProposalNotice] = useState<string | null>(null);
  /** Where the info dialog is anchored, and where focus goes back to. */
  const anchorRef = useRef<HTMLElement | null>(null);

  const eligibility = useQuery({
    queryKey: [...eligibilityQueryKey(productId, variantId), isCustomer],
    queryFn: () => fetchEligibility(productId, variantId),
    enabled: isReady,
    staleTime: 60_000,
  });

  const answer = isReady ? eligibility.data?.eligibility : undefined;
  const viewer = eligibility.data?.viewer;
  const available = answer?.available === true;
  const terms = answer?.available === true ? answer : null;
  const needsBusiness = available && viewer?.signedIn === true && !viewer.isBusinessBuyer;
  const policyVersion = viewer?.preorderInfo.policyVersion ?? null;
  const acknowledged =
    policyVersion !== null &&
    (viewer?.preorderInfo.acknowledged === true || acknowledgedHere === policyVersion);
  const canPreorder = isReady && available && !needsBusiness && policyVersion !== null;
  /** The bulk threshold IS the minimum, in pieces - one figure, from the server. */
  const threshold = terms?.moq.minimumBaseUnits ?? null;

  const signInThenPreorder = useCallback((): void => {
    // Sign in, then come back to exactly this page - its query string
    // carries the variant - with the intent to preorder.
    const params = new URLSearchParams(location.search);
    params.set(PREORDER_INTENT_PARAM, '1');
    void navigate(`/login?next=${encodeURIComponent(`${location.pathname}?${params.toString()}`)}`);
  }, [location.pathname, location.search, navigate]);

  const openForm = useCallback(
    (at: number | undefined): void => {
      setPanel(null);
      setFormPieces(at);
      setIsOpen(true);
      emitPreorderEvent('preorder_form_opened', { productId, variantId });
    },
    [productId, variantId],
  );

  const acknowledge = useMutation({
    mutationFn: (version: string) => acknowledgePreorderInfo(version),
    onSuccess: (result) => {
      setAcknowledgedHere(result.acknowledgement.policyVersion);
      emitPreorderEvent('preorder_info_acknowledged', { productId, variantId });
      void queryClient.invalidateQueries({ queryKey: ['preorder', 'eligibility', productId] });
      openForm(pieces);
    },
    onError: (error) => {
      // The note changed while it was open: fetch the current one to read.
      if (error instanceof ApiError && error.code === 'PREORDER_INFO_OUTDATED') {
        void eligibility.refetch();
      }
    },
  });

  /**
   * Every way into a preorder comes through here.
   *
   * Read the note first if this buyer has not (at this version); otherwise
   * straight to the form. A guest reads it too, and then signs in.
   */
  const startPreorder = useCallback(
    (anchor: HTMLElement | null): void => {
      if (!canPreorder) return;
      anchorRef.current = anchor;
      if (!isCustomer) {
        if (hasGuestAcknowledgement(policyVersion)) signInThenPreorder();
        else setPanel('info');
        return;
      }
      if (acknowledged) openForm(pieces);
      else setPanel('info');
    },
    [acknowledged, canPreorder, isCustomer, openForm, pieces, policyVersion, signInThenPreorder],
  );

  /*
   * Back from sign-in with the intent in the URL: take the parameter off so a
   * reload or a Back does not reopen anything, then carry on. A guest who
   * ticked the box before signing in has it recorded now, against the account
   * they signed in to - the server checks the version as it always does.
   */
  const intent = searchParams.get(PREORDER_INTENT_PARAM) === '1';
  const intentHandled = useRef(false);
  const { mutate: recordAcknowledgement } = acknowledge;
  useEffect(() => {
    // The bulk-savings card sets the same parameter from this page, and may
    // do it again later; each arrival is handled once.
    if (!intent) {
      intentHandled.current = false;
      return;
    }
    if (!isCustomer || !canPreorder) return;
    if (intentHandled.current) return;
    intentHandled.current = true;
    const next = new URLSearchParams(searchParams);
    next.delete(PREORDER_INTENT_PARAM);
    setSearchParams(next, { replace: true });

    const carried = takeGuestAcknowledgement();
    if (!acknowledged && carried === policyVersion) {
      recordAcknowledgement(policyVersion);
      return;
    }
    startPreorder(preorderButtonRef.current);
  }, [
    intent,
    isCustomer,
    canPreorder,
    policyVersion,
    acknowledged,
    recordAcknowledgement,
    searchParams,
    setSearchParams,
    startPreorder,
  ]);

  /*
   * The bulk suggestion. It arms on the step that CROSSES the minimum, and
   * appears once the quantity has rested there for a moment - so typing
   * "10000" or holding + crosses once and shows it once, and a quantity that
   * goes back under before it settles shows nothing. A change of option moves
   * the threshold rather than the buyer's quantity, and does not count.
   */
  const previousPieces = useRef(pieces);
  const previousThreshold = useRef(threshold);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const before = previousPieces.current;
    const thresholdBefore = previousThreshold.current;
    previousPieces.current = pieces;
    previousThreshold.current = threshold;
    if (threshold === null || pieces === undefined) return;
    if (thresholdBefore !== threshold) {
      setArmed(false);
      return;
    }
    if (crossedBulkThreshold(before, pieces, threshold)) setArmed(true);
    else if (pieces < threshold) setArmed(false);
  }, [pieces, threshold]);

  useEffect(() => {
    if (!armed || threshold === null || policyVersion === null) return undefined;
    const timer = window.setTimeout(() => {
      setArmed(false);
      if (!canPreorder || panel !== null || isOpen || blocked || stockPrompt !== null) return;
      if (isBulkPromptDismissed(productId, variantId, threshold, policyVersion)) return;
      // Once per product, minimum and note version, for this session.
      rememberBulkPromptDismissed(productId, variantId, threshold, policyVersion);
      anchorRef.current = preorderButtonRef.current;
      setPanel('prompt');
      emitPreorderEvent('bulk_threshold_reached', { productId, variantId });
    }, BULK_PROMPT_SETTLE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [armed, pieces, threshold, policyVersion, canPreorder, panel, isOpen, blocked, stockPrompt, productId, variantId]);

  // The page's coordinator needs to know when this component has the screen.
  const hasDialog = panel !== null || isOpen;
  useEffect(() => {
    onDialogChange?.(hasDialog);
  }, [hasDialog, onDialogChange]);

  // Asked for a stock prompt this component cannot honour (no preorder terms
  // for this version): hand the screen straight back.
  useEffect(() => {
    if (stockPrompt === null || !isReady || eligibility.isPending) return;
    if (terms === null) onStockPromptClose?.('dismiss');
  }, [stockPrompt, isReady, eligibility.isPending, terms, onStockPromptClose]);

  /*
   * Focus goes back to whatever opened the dialog - but only once the dialog
   * has left the DOM. While a modal <dialog> is open the page behind it is
   * inert and refuses focus, so focusing from the close handler (or the next
   * frame, which can come before React commits) left focus on <body>.
   */
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (panel !== null || isOpen) return;
    const target = restoreFocusTo.current;
    restoreFocusTo.current = null;
    if (target?.isConnected === true) target.focus();
  }, [panel, isOpen]);

  /** Close a dialog and put focus back on whatever opened it. */
  const closeAndRestoreFocus = (): void => {
    restoreFocusTo.current = anchorRef.current ?? preorderButtonRef.current;
    setPanel(null);
    acknowledge.reset();
  };

  /*
   * "Review proposal": open the ordinary form on the proposal's figures. From
   * the chat drawer on this page directly; from Account -> Messages by way of
   * `?proposal=<id>&conversation=<id>` in this page's URL.
   */
  const reviewProposal = useCallback(
    (conversationId: string, proposalId: string): void => {
      setProposalNotice(null);
      void fetchProposal(conversationId, proposalId)
        .then((result) => {
          if (result.prefill.variantId !== variantId) {
            setProposalNotice(t('preorderChat.proposal.variantMismatch'));
            return;
          }
          setProposal({
            conversationId,
            proposalId,
            prefill: {
              orderingUnit: result.prefill.orderingUnit,
              unitQuantity: result.prefill.unitQuantity,
              requestedDeliveryDate: result.prefill.requestedDeliveryDate,
            },
          });
          startPreorder(preorderButtonRef.current);
        })
        .catch((error: unknown) => {
          setProposalNotice(errorMessage(t, error));
        });
    },
    [variantId, startPreorder, t],
  );

  const proposalParam = searchParams.get(PROPOSAL_PARAM);
  const conversationParam = searchParams.get(CONVERSATION_PARAM);
  useEffect(() => {
    if (proposalParam === null || conversationParam === null) return;
    if (!isCustomer || !canPreorder) return;
    const next = new URLSearchParams(searchParams);
    next.delete(PROPOSAL_PARAM);
    next.delete(CONVERSATION_PARAM);
    setSearchParams(next, { replace: true });
    reviewProposal(conversationParam, proposalParam);
  }, [proposalParam, conversationParam, isCustomer, canPreorder, searchParams, setSearchParams, reviewProposal]);

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

  // The same reason, as a sentence the info dialog can show in place of a
  // minimum it does not have.
  let unavailableReason: string | null = null;
  if (!isReady) unavailableReason = t('preorder.chooseOptionFirst');
  else if (eligibility.isError) unavailableReason = t('preorder.couldNotCheck');
  else if (answer !== undefined && !answer.available) {
    unavailableReason = t(`preorder.unavailable.${answer.reason}` as TranslationKey);
  } else if (needsBusiness) unavailableReason = t('preorder.needsBusinessAccount');

  const guestHasRead =
    !isCustomer && policyVersion !== null && hasGuestAcknowledgement(policyVersion);

  const reasonId = `preorder-reason-${productId}`;

  return (
    <div className={className}>
      {/* [ Preorder  (i) ] [ chat ] - the i sits inside the right end of
          Preorder, but it is a sibling laid over it, never a button inside a
          button: nested buttons are invalid HTML, and a disabled Preorder
          would swallow its clicks. The i stays whenever Preorder is shown,
          enabled or not: the information is most useful to the buyer
          wondering why it is off. The chat is there either way, for the same
          reason - an icon now, the same height as Preorder, directly to the
          right of the i. Preorder takes the rest of the row on a phone. */}
      <div className="flex items-stretch gap-1.5">
        <div className="relative flex min-w-0 flex-1 sm:flex-none">
          <Button
            ref={preorderButtonRef}
            size="lg"
            variant="secondary"
            disabled={disabled}
            isLoading={isReady && eligibility.isPending}
            aria-describedby={reason === null ? undefined : reasonId}
            className="w-full min-w-0 pr-14"
            onClick={(event) => {
              startPreorder(event.currentTarget);
            }}
          >
            <BoxesIcon />
            {t('preorder.button')}
          </Button>
          <button
            type="button"
            aria-label={t('preorderInfo.iconLabel')}
            aria-haspopup="dialog"
            aria-expanded={panel === 'info'}
            title={t('preorderInfo.iconLabel')}
            onClick={(event) => {
              anchorRef.current = event.currentTarget;
              setPanel('info');
              emitPreorderEvent('preorder_info_opened', { productId, variantId });
            }}
            className="absolute right-1.5 top-1/2 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-brand transition-colors hover:bg-brand-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
          >
            <InfoIcon />
          </button>
        </div>
        <ChatWithUbossButton
          productId={productId}
          variantId={variantId}
          pieces={pieces}
          onReviewProposal={reviewProposal}
        />
      </div>

      {reason !== null && (
        <p id={reasonId} className="mt-1.5 text-xs text-ink-muted">
          {reason}
        </p>
      )}
      {proposalNotice !== null && (
        <p role="status" className="mt-1.5 text-xs text-ink">
          {proposalNotice}
        </p>
      )}

      {panel === 'info' && (
        <PreorderInfoDialog
          anchorRef={anchorRef}
          terms={terms}
          unavailableReason={unavailableReason}
          acknowledged={acknowledged || guestHasRead}
          canContinue={canPreorder}
          isGuest={!isCustomer}
          isSaving={acknowledge.isPending}
          error={acknowledge.isError ? errorMessage(t, acknowledge.error) : null}
          onClose={closeAndRestoreFocus}
          onContinue={() => {
            if (policyVersion === null) return;
            if (!isCustomer) {
              // Kept in this tab only, and recorded against the account they
              // sign in to. The server decides; this is never proof.
              rememberGuestAcknowledgement(policyVersion);
              emitPreorderEvent('preorder_info_acknowledged', { productId, variantId });
              setPanel(null);
              signInThenPreorder();
              return;
            }
            if (acknowledged) openForm(pieces);
            else acknowledge.mutate(policyVersion);
          }}
        />
      )}

      {stockPrompt !== null && terms !== null && panel === null && !isOpen && (
        <BulkPreorderPrompt
          terms={terms}
          pieces={stockPrompt.requested}
          stock={stockPrompt.stock}
          regularOrderAllowed={null}
          onClose={() => {
            emitPreorderEvent('stock_prompt_dismissed', { productId, variantId });
            onStockPromptClose?.('dismiss');
          }}
          onContinueRegular={() => {
            emitPreorderEvent('stock_prompt_change_quantity', { productId, variantId });
            onStockPromptClose?.('change');
          }}
          onStartPreorder={() => {
            emitPreorderEvent('stock_prompt_start_preorder', { productId, variantId });
            onStockPromptClose?.('preorder');
            startPreorder(preorderButtonRef.current);
          }}
        />
      )}

      {panel === 'prompt' && terms !== null && pieces !== undefined && (
        <BulkPreorderPrompt
          terms={terms}
          pieces={pieces}
          regularOrderAllowed={isCustomer ? regularOrderAllowed : null}
          onClose={() => {
            emitPreorderEvent('bulk_prompt_dismissed', { productId, variantId });
            closeAndRestoreFocus();
          }}
          onContinueRegular={() => {
            emitPreorderEvent('bulk_prompt_continue_regular', { productId, variantId });
            closeAndRestoreFocus();
          }}
          onStartPreorder={() => {
            emitPreorderEvent('bulk_prompt_start_preorder', { productId, variantId });
            setPanel(null);
            startPreorder(preorderButtonRef.current);
          }}
        />
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
          initialPieces={formPieces}
          prefill={proposal?.prefill}
          onSubmitted={(preorder) => {
            if (proposal === null) return;
            // The request is sent whatever happens here; this only links the
            // chat to it, so staff see the preorder beside the conversation.
            void markProposalSubmitted(proposal.conversationId, proposal.proposalId, preorder.id).catch(() => {
              setProposalNotice(t('preorderChat.proposal.linkFailed'));
            });
          }}
          onClose={() => {
            restoreFocusTo.current = preorderButtonRef.current;
            setIsOpen(false);
            setProposal(null);
          }}
        />
      )}
    </div>
  );
}

function InfoIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" strokeLinecap="round" />
      <circle cx="12" cy="7.75" r="0.6" fill="currentColor" stroke="none" />
    </svg>
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
