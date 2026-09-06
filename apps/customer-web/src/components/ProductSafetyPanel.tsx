/**
 * Product safety information — GPSR Art. 19.
 *
 * Regulation (EU) 2023/988 requires that a product offered online carries, on
 * the listing and before anyone buys, who made it, how to reach them, what it
 * is, and what the warnings are. That is a display obligation, which makes this
 * component the part of the feature that actually discharges it — a
 * manufacturer recorded perfectly in the database and never rendered satisfies
 * nothing.
 *
 * Three decisions about how it renders, each of which matters more than it
 * looks:
 *
 *   - **Nothing is shown where there is nothing.** A "Safety information"
 *     heading over an empty block reads as "this product has no warnings",
 *     which is a claim, and a much stronger one than "we have not stated any
 *     here". A catalogue outside the EU renders none of this at all.
 *
 *   - **Warnings come first and are visually distinct from the address block.**
 *     They are the part somebody has to read; the economic operators are the
 *     part somebody has to find later, usually after something has gone wrong.
 *     Putting them in one undifferentiated list buries the first under the
 *     second.
 *
 *   - **The warning text is not `dangerouslySetInnerHTML`.** It is typed by
 *     staff into a plain textarea and rendered as plain text with newlines
 *     preserved. A safety warning is the last field in this application that
 *     should be able to carry markup.
 */
import type { EconomicOperator, ProductSafety } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

function OperatorBlock({
  operator,
  heading,
  hint,
}: {
  operator: EconomicOperator;
  heading: string;
  hint?: string;
}): React.JSX.Element {
  const address = operator.address ?? {};

  // Assembled here rather than stored pre-formatted: the parts come off a
  // company register in whatever shape that country's register uses, and half
  // of them are legitimately absent.
  const lines = [address.line1, address.line2, address.city, address.postalCode].filter(
    (part): part is string => typeof part === 'string' && part.trim().length > 0,
  );

  return (
    <div className="min-w-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">{heading}</h3>
      {hint !== undefined && <p className="mt-0.5 text-xxs text-ink-subtle">{hint}</p>}

      <p className="mt-1.5 font-medium text-ink">{operator.legalName}</p>
      {operator.tradeName !== null && (
        <p className="text-sm text-ink-muted">{operator.tradeName}</p>
      )}

      <address className="mt-1 not-italic text-sm leading-relaxed text-ink-muted">
        {lines.map((line) => (
          <span key={line} className="block">
            {line}
          </span>
        ))}
        <span className="block">{operator.countryCode}</span>

        {/* Art. 19(a) asks for an electronic address specifically. A name and
            a postal address with no way to write to them is the state the
            article exists to stop. */}
        <a
          className="mt-1 block break-all font-medium text-ink underline underline-offset-2 hover:no-underline"
          href={`mailto:${operator.email}`}
        >
          {operator.email}
        </a>

        {operator.phone !== null && <span className="block">{operator.phone}</span>}

        {operator.website !== null && (
          <a
            className="block break-all underline underline-offset-2 hover:no-underline"
            href={operator.website}
            rel="noreferrer noopener"
            target="_blank"
          >
            {operator.website}
          </a>
        )}
      </address>
    </div>
  );
}

export function ProductSafetyPanel({
  safety,
}: {
  safety: ProductSafety | null | undefined;
}): React.JSX.Element | null {
  const { t } = useI18n();

  if (safety === null || safety === undefined) return null;

  const hasIdentifiers = safety.gtin !== null || safety.modelIdentifier !== null;
  const hasOperators = safety.manufacturer !== null || safety.euResponsiblePerson !== null;
  const hasWarnings = safety.warnings !== null || safety.instructions !== null;

  // A catalogue that has filled none of this in renders nothing, rather than
  // an empty section implying the product has no warnings.
  if (!hasWarnings && !hasOperators && !hasIdentifiers) return null;

  return (
    <section aria-labelledby="safety-heading" className="min-w-0">
      <h2 id="safety-heading" className="text-title-sm text-ink">
        {t('safety.heading')}
      </h2>

      <div className="mt-3 overflow-hidden rounded-lg border border-border bg-surface shadow-card">
        {hasWarnings && (
          <div className="border-b border-border-subtle bg-warning-soft/40 px-4 py-3">
            {safety.warnings !== null && (
              <>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-warning">
                  {t('safety.warnings')}
                </h3>
                {/* `whitespace-pre-line`, not markup: staff type this into a
                    plain textarea, and a safety warning is the last field here
                    that should be able to carry HTML. */}
                <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink">
                  {safety.warnings}
                </p>
              </>
            )}

            {safety.instructions !== null && (
              <>
                <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                  {t('safety.instructions')}
                </h3>
                <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink-muted">
                  {safety.instructions}
                </p>
              </>
            )}
          </div>
        )}

        {hasIdentifiers && (
          <dl className="grid gap-x-6 gap-y-2 border-b border-border-subtle px-4 py-3 text-sm sm:grid-cols-2">
            {safety.modelIdentifier !== null && (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                  {t('safety.model')}
                </dt>
                <dd className="mt-0.5 break-words text-ink">{safety.modelIdentifier}</dd>
              </div>
            )}
            {safety.gtin !== null && (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                  {t('safety.gtin')}
                </dt>
                <dd className="mt-0.5 font-mono text-xs text-ink">{safety.gtin}</dd>
              </div>
            )}
          </dl>
        )}

        {hasOperators && (
          <div className="grid gap-6 px-4 py-3 sm:grid-cols-2">
            {safety.manufacturer !== null && (
              <OperatorBlock operator={safety.manufacturer} heading={t('safety.manufacturer')} />
            )}
            {safety.euResponsiblePerson !== null && (
              <OperatorBlock
                operator={safety.euResponsiblePerson}
                heading={t('safety.euResponsible')}
                hint={t('safety.euResponsibleHint')}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}
