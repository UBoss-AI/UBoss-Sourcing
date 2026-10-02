/**
 * Reporting and translating a message (JOURNEY-055).
 *
 * The same two actions on every conversation a person can read: a preorder
 * chat, an RFQ thread and an order thread. The buyer's calls go to /account,
 * a seller's to /seller; the server decides whether this person may see the
 * message at all, so neither can reach somebody else's conversation.
 */
import { api } from './api';

export type MessageThreadKind = 'PREORDER_CHAT' | 'RFQ' | 'ORDER';
export type MessageAudience = 'buyer' | 'seller';

export const MESSAGE_REPORT_REASONS = ['SPAM', 'ABUSE', 'FRAUD', 'PERSONAL_DATA', 'OFF_PLATFORM', 'OTHER'] as const;
export type MessageReportReason = (typeof MESSAGE_REPORT_REASONS)[number];

export interface MessageReportReceipt {
  id: string;
  status: 'OPEN' | 'ACTIONED' | 'DISMISSED';
  createdAt: string;
}

export interface MessageTranslation {
  text: string;
  detectedLanguage: string | null;
  language: string;
}

const base = (audience: MessageAudience): string => (audience === 'seller' ? '/seller/messages' : '/account/messages');

export async function reportMessage(
  audience: MessageAudience,
  input: { threadKind: MessageThreadKind; messageId: string; reason: MessageReportReason; note: string | null },
): Promise<MessageReportReceipt> {
  return (await api.post<{ report: MessageReportReceipt }>(`${base(audience)}/reports`, input)).report;
}

export async function translateMessage(
  audience: MessageAudience,
  input: { threadKind: MessageThreadKind; messageId: string; language: string },
): Promise<MessageTranslation> {
  return api.post<MessageTranslation>(`${base(audience)}/translate`, input);
}
