/**
 * A stand-in for the agreement boxes on a sign-in form, for tests of the
 * pages that hold them. The boxes themselves - opening each document, the
 * read-to-the-end rule, failing closed - are tested in the agreement kit.
 *
 *   vi.mock('@/components/agreement-kit/SignInAgreements', () => import('@/components/agreement-kit/sign-in-agreements-stub'));
 *
 * By default it reports every box ticked, so a test about something else can
 * sign in; set `globalThis.signInAgreementsIncomplete = true` to leave them
 * empty. A global rather than an export: this file exports one component.
 */
import { useEffect } from 'react';
import type { SignInAgreementsProps } from '@/components/agreement-kit/SignInAgreements';


export function SignInAgreements({ scope, onCompleteChange }: SignInAgreementsProps): React.JSX.Element {
  useEffect(() => {
    onCompleteChange((globalThis as { signInAgreementsIncomplete?: boolean }).signInAgreementsIncomplete !== true);
  }, [onCompleteChange]);
  return <p>Agreement boxes for {scope}</p>;
}
