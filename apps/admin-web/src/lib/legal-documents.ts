/**
 * Settings → Legal documents: the Terms and Conditions every new account
 * agrees to. Mirrors `backend/src/http/routes/legal.admin.ts`.
 *
 * The panel never decides which version is in force or what a document's hash
 * is - the server does both, and a published document never changes. The
 * preview below reads the text with the same rules as the storefront, the
 * carrier portal and the PDF, so what the operator sees is what a reader sees.
 */
import { BASE_URL, api } from './api';

export type LegalDocumentKind =
  | 'PLATFORM_TERMS'
  | 'LOGISTICS_PARTNER_TERMS'
  | 'SELLER_TERMS'
  | 'PRIVACY_POLICY'
  | 'RETURNS_POLICY'
  | 'BUYER_PROTECTION_POLICY'
  | 'INSPECTION_POLICY'
  | 'PROHIBITED_PRODUCTS'
  | 'STAFF_TERMS'
  | 'AUDIT_CONSOLE_TERMS';
/**
 * The two terms kinds are accepted at sign-up; the next six are published
 * policies, shown in the storefront's help and policies hub (Master row 9).
 * `STAFF_TERMS` and `AUDIT_CONSOLE_TERMS` are what the console's staff and
 * Audit Console users accept on the agreement screen after signing in. The
 * Privacy Policy is acknowledged there by everybody.
 */
export const LEGAL_DOCUMENT_KINDS: readonly LegalDocumentKind[] = [
  'PLATFORM_TERMS',
  'LOGISTICS_PARTNER_TERMS',
  'SELLER_TERMS',
  'PRIVACY_POLICY',
  'RETURNS_POLICY',
  'BUYER_PROTECTION_POLICY',
  'INSPECTION_POLICY',
  'PROHIBITED_PRODUCTS',
  'STAFF_TERMS',
  'AUDIT_CONSOLE_TERMS',
];

export type LegalDocumentStatus = 'DRAFT' | 'PUBLISHED';

export interface LegalDocument {
  id: string;
  kind: LegalDocumentKind;
  version: string;
  locale: string;
  title: string;
  body: string;
  changeSummary: string | null;
  effectiveAt: string;
  status: LegalDocumentStatus;
  publishedAt: string | null;
  contentSha256: string | null;
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
  /** How many people accepted it. The server never says who. */
  acceptanceCount: number;
  /** The version in force for its kind right now. */
  isCurrentVersion: boolean;
  /** Whether people who accepted an earlier version must accept this one. */
  requiresReacceptance: boolean;
}

export interface LegalDocumentDraft {
  kind: LegalDocumentKind;
  version: string;
  locale: string;
  title: string;
  body: string;
  changeSummary: string | null;
  /** ISO 8601. The server moves a past date to the moment of publishing. */
  effectiveAt: string;
  /** Off only for a correction that changes nothing anybody agreed to. */
  requiresReacceptance: boolean;
}

export const legalDocumentsApi = {
  list: async (kind?: LegalDocumentKind): Promise<LegalDocument[]> => {
    const query = kind === undefined ? '' : `?kind=${kind}`;
    return (await api.get<{ documents: LegalDocument[] }>(`/admin/legal-documents${query}`)).documents;
  },
  get: (id: string): Promise<LegalDocument> => api.get<LegalDocument>(`/admin/legal-documents/${id}`),
  create: (draft: LegalDocumentDraft): Promise<LegalDocument> =>
    api.post<LegalDocument>('/admin/legal-documents', draft),
  update: (id: string, draft: LegalDocumentDraft): Promise<LegalDocument> =>
    api.put<LegalDocument>(`/admin/legal-documents/${id}`, draft),
  remove: async (id: string): Promise<void> => {
    await api.delete<unknown>(`/admin/legal-documents/${id}`);
  },
  publish: (id: string): Promise<LegalDocument> => api.post<LegalDocument>(`/admin/legal-documents/${id}/publish`),
};

/**
 * The published document in force for a kind, as `GET /legal/current` returns
 * it. Public: the sign-in screen asks for the staff terms before anybody is
 * signed in.
 */
export interface CurrentLegalDocument {
  document: {
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
  };
  requestedLocale: string;
  /** Not published in the reader's language; `document.locale` says which it is in. */
  isFallback: boolean;
}

/**
 * The version in force now, in the reader's language where it is published.
 * Rejects with `ApiError` code `TERMS_DOCUMENT_UNAVAILABLE` when none is.
 */
export function fetchCurrentTerms(kind: LegalDocumentKind, locale: string): Promise<CurrentLegalDocument> {
  const query = new URLSearchParams({ kind, locale });
  return api.get<CurrentLegalDocument>(`/legal/current?${query.toString()}`, { retryOnUnauthorised: false });
}

/** The public PDF of a published document - the same file a customer downloads. */
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
 * nothing else means anything. Rendered as React text, never as HTML.
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
