/**
 * The preorder assistant's state for one product and option: the questions on
 * offer, the answers read so far, and what the screen is waiting for.
 *
 * One question at a time. A second click while an answer is on its way is
 * ignored rather than queued - two answers arriving out of order would read
 * as the assistant contradicting itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ChatContextInput } from './preorder-chat';
import {
  askAssistant,
  assistantKeys,
  clearTranscript,
  fetchAssistant,
  readTranscript,
  saveTranscript,
  TRANSCRIPT_MAX,
  type AssistantIntro,
  type FaqId,
  type TranscriptEntry,
} from './preorder-assistant';

export interface PreorderAssistantState {
  intro: AssistantIntro | undefined;
  introLoading: boolean;
  introError: unknown;
  retryIntro: () => void;
  entries: TranscriptEntry[];
  /** The question whose answer is on its way, or null. */
  asking: FaqId | null;
  askError: { faqId: FaqId; error: unknown } | null;
  /** True when the question list is showing - at the start, or after "Ask another question". */
  choosing: boolean;
  /** The customer said "Not now" to a person for the latest answer. */
  humanOfferDismissed: boolean;
  ask: (faqId: FaqId) => void;
  markHelpful: () => void;
  showQuestions: () => void;
  dismissHumanOffer: () => void;
  /** The question the customer is on: the latest one they asked. */
  topic: FaqId | null;
  /** Forget the answers - once they are in a conversation, they live there. */
  clear: () => void;
}

export function usePreorderAssistant(options: {
  context: ChatContextInput | null;
  enabled: boolean;
  signedIn: boolean;
}): PreorderAssistantState {
  const { context, enabled, signedIn } = options;
  const productId = context?.productId ?? '';
  const variantId = context?.variantId ?? null;

  const intro = useQuery({
    queryKey: context === null ? ['preorder-assistant', 'none'] : assistantKeys.intro(context, signedIn),
    queryFn: () => fetchAssistant(context as ChatContextInput),
    enabled: enabled && context !== null,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const [entries, setEntries] = useState<TranscriptEntry[]>(() =>
    context === null ? [] : readTranscript(productId, variantId),
  );
  const [choosing, setChoosing] = useState(entries.length === 0);
  const [humanOfferDismissed, setHumanOfferDismissed] = useState(false);
  const [asking, setAsking] = useState<FaqId | null>(null);
  const [askError, setAskError] = useState<{ faqId: FaqId; error: unknown } | null>(null);
  const inFlight = useRef(false);
  const contextRef = useRef(context);
  contextRef.current = context;

  // Another product or option is another transcript.
  const scope = `${productId}:${variantId ?? ''}`;
  const loadedScope = useRef(scope);
  useEffect(() => {
    if (loadedScope.current === scope) return;
    loadedScope.current = scope;
    const stored = productId === '' ? [] : readTranscript(productId, variantId);
    setEntries(stored);
    setChoosing(stored.length === 0);
    setHumanOfferDismissed(false);
    setAskError(null);
  }, [scope, productId, variantId]);

  useEffect(() => {
    if (productId === '' || loadedScope.current !== scope) return;
    if (entries.length === 0) clearTranscript(productId, variantId);
    else saveTranscript(productId, variantId, entries);
  }, [entries, productId, variantId, scope]);

  const ask = useCallback((faqId: FaqId): void => {
    const current = contextRef.current;
    if (current === null || inFlight.current) return;
    inFlight.current = true;
    setAsking(faqId);
    setAskError(null);
    askAssistant(current, faqId)
      .then((signed) => {
        setEntries((list) => [...list, { ...signed, feedback: null }].slice(-TRANSCRIPT_MAX));
        setChoosing(false);
        setHumanOfferDismissed(false);
      })
      .catch((error: unknown) => {
        setAskError({ faqId, error });
      })
      .finally(() => {
        inFlight.current = false;
        setAsking(null);
      });
  }, []);

  const markHelpful = useCallback((): void => {
    setEntries((list) =>
      list.map((entry, index) => (index === list.length - 1 ? { ...entry, feedback: 'helpful' } : entry)),
    );
  }, []);

  const clear = useCallback((): void => {
    if (productId !== '') clearTranscript(productId, variantId);
    setEntries([]);
    setChoosing(true);
  }, [productId, variantId]);

  return {
    intro: intro.data,
    introLoading: intro.isLoading,
    introError: intro.error,
    retryIntro: () => {
      void intro.refetch();
    },
    entries,
    asking,
    askError,
    choosing,
    humanOfferDismissed,
    ask,
    markHelpful,
    showQuestions: () => {
      setChoosing(true);
    },
    dismissHumanOffer: () => {
      setHumanOfferDismissed(true);
      setChoosing(true);
    },
    topic: entries.at(-1)?.answer.faqId ?? null,
    clear,
  };
}
