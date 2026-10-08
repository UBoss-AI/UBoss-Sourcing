/**
 * What this person has accepted and acknowledged, for their account page:
 * every record, newest first, with a link to read that exact version again.
 *
 * Read-only. A record is cleared only on the agreement screen, before
 * Continue; after that the history is a history.
 */
import { useEffect, useState } from 'react';
import { Button, Spinner } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { formatAgreementDate } from './format';
import type { AgreementHistoryEntry, AgreementsClient } from './types';

export function AgreementHistory({ client }: { client: AgreementsClient }): React.JSX.Element {
  const { t, language } = useI18n();
  const [entries, setEntries] = useState<AgreementHistoryEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    client.history().then(
      (rows) => {
        if (cancelled) return;
        // A malformed answer is a failure to load, never a crash of the page around it.
        if (Array.isArray(rows)) setEntries(rows);
        else setFailed(true);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, attempt]);

  return (
    <section aria-labelledby="agreement-history-title" className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <h2 id="agreement-history-title" className="text-title-sm text-ink">
        {t('agreements.history.title')}
      </h2>
      <p className="mt-1 text-sm text-ink-muted">{t('agreements.history.intro')}</p>

      {failed && (
        <div role="alert" className="mt-4 flex flex-wrap items-center gap-2 text-sm text-danger">
          <span>{t('agreements.history.loadFailed')}</span>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setAttempt((value) => value + 1);
            }}
          >
            {t('agreements.retry')}
          </Button>
        </div>
      )}

      {!failed && entries === null && (
        <div className="mt-4 flex items-center gap-2 text-sm text-ink-muted" role="status">
          <Spinner className="h-4 w-4" />
          <span>{t('agreements.checking')}</span>
        </div>
      )}

      {entries !== null && entries.length === 0 && (
        <p className="mt-4 text-sm text-ink-muted">{t('agreements.history.empty')}</p>
      )}

      {entries !== null && entries.length > 0 && (
        <ul className="mt-4 divide-y divide-border-subtle">
          {entries.map((entry) => {
            const page = client.pageUrl(entry.documentId);
            return (
              <li key={entry.recordId} className="flex flex-col gap-1 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="font-medium text-ink">{entry.title}</p>
                  <p className="text-xs text-ink-muted">
                    {entry.action === 'TERMS_ACCEPTED'
                      ? t('agreements.history.termsAccepted')
                      : t('agreements.history.privacyAcknowledged')}
                    {' · '}
                    {t('agreements.history.version', { version: entry.version })}
                    {' · '}
                    {formatAgreementDate(entry.recordedAt, language)}
                    {entry.clearedAt !== null && ` · ${t('agreements.history.cleared')}`}
                  </p>
                </div>
                <div className="flex shrink-0 gap-3 text-xs">
                  {page !== null && (
                    <a href={page} target="_blank" rel="noopener noreferrer" className="font-medium text-brand hover:underline">
                      {t('agreements.history.read')}
                    </a>
                  )}
                  <a href={client.pdfUrl(entry.documentId)} download className="font-medium text-brand hover:underline">
                    {t('agreements.downloadPdf')}
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
