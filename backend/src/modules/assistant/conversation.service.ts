/**
 * Chat conversations, and the customer behind each one.
 *
 * The widget used to ask a visitor for a name, a mobile number and an email
 * before it would answer anything. It no longer asks for any of the three: the
 * assistant is behind the customer session now, so who is asking is something
 * the request already proves. Three decisions worth stating:
 *
 *   1. **The owner is authenticated, not typed.** `customerProfileId` comes
 *      from the session guard on the route, never from the request body, and
 *      it is the only thing `/assistant/chat` authorises against. A row here
 *      says "this customer asked this", which is a stronger claim than
 *      anything the old capture form could make — it never verified a single
 *      character of what somebody typed into it.
 *
 *   2. **The transcript is server-side.** The browser holds a conversation id
 *      and nothing else; the turns live in the database. Before this, the
 *      client posted the whole history back on every turn — fine for a
 *      stateless endpoint, useless as a record: an administrator would be
 *      reading whatever the browser chose to send.
 *
 *   3. **Nothing here deletes history.** The `visitor*` columns are nullable
 *      and no longer written, but the rows that have them keep them until the
 *      retention sweep or an erasure request takes them. See the model
 *      comments in `schema.prisma`.
 */
import { AssistantMessageRole } from '../../generated/prisma/client.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import type { AssistantTurn } from './provider.js';

/**
 * How much of a conversation is replayed to the model.
 *
 * The whole transcript is kept for staff; only the tail is sent, because the
 * prompt is billed per turn and a visitor twenty questions in is not still
 * asking about the first one.
 */
const HISTORY_TURNS = 20;

export interface StartedConversation {
  conversationId: string;
}

/**
 * Open a conversation for the signed-in customer.
 *
 * Nothing is asked of them first. The old flow took a name, a mobile number
 * and an email before it would answer a question; all three are either already
 * known from the account or not needed to answer one, and asking a customer
 * who has just signed in to type their own email is friction that buys
 * nothing.
 *
 * `customerProfileId` is required rather than optional. It comes from the
 * route's session guard, and it is what every later read and write on this
 * conversation is checked against — there is no unowned conversation for an
 * ownership check to fall through.
 */
export async function startConversation(
  owner: { customerProfileId: string },
  context: { ipAddress: string | null; userAgent: string | null },
): Promise<StartedConversation> {
  const id = newId();

  await prisma.assistantConversation.create({
    data: {
      id,
      customerProfileId: owner.customerProfileId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    },
  });

  return { conversationId: id };
}

/**
 * The conversation, if it is this customer's.
 *
 * Ownership is the whole check. There is no opaque per-conversation token any
 * more: that existed because the endpoint had no session and something had to
 * separate one anonymous visitor from another. A session does that now, and
 * minting a second bearer secret alongside it would only be one more thing to
 * leak.
 *
 * Null covers both "no such conversation" and "not yours", and the route turns
 * both into a 404 — an owner mismatch must not be distinguishable from a
 * missing row, or the id becomes a way to ask whether somebody else's
 * conversation exists.
 */
export async function authoriseConversation(
  conversationId: string,
  customerProfileId: string,
): Promise<{ id: string; messageCount: number } | null> {
  const conversation = await prisma.assistantConversation.findUnique({
    where: { id: conversationId },
    select: { id: true, messageCount: true, customerProfileId: true },
  });

  if (conversation === null) return null;
  if (conversation.customerProfileId !== customerProfileId) return null;

  return { id: conversation.id, messageCount: conversation.messageCount };
}

/**
 * What the assistant may know about the customer without asking them.
 *
 * Read from the account, under the session that just authenticated — never
 * from anything the browser sent. It is what replaces the three questions the
 * widget used to open with: the answers were always weaker than this, because
 * nothing typed into that form was verified.
 *
 * Null for a profile that has been deleted between the guard and this read,
 * which is a race rather than a state; the assistant then answers without
 * personalisation, which is the correct degradation.
 */
export interface AssistantCustomerContext {
  fullName: string;
  organization: string | null;
  department: string | null;
  customerCode: string | null;
  preferredCurrency: string | null;
  preferredCountry: string | null;
}

export async function customerContext(
  customerProfileId: string,
): Promise<AssistantCustomerContext | null> {
  const profile = await prisma.customerProfile.findUnique({
    where: { id: customerProfileId },
    select: {
      fullName: true,
      organization: true,
      department: true,
      customerCode: true,
      preferredCurrency: true,
      preferredCountry: true,
    },
  });

  return profile;
}

/** The tail of the transcript, oldest first, in the shape the provider takes. */
export async function conversationHistory(conversationId: string): Promise<AssistantTurn[]> {
  const rows = await prisma.assistantMessage.findMany({
    where: { conversationId },
    // Newest first with a `take`, then reversed: the tail is what is wanted,
    // and ordering ascending with a take would return the oldest turns.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: HISTORY_TURNS,
    select: { role: true, content: true },
  });

  return rows
    .reverse()
    .map((row) => ({
      role: row.role === AssistantMessageRole.VISITOR ? ('user' as const) : ('assistant' as const),
      content: row.content,
    }));
}

/**
 * Append one message and move the conversation's summary columns with it.
 *
 * Called twice per turn — once for the question, before the provider is
 * asked, and once for the answer. Writing the question first is deliberate: a
 * customer who closes the panel mid-answer, or a provider that fails, still
 * leaves the question on the record, and the question is the part that tells
 * staff what was being asked for.
 */
export async function appendMessage(
  conversationId: string,
  role: 'VISITOR' | 'ASSISTANT',
  content: string,
): Promise<void> {
  const now = new Date();

  await prisma.$transaction([
    prisma.assistantMessage.create({
      data: {
        id: newId(),
        conversationId,
        role:
          role === 'VISITOR' ? AssistantMessageRole.VISITOR : AssistantMessageRole.ASSISTANT,
        content,
        createdAt: now,
      },
    }),
    prisma.assistantConversation.update({
      where: { id: conversationId },
      data: { messageCount: { increment: 1 }, lastMessageAt: now },
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Admin reads
// ---------------------------------------------------------------------------

/**
 * Who a conversation was with, as staff need to read it.
 *
 * Two eras answer this differently and the screen must not care which one it
 * is looking at:
 *
 *   - A conversation started since the assistant moved behind the sign-in has
 *     an owning account, and the name, email and phone come from that account.
 *     They are verified, in the sense that whoever asked held the credentials.
 *   - A conversation from the old guest widget carries whatever was typed into
 *     the capture form, and nothing about it was ever checked.
 *
 * `isVerifiedContact` says which of the two a row is, because a phone number
 * nobody confirmed and a phone number on an account are different things to
 * act on. Every field is nullable: a customer need not have given a phone, and
 * a historical row loses its typed details to the retention sweep.
 */
export interface ConversationContact {
  name: string | null;
  email: string | null;
  phone: string | null;
  isVerifiedContact: boolean;
}

/** The columns both admin reads select, so the mapping below has one home. */
const CONTACT_SELECT = {
  visitorName: true,
  visitorEmail: true,
  visitorPhone: true,
  customerProfile: {
    select: { fullName: true, phone: true, user: { select: { email: true } } },
  },
} as const;

interface ContactColumns {
  visitorName: string | null;
  visitorEmail: string | null;
  visitorPhone: string | null;
  customerProfile: { fullName: string; phone: string | null; user: { email: string } } | null;
}

function contactOf(row: ContactColumns): ConversationContact {
  // The account wins wherever there is one. A row can carry both - a guest
  // enquiry whose typed address happened to match an account - and the account
  // is the half that was proved.
  if (row.customerProfile !== null) {
    return {
      name: row.customerProfile.fullName,
      email: row.customerProfile.user.email,
      phone: row.customerProfile.phone,
      isVerifiedContact: true,
    };
  }

  return {
    name: row.visitorName,
    email: row.visitorEmail,
    phone: row.visitorPhone,
    isVerifiedContact: false,
  };
}

export interface ConversationSummary extends ConversationContact {
  id: string;
  customerProfileId: string | null;
  customerName: string | null;
  messageCount: number;
  /** The opening question, for a list that reads without a click. */
  firstQuestion: string | null;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface ConversationListResult {
  conversations: ConversationSummary[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export async function listConversations(query: {
  page: number;
  limit: number;
  search?: string | undefined;
  /** Only conversations that belong to a registered customer. */
  customersOnly?: boolean | undefined;
}): Promise<ConversationListResult> {
  const search = query.search?.trim() ?? '';

  const where = {
    // A conversation with no message is a panel somebody opened and closed
    // again. It is not a conversation and it is not what this screen is for.
    messageCount: { gt: 0 },
    ...(query.customersOnly === true ? { customerProfileId: { not: null } } : {}),
    ...(search.length > 0
      ? {
          // Both eras, through one search box. The first three branches find a
          // historical guest enquiry; the account branches find everything
          // since, where those columns are null and the name and the address
          // live on the profile instead.
          OR: [
            { visitorName: { contains: search } },
            { visitorEmailNormalized: { contains: search.toLowerCase() } },
            { visitorPhone: { contains: search } },
            { customerProfile: { fullName: { contains: search } } },
            { customerProfile: { phone: { contains: search } } },
            { customerProfile: { user: { emailNormalized: { contains: search.toLowerCase() } } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.assistantConversation.findMany({
      where,
      // Most recently active first: somebody who asked a question a minute ago
      // is the one worth answering.
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      select: {
        id: true,
        ...CONTACT_SELECT,
        customerProfileId: true,
        messageCount: true,
        lastMessageAt: true,
        createdAt: true,
        messages: {
          where: { role: AssistantMessageRole.VISITOR },
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { content: true },
        },
      },
    }),
    prisma.assistantConversation.count({ where }),
  ]);

  return {
    conversations: rows.map((row) => ({
      id: row.id,
      ...contactOf(row),
      customerProfileId: row.customerProfileId,
      customerName: row.customerProfile?.fullName ?? null,
      messageCount: row.messageCount,
      firstQuestion: row.messages[0]?.content ?? null,
      lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    },
  };
}

export interface ConversationDetail extends ConversationSummary {
  ipAddress: string | null;
  userAgent: string | null;
  messages: { id: string; role: 'VISITOR' | 'ASSISTANT'; content: string; createdAt: string }[];
}

/** The whole transcript. Returns null rather than throwing, so the route can 404. */
export async function getConversation(id: string): Promise<ConversationDetail | null> {
  const row = await prisma.assistantConversation.findUnique({
    where: { id },
    select: {
      id: true,
      ...CONTACT_SELECT,
      customerProfileId: true,
      messageCount: true,
      lastMessageAt: true,
      createdAt: true,
      ipAddress: true,
      userAgent: true,
      messages: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, role: true, content: true, createdAt: true },
      },
    },
  });

  if (row === null) return null;

  const firstQuestion =
    row.messages.find((message) => message.role === AssistantMessageRole.VISITOR)?.content ?? null;

  return {
    id: row.id,
    ...contactOf(row),
    customerProfileId: row.customerProfileId,
    customerName: row.customerProfile?.fullName ?? null,
    messageCount: row.messageCount,
    firstQuestion,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    messages: row.messages.map((message) => ({
      id: message.id,
      role: message.role === AssistantMessageRole.VISITOR ? 'VISITOR' : 'ASSISTANT',
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    })),
  };
}
