/**
 * The Preorder Chats badge and desktop alerts, on every screen of the console.
 *
 * Mounted once, in the shell, for staff who hold `preorder_chat.view`. It keeps
 * the staff chat socket open while the console is open, and on any message or
 * conversation change it refreshes the sidebar's attention counts - so the
 * "waiting for an answer" badge moves the moment a customer writes, not at the
 * next minute's poll.
 *
 * DESKTOP ALERTS
 *
 * Only after the member of staff has switched them on and the browser has
 * granted permission (`requestDesktopAlerts`), only for a CUSTOMER's message,
 * and only when this tab is not already showing that conversation. The alert
 * says a customer wrote - never what they wrote: a lock screen and a shared
 * monitor are not where a price belongs. Clicking it opens the conversation.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import { ATTENTION_QUERY_KEY } from './attention';
import { staffChatSocket } from './chat-socket';
import { Permission } from './permissions';
import { inboxKeys } from './preorder-chats';

const ALERTS_KEY = 'uboss.preorderChat.desktopAlerts';

export function desktopAlertsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function desktopAlertsOn(): boolean {
  if (!desktopAlertsSupported() || Notification.permission !== 'granted') return false;
  try {
    return localStorage.getItem(ALERTS_KEY) === 'on';
  } catch {
    return false;
  }
}

/** Ask the browser, and remember the choice for this browser only. */
export async function requestDesktopAlerts(on: boolean): Promise<boolean> {
  if (!desktopAlertsSupported()) return false;
  if (on && Notification.permission !== 'granted') {
    const answer = await Notification.requestPermission();
    if (answer !== 'granted') return false;
  }
  try {
    localStorage.setItem(ALERTS_KEY, on ? 'on' : 'off');
  } catch {
    return false;
  }
  return on;
}

/** The conversation this tab is showing, so it does not alert about itself. */
let visibleConversation: string | null = null;
export function setVisibleConversation(id: string | null): void {
  visibleConversation = id;
}

export function usePreorderChatLive(): void {
  const { user, can } = useSession();
  const allowed = user !== null && can(Permission.PREORDER_CHAT_VIEW);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { t } = useI18n();
  const pending = useRef<number | null>(null);

  useEffect(() => {
    if (!allowed) return undefined;
    const socket = staffChatSocket();
    const release = socket.acquire();

    // Several frames arrive together for one send; one refresh covers them.
    const refreshCounts = (): void => {
      if (pending.current !== null) return;
      pending.current = window.setTimeout(() => {
        pending.current = null;
        void queryClient.invalidateQueries({ queryKey: ATTENTION_QUERY_KEY });
        // The queue itself, not only its counts: a new conversation must
        // appear in the list the moment it is counted.
        void queryClient.invalidateQueries({ queryKey: inboxKeys.counts });
        void queryClient.invalidateQueries({ queryKey: ['preorder-chats', 'list'] });
        void queryClient.invalidateQueries({ queryKey: inboxKeys.operations });
      }, 250);
    };

    const stopFrames = socket.onFrame((frame) => {
      if (frame.type === 'conversation.updated' || frame.type === 'message.created') refreshCounts();
      if (frame.type !== 'message.created') return;
      const message = frame['message'] as { senderType?: string } | undefined;
      const conversationId = typeof frame['conversationId'] === 'string' ? frame['conversationId'] : '';
      if (message?.senderType !== 'CUSTOMER' || !desktopAlertsOn()) return;
      if (document.visibilityState === 'visible' && visibleConversation === conversationId) return;
      const alert = new Notification(t('preorderChats.alert.title'), {
        body: t('preorderChats.alert.body'),
        // One alert per conversation at a time rather than a stack of them.
        tag: `preorder-chat-${conversationId}`,
      });
      alert.onclick = () => {
        window.focus();
        void navigate(`/preorder-chats/${conversationId}`);
        alert.close();
      };
    });

    return () => {
      stopFrames();
      release();
      if (pending.current !== null) window.clearTimeout(pending.current);
      pending.current = null;
    };
  }, [allowed, queryClient, navigate, t]);
}
