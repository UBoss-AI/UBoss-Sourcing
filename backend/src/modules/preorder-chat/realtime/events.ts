/**
 * What travels on the chat bus. References only - see `bus.ts`.
 *
 * `customerProfileId` rides on every conversation event so that a process can
 * decide which customer sockets an event concerns without a database read. It
 * is an id, and the socket it is matched against already belongs to that
 * profile; it is never sent on to a browser.
 */
export type ChatSide = 'CUSTOMER' | 'STAFF';

export type ChatBusEvent =
  | {
      kind: 'message.created';
      conversationId: string;
      customerProfileId: string;
      messageId: string;
      seq: number;
    }
  | {
      /** A redaction, or a proposal card whose state changed. */
      kind: 'message.updated';
      conversationId: string;
      customerProfileId: string;
      messageId: string;
    }
  | {
      kind: 'conversation.updated';
      conversationId: string;
      customerProfileId: string;
      /**
       * Why, so a client can decide what to refetch. `staffOnly` changes -
       * notes, tags, assignment - are never delivered to the customer at all.
       */
      reason:
        | 'created'
        | 'message'
        | 'status'
        | 'assigned'
        | 'priority'
        | 'tags'
        | 'note'
        | 'linked'
        | 'proposal'
        | 'receipt';
      staffOnly: boolean;
    }
  | {
      /** Delivered/read positions moved. */
      kind: 'receipt';
      conversationId: string;
      customerProfileId: string;
      /** Whose position moved. */
      side: ChatSide;
      deliveredSeq: number;
      readSeq: number;
    }
  | {
      /** Never stored anywhere but this row's short life on the database bus. */
      kind: 'typing';
      conversationId: string;
      customerProfileId: string;
      side: ChatSide;
      userId: string;
      state: 'start' | 'stop';
    }
  | {
      /** How many staff who may reply are connected to one process. */
      kind: 'presence';
      instanceId: string;
      staffOnline: number;
    };
