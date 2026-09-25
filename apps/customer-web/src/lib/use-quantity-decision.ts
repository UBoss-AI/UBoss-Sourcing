/**
 * The product page's quantity decisions, wired to the live figures.
 *
 * `quantity-decision.ts` decides; this hook feeds it. It records each
 * committed quantity, waits for the server's answer FOR THAT QUANTITY (never a
 * placeholder, never a late reply for an older one), decides once, and holds
 * the one dialog the page may show. See that file for the rules.
 *
 * The preorder prompt it can open is drawn by `PreorderButton`, which owns the
 * preorder terms and the form; the offers dialog is drawn by the page. Both
 * read `dialog` from here, so there is only ever one.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  decide,
  loadMemory,
  offerSignature,
  saveMemory,
  scopeKey,
  type Commit,
  type DecisionDialog,
  type DecisionMemory,
  type QuantitySource,
} from './quantity-decision';
import { useBulkPricing } from './use-bulk-pricing';

/**
 * An automatic dialog waits at least this long after the commit that caused
 * it. The preorder minimum prompt, drawn elsewhere, settles in 600 ms; waiting
 * past it means the preorder side always gets the screen first when both are
 * due on the same change, as the priority order says.
 */
export const AUTO_OPEN_AFTER_MS = 700;

export function useQuantityDecision(input: {
  productId: string;
  variantId: string | null;
  pieces: number;
  displayCurrency: string | null;
  enabled: boolean;
  /** Whether a dialog this hook does not own is open (the preorder form, its note). */
  otherDialogOpen: boolean;
}) {
  const scope = scopeKey(input.productId, input.variantId);
  const { query } = useBulkPricing({
    productId: input.productId,
    variantId: input.variantId,
    pieces: input.pieces,
    displayCurrency: input.displayCurrency,
    enabled: input.enabled,
  });

  const [dialog, setDialog] = useState<DecisionDialog | null>(null);
  const memory = useRef<DecisionMemory>(loadMemory(scope));
  const memoryScope = useRef(scope);
  if (memoryScope.current !== scope) {
    memoryScope.current = scope;
    memory.current = loadMemory(scope);
  }

  const pending = useRef<(Commit & { at: number }) | null>(null);
  const seq = useRef(0);
  const otherOpen = useRef(input.otherDialogOpen);
  otherOpen.current = input.otherDialogOpen;
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  /** Bumped on every commit, so the decision effect runs even when the figures are cached. */
  const [commitTick, forceDecide] = useState(0);

  /** The buyer settled on a quantity. */
  const commit = useCallback(
    (quantity: number, source: QuantitySource, previous: number): void => {
      seq.current += 1;
      pending.current = { quantity, previous, source, scope, seq: seq.current, at: Date.now() };
      forceDecide((n) => n + 1);
    },
    [scope],
  );

  const pricing = query.data;
  const settled = pricing !== undefined && !query.isPlaceholderData && !query.isFetching;

  useEffect(() => {
    const commitNow = pending.current;
    if (commitNow === null || !settled) return undefined;
    if (!pricing.available) {
      pending.current = null;
      return undefined;
    }

    const figures = {
      quantity: pricing.quantity,
      scope,
      offerSignature: offerSignature(pricing.offers),
      offerCount: pricing.offers.length,
      exceedsStock: pricing.exceedsStock,
      preorderAvailable: pricing.preorderAvailable,
      stock: pricing.stockBaseUnits,
    };
    // Not this commit's answer yet (the settled quantity is still catching
    // up): wait for the next one.
    if (commitNow.scope !== scope || figures.quantity !== commitNow.quantity) return undefined;

    // The commit stays pending until the timer below has decided it. A
    // re-render in between (a refetch finishing, fresh figures) cancels the
    // timer and this effect schedules it again, rather than losing it.
    const wait = Math.max(0, commitNow.at + AUTO_OPEN_AFTER_MS - Date.now());
    const timer = window.setTimeout(() => {
      // Something newer was committed while waiting: that one decides.
      if (seq.current !== commitNow.seq || pending.current?.seq !== commitNow.seq) return;
      pending.current = null;
      const result = decide({
        commit: commitNow,
        figures,
        memory: memory.current,
        dialogOpen: dialogRef.current !== null || otherOpen.current,
      });
      memory.current = result.memory;
      saveMemory(scope, result.memory);
      if (result.open !== null) setDialog(result.open);
    }, wait);
    return () => {
      window.clearTimeout(timer);
    };
  }, [pricing, settled, scope, commitTick]);

  /*
   * A different version: whatever was open belongs to the old one, and the
   * quantity on the page is checked again against THIS version's stock - as a
   * 'variant' commit, which can open the stock prompt but never the offers.
   * Not on the first render: opening the page is not a change.
   */
  const piecesRef = useRef(input.pieces);
  piecesRef.current = input.pieces;
  const firstScope = useRef(true);
  useEffect(() => {
    setDialog(null);
    pending.current = null;
    if (firstScope.current) {
      firstScope.current = false;
      return;
    }
    if (piecesRef.current > 0) commit(piecesRef.current, 'variant', piecesRef.current);
  }, [scope, commit]);

  const openOffers = useCallback((): void => {
    if (otherOpen.current) return;
    setDialog({ kind: 'offers', trigger: 'explicit' });
  }, []);

  /** Closed without choosing a band: an automatic one is not shown again. */
  const dismissOffers = useCallback((): void => {
    if (dialogRef.current?.kind === 'offers' && dialogRef.current.trigger === 'auto') {
      memory.current = { ...memory.current, offersDismissed: true };
      saveMemory(scope, memory.current);
    }
    setDialog(null);
  }, [scope]);

  /** A band was chosen: close, then decide on the new quantity like any other. */
  const chooseOffer = useCallback(
    (quantity: number, previous: number): void => {
      setDialog(null);
      commit(quantity, 'tier', previous);
    },
    [commit],
  );

  const closePreorderPrompt = useCallback((): void => {
    setDialog((current) => (current?.kind === 'preorder' ? null : current));
  }, []);

  /** The settled figures say this quantity is more than stock, with preorders taken. */
  const overStockNow =
    pricing?.available === true &&
    pricing.quantity === Math.max(1, input.pieces) &&
    pricing.exceedsStock &&
    pricing.preorderAvailable;

  return {
    dialog,
    overStockNow,
    pricing: pricing?.available === true ? (pricing) : null,
    commit,
    openOffers,
    dismissOffers,
    chooseOffer,
    closePreorderPrompt,
  };
}
