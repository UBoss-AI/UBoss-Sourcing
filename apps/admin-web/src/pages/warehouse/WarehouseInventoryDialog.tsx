/**
 * Everything one warehouse holds.
 *
 * Opened by clicking a warehouse - from its row, its marker, or the detail
 * panel - and it answers the question the Warehouses screen could not: *what
 * is actually in that building*. Until this existed the only route to a
 * warehouse's stock was the Inventory screen filtered by location, which pages
 * over balance rows and therefore cannot show a product the warehouse has none
 * of. The row is not there, so the product is simply missing, and missing is
 * indistinguishable from "not in the catalogue".
 *
 * **Every product in the catalogue is here, for every warehouse.** That is the
 * server's doing - see `warehouse-inventory.service.ts` - and it is what makes
 * this screen answerable: the product a warehouse manager opens it to find is
 * usually the one that ran out.
 *
 * TWO VIEWS, AND BOTH ARE THE REAL ONE
 *
 * The **shelf** is the default. It draws the warehouse as a wall of product
 * plates in real CSS 3D - each card in its own perspective, turned on a
 * resting angle and turning further towards the pointer, its photograph, name
 * and quantity on their own planes off the plate, and a shadow cast on the
 * wall behind it - because a warehouse *is* a physical place and a flat table
 * of numbers is the one representation that never says so. It reads at a
 * glance: how much is here, what is nearly gone, what was never stocked.
 *
 * The **table** is one row per stock-keeping unit, dense, sortable by the eye,
 * and it is what somebody counting stock actually wants. A screen that only
 * offered the shelf would be a screen people stopped using by Wednesday.
 *
 * **A transform above a button must not change between the press and the
 * release, and two rules keep that true here.** When it does change, the hit
 * region moves out from under a cursor that has not moved, the browser fires
 * `click` on a parent with no handler, and the button silently does nothing -
 * then works on the second press. So `useTilt` below **freezes the turn for
 * as long as a pointer is held down**, and an unlayered rule in `index.css`
 * stops the design system's own `active:translate-y-px` from moving a button
 * inside a card. Either alone leaves the click swallowed. The long version,
 * with the event log that finally named it, is at the top of the `.shelf-*`
 * block in `index.css`.
 *
 * The 3D is decoration and is built so that it can be: every card is a real
 * heading, a real list and real buttons, the numbers are in the text and not
 * only in the bar lengths, and every plane is collapsed by
 * `prefers-reduced-motion` (the block in `index.css`).
 *
 * **Nothing here writes.** Receipts and adjustments belong on the Inventory
 * screen, where the movement ledger they append to is on the same page; this
 * links across to it per SKU rather than growing a second way to book stock.
 * A quantity somebody could type over on this screen is the audit trail that
 * explains where stock went, quietly erased.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Modal } from '@/components/Modal';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import {
  Badge,
  Button,
  ErrorState,
  Input,
  Select,
  Spinner,
  Toolbar,
  ToolbarField,
} from '@/components/ui';
import { cx } from '@/lib/cx';
import { formatNumber } from '@/lib/format';
import {
  STOCK_PRESENCES,
  fetchWarehouseInventory,
  stockFraction,
  warehouseInventoryQueryKey,
} from '@/lib/warehouse-inventory';
import type {
  StockPresence,
  WarehouseProduct,
  WarehouseSku,
} from '@/lib/warehouse-inventory';
import type { Warehouse } from '@/lib/warehouses';
import { translateKey, useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';

/**
 * How long the search box waits before asking the server.
 *
 * The search runs on the server because it matches variant SKUs as well as the
 * product's own name - which the browser could not do from one page of
 * products - so every keystroke would otherwise be a request. The same 300ms
 * the Warehouses screen uses, for the same reason.
 */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * How far a card turns at the very edge of itself, in degrees.
 *
 * Five, and it was seven. A turned card is *wider on screen* than its own box
 * - the near edge swings towards the reader - and the grid's outer column has
 * only the dialog's padding to swing into, so at seven degrees the leftmost
 * card had its border and the first digit of its quantity clipped by the
 * scroller. Five is still unmistakably a turn and stays inside the gutter.
 */
const TILT_DEGREES = 5;

/**
 * The card follows the pointer, and holds still while it is pressed.
 *
 * **The freeze is the important half.** A transform above a button that moves
 * between the press and the release takes the button's hit region with it, so
 * the release lands on a wrapper with no handler and the click is lost - which
 * is what made every disclosure on this screen do nothing on the first press.
 * A pointer resting on a card is never perfectly still, so without this the
 * turn would be mid-change on most clicks. Between `pointerdown` and
 * `pointerup` the angle is simply not updated: the card holds the pose it was
 * in, which is also what a physical object does when a finger lands on it.
 *
 * The other half is the unlayered `:active` rule in `index.css`, which stops
 * the *button's own* press from moving it. Both are needed; either alone
 * leaves the click swallowed.
 *
 * The angles are written to the element's own style rather than held in React
 * state, and that is a performance decision rather than a stylistic one: a
 * `pointermove` that set state would re-render a grid of twenty-five cards on
 * every pixel of pointer movement. Writing two custom properties touches one
 * element, and the transform that reads them is composited.
 */
function useTilt(): {
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: React.PointerEvent<HTMLElement>) => void;
} {
  /**
   * True from `pointerdown` until `pointerup`.
   *
   * A ref rather than state: nothing renders differently while a card is held,
   * and a state change here would re-render the card in the middle of the
   * gesture it is trying not to disturb.
   */
  const isPressed = useRef(false);

  return useMemo(
    () => ({
      onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
        // Touch and pen have no hover, so a tap would turn the card and leave
        // it turned with nothing to move away. The turn is a pointer
        // affordance; on touch the cards sit on the resting angle.
        if (event.pointerType !== 'mouse') return;
        // Held down: hold the pose. See the note above.
        if (isPressed.current) return;

        const element = event.currentTarget;
        const box = element.getBoundingClientRect();
        // -1 at one edge, +1 at the other.
        const x = ((event.clientX - box.left) / box.width) * 2 - 1;
        const y = ((event.clientY - box.top) / box.height) * 2 - 1;

        element.style.setProperty('--tilt-y', `${(x * TILT_DEGREES).toFixed(2)}deg`);
        // Inverted: moving the pointer *down* should push the bottom of the
        // card away, which is a negative rotation about X.
        element.style.setProperty('--tilt-x', `${(-y * TILT_DEGREES).toFixed(2)}deg`);
      },
      onPointerDown: () => {
        isPressed.current = true;
      },
      onPointerUp: () => {
        isPressed.current = false;
      },
      onPointerLeave: (event: React.PointerEvent<HTMLElement>) => {
        // A pointer that left while held down - a drag that ended off the card
        // - would otherwise leave the freeze on for ever.
        isPressed.current = false;

        const element = event.currentTarget;
        element.style.removeProperty('--tilt-y');
        element.style.removeProperty('--tilt-x');
      },
    }),
    [],
  );
}

function presenceLabelKey(presence: StockPresence): TranslationKey {
  switch (presence) {
    case 'IN_STOCK':
      return 'warehouseInventory.presence.inStock';
    case 'OUT_OF_STOCK':
      return 'warehouseInventory.presence.outOfStock';
    case 'LOW_STOCK':
      return 'warehouseInventory.presence.lowStock';
    case 'NEVER_STOCKED':
      return 'warehouseInventory.presence.neverStocked';
    case 'ALL':
      return 'warehouseInventory.presence.all';
  }
}

/**
 * The health bar under a SKU.
 *
 * Length and colour both, because colour alone is not a signal to everybody -
 * and the number it describes is in the text beside it either way, so the bar
 * is the summary and never the source. `aria-hidden`, for exactly that reason:
 * a screen reader already has the quantity in words, and a second reading of
 * the same fact as a progress bar is noise.
 */
function StockBar({
  sku,
  reorderThreshold,
}: {
  sku: WarehouseSku;
  reorderThreshold: number;
}): React.JSX.Element {
  const fraction = stockFraction(sku, reorderThreshold);

  return (
    <div
      aria-hidden="true"
      className="h-1.5 overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-border-subtle"
    >
      <div
        className={cx(
          'h-full rounded-full transition-[width] duration-200',
          sku.availableQty <= 0
            ? 'bg-danger-fill'
            : sku.isLowStock
              ? 'bg-warning-fill'
              : 'bg-operational-fill',
        )}
        // A floor of 3% so a SKU with one unit left is a visible sliver rather
        // than a bar that looks identical to empty.
        style={{ width: fraction <= 0 ? '0%' : `${Math.max(3, fraction * 100).toFixed(1)}%` }}
      />
    </div>
  );
}

/** One SKU line inside a product card. */
function SkuRow({
  sku,
  product,
  warehouseId,
}: {
  sku: WarehouseSku;
  product: WarehouseProduct;
  warehouseId: string;
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <li className="rounded-md bg-surface px-2.5 py-2 ring-1 ring-inset ring-border-subtle">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-ink">
            {sku.variantName ?? t('warehouseInventory.baseProduct')}
          </p>
          <p className="truncate font-mono text-xxs text-ink-subtle">{sku.sku}</p>
        </div>

        <div className="shrink-0 text-right">
          <p className="text-sm font-semibold tabular-nums text-ink">
            {product.isStockTracked ? formatNumber(sku.availableQty) : '—'}
          </p>
          <p className="text-xxs text-ink-subtle">{t('warehouseInventory.available')}</p>
        </div>
      </div>

      {product.isStockTracked && (
        <>
          <div className="mt-1.5">
            <StockBar sku={sku} reorderThreshold={product.reorderThreshold} />
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xxs text-ink-muted">
            <span>
              {t('warehouseInventory.onHandShort')}{' '}
              <span className="font-medium tabular-nums text-ink">
                {formatNumber(sku.onHandQty)}
              </span>
            </span>
            {sku.reservedQty > 0 && (
              <span>
                {t('warehouseInventory.reservedShort')}{' '}
                <span className="font-medium tabular-nums text-ink">
                  {formatNumber(sku.reservedQty)}
                </span>
              </span>
            )}

            {/* Two states that look the same in a number and are not. See the
                header of `warehouse-inventory.ts`. */}
            {!sku.hasBalanceRow ? (
              <Badge tone="neutral">{t('warehouseInventory.neverStocked')}</Badge>
            ) : sku.availableQty <= 0 ? (
              <Badge tone="danger">{t('warehouseInventory.outOfStock')}</Badge>
            ) : sku.isLowStock ? (
              <Badge tone="warning">{t('warehouseInventory.low')}</Badge>
            ) : null}

            {/* Across to the screen that can actually change this number. The
                dialog itself never writes - see the module header. */}
            <Link
              to={`/inventory?locationId=${warehouseId}&q=${encodeURIComponent(sku.sku)}`}
              className="ml-auto font-medium text-brand underline underline-offset-2 hover:no-underline"
            >
              {t('warehouseInventory.manage')}
            </Link>
          </div>
        </>
      )}
    </li>
  );
}

/**
 * One product, as a plate on the shelf.
 *
 * The 3D is four planes at different depths inside one `preserve-3d` card: the
 * plate itself, the photograph lifted off it, the quantity lifted further, and
 * a soft shadow left behind on the ground. That is what makes the tilt read as
 * an object being turned rather than a picture being skewed - a single flat
 * layer rotated is just a distorted rectangle.
 */
function ProductPlate({
  product,
  warehouseId,
  isExpanded,
  onToggle,
}: {
  product: WarehouseProduct;
  warehouseId: string;
  isExpanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const tilt = useTilt();

  // A product with one SKU has nothing to expand - its own row *is* the SKU -
  // so the whole card shows it inline and grows no disclosure button.
  const single = product.skus.length === 1 ? product.skus[0] : undefined;

  return (
    /*
     * Three elements, because the 3D needs three jobs kept apart.
     *
     * `.shelf-plate` (this `li`) owns the *perspective*, which in CSS applies
     * to an element's children rather than to itself - so the thing that turns
     * has to be inside it. Per card rather than per grid, which is what keeps
     * a plane's projection centred on its own card instead of displacing it
     * towards a vanishing point somewhere else on the wall.
     *
     * `.shelf-tilt` turns, and establishes the 3D space its contents share.
     * It is also what the unlayered `:active` rule in index.css is scoped to,
     * because a button that moves while it is being pressed inside a
     * 3D-transformed subtree loses its own click.
     *
     * The shadow is a child of the `li`, not of the tilt, so it stays behind
     * the card whatever the card's height. See index.css for both reasons.
     */
    <li
      className="group/plate shelf-plate relative"
      onPointerMove={tilt.onPointerMove}
      onPointerDown={tilt.onPointerDown}
      onPointerUp={tilt.onPointerUp}
      onPointerLeave={tilt.onPointerLeave}
    >
      {/* The shadow the card casts on the wall behind it: its own surface
          further back, which is what lets it grow and soften as the card comes
          forward. Decoration, so it is hidden from assistive technology and
          takes no pointer events. */}
      <div
        aria-hidden="true"
        className="shelf-shadow pointer-events-none absolute inset-x-3 inset-y-4 rounded-xl"
      />

      <div className="shelf-tilt h-full">
        <article
          className={cx(
            'relative flex h-full flex-col rounded-xl border border-border bg-surface p-3',
            // `box-shadow` and `border-color` only. A transform *transition*
            // on this element would move the buttons inside it between
            // mousedown and mouseup, which swallows the click - the card's own
            // turn is on `.shelf-tilt`, and it is frozen while a pointer is
            // held down.
            'shadow-card transition-[box-shadow,border-color] [transform-style:preserve-3d]',
            'group-hover/plate:border-border-hover group-hover/plate:shadow-card-hover',
            // Dashed, so a warehouse holding none of this product says so in
            // the border as well as in the number.
            product.onHandQty <= 0 && 'border-dashed',
          )}
        >
          <div className="flex items-start gap-3">
            {/* The photograph, on its own plane a few pixels off the plate.
                `surface-media` is white in both themes - a product shot is lit
                for white, and a dark plate behind a transparent PNG is a
                product nobody can see. */}
            <div className="shelf-media shrink-0">
              <div className="h-14 w-14 overflow-hidden rounded-lg bg-surface-media ring-1 ring-border-subtle">
                {product.imageUrl === null ? (
                  <div className="flex h-full w-full items-center justify-center font-mono text-xxs text-ink-subtle">
                    {product.sku.slice(0, 3)}
                  </div>
                ) : (
                  <img
                    src={product.imageUrl}
                    // Empty, deliberately: the product's name is the next
                    // element and a screen reader reading it twice is noise.
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-contain"
                  />
                )}
              </div>
            </div>

            <div className="shelf-title min-w-0 flex-1">
              <h4 className="text-xs font-semibold leading-snug text-ink" title={product.name}>
                {/* Two lines, then an ellipsis. A medical-device name runs to
                    eighty characters and a card that grew to fit one would make
                    every other card on the row the same height. */}
                <span className="line-clamp-2">{product.name}</span>
              </h4>
              <p className="mt-0.5 truncate font-mono text-xxs text-ink-subtle">{product.sku}</p>
              <p className="mt-0.5 truncate text-xxs text-ink-muted">{product.categoryName}</p>
            </div>
          </div>

          {/*
            The quantity, and then the badges under it on their own row.

            They used to share a row - the number on the left, the badges
            pushed right with `justify-between` - and it collapsed as soon as
            a product carried two of them: "Not published" and "3 SKUs low"
            wrapped onto a second line and landed across "on hand" and the
            valuation beneath it. A card is 300-odd pixels wide and two badges
            are most of that, so they get a line of their own rather than
            competing for one.
          */}
          <div className="shelf-figure mt-3">
            <div className="flex items-baseline gap-1.5">
              <p
                className={cx(
                  'text-title-sm tabular-nums',
                  product.onHandQty <= 0 ? 'text-ink-subtle' : 'text-ink',
                )}
              >
                {product.isStockTracked ? formatNumber(product.onHandQty) : '—'}
              </p>
              <p className="text-xxs text-ink-subtle">{t('warehouseInventory.unitsOnHand')}</p>
            </div>

            {product.isStockTracked && (
              <p className="mt-0.5 text-xxs text-ink-muted">
                {t('warehouseInventory.valuedAt', {
                  amount: `${product.valuation.formatted} ${product.valuation.currency}`,
                })}
              </p>
            )}
          </div>

          {/* Only rendered when there is something to say, so a card with no
              badges does not carry an empty row's worth of margin. */}
          {(!product.isStockTracked || !product.isPublished || product.lowStockSkus > 0) && (
            <div className="mt-2 flex flex-wrap gap-1">
              {!product.isStockTracked && (
                <Badge tone="neutral">{t('warehouseInventory.notTracked')}</Badge>
              )}
              {!product.isPublished && (
                <Badge tone="neutral">{t('warehouseInventory.unpublished')}</Badge>
              )}
              {product.lowStockSkus > 0 && (
                <Badge tone="warning">
                  {t('warehouseInventory.lowSkus', { count: product.lowStockSkus })}
                </Badge>
              )}
            </div>
          )}

          {/* `mt-auto` so the disclosure sits on the bottom edge of every card
              in a row, however tall the names above it made them. A row of
              cards whose buttons are at four different heights reads as four
              unrelated things. */}
          <div className="mt-auto pt-3">
            {single !== undefined ? (
              <ul className="space-y-1.5">
                <SkuRow sku={single} product={product} warehouseId={warehouseId} />
              </ul>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  className="w-full"
                  onClick={onToggle}
                  aria-expanded={isExpanded}
                >
                  {isExpanded
                    ? t('warehouseInventory.hideSkus', { count: product.skus.length })
                    : t('warehouseInventory.showSkus', { count: product.skus.length })}
                </Button>

                {isExpanded && (
                  <ul className="mt-2 space-y-1.5">
                    {product.skus.map((sku) => (
                      <SkuRow
                        key={sku.variantId ?? 'base'}
                        sku={sku}
                        product={product}
                        warehouseId={warehouseId}
                      />
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </article>
      </div>
    </li>
  );
}

/**
 * A stat plate over the shelf.
 *
 * Lifted off the page on its own plane so the header reads as the front of the
 * same three-dimensional space the cards are in, rather than as a flat strip
 * pasted over it.
 */
function StatPlate({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'warning' | 'neutral';
}): React.JSX.Element {
  return (
    <div
      className={cx(
        'rounded-lg border border-border bg-surface px-3 py-2.5 shadow-card',
        '[transform:perspective(900px)_rotateX(2.5deg)_translateZ(6px)]',
        'motion-reduce:[transform:none]',
      )}
    >
      <p className="text-xxs uppercase tracking-wider text-ink-subtle">{label}</p>
      <p
        className={cx(
          'mt-0.5 text-title-sm tabular-nums',
          tone === 'warning' ? 'text-warning' : tone === 'neutral' ? 'text-ink-muted' : 'text-ink',
        )}
      >
        {value}
      </p>
    </div>
  );
}

interface WarehouseInventoryDialogProps {
  warehouse: Warehouse;
  onClose: () => void;
}

export function WarehouseInventoryDialog({
  warehouse,
  onClose,
}: WarehouseInventoryDialogProps): React.JSX.Element {
  const { t } = useI18n();

  const [view, setView] = useState<'shelf' | 'table'>('shelf');
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [presence, setPresence] = useState<StockPresence>('ALL');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  // Not in the URL, unlike the Warehouses screen's own filters. This is a
  // dialog: it is opened, read and closed, and a filter inside it that pushed
  // history would put a back button between the reader and the screen they
  // came from.
  useEffect(() => {
    if (searchDraft.trim() === search) return undefined;

    const timer = setTimeout(() => {
      setSearch(searchDraft.trim());
      // A new search is a new list, and page 4 of the old one names nothing.
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [searchDraft, search]);

  const query = useQuery({
    queryKey: warehouseInventoryQueryKey(warehouse.id, {
      page,
      search,
      categoryId: '',
      presence,
    }),
    queryFn: () =>
      fetchWarehouseInventory(warehouse.id, { page, search, categoryId: '', presence }),
    // The catalogue does not change while somebody reads one warehouse, and
    // the quantities change often enough that a long stale time would be a
    // lie. Half a minute keeps paging back and forth free without holding a
    // figure anybody would act on.
    staleTime: 30 * 1000,
  });

  const data = query.data;
  /*
   * Memoised on the response, not written as `data?.products ?? []`.
   *
   * The `??` builds a fresh empty array on every render, which is a new
   * identity, which makes the `skuRows` memo below recompute on every render -
   * flattening every product's SKUs and rebuilding the whole table's row
   * objects each time somebody types a character into the search box.
   */
  const products = useMemo(() => data?.products ?? [], [data]);

  /**
   * The scroller, so a page change goes back to the top.
   *
   * Turning to page three and landing halfway down it is the sort of small
   * wrongness nobody reports and everybody notices. The dialog's own body is
   * the scroll container, so this is a ref into it rather than `window`.
   */
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bodyRef.current?.closest('[data-dialog-body]')?.scrollTo({ top: 0 });
  }, [page]);

  const toggleExpanded = (productId: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  /** One row per SKU, for the table view. */
  const skuRows = useMemo(
    () =>
      products.flatMap((product) =>
        product.skus.map((sku) => ({ product, sku, key: `${product.productId}:${sku.variantId ?? 'base'}` })),
      ),
    [products],
  );

  const columns: Column<(typeof skuRows)[number]>[] = [
    {
      key: 'product',
      header: t('warehouseInventory.column.product'),
      render: (row) => (
        <div className="min-w-56">
          <p className="font-medium text-ink">{row.product.name}</p>
          <p className="font-mono text-xxs text-ink-subtle">{row.sku.sku}</p>
          {row.sku.variantName !== null && (
            <p className="mt-0.5 text-xxs text-ink-muted">{row.sku.variantName}</p>
          )}
        </div>
      ),
    },
    {
      key: 'category',
      header: t('warehouseInventory.column.category'),
      secondary: true,
      tertiary: true,
      render: (row) => <span className="text-ink-muted">{row.product.categoryName}</span>,
    },
    {
      key: 'onHand',
      header: t('warehouseInventory.column.onHand'),
      align: 'right',
      render: (row) =>
        row.product.isStockTracked ? (
          formatNumber(row.sku.onHandQty)
        ) : (
          <span className="text-xxs text-ink-subtle">—</span>
        ),
    },
    {
      key: 'reserved',
      header: t('warehouseInventory.column.reserved'),
      align: 'right',
      secondary: true,
      render: (row) =>
        row.sku.reservedQty === 0 ? (
          <span className="text-xxs text-ink-subtle">—</span>
        ) : (
          formatNumber(row.sku.reservedQty)
        ),
    },
    {
      key: 'available',
      header: t('warehouseInventory.column.available'),
      align: 'right',
      render: (row) => (
        <span
          className={cx(
            'font-medium',
            row.sku.availableQty <= 0
              ? 'text-danger'
              : row.sku.isLowStock
                ? 'text-warning'
                : 'text-ink',
          )}
        >
          {row.product.isStockTracked ? formatNumber(row.sku.availableQty) : '—'}
        </span>
      ),
    },
    {
      key: 'state',
      header: t('warehouseInventory.column.state'),
      nowrap: true,
      render: (row) =>
        !row.product.isStockTracked ? (
          <Badge tone="neutral">{t('warehouseInventory.notTracked')}</Badge>
        ) : !row.sku.hasBalanceRow ? (
          <Badge tone="neutral">{t('warehouseInventory.neverStocked')}</Badge>
        ) : row.sku.availableQty <= 0 ? (
          <Badge tone="danger">{t('warehouseInventory.outOfStock')}</Badge>
        ) : row.sku.isLowStock ? (
          <Badge tone="warning">{t('warehouseInventory.low')}</Badge>
        ) : (
          <Badge tone="success">{t('warehouseInventory.stocked')}</Badge>
        ),
    },
    {
      key: 'action',
      header: t('warehouseInventory.column.action'),
      align: 'right',
      render: (row) => (
        <Link
          to={`/inventory?locationId=${warehouse.id}&q=${encodeURIComponent(row.sku.sku)}`}
          className="font-medium text-brand underline underline-offset-2 hover:no-underline"
        >
          {t('warehouseInventory.manage')}
        </Link>
      ),
    },
  ];

  const totals = data?.totals;
  const pagination = data?.pagination;

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="xl"
      title={t('warehouseInventory.title', { name: warehouse.name })}
      description={t('warehouseInventory.description', { code: warehouse.code })}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-ink-muted">
            {pagination === undefined
              ? ''
              : t('warehouseInventory.pageOf', {
                  page: pagination.page,
                  totalPages: pagination.totalPages,
                  total: pagination.total,
                })}
          </p>

          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={page <= 1 || query.isFetching}
              onClick={() => {
                setPage((current) => Math.max(1, current - 1));
              }}
            >
              {t('warehouseInventory.previous')}
            </Button>
            <Button
              size="sm"
              disabled={
                pagination === undefined || page >= pagination.totalPages || query.isFetching
              }
              onClick={() => {
                setPage((current) => current + 1);
              }}
            >
              {t('warehouseInventory.next')}
            </Button>
          </div>
        </div>
      }
    >
      <div ref={bodyRef} className="space-y-4">
        {!warehouse.isActive && (
          <p className="rounded-md border border-border-subtle bg-surface-sunken px-3 py-2 text-xs leading-relaxed text-ink-muted">
            {t('warehouseInventory.retiredNote')}
          </p>
        )}

        {/* The warehouse's own figures, not the filtered list's. A total that
            moved with the search box would be read as the warehouse's and be
            wrong; the filtered count is in the footer. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatPlate
            label={t('warehouseInventory.stat.skus')}
            value={totals === undefined ? '—' : formatNumber(totals.skus)}
          />
          <StatPlate
            label={t('warehouseInventory.stat.onHand')}
            value={totals === undefined ? '—' : formatNumber(totals.onHandQty)}
          />
          <StatPlate
            label={t('warehouseInventory.stat.available')}
            value={totals === undefined ? '—' : formatNumber(totals.availableQty)}
          />
          <StatPlate
            label={t('warehouseInventory.stat.lowStock')}
            value={totals === undefined ? '—' : formatNumber(totals.lowStockSkus)}
            tone={totals !== undefined && totals.lowStockSkus > 0 ? 'warning' : 'default'}
          />
        </div>

        <Toolbar>
          <ToolbarField label={t('warehouseInventory.searchLabel')}>
            <Input
              type="search"
              className="sm:w-64"
              placeholder={t('warehouseInventory.searchPlaceholder')}
              value={searchDraft}
              onChange={(event) => {
                setSearchDraft(event.target.value);
              }}
            />
          </ToolbarField>

          <ToolbarField label={t('warehouseInventory.presenceLabel')}>
            <Select
              className="w-48"
              value={presence}
              onChange={(event) => {
                setPresence(event.target.value as StockPresence);
                setPage(1);
              }}
            >
              {STOCK_PRESENCES.map((option) => (
                <option key={option} value={option}>
                  {translateKey(t, presenceLabelKey(option))}
                </option>
              ))}
            </Select>
          </ToolbarField>

          <ToolbarField label={t('warehouseInventory.viewLabel')}>
            {/* Two buttons rather than a select: it is a two-state choice
                somebody makes with their eyes on the content, and
                `aria-pressed` says which is on without a label to read. */}
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={view === 'shelf' ? 'primary' : 'secondary'}
                aria-pressed={view === 'shelf'}
                onClick={() => {
                  setView('shelf');
                }}
              >
                {t('warehouseInventory.view.shelf')}
              </Button>
              <Button
                size="sm"
                variant={view === 'table' ? 'primary' : 'secondary'}
                aria-pressed={view === 'table'}
                onClick={() => {
                  setView('table');
                }}
              >
                {t('warehouseInventory.view.table')}
              </Button>
            </div>
          </ToolbarField>
        </Toolbar>

        {query.isError ? (
          <ErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : view === 'table' ? (
          <DataTable
            caption={t('warehouseInventory.title', { name: warehouse.name })}
            columns={columns}
            rows={skuRows}
            rowKey={(row) => row.key}
            isLoading={query.isPending}
            isRefreshing={query.isFetching && !query.isPending}
            loadingLabel={t('warehouseInventory.loading')}
            minWidth="60rem"
            emptyTitle={t('warehouseInventory.emptyTitle')}
            emptyDescription={t('warehouseInventory.emptyDescription')}
          />
        ) : query.isPending ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-ink-muted">
            <Spinner className="h-4 w-4" />
            {t('warehouseInventory.loading')}
          </div>
        ) : products.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-surface-sunken px-6 py-10 text-center">
            <p className="text-sm font-medium text-ink">{t('warehouseInventory.emptyTitle')}</p>
            <p className="mx-auto mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">
              {t('warehouseInventory.emptyDescription')}
            </p>
          </div>
        ) : (
          /*
           * The shelf.
           *
           * The perspective lives here rather than on each card, and that is
           * what makes it one space: a shared vanishing point means two cards
           * side by side are turned *towards the same point*, the way two
           * boxes on a real shelf are. Per-card perspective gives every card
           * its own vanishing point and the wall reads as a collage.
           *
           * `origin-center` and the flat default keep an untouched card
           * square, so the grid is still a grid.
           */
          <ul
            className={cx(
              'shelf-grid grid grid-cols-1 gap-3',
              'sm:grid-cols-2 xl:grid-cols-3',
              // A refetch dims what is on screen rather than blanking it, the
              // same rule the tables follow.
              query.isFetching && 'opacity-60 transition-opacity',
            )}
          >
            {products.map((product) => (
              <ProductPlate
                key={product.productId}
                product={product}
                warehouseId={warehouse.id}
                isExpanded={expanded.has(product.productId)}
                onToggle={() => {
                  toggleExpanded(product.productId);
                }}
              />
            ))}
          </ul>
        )}

        {totals !== undefined && totals.unstockedSkus > 0 && (
          <p className="text-xs leading-relaxed text-ink-muted">
            {t('warehouseInventory.unstockedNote', { count: totals.unstockedSkus })}
          </p>
        )}
      </div>
    </Modal>
  );
}
