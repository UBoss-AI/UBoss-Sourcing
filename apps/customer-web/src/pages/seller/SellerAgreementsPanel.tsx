/**
 * The two seller agreements an application is sent against - the Seller
 * Terms & Conditions and the Seller Platform Services Agreement - beside the
 * "Send for review" button.
 *
 * The same records, the same dialog and the same end-of-text rule as the
 * Seller Hub's agreement screen (`components/agreement-kit`): this panel reads
 * the server's status and never keeps its own. Each row opens its own
 * document; reading one never unlocks the other, and only "I agree" at the end
 * of a document writes anything. The server checks both again when the
 * application is sent, so a version published since is caught there too.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PolicyDocumentDialog } from '@/components/agreement-kit/PolicyDocumentDialog';
import { formatAgreementDate } from '@/components/agreement-kit/format';
import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { agreementsClient } from '@/lib/agreements';
import { SELLER_AGREEMENTS_QUERY_KEY, sellerAgreementRows, useSellerAgreements, type SellerAgreementRow } from './seller-agreements';

export function SellerAgreementsPanel(): React.JSX.Element {
  const { t, language } = useI18n();
  const client = useQueryClient();
  const query = useSellerAgreements();
  const [open, setOpen] = useState<SellerAgreementRow['role'] | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (query.isError) {
    return (
      <p role="alert" className="text-xxs text-danger">
        {t('sellerOnboarding.agreements.loadFailed')}
      </p>
    );
  }
  if (query.data === undefined) return <></>;

  const status = query.data;
  const rows = sellerAgreementRows(status);
  const openRow = rows.find((row) => row.role === open) ?? null;
  const documents = openRow?.entry?.current === null || openRow?.entry?.current === undefined ? [] : [openRow.entry.current];

  const confirm = async (documentIds: string[]): Promise<void> => {
    if (open === null || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      client.setQueryData([...SELLER_AGREEMENTS_QUERY_KEY, language], await agreementsClient.record('SELLER', open, documentIds, language));
      setOpen(null);
    } catch (error) {
      setNotice(
        agreementsClient.errorCode(error) === 'TERMS_VERSION_OUTDATED'
          ? t('agreements.versionChanged')
          : t('agreements.saveFailed'),
      );
      await query.refetch();
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="seller-agreements-heading" className="space-y-2">
      <h3 id="seller-agreements-heading" className="text-xxs font-semibold text-ink">
        {t('sellerOnboarding.agreements.title')}
      </h3>
      <p className="text-xxs leading-relaxed text-ink-muted">{t('sellerOnboarding.agreements.intro')}</p>
      <ul className="space-y-2">
        {rows.map(({ role, entry }) => {
          const name = role === 'TERMS' ? t('sellerOnboarding.agreements.sellerTerms') : t('agreements.services.documentName');
          const unavailable = entry === null || entry.unavailable;
          return (
            <li key={role} className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs font-medium text-ink">{name}</p>
                <p className="text-xxs text-ink-muted">
                  {unavailable
                    ? t('sellerOnboarding.agreements.unpublished')
                    : entry.record !== null
                      ? t('sellerOnboarding.agreements.accepted', {
                          version: entry.record.version,
                          date: formatAgreementDate(entry.record.recordedAt, language),
                        })
                      : t('sellerOnboarding.agreements.pending')}
                </p>
              </div>
              {!unavailable && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setNotice(null);
                    setOpen(role);
                  }}
                >
                  {t('sellerOnboarding.agreements.open')}
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      <PolicyDocumentDialog
        isOpen={openRow !== null}
        role={open ?? 'TERMS'}
        documents={documents}
        state={documents.length > 0 ? 'ready' : 'error'}
        recordedAt={openRow?.entry?.record?.recordedAt ?? null}
        isSaving={saving}
        notice={notice}
        onRetry={() => {
          void query.refetch();
        }}
        onClose={() => {
          setOpen(null);
          setNotice(null);
        }}
        onConfirm={(documentIds) => {
          void confirm(documentIds);
        }}
        pdfUrl={agreementsClient.pdfUrl}
        pageUrl={agreementsClient.pageUrl}
      />
    </section>
  );
}
