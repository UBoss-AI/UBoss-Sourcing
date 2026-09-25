/**
 * What, if anything, the product page should open when the quantity settles.
 *
 * ONE PLACE DECIDES
 *
 * Two dialogs can want the screen after a quantity change: the bulk-offers
 * dialog ("every price band together") and the preorder prompt ("that is more
 * than is in stock"). Deciding in two components would let both open on the
 * same change, one over the other. So the decision is here, as a pure
 * function, in this order:
 *
 *   1. An invalid quantity decides nothing. The box has already refused it.
 *   2. More than can be promised from stock -> the preorder prompt, but only
 *      on the change that crosses the stock line. 501 -> 502 -> 503 opens it
 *      once; going back to 500 or below re-arms it.
 *   3. Otherwise, a quantity INCREASE, with genuine offers on this product and
 *      version, that the buyer has not already been shown or dismissed -> the
 *      offers dialog.
 *
 * Nothing opens while another dialog is up. The page never stacks two modals.
 *
 * WHAT "ALREADY SHOWN" MEANS
 *
 * The dialog shows every band at once, so once it has been seen there is
 * nothing new to say until the set of bands itself changes - another version,
 * another currency, a business buyer signing in and seeing their own bands.
 * The set is remembered as a signature per product and version for the
 * browser session, and a dismissal (the ×, Escape, the backdrop) silences
 * automatic opening for that product and version entirely. "View all bulk
 * offers" always opens it, whatever has been remembered.
 *
 * ONLY SETTLED FIGURES COUNT
 *
 * A decision is made on the server's answer FOR THE QUANTITY THAT WAS
 * COMMITTED, never on a placeholder from the quantity before it or on a reply
 * that arrives after the buyer has moved on. `matchesCommit` is that check.
 */
export type QuantitySource =
  /** The + or − button, or an arrow key. */
  | 'step'
  /** Typed, pasted or spun with the browser's own control, then settled. */
  | 'typed'
  /** Chosen from the offers dialog. */
  | 'tier'
  /** A different version chosen; the quantity carries over. */
  | 'variant';

export interface Commit {
  quantity: number;
  previous: number;
  source: QuantitySource;
  /** Product and version the quantity belongs to. */
  scope: string;
  /** Increases with every commit, so an older answer can be recognised. */
  seq: number;
}

/** The parts of the server's answer a decision needs. */
export interface DecisionFigures {
  quantity: number;
  scope: string;
  offerSignature: string;
  offerCount: number;
  exceedsStock: boolean;
  preorderAvailable: boolean;
  stock: number;
}

export type DecisionDialog =
  | { kind: 'offers'; trigger: 'auto' | 'explicit' }
  | { kind: 'preorder'; requested: number; stock: number };

export interface DecisionMemory {
  /** Offer signatures already shown automatically, for this scope. */
  shownSignatures: readonly string[];
  /** The buyer closed the dialog without choosing: no more automatic opening. */
  offersDismissed: boolean;
  /** Whether the last settled quantity was over stock. The latch. */
  overStock: boolean;
}

export const EMPTY_MEMORY: DecisionMemory = {
  shownSignatures: [],
  offersDismissed: false,
  overStock: false,
};

/** Is this answer the one for the commit being decided? */
export function matchesCommit(commit: Commit, figures: DecisionFigures): boolean {
  return figures.scope === commit.scope && figures.quantity === commit.quantity;
}

/**
 * The decision.
 *
 * Returns the dialog to open (or null) and the memory to keep. Pure: the
 * caller owns timing, storage and the dialogs themselves.
 */
export function decide(input: {
  commit: Commit;
  figures: DecisionFigures;
  memory: DecisionMemory;
  /** Is any dialog already open on the page? */
  dialogOpen: boolean;
}): { open: DecisionDialog | null; memory: DecisionMemory } {
  const { commit, figures, memory } = input;

  // 1. Not the answer for this commit: decide nothing, remember nothing.
  if (!matchesCommit(commit, figures) || !Number.isSafeInteger(commit.quantity) || commit.quantity < 1) {
    return { open: null, memory };
  }

  // 2. Stock. The latch moves with every settled answer, open or not, so a
  //    quantity that went over while a dialog was up does not fire later.
  const crossedStock = figures.exceedsStock && !memory.overStock;
  const next: DecisionMemory = { ...memory, overStock: figures.exceedsStock };
  if (crossedStock && figures.preorderAvailable && !input.dialogOpen) {
    return { open: { kind: 'preorder', requested: commit.quantity, stock: figures.stock }, memory: next };
  }
  if (figures.exceedsStock) return { open: null, memory: next };

  // 3. Offers, on a real increase only. A tier chosen from the dialog, or a
  //    change of version, is the buyer answering the dialog, not asking again.
  const increased =
    (commit.source === 'step' || commit.source === 'typed') && commit.quantity > commit.previous;
  if (
    increased &&
    figures.offerCount > 0 &&
    !memory.offersDismissed &&
    !memory.shownSignatures.includes(figures.offerSignature) &&
    !input.dialogOpen
  ) {
    return {
      open: { kind: 'offers', trigger: 'auto' },
      memory: { ...next, shownSignatures: [...next.shownSignatures, figures.offerSignature] },
    };
  }

  return { open: null, memory: next };
}

// ---------------------------------------------------------------------------
// Session memory, per product and version
// ---------------------------------------------------------------------------

const MEMORY_PREFIX = 'uboss.quantityDecision:';

export function scopeKey(productId: string, variantId: string | null): string {
  return `${productId}:${variantId ?? '-'}`;
}

/** What has been shown or dismissed for this scope, this browser session. */
export function loadMemory(scope: string): DecisionMemory {
  try {
    const raw = window.sessionStorage.getItem(`${MEMORY_PREFIX}${scope}`);
    if (raw === null) return EMPTY_MEMORY;
    const parsed = JSON.parse(raw) as Partial<DecisionMemory>;
    return {
      shownSignatures: Array.isArray(parsed.shownSignatures)
        ? parsed.shownSignatures.filter((entry): entry is string => typeof entry === 'string')
        : [],
      offersDismissed: parsed.offersDismissed === true,
      // The stock latch is per page view, never carried: arriving on the page
      // already over stock should still be told once it is decided.
      overStock: false,
    };
  } catch {
    return EMPTY_MEMORY;
  }
}

export function saveMemory(scope: string, memory: DecisionMemory): void {
  try {
    window.sessionStorage.setItem(
      `${MEMORY_PREFIX}${scope}`,
      JSON.stringify({
        shownSignatures: memory.shownSignatures.slice(-20),
        offersDismissed: memory.offersDismissed,
      }),
    );
  } catch {
    // No storage (a private window): remembered for this page view only.
  }
}

/** The set of bands, as a string: same bands, same signature. */
export function offerSignature(
  offers: readonly { minQuantity: number; unitPrice: { minor: string; currency: string } }[],
): string {
  return offers.map((offer) => `${String(offer.minQuantity)}@${offer.unitPrice.minor}${offer.unitPrice.currency}`).join('|');
}
