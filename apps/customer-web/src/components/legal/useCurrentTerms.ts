/**
 * The Terms in force, in the language the page is being read in.
 *
 * Asked again when the language changes, and on `reload()` - which the
 * sign-up form calls when the server says the version it was sent is out of
 * date. The page never works out which version is current by itself.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { fetchCurrentTerms, type CurrentLegalDocument, type LegalDocumentKind } from '@/lib/legal';

export type CurrentTermsState =
  | { status: 'loading' }
  | { status: 'ready'; current: CurrentLegalDocument }
  /** `unavailable`: nothing is published, so no account can be opened here. */
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
