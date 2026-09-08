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
import { Badge, Button, DescriptionList } from '@/components/ui';
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
}

export function WarehouseDetailPanel({
  warehouse,
  onClose,
  onEdit,
}: WarehouseDetailPanelProps): React.JSX.Element {
  const { t } = useI18n();

  const state = warehouseState(warehouse);
  const lines = addressLines(warehouse);
  const localTime = localTimeAt(warehouse.timezone);

  return (
    <aside
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

        {onEdit !== undefined && (
          <Button variant="primary" className="w-full" onClick={onEdit}>
            {t('warehouses.edit')}
          </Button>
        )}
      </div>
    </aside>
  );
}
