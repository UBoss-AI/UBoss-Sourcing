/**
 * Shown while a lazily-loaded route's chunk is fetched.
 *
 * In its own file so `router.tsx` exports only the router - a module that
 * mixes a component with other exports cannot keep its state across a Fast
 * Refresh edit, and the router is edited often.
 */
import { Spinner } from '@/components/ui';

export function RouteFallback(): React.JSX.Element {
  return (
    <div className="flex items-center justify-center py-20">
      <Spinner className="h-5 w-5 text-ink-subtle" />
      <span className="sr-only" role="status">
        Loading
      </span>
    </div>
  );
}
