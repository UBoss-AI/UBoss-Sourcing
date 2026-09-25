/**
 * One conversation, live, for the customer.
 *
 * The server is the source of truth and this hook is a window onto it:
 *
 *   - **Messages are keyed by the server's sequence number.** Whatever arrives
 *     - the send's response, a socket frame, a catch-up page - is merged on
 *     it, so the same message arriving three ways is still one message, in
 *     the server's order.
 *   - **Sending is optimistic and honest.** The text appears at once marked
 *     Sending, becomes Sent when the server answers, Delivered and Read when
 *     the team's side reports it, and Failed - with Retry - when the request
 *     did not get through. A retry reuses the same `clientMessageId`, so a
 *     request that did land the first time is not sent twice.
 *   - **A reconnect catches up.** When the socket comes back, everything
 *     after the last sequence held is fetched and merged.
 *   - **Nothing is created by looking.** With no conversation yet, the hook
 *     shows the server's product card and waits for the first message.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { customerChatSocket, type ChatConnectionState, type ChatFrame } from './chat-socket';
import {
  chatKeys,
  fetchChatMessages,
  fetchConversation,
  markChatRead,
  mergeMessages,
  newClientMessageId,
  previewChat,
  sendChatMessage,
  startChat,
  uploadChatAttachment,
  type ChatContextCard,
  type ChatContextInput,
  type ChatMessage,
  type CustomerConversation,
} from './preorder-chat';
import { firstUnreadKey } from './chat-kit/timeline';

/** The key a message is rendered and anchored under. */
export function messageKey(message: { seq: number }): string {
  return `m-${message.seq}`;
}

export interface PendingMessage {
  clientMessageId: string;
  body: string;
  /** Set for a file; the body is then its name. */
  file?: File;
  status: 'SENDING' | 'FAILED';
  error: unknown;
  createdAt: string;
}

export interface ChatThreadState {
  conversation: CustomerConversation | null;
  context: ChatContextCard | null;
  messages: ChatMessage[];
  pending: PendingMessage[];
  hasEarlier: boolean;
  isLoadingEarlier: boolean;
  /**
   * The first message that was unread when the conversation opened - read
   * once, before opening it marks everything read.
   */
  initialUnreadKey: string | null;
  isLoading: boolean;
  loadError: unknown;
  connection: ChatConnectionState;
  teamAvailable: boolean | null;
  teamTyping: boolean;
  /** The newest message from the team, for the screen-reader announcement. */
  lastIncoming: ChatMessage | null;
  send: (body: string) => void;
  sendFile: (file: File) => void;
  retry: (clientMessageId: string) => void;
  discard: (clientMessageId: string) => void;
  loadEarlier: () => Promise<void>;
  setTyping: (typing: boolean) => void;
  refresh: () => Promise<void>;
}

const PAGE = 50;
const SAFETY_POLL_MS = 60_000;
const TYPING_TTL_MS = 6_000;

export function useChatThread(options: {
  /** An existing conversation, or null to start from a product. */
  conversationId: string | null;
  /** Required when there is no conversation yet. */
  context: ChatContextInput | null;
  locale: string;
  /** False pauses reading and marking read, e.g. while the drawer is closed. */
  active: boolean;
}): ChatThreadState {
  const { context: contextInput, locale, active } = options;
  const queryClient = useQueryClient();
  const socket = customerChatSocket();

  const [conversationId, setConversationId] = useState<string | null>(options.conversationId);
  const [conversation, setConversation] = useState<CustomerConversation | null>(null);
  const [context, setContext] = useState<ChatContextCard | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  const [initialUnreadKey, setInitialUnreadKey] = useState<string | null>(null);
  const loadingEarlier = useRef(false);
  // Each load is numbered; an answer to an older one is dropped. A retry, a
  // reconnect and the first load can overlap, and the slowest must not win.
  const loadToken = useRef(0);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [connection, setConnection] = useState<ChatConnectionState>(socket.getState());
  const [teamAvailable, setTeamAvailable] = useState<boolean | null>(null);
  const [teamTyping, setTeamTyping] = useState(false);
  const [lastIncoming, setLastIncoming] = useState<ChatMessage | null>(null);

  const lastSeqRef = useRef(0);
  lastSeqRef.current = messages.at(-1)?.seq ?? 0;
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const typingTimer = useRef<number | null>(null);
  const lastReadPosted = useRef(0);

  useEffect(() => {
    setConversationId(options.conversationId);
  }, [options.conversationId]);

  const contextKey = contextInput === null ? null : JSON.stringify(contextInput);

  // ---- Initial load --------------------------------------------------------
  const load = useCallback(async (): Promise<void> => {
    const token = ++loadToken.current;
    const current = (): boolean => token === loadToken.current;
    setIsLoading(true);
    setLoadError(null);
    try {
      let id = conversationIdRef.current;
      if (id === null && contextKey !== null) {
        const preview = await previewChat(JSON.parse(contextKey) as ChatContextInput);
        if (!current()) return;
        setContext(preview.context);
        if (preview.conversation !== null) {
          id = preview.conversation.id;
          setConversationId(id);
        }
      }
      if (id !== null) {
        const [detail, page] = await Promise.all([fetchConversation(id), fetchChatMessages(id, { limit: PAGE })]);
        if (!current()) return;
        setInitialUnreadKey(
          firstUnreadKey(
            page.messages,
            detail.conversation.unreadCount,
            (message) => message.senderType !== 'CUSTOMER',
            messageKey,
          ),
        );
        setConversation(detail.conversation);
        setContext((current) => detail.conversation.context ?? current);
        setMessages(page.messages);
        setHasEarlier(page.hasMore);
      }
    } catch (error) {
      if (current()) setLoadError(error);
    } finally {
      if (current()) setIsLoading(false);
    }
  }, [contextKey]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- Catch up after a gap -------------------------------------------------
  const catchUp = useCallback(async (): Promise<void> => {
    const id = conversationIdRef.current;
    if (id === null) return;
    let after = lastSeqRef.current;
    for (let page = 0; page < 20; page += 1) {
      const result = await fetchChatMessages(id, { after, limit: 200 });
      if (result.messages.length > 0) {
        setMessages((current) => mergeMessages(current, result.messages));
        after = result.messages.at(-1)?.seq ?? after;
      }
      if (!result.hasMore) break;
    }
    const detail = await fetchConversation(id);
    setConversation(detail.conversation);
  }, []);

  // ---- The socket -----------------------------------------------------------
  useEffect(() => socket.acquire(), [socket]);

  useEffect(
    () =>
      socket.onState((state, reconnected) => {
        setConnection(state);
        if (reconnected) void catchUp().catch(() => undefined);
      }),
    [socket, catchUp],
  );

  useEffect(() => {
    if (conversationId === null) return undefined;
    return socket.subscribe(conversationId);
  }, [socket, conversationId]);

  useEffect(
    () =>
      socket.onFrame((frame: ChatFrame) => {
        if (frame.type === 'hello' || frame.type === 'presence') {
          setTeamAvailable(frame['teamAvailable'] === true);
          return;
        }
        const id = conversationIdRef.current;
        if (frame['conversationId'] !== undefined && frame['conversationId'] !== id) {
          // Another conversation of mine changed: the badge may have.
          if (frame.type === 'message.created') void queryClient.invalidateQueries({ queryKey: chatKeys.unread });
          return;
        }
        switch (frame.type) {
          case 'message.created':
          case 'message.updated': {
            const message = frame['message'] as ChatMessage;
            setMessages((current) => mergeMessages(current, [message]));
            if (message.clientMessageId !== undefined) {
              setPending((current) => current.filter((entry) => entry.clientMessageId !== message.clientMessageId));
            }
            if (frame.type === 'message.created' && message.senderType !== 'CUSTOMER') {
              setLastIncoming(message);
              setTeamTyping(false);
              if (id !== null) socket.send({ type: 'delivered', conversationId: id, seq: message.seq });
            }
            return;
          }
          case 'conversation.updated': {
            const next = frame['conversation'] as CustomerConversation;
            if (next.id === id) setConversation(next);
            void queryClient.invalidateQueries({ queryKey: chatKeys.list });
            return;
          }
          case 'receipt': {
            if (frame['side'] !== 'STAFF') return;
            setConversation((current) =>
              current === null
                ? current
                : {
                    ...current,
                    receipts: {
                      deliveredSeq: Math.max(current.receipts.deliveredSeq, Number(frame['deliveredSeq'])),
                      readSeq: Math.max(current.receipts.readSeq, Number(frame['readSeq'])),
                    },
                  },
            );
            return;
          }
          case 'typing': {
            if (frame['side'] !== 'STAFF') return;
            const typing = frame['state'] === 'start';
            setTeamTyping(typing);
            if (typingTimer.current !== null) window.clearTimeout(typingTimer.current);
            if (typing) {
              typingTimer.current = window.setTimeout(() => {
                setTeamTyping(false);
              }, TYPING_TTL_MS);
            }
            return;
          }
          default:
            return;
        }
      }),
    [socket, queryClient],
  );

  // A slow safety net: an event lost between processes is fetched within the
  // minute even while the socket stays up.
  useEffect(() => {
    if (!active || conversationId === null) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void catchUp().catch(() => undefined);
    }, SAFETY_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [active, conversationId, catchUp]);

  // ---- Marking read ---------------------------------------------------------
  const newestFromTeam = useMemo(
    () => [...messages].reverse().find((message) => message.senderType !== 'CUSTOMER')?.seq ?? 0,
    [messages],
  );
  useEffect(() => {
    const id = conversationId;
    if (!active || id === null || newestFromTeam <= lastReadPosted.current) return;
    if (document.visibilityState !== 'visible') return;
    const seq = lastSeqRef.current;
    lastReadPosted.current = seq;
    void markChatRead(id, seq)
      .then((result) => {
        setConversation((current) => (current === null ? current : { ...current, unreadCount: result.unreadCount }));
        void queryClient.invalidateQueries({ queryKey: chatKeys.unread });
        // The list row carries the count too; it must not go on saying unread.
        void queryClient.invalidateQueries({ queryKey: chatKeys.list });
      })
      .catch(() => {
        lastReadPosted.current = 0;
      });
  }, [active, conversationId, newestFromTeam, queryClient]);

  // ---- Sending --------------------------------------------------------------
  const deliver = useCallback(
    async (entry: PendingMessage): Promise<void> => {
      try {
        const id = conversationIdRef.current;
        if (entry.file !== undefined) {
          if (id === null) throw new Error('A conversation must exist before a file is sent.');
          const result = await uploadChatAttachment(id, entry.file, entry.clientMessageId);
          setMessages((current) => mergeMessages(current, [result.message]));
        } else {
          const result =
            id === null
              ? await startChat({
                  context: contextInput as ChatContextInput,
                  clientMessageId: entry.clientMessageId,
                  body: entry.body,
                  locale,
                })
              : await sendChatMessage(id, { clientMessageId: entry.clientMessageId, body: entry.body });
          if (id === null) {
            setConversationId(result.conversation.id);
            void queryClient.invalidateQueries({ queryKey: chatKeys.list });
          }
          setConversation(result.conversation);
          setContext((current) => result.conversation.context ?? current);
          setMessages((current) => mergeMessages(current, [result.message]));
        }
        setPending((current) => current.filter((item) => item.clientMessageId !== entry.clientMessageId));
      } catch (error) {
        setPending((current) =>
          current.map((item) =>
            item.clientMessageId === entry.clientMessageId ? { ...item, status: 'FAILED', error } : item,
          ),
        );
      }
    },
    [contextInput, locale, queryClient],
  );

  const send = useCallback(
    (body: string): void => {
      const entry: PendingMessage = {
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

  const sendFile = useCallback(
    (file: File): void => {
      const entry: PendingMessage = {
        clientMessageId: newClientMessageId(),
        body: file.name,
        file,
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

  const discard = useCallback((clientMessageId: string): void => {
    setPending((current) => current.filter((item) => item.clientMessageId !== clientMessageId));
  }, []);

  // One request at a time: scrolling near the top asks again on every
  // scroll event, and two pages of the same messages is one too many.
  const loadEarlier = useCallback(async (): Promise<void> => {
    const id = conversationIdRef.current;
    const first = messages[0]?.seq;
    if (id === null || first === undefined || loadingEarlier.current) return;
    loadingEarlier.current = true;
    setIsLoadingEarlier(true);
    try {
      const page = await fetchChatMessages(id, { before: first, limit: PAGE });
      if (conversationIdRef.current !== id) return;
      setMessages((current) => mergeMessages(current, page.messages));
      setHasEarlier(page.hasMore);
    } finally {
      loadingEarlier.current = false;
      setIsLoadingEarlier(false);
    }
  }, [messages]);

  const typingSent = useRef(false);
  const setTyping = useCallback(
    (typing: boolean): void => {
      const id = conversationIdRef.current;
      if (id === null || typing === typingSent.current) {
        // "Still typing" is re-sent now and then; the server throttles it.
        if (id !== null && typing) socket.send({ type: 'typing', conversationId: id, state: 'start' });
        return;
      }
      typingSent.current = typing;
      socket.send({ type: 'typing', conversationId: id, state: typing ? 'start' : 'stop' });
    },
    [socket],
  );

  return {
    conversation,
    context,
    messages,
    pending,
    hasEarlier,
    isLoadingEarlier,
    initialUnreadKey,
    isLoading,
    loadError,
    connection,
    teamAvailable,
    teamTyping,
    lastIncoming,
    send,
    sendFile,
    retry,
    discard,
    loadEarlier,
    setTyping,
    refresh: load,
  };
}
