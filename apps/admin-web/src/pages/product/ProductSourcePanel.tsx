/**
 * Packaging, and where this product came from.
 *
 * Two panels that belong together on one screen and nowhere else.
 *
 * The packing figures are the same ones a customer sees, shown here so an
 * administrator can check them against the sheet without opening the
 * storefront — plus the sticker artwork size, which the public read filters out
 * because it is a print specification for the label supplier rather than a fact
 * about the product.
 *
 * The source record is the half a customer must never see: licence status,
 * production capacity, and the operator's own workflow state. It lives on its
 * own table for exactly that reason, so this panel is the only screen in the
 * product that reads it.
 *
 * Everything here is read-only, and deliberately so. It is written by the
 * catalogue import and re-written on the next run, so an edit typed here would
 * be thrown away by the next import without warning — which is a worse
 * experience than a field that was never editable. Correcting any of it means
 * correcting the source sheet and re-importing.
 */
import { Card } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';

/** How much of a packing description the importer could read. */
type PackingParseStatus = 'PARSED' | 'PARTIAL' | 'NEEDS_REVIEW' | 'UNPARSED';

export interface AdminPackDimension {
  kind: 'PRIMARY_PACK' | 'INNER_BOX' | 'OUTER_CARTON' | 'STICKER_ARTWORK';
  rawText: string;
  displayValue: string | null;
  unit: string | null;
  parseStatus: 'PARSED' | 'UNIT_UNKNOWN' | 'UNPARSED';
  /** "460 × 350 × 210 mm", or the raw text where nothing could be read. */
  label: string;
}

export interface AdminPackaging {
  variantKey: string;
  packingType: string | null;
  packingRawText: string | null;
  piecesPerInnerPack: number | null;
  innerPacksPerOuterCarton: number | null;
  piecesPerOuterCarton: number | null;
  innerPackType: string | null;
  outerPackType: string | null;
  parseStatus: PackingParseStatus;
  validationMessage: string | null;
  formula: string | null;
  dimensions: AdminPackDimension[];
}

export interface AdminImportRecord {
  variantKey: string;
  fingerprint: string;
  sourceFileName: string;
  sourceSheet: string;
  sourceRow: number;
  importedAt: string;
  productCode: string | null;
  gtinRaw: string | null;
  gtinNormalised: string | null;
  genericName: string | null;
  modelSize: string | null;
  sterilisation: string | null;
  brand: string | null;
  packingType: string | null;
  shelfLife: string | null;
  productionCapacityPerMonth: string | null;
  launchDate: string | null;
  manufacturingLicenceStatus: string | null;
  testLicenceStatus: string | null;
  internalStatus: string | null;
}

/** The tone a parse status is shown in. Only two of the four are a problem. */
const STATUS_TONE: Record<PackingParseStatus, string> = {
  PARSED: 'bg-success-soft text-success ring-success/25',
  PARTIAL: 'bg-surface-sunken text-ink-muted ring-border',
  NEEDS_REVIEW: 'bg-warning-soft text-warning ring-warning/25',
  UNPARSED: 'bg-surface-sunken text-ink-muted ring-border',
};

function Row({
  term,
  detail,
  mono = false,
}: {
  term: string;
  detail: string;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border-subtle py-2 last:border-0">
      <dt className="text-xs text-ink-muted">{term}</dt>
      <dd
        className={
          'text-right text-xs text-ink ' + (mono ? 'font-mono text-xxs' : 'font-medium tabular')
        }
      >
        {detail}
      </dd>
    </div>
  );
}

/**
 * One SKU's packing.
 *
 * The product-level row (`variantKey` empty) is the one the grid and the
 * listing use; the rest belong to a size each. Both are shown, because "the
 * card says 2,000 and this size says 1,000" is a real question and the answer
 * is on this screen.
 */
function PackagingRow({
  packaging,
  title,
}: {
  packaging: AdminPackaging;
  title: string;
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="border-b border-border px-5 py-4 last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <span
          className={
            'inline-flex items-center rounded-full px-2.5 py-0.5 text-xxs font-semibold ring-1 ring-inset ' +
            STATUS_TONE[packaging.parseStatus]
          }
        >
          {t(`productSource.status.${packaging.parseStatus}` as 'productSource.status.PARSED')}
        </span>
      </div>

      {/* The source text, first and in monospace.

          It is what the supplier actually wrote, and every figure below is
          somebody's reading of it. When the two disagree, this is the line that
          settles it — so it is shown before the interpretation rather than
          tucked underneath it. */}
      {packaging.packingRawText !== null && (
        <p className="mt-2 break-words rounded-md bg-surface-sunken px-3 py-2 font-mono text-xxs text-ink-muted">
          {packaging.packingRawText}
        </p>
      )}

      {packaging.validationMessage !== null && (
        <p
          className={
            'mt-2 rounded-md px-3 py-2 text-xs ' +
            (packaging.parseStatus === 'NEEDS_REVIEW'
              ? 'bg-warning-soft text-warning'
              : 'bg-surface-sunken text-ink-muted')
          }
        >
          {packaging.validationMessage}
        </p>
      )}

      <dl className="mt-3">
        {packaging.packingType !== null && (
          <Row term={t('productSource.packedAs')} detail={packaging.packingType} />
        )}
        {packaging.piecesPerInnerPack !== null && (
          <Row
            term={t('productSource.piecesPerInner', {
              // Lowercased here and capitalised in the row below, matching the
              // storefront: this word sits mid-label, that one starts one.
              pack: (packaging.innerPackType ?? t('productSource.pack')).toLowerCase(),
            })}
            detail={packaging.piecesPerInnerPack.toLocaleString()}
          />
        )}
        {packaging.innerPacksPerOuterCarton !== null && (
          <Row
            term={t('productSource.innersPerOuter', {
              pack: packaging.innerPackType ?? t('productSource.pack'),
            })}
            detail={packaging.innerPacksPerOuterCarton.toLocaleString()}
          />
        )}
        {packaging.piecesPerOuterCarton !== null && (
          <Row
            term={t('productSource.piecesPerOuter')}
            detail={packaging.piecesPerOuterCarton.toLocaleString()}
          />
        )}
        {packaging.dimensions.map((dimension) => (
          <Row
            key={dimension.kind}
            term={t(
              `productSource.dimension.${dimension.kind}` as 'productSource.dimension.PRIMARY_PACK',
            )}
            detail={dimension.label}
            mono={dimension.parseStatus === 'UNPARSED'}
          />
        ))}
      </dl>

      {packaging.formula !== null && (
        <p className="mt-3 rounded-md bg-brand-soft px-3 py-2 text-center text-xs font-medium tabular text-brand">
          {packaging.formula}
        </p>
      )}
    </div>
  );
}

export function ProductPackagingPanel({
  packaging,
  variantNames,
}: {
  packaging: AdminPackaging[];
  variantNames: ReadonlyMap<string, string>;
}): React.JSX.Element | null {
  const { t } = useI18n();

  if (packaging.length === 0) return null;

  return (
    <Card title={t('productSource.packagingHeading')}>
      <p className="border-b border-border px-5 py-3 text-xs leading-relaxed text-ink-muted">
        {t('productSource.packagingIntro')}
      </p>

      {packaging.map((row) => (
        <PackagingRow
          key={row.variantKey === '' ? 'base' : row.variantKey}
          packaging={row}
          title={
            row.variantKey === ''
              ? t('productSource.wholeProduct')
              : (variantNames.get(row.variantKey) ?? t('productSource.oneSize'))
          }
        />
      ))}
    </Card>
  );
}

/**
 * The operator's own columns, and the row they came from.
 *
 * Every value is shown exactly as the sheet recorded it. None of it is
 * interpreted here — the one decision the importer makes from this data, that
 * a product on hold is not orderable, was made once at import time and is
 * visible as the availability switch above, not re-derived from these strings.
 */
export function ProductSourcePanel({
  records,
  variantNames,
}: {
  records: AdminImportRecord[];
  variantNames: ReadonlyMap<string, string>;
}): React.JSX.Element | null {
  const { t } = useI18n();

  if (records.length === 0) return null;

  const first = records[0];

  return (
    <Card title={t('productSource.heading')}>
      <p className="border-b border-border px-5 py-3 text-xs leading-relaxed text-ink-muted">
        {t('productSource.internalOnly')}
      </p>

      {first !== undefined && (
        <div className="border-b border-border px-5 py-4">
          <dl>
            <Row term={t('productSource.sourceFile')} detail={first.sourceFileName} mono />
            <Row term={t('productSource.sourceSheet')} detail={first.sourceSheet} mono />
            <Row
              term={t('productSource.lastImported')}
              detail={new Date(first.importedAt).toLocaleString()}
            />
          </dl>
        </div>
      )}

      {records.map((record) => (
        <div key={record.variantKey === '' ? 'base' : record.variantKey} className="border-b border-border px-5 py-4 last:border-0">
          <h3 className="text-sm font-semibold text-ink">
            {record.variantKey === ''
              ? t('productSource.wholeProduct')
              : (variantNames.get(record.variantKey) ?? t('productSource.oneSize'))}
          </h3>

          <dl className="mt-3">
            <Row
              term={t('productSource.sourceRow')}
              detail={t('productSource.rowN', { n: String(record.sourceRow) })}
            />
            {record.productCode !== null && (
              <Row term={t('productSource.productCode')} detail={record.productCode} mono />
            )}
            {/* Both spellings. The raw one is what a buyer reads off the
                paperwork; the normalised one is what a scanner matches, and
                the two only look the same on some rows. */}
            {record.gtinRaw !== null && (
              <Row term={t('productSource.barcodeAsWritten')} detail={record.gtinRaw} mono />
            )}
            {record.gtinNormalised !== null && (
              <Row term={t('productSource.barcodeNormalised')} detail={record.gtinNormalised} mono />
            )}
            {record.genericName !== null && (
              <Row term={t('productSource.genericName')} detail={record.genericName} />
            )}
            {record.modelSize !== null && (
              <Row term={t('productSource.modelSize')} detail={record.modelSize} />
            )}
            {record.brand !== null && <Row term={t('productSource.brand')} detail={record.brand} />}
            {record.sterilisation !== null && (
              <Row term={t('productSource.sterilisation')} detail={record.sterilisation} />
            )}
            {record.shelfLife !== null && (
              <Row term={t('productSource.shelfLife')} detail={record.shelfLife} />
            )}

            {record.internalStatus !== null && (
              <Row term={t('productSource.internalStatus')} detail={record.internalStatus} />
            )}
            {record.productionCapacityPerMonth !== null && (
              <Row
                term={t('productSource.productionCapacity')}
                detail={record.productionCapacityPerMonth}
              />
            )}
            {record.launchDate !== null && (
              <Row term={t('productSource.launchDate')} detail={record.launchDate} />
            )}
            {record.manufacturingLicenceStatus !== null && (
              <Row
                term={t('productSource.manufacturingLicence')}
                detail={record.manufacturingLicenceStatus}
              />
            )}
            {record.testLicenceStatus !== null && (
              <Row term={t('productSource.testLicence')} detail={record.testLicenceStatus} />
            )}
          </dl>
        </div>
      ))}
    </Card>
  );
}
