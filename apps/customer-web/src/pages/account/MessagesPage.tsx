/**
 * Account -> Messages: every preorder chat this customer has had with the
 * {{marketplace}} team.
 *
 * The list and the open conversation side by side from `md`; one at a time on
 * a phone, where `/account/messages/:id` is the conversation and its back
 * button is the list. The "a reply is waiting" email links straight to
 * `/account/messages/:id`, after sign-in.
 *
 * A new conversation is not started here - it is about a product, so it
 * starts from that product's page.
 *
 * THE FRAME
 *
 * This page is exactly as tall as the space `StoreLayout` and `AccountLayout`
 * hand it, and never taller - both frame it as an application pane rather
 * than a document. Inside it, three things scroll and each on its own: the
 * conversation list, and the message history (the header above it and the
 * composer below it stay put). The document itself does not scroll at all.
 * Every flex and grid ancestor on the way down carries `min-h-0`, because a
 * flex child's default minimum height is its content's, and one ancestor
 * without it is how a long conversation makes the whole page scroll again.
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';
import { ChatThread } from '@/components/preorder-chat/ChatThread';
import { Button, ErrorState } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { formatDateTime, formatRelative } from '@/lib/format';
import {
  ChatAvatar,
  ChatEmptyState,
  ConversationListSkeleton,
  UnreadBadge,
} from '@/lib/chat-kit/primitives';
import {
  CONVERSATION_PARAM,
  MESSAGES_PATH,
  PROPOSAL_PARAM,
  chatKeys,
  fetchMyConversations,
  type CustomerConversation,
} from '@/lib/preorder-chat';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

export function MessagesPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  useDocumentMeta({ title: t('preorderChat.page.title'), noIndex: true }, business.displayName);

  const list = useInfiniteQuery({
    queryKey: chatKeys.list,
    queryFn: ({ pageParam }) => fetchMyConversations(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 60_000,
  });

  const conversations: CustomerConversation[] = list.data?.pages.flatMap((page) => page.conversations) ?? [];

  const reviewProposal = (conversationId: string, proposalId: string): void => {
    const conversation = conversations.find((entry) => entry.id === conversationId);
    const slug = conversation?.context?.product.slug;
    if (slug === undefined) return;
    const params = new URLSearchParams({ [PROPOSAL_PARAM]: proposalId, [CONVERSATION_PARAM]: conversationId });
    void navigate(`/product/${slug}?${params.toString()}`);
  };

  const isOpen = id !== undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* On a phone with a conversation open, the conversation's own header
          says where you are; this one would only take its height. */}
      <header
        className={cx(
          'mb-2 shrink-0 sm:mb-3',
          isOpen && 'max-md:hidden',
          // A short window gives its height to the conversation instead.
          '[@media(max-height:680px)]:sr-only',
        )}
      >
        <h1 className="text-xl font-semibold text-ink sm:text-2xl">{t('preorderChat.page.title')}</h1>
        <p className="text-sm text-ink-muted">{t('preorderChat.page.subtitle')}</p>
      </header>

      <div className="grid min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-surface shadow-card md:grid-cols-[17rem_minmax(0,1fr)] lg:grid-cols-[20rem_minmax(0,1fr)]">
        {/* The list. */}
        <nav
          aria-label={t('preorderChat.page.listLabel')}
          className={cx('flex min-h-0 min-w-0 flex-col md:border-r md:border-border-subtle', isOpen && 'max-md:hidden')}
        >
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {list.isPending && <ConversationListSkeleton label={t('preorderChat.loading')} />}
            {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
            {list.isSuccess && conversations.length === 0 && (
              <ChatEmptyState title={t('preorderChat.page.emptyTitle')} description={t('preorderChat.page.empty')} />
            )}
            {conversations.length > 0 && (
              <ul className="divide-y divide-border-subtle">
                {conversations.map((conversation) => (
                  <li key={conversation.id}>
                    <ConversationRow conversation={conversation} selected={conversation.id === id} />
                  </li>
                ))}
              </ul>
            )}
            {list.hasNextPage && (
              <div className="p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  isLoading={list.isFetchingNextPage}
                  onClick={() => void list.fetchNextPage()}
                >
                  {t('preorderChat.page.more')}
                </Button>
              </div>
            )}
          </div>
        </nav>

        {/* The open conversation. */}
        <section
          aria-label={t('preorderChat.page.conversationLabel')}
          className={cx('flex min-h-0 min-w-0 flex-col', !isOpen && 'max-md:hidden')}
        >
          {id === undefined ? (
            <ChatEmptyState
              title={t('preorderChat.page.selectTitle')}
              description={t('preorderChat.page.select')}
            />
          ) : (
            <ChatThread
              // A fresh thread per conversation: its messages, its scroll
              // position and its draft never leak into the next one, and a
              // slow answer for the last one lands on nothing.
              key={id}
              conversationId={id}
              context={null}
              active
              variant="page"
              onReviewProposal={reviewProposal}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function ConversationRow({
  conversation,
  selected,
}: {
  conversation: CustomerConversation;
  selected: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const product = conversation.context?.product;
  const status = t(`preorderChat.conversationStatus.${conversation.status}` as TranslationKey);
  const unread = conversation.unreadCount > 0;

  return (
    <Link
      to={`${MESSAGES_PATH}/${conversation.id}`}
      aria-current={selected ? 'page' : undefined}
      className={cx(
        'relative flex gap-3 px-3 py-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand',
        selected ? 'bg-brand-soft' : 'hover:bg-surface-hover',
      )}
    >
      {selected && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-brand" />}
      <ChatAvatar name={product?.name} imageUrl={product?.imageUrl} square />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cx('truncate text-ink', unread ? 'font-semibold' : 'font-medium')} title={product?.name}>
            {product?.name ?? '—'}
          </span>
          <time
            dateTime={conversation.lastMessageAt}
            title={formatDateTime(conversation.lastMessageAt)}
            className="shrink-0 text-xxs text-ink-subtle"
          >
            {formatRelative(conversation.lastMessageAt)}
          </time>
        </span>
        {/* Who the customer is talking to, then whose product it is - so the
            seller reads as context, never as the other party. */}
        <span className="block truncate text-xxs text-ink-muted">
          {t('preorderChat.team.name')}
          {conversation.context !== null && (
            <> · {t('preorderChat.context.seller', { name: conversation.context.sellerName })}</>
          )}
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span className={cx('min-w-0 flex-1 truncate text-xs', unread ? 'text-ink' : 'text-ink-muted')}>
            {conversation.lastMessagePreview === null
              ? status
              : conversation.lastMessageFromMe
                ? t('preorderChat.page.fromYou', { text: conversation.lastMessagePreview })
                : conversation.lastMessagePreview}
          </span>
          <UnreadBadge
            count={conversation.unreadCount}
            label={t('preorderChat.page.unread', { count: conversation.unreadCount })}
          />
        </span>
        <span className="mt-1 block text-xxs text-ink-subtle">{status}</span>
      </span>
    </Link>
  );
}
