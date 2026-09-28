/**
 * The Terms and Conditions, as the server publishes them.
 *
 * This file never decides which Terms are current - the server does, in
 * `GET /legal/current`. The sign-up form shows what it is given and sends back
 * the document's id; everything else about the agreement is read off the
 * stored document on the server.
 */
import { LANGUAGES } from '@/i18n/languages';
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

export interface PublishedVersion {
  id: string;
  version: string;
  locale: string;
  title: string;
  effectiveAt: string;
  isCurrent: boolean;
}

export function fetchCurrentTerms(kind: LegalDocumentKind, locale: string): Promise<CurrentLegalDocument> {
  const query = new URLSearchParams({ kind, locale });
  return api.get<CurrentLegalDocument>(`/legal/current?${query.toString()}`);
}

export function fetchLegalDocument(id: string): Promise<LegalDocument> {
  return api.get<LegalDocument>(`/legal/documents/${encodeURIComponent(id)}`);
}

export async function fetchPublishedVersions(kind: LegalDocumentKind): Promise<PublishedVersion[]> {
  const query = new URLSearchParams({ kind });
  return (await api.get<{ versions: PublishedVersion[] }>(`/legal/versions?${query.toString()}`)).versions;
}

/** The PDF of a published document. A plain link: it needs no session. */
export function legalDocumentPdfUrl(id: string): string {
  return `${BASE_URL}/legal/documents/${encodeURIComponent(id)}/pdf`;
}

/** A language's own name for itself, for saying which language a document is in. */
export function languageEndonym(code: string): string {
  return LANGUAGES.find((language) => language.code === code)?.endonym ?? code.toUpperCase();
}

/** Where the full text of one document can be read, printed and linked to. */
export function legalDocumentPath(id: string): string {
  return `/legal/documents/${encodeURIComponent(id)}`;
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
