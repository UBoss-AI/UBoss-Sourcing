/**
 * The storefront's live connection to the preorder chat.
 *
 * One socket for the whole tab, shared by every chat surface on the page, and
 * only while at least one of them is mounted. It carries NOTHING the page
 * relies on for correctness: every message is sent over REST and every
 * message can be read back over REST by sequence number. What the socket adds
 * is that the reply appears without a reload.
 *
 * WHEN IT DROPS
 *
 * It comes back on its own - after 1 s, then 2, 4, 8 ... up to 30, each with
 * some jitter so a server restart is not met by every browser at once - and
 * immediately when the browser says it is online again or the tab comes back
 * into view. Listeners are told `reconnected`, which is their cue to fetch
 * what they missed after the last sequence they hold.
 *
 * A close with 4401 means the session's access token expired: the page renews
 * it through the same one-at-a-time refresh every request uses and tries
 * again. 4403 means this account may no longer chat, and it stops.
 *
 * The state is reported honestly - `connecting`, `open`, `reconnecting`,
 * `offline`, `signedOut` - so the drawer never claims to be live when it is
 * not.
 */
import { BASE_URL, renewSession } from './api';

export type ChatConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'offline' | 'signedOut';

export type ChatFrame = { type: string } & Record<string, unknown>;

type FrameListener = (frame: ChatFrame) => void;
type StateListener = (state: ChatConnectionState, reconnected: boolean) => void;

const MAX_DELAY_MS = 30_000;

export function socketUrl(path: string): string {
  const base = new URL(`${BASE_URL}${path}`, window.location.origin);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return base.toString();
}

export class ChatSocket {
  private socket: WebSocket | null = null;
  private state: ChatConnectionState = 'idle';
  private attempts = 0;
  private timer: number | null = null;
  private users = 0;
  private everOpened = false;
  private readonly frames = new Set<FrameListener>();
  private readonly states = new Set<StateListener>();
  /** Conversations to subscribe to, re-sent after every reconnect. */
  private readonly subscriptions = new Map<string, number>();

  constructor(private readonly path: string) {}

  private readonly onOnline = (): void => {
    if (this.users > 0 && this.state !== 'open') this.connectNow();
  };
  private readonly onOffline = (): void => {
    this.setState('offline', false);
  };
  private readonly onVisible = (): void => {
    if (document.visibilityState === 'visible' && this.users > 0 && this.state !== 'open') {
      this.connectNow();
    }
  };

  /** A surface wants the socket. Returns the release. */
  acquire(): () => void {
    this.users += 1;
    if (this.users === 1) {
      window.addEventListener('online', this.onOnline);
      window.addEventListener('offline', this.onOffline);
      document.addEventListener('visibilitychange', this.onVisible);
      this.connectNow();
    }
    return () => {
      this.users -= 1;
      if (this.users === 0) this.shutDown();
    };
  }

  onFrame(listener: FrameListener): () => void {
    this.frames.add(listener);
    return () => this.frames.delete(listener);
  }

  onState(listener: StateListener): () => void {
    this.states.add(listener);
    listener(this.state, false);
    return () => this.states.delete(listener);
  }

  getState(): ChatConnectionState {
    return this.state;
  }

  subscribe(conversationId: string): () => void {
    this.subscriptions.set(conversationId, (this.subscriptions.get(conversationId) ?? 0) + 1);
    this.send({ type: 'subscribe', conversationId });
    return () => {
      const left = (this.subscriptions.get(conversationId) ?? 1) - 1;
      if (left <= 0) {
        this.subscriptions.delete(conversationId);
        this.send({ type: 'unsubscribe', conversationId });
      } else {
        this.subscriptions.set(conversationId, left);
      }
    };
  }

  /** Best effort: typing and delivered marks are worth nothing late. */
  send(frame: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private setState(state: ChatConnectionState, reconnected: boolean): void {
    this.state = state;
    for (const listener of this.states) listener(state, reconnected);
  }

  private connectNow(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.socket !== null && this.socket.readyState <= WebSocket.OPEN) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.setState('offline', false);
      return;
    }
    this.setState(this.everOpened ? 'reconnecting' : 'connecting', false);

    let socket: WebSocket;
    try {
      socket = new WebSocket(socketUrl(this.path));
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      const reconnected = this.everOpened;
      this.everOpened = true;
      this.attempts = 0;
      for (const conversationId of this.subscriptions.keys()) {
        socket.send(JSON.stringify({ type: 'subscribe', conversationId }));
      }
      this.setState('open', reconnected);
    });

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      let frame: ChatFrame;
      try {
        frame = JSON.parse(event.data) as ChatFrame;
      } catch {
        return;
      }
      for (const listener of this.frames) listener(frame);
    });

    socket.addEventListener('close', (event) => {
      if (this.socket === socket) this.socket = null;
      if (this.users === 0) return;
      if (event.code === 4403) {
        this.setState('signedOut', false);
        return;
      }
      if (event.code === 4401) {
        void renewSession().then((renewed) => {
          if (renewed) this.scheduleRetry(0);
          else this.setState('signedOut', false);
        });
        return;
      }
      this.scheduleRetry();
    });
  }

  private scheduleRetry(fixedDelay?: number): void {
    if (this.users === 0) return;
    const exponential = Math.min(MAX_DELAY_MS, 1_000 * 2 ** this.attempts);
    const delay = fixedDelay ?? exponential * (0.75 + Math.random() * 0.5);
    this.attempts += 1;
    this.setState(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'reconnecting', false);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.connectNow();
    }, delay);
  }

  private shutDown(): void {
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    document.removeEventListener('visibilitychange', this.onVisible);
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'no longer needed');
    this.everOpened = false;
    this.attempts = 0;
    this.setState('idle', false);
  }
}

let shared: ChatSocket | null = null;

/** The tab's one customer chat socket. */
export function customerChatSocket(): ChatSocket {
  shared ??= new ChatSocket('/preorder-chats/socket');
  return shared;
}
