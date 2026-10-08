/**
 * Privacy requests on their own: a copy of your data, a correction, erasure.
 *
 * The same panel as the account's profile page, on a page of its own so it
 * can be reached from the agreement screen - before the Terms are accepted,
 * when the rest of the account is not. The server allows exactly this.
 */
import { useI18n } from '@/i18n/i18n-context';
import { YourDataPanel } from './account/YourDataPanel';

export function PrivacyRequestsPage(): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="mx-auto max-w-3xl py-8">
      <h1 className="text-title-lg text-ink">{t('privacyRequests.title')}</h1>
      <p className="mt-2 text-sm text-ink-muted">{t('privacyRequests.intro')}</p>
      <div className="mt-6">
        <YourDataPanel />
      </div>
    </div>
  );
}
