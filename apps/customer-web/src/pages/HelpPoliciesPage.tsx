/**
 * `/legal` - help, policies and legal (checklist Master row 9).
 *
 * One place for every document the operator has published - the Terms and
 * Conditions, and the seller terms, privacy, returns, buyer protection,
 * inspection and prohibited-products policies - each opening its published
 * text at `/legal/documents/:id` (versioned and hashed; see
 * `domain/legal-document.ts`). Beside them, the way to get help and any other
 * policy links the operator keeps on their own website.
 *
 * It says which documents are not published yet rather than leaving a buyer
 * to wonder whether a returns policy exists: a missing policy is a gap the
 * operator should see, not one this page should hide.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { DocumentIcon, HeadsetIcon, ShieldIcon } from '@/components/icons';
import { ErrorState, LoadingState } from '@/components/ui';
import { useStorefront } from '@/app/storefront-context';
import { api } from '@/lib/api';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';

const HELP_DOCUMENT_KINDS = [
  'PLATFORM_TERMS',
  'SELLER_TERMS',
  'SELLER_SERVICES_AGREEMENT',
  'B2B_BUYER_TERMS',
  'B2B_BUYER_SERVICES_AGREEMENT',
  'B2C_CONSUMER_TERMS',
  'B2C_PLATFORM_SERVICES_AGREEMENT',
  'PRIVACY_POLICY',
  'RETURNS_POLICY',
  'BUYER_PROTECTION_POLICY',
  'INSPECTION_POLICY',
  'PROHIBITED_PRODUCTS',
] as const;
export type HelpDocumentKind = (typeof HELP_DOCUMENT_KINDS)[number];

export interface DocumentInForce {
  kind: HelpDocumentKind;
  id: string;
  title: string;
  version: string;
  effectiveAt: string;
  isFallback: boolean;
}

export function HelpPoliciesPage(): React.JSX.Element {
  const { t, language } = useI18n();
  const { business } = useStorefront();
  useDocumentMeta({ title: t('help.title'), description: t('help.intro') }, business.displayName);

  const query = useQuery({
    queryKey: ['legal-in-force', language],
    queryFn: () => api.get<{ documents: DocumentInForce[] }>('/legal/in-force', { query: { locale: language } }),
    retry: false,
  });

  const date = new Intl.DateTimeFormat(language, { dateStyle: 'medium' });
  const external = Object.entries(business.policyLinks ?? {});

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:py-8">
      <h1 className="text-title-xl text-ink">{t('help.title')}</h1>
      <p className="mt-2 text-sm text-ink-muted">{t('help.intro')}</p>

      <section aria-labelledby="help-support" className="mt-6 rounded-lg border border-border bg-surface p-5 shadow-card">
        <h2 id="help-support" className="flex items-center gap-2 text-title-sm text-ink">
          <HeadsetIcon className="h-5 w-5 text-brand" />
          {t('help.getHelp')}
        </h2>
        <p className="mt-2 text-sm text-ink">{t('help.supportBody')}</p>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <Link to="/support" className="font-medium text-brand underline-offset-2 hover:underline">
            {t('help.contactSupport')}
          </Link>
          <Link to="/assurance" className="inline-flex items-center gap-1.5 font-medium text-brand underline-offset-2 hover:underline">
            <ShieldIcon className="h-4 w-4" />
            {t('assurance.link')}
          </Link>
        </div>
      </section>

      <section aria-labelledby="help-documents" className="mt-4 rounded-lg border border-border bg-surface p-5 shadow-card">
        <h2 id="help-documents" className="flex items-center gap-2 text-title-sm text-ink">
          <DocumentIcon className="h-5 w-5 text-brand" />
          {t('help.documentsTitle')}
        </h2>

        {query.isPending && <LoadingState label={t('help.loading')} />}
        {query.isError && (
          <ErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        )}
        {query.isSuccess && (
          <>
            <ul className="mt-3 divide-y divide-border-subtle">
              {HELP_DOCUMENT_KINDS.map((kind) => query.data.documents.find((entry) => entry.kind === kind))
                .filter((entry): entry is DocumentInForce => entry !== undefined)
                .map((document) => (
                  <li key={document.kind} className="py-3">
                    <Link
                      to={`/legal/documents/${encodeURIComponent(document.id)}`}
                      className="font-medium text-brand underline-offset-2 hover:underline"
                    >
                      {t(`help.kind.${document.kind}`)}
                    </Link>
                    <p className="text-xs text-ink-muted">
                      {document.title} ·{' '}
                      {t('help.effectiveFrom', { version: document.version, date: date.format(new Date(document.effectiveAt)) })}
                      {document.isFallback && <> · {t('help.otherLanguage')}</>}
                    </p>
                  </li>
                ))}
            </ul>
            {(() => {
              const missing = HELP_DOCUMENT_KINDS.filter(
                (kind) => !query.data.documents.some((entry) => entry.kind === kind),
              );
              return missing.length === 0 ? null : (
                <p className="mt-2 text-xs text-ink-muted">
                  {t('help.notPublished', { documents: missing.map((kind) => t(`help.kind.${kind}`)).join(', ') })}
                </p>
              );
            })()}
          </>
        )}
      </section>

      {external.length > 0 && (
        <section aria-labelledby="help-external" className="mt-4 rounded-lg border border-border bg-surface p-5 shadow-card">
          <h2 id="help-external" className="text-title-sm text-ink">
            {t('help.moreLinks', { marketplace: business.displayName })}
          </h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            {external.map(([label, url]) => (
              <li key={label}>
                <a href={url} target="_blank" rel="noopener noreferrer" className="text-brand underline-offset-2 hover:underline">
                  {label}
                  <span className="sr-only"> {t('supplier.opensInNewTab')}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
