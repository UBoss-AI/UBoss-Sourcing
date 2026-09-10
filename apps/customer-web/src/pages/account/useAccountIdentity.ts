/**
 * Who is signed in, as the chrome and the account pages need to say it.
 *
 * Four surfaces ask the same question — the header button, the dropdown under
 * it, the profile sidebar and the profile page itself — and before this each
 * one composed its own answer out of `session.user.email` and a `/account/profile`
 * read. Which is how one of them ends up greeting somebody by their email
 * address while the other three use their name.
 *
 * It shares the `['account-profile']` query key with the account screens on
 * purpose. Opening the dropdown therefore costs nothing on a page that has
 * already read the profile, and saving a new name over on the profile screen
 * invalidates that key and re-labels the header without this module knowing
 * anything about it.
 *
 * **Every field is allowed to be missing, and none of them may break the page.**
 * `fullName` is nullable in the API and blank in plenty of real purchasing
 * accounts, the read may not have finished, and it may simply have failed.
 * All three land on the email address — which is always present, because it is
 * what identifies the account — rather than on "Welcome back, undefined".
 */
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { api } from '@/lib/api';
import type { AccountResponse } from '@/lib/types';

export interface AccountIdentity {
  /** Always something. The email address when there is no name on the account. */
  email: string;
  /** The name as it was typed, or null. Never derived from the email. */
  fullName: string | null;
  /** The first word of the name, for a header button. Null with no name. */
  shortName: string | null;
  organization: string | null;
  /** True while the profile read is in flight. Nothing here waits on it. */
  isLoading: boolean;
}

/**
 * The first word of a name, if there is a name and it has a word in it.
 *
 * Only the first word, so a header button says "Priya" rather than the full
 * legal name somebody typed into a purchasing account. Deliberately not
 * derived from the email address: `ops.procurement@` is not a person's name,
 * and "Ops" is worse than no greeting at all.
 */
function firstWord(fullName: string | null): string | null {
  const trimmed = (fullName ?? '').trim();
  if (trimmed === '') return null;

  return trimmed.split(/\s+/)[0] ?? null;
}

export function useAccountIdentity(enabled: boolean): AccountIdentity {
  const { user } = useSession();

  const query = useQuery({
    queryKey: ['account-profile'],
    queryFn: () => api.get<AccountResponse>('/account/profile'),
    // Nothing is fetched for a guest. A stranger in the header makes exactly
    // the requests they made before this hook existed: none.
    enabled,
    staleTime: 5 * 60_000,
  });

  const profile = query.data?.profile ?? null;
  const fullName = (profile?.fullName ?? '').trim() === '' ? null : (profile?.fullName ?? null);

  return {
    // The session's email rather than the profile's, so the identity is
    // correct on the first frame instead of after a round trip. They are the
    // same address — `/account/profile` reads it off the same user row.
    email: user?.email ?? profile?.email ?? '',
    fullName,
    shortName: firstWord(fullName),
    organization:
      (profile?.organization ?? '').trim() === '' ? null : (profile?.organization ?? null),
    isLoading: query.isFetching,
  };
}
