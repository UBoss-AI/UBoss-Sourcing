/**
 * Adding a product to a schedule.
 *
 * A search over the catalogue rather than a free-text field, for the reason
 * that shapes this whole module: a schedule line is a product id, and a buyer
 * typing a product code from memory into a standing order that will be charged
 * unattended for a year is the wrong place to be approximate.
 *
 * Two things it asks the catalogue for, and both matter:
 *
 *   - **`recurringOnly`**, so only products the server will actually accept on
 *     a schedule are offered. On a deployment that curates which of its
 *     products may be repeated, offering the rest is offering a line whose
 *     save will be refused — and the refusal would arrive after the customer
 *     had also changed the cadence and the quantities.
 *   - **The shopper's own market**, so the price beside a candidate is the
 *     price that plan would be quoted at.
 *
 * Products already on the schedule are shown as already added rather than
 * hidden. A buyer looking for something they put on last month needs to find
 * it and be told it is there; a search that silently returns nothing reads as
 * a catalogue that has lost the product.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocale } from '@/app/locale-context';
import { Modal } from '@/components/Modal';
import { Badge, Button, Field, Input, Spinner } from '@/components/ui';
import { SearchIcon } from '@/components/icons';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useI18n } from '@/i18n/i18n-context';
import type { Product } from '@/lib/types';

export interface PickedProduct {
  productId: string;
  name: string;
  sku: string;
  slug: string;
  minOrderQty: number;
  maxOrderQty: number | null;
  qtyIncrement: number;
}

export function ScheduleProductPicker({
  isOpen,
  onClose,
  onPick,
  alreadyOn,
}: {
  isOpen: boolean;
  onClose: () => void;
  onPick: (product: PickedProduct) => void;
  /** Product ids already on the schedule. */
  alreadyOn: readonly string[];
}): React.JSX.Element {
  const { t } = useI18n();
  const { currency, country } = useLocale();

  const [term, setTerm] = useState('');
  const [search, setSearch] = useState('');

  /*
   * Typing is not searching.
   *
   * The catalogue read is keyed on `search`, which trails `term` by a beat, so
   * a buyer typing "cannula" makes one request rather than seven. 300ms is
   * short enough to feel immediate and long enough to collapse a word.
   */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(term.trim());
    }, 300);

    return () => {
      window.clearTimeout(timer);
    };
  }, [term]);

  const query = useQuery({
    queryKey: ['schedule-product-search', search, currency, country],
    queryFn: () =>
      api.get<{ products: Product[] }>('/catalog/products', {
        query: {
          ...(search.length > 0 ? { q: search } : {}),
          // Only what a schedule will accept. See the header.
          recurringOnly: 'true',
          limit: 12,
          currency,
          country: country ?? undefined,
        },
      }),
    enabled: isOpen,
    staleTime: 60_000,
  });

  const products = query.data?.products ?? [];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('scheduleCart.addAProduct')}
      description={t('scheduleCart.addAProductBody')}
      size="lg"
      footer={<Button onClick={onClose}>{t('scheduleCart.done')}</Button>}
    >
      <div className="space-y-4">
        <Field label={t('scheduleCart.searchTheCatalogue')}>
          {({ inputId }) => (
            <div className="relative">
              <SearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle"
              />
              <Input
                id={inputId}
                type="search"
                className="pl-9"
                value={term}
                placeholder={t('scheduleCart.searchPlaceholder')}
                onChange={(event) => {
                  setTerm(event.target.value);
                }}
              />
            </div>
          )}
        </Field>

        {/* `aria-live`, because the list changes under a field somebody is
            still typing into and a screen-reader user gets no other signal
            that the results moved. `polite`, so it waits for a pause. */}
        <div aria-live="polite" aria-busy={query.isFetching}>
          {query.isPending && (
            <p className="flex items-center gap-2 py-6 text-sm text-ink-muted">
              <Spinner className="h-4 w-4" />
              {t('scheduleCart.searching')}
            </p>
          )}

          {query.isError && (
            <p
              role="alert"
              className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
            >
              {t('scheduleCart.searchFailed')}
            </p>
          )}

          {query.isSuccess && products.length === 0 && (
            <p className="py-6 text-sm text-ink-muted">
              {search.length === 0
                ? t('scheduleCart.nothingCanBeScheduled')
                : t('scheduleCart.noProductMatches', { term: search })}
            </p>
          )}

          {products.length > 0 && (
            <ul className="divide-y divide-border-subtle">
              {products.map((product) => {
                const isOn = alreadyOn.includes(product.id);

                return (
                  <li key={product.id} className="flex items-center gap-3 py-2.5">
                    {product.primaryImage === null ? (
                      <span
                        aria-hidden="true"
                        className="h-10 w-10 shrink-0 rounded-md border border-border bg-surface-sunken"
                      />
                    ) : (
                      <img
                        src={product.primaryImage.url}
                        alt=""
                        width={40}
                        height={40}
                        loading="lazy"
                        className="h-10 w-10 shrink-0 rounded-md border border-border bg-surface object-contain p-1"
                      />
                    )}

                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink">{product.name}</span>
                      <span className="block truncate font-mono text-xxs uppercase text-ink-subtle">
                        {product.sku} · {formatMoney(product.price)}
                      </span>
                    </span>

                    {isOn ? (
                      // Named rather than hidden: somebody hunting for what
                      // they added last month needs to be told it is there.
                      <Badge tone="operational">{t('scheduleCart.alreadyOnThisSchedule')}</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        className="shrink-0"
                        onClick={() => {
                          onPick({
                            productId: product.id,
                            name: product.name,
                            sku: product.sku,
                            slug: product.slug,
                            minOrderQty: product.purchaseRules.minOrderQty,
                            maxOrderQty: product.purchaseRules.maxOrderQty,
                            qtyIncrement: product.purchaseRules.qtyIncrement,
                          });
                        }}
                      >
                        {t('scheduleCart.add')}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
