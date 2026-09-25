/**
 * The preorder assistant: what the storefront asks the server, and how an
 * answer is turned into words.
 *
 * The assistant answers common questions about a preorder before a person is
 * involved. It is automated and says so. Every answer comes from the server,
 * which builds it from the product's own preorder terms, verified container
 * loading, stock and delivery window; the browser never computes a figure.
 * What the browser does is choose the words: an answer is a list of lines,
 * each a translation key and typed values, so it reads in the customer's own
 * language and number, date and money formats.
 *
 * The answers read so far - the transcript - are kept in this tab's
 * sessionStorage, per product and option. That is what lets a guest sign in
 * and still carry them to a person, and what lets the drawer be closed and
 * opened again without the greeting starting over. Each answer carries the
 * server's signature; the server will only accept answers it gave, for this
 * product, in the last day.
 */
import type { Translate, TranslationKey } from '@/i18n/i18n-context';
import { api } from './api';
import { formatIsoDate } from './calendar-date';
import { formatMoneyMinor } from './format';
import type { ChatContextInput, ChatMessage, CustomerConversation } from './preorder-chat';

export const FAQ_IDS = [
  'moq',
  'bulkPricing',
  'container20',
  'container40',
  'stock',
  'insufficientStock',
  'deliveryDate',
  'splitShipments',
  'customisation',
  'payment',
  'logistics',
  'changeCancel',
] as const;
export type FaqId = (typeof FAQ_IDS)[number];

export type FaqValue =
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'date'; value: string }
  | { kind: 'money'; minor: string; currency: string }
  | { kind: 'unit'; value: string }
  | { kind: 'countries'; value: string[] };

export interface FaqAnswerLine {
  key: string;
  values: Record<string, FaqValue>;
}

export interface FaqAnswer {
  faqId: FaqId;
  version: number;
  outcome: 'ANSWERED' | 'NEEDS_CONFIRMATION';
  lines: FaqAnswerLine[];
}

export interface SignedAnswer {
  answer: FaqAnswer;
  askedAt: string;
  token: string;
}

export interface AssistantQuestion {
  id: FaqId;
  category: string;
  questionKey: string;
  version: number;
  requiresHumanConfirmation: boolean;
}

export interface AssistantIntro {
  greeting: { firstName: string | null; productName: string; variantName: string | null };
  questions: AssistantQuestion[];
  signedIn: boolean;
}

export interface HandoffResult {
  conversation: CustomerConversation;
  messages: ChatMessage[];
  created: boolean;
  duplicate: boolean;
}

export const assistantKeys = {
  intro: (context: ChatContextInput, signedIn: boolean) =>
    ['preorder-assistant', 'intro', context.productId, context.variantId, signedIn] as const,
};

export function fetchAssistant(context: ChatContextInput): Promise<AssistantIntro> {
  return api.post<AssistantIntro>('/preorder-chats/assistant', { context });
}

export function askAssistant(context: ChatContextInput, faqId: FaqId): Promise<SignedAnswer> {
  return api.post<SignedAnswer>('/preorder-chats/assistant/answer', { context, faqId });
}

export function requestHandoff(input: {
  clientRequestId: string;
  context: ChatContextInput;
  locale: string | null;
  topic: FaqId | null;
  transcript: SignedAnswer[];
}): Promise<HandoffResult> {
  return api.post<HandoffResult>('/preorder-chats/handoff', input);
}

// ---------------------------------------------------------------------------
// The transcript, kept in this tab
// ---------------------------------------------------------------------------

export interface TranscriptEntry extends SignedAnswer {
  /** "Was this helpful?" - null until answered. */
  feedback: 'helpful' | null;
}

/** The server takes at most this many; older ones drop off the front. */
export const TRANSCRIPT_MAX = 24;

const TRANSCRIPT_PREFIX = 'uboss.preorderAssistant.transcript:';
const HANDOFF_INTENT_KEY = 'uboss.preorderAssistant.handoff';
/** Matches the server's limit on how old a carried answer may be. */
const TRANSCRIPT_TTL_MS = 23 * 60 * 60_000;

function transcriptKey(productId: string, variantId: string | null): string {
  return `${TRANSCRIPT_PREFIX}${productId}:${variantId ?? ''}`;
}

function isEntry(value: unknown): value is TranscriptEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as { token?: unknown; askedAt?: unknown; answer?: unknown };
  if (typeof entry.token !== 'string' || typeof entry.askedAt !== 'string') return false;
  if (typeof entry.answer !== 'object' || entry.answer === null) return false;
  const answer = entry.answer as { faqId?: unknown; lines?: unknown };
  return (
    typeof answer.faqId === 'string' &&
    (FAQ_IDS as readonly string[]).includes(answer.faqId) &&
    Array.isArray(answer.lines)
  );
}

export function readTranscript(productId: string, variantId: string | null, now: number = Date.now()): TranscriptEntry[] {
  try {
    const raw = sessionStorage.getItem(transcriptKey(productId, variantId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isEntry)
      .filter((entry) => now - Date.parse(entry.askedAt) < TRANSCRIPT_TTL_MS)
      .slice(-TRANSCRIPT_MAX);
  } catch {
    return [];
  }
}

export function saveTranscript(productId: string, variantId: string | null, entries: TranscriptEntry[]): void {
  try {
    sessionStorage.setItem(transcriptKey(productId, variantId), JSON.stringify(entries.slice(-TRANSCRIPT_MAX)));
  } catch {
    /* private mode: the answers stay on screen, they just do not survive a reload */
  }
}

export function clearTranscript(productId: string, variantId: string | null): void {
  try {
    sessionStorage.removeItem(transcriptKey(productId, variantId));
  } catch {
    /* nothing to clear */
  }
}

/** What the server is sent: the signed answers, nothing the browser added. */
export function signedAnswers(entries: readonly TranscriptEntry[]): SignedAnswer[] {
  return entries.map(({ answer, askedAt, token }) => ({ answer, askedAt, token }));
}

export interface HandoffIntent {
  productId: string;
  variantId: string | null;
  topic: FaqId | null;
}

/** A guest pressed "Connect with a human agent": finish it after they sign in. */
export function rememberHandoffIntent(intent: HandoffIntent): void {
  try {
    sessionStorage.setItem(HANDOFF_INTENT_KEY, JSON.stringify(intent));
  } catch {
    /* they will press it again once signed in */
  }
}

export function takeHandoffIntent(productId: string, variantId: string | null): HandoffIntent | null {
  try {
    const raw = sessionStorage.getItem(HANDOFF_INTENT_KEY);
    if (raw === null) return null;
    const intent = JSON.parse(raw) as HandoffIntent;
    if (intent.productId !== productId || (intent.variantId ?? null) !== variantId) return null;
    sessionStorage.removeItem(HANDOFF_INTENT_KEY);
    return {
      productId: intent.productId,
      variantId: intent.variantId ?? null,
      topic: (FAQ_IDS as readonly string[]).includes(intent.topic ?? '') ? intent.topic : null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

function countryList(codes: string[], intlLocale: string): string {
  let names: string[] = codes;
  try {
    const display = new Intl.DisplayNames([intlLocale], { type: 'region' });
    names = codes.map((code) => display.of(code) ?? code);
  } catch {
    /* an engine without DisplayNames: the codes are still true */
  }
  try {
    return new Intl.ListFormat(intlLocale, { style: 'long', type: 'conjunction' }).format(names);
  } catch {
    return names.join(', ');
  }
}

/** One value, in the reader's language. Plain text - it is never HTML. */
export function formatFaqValue(value: FaqValue, t: Translate, intlLocale: string): string {
  switch (value.kind) {
    case 'number':
      return new Intl.NumberFormat(intlLocale).format(value.value);
    case 'text':
      return value.value;
    case 'date':
      return formatIsoDate(value.value, intlLocale);
    case 'money':
      return formatMoneyMinor(value.minor, value.currency);
    case 'unit':
      return t(`preorder.unit.${value.value}` as TranslationKey);
    case 'countries':
      return countryList(value.value, intlLocale);
  }
}

/** One line of an answer, as a sentence. */
export function faqLineText(line: FaqAnswerLine, t: Translate, intlLocale: string): string {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(line.values)) values[name] = formatFaqValue(value, t, intlLocale);
  return t(line.key as TranslationKey, values);
}

export function faqQuestionText(id: string, t: Translate): string {
  return (FAQ_IDS as readonly string[]).includes(id)
    ? t(`preorderChat.assistant.q.${id}` as TranslationKey)
    : t('preorderChat.assistant.q.unknown');
}
