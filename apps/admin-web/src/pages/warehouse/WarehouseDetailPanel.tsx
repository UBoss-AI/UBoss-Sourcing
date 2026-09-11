/**
 * Everything known about one warehouse.
 *
 * A side panel rather than a map popup, and that is a considered choice. A
 * popup anchored to a marker has to fit inside the map, so it either hides the
 * markers around it or truncates what it says - and this panel carries fifteen
 * fields including a four-figure stock roll-up and an ERP message that can run
 * to a sentence. The map still gets a popup, but a short one: the name, the
 * status, and a nudge to open this.
 *
 * On a desktop it sits beside the map. On a tablet the page stacks and it
 * lands underneath, which is why nothing in here relies on being tall and
 * narrow.
 *
 * A real `<aside>` with a heading, not a div: it is a complementary region
 * next to the main content, and a screen reader user should be able to jump
 * straight to it rather than tabbing the whole table first.
 */
import { useEffect, useRef } from 'react';
import { Badge, Button, DescriptionList } from '@/components/ui';
import { CountryFlag } from '@/components/CountryFlag';
import { CloseIcon } from '@/components/icons';
import { formatDateTime, formatNumber, formatRelative } from '@/lib/format';
import {
  addressLines,
  erpLabelKey,
  erpTone,
  formatCoordinates,
  isPlaced,
  localTimeAt,
  operationalLabelKey,
  operationalTone,
  warehouseState,
} from '@/lib/warehouses';
import type { Warehouse } from '@/lib/warehouses';
import { translateKey, useI18n } from '@/i18n/i18n-context';

interface WarehouseDetailPanelProps {
  warehouse: Warehouse;
  onClose: () => void;
  /** Opens the form. Absent for a reader without the write permission. */
  onEdit?: () => void;
  /**
   * The delivery-coverage toggle.
   *
   * **This is the keyboard path to that feature, not a convenience.** On the
   * map, coverage follows the pointer - and the map is `aria-hidden` because
   * the table below it is the accessible copy of everything on it, so no
   * marker can be focused and hovering is not a gesture a keyboard has. A
   * button in this panel is the only way the answer is reachable without a
   * pointer, which makes it load-bearing.
   *
   * Absent for a warehouse with no position and on a map provider that cannot
   * draw the ring, rather than present and inert.
   */
  coverage?: { isOpen: boolean; onToggle: () => void };
  /**
   * Opens this warehouse's inventory.
   *
   * The panel's most-used button, and the reason it is the *primary* action
   * rather than Edit: somebody who has clicked a warehouse is far more often
   * asking what is in it than correcting its postcode. Always present - it is
   * a read, so everybody who can see this screen gets it.
   */
  onOpenInventory: () => void;
}

export function WarehouseDetailPanel({
  warehouse,
  onClose,
  onEdit,
  coverage,
  onOpenInventory,
}: WarehouseDetailPanelProps): React.JSX.Element {
  const { t } = useI18n();

  const state = warehouseState(warehouse);
  const lines = addressLines(warehouse);
  const localTime = localTimeAt(warehouse.timezone);
  const delivery = warehouse.delivery;

  /**
   * Bring the panel into view when it opens.
   *
   * **This is a bug fix, not a flourish.** The panel lives beside the map, and
   * the button that opens it is in the table *below* the map - which on this
   * screen is around nine hundred pixels further down the page. Pressing
   * *Details* therefore did the whole job and looked like it had done nothing:
   * the row tinted, the answer rendered, and every pixel of it was off the top
   * of the screen. Somebody pressed it twice and closed it again.
   *
   * Keyed on the warehouse's id rather than run once on mount, because the
   * panel is not remounted when a *different* warehouse is selected - React
   * keeps the same element and swaps its props, so an effect that ran only on
   * mount would scroll for the first warehouse and never again.
   *
   * What gets scrolled to is the panel's **top**, and that is not what
   * `scrollIntoView({ block: 'nearest' })` does. This panel is taller than
   * most viewports, so "nearest" satisfies itself by bringing the *bottom*
   * edge up - which left the reader looking at the middle of a record with no
   * name on it. `block: 'start'` puts the heading first, which is the only
   * useful place to start reading one.
   *
   * And it only scrolls when the top is not already where somebody could read
   * it. Scrolling a screen that did not need scrolling is its own small
   * wrongness, and it is the one noticed on a tall monitor where the map and
   * the table are both in view at once.
   */
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;

    const top = panel.getBoundingClientRect().top;
    // Off the top, or so near the bottom edge that only a sliver shows.
    const needsScrolling = top < 0 || top > window.innerHeight - 96;

    if (!needsScrolling) return;

    panel.scrollIntoView({
      block: 'start',
      // Honoured by the browser against the reader's own motion preference,
      // so this needs no `matchMedia` check of its own.
      behavior: 'smooth',
    });
  }, [warehouse.id]);

  return (
    <aside
      ref={panelRef}
      aria-labelledby="warehouse-detail-heading"
      className="flex flex-col rounded-lg border border-border bg-surface shadow-card"
    >
      <header className="flex items-start gap-3 border-b border-border-subtle px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2
            id="warehouse-detail-heading"
            className="truncate text-title-sm text-ink"
            title={warehouse.name}
          >
            {warehouse.name}
          </h2>
          <p className="mt-0.5 font-mono text-xxs text-ink-subtle">{warehouse.code}</p>
        </div>

        <Button
          size="sm"
          variant="ghost"
          onClick={onClose}
          aria-label={t('warehouses.detail.close')}
        >
          <CloseIcon className="h-4 w-4" />
        </Button>
      </header>

      <div className="space-y-4 px-4 py-4">
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={state.tone}>{translateKey(t, state.labelKey)}</Badge>
          <Badge tone={operationalTone(warehouse.operationalStatus)}>
            {translateKey(t, operationalLabelKey(warehouse.operationalStatus))}
          </Badge>
          <Badge tone={erpTone(warehouse.erp.status)}>
            {translateKey(t, erpLabelKey(warehouse.erp.status))}
          </Badge>
        </div>

        {/* Read before anything else on a warehouse in another country, and
            the reason the zone is stored rather than derived from the country:
            Spain spans two. */}
        {localTime !== null && (
          <p className="text-sm text-ink">
            {t('warehouses.detail.localTime', { time: localTime })}{' '}
            <span className="text-ink-subtle">({warehouse.timezone})</span>
          </p>
        )}

        <section>
          <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
            {t('warehouses.detail.address')}
          </h3>
          {lines.length > 0 ? (
            <address className="mt-1 whitespace-pre-line text-sm not-italic leading-relaxed text-ink">
              {lines.join('\n')}
            </address>
          ) : (
            <p className="mt-1 text-sm text-ink-subtle">{t('warehouses.detail.noAddress')}</p>
          )}
        </section>

        <DescriptionList
          items={[
            {
              label: t('warehouses.detail.position'),
              value: isPlaced(warehouse) ? (
                <span className="font-mono text-xs">
                  {formatCoordinates(warehouse.latitude, warehouse.longitude)}
                </span>
              ) : warehouse.coordinatesInvalid ? (
                // Named, not blank. This warehouse *has* coordinates and they
                // are unusable, which is a different problem from having none
                // and needs a different fix.
                <span className="text-danger">{t('warehouses.detail.positionInvalid')}</span>
              ) : (
                <span className="text-ink-subtle">{t('warehouses.notPlaced')}</span>
              ),
            },
            {
              label: t('warehouses.detail.timezone'),
              value: warehouse.timezone ?? (
                <span className="text-ink-subtle">{t('warehouses.detail.notSet')}</span>
              ),
            },
            {
              label: t('warehouses.detail.skus'),
              value: formatNumber(warehouse.stock.skuCount),
            },
            {
              label: t('warehouses.detail.onHand'),
              value: formatNumber(warehouse.stock.onHandQty),
            },
            {
              label: t('warehouses.detail.reserved'),
              value: formatNumber(warehouse.stock.reservedQty),
            },
            {
              label: t('warehouses.detail.available'),
              // Derived on screen from the two figures above it, the same way
              // the Inventory screen derives it - on hand minus what carts and
              // unpaid orders have already promised away.
              value: formatNumber(warehouse.stock.onHandQty - warehouse.stock.reservedQty),
            },
            {
              label: t('warehouses.detail.lowStock'),
              value:
                warehouse.stock.lowStockCount === 0 ? (
                  formatNumber(0)
                ) : (
                  <span className="font-medium text-warning">
                    {formatNumber(warehouse.stock.lowStockCount)}
                  </span>
                ),
            },
            {
              label: t('warehouses.detail.liveReservations'),
              value: formatNumber(warehouse.stock.activeReservations),
            },
          ]}
        />

        {/* The geofence, and the two facts a buyer chooses between when more
            than one warehouse can serve them. Read together, because they are
            one promise: "500 km, two to four days, twelve euro". */}
        <section>
          <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
            {t('warehouses.detail.delivery')}
          </h3>

          <dl className="mt-1 space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-ink-muted">{t('warehouses.detail.radius')}</dt>
              <dd className="min-w-0 flex-1 text-ink">
                {/* The same number and two different statements. See
                    `radiusIsDefault` in lib/warehouses.ts. */}
                {delivery.radiusIsDefault
                  ? t('warehouses.radiusDefault', { km: delivery.radiusKm })
                  : t('warehouses.radiusOwn', { km: delivery.radiusKm })}
              </dd>
            </div>

            <div className="flex gap-2">
              <dt className="text-ink-muted">{t('warehouses.detail.leadTime')}</dt>
              <dd className="min-w-0 flex-1 text-ink">
                {delivery.leadTimeDays === null ? (
                  <span className="text-ink-subtle">{t('warehouses.detail.leadTimeUnset')}</span>
                ) : (
                  t('warehouses.detail.leadTimeDays', {
                    min: delivery.leadTimeDays.min,
                    max: delivery.leadTimeDays.max,
                  })
                )}
              </dd>
            </div>

            <div className="flex gap-2">
              <dt className="text-ink-muted">{t('warehouses.detail.fee')}</dt>
              <dd className="min-w-0 flex-1 text-ink">
                {delivery.fee === null ? (
                  <span className="text-ink-subtle">{t('warehouses.detail.feeUnset')}</span>
                ) : delivery.fee.minor === '0' ? (
                  // Zero is a real fee, and "0.00 EUR" reads as a bug. It
                  // means free, so it says free.
                  <span className="font-medium text-operational">
                    {t('warehouses.detail.feeFree')}
                  </span>
                ) : (
                  <span className="tabular-nums">
                    {delivery.fee.formatted} {delivery.fee.currency}
                  </span>
                )}
              </dd>
            </div>
          </dl>

          {/* Said in words rather than left to the reader to notice, because
              the consequence is not obvious: a warehouse with no published
              lead time is silently absent from a buyer's option list. */}
          {delivery.leadTimeDays === null && (
            <p className="mt-1.5 text-xxs leading-relaxed text-ink-muted">
              {t('warehouses.detail.leadTimeUnsetNote')}
            </p>
          )}

          {delivery.radiusIsDefault && (
            <p className="mt-1.5 text-xxs leading-relaxed text-ink-muted">
              {t('warehouses.detail.radiusDefaultNote')}
            </p>
          )}

          <h4 className="mt-3 text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
            {t('warehouses.detail.excluded')}
          </h4>

          {delivery.excludedCountries.length === 0 ? (
            <p className="mt-1 text-xs text-ink-subtle">{t('warehouses.detail.excludedNone')}</p>
          ) : (
            <ul className="mt-1.5 space-y-1">
              {delivery.excludedCountries.map((country) => (
                <li
                  key={country.code}
                  className="rounded-md border border-danger/25 bg-danger-soft px-2 py-1.5"
                >
                  <div className="flex items-baseline gap-1.5">
                    <CountryFlag code={country.code} className="h-3 w-4 shrink-0" />
                    <span className="text-xs font-medium text-ink">{country.name}</span>
                    <span className="font-mono text-xxs text-ink-subtle">{country.code}</span>
                  </div>
                  {country.reason !== null && (
                    <p className="mt-0.5 text-xxs leading-relaxed text-ink-muted">
                      {country.reason}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
            {t('warehouses.detail.erp')}
          </h3>

          <dl className="mt-1 space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-ink-muted">{t('warehouses.detail.erpId')}</dt>
              <dd className="min-w-0 flex-1 truncate font-mono text-xs text-ink">
                {warehouse.erp.externalId ?? (
                  <span className="font-sans text-ink-subtle">
                    {t('warehouses.detail.notMapped')}
                  </span>
                )}
              </dd>
            </div>

            <div className="flex gap-2">
              <dt className="text-ink-muted">{t('warehouses.detail.erpLastSync')}</dt>
              <dd className="min-w-0 flex-1 text-ink">
                {warehouse.erp.lastSyncAt === null ? (
                  <span className="text-ink-subtle">{t('warehouses.detail.erpNever')}</span>
                ) : (
                  // Relative first, because "3 hours ago" is the question, and
                  // the absolute time in the tooltip for whoever needs to
                  // quote it.
                  <span title={formatDateTime(warehouse.erp.lastSyncAt)}>
                    {formatRelative(warehouse.erp.lastSyncAt)}
                  </span>
                )}
              </dd>
            </div>
          </dl>

          {warehouse.erp.message !== null && (
            <p className="mt-1.5 rounded-md border border-border-subtle bg-surface-sunken px-2.5 py-2 text-xs leading-relaxed text-ink-muted">
              {warehouse.erp.message}
            </p>
          )}
        </section>

        {/* The primary action, and above the coverage toggle and Edit for the
            same reason: it is what somebody who clicked a warehouse is most
            often asking for. */}
        <Button variant="primary" className="w-full" onClick={onOpenInventory}>
          {t('warehouses.detail.openInventory')}
        </Button>

        {coverage !== undefined && (
          <Button
            variant="secondary"
            className="w-full"
            onClick={coverage.onToggle}
            // The panel it opens is over the map, which is a different part of
            // the page - so this says what state it is in rather than relying
            // on the reader seeing the result appear.
            aria-pressed={coverage.isOpen}
          >
            {coverage.isOpen
              ? t('warehouses.coverage.close')
              : t('warehouses.coverage.show')}
          </Button>
        )}

        {onEdit !== undefined && (
          <Button variant="secondary" className="w-full" onClick={onEdit}>
            {t('warehouses.edit')}
          </Button>
        )}
      </div>
    </aside>
  );
}
