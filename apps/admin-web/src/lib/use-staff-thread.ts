/**
 * One open conversation in the inbox, live.
 *
 * The same shape as the storefront's thread hook: messages keyed by the
 * server's sequence, an optimistic outbox whose retries reuse the same
 * `clientMessageId`, a catch-up after every reconnect, and read marks that go
 * to the server rather than being counted here. Staff reading a conversation
 * marks it read for the TEAM; the customer's own Delivered and Read positions
 * arrive as `receipt` frames.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { staffChatSocket, type ChatConnectionState } from './chat-socket';
import {
  fetchMessages,
  inboxKeys,
  markRead,
  mergeMessages,
  newClientMessageId,
  sendReply,
  type StaffMessage,
} from './preorder-chats';
import { setVisibleConversation } from './use-preorder-chat-live';

/** The key a message is rendered and anchored under. Same shape as the storefront's. */
export function messageKey(message: { seq: number }): string {
  return `m-${message.seq}`;
}

export interface PendingReply {
  clientMessageId: string;
  body: string;
  status: 'SENDING' | 'FAILED';
  error: unknown;
  createdAt: string;
}

const PAGE = 50;

export function useStaffThread(conversationId: string) {
  const queryClient = useQueryClient();
  const socket = staffChatSocket();
  const [messages, setMessages] = useState<StaffMessage[]>([]);
  const [pending, setPending] = useState<PendingReply[]>([]);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  const loadingEarlier = useRef(false);
  // Each load is numbered and an answer to an older one is dropped: a retry
  // and the first load can overlap, and the slowest must not win.
  const loadToken = useRef(0);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [connection, setConnection] = useState<ChatConnectionState>(socket.getState());
  const [receipts, setReceipts] = useState<{ deliveredSeq: number; readSeq: number } | null>(null);
  const [customerTyping, setCustomerTyping] = useState(false);
  const [colleagueTyping, setColleagueTyping] = useState(false);
  const lastSeq = useRef(0);
  lastSeq.current = messages.at(-1)?.seq ?? 0;
  const lastRead = useRef(0);
  const typingTimers = useRef<number[]>([]);

  const load = useCallback(async (): Promise<void> => {
    const token = ++loadToken.current;
    setIsLoading(true);
    setLoadError(null);
    try {
      const page = await fetchMessages(conversationId, { limit: PAGE });
      if (token !== loadToken.current) return;
      setMessages(page.messages);
      setHasEarlier(page.hasMore);
    } catch (error) {
      if (token === loadToken.current) setLoadError(error);
    } finally {
      if (token === loadToken.current) setIsLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    setMessages([]);
    setPending([]);
    setReceipts(null);
    lastRead.current = 0;
    void load();
  }, [load]);

  const catchUp = useCallback(async (): Promise<void> => {
    let after = lastSeq.current;
    for (let page = 0; page < 20; page += 1) {
      const result = await fetchMessages(conversationId, { after, limit: 200 });
      if (result.messages.length > 0) {
        setMessages((current) => mergeMessages(current, result.messages));
        after = result.messages.at(-1)?.seq ?? after;
      }
      if (!result.hasMore) break;
    }
    void queryClient.invalidateQueries({ queryKey: inboxKeys.detail(conversationId) });
  }, [conversationId, queryClient]);

  useEffect(() => socket.acquire(), [socket]);
  useEffect(() => socket.subscribe(conversationId), [socket, conversationId]);
  useEffect(() => {
    setVisibleConversation(conversationId);
    return () => {
      setVisibleConversation(null);
    };
  }, [conversationId]);

  useEffect(
    () =>
      socket.onState((state, reconnected) => {
        setConnection(state);
        if (reconnected) void catchUp().catch(() => undefined);
      }),
    [socket, catchUp],
  );

  useEffect(
    () =>
      socket.onFrame((frame) => {
        if (frame['conversationId'] !== undefined && frame['conversationId'] !== conversationId) {
          if (frame.type === 'message.created' || frame.type === 'conversation.updated') {
            void queryClient.invalidateQueries({ queryKey: ['preorder-chats', 'list'] });
          }
          return;
        }
        switch (frame.type) {
          case 'message.created':
          case 'message.updated': {
            const message = frame['message'] as StaffMessage;
            setMessages((current) => mergeMessages(current, [message]));
            if (message.clientMessageId !== undefined) {
              setPending((current) => current.filter((entry) => entry.clientMessageId !== message.clientMessageId));
            }
            if (message.senderType === 'CUSTOMER') {
              setCustomerTyping(false);
              if (frame.type === 'message.created') {
                socket.send({ type: 'delivered', conversationId, seq: message.seq });
              }
            }
            void queryClient.invalidateQueries({ queryKey: ['preorder-chats', 'list'] });
            if (message.messageType === 'STRUCTURED_OFFER' || message.systemEvent?.startsWith('proposal.') === true) {
              void queryClient.invalidateQueries({ queryKey: inboxKeys.proposals(conversationId) });
            }
            return;
          }
          case 'conversation.updated': {
            void queryClient.invalidateQueries({ queryKey: inboxKeys.detail(conversationId) });
            void queryClient.invalidateQueries({ queryKey: ['preorder-chats', 'list'] });
            if (frame['reason'] === 'note') void queryClient.invalidateQueries({ queryKey: inboxKeys.notes(conversationId) });
            void queryClient.invalidateQueries({ queryKey: inboxKeys.activity(conversationId) });
            return;
          }
          case 'receipt': {
            if (frame['side'] !== 'CUSTOMER') return;
            setReceipts((current) => ({
              deliveredSeq: Math.max(current?.deliveredSeq ?? 0, Number(frame['deliveredSeq'])),
              readSeq: Math.max(current?.readSeq ?? 0, Number(frame['readSeq'])),
            }));
            return;
          }
          case 'typing': {
            const typing = frame['state'] === 'start';
            const setter = frame['side'] === 'CUSTOMER' ? setCustomerTyping : setColleagueTyping;
            setter(typing);
            if (typing) {
              typingTimers.current.push(
                window.setTimeout(() => {
                  setter(false);
                }, 6_000),
              );
            }
            return;
          }
          default:
            return;
        }
      }),
    [socket, conversationId, queryClient],
  );

  useEffect(
    () => () => {
      for (const timer of typingTimers.current) window.clearTimeout(timer);
    },
    [],
  );

  // Read, for the team, whenever something new from the customer is on screen.
  const newestFromCustomer = [...messages].reverse().find((message) => message.senderType === 'CUSTOMER')?.seq ?? 0;
  useEffect(() => {
    if (newestFromCustomer <= lastRead.current || document.visibilityState !== 'visible') return;
    const seq = lastSeq.current;
    lastRead.current = seq;
    void markRead(conversationId, seq)
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ['preorder-chats', 'list'] });
        void queryClient.invalidateQueries({ queryKey: inboxKeys.counts });
      })
      .catch(() => {
        lastRead.current = 0;
      });
  }, [conversationId, newestFromCustomer, queryClient]);

  const deliver = useCallback(
    async (entry: PendingReply): Promise<void> => {
      try {
        const result = await sendReply(conversationId, entry.clientMessageId, entry.body);
        setMessages((current) => mergeMessages(current, [result.message]));
        setPending((current) => current.filter((item) => item.clientMessageId !== entry.clientMessageId));
        void queryClient.invalidateQueries({ queryKey: inboxKeys.detail(conversationId) });
      } catch (error) {
        setPending((current) =>
          current.map((item) =>
            item.clientMessageId === entry.clientMessageId ? { ...item, status: 'FAILED', error } : item,
          ),
        );
      }
    },
    [conversationId, queryClient],
  );

  const send = useCallback(
    (body: string): void => {
      const entry: PendingReply = {
        clientMessageId: newClientMessageId(),
        body,
        status: 'SENDING',
        error: null,
        createdAt: new Date().toISOString(),
      };
      setPending((current) => [...current, entry]);
      void deliver(entry);
    },
    [deliver],
  );

  const retry = useCallback(
    (clientMessageId: string): void => {
      const entry = pending.find((item) => item.clientMessageId === clientMessageId);
      if (entry === undefined) return;
      const again = { ...entry, status: 'SENDING' as const, error: null };
      setPending((current) => current.map((item) => (item.clientMessageId === clientMessageId ? again : item)));
      void deliver(again);
    },
    [pending, deliver],
  );

  // One request at a time: scrolling near the top asks on every scroll event.
  const loadEarlier = useCallback(async (): Promise<void> => {
    const first = messages[0]?.seq;
    if (first === undefined || loadingEarlier.current) return;
    loadingEarlier.current = true;
    setIsLoadingEarlier(true);
    try {
      const page = await fetchMessages(conversationId, { before: first, limit: PAGE });
      setMessages((current) => mergeMessages(current, page.messages));
      setHasEarlier(page.hasMore);
    } finally {
      loadingEarlier.current = false;
      setIsLoadingEarlier(false);
    }
  }, [conversationId, messages]);

  const typingSent = useRef(false);
  const setTyping = useCallback(
    (typing: boolean): void => {
      if (typing || typingSent.current) {
        socket.send({ type: 'typing', conversationId, state: typing ? 'start' : 'stop' });
      }
      typingSent.current = typing;
    },
    [socket, conversationId],
  );

  const replaceMessage = useCallback((message: StaffMessage): void => {
    setMessages((current) => mergeMessages(current, [message]));
  }, []);

  return {
    messages,
    pending,
    hasEarlier,
    isLoadingEarlier,
    isLoading,
    loadError,
    connection,
    receipts,
    customerTyping,
    colleagueTyping,
    send,
    retry,
    discard: (clientMessageId: string): void => {
      setPending((current) => current.filter((item) => item.clientMessageId !== clientMessageId));
    },
    loadEarlier,
    setTyping,
    replaceMessage,
    refresh: load,
  };
}
