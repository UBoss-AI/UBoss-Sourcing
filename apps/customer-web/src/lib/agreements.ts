/**
 * The agreement screen's connection to this app: the storefront and its Seller Hub.
 *
 * The screen itself is `components/agreement-kit/`, the same files in all
 * four apps. Only this file knows the prefix this surface's agreement routes
 * live under (its own cookie jar) and how a document is linked to.
 */
import type {
  AgreementHistoryEntry,
  AgreementRole,
  AgreementScope,
  AgreementsClient,
  AgreementStatus,
} from '@/components/agreement-kit/types';
import { ApiError, BASE_URL, api, onAgreementsRequired } from './api';

const PREFIX = '/auth/agreements';

function query(scope: AgreementScope, locale: string): string {
  const params = new URLSearchParams({ locale });
  // Only the storefront has two scopes; every other surface's is fixed by the server.
  if (scope === 'BUYER' || scope === 'SELLER') params.set('scope', scope);
  return params.toString();
}

const path = (role: AgreementRole): string => `${PREFIX}/${role === 'TERMS' ? 'terms' : 'privacy'}`;

export const agreementsClient: AgreementsClient = {
  status: (scope, locale) => api.get<AgreementStatus>(`${PREFIX}?${query(scope, locale)}`),
  record: (scope, role, documentIds, locale) =>
    api.post<AgreementStatus>(path(role), {
      documentIds,
      locale,
      ...(scope === 'BUYER' || scope === 'SELLER' ? { scope } : {}),
    }),
  clear: (scope, role, locale) => api.delete<AgreementStatus>(`${path(role)}?${query(scope, locale)}`),
  history: async () => (await api.get<{ entries: AgreementHistoryEntry[] }>(`${PREFIX}/history`)).entries,
  pdfUrl: (documentId) => `${BASE_URL}/legal/documents/${encodeURIComponent(documentId)}/pdf`,
  // The storefront has a public page for every published document.
  pageUrl: (documentId) => `/legal/documents/${encodeURIComponent(documentId)}`,
  onRequired: onAgreementsRequired,
  errorCode: (error) => (error instanceof ApiError ? error.code : null),
};
