/**
 * The terms a carrier's staff agree to, as the server publishes them.
 *
 * This file never decides which terms are current - the server does, in
 * `GET /legal/current`. The activation form shows what it is given and sends
 * back the document's id; everything else about the agreement is read off the
 * stored document on the server. The routes are the marketplace's public
 * ones, not under `/logistics`: the terms are the same wherever they are read.
 *
 * A copy of `apps/customer-web/src/lib/legal.ts`, trimmed to what the portal
 * uses. The body format must stay the same as the backend's
 * `domain/legal-document.ts`.
 */
import { BASE_URL, api } from './api';

export type LegalDocumentKind = 'PLATFORM_TERMS' | 'LOGISTICS_PARTNER_TERMS';

export interface LegalDocument {
  id: string;
  kind: LegalDocumentKind;
  version: string;
  locale: string;
  title: string;
  body: string;
  changeSummary: string | null;
  effectiveAt: string;
  publishedAt: string;
  contentSha256: string;
}

export interface CurrentLegalDocument {
  document: LegalDocument;
  requestedLocale: string;
  /** The Terms are not published in the reader's language; `document.locale` says which they are in. */
  isFallback: boolean;
}

export function fetchCurrentTerms(
  kind: LegalDocumentKind,
  locale: string,
): Promise<CurrentLegalDocument> {
  const query = new URLSearchParams({ kind, locale });
  return api.get<CurrentLegalDocument>(`/legal/current?${query.toString()}`);
}

/** The PDF of a published document. A plain link: it needs no session. */
export function legalDocumentPdfUrl(id: string): string {
  return `${BASE_URL}/legal/documents/${encodeURIComponent(id)}/pdf`;
}

export type LegalBlock =
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[] };

/**
 * Plain text into blocks - the same reading as `backend/src/domain/legal-document.ts`.
 *
 * `## ` a heading, `- ` or `* ` a bullet, a blank line ends a paragraph, and
 * nothing else means anything. Rendered as React text, so stored text can
 * never become markup here.
 */
export function parseLegalBody(body: string): LegalBlock[] {
  const blocks: LegalBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };
  const flushList = (): void => {
    if (list !== null && list.length > 0) blocks.push({ type: 'list', items: list });
    list = null;
  };

  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line === '') {
      flushParagraph();
      flushList();
    } else if (line.startsWith('## ')) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'heading', text: line.slice(3).trim() });
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      flushParagraph();
      list ??= [];
      list.push(line.slice(2).trim());
    } else if (list !== null) {
      list[list.length - 1] = `${list[list.length - 1] ?? ''} ${line}`;
    } else {
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}
