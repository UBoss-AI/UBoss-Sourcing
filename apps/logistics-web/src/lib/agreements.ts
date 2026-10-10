/**
 * The agreement screen's connection to this app: the carrier portal.
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
  CurrentAgreementDocument,
} from '@/components/agreement-kit/types';
import { flushSignInAgreements } from '@/components/agreement-kit/sign-in-agreements';
import { ApiError, BASE_URL, api, onAgreementsRequired } from './api';

const PREFIX = '/logistics/auth/agreements';

function query(scope: AgreementScope, locale: string): string {
  const params = new URLSearchParams({ locale });
  // Only the storefront has two scopes; every other surface's is fixed by the server.
  if (scope === 'BUYER' || scope === 'SELLER') params.set('scope', scope);
  return params.toString();
}

const path = (role: AgreementRole): string => `${PREFIX}/${role === 'TERMS' ? 'terms' : role === 'SERVICES' ? 'services' : 'privacy'}`;

export const agreementsClient: AgreementsClient = {
  status: async (scope, locale) => {
    // What was ticked on the sign-in form is recorded first, so the answer includes it.
    await flushSignInAgreements(scope, (role, documentIds) => agreementsClient.record(scope, role, documentIds, locale));
    return api.get<AgreementStatus>(`${PREFIX}?${query(scope, locale)}`);
  },
  record: (scope, role, documentIds, locale) =>
    api.post<AgreementStatus>(path(role), {
      documentIds,
      locale,
      ...(scope === 'BUYER' || scope === 'SELLER' ? { scope } : {}),
    }),
  clear: (scope, role, locale) => api.delete<AgreementStatus>(`${path(role)}?${query(scope, locale)}`),
  history: async () => (await api.get<{ entries: AgreementHistoryEntry[] }>(`${PREFIX}/history`)).entries,
  currentDocument: (kind, locale) =>
    api.get<CurrentAgreementDocument>(`/legal/current?${new URLSearchParams({ kind, locale }).toString()}`),
  pdfUrl: (documentId) => `${BASE_URL}/legal/documents/${encodeURIComponent(documentId)}/pdf`,
  // No public document page in this app: the PDF is the copy to keep.
  pageUrl: () => null,
  onRequired: onAgreementsRequired,
  errorCode: (error) => (error instanceof ApiError ? error.code : null),
};
