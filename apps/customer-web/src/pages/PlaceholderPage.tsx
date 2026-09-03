/**
 * A screen that has not been built yet.
 *
 * Says so plainly and names what will be here. The alternative — an empty page
 * — is indistinguishable from a page that loaded and found nothing, which is
 * the wrong thing for a customer to worry about.
 */
import { useStorefront } from '@/app/storefront-context';
import { Card, PageHeader } from '@/components/ui';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

export function PlaceholderPage({
  title,
  summary,
}: {
  title: string;
  summary: string;
}): React.JSX.Element {
  const { business } = useStorefront();
  useDocumentMeta({ title, noIndex: true }, business.displayName);

  return (
    <>
      <PageHeader title={title} />
      <Card>
        <div className="px-5 py-12 text-center">
          <p className="text-sm font-medium text-ink">This page is not built yet</p>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-ink-muted">{summary}</p>
        </div>
      </Card>
    </>
  );
}
