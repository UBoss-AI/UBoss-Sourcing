/**
 * "Chat with UBOSS" - an icon beside Preorder's (i) on every product page:
 * [ Preorder (i) ] [ chat ].
 *
 * An icon button rather than a labelled one, because the row already says
 * "Preorder" and three words of text beside it crowded the action the buyer
 * came for. It loses nothing: its accessible name is "Chat with {{marketplace}}",
 * a tooltip says what it does on hover and on keyboard focus, and on a phone a
 * tap simply opens the chat - nothing depends on hover. It is 48 px square,
 * the height of the Preorder button, which is past the 44 px touch minimum.
 * A badge shows replies from the team that are still unread on conversations
 * about THIS product, counted by the server.
 *
 * Everything behind the click is unchanged: the same sign-in round trip, the
 * same drawer, the same product, option, quantity and unit carried in.
 *
 * Asks the operator's own team, never the seller. It is there whether or not
 * the product can be preordered right now, because "why can't I preorder
 * this?" is one of the questions it exists for.
 *
 * A guest opens the same drawer and can read the preorder assistant's answers
 * straight away - they are the product's own public information. Writing to
 * the team, or asking for a person, needs an account: the guest is sent to
 * sign in and brought back to this page - the query string keeps the option
 * they chose - with the chat open on the quantity and unit they were looking
 * at, the answers they read still there, and a request for a person finished
 * for them if that is what they asked for. Nothing about the guest is sent
 * anywhere: the intent waits in this tab's sessionStorage, and a conversation
 * only exists once a signed-in customer writes or asks for a person.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Tooltip } from '@/components/Tooltip';
import { useSession } from '@/auth/session-context';
import { ChatBubblesIcon } from '@/components/icons';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import {
  CHAT_INTENT_PARAM,
  chatKeys,
  fetchChatAvailability,
  fetchUnreadChats,
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
  const { t, intlLocale } = useI18n();
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

  // Under chatKeys.unread, so every place that invalidates the unread count -
  // a live message, a conversation marked read - refreshes this badge too.
  const unread = useQuery({
    queryKey: [...chatKeys.unread, productId],
    queryFn: () => fetchUnreadChats(productId),
    enabled: isCustomer && availability.data?.enabled !== false,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const unreadCount = isCustomer ? (unread.data?.unreadCount ?? 0) : 0;

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

  // Off to sign in, and back to this page with the chat open.
  const signIn = useCallback((): void => {
    rememberChatIntent(context);
    const params = new URLSearchParams(location.search);
    params.set(CHAT_INTENT_PARAM, '1');
    void navigate(`/login?next=${encodeURIComponent(`${location.pathname}?${params.toString()}`)}`);
  }, [context, location.pathname, location.search, navigate]);

  const open = useCallback((): void => {
    setIsOpen(true);
  }, []);

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
      <Tooltip label={t('preorderChat.tooltip')} align="end">
        <button
          ref={buttonRef}
          type="button"
          onClick={open}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-label={
            unreadCount > 0
              ? t('preorderChat.iconLabelUnread', { unread: unreadCount.toLocaleString(intlLocale) })
              : t('preorderChat.button')
          }
          className={cx(
            'relative inline-flex size-12 shrink-0 items-center justify-center rounded-md border border-border-strong bg-surface text-brand shadow-card',
            'transition-[border-color,background-color,box-shadow] duration-200',
            'hover:border-brand/50 hover:bg-brand-soft hover:shadow-[0_0_0_4px_rgb(var(--brand)/0.12),0_6px_18px_-6px_rgb(var(--brand)/0.45)]',
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
            className,
          )}
        >
          <ChatBubblesIcon className="size-5 shrink-0" />
          {unreadCount > 0 && (
            <span
              aria-hidden="true"
              className="absolute -right-1.5 -top-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-danger px-1 text-xxs font-semibold leading-5 text-white ring-2 ring-surface"
            >
              {unreadCount > 99 ? '99+' : unreadCount.toLocaleString(intlLocale)}
            </span>
          )}
        </button>
      </Tooltip>

      <PreorderChatDrawer
        isOpen={isOpen}
        onClose={close}
        signedIn={isCustomer}
        onSignIn={signIn}
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
