/**
 * Shown while a lazily-loaded route's chunk is fetched.
 *
 * In its own file so `router.tsx` exports only the router — a module that
 * mixes a component with other exports cannot keep its state across a Fast
 * Refresh edit, and the router is edited often.
 */
import { Spinner } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';

export function RouteFallback(): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="flex items-center justify-center py-24">
      <Spinner className="h-6 w-6 text-ink-subtle" />
      <span className="sr-only" role="status">
        {t('routeFallback.loading')}
      </span>
    </div>
  );
}
