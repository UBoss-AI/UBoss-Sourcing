/**
 * Where an invitation to join a company lands (checklist Master rows 11 and 14).
 *
 * Signed in first - the account route sends a signed-out visitor to sign-in
 * and back here with the link intact. The page then asks the server what the
 * invitation is for and shows it: which company, who asked, the role. Nothing
 * happens until the person presses Accept, because joining a company in a
 * role is a decision, not a side effect of opening an email.
 *
 * The token goes to the server in a request body, and is taken out of the
 * address bar as soon as it is read, so it does not linger in history.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { Button, ButtonLink, LoadingState, PageHeader } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { COMPANIES_QUERY_KEY, acceptCompanyInvitation, previewCompanyInvitation } from '@/lib/buyer-companies';
import { errorMessage } from '@/lib/errors';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { AccountPanel } from '@/pages/account/AccountPanel';

export function JoinCompanyPage(): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const { business } = useStorefront();
  const { refreshUser } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  // Read once and kept: the address bar is cleaned below.
  const [token] = useState(() => searchParams.get('token') ?? '');

  useDocumentMeta({ title: t('joinCompany.title'), noIndex: true }, business.displayName);

  const preview = useQuery({
    queryKey: ['company-invitation', token],
    queryFn: async () => {
      const result = await previewCompanyInvitation(token);
      window.history.replaceState(window.history.state, '', window.location.pathname);
      return result;
    },
    enabled: token.length > 0,
    retry: false,
    staleTime: Infinity,
  });

  const accept = useMutation({
    mutationFn: () => acceptCompanyInvitation(token),
    onSuccess: async ({ companyId }) => {
      await queryClient.invalidateQueries({ queryKey: COMPANIES_QUERY_KEY });
      await refreshUser();
      void navigate(`/account/companies/${companyId}`, { replace: true });
    },
  });

  const invalid = (message: string): React.JSX.Element => (
    <>
      <PageHeader title={t('joinCompany.title')} />
      <AccountPanel title={t('joinCompany.invalidTitle')}>
        <p role="alert" className="max-w-prose text-sm leading-relaxed text-ink">
          {message}
        </p>
        <div className="mt-5">
          <ButtonLink to="/account/companies">{t('joinCompany.toCompanies')}</ButtonLink>
        </div>
      </AccountPanel>
    </>
  );

  if (token.length === 0) return invalid(t('joinCompany.noToken'));
  if (preview.isPending) return <LoadingState label={t('joinCompany.loading')} />;
  if (preview.isError) return invalid(errorMessage(t, preview.error, t('joinCompany.invalidBody')));

  const invitation = preview.data;
  const expires = new Intl.DateTimeFormat(intlLocale, { dateStyle: 'medium' }).format(new Date(invitation.expiresAt));

  return (
    <>
      <PageHeader title={t('joinCompany.title')} />
      <AccountPanel title={t('joinCompany.heading', { company: invitation.companyName })}>
        <p className="max-w-prose text-sm leading-relaxed text-ink">
          {t('joinCompany.body', {
            inviter: invitation.inviterName,
            company: invitation.companyName,
            role: t(`companyRole.${invitation.role}` as TranslationKey),
          })}
        </p>
        <p className="mt-2 text-sm text-ink-muted">{t('joinCompany.expires', { date: expires })}</p>
        {accept.isError && (
          <p role="alert" className="mt-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {errorMessage(t, accept.error, t('joinCompany.invalidBody'))}
          </p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            isLoading={accept.isPending}
            onClick={() => {
              accept.mutate();
            }}
          >
            {t('joinCompany.accept')}
          </Button>
          <ButtonLink to="/account" variant="secondary">
            {t('joinCompany.notNow')}
          </ButtonLink>
        </div>
      </AccountPanel>
    </>
  );
}
