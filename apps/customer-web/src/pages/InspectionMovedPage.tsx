/**
 * `/inspection` and everything under it: the agency portal that used to live
 * here has moved to the Audit Console.
 *
 * Inspection agencies, inspectors and QA reviewers now work in a separate
 * application with its own sign-in on its own address. A bookmark to the old
 * pages lands here and is told where to go, and - the part people get wrong -
 * that their storefront login does not work there: they sign in with the
 * account they were invited to.
 *
 * The address comes from the public config (`auditConsoleUrl`), which is empty
 * when the operator has the console switched off. Nothing here names a host:
 * every deployment has its own.
 */
import { useStorefront } from '@/app/storefront-context';
import { ButtonAnchor, Card, PageHeader } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

/** Only an http(s) address is offered as a link; anything else is not shown at all. */
function safeConsoleUrl(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function InspectionMovedPage(): React.JSX.Element {
  const { t } = useI18n();
  const config = useStorefront();
  useDocumentMeta({ title: t('inspectionMoved.title'), noIndex: true }, config.business.displayName);
  const consoleUrl = safeConsoleUrl(config.auditConsoleUrl);

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <PageHeader title={t('inspectionMoved.title')} description={t('inspectionMoved.body')} />
      <Card bodyClassName="space-y-4 px-5 py-5 text-sm leading-relaxed">
        <p>{t('inspectionMoved.account')}</p>
        {consoleUrl === null ? (
          <p className="text-ink-muted">{t('inspectionMoved.noLink')}</p>
        ) : (
          <ButtonAnchor href={consoleUrl} variant="primary" rel="noopener noreferrer">
            {t('inspectionMoved.open')}
          </ButtonAnchor>
        )}
        <p className="text-ink-muted">{t('inspectionMoved.buyersSellers')}</p>
      </Card>
    </div>
  );
}
