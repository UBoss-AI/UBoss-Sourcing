/**
 * The Terms and Conditions, on a page of their own.
 *
 * Two routes. `/legal/terms` is the version in force, in the reader's
 * language where it is published; `/legal/documents/:id` is one exact
 * version, which is what the sign-up dialog links to and what somebody opens
 * later to see the words they agreed to. Public, with no session needed:
 * terms somebody is asked to accept have to be readable before they accept.
 *
 * Print and Download PDF give the same document. The PDF is built on the
 * server from the stored text, so it cannot differ from what is shown here.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';
import { LegalDocumentBody } from '@/components/legal/LegalDocumentBody';
import { Button, ButtonAnchor } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import {
  fetchCurrentTerms,
  fetchLegalDocument,
  fetchPublishedVersions,
  languageEndonym,
  legalDocumentPath,
  legalDocumentPdfUrl,
  type LegalDocument,
  type PublishedVersion,
} from '@/lib/legal';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

type Loaded =
  | { status: 'loading' }
  | { status: 'ready'; document: LegalDocument; isFallback: boolean; versions: PublishedVersion[] }
  | { status: 'error'; error: unknown };

export function LegalDocumentPage(): React.JSX.Element {
  const { t, language } = useI18n();
  const { business } = useStorefront();
  const { id } = useParams<{ id?: string }>();
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoaded({ status: 'loading' });

    const load = async (): Promise<Loaded> => {
      if (id === undefined) {
        const current = await fetchCurrentTerms('PLATFORM_TERMS', language);
        const versions = await fetchPublishedVersions('PLATFORM_TERMS');
        return { status: 'ready', document: current.document, isFallback: current.isFallback, versions };
      }
      const document = await fetchLegalDocument(id);
      const versions = await fetchPublishedVersions(document.kind);
      return { status: 'ready', document, isFallback: false, versions };
    };

    load().then(
      (result) => {
        if (!cancelled) setLoaded(result);
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ status: 'error', error });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, language, attempt]);

  const title = loaded.status === 'ready' ? loaded.document.title : t('terms.page.title');
  useDocumentMeta({ title }, business.displayName);

  if (loaded.status === 'loading') {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 text-sm text-ink-muted" role="status">
        {t('terms.field.loading')}
      </div>
    );
  }

  if (loaded.status === 'error') {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <h1 data-route-focus tabIndex={-1} className="text-xl font-semibold text-ink focus:outline-none">
          {t('terms.page.title')}
        </h1>
        <p role="alert" className="mt-3 text-sm text-danger">
          {errorMessage(t, loaded.error, t('terms.field.loadFailed'))}
        </p>
        <Button
          className="mt-4"
          onClick={() => {
            setAttempt((value) => value + 1);
          }}
        >
          {t('terms.field.retry')}
        </Button>
      </div>
    );
  }

  const { document, isFallback, versions } = loaded;
  const current = versions.find((entry) => entry.isCurrent && entry.locale === document.locale);
  const isOutOfDate = current !== undefined && current.version !== document.version;

  return (
    <article data-legal-print className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-10">
      <h1 data-route-focus tabIndex={-1} className="text-2xl font-bold tracking-tight text-ink focus:outline-none">
        {document.title}
      </h1>

      <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-muted">
        <div className="flex gap-1">
          <dt>{t('terms.meta.version')}</dt>
          <dd className="font-medium text-ink">{document.version}</dd>
        </div>
        <div className="flex gap-1">
          <dt>{t('terms.meta.effective')}</dt>
          <dd className="font-medium text-ink">{formatDate(document.effectiveAt)}</dd>
        </div>
        <div className="flex gap-1">
          <dt>{t('terms.meta.language')}</dt>
          <dd className="font-medium text-ink">{languageEndonym(document.locale)}</dd>
        </div>
      </dl>

      <div className="mt-5 flex flex-wrap gap-2 print:hidden">
        <Button
          onClick={() => {
            window.print();
          }}
        >
          {t('terms.print')}
        </Button>
        <ButtonAnchor href={legalDocumentPdfUrl(document.id)} download>
          {t('terms.downloadPdf')}
        </ButtonAnchor>
      </div>

      {isOutOfDate && (
        <p className="mt-5 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-ink print:hidden">
          {t('terms.page.olderVersion')}{' '}
          <Link to={legalDocumentPath(current.id)} className="font-medium text-brand hover:underline">
            {t('terms.page.readCurrent')}
          </Link>
        </p>
      )}

      {isFallback && (
        <p className="mt-5 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-ink">
          {t('terms.fallbackNotice', { language: languageEndonym(document.locale) })}
        </p>
      )}

      {document.changeSummary !== null && document.changeSummary.length > 0 && (
        <div className="mt-5 rounded-md border border-border bg-surface-sunken px-4 py-3 text-sm">
          <p className="font-semibold text-ink">{t('terms.changeSummary')}</p>
          <p className="mt-1 whitespace-pre-line text-ink-muted">{document.changeSummary}</p>
        </div>
      )}

      <LegalDocumentBody body={document.body} headingLevel={2} className="mt-8 text-base" />

      <p className="mt-10 break-all font-mono text-[11px] text-ink-subtle">SHA-256 {document.contentSha256}</p>

      {versions.length > 1 && (
        <section className="mt-10 border-t border-border-subtle pt-6 print:hidden" aria-labelledby="legal-versions">
          <h2 id="legal-versions" className="text-sm font-semibold text-ink">
            {t('terms.page.allVersions')}
          </h2>
          <ul className="mt-3 space-y-1.5 text-sm">
            {versions.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-x-2">
                {entry.id === document.id ? (
                  <span className="font-medium text-ink">
                    {entry.version} · {languageEndonym(entry.locale)}
                  </span>
                ) : (
                  <Link to={legalDocumentPath(entry.id)} className="font-medium text-brand hover:underline">
                    {entry.version} · {languageEndonym(entry.locale)}
                  </Link>
                )}
                <span className="text-xs text-ink-muted">
                  {t('terms.page.effectiveOn', { date: formatDate(entry.effectiveAt) })}
                  {entry.isCurrent && ` · ${t('terms.page.inForce')}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
