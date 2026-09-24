/**
 * The cart.
 *
 * The rule this page is built around: **the server owns the cart.** Every
 * mutation returns the whole cart, and that response replaces what is on
 * screen. There is no local total, no local stock check and no optimistic line
 * edit that survives the answer — because the moment the two disagree, the one
 * the customer is looking at is the wrong one.
 *
 * What that buys, concretely:
 *
 *   - A product unpublished while it sat in the cart appears as a line with an
 *     issue, explained in the server's own words, with the correction offered.
 *   - A price that changed shows the new price, because the response carries
 *     it. Nothing here remembers the old one to "helpfully" keep showing.
 *   - `checkoutReady` decides whether checkout is offered. Not a count of
 *     issues computed here, which would drift the first time a new issue code
 *     appeared.
 *
 * Double-click protection is per line: an in-flight change disables that
 * line's controls, so a customer hammering "+" queues one change, not six.
 *
 * The one number this file *derives* is whether the tax figure is already
 * inside the subtotal, and it derives it from `line.taxInclusive` — a flag the
 * server sends — purely to label the row. On an inclusive cart the column does
 * not add up unless somebody says so, and "somebody" was previously nobody.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { useLocale } from '@/app/locale-context';
import { useToast } from '@/components/toast-context';
import { AutoPaySetupDialog } from '@/components/AutoPaySetupDialog';
import { QuantityInput } from '@/components/QuantityInput';
import { PackagingBreakdown } from '@/components/catalog/PackagingBreakdown';
import { CouponPanel } from '@/components/CouponPanel';
import { DeliveryOptionsPanel } from '@/components/DeliveryOptionsPanel';
import { CheckoutSteps } from '@/components/CheckoutSteps';
import { CartModeTabs } from '@/components/CartModeTabs';
import { CART_STEPS } from '@/lib/checkout-steps';
import { StickyBottomBar } from '@/components/StickyBottomBar';
import { GrandTotalRow, TotalRow } from '@/components/Totals';
import { DeliveryBreakdown } from '@/components/DeliveryBreakdown';
import { PageEmptyState } from '@/components/PageEmptyState';
import { AlertIcon, TrashIcon } from '@/components/icons';
import { clampToRules } from '@/lib/quantity-rules';
import { MAX_LINE_NOTE_CHARS, noteForWire } from '@/lib/line-note';
import { Badge, Button, ButtonLink, ErrorState, Field, LoadingState, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { autoPayApi, autoPayKeys } from '@/lib/autopay';
import { formatMoney, formatMoneyMinor, formatNumber } from '@/lib/format';
import { formatBasisPoints } from '@/lib/bulk-pricing';
import { cartonPriceMinor, lineIsSoldByThePiece } from '@/lib/packaging';
import { useI18n } from '@/i18n/i18n-context';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { Cart, CartIssue, CartLine, PurchaseRules } from '@/lib/types';
import { errorMessage } from '@/lib/errors';

/** The cart's rules, widened back to what the quantity control expects. */
function toPurchaseRules(line: CartLine): PurchaseRules {
  /*
   * A seller's line is stepped by the SELLER's terms, not the operator's.
   *
   * `line.purchaseRules` is the PRODUCT row's minimum and increment, written in
   * pieces by whoever catalogued the product. On a product a third-party
   * seller described, that is a figure the seller never agreed to - and the
   * server does not apply it to their line either, so a stepper that used it
   * would refuse quantities the basket would happily accept, or offer ones it
   * would silently round.
   *
   * The offer's own terms arrive on `line.ordering` for exactly this.
   */
  const ordering = line.ordering ?? null;

  if (ordering !== null && lineIsSoldByThePiece(ordering)) {
    return {
      minOrderQty: ordering.minimumOrderQuantity ?? 1,
      maxOrderQty: ordering.maximumOrderQuantity ?? null,
      qtyIncrement: ordering.orderIncrement ?? 1,
      isRecurringEligible: line.isRecurringEligible,
    };
  }

  return {
    ...line.purchaseRules,
    isRecurringEligible: line.isRecurringEligible,
  };
}

/**
 * An issue, shown in the server's own words.
 *
 * The code decides the tone and whether a correction can be offered; the
 * message is never rewritten here. The server knows the rule — this page would
 * only paraphrase it, and eventually paraphrase it wrongly.
 */
function IssueNotice({
  issue,
  onCorrect,
  correctionLabel,
}: {
  issue: CartIssue;
  onCorrect?: () => void;
  correctionLabel?: string;
}): React.JSX.Element {
  // Three tones, because three different things are being said: this item
  // cannot be bought at all, this needs a correction, or this simply changed.
  const isFatal = issue.code === 'CART_ITEM_UNAVAILABLE';
  const isNotice = issue.code === 'CART_PRICE_CHANGED';

  return (
    <div
      role="alert"
      className={`mt-3 flex gap-2.5 rounded-md border px-3 py-2.5 text-xs ${
        isFatal
          ? 'border-danger/30 bg-danger-soft text-danger'
          : isNotice
            ? 'border-brand/30 bg-brand-soft text-brand'
            : 'border-warning/30 bg-warning-soft text-warning'
      }`}
    >
      {/* The glyph is the second signal. A tinted panel alone is a colour, and
          a colour alone is not a message. */}
      <AlertIcon className="mt-px h-4 w-4 shrink-0" />

      <div className="min-w-0">
        <p className="font-medium">{issue.message}</p>

        {onCorrect !== undefined && correctionLabel !== undefined && (
          <button
            type="button"
            onClick={onCorrect}
            className="mt-1.5 font-semibold text-ink underline underline-offset-2 hover:no-underline"
          >
            {correctionLabel}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The cartons this line is counted in, or null where it is counted in pieces.
 *
 * Null is the answer only for a line put in a basket before this shop settled
 * on the carton, and it is what keeps the ordinary quantity stepper working
 * for one. Nothing new is ever added that way.
 */
function cartonsOf(
  line: CartLine,
  t: ReturnType<typeof useI18n>['t'],
): { unitQuantity: number; piecesPerUnit: number; label: string } | null {
  const ordering = line.ordering ?? null;
  if (ordering === null || ordering.unit === 'PIECE') return null;

  return {
    unitQuantity: ordering.unitQuantity,
    piecesPerUnit: Math.max(ordering.piecesPerUnit, 1),
    label: t('packaging.outerCarton'),
  };
}

/**
 * The special instruction on one line, shown and edited in place.
 *
 * ## Why it is collapsed until it is wanted
 *
 * Most lines have no instruction and never will. An always-open textarea on
 * every row would make a basket of nine lines nine textareas tall, and a
 * control that is empty on eight rows out of nine is noise on all nine. So a
 * line with nothing on it offers a quiet link; a line WITH something on it
 * shows the words, because an instruction the buyer cannot see on the basket
 * is one they cannot check before they agree to the order.
 *
 * ## Why the draft is local and the saved value is not
 *
 * The box holds a draft. Nothing is sent while somebody is typing — a save per
 * keystroke would be a request per keystroke against a route that reprices the
 * whole basket — and nothing is saved by wandering off, which would be a
 * silent write nobody asked for. Save sends it, Cancel throws the draft away
 * and puts the stored value back.
 *
 * A failed save leaves the box exactly as it is, with the words still in it.
 * That is the whole reason the draft is separate from the line: the
 * alternative is a paragraph somebody typed disappearing because a request
 * timed out.
 */
function LineNote({
  line,
  isBusy,
  onSave,
}: {
  line: CartLine;
  isBusy: boolean;
  onSave: (note: string | null) => void;
}): React.JSX.Element {
  const { t } = useI18n();

  const stored = line.note ?? null;

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(stored ?? '');

  const open = (): void => {
    // Opened from the stored value rather than from whatever was last typed
    // and abandoned: reopening the box has to show what is actually saved.
    setDraft(stored ?? '');
    setIsEditing(true);
  };

  if (!isEditing) {
    return (
      <div className="mt-2.5">
        {stored === null ? (
          <Button size="sm" variant="ghost" onClick={open} disabled={isBusy}>
            {t('cart.addInstructions')}
          </Button>
        ) : (
          <div className="rounded-md border border-border-subtle bg-surface-sunken px-3 py-2">
            <p className="text-xxs font-medium uppercase tracking-wide text-ink-subtle">
              {t('cart.specialInstructions')}
            </p>
            {/* `whitespace-pre-line`: somebody who typed three lines meant
                three lines, and a picking instruction run together into one
                paragraph is one a packer misreads. */}
            <p className="mt-0.5 whitespace-pre-line text-sm leading-relaxed text-ink">{stored}</p>
            <Button size="sm" variant="ghost" onClick={open} disabled={isBusy} className="mt-1">
              {t('cart.editInstructions')}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2.5">
      <Field label={t('cart.specialInstructions')}>
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            value={draft}
            rows={2}
            maxLength={MAX_LINE_NOTE_CHARS}
            disabled={isBusy}
            className="min-h-[4.5rem]"
            onChange={(event) => {
              const { value } = event.currentTarget;
              setDraft(value);
            }}
          />
        )}
      </Field>

      <div className="mt-1.5 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={isBusy}
          onClick={() => {
            onSave(noteForWire(draft));
            setIsEditing(false);
          }}
        >
          {t('cart.saveInstructions')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={isBusy}
          onClick={() => {
            setIsEditing(false);
          }}
        >
          {t('common.cancel')}
        </Button>
        {stored !== null && (
          <Button
            size="sm"
            variant="ghost"
            disabled={isBusy}
            className="hover:bg-danger-soft hover:text-danger"
            onClick={() => {
              // `null`, not `''`. The route reads null as "clear it" and the
              // service turns it into a NULL column, so "no instruction" has
              // one representation rather than two.
              onSave(null);
              setIsEditing(false);
            }}
          >
            {t('cart.clearInstructions')}
          </Button>
        )}
      </div>
    </div>
  );
}

function LineRow({
  line,
  onQuantityChange,
  onPackQuantityChange,
  onNoteChange,
  onRemove,
  isBusy,
}: {
  line: CartLine;
  onQuantityChange: (quantity: number) => void;
  onPackQuantityChange: (unitQuantity: number) => void;
  onNoteChange: (note: string | null) => void;
  onRemove: () => void;
  isBusy: boolean;
}): React.JSX.Element {
  const { t, intlLocale } = useI18n();

  const rules = toPurchaseRules(line);
  const available = typeof line.availableQty === 'number' ? line.availableQty : null;
  const packs = cartonsOf(line, t);

  // Read off the LINE's own snapshot, so a basket agreed in cartons keeps
  // reading in cartons whatever the product is sold as today.
  const soldByThePiece = lineIsSoldByThePiece(line.ordering ?? null);

  /**
   * What one carton of this line costs.
   *
   * `line.unitPrice` is the price of a piece, which is what the server prices
   * and totals in. A basket that printed it beside a carton count would be
   * showing a figure five hundred times smaller than the line total next to
   * it. The factor is the line's OWN snapshot, so a basket agreed before the
   * carton was re-specified still adds up.
   */
  const cartonPrice =
    packs === null
      ? null
      : formatMoneyMinor(
          cartonPriceMinor(line.unitPrice.minor, packs.piecesPerUnit),
          line.unitPrice.currency,
        );

  /**
   * The one-click correction for an issue, when there is an obvious one.
   *
   * The backend accepts an add that breaks a quantity rule and flags the line
   * rather than refusing it, so the customer keeps what they did. That is only
   * an improvement if fixing it is one click rather than arithmetic they have
   * to do themselves.
   *
   * Returns null when nothing sensible can be offered — an unavailable product
   * cannot be corrected by changing a number.
   */
  const correctionFor = (code: string): { label: string; quantity: number } | null => {
    if (code === 'INSUFFICIENT_STOCK') {
      // Only worth offering when the available amount is itself a legal
      // quantity; otherwise the "fix" produces a different violation.
      if (available === null || available < rules.minOrderQty) return null;
      const target = clampToRules(available, rules);
      if (target > available) return null;
      return { label: t('cart.reduceTo', { quantity: formatNumber(target) }), quantity: target };
    }

    if (code === 'QUANTITY_BELOW_MINIMUM' || code === 'QUANTITY_INCREMENT_INVALID') {
      const target = clampToRules(line.quantity, rules);
      if (target === line.quantity) return null;
      return { label: t('cart.changeTo', { quantity: formatNumber(target) }), quantity: target };
    }

    if (code === 'QUANTITY_ABOVE_MAXIMUM' && rules.maxOrderQty !== null) {
      const target = clampToRules(rules.maxOrderQty, rules);
      return { label: t('cart.reduceTo', { quantity: formatNumber(target) }), quantity: target };
    }

    return null;
  };

  return (
    <li
      className={`flex gap-4 py-6 transition-opacity first:pt-5 last:pb-5 sm:gap-5 ${
        isBusy ? 'opacity-60' : ''
      }`}
    >
      {/*
       * The image is the line's anchor, so it is the largest thing in the row
       * and it is a link — a customer checking "is this the right bolt?" goes
       * back to the product, and the picture is what they reach for.
       */}
      <Link
        to={`/product/${line.slug}`}
        className="group shrink-0"
        aria-label={t('cart.viewProduct', { product: line.name })}
      >
        {line.imageUrl === null ? (
          <span
            aria-hidden="true"
            className="block h-14 w-14 rounded-lg border border-border bg-surface-sunken min-[380px]:h-20 min-[380px]:w-20 sm:h-24 sm:w-24"
          />
        ) : (
          <img
            src={line.imageUrl}
            alt=""
            width={96}
            height={96}
            loading="lazy"
            className="h-14 w-14 rounded-lg border border-border bg-surface object-contain p-2 transition-colors group-hover:border-border-hover min-[380px]:h-20 min-[380px]:w-20 sm:h-24 sm:w-24"
          />
        )}
      </Link>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            {/* One step up from the body text around it. The product name is
                the thing being scanned down the column; at 14px regular it was
                the same weight as its own SKU. */}
            <h3 className="text-title-xs text-ink">
              <Link to={`/product/${line.slug}`} className="hover:text-brand hover:underline">
                {line.name}
              </Link>
            </h3>

            {/* The option, in the same weight as the price beside it rather
                than as another grey footnote. A cart can now hold the 3 ml and
                the 5 ml of one product as two lines, and those two lines carry
                the same name and the same photograph — this is the only thing
                on the row that says which is which, so it cannot be the
                quietest thing on it. */}
            {line.variantName !== null && (
              <p className="mt-1 text-sm font-medium text-ink-muted">{line.variantName}</p>
            )}

            <p className="mt-1 font-mono text-xxs text-ink-subtle">{line.sku}</p>

            {/*
             * The bulk breakdown, on the line it belongs to.
             *
             * A basket row reading "2,400" beside a five-figure total is a
             * number the buyer has to take on trust. The breakdown is what
             * makes it checkable - and it is read off the line's own frozen
             * snapshot, so it keeps describing the pallet that was actually
             * bought after the seller re-specifies theirs.
             *
             * Absent on every ordinary line, which is most of them.
             */}
            {line.packaging != null && (
              <PackagingBreakdown packaging={line.packaging} className="mt-2" />
            )}
          </div>

          <p className="shrink-0 text-right">
            <span className="block text-title-sm tabular text-ink">
              {formatMoney(line.lineTotal)}
            </span>
            <span className="mt-0.5 block text-xxs text-ink-muted">
              {/* Three cases, and the middle one is the new one. A carton line
                  quotes the carton; a seller's line quotes the piece, which is
                  what its price already is; and a line from before either says
                  "each", which is all that can honestly be said about it.

                  The English "each" was previously hardcoded here and reached
                  every seller line - untranslated, on the one row where the
                  basis most needed saying. */}
              {cartonPrice !== null
                ? t('cart.perCarton', { price: cartonPrice })
                : soldByThePiece
                  ? t('cart.perPiece', { price: formatMoney(line.unitPrice) })
                  : t('cart.eachPrice', { price: formatMoney(line.unitPrice) })}
              {line.taxInclusive
                ? ` ${t('cart.taxIncludedNote')}`
                : ` ${t('cart.plusTaxRate', { rate: line.taxRatePercent })}`}
            </span>
            {/* The seller's quantity band: what this quantity saves, and what
                a few more would. Both figures are the server's, from the same
                function that priced the line. */}
            {line.quantityTier != null && (
              <span className="mt-0.5 block text-xxs font-medium text-success">
                {t('cart.bandApplied', {
                  list: formatMoney(line.quantityTier.listUnitPrice),
                  percent: formatBasisPoints(line.quantityTier.savingBasisPoints, intlLocale),
                })}
              </span>
            )}
            {line.nextQuantityTier != null && (
              <span className="mt-0.5 block text-xxs text-ink-muted">
                {t('cart.bandNext', {
                  more: formatNumber(line.nextQuantityTier.addQuantity),
                  price: formatMoney(line.nextQuantityTier.unitPrice),
                })}
              </span>
            )}
          </p>
        </div>

        {/*
         * No per-line "Repeat purchase available" badge.
         *
         * It carried information while an administrator opted products in one
         * at a time. Now that everything a customer can buy can also be
         * scheduled, it appeared on every line of every cart — and a badge on
         * everything is a badge that says nothing, competing for attention
         * with the issue notices below it, which do need to be seen.
         *
         * The capability is still offered, once, where it can be acted on: the
         * "Need this again?" panel beside the summary. `line.isRecurringEligible`
         * is still read — that panel counts it.
         */}
        <div className="mt-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          {/* Counted the way the customer chose to count it.

              A line added as "2 cartons" is stepped in cartons, not in the
              four thousand pieces it works out to — stepping that by one would
              be a control nobody could use. The piece figure is printed
              underneath, because it is what the price, the stock check and the
              delivery note are all in, and hiding it is how "2" comes to mean
              two different things to the buyer and the warehouse.

              The conversion comes off the line's own snapshot, so it is the one
              the basket was agreed at even if the packing has been corrected
              since. The server re-derives the pieces from the same snapshot. */}
          {packs === null ? (
            <div>
              <QuantityInput
                value={line.quantity}
                onChange={onQuantityChange}
                rules={rules}
                label={t('cart.quantity')}
                disabled={isBusy}
                // Two lines of one product mean two steppers a screen reader
                // would otherwise hear as "Increase quantity by 5" twice over.
                itemName={line.variantName ?? line.name}
              />
              {/* What the number above counts, said once, so a basket holding
                  the operator's cartons beside a seller's pieces does not
                  leave the shopper converting between two unlabelled columns. */}
              {soldByThePiece && (
                <p className="mt-1 text-xxs tabular text-ink-subtle">
                  {t('packaging.soldByThePiece')}
                  {rules.minOrderQty > 1 &&
                    ` · ${t('packaging.minimumNPieces', { n: formatNumber(rules.minOrderQty) })}`}
                  {rules.qtyIncrement > 1 &&
                    ` · ${t('packaging.inMultiplesOfNPieces', { n: formatNumber(rules.qtyIncrement) })}`}
                </p>
              )}
            </div>
          ) : (
            <div>
              <QuantityInput
                value={packs.unitQuantity}
                onChange={onPackQuantityChange}
                // A carton count has no minimum or increment of its own: those
                // rules are written in pieces and the server applies them to
                // the piece total. Passing them here would step the carton
                // count by the product's piece increment.
                rules={{
                  minOrderQty: 1,
                  maxOrderQty: null,
                  qtyIncrement: 1,
                  isRecurringEligible: line.isRecurringEligible,
                }}
                label={packs.label}
                disabled={isBusy}
                itemName={line.variantName ?? line.name}
              />
              <p className="mt-1 text-xxs tabular text-ink-subtle">
                {t('packaging.oneCartonHas', { n: formatNumber(packs.piecesPerUnit) })}
                {' · '}
                {t('cart.piecesTotal', { n: formatNumber(line.quantity) })}
              </p>
            </div>
          )}

          {/*
           * Remove is deliberately visible rather than revealed on hover —
           * there is no hover on a phone, and a control that only exists for
           * mouse users is a control half the customers do not have. It stays
           * quiet until approached, and turns red then: destructive, but not
           * shouting from across the row.
           */}
          <Button
            size="sm"
            variant="ghost"
            disabled={isBusy}
            onClick={onRemove}
            className="hover:bg-danger-soft hover:text-danger"
          >
            <TrashIcon className="h-4 w-4" />
            {t('cart.remove')}
            <span className="sr-only">
              {' '}
              {line.variantName === null ? line.name : `${line.name} ${line.variantName}`} from
              your cart
            </span>
          </Button>
        </div>

        {/* Under the line it belongs to and above its problems, because a
            problem is something to fix now and an instruction is something
            that travels with the order. */}
        <LineNote line={line} isBusy={isBusy} onSave={onNoteChange} />

        {line.issues.map((issue) => {
          const correction = correctionFor(issue.code);

          return (
            <IssueNotice
              key={`${issue.code}:${issue.message}`}
              issue={issue}
              {...(correction === null
                ? {}
                : {
                    correctionLabel: correction.label,
                    onCorrect: () => {
                      onQuantityChange(correction.quantity);
                    },
                  })}
            />
          );
        })}
      </div>
    </li>
  );
}

/**
 * The other thing that can be done with this cart.
 *
 * A customer who has just added a case of flush syringes is at the exact
 * moment they would think "I need these every week", and until now the only
 * place that thought could be acted on was a product badge and a page in the
 * account section. This puts the schedule next to Checkout, where the decision
 * is actually being made.
 *
 * The auto-pay half is here for the same reason. `/schedules/new` offers
 * "Autopay" as a radio button, but choosing it there is only
 * useful once a card is authorised — so the state of that authority is worth
 * knowing *before* the builder, not after.
 *
 * It is now actionable rather than only readable, and the button says which of
 * three things will happen, because they are genuinely different:
 *
 *   no card       — "Set up a card" — enrolment, then the consent step. This
 *                   is the order the two have to happen in: there is nothing
 *                   to consent about until a card exists.
 *   card, off     — "Turn on automatic payment" — the consent step alone.
 *   paused        — "Resume" — consent is already on record, so this is one
 *                   call and no new agreement.
 *
 * What it does NOT do is enable anything from this panel directly. Both the
 * card and the consent are collected in a dialog with the wording in front of
 * the customer; a cart button that quietly authorised off-session charges
 * would be the one thing this whole path must not be.
 *
 * Both halves fail quietly. `available: false` means the store does not offer
 * auto-pay at all, and a failed or still-loading read simply omits the block —
 * a cart must not lose its checkout button because an account endpoint
 * hiccoughed.
 */
function RepeatPurchasePanel({ eligibleCount }: { eligibleCount: number }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [isSettingUp, setIsSettingUp] = useState(false);

  const query = useQuery({
    queryKey: autoPayKeys.settings,
    queryFn: () => autoPayApi.get(),
    // Nothing on this page changes it except the dialog below, which
    // invalidates the key itself.
    staleTime: 60_000,
    retry: false,
  });

  const autoPay = query.data?.available === true ? query.data.autoPay : null;

  const resume = useMutation({
    mutationFn: () => autoPayApi.setPaused(false),
    onSuccess: () => {
      toast.success(t('autopay.resumed'));
      void queryClient.invalidateQueries({ queryKey: autoPayKeys.settings });
    },
    onError: (error) => {
      toast.error(errorMessage(t, error, t('autopay.couldNotBeSwitchedOn')));
    },
  });

  return (
    <div className="mt-4 rounded-lg border border-border bg-surface p-5 shadow-card">
      <h2 className="text-title-sm text-ink">{t('cart.repeatHeading')}</h2>

      <p className="mt-1.5 text-xs text-ink-muted">
        {t('cart.repeatEligibleCount', { count: eligibleCount })}
      </p>

      {autoPay !== null && (
        <div className="mt-4 rounded-md bg-surface-sunken px-3 py-2.5">
          <p className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink">{t('cart.autoPayLabel')}</span>
            <Badge
              tone={
                autoPay.status === 'ACTIVE'
                  ? 'success'
                  : autoPay.status === 'PAUSED'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {t(`autopay.state.${autoPay.status}` as 'autopay.state.ACTIVE')}
            </Badge>
          </p>

          <p className="mt-1 text-xxs text-ink-muted">
            {autoPay.status === 'ACTIVE'
              ? autoPay.paymentMethodLabel === null
                ? t('cart.autoPayOnHintNoCard')
                : t('cart.autoPayOnHint', { card: autoPay.paymentMethodLabel })
              : autoPay.status === 'PAUSED'
                ? t('cart.autoPayPausedHint')
                : t('cart.autoPayOffHint')}
          </p>

          {/*
           * One control per state, and never two.
           *
           * ACTIVE has nothing to switch on, so it gets the management link it
           * always had — changing a limit or withdrawing consent belongs on
           * the page that explains both.
           */}
          {autoPay.status === 'ACTIVE' ? (
            <Link
              to="/account/autopay"
              className="mt-1.5 inline-block text-xxs font-semibold text-brand underline underline-offset-2 hover:no-underline"
            >
              {t('cart.autoPayManage')}
            </Link>
          ) : autoPay.status === 'PAUSED' ? (
            <Button
              size="sm"
              variant="primary"
              fullWidth
              className="mt-2.5"
              isLoading={resume.isPending}
              onClick={() => {
                resume.mutate();
              }}
            >
              {t('cart.autoPayResume')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              fullWidth
              className="mt-2.5"
              onClick={() => {
                setIsSettingUp(true);
              }}
            >
              {/* The label names the FIRST step, not the destination. A
                  customer with no card who is promised "turn on automatic
                  payment" and handed a card form has been surprised; one
                  offered "set up a card for automatic payment" has not. */}
              {autoPay.paymentMethodUsable
                ? t('cart.autoPayTurnOn')
                : t('cart.autoPaySetUpCard')}
            </Button>
          )}
        </div>
      )}

      {/* Blue, not orange: the orange belongs to Add to Cart, Checkout and
          Place Order. This is a second road, not a louder version of the
          first one. */}
      <ButtonLink to="/schedules/new" variant="primary" fullWidth className="mt-4">
        {t('cart.repeatSetUp')}
      </ButtonLink>

      {isSettingUp && (
        <AutoPaySetupDialog
          onClose={() => {
            setIsSettingUp(false);
          }}
          onEnabled={() => {
            toast.success(t('autopay.enabled'));
          }}
        />
      )}
    </div>
  );
}

export function CartPage(): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { business } = useStorefront();
  // The shopper's market, which is the destination the delivery options are
  // measured to. Null until they have answered the country question, and the
  // panel has a state that says so rather than guessing one.
  const locale = useLocale();

  // Which line is mid-change. Scoped per line so editing one does not freeze
  // the whole cart.
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useDocumentMeta({ title: t('cart.pageTitle'), noIndex: true }, business.displayName);

  const query = useQuery({
    queryKey: ['cart'],
    queryFn: () => api.get<{ cart: Cart }>('/cart'),
  });

  /** Every mutation returns the whole cart; that response becomes the truth. */
  const applyCart = (result: { cart: Cart }): void => {
    queryClient.setQueryData(['cart'], result);
    setActionError(null);
  };

  const updateQuantity = useMutation({
    mutationFn: ({ itemId, quantity }: { itemId: string; quantity: number }) =>
      api.patch<{ cart: Cart }>(`/cart/items/${itemId}`, { quantity }),
    onMutate: ({ itemId }) => {
      setBusyItemId(itemId);
    },
    onSuccess: applyCart,
    onError: (error) => {
      setActionError(errorMessage(t, error, t('cart.changeNotSaved')));
      // The local view may now disagree with the server, so re-read rather
      // than leaving a quantity on screen that was never accepted.
      void queryClient.invalidateQueries({ queryKey: ['cart'] });
    },
    onSettled: () => {
      setBusyItemId(null);
    },
  });

  /**
   * The same line, counted in packs.
   *
   * Its own endpoint rather than a flag on the one above: that route states
   * pieces and derives packs, this one states packs and derives pieces, and an
   * endpoint that accepted both would have to decide which to believe when a
   * client sent a pair that does not multiply out.
   */
  const updatePackQuantity = useMutation({
    mutationFn: ({ itemId, unitQuantity }: { itemId: string; unitQuantity: number }) =>
      api.patch<{ cart: Cart }>(`/cart/items/${itemId}/packs`, { unitQuantity }),
    onMutate: ({ itemId }) => {
      setBusyItemId(itemId);
    },
    onSuccess: applyCart,
    onError: (error) => {
      setActionError(errorMessage(t, error, t('cart.changeNotSaved')));
      void queryClient.invalidateQueries({ queryKey: ['cart'] });
    },
    onSettled: () => {
      setBusyItemId(null);
    },
  });

  /**
   * The special instruction on a line, changed or cleared.
   *
   * Its own mutation rather than a field on the quantity one, matching the
   * route: an absent field on a shared endpoint would have to mean either
   * "leave it alone" or "clear it", and each of those is wrong for one of the
   * two callers.
   *
   * It answers with the whole repriced cart like every other mutation on this
   * page, even though nothing about the basket's arithmetic has moved. The
   * shape being identical is what lets `applyCart` be the only place the
   * response is written, which is the rule this file is built around.
   */
  const updateNote = useMutation({
    mutationFn: ({ itemId, note }: { itemId: string; note: string | null }) =>
      api.patch<{ cart: Cart }>(`/cart/items/${itemId}/note`, { note }),
    onMutate: ({ itemId }) => {
      setBusyItemId(itemId);
    },
    onSuccess: (result, variables) => {
      applyCart(result);
      // Two different things happened and they are worth telling apart:
      // somebody who meant to clear an instruction and sees "saved" has no
      // way to know whether it worked.
      toast.success(
        variables.note === null ? t('cart.instructionsCleared') : t('cart.instructionsSaved'),
      );
    },
    onError: (error) => {
      setActionError(errorMessage(t, error, t('cart.instructionsFailed')));
      void queryClient.invalidateQueries({ queryKey: ['cart'] });
    },
    onSettled: () => {
      setBusyItemId(null);
    },
  });

  const removeItem = useMutation({
    mutationFn: (itemId: string) => api.delete<{ cart: Cart }>(`/cart/items/${itemId}`),
    onMutate: (itemId) => {
      setBusyItemId(itemId);
    },
    onSuccess: (result) => {
      applyCart(result);
      toast.success(t('cart.removedToast'));
    },
    onError: (error) => {
      setActionError(errorMessage(t, error, t('cart.itemNotRemoved')));
      void queryClient.invalidateQueries({ queryKey: ['cart'] });
    },
    onSettled: () => {
      setBusyItemId(null);
    },
  });

  const clearCart = useMutation({
    mutationFn: () => api.delete<{ cart: Cart }>('/cart'),
    onSuccess: (result) => {
      applyCart(result);
      toast.success(t('cart.emptiedToast'));
    },
    onError: () => {
      setActionError(t('cart.notEmptied'));
    },
  });

  if (query.isPending) return <LoadingState label={t('cart.loading')} />;

  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const cart = query.data.cart;

  if (cart.lines.length === 0) {
    return (
      <>
        <CheckoutSteps states={CART_STEPS} />
        {/* On the empty cart too. Somebody with nothing in their basket is
            exactly the person who has not yet found out that a standing order
            is on offer, and a control that appears only once there is
            something to buy is a control they meet too late. */}
        <CartModeTabs current="instant" />
        <PageEmptyState
          title={t('cart.emptyTitle')}
          description={t('cart.emptyBody')}
          /* Blue, not orange. Browsing is navigation; the orange belongs to
             Add to Cart, Checkout and Place Order and nowhere else. */
          action={
            <ButtonLink to="/products" variant="primary" size="lg">
              {t('cart.browseProducts')}
            </ButtonLink>
          }
        />
      </>
    );
  }

  /*
   * Whether the tax figure is already inside the subtotal.
   *
   * Read off the lines the server sent, not computed from the money: an
   * inclusive cart's column reads Subtotal + Tax + Delivery and then a total
   * that is *less* than their sum, because the tax was extracted from the
   * prices rather than added to them. That is correct, and it looks like an
   * arithmetic bug until the row says so.
   */
  const inclusiveLines = cart.lines.filter((line) => line.taxInclusive).length;

  /*
   * How many of these products the builder would accept.
   *
   * The same flag the line badge reads, counted here so the panel can say a
   * number rather than "some of these". `/schedules/new` filters the cart by
   * exactly this, so a panel offered on a cart of nothing eligible would lead
   * straight to that page's empty state.
   */
  const recurringEligibleCount = cart.lines.filter((line) => line.isRecurringEligible).length;
  const taxHint =
    inclusiveLines === cart.lines.length
      ? '· already in the prices above'
      : inclusiveLines > 0
        ? '· partly in the prices above'
        : '· added to the subtotal';

  return (
    <>
      <CheckoutSteps states={CART_STEPS} />

      {/*
       * Instant Buy and Schedule Cart, above the heading rather than beside
       * it.
       *
       * Everything below this line is the cart the storefront always had: the
       * same lines, the same server-owned totals, the same checkout button.
       * The tab names it, and names the alternative that was previously a link
       * two screens down the summary panel.
       */}
      <CartModeTabs current="instant" />

      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-title-xl text-ink">{t('cart.pageTitle')}</h1>
          <p className="mt-2 text-sm text-ink-muted" aria-live="polite">
            {t('cart.itemsAcrossProducts', {
              items: t('cart.itemCount', { count: cart.itemCount }),
              products: t('cart.productCount', { count: cart.lines.length }),
            })}
          </p>
        </div>

        <Button
          variant="ghost"
          className="shrink-0"
          isLoading={clearCart.isPending}
          onClick={() => {
            clearCart.mutate();
          }}
        >
          {t('cart.emptyTheCart')}
        </Button>
      </header>

      {actionError !== null && (
        <div
          role="alert"
          className="mb-5 flex gap-2.5 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          <AlertIcon className="mt-px h-4 w-4 shrink-0" />
          {actionError}
        </div>
      )}

      {/* The bottom padding clears the sticky bar below `lg`, so the last
          line of the summary is never parked underneath it. */}
      <div className="grid grid-cols-1 gap-6 pb-24 lg:grid-cols-[minmax(0,1fr)_22rem] lg:pb-0">
        <div className="rounded-lg border border-border bg-surface px-4 shadow-card sm:px-5">
          <ul className="divide-y divide-border-subtle">
            {cart.lines.map((line) => (
              <LineRow
                key={line.itemId}
                line={line}
                isBusy={busyItemId === line.itemId}
                onQuantityChange={(quantity) => {
                  updateQuantity.mutate({ itemId: line.itemId, quantity });
                }}
                onPackQuantityChange={(unitQuantity) => {
                  updatePackQuantity.mutate({ itemId: line.itemId, unitQuantity });
                }}
                onNoteChange={(note) => {
                  updateNote.mutate({ itemId: line.itemId, note });
                }}
                onRemove={() => {
                  removeItem.mutate(line.itemId);
                }}
              />
            ))}
          </ul>
        </div>

        {/*
         * Sticky from `lg`, offset to clear the sticky header. Below that it
         * is an ordinary block under the lines: a summary pinned to a short
         * phone viewport is a summary covering the thing it summarises.
         */}
        <aside aria-labelledby="summary-heading" className="lg:sticky lg:top-28 lg:self-start">
          <div className="rounded-lg border border-border bg-surface p-5 shadow-card">
            <h2 id="summary-heading" className="text-title-sm text-ink">
              {t('cart.summary')}
            </h2>

            <dl className="mt-4 space-y-2.5 text-sm">
              <TotalRow
                label={t('cart.subtotal')}
                hint={`· ${t('cart.itemCount', { count: cart.itemCount })}`}
                value={formatMoney(cart.totals.subtotal)}
              />

              {cart.totals.discount.minor !== '0' && (
                <TotalRow
                  label={t('cart.discount')}
                  tone="credit"
                  value={<>−{formatMoney(cart.totals.discount)}</>}
                />
              )}

              <TotalRow label={t('cart.tax')} hint={taxHint} value={formatMoney(cart.totals.tax)} />

              <TotalRow
                label={t('cart.delivery')}
                value={
                  cart.totals.shipping.minor === '0' ? (
                    <span className="text-xs font-normal text-ink-muted">
                      {t('cart.deliveryAtCheckout')}
                    </span>
                  ) : (
                    formatMoney(cart.totals.shipping)
                  )
                }
              />

              {/* The sellers' L1-L4 delivery, estimated to the buyer's own country
                  until an address is chosen at checkout. */}
              {cart.delivery !== undefined && cart.delivery !== null && <DeliveryBreakdown delivery={cart.delivery} />}

              <GrandTotalRow
                label={t('cart.estimatedTotal')}
                value={formatMoney(cart.totals.grandTotal)}
                // Every figure above comes from the server. Saying so sets the
                // right expectation for the final breakdown at checkout.
                note="Confirmed at checkout once delivery is chosen."
              />
            </dl>

            <CouponPanel cart={cart} />

            {/* Who can actually deliver this basket, and on what terms. Under
                the totals rather than above them, because it is the answer to
                a question the totals raise: the delivery line says what
                delivery costs, and this says where it would come from and how
                soon - which is the trade a buyer with two warehouses in reach
                gets to make. */}
            <DeliveryOptionsPanel
              countryCode={locale.country}
              items={cart.lines.map((line) => ({
                productId: line.productId,
                variantId: line.variantId,
                quantity: line.quantity,
              }))}
            />

            {cart.requiresApproval && (
              <div
                role="status"
                className="mt-4 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-xs text-ink"
              >
                <p className="font-medium text-warning">{t('cart.needsApproval')}</p>
                <p className="mt-0.5">{cart.approvalReason ?? t('cart.needsApprovalBody')}</p>
              </div>
            )}

            {cart.blockingIssues.length > 0 && (
              <div
                role="alert"
                className="mt-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-xs"
              >
                <p className="font-medium text-danger">{t('cart.blockingHeading')}</p>
                <ul className="mt-1 list-inside list-disc space-y-1 text-ink">
                  {cart.blockingIssues.map((issue) => (
                    <li key={`${issue.code}:${issue.message}`}>{issue.message}</li>
                  ))}
                </ul>
              </div>
            )}

            <Button
              variant="action"
              size="lg"
              fullWidth
              className="mt-5"
              // The server's verdict, not a count of issues computed here —
              // which would drift the first time a new issue code appeared.
              disabled={!cart.checkoutReady}
              onClick={() => {
                void navigate('/checkout');
              }}
            >
              {t('cart.proceedToCheckout')}
            </Button>

            {!cart.checkoutReady && cart.blockingIssues.length === 0 && (
              <p className="mt-2 text-center text-xs text-ink-muted">{t('cart.fixFlagged')}</p>
            )}

            <ButtonLink to="/products" fullWidth className="mt-2">
              {t('cart.continueShopping')}
            </ButtonLink>
          </div>

          {recurringEligibleCount > 0 && (
            <RepeatPurchasePanel eligibleCount={recurringEligibleCount} />
          )}
        </aside>
      </div>

      {/*
       * The phone-sized checkout bar.
       *
       * Below `lg` the summary sits under a column of lines that can be a
       * screen and a half long, and the CTA goes with it. This keeps one
       * reachable, without repeating the total — the figure lives in exactly
       * one place on the page, so there is nothing to fall out of step.
       */}
      <StickyBottomBar>
        <p className="min-w-0 flex-1 text-xs text-ink-muted">
          {t('cart.itemsReady', { count: cart.itemCount })}
        </p>
        <Button
          variant="action"
          size="lg"
          className="shrink-0"
          disabled={!cart.checkoutReady}
          onClick={() => {
            void navigate('/checkout');
          }}
        >
          {t('cart.checkout')}
        </Button>
      </StickyBottomBar>
    </>
  );
}
