/**
 * Everything a buyer reads about a product below the buy panel, in one order:
 *
 *   Product Highlights · Product Description · Specifications ·
 *   Packaging and Bulk Ordering · Compliance and Certifications · Warranty ·
 *   Manufacturer and Seller Information
 *
 * A section appears only when it has something true to say. Nothing here
 * writes a word of product content: every value is the seller's or the
 * catalogue's, and a group with no rows, a row with no value and a label seen
 * twice never reach the page (the server already drops them; `rowsOf` is the
 * belt to that pair of braces).
 *
 * The specifications follow the chosen variant: the page passes the variant's
 * own list when it has one, and the product's otherwise - never a mixture, so
 * a buyer who changes size never reads the previous size's capacity.
 *
 * Description sections are plain text, drawn as text with the seller's line
 * breaks kept. The older HTML description, where a product has one, goes
 * through `SafeHtml` exactly as before - it was sanitised when it was saved.
 */
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ChevronDownIcon } from '@/components/icons';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { SafeHtml } from '@/lib/safe-html';
import type { DescriptionSection, SpecGroup, SpecGroupKey, SpecRow } from '@/lib/types';

/** Rows shown before "View all specifications". */
export const SPEC_ROWS_SHOWN = 8;
/** Highlights shown before "View all highlights". */
export const HIGHLIGHTS_SHOWN = 6;

const SPEC_SECTION: readonly SpecGroupKey[] = [
  'GENERAL',
  'TECHNICAL',
  'DIMENSIONS_WEIGHT',
  'MATERIAL',
  'PERFORMANCE',
  'COMPATIBILITY',
  'IN_THE_BOX',
];
const PACKAGING_SECTION: readonly SpecGroupKey[] = ['PACKAGING', 'CARTON', 'CONTAINER'];
const COMPLIANCE_SECTION: readonly SpecGroupKey[] = ['COMPLIANCE'];
const WARRANTY_SECTION: readonly SpecGroupKey[] = ['WARRANTY'];
const MAKER_SECTION: readonly SpecGroupKey[] = ['MANUFACTURER', 'SELLER', 'ORIGIN'];

export interface Highlight {
  label: string;
  value: string;
}

export interface ProductInformationProps {
  /** The chosen variant's specifications when it has its own, else the product's. */
  specifications: SpecGroup[];
  descriptionSections: DescriptionSection[];
  /** The older single description: plain text or sanitised HTML. */
  description: string | null;
  descriptionHtml: string | null;
  /** Facts the page already knows that belong in the highlights: minimum order, carton size. */
  extraHighlights?: Highlight[];
  /** The existing packaging and dimensions panels. */
  packaging?: React.ReactNode;
  /** The device and certification panel. */
  compliance?: React.ReactNode;
  /** The GPSR manufacturer and safety panel. */
  manufacturer?: React.ReactNode;
}

function rowsOf(groups: SpecGroup[], keys: readonly SpecGroupKey[]): SpecGroup[] {
  return groups
    .filter((group) => keys.includes(group.group))
    .map((group) => ({
      group: group.group,
      rows: group.rows.filter((row) => row.label.trim() !== '' && row.value.trim() !== ''),
    }))
    .filter((group) => group.rows.length > 0);
}

function valueOf(row: SpecRow): string {
  return row.unit === null ? row.value : `${row.value} ${row.unit}`;
}

function Card({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const headingId = `${id}-heading`;
  return (
    <section id={id} aria-labelledby={headingId} className="min-w-0 scroll-mt-24">
      <h2 id={headingId} className="text-title-sm text-ink">
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * Keep the toggle where it was on the screen when the list above it grows or
 * shrinks - measured before and after, and the page moved by the difference.
 * Collapsing a long table otherwise throws the reader a screen up the page.
 */
function useToggleKeepsPlace(): {
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  remember: () => void;
} {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const before = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (before.current === null || buttonRef.current === null) return;
    const shift = buttonRef.current.getBoundingClientRect().top - before.current;
    before.current = null;
    if (Math.abs(shift) > 1 && typeof window.scrollBy === 'function') window.scrollBy({ top: shift, behavior: 'instant' });
  });
  return {
    buttonRef,
    remember: () => {
      before.current = buttonRef.current?.getBoundingClientRect().top ?? null;
    },
  };
}

function ToggleButton({
  expanded,
  controls,
  onToggle,
  more,
  less,
  buttonRef,
}: {
  expanded: boolean;
  controls: string;
  onToggle: () => void;
  more: string;
  less: string;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
}): React.JSX.Element {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
      className="mt-3 inline-flex min-h-10 items-center gap-1.5 rounded-md px-2 text-sm font-semibold text-brand hover:bg-brand-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      {expanded ? less : more}
      <ChevronDownIcon
        aria-hidden="true"
        className={cx('size-4 transition-transform duration-200 motion-reduce:transition-none', expanded && 'rotate-180')}
      />
    </button>
  );
}

/**
 * Label | value rows under group headings. Two columns from `sm` with a fixed
 * label width, stacked on a phone; long values wrap anywhere rather than
 * pushing the page sideways.
 */
function SpecTable({
  groups,
  limit,
  listId,
}: {
  groups: SpecGroup[];
  limit: number | null;
  listId?: string;
}): React.JSX.Element {
  const { t } = useI18n();
  let remaining = limit ?? Number.POSITIVE_INFINITY;
  return (
    <div id={listId} className="overflow-hidden rounded-lg border border-border bg-surface shadow-card">
      {groups.map((group) => {
        if (remaining <= 0) return null;
        const rows = group.rows.slice(0, remaining);
        remaining -= rows.length;
        return (
          <div key={group.group} className="border-b border-border-subtle last:border-b-0">
            <h3 className="bg-surface-sunken/60 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
              {t(`product.specGroup.${group.group}` as TranslationKey)}
            </h3>
            <dl className="divide-y divide-border-subtle">
              {rows.map((row) => (
                <div
                  key={row.label}
                  className="grid grid-cols-1 gap-0.5 px-4 py-2.5 text-sm sm:grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)] sm:gap-6"
                >
                  <dt className="text-ink-muted [overflow-wrap:anywhere]">{row.label}</dt>
                  <dd className="text-ink [overflow-wrap:anywhere]">{valueOf(row)}</dd>
                </div>
              ))}
            </dl>
          </div>
        );
      })}
    </div>
  );
}

function Highlights({ items }: { items: Highlight[] }): React.JSX.Element | null {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const keep = useToggleKeepsPlace();
  if (items.length === 0) return null;
  const shown = expanded ? items : items.slice(0, HIGHLIGHTS_SHOWN);
  return (
    <Card id="highlights" title={t('product.info.highlights')}>
      <ul id={listId} className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        {shown.map((item) => (
          <li key={item.label} className="flex min-w-0 gap-2">
            <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <span className="text-ink-muted">{item.label}: </span>
              <span className="font-medium text-ink">{item.value}</span>
            </span>
          </li>
        ))}
      </ul>
      {items.length > HIGHLIGHTS_SHOWN && (
        <ToggleButton
          buttonRef={keep.buttonRef}
          expanded={expanded}
          controls={listId}
          onToggle={() => {
            keep.remember();
            setExpanded((open) => !open);
          }}
          more={t('product.info.viewAllHighlights')}
          less={t('product.info.fewerHighlights')}
        />
      )}
    </Card>
  );
}

function Description({
  sections,
  description,
  descriptionHtml,
}: {
  sections: DescriptionSection[];
  description: string | null;
  descriptionHtml: string | null;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const hasSections = sections.length > 0;
  if (!hasSections && description === null && descriptionHtml === null) return null;
  return (
    <Card id="description" title={t('product.description')}>
      <div className="max-w-prose space-y-5">
        {descriptionHtml !== null ? (
          // A supplier's HTML can contain a wide table or an unbroken part
          // number; the table scrolls inside itself instead of the page.
          <SafeHtml
            html={descriptionHtml}
            className="prose-sm break-words text-sm leading-relaxed text-ink-muted [&_a]:text-brand [&_a]:underline [&_h2]:mt-4 [&_h2]:font-semibold [&_h2]:text-ink [&_h3]:mt-3 [&_h3]:font-medium [&_h3]:text-ink [&_img]:h-auto [&_img]:max-w-full [&_li]:ml-5 [&_li]:list-disc [&_p]:mt-2 [&_table]:mt-3 [&_table]:block [&_table]:w-full [&_table]:overflow-x-auto [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1"
          />
        ) : description !== null && !hasSections ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-muted">{description}</p>
        ) : null}
        {sections.map((section, index) => (
          <article key={`${section.heading}-${String(index)}`} className="min-w-0">
            {section.heading !== '' && <h3 className="text-sm font-semibold text-ink">{section.heading}</h3>}
            {section.image !== null && (
              <img
                src={section.image.url}
                alt={section.image.alt}
                loading="lazy"
                decoding="async"
                width={section.image.width ?? undefined}
                height={section.image.height ?? undefined}
                className="mt-2 h-auto max-h-80 w-auto max-w-full rounded-md border border-border-subtle bg-surface-sunken object-contain"
              />
            )}
            {section.body !== '' && (
              <p className="mt-1.5 whitespace-pre-line text-sm leading-relaxed text-ink-muted [overflow-wrap:anywhere]">
                {section.body}
              </p>
            )}
          </article>
        ))}
      </div>
    </Card>
  );
}

function Specifications({ groups }: { groups: SpecGroup[] }): React.JSX.Element | null {
  const { t } = useI18n();
  const location = useLocation();
  // A link straight to #specifications opens the whole table.
  const [expanded, setExpanded] = useState(() => location.hash === '#specifications');
  const listId = useId();
  const keep = useToggleKeepsPlace();
  if (groups.length === 0) return null;
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const long = total > SPEC_ROWS_SHOWN;
  return (
    <Card id="specifications" title={t('product.specifications')}>
      <SpecTable groups={groups} limit={long && !expanded ? SPEC_ROWS_SHOWN : null} listId={listId} />
      {long && (
        <ToggleButton
          buttonRef={keep.buttonRef}
          expanded={expanded}
          controls={listId}
          onToggle={() => {
            keep.remember();
            setExpanded((open) => !open);
          }}
          more={t('product.info.viewAllSpecs', { total: String(total) })}
          less={t('product.info.showLess')}
        />
      )}
    </Card>
  );
}

export function ProductInformation({
  specifications,
  descriptionSections,
  description,
  descriptionHtml,
  extraHighlights = [],
  packaging,
  compliance,
  manufacturer,
}: ProductInformationProps): React.JSX.Element {
  const { t } = useI18n();
  const highlights: Highlight[] = [];
  const seen = new Set<string>();
  for (const group of specifications) {
    for (const row of group.rows) {
      if (!row.highlight || seen.has(row.label.toLowerCase())) continue;
      seen.add(row.label.toLowerCase());
      highlights.push({ label: row.label, value: valueOf(row) });
    }
  }
  for (const extra of extraHighlights) {
    if (seen.has(extra.label.toLowerCase())) continue;
    seen.add(extra.label.toLowerCase());
    highlights.push(extra);
  }

  const packagingRows = rowsOf(specifications, PACKAGING_SECTION);
  const complianceRows = rowsOf(specifications, COMPLIANCE_SECTION);
  const warrantyRows = rowsOf(specifications, WARRANTY_SECTION);
  const makerRows = rowsOf(specifications, MAKER_SECTION);

  return (
    <div className="mt-12 flex flex-col gap-10 border-t border-border pt-8">
      <Highlights items={highlights} />
      <Description sections={descriptionSections} description={description} descriptionHtml={descriptionHtml} />
      <Specifications groups={rowsOf(specifications, SPEC_SECTION)} />

      {(packagingRows.length > 0 || packaging !== undefined) && (
        <div className="flex flex-col gap-6">
          {packagingRows.length > 0 && (
            <Card id="bulk-ordering" title={t('product.info.packagingBulk')}>
              <SpecTable groups={packagingRows} limit={null} />
            </Card>
          )}
          {packaging}
        </div>
      )}

      {complianceRows.length > 0 && (
        <Card id="compliance" title={t('product.info.compliance')}>
          <SpecTable groups={complianceRows} limit={null} />
        </Card>
      )}
      {compliance}

      {warrantyRows.length > 0 && (
        <Card id="warranty" title={t('product.info.warranty')}>
          <SpecTable groups={warrantyRows} limit={null} />
        </Card>
      )}

      {makerRows.length > 0 && (
        <Card id="manufacturer" title={t('product.info.manufacturerSeller')}>
          <SpecTable groups={makerRows} limit={null} />
        </Card>
      )}
      {manufacturer}
    </div>
  );
}
