/**
 * Who can act for a seller or a buyer company, read-only (checklist Master
 * row 14).
 *
 * The same facts the business's own owner reviews: each member's role, when
 * they joined, who invited them, when they last signed in and were active, the
 * open invitations, and the recent access reviews. Staff change nothing here -
 * membership belongs to the business.
 */
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, ErrorState, LoadingState } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';

export interface AccessReviewView {
  members: {
    id: string;
    name: string;
    email: string;
    role: string;
    joinedAt: string;
    invitedByName: string | null;
    lastSignInAt: string | null;
    lastActiveAt: string | null;
    lastHubActivityAt: string | null;
  }[];
  invitations: { id: string; email: string; role: string; expiresAt: string; expired: boolean; sendCount: number; invitedByName: string | null }[];
  accessReview: {
    reviews: { id: string; reviewedAt: string; reviewedByName: string; memberCount: number; invitationCount: number }[];
    intervalDays: number;
    dueAt: string | null;
    due: boolean;
  };
}

export function AccessReviewCard({ kind, id }: { kind: 'seller' | 'company'; id: string }): React.JSX.Element {
  const { t } = useI18n();
  const url = kind === 'seller' ? `/admin/sellers/${id}/access-review` : `/admin/buyer-companies/${id}/access-review`;
  const query = useQuery({
    queryKey: ['access-review', kind, id],
    queryFn: () => api.get<AccessReviewView>(url),
    retry: false,
  });
  const role = (key: string): string =>
    t((kind === 'seller' ? `accessReview.sellerRole.${key}` : `buyerCompany.role.${key}`) as TranslationKey);
  const when = (iso: string | null): string => (iso === null ? t('accessReview.never') : formatDate(iso));

  return (
    <Card title={t('accessReview.title')} description={t('accessReview.description')}>
      {query.isPending ? (
        <div className="px-5 py-4">
          <LoadingState label={t('accessReview.loading')} />
        </div>
      ) : query.isError ? (
        <div className="px-5 py-4">
          <ErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        </div>
      ) : (
        <div className="space-y-4 px-5 py-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {query.data.accessReview.due ? (
              <Badge tone="warning">{t('accessReview.due')}</Badge>
            ) : (
              <Badge tone="success">{t('accessReview.upToDate')}</Badge>
            )}
            <span className="text-ink-muted">
              {query.data.accessReview.reviews[0] === undefined
                ? t('accessReview.neverReviewed')
                : t('accessReview.last', {
                    date: formatDate(query.data.accessReview.reviews[0].reviewedAt),
                    name: query.data.accessReview.reviews[0].reviewedByName,
                  })}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="text-xxs uppercase tracking-wider text-ink-subtle">
                <tr>
                  <th className="py-2 pr-3 font-semibold">{t('accessReview.person')}</th>
                  <th className="py-2 pr-3 font-semibold">{t('accessReview.role')}</th>
                  <th className="py-2 pr-3 font-semibold">{t('accessReview.joined')}</th>
                  <th className="py-2 pr-3 font-semibold">{t('accessReview.invitedBy')}</th>
                  <th className="py-2 pr-3 font-semibold">{t('accessReview.lastSignIn')}</th>
                  <th className="py-2 font-semibold">
                    {kind === 'seller' ? t('accessReview.lastHub') : t('accessReview.lastActive')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {query.data.members.map((member) => (
                  <tr key={member.id}>
                    <td className="py-2 pr-3">
                      <span className="block font-medium text-ink">{member.name !== '' ? member.name : member.email}</span>
                      <span className="block text-xs text-ink-muted">{member.email}</span>
                    </td>
                    <td className="py-2 pr-3">
                      <Badge tone={member.role === 'OWNER' ? 'brand' : 'neutral'}>{role(member.role)}</Badge>
                    </td>
                    <td className="py-2 pr-3 text-ink-muted">{formatDate(member.joinedAt)}</td>
                    <td className="py-2 pr-3 text-ink-muted">{member.invitedByName ?? t('accessReview.notInvited')}</td>
                    <td className="py-2 pr-3 text-ink-muted">{when(member.lastSignInAt)}</td>
                    <td className="py-2 text-ink-muted">
                      {when(kind === 'seller' ? member.lastHubActivityAt : member.lastActiveAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {query.data.invitations.length > 0 && (
            <div>
              <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{t('accessReview.invitations')}</h3>
              <ul className="mt-2 space-y-1 text-sm">
                {query.data.invitations.map((invitation) => (
                  <li key={invitation.id} className="flex flex-wrap items-center gap-2">
                    <span className="text-ink">{invitation.email}</span>
                    <Badge>{role(invitation.role)}</Badge>
                    <span className="text-xs text-ink-muted">
                      {invitation.expired
                        ? t('accessReview.expired')
                        : t('accessReview.expires', { date: formatDate(invitation.expiresAt) })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
