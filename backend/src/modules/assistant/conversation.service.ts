/**
 * Chat conversations, and the visitor behind each one.
 *
 * The widget asks for a name, a mobile number and an email address before it
 * answers anything, and this module is where that goes. Three decisions worth
 * stating:
 *
 *   1. **The contact details are captured, not verified.** Nothing is
 *      confirmed by an email or an OTP, so a row here says "somebody typed
 *      this", never "this person is who they say". Staff following up a lead
 *      need to know which of the two they are looking at, which is why the
 *      admin screen labels it an enquiry and not a customer.
 *
 *   2. **The transcript is server-side.** The browser holds a conversation id
 *      and an opaque token; the turns live in the database. Before this, the
 *      client posted the whole history back on every turn — fine for a
 *      stateless endpoint, useless as a record: an administrator would be
 *      reading whatever the browser chose to send.
 *
 *   3. **A conversation is not an account.** No User and no CustomerProfile is
 *      created. `customerProfileId` is filled in only when the address already
 *      belongs to a customer, so an enquiry from an existing buyer is
 *      recognisable without inventing an account for one who is not.
 */
import { AssistantMessageRole } from '../../generated/prisma/client.js';
import { generateToken, safeCompare, sha256Hex } from '../../infra/crypto.js';
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

export interface VisitorDetails {
  name: string;
  phone: string;
  email: string;
}

export interface StartedConversation {
  conversationId: string;
  /** Returned exactly once, to the browser that started it. Never stored raw. */
  token: string;
}

/** Trimmed and lowercased, matching how `users.emailNormalized` is built. */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Open a conversation for a visitor who has just given their details.
 *
 * The customer lookup is a courtesy and never a gate: a visitor whose address
 * matches no account is the normal case on a catalogue, and refusing to chat
 * with them would be refusing the lead.
 */
export async function startConversation(
  visitor: VisitorDetails,
  context: { ipAddress: string | null; userAgent: string | null },
): Promise<StartedConversation> {
  const emailNormalized = normaliseEmail(visitor.email);

  const existing = await prisma.user.findUnique({
    where: { emailNormalized },
    select: { customerProfile: { select: { id: true } } },
  });

  const { token, tokenHash } = generateToken(24);
  const id = newId();

  await prisma.assistantConversation.create({
    data: {
      id,
      visitorName: visitor.name.trim(),
      visitorPhone: visitor.phone.trim(),
      visitorEmail: visitor.email.trim(),
      visitorEmailNormalized: emailNormalized,
      sessionTokenHash: tokenHash,
      customerProfileId: existing?.customerProfile?.id ?? null,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    },
  });

  return { conversationId: id, token };
}

/**
 * The conversation this id and token identify, or null.
 *
 * Compared against the stored hash in constant time. The token is what
 * separates one visitor's conversation from another's on an endpoint that has
 * no session and no cookie, so a near-miss must not be distinguishable from a
 * wild guess by how long the answer took.
 */
export async function authenticateConversation(
  conversationId: string,
  token: string,
): Promise<{ id: string; visitorName: string; messageCount: number } | null> {
  const conversation = await prisma.assistantConversation.findUnique({
    where: { id: conversationId },
    select: { id: true, visitorName: true, messageCount: true, sessionTokenHash: true },
  });

  if (conversation === null) return null;
  if (!safeCompare(conversation.sessionTokenHash, sha256Hex(token))) return null;

  return {
    id: conversation.id,
    visitorName: conversation.visitorName,
    messageCount: conversation.messageCount,
  };
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
 * visitor who closes the panel mid-answer, or a provider that fails, still
 * leaves the question on the record, and the question is the part that tells
 * staff what the lead wanted.
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

export interface ConversationSummary {
  id: string;
  visitorName: string;
  visitorPhone: string;
  visitorEmail: string;
  customerProfileId: string | null;
  customerName: string | null;
  messageCount: number;
  /** The visitor's opening question, for a list that reads without a click. */
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
  /** Only enquiries from an address that belongs to a registered customer. */
  customersOnly?: boolean | undefined;
}): Promise<ConversationListResult> {
  const search = query.search?.trim() ?? '';

  const where = {
    // An enquiry with no message is a form that was filled in and abandoned
    // before a question was asked. It is not a conversation and it is not what
    // this screen is for.
    messageCount: { gt: 0 },
    ...(query.customersOnly === true ? { customerProfileId: { not: null } } : {}),
    ...(search.length > 0
      ? {
          OR: [
            { visitorName: { contains: search } },
            { visitorEmailNormalized: { contains: search.toLowerCase() } },
            { visitorPhone: { contains: search } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.assistantConversation.findMany({
      where,
      // Most recently active first: a lead that asked a question a minute ago
      // is the one worth answering.
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      select: {
        id: true,
        visitorName: true,
        visitorPhone: true,
        visitorEmail: true,
        customerProfileId: true,
        messageCount: true,
        lastMessageAt: true,
        createdAt: true,
        customerProfile: { select: { fullName: true } },
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
      visitorName: row.visitorName,
      visitorPhone: row.visitorPhone,
      visitorEmail: row.visitorEmail,
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
      visitorName: true,
      visitorPhone: true,
      visitorEmail: true,
      customerProfileId: true,
      messageCount: true,
      lastMessageAt: true,
      createdAt: true,
      ipAddress: true,
      userAgent: true,
      customerProfile: { select: { fullName: true } },
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
    visitorName: row.visitorName,
    visitorPhone: row.visitorPhone,
    visitorEmail: row.visitorEmail,
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
