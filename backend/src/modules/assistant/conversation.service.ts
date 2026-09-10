/**
 * Chat conversations, and whoever is behind each one.
 *
 * There are two kinds, and the difference runs through this whole file:
 *
 *   - **A customer's**, owned by `customerProfileId` and therefore theirs on
 *     every machine they sign in from. These are what AI Mode's history lists.
 *   - **A guest's**, owned by an opaque token their browser holds for the life
 *     of the tab. Anyone may ask this catalogue a question without opening an
 *     account, on the same reasoning that puts the sign-in wall at the cart
 *     rather than the front door — see `ASSISTANT_ALLOW_GUESTS`, which lets an
 *     operator close it again, and read the note there on what it costs.
 *
 * Four decisions worth stating:
 *
 *   1. **The owner is never typed by whoever is asking.** A customer's comes
 *      from the session guard on the route. A guest's is a secret this server
 *      minted and only that browser holds — not a name, an email or a phone
 *      number somebody entered into a box. The widget used to collect all
 *      three before it would answer anything, and verified none of them; that
 *      form is gone and is not coming back. Anonymous is the honest word for a
 *      visitor, and it is cheaper for everyone than an unchecked claim.
 *
 *   2. **The two authorities do not cross.** A row is owned by an account or
 *      by a token, never both, and each branch of `authoriseConversation`
 *      demands the column the other one leaves null.
 *
 *   3. **The transcript is server-side.** The browser holds a conversation id
 *      and nothing else; the turns live in the database. Before this, the
 *      client posted the whole history back on every turn — fine for a
 *      stateless endpoint, useless as a record: an administrator would be
 *      reading whatever the browser chose to send.
 *
 *   4. **Nothing here deletes history.** The `visitor*` columns are nullable
 *      and no longer written, but the rows that have them keep them until the
 *      retention sweep or an erasure request takes them. See the model
 *      comments in `schema.prisma`.
 */
import { AssistantMessageRole } from '../../generated/prisma/client.js';
import { safeCompare } from '../../infra/crypto.js';
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

/**
 * Who a conversation belongs to.
 *
 * Two shapes, and they are deliberately not interchangeable. A signed-in
 * customer owns their conversations through their account, so they follow them
 * from one machine to the next and appear in their AI Mode history. A guest
 * owns exactly one, through an opaque token their browser holds for the life
 * of the tab, and it appears in nobody's history because there is no account
 * for it to belong to.
 *
 * Written as a discriminated union rather than two nullable fields because the
 * one thing that must never happen is a guest token opening a customer's
 * conversation, or the reverse. A union makes the wrong call a type error
 * instead of a runtime check somebody can forget.
 */
export type ConversationOwner =
  | { kind: 'customer'; customerProfileId: string }
  | { kind: 'guest'; sessionTokenHash: string };

export interface StartedConversation {
  conversationId: string;
}

/**
 * Open a conversation.
 *
 * Nothing is asked of anybody first. The original flow took a name, a mobile
 * number and an email before it would answer a question; none of the three was
 * ever verified, so it bought friction rather than safety, and it is not
 * coming back — a guest is anonymous here in the ordinary sense of the word.
 *
 * The owner decides which column is written. A customer conversation carries
 * `customerProfileId` and no token; a guest conversation carries the SHA-256
 * of the token handed back to the browser and no owner. Never both: a row with
 * both would be reachable by two different authorities, which is exactly the
 * confusion the union above exists to prevent.
 */
export async function startConversation(
  owner: ConversationOwner,
  context: { ipAddress: string | null; userAgent: string | null },
): Promise<StartedConversation> {
  const id = newId();

  await prisma.assistantConversation.create({
    data: {
      id,
      customerProfileId: owner.kind === 'customer' ? owner.customerProfileId : null,
      sessionTokenHash: owner.kind === 'guest' ? owner.sessionTokenHash : null,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    },
  });

  return { conversationId: id };
}

/**
 * The conversation, if this caller is the one who owns it.
 *
 * Ownership is the whole check, and which authority proves it depends on who
 * is asking. A customer proves it with their account, which the session guard
 * established. A guest proves it with the token they were handed when the
 * conversation was opened — an opaque secret their browser holds, matched
 * against the hash stored on the row, never against anything they can guess.
 *
 * The two authorities do not cross. A guest token cannot open a conversation
 * that has an owner, and a customer cannot pick up a guest conversation by its
 * id: a row is either owned or tokened, and each branch demands the column the
 * other one leaves null.
 *
 * Null covers "no such conversation", "not yours" and "you deleted it", and
 * the route turns all three into a 404 — an owner mismatch must not be
 * distinguishable from a missing row, or the id becomes a way to ask whether
 * somebody else's conversation exists.
 */
export async function authoriseConversation(
  conversationId: string,
  owner: ConversationOwner,
): Promise<{ id: string; messageCount: number } | null> {
  const conversation = await prisma.assistantConversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      messageCount: true,
      customerProfileId: true,
      sessionTokenHash: true,
      hiddenAt: true,
    },
  });

  if (conversation === null) return null;

  // Deleted from the customer's own history. The row survives for staff and
  // for the retention sweep; it is not a thread anybody can go on adding to.
  if (conversation.hiddenAt !== null) return null;

  if (owner.kind === 'customer') {
    if (conversation.customerProfileId !== owner.customerProfileId) return null;
    return { id: conversation.id, messageCount: conversation.messageCount };
  }

  // A guest. The row must have no account behind it — otherwise a token would
  // be a second key to a customer's conversation — and its stored hash must
  // match. Compared in constant time: it is a bearer secret, and the fact that
  // both sides are already hashes is not a reason to leak the comparison.
  if (conversation.customerProfileId !== null) return null;
  if (conversation.sessionTokenHash === null) return null;
  if (!safeCompare(conversation.sessionTokenHash, owner.sessionTokenHash)) return null;

  return { id: conversation.id, messageCount: conversation.messageCount };
}

// ---------------------------------------------------------------------------
// The customer's own history
//
// Everything below is read and written under the caller's own
// `customerProfileId`, which comes from the route's session guard and never
// from the request. That is the whole of the isolation between one customer's
// AI Mode sidebar and another's: there is no query here that can be widened by
// anything the browser sends.
// ---------------------------------------------------------------------------

/** How many threads the sidebar shows. Beyond this, the oldest fall off. */
const HISTORY_LIMIT = 50;

export interface CustomerConversationSummary {
  id: string;
  /** What the customer renamed it to, or null to fall back to `preview`. */
  title: string | null;
  /** The opening question, so an unnamed thread still reads as something. */
  preview: string | null;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
}

/**
 * The threads in this customer's sidebar, most recently active first.
 *
 * Empty conversations are excluded for the same reason the admin list excludes
 * them: a panel somebody opened and closed again is not a conversation, and a
 * sidebar that grows a blank row every time the page is visited is a bug
 * customers report.
 */
export async function listCustomerConversations(
  customerProfileId: string,
): Promise<CustomerConversationSummary[]> {
  const rows = await prisma.assistantConversation.findMany({
    where: { customerProfileId, hiddenAt: null, messageCount: { gt: 0 } },
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
    take: HISTORY_LIMIT,
    select: {
      id: true,
      title: true,
      messageCount: true,
      lastMessageAt: true,
      createdAt: true,
      messages: {
        where: { role: AssistantMessageRole.VISITOR },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 1,
        select: { content: true },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    // Trimmed to a sidebar's worth. The full question is one click away and
    // sending 8,000 characters per row to render 40 of them is not a list.
    preview: row.messages[0]?.content.slice(0, 160) ?? null,
    messageCount: row.messageCount,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export interface CustomerConversationDetail extends CustomerConversationSummary {
  messages: { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }[];
}

/**
 * One thread in full, for the customer who owns it.
 *
 * The roles come back as `user` / `assistant` rather than the database's
 * `VISITOR` / `ASSISTANT`: this feeds a chat transcript, and the page should
 * not have to know that the column was named in the era of the guest widget.
 */
export async function customerConversation(
  conversationId: string,
  customerProfileId: string,
): Promise<CustomerConversationDetail | null> {
  const row = await prisma.assistantConversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      title: true,
      customerProfileId: true,
      hiddenAt: true,
      messageCount: true,
      lastMessageAt: true,
      createdAt: true,
      messages: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, role: true, content: true, createdAt: true },
      },
    },
  });

  if (row === null) return null;
  if (row.customerProfileId !== customerProfileId) return null;
  if (row.hiddenAt !== null) return null;

  const firstQuestion =
    row.messages.find((message) => message.role === AssistantMessageRole.VISITOR)?.content ?? null;

  return {
    id: row.id,
    title: row.title,
    preview: firstQuestion?.slice(0, 160) ?? null,
    messageCount: row.messageCount,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    messages: row.messages.map((message) => ({
      id: message.id,
      role: message.role === AssistantMessageRole.VISITOR ? ('user' as const) : ('assistant' as const),
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    })),
  };
}

/**
 * Rename a thread, or clear the name back to the opening-question fallback.
 *
 * `updateMany` with the owner in the `where`, not a `findUnique` followed by an
 * `update`: one statement that cannot be raced, and a row belonging to somebody
 * else simply matches nothing. The count is what tells the route whether to
 * answer 200 or 404.
 */
export async function renameCustomerConversation(
  conversationId: string,
  customerProfileId: string,
  title: string | null,
): Promise<boolean> {
  const result = await prisma.assistantConversation.updateMany({
    where: { id: conversationId, customerProfileId, hiddenAt: null },
    data: { title },
  });

  return result.count > 0;
}

/**
 * Remove a thread from the customer's history.
 *
 * Soft, and the model comment in `schema.prisma` says why at length: what the
 * AI told a buyer about a medical device is a record this deployment has to be
 * able to produce, and a sidebar tidy-up is not a decision to destroy it. From
 * the customer's side the effect is total — it is gone from the list, gone from
 * the reads, and `authoriseConversation` will not let it be continued.
 */
export async function hideCustomerConversation(
  conversationId: string,
  customerProfileId: string,
): Promise<boolean> {
  const result = await prisma.assistantConversation.updateMany({
    where: { id: conversationId, customerProfileId, hiddenAt: null },
    data: { hiddenAt: new Date() },
  });

  return result.count > 0;
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
