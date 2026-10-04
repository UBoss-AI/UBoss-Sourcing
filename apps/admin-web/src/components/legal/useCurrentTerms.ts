/**
 * The staff terms in force, in the language the sign-in screen is read in.
 *
 * A copy of the storefront's hook (`apps/customer-web/src/components/legal/`),
 * pointed at this console's API client. Asked again when the language changes.
 * The page never works out which version is current by itself - the server
 * does, in `GET /legal/current`.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { fetchCurrentTerms, type CurrentLegalDocument, type LegalDocumentKind } from '@/lib/legal-documents';

export type CurrentTermsState =
  | { status: 'loading' }
  | { status: 'ready'; current: CurrentLegalDocument }
  /** `unavailable`: nothing of this kind is published. */
  | { status: 'unavailable' }
  | { status: 'error'; error: unknown };

export interface CurrentTerms {
  state: CurrentTermsState;
  reload: () => void;
}

export function useCurrentTerms(kind: LegalDocumentKind, locale: string): CurrentTerms {
  const [state, setState] = useState<CurrentTermsState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }));

    fetchCurrentTerms(kind, locale).then(
      (current) => {
        if (!cancelled) setState({ status: 'ready', current });
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.code === 'TERMS_DOCUMENT_UNAVAILABLE') {
          setState({ status: 'unavailable' });
        } else {
          setState({ status: 'error', error });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [kind, locale, attempt]);

  const reload = useCallback((): void => {
    setAttempt((value) => value + 1);
  }, []);

  return { state, reload };
}
