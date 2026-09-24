/**
 * Where the QR code on a seller's invoice or packing list lands.
 *
 * Public, because it is read by whoever is holding the carton - a receiving
 * clerk, a customs officer, a driver. It answers one question: did this
 * marketplace issue a document with this number, from whom, and is it still
 * standing. It says nothing about the buyer or what they paid; the server
 * never sends that, so this page could not leak it if it tried.
 *
 * It is NOT a GST e-invoice check. The printed QR says so too.
 */
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { useStorefront } from '@/app/storefront-context';
import { Badge, LoadingState } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { formatDateTime } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { verifyDocument, type DocumentKind } from '@/lib/seller-documents';

export function VerifyDocumentPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  const [params] = useSearchParams();
  useDocumentMeta({ title: t('verifyDocument.pageTitle'), noIndex: true }, business.displayName);

  const kindParam = params.get('kind');
  const kind: DocumentKind | null =
    kindParam === 'invoice' || kindParam === 'packing-list' ? kindParam : null;
  const number = params.get('number') ?? '';
  const code = params.get('code') ?? '';
  const complete = kind !== null && number.length >= 3 && code.length === 16;

  const query = useQuery({
    queryKey: ['verify-document', kind, number, code],
    queryFn: () => verifyDocument(kind ?? 'invoice', number, code),
    enabled: complete,
    retry: false,
  });

  return (
    <div className="mx-auto max-w-lg space-y-6 px-4 py-12">
      <h1 className="text-title text-ink">{t('verifyDocument.title')}</h1>

      {!complete ? (
        <p className="text-sm text-ink-muted">{t('verifyDocument.incomplete')}</p>
      ) : query.isPending ? (
        <LoadingState label={t('verifyDocument.checking')} />
      ) : query.isError || !query.data.valid ? (
        <div
          role="alert"
          className="rounded-lg border border-danger/30 bg-danger-soft p-5 text-sm text-ink"
        >
          <p className="font-medium">{t('verifyDocument.notFound')}</p>
          <p className="mt-1 text-ink-muted">{t('verifyDocument.notFoundHint')}</p>
        </div>
      ) : (
        <div
          role="status"
          className="space-y-3 rounded-lg border border-border bg-surface p-5 shadow-card"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={query.data.status === 'ISSUED' ? 'success' : 'warning'}>
              {t(`verifyDocument.status.${query.data.status}` as TranslationKey)}
            </Badge>
            <span className="text-sm text-ink-muted">
              {t(`verifyDocument.kind.${query.data.kind}` as TranslationKey)}
            </span>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-ink-muted">{t('verifyDocument.number')}</dt>
            <dd className="font-mono text-ink">{query.data.number}</dd>
            <dt className="text-ink-muted">{t('verifyDocument.issuer')}</dt>
            <dd className="text-ink">{query.data.issuer}</dd>
            {query.data.issuedAt !== null && (
              <>
                <dt className="text-ink-muted">{t('verifyDocument.issuedAt')}</dt>
                <dd className="text-ink">{formatDateTime(query.data.issuedAt)}</dd>
              </>
            )}
            {query.data.packageCount !== undefined && (
              <>
                <dt className="text-ink-muted">{t('verifyDocument.packages')}</dt>
                <dd className="text-ink">{query.data.packageCount.toLocaleString()}</dd>
              </>
            )}
          </dl>
          <p className="text-xs text-ink-muted">{t('verifyDocument.notEInvoice')}</p>
        </div>
      )}
    </div>
  );
}
