/**
 * "Chat with UBOSS" - beside Preorder on every product page.
 *
 * Asks the operator's own team, never the seller. It is there whether or not
 * the product can be preordered right now, because "why can't I preorder
 * this?" is one of the questions it exists for.
 *
 * A guest is sent to sign in and brought back to this page - the query string
 * keeps the option they chose - with the chat open on the quantity and unit
 * they were looking at. Nothing about the guest is sent anywhere: the intent
 * waits in this tab's sessionStorage, and a conversation only exists once a
 * signed-in customer sends a first message.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { ChatBubblesIcon } from '@/components/icons';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import {
  CHAT_INTENT_PARAM,
  chatKeys,
  fetchChatAvailability,
  rememberChatIntent,
  takeChatIntent,
  type ChatContextInput,
} from '@/lib/preorder-chat';
import { PreorderChatDrawer } from './PreorderChatDrawer';

export interface ChatWithUbossButtonProps {
  productId: string;
  variantId: string | null;
  /** The pieces on the page, carried into the chat as the quantity asked about. */
  pieces?: number | undefined;
  onReviewProposal: (conversationId: string, proposalId: string) => void;
  className?: string;
}

export function ChatWithUbossButton({
  productId,
  variantId,
  pieces,
  onReviewProposal,
  className,
}: ChatWithUbossButtonProps): React.JSX.Element | null {
  const { t } = useI18n();
  const { isCustomer } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const [isOpen, setIsOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [context, setContext] = useState<ChatContextInput>(() => ({
    productId,
    variantId,
    orderingUnit: 'PIECE',
    unitQuantity: pieces !== undefined && pieces > 0 ? pieces : null,
    desiredDeliveryDate: null,
  }));

  const availability = useQuery({ queryKey: chatKeys.availability, queryFn: fetchChatAvailability, staleTime: 60_000 });

  // The option or quantity on the page changed while the drawer was closed:
  // the next conversation is about what is on the page now.
  useEffect(() => {
    if (isOpen) return;
    setConversationId(null);
    setContext((current) => ({
      ...current,
      productId,
      variantId,
      unitQuantity: current.orderingUnit === 'PIECE' && pieces !== undefined && pieces > 0 ? pieces : current.unitQuantity,
    }));
  }, [productId, variantId, pieces, isOpen]);

  const open = useCallback((): void => {
    if (!isCustomer) {
      rememberChatIntent(context);
      const params = new URLSearchParams(location.search);
      params.set(CHAT_INTENT_PARAM, '1');
      void navigate(`/login?next=${encodeURIComponent(`${location.pathname}?${params.toString()}`)}`);
      return;
    }
    setIsOpen(true);
  }, [isCustomer, context, location.pathname, location.search, navigate]);

  // Back from sign-in with the intent in the URL.
  const intent = searchParams.get(CHAT_INTENT_PARAM) === '1';
  useEffect(() => {
    if (!intent || !isCustomer) return;
    const next = new URLSearchParams(searchParams);
    next.delete(CHAT_INTENT_PARAM);
    setSearchParams(next, { replace: true });
    const carried = takeChatIntent(productId);
    if (carried !== null) setContext({ ...carried, variantId });
    setIsOpen(true);
  }, [intent, isCustomer, searchParams, setSearchParams, productId, variantId]);

  const close = useCallback((): void => {
    setIsOpen(false);
    // Back to the button, once the dialog has let go of focus.
    window.setTimeout(() => buttonRef.current?.focus(), 0);
  }, []);

  if (availability.data?.enabled === false) return null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={open}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label={t('preorderChat.buttonLabel')}
        title={t('preorderChat.tooltip')}
        className={cx(
          'inline-flex h-12 min-w-0 items-center justify-center gap-2 rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink shadow-card',
          'hover:border-brand/40 hover:bg-brand-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
          className,
        )}
      >
        <ChatBubblesIcon className="size-5 shrink-0 text-brand" />
        <span className="truncate">{t('preorderChat.button')}</span>
      </button>

      <PreorderChatDrawer
        isOpen={isOpen}
        onClose={close}
        conversationId={conversationId}
        context={context}
        onContextChange={setContext}
        onConversation={setConversationId}
        onReviewProposal={(conversation, proposal) => {
          setIsOpen(false);
          onReviewProposal(conversation, proposal);
        }}
      />
    </>
  );
}
