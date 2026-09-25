/**
 * How many replies from the UBOSS team are waiting to be read.
 *
 * For the Messages badge in the account sidebar and menu. Counted by the
 * server - never added up in the browser - and refreshed once a minute while
 * the tab is in front, plus whenever an open conversation marks something
 * read (it invalidates `chatKeys.unread`). Zero for a guest, who has no
 * conversations to count.
 */
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { chatKeys, fetchUnreadChats } from './preorder-chat';

export function useChatUnreadCount(): number {
  const { isCustomer } = useSession();
  const unread = useQuery({
    queryKey: chatKeys.unread,
    queryFn: () => fetchUnreadChats(),
    enabled: isCustomer,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  return isCustomer ? (unread.data?.unreadCount ?? 0) : 0;
}
