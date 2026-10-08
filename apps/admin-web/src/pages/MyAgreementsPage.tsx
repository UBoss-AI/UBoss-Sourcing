/**
 * The member of staff's own record: the staff terms they accepted and the
 * Privacy Policy notices they acknowledged, newest first, each linked to the
 * exact version as a PDF. Opened from the user menu.
 */
import { AgreementHistory } from '@/components/agreement-kit/AgreementHistory';
import { agreementsClient } from '@/lib/agreements';

export function MyAgreementsPage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-3xl">
      <AgreementHistory client={agreementsClient} />
    </div>
  );
}
